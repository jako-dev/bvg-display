/**
 * BVG Departure Monitor - Main Application
 */
(() => {
    'use strict';

    // ===== Constants =====
    const STORAGE_KEY = 'bvg-display-state';
    const LOOKAHEAD_MINUTES = 30;   // How far ahead to ask the API for departures
    const MAX_API_RESULTS = 40;     // Upper bound when over-fetching for walk time
    const LED_MAX_MERGED = 30;      // Cap on merged departures in LED view
    const MAX_ALERTS = 3;
    const DELAY_THRESHOLD_SEC = 60; // Above this a departure counts as delayed
    const SEARCH_DEBOUNCE_MS = 300;
    const VIEW_MODES = ['single', 'split', 'journey', 'map', 'led'];
    const RADAR_INTERVAL_MS = 10000; // Live vehicle poll — one request per tick
    const RADAR_MAX_VEHICLES = 80;

    // ===== State =====
    const state = {
        stations: [],           // Saved stations [{id, name, walkTime}]
        activeStationId: null,  // Currently displayed station
        departureCount: 6,      // Number of departures to show
        refreshInterval: 30,    // Seconds between refreshes
        refreshTimer: null,
        theme: 'dark',
        viewMode: 'single',     // 'single' | 'split' | 'led'
        kioskMode: false,
        ledScrollEnabled: true, // Scroll through departures in LED mode
        ledScrollSpeed: 3000,   // ms between scroll steps
        splitLeftId: null,      // Station shown in the left split pane
        splitRightId: null,     // Station shown in the right split pane
        homeStationId: null,    // Journey origin — the "Home" the planner starts from
        homeAddress: null,      // Optional street address origin {address, latitude, longitude}
        destination: null,      // Journey target {id, name}
        mapLive: true,          // Poll /radar for live vehicles in the map view
        mapFilters: {           // Which products show as live vehicles on the map
            suburban: true, subway: true, tram: true,
            bus: true, ferry: true, express: true, regional: true
        },
        mapTileUrl: null,       // Override the tile server (config.json only)
        mapAttribution: null,   // Attribution shown for that tile server
        apiProvider: BvgApi.DEFAULT_PROVIDER,
        filters: {
            suburban: true,
            subway: true,
            tram: true,
            bus: true,
            ferry: true,
            express: true,
            regional: true
        }
    };

    // Incremented on every user action that changes what should be on screen.
    // A response tagged with an older token is stale and gets dropped, so a slow
    // request for a previous station can't overwrite the current one.
    let requestToken = 0;

    // Set when the board is driven by URL parameters (e.g. a Home Assistant
    // card). Such a page load is read-only: it renders what the URL asks for
    // without writing it into this browser's saved settings.
    let persistDisabled = false;

    // Journey planner + map runtime state. Not persisted: results go stale in
    // minutes, and a saved map route would be a route through yesterday.
    let journeys = [];
    let selectedJourney = -1;
    let radarTimer = null;
    let mapReady = false;
    let mapInitPromise = null;
    let shownRoute = null;   // { tripId, label } of the trip route on the map
    // Lines the map is currently about — a shown line, or the lines of a shown
    // connection. Live vehicles are narrowed to these: seeing every tram in
    // Berlin is noise, seeing the ones on the route you're looking at is not.
    let mapFocus = null;
    // Set by whatever triggered the map (a journey, a departure row) and
    // consumed once the map view is actually up.
    let pendingMapScene = null;
    // Search results keyed by station ID. The rendered markup only carries the
    // ID and name, but a station's coordinates are what the radar bounding box
    // is built from, so the full objects are kept until the pick is made.
    let lastSearchResults = new Map();
    // Latest radar payload, kept so the line picker and the map agree on what
    // is currently running.
    let liveVehicles = [];

    // ===== DOM References =====
    const dom = {
        settingsPanel: document.getElementById('settings-panel'),
        openSettings: document.getElementById('open-settings'),
        openSettingsCta: document.getElementById('open-settings-cta'),
        closeSettings: document.getElementById('close-settings'),
        stationSearch: document.getElementById('station-search'),
        searchResults: document.getElementById('search-results'),
        savedStations: document.getElementById('saved-stations'),
        homeAddressInput: document.getElementById('home-address'),
        homeAddressResults: document.getElementById('home-address-results'),
        homeAddressCurrent: document.getElementById('home-address-current'),
        stationTabs: document.getElementById('station-tabs'),
        departuresList: document.getElementById('departures-list'),
        loadingIndicator: document.getElementById('loading-indicator'),
        noStationMsg: document.getElementById('no-station-msg'),
        boardMessage: document.getElementById('board-message'),
        currentStationName: document.getElementById('current-station-name'),
        clock: document.getElementById('clock'),
        lastUpdate: document.getElementById('last-update'),
        dataSource: document.getElementById('data-source'),
        realtimeIndicator: document.getElementById('realtime-indicator'),
        alertsBanner: document.getElementById('alerts-banner'),
        apiProviderSelect: document.getElementById('api-provider'),
        departureCountSelect: document.getElementById('departure-count'),
        refreshIntervalInput: document.getElementById('refresh-interval'),
        themeDark: document.getElementById('theme-dark'),
        themeModern: document.getElementById('theme-modern'),
        // View mode
        viewSingle: document.getElementById('view-single'),
        viewSplit: document.getElementById('view-split'),
        singleView: document.getElementById('single-view'),
        splitView: document.getElementById('split-view'),
        splitDeparturesLeft: document.getElementById('split-departures-left'),
        splitDeparturesRight: document.getElementById('split-departures-right'),
        splitHeaderLeft: document.getElementById('split-header-left'),
        splitHeaderRight: document.getElementById('split-header-right'),
        splitLeftSelect: document.getElementById('split-left-select'),
        splitRightSelect: document.getElementById('split-right-select'),
        // LED view
        viewLed: document.getElementById('view-led'),
        ledView: document.getElementById('led-view'),
        ledCanvas: document.getElementById('led-canvas'),
        ledScrollToggle: document.getElementById('led-scroll-toggle'),
        ledScrollSpeed: document.getElementById('led-scroll-speed'),
        // Journey planner
        viewJourney: document.getElementById('view-journey'),
        journeyView: document.getElementById('journey-view'),
        journeyFrom: document.getElementById('journey-from'),
        journeyTo: document.getElementById('journey-to'),
        journeyToResults: document.getElementById('journey-to-results'),
        journeySearch: document.getElementById('journey-search'),
        journeyResults: document.getElementById('journey-results'),
        // Map
        viewMap: document.getElementById('view-map'),
        mapView: document.getElementById('map-view'),
        mapContainer: document.getElementById('map-container'),
        mapTitle: document.getElementById('map-title'),
        mapLiveToggle: document.getElementById('map-live-toggle'),
        mapLineInput: document.getElementById('map-line-input'),
        mapLineResults: document.getElementById('map-line-results'),
        mapFilters: document.getElementById('map-filters'),
        mapFit: document.getElementById('map-fit'),
        mapClear: document.getElementById('map-clear'),
        mapStatus: document.getElementById('map-status'),
        viewSwitch: document.getElementById('view-switch'),
        // Kiosk
        kioskBtn: document.getElementById('kiosk-btn'),
        kioskToggle: document.getElementById('kiosk-toggle')
    };

    // ===== Initialization =====
    async function init() {
        // Deployment (config.json) and URL config are resolved before the first
        // render, so a client that has never configured anything still comes up
        // with a populated board instead of the "add a station" placeholder.
        const config = await AppConfig.load().catch(e => {
            console.warn('Config load failed:', e);
            return { defaults: {}, overrides: {}, lock: false, ephemeral: false };
        });

        applySettings(config.defaults);                     // deployment defaults
        loadState();                                        // client's own saved settings
        if (config.lock) applySettings(config.defaults);    // locked deployment wins
        applySettings(config.overrides);                    // URL always wins
        // A URL-configured board is a view onto the app, not a setup step:
        // persisting it would overwrite the settings this browser already has.
        persistDisabled = config.ephemeral;
        reconcileStationSelection();

        setupEventListeners();
        updateClock();
        setInterval(updateClock, 1000);
        applyTheme(state.theme);
        applyFiltersToUI();
        renderSavedStations();
        renderSplitStationSelects();
        renderStationTabs();
        renderHomeAddress();
        renderJourneyControls();
        renderMapFilters();
        updateDataSourceLabel();

        if (state.kioskMode) {
            enterKioskMode(false); // restore without hint
        }

        // Lay the view out and load it once — applyViewMode does the initial fetch.
        applyViewMode(state.viewMode, { persist: false });

        // Config may name stations by ID only; fill in the labels in the
        // background so the board doesn't wait on extra API round-trips.
        resolveStationNames();

        // Pause refreshing while the tab is hidden; catch up when it returns.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopRefreshTimer();
                LedRenderer.stopScroll();
            } else {
                refreshCurrentView();
                startRefreshTimer();
            }
        });
    }

    // ===== Persistence =====
    /**
     * Layer a partial settings object (from config.json or the URL) onto the
     * running state. Only keys actually present are touched, so each layer
     * overrides the one below it without wiping anything it doesn't mention.
     */
    function applySettings(settings) {
        if (!settings) return;

        for (const [key, value] of Object.entries(settings)) {
            if (key === 'filters') {
                state.filters = { ...state.filters, ...value };
            } else if (key === 'mapFilters') {
                state.mapFilters = { ...state.mapFilters, ...value };
            } else if (key === 'stations') {
                // Config may give the ID only; the name is resolved from the
                // API later, with the ID standing in until it arrives.
                state.stations = value.map(s => ({
                    id: s.id,
                    name: s.name || s.id,
                    walkTime: s.walkTime || 0
                }));
            } else {
                state[key] = value;
            }
        }

        if (settings.apiProvider) {
            BvgApi.setProvider(settings.apiProvider);
            state.apiProvider = BvgApi.getProvider();
        }
    }

    /**
     * Make sure the station the board points at actually exists — config,
     * localStorage and the URL each bring their own station list, so the
     * selection they were saved against may be gone.
     */
    function reconcileStationSelection() {
        const has = (id) => id && state.stations.some(s => s.id === id);
        if (!has(state.activeStationId)) {
            state.activeStationId = state.stations.length > 0 ? state.stations[0].id : null;
        }
        if (!has(state.splitLeftId)) state.splitLeftId = null;
        if (!has(state.splitRightId)) state.splitRightId = null;
        // No explicit home yet (or it was removed) — the first station is the
        // most useful guess, and the planner is unusable without an origin.
        if (state.homeStationId === HOME_ADDRESS_VALUE && !state.homeAddress) {
            state.homeStationId = null; // address was removed under it
        }
        if (state.homeStationId !== HOME_ADDRESS_VALUE && !has(state.homeStationId)) {
            // A configured address is a deliberate choice of origin, so it wins
            // over silently falling back to the first saved station.
            state.homeStationId = state.homeAddress
                ? HOME_ADDRESS_VALUE
                : (state.stations.length > 0 ? state.stations[0].id : null);
        }
    }

    function loadState() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) return;
            const parsed = JSON.parse(saved);
            // Fall back to the current values rather than hard-coded ones:
            // config.json defaults are already in `state` at this point and
            // must survive keys an older saved state doesn't have.
            if (Array.isArray(parsed.stations) && parsed.stations.length > 0) {
                state.stations = parsed.stations;
                state.activeStationId = parsed.activeStationId || null;
                state.splitLeftId = parsed.splitLeftId || null;
                state.splitRightId = parsed.splitRightId || null;
                state.homeStationId = parsed.homeStationId || null;
            }
            state.departureCount = parsed.departureCount || state.departureCount;
            state.refreshInterval = clamp(parsed.refreshInterval || state.refreshInterval, 10, 120);
            if (parsed.theme) state.theme = parsed.theme === 'modern' ? 'modern' : 'dark';
            if (VIEW_MODES.includes(parsed.viewMode)) state.viewMode = parsed.viewMode;
            if (parsed.kioskMode !== undefined) state.kioskMode = !!parsed.kioskMode;
            if (parsed.ledScrollEnabled !== undefined) state.ledScrollEnabled = parsed.ledScrollEnabled !== false;
            state.ledScrollSpeed = parsed.ledScrollSpeed || state.ledScrollSpeed;
            state.apiProvider = parsed.apiProvider || state.apiProvider;
            if (parsed.mapLive !== undefined) state.mapLive = parsed.mapLive !== false;
            state.mapFilters = { ...state.mapFilters, ...parsed.mapFilters };
            if (parsed.destination && (parsed.destination.id
                    || (isFinite(parsed.destination.latitude) && isFinite(parsed.destination.longitude)))) {
                state.destination = parsed.destination;
            }
            if (parsed.homeAddress && isFinite(parsed.homeAddress.latitude) && isFinite(parsed.homeAddress.longitude)) {
                state.homeAddress = parsed.homeAddress;
            }
            state.filters = { ...state.filters, ...parsed.filters };
            BvgApi.setProvider(state.apiProvider);
            // setProvider ignores unknown hosts — mirror back what it accepted.
            state.apiProvider = BvgApi.getProvider();
        } catch (e) {
            console.warn('Failed to load saved state:', e);
        }
    }

    function saveState() {
        if (persistDisabled) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                stations: state.stations,
                activeStationId: state.activeStationId,
                departureCount: state.departureCount,
                refreshInterval: state.refreshInterval,
                theme: state.theme,
                viewMode: state.viewMode,
                kioskMode: state.kioskMode,
                ledScrollEnabled: state.ledScrollEnabled,
                ledScrollSpeed: state.ledScrollSpeed,
                splitLeftId: state.splitLeftId,
                splitRightId: state.splitRightId,
                homeStationId: state.homeStationId,
                homeAddress: state.homeAddress,
                destination: state.destination,
                mapLive: state.mapLive,
                mapFilters: state.mapFilters,
                apiProvider: state.apiProvider,
                filters: state.filters
            }));
        } catch (e) {
            console.warn('Failed to save state:', e);
        }
    }

    // ===== Event Listeners =====
    function setupEventListeners() {
        // Settings panel
        dom.openSettings.addEventListener('click', openSettings);
        dom.openSettingsCta.addEventListener('click', openSettings);
        dom.closeSettings.addEventListener('click', closeSettings);

        // Station search
        let searchTimeout;
        dom.stationSearch.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const query = e.target.value;
            if (query.trim().length < 2) {
                dom.searchResults.classList.add('hidden');
                return;
            }
            searchTimeout = setTimeout(() => searchStations(query), SEARCH_DEBOUNCE_MS);
        });

        dom.stationSearch.addEventListener('focus', () => {
            if (dom.searchResults.children.length > 0) {
                dom.searchResults.classList.remove('hidden');
            }
        });

        // One document-level handler for "click outside" behaviour.
        // Registered in the capture phase on purpose: the delegated handlers
        // below re-render their lists, which detaches the clicked node — by
        // bubble time `settingsPanel.contains(e.target)` would be false and the
        // panel would close every time a station is removed.
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-wrapper')) {
                dom.searchResults.classList.add('hidden');
                dom.journeyToResults.classList.add('hidden');
                dom.homeAddressResults.classList.add('hidden');
                dom.mapLineResults.classList.add('hidden');
            }
            if (dom.settingsPanel.classList.contains('open') &&
                !dom.settingsPanel.contains(e.target) &&
                !e.target.closest('#open-settings, #open-settings-cta')) {
                closeSettings();
            }
        }, true);

        // Delegated handlers — the lists are re-rendered often, so binding once
        // on the container avoids re-attaching listeners on every render.
        dom.searchResults.addEventListener('click', (e) => {
            const item = e.target.closest('.search-result-item[data-id]');
            if (!item) return;
            const hit = lastSearchResults.get(item.dataset.id);
            addStation(item.dataset.id, item.dataset.name, hit && hit.location);
            dom.searchResults.classList.add('hidden');
            dom.stationSearch.value = '';
        });

        dom.savedStations.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-remove[data-id]');
            if (btn) removeStation(btn.dataset.id);
        });

        dom.savedStations.addEventListener('change', (e) => {
            const input = e.target.closest('.walk-time-input[data-id]');
            if (!input) return;
            const val = clamp(parseInt(input.value, 10) || 0, 0, 30);
            input.value = val;
            const station = state.stations.find(s => s.id === input.dataset.id);
            if (station && station.walkTime !== val) {
                station.walkTime = val;
                saveState();
                refreshCurrentView();
            }
        });

        dom.stationTabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.station-tab[data-id]');
            if (!tab || tab.dataset.id === state.activeStationId) return;
            state.activeStationId = tab.dataset.id;
            saveState();
            renderStationTabs();
            showSingleStation();
        });

        // Filters
        BvgApi.PRODUCTS.forEach(key => {
            const checkbox = document.getElementById(`filter-${key}`);
            if (!checkbox) return;
            checkbox.addEventListener('change', (e) => {
                state.filters[key] = e.target.checked;
                saveState();
                refreshCurrentView();
            });
        });

        // Theme
        dom.themeDark.addEventListener('click', () => applyTheme('dark'));
        dom.themeModern.addEventListener('click', () => applyTheme('modern'));

        // API provider
        dom.apiProviderSelect.addEventListener('change', (e) => {
            state.apiProvider = e.target.value;
            BvgApi.setProvider(state.apiProvider);
            saveState();
            updateDataSourceLabel();
            refreshCurrentView();
        });

        // Departure count
        dom.departureCountSelect.addEventListener('change', (e) => {
            state.departureCount = parseInt(e.target.value, 10) || 6;
            saveState();
            refreshCurrentView();
        });

        // Refresh interval
        dom.refreshIntervalInput.addEventListener('change', (e) => {
            const val = clamp(parseInt(e.target.value, 10) || 30, 10, 120);
            state.refreshInterval = val;
            e.target.value = val;
            saveState();
            startRefreshTimer();
        });

        // View mode
        dom.viewSingle.addEventListener('click', () => applyViewMode('single'));
        dom.viewSplit.addEventListener('click', () => applyViewMode('split'));
        dom.viewJourney.addEventListener('click', () => applyViewMode('journey'));
        dom.viewMap.addEventListener('click', () => applyViewMode('map'));
        dom.viewLed.addEventListener('click', () => applyViewMode('led'));

        // Header switch — same modes, delegated so the markup stays declarative.
        dom.viewSwitch.addEventListener('click', (e) => {
            const btn = e.target.closest('.view-btn[data-view]');
            if (btn && btn.dataset.view !== state.viewMode) applyViewMode(btn.dataset.view);
        });

        // Journey planner
        dom.journeyFrom.addEventListener('change', (e) => {
            state.homeStationId = e.target.value || null;
            saveState();
            renderSavedStations();
            fetchJourneys();
        });

        // Home address search
        let addressTimeout;
        dom.homeAddressInput.addEventListener('input', (e) => {
            clearTimeout(addressTimeout);
            const query = e.target.value;
            if (query.trim().length < 3) {
                dom.homeAddressResults.classList.add('hidden');
                return;
            }
            addressTimeout = setTimeout(() => searchHomeAddress(query), SEARCH_DEBOUNCE_MS);
        });

        dom.homeAddressResults.addEventListener('click', (e) => {
            const item = e.target.closest('.search-result-item[data-address]');
            if (!item) return;
            state.homeAddress = {
                address: item.dataset.address,
                latitude: parseFloat(item.dataset.lat),
                longitude: parseFloat(item.dataset.lng)
            };
            // Setting an address is an implicit "start from here".
            state.homeStationId = HOME_ADDRESS_VALUE;
            dom.homeAddressInput.value = '';
            dom.homeAddressResults.classList.add('hidden');
            saveState();
            renderHomeAddress();
            renderJourneyControls();
            renderHomePin();
            if (state.viewMode === 'journey' && state.destination) fetchJourneys();
        });

        dom.homeAddressCurrent.addEventListener('click', (e) => {
            if (!e.target.closest('#home-address-clear')) return;
            state.homeAddress = null;
            if (state.homeStationId === HOME_ADDRESS_VALUE) state.homeStationId = null;
            reconcileStationSelection();
            saveState();
            renderHomeAddress();
            renderJourneyControls();
            renderHomePin();
        });

        let destTimeout;
        dom.journeyTo.addEventListener('input', (e) => {
            clearTimeout(destTimeout);
            const query = e.target.value;
            if (query.trim().length < 2) {
                dom.journeyToResults.classList.add('hidden');
                return;
            }
            destTimeout = setTimeout(() => searchDestination(query), SEARCH_DEBOUNCE_MS);
        });

        dom.journeyToResults.addEventListener('click', (e) => {
            const item = e.target.closest('.search-result-item[data-name]');
            if (!item) return;
            const lat = parseFloat(item.dataset.lat);
            const lng = parseFloat(item.dataset.lng);
            state.destination = item.dataset.kind === 'stop' && item.dataset.id
                ? { id: item.dataset.id, name: item.dataset.name }
                : { name: item.dataset.name, latitude: lat, longitude: lng };
            dom.journeyTo.value = item.dataset.name;
            dom.journeyToResults.classList.add('hidden');
            saveState();
            fetchJourneys();
        });

        dom.journeySearch.addEventListener('click', () => fetchJourneys());
        dom.journeyTo.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && state.destination) {
                dom.journeyToResults.classList.add('hidden');
                fetchJourneys();
            }
        });

        // A connection card opens that journey on the map.
        const openJourney = (target) => {
            const card = target.closest('.journey-card[data-index]');
            if (card) showJourneyOnMap(parseInt(card.dataset.index, 10));
        };
        dom.journeyResults.addEventListener('click', (e) => openJourney(e.target));
        dom.journeyResults.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                if (e.target.closest('.journey-card[data-index]')) {
                    e.preventDefault();
                    openJourney(e.target);
                }
            }
        });

        // Map controls
        dom.mapLiveToggle.addEventListener('change', (e) => {
            state.mapLive = e.target.checked;
            saveState();
            if (state.mapLive) {
                fetchRadar();
                startRadarTimer();
            } else {
                stopRadarTimer();
                liveVehicles = [];
                TransitMap.setVehicles([]);
            }
        });
        // Show any line's route by name — independent of the saved stations and
        // of what happens to be on screen.
        let lineTimeout;
        dom.mapLineInput.addEventListener('input', (e) => {
            clearTimeout(lineTimeout);
            const query = e.target.value.trim();
            if (query.length < 1) {
                dom.mapLineResults.classList.add('hidden');
                return;
            }
            lineTimeout = setTimeout(() => searchMapLine(query), SEARCH_DEBOUNCE_MS);
        });

        dom.mapLineInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            clearTimeout(lineTimeout);
            const first = dom.mapLineResults.querySelector('.search-result-item[data-trip-id]');
            if (first) first.click();
            else if (e.target.value.trim()) searchMapLine(e.target.value.trim());
        });

        dom.mapLineResults.addEventListener('click', (e) => {
            const item = e.target.closest('.search-result-item[data-trip-id]');
            if (!item) return;
            dom.mapLineResults.classList.add('hidden');
            showTripOnMap(item.dataset.tripId, item.dataset.label || '');
        });

        // Product filters — which live vehicles are drawn.
        dom.mapFilters.addEventListener('click', (e) => {
            const btn = e.target.closest('.map-filter[data-product]');
            if (!btn) return;
            const product = btn.dataset.product;
            state.mapFilters[product] = state.mapFilters[product] === false;
            saveState();
            renderMapFilters();
            applyMapFilters();
        });

        dom.mapFit.addEventListener('click', () => TransitMap.fit());
        dom.mapClear.addEventListener('click', () => {
            shownRoute = null;
            selectedJourney = -1;
            dom.mapLineInput.value = '';
            dom.mapLineResults.classList.add('hidden');
            TransitMap.setRoutes([]);
            TransitMap.setStops([]);
            dom.mapTitle.textContent = 'Karte';
            setMapFocus([]);
        });

        // A departure row opens that trip's route on the map.
        const openTrip = (row) => {
            if (!row || !row.dataset.tripId) return;
            showTripOnMap(row.dataset.tripId, row.dataset.tripLabel || '');
        };
        dom.departuresList.addEventListener('click', (e) => openTrip(e.target.closest('.departure-row[data-trip-id]')));
        dom.splitDeparturesLeft.addEventListener('click', (e) => openTrip(e.target.closest('.departure-row[data-trip-id]')));
        dom.splitDeparturesRight.addEventListener('click', (e) => openTrip(e.target.closest('.departure-row[data-trip-id]')));

        // Home station picker in the saved-stations list
        dom.savedStations.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-home[data-id]');
            if (!btn) return;
            state.homeStationId = btn.dataset.id;
            saveState();
            renderSavedStations();
            renderJourneyControls();
        });

        window.addEventListener('resize', () => {
            if (state.viewMode === 'map') TransitMap.refresh();
        });

        // Split view station pickers
        dom.splitLeftSelect.addEventListener('change', (e) => {
            state.splitLeftId = e.target.value || null;
            saveState();
            if (state.viewMode === 'split') fetchSplitDepartures();
        });
        dom.splitRightSelect.addEventListener('change', (e) => {
            state.splitRightId = e.target.value || null;
            saveState();
            if (state.viewMode === 'split') fetchSplitDepartures();
        });

        // LED scroll settings
        dom.ledScrollToggle.addEventListener('change', (e) => {
            state.ledScrollEnabled = e.target.checked;
            saveState();
            if (state.viewMode === 'led') fetchLedDepartures();
        });
        dom.ledScrollSpeed.addEventListener('change', (e) => {
            state.ledScrollSpeed = parseInt(e.target.value, 10) || 3000;
            saveState();
            if (state.viewMode === 'led') fetchLedDepartures();
        });

        // Kiosk mode
        dom.kioskBtn.addEventListener('click', toggleKioskMode);
        dom.kioskToggle.addEventListener('change', (e) => {
            if (e.target.checked) enterKioskMode(true);
            else exitKioskMode();
        });

        // Kiosk exit: Escape key or double-click outside the settings panel
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && state.kioskMode) exitKioskMode();
        });
        document.addEventListener('dblclick', (e) => {
            if (state.kioskMode && !e.target.closest('#settings-panel')) exitKioskMode();
        });
    }

    // ===== Settings Panel =====
    function openSettings() {
        dom.settingsPanel.classList.add('open');
    }

    function closeSettings() {
        dom.settingsPanel.classList.remove('open');
    }

    // ===== Theme =====
    function applyTheme(theme) {
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        dom.themeDark.classList.toggle('active', theme === 'dark');
        dom.themeModern.classList.toggle('active', theme === 'modern');
        saveState();
    }

    // ===== Clock =====
    function updateClock() {
        dom.clock.textContent = new Date().toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    // ===== Station Search =====
    async function searchStations(query) {
        try {
            renderSearchResults(await BvgApi.searchStations(query));
        } catch (e) {
            console.error('Search failed:', e);
            dom.searchResults.innerHTML = '<div class="search-result-item">Fehler bei der Suche</div>';
            dom.searchResults.classList.remove('hidden');
        }
    }

    function renderSearchResults(results) {
        lastSearchResults = new Map(results.map(stop => [String(stop.id), stop]));
        if (results.length === 0) {
            dom.searchResults.innerHTML = '<div class="search-result-item">Keine Ergebnisse</div>';
        } else {
            dom.searchResults.innerHTML = results.map(stop => `
                <div class="search-result-item" data-id="${escapeHtml(stop.id)}" data-name="${escapeHtml(stop.name)}">
                    <div>${escapeHtml(stop.name)}</div>
                    <div class="result-products">${getProductBadges(stop.products)}</div>
                </div>
            `).join('');
        }
        dom.searchResults.classList.remove('hidden');
    }

    const PRODUCT_LABELS = {
        suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram',
        bus: 'Bus', ferry: 'Fähre', express: 'IC/ICE', regional: 'Regional'
    };

    const PRODUCT_BADGES = {
        suburban: ['badge-suburban', 'S'],
        subway: ['badge-subway', 'U'],
        tram: ['badge-tram', 'T'],
        bus: ['badge-bus', 'B'],
        ferry: ['badge-ferry', 'F'],
        express: ['badge-express', 'IC'],
        regional: ['badge-regional', 'RE']
    };

    function getProductBadges(products) {
        if (!products) return '';
        return BvgApi.PRODUCTS
            .filter(key => products[key])
            .map(key => {
                const [cls, label] = PRODUCT_BADGES[key];
                return `<span class="badge ${cls}">${label}</span>`;
            })
            .join('');
    }

    // ===== Station Management =====
    function addStation(id, name, location) {
        if (state.stations.some(s => s.id === id)) return; // Already added
        const station = { id, name, walkTime: 0 };
        if (location && isFinite(location.latitude) && isFinite(location.longitude)) {
            station.lat = location.latitude;
            station.lng = location.longitude;
        }
        state.stations.push(station);
        state.activeStationId = id;
        saveState();
        renderSavedStations();
        renderSplitStationSelects();
        renderStationTabs();
        renderJourneyControls();
        closeSettings();
        refreshCurrentView();
    }

    function removeStation(id) {
        state.stations = state.stations.filter(s => s.id !== id);
        if (state.activeStationId === id) {
            state.activeStationId = state.stations.length > 0 ? state.stations[0].id : null;
        }
        saveState();
        renderSavedStations();
        renderSplitStationSelects();
        renderStationTabs();
        renderJourneyControls();
        refreshCurrentView();
    }

    /**
     * Config can list stations by ID alone (`?stop=900000100003`), which is the
     * only form available before the user has searched for anything. Look the
     * real names up in the background and refresh the labels once they land —
     * the board itself already works, the ID is just an ugly placeholder.
     */
    async function resolveStationNames() {
        // Config-supplied stations arrive as bare IDs, and stations saved before
        // coordinates were stored have a name but no position — both need a
        // lookup before the map can place them.
        const pending = state.stations.filter(s =>
            !s.name || s.name === s.id || !isFinite(s.lat) || !isFinite(s.lng));
        if (pending.length === 0) return;

        let resolved = false;
        for (const station of pending) {
            try {
                const data = await BvgApi.getStation(station.id);
                const stop = (data && data.stop) || data || {};
                if (stop.name && (!station.name || station.name === station.id)) {
                    station.name = stop.name;
                    resolved = true;
                }
                const loc = stop.location;
                if (loc && isFinite(loc.latitude) && isFinite(loc.longitude)) {
                    station.lat = loc.latitude;
                    station.lng = loc.longitude;
                    resolved = true;
                }
            } catch (e) {
                console.warn(`Could not resolve station ${station.id}:`, e.message);
            }
        }
        if (!resolved) return;

        saveState();
        renderSavedStations();
        renderSplitStationSelects();
        renderStationTabs();
        renderJourneyControls();
        updateStationHeadings();

        // The radar bounding box is derived from station coordinates, so a map
        // opened before they resolved had nothing to query with.
        if (state.viewMode === 'map' && state.mapLive) fetchRadar();
    }

    /** Re-label the headers for whichever view is currently on screen */
    function updateStationHeadings() {
        if (state.viewMode === 'single') {
            const station = getActiveStation();
            if (station) dom.currentStationName.textContent = station.name;
        } else if (state.viewMode === 'split') {
            const { left, right } = getSplitStations();
            if (left) dom.splitHeaderLeft.textContent = left.name;
            if (right) dom.splitHeaderRight.textContent = right.name;
        }
    }

    function renderSavedStations() {
        if (state.stations.length === 0) {
            dom.savedStations.innerHTML = '<p class="empty-hint">Noch keine Stationen gespeichert.</p>';
            return;
        }

        dom.savedStations.innerHTML = state.stations.map(station => {
            const isHome = station.id === state.homeStationId;
            return `
            <div class="saved-station${isHome ? ' is-home' : ''}">
                <button class="btn-home${isHome ? ' active' : ''}" data-id="${escapeHtml(station.id)}"
                        aria-pressed="${isHome ? 'true' : 'false'}"
                        aria-label="${escapeHtml(station.name)} als Start setzen"
                        title="Als Start für die Verbindungssuche">&#9733;</button>
                <span class="station-info">${escapeHtml(station.name)}</span>
                <input type="number" class="walk-time-input" data-id="${escapeHtml(station.id)}"
                       min="0" max="30" value="${station.walkTime || 0}"
                       aria-label="Fußweg zu ${escapeHtml(station.name)} in Minuten"
                       title="Fußweg (Minuten)">
                <span class="walk-time-unit">min</span>
                <button class="btn-remove" data-id="${escapeHtml(station.id)}"
                        aria-label="${escapeHtml(station.name)} entfernen" title="Entfernen">&times;</button>
            </div>`;
        }).join('');
    }

    /**
     * Resolve which two stations the split view shows. Falls back to the
     * first two saved stations whenever the persisted picks are missing or
     * no longer exist (e.g. after removing a station), and never lets both
     * panes resolve to the same station.
     */
    function getSplitStations() {
        const byId = (id) => state.stations.find(s => s.id === id) || null;
        let left = byId(state.splitLeftId) || state.stations[0] || null;
        let right = byId(state.splitRightId);
        if (!right || right.id === (left && left.id)) {
            right = state.stations.find(s => !left || s.id !== left.id) || null;
        }
        return { left, right };
    }

    function renderSplitStationSelects() {
        const options = (selectedId) => state.stations.map(s =>
            `<option value="${escapeHtml(s.id)}"${s.id === selectedId ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
        ).join('');

        const { left, right } = getSplitStations();
        dom.splitLeftSelect.innerHTML = options(left && left.id);
        dom.splitRightSelect.innerHTML = options(right && right.id);
        const noChoice = state.stations.length < 2;
        dom.splitLeftSelect.disabled = noChoice;
        dom.splitRightSelect.disabled = noChoice;
    }

    function renderStationTabs() {
        if (state.stations.length <= 1 || state.viewMode !== 'single') {
            dom.stationTabs.classList.add('hidden');
            return;
        }

        dom.stationTabs.classList.remove('hidden');
        dom.stationTabs.innerHTML = state.stations.map(station => `
            <button class="station-tab ${station.id === state.activeStationId ? 'active' : ''}"
                    data-id="${escapeHtml(station.id)}">
                ${escapeHtml(station.name)}
            </button>
        `).join('');
    }

    // ===== Board State Helpers =====
    function showBoardMessage(html) {
        dom.boardMessage.innerHTML = html;
        dom.boardMessage.classList.remove('hidden');
    }

    function clearBoardMessage() {
        dom.boardMessage.classList.add('hidden');
        dom.boardMessage.innerHTML = '';
    }

    function showNoStationMessage() {
        dom.loadingIndicator.classList.add('hidden');
        clearBoardMessage();
        dom.noStationMsg.classList.remove('hidden');
        dom.currentStationName.textContent = 'BVG Abfahrtsmonitor';
        dom.alertsBanner.classList.add('hidden');
        dom.departuresList.innerHTML = '';
        stopRefreshTimer();
    }

    // ===== Departures Display =====
    function showSingleStation() {
        if (!state.activeStationId) {
            showNoStationMessage();
            return;
        }

        dom.noStationMsg.classList.add('hidden');
        clearBoardMessage();
        dom.loadingIndicator.classList.remove('hidden');
        dom.departuresList.innerHTML = '';

        const station = getActiveStation();
        if (station) dom.currentStationName.textContent = station.name;

        fetchDepartures();
        startRefreshTimer();
    }

    function getActiveStation() {
        return state.stations.find(s => s.id === state.activeStationId) || null;
    }

    /**
     * How much to ask the API for. With a walk time set, the closest departures
     * get filtered out again — so look further ahead and pull extra rows,
     * otherwise the board ends up shorter than the user asked for.
     */
    function fetchParamsFor(station) {
        const walk = (station && station.walkTime) || 0;
        return {
            duration: LOOKAHEAD_MINUTES + walk,
            results: walk > 0
                ? Math.min(MAX_API_RESULTS, state.departureCount * 2 + 4)
                : state.departureCount
        };
    }

    async function loadStationDepartures(station) {
        const { duration, results } = fetchParamsFor(station);
        const data = await BvgApi.getDepartures(station.id, state.filters, duration, results);
        const departures = filterByWalkTime(data.departures || [], station.walkTime || 0);
        return { data, departures };
    }

    async function fetchDepartures() {
        const station = getActiveStation();
        if (!station) return;

        const token = ++requestToken;

        try {
            const { data, departures } = await loadStationDepartures(station);
            if (token !== requestToken) return; // superseded by a newer request

            dom.loadingIndicator.classList.add('hidden');

            const visible = departures.slice(0, state.departureCount);
            renderDepartures(visible);
            renderAlerts(data.departures || []);

            if (visible.length === 0) {
                showBoardMessage(`<p>Keine Abfahrten in den nächsten ${fetchParamsFor(station).duration} Minuten.</p>`);
            } else {
                clearBoardMessage();
            }

            updateRealtimeIndicator(data.realtimeDataUpdatedAt);
            updateLastRefreshTime();
        } catch (e) {
            if (token !== requestToken) return;
            console.error('Failed to fetch departures:', e);
            dom.loadingIndicator.classList.add('hidden');
            dom.departuresList.innerHTML = '';
            dom.alertsBanner.classList.add('hidden');
            showBoardMessage(`
                <p class="error-text">Fehler beim Laden der Abfahrten.</p>
                <p class="error-detail">${escapeHtml(e.message)}</p>
            `);
        }
    }

    function filterByWalkTime(departures, walkTime) {
        if (!walkTime || walkTime <= 0) return departures;
        const now = Date.now();
        return departures.filter(dep => {
            const when = departureDate(dep);
            if (!when) return true;
            return (when - now) / 60000 >= walkTime;
        });
    }

    /** Realtime time if available, otherwise the scheduled one */
    function departureDate(dep) {
        const raw = dep.when || dep.plannedWhen;
        if (!raw) return null;
        const parsed = new Date(raw);
        return isNaN(parsed) ? null : parsed;
    }

    function departureRowHtml(dep) {
        const line = dep.line || {};
        const lineName = line.name || '?';
        const lineProduct = line.product || '';
        const lineClass = getLineClass(line);
        const platform = dep.platform || dep.plannedPlatform || '';
        const timeInfo = formatDepartureTime(dep);

        let rowClass = 'departure-row';
        if (dep.cancelled === true) rowClass += ' cancelled';
        else if (dep.delay > DELAY_THRESHOLD_SEC) rowClass += ' delayed';

        // Rows with a trip are clickable: they open that trip's route on the
        // map. Without a tripId the API can't give us a shape, so the row stays
        // inert rather than advertising an action that would fail.
        const tripAttrs = dep.tripId
            ? ` data-trip-id="${escapeHtml(dep.tripId)}" data-trip-label="${escapeHtml(`${lineName} → ${dep.direction || ''}`.trim())}" role="button" tabindex="0" title="Route auf der Karte zeigen"`
            : '';
        if (dep.tripId) rowClass += ' is-clickable';

        return `
            <div class="${rowClass}"${tripAttrs}>
                <span class="col-line">
                    <span class="line-badge line-tint ${escapeHtml(lineProduct)} ${lineClass}">${escapeHtml(lineName)}</span>
                </span>
                <span class="col-destination">${escapeHtml(dep.direction || 'Unbekannt')}</span>
                <span class="col-platform">${escapeHtml(platform)}</span>
                <span class="col-departure">${timeInfo.main}${timeInfo.sub}</span>
            </div>
        `;
    }

    function renderDepartures(departures) {
        dom.departuresList.innerHTML = departures.map(departureRowHtml).join('');
    }

    function getLineClass(line) {
        if (!line || !line.name) return '';
        const name = line.name.toLowerCase().replace(/\s/g, '');
        // Match specific line names like u1, u2, s1, s41, etc.
        return /^[us]\d+$/.test(name) ? name : '';
    }

    function formatDepartureTime(dep) {
        if (dep.cancelled === true) {
            return { main: '<span class="cancelled-text">Fällt aus</span>', sub: '' };
        }

        const departureTime = departureDate(dep);
        if (!departureTime) return { main: '?', sub: '' };

        const diffMin = Math.round((departureTime - Date.now()) / 60000);

        let main;
        if (diffMin <= 0) {
            main = '<span class="now-text">jetzt</span>';
        } else if (diffMin < 60) {
            main = `${diffMin} min`;
        } else {
            main = departureTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }

        // Delay info (delay is in seconds)
        let sub = '';
        const delay = dep.delay;
        if (delay > DELAY_THRESHOLD_SEC) {
            sub = `<span class="delay-info">+${Math.round(delay / 60)} min</span>`;
        } else if (delay !== null && delay !== undefined && dep.when) {
            sub = '<span class="on-time">pünktlich</span>';
        }

        return { main, sub };
    }

    function updateRealtimeIndicator(hasRealtime) {
        dom.realtimeIndicator.classList.toggle('is-live', !!hasRealtime);
        dom.realtimeIndicator.title = hasRealtime ? 'Echtzeitdaten verfügbar' : 'Keine Echtzeitdaten';
    }

    function updateLastRefreshTime() {
        const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        dom.lastUpdate.textContent = `Letzte Aktualisierung: ${now}`;
    }

    function updateDataSourceLabel() {
        const providers = BvgApi.getProviders();
        dom.dataSource.textContent = `Daten: ${providers[BvgApi.getProvider()] || 'BVG / VBB'}`;
    }

    // ===== Alerts/Remarks =====
    function renderAlerts(departures) {
        const remarks = new Map(); // deduplicate by text
        departures.forEach(dep => {
            (dep.remarks || []).forEach(remark => {
                if (remark.type !== 'warning' && remark.type !== 'status') return;
                const text = remark.text || remark.summary;
                if (text && !remarks.has(text)) remarks.set(text, text);
            });
        });

        if (remarks.size === 0) {
            dom.alertsBanner.classList.add('hidden');
            dom.alertsBanner.innerHTML = '';
            return;
        }

        dom.alertsBanner.innerHTML = Array.from(remarks.values())
            .slice(0, MAX_ALERTS)
            .map(text => `<div class="alert-item"><span>${escapeHtml(text)}</span></div>`)
            .join('');
        dom.alertsBanner.classList.remove('hidden');
    }

    // ===== Filters =====
    function applyFiltersToUI() {
        BvgApi.PRODUCTS.forEach(key => {
            const checkbox = document.getElementById(`filter-${key}`);
            if (checkbox) checkbox.checked = state.filters[key];
        });
        dom.departureCountSelect.value = state.departureCount;
        dom.refreshIntervalInput.value = state.refreshInterval;
        dom.apiProviderSelect.value = state.apiProvider;
        dom.kioskToggle.checked = state.kioskMode;
        dom.ledScrollToggle.checked = state.ledScrollEnabled;
        dom.ledScrollSpeed.value = state.ledScrollSpeed;
    }

    // ===== Refresh Timer =====
    function startRefreshTimer() {
        stopRefreshTimer();
        if (state.stations.length === 0) return;
        state.refreshTimer = setInterval(refreshCurrentView, state.refreshInterval * 1000);
    }

    function stopRefreshTimer() {
        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
            state.refreshTimer = null;
        }
    }

    /** Reload whatever the active view is showing */
    function refreshCurrentView() {
        if (state.viewMode === 'split') {
            fetchSplitDepartures();
        } else if (state.viewMode === 'led') {
            fetchLedDepartures();
        } else if (state.viewMode === 'journey') {
            if (state.destination) fetchJourneys();
        } else if (state.viewMode === 'map') {
            fetchRadar();
        } else if (state.activeStationId) {
            fetchDepartures();
        } else {
            showNoStationMessage();
        }
    }

    // ===== View Mode =====
    function applyViewMode(mode, { persist = true } = {}) {
        state.viewMode = mode;
        dom.viewSingle.classList.toggle('active', mode === 'single');
        dom.viewSplit.classList.toggle('active', mode === 'split');
        dom.viewJourney.classList.toggle('active', mode === 'journey');
        dom.viewMap.classList.toggle('active', mode === 'map');
        dom.viewLed.classList.toggle('active', mode === 'led');

        // The header switch mirrors the settings buttons; whichever was used,
        // both have to end up showing the same mode.
        for (const btn of dom.viewSwitch.querySelectorAll('.view-btn[data-view]')) {
            const isActive = btn.dataset.view === mode;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }

        // Hide all views first
        dom.singleView.classList.add('hidden');
        dom.splitView.classList.add('hidden');
        dom.journeyView.classList.add('hidden');
        dom.mapView.classList.add('hidden');
        dom.ledView.classList.add('hidden');
        dom.stationTabs.classList.add('hidden');
        dom.alertsBanner.classList.add('hidden');

        // The LED scroll timer keeps redrawing an off-screen canvas otherwise.
        if (mode !== 'led') LedRenderer.stopScroll();
        // Same for the radar poll — no point paying for requests off-screen.
        if (mode !== 'map') stopRadarTimer();

        if (mode === 'journey') {
            dom.journeyView.classList.remove('hidden');
            dom.currentStationName.textContent = 'Verbindung suchen';
            renderJourneyControls();
            if (journeys.length > 0) {
                JourneyView.render(dom.journeyResults, journeys, { selectedIndex: selectedJourney });
            } else if (state.destination) {
                fetchJourneys();
            } else {
                showJourneyMessage('<p>W&auml;hle ein Ziel, um Verbindungen zu sehen.</p>');
            }
            stopRefreshTimer();
        } else if (mode === 'map') {
            dom.mapView.classList.remove('hidden');
            dom.currentStationName.textContent = 'Karte';
            dom.mapLiveToggle.checked = state.mapLive;
            // The container has a size only now that the view is visible, so the
            // map is created/measured here rather than up front.
            initMapView().then(() => {
                TransitMap.refresh(); // the container only has a size now
                renderHomePin();
                applyPendingMapScene();
                if (state.mapLive) {
                    fetchRadar();
                    startRadarTimer();
                }
            });
            stopRefreshTimer();
        } else if (mode === 'split') {
            dom.splitView.classList.remove('hidden');
            dom.currentStationName.textContent = 'BVG Abfahrtsmonitor';
            fetchSplitDepartures();
            startRefreshTimer();
        } else if (mode === 'led') {
            dom.ledView.classList.remove('hidden');
            dom.currentStationName.textContent = 'LED-Panel Emulation';
            LedRenderer.init(dom.ledCanvas);
            fetchLedDepartures();
            startRefreshTimer();
        } else {
            dom.singleView.classList.remove('hidden');
            renderStationTabs();
            showSingleStation();
        }

        if (persist) saveState();
    }

    async function fetchLedDepartures() {
        if (state.stations.length === 0) {
            LedRenderer.stopScroll();
            LedRenderer.render([]);
            return;
        }

        const token = ++requestToken;

        try {
            // Fetch every station, filter each by its own walk time, then merge.
            // A single failing station must not blank the whole panel.
            const results = await Promise.all(state.stations.map(station =>
                loadStationDepartures(station)
                    .then(res => res.departures.slice(0, state.departureCount))
                    .catch(e => {
                        console.warn(`LED fetch failed for ${station.name}:`, e);
                        return [];
                    })
            ));
            if (token !== requestToken) return;

            const allDepartures = results
                .flat()
                .sort((a, b) => (departureDate(a) || 0) - (departureDate(b) || 0))
                .slice(0, LED_MAX_MERGED);

            if (state.ledScrollEnabled) {
                LedRenderer.startScroll(allDepartures, state.ledScrollSpeed);
            } else {
                LedRenderer.stopScroll();
                LedRenderer.render(allDepartures.slice(0, 3));
            }

            updateLastRefreshTime();
        } catch (e) {
            if (token !== requestToken) return;
            console.error('LED fetch failed:', e);
            LedRenderer.stopScroll();
            LedRenderer.render([]);
        }
    }

    async function fetchSplitDepartures() {
        if (state.stations.length < 2) {
            dom.splitDeparturesLeft.innerHTML = '<div class="loading"><p>Mindestens 2 Stationen nötig.</p></div>';
            dom.splitDeparturesRight.innerHTML = '';
            dom.splitHeaderLeft.textContent = '—';
            dom.splitHeaderRight.textContent = '—';
            return;
        }

        const { left: leftStation, right: rightStation } = getSplitStations();
        dom.splitHeaderLeft.textContent = leftStation.name;
        dom.splitHeaderRight.textContent = rightStation.name;

        const token = ++requestToken;

        try {
            const [left, right] = await Promise.all([
                loadStationDepartures(leftStation),
                loadStationDepartures(rightStation)
            ]);
            if (token !== requestToken) return;

            renderSplitPane(dom.splitDeparturesLeft, left.departures.slice(0, state.departureCount));
            renderSplitPane(dom.splitDeparturesRight, right.departures.slice(0, state.departureCount));

            updateRealtimeIndicator(left.data.realtimeDataUpdatedAt || right.data.realtimeDataUpdatedAt);
            updateLastRefreshTime();
        } catch (e) {
            if (token !== requestToken) return;
            console.error('Split view fetch failed:', e);
            const msg = `<div class="loading"><p class="error-text">${escapeHtml(e.message)}</p></div>`;
            dom.splitDeparturesLeft.innerHTML = msg;
            dom.splitDeparturesRight.innerHTML = msg;
        }
    }

    function renderSplitPane(container, departures) {
        container.innerHTML = departures.length === 0
            ? '<div class="loading"><p>Keine Abfahrten.</p></div>'
            : departures.map(departureRowHtml).join('');
    }

    // ===== Journey Planner =====

    // Sentinel for the address entry in the origin dropdown — a real station's
    // value is always its ID, so this can't collide.
    const HOME_ADDRESS_VALUE = '__address__';

    function getHomeStation() {
        return state.stations.find(s => s.id === state.homeStationId)
            || state.stations[0]
            || null;
    }

    /**
     * What the planner should depart from: the saved address when it is
     * selected, otherwise a station.
     * @returns {{place: Object|string, label: string, walkTime: number}|null}
     */
    function getJourneyOrigin() {
        if (state.homeStationId === HOME_ADDRESS_VALUE && state.homeAddress) {
            return {
                place: state.homeAddress,
                label: state.homeAddress.address,
                // No manual offset: starting from a coordinate makes HAFAS
                // plan the real walk to the platform as its own leg.
                walkTime: 0
            };
        }
        const station = getHomeStation();
        if (!station) return null;
        return { place: station.id, label: station.name, walkTime: station.walkTime || 0 };
    }

    function renderJourneyControls() {
        const options = [];
        if (state.homeAddress) {
            options.push(`<option value="${HOME_ADDRESS_VALUE}">🏠 Zuhause · ${escapeHtml(state.homeAddress.address)}</option>`);
        }
        for (const station of state.stations) {
            options.push(`<option value="${escapeHtml(station.id)}">${escapeHtml(station.name)}</option>`);
        }

        dom.journeyFrom.innerHTML = options.length
            ? options.join('')
            : '<option value="">Keine Station gespeichert</option>';
        dom.journeyFrom.disabled = options.length === 0;

        // Restore the selection: the stored id, or the address, or the fallback
        // station getHomeStation() would pick anyway.
        const home = getHomeStation();
        const wanted = (state.homeStationId === HOME_ADDRESS_VALUE && state.homeAddress)
            ? HOME_ADDRESS_VALUE
            : (home ? home.id : '');
        if (wanted) dom.journeyFrom.value = wanted;

        if (state.destination && dom.journeyTo.value !== state.destination.name) {
            dom.journeyTo.value = state.destination.name || state.destination.id;
        }
    }

    // ===== Home address =====

    function renderHomeAddress() {
        if (!state.homeAddress) {
            dom.homeAddressCurrent.innerHTML = '';
            return;
        }
        dom.homeAddressCurrent.innerHTML = `
            <span class="home-address-label">🏠 ${escapeHtml(state.homeAddress.address)}</span>
            <button class="btn-remove" id="home-address-clear"
                    aria-label="Adresse entfernen" title="Entfernen">&times;</button>`;
    }

    async function searchHomeAddress(query) {
        try {
            const results = await BvgApi.searchAddresses(query);
            if (results.length === 0) {
                dom.homeAddressResults.innerHTML = '<div class="search-result-item">Keine Adresse gefunden</div>';
            } else {
                dom.homeAddressResults.innerHTML = results.map(hit => `
                    <div class="search-result-item"
                         data-address="${escapeHtml(hit.address)}"
                         data-lat="${hit.latitude}" data-lng="${hit.longitude}">
                        <div>${escapeHtml(hit.address)}</div>
                    </div>
                `).join('');
            }
            dom.homeAddressResults.classList.remove('hidden');
        } catch (e) {
            console.error('Address search failed:', e);
            dom.homeAddressResults.innerHTML = '<div class="search-result-item">Fehler bei der Suche</div>';
            dom.homeAddressResults.classList.remove('hidden');
        }
    }

    const PLACE_KIND_LABELS = { stop: '', poi: 'Ort', address: 'Adresse' };

    /**
     * Destination search covers stops, points of interest and addresses — you
     * travel to "Markthalle 9", not to whichever stop happens to be near it.
     * A non-stop destination is sent as coordinates and the API works out the
     * final walk itself.
     */
    async function searchDestination(query) {
        try {
            const results = await BvgApi.searchPlaces(query, {
                stops: true, addresses: true, poi: true, results: 10
            });

            if (results.length === 0) {
                dom.journeyToResults.innerHTML = '<div class="search-result-item">Keine Ergebnisse</div>';
            } else {
                dom.journeyToResults.innerHTML = results.map(place => `
                    <div class="search-result-item"
                         data-kind="${escapeHtml(place.kind)}"
                         data-id="${escapeHtml(place.id)}"
                         data-name="${escapeHtml(place.name)}"
                         data-lat="${place.latitude}" data-lng="${place.longitude}">
                        <div>${escapeHtml(place.name)}</div>
                        <div class="result-products">${place.kind === 'stop'
                            ? getProductBadges(place.products)
                            : `<span class="result-kind">${escapeHtml(PLACE_KIND_LABELS[place.kind])}</span>`}</div>
                    </div>
                `).join('');
            }
            dom.journeyToResults.classList.remove('hidden');
        } catch (e) {
            console.error('Destination search failed:', e);
            dom.journeyToResults.innerHTML = '<div class="search-result-item">Fehler bei der Suche</div>';
            dom.journeyToResults.classList.remove('hidden');
        }
    }

    /**
     * The destination in the form the API wants: a stop goes by ID, anything
     * else by coordinates.
     * @returns {string|Object|null}
     */
    function destinationPlace() {
        const dest = state.destination;
        if (!dest) return null;
        if (dest.id) return dest.id;
        if (isFinite(dest.latitude) && isFinite(dest.longitude)) {
            return { latitude: dest.latitude, longitude: dest.longitude, address: dest.name };
        }
        return null;
    }

    function showJourneyMessage(html) {
        dom.journeyResults.innerHTML = `<div class="journey-empty">${html}</div>`;
    }

    async function fetchJourneys() {
        const origin = getJourneyOrigin();
        if (!origin) {
            showJourneyMessage('<p>Bitte zuerst eine Station oder eine Adresse in den Einstellungen speichern.</p>');
            return;
        }
        const destination = destinationPlace();
        if (!destination) {
            showJourneyMessage('<p>Bitte ein Ziel ausw&auml;hlen.</p>');
            return;
        }
        if (typeof destination === 'string' && destination === origin.place) {
            showJourneyMessage('<p>Start und Ziel sind dieselbe Station.</p>');
            return;
        }

        const token = ++requestToken;
        showJourneyMessage('<p>Suche Verbindungen&hellip;</p>');

        try {
            // A station origin has a walk time the API knows nothing about, so
            // the search starts from when you'd actually reach the platform.
            // An address origin needs no such offset — the walk is a real leg.
            const departure = origin.walkTime > 0
                ? new Date(Date.now() + origin.walkTime * 60000)
                : null;

            const data = await BvgApi.getJourneys(origin.place, destination, state.filters, {
                results: 5,
                polylines: true,
                departure
            });
            if (token !== requestToken) return;

            journeys = Array.isArray(data.journeys) ? data.journeys : [];
            selectedJourney = -1;
            JourneyView.render(dom.journeyResults, journeys, { selectedIndex: selectedJourney });
            updateLastRefreshTime();
        } catch (e) {
            if (token !== requestToken) return;
            console.error('Journey search failed:', e);
            showJourneyMessage(`<p class="error-text">Verbindungssuche fehlgeschlagen.</p>
                                <p class="error-detail">${escapeHtml(e.message)}</p>`);
        }
    }

    /** Draw one connection on the map and switch to it. */
    function showJourneyOnMap(index) {
        const journey = journeys[index];
        if (!journey) return;

        selectedJourney = index;
        JourneyView.render(dom.journeyResults, journeys, { selectedIndex: selectedJourney });

        const origin = getJourneyOrigin();
        const label = `${origin ? origin.label : '?'} → ${state.destination ? state.destination.name : '?'}`;
        pendingMapScene = {
            title: label,
            routes: JourneyView.toRoutes(journey),
            stops: JourneyView.toStops(journey)
        };
        shownRoute = null;
        applyViewMode('map');
        // If the map was already up, applyViewMode's init promise resolves
        // immediately — but the scene still has to be pushed through it.
        initMapView().then(applyPendingMapScene);
        setMapFocus((journey.legs || [])
            .filter(leg => !leg.walking && leg.line)
            .map(leg => leg.line.name));
    }

    // ===== Map =====

    // Set once the map drops to the schematic backend. It outlives any
    // transient "loading…" message: clearing the status must not hide the fact
    // that what you are looking at is not a real map.
    let mapFallbackNote = '';

    function setMapStatus(text, isWarning) {
        const message = text || mapFallbackNote;
        dom.mapStatus.textContent = message;
        dom.mapStatus.classList.toggle('is-warning', text ? !!isWarning : !!mapFallbackNote);
    }

    /**
     * Bring the map up, at most once. The promise is cached because both the
     * view switch and whatever asked for the map (a journey, a departure row)
     * need to wait for the same initialisation — starting a second one would
     * race two Leaflet instances into the same container.
     */
    function initMapView() {
        if (mapInitPromise) return mapInitPromise;

        setMapStatus('Karte wird geladen…');
        mapInitPromise = TransitMap.init(dom.mapContainer, {
            tileUrl: state.mapTileUrl,
            attribution: state.mapAttribution,
            onFallback: (reason) => {
                mapFallbackNote = `${reason} — schematische Ansicht.`;
                setMapStatus('', true);
            }
        }).then((backend) => {
            mapReady = true;
            if (backend === 'leaflet') setMapStatus('');
            // Deliberately no re-poll on pan: it also fired on the programmatic
            // fit() after drawing a route, so a single click could trigger
            // several requests. The bounding box still follows the map — the
            // next scheduled poll simply picks up wherever you've moved to.
            return backend;
        });

        return mapInitPromise;
    }

    /** Show where home is, if one is set — context for everything else drawn. */
    function renderHomePin() {
        if (!mapReady) return;
        TransitMap.setPins(state.homeAddress ? [{
            lat: state.homeAddress.latitude,
            lng: state.homeAddress.longitude,
            label: `Zuhause · ${state.homeAddress.address}`
        }] : []);
    }

    function applyPendingMapScene() {
        if (!pendingMapScene) return;
        dom.mapTitle.textContent = pendingMapScene.title || 'Karte';
        TransitMap.setRoutes(pendingMapScene.routes || []);
        TransitMap.setStops(pendingMapScene.stops || []);
        TransitMap.fit();
        pendingMapScene = null;
    }

    /** Fetch and draw the geographic shape of one trip. */
    async function showTripOnMap(tripId, label) {
        if (!tripId) return;

        shownRoute = { tripId, label };
        // No pending scene here: this one is fetched, and an empty placeholder
        // would be applied after the fetch resolves and wipe the route again.
        pendingMapScene = null;
        applyViewMode('map');
        dom.mapTitle.textContent = label || 'Route';

        const token = ++requestToken;
        setMapStatus('Route wird geladen…');
        try {
            // The map has to exist before anything can be drawn on it, and the
            // trip fetch is independent of it — so wait on both, not in series.
            const [data] = await Promise.all([BvgApi.getTrip(tripId, true), initMapView()]);
            if (token !== requestToken || !shownRoute || shownRoute.tripId !== tripId) return;

            const trip = data.trip || {};
            const points = BvgApi.polylineToLatLngs(trip.polyline);
            if (points.length < 2) {
                setMapStatus('Für diese Fahrt liegt keine Route vor.', true);
                return;
            }

            const stations = BvgApi.polylineStations(trip.polyline);
            dom.mapTitle.textContent = label || `${(trip.line && trip.line.name) || ''} ${trip.direction || ''}`.trim();
            // From here on, "live" means this line rather than the whole city.
            setMapFocus([(trip.line && trip.line.name) || '']);
            TransitMap.setRoutes([{
                points,
                product: (trip.line && trip.line.product) || '',
                label: (trip.line && trip.line.name) || ''
            }]);
            TransitMap.setStops(stations.map((st, i) => ({
                lat: st.lat, lng: st.lng, name: st.name,
                kind: i === 0 ? 'origin' : (i === stations.length - 1 ? 'destination' : 'stop')
            })));
            TransitMap.fit();
        } catch (e) {
            if (token !== requestToken) return;
            console.error('Trip route failed:', e);
            setMapStatus(`Route konnte nicht geladen werden: ${e.message}`, true);
        }
    }

    /**
     * Bounding box for the radar query. Prefers what the map is showing;
     * falls back to a box around the saved stations before the map has a size.
     */
    function radarBounds() {
        const points = [];
        for (const station of state.stations) {
            if (isFinite(station.lat) && isFinite(station.lng)) points.push([station.lat, station.lng]);
        }

        const mapBounds = TransitMap.getBounds && TransitMap.getBounds();
        if (mapBounds) return mapBounds;
        if (points.length === 0) return null;

        const lats = points.map(p => p[0]);
        const lngs = points.map(p => p[1]);
        // Pad the box so vehicles heading toward the stations are visible too.
        const pad = 0.012;
        return {
            north: Math.max(...lats) + pad,
            south: Math.min(...lats) - pad,
            east: Math.max(...lngs) + pad,
            west: Math.min(...lngs) - pad
        };
    }

    async function fetchRadar() {
        if (!state.mapLive || state.viewMode !== 'map') return;

        const bounds = radarBounds();
        if (!bounds) return;

        try {
            const data = await BvgApi.getRadar(bounds, {
                results: RADAR_MAX_VEHICLES,
                duration: 30,
                frames: 3,
                polylines: false
            });
            if (state.viewMode !== 'map') return;

            const movements = Array.isArray(data.movements) ? data.movements : [];
            liveVehicles = movements.map(toVehicle).filter(v => isFinite(v.lat) && isFinite(v.lng));
            applyMapFilters();
            updateLastRefreshTime();
        } catch (e) {
            console.warn('Radar poll failed:', e.message);
            setMapStatus(`Live-Fahrzeuge nicht verfügbar: ${e.message}`, true);
        }
    }

    /**
     * One radar movement in the shape the map wants.
     * @returns {Object}
     */
    function toVehicle(movement) {
        const line = movement.line || {};
        return {
            // Keyed by trip so the marker is moved on the next poll rather than
            // destroyed and recreated, which made the whole fleet flicker.
            key: movement.tripId ? String(movement.tripId) : `${line.name || '?'}|${movement.direction || ''}`,
            tripId: movement.tripId ? String(movement.tripId) : '',
            lat: movement.location && movement.location.latitude,
            lng: movement.location && movement.location.longitude,
            label: line.name || '?',
            product: line.product || '',
            direction: movement.direction || ''
        };
    }

    /**
     * Draw the vehicles that are relevant right now: those of the line or
     * connection on screen, or — when nothing is shown — everything that
     * passes the product filter.
     */
    function applyMapFilters() {
        const focused = mapFocus && mapFocus.lines && mapFocus.lines.size > 0;
        const vehicles = liveVehicles.filter(v => focused
            ? mapFocus.lines.has(normaliseLine(v.label))
            : state.mapFilters[v.product] !== false);

        TransitMap.setVehicles(vehicles);
        dom.mapFilters.classList.toggle('is-muted', !!focused);
        updateLiveNote(focused, vehicles.length);
    }

    const normaliseLine = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, '');

    function setMapFocus(lineNames) {
        const names = (lineNames || []).map(normaliseLine).filter(Boolean);
        mapFocus = names.length > 0 ? { lines: new Set(names) } : null;
        applyMapFilters();
    }

    /**
     * Say what "live" currently means, so the filter chips aren't confusing.
     * Composed with the fallback note rather than replacing it — being on the
     * schematic is the more important of the two facts.
     */
    function updateLiveNote(focused, count) {
        let live = '';
        if (state.mapLive) {
            if (focused) live = `Live: ${[...mapFocus.lines].join(', ').toUpperCase()} (${count})`;
            else if (count > 0) live = `Live: ${count} Fahrzeuge`;
        }
        setMapStatus([mapFallbackNote, live].filter(Boolean).join(' · '));
    }

    function renderMapFilters() {
        for (const btn of dom.mapFilters.querySelectorAll('.map-filter[data-product]')) {
            const on = state.mapFilters[btn.dataset.product] !== false;
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    // ===== Line lookup =====

    /**
     * Find a line by name anywhere in the network and offer its directions.
     *
     * The radar feed only knows what is inside the current map viewport, which
     * is why a line that happens not to be running past you was missing from
     * the old picker. /trips searches by line name across the whole network.
     */
    async function searchMapLine(query) {
        dom.mapLineResults.innerHTML = '<div class="search-result-item">Suche&hellip;</div>';
        dom.mapLineResults.classList.remove('hidden');

        try {
            const data = await BvgApi.searchTripsByLine(query, { results: 30 });
            const trips = Array.isArray(data.trips) ? data.trips : [];

            // One entry per direction, not per running vehicle: the point is
            // the line's route, and every run of a direction draws the same one.
            const seen = new Set();
            const directions = [];
            for (const trip of trips) {
                const line = trip.line || {};
                const direction = trip.direction || (trip.destination && trip.destination.name) || '';
                const key = `${line.name}|${direction}`;
                if (!line.name || seen.has(key)) continue;
                seen.add(key);
                directions.push({
                    id: trip.id,
                    name: line.name,
                    product: line.product || '',
                    direction
                });
            }

            if (directions.length === 0) {
                dom.mapLineResults.innerHTML = `<div class="search-result-item">Keine Linie „${escapeHtml(query)}" gefunden (fährt sie gerade?)</div>`;
                return;
            }

            dom.mapLineResults.innerHTML = directions.map(entry => `
                <div class="search-result-item" data-trip-id="${escapeHtml(entry.id)}"
                     data-label="${escapeHtml(`${entry.name} → ${entry.direction}`)}">
                    <span class="line-badge line-tint ${escapeHtml(entry.product)} ${escapeHtml(lineColorClass(entry.name))}">${escapeHtml(entry.name)}</span>
                    <span class="line-result-direction">${escapeHtml(entry.direction || 'Richtung unbekannt')}</span>
                </div>
            `).join('');
        } catch (e) {
            console.error('Line search failed:', e);
            dom.mapLineResults.innerHTML = `<div class="search-result-item">Fehler: ${escapeHtml(e.message)}</div>`;
        }
    }

    /** Shared with the board badges so a line keeps its colour everywhere. */
    function lineColorClass(name) {
        if (!name) return '';
        const clean = String(name).toLowerCase().replace(/\s/g, '');
        return /^[us]\d+$/.test(clean) ? clean : '';
    }

    function startRadarTimer() {
        stopRadarTimer();
        if (!state.mapLive) return;
        radarTimer = setInterval(fetchRadar, RADAR_INTERVAL_MS);
    }

    function stopRadarTimer() {
        if (radarTimer) {
            clearInterval(radarTimer);
            radarTimer = null;
        }
    }

    // ===== Kiosk Mode =====
    function toggleKioskMode() {
        if (state.kioskMode) exitKioskMode();
        else enterKioskMode(true);
    }

    function enterKioskMode(showHint) {
        state.kioskMode = true;
        document.body.classList.add('kiosk-mode');
        dom.kioskToggle.checked = true;
        saveState();
        closeSettings();

        // Request fullscreen (may be rejected without a user gesture — that's fine)
        const elem = document.documentElement;
        if (elem.requestFullscreen) {
            elem.requestFullscreen().catch(() => {});
        } else if (elem.webkitRequestFullscreen) {
            elem.webkitRequestFullscreen();
        }

        if (showHint) showKioskHint();
    }

    function exitKioskMode() {
        state.kioskMode = false;
        document.body.classList.remove('kiosk-mode');
        dom.kioskToggle.checked = false;
        saveState();

        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else if (document.webkitFullscreenElement) {
            document.webkitExitFullscreen();
        }

        const hint = document.querySelector('.kiosk-exit-hint');
        if (hint) hint.remove();
    }

    function showKioskHint() {
        const existing = document.querySelector('.kiosk-exit-hint');
        if (existing) existing.remove();

        const hint = document.createElement('div');
        hint.className = 'kiosk-exit-hint';
        hint.textContent = 'Kiosk-Modus aktiv — Doppelklick oder Escape zum Beenden';
        document.body.appendChild(hint);

        requestAnimationFrame(() => hint.classList.add('visible'));
        setTimeout(() => {
            hint.classList.remove('visible');
            setTimeout(() => hint.remove(), 500);
        }, 3000);
    }

    // ===== Utilities =====
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    /**
     * Escape for both text content and quoted attribute values. Quotes matter:
     * station names go into data-* attributes, and the textContent/innerHTML
     * trick this used to rely on leaves " and ' untouched.
     */
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
    }

    // ===== Service Worker =====
    // Caches the app shell for offline startup / installability. Registration
    // fails silently under file:// or plain HTTP (the API requires a secure
    // context), which is fine — the app works the same either way.
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./service-worker.js')
            .catch(e => console.warn('Service worker registration failed:', e));
    }

    // ===== Start =====
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    registerServiceWorker();
})();
