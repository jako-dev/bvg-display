# BVG Abfahrtsmonitor

A real-time departure display for Berlin public transport (BVG/VBB), inspired by [T-Skylt](https://shop.t-skylt.se/products/t-skylt-x-silver-metallic).

## Quick Start

```bash
cd bvg-display
python3 -m http.server 8080
```

Then open **http://localhost:8080** in your browser.

Alternatively, just open `index.html` directly in your browser (works thanks to CORS-enabled BVG API).

## Features

- **Real-time departures** from any BVG/VBB station in Berlin & Brandenburg
- **Station search** — find and save multiple stations
- **Transport type filters** — show/hide S-Bahn, U-Bahn, Tram, Bus, Ferry, IC/ICE, Regional
- **Delay highlighting** — delays shown in red, on-time in green, cancelled struck through
- **Service alerts** — disruption warnings displayed as banner
- **Platform info** — shows platform/position when available
- **Two visual themes**:
  - Classic Dark (authentic BVG/DB departure board look)
  - Modern Minimal (Catppuccin-inspired dark theme)
- **Auto-refresh** — configurable interval (10–120 seconds)
- **Persistent settings** — stations and preferences saved in localStorage

## Usage

1. Click the ⚙ gear icon to open settings
2. Search for a station (e.g. "Alexanderplatz", "Kottbusser Tor")
3. Click a result to add it
4. Departures will load automatically
5. Add multiple stations and switch between them via tabs

## Architecture

```
bvg-display/
├── index.html          # Main page
├── css/
│   └── styles.css      # Themes & layout
├── js/
│   ├── api.js          # BVG REST API wrapper
│   ├── app.js          # Application logic & UI
│   └── led-renderer.js # Canvas LED panel emulator
└── esp32/
    ├── platformio.ini  # PlatformIO project config
    └── src/
        ├── main.cpp    # Firmware entry point
        ├── config.h    # Pin mappings & constants
        ├── font.h      # 4x7 bitmap font
        └── web_portal.h # Embedded config web UI
```

## API

Uses the public [v6.bvg.transport.rest](https://v6.bvg.transport.rest/) API:
- No API key required
- Rate limit: 100 requests/minute
- CORS enabled (works directly from browser)

---

## ESP32 Hardware Version

The `esp32/` directory contains firmware for running the departure display on real LED matrix hardware.

### Components

| Component | Description | Notes |
|-----------|-------------|-------|
| ESP32 DevKit V1 (30-pin) | Microcontroller | Any ESP32-WROOM-32 board works |
| HUB75 LED Matrix Panel 64×32 | RGB LED panel (P3 or P4 pitch) | ×2 panels chained for 128×32 |
| 5V Power Supply (≥4A) | Panel power | Each 64×32 panel draws up to 2A at full white |
| Jumper wires / ribbon cable | HUB75 connection | Female-to-female dupont or IDC ribbon |
| USB cable (micro-USB or USB-C) | For flashing & serial | Depends on your ESP32 board |

### Wiring Diagram

Connect the ESP32 to the **input** HUB75 connector on the first panel. Chain the second panel via the output connector of the first.

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

> **Note:** Pin E is unused (`-1`) for standard 32-row panels. If using a 64-row panel, assign E to a free GPIO in `config.h`.

**Power wiring:**
- Connect the 5V PSU directly to the panel's power terminals (the screw terminals or power connector on the panel PCB).
- Connect ESP32 `VIN` to 5V and `GND` to the shared ground.
- **Do not power the panels from the ESP32's 5V pin** — the panels draw too much current.

```
5V PSU ─────┬──► Panel 1 (5V / GND)
            ├──► Panel 2 (5V / GND)
            └──► ESP32 VIN / GND
```

### Prerequisites

1. **PlatformIO** — Install via VS Code extension ("PlatformIO IDE") or CLI:
   ```bash
   pip install platformio
   ```

2. **USB driver** — Install the CP2102 or CH340 driver if your OS doesn't recognize the ESP32 board.

### Flashing the Firmware

```bash
cd esp32

# Build the firmware
pio run

# Upload to the ESP32 (connect via USB first)
pio run --target upload

# (Optional) Monitor serial output
pio device monitor --baud 115200
```

Or as a single command:
```bash
cd esp32 && pio run --target upload && pio device monitor --baud 115200
```

### First-Time Setup

1. After flashing, the ESP32 creates a WiFi access point named **"BVG-Display"** (open, no password).
2. Connect to it with your phone or laptop.
3. A captive portal opens automatically (or navigate to `192.168.4.1`).
4. Enter your home WiFi credentials and click **Verbinden**.
5. Once connected, the portal shows the device's IP on your local network.
6. Search for a station (e.g. "Alexanderplatz") and add it.
7. The LED matrix will begin showing departures within seconds.

After setup, the config portal remains accessible at the device's local IP address.

### Configuration

All settings can be adjusted in `esp32/src/config.h`:

| Setting | Default | Description |
|---------|---------|-------------|
| `PANEL_WIDTH` | 64 | Width of a single panel |
| `PANELS_NUMBER` | 2 | Number of chained panels |
| `BVG_REFRESH_INTERVAL` | 30000 | API poll interval (ms) |
| `BVG_DEPARTURE_DURATION` | 30 | Minutes to look ahead |
| `MAX_STATIONS` | 5 | Max saved stations |
| `SCROLL_SPEED` | 50 | Scroll step interval (ms) |

Departure count is configurable at runtime via the web portal (3–15).

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Panel stays dark | Check 5V power to panel; verify GND is shared with ESP32 |
| Garbled/flickering display | Double-check all HUB75 wiring; ensure no loose jumper wires |
| Can't find "BVG-Display" AP | Re-flash; hold BOOT button during upload if needed |
| Upload fails | Hold BOOT button on ESP32 when upload starts; try lower `upload_speed` in `platformio.ini` |
| No departures shown | Check serial monitor for WiFi/API errors; BVG API may be temporarily down (503) |

## License

MIT
