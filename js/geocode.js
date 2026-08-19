/**
 * Place lookup fallback (Photon / OpenStreetMap)
 *
 * The transport API's own location index covers stops, addresses and a thin
 * set of transport-relevant landmarks — "Brandenburger Tor" resolves, a market
 * hall or a particular restaurant usually does not. This fills that gap.
 *
 * Photon rather than Nominatim on purpose: Nominatim's usage policy explicitly
 * forbids autocomplete-style querying, which is exactly what a search field
 * does. Photon is built for it, needs no API key and no registration.
 *
 * It is a third-party host, so:
 *   - it is only queried when the transport search found no place (never on
 *     every keystroke, and never at all if the built-in index already answered)
 *   - it can be switched off entirely
 *   - what gets sent is the text typed into the destination field
 */
const Geocoder = (() => {
    'use strict';

    const ENDPOINT = 'https://photon.komoot.io/api/';
    const REQUEST_TIMEOUT = 8000;
    const MIN_INTERVAL_MS = 1000;  // be a polite guest on a donated service
    const MAX_RESULTS = 5;

    // Berlin + Brandenburg. Keeps "Hauptbahnhof" from resolving to Hamburg.
    const DEFAULT_BBOX = { minLon: 11.2, minLat: 51.3, maxLon: 14.8, maxLat: 53.7 };
    const DEFAULT_CENTRE = { lat: 52.52, lon: 13.405 };

    let enabled = true;
    let bbox = { ...DEFAULT_BBOX };
    let centre = { ...DEFAULT_CENTRE };
    let lastRequestAt = 0;

    function configure(opt = {}) {
        if (typeof opt.enabled === 'boolean') enabled = opt.enabled;
        if (opt.bbox) bbox = { ...bbox, ...opt.bbox };
        if (opt.centre) centre = { ...centre, ...opt.centre };
    }

    const isEnabled = () => enabled;

    /**
     * Photon splits an address across properties; reassemble it the way it
     * would be written on an envelope.
     * @returns {{label: string, detail: string}}
     */
    function describe(props) {
        const street = [props.street, props.housenumber].filter(Boolean).join(' ');
        // A named place (shop, hall, station) is what someone actually typed;
        // fall back to the street when the hit is a plain address.
        const label = props.name || street || props.city || '';

        const detail = [
            props.name && street ? street : '',
            [props.postcode, props.city || props.district].filter(Boolean).join(' ')
        ].filter(Boolean).join(', ');

        return { label, detail };
    }

    /**
     * Look a place up.
     * @param {string} query
     * @returns {Promise<Array<{name: string, detail: string, latitude: number, longitude: number, source: 'osm'}>>}
     *          Always resolves — a geocoder outage must not break the search
     *          field, it just means no extra suggestions.
     */
    async function search(query) {
        const text = (query || '').trim();
        if (!enabled || text.length < 3) return [];

        // A fallback that fires at most once per second is well inside fair
        // use; it only runs when the transport index came up empty anyway.
        const since = Date.now() - lastRequestAt;
        if (since < MIN_INTERVAL_MS) return [];
        lastRequestAt = Date.now();

        const params = new URLSearchParams({
            q: text,
            limit: String(MAX_RESULTS),
            lang: 'de',
            lat: String(centre.lat),
            lon: String(centre.lon),
            bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
            const response = await fetch(`${ENDPOINT}?${params}`, { signal: controller.signal });
            if (!response.ok) throw new Error(`Photon ${response.status}`);

            const data = await response.json();
            const features = (data && Array.isArray(data.features)) ? data.features : [];

            const places = [];
            const seen = new Set();
            for (const feature of features) {
                const props = feature && feature.properties;
                const coords = feature && feature.geometry && feature.geometry.coordinates;
                if (!props || !Array.isArray(coords) || coords.length < 2) continue;

                const [lon, lat] = coords;
                if (!isFinite(lat) || !isFinite(lon)) continue;

                const { label, detail } = describe(props);
                if (!label) continue;

                // Photon happily returns the same place from several OSM
                // objects (a node and its enclosing way, say).
                const key = `${label}|${detail}`;
                if (seen.has(key)) continue;
                seen.add(key);

                places.push({ name: label, detail, latitude: lat, longitude: lon, source: 'osm' });
            }
            return places;
        } catch (e) {
            console.info('Place lookup unavailable:', e.message);
            return [];
        } finally {
            clearTimeout(timeout);
        }
    }

    return { search, configure, isEnabled };
})();
