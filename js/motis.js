/**
 * MOTIS / Transitous adapter
 *
 * Transitous (https://transitous.org) is a community-run MOTIS instance with
 * Germany-wide — in fact Europe-wide — GTFS and GTFS-RT coverage, free and
 * without registration. It answers the same questions as the transport.rest
 * endpoints but in a different vocabulary, so this module translates in both
 * directions and hands `api.js` back the hafas-shaped objects the rest of the
 * app already knows how to render. Nothing outside this file needs to know
 * which backend answered.
 *
 * Endpoint map (MOTIS API v6, spec: motis-project/motis openapi.yaml):
 *
 *   /stops/:id/departures  ->  /api/v6/stoptimes
 *   /locations             ->  /api/v1/geocode
 *   /journeys              ->  /api/v6/plan
 *   /trips/:id             ->  /api/v6/trip
 *   /radar                 ->  /api/v6/map/trips
 *
 * Two differences are more than renaming:
 *
 *   - Geocoding returns stops, points of interest and addresses from one
 *     index, so the separate Photon lookup is unnecessary here.
 *   - map/trips returns trip *segments* — a stretch between two stops with a
 *     departure time, an arrival time and a shape — not vehicle positions. A
 *     position is what you get by interpolating along that shape for the
 *     current moment, which is what MOTIS's own map does.
 */
