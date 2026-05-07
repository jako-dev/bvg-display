/**
 * BVG Departure Monitor - Main Application
 */
(() => {
    'use strict';

    // ===== State =====
    const state = {
        stations: [],           // Saved stations [{id, name, walkTime}]
        activeStationId: null,  // Currently displayed station
        departures: [],         // Current departure data
        departureCount: 6,      // Number of departures to fetch
        refreshInterval: 30,    // Seconds between refreshes
        refreshTimer: null,
        theme: 'dark',
        viewMode: 'single',     // 'single' or 'split'
        kioskMode: false,
        ledScrollEnabled: true, // Scroll through departures in LED mode
        ledScrollSpeed: 3000,   // ms between scroll steps
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
        currentStationName: document.getElementById('current-station-name'),
        clock: document.getElementById('clock'),
        lastUpdate: document.getElementById('last-update'),
        realtimeIndicator: document.getElementById('realtime-indicator'),
        alertsBanner: document.getElementById('alerts-banner'),
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
        splitHint: document.getElementById('split-hint'),
        // LED view
        viewLed: document.getElementById('view-led'),
        ledView: document.getElementById('led-view'),
        ledCanvas: document.getElementById('led-canvas'),
        ledScrollToggle: document.getElementById('led-scroll-toggle'),
        ledScrollSpeed: document.getElementById('led-scroll-speed'),
        // Kiosk
        kioskBtn: document.getElementById('kiosk-btn'),
        kioskToggle: document.getElementById('kiosk-toggle'),
        displayHeader: document.getElementById('display-header'),
        displayFooter: document.getElementById('display-footer')
    };

    // ===== Initialization =====
    function init() {
        loadState();
        setupEventListeners();
        updateClock();
        setInterval(updateClock, 1000);
        applyTheme(state.theme);
        applyViewMode(state.viewMode);
        renderSavedStations();
        renderStationTabs();
        applyFiltersToUI();

        if (state.kioskMode) {
            enterKioskMode(false); // restore without hint
        }

        if (state.stations.length > 0) {
            if (!state.activeStationId) {
                state.activeStationId = state.stations[0].id;
            }
            showDepartures();
        } else {
            showNoStationMessage();
        }

        // Pause/resume refresh on visibility change
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopRefreshTimer();
            } else if (state.stations.length > 0) {
                showDepartures(); // Immediate refresh + restart timer
            }
        });
    }

    // ===== Persistence =====
    function loadState() {
        try {
            const saved = localStorage.getItem('bvg-display-state');
            if (saved) {
                const parsed = JSON.parse(saved);
                state.stations = parsed.stations || [];
                state.activeStationId = parsed.activeStationId || null;
                state.departureCount = parsed.departureCount || 6;
                state.refreshInterval = parsed.refreshInterval || 30;
                state.theme = parsed.theme || 'dark';
                state.viewMode = parsed.viewMode || 'single';
                state.kioskMode = parsed.kioskMode || false;
                state.ledScrollEnabled = parsed.ledScrollEnabled !== false;
                state.ledScrollSpeed = parsed.ledScrollSpeed || 3000;
                state.filters = { ...state.filters, ...parsed.filters };
            }
        } catch (e) {
            console.warn('Failed to load saved state:', e);
        }
    }

    function saveState() {
        try {
            localStorage.setItem('bvg-display-state', JSON.stringify({
                stations: state.stations,
                activeStationId: state.activeStationId,
                departureCount: state.departureCount,
                refreshInterval: state.refreshInterval,
                theme: state.theme,
                viewMode: state.viewMode,
                kioskMode: state.kioskMode,
                ledScrollEnabled: state.ledScrollEnabled,
                ledScrollSpeed: state.ledScrollSpeed,
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
            if (query.length < 2) {
                dom.searchResults.classList.add('hidden');
                return;
            }
            searchTimeout = setTimeout(() => searchStations(query), 300);
        });

        dom.stationSearch.addEventListener('focus', () => {
            if (dom.searchResults.children.length > 0) {
                dom.searchResults.classList.remove('hidden');
            }
        });

        // Close search results when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-wrapper')) {
                dom.searchResults.classList.add('hidden');
            }
        });

        // Filters
        Object.keys(state.filters).forEach(key => {
            const checkbox = document.getElementById(`filter-${key}`);
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    state.filters[key] = e.target.checked;
                    saveState();
                    if (state.activeStationId) {
                        fetchDepartures();
                    }
                });
            }
        });

        // Theme
        dom.themeDark.addEventListener('click', () => applyTheme('dark'));
        dom.themeModern.addEventListener('click', () => applyTheme('modern'));

        // Departure count
        dom.departureCountSelect.addEventListener('change', (e) => {
            state.departureCount = parseInt(e.target.value) || 6;
            saveState();
            if (state.activeStationId) showDepartures();
        });

        // Refresh interval
        dom.refreshIntervalInput.addEventListener('change', (e) => {
            const val = Math.max(10, Math.min(120, parseInt(e.target.value) || 30));
            state.refreshInterval = val;
            e.target.value = val;
            saveState();
            startRefreshTimer();
        });

        // Walk time - removed (now per-station)

        // View mode
        dom.viewSingle.addEventListener('click', () => applyViewMode('single'));
        dom.viewSplit.addEventListener('click', () => applyViewMode('split'));
        dom.viewLed.addEventListener('click', () => applyViewMode('led'));

        // LED scroll settings
        dom.ledScrollToggle.addEventListener('change', (e) => {
            state.ledScrollEnabled = e.target.checked;
            saveState();
            if (state.viewMode === 'led') fetchLedDepartures();
        });
        dom.ledScrollSpeed.addEventListener('change', (e) => {
            state.ledScrollSpeed = parseInt(e.target.value) || 3000;
            saveState();
            if (state.viewMode === 'led') fetchLedDepartures();
        });

        // Kiosk mode
        dom.kioskBtn.addEventListener('click', () => toggleKioskMode());
        dom.kioskToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                enterKioskMode(true);
            } else {
                exitKioskMode();
            }
        });

        // Kiosk exit: Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && state.kioskMode) {
                exitKioskMode();
            }
        });

        // Kiosk exit: double-click
        document.addEventListener('dblclick', () => {
            if (state.kioskMode) {
                exitKioskMode();
            }
        });

        // Settings overlay click to close
        document.addEventListener('click', (e) => {
            if (dom.settingsPanel.classList.contains('open') &&
                !dom.settingsPanel.contains(e.target) &&
                e.target !== dom.openSettings &&
                e.target !== dom.openSettingsCta) {
                closeSettings();
            }
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
        const now = new Date();
        dom.clock.textContent = now.toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    // ===== Station Search =====
    async function searchStations(query) {
        try {
            const results = await BvgApi.searchStations(query);
            renderSearchResults(results);
        } catch (e) {
            console.error('Search failed:', e);
            dom.searchResults.innerHTML = '<div class="search-result-item">Fehler bei der Suche</div>';
            dom.searchResults.classList.remove('hidden');
        }
    }

    function renderSearchResults(results) {
        if (results.length === 0) {
            dom.searchResults.innerHTML = '<div class="search-result-item">Keine Ergebnisse</div>';
            dom.searchResults.classList.remove('hidden');
            return;
        }

        dom.searchResults.innerHTML = results.map(stop => {
            const products = getProductBadges(stop.products);
            return `
                <div class="search-result-item" data-id="${stop.id}" data-name="${escapeHtml(stop.name)}">
                    <div>${escapeHtml(stop.name)}</div>
                    <div class="result-products">${products}</div>
                </div>
            `;
        }).join('');

        // Add click handlers
        dom.searchResults.querySelectorAll('.search-result-item[data-id]').forEach(item => {
            item.addEventListener('click', () => {
                addStation(item.dataset.id, item.dataset.name);
                dom.searchResults.classList.add('hidden');
                dom.stationSearch.value = '';
            });
        });

        dom.searchResults.classList.remove('hidden');
    }

    function getProductBadges(products) {
        if (!products) return '';
        const badges = [];
        if (products.suburban) badges.push('<span class="badge badge-suburban">S</span>');
        if (products.subway) badges.push('<span class="badge badge-subway">U</span>');
        if (products.tram) badges.push('<span class="badge badge-tram">T</span>');
        if (products.bus) badges.push('<span class="badge badge-bus">B</span>');
        if (products.ferry) badges.push('<span class="badge badge-ferry">F</span>');
        if (products.express) badges.push('<span class="badge badge-express">IC</span>');
        if (products.regional) badges.push('<span class="badge badge-regional">RE</span>');
        return badges.join('');
    }

    // ===== Station Management =====
    function addStation(id, name) {
        if (state.stations.find(s => s.id === id)) return; // Already added
        state.stations.push({ id, name, walkTime: 0 });
        state.activeStationId = id;
        saveState();
        renderSavedStations();
        renderStationTabs();
        showDepartures();
        closeSettings();
    }

    function removeStation(id) {
        state.stations = state.stations.filter(s => s.id !== id);
        if (state.activeStationId === id) {
            state.activeStationId = state.stations.length > 0 ? state.stations[0].id : null;
        }
        saveState();
        renderSavedStations();
        renderStationTabs();

        if (state.viewMode === 'split') {
            fetchSplitDepartures();
        } else if (state.viewMode === 'led') {
            fetchLedDepartures();
        } else if (state.activeStationId) {
            showDepartures();
        } else {
            showNoStationMessage();
        }
    }

    function renderSavedStations() {
        if (state.stations.length === 0) {
            dom.savedStations.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Noch keine Stationen gespeichert.</p>';
            return;
        }

        dom.savedStations.innerHTML = state.stations.map(station => `
            <div class="saved-station">
                <span class="station-info">${escapeHtml(station.name)}</span>
                <input type="number" class="walk-time-input" data-id="${station.id}" 
                       min="0" max="30" value="${station.walkTime || 0}" 
                       title="Fu\u00dfweg (Minuten)" style="width: 50px; text-align: center;">
                <span style="font-size: 0.7rem; color: var(--text-muted);">min</span>
                <button class="btn-remove" data-id="${station.id}" title="Entfernen">&times;</button>
            </div>
        `).join('');

        dom.savedStations.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => removeStation(btn.dataset.id));
        });
        dom.savedStations.querySelectorAll('.walk-time-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                const val = Math.max(0, Math.min(30, parseInt(e.target.value) || 0));
                const station = state.stations.find(s => s.id === id);
                if (station) {
                    station.walkTime = val;
                    saveState();
                    if (state.activeStationId) showDepartures();
                }
            });
        });
    }

    function renderStationTabs() {
        if (state.stations.length <= 1) {
            dom.stationTabs.classList.add('hidden');
            return;
        }

        dom.stationTabs.classList.remove('hidden');
        dom.stationTabs.innerHTML = state.stations.map(station => `
            <button class="station-tab ${station.id === state.activeStationId ? 'active' : ''}"
                    data-id="${station.id}">
                ${escapeHtml(station.name)}
            </button>
        `).join('');

        dom.stationTabs.querySelectorAll('.station-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                state.activeStationId = tab.dataset.id;
                saveState();
                renderStationTabs();
                showDepartures();
            });
        });
    }

    // ===== Departures Display =====
    function showNoStationMessage() {
        dom.loadingIndicator.classList.add('hidden');
        dom.noStationMsg.classList.remove('hidden');
        dom.currentStationName.textContent = 'BVG Abfahrtsmonitor';
        dom.alertsBanner.classList.add('hidden');
        clearDepartureRows();
        stopRefreshTimer();
    }

    async function showDepartures() {
        if (state.viewMode === 'split') {
            fetchSplitDepartures();
            startRefreshTimer();
            return;
        }
        if (state.viewMode === 'led') {
            fetchLedDepartures();
            startRefreshTimer();
            return;
        }

        dom.noStationMsg.classList.add('hidden');
        dom.loadingIndicator.classList.remove('hidden');
        clearDepartureRows();

        const station = state.stations.find(s => s.id === state.activeStationId);
        if (station) {
            dom.currentStationName.textContent = station.name;
        }

        await fetchDepartures();
        startRefreshTimer();
    }

    async function fetchDepartures() {
        if (!state.activeStationId) return;

        try {
            const data = await BvgApi.getDepartures(state.activeStationId, state.filters, 30, state.departureCount);
            dom.loadingIndicator.classList.add('hidden');

            if (data.departures && data.departures.length > 0) {
                state.departures = data.departures;
                const activeStation = state.stations.find(s => s.id === state.activeStationId);
                const filtered = filterByWalkTime(data.departures, activeStation ? activeStation.walkTime : 0);
                renderDepartures(filtered);
                renderAlerts(data.departures);
            } else {
                dom.departuresList.innerHTML = `
                    <div class="loading">
                        <p>Keine Abfahrten in den nächsten 30 Minuten.</p>
                    </div>
                `;
            }

            // Update realtime indicator
            if (data.realtimeDataUpdatedAt) {
                dom.realtimeIndicator.style.color = 'var(--on-time-color)';
                dom.realtimeIndicator.title = 'Echtzeitdaten verfügbar';
            } else {
                dom.realtimeIndicator.style.color = 'var(--text-muted)';
                dom.realtimeIndicator.title = 'Keine Echtzeitdaten';
            }

            // Update last refresh time
            const now = new Date();
            dom.lastUpdate.textContent = `Letzte Aktualisierung: ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;

        } catch (e) {
            console.error('Failed to fetch departures:', e);
            dom.loadingIndicator.classList.add('hidden');
            dom.departuresList.innerHTML = `
                <div class="loading">
                    <p style="color: var(--delay-color);">Fehler beim Laden der Abfahrten.</p>
                    <p style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(e.message)}</p>
                </div>
            `;
        }
    }

    function filterByWalkTime(departures, walkTime) {
        if (!walkTime || walkTime <= 0) return departures;
        const now = new Date();
        return departures.filter(dep => {
            const when = dep.when ? new Date(dep.when) : (dep.plannedWhen ? new Date(dep.plannedWhen) : null);
            if (!when) return true;
            const diffMin = (when - now) / 60000;
            return diffMin >= walkTime;
        });
    }

    function renderDepartures(departures) {
        const rows = departures.map(dep => {
            const lineName = dep.line ? dep.line.name : '?';
            const lineProduct = dep.line ? dep.line.product : '';
            const lineClass = getLineClass(dep.line);
            const direction = dep.direction || 'Unbekannt';
            const platform = dep.platform || dep.plannedPlatform || '';
            const timeInfo = formatDepartureTime(dep);
            const isCancelled = dep.cancelled === true;
            const isDelayed = dep.delay && dep.delay > 60; // more than 1 min delay

            let rowClass = 'departure-row';
            if (isCancelled) rowClass += ' cancelled';
            else if (isDelayed) rowClass += ' delayed';

            return `
                <div class="${rowClass}">
                    <span class="col-line">
                        <span class="line-badge ${lineProduct} ${lineClass}">${escapeHtml(lineName)}</span>
                    </span>
                    <span class="col-destination">${escapeHtml(direction)}</span>
                    <span class="col-platform">${escapeHtml(platform)}</span>
                    <span class="col-departure">
                        ${timeInfo.main}
                        ${timeInfo.sub}
                    </span>
                </div>
            `;
        }).join('');

        dom.departuresList.innerHTML = rows;
    }

    function getLineClass(line) {
        if (!line || !line.name) return '';
        const name = line.name.toLowerCase().replace(/\s/g, '');
        // Match specific line names like u1, u2, s1, s41, etc.
        if (/^[us]\d+$/.test(name)) return name;
        return '';
    }

    function formatDepartureTime(dep) {
        const now = new Date();
        const when = dep.when ? new Date(dep.when) : null;
        const plannedWhen = dep.plannedWhen ? new Date(dep.plannedWhen) : null;
        const isCancelled = dep.cancelled === true;

        if (isCancelled) {
            return { main: '<span style="color: var(--cancelled-color);">Fällt aus</span>', sub: '' };
        }

        if (!when && !plannedWhen) {
            return { main: '?', sub: '' };
        }

        const departureTime = when || plannedWhen;
        const diffMs = departureTime - now;
        const diffMin = Math.round(diffMs / 60000);

        let main;
        if (diffMin <= 0) {
            main = '<span style="color: var(--on-time-color);">jetzt</span>';
        } else if (diffMin === 1) {
            main = '1 min';
        } else if (diffMin < 60) {
            main = `${diffMin} min`;
        } else {
            main = departureTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }

        // Delay info
        let sub = '';
        const delay = dep.delay; // in seconds
        if (delay && delay > 60) {
            const delayMin = Math.round(delay / 60);
            sub = `<span class="delay-info">+${delayMin} min</span>`;
        } else if (delay !== null && delay !== undefined && delay <= 60 && when) {
            sub = `<span class="on-time">pünktlich</span>`;
        }

        return { main, sub };
    }

    // ===== Alerts/Remarks =====
    function renderAlerts(departures) {
        const remarks = new Map(); // deduplicate by text
        departures.forEach(dep => {
            if (dep.remarks) {
                dep.remarks.forEach(remark => {
                    if (remark.type === 'warning' || remark.type === 'status') {
                        const text = remark.text || remark.summary;
                        if (text && !remarks.has(text)) {
                            remarks.set(text, remark);
                        }
                    }
                });
            }
        });

        if (remarks.size === 0) {
            dom.alertsBanner.classList.add('hidden');
            return;
        }

        // Show max 3 alerts
        const alertItems = Array.from(remarks.values()).slice(0, 3).map(remark => {
            const text = remark.text || remark.summary || '';
            return `<div class="alert-item"><span>${escapeHtml(text)}</span></div>`;
        }).join('');

        dom.alertsBanner.innerHTML = alertItems;
        dom.alertsBanner.classList.remove('hidden');
    }

    // ===== Filters =====
    function applyFiltersToUI() {
        Object.keys(state.filters).forEach(key => {
            const checkbox = document.getElementById(`filter-${key}`);
            if (checkbox) {
                checkbox.checked = state.filters[key];
            }
        });
        dom.departureCountSelect.value = state.departureCount;
        dom.refreshIntervalInput.value = state.refreshInterval;
        dom.kioskToggle.checked = state.kioskMode;
        dom.ledScrollToggle.checked = state.ledScrollEnabled;
        dom.ledScrollSpeed.value = state.ledScrollSpeed;
        dom.viewSingle.classList.toggle('active', state.viewMode === 'single');
        dom.viewSplit.classList.toggle('active', state.viewMode === 'split');
        dom.viewLed.classList.toggle('active', state.viewMode === 'led');
    }

    // ===== Refresh Timer =====
    function startRefreshTimer() {
        stopRefreshTimer();
        state.refreshTimer = setInterval(() => {
            if (state.viewMode === 'split') {
                fetchSplitDepartures();
            } else if (state.viewMode === 'led') {
                fetchLedDepartures();
            } else {
                fetchDepartures();
            }
        }, state.refreshInterval * 1000);
    }

    function stopRefreshTimer() {
        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
            state.refreshTimer = null;
        }
    }

    // ===== View Mode =====
    function applyViewMode(mode) {
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

        if (mode === 'split') {
            dom.splitView.classList.remove('hidden');
            dom.currentStationName.textContent = 'BVG Abfahrtsmonitor';
            fetchSplitDepartures();
        } else if (mode === 'led') {
            dom.ledView.classList.remove('hidden');
            dom.currentStationName.textContent = 'LED-Panel Emulation';
            LedRenderer.init(dom.ledCanvas);
            fetchLedDepartures();
        } else {
            dom.singleView.classList.remove('hidden');
            renderStationTabs();
            if (state.activeStationId) {
                const station = state.stations.find(s => s.id === state.activeStationId);
                if (station) dom.currentStationName.textContent = station.name;
            }
        }
        saveState();
        startRefreshTimer();
    }

    async function fetchLedDepartures() {
        if (state.stations.length === 0) {
            LedRenderer.clear();
            return;
        }

        try {
            // Fetch from all stations and merge, filtering by per-station walk time
            const fetches = state.stations.map(s =>
                BvgApi.getDepartures(s.id, state.filters, 30, state.departureCount)
                    .then(data => filterByWalkTime(data.departures || [], s.walkTime || 0))
                    .catch(() => [])
            );
            const results = await Promise.all(fetches);
            const allDepartures = results.flat();

            // Sort by departure time (soonest first)
            const now = new Date();
            allDepartures.sort((a, b) => {
                const timeA = new Date(a.when || a.plannedWhen || 0);
                const timeB = new Date(b.when || b.plannedWhen || 0);
                return timeA - timeB;
            });

            if (allDepartures.length > 0) {
                if (state.ledScrollEnabled) {
                    LedRenderer.startScroll(allDepartures, state.ledScrollSpeed);
                } else {
                    LedRenderer.stopScroll();
                    LedRenderer.render(allDepartures.slice(0, 3));
                }
            } else {
                LedRenderer.render([]);
            }

            const updateTime = new Date();
            dom.lastUpdate.textContent = `Letzte Aktualisierung: ${updateTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
        } catch (e) {
            console.error('LED fetch failed:', e);
            LedRenderer.clear();
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

        const leftStation = state.stations[0];
        const rightStation = state.stations[1];
        dom.splitHeaderLeft.textContent = leftStation.name;
        dom.splitHeaderRight.textContent = rightStation.name;

        try {
            const [leftData, rightData] = await Promise.all([
                BvgApi.getDepartures(leftStation.id, state.filters, 30, state.departureCount),
                BvgApi.getDepartures(rightStation.id, state.filters, 30, state.departureCount)
            ]);

            const leftFiltered = filterByWalkTime(leftData.departures || [], leftStation.walkTime || 0);
            const rightFiltered = filterByWalkTime(rightData.departures || [], rightStation.walkTime || 0);
            renderSplitPane(dom.splitDeparturesLeft, leftFiltered);
            renderSplitPane(dom.splitDeparturesRight, rightFiltered);

            // Update last refresh time
            const now = new Date();
            dom.lastUpdate.textContent = `Letzte Aktualisierung: ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;

            // Realtime indicator
            if (leftData.realtimeDataUpdatedAt || rightData.realtimeDataUpdatedAt) {
                dom.realtimeIndicator.style.color = 'var(--on-time-color)';
            }
        } catch (e) {
            console.error('Split view fetch failed:', e);
        }
    }

    function renderSplitPane(container, departures) {
        if (departures.length === 0) {
            container.innerHTML = '<div class="loading"><p>Keine Abfahrten.</p></div>';
            return;
        }

        container.innerHTML = departures.map(dep => {
            const lineName = dep.line ? dep.line.name : '?';
            const lineProduct = dep.line ? dep.line.product : '';
            const lineClass = getLineClass(dep.line);
            const direction = dep.direction || 'Unbekannt';
            const platform = dep.platform || dep.plannedPlatform || '';
            const timeInfo = formatDepartureTime(dep);
            const isCancelled = dep.cancelled === true;
            const isDelayed = dep.delay && dep.delay > 60;

            let rowClass = 'departure-row';
            if (isCancelled) rowClass += ' cancelled';
            else if (isDelayed) rowClass += ' delayed';

            return `
                <div class="${rowClass}">
                    <span class="col-line">
                        <span class="line-badge ${lineProduct} ${lineClass}">${escapeHtml(lineName)}</span>
                    </span>
                    <span class="col-destination">${escapeHtml(direction)}</span>
                    <span class="col-platform">${escapeHtml(platform)}</span>
                    <span class="col-departure">
                        ${timeInfo.main}
                        ${timeInfo.sub}
                    </span>
                </div>
            `;
        }).join('');
    }

    // ===== Kiosk Mode =====
    function toggleKioskMode() {
        if (state.kioskMode) {
            exitKioskMode();
        } else {
            enterKioskMode(true);
        }
    }

    function enterKioskMode(showHint) {
        state.kioskMode = true;
        document.body.classList.add('kiosk-mode');
        dom.kioskToggle.checked = true;
        saveState();
        closeSettings();

        // Request fullscreen
        const elem = document.documentElement;
        if (elem.requestFullscreen) {
            elem.requestFullscreen().catch(() => {});
        } else if (elem.webkitRequestFullscreen) {
            elem.webkitRequestFullscreen();
        }

        // Show exit hint briefly
        if (showHint) {
            showKioskHint();
        }
    }

    function exitKioskMode() {
        state.kioskMode = false;
        document.body.classList.remove('kiosk-mode');
        dom.kioskToggle.checked = false;
        saveState();

        // Exit fullscreen
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else if (document.webkitFullscreenElement) {
            document.webkitExitFullscreen();
        }

        // Remove hint if present
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
    function clearDepartureRows() {
        const rows = dom.departuresList.querySelectorAll('.departure-row');
        rows.forEach(row => row.remove());
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ===== Start =====
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
