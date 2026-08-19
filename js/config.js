/**
 * Deployment & URL Configuration
 *
 * The app is a static site with no backend, so "server-side config" here means
 * two things a fresh client can be handed before it has any localStorage:
 *
 *   1. `config.json` next to index.html — deployment defaults. Edit it in your
 *      fork/deployment and every client that has not configured anything yet
 *      starts with those stations and settings. With `"lock": true` the file
 *      always wins, even over a client's own saved settings (wall displays).
 *
 *   2. URL query parameters — per-embed config, e.g. for a Home Assistant
 *      webpage card. These always win over both localStorage and config.json,
 *      and are NOT written back to localStorage unless `persist=1` is given,
 *      so embedding the board somewhere never clobbers the browser's own setup.
 *
 * Both sources produce a *partial* settings object using the same key names as
 * the app's persisted state, so the app can layer them in a fixed order:
 *
 *   built-in defaults < config.json < localStorage < config.json (if locked) < URL
 */
const AppConfig = (() => {
    'use strict';

    const CONFIG_URL = './config.json';
    const CONFIG_TIMEOUT = 4000; // ms — never let a missing/slow file stall startup

    const VIEW_MODES = ['single', 'split', 'journey', 'map', 'led'];
    const THEMES = ['dark', 'modern'];
    const TRUE_VALUES = ['1', 'true', 'yes', 'on'];
    const FALSE_VALUES = ['0', 'false', 'no', 'off'];

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    /** Tri-state boolean: true / false / undefined ("not specified") */
    function toBool(value) {
        if (typeof value === 'boolean') return value;
        if (value === null || value === undefined) return undefined;
        const text = String(value).trim().toLowerCase();
        if (TRUE_VALUES.includes(text)) return true;
        if (FALSE_VALUES.includes(text)) return false;
        return undefined;
    }

    function toInt(value) {
        if (value === null || value === undefined || value === '') return undefined;
        const num = parseInt(value, 10);
        return Number.isFinite(num) ? num : undefined;
    }

    /**
     * Normalise one station entry. Accepted forms:
     *   "900000100003"                          (URL / JSON string, name looked up via API)
     *   "900000100003|S+U Alexanderplatz"       (name given inline)
     *   "900000100003|S+U Alexanderplatz:5"     (… plus 5 min walk time)
     *   { "id": "900000100003", "name": "…", "walkTime": 5 }   (config.json object form)
     *
     * @returns {{id: string, name: string, walkTime: number}|null}
     */
    function parseStation(raw) {
        let id = '';
        let name = '';
        let walkTime;

        if (typeof raw === 'string') {
            let text = raw.trim();
            if (!text) return null;
            // Walk time is the trailing ":<minutes>" — matched from the end so a
            // colon inside a station name doesn't get mistaken for it.
            const walk = text.match(/:(\d+)\s*$/);
            if (walk) {
                walkTime = toInt(walk[1]);
                text = text.slice(0, walk.index);
            }
            const pipe = text.indexOf('|');
            if (pipe >= 0) {
                id = text.slice(0, pipe).trim();
                name = text.slice(pipe + 1).trim();
            } else {
                id = text.trim();
            }
        } else if (raw && typeof raw === 'object') {
            id = raw.id === null || raw.id === undefined ? '' : String(raw.id).trim();
            name = typeof raw.name === 'string' ? raw.name.trim() : '';
            walkTime = toInt(raw.walkTime);
        } else {
            return null;
        }

        if (!id) return null;
        return { id, name, walkTime: clamp(walkTime || 0, 0, 30) };
    }

    /** @returns {Array|undefined} undefined means "not specified" */
    function parseStations(list) {
        if (typeof list === 'string') list = list.split(',');
        if (!Array.isArray(list)) return undefined;

        const seen = new Set();
        const stations = [];
        for (const raw of list) {
            const station = parseStation(raw);
            if (!station || seen.has(station.id)) continue;
            seen.add(station.id);
            stations.push(station);
        }
        return stations;
    }

    /**
     * Filters accept either an object of explicit flags
     * ({"bus": false}) or a whitelist ("subway,tram" / ["subway","tram"]),
     * where every product not named is switched off.
     */
    function parseFilters(raw) {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const filters = {};
            for (const key of BvgApi.PRODUCTS) {
                const value = toBool(raw[key]);
                if (value !== undefined) filters[key] = value;
            }
            return Object.keys(filters).length > 0 ? filters : undefined;
        }

        const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : null);
        if (!list) return undefined;
        const wanted = new Set(list.map(item => String(item).trim().toLowerCase()).filter(Boolean));
        if (wanted.size === 0) return undefined;

        const filters = {};
        for (const key of BvgApi.PRODUCTS) filters[key] = wanted.has(key);
        return filters;
    }

    /**
     * Turn a raw config object into a partial settings object. Unknown and
     * malformed keys are dropped, so a typo can never brick the board — it just
     * falls back to whatever the previous layer had.
     */
    function normalize(raw) {
        const settings = {};
        if (!raw || typeof raw !== 'object') return settings;

        const stations = parseStations(raw.stations);
        if (stations) settings.stations = stations;

        if (typeof raw.apiProvider === 'string' && BvgApi.getProviders()[raw.apiProvider]) {
            settings.apiProvider = raw.apiProvider;
        }

        const departureCount = toInt(raw.departureCount);
        if (departureCount !== undefined) settings.departureCount = clamp(departureCount, 1, 15);

        const refreshInterval = toInt(raw.refreshInterval);
        if (refreshInterval !== undefined) settings.refreshInterval = clamp(refreshInterval, 10, 120);

        if (THEMES.includes(raw.theme)) settings.theme = raw.theme;
        if (VIEW_MODES.includes(raw.viewMode)) settings.viewMode = raw.viewMode;

        const kioskMode = toBool(raw.kioskMode);
        if (kioskMode !== undefined) settings.kioskMode = kioskMode;

        const ledScrollEnabled = toBool(raw.ledScrollEnabled);
        if (ledScrollEnabled !== undefined) settings.ledScrollEnabled = ledScrollEnabled;

        const ledScrollSpeed = toInt(raw.ledScrollSpeed);
        if (ledScrollSpeed !== undefined) settings.ledScrollSpeed = clamp(ledScrollSpeed, 1500, 8000);

        const filters = parseFilters(raw.filters);
        if (filters) settings.filters = filters;

        const mapLive = toBool(raw.mapLive);
        if (mapLive !== undefined) settings.mapLive = mapLive;

        // Tile server override — deployment-level only. Not accepted from the
        // URL, where it would let any link repoint the map at an arbitrary host.
        if (typeof raw.mapTileUrl === 'string' && /^https?:\/\//.test(raw.mapTileUrl)) {
            settings.mapTileUrl = raw.mapTileUrl;
        }
        if (typeof raw.mapAttribution === 'string' && raw.mapAttribution.trim()) {
            settings.mapAttribution = raw.mapAttribution.trim();
        }

        // A destination may be given as a bare ID or as "id|Name", the same
        // shorthand stations use — reuse the parser rather than a second syntax.
        if (raw.destination !== null && raw.destination !== undefined && raw.destination !== '') {
            const dest = parseStation(raw.destination);
            if (dest) settings.destination = { id: dest.id, name: dest.name || '' };
        }

        for (const key of ['activeStationId', 'splitLeftId', 'splitRightId', 'homeStationId']) {
            if (raw[key] !== null && raw[key] !== undefined && raw[key] !== '') {
                settings[key] = String(raw[key]);
            }
        }

        return settings;
    }

    /**
     * Read config from the query string. Every key has a short alias so an
     * embed URL stays readable:
     *
     *   ?stop=900000100003|Alexanderplatz:5&stop=900000024101&view=led&kiosk=1
     */
    function readUrl(search) {
        const params = new URLSearchParams(search || '');
        const raw = {};

        // Repeatable `stop=` params are the safe form (a station name may
        // contain a comma); `stops=` takes a comma-separated list.
        const stops = [
            ...params.getAll('stop'),
            ...params.getAll('stops').flatMap(value => value.split(','))
        ].filter(value => value.trim() !== '');
        if (stops.length > 0) raw.stations = stops;

        const first = (...keys) => {
            for (const key of keys) {
                const value = params.get(key);
                if (value !== null) return value;
            }
            return null;
        };

        const map = {
            apiProvider: first('provider', 'source'),
            departureCount: first('count', 'departures'),
            refreshInterval: first('refresh', 'interval'),
            theme: first('theme'),
            viewMode: first('view'),
            kioskMode: first('kiosk'),
            ledScrollEnabled: first('scroll'),
            ledScrollSpeed: first('scrollSpeed', 'scrollspeed'),
            filters: first('filter', 'filters'),
            activeStationId: first('active'),
            splitLeftId: first('left'),
            splitRightId: first('right'),
            homeStationId: first('home'),
            destination: first('to', 'destination'),
            mapLive: first('live')
        };
        for (const [key, value] of Object.entries(map)) {
            if (value !== null) raw[key] = value;
        }

        return {
            settings: normalize(raw),
            persist: toBool(params.get('persist')) === true
        };
    }

    /**
     * Fetch config.json. A missing file is a normal, supported state — the app
     * simply has no deployment defaults — so every failure resolves to null.
     */
    async function readFile() {
        if (typeof fetch !== 'function') return null;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG_TIMEOUT);
        try {
            // no-cache: always revalidate, so editing config.json on the server
            // takes effect on the next load instead of after a cache eviction.
            const response = await fetch(CONFIG_URL, { signal: controller.signal, cache: 'no-cache' });
            if (!response.ok) return null;
            const parsed = await response.json();
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {
            console.info('No usable config.json — using built-in defaults.', e.message);
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * @returns {Promise<{defaults: Object, overrides: Object, lock: boolean, ephemeral: boolean}>}
     *   defaults  — settings from config.json (applied when nothing is saved)
     *   overrides — settings from the URL (always applied last)
     *   lock      — config.json wins over the client's saved settings
     *   ephemeral — don't persist anything this page load
     */
    async function load() {
        const url = readUrl(window.location.search);
        const fileRaw = await readFile();
        const hasOverrides = Object.keys(url.settings).length > 0;

        return {
            defaults: normalize(fileRaw),
            overrides: url.settings,
            lock: toBool(fileRaw && fileRaw.lock) === true,
            ephemeral: hasOverrides && !url.persist
        };
    }

    return { load, normalize, readUrl, parseStation };
})();
