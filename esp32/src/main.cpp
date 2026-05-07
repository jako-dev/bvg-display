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
#include <Update.h>
#include <esp_ota_ops.h>
#include <esp_task_wdt.h>
#include <ESPmDNS.h>

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
    int walkTime;  // Minutes to walk to this station
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
bool scrollEnabled = false;       // Scroll disabled by default: show first 3
int scrollSpeedSetting = 3000;    // ms between scroll steps

String wifiSSID = "";
String wifiPassword = "";
unsigned long lastFetchTime = 0;

// Sleep mode
bool sleepEnabled = false;
int sleepStartHour = 22;  // 0-23
int sleepEndHour = 6;     // 0-23
bool displaySleeping = false;

// Brightness
int brightnessSetting = 80;  // 0-255

// API provider
String apiHost = BVG_API_HOST_DEFAULT;

// Stale data tracking
unsigned long lastSuccessfulFetch = 0;  // millis() of last successful API response
#define STALE_DATA_THRESHOLD 300000     // 5 minutes in ms

// Factory reset button
#define RESET_BUTTON_PIN 0  // BOOT button on most ESP32 dev boards
#define RESET_HOLD_TIME 5000  // Hold 5 seconds to factory reset

unsigned long lastScrollTime = 0;
unsigned long lastWifiCheck = 0;
int scrollOffset = 0;
bool ntpSynced = false;

// ===== Forward Declarations =====
void setupMatrix();
void setupAP();
void setupWebServer();
void connectWiFi();
void checkWiFiReconnect();
void syncNTP();
void fetchDepartures();
void parseDeparturesAppend(const String& json);
void sortDepartures();
void renderDisplay();
void renderSetupScreen();
void renderTextCentered(const char* text, uint16_t color);
void loadSettings();
void saveSettings();
void factoryReset();
uint16_t getLineColor(const String& product, const String& lineName);

// ===== Setup =====
void setup() {
    Serial.begin(115200);
    Serial.println("\n=== BVG Display Starting ===");

    // Factory reset button (BOOT pin)
    pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);

    setupMatrix();
    loadSettings();
    matrix->setBrightness8(brightnessSetting);

    if (wifiSSID.length() > 0) {
        // Try connecting to saved WiFi
        renderTextCentered("Verbinde...", matrix->color565(255, 204, 0));
        connectWiFi();
    }

    if (WiFi.status() != WL_CONNECTED) {
        // Check if this is an OTA update that can't connect — rollback
        const esp_partition_t* running = esp_ota_get_running_partition();
        esp_ota_img_states_t ota_state;
        if (esp_ota_get_state_partition(running, &ota_state) == ESP_OK) {
            if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
                Serial.println("[OTA] WiFi failed after update — rolling back!");
                esp_ota_mark_app_invalid_rollback_and_reboot();
                // Does not return
            }
        }
        // Normal case: start AP mode for configuration
        appMode = MODE_AP_SETUP;
        setupAP();
    } else {
        appMode = MODE_RUNNING;
        // Mark firmware as valid (confirms OTA if pending)
        esp_ota_mark_app_valid_cancel_rollback();
        Serial.println("[OTA] Firmware confirmed valid");
        syncNTP();

        // Start mDNS
        if (MDNS.begin("bvg-display")) {
            MDNS.addService("http", "tcp", 80);
            Serial.println("[mDNS] http://bvg-display.local");
        }
    }

    setupWebServer();

    // Enable hardware watchdog (60 second timeout)
    esp_task_wdt_init(60, true);
    esp_task_wdt_add(NULL);

    Serial.println("Setup complete. Mode: " + String(appMode == MODE_AP_SETUP ? "AP Setup" : "Running"));
}

