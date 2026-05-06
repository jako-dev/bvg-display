/**
 * BVG Departure Display - ESP32 Firmware
 * 
 * Features:
 * - HUB75 LED Matrix (128x32) via DMA
 * - WiFi captive portal for initial setup
 * - Web interface for station configuration
 * - Real-time BVG departure data
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESPAsyncWebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

#include "config.h"
#include "font.h"
#include "web_portal.h"

// ===== Globals =====
MatrixPanel_I2S_DMA* matrix = nullptr;
AsyncWebServer server(80);
DNSServer dnsServer;
Preferences prefs;

// State
enum AppMode { MODE_AP_SETUP, MODE_RUNNING };
AppMode appMode = MODE_AP_SETUP;

struct Station {
    String id;
    String name;
};

struct Departure {
    String lineName;
    String direction;
    String product;
    int minutesUntil;
    int delaySeconds;
    bool cancelled;
};

Station stations[MAX_STATIONS];
int stationCount = 0;
int activeStationIdx = 0;
Departure departures[BVG_MAX_DEPARTURES];
int departureCount = 0;
int depCountSetting = 6;

String wifiSSID = "";
String wifiPassword = "";
unsigned long lastFetchTime = 0;
unsigned long lastScrollTime = 0;
int scrollOffset = 0;

// ===== Forward Declarations =====
void setupMatrix();
void setupAP();
void setupWebServer();
void connectWiFi();
void fetchDepartures();
void renderDisplay();
void renderSetupScreen();
void loadSettings();
void saveSettings();
uint16_t getLineColor(const String& product, const String& lineName);

// ===== Setup =====
void setup() {
    Serial.begin(115200);
    Serial.println("\n=== BVG Display Starting ===");

    setupMatrix();
    loadSettings();

    if (wifiSSID.length() > 0) {
        // Try connecting to saved WiFi
        renderTextCentered("Verbinde...", matrix->color565(255, 204, 0));
        connectWiFi();
    }

    if (WiFi.status() != WL_CONNECTED) {
        // Start AP mode for configuration
        appMode = MODE_AP_SETUP;
        setupAP();
    } else {
        appMode = MODE_RUNNING;
    }

    setupWebServer();
    Serial.println("Setup complete. Mode: " + String(appMode == MODE_AP_SETUP ? "AP Setup" : "Running"));
}

// ===== Loop =====
void loop() {
    if (appMode == MODE_AP_SETUP) {
        dnsServer.processNextRequest();
        renderSetupScreen();
        delay(100);
        return;
    }

    // Running mode
    unsigned long now = millis();

    // Fetch departures periodically
    if (now - lastFetchTime >= BVG_REFRESH_INTERVAL || lastFetchTime == 0) {
        fetchDepartures();
        lastFetchTime = now;
    }

    // Scroll display
    if (now - lastScrollTime >= SCROLL_SPEED) {
        renderDisplay();
        lastScrollTime = now;
    }

    delay(10);
}

// ===== Matrix Setup =====
void setupMatrix() {
    HUB75_I2S_CFG mxconfig(PANEL_WIDTH, PANEL_HEIGHT, PANELS_NUMBER);
    
    mxconfig.gpio.r1 = R1_PIN;
    mxconfig.gpio.g1 = G1_PIN;
    mxconfig.gpio.b1 = B1_PIN;
    mxconfig.gpio.r2 = R2_PIN;
    mxconfig.gpio.g2 = G2_PIN;
    mxconfig.gpio.b2 = B2_PIN;
    mxconfig.gpio.a = A_PIN;
    mxconfig.gpio.b = B_PIN;
    mxconfig.gpio.c = C_PIN;
    mxconfig.gpio.d = D_PIN;
    mxconfig.gpio.e = E_PIN;
    mxconfig.gpio.lat = LAT_PIN;
    mxconfig.gpio.oe = OE_PIN;
    mxconfig.gpio.clk = CLK_PIN;

    mxconfig.clkphase = false;
    mxconfig.driver = HUB75_I2S_CFG::FM6126A;

    matrix = new MatrixPanel_I2S_DMA(mxconfig);
    matrix->begin();
    matrix->setBrightness8(80);
    matrix->clearScreen();
}

// ===== WiFi =====
void setupAP() {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    
    // Start DNS server for captive portal (redirect all to us)
    dnsServer.start(53, "*", WiFi.softAPIP());
    
    Serial.print("AP started. IP: ");
    Serial.println(WiFi.softAPIP());
}

void connectWiFi() {
    WiFi.mode(WIFI_STA);
    WiFi.begin(wifiSSID.c_str(), wifiPassword.c_str());
    
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT) {
        delay(250);
        Serial.print(".");
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
    } else {
        Serial.println("\nWiFi connection failed");
        WiFi.disconnect();
    }
}

// ===== Web Server =====
void setupWebServer() {
    // Serve the configuration page
    server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->send(200, "text/html", getPortalHTML());
    });

    // Captive portal detection endpoints
    server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->redirect("/");
    });
    server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->redirect("/");
    });
    server.on("/fwlink", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->redirect("/");
    });

    // API: Get current status
    server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest* request) {
        JsonDocument doc;
        doc["mode"] = (appMode == MODE_AP_SETUP) ? "setup" : "running";
        doc["wifi_connected"] = (WiFi.status() == WL_CONNECTED);
        doc["wifi_ssid"] = wifiSSID;
        doc["ip"] = WiFi.localIP().toString();
        doc["station_count"] = stationCount;
        doc["departure_count"] = departureCount;
        
        JsonArray stArr = doc["stations"].to<JsonArray>();
        for (int i = 0; i < stationCount; i++) {
            JsonObject st = stArr.add<JsonObject>();
            st["id"] = stations[i].id;
            st["name"] = stations[i].name;
        }

        String response;
        serializeJson(doc, response);
        request->send(200, "application/json", response);
    });

    // API: Save WiFi credentials
    server.on("/api/wifi", HTTP_POST, [](AsyncWebServerRequest* request) {
        if (request->hasParam("ssid", true) && request->hasParam("password", true)) {
            wifiSSID = request->getParam("ssid", true)->value();
            wifiPassword = request->getParam("password", true)->value();
            saveSettings();
            request->send(200, "application/json", "{\"ok\":true,\"msg\":\"WiFi saved. Restarting...\"}");
            delay(1000);
            ESP.restart();
        } else {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Missing ssid or password\"}");
        }
    });

    // API: Scan WiFi networks
    server.on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest* request) {
        int n = WiFi.scanNetworks();
        JsonDocument doc;
        JsonArray networks = doc["networks"].to<JsonArray>();
        for (int i = 0; i < n && i < 20; i++) {
            JsonObject net = networks.add<JsonObject>();
            net["ssid"] = WiFi.SSID(i);
            net["rssi"] = WiFi.RSSI(i);
            net["encrypted"] = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
        }
        WiFi.scanDelete();
        String response;
        serializeJson(doc, response);
        request->send(200, "application/json", response);
    });

    // API: Search BVG stations (proxy to avoid CORS on ESP)
    server.on("/api/stations/search", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (!request->hasParam("q")) {
            request->send(400, "application/json", "{\"error\":\"Missing q param\"}");
            return;
        }
        String query = request->getParam("q")->value();
        
        HTTPClient http;
        String url = "https://" + String(BVG_API_HOST) + "/locations?query=" + 
                     urlEncode(query) + "&results=5&stops=true&addresses=false&poi=false&pretty=false";
        http.begin(url);
        int httpCode = http.GET();
        
        if (httpCode == 200) {
            request->send(200, "application/json", http.getString());
        } else {
            request->send(502, "application/json", "{\"error\":\"API request failed\"}");
        }
        http.end();
    });

    // API: Add station
    server.on("/api/stations", HTTP_POST, [](AsyncWebServerRequest* request) {
        if (request->hasParam("id", true) && request->hasParam("name", true)) {
            if (stationCount >= MAX_STATIONS) {
                request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Max stations reached\"}");
                return;
            }
            String id = request->getParam("id", true)->value();
            // Check for duplicate
            for (int i = 0; i < stationCount; i++) {
                if (stations[i].id == id) {
                    request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Already added\"}");
                    return;
                }
            }
            stations[stationCount].id = id;
            stations[stationCount].name = request->getParam("name", true)->value();
            stationCount++;
            saveSettings();
            lastFetchTime = 0; // Trigger immediate refresh
            request->send(200, "application/json", "{\"ok\":true}");
        } else {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Missing id or name\"}");
        }
    });

    // API: Remove station
    server.on("/api/stations/remove", HTTP_POST, [](AsyncWebServerRequest* request) {
        if (request->hasParam("id", true)) {
            String id = request->getParam("id", true)->value();
            int found = -1;
            for (int i = 0; i < stationCount; i++) {
                if (stations[i].id == id) { found = i; break; }
            }
            if (found >= 0) {
                for (int i = found; i < stationCount - 1; i++) {
                    stations[i] = stations[i + 1];
                }
                stationCount--;
                if (activeStationIdx >= stationCount) activeStationIdx = 0;
                saveSettings();
                request->send(200, "application/json", "{\"ok\":true}");
            } else {
                request->send(404, "application/json", "{\"ok\":false,\"msg\":\"Not found\"}");
            }
        }
    });

    // Settings GET
    server.on("/api/settings", HTTP_GET, [](AsyncWebServerRequest* request) {
        String json = "{\"dep_count\":" + String(depCountSetting) + "}";
        request->send(200, "application/json", json);
    });

    // Settings POST
    server.on("/api/settings", HTTP_POST, [](AsyncWebServerRequest* request) {
        if (request->hasParam("dep_count", true)) {
            int val = request->getParam("dep_count", true)->value().toInt();
            if (val >= 1 && val <= 15) {
                depCountSetting = val;
                saveSettings();
                request->send(200, "application/json", "{\"ok\":true}");
            } else {
                request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Invalid value\"}");
            }
        } else {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Missing dep_count\"}");
        }
    });

    // Catch-all for captive portal
    server.onNotFound([](AsyncWebServerRequest* request) {
        request->redirect("/");
    });

    server.begin();
    Serial.println("Web server started");
}

// ===== BVG API =====
void fetchDepartures() {
    if (WiFi.status() != WL_CONNECTED || stationCount == 0) return;
    
    String stationId = stations[activeStationIdx].id;
    String url = "https://" + String(BVG_API_HOST) + "/stops/" + stationId + 
                 "/departures?duration=" + String(BVG_DEPARTURE_DURATION) + 
                 "&results=" + String(depCountSetting) + "&pretty=false&language=de";

    HTTPClient http;
    http.begin(url);
    http.setTimeout(10000);
    int httpCode = http.GET();

    if (httpCode == 200) {
        String payload = http.getString();
        parseDepartures(payload);
        scrollOffset = 0;
        Serial.println("Fetched " + String(departureCount) + " departures");
    } else {
        Serial.println("API error: " + String(httpCode));
    }
    http.end();

    // Cycle through stations on each fetch
    if (stationCount > 1) {
        activeStationIdx = (activeStationIdx + 1) % stationCount;
    }
}

void parseDepartures(const String& json) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, json);
    if (err) {
        Serial.println("JSON parse error: " + String(err.c_str()));
        return;
    }

    JsonArray deps = doc["departures"].as<JsonArray>();
    departureCount = 0;

    for (JsonObject dep : deps) {
        if (departureCount >= BVG_MAX_DEPARTURES) break;

        Departure& d = departures[departureCount];
        d.lineName = dep["line"]["name"].as<String>();
        d.direction = dep["direction"].as<String>();
        d.product = dep["line"]["product"].as<String>();
        d.cancelled = dep["cancelled"] | false;
        d.delaySeconds = dep["delay"] | 0;

        // Calculate minutes until departure
        const char* whenStr = dep["when"] | dep["plannedWhen"];
        if (whenStr) {
            // Parse ISO time — simplified: use the offset from 'when'
            // The API returns times like "2026-05-06T13:09:00+02:00"
            struct tm tm = {};
            int tzHour = 0, tzMin = 0;
            char tzSign = '+';
            sscanf(whenStr, "%d-%d-%dT%d:%d:%d%c%d:%d",
                   &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
                   &tm.tm_hour, &tm.tm_min, &tm.tm_sec,
                   &tzSign, &tzHour, &tzMin);
            tm.tm_year -= 1900;
            tm.tm_mon -= 1;
            
            time_t depTime = mktime(&tm);
            // Adjust for timezone
            int tzOffset = (tzHour * 3600 + tzMin * 60) * (tzSign == '+' ? -1 : 1);
            depTime += tzOffset;
            
            time_t now;
            time(&now);
            d.minutesUntil = (int)((depTime - now) / 60);
            if (d.minutesUntil < 0) d.minutesUntil = 0;
        } else {
            d.minutesUntil = -1;
        }

        departureCount++;
    }
}

// ===== Display Rendering =====
void renderDisplay() {
    matrix->clearScreen();

    if (departureCount == 0) {
        renderTextCentered("Warte auf Daten...", matrix->color565(255, 204, 0));
        return;
    }

    // Render up to DISPLAY_ROWS departures
    int rowHeight = 10;
    for (int i = 0; i < DISPLAY_ROWS && i < departureCount; i++) {
        int depIdx = (scrollOffset + i) % departureCount;
        renderDepartureRow(departures[depIdx], i * rowHeight + 1);
    }

    // Advance scroll every N frames if more departures than rows
    static int frameCount = 0;
    frameCount++;
    if (frameCount >= 60 && departureCount > DISPLAY_ROWS) { // ~3 seconds at 50ms
        scrollOffset = (scrollOffset + 1) % departureCount;
        frameCount = 0;
    }
}

void renderDepartureRow(const Departure& dep, int y) {
    uint16_t lineColor = getLineColor(dep.product, dep.lineName);
    uint16_t white = matrix->color565(255, 255, 255);
    uint16_t yellow = matrix->color565(255, 204, 0);
    uint16_t red = matrix->color565(255, 0, 0);
    uint16_t green = matrix->color565(0, 255, 0);

    // Line badge background
    int badgeWidth = dep.lineName.length() * 5 + 2;
    matrix->fillRect(0, y, badgeWidth, 8, lineColor);

    // Line name
    uint16_t textColor = white;
    drawString(matrix, dep.lineName.c_str(), 1, y + 1, textColor);

    // Direction (truncated)
    int destX = badgeWidth + 2;
    String truncDir = dep.direction.substring(0, 14);
    uint16_t destColor = dep.cancelled ? matrix->color565(100, 100, 100) : white;
    drawString(matrix, truncDir.c_str(), destX, y + 1, destColor);

    // Time
    String timeStr;
    uint16_t timeColor;
    if (dep.cancelled) {
        timeStr = "X";
        timeColor = red;
    } else if (dep.minutesUntil <= 0) {
        timeStr = "jetzt";
        timeColor = green;
    } else if (dep.minutesUntil < 60) {
        timeStr = String(dep.minutesUntil) + "'";
        timeColor = (dep.delaySeconds > 120) ? red : yellow;
    } else {
        timeStr = String(dep.minutesUntil / 60) + "h";
        timeColor = yellow;
    }

    int timeWidth = measureString(timeStr.c_str());
    drawString(matrix, timeStr.c_str(), MATRIX_WIDTH - timeWidth - 1, y + 1, timeColor);
}

void renderTextCentered(const char* text, uint16_t color) {
    int w = measureString(text);
    int x = (MATRIX_WIDTH - w) / 2;
    int y = (MATRIX_HEIGHT - 7) / 2;
    drawString(matrix, text, x, y, color);
}

void renderSetupScreen() {
    static unsigned long lastBlink = 0;
    static bool showIP = true;
    
    matrix->clearScreen();
    
    uint16_t yellow = matrix->color565(255, 204, 0);
    uint16_t cyan = matrix->color565(0, 200, 255);
    
    drawString(matrix, "BVG Display", 20, 2, yellow);
    
    if (millis() - lastBlink > 2000) {
        showIP = !showIP;
        lastBlink = millis();
    }
    
    if (showIP) {
        String ip = WiFi.softAPIP().toString();
        drawString(matrix, ip.c_str(), 10, 14, cyan);
    } else {
        drawString(matrix, "WiFi: BVG-Display", 2, 14, cyan);
    }
    
    drawString(matrix, "Setup via Browser", 5, 24, matrix->color565(150, 150, 150));
}

// ===== Line Colors =====
uint16_t getLineColor(const String& product, const String& lineName) {
    String name = lineName;
    name.toLowerCase();
    
    // Specific U-Bahn colors
    if (name == "u1") return matrix->color565(125, 173, 76);
    if (name == "u2") return matrix->color565(218, 66, 30);
    if (name == "u3") return matrix->color565(0, 122, 91);
    if (name == "u4") return matrix->color565(240, 215, 34);
    if (name == "u5") return matrix->color565(126, 83, 48);
    if (name == "u6") return matrix->color565(140, 109, 171);
    if (name == "u7") return matrix->color565(82, 141, 186);
    if (name == "u8") return matrix->color565(34, 79, 134);
    if (name == "u9") return matrix->color565(243, 121, 29);
    
    // Specific S-Bahn colors
    if (name == "s1") return matrix->color565(222, 77, 164);
    if (name == "s2" || name == "s25" || name == "s26") return matrix->color565(0, 95, 39);
    if (name == "s3") return matrix->color565(0, 96, 170);
    if (name == "s41") return matrix->color565(162, 59, 30);
    if (name == "s42") return matrix->color565(194, 106, 55);
    if (name == "s5") return matrix->color565(255, 89, 0);
    if (name == "s7" || name == "s75") return matrix->color565(119, 96, 176);
    if (name == "s8" || name == "s85") return matrix->color565(85, 168, 34);
    if (name == "s9") return matrix->color565(139, 28, 98);
    
    // Generic product colors
    if (product == "suburban") return matrix->color565(0, 141, 79);
    if (product == "subway") return matrix->color565(0, 96, 170);
    if (product == "tram") return matrix->color565(190, 20, 20);
    if (product == "bus") return matrix->color565(155, 39, 144);
    if (product == "ferry") return matrix->color565(0, 137, 180);
    if (product == "express") return matrix->color565(100, 100, 100);
    if (product == "regional") return matrix->color565(227, 6, 19);
    
    return matrix->color565(255, 204, 0); // default yellow
}

// ===== Settings Persistence =====
void loadSettings() {
    prefs.begin(PREFS_NAMESPACE, true);
    wifiSSID = prefs.getString("ssid", "");
    wifiPassword = prefs.getString("pass", "");
    stationCount = prefs.getInt("stCount", 0);
    
    depCountSetting = prefs.getInt("depCount", 6);
    
    for (int i = 0; i < stationCount && i < MAX_STATIONS; i++) {
        stations[i].id = prefs.getString(("st_id_" + String(i)).c_str(), "");
        stations[i].name = prefs.getString(("st_nm_" + String(i)).c_str(), "");
    }
    prefs.end();
    
    Serial.println("Loaded " + String(stationCount) + " stations, SSID: " + wifiSSID);
}

void saveSettings() {
    prefs.begin(PREFS_NAMESPACE, false);
    prefs.putString("ssid", wifiSSID);
    prefs.putString("pass", wifiPassword);
    prefs.putInt("stCount", stationCount);
    prefs.putInt("depCount", depCountSetting);
    
    for (int i = 0; i < stationCount; i++) {
        prefs.putString(("st_id_" + String(i)).c_str(), stations[i].id);
        prefs.putString(("st_nm_" + String(i)).c_str(), stations[i].name);
    }
    prefs.end();
}

// ===== Utility =====
String urlEncode(const String& str) {
    String encoded = "";
    for (unsigned int i = 0; i < str.length(); i++) {
        char c = str[i];
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded += c;
        } else {
            char buf[4];
            snprintf(buf, sizeof(buf), "%%%02X", (unsigned char)c);
            encoded += buf;
        }
    }
    return encoded;
}
