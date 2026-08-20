#pragma once
#include <Arduino.h>

// Embedded HTML for the ESP32 captive portal / config interface
// This is served at http://192.168.4.1/ when in AP mode,
// or at the device's IP when connected to WiFi.

const char PORTAL_HTML[] PROGMEM = R"rawhtml(
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Abfahrtsmonitor - Einrichtung</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #1a1a2e;
            color: #eee;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 500px; margin: 0 auto; }
        h1 { color: #ffcc00; margin-bottom: 8px; font-size: 1.5rem; }
        h2 { color: #89b4fa; margin: 20px 0 10px; font-size: 1.1rem; }
        .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 20px; }
        .card {
            background: #16213e;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 16px;
            border: 1px solid #2a2a4a;
        }
        .status-bar {
            display: flex; gap: 8px; align-items: center;
            padding: 10px 14px;
            background: #0f3460;
            border-radius: 8px;
            margin-bottom: 16px;
            font-size: 0.85rem;
        }
        .status-dot {
            width: 10px; height: 10px; border-radius: 50%;
            background: #ff4444;
        }
        .status-dot.connected { background: #44ff44; }
        label { display: block; font-size: 0.85rem; color: #aaa; margin-bottom: 4px; }
        input[type="text"], input[type="password"], input[type="search"] {
            width: 100%; padding: 10px 14px;
            border: 1px solid #2a2a4a; border-radius: 8px;
            background: #0f3460; color: #eee;
            font-size: 0.95rem; outline: none;
            margin-bottom: 12px;
        }
        input:focus { border-color: #89b4fa; }
        button, .btn {
            padding: 10px 18px; border: none; border-radius: 8px;
            font-size: 0.9rem; cursor: pointer;
            background: #ffcc00; color: #1a1a2e; font-weight: 600;
            transition: opacity 0.2s;
        }
        button:hover { opacity: 0.85; }
        .btn-secondary { background: #2a2a4a; color: #eee; }
        .btn-danger { background: #ff4444; color: #fff; }
        .btn-small { padding: 6px 12px; font-size: 0.8rem; }
        .wifi-list { list-style: none; margin: 12px 0; }
        .wifi-item {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 14px; background: #0f3460; border-radius: 8px;
            margin-bottom: 8px; cursor: pointer;
            border: 1px solid transparent; transition: border-color 0.2s;
        }
        .wifi-item:hover { border-color: #89b4fa; }
        .wifi-item .name { font-weight: 500; }
        .wifi-item .signal { color: #888; font-size: 0.8rem; }
        .station-list { margin: 12px 0; }
        .station-item {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 14px; background: #0f3460; border-radius: 8px;
            margin-bottom: 8px;
        }
        .station-item .name { font-size: 0.9rem; }
        .search-results { margin: 8px 0; }
        .search-result {
            padding: 10px 14px; background: #0f3460; border-radius: 8px;
            margin-bottom: 6px; cursor: pointer;
            border: 1px solid transparent; transition: border-color 0.2s;
        }
        .search-result:hover { border-color: #89b4fa; }
        .msg { padding: 10px; border-radius: 8px; margin: 10px 0; font-size: 0.85rem; }
        .msg-success { background: #1a4a2a; color: #44ff44; }
        .msg-error { background: #4a1a1a; color: #ff4444; }
        .hidden { display: none; }
        .loader {
            display: inline-block; width: 16px; height: 16px;
            border: 2px solid #333; border-top-color: #ffcc00;
            border-radius: 50%; animation: spin 0.6s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <h1>Abfahrtsmonitor</h1>
        <p class="subtitle">ESP32 LED Panel Einrichtung</p>

        <div id="status-bar" class="status-bar">
            <div class="status-dot" id="status-dot"></div>
            <span id="status-text">Lade Status...</span>
        </div>

        <!-- WiFi Setup -->
        <div class="card">
            <h2>WLAN-Verbindung</h2>
            <button class="btn-secondary btn-small" onclick="scanWifi()">Netzwerke suchen</button>
            <div id="wifi-scanning" class="hidden"><span class="loader"></span> Suche...</div>
            <ul class="wifi-list" id="wifi-list"></ul>
            <form id="wifi-form" onsubmit="saveWifi(event)">
                <label for="ssid">SSID (Netzwerkname)</label>
                <input type="text" id="ssid" name="ssid" required placeholder="Netzwerkname">
                <label for="password">Passwort</label>
                <input type="password" id="password" name="password" placeholder="WLAN-Passwort">
                <button type="submit">Verbinden & Neustart</button>
            </form>
            <div id="wifi-msg"></div>
        </div>

        <!-- Station Config -->
        <div class="card">
            <h2>Stationen</h2>
            <div class="station-list" id="station-list"></div>
            <label for="station-search">Station suchen</label>
            <input type="search" id="station-search" placeholder="z.B. Alexanderplatz..." oninput="searchStation(this.value)">
            <div id="search-loading" class="hidden"><span class="loader"></span> Suche...</div>
            <div class="search-results" id="search-results"></div>
            <div id="station-msg"></div>
        </div>

        <!-- Display Settings -->
        <div class="card">
            <h2>Anzeige</h2>
            <label for="api-provider">Datenquelle</label>
            <select id="api-provider" onchange="saveSetting('api_host', this.value)" style="width:100%;padding:10px 14px;border:1px solid #2a2a4a;border-radius:8px;background:#0f3460;color:#eee;font-size:0.95rem;margin-bottom:12px;">
                <option value="v6.bvg.transport.rest">BVG (Berlin)</option>
                <option value="v6.vbb.transport.rest">VBB (Berlin + Brandenburg)</option>
            </select>
            <label for="dep-count">Anzahl Abfahrten</label>
            <select id="dep-count" onchange="saveSetting('dep_count', this.value)" style="width:100%;padding:10px 14px;border:1px solid #2a2a4a;border-radius:8px;background:#0f3460;color:#eee;font-size:0.95rem;margin-bottom:12px;">
                <option value="3">3</option>
                <option value="6">6</option>
                <option value="9">9</option>
                <option value="12">12</option>
                <option value="15">15</option>
            </select>
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;">
                <input type="checkbox" id="scroll-enabled" onchange="saveSetting('scroll_enabled', this.checked ? '1' : '0')" style="width:18px;height:18px;accent-color:#ffcc00;">
                <span style="font-size:0.9rem;">Scrollen aktiviert</span>
            </label>
            <label for="scroll-speed">Scroll-Geschwindigkeit</label>
            <select id="scroll-speed" onchange="saveSetting('scroll_speed', this.value)" style="width:100%;padding:10px 14px;border:1px solid #2a2a4a;border-radius:8px;background:#0f3460;color:#eee;font-size:0.95rem;margin-bottom:12px;">
                <option value="1500">1.5s (Schnell)</option>
                <option value="2000">2s</option>
                <option value="3000">3s (Standard)</option>
                <option value="4000">4s</option>
                <option value="5000">5s</option>
                <option value="8000">8s (Langsam)</option>
            </select>
            <label for="brightness">Helligkeit</label>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
                <input type="range" id="brightness" min="5" max="255" value="80" oninput="document.getElementById('brightness-val').textContent=this.value" onchange="saveSetting('brightness', this.value)" style="flex:1;accent-color:#ffcc00;">
                <span id="brightness-val" style="font-size:0.85rem;color:#89b4fa;min-width:28px;text-align:right;">80</span>
            </div>
            <p style="font-size:0.75rem;color:#888;margin-top:4px;">Wenn Scrollen deaktiviert ist, werden nur die naechsten 3 Abfahrten angezeigt.</p>
            <div id="display-msg"></div>
        </div>

        <!-- Transport Filters -->
        <div class="card">
            <h2>Verkehrsmittel</h2>
            <div id="filter-toggles" style="display:flex;flex-wrap:wrap;gap:8px;">
                <label class="filter-toggle" data-filter="suburban" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f3460;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                    <input type="checkbox" checked style="width:16px;height:16px;accent-color:#ffcc00;"> S-Bahn
                </label>
                <label class="filter-toggle" data-filter="subway" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f3460;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                    <input type="checkbox" checked style="width:16px;height:16px;accent-color:#ffcc00;"> U-Bahn
                </label>
                <label class="filter-toggle" data-filter="tram" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f3460;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                    <input type="checkbox" checked style="width:16px;height:16px;accent-color:#ffcc00;"> Tram
                </label>
                <label class="filter-toggle" data-filter="bus" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f3460;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                    <input type="checkbox" checked style="width:16px;height:16px;accent-color:#ffcc00;"> Bus
                </label>
                <label class="filter-toggle" data-filter="ferry" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f3460;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                    <input type="checkbox" checked style="width:16px;height:16px;accent-color:#ffcc00;"> Faehre
                </label>
                <label class="filter-toggle" data-filter="express" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f3460;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                    <input type="checkbox" checked style="width:16px;height:16px;accent-color:#ffcc00;"> IC/ICE
                </label>
                <label class="filter-toggle" data-filter="regional" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f3460;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                    <input type="checkbox" checked style="width:16px;height:16px;accent-color:#ffcc00;"> Regional
                </label>
            </div>
            <p style="font-size:0.75rem;color:#888;margin-top:8px;">Nicht ausgewaehlte Verkehrsmittel werden auf dem LED-Panel ausgeblendet.</p>
            <div id="filter-msg"></div>
        </div>

        <!-- Sleep Mode -->
        <div class="card">
            <h2>Nachtmodus</h2>
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;">
                <input type="checkbox" id="sleep-enabled" onchange="saveSleepSettings()" style="width:18px;height:18px;accent-color:#ffcc00;">
                <span style="font-size:0.9rem;">Nachtmodus aktiviert</span>
            </label>
            <div id="sleep-times" style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
                <div style="flex:1;">
                    <label for="sleep-start" style="font-size:0.8rem;color:#888;">Von</label>
                    <select id="sleep-start" onchange="saveSleepSettings()" style="width:100%;padding:10px 14px;border:1px solid #2a2a4a;border-radius:8px;background:#0f3460;color:#eee;font-size:0.95rem;">
                    </select>
                </div>
                <span style="color:#888;margin-top:16px;">—</span>
                <div style="flex:1;">
                    <label for="sleep-end" style="font-size:0.8rem;color:#888;">Bis</label>
                    <select id="sleep-end" onchange="saveSleepSettings()" style="width:100%;padding:10px 14px;border:1px solid #2a2a4a;border-radius:8px;background:#0f3460;color:#eee;font-size:0.95rem;">
                    </select>
                </div>
            </div>
            <p style="font-size:0.75rem;color:#888;">Display und Datenabfrage werden im angegebenen Zeitraum pausiert. Der Webserver bleibt erreichbar.</p>
            <div id="sleep-msg"></div>
        </div>

        <!-- Security -->
        <div class="card">
            <h2>Sicherheit</h2>
            <p style="font-size:0.8rem;color:#888;margin-bottom:12px;">
                Ohne Passwortschutz kann jeder im selben Netzwerk diese Seite oeffnen und Einstellungen aendern.
                Aktivieren, um einen Benutzernamen/Passwort-Schutz (Basic Auth) fuer diese Seite zu verlangen.
            </p>
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;">
                <input type="checkbox" id="auth-enabled" style="width:18px;height:18px;accent-color:#ffcc00;">
                <span style="font-size:0.9rem;">Passwortschutz aktiviert</span>
            </label>
            <label for="auth-password">Passwort <span style="color:#888;font-weight:normal;">(Benutzername: admin)</span></label>
            <input type="password" id="auth-password" placeholder="Neues Passwort setzen" autocomplete="new-password">
            <button class="btn-secondary btn-small" onclick="saveSecuritySettings()">Speichern</button>
            <p style="font-size:0.7rem;color:#888;margin-top:8px;">
                Nach dem Aktivieren fragt der Browser bei der naechsten Anfrage nach den Zugangsdaten.
                Passwort merken — es wird aus Sicherheitsgruenden nie wieder angezeigt.
            </p>
            <div id="auth-msg"></div>
        </div>

        <!-- Info -->
        <div class="card">
            <h2>Info</h2>
            <p style="font-size:0.8rem; color:#888; margin-bottom:8px;">
                Dieses Interface ist erreichbar unter <strong id="info-hostname">abfahrtsmonitor.local</strong> oder der IP-Adresse.
                Die LED-Anzeige aktualisiert sich automatisch alle 30 Sekunden.
            </p>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:#888;margin-bottom:4px;">
                <span>Betriebszeit:</span><span id="info-uptime">—</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:#888;margin-bottom:4px;">
                <span>Freier Speicher:</span><span id="info-heap">—</span>
            </div>
            <div id="info-stale" class="hidden" style="margin-top:8px;padding:8px 12px;background:#5c2020;border-radius:6px;font-size:0.8rem;color:#ff6666;">
                ⚠ Daten veraltet — API antwortet nicht seit &gt;5 Minuten
            </div>
            <hr style="border-color:#2a2a4a;margin:14px 0;">
            <button class="btn" onclick="doFactoryReset()" style="width:100%;background:#e74c3c;color:#fff;">Werksreset</button>
            <p style="font-size:0.7rem;color:#888;margin-top:6px;text-align:center;">Loescht alle Einstellungen. Alternativ: BOOT-Taste 5 Sekunden halten.</p>
            <div id="reset-msg"></div>
        </div>

        <!-- Firmware Update -->
        <div class="card">
            <h2>Firmware Update</h2>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="font-size:0.85rem;color:#888;">Aktuelle Version:</span>
                <span id="fw-current" style="font-size:0.85rem;font-weight:bold;color:#89b4fa;">...</span>
            </div>
            <button class="btn" onclick="checkFirmwareUpdate()" style="width:100%;margin-bottom:12px;">Nach Updates suchen</button>
            <div id="fw-status"></div>
            <div id="fw-update-info" class="hidden" style="margin-top:12px;padding:12px;background:#0f3460;border-radius:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-size:0.85rem;color:#ccc;">Neue Version:</span>
                    <span id="fw-latest" style="font-size:0.85rem;font-weight:bold;color:#a6e3a1;"></span>
                </div>
                <div id="fw-notes" style="font-size:0.75rem;color:#888;margin-bottom:10px;max-height:100px;overflow-y:auto;white-space:pre-wrap;"></div>
                <button class="btn" id="fw-install-btn" onclick="installFirmwareUpdate()" style="width:100%;background:#a6e3a1;color:#1a1a2e;">Update installieren</button>
            </div>
            <hr style="border-color:#2a2a4a;margin:16px 0;">
            <p style="font-size:0.8rem;color:#888;margin-bottom:8px;">Oder manuell eine .bin-Datei hochladen:</p>
            <input type="file" id="fw-file" accept=".bin" style="font-size:0.8rem;color:#888;margin-bottom:8px;">
            <button class="btn" onclick="uploadFirmware()" style="width:100%;">Manuell flashen</button>
            <div id="fw-upload-progress" class="hidden" style="margin-top:10px;">
                <div style="background:#2a2a4a;border-radius:6px;overflow:hidden;height:8px;">
                    <div id="fw-progress-bar" style="height:100%;background:#a6e3a1;width:0%;transition:width 0.3s;"></div>
                </div>
                <span id="fw-progress-text" style="font-size:0.75rem;color:#888;">0%</span>
            </div>
            <div id="fw-upload-msg"></div>
        </div>
    </div>

    <script>
    let statusData = {};

    async function loadStatus() {
        try {
            const r = await fetch('/api/status');
            statusData = await r.json();
            const dot = document.getElementById('status-dot');
            const text = document.getElementById('status-text');
            if (statusData.wifi_connected) {
                dot.classList.add('connected');
                text.textContent = 'Verbunden mit ' + statusData.wifi_ssid + ' (' + statusData.ip + ')';
            } else {
                dot.classList.remove('connected');
                text.textContent = 'Nicht verbunden — bitte WLAN einrichten';
            }
            renderStations();
            // Update info panel
            if (statusData.uptime_seconds !== undefined) {
                const h = Math.floor(statusData.uptime_seconds / 3600);
                const m = Math.floor((statusData.uptime_seconds % 3600) / 60);
                document.getElementById('info-uptime').textContent = h + 'h ' + m + 'min';
            }
            if (statusData.free_heap) {
                document.getElementById('info-heap').textContent = Math.round(statusData.free_heap / 1024) + ' KB';
            }
            const staleEl = document.getElementById('info-stale');
            if (statusData.data_stale) {
                staleEl.classList.remove('hidden');
            } else {
                staleEl.classList.add('hidden');
            }
        } catch(e) {
            document.getElementById('status-text').textContent = 'Fehler beim Laden';
        }
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function scanWifi() {
        document.getElementById('wifi-scanning').classList.remove('hidden');
        document.getElementById('wifi-list').innerHTML = '';
        const list = document.getElementById('wifi-list');
        try {
            // The device scans asynchronously so the web server stays responsive
            let data = null;
            for (let i = 0; i < 20; i++) {
                const r = await fetch('/api/wifi/scan');
                data = await r.json();
                if (data.status === 'done') break;
                await sleep(1000);
            }
            document.getElementById('wifi-scanning').classList.add('hidden');
            if (!data || data.status !== 'done') {
                list.innerHTML = '<li class="wifi-item">Zeitueberschreitung beim Scan</li>';
                return;
            }
            if (!data.networks || !data.networks.length) {
                list.innerHTML = '<li class="wifi-item">Keine Netzwerke gefunden</li>';
                return;
            }
            list.innerHTML = data.networks.map((n, i) =>
                '<li class="wifi-item" data-idx="' + i + '">' +
                '<span class="name">' + escHtml(n.ssid) + (n.encrypted ? ' 🔒' : '') + '</span>' +
                '<span class="signal">' + n.rssi + ' dBm</span></li>'
            ).join('');
            // Bind by index instead of interpolating the SSID into an onclick
            // attribute — network names are attacker-controlled text.
            list.querySelectorAll('.wifi-item[data-idx]').forEach(el => {
                el.onclick = () => selectWifi(data.networks[el.dataset.idx].ssid);
            });
        } catch(e) {
            document.getElementById('wifi-scanning').classList.add('hidden');
            list.innerHTML = '<li class="wifi-item">Scan fehlgeschlagen</li>';
        }
    }

    // Poll a queued device job (station search / firmware check) to completion
    async function pollJob(attempts = 25) {
        for (let i = 0; i < attempts; i++) {
            await sleep(400);
            const r = await fetch('/api/job');
            if (r.status === 404) throw new Error('Job nicht gefunden');
            const j = await r.json();
            if (j.status === 'done') {
                if (j.code !== 200) throw new Error('Geraet meldet Fehler ' + j.code);
                return j.data;
            }
        }
        throw new Error('Zeitueberschreitung');
    }

    function selectWifi(ssid) {
        document.getElementById('ssid').value = ssid;
        document.getElementById('password').focus();
    }

    async function saveWifi(e) {
        e.preventDefault();
        const ssid = document.getElementById('ssid').value;
        const password = document.getElementById('password').value;
        const msgEl = document.getElementById('wifi-msg');
        try {
            const r = await fetch('/api/wifi', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'ssid=' + encodeURIComponent(ssid) + '&password=' + encodeURIComponent(password)
            });
            const data = await r.json();
            msgEl.innerHTML = '<div class="msg msg-success">' + data.msg + '</div>';
        } catch(e) {
            msgEl.innerHTML = '<div class="msg msg-error">Fehler beim Speichern</div>';
        }
    }

    function renderStations() {
        const list = document.getElementById('station-list');
        if (!statusData.stations || statusData.stations.length === 0) {
            list.innerHTML = '<p style="color:#888;font-size:0.85rem;">Keine Stationen gespeichert.</p>';
            return;
        }
        list.innerHTML = statusData.stations.map(s =>
            '<div class="station-item">' +
            '<span class="name">' + escHtml(s.name) + '</span>' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
            '<input type="number" min="0" max="30" value="' + (s.walk_time || 0) + '" ' +
            'data-id="' + escHtml(s.id) + '" class="walk-input" ' +
            'style="width:50px;padding:4px 6px;border:1px solid #2a2a4a;border-radius:6px;background:#0f3460;color:#eee;text-align:center;font-size:0.85rem;" title="Fussweg (Minuten)">' +
            '<span style="font-size:0.7rem;color:#888;">min</span>' +
            '<button class="btn-danger btn-small remove-btn" data-id="' + escHtml(s.id) + '">Entfernen</button>' +
            '</div></div>'
        ).join('');
        list.querySelectorAll('.walk-input').forEach(el => {
            el.onchange = () => updateWalkTime(el.dataset.id, el.value);
        });
        list.querySelectorAll('.remove-btn').forEach(el => {
            el.onclick = () => removeStation(el.dataset.id);
        });
    }

    let searchTimeout;
    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
    async function searchStation(query) {
        clearTimeout(searchTimeout);
        if (query.length < 2) {
            document.getElementById('search-results').innerHTML = '';
            return;
        }
        searchTimeout = setTimeout(async () => {
            const box = document.getElementById('search-results');
            document.getElementById('search-loading').classList.remove('hidden');
            try {
                const start = await fetch('/api/stations/search?q=' + encodeURIComponent(query));
                if (start.status === 429) throw new Error('Geraet ist beschaeftigt');
                if (!start.ok) throw new Error('Suche fehlgeschlagen');
                const data = await pollJob();
                document.getElementById('search-loading').classList.add('hidden');
                const results = Array.isArray(data) ? data.filter(x => x.type === 'stop') : [];
                if (!results.length) {
                    box.innerHTML = '<div class="search-result">Keine Ergebnisse</div>';
                    return;
                }
                box.innerHTML = results.map((s, i) =>
                    '<div class="search-result" data-idx="' + i + '">' + escHtml(s.name) + '</div>'
                ).join('');
                box.querySelectorAll('.search-result[data-idx]').forEach(el => {
                    const hit = results[el.dataset.idx];
                    el.onclick = () => addStation(hit.id, hit.name);
                });
            } catch(e) {
                document.getElementById('search-loading').classList.add('hidden');
                box.innerHTML = '<div class="search-result">' + escHtml(e.message || 'Fehler') + '</div>';
            }
        }, 400);
    }

    async function addStation(id, name) {
        const msgEl = document.getElementById('station-msg');
        try {
            const r = await fetch('/api/stations', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name)
            });
            const data = await r.json();
            if (data.ok) {
                msgEl.innerHTML = '<div class="msg msg-success">' + name + ' hinzugefuegt!</div>';
                document.getElementById('search-results').innerHTML = '';
                document.getElementById('station-search').value = '';
                loadStatus();
            } else {
                msgEl.innerHTML = '<div class="msg msg-error">' + data.msg + '</div>';
            }
        } catch(e) {
            msgEl.innerHTML = '<div class="msg msg-error">Fehler</div>';
        }
    }

    async function removeStation(id) {
        try {
            await fetch('/api/stations/remove', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'id=' + encodeURIComponent(id)
            });
            loadStatus();
        } catch(e) {}
    }

    async function updateWalkTime(id, val) {
        try {
            await fetch('/api/stations/walktime', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'id=' + encodeURIComponent(id) + '&walk_time=' + encodeURIComponent(val)
            });
        } catch(e) {}
    }

    async function saveSetting(key, val) {
        const msgEl = document.getElementById('display-msg');
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: key + '=' + encodeURIComponent(val)
            });
            const data = await res.json();
            if (data.ok) {
                msgEl.innerHTML = '<div class="msg msg-success">Gespeichert</div>';
            } else {
                msgEl.innerHTML = '<div class="msg msg-error">Fehler</div>';
            }
            setTimeout(() => msgEl.innerHTML = '', 2000);
        } catch(e) {
            msgEl.innerHTML = '<div class="msg msg-error">Fehler</div>';
        }
    }

    async function loadSettings() {
        try {
            const res = await fetch('/api/settings');
            const data = await res.json();
            if (data.dep_count) {
                document.getElementById('dep-count').value = data.dep_count;
            }
            document.getElementById('scroll-enabled').checked = !!data.scroll_enabled;
            if (data.scroll_speed) {
                document.getElementById('scroll-speed').value = data.scroll_speed;
            }
            // Brightness
            if (data.brightness) {
                document.getElementById('brightness').value = data.brightness;
                document.getElementById('brightness-val').textContent = data.brightness;
            }
            // API provider
            if (data.api_host) {
                document.getElementById('api-provider').value = data.api_host;
            }
            // Sleep settings
            document.getElementById('sleep-enabled').checked = !!data.sleep_enabled;
            if (data.sleep_start !== undefined) {
                document.getElementById('sleep-start').value = data.sleep_start;
            }
            if (data.sleep_end !== undefined) {
                document.getElementById('sleep-end').value = data.sleep_end;
            }
            // Transport filters
            document.querySelectorAll('.filter-toggle[data-filter]').forEach(label => {
                const key = 'filter_' + label.dataset.filter;
                if (data[key] !== undefined) {
                    label.querySelector('input').checked = !!data[key];
                }
            });
            // Security — the password itself is never sent back by the device
            authCurrentlyEnabled = !!data.auth_enabled;
            document.getElementById('auth-enabled').checked = authCurrentlyEnabled;
        } catch(e) {}
    }

    // Each filter checkbox saves itself independently, same as the other
    // per-setting controls (no separate "Speichern" button needed).
    document.querySelectorAll('.filter-toggle[data-filter]').forEach(label => {
        label.querySelector('input').addEventListener('change', (e) => {
            saveSetting('filter_' + label.dataset.filter, e.target.checked ? '1' : '0');
        });
    });

    // Set from /api/settings' auth_enabled field — the device is the source
    // of truth for whether a password already exists, since it's never sent
    // back to the browser once saved.
    let authCurrentlyEnabled = false;

    async function saveSecuritySettings() {
        const enabled = document.getElementById('auth-enabled').checked;
        const password = document.getElementById('auth-password').value;
        const msgEl = document.getElementById('auth-msg');
        if (enabled && !password && !authCurrentlyEnabled) {
            msgEl.innerHTML = '<div class="msg msg-error">Bitte zuerst ein Passwort setzen</div>';
            return;
        }
        try {
            const body = 'auth_enabled=' + (enabled ? '1' : '0') +
                (password ? '&auth_password=' + encodeURIComponent(password) : '');
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
                msgEl.innerHTML = '<div class="msg msg-success">Gespeichert</div>';
                authCurrentlyEnabled = enabled;
            } else {
                msgEl.innerHTML = '<div class="msg msg-error">' + escHtml(data.msg || 'Fehler') + '</div>';
            }
            // Never leave the password sitting in the input field
            document.getElementById('auth-password').value = '';
            setTimeout(() => msgEl.innerHTML = '', 3000);
        } catch(e) {
            msgEl.innerHTML = '<div class="msg msg-error">Fehler</div>';
        }
    }

    function initSleepSelects() {
        const startSel = document.getElementById('sleep-start');
        const endSel = document.getElementById('sleep-end');
        for (let h = 0; h < 24; h++) {
            const label = String(h).padStart(2, '0') + ':00';
            startSel.innerHTML += '<option value="' + h + '">' + label + '</option>';
            endSel.innerHTML += '<option value="' + h + '">' + label + '</option>';
        }
        startSel.value = 22;
        endSel.value = 6;
    }

    async function saveSleepSettings() {
        const enabled = document.getElementById('sleep-enabled').checked ? '1' : '0';
        const start = document.getElementById('sleep-start').value;
        const end = document.getElementById('sleep-end').value;
        const msgEl = document.getElementById('sleep-msg');
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'sleep_enabled=' + enabled + '&sleep_start=' + start + '&sleep_end=' + end
            });
            const data = await res.json();
            if (data.ok) {
                msgEl.innerHTML = '<div class="msg msg-success">Gespeichert</div>';
            } else {
                msgEl.innerHTML = '<div class="msg msg-error">Fehler</div>';
            }
            setTimeout(() => msgEl.innerHTML = '', 2000);
        } catch(e) {
            msgEl.innerHTML = '<div class="msg msg-error">Fehler</div>';
        }
    }

    async function doFactoryReset() {
        if (!confirm('Alle Einstellungen werden geloescht und das Geraet startet im Setup-Modus neu. Fortfahren?')) return;
        const msgEl = document.getElementById('reset-msg');
        try {
            const r = await fetch('/api/factory-reset', { method: 'POST' });
            const data = await r.json();
            msgEl.innerHTML = '<div class="msg msg-success">' + data.msg + '</div>';
            setTimeout(() => { location.reload(); }, 5000);
        } catch(e) {
            msgEl.innerHTML = '<div class="msg msg-error">Fehler</div>';
        }
    }

    // Init
    initSleepSelects();
    loadStatus();
    loadSettings();
    loadFirmwareVersion();

    // Refresh status every 30s
    setInterval(loadStatus, 30000);

    async function loadFirmwareVersion() {
        try {
            const r = await fetch('/api/firmware/version');
            const data = await r.json();
            document.getElementById('fw-current').textContent = 'v' + data.version;
        } catch(e) {
            document.getElementById('fw-current').textContent = 'Unbekannt';
        }
    }

    async function checkFirmwareUpdate() {
        const statusEl = document.getElementById('fw-status');
        const infoEl = document.getElementById('fw-update-info');
        infoEl.classList.add('hidden');
        statusEl.innerHTML = '<div class="msg" style="color:#888;">Suche nach Updates...</div>';
        try {
            const start = await fetch('/api/firmware/check');
            if (!start.ok) {
                const err = await start.json().catch(() => ({}));
                statusEl.innerHTML = '<div class="msg msg-error">' + escHtml(err.error || 'Fehler') + '</div>';
                return;
            }
            const data = await pollJob();
            if (!data) {
                statusEl.innerHTML = '<div class="msg msg-error">Keine Antwort von GitHub</div>';
                return;
            }
            if (data.update_available && data.download_url) {
                statusEl.innerHTML = '<div class="msg msg-success">Neues Update verfuegbar!</div>';
                document.getElementById('fw-latest').textContent = data.latest_version;
                document.getElementById('fw-notes').textContent = data.release_notes || 'Keine Release-Notizen.';
                document.getElementById('fw-install-btn').dataset.url = data.download_url;
                infoEl.classList.remove('hidden');
            } else if (data.update_available && !data.download_url) {
                statusEl.innerHTML = '<div class="msg msg-error">Update gefunden (' + escHtml(data.latest_version) + ') aber keine .bin Datei im Release.</div>';
            } else {
                statusEl.innerHTML = '<div class="msg msg-success">Firmware ist aktuell (' + escHtml(data.current_version) + ')</div>';
            }
        } catch(e) {
            statusEl.innerHTML = '<div class="msg msg-error">Verbindungsfehler</div>';
        }
    }

    async function installFirmwareUpdate() {
        const btn = document.getElementById('fw-install-btn');
        const url = btn.dataset.url;
        if (!url) return;
        btn.disabled = true;
        btn.textContent = 'Update wird installiert...';
        const statusEl = document.getElementById('fw-status');
        try {
            const r = await fetch('/api/firmware/update', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'url=' + encodeURIComponent(url)
            });
            const data = await r.json();
            if (data.ok) {
                statusEl.innerHTML = '<div class="msg msg-success">Update gestartet! Das Geraet startet in wenigen Sekunden neu...</div>';
                btn.textContent = 'Neustart...';
                setTimeout(() => { location.reload(); }, 15000);
            } else {
                statusEl.innerHTML = '<div class="msg msg-error">' + (data.msg || data.error) + '</div>';
                btn.disabled = false;
                btn.textContent = 'Update installieren';
            }
        } catch(e) {
            statusEl.innerHTML = '<div class="msg msg-error">Fehler beim Starten des Updates</div>';
            btn.disabled = false;
            btn.textContent = 'Update installieren';
        }
    }

    async function uploadFirmware() {
        const fileInput = document.getElementById('fw-file');
        const msgEl = document.getElementById('fw-upload-msg');
        const progressEl = document.getElementById('fw-upload-progress');
        const progressBar = document.getElementById('fw-progress-bar');
        const progressText = document.getElementById('fw-progress-text');

        if (!fileInput.files.length) {
            msgEl.innerHTML = '<div class="msg msg-error">Bitte eine .bin Datei auswaehlen</div>';
            return;
        }

        const file = fileInput.files[0];
        if (!file.name.endsWith('.bin')) {
            msgEl.innerHTML = '<div class="msg msg-error">Nur .bin Dateien erlaubt</div>';
            return;
        }

        msgEl.innerHTML = '';
        progressEl.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = '0%';

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/firmware/upload');

        xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = pct + '%';
                progressText.textContent = pct + '%';
            }
        };

        xhr.onload = function() {
            try {
                const data = JSON.parse(xhr.responseText);
                if (data.ok) {
                    msgEl.innerHTML = '<div class="msg msg-success">' + data.msg + '</div>';
                    progressBar.style.width = '100%';
                    progressText.textContent = '100%';
                    setTimeout(() => { location.reload(); }, 10000);
                } else {
                    msgEl.innerHTML = '<div class="msg msg-error">' + (data.msg || 'Upload fehlgeschlagen') + '</div>';
                }
            } catch(e) {
                msgEl.innerHTML = '<div class="msg msg-error">Unerwarteter Fehler</div>';
            }
        };

        xhr.onerror = function() {
            msgEl.innerHTML = '<div class="msg msg-error">Verbindung verloren</div>';
        };

        const formData = new FormData();
        formData.append('firmware', file);
        xhr.send(formData);
    }
    </script>
</body>
</html>
)rawhtml";
