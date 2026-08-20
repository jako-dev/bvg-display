# Abfahrtsmonitor

A real-time departure display for German public transport, available as a **web app** and as **ESP32 LED matrix display** firmware. Departure boards, journey planning and a live route map, on any stop in Germany — with Berlin-specific data sources still selectable.

Inspired by [T-Skylt](https://shop.t-skylt.se/products/t-skylt-x-silver-metallic).

**[Live Demo →](https://jako-dev.github.io/abfahrtsmonitor/)**

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

- **Real-time departures** from any stop in Germany
- **Multi-station** support with tabs
- **Per-station walk time** — hides departures you can't reach in time (the lookahead window and result count are widened automatically so the board stays full)
- **Transport filters** — S-Bahn, U-Bahn, Tram, Bus, Ferry, Regional
- **Delay highlighting** — red for delays, green for on-time, strikethrough for cancelled
- **Service alerts** — disruption banners
- **Journey planner** — from your "home" station *or a street address* to anywhere in the network, including places that aren't stops: "Markthalle 9" works as a destination, and the walks at both ends are planned as real legs
- **Map** — show any line's route and stops by name (`M10`, `U5`, `S41`), the route of any departure, the legs of any connection, and live vehicles. Scroll off the loaded area and a button offers to reload vehicles for where you are looking. Falls back to a self-contained schematic when map tiles aren't reachable
- **View switch in the header** — board, split, journey, map and LED, one click apart
- **Views**: Single, Split (two stations side-by-side, each independently selectable), Verbindung (journey planner), Karte (map), LED emulator
- **Themes**: Dunkel, Modern
- **Kiosk mode** — fullscreen for wall-mounted tablets
- **Auto-refresh** — configurable interval (10–120s)
- **Data source selector** — Transitous (nationwide, the default), DB, BVG or VBB
- **Installable** — add-to-home-screen / installable as a standalone app, with the app shell cached for offline startup (live departure data always requires a connection)
- **Offline-capable settings** — all settings persisted in localStorage
- **Preconfigured stations** — ship default stations with the deployment (`config.json`) or pass them per URL, so a client that has never set anything up still sees a full board — see [Preconfigured Stations](#preconfigured-stations)

### Quick Start

Open the [live version](https://jako-dev.github.io/abfahrtsmonitor/) or run locally:

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
| `apiProvider` | `v6.bvg.transport.rest`, `v6.vbb.transport.rest`, `v6.db.transport.rest` or `api.transitous.org` |
| `departureCount` | 1–15 |
| `refreshInterval` | 10–120 seconds |
| `theme` | `dark` or `modern` |
| `viewMode` | `single`, `split` or `led` |
| `kioskMode` | `true` hides header and footer |
| `ledScrollEnabled` / `ledScrollSpeed` | LED view scrolling (1500–8000 ms) |
| `filters` | Either explicit flags (`{"bus": false}`) or a whitelist (`["subway","tram"]`, everything else off) |
| `activeStationId`, `splitLeftId`, `splitRightId`, `homeStationId` | Which station each view starts on |
| `mapLive` | Poll live vehicle positions in the map view (default `true`) |
| `homeAddress` | Journey origin as an address — `{"latitude": …, "longitude": …, "address": "…"}` or the string form `"lat,lng\|Label"` |
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
https://jako-dev.github.io/abfahrtsmonitor/?stop=900100003:4&stop=900120005&view=split&kiosk=1
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
| `provider` | `source` | `provider=v6.db.transport.rest` |
| `filter` | `filters` | `filter=subway,tram` (everything else off) |
| `scroll` / `scrollSpeed` | — | `scroll=0`, `scrollSpeed=5000` |
| `left` / `right` | — | Station IDs for the split panes |
| `active` | — | Station ID the single view starts on |
| `home` | — | Station ID the journey planner departs from |
| `address` | — | Journey origin as an address: `lat,lng` or `lat,lng\|Label` |
| `to` | `destination` | Journey destination, `<id>` or `<id>\|<name>` |
| `live` | — | `live=0` turns off live vehicles on the map |
| `persist` | — | `persist=1` saves the URL config to localStorage |

A stop is `<id>`, `<id>:<walkMinutes>`, `<id>|<name>` or `<id>|<name>:<walkMinutes>`.
The name is optional — with the ID alone the app resolves the real station name
from the API in the background. Station IDs come from the settings panel's search
or from `https://v6.bvg.transport.rest/locations?query=Alexanderplatz&stops=true`.

> URL-encode the name: `+` means a space in a query string, so `S+U Alexanderplatz`
> has to be written `S%2BU%20Alexanderplatz`.

### Finding places

The destination search covers stops, addresses and points of interest. The
operator's own POI index is thin outside well-known landmarks — *Brandenburger
Tor* resolves, a particular market hall usually does not — so when it returns no
actual place, the query falls back to [Photon](https://photon.komoot.io), an
OpenStreetMap geocoder. No API key and no registration.

Photon rather than Nominatim deliberately: Nominatim's usage policy forbids
autocomplete-style querying, which is exactly what a search field does.

The fallback is a third-party request, so it is deliberately narrow: it only
fires when the transport index found no place (never on every keystroke), it is
throttled to one request a second, and it can be switched off under
**Einstellungen → Ortssuche**. What gets sent is the text typed into the
destination field.

### Favourites

The star next to the destination saves it; saved destinations appear as chips
under the search and are kept in localStorage. Eight at most — a list you have
to scroll is no faster than typing the name.

### When the API is down

`transport.rest` is a free, hobby-run service and it does fall over. When it
does it usually stops sending CORS headers with its error pages too, so the
browser reports a CORS failure and an opaque `TypeError` rather than the actual
status — which looks like a bug in this app and is not.

The app handles it: requests are retried once, the board keeps showing the last
departures it loaded (dimmed, with the time they were fetched) instead of
blanking, and it offers to switch to the other endpoint — BVG and VBB are
separately hosted, so one being down rarely means the next one is.

### Showing a line

Type a line name into the map toolbar — `M10`, `U5`, `S41`. The lookup goes
through `/trips?lineName=…`, which searches the **whole network**, so it finds a
line whether or not it happens to run past the area you're looking at. Pick a
direction and its full route and stops are drawn.

### Starting journeys from your front door

Set **Zuhause (Adresse)** in the settings panel and type your address — it is
resolved through the same API (`/locations?addresses=true`) and stored in that
browser's localStorage. The planner then offers it as an origin and every
connection begins with the walk to the departure stop, and a home marker shows
on the map so you can see where you are relative to whatever is drawn.

For a kiosk or an embedded view, pass it in the URL instead:

```
?address=52.52151,13.41127|Alexanderplatz&to=900120025&view=journey
```

> Deliberately not part of the shipped `config.json`: this repo and its Pages
> deployment are public, and a home address committed there is a home address
> published. Keep it in localStorage or in a URL you don't share.

### Embedding in Home Assistant

Because the config travels in the URL, no per-client setup is needed — add a
**Webpage card** (or an `iframe` panel) pointing at the board:

```yaml
type: iframe
url: >-
  https://jako-dev.github.io/abfahrtsmonitor/?stop=900100003:4&stop=900120005&view=split&kiosk=1&theme=modern&refresh=60
aspect_ratio: 50%
```

`kiosk=1` drops the header and footer so only the departure board is left, and
each card can carry its own stations — the same Home Assistant instance can show
different stops on different dashboards without any of them interfering.

---

## Deploying

The web app is published by the **Deploy Web App** workflow
(`.github/workflows/pages.yml`) to a `gh-pages` branch, which GitHub Pages
serves:

| Source | URL |
|--------|-----|
| `main` (on every push) | `https://jako-dev.github.io/abfahrtsmonitor/` |
| any branch (on demand) | `https://jako-dev.github.io/abfahrtsmonitor/preview/<branch>/` |

Both are live at the same time, so previewing a branch never takes the demo
down. `/preview/` lists whatever is currently published.

### Publishing a branch without merging

Actions → **Deploy Web App** → *Run workflow* → pick the branch → *Run*.

The branch needs this workflow file on it to appear in that list; for a branch
that predates it, run the workflow from `main` and put the branch name in the
`ref` input instead.

Deleting a branch removes its preview automatically.

### One-time setup

The workflow publishes to `gh-pages`, so Pages has to be pointed at it:

**Settings → Pages → Build and deployment → Source: Deploy from a branch →
Branch: `gh-pages` / `(root)`**

Until that switch is made, the workflow will push to `gh-pages` but the live
site will still be served from `main`. The `gh-pages` branch is created by the
first run — there is nothing to set up by hand.

### What gets published

An allow-list, set as `SITE_PATHS` at the top of the workflow — the repo also
holds the ESP32 firmware, which has no business being served. Add new top-level
assets there when they appear.

Each deployment is a self-contained directory, so a preview's service worker is
scoped to its own subdirectory and cannot interfere with the live site.

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
- **mDNS** — accessible at `http://abfahrtsmonitor.local`
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

1. Power on → ESP32 creates WiFi AP **"Abfahrtsmonitor"** (open)
2. Connect with phone/laptop → captive portal opens
3. Enter WiFi credentials → device connects to your network
4. Access config at `http://abfahrtsmonitor.local` or the device IP
5. Add stations → LED matrix shows departures

### OTA Updates

When a new [GitHub Release](https://github.com/jako-dev/abfahrtsmonitor/releases) is published:
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
abfahrtsmonitor/
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
    ├── scripts/
    │   └── preview-index.sh    # Generates the /preview/ listing page
    └── workflows/
        ├── build-firmware.yml  # CI: build on every esp32/ change, attach .bin to releases
        └── pages.yml           # Publishes the web app + per-branch previews
```

## API

Uses the public [transport.rest](https://transport.rest/) APIs:

Uses the public [transport.rest](https://transport.rest/) endpoints and
[Transitous](https://transitous.org/):

| Endpoint | Coverage | Live vehicles | Search by line |
|----------|----------|---------------|----------------|
| `api.transitous.org` **(default)** | Germany and neighbours | yes | yes, map-scoped |
| `v6.db.transport.rest` | Germany (DB) | no | no |
| `v6.bvg.transport.rest` | Berlin (BVG) | yes | yes |
| `v6.vbb.transport.rest` | Berlin + Brandenburg (VBB) | yes | yes |

Transitous is the default because a client that has never been configured has
no way to say where it is, and a Berlin-only source is wrong everywhere else.
A browser that has already picked a source keeps its choice — the saved setting
is restored over the default. Berlin users who want line search should select
BVG or VBB.

Live vehicles poll every 30 seconds on every source. `radarIntervalMs` in
`PROVIDERS` can slow an individual one further; nothing polls faster.

- No API key required, no registration
- CORS enabled (browser-friendly)

The three transport.rest endpoints speak one request and response shape;
switching between them is a base-URL swap. They are not the same backend,
though: BVG and VBB are HAFAS deployments, while the DB one was migrated to
`db-vendo-client` after Deutsche Bahn retired its HAFAS endpoint, and that
client has no equivalent for `/radar` or `/trips?lineName=`.

Transitous is a different system again — a community-run
[MOTIS](https://github.com/motis-project/motis) instance — and is translated in
`js/motis.js`, which maps its vocabulary onto the same objects the rest of the
app renders. Two things there are worth knowing:

- Its geocoder returns stops, points of interest and addresses from one index,
  so the separate Photon lookup is switched off while it is selected.
- `map/trips` returns trip *segments* with a departure, an arrival and a shape,
  not vehicle positions. A position is interpolated along the shape for the
  current moment, the way MOTIS's own map does it. Its `precision` parameter —
  which sets how many decimal places the shapes are encoded with — is
  deliberately left alone: the response does not say which value was used, so
  asking for fewer places to save bandwidth means decoding against a number the
  client only assumes, and being wrong by one divides every coordinate by ten.
  Positions that land outside the requested box are discarded rather than
  drawn, so a mis-scale shows up as "no vehicles" instead of a fleet in the
  Atlantic.
- There is no search-by-line-name endpoint, so the line lookup reads
  `map/routes` — every route in a box around what is on screen — and filters by
  name locally. That makes it **map-scoped rather than network-wide**: a line
  running on the other side of the country is not found until you pan there.
  In exchange it draws the *scheduled* route rather than a running vehicle's
  track, so a line that is not operating right now still shows where it goes.
  `getCapabilities().lineSearchScope` is `'map'` there and `'network'` on the
  transport.rest endpoints; the field's placeholder and its empty state say
  which is in force.
- MOTIS holds one line as **several routes** — one per distinct stop sequence,
  so each direction and every short working is its own entry. Drawing any one
  of them draws part of the line. The search pools their segments, deduplicates
  the shared hops, and walks the result end to end, so the first hit for "M10"
  is the line from terminus to terminus; the individual routes follow under a
  divider, since a branch or a short working is a real thing to want to see.
  The searched box has a floor of roughly 13 × 13 km for the same reason —
  sized to a line rather than to the viewport, so searching from a zoomed-in
  street view does not return a stub.

Rather than let unsupported calls fail, each provider declares what it supports
in `PROVIDERS` (`js/api.js`). `BvgApi.getCapabilities()` reports it, calls to an
unsupported endpoint are refused before a request goes out, and
`applyProviderCapabilities()` (`js/app.js`) hides the map controls that depend
on them. Departure boards, journey planning, station and place search and route
shapes work on every source.

### Station IDs are not portable

transport.rest uses bare numeric HAFAS IDs (`900120025`); MOTIS uses the source
dataset's ID behind a feed tag (`de-DELFI_de:11000:900120025`). A board saved
against one shows nothing at all against the other, so switching source
re-resolves each saved station by the name it was stored under
(`remapStationsForProvider()` in `js/app.js`). Names and walking times are kept;
only IDs change. A station with no counterpart is dropped and named in a
message rather than left in the list loading nothing.

This also runs at startup, so a `config.json` or a URL that names BVG IDs works
when pointed at another source.

### Using Transitous

Transitous is donated infrastructure. Its [usage
policy](https://transitous.org/api/) sets conditions this app already meets in
part, and one it cannot meet for you:

- **Attribution.** A link to `https://transitous.org/sources/` is shown in the
  footer whenever Transitous is the selected source — including inside a short
  embedded card, where the rest of the footer is hidden.
- **Polling.** Live vehicles poll every 30 s, and Transitous pins that value
  rather than inheriting the default, so raising the default later will not
  quietly speed it up. The policy asks you to get in touch before making many
  requests; if you run this on a wall display all day, do that.
- **Contact information.** A browser app cannot set a `User-Agent`, so the
  policy accepts the `Referer` header instead — on the condition that the site
  carries contact information. **If you deploy this with Transitous enabled,
  add a way to reach you** (a repository link or an email in the footer or
  README of your deployment). This repository does not add one for you.

Endpoints used:

| Endpoint | Used for |
|----------|----------|
| `/locations` | Station search |
| `/stops/:id` | Resolving names and coordinates for stations given by ID |
| `/stops/:id/departures` | The departure board |
| `/journeys` | Journey planner (with `polylines=true` for the map) |
| `/trips` | Finding a line by name (`lineName=M10&onlyCurrentlyRunning=true`) |
| `/trips/:id` | A single trip's route shape (`polyline=true`) |
| `/radar` | Live vehicle positions in the visible area |

The map polls `/radar` every 10s — one request per tick regardless of how many
vehicles are in view, which is what keeps the live map inside the rate limit.
Panning does not trigger a poll; the bounding box just follows the map and the
next scheduled tick picks up wherever you moved to. Trip routes are fetched on
demand (when you click a departure or look up a line), not for every row on the
board.

**Live vehicles follow what you are looking at.** With a line or a connection on
screen, only that line's vehicles are drawn — the whole city's traffic at once is
noise. With nothing shown, everything passes, subject to the product filter in
the map toolbar.

`/radar` caps a response at 256 vehicles. A wide view over central Berlin hits
that, and what comes back is then an arbitrary slice that differs poll to poll —
so the toolbar says *Ausschnitt* when the cap is reached. Zooming in narrows the
bounding box and gets you a complete picture of a smaller area.

A poll covers one bounding box — the map's own view widened by a quarter of its
span on each side, so vehicles just off the edge are already loaded and a small
pan does not blank them in. Scroll far enough that the view leaves that box and
a **Fahrzeuge hier laden** button appears over the map; the vehicles on screen
came from somewhere else, and without the offer an empty map reads as a bug
rather than a boundary.

The reload is a button rather than an automatic re-poll on every pan. Driving
the fetch from map movement is what previously made a single click fire several
requests, because a programmatic fit to a new route moves the map exactly as a
drag does.

It also clears the line focus. While a line or a connection is shown, live
vehicles are narrowed to it — so somewhere that line does not run, a reload
would fetch a full response and draw none of it. The route stays on the map;
the narrowing does not.

### Line colours

They live in one place: `.line-tint` in `css/styles.css`. Seven product
families plus every individual U-Bahn and S-Bahn line, taken from BVG's own
palette and held one step back from full saturation so a full board does not
turn into a colour chart.

The map reads that same rule rather than keeping a table of its own — a probe
element is given the badge's classes and its computed background is read back
(`TransitMap.lineColor`). A second table is what made a U5 brown on the board
and blue on the map. Change the CSS and the badge, the journey chip, the drawn
route and the live vehicle labels all follow.

A line with no rule of its own falls back to its product's colour, and an
unknown product to a neutral grey.

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
| Can't find "Abfahrtsmonitor" AP | Reflash; hold BOOT during upload |
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
