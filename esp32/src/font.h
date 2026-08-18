#pragma once
#include <Arduino.h>

// 4x6 pixel font for LED matrix (compact, fits 3 rows on 32px height)
// Each character is 4 columns wide, 7 rows tall
// Stored as column bytes (LSB = top row)

const uint8_t FONT_4x7[][4] PROGMEM = {
    // Space (ASCII 32)
    {0x00, 0x00, 0x00, 0x00},
    // ! (33)
    {0x00, 0x5F, 0x00, 0x00},
    // " (34)
    {0x07, 0x00, 0x07, 0x00},
    // # (35)
    {0x14, 0x7F, 0x14, 0x7F},
    // $ (36)
    {0x24, 0x2A, 0x7F, 0x2A},
    // % (37)
    {0x23, 0x08, 0x64, 0x62},
    // & (38)
    {0x36, 0x49, 0x55, 0x22},
    // ' (39)
    {0x00, 0x03, 0x00, 0x00},
    // ( (40)
    {0x00, 0x1C, 0x22, 0x41},
    // ) (41)
    {0x41, 0x22, 0x1C, 0x00},
    // * (42)
    {0x14, 0x3E, 0x14, 0x00},
    // + (43)
    {0x08, 0x3E, 0x08, 0x00},
    // , (44)
    {0x00, 0x50, 0x30, 0x00},
    // - (45)
    {0x08, 0x08, 0x08, 0x08},
    // . (46)
    {0x00, 0x60, 0x60, 0x00},
    // / (47)
    {0x20, 0x10, 0x08, 0x04},
    // 0 (48)
    {0x3E, 0x51, 0x45, 0x3E},
    // 1 (49)
    {0x42, 0x7F, 0x40, 0x00},
    // 2 (50)
    {0x62, 0x51, 0x49, 0x46},
    // 3 (51)
    {0x21, 0x45, 0x4B, 0x31},
    // 4 (52)
    {0x18, 0x14, 0x7F, 0x10},
    // 5 (53)
    {0x27, 0x45, 0x45, 0x39},
    // 6 (54)
    {0x3C, 0x4A, 0x49, 0x30},
    // 7 (55)
    {0x01, 0x71, 0x09, 0x07},
    // 8 (56)
    {0x36, 0x49, 0x49, 0x36},
    // 9 (57)
    {0x06, 0x49, 0x29, 0x1E},
    // : (58)
    {0x00, 0x36, 0x36, 0x00},
    // ; (59)
    {0x00, 0x56, 0x36, 0x00},
    // < (60)
    {0x08, 0x14, 0x22, 0x41},
    // = (61)
    {0x14, 0x14, 0x14, 0x14},
    // > (62)
    {0x41, 0x22, 0x14, 0x08},
    // ? (63)
    {0x02, 0x51, 0x09, 0x06},
    // @ (64)
    {0x3E, 0x5D, 0x55, 0x1E},
    // A (65)
    {0x7E, 0x11, 0x11, 0x7E},
    // B (66)
    {0x7F, 0x49, 0x49, 0x36},
    // C (67)
    {0x3E, 0x41, 0x41, 0x22},
    // D (68)
    {0x7F, 0x41, 0x22, 0x1C},
    // E (69)
    {0x7F, 0x49, 0x49, 0x41},
    // F (70)
    {0x7F, 0x09, 0x09, 0x01},
    // G (71)
    {0x3E, 0x41, 0x49, 0x7A},
    // H (72)
    {0x7F, 0x08, 0x08, 0x7F},
    // I (73)
    {0x41, 0x7F, 0x41, 0x00},
    // J (74)
    {0x20, 0x40, 0x41, 0x3F},
    // K (75)
    {0x7F, 0x08, 0x14, 0x63},
    // L (76)
    {0x7F, 0x40, 0x40, 0x40},
    // M (77)
    {0x7F, 0x02, 0x0C, 0x02},
    // N (78)
    {0x7F, 0x04, 0x08, 0x7F},
    // O (79)
    {0x3E, 0x41, 0x41, 0x3E},
    // P (80)
    {0x7F, 0x09, 0x09, 0x06},
    // Q (81)
    {0x3E, 0x41, 0x21, 0x5E},
    // R (82)
    {0x7F, 0x09, 0x19, 0x66},
    // S (83)
    {0x46, 0x49, 0x49, 0x31},
    // T (84)
    {0x01, 0x7F, 0x01, 0x01},
    // U (85)
    {0x3F, 0x40, 0x40, 0x3F},
    // V (86)
    {0x1F, 0x20, 0x40, 0x1F},
    // W (87)
    {0x3F, 0x40, 0x38, 0x40},
    // X (88)
    {0x63, 0x14, 0x14, 0x63},
    // Y (89)
    {0x07, 0x70, 0x08, 0x07},
    // Z (90)
    {0x61, 0x51, 0x49, 0x47},
};