// ===== Loop =====
void loop() {
    // Feed watchdog
    esp_task_wdt_reset();

    // Check factory reset button (BOOT button held for 5 seconds)
    static unsigned long resetBtnStart = 0;
    if (digitalRead(RESET_BUTTON_PIN) == LOW) {
        if (resetBtnStart == 0) resetBtnStart = millis();
        if (millis() - resetBtnStart >= RESET_HOLD_TIME) {
            factoryReset();
        }
    } else {
        resetBtnStart = 0;
    }

    if (appMode == MODE_AP_SETUP) {
        dnsServer.processNextRequest();
        renderSetupScreen();
        delay(100);
        return;
    }

    // Running mode
    unsigned long now = millis();

    // Check WiFi connectivity every 30s
    if (now - lastWifiCheck >= 30000) {
        checkWiFiReconnect();
        lastWifiCheck = now;
    }

    // Check sleep mode
    if (sleepEnabled && ntpSynced) {
        struct tm timeinfo;
        if (getLocalTime(&timeinfo)) {
            int h = timeinfo.tm_hour;
            bool shouldSleep;
            if (sleepStartHour <= sleepEndHour) {
                // e.g. 8-17 (sleep during the day)
                shouldSleep = (h >= sleepStartHour && h < sleepEndHour);
            } else {
                // e.g. 22-6 (sleep overnight, typical)
                shouldSleep = (h >= sleepStartHour || h < sleepEndHour);
            }
            if (shouldSleep && !displaySleeping) {
                displaySleeping = true;
                matrix->clearScreen();
                Serial.println("[Sleep] Display off");
            } else if (!shouldSleep && displaySleeping) {
                displaySleeping = false;
                lastFetchTime = 0; // Trigger immediate refresh on wake
                Serial.println("[Sleep] Display on");
            }
        }
    } else if (!sleepEnabled && displaySleeping) {
        displaySleeping = false;
        lastFetchTime = 0;
    }

    // Skip fetch and render while sleeping
    if (displaySleeping) {
        delay(1000);
        return;
    }

    // Fetch departures periodically
    if (now - lastFetchTime >= BVG_REFRESH_INTERVAL || lastFetchTime == 0) {
        if (WiFi.status() == WL_CONNECTED && ntpSynced) {
            fetchDepartures();
        }
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
    matrix->setBrightness8(80);  // Default, overridden after loadSettings()
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
    WiFi.setAutoReconnect(true);
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

void checkWiFiReconnect() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi lost, reconnecting...");
        WiFi.disconnect();
        WiFi.begin(wifiSSID.c_str(), wifiPassword.c_str());
        unsigned long start = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - start < 5000) {
            delay(100);
        }
        if (WiFi.status() == WL_CONNECTED) {
            Serial.println("WiFi reconnected: " + WiFi.localIP().toString());
        }
    }
}

