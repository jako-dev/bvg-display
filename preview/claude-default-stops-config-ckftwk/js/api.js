/**
 * Transport API Module
 * Handles all communication with the transport.rest API
 * Supports BVG (Berlin) and VBB (Berlin + Brandenburg)
 */
const BvgApi = (() => {
    'use strict';

    const PROVIDERS = {
        'v6.bvg.transport.rest': 'BVG (Berlin)',
        'v6.vbb.transport.rest': 'VBB (Berlin + Brandenburg)'
    };

    // Transport product keys understood by the transport.rest API.
    // Shared with the UI so filters, badges and query params can't drift apart.
    const PRODUCTS = ['suburban', 'subway', 'tram', 'bus', 'ferry', 'express', 'regional'];

    const DEFAULT_PROVIDER = 'v6.bvg.transport.rest';
    const RATE_LIMIT_DELAY = 650;  // ms between requests to stay under 100/min
    const REQUEST_TIMEOUT = 12000; // ms
    const SERVER_ERROR_RETRIES = 1;
    const RETRY_DELAY_MS = 1500;

    let baseUrl = 'https://' + DEFAULT_PROVIDER;
    let lastRequestTime = 0;
    // Serialises slot reservation so parallel callers (LED/split view) queue up
    // instead of all reading the same timestamp and firing at once.
    let rateLimitQueue = Promise.resolve();

    /**
     * Set the API provider host
     * @param {string} host - e.g. 'v6.vbb.transport.rest'
     */
    function setProvider(host) {
        if (PROVIDERS[host]) {
            baseUrl = 'https://' + host;
        }
    }

    /**
     * Get the current provider host
     * @returns {string}
     */
    function getProvider() {
        return baseUrl.replace('https://', '');
    }

    /**
     * Get available providers
     * @returns {Object} host -> label mapping
     */
    function getProviders() {
        return { ...PROVIDERS };
    }

    /**
     * The other endpoint. BVG and VBB are separate deployments that both cover
     * Berlin, so when one is down the other usually is not.
     * @returns {{host: string, label: string}|null}
     */
    function getAlternateProvider() {
        const current = getProvider();
        const other = Object.keys(PROVIDERS).find(host => host !== current);
        return other ? { host: other, label: PROVIDERS[other] } : null;
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    /**
     * Reserve the next request slot. Chaining onto a shared promise guarantees
     * every request starts at least RATE_LIMIT_DELAY after the previous one,
     * even when several are kicked off in the same tick via Promise.all().
     * @returns {Promise<void>}
     */
    function reserveSlot() {
        const slot = rateLimitQueue.then(async () => {
            const wait = RATE_LIMIT_DELAY - (Date.now() - lastRequestTime);
            if (wait > 0) await sleep(wait);
            lastRequestTime = Date.now();
        });
        rateLimitQueue = slot.catch(() => {});
        return slot;
    }

    /**
     * Rate-limited fetch wrapper with timeout.
     *
     * 5xx responses are retried once. This is a free, public API and it does
     * fall over from time to time; a single upstream hiccup should not empty
     * the board when waiting a couple of seconds usually clears it.
     */
    async function rateLimitedFetch(url, attempt = 0) {
        await reserveSlot();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
            const response = await fetch(url, { signal: controller.signal });

            if (!response.ok) {
                if (response.status === 429) {
                    const error = new Error('API-Limit erreicht. Bitte kurz warten.');
                    error.status = 429;
                    throw error;
                }

                if (response.status >= 500 && attempt < SERVER_ERROR_RETRIES) {
                    clearTimeout(timeoutId);
                    await sleep(RETRY_DELAY_MS * (attempt + 1));
                    return rateLimitedFetch(url, attempt + 1);
                }

                // 5xx is the upstream's problem, not the request's — say so,
                // because "check your settings" is the wrong advice for it.
                const error = new Error(response.status >= 500
                    ? `Die Verkehrs-API antwortet gerade nicht (${response.status}). Das liegt am Anbieter, nicht an dieser App.`
                    : `API-Fehler: ${response.status} ${response.statusText}`);
                error.status = response.status;
                error.upstream = response.status >= 500;
                error.unreachable = response.status >= 500;
                throw error;
            }

            return await response.json();
        } catch (e) {
            if (e.name === 'AbortError') {
                const error = new Error('Zeitüberschreitung — die API antwortet nicht.');
                error.upstream = true;
                error.unreachable = true;
                throw error;
            }

            // A server that falls over usually stops sending CORS headers with
            // it, so the browser refuses to show us the response at all: we get
            // an opaque TypeError with no status. That reads like a CORS
            // misconfiguration but is nearly always the upstream being down —
            // and it means the status-based retry above never sees it.
            if (e instanceof TypeError) {
                if (attempt < SERVER_ERROR_RETRIES) {
                    clearTimeout(timeoutId);
                    await sleep(RETRY_DELAY_MS * (attempt + 1));
                    return rateLimitedFetch(url, attempt + 1);
                }
                const error = new Error('Die Verkehrs-API ist nicht erreichbar (Dienst überlastet oder offline).');
                error.upstream = true;
                error.unreachable = true;
                throw error;
            }

            throw e;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Search for stations by name
     * @param {string} query - Search term
     * @returns {Promise<Array>} List of matching stops/stations
     */
    /**
     * Search the location index and normalise the three kinds it returns into
     * one shape.
     *
     * Stops nest their coordinates under `location`; addresses and points of
     * interest carry lat/lng at the top level, and name themselves with
     * `address` and `name` respectively. Flattening that here keeps the
     * difference out of the UI.
     *
     * @param {string} query
     * @param {Object} [opt]
     * @param {boolean} [opt.stops=true]
     * @param {boolean} [opt.addresses=false]
     * @param {boolean} [opt.poi=false]
     * @param {number} [opt.results=8]
     * @returns {Promise<Array<{kind: 'stop'|'poi'|'address', id: string, name: string,
     *                          latitude: number, longitude: number, products?: Object}>>}
     */
    async function searchPlaces(query, opt = {}) {
        const text = (query || '').trim();
        if (text.length < 2) return [];

        const params = new URLSearchParams({
            query: text,
            results: String(opt.results || 8),
            stops: opt.stops === false ? 'false' : 'true',
            addresses: opt.addresses ? 'true' : 'false',
            poi: opt.poi ? 'true' : 'false',
            pretty: 'false'
        });

        const data = await rateLimitedFetch(`${baseUrl}/locations?${params}`);
        if (!Array.isArray(data)) return [];

        const places = [];
        for (const item of data) {
            if (!item) continue;

            if (item.type === 'stop' && item.id) {
                const loc = item.location || {};
                places.push({
                    kind: 'stop',
                    id: String(item.id),
                    name: item.name || '',
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    products: item.products
                });
                continue;
            }

            if (item.type === 'location' && isFinite(item.latitude) && isFinite(item.longitude)) {
                const name = item.name || item.address || '';
                if (!name) continue;
                places.push({
                    kind: item.poi ? 'poi' : 'address',
                    id: item.id ? String(item.id) : '',
                    name,
                    latitude: item.latitude,
                    longitude: item.longitude
                });
            }
        }
        return places;
    }

    /** Stops only — what the departure board and the split panes can display. */
    async function searchStations(query) {
        const places = await searchPlaces(query, { stops: true });
        return places
            .filter(place => place.kind === 'stop')
            .map(place => ({
                type: 'stop',
                id: place.id,
                name: place.name,
                location: { latitude: place.latitude, longitude: place.longitude },
                products: place.products
            }));
    }

    /**
     * Addresses and points of interest — anywhere a journey can start or end
     * that isn't a stop.
     */
    async function searchAddresses(query) {
        if (!query || query.trim().length < 3) return [];
        const places = await searchPlaces(query, { stops: false, addresses: true, poi: true, results: 6 });
        return places.map(place => ({
            address: place.name,
            latitude: place.latitude,
            longitude: place.longitude,
            poi: place.kind === 'poi'
        }));
    }

    /**
     * Get departures for a station
     * @param {string} stationId - Station ID
     * @param {Object} filters - Transport type filters
     * @param {number} duration - Minutes to look ahead
     * @param {number|null} results - Max number of departures
     * @returns {Promise<Object>} Departures data
     */
    async function getDepartures(stationId, filters = {}, duration = 30, results = null) {
        const params = new URLSearchParams({
            duration: String(duration),
            remarks: 'true',
            pretty: 'false',
            language: 'de'
        });

        if (results) params.set('results', String(results));

        // Apply transport type filters
        for (const product of PRODUCTS) {
            if (filters[product] !== undefined) {
                params.set(product, String(filters[product]));
            }
        }

        return rateLimitedFetch(`${baseUrl}/stops/${encodeURIComponent(stationId)}/departures?${params}`);
    }

    /**
     * Get station details by ID
     * @param {string} stationId - Station ID
     * @returns {Promise<Object>} Station data
     */
    async function getStation(stationId) {
        const params = new URLSearchParams({
            linesOfStops: 'true',
            pretty: 'false'
        });
        return rateLimitedFetch(`${baseUrl}/stops/${encodeURIComponent(stationId)}?${params}`);
    }

    /**
     * Plan journeys from one station to another.
     * @param {string} fromId - Origin station ID
     * @param {string} toId - Destination station ID
     * @param {Object} filters - Transport type filters
     * @param {Object} [opt]
     * @param {number} [opt.results=4] - Number of journeys to return
     * @param {number} [opt.transfers] - Max transfers (-1 = unlimited)
     * @param {boolean} [opt.polylines=false] - Include a shape per leg
     * @param {Date|string} [opt.departure] - Depart at this time instead of now
     * @returns {Promise<Object>} { journeys: [...] }
     */
    /**
     * Write an endpoint into the query. A saved station goes in as an ID; an
     * address goes in as a coordinate pair, which is what makes HAFAS plan the
     * walk from that point to the first platform instead of starting at a stop.
     */
    function setJourneyPlace(params, key, place) {
        if (place && typeof place === 'object') {
            params.set(`${key}.latitude`, String(place.latitude));
            params.set(`${key}.longitude`, String(place.longitude));
            if (place.address) params.set(`${key}.address`, place.address);
            else if (place.name) params.set(`${key}.name`, place.name);
            return;
        }
        params.set(key, String(place));
    }

    async function getJourneys(from, to, filters = {}, opt = {}) {
        const params = new URLSearchParams({
            results: String(opt.results || 4),
            stopovers: 'false',
            remarks: 'true',
            polylines: opt.polylines ? 'true' : 'false',
            pretty: 'false',
            language: 'de'
        });

        setJourneyPlace(params, 'from', from);
        setJourneyPlace(params, 'to', to);

        // -1 means "as many transfers as needed"; the API rejects it as a count,
        // so it is simply left out and HAFAS applies its own default.
        if (typeof opt.transfers === 'number' && opt.transfers >= 0) {
            params.set('transfers', String(opt.transfers));
        }
        if (opt.departure) {
            const when = opt.departure instanceof Date ? opt.departure.toISOString() : opt.departure;
            params.set('departure', when);
        }

        for (const product of PRODUCTS) {
            if (filters[product] !== undefined) {
                params.set(product, String(filters[product]));
            }
        }

        return rateLimitedFetch(`${baseUrl}/journeys?${params}`);
    }

    /**
     * Get a single trip, optionally with its geographic shape. Trip IDs contain
     * '|' and other reserved characters, so the path segment must be encoded.
     * @param {string} tripId
     * @param {boolean} [withPolyline=true]
     * @returns {Promise<Object>} { trip: {...} }
     */
    async function getTrip(tripId, withPolyline = true) {
        const params = new URLSearchParams({
            stopovers: 'true',
            remarks: 'false',
            polyline: withPolyline ? 'true' : 'false',
            pretty: 'false',
            language: 'de'
        });
        return rateLimitedFetch(`${baseUrl}/trips/${encodeURIComponent(tripId)}?${params}`);
    }

    /**
     * Find the runs of a named line — "M10", "U5", "S41" — across the whole
     * network, not just a map viewport. Each result is one run in one
     * direction, which is what makes a line's route retrievable by name.
     * @param {string} lineName
     * @param {Object} [opt]
     * @param {number} [opt.results=20]
     * @returns {Promise<Object>} { trips: [...] }
     */
    async function searchTripsByLine(lineName, opt = {}) {
        const params = new URLSearchParams({
            lineName: String(lineName).trim(),
            onlyCurrentlyRunning: 'true',
            stopovers: 'false',
            remarks: 'false',
            pretty: 'false',
            language: 'de'
        });
        if (opt.results) params.set('results', String(opt.results));
        return rateLimitedFetch(`${baseUrl}/trips?${params}`);
    }

    /**
     * Find every vehicle currently moving inside a bounding box.
     * One request covers the whole visible area no matter how many vehicles
     * are in it, which is what makes a live map affordable under the rate limit.
     * @param {{north: number, west: number, south: number, east: number}} bbox
     * @param {Object} [opt]
     * @param {number} [opt.results=128] - Max vehicles
     * @param {number} [opt.duration=30] - Seconds of movement to compute
     * @param {number} [opt.frames=3] - Interpolation frames within `duration`
     * @param {boolean} [opt.polylines=false] - Include each vehicle's track
     * @returns {Promise<Object>} { movements: [...] }
     */
    async function getRadar(bbox, opt = {}) {
        const params = new URLSearchParams({
            north: String(bbox.north),
            west: String(bbox.west),
            south: String(bbox.south),
            east: String(bbox.east),
            results: String(opt.results || 256),
            duration: String(opt.duration || 30),
            frames: String(opt.frames || 3),
            polylines: opt.polylines ? 'true' : 'false',
            pretty: 'false',
            language: 'de'
        });
        return rateLimitedFetch(`${baseUrl}/radar?${params}`);
    }

    /**
     * Flatten a hafas-client polyline into Leaflet-style [lat, lng] pairs.
     * The API returns a GeoJSON FeatureCollection of Points whose coordinates
     * are [longitude, latitude] — the opposite order from Leaflet's.
     * @param {Object} polyline - GeoJSON FeatureCollection
     * @returns {Array<[number, number]>}
     */
    function polylineToLatLngs(polyline) {
        const features = polyline && Array.isArray(polyline.features) ? polyline.features : [];
        const points = [];
        for (const feature of features) {
            const coords = feature && feature.geometry && feature.geometry.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) continue;
            const [lng, lat] = coords;
            if (typeof lat === 'number' && typeof lng === 'number') points.push([lat, lng]);
        }
        return points;
    }

    /**
     * The stations along a polyline, in order — the dots drawn on the route.
     * @param {Object} polyline - GeoJSON FeatureCollection
     * @returns {Array<{id: string, name: string, lat: number, lng: number}>}
     */
    function polylineStations(polyline) {
        const features = polyline && Array.isArray(polyline.features) ? polyline.features : [];
        const stations = [];
        for (const feature of features) {
            const props = feature && feature.properties;
            const coords = feature && feature.geometry && feature.geometry.coordinates;
            if (!props || !props.name || !Array.isArray(coords) || coords.length < 2) continue;
            stations.push({
                id: props.id ? String(props.id) : '',
                name: props.name,
                lat: coords[1],
                lng: coords[0]
            });
        }
        return stations;
    }

    return {
        PRODUCTS,
        DEFAULT_PROVIDER,
        searchPlaces,
        searchStations,
        searchAddresses,
        getDepartures,
        getStation,
        getJourneys,
        getTrip,
        searchTripsByLine,
        getRadar,
        polylineToLatLngs,
        polylineStations,
        setProvider,
        getProvider,
        getProviders,
        getAlternateProvider
    };
})();
