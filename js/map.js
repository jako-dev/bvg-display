/**
 * Transit Map
 *
 * Draws routes, stops and live vehicles either on a real slippy map (Leaflet
 * over raster tiles) or, when that isn't available, as a self-contained SVG
 * schematic. Both renderers consume the same "scene" object, so the two can
 * never drift apart — only the drawing backend differs.
 *
 * Leaflet is vendored locally and loaded lazily: nothing here is fetched until
 * the map view is actually opened, which keeps the departure board and the
 * kiosk/LED views dependency-free.
 *
 * The fallback triggers on any of:
 *   - the vendored Leaflet script failing to load
 *   - tiles erroring (offline, blocked, tile server down)
 *   - no tile arriving within TILE_PROBE_MS
 */
const TransitMap = (() => {
    'use strict';

    const LEAFLET_JS = './vendor/leaflet/leaflet.js';
    const LEAFLET_CSS = './vendor/leaflet/leaflet.css';
    const DEFAULT_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const DEFAULT_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const TILE_PROBE_MS = 6000;   // how long to wait for the first tile before giving up
    const BERLIN_CENTER = [52.5175, 13.4470];
    const SVG_PADDING = 28;       // px kept clear around the schematic

    // Line colours by product — muted enough to sit on a map without shouting.
    const PRODUCT_COLORS = {
        suburban: '#3d8c40',
        subway: '#2f6cb5',
        tram: '#c8452f',
        bus: '#8a4f9e',
        ferry: '#2f8fa8',
        express: '#b5453f',
        regional: '#5c6f80',
        walking: '#7c8896'
    };

    let mode = null;          // 'leaflet' | 'svg' | null
    let container = null;
    let map = null;           // Leaflet map instance
    let staticLayer = null;   // routes + stops — rebuilt only when they change
    let vehicleLayer = null;  // vehicles — markers are moved, not recreated
    let svgEl = null;
    let svgStatic = null;
    let svgVehicles = null;
    let projection = null;    // reused between vehicle ticks so the view can't jitter
    let vehicleMarkers = new Map(); // key -> Leaflet marker / SVG <g>
    let tileConfig = { url: DEFAULT_TILE_URL, attribution: DEFAULT_ATTRIBUTION };
    let leafletPromise = null;
    let onFallback = null;    // notified when we drop from tiles to schematic

    // The current scene. Re-rendered wholesale on every change — the data sets
    // are small (tens of points) and this keeps the two backends in lockstep.
    // `pins` are standing landmarks (home), kept apart from `stops` so that
    // drawing a new route doesn't wipe them.
    let scene = { routes: [], stops: [], vehicles: [], pins: [], focus: null };

    const productColor = (product) => PRODUCT_COLORS[product] || '#6b7785';

    // ===== Leaflet loading =====

    function loadLeaflet() {
        if (leafletPromise) return leafletPromise;

        leafletPromise = new Promise((resolve, reject) => {
            if (window.L) return resolve(window.L);

            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = LEAFLET_CSS;
            document.head.appendChild(css);

            const script = document.createElement('script');
            script.src = LEAFLET_JS;
            script.async = true;
            script.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet loaded but window.L is missing')));
            script.onerror = () => reject(new Error('Leaflet script failed to load'));
            document.head.appendChild(script);
        }).catch(e => {
            leafletPromise = null; // allow a later retry
            throw e;
        });

        return leafletPromise;
    }

    /**
     * Resolve once we know whether tiles actually work. Leaflet firing
     * `tileerror` is decisive; silence is not, so a timeout backs it up.
     */
    function probeTiles(tileLayer) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                tileLayer.off('tileload', onLoad);
                tileLayer.off('tileerror', onError);
                resolve(ok);
            };
            const onLoad = () => finish(true);
            const onError = () => finish(false);
            const timer = setTimeout(() => finish(false), TILE_PROBE_MS);

            tileLayer.on('tileload', onLoad);
            tileLayer.on('tileerror', onError);
        });
    }

    // ===== Initialisation =====

    /**
     * Prepare the map inside `el`.
     * @param {HTMLElement} el
     * @param {Object} [opt]
     * @param {string} [opt.tileUrl] - Override the tile template
     * @param {string} [opt.attribution] - Override the tile attribution
     * @param {Function} [opt.onFallback] - Called with a reason when tiles are given up on
     * @returns {Promise<'leaflet'|'svg'>} which backend ended up active
     */
    async function init(el, opt = {}) {
        container = el;
        onFallback = opt.onFallback || null;
        if (opt.tileUrl) tileConfig.url = opt.tileUrl;
        if (opt.attribution) tileConfig.attribution = opt.attribution;

        if (mode) return mode;

        try {
            const L = await loadLeaflet();

            container.innerHTML = '';
            const canvas = document.createElement('div');
            canvas.className = 'map-canvas';
            container.appendChild(canvas);

            map = L.map(canvas, {
                center: BERLIN_CENTER,
                zoom: 13,
                zoomControl: true,
                attributionControl: true
            });

            const tiles = L.tileLayer(tileConfig.url, {
                attribution: tileConfig.attribution,
                maxZoom: 19,
                crossOrigin: true
            });
            const probe = probeTiles(tiles);
            tiles.addTo(map);

            staticLayer = L.layerGroup().addTo(map);
            vehicleLayer = L.layerGroup().addTo(map);
            mode = 'leaflet';

            // Leaflet measures the container on creation; in a view that was
            // hidden at that moment the size comes out as 0.
            setTimeout(() => map && map.invalidateSize(), 0);

            const tilesOk = await probe;
            if (!tilesOk) {
                fallbackToSvg('Kartenkacheln nicht erreichbar');
                return mode;
            }

            renderScene();
            return mode;
        } catch (e) {
            fallbackToSvg(e.message);
            return mode;
        }
    }

    function fallbackToSvg(reason) {
        if (map) {
            // Drop our own layers before tearing the map down. A scene drawn
            // while the tile probe was still running leaves markers whose DOM
            // position Leaflet never computed, and removing the map with those
            // still attached throws on `_leaflet_pos`.
            try {
                if (staticLayer) staticLayer.clearLayers();
                if (vehicleLayer) vehicleLayer.clearLayers();
                map.remove();
            } catch (e) {
                console.warn('Leaflet teardown failed, continuing to schematic:', e.message);
            }
            map = null;
            staticLayer = null;
            vehicleLayer = null;
        }
        vehicleMarkers.clear();
        mode = 'svg';
        buildSvg();
        renderScene();
        if (onFallback) onFallback(reason || 'Karte nicht verfügbar');
    }

    function buildSvg() {
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'map-canvas map-canvas-svg';
        svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgEl.setAttribute('class', 'map-schematic');
        svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        wrap.appendChild(svgEl);
        container.appendChild(wrap);
    }

    // ===== Scene mutation =====

    /**
     * @param {Array<{points: Array<[number, number]>, product?: string, label?: string, dashed?: boolean}>} routes
     */
    function setRoutes(routes) {
        scene.routes = Array.isArray(routes) ? routes.filter(r => r && Array.isArray(r.points) && r.points.length > 1) : [];
        renderScene();
    }

    /**
     * @param {Array<{lat: number, lng: number, name: string, kind?: 'stop'|'origin'|'destination'}>} stops
     */
    function setStops(stops) {
        scene.stops = Array.isArray(stops) ? stops.filter(s => s && isFinite(s.lat) && isFinite(s.lng)) : [];
        renderScene();
    }

    /**
     * Hand over the latest radar payload. Positions update once per poll —
     * markers are reused across polls (keyed below) so they move rather than
     * being destroyed and recreated, but nothing is animated in between.
     *
     * @param {Array<{key?: string, lat: number, lng: number, label: string,
     *                product?: string, direction?: string}>} vehicles
     */
    function setVehicles(vehicles) {
        scene.vehicles = Array.isArray(vehicles)
            ? vehicles.filter(v => v && isFinite(v.lat) && isFinite(v.lng))
            : [];
        syncVehicles();
    }

    // Trip id where the API gives one; otherwise line+direction, which is
    // stable enough that a marker isn't torn down and rebuilt every poll.
    const vehicleKey = (v) => v.key || v.tripId || `${v.label}|${v.direction || ''}`;

    /**
     * Standing landmarks — currently just "home". Unlike stops these survive a
     * new route being drawn, and they are left out of `fit()`: showing a line
     * across town should frame the line, not zoom out to take in your flat.
     * @param {Array<{lat: number, lng: number, label: string, glyph?: string}>} pins
     */
    function setPins(pins) {
        scene.pins = Array.isArray(pins)
            ? pins.filter(p => p && isFinite(p.lat) && isFinite(p.lng))
            : [];
        renderScene();
    }

    function clear() {
        scene = { routes: [], stops: [], vehicles: [], pins: scene.pins, focus: null };
        renderScene();
    }

    /** Fit the view to everything currently in the scene. */
    function fit() {
        const points = collectPoints();
        if (points.length === 0) return;

        if (mode === 'leaflet' && map) {
            const bounds = window.L.latLngBounds(points);
            map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
        } else {
            renderScene(); // the SVG projection always fits by construction
        }
    }

    function collectPoints() {
        const points = [];
        for (const route of scene.routes) points.push(...route.points);
        for (const stop of scene.stops) points.push([stop.lat, stop.lng]);
        for (const vehicle of scene.vehicles) points.push([vehicle.lat, vehicle.lng]);
        return points;
    }

    // ===== Rendering =====

    // Routes and stops change rarely; vehicles change several times a second.
    // Keeping them on separate layers means a vehicle tick never rebuilds a
    // route, and a new route never resets the animation.
    function renderScene() {
        if (mode === 'leaflet') renderLeafletStatic();
        else if (mode === 'svg') renderSvg();
        syncVehicles();
    }

    function renderLeafletStatic() {
        if (!map || !staticLayer || !window.L) return;
        const L = window.L;
        staticLayer.clearLayers();

        for (const route of scene.routes) {
            L.polyline(route.points, {
                color: productColor(route.product),
                weight: route.dashed ? 3 : 5,
                opacity: route.dashed ? 0.75 : 0.85,
                dashArray: route.dashed ? '6 8' : null,
                lineJoin: 'round',
                lineCap: 'round'
            }).addTo(staticLayer);
        }

        for (const pin of scene.pins) {
            const icon = L.divIcon({
                className: 'map-pin-icon',
                html: `<span class="map-pin">${escapeHtml(pin.glyph || '🏠')}</span>`,
                iconSize: null
            });
            L.marker([pin.lat, pin.lng], { icon, keyboard: false, zIndexOffset: 500 })
                .addTo(staticLayer)
                .bindTooltip(pin.label || 'Zuhause', { direction: 'top' });
        }

        for (const stop of scene.stops) {
            const major = stop.kind === 'origin' || stop.kind === 'destination';
            const marker = L.circleMarker([stop.lat, stop.lng], {
                radius: major ? 7 : 5,
                color: '#ffffff',
                weight: major ? 3 : 2,
                fillColor: major ? '#1b1f24' : '#5b6672',
                fillOpacity: 1
            }).addTo(staticLayer);

            // Endpoints stay labelled; intermediate stops would collide into an
            // unreadable smear on a 30-stop line, so those name on hover.
            marker.bindTooltip(stop.name, {
                direction: 'top',
                permanent: major && scene.stops.length <= 12,
                className: 'map-stop-tip'
            });
        }
    }

    /**
     * Reconcile the marker set against the current vehicles: create the new
     * ones, drop the departed, and move the rest. Recreating every marker on
     * each poll would make the whole fleet flicker and drop any open tooltip.
     */
    function syncVehicles() {
        if (mode === 'leaflet' && (!map || !vehicleLayer || !window.L)) return;
        if (mode === 'svg' && !svgVehicles) return;
        if (!mode) return;

        const seen = new Set();
        for (const vehicle of scene.vehicles) {
            const key = vehicleKey(vehicle);
            seen.add(key);
            if (!vehicleMarkers.has(key)) {
                vehicleMarkers.set(key, mode === 'leaflet'
                    ? createLeafletVehicle(vehicle)
                    : createSvgVehicle(vehicle));
            }
        }

        for (const [key, marker] of vehicleMarkers) {
            if (seen.has(key)) continue;
            if (mode === 'leaflet') vehicleLayer.removeLayer(marker);
            else marker.remove();
            vehicleMarkers.delete(key);
        }

        placeVehicles();
    }

    /** Put every marker at its reported position. */
    function placeVehicles() {
        for (const vehicle of scene.vehicles) {
            const marker = vehicleMarkers.get(vehicleKey(vehicle));
            if (!marker) continue;
            if (mode === 'leaflet') {
                marker.setLatLng([vehicle.lat, vehicle.lng]);
            } else if (projection) {
                const [x, y] = projection([vehicle.lat, vehicle.lng]);
                marker.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
            }
        }
    }

    function createLeafletVehicle(vehicle) {
        const L = window.L;
        const icon = L.divIcon({
            className: 'map-vehicle-icon',
            html: `<span class="map-vehicle" style="--vehicle-color:${productColor(vehicle.product)}">${escapeHtml(vehicle.label)}</span>`,
            iconSize: null
        });
        return L.marker([vehicle.lat, vehicle.lng], { icon, keyboard: false })
            .addTo(vehicleLayer)
            .bindTooltip(`${vehicle.label} → ${vehicle.direction || '?'}`, { direction: 'top' });
    }

    function createSvgVehicle(vehicle) {
        const ns = 'http://www.w3.org/2000/svg';
        const group = document.createElementNS(ns, 'g');

        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('r', '9');
        dot.setAttribute('fill', productColor(vehicle.product));
        dot.setAttribute('stroke', 'var(--map-stop-ring, #ffffff)');
        dot.setAttribute('stroke-width', '2');

        const label = document.createElementNS(ns, 'text');
        label.setAttribute('y', '3.5');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('class', 'map-schematic-vehicle');
        label.textContent = vehicle.label;

        const title = document.createElementNS(ns, 'title');
        title.textContent = `${vehicle.label} → ${vehicle.direction || '?'}`;

        group.append(title, dot, label);
        svgVehicles.appendChild(group);
        return group;
    }

    /**
     * Schematic renderer. Projects lat/lng with a plain equirectangular
     * transform, corrected for latitude so Berlin doesn't come out stretched,
     * then scales the result to fill the available box.
     */
    function renderSvg() {
        if (!svgEl) return;

        // Vehicles are deliberately excluded from the framing: including them
        // would re-fit the view every time one moved, and the whole schematic
        // would crawl around. Only fall back to them when nothing else exists.
        const anchors = [];
        for (const route of scene.routes) anchors.push(...route.points);
        for (const stop of scene.stops) anchors.push([stop.lat, stop.lng]);
        // Included here, unlike in fit(): the schematic has no viewport, so a
        // pin outside the projected bounds would simply not be drawn.
        for (const pin of scene.pins) anchors.push([pin.lat, pin.lng]);
        const points = anchors.length > 0 ? anchors : collectPoints();

        svgEl.innerHTML = '';
        vehicleMarkers.clear();
        svgStatic = null;
        svgVehicles = null;
        projection = null;

        if (points.length === 0) {
            svgEl.setAttribute('viewBox', '0 0 100 60');
            return;
        }

        const width = Math.max(container.clientWidth || 640, 240);
        const height = Math.max(container.clientHeight || 400, 180);
        svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);

        const lats = points.map(p => p[0]);
        const lngs = points.map(p => p[1]);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

        // A degree of longitude is shorter than a degree of latitude by cos(lat).
        const midLat = (minLat + maxLat) / 2;
        const lngScale = Math.cos(midLat * Math.PI / 180);
        const spanX = Math.max((maxLng - minLng) * lngScale, 1e-6);
        const spanY = Math.max(maxLat - minLat, 1e-6);
        const scale = Math.min((width - SVG_PADDING * 2) / spanX, (height - SVG_PADDING * 2) / spanY);
        const offsetX = (width - spanX * scale) / 2;
        const offsetY = (height - spanY * scale) / 2;

        const project = ([lat, lng]) => [
            offsetX + (lng - minLng) * lngScale * scale,
            // SVG y grows downward, latitude grows northward — hence the flip.
            offsetY + (maxLat - lat) * scale
        ];
        // Held for the vehicle ticks, which must place markers in the same
        // coordinate space without recomputing (and possibly shifting) it.
        projection = project;

        const svgNs = 'http://www.w3.org/2000/svg';
        svgStatic = document.createElementNS(svgNs, 'g');
        svgVehicles = document.createElementNS(svgNs, 'g');
        svgEl.append(svgStatic, svgVehicles);

        const add = (tag, attrs, text) => {
            const node = document.createElementNS(svgNs, tag);
            for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
            if (text !== undefined) node.textContent = text;
            svgStatic.appendChild(node);
            return node;
        };

        for (const route of scene.routes) {
            add('polyline', {
                points: route.points.map(project).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
                fill: 'none',
                stroke: productColor(route.product),
                'stroke-width': route.dashed ? 3 : 5,
                'stroke-linejoin': 'round',
                'stroke-linecap': 'round',
                'stroke-dasharray': route.dashed ? '6 8' : null,
                opacity: route.dashed ? 0.75 : 0.9
            });
        }

        for (const stop of scene.stops) {
            const [x, y] = project([stop.lat, stop.lng]);
            const major = stop.kind === 'origin' || stop.kind === 'destination';
            add('circle', {
                cx: x.toFixed(1), cy: y.toFixed(1), r: major ? 7 : 4,
                fill: major ? 'var(--map-stop-major, #1b1f24)' : 'var(--map-stop, #5b6672)',
                stroke: 'var(--map-stop-ring, #ffffff)', 'stroke-width': major ? 3 : 2
            });
            if (major) {
                add('text', {
                    x: (x + 11).toFixed(1), y: (y + 4).toFixed(1),
                    class: 'map-schematic-label'
                }, stop.name);
            }
        }

        for (const pin of scene.pins) {
            const [x, y] = project([pin.lat, pin.lng]);
            add('text', {
                x: x.toFixed(1), y: (y + 6).toFixed(1),
                'text-anchor': 'middle', class: 'map-schematic-pin'
            }, pin.glyph || '🏠');
        }

    }

    /**
     * The area currently visible, as a radar-ready bounding box.
     * Only meaningful for the Leaflet backend — the schematic has no viewport
     * of its own, it just draws whatever it is given.
     * @returns {{north: number, south: number, east: number, west: number}|null}
     */
    function getBounds() {
        if (mode !== 'leaflet' || !map) return null;
        const bounds = map.getBounds();
        if (!bounds) return null;
        return {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
    }

    /**
     * Current zoom, for backends that use it to decide how much to send.
     * Null on the schematic fallback, where there is no tile pyramid.
     * @returns {number|null}
     */
    function getZoom() {
        return (mode === 'leaflet' && map) ? map.getZoom() : null;
    }

    /** Recompute layout after the container changed size (view switch, resize). */
    function refresh() {
        if (mode === 'leaflet' && map) map.invalidateSize();
        else if (mode === 'svg') renderSvg();
    }

    function destroy() {
        if (map) {
            map.remove();
            map = null;
            staticLayer = null;
            vehicleLayer = null;
        }
        vehicleMarkers.clear();
        svgEl = null;
        svgStatic = null;
        svgVehicles = null;
        projection = null;
        mode = null;
        scene = { routes: [], stops: [], vehicles: [], pins: [], focus: null };
        if (container) container.innerHTML = '';
    }

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
    }

    return {
        init,
        getBounds,
        getZoom,
        setRoutes,
        setStops,
        setPins,
        setVehicles,
        clear,
        fit,
        refresh,
        destroy,
        productColor,
        getMode: () => mode
    };
})();