const MotisApi = (() => {
    'use strict';

    const API_VERSION = 'v6';

    /** MOTIS transport mode -> the product keys this app filters and colours by. */
    const MODE_TO_PRODUCT = {
        TRAM: 'tram',
        SUBWAY: 'subway', METRO: 'subway',
        SUBURBAN: 'suburban',
        BUS: 'bus', COACH: 'bus',
        FERRY: 'ferry',
        HIGHSPEED_RAIL: 'express', LONG_DISTANCE: 'express', NIGHT_RAIL: 'express',
        REGIONAL_RAIL: 'regional', REGIONAL_FAST_RAIL: 'regional',
        RAIL: 'regional',
        FUNICULAR: 'tram', AERIAL_LIFT: 'ferry', CABLE_CAR: 'tram'
    };

    /** …and back, for the mode filters MOTIS accepts on its side. */
    const PRODUCT_TO_MODES = {
        suburban: ['SUBURBAN'],
        subway: ['SUBWAY'],
        tram: ['TRAM'],
        bus: ['BUS', 'COACH'],
        ferry: ['FERRY'],
        express: ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL'],
        regional: ['REGIONAL_RAIL']
    };

    let fetchJson = null;
    let baseUrl = '';

    /**
     * Assembled routes from the last line search, keyed by a synthetic ID.
     *
     * map/routes answers the search *and* carries the geometry, so drawing the
     * line the user picked needs no second request — the shape is already here.
     * Cleared on each new search; the only IDs the UI can hand back are the
     * ones the current search just produced.
     */
    const routeCache = new Map();
    const ROUTE_ID_PREFIX = 'motis-route:';

    /**
     * How far around the map centre a line search looks.
     *
     * The box only has to *find* the line — the full geometry comes from
     * route-details afterwards, which is not box-limited. So it stays small: a
     * few kilometres so a zoomed-in street view still finds the line one
     * street over, at most ~20 x 20 km. The previous design fetched geometry
     * from this same request and grew the box to ~55 x 60 km to compensate,
     * which asked MOTIS for every route in a quarter of a Bundesland and is
     * what made searches slow and prone to timeouts.
     */
    const SEARCH_MIN_SPAN_LAT = 0.05;
    const SEARCH_MIN_SPAN_LON = 0.08;
    const SEARCH_MAX_SPAN_LAT = 0.18;
    const SEARCH_MAX_SPAN_LON = 0.30;
    const SEARCH_MIN_ZOOM = 13;     // below this MOTIS drops trams and buses

    /**
     * How many of a line's stop patterns to fetch in full when it is drawn.
     * Each is one route-details request, serialised by the rate limiter, so
     * this bounds the click-to-drawn latency; the search response fills in
     * whatever the skipped patterns would have added anyway.
     */
    const DETAIL_FETCH_MAX = 4;

    /**
     * Decimal places in a map/trips segment polyline. This is MOTIS's default
     * and what the segment schema documents; see getRadar() for why the request
     * does not ask for anything else.
     */
    const SEGMENT_PRECISION = 5;

    /** A one-character query matches a lot; only the closest few are useful. */
    const MAX_LINE_RESULTS = 8;

    /**
     * @param {{fetchJson: function(string): Promise<Object>, baseUrl: string}} opt
     *        The fetcher is injected so rate limiting, retries and the outage
     *        diagnostics in api.js apply here too.
     */
    function configure(opt) {
        if (opt.fetchJson) fetchJson = opt.fetchJson;
        if (opt.baseUrl) baseUrl = opt.baseUrl.replace(/\/+$/, '');
    }

    const call = (path, params) =>
        fetchJson(`${baseUrl}${path}${params && String(params) ? `?${params}` : ''}`);

    /**
     * MOTIS stop IDs are the source dataset's ID prefixed with a feed tag
     * ("de-DELFI_de:11000:900120025"), while the transport.rest endpoints use
     * bare numeric HAFAS IDs. A station saved under one will not resolve under
     * the other, so the app has to be able to tell them apart.
     * @param {string} id
     * @returns {boolean}
     */
    const isMotisId = (id) => /\D/.test(String(id || ''));

    // ===== Polylines =====

    /**
     * Decode a Google-encoded polyline.
     *
     * MOTIS varies the precision by endpoint — 5 for map segments, 6 or 7 for
     * journey legs, where it is carried alongside the string — so it is a
     * parameter rather than the usual hard-coded 1e5.
     *
     * @param {string} encoded
     * @param {number} [precision=5]
     * @returns {Array<[number, number]>} [lat, lng] pairs
     */
    function decodePolyline(encoded, precision = 5) {
        if (typeof encoded !== 'string' || !encoded) return [];
        const factor = Math.pow(10, precision);
        const points = [];
        let index = 0, lat = 0, lng = 0;

        while (index < encoded.length) {
            let result = 0, shift = 0, byte;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < encoded.length);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);

            result = 0; shift = 0;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < encoded.length);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);

            points.push([lat / factor, lng / factor]);
        }
        return points;
    }

    /**
     * Wrap decoded points in the GeoJSON FeatureCollection that
     * TransitApi.polylineToLatLngs() and polylineStations() already read, so the
     * map and the journey view need no MOTIS-specific branch.
     *
     * Stops are attached to their nearest shape point rather than appended,
     * because the point order *is* the drawn line — anything out of sequence
     * would put a kink in the route.
     *
     * @param {Array<[number, number]>} points
     * @param {Array<{id: string, name: string, lat: number, lon: number}>} [stops]
     * @returns {Object} GeoJSON FeatureCollection
     */
    function toFeatureCollection(points, stops = []) {
        const features = points.map(([lat, lng]) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: {}
        }));

        for (const stop of stops) {
            if (!stop || !isFinite(stop.lat) || !isFinite(stop.lon)) continue;
            let best = -1, bestDistance = Infinity;
            for (let i = 0; i < points.length; i++) {
                const dLat = points[i][0] - stop.lat;
                const dLng = (points[i][1] - stop.lon) * Math.cos(stop.lat * Math.PI / 180);
                const distance = dLat * dLat + dLng * dLng;
                if (distance < bestDistance) { bestDistance = distance; best = i; }
            }
            if (best >= 0) {
                features[best].properties = { id: stop.id || '', name: stop.name || '' };
            } else {
                // A leg with no shape at all still has endpoints worth drawing.
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                    properties: { id: stop.id || '', name: stop.name || '' }
                });
            }
        }

        return { type: 'FeatureCollection', features };
    }

    /** Journey legs carry their precision with them; map segments are always 5. */
    const legGeometry = (leg) => {
        const geo = leg && leg.legGeometry;
        if (!geo || !geo.points) return null;
        return toFeatureCollection(decodePolyline(geo.points, geo.precision || 5));
    };

    // ===== Shared field mapping =====

    const productOf = (mode) => MODE_TO_PRODUCT[mode] || '';

    /** What to print on the line badge. */
    const lineNameOf = (item) =>
        item.displayName || item.routeShortName || item.tripShortName || item.routeLongName || '';

    const lineOf = (item) => ({
        name: lineNameOf(item),
        product: productOf(item.mode),
        mode: item.mode || ''
    });

    /** Delay in seconds, the way the board renders it. */
    function delaySeconds(actual, scheduled) {
        if (!actual || !scheduled) return null;
        const diff = (Date.parse(actual) - Date.parse(scheduled)) / 1000;
        return isFinite(diff) ? Math.round(diff) : null;
    }

    /** MOTIS Place -> the stop shape the journey view and map markers expect. */
    const placeOf = (place) => {
        if (!place) return null;
        return {
            type: 'stop',
            id: place.stopId || '',
            name: place.name || '',
            address: place.name || '',
            location: { latitude: place.lat, longitude: place.lon }
        };
    };

    /** GTFS-RT alerts -> the remark shape the alerts banner reads. */
    const alertsOf = (alerts) => (Array.isArray(alerts) ? alerts : [])
        .map(alert => ({
            type: 'warning',
            text: alert.headerText || alert.descriptionText || '',
            summary: alert.headerText || ''
        }))
        .filter(remark => remark.text);

    /** Only send a mode filter when something is actually switched off. */
    function modeFilter(filters, products) {
        const off = products.filter(product => filters[product] === false);
        if (off.length === 0) return null;
        const on = products.filter(product => filters[product] !== false);
        const modes = on.flatMap(product => PRODUCT_TO_MODES[product] || []);
        // Everything off means everything off — not "no filter".
        return modes.length ? modes.join(',') : 'WALK';
    }

    // ===== Line lookup =====

    const normalise = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, '');

    /**
     * Clamp a viewport to the area a line search should cover.
     *
     * Too small and a line running one street over is invisible; too large and
     * the response is every bus route in the state. Both bounds are applied
     * around the centre of what the user is actually looking at.
     */
    function searchBox(bounds) {
        const centreLat = (bounds.north + bounds.south) / 2;
        const centreLon = (bounds.east + bounds.west) / 2;
        const spanLat = Math.min(SEARCH_MAX_SPAN_LAT,
            Math.max(SEARCH_MIN_SPAN_LAT, Math.abs(bounds.north - bounds.south)));
        const spanLon = Math.min(SEARCH_MAX_SPAN_LON,
            Math.max(SEARCH_MIN_SPAN_LON, Math.abs(bounds.east - bounds.west)));
        return {
            south: centreLat - spanLat / 2, north: centreLat + spanLat / 2,
            west: centreLon - spanLon / 2, east: centreLon + spanLon / 2
        };
    }

    /**
     * Stitch a route's segments into one path.
     *
     * A polyline is shared between every route that runs over that stretch, so
     * it is stored in one direction only and may be the wrong way round for
     * this one. Each segment is oriented against the stop it starts from before
     * being appended, otherwise the drawn line doubles back on itself.
     */
    function assembleRoute(info, polylines, stops) {
        return assembleFromSegments(info.segments || [], polylines, stops);
    }

    /**
     * Stitch an ordered list of segments into one path. See assembleRoute for
     * why each segment has to be oriented before it is appended.
     */
    function assembleFromSegments(segments, polylines, stops) {
        const points = [];
        const routeStops = [];

        for (const segment of segments) {
            const shared = polylines[segment.polyline];
            const from = stops[segment.from];
            const to = stops[segment.to];
            if (!shared || !shared.polyline) continue;

            let leg = decodePolyline(shared.polyline.points, shared.polyline.precision || 5);
            if (leg.length >= 2 && from && isFinite(from.lat)) {
                const head = leg[0], tail = leg[leg.length - 1];
                const near = (p) => Math.abs(p[0] - from.lat) + Math.abs(p[1] - from.lon);
                if (near(tail) < near(head)) leg = leg.slice().reverse();
            }

            // The join between two segments is the same stop twice over.
            if (points.length && leg.length && points[points.length - 1][0] === leg[0][0]
                && points[points.length - 1][1] === leg[0][1]) leg = leg.slice(1);

            points.push(...leg);
            if (from) routeStops.push(from);
            if (to) routeStops.push(to);
        }

        // Stops repeat at every segment join.
        const seen = new Set();
        const uniqueStops = [];
        for (const stop of routeStops) {
            const key = stop.stopId || `${stop.lat},${stop.lon}`;
            if (seen.has(key)) continue;
            seen.add(key);
            uniqueStops.push({ id: stop.stopId || '', name: stop.name || '', lat: stop.lat, lon: stop.lon });
        }

        return { points, stops: uniqueStops };
    }

    /**
     * Every distinct stop-to-stop hop a set of routes runs over.
     *
     * MOTIS splits one line into several routes — one per distinct stop
     * sequence, so short workings and each direction are separate entries.
     * Drawing any single one of them draws part of the line, which is what
     * made a search for M10 come back as a handful of stops. Pooling their
     * segments first gives the line as a whole.
     */
    function collectEdges(infos, polylines) {
        const edges = new Map();
        for (const info of infos) {
            for (const segment of info.segments || []) {
                if (!polylines[segment.polyline]) continue;
                // The same hop appears once per route running it, and once per
                // direction with the endpoints swapped.
                const key = [segment.from, segment.to].sort((a, b) => a - b).join('-');
                if (!edges.has(key)) {
                    edges.set(key, { from: segment.from, to: segment.to, polyline: segment.polyline });
                }
            }
        }
        return [...edges.values()];
    }

    /**
     * How well a route's names answer what was typed.
     *
     * Exact beats prefix beats substring, so typing "5" still puts line 5 above
     * RNV 5 and 105, while "rnv" finds every RNV line. The long name matches
     * too but always ranks below the short one — it is a description, not a
     * label, and matching it should never outrank the thing printed on the
     * front of the vehicle.
     *
     * @returns {number} higher is better; -1 for no match
     */
    function matchScore(wanted, route) {
        const short = normalise(route.shortName);
        const long = normalise(route.longName);
        if (short === wanted) return 4;
        if (short.startsWith(wanted)) return 3;
        if (short.includes(wanted)) return 2;
        if (long.includes(wanted)) return 1;
        return -1;
    }

    /**
     * Split the pooled hops into as few continuous runs as possible.
     *
     * A line is not always one path. RNV 5 in Mannheim is a ring, and plenty of
     * lines have a branch or a depot spur, so reducing the whole thing to its
     * single longest walk drew a ring as a semicircle and a branch not at all.
     * Every hop ends up in exactly one run here, so the drawn line is the whole
     * line; the runs are as long as they can be so the map gets a handful of
     * polylines rather than one per stop pair.
     */
    function chainEdges(edges) {
        const unused = new Set(edges.keys());
        const touching = new Map();
        edges.forEach((edge, i) => {
            for (const stop of [edge.from, edge.to]) {
                if (!touching.has(stop)) touching.set(stop, []);
                touching.get(stop).push(i);
            }
        });
        const nextFrom = (stop) => (touching.get(stop) || []).find(i => unused.has(i));

        const chains = [];
        while (unused.size > 0) {
            const seed = unused.values().next().value;
            unused.delete(seed);
            const chain = [edges[seed]];

            // Grow forwards, then backwards, taking any hop that still needs a
            // home and turning it to face the way we are walking.
            for (let stop = chain[chain.length - 1].to; ;) {
                const i = nextFrom(stop);
                if (i === undefined) break;
                unused.delete(i);
                const edge = edges[i];
                const step = edge.from === stop ? edge : { from: edge.to, to: edge.from, polyline: edge.polyline };
                chain.push(step);
                stop = step.to;
            }
            for (let stop = chain[0].from; ;) {
                const i = nextFrom(stop);
                if (i === undefined) break;
                unused.delete(i);
                const edge = edges[i];
                const step = edge.to === stop ? edge : { from: edge.to, to: edge.from, polyline: edge.polyline };
                chain.unshift(step);
                stop = step.from;
            }
            chains.push(chain);
        }
        return chains;
    }

    /**
     * The hops that make up the line proper, dropping anything not joined to it.
     *
     * Pooling by route id already keeps a different operator's identically
     * named line out, but a route's own data can still carry a stray fragment —
     * a depot spur recorded as its own pattern, a corridor left over from an
     * old routing. Drawn, those appear as a piece of line floating somewhere
     * the tram does not go. A line is one connected thing, so only the largest
     * connected group of hops is kept.
     */
    function connectedCore(edges) {
        if (edges.length === 0) return edges;

        // Union-find over the stops the hops touch.
        const parent = new Map();
        const find = (x) => {
            while (parent.get(x) !== x) {
                parent.set(x, parent.get(parent.get(x)));
                x = parent.get(x);
            }
            return x;
        };
        for (const edge of edges) {
            for (const stop of [edge.from, edge.to]) if (!parent.has(stop)) parent.set(stop, stop);
        }
        for (const edge of edges) {
            const a = find(edge.from), b = find(edge.to);
            if (a !== b) parent.set(a, b);
        }

        const sizes = new Map();
        for (const edge of edges) {
            const root = find(edge.from);
            sizes.set(root, (sizes.get(root) || 0) + 1);
        }
        let biggest = null, most = -1;
        for (const [root, size] of sizes) if (size > most) { most = size; biggest = root; }

        const core = edges.filter(edge => find(edge.from) === biggest);
        if (core.length !== edges.length) {
            console.info(`Line: ignored ${edges.length - core.length} hop(s) not connected to it.`);
        }
        return core;
    }

    /** Stops where the line ends rather than carries on. A ring has none. */
    function terminiOf(edges) {
        const degree = new Map();
        for (const edge of edges) {
            degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
            degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
        }
        return [...degree.entries()].filter(([, n]) => n === 1).map(([stop]) => stop);
    }

    /**
     * Find a line by name and return the whole line plus its variants.
     *
     * Unlike the transport.rest search this is geographic rather than
     * network-wide — MOTIS has no search-by-name endpoint — so it covers the
     * area around what is on screen. It reads the scheduled route rather than a
     * running vehicle, which means a line that is not currently operating still
     * draws.
     *
     * The first result is the line end to end; the ones after it are the
     * individual routes MOTIS holds for it, which are worth keeping because a
     * short working or a branch is a real thing to want to look at.
     *
     * @param {string} query
     * @param {{bounds: Object, zoom: number, results: number}} opt
     * @returns {Promise<{trips: Array}>} shaped like the transport.rest result
     */
    async function searchTripsByLine(query, opt = {}) {
        const wanted = normalise(query);
        if (!wanted || !opt.bounds) return { trips: [] };

        const box = searchBox(opt.bounds);
        const zoom = Math.max(SEARCH_MIN_ZOOM, Math.min(Math.round(opt.zoom || SEARCH_MIN_ZOOM), 16));

        const params = new URLSearchParams({
            zoom: String(zoom),
            min: `${box.south},${box.west}`,
            max: `${box.north},${box.east}`,
            language: 'de'
        });

        const data = await call('/api/experimental/map/routes', params);
        const infos = Array.isArray(data && data.routes) ? data.routes : [];
        const polylines = Array.isArray(data && data.polylines) ? data.polylines : [];
        const stops = Array.isArray(data && data.stops) ? data.stops : [];

        routeCache.clear();

        // Group the matching routes by the line they belong to: a search for
        // "M10" should produce one M10, not one per stop sequence. Grouped by
        // the route's own id rather than the printed name — two operators can
        // both run something called M10, and pooling their segments would draw
        // one line's arms onto the other.
        const lines = new Map();
        for (const info of infos) {
            let best = -1;
            let bestRoute = null;
            for (const route of info.transitRoutes || []) {
                const score = matchScore(wanted, route);
                if (score > best) { best = score; bestRoute = route; }
            }
            if (best < 0) continue;

            const key = bestRoute.id || bestRoute.shortName || bestRoute.longName || query;
            if (!lines.has(key)) {
                lines.set(key, {
                    key,
                    name: bestRoute.shortName || bestRoute.longName || query,
                    match: bestRoute, score: best, infos: []
                });
            }
            const line = lines.get(key);
            line.infos.push(info);
            if (best > line.score) { line.score = best; line.match = bestRoute; }
        }

        // Closest answer first, and a cap so a one-character query does not
        // return every line in the region.
        const ranked = [...lines.values()]
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'de', { numeric: true }))
            .slice(0, MAX_LINE_RESULTS);

        const trips = [];
        for (const line of ranked) {
            const product = productOf(line.infos[0].mode);
            const mode = line.infos[0].mode || '';

            // The label comes from the long name — in GTFS usually the two
            // termini ("Warschauer Str. <> Hauptbahnhof"). Assembling the real
            // termini here would need the geometry this request deliberately no
            // longer carries in full.
            const direction = line.match.longName || '';

            const id = `${ROUTE_ID_PREFIX}line:${line.key}`;
            routeCache.set(id, {
                id, name: line.name, direction, product, mode,
                // Everything needed to draw the whole line later: which
                // patterns to fetch in full, and the partial data this search
                // already returned as a fallback and a supplement.
                routeIdxs: [...new Set(line.infos.map(info => info.routeIdx).filter(Number.isFinite))],
                searchData: { routes: line.infos, polylines, stops }
            });
            trips.push({ id, line: { name: line.name, product }, direction, kind: 'line' });
        }

        return { trips };
    }

    /** Full data for one stop pattern, by the index map/routes handed out. */
    function fetchRouteDetails(routeIdx) {
        const params = new URLSearchParams({ routeIdx: String(routeIdx), language: 'de' });
        return call('/api/experimental/map/route-details', params);
    }

    /**
     * Concatenate several {routes, polylines, stops} payloads into one, with
     * every segment's indices remapped into the combined arrays.
     */
    function mergeRouteData(payloads) {
        const stops = [];
        const polylines = [];
        const infos = [];

        // The same physical stop appears in several payloads at different
        // array positions. Indices are the graph's node identity, so they have
        // to be unified — otherwise Alexanderplatz-from-payload-one and
        // Alexanderplatz-from-payload-two are two unconnected nodes, the
        // line's graph falls apart at every payload boundary, and the
        // largest-connected-component filter throws most of the line away.
        const canonical = new Map();
        const stopIndex = (stop) => {
            if (!stop) return -1;
            const key = stop.stopId
                || `${(+stop.lat).toFixed(5)},${(+stop.lon).toFixed(5)}`;
            if (!canonical.has(key)) {
                canonical.set(key, stops.length);
                stops.push(stop);
            }
            return canonical.get(key);
        };

        for (const data of payloads) {
            if (!data) continue;
            const localStops = Array.isArray(data.stops) ? data.stops : [];
            const polyBase = polylines.length;
            polylines.push(...(Array.isArray(data.polylines) ? data.polylines : []));
            for (const info of (Array.isArray(data.routes) ? data.routes : [])) {
                infos.push({
                    ...info,
                    segments: (info.segments || []).map(segment => ({
                        from: stopIndex(localStops[segment.from]),
                        to: stopIndex(localStops[segment.to]),
                        polyline: segment.polyline + polyBase
                    })).filter(segment => segment.from >= 0 && segment.to >= 0)
                });
            }
        }
        return { infos, polylines, stops };
    }

    /**
     * Pool a line's patterns into the drawn line: deduplicated hops, only the
     * connected core, chained into as few runs as possible.
     */
    function assembleWholeLine(infos, polylines, stops) {
        const edges = connectedCore(collectEdges(infos, polylines));
        const chains = chainEdges(edges);

        const shapes = [];
        for (const chain of chains) {
            const run = assembleFromSegments(chain, polylines, stops);
            if (run.points.length < 2) continue;
            shapes.push(toFeatureCollection(run.points, run.stops));
        }

        const termini = terminiOf(edges)
            .map(i => stops[i])
            .filter(Boolean)
            .map(stop => ({ id: stop.stopId || '', name: stop.name || '', lat: stop.lat, lon: stop.lon }));

        return { shapes, termini };
    }

    /**
     * Draw data for a line picked from the search.
     *
     * The full geometry is fetched per stop pattern from route-details, which
     * is not limited to any bounding box — this is what lets a line run past
     * the edge of wherever the search happened to look. The search response's
     * own partial data is merged in as well, so a pattern beyond
     * DETAIL_FETCH_MAX, or a route-details endpoint that fails, degrades to
     * what the search already knew instead of to nothing.
     */
    async function lineTrip(cached) {
        if (!cached.assembled) {
            const idxs = cached.routeIdxs.slice(0, DETAIL_FETCH_MAX);
            if (cached.routeIdxs.length > idxs.length) {
                console.info(`Line ${cached.name}: fetching ${idxs.length} of ${cached.routeIdxs.length} patterns in full.`);
            }
            const details = await Promise.allSettled(idxs.map(fetchRouteDetails));
            const payloads = details
                .filter(result => result.status === 'fulfilled')
                .map(result => result.value);
            if (payloads.length < idxs.length) {
                console.warn(`Line ${cached.name}: ${idxs.length - payloads.length} route-details request(s) failed; drawing from search data.`);
            }

            const merged = mergeRouteData([...payloads, cached.searchData]);
            const { shapes, termini } = assembleWholeLine(merged.infos, merged.polylines, merged.stops);
            cached.assembled = { shapes, termini };
        }

        const { shapes, termini } = cached.assembled;
        if (shapes.length === 0) return { trip: {} };
        return { trip: {
            id: cached.id,
            line: { name: cached.name, product: cached.product, mode: cached.mode },
            direction: cached.direction,
            polyline: shapes[0],
            polylines: shapes,
            termini
        } };
    }

    // ===== Endpoints =====

    /**
     * One index for stops, points of interest and addresses.
     * @returns {Promise<Array<{kind: string, id: string, name: string,
     *                          latitude: number, longitude: number}>>}
     */
    async function searchPlaces(query, opt = {}) {
        const text = (query || '').trim();
        if (text.length < 2) return [];

        const params = new URLSearchParams({
            text,
            language: 'de',
            numResults: String(opt.results || 8)
        });
        // The filter is a single type; asking for stops only is the common case
        // and worth narrowing server-side.
        if (opt.stops !== false && !opt.addresses && !opt.poi) params.set('type', 'STOP');

        const data = await call('/api/v1/geocode', params);
        if (!Array.isArray(data)) return [];

        const wantStops = opt.stops !== false;
        const wantOther = !!(opt.addresses || opt.poi);

        const places = [];
        for (const match of data) {
            if (!match || !isFinite(match.lat) || !isFinite(match.lon)) continue;

            const isStop = match.type === 'STOP';
            if (isStop && !wantStops) continue;
            if (!isStop && !wantOther) continue;

            // A geocoded address names itself by street and number rather than
            // in `name`, the way an envelope would be written.
            const street = [match.street, match.houseNumber].filter(Boolean).join(' ');
            const name = match.name || street;
            if (!name) continue;

            places.push({
                kind: isStop ? 'stop' : (match.type === 'PLACE' ? 'poi' : 'address'),
                id: match.id ? String(match.id) : '',
                name,
                detail: [street && match.name ? street : '', [match.zip, cityOf(match)].filter(Boolean).join(' ')]
                    .filter(Boolean).join(', '),
                latitude: match.lat,
                longitude: match.lon
            });
        }
        return places;
    }

    /** Areas are ordered outward; the first non-country one reads as the city. */
    function cityOf(match) {
        const areas = Array.isArray(match.areas) ? match.areas : [];
        const named = areas.find(area => area && area.name && area.adminLevel >= 6);
        return named ? named.name : '';
    }

    async function getDepartures(stationId, filters = {}, duration = 30, results = null, products = []) {
        const params = new URLSearchParams({
            stopId: String(stationId),
            arriveBy: 'false',
            window: String(Math.max(60, duration * 60)),   // MOTIS counts seconds
            language: 'de',
            withAlerts: 'true'
        });
        if (results) params.set('n', String(results));

        const modes = modeFilter(filters, products);
        if (modes) params.set('mode', modes);

        const data = await call(`/api/${API_VERSION}/stoptimes`, params);
        const stopTimes = Array.isArray(data && data.stopTimes) ? data.stopTimes : [];

        return {
            // Kept so getStation() can reuse this call rather than making a second.
            place: (data && data.place) || null,
            departures: stopTimes.map(stopTime => {
                const place = stopTime.place || {};
                return {
                    tripId: stopTime.tripId || '',
                    direction: stopTime.headsign || (stopTime.tripTo && stopTime.tripTo.name) || '',
                    when: place.departure || null,
                    plannedWhen: place.scheduledDeparture || null,
                    delay: stopTime.realTime ? delaySeconds(place.departure, place.scheduledDeparture) : null,
                    platform: place.track || '',
                    plannedPlatform: place.scheduledTrack || '',
                    cancelled: !!(place.cancelled || stopTime.tripCancelled),
                    line: lineOf(stopTime),
                    remarks: alertsOf(place.alerts),
                    stop: placeOf(place)
                };
            })
        };
    }

    /** Station metadata. The cheapest route to a name is a one-event board. */
    async function getStation(stationId) {
        const params = new URLSearchParams({
            stopId: String(stationId),
            n: '1',
            language: 'de',
            withAlerts: 'false'
        });
        const data = await call(`/api/${API_VERSION}/stoptimes`, params);
        const place = (data && data.place) || {};
        return {
            type: 'stop',
            id: place.stopId || String(stationId),
            name: place.name || '',
            location: { latitude: place.lat, longitude: place.lon }
        };
    }

    /** A stop ID goes in as-is; an address goes in as `lat,lon`. */
    const placeParam = (place) => (place && typeof place === 'object')
        ? `${place.latitude},${place.longitude}`
        : String(place);

    async function getJourneys(from, to, filters = {}, opt = {}, products = []) {
        const params = new URLSearchParams({
            fromPlace: placeParam(from),
            toPlace: placeParam(to),
            numItineraries: String(opt.results || 4),
            // Every leg carries a shape here, walking legs included, so the
            // journey map never has to fall back to a straight line.
            detailedLegs: 'true',
            detailedTransfers: 'true',
            language: 'de'
        });

        if (typeof opt.transfers === 'number' && opt.transfers >= 0) {
            params.set('maxTransfers', String(opt.transfers));
        }
        if (opt.departure) {
            params.set('time', opt.departure instanceof Date
                ? opt.departure.toISOString()
                : opt.departure);
        }

        const modes = modeFilter(filters, products);
        if (modes) params.set('transitModes', modes);

        const data = await call(`/api/${API_VERSION}/plan`, params);
        const itineraries = Array.isArray(data && data.itineraries) ? data.itineraries : [];

        return { journeys: itineraries.map(toJourney) };
    }

    function toJourney(itinerary) {
        return {
            legs: (itinerary.legs || []).map(leg => {
                const walking = leg.mode === 'WALK';
                return {
                    origin: placeOf(leg.from),
                    destination: placeOf(leg.to),
                    departure: leg.startTime || null,
                    plannedDeparture: leg.scheduledStartTime || null,
                    arrival: leg.endTime || null,
                    plannedArrival: leg.scheduledEndTime || null,
                    departureDelay: leg.realTime ? delaySeconds(leg.startTime, leg.scheduledStartTime) : null,
                    arrivalDelay: leg.realTime ? delaySeconds(leg.endTime, leg.scheduledEndTime) : null,
                    departurePlatform: (leg.from && leg.from.track) || '',
                    plannedDeparturePlatform: (leg.from && leg.from.scheduledTrack) || '',
                    cancelled: !!leg.cancelled,
                    walking,
                    distance: walking && isFinite(leg.distance) ? leg.distance : null,
                    direction: leg.headsign || (leg.tripTo && leg.tripTo.name) || '',
                    tripId: leg.tripId || '',
                    line: walking ? null : lineOf(leg),
                    polyline: legGeometry(leg)
                };
            })
        };
    }

    /**
     * One trip's route. MOTIS returns it as a one-leg itinerary, so the shape
     * and the stop list both come out of that leg.
     */
    async function getTrip(tripId) {
        // A line picked from the search: the search found it, this fetches it
        // in full. Assembled once, then answered from memory on a re-click.
        if (String(tripId).startsWith(ROUTE_ID_PREFIX)) {
            const cached = routeCache.get(String(tripId));
            return cached ? lineTrip(cached) : { trip: {} };
        }

        const params = new URLSearchParams({
            tripId: String(tripId),
            detailedLegs: 'true',
            language: 'de'
        });
        const data = await call(`/api/${API_VERSION}/trip`, params);
        const leg = (data.legs || [])[0];
        if (!leg) return { trip: {} };

        const geo = leg.legGeometry || {};
        const points = decodePolyline(geo.points || '', geo.precision || 5);
        const stops = [leg.from, ...(leg.intermediateStops || []), leg.to]
            .filter(Boolean)
            .map(place => ({ id: place.stopId || '', name: place.name || '', lat: place.lat, lon: place.lon }));

        return {
            trip: {
                id: leg.tripId || String(tripId),
                line: lineOf(leg),
                direction: leg.headsign || (leg.tripTo && leg.tripTo.name) || '',
                polyline: toFeatureCollection(points, stops)
            }
        };
    }

    /**
     * Live vehicles.
     *
     * map/trips answers with the segments running in the box during a time
     * window — each with a departure, an arrival and the shape between two
     * stops — and leaves working out where the vehicle is to the caller. So
     * for every segment spanning this instant, walk its shape to the fraction
     * of the way the clock says it should have covered.
     *
     * @param {{north: number, south: number, east: number, west: number}} bbox
     * @param {Object} [opt]
     * @param {number} [opt.zoom=13] Map zoom — MOTIS uses it to decide which
     *        modes are worth returning (long distance only when far out).
     * @param {number} [opt.results] Cap, applied after interpolation.
     * @returns {Promise<{movements: Array}>}
     */
    async function getRadar(bbox, opt = {}) {
        const now = new Date();
        const zoom = isFinite(opt.zoom) ? Math.round(opt.zoom) : 13;

        const params = new URLSearchParams({
            zoom: String(zoom),
            // min/max are the corners of the box as `lat,lon`.
            min: `${bbox.south},${bbox.west}`,
            max: `${bbox.north},${bbox.east}`,
            startTime: now.toISOString(),
            endTime: new Date(now.getTime() + 30000).toISOString(),
            // `precision` is deliberately not sent. It sets how many decimal
            // places the returned polylines are encoded with, and the response
            // does not say which was used — so asking for fewer places to save
            // bandwidth (as the spec suggests doing when zoomed out) means
            // decoding against a number the client only assumes. Getting that
            // wrong divides every coordinate by a power of ten and puts the
            // whole fleet in the Gulf of Guinea. The default is 5, documented
            // on the segment itself, so leaving it alone is the one setting
            // that cannot disagree with the decoder.
            language: 'de'
        });

        const data = await call(`/api/${API_VERSION}/map/trips`, params);
        const segments = Array.isArray(data) ? data : [];
        const at = now.getTime();

        // Nothing outside the box was asked for, so anything outside it is a
        // decode gone wrong rather than a vehicle. Generous, because an
        // interpolated position sits between two stops and the far one can lie
        // beyond the edge.
        const margin = {
            lat: Math.abs(bbox.north - bbox.south) || 1,
            lon: Math.abs(bbox.east - bbox.west) || 1
        };
        const plausible = ([lat, lon]) =>
            lat <= bbox.north + margin.lat && lat >= bbox.south - margin.lat
            && lon <= bbox.east + margin.lon && lon >= bbox.west - margin.lon;

        const movements = [];
        const seen = new Set();
        let implausible = 0;
        for (const segment of segments) {
            const from = Date.parse(segment.departure);
            const to = Date.parse(segment.arrival);
            if (!isFinite(from) || !isFinite(to) || at < from || at > to) continue;

            const points = decodePolyline(segment.polyline, SEGMENT_PRECISION);
            const position = pointAlong(points, to > from ? (at - from) / (to - from) : 0);
            if (!position) continue;
            if (!plausible(position)) { implausible++; continue; }

            const trip = (segment.trips || [])[0] || {};
            const tripId = trip.tripId || '';
            // A trip can have several segments inside the box; it is still one
            // vehicle, and the one it is on right now has already been picked
            // by the time window above.
            const key = tripId || `${trip.displayName || ''}|${segment.to && segment.to.name}`;
            if (seen.has(key)) continue;
            seen.add(key);

            movements.push({
                tripId,
                line: {
                    name: trip.displayName || trip.routeShortName || '',
                    product: productOf(segment.mode)
                },
                location: { latitude: position[0], longitude: position[1] },
                direction: (segment.to && segment.to.name) || ''
            });

            if (opt.results && movements.length >= opt.results) break;
        }

        if (implausible > 0) {
            console.warn(`Discarded ${implausible} vehicle position(s) outside the requested area.`);
        }
        return { movements };
    }

    /**
     * The point a given fraction of the way along a path, measured by distance
     * rather than by index — segments between shape points are not equal
     * lengths, and stepping by index would make vehicles lurch.
     * @returns {[number, number]|null}
     */
    function pointAlong(points, fraction) {
        if (points.length === 0) return null;
        if (points.length === 1) return points[0];

        const clamped = Math.min(1, Math.max(0, fraction));
        const spans = [];
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            const dLat = points[i][0] - points[i - 1][0];
            const dLng = (points[i][1] - points[i - 1][1]) * Math.cos(points[i][0] * Math.PI / 180);
            const length = Math.sqrt(dLat * dLat + dLng * dLng);
            spans.push(length);
            total += length;
        }
        if (total === 0) return points[0];

        let walked = clamped * total;
        for (let i = 0; i < spans.length; i++) {
            if (walked <= spans[i] || i === spans.length - 1) {
                const share = spans[i] > 0 ? Math.min(1, walked / spans[i]) : 0;
                return [
                    points[i][0] + (points[i + 1][0] - points[i][0]) * share,
                    points[i][1] + (points[i + 1][1] - points[i][1]) * share
                ];
            }
            walked -= spans[i];
        }
        return points[points.length - 1];
    }

    return {
        configure,
        isMotisId,
        decodePolyline,
        searchPlaces,
        searchTripsByLine,
        getDepartures,
        getStation,
        getJourneys,
        getTrip,
        getRadar
    };
})();
