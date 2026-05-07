/**
 * Transport API Module
 * Handles all communication with the transport.rest API
 * Supports BVG (Berlin), VBB (Berlin+Brandenburg), DB (all Germany)
 */
const BvgApi = (() => {
    const PROVIDERS = {
        'v6.bvg.transport.rest': 'BVG (Berlin)',
        'v6.vbb.transport.rest': 'VBB (Berlin + Brandenburg)'
    };

    let baseUrl = 'https://v6.bvg.transport.rest';
    const RATE_LIMIT_DELAY = 650; // ms between requests to stay under 100/min

    let lastRequestTime = 0;

    /**
     * Set the API provider host
     * @param {string} host - e.g. 'v6.db.transport.rest'
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
     * Rate-limited fetch wrapper with timeout
     */
    async function rateLimitedFetch(url) {
        const now = Date.now();
        const timeSinceLastRequest = now - lastRequestTime;
        if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
        }
        lastRequestTime = Date.now();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('API rate limit exceeded. Please wait.');
                }
                throw new Error(`API error: ${response.status} ${response.statusText}`);
            }
            return response.json();
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') {
                throw new Error('Request timed out. BVG API may be unavailable.');
            }
            throw e;
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
        return data.filter(item => item.type === 'stop');
    }

    /**
     * Get departures for a station
     * @param {string} stationId - Station ID
     * @param {Object} filters - Transport type filters
     * @param {number} duration - Minutes to look ahead
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
        if (filters.suburban !== undefined) params.set('suburban', String(filters.suburban));
        if (filters.subway !== undefined) params.set('subway', String(filters.subway));
        if (filters.tram !== undefined) params.set('tram', String(filters.tram));
        if (filters.bus !== undefined) params.set('bus', String(filters.bus));
        if (filters.ferry !== undefined) params.set('ferry', String(filters.ferry));
        if (filters.express !== undefined) params.set('express', String(filters.express));
        if (filters.regional !== undefined) params.set('regional', String(filters.regional));

        const data = await rateLimitedFetch(`${baseUrl}/stops/${encodeURIComponent(stationId)}/departures?${params}`);
        return data;
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
        searchStations,
        getDepartures,
        getStation,
        setProvider,
        getProvider,
        getProviders
    };
})();
