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

    // ===== DOM References =====
    const dom = {
        settingsPanel: document.getElementById('settings-panel'),
        openSettings: document.getElementById('open-settings'),
        openSettingsCta: document.getElementById('open-settings-cta'),
        closeSettings: document.getElementById('close-settings'),
        stationSearch: document.getElementById('station-search'),
        searchResults: document.getElementById('search-results'),
        savedStations: document.getElementById('saved-stations'),
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
            }
            state.departureCount = parsed.departureCount || state.departureCount;
            state.refreshInterval = clamp(parsed.refreshInterval || state.refreshInterval, 10, 120);
            if (parsed.theme) state.theme = parsed.theme === 'modern' ? 'modern' : 'dark';
            if (['single', 'split', 'led'].includes(parsed.viewMode)) state.viewMode = parsed.viewMode;
            if (parsed.kioskMode !== undefined) state.kioskMode = !!parsed.kioskMode;
            if (parsed.ledScrollEnabled !== undefined) state.ledScrollEnabled = parsed.ledScrollEnabled !== false;
            state.ledScrollSpeed = parsed.ledScrollSpeed || state.ledScrollSpeed;
            state.apiProvider = parsed.apiProvider || state.apiProvider;
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
            addStation(item.dataset.id, item.dataset.name);
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
        dom.viewLed.addEventListener('click', () => applyViewMode('led'));

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
    function addStation(id, name) {
        if (state.stations.some(s => s.id === id)) return; // Already added
        state.stations.push({ id, name, walkTime: 0 });
        state.activeStationId = id;
        saveState();
        renderSavedStations();
        renderSplitStationSelects();
        renderStationTabs();
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
        refreshCurrentView();
    }

    /**
     * Config can list stations by ID alone (`?stop=900000100003`), which is the
     * only form available before the user has searched for anything. Look the
     * real names up in the background and refresh the labels once they land —
     * the board itself already works, the ID is just an ugly placeholder.
     */
    async function resolveStationNames() {
        const pending = state.stations.filter(s => !s.name || s.name === s.id);
        if (pending.length === 0) return;

        let resolved = false;
        for (const station of pending) {
            try {
                const data = await BvgApi.getStation(station.id);
                const name = data && (data.name || (data.stop && data.stop.name));
                if (name) {
                    station.name = name;
                    resolved = true;
                }
            } catch (e) {
                console.warn(`Could not resolve name for station ${station.id}:`, e.message);
            }
        }
        if (!resolved) return;

        saveState();
        renderSavedStations();
        renderSplitStationSelects();
        renderStationTabs();
        updateStationHeadings();
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

        dom.savedStations.innerHTML = state.stations.map(station => `
            <div class="saved-station">
                <span class="station-info">${escapeHtml(station.name)}</span>
                <input type="number" class="walk-time-input" data-id="${escapeHtml(station.id)}"
                       min="0" max="30" value="${station.walkTime || 0}"
                       aria-label="Fußweg zu ${escapeHtml(station.name)} in Minuten"
                       title="Fußweg (Minuten)">
                <span class="walk-time-unit">min</span>
                <button class="btn-remove" data-id="${escapeHtml(station.id)}"
                        aria-label="${escapeHtml(station.name)} entfernen" title="Entfernen">&times;</button>
            </div>
        `).join('');
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

        return `
            <div class="${rowClass}">
                <span class="col-line">
                    <span class="line-badge ${escapeHtml(lineProduct)} ${lineClass}">${escapeHtml(lineName)}</span>
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
        dom.viewLed.classList.toggle('active', mode === 'led');

        // Hide all views first
        dom.singleView.classList.add('hidden');
        dom.splitView.classList.add('hidden');
        dom.ledView.classList.add('hidden');
        dom.stationTabs.classList.add('hidden');
        dom.alertsBanner.classList.add('hidden');

        // The LED scroll timer keeps redrawing an off-screen canvas otherwise.
        if (mode !== 'led') LedRenderer.stopScroll();

        if (mode === 'split') {
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
