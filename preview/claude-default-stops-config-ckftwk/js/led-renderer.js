/**
 * LED Panel Renderer
 * Renders departure data onto a 128x32 pixel canvas, emulating a HUB75/P10 LED matrix.
 * Uses a built-in 5x7 pixel font for authentic LED look.
 */
const LedRenderer = (() => {
    'use strict';

    const WIDTH = 128;
    const HEIGHT = 32;
    const ROW_HEIGHT = 10;
    const MAX_ROWS = 3;
    const CHAR_WIDTH = 6;  // 5px glyph + 1px gap

    let canvas = null;
    let ctx = null;
    let frame = null;   // ImageData backing buffer
    let pixels = null;  // frame.data (RGBA)
    let scrollTimer = null;

    // 5x7 pixel font (subset: A-Z, 0-9, common symbols)
    // Each char is 5 columns wide, each column is 7 bits (LSB = top row)
    const FONT_5x7 = {
        ' ': [0x00, 0x00, 0x00, 0x00, 0x00],
        '!': [0x00, 0x00, 0x5F, 0x00, 0x00],
        '"': [0x00, 0x07, 0x00, 0x07, 0x00],
        '#': [0x14, 0x7F, 0x14, 0x7F, 0x14],
        '$': [0x24, 0x2A, 0x7F, 0x2A, 0x12],
        '%': [0x23, 0x13, 0x08, 0x64, 0x62],
        '&': [0x36, 0x49, 0x55, 0x22, 0x50],
        "'": [0x00, 0x05, 0x03, 0x00, 0x00],
        '(': [0x00, 0x1C, 0x22, 0x41, 0x00],
        ')': [0x00, 0x41, 0x22, 0x1C, 0x00],
        '*': [0x14, 0x08, 0x3E, 0x08, 0x14],
        '+': [0x08, 0x08, 0x3E, 0x08, 0x08],
        ',': [0x00, 0x50, 0x30, 0x00, 0x00],
        '-': [0x08, 0x08, 0x08, 0x08, 0x08],
        '.': [0x00, 0x60, 0x60, 0x00, 0x00],
        '/': [0x20, 0x10, 0x08, 0x04, 0x02],
        '0': [0x3E, 0x51, 0x49, 0x45, 0x3E],
        '1': [0x00, 0x42, 0x7F, 0x40, 0x00],
        '2': [0x42, 0x61, 0x51, 0x49, 0x46],
        '3': [0x21, 0x41, 0x45, 0x4B, 0x31],
        '4': [0x18, 0x14, 0x12, 0x7F, 0x10],
        '5': [0x27, 0x45, 0x45, 0x45, 0x39],
        '6': [0x3C, 0x4A, 0x49, 0x49, 0x30],
        '7': [0x01, 0x71, 0x09, 0x05, 0x03],
        '8': [0x36, 0x49, 0x49, 0x49, 0x36],
        '9': [0x06, 0x49, 0x49, 0x29, 0x1E],
        ':': [0x00, 0x36, 0x36, 0x00, 0x00],
        ';': [0x00, 0x56, 0x36, 0x00, 0x00],
        '<': [0x08, 0x14, 0x22, 0x41, 0x00],
        '=': [0x14, 0x14, 0x14, 0x14, 0x14],
        '>': [0x00, 0x41, 0x22, 0x14, 0x08],
        '?': [0x02, 0x01, 0x51, 0x09, 0x06],
        '@': [0x3E, 0x41, 0x5D, 0x55, 0x1E],
        'A': [0x7E, 0x11, 0x11, 0x11, 0x7E],
        'B': [0x7F, 0x49, 0x49, 0x49, 0x36],
        'C': [0x3E, 0x41, 0x41, 0x41, 0x22],
        'D': [0x7F, 0x41, 0x41, 0x22, 0x1C],
        'E': [0x7F, 0x49, 0x49, 0x49, 0x41],
        'F': [0x7F, 0x09, 0x09, 0x09, 0x01],
        'G': [0x3E, 0x41, 0x49, 0x49, 0x7A],
        'H': [0x7F, 0x08, 0x08, 0x08, 0x7F],
        'I': [0x00, 0x41, 0x7F, 0x41, 0x00],
        'J': [0x20, 0x40, 0x41, 0x3F, 0x01],
        'K': [0x7F, 0x08, 0x14, 0x22, 0x41],
        'L': [0x7F, 0x40, 0x40, 0x40, 0x40],
        'M': [0x7F, 0x02, 0x0C, 0x02, 0x7F],
        'N': [0x7F, 0x04, 0x08, 0x10, 0x7F],
        'O': [0x3E, 0x41, 0x41, 0x41, 0x3E],
        'P': [0x7F, 0x09, 0x09, 0x09, 0x06],
        'Q': [0x3E, 0x41, 0x51, 0x21, 0x5E],
        'R': [0x7F, 0x09, 0x19, 0x29, 0x46],
        'S': [0x46, 0x49, 0x49, 0x49, 0x31],
        'T': [0x01, 0x01, 0x7F, 0x01, 0x01],
        'U': [0x3F, 0x40, 0x40, 0x40, 0x3F],
        'V': [0x1F, 0x20, 0x40, 0x20, 0x1F],
        'W': [0x3F, 0x40, 0x38, 0x40, 0x3F],
        'X': [0x63, 0x14, 0x08, 0x14, 0x63],
        'Y': [0x07, 0x08, 0x70, 0x08, 0x07],
        'Z': [0x61, 0x51, 0x49, 0x45, 0x43],
        '[': [0x00, 0x7F, 0x41, 0x41, 0x00],
        ']': [0x00, 0x41, 0x41, 0x7F, 0x00],
        '_': [0x40, 0x40, 0x40, 0x40, 0x40],
        'a': [0x20, 0x54, 0x54, 0x54, 0x78],
        'b': [0x7F, 0x48, 0x44, 0x44, 0x38],
        'c': [0x38, 0x44, 0x44, 0x44, 0x20],
        'd': [0x38, 0x44, 0x44, 0x48, 0x7F],
        'e': [0x38, 0x54, 0x54, 0x54, 0x18],
        'f': [0x08, 0x7E, 0x09, 0x01, 0x02],
        'g': [0x0C, 0x52, 0x52, 0x52, 0x3E],
        'h': [0x7F, 0x08, 0x04, 0x04, 0x78],
        'i': [0x00, 0x44, 0x7D, 0x40, 0x00],
        'j': [0x20, 0x40, 0x44, 0x3D, 0x00],
        'k': [0x7F, 0x10, 0x28, 0x44, 0x00],
        'l': [0x00, 0x41, 0x7F, 0x40, 0x00],
        'm': [0x7C, 0x04, 0x18, 0x04, 0x78],
        'n': [0x7C, 0x08, 0x04, 0x04, 0x78],
        'o': [0x38, 0x44, 0x44, 0x44, 0x38],
        'p': [0x7C, 0x14, 0x14, 0x14, 0x08],
        'q': [0x08, 0x14, 0x14, 0x18, 0x7C],
        'r': [0x7C, 0x08, 0x04, 0x04, 0x08],
        's': [0x48, 0x54, 0x54, 0x54, 0x20],
        't': [0x04, 0x3F, 0x44, 0x40, 0x20],
        'u': [0x3C, 0x40, 0x40, 0x20, 0x7C],
        'v': [0x1C, 0x20, 0x40, 0x20, 0x1C],
        'w': [0x3C, 0x40, 0x30, 0x40, 0x3C],
        'x': [0x44, 0x28, 0x10, 0x28, 0x44],
        'y': [0x0C, 0x50, 0x50, 0x50, 0x3C],
        'z': [0x44, 0x64, 0x54, 0x4C, 0x44],
        // German umlauts
        '\u00C4': [0x7E, 0x11, 0x11, 0x11, 0x7E], // Ä (same as A with dots drawn)
        '\u00D6': [0x3E, 0x41, 0x41, 0x41, 0x3E], // Ö
        '\u00DC': [0x3F, 0x40, 0x40, 0x40, 0x3F], // Ü
        '\u00E4': [0x20, 0x54, 0x54, 0x54, 0x78], // ä
        '\u00F6': [0x38, 0x44, 0x44, 0x44, 0x38], // ö
        '\u00FC': [0x3C, 0x40, 0x40, 0x20, 0x7C], // ü
        '\u00DF': [0x7E, 0x01, 0x49, 0x49, 0x36], // ß
    };

    // Line colors for LED display (RGB)
    const LINE_COLORS = {
        suburban: [0, 141, 79],     // S-Bahn green
        subway: [0, 96, 170],       // U-Bahn blue
        tram: [190, 20, 20],        // Tram red
        bus: [155, 39, 144],        // Bus purple
        ferry: [0, 137, 180],       // Ferry teal
        express: [100, 100, 100],   // IC gray
        regional: [227, 6, 19],     // RE red
    };

    // Specific line colors
    const SPECIFIC_COLORS = {
        'u1': [125, 173, 76], 'u2': [218, 66, 30], 'u3': [0, 122, 91],
        'u4': [240, 215, 34], 'u5': [126, 83, 48], 'u6': [140, 109, 171],
        'u7': [82, 141, 186], 'u8': [34, 79, 134], 'u9': [243, 121, 29],
        's1': [222, 77, 164], 's2': [0, 95, 39], 's3': [0, 96, 170],
        's41': [162, 59, 30], 's42': [194, 106, 55], 's5': [255, 89, 0],
        's7': [119, 96, 176], 's8': [85, 168, 34], 's9': [139, 28, 98],
    };

    /**
     * Initialize the renderer with a canvas element.
     * Safe to call repeatedly (e.g. every time the LED view is opened).
     */
    function init(canvasElement) {
        if (canvas !== canvasElement) {
            canvas = canvasElement;
            ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            frame = ctx.createImageData(WIDTH, HEIGHT);
            pixels = frame.data;
            // Alpha is constant — set it once instead of on every pixel write.
            for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
        }
        clear();
    }

    /**
     * Clear the panel to black
     */
    function clear() {
        if (!ctx) return;
        clearBuffer();
        flush();
    }

    /** Zero the RGB channels of the backing buffer (alpha stays at 255) */
    function clearBuffer() {
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = 0;
            pixels[i + 1] = 0;
            pixels[i + 2] = 0;
        }
    }

    /** Push the backing buffer to the canvas — one draw call per frame */
    function flush() {
        ctx.putImageData(frame, 0, 0);
    }

    /**
     * Set a single pixel in the backing buffer
     */
    function setPixel(x, y, r, g, b) {
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
        const i = (y * WIDTH + x) * 4;
        pixels[i] = r;
        pixels[i + 1] = g;
        pixels[i + 2] = b;
    }

    /**
     * Draw a character at position, returns width drawn
     */
    function drawChar(ch, x, y, r, g, b) {
        const glyph = FONT_5x7[ch] || FONT_5x7['?'];
        for (let col = 0; col < 5; col++) {
            const colData = glyph[col];
            if (!colData) continue;
            for (let row = 0; row < 7; row++) {
                if (colData & (1 << row)) {
                    setPixel(x + col, y + row, r, g, b);
                }
            }
        }
        return CHAR_WIDTH;
    }

    /**
     * Draw a string, returns total width
     */
    function drawString(str, x, y, r, g, b) {
        let cx = x;
        for (let i = 0; i < str.length; i++) {
            cx += drawChar(str[i], cx, y, r, g, b);
        }
        return cx - x;
    }

    /**
     * Measure string width in pixels
     */
    function measureString(str) {
        return str.length > 0 ? str.length * CHAR_WIDTH - 1 : 0;
    }

    /**
     * Draw a small filled rectangle (for line badge background)
     */
    function fillRect(x, y, w, h, r, g, b) {
        for (let py = y; py < y + h; py++) {
            for (let px = x; px < x + w; px++) {
                setPixel(px, py, r, g, b);
            }
        }
    }

    /**
     * Get color for a line
     */
    function getLineColor(line) {
        if (!line) return [255, 255, 255];
        const name = (line.name || '').toLowerCase().replace(/\s/g, '');
        if (SPECIFIC_COLORS[name]) return SPECIFIC_COLORS[name];
        if (LINE_COLORS[line.product]) return LINE_COLORS[line.product];
        return [255, 204, 0]; // default yellow
    }

    /**
     * Render departures onto the LED panel
     * Shows up to 3 rows (row height ~10px with 1px gap)
     */
    function render(departures) {
        if (!ctx) return;
        clearBuffer();

        if (!departures || departures.length === 0) {
            const label = 'Keine Abfahrten';
            drawString(label, Math.round((WIDTH - measureString(label)) / 2), 12, 255, 204, 0);
            flush();
            return;
        }

        departures.slice(0, MAX_ROWS).forEach((dep, i) => {
            renderDepartureRow(dep, i * ROW_HEIGHT + 1);
        });
        flush();
    }

    /**
     * Render a single departure row
     */
    function renderDepartureRow(dep, y) {
        const line = dep.line;
        const lineName = line ? line.name : '?';
        const direction = dep.direction || '';
        const color = getLineColor(line);
        const isCancelled = dep.cancelled === true;

        // Line badge (background + text)
        const badgeWidth = lineName.length * CHAR_WIDTH + 3;
        fillRect(0, y, badgeWidth, 9, color[0], color[1], color[2]);

        // Line name in badge (use black if badge is bright)
        const brightness = (color[0] * 299 + color[1] * 587 + color[2] * 114) / 1000;
        const textR = brightness > 128 ? 0 : 255;
        const textG = brightness > 128 ? 0 : 255;
        const textB = brightness > 128 ? 0 : 255;
        drawString(lineName, 2, y + 1, textR, textG, textB);

        // Time (right-aligned, measured first so the destination knows its budget)
        const timeStr = formatLedTime(dep);
        const timeColor = getTimeColor(dep);
        const timeX = WIDTH - measureString(timeStr) - 1;
        drawString(timeStr, timeX, y + 1, timeColor[0], timeColor[1], timeColor[2]);

        // Destination (between badge and time)
        const destX = badgeWidth + 2;
        const destColor = isCancelled ? [100, 100, 100] : [255, 255, 255];
        const availableWidth = timeX - destX - 2;
        const maxChars = Math.floor(availableWidth / CHAR_WIDTH);
        let truncatedDest = direction;
        if (truncatedDest.length > maxChars) {
            truncatedDest = truncatedDest.substring(0, Math.max(0, maxChars - 1)) + '.';
        }
        drawString(truncatedDest, destX, y + 1, destColor[0], destColor[1], destColor[2]);
    }

    /**
     * Format departure time for LED display
     */
    function formatLedTime(dep) {
        if (dep.cancelled) return 'X';
        const when = dep.when ? new Date(dep.when) : (dep.plannedWhen ? new Date(dep.plannedWhen) : null);
        if (!when) return '?';

        const now = new Date();
        const diffMin = Math.round((when - now) / 60000);

        if (diffMin <= 0) return 'jetzt';
        if (diffMin < 60) return `${diffMin}'`;
        return when.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    /**
     * Get time display color based on status
     */
    function getTimeColor(dep) {
        if (dep.cancelled) return [255, 0, 0];
        if (dep.delay && dep.delay > 120) return [255, 80, 80]; // significant delay: red
        if (dep.delay && dep.delay > 60) return [255, 165, 0]; // slight delay: orange

        const when = dep.when ? new Date(dep.when) : null;
        if (!when) return [255, 204, 0]; // yellow (planned only)

        const now = new Date();
        const diffMin = Math.round((when - now) / 60000);
        if (diffMin <= 1) return [0, 255, 0]; // imminent: green
        return [255, 204, 0]; // normal: yellow
    }

    /**
     * Start scrolling animation (for long lists)
     */
    function startScroll(departures, intervalMs) {
        stopScroll();
        if (!departures || departures.length <= MAX_ROWS) {
            render(departures || []);
            return;
        }

        let offset = 0;
        render(departures.slice(0, MAX_ROWS));

        scrollTimer = setInterval(() => {
            offset = (offset + 1) % departures.length;
            const visible = [];
            for (let i = 0; i < MAX_ROWS; i++) {
                visible.push(departures[(offset + i) % departures.length]);
            }
            render(visible);
        }, intervalMs || 3000);
    }

    /**
     * Stop scrolling
     */
    function stopScroll() {
        if (scrollTimer) {
            clearInterval(scrollTimer);
            scrollTimer = null;
        }
    }

    return {
        init,
        clear,
        render,
        startScroll,
        stopScroll,
        isScrolling: () => scrollTimer !== null,
        WIDTH,
        HEIGHT
    };
})();