void syncNTP() {
    configTzTime("CET-1CEST,M3.5.0,M10.5.0/3", "pool.ntp.org", "time.nist.gov");
    Serial.print("Syncing NTP");
    int attempts = 0;
    struct tm timeinfo;
    while (!getLocalTime(&timeinfo) && attempts < 10) {
        Serial.print(".");
        delay(500);
        attempts++;
    }
    if (attempts < 10) {
        ntpSynced = true;
        Serial.println(" OK");
    } else {
        ntpSynced = true; // Allow operation with potentially wrong time
        Serial.println(" TIMEOUT (proceeding anyway)");
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
        doc["hostname"] = "bvg-display.local";
        doc["station_count"] = stationCount;
        doc["departure_count"] = departureCount;
        doc["uptime_seconds"] = millis() / 1000;
        doc["data_stale"] = (lastSuccessfulFetch > 0 && millis() - lastSuccessfulFetch > STALE_DATA_THRESHOLD);
        doc["free_heap"] = ESP.getFreeHeap();
        
        JsonArray stArr = doc["stations"].to<JsonArray>();
        for (int i = 0; i < stationCount; i++) {
            JsonObject st = stArr.add<JsonObject>();
            st["id"] = stations[i].id;
            st["name"] = stations[i].name;
            st["walk_time"] = stations[i].walkTime;
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
        if (WiFi.status() != WL_CONNECTED) {
            request->send(503, "application/json", "{\"error\":\"WiFi not connected\"}");
            return;
        }
        String query = request->getParam("q")->value();
        
        HTTPClient http;
        String url = "https://" + apiHost + "/locations?query=" + 
                     urlEncode(query) + "&results=5&stops=true&addresses=false&poi=false&pretty=false";
        http.begin(url);
        http.setTimeout(8000);
        int httpCode = http.GET();
        
        if (httpCode == 200) {
            request->send(200, "application/json", http.getString());
        } else {
            request->send(502, "application/json", "{\"error\":\"API request failed\",\"code\":" + String(httpCode) + "}");
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
            stations[stationCount].walkTime = 0;
            if (request->hasParam("walk_time", true)) {
                stations[stationCount].walkTime = request->getParam("walk_time", true)->value().toInt();
            }
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

    // API: Update station walk time
    server.on("/api/stations/walktime", HTTP_POST, [](AsyncWebServerRequest* request) {
        if (request->hasParam("id", true) && request->hasParam("walk_time", true)) {
            String id = request->getParam("id", true)->value();
            int wt = request->getParam("walk_time", true)->value().toInt();
            if (wt < 0) wt = 0;
            if (wt > 30) wt = 30;
            for (int i = 0; i < stationCount; i++) {
                if (stations[i].id == id) {
                    stations[i].walkTime = wt;
                    saveSettings();
                    lastFetchTime = 0; // Trigger refresh
                    request->send(200, "application/json", "{\"ok\":true}");
                    return;
                }
            }
            request->send(404, "application/json", "{\"ok\":false,\"msg\":\"Station not found\"}");
        } else {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Missing id or walk_time\"}");
        }
    });

    // Settings GET
    server.on("/api/settings", HTTP_GET, [](AsyncWebServerRequest* request) {
        JsonDocument doc;
        doc["dep_count"] = depCountSetting;
        doc["scroll_enabled"] = scrollEnabled;
        doc["scroll_speed"] = scrollSpeedSetting;
        doc["sleep_enabled"] = sleepEnabled;
        doc["sleep_start"] = sleepStartHour;
        doc["sleep_end"] = sleepEndHour;
        doc["brightness"] = brightnessSetting;
        doc["api_host"] = apiHost;
        String response;
        serializeJson(doc, response);
        request->send(200, "application/json", response);
    });

    // Settings POST
    server.on("/api/settings", HTTP_POST, [](AsyncWebServerRequest* request) {
        bool changed = false;
        if (request->hasParam("dep_count", true)) {
            int val = request->getParam("dep_count", true)->value().toInt();
            if (val >= 1 && val <= 15) {
                depCountSetting = val;
                changed = true;
            }
        }
        if (request->hasParam("scroll_enabled", true)) {
            scrollEnabled = request->getParam("scroll_enabled", true)->value() == "1";
            changed = true;
        }
        if (request->hasParam("scroll_speed", true)) {
            int val = request->getParam("scroll_speed", true)->value().toInt();
            if (val >= 1000 && val <= 10000) {
                scrollSpeedSetting = val;
                changed = true;
            }
        }
        if (request->hasParam("sleep_enabled", true)) {
            sleepEnabled = request->getParam("sleep_enabled", true)->value() == "1";
            changed = true;
        }
        if (request->hasParam("sleep_start", true)) {
            int val = request->getParam("sleep_start", true)->value().toInt();
            if (val >= 0 && val <= 23) {
                sleepStartHour = val;
                changed = true;
            }
        }
        if (request->hasParam("sleep_end", true)) {
            int val = request->getParam("sleep_end", true)->value().toInt();
            if (val >= 0 && val <= 23) {
                sleepEndHour = val;
                changed = true;
            }
        }
        if (request->hasParam("brightness", true)) {
            int val = request->getParam("brightness", true)->value().toInt();
            if (val >= 5 && val <= 255) {
                brightnessSetting = val;
                matrix->setBrightness8(brightnessSetting);
                changed = true;
            }
        }
        if (request->hasParam("api_host", true)) {
            String val = request->getParam("api_host", true)->value();
            // Only allow known safe hosts
            if (val == "v6.bvg.transport.rest" || val == "v6.vbb.transport.rest") {
                apiHost = val;
                lastFetchTime = 0; // Trigger immediate re-fetch
                changed = true;
            }
        }
        if (changed) {
            saveSettings();
            request->send(200, "application/json", "{\"ok\":true}");
        } else {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"No valid params\"}");
        }
    });

    // API: Factory reset
    server.on("/api/factory-reset", HTTP_POST, [](AsyncWebServerRequest* request) {
        request->send(200, "application/json", "{\"ok\":true,\"msg\":\"Factory reset. Rebooting...\"}");
        delay(500);
        factoryReset();
    });

    // API: Check for firmware update (GitHub releases)
    server.on("/api/firmware/check", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (WiFi.status() != WL_CONNECTED) {
            request->send(503, "application/json", "{\"error\":\"WiFi not connected\"}");
            return;
        }
        HTTPClient http;
        http.begin(GITHUB_RELEASE_URL);
        http.setTimeout(10000);
        http.addHeader("User-Agent", "ESP32-BVG-Display");
        int httpCode = http.GET();
        if (httpCode != 200) {
            request->send(502, "application/json", "{\"error\":\"GitHub API error\",\"code\":" + String(httpCode) + "}");
            http.end();
            return;
        }
        String payload = http.getString();
        http.end();

        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, payload);
        if (err) {
            request->send(500, "application/json", "{\"error\":\"JSON parse failed\"}");
            return;
        }

        String tagName = doc["tag_name"] | "";
        String releaseName = doc["name"] | tagName;
        String body = doc["body"] | "";
        String downloadUrl = "";

        JsonArray assets = doc["assets"].as<JsonArray>();
        for (JsonObject asset : assets) {
            String name = asset["name"] | "";
            if (name == FW_ASSET_NAME) {
                downloadUrl = asset["browser_download_url"].as<String>();
                break;
            }
        }

        JsonDocument resp;
        resp["current_version"] = FW_VERSION;
        resp["latest_version"] = tagName;
        resp["release_name"] = releaseName;
        resp["release_notes"] = body;
        resp["download_url"] = downloadUrl;
        resp["update_available"] = (tagName != "" && tagName != "v" + String(FW_VERSION) && tagName != String(FW_VERSION));
        String response;
        serializeJson(resp, response);
        request->send(200, "application/json", response);
    });

    // API: OTA update from URL (GitHub release asset)
    server.on("/api/firmware/update", HTTP_POST, [](AsyncWebServerRequest* request) {
        if (!request->hasParam("url", true)) {
            request->send(400, "application/json", "{\"error\":\"Missing url param\"}");
            return;
        }
        String url = request->getParam("url", true)->value();
        // Only allow downloads from GitHub
        if (!url.startsWith("https://github.com/") && !url.startsWith("https://objects.githubusercontent.com/")) {
            request->send(400, "application/json", "{\"error\":\"URL must be from github.com\"}");
            return;
        }

        request->send(200, "application/json", "{\"ok\":true,\"msg\":\"Starting OTA update...\"}");

        // Perform OTA in a delayed task to allow response to be sent
        static String otaUrl;
        otaUrl = url;
        xTaskCreatePinnedToCore([](void* param) {
            delay(500); // Let HTTP response finish
            HTTPClient http;
            http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
            http.begin(otaUrl);
            http.setTimeout(30000);
            http.addHeader("User-Agent", "ESP32-BVG-Display");
            int httpCode = http.GET();

            if (httpCode != 200) {
                Serial.printf("[OTA] Download failed, HTTP %d\n", httpCode);
                http.end();
                vTaskDelete(NULL);
                return;
            }

            int contentLength = http.getSize();
            if (contentLength <= 0) {
                Serial.println("[OTA] Invalid content length");
                http.end();
                vTaskDelete(NULL);
                return;
            }

            WiFiClient* stream = http.getStreamPtr();
            // Validate ESP32 firmware magic byte
            uint8_t firstByte;
            if (stream->peek() != 0xE9) {
                Serial.println("[OTA] Invalid firmware (bad magic byte)");
                http.end();
                vTaskDelete(NULL);
                return;
            }

            if (!Update.begin(contentLength)) {
                Serial.printf("[OTA] Not enough space: %d\n", contentLength);
                http.end();
                vTaskDelete(NULL);
                return;
            }

            Serial.printf("[OTA] Starting update, %d bytes\n", contentLength);
            size_t written = Update.writeStream(*stream);
            if (written == (size_t)contentLength) {
                Serial.println("[OTA] Written successfully");
            } else {
                Serial.printf("[OTA] Written only %d/%d\n", written, contentLength);
            }

            if (Update.end()) {
                if (Update.isFinished()) {
                    Serial.println("[OTA] Update success! Rebooting...");
                    delay(500);
                    ESP.restart();
                } else {
                    Serial.println("[OTA] Update not finished");
                }
            } else {
                Serial.printf("[OTA] Update error: %s\n", Update.errorString());
            }

            http.end();
            vTaskDelete(NULL);
        }, "ota_task", 8192, NULL, 1, NULL, 0);
    });

    // API: Manual firmware upload
    server.on("/api/firmware/upload", HTTP_POST,
        // Response handler (called after upload completes)
        [](AsyncWebServerRequest* request) {
            if (Update.hasError()) {
                request->send(500, "application/json", "{\"ok\":false,\"msg\":\"" + String(Update.errorString()) + "\"}");
            } else {
                request->send(200, "application/json", "{\"ok\":true,\"msg\":\"Update successful! Rebooting...\"}");
                delay(500);
                ESP.restart();
            }
        },
        // Upload handler (called for each chunk)
        [](AsyncWebServerRequest* request, const String& filename, size_t index, uint8_t* data, size_t len, bool final) {
            if (index == 0) {
                Serial.printf("[OTA] Upload start: %s\n", filename.c_str());
                // Validate magic byte
                if (len > 0 && data[0] != 0xE9) {
                    Serial.println("[OTA] Invalid firmware file");
                    Update.abort();
                    return;
                }
                if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
                    Serial.printf("[OTA] Begin failed: %s\n", Update.errorString());
                    return;
                }
            }
            if (Update.isRunning()) {
                if (Update.write(data, len) != len) {
                    Serial.printf("[OTA] Write failed: %s\n", Update.errorString());
                }
            }
            if (final) {
                if (Update.end(true)) {
                    Serial.printf("[OTA] Upload complete: %u bytes\n", index + len);
                } else {
                    Serial.printf("[OTA] Upload end failed: %s\n", Update.errorString());
                }
            }
        }
    );

    // API: Get firmware version
    server.on("/api/firmware/version", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->send(200, "application/json", "{\"version\":\"" + String(FW_VERSION) + "\"}");
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
    
    // Fetch from all configured stations and merge
    departureCount = 0;

    for (int s = 0; s < stationCount; s++) {
        String url = "https://" + apiHost + "/stops/" + stations[s].id + 
                     "/departures?duration=" + String(BVG_DEPARTURE_DURATION) + 
                     "&results=" + String(depCountSetting) + "&pretty=false&language=de";

        HTTPClient http;
        http.begin(url);
        http.setTimeout(10000);
        int httpCode = http.GET();

        if (httpCode == 200) {
            String payload = http.getString();
            int countBefore = departureCount;
            parseDeparturesAppend(payload);
            // Filter this station's departures by its walk time
            if (stations[s].walkTime > 0) {
                int writeIdx = countBefore;
                for (int i = countBefore; i < departureCount; i++) {
                    if (departures[i].minutesUntil >= stations[s].walkTime) {
                        if (writeIdx != i) departures[writeIdx] = departures[i];
                        writeIdx++;
                    }
                }
                departureCount = writeIdx;
            }
            Serial.println("Station " + stations[s].name + ": OK (" + String(departureCount - countBefore) + " deps)");
        } else if (httpCode == 429) {
            Serial.println("Rate limited for " + stations[s].name + ", skipping remaining");
            break; // Don't hammer the API
        } else {
            Serial.println("API error for " + stations[s].name + ": " + String(httpCode));
        }
        http.end();

        // Small delay between multi-station fetches to avoid rate limiting
        if (s < stationCount - 1) delay(200);
    }

    // Sort merged departures by minutesUntil
    sortDepartures();
    scrollOffset = 0;
    if (departureCount > 0) {
        lastSuccessfulFetch = millis();
    }
    Serial.println("Total merged departures: " + String(departureCount));
}

