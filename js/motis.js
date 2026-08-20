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
            precision: String(zoom >= 11 ? 5 : zoom >= 8 ? 4 : zoom >= 5 ? 3 : 2),
            language: 'de'
        });

        const data = await call(`/api/${API_VERSION}/map/trips`, params);
        const segments = Array.isArray(data) ? data : [];
        const at = now.getTime();

        const movements = [];
        const seen = new Set();
        for (const segment of segments) {
            const from = Date.parse(segment.departure);
            const to = Date.parse(segment.arrival);
            if (!isFinite(from) || !isFinite(to) || at < from || at > to) continue;

            const points = decodePolyline(segment.polyline, 5);
            const position = pointAlong(points, to > from ? (at - from) / (to - from) : 0);
            if (!position) continue;

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
        getDepartures,
        getStation,
        getJourneys,
        getTrip,
        getRadar
    };
})();
