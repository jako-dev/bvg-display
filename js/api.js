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
     * Rate-limited fetch wrapper with timeout
     */
    async function rateLimitedFetch(url) {
        await reserveSlot();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('API-Limit erreicht. Bitte kurz warten.');
                }
                throw new Error(`API-Fehler: ${response.status} ${response.statusText}`);
            }
            return await response.json();
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error('Zeitüberschreitung — die API antwortet nicht.');
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
    async function searchStations(query) {
        if (!query || query.trim().length < 2) return [];
        const params = new URLSearchParams({
            query: query.trim(),
            results: '8',
            stops: 'true',
            addresses: 'false',
            poi: 'false',
            pretty: 'false'
        });
        const data = await rateLimitedFetch(`${baseUrl}/locations?${params}`);
        if (!Array.isArray(data)) return [];
        return data.filter(item => item.type === 'stop');
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
    async function getJourneys(fromId, toId, filters = {}, opt = {}) {
        const params = new URLSearchParams({
            from: String(fromId),
            to: String(toId),
            results: String(opt.results || 4),
            stopovers: 'false',
            remarks: 'true',
            polylines: opt.polylines ? 'true' : 'false',
            pretty: 'false',
            language: 'de'
        });

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
            results: String(opt.results || 128),
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
        searchStations,
        getDepartures,
        getStation,
        getJourneys,
        getTrip,
        getRadar,
        polylineToLatLngs,
        polylineStations,
        setProvider,
        getProvider,
        getProviders
    };
})();