void parseDeparturesAppend(const String& json) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, json);
    if (err) {
        Serial.println("JSON parse error: " + String(err.c_str()));
        return;
    }

    JsonArray deps = doc["departures"].as<JsonArray>();
    if (deps.isNull()) {
        // Fallback: some API versions return array directly
        deps = doc.as<JsonArray>();
        if (deps.isNull()) return;
    }

    for (JsonObject dep : deps) {
        if (departureCount >= BVG_MAX_DEPARTURES) break;

        Departure& d = departures[departureCount];
        d.lineName = dep["line"]["name"].as<String>();
        d.direction = dep["direction"].as<String>();
        d.product = dep["line"]["product"].as<String>();
        d.cancelled = dep["cancelled"] | false;
        d.delaySeconds = dep["delay"] | 0;

        // Calculate minutes until departure
        const char* whenStr = dep["when"] | (const char*)nullptr;
        if (!whenStr) whenStr = dep["plannedWhen"] | (const char*)nullptr;
        
        if (whenStr) {
            // Parse ISO 8601: "2026-05-06T13:09:00+02:00"
            struct tm tm = {};
            int tzHour = 0, tzMin = 0;
            char tzSign = '+';
            int parsed = sscanf(whenStr, "%d-%d-%dT%d:%d:%d%c%d:%d",
                   &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
                   &tm.tm_hour, &tm.tm_min, &tm.tm_sec,
                   &tzSign, &tzHour, &tzMin);
            
            if (parsed >= 6) {
                tm.tm_year -= 1900;
                tm.tm_mon -= 1;
                tm.tm_isdst = 0;
                
                // mktime interprets tm as local time, but we want to treat it
                // as the timezone specified in the string. Convert to UTC.
                // First get the epoch assuming UTC (using timegm equivalent)
                time_t depEpoch = mktime(&tm);
                // mktime assumes local time (CET/CEST due to configTzTime),
                // so correct for local timezone offset
                struct tm check;
                localtime_r(&depEpoch, &check);
                depEpoch += check.tm_gmtoff; // Now it's as if tm was UTC
                
                // Apply the string's timezone offset to get true UTC
                int tzOffsetSec = (tzHour * 3600 + tzMin * 60);
                if (tzSign == '+') depEpoch -= tzOffsetSec;
                else depEpoch += tzOffsetSec;
                
                // time() on ESP32 returns UTC epoch
                time_t nowUtc;
                time(&nowUtc);
                
                d.minutesUntil = (int)((depEpoch - nowUtc) / 60);
                if (d.minutesUntil < 0) d.minutesUntil = 0;
            } else {
                d.minutesUntil = -1;
            }
        } else {
            d.minutesUntil = -1;
        }

        departureCount++;
    }
}

