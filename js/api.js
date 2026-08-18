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

    return {
        PRODUCTS,
        DEFAULT_PROVIDER,
        searchStations,
        getDepartures,
        getStation,
        setProvider,
        getProvider,
        getProviders
    };
})();