#define FONT_CHAR_ADVANCE 5   // 4px glyph + 1px gap
#define FONT_GLYPH_COUNT  59  // ASCII 32..90

// Decode one UTF-8 code point and fold it into the ASCII range the font covers.
// Station names arrive as UTF-8 ("Schoenhauser Allee" is really "Schönhauser"),
// so without this every umlaut renders as two blank cells and shifts the rest
// of the row out of alignment.
// Advances `p` past the whole sequence and returns the glyph to draw.
inline char nextGlyph(const char*& p) {
    uint8_t c = (uint8_t)*p++;
    if (c < 0x80) return (char)c;

    if ((c & 0xE0) == 0xC0 && ((uint8_t)*p & 0xC0) == 0x80) {
        uint16_t cp = ((c & 0x1F) << 6) | ((uint8_t)*p++ & 0x3F);
        switch (cp) {
            case 0x00C4: return 'A';  // A-umlaut
            case 0x00D6: return 'O';  // O-umlaut
            case 0x00DC: return 'U';  // U-umlaut
            case 0x00E4: return 'a';
            case 0x00F6: return 'o';
            case 0x00FC: return 'u';
            case 0x00DF: return 's';  // sharp s
            case 0x00E9: case 0x00E8: return 'e';
            case 0x00C9: case 0x00C8: return 'E';
            default: return '?';
        }
    }

    // 3- and 4-byte sequences have no equivalent — skip their continuation bytes
    while (((uint8_t)*p & 0xC0) == 0x80) p++;
    return '?';
}

// Draw a single (already folded) character at (x, y).
// Always advances by FONT_CHAR_ADVANCE so measureString() and drawString() agree
// even when a character has no glyph.
inline int drawChar(MatrixPanel_I2S_DMA* matrix, char ch, int x, int y, uint16_t color) {
    int idx = -1;
    if (ch >= 32 && ch <= 90) {
        idx = ch - 32;
    } else if (ch >= 'a' && ch <= 'z') {
        idx = (ch - 'a') + ('A' - 32); // Map lowercase to uppercase
    }

    if (idx < 0 || idx >= FONT_GLYPH_COUNT) {
        return FONT_CHAR_ADVANCE; // unknown char, leave a blank cell
    }

    for (int col = 0; col < 4; col++) {
        uint8_t colData = pgm_read_byte(&FONT_4x7[idx][col]);
        for (int row = 0; row < 7; row++) {
            if (colData & (1 << row)) {
                if (x + col >= 0 && x + col < MATRIX_WIDTH && y + row >= 0 && y + row < MATRIX_HEIGHT) {
                    matrix->drawPixel(x + col, y + row, color);
                }
            }
        }
    }
    return FONT_CHAR_ADVANCE;
}

// Draw a UTF-8 string at (x, y)
inline int drawString(MatrixPanel_I2S_DMA* matrix, const char* str, int x, int y, uint16_t color) {
    int cx = x;
    while (*str) {
        cx += drawChar(matrix, nextGlyph(str), cx, y, color);
    }
    return cx - x;
}

// Number of drawable glyphs in a UTF-8 string
inline int glyphCount(const char* str) {
    int n = 0;
    while (*str) { nextGlyph(str); n++; }
    return n;
}

// Measure a UTF-8 string's rendered width in pixels
inline int measureString(const char* str) {
    int n = glyphCount(str);
    return n > 0 ? (n * FONT_CHAR_ADVANCE - 1) : 0;
}

// Truncate a UTF-8 string to at most `maxGlyphs` glyphs without splitting a
// multi-byte sequence in half.
inline String truncateUtf8(const String& str, int maxGlyphs) {
    if (maxGlyphs <= 0) return String("");
    const char* start = str.c_str();
    const char* p = start;
    int n = 0;
    while (*p && n < maxGlyphs) { nextGlyph(p); n++; }
    return str.substring(0, p - start);
}
