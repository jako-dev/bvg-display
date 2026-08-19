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
    let layerGroup = null;    // everything we draw lives here, so clearing is one call
    let svgEl = null;
    let tileConfig = { url: DEFAULT_TILE_URL, attribution: DEFAULT_ATTRIBUTION };
    let leafletPromise = null;
    let onFallback = null;    // notified when we drop from tiles to schematic

    // The current scene. Re-rendered wholesale on every change — the data sets
    // are small (tens of points) and this keeps the two backends in lockstep.
    let scene = { routes: [], stops: [], vehicles: [], focus: null };

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

            layerGroup = L.layerGroup().addTo(map);
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
                if (layerGroup) layerGroup.clearLayers();
                map.remove();
            } catch (e) {
                console.warn('Leaflet teardown failed, continuing to schematic:', e.message);
            }
            map = null;
            layerGroup = null;
        }
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
     * @param {Array<{lat: number, lng: number, label: string, product?: string, direction?: string}>} vehicles
     */
    function setVehicles(vehicles) {
        scene.vehicles = Array.isArray(vehicles) ? vehicles.filter(v => v && isFinite(v.lat) && isFinite(v.lng)) : [];
        renderVehiclesOnly();
    }

    function clear() {
        scene = { routes: [], stops: [], vehicles: [], focus: null };
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

    function renderScene() {
        if (mode === 'leaflet') renderLeaflet();
        else if (mode === 'svg') renderSvg();
    }

    // Vehicles move on every radar poll while routes stay put, so redrawing
    // just them avoids tearing down the whole scene several times a minute.
    function renderVehiclesOnly() {
        renderScene();
    }

    function renderLeaflet() {
        if (!map || !layerGroup || !window.L) return;
        const L = window.L;
        layerGroup.clearLayers();

        for (const route of scene.routes) {
            L.polyline(route.points, {
                color: productColor(route.product),
                weight: route.dashed ? 3 : 5,
                opacity: route.dashed ? 0.75 : 0.85,
                dashArray: route.dashed ? '6 8' : null,
                lineJoin: 'round',
                lineCap: 'round'
            }).addTo(layerGroup);
        }

        for (const stop of scene.stops) {
            const major = stop.kind === 'origin' || stop.kind === 'destination';
            L.circleMarker([stop.lat, stop.lng], {
                radius: major ? 7 : 4,
                color: '#ffffff',
                weight: major ? 3 : 2,
                fillColor: major ? '#1b1f24' : '#5b6672',
                fillOpacity: 1
            }).addTo(layerGroup).bindTooltip(stop.name, { direction: 'top' });
        }

        for (const vehicle of scene.vehicles) {
            const color = productColor(vehicle.product);
            const icon = L.divIcon({
                className: 'map-vehicle-icon',
                html: `<span class="map-vehicle" style="--vehicle-color:${color}">${escapeHtml(vehicle.label)}</span>`,
                iconSize: null
            });
            L.marker([vehicle.lat, vehicle.lng], { icon, keyboard: false })
                .addTo(layerGroup)
                .bindTooltip(`${vehicle.label} → ${vehicle.direction || '?'}`, { direction: 'top' });
        }
    }

    /**
     * Schematic renderer. Projects lat/lng with a plain equirectangular
     * transform, corrected for latitude so Berlin doesn't come out stretched,
     * then scales the result to fill the available box.
     */
    function renderSvg() {
        if (!svgEl) return;

        const points = collectPoints();
        svgEl.innerHTML = '';
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

        const svgNs = 'http://www.w3.org/2000/svg';
        const add = (tag, attrs, text) => {
            const node = document.createElementNS(svgNs, tag);
            for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
            if (text !== undefined) node.textContent = text;
            svgEl.appendChild(node);
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

        for (const vehicle of scene.vehicles) {
            const [x, y] = project([vehicle.lat, vehicle.lng]);
            add('circle', {
                cx: x.toFixed(1), cy: y.toFixed(1), r: 9,
                fill: productColor(vehicle.product),
                stroke: 'var(--map-stop-ring, #ffffff)', 'stroke-width': 2
            });
            add('text', {
                x: x.toFixed(1), y: (y + 3.5).toFixed(1),
                class: 'map-schematic-vehicle', 'text-anchor': 'middle'
            }, vehicle.label);
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

    /** Recompute layout after the container changed size (view switch, resize). */
    function refresh() {
        if (mode === 'leaflet' && map) map.invalidateSize();
        else if (mode === 'svg') renderSvg();
    }

    function destroy() {
        if (map) {
            map.remove();
            map = null;
            layerGroup = null;
        }
        svgEl = null;
        mode = null;
        scene = { routes: [], stops: [], vehicles: [], focus: null };
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
        setRoutes,
        setStops,
        setVehicles,
        clear,
        fit,
        refresh,
        destroy,
        productColor,
        getMode: () => mode
    };
})();
