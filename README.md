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
├── index.html      # Main page
├── css/
│   └── styles.css  # Themes & layout
├── js/
│   ├── api.js      # BVG REST API wrapper
│   └── app.js      # Application logic & UI
└── README.md
```

## API

Uses the public [v6.bvg.transport.rest](https://v6.bvg.transport.rest/) API:
- No API key required
- Rate limit: 100 requests/minute
- CORS enabled (works directly from browser)

## Future: ESP32 Hardware Version

This web simulator is designed so the logic can be ported to an ESP32 with a TFT display. The ESP32 version would:
- Connect to WiFi
- Fetch the same BVG API endpoints
- Render on a 320x240 or similar TFT/OLED display
- Use a captive portal for initial WiFi + station configuration

## License

MIT
