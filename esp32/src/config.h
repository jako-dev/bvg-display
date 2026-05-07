#pragma once

// ===== LED Matrix Configuration =====
// HUB75 128x32 panel (2x 64x32 chained, or 1x 128x32)
#define PANEL_WIDTH 64
#define PANEL_HEIGHT 32
#define PANELS_NUMBER 2  // Number of panels chained
#define MATRIX_WIDTH (PANEL_WIDTH * PANELS_NUMBER)  // 128
#define MATRIX_HEIGHT PANEL_HEIGHT                    // 32

// HUB75 Pin Mapping (ESP32 default)
#define R1_PIN 25
#define G1_PIN 26
#define B1_PIN 27
#define R2_PIN 14
#define G2_PIN 12
#define B2_PIN 13
#define A_PIN  23
#define B_PIN  19
#define C_PIN  5
#define D_PIN  17
#define E_PIN  -1  // For 32-row panels, E is not needed
#define LAT_PIN 4
#define OE_PIN  15
#define CLK_PIN 16

// ===== WiFi Configuration =====
#define AP_SSID "BVG-Display"
#define AP_PASSWORD ""  // Open AP for setup
#define WIFI_CONNECT_TIMEOUT 15000  // ms

// ===== BVG API =====
// Default API host (can be changed at runtime)
#define BVG_API_HOST_DEFAULT "v6.bvg.transport.rest"
#define BVG_DEPARTURE_DURATION 30  // minutes to look ahead
#define BVG_MAX_DEPARTURES 30
#define BVG_REFRESH_INTERVAL 30000  // ms between API calls

// ===== Display Settings =====
#define SCROLL_SPEED 50           // ms between scroll steps
#define MAX_STATIONS 5            // Max saved stations
#define DISPLAY_ROWS 3            // Rows visible at once on 32px height

// ===== EEPROM/Preferences =====
#define PREFS_NAMESPACE "bvg"

// ===== Firmware / OTA =====
#define FW_VERSION "1.0.0"
#define GITHUB_OWNER "jako-dev"
#define GITHUB_REPO "bvg-display"
// GitHub API endpoint for latest release
#define GITHUB_RELEASE_URL "https://api.github.com/repos/" GITHUB_OWNER "/" GITHUB_REPO "/releases/latest"
// Expected firmware asset filename in the release
#define FW_ASSET_NAME "bvg-display.bin"
