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
- **Views**: Single, Split (two stations side-by-side), LED emulator
- **Themes**: Classic Dark, Modern (Catppuccin)
- **Kiosk mode** — fullscreen for wall-mounted tablets
- **Auto-refresh** — configurable interval (10–120s)
- **Data source selector** — BVG or VBB
- **Offline-capable** — all settings persisted in localStorage

### Quick Start

Open the [live version](https://jako-dev.github.io/bvg-display/) or run locally:

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

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
| Factory reset | Wipe all settings |

---

## Project Structure

```
bvg-display/
├── index.html              # Web app entry
├── css/styles.css          # Themes & layout
├── js/
│   ├── api.js              # Transport REST API wrapper
│   ├── app.js              # Application logic
│   └── led-renderer.js     # Canvas LED panel emulator
├── esp32/
│   ├── platformio.ini      # PlatformIO config
│   └── src/
│       ├── main.cpp        # Firmware (WiFi, API, LED, web server, OTA)
│       ├── config.h        # Pin mappings & constants
│       ├── font.h          # 4×7 bitmap font
│       └── web_portal.h    # Embedded config web UI
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

The ESP32 config page has **no authentication**. Anyone who can reach the device
on your network can change its settings, trigger a factory reset, or flash new
firmware. Keep it on a trusted LAN (or a separate IoT VLAN) and do not expose
port 80 to the internet.

WiFi credentials are stored in the ESP32's NVS partition in plain text, which is
readable by anyone with physical access and a serial cable.

## License

MIT
