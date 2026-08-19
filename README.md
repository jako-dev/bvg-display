# BVG Abfahrtsmonitor

A real-time departure display for Berlin public transport (BVG/VBB), available as a **web app** and as **ESP32 LED matrix display** firmware.

Inspired by [T-Skylt](https://shop.t-skylt.se/products/t-skylt-x-silver-metallic).

**[Live Demo →](https://jako-dev.github.io/bvg-display/)**

![License](https://img.shields.io/badge/license-MIT-blue)

---

## Overview

| Platform | Description |
|----------|-------------|
| **Web App** | Browser-based departure monitor — works on any device |
| **ESP32 Firmware** | Physical HUB75 LED matrix display (128×32) with WiFi config portal |

---

## Web App

### Features

- **Real-time departures** from any BVG/VBB station
- **Multi-station** support with tabs
- **Per-station walk time** — hides departures you can't reach in time (the lookahead window and result count are widened automatically so the board stays full)
- **Transport filters** — S-Bahn, U-Bahn, Tram, Bus, Ferry, Regional
- **Delay highlighting** — red for delays, green for on-time, strikethrough for cancelled
- **Service alerts** — disruption banners
- **Journey planner** — from your "home" station to anywhere in the network: which line to board, where to change, walking legs, platforms and live delays
- **Map** — the route of any departure, the legs of any connection, and live vehicle positions polled from the network's radar feed. Falls back to a self-contained schematic when map tiles aren't reachable
- **Views**: Single, Split (two stations side-by-side, each independently selectable), Verbindung (journey planner), Karte (map), LED emulator
- **Themes**: Dunkel, Modern
- **Kiosk mode** — fullscreen for wall-mounted tablets
- **Auto-refresh** — configurable interval (10–120s)
- **Data source selector** — BVG or VBB
- **Installable** — add-to-home-screen / installable as a standalone app, with the app shell cached for offline startup (live departure data always requires a connection)
- **Offline-capable settings** — all settings persisted in localStorage
- **Preconfigured stations** — ship default stations with the deployment (`config.json`) or pass them per URL, so a client that has never set anything up still sees a full board — see [Preconfigured Stations](#preconfigured-stations)

### Quick Start

Open the [live version](https://jako-dev.github.io/bvg-display/) or run locally:

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

---

## Preconfigured Stations

By default the app is empty until the visitor adds a station, and everything is
kept in that browser's localStorage. That does not work for a display you just
want to *point at* — a wall tablet, a fresh browser profile, or a Home Assistant
dashboard card, where nobody is going to open the settings panel first.

Two config sources fix that. Both are optional and neither replaces the settings
panel; they only decide what a client sees **before** it has settings of its own.

Settings are layered in a fixed order, each overriding the one before it:

```
built-in defaults  →  config.json  →  localStorage  →  config.json (if "lock")  →  URL parameters
```

### 1. `config.json` — deployment defaults

Edit `config.json` next to `index.html` in your deployment (or fork). Any client
that has **not** configured its own stations starts with what is listed here:

```json
{
  "lock": false,
  "stations": [
    { "id": "900100003", "name": "S+U Alexanderplatz", "walkTime": 4 },
    { "id": "900120005" }
  ],
  "apiProvider": "v6.bvg.transport.rest",
  "departureCount": 9,
  "refreshInterval": 45,
  "theme": "modern",
  "viewMode": "single",
  "kioskMode": false,
  "filters": { "bus": false, "ferry": false }
}
```

| Key | Description |
|-----|-------------|
| `stations` | Default stations. `name` and `walkTime` are optional — a missing name is looked up from the API on first load |
| `lock` | `true` makes this file win over the client's own saved settings — for dedicated wall displays that must always show the same stations |
| `apiProvider` | `v6.bvg.transport.rest` or `v6.vbb.transport.rest` |
| `departureCount` | 1–15 |
| `refreshInterval` | 10–120 seconds |
| `theme` | `dark` or `modern` |
| `viewMode` | `single`, `split` or `led` |
| `kioskMode` | `true` hides header and footer |
| `ledScrollEnabled` / `ledScrollSpeed` | LED view scrolling (1500–8000 ms) |
| `filters` | Either explicit flags (`{"bus": false}`) or a whitelist (`["subway","tram"]`, everything else off) |
| `activeStationId`, `splitLeftId`, `splitRightId`, `homeStationId` | Which station each view starts on |
| `mapLive` | Poll live vehicle positions in the map view (default `true`) |
| `mapTileUrl`, `mapAttribution` | Point the map at a different tile server. Deployment-only — deliberately not accepted from the URL, where a link could otherwise repoint the map at any host |

Every key is optional, and unknown or malformed values are ignored rather than
applied — a typo falls back to the previous layer instead of breaking the board.
A missing `config.json` is a supported state too; the app simply has no presets.

> `config.json` is fetched with revalidation and served network-first by the
> service worker, so an edit takes effect on the next load — no cache bust needed.

### 2. URL parameters — per-embed config

The same settings can be passed in the query string. These win over everything
else, and — unless you add `persist=1` — they are **not** written to
localStorage, so embedding the board somewhere never overwrites the settings
that browser already has.

```
https://jako-dev.github.io/bvg-display/?stop=900100003:4&stop=900120005&view=split&kiosk=1
```

| Parameter | Alias | Example |
|-----------|-------|---------|
| `stop` (repeatable) | — | `stop=900100003`, `stop=900100003\|S%2BU%20Alexanderplatz:4` |
| `stops` | — | `stops=900100003,900120005` (comma-separated) |
| `view` | — | `view=single` / `split` / `led` |
| `kiosk` | — | `kiosk=1` |
| `theme` | — | `theme=modern` |
| `count` | `departures` | `count=9` |
| `refresh` | `interval` | `refresh=45` |
| `provider` | `source` | `provider=v6.vbb.transport.rest` |
| `filter` | `filters` | `filter=subway,tram` (everything else off) |
| `scroll` / `scrollSpeed` | — | `scroll=0`, `scrollSpeed=5000` |
| `left` / `right` | — | Station IDs for the split panes |
| `active` | — | Station ID the single view starts on |
| `home` | — | Station ID the journey planner departs from |
| `to` | `destination` | Journey destination, `<id>` or `<id>\|<name>` |
| `live` | — | `live=0` turns off live vehicles on the map |
| `persist` | — | `persist=1` saves the URL config to localStorage |

A stop is `<id>`, `<id>:<walkMinutes>`, `<id>|<name>` or `<id>|<name>:<walkMinutes>`.
The name is optional — with the ID alone the app resolves the real station name
from the API in the background. Station IDs come from the settings panel's search
or from `https://v6.bvg.transport.rest/locations?query=Alexanderplatz&stops=true`.

> URL-encode the name: `+` means a space in a query string, so `S+U Alexanderplatz`
> has to be written `S%2BU%20Alexanderplatz`.

### Embedding in Home Assistant

Because the config travels in the URL, no per-client setup is needed — add a
**Webpage card** (or an `iframe` panel) pointing at the board:

```yaml
type: iframe
url: >-
  https://jako-dev.github.io/bvg-display/?stop=900100003:4&stop=900120005&view=split&kiosk=1&theme=modern&refresh=60
aspect_ratio: 50%
```

`kiosk=1` drops the header and footer so only the departure board is left, and
each card can carry its own stations — the same Home Assistant instance can show
different stops on different dashboards without any of them interfering.

---

## ESP32 Hardware Display

The `esp32/` directory contains firmware for a physical departure display using HUB75 RGB LED matrix panels.

### Features

- **128×32 pixel RGB LED display** (2× 64×32 HUB75 panels)
- **WiFi captive portal** for zero-config setup (no coding required)
- **Multi-station** with per-station walk time filtering
- **OTA firmware updates** via GitHub Releases (one-click from web UI)
- **Automatic rollback** — if a firmware update breaks WiFi, auto-reverts to last known good
- **Night mode** — scheduled display off (e.g. 22:00–06:00)
- **Adjustable brightness**
- **mDNS** — accessible at `http://bvg-display.local`
- **Watchdog** — auto-reboot on hang
- **Factory reset** — via web UI or hold BOOT button 5 seconds
- **Stale data indicator** — blinking red dot when API hasn't responded in >5 min
- **Keeps the last good data** — a failed poll leaves the previous departures on screen instead of blanking the panel
- **Transport filters** — S-Bahn, U-Bahn, Tram, Bus, Ferry, IC/ICE, Regional (mirrors the web app's filters)
- **Optional password protection** — HTTP Basic Auth for the config page, off by default

### Components

| Component | Description |
|-----------|-------------|
| ESP32 DevKit V1 (30-pin) | Any ESP32-WROOM-32 board |
| HUB75 LED Matrix 64×32 (×2) | P3 or P4 pitch, chained for 128×32 |
| 5V Power Supply (≥4A) | Each panel draws up to 2A at full white |
| Jumper wires / IDC ribbon | HUB75 connection |

### Wiring

```
ESP32 Pin    HUB75 Signal    HUB75 Pin
─────────    ────────────    ─────────
GPIO 25  ──► R1              1
GPIO 26  ──► G1              2
GPIO 27  ──► B1              3
GND      ──► GND             4
GPIO 14  ──► R2              5
GPIO 12  ──► G2              6
GPIO 13  ──► B2              7
GND      ──► GND             8
GPIO 23  ──► A               9
GPIO 19  ──► B               10
GPIO  5  ──► C               11
GPIO 17  ──► D               12
GPIO 16  ──► CLK             13
GPIO  4  ──► LAT (STB)       14
GPIO 15  ──► OE              15
GND      ──► GND             16
```

**Power:**
```
5V PSU ─────┬──► Panel 1 (5V / GND)
            ├──► Panel 2 (5V / GND)
            └──► ESP32 VIN / GND
```

> Do not power panels from the ESP32's 5V pin.

### Flashing

```bash
cd esp32
pio run --target upload
pio device monitor --baud 115200
```

### First-Time Setup

1. Power on → ESP32 creates WiFi AP **"BVG-Display"** (open)
2. Connect with phone/laptop → captive portal opens
3. Enter WiFi credentials → device connects to your network
4. Access config at `http://bvg-display.local` or the device IP
5. Add stations → LED matrix shows departures

### OTA Updates

When a new [GitHub Release](https://github.com/jako-dev/bvg-display/releases) is published:
1. Open the device config page
2. Click "Nach Updates suchen" in the Firmware section
3. Click "Update installieren"

The device downloads the firmware, flashes it, and reboots. If the update fails to connect to WiFi, it automatically rolls back.

You can also manually upload a `.bin` file via the web UI.

### Configuration (Web Portal)

All runtime settings are adjustable from the config page — no reflashing needed:

| Setting | Description |
|---------|-------------|
| Stations | Add/remove, per-station walk time |
| Data source | BVG or VBB |
| Departures count | 3–15 |
| Scroll | Enable/disable, speed |
| Brightness | 5–255 |
| Night mode | Scheduled display off |
| Firmware update | GitHub OTA or manual upload |
| Transport filters | Per-type show/hide, same set as the web app |
| Security | Optional password protection (HTTP Basic Auth) |
| Factory reset | Wipe all settings |

---

## Project Structure

```
bvg-display/
├── index.html              # Web app entry
├── config.json             # Optional deployment defaults (preset stations)
├── manifest.json           # PWA manifest (install as app)
├── service-worker.js       # Offline app-shell cache (never caches live data)
├── icons/                  # PWA icons (192/512/apple-touch)
├── css/styles.css          # Themes & layout
├── js/
│   ├── api.js              # Transport REST API wrapper
│   ├── config.js           # config.json + URL parameter config
│   ├── app.js              # Application logic
│   ├── journey.js          # Connection list rendering
│   ├── map.js              # Leaflet map + SVG schematic fallback
│   └── led-renderer.js     # Canvas LED panel emulator
├── vendor/
│   └── leaflet/            # Leaflet 1.9.4 (BSD-2-Clause), lazy-loaded
├── esp32/
│   ├── platformio.ini      # PlatformIO config
│   └── src/
│       ├── main.cpp        # Firmware (WiFi, API, LED, web server, OTA)
│       ├── config.h        # Pin mappings & constants
│       ├── font.h          # 4×7 bitmap font
│       ├── web_portal.h    # Embedded config web UI
│       └── version.h       # Generated by CI on release builds — not committed
└── .github/
    └── workflows/
        └── build-firmware.yml  # CI: build on every esp32/ change, attach .bin to releases
```

## API

Uses the public [transport.rest](https://transport.rest/) APIs:

| Endpoint | Coverage |
|----------|----------|
| `v6.bvg.transport.rest` | Berlin (BVG) |
| `v6.vbb.transport.rest` | Berlin + Brandenburg (VBB) |

- No API key required
- Rate limit: ~100 requests/minute
- CORS enabled (browser-friendly)

Endpoints used:

| Endpoint | Used for |
|----------|----------|
| `/locations` | Station search |
| `/stops/:id` | Resolving names and coordinates for stations given by ID |
| `/stops/:id/departures` | The departure board |
| `/journeys` | Journey planner (with `polylines=true` for the map) |
| `/trips/:id` | A single trip's route shape (`polyline=true`) |
| `/radar` | Live vehicle positions in the visible area |

The map polls `/radar` every 15s — one request per tick regardless of how many
vehicles are in view, which is what keeps the live map inside the rate limit.
Trip routes are fetched on demand (when you click a departure), not for every
row on the board.

### Map tiles

Map tiles come from OpenStreetMap by default. That is a shared, donated
resource with a [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) —
fine for a personal dashboard, not for anything high-traffic. Point
`mapTileUrl` in `config.json` at your own tile server if you need more.

If tiles can't be reached at all — offline, blocked, or the tile server is
down — the map falls back to a self-contained SVG schematic drawn from the same
coordinates. Routes, stops and vehicles still render; only the streets are
missing.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Panel stays dark | Check 5V power; verify shared GND with ESP32 |
| Garbled display | Recheck HUB75 wiring, no loose jumpers |
| Can't find "BVG-Display" AP | Reflash; hold BOOT during upload |
| Upload fails | Hold BOOT when upload starts; lower `upload_speed` |
| No departures | Check serial monitor; BVG API may be temporarily down |
| Blinking red dot | API stale >5 min — check WiFi and internet connectivity |
| Station name looks wrong | Umlauts are folded to ASCII (ä→a, ö→o, ü→u, ß→s) — the 4×7 font has no accented glyphs |
| OTA failed | Device keeps old firmware; retry or use manual .bin upload |

## Security

The ESP32 config page has **no authentication by default**. Anyone who can reach
the device on your network can change its settings, trigger a factory reset, or
flash new firmware. An optional password can be set from the portal's
"Sicherheit" card (username is always `admin`), which puts standard HTTP Basic
Auth in front of the config page and every settings/station/firmware endpoint —
but it is off until you turn it on, and there is no recovery flow for a lost
password short of a factory reset (hold BOOT 5 seconds). Either way, keep the
device on a trusted LAN (or a separate IoT VLAN) and do not expose port 80 to
the internet.

WiFi credentials — and the Basic Auth password, if you set one — are stored in
the ESP32's NVS partition in plain text, which is readable by anyone with
physical access and a serial cable.

## License

MIT