// Sort departures by minutesUntil (ascending)
void sortDepartures() {
    for (int i = 0; i < departureCount - 1; i++) {
        for (int j = i + 1; j < departureCount; j++) {
            if (departures[j].minutesUntil < departures[i].minutesUntil) {
                Departure tmp = departures[i];
                departures[i] = departures[j];
                departures[j] = tmp;
            }
        }
    }
    // Trim to max
    if (departureCount > BVG_MAX_DEPARTURES) {
        departureCount = BVG_MAX_DEPARTURES;
    }
}

// ===== Display Rendering =====
void renderDisplay() {
    matrix->clearScreen();

    if (departureCount == 0) {
        renderTextCentered("Warte auf Daten...", matrix->color565(255, 204, 0));
        return;
    }

    // Stale data warning: blinking dot in top-right corner
    bool dataStale = (lastSuccessfulFetch > 0 && millis() - lastSuccessfulFetch > STALE_DATA_THRESHOLD);
    if (dataStale) {
        // Blink a red dot every 500ms
        if ((millis() / 500) % 2 == 0) {
            matrix->fillRect(MATRIX_WIDTH - 3, 0, 3, 3, matrix->color565(255, 0, 0));
        }
    }

    // Render up to DISPLAY_ROWS departures
    int rowHeight = 10;

    if (!scrollEnabled) {
        // Static mode: show first 3 departures only
        for (int i = 0; i < DISPLAY_ROWS && i < departureCount; i++) {
            renderDepartureRow(departures[i], i * rowHeight + 1);
        }
    } else {
        // Scroll mode
        for (int i = 0; i < DISPLAY_ROWS && i < departureCount; i++) {
            int depIdx = (scrollOffset + i) % departureCount;
            renderDepartureRow(departures[depIdx], i * rowHeight + 1);
        }

        // Advance scroll based on scrollSpeedSetting
        static int frameCount = 0;
        frameCount++;
        int framesPerScroll = scrollSpeedSetting / SCROLL_SPEED;
        if (frameCount >= framesPerScroll && departureCount > DISPLAY_ROWS) {
            scrollOffset = (scrollOffset + 1) % departureCount;
            frameCount = 0;
        }
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
    scrollEnabled = prefs.getBool("scrollOn", false);
    scrollSpeedSetting = prefs.getInt("scrollSpd", 3000);
    sleepEnabled = prefs.getBool("sleepOn", false);
    sleepStartHour = prefs.getInt("sleepStart", 22);
    sleepEndHour = prefs.getInt("sleepEnd", 6);
    brightnessSetting = prefs.getInt("brightness", 80);
    apiHost = prefs.getString("apiHost", BVG_API_HOST_DEFAULT);
    
    for (int i = 0; i < stationCount && i < MAX_STATIONS; i++) {
        stations[i].id = prefs.getString(("st_id_" + String(i)).c_str(), "");
        stations[i].name = prefs.getString(("st_nm_" + String(i)).c_str(), "");
        stations[i].walkTime = prefs.getInt(("st_wt_" + String(i)).c_str(), 0);
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
    prefs.putBool("scrollOn", scrollEnabled);
    prefs.putInt("scrollSpd", scrollSpeedSetting);
    prefs.putBool("sleepOn", sleepEnabled);
    prefs.putInt("sleepStart", sleepStartHour);
    prefs.putInt("sleepEnd", sleepEndHour);
    prefs.putInt("brightness", brightnessSetting);
    prefs.putString("apiHost", apiHost);
    
    for (int i = 0; i < stationCount; i++) {
        prefs.putString(("st_id_" + String(i)).c_str(), stations[i].id);
        prefs.putString(("st_nm_" + String(i)).c_str(), stations[i].name);
        prefs.putInt(("st_wt_" + String(i)).c_str(), stations[i].walkTime);
    }
    prefs.end();
}

void factoryReset() {
    Serial.println("[RESET] Factory reset triggered!");
    matrix->clearScreen();
    renderTextCentered("RESET...", matrix->color565(255, 0, 0));
    delay(1000);
    prefs.begin(PREFS_NAMESPACE, false);
    prefs.clear();
    prefs.end();
    delay(500);
    ESP.restart();
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
