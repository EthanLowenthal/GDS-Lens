#include "stroke_font.hpp"

namespace stroke_font {
namespace {

// One entry per printable ASCII code point, 0x20 (space) through 0x7E (~), in
// order, followed by one fallback glyph (a hollow box) used for every other
// byte -- GDSII/OASIS label text is a byte string with no declared encoding,
// so anything outside printable ASCII (including the individual bytes of a
// UTF-8 sequence) draws as that box instead of being guessed at.
//
// Each glyph is a set of polylines on an integer grid, written as two-digit
// "xy" points separated by spaces, with '/' between polylines. x runs 0..4
// left to right. y runs 0..9 bottom to top with the baseline at 2, the
// x-height at 7 and the cap height at 9 -- so descenders reach y=0 and
// ascenders y=9.
const char* const kGlyphStrokes[] = {
    "",                                                     // (space)
    "29 24/22 23",                                          // !
    "19 17/39 37",                                          // "
    "17 47/15 45/19 12/39 32",                              // #
    "48 39 19 08 07 16 35 44 43 32 12 03/21 29",            // $
    "09 19 18 08 09/32 42 43 33 32/02 49",                  // %
    "42 17 18 29 38 37 04 03 12 22 44",                     // &
    "29 27",                                                // '
    "39 17 14 32",                                          // (
    "19 37 34 12",                                          // )
    "28 24/07 45/47 05",                                    // *
    "05 45/27 23",                                          // +
    "22 21 10",                                             // ,
    "05 45",                                                // -
    "22 23",                                                // .
    "02 49",                                                // /
    "12 32 43 48 39 19 08 03 12",                           // 0
    "08 29 22/02 42",                                       // 1
    "08 19 39 48 47 02 42",                                 // 2
    "08 19 39 48 47 36 45 43 32 12 03",                     // 3
    "39 04 44/32 39",                                       // 4
    "49 09 06 36 45 43 32 12 03",                           // 5
    "48 39 19 08 03 12 32 43 44 35 15 04",                  // 6
    "09 49 12",                                             // 7
    "12 32 43 44 35 15 04 03 12/15 35 46 48 39 19 08 06 15",// 8
    "03 12 32 43 48 39 19 08 07 16 36 47",                  // 9
    "26 27/22 23",                                          // :
    "26 27/22 21 10",                                       // ;
    "48 05 42",                                             // <
    "06 46/04 44",                                          // =
    "08 45 02",                                             // >
    "08 19 39 48 47 25 24/22 23",                           // ?
    "43 12 03 08 19 39 48 45 34 24 26 36",                  // @
    "02 29 42/15 35",                                       // A
    "09 02/09 39 48 47 36 06/36 45 43 32 02",               // B
    "48 39 19 08 03 12 32 43",                              // C
    "09 02/09 39 48 43 32 02",                              // D
    "49 09 02 42/06 36",                                    // E
    "49 09 02/06 36",                                       // F
    "48 39 19 08 03 12 32 43 45 25",                        // G
    "09 02/49 42/06 46",                                    // H
    "09 49/29 22/02 42",                                    // I
    "39 33 22 12 03",                                       // J
    "09 02/49 05 42",                                       // K
    "09 02 42",                                             // L
    "02 09 25 49 42",                                       // M
    "02 09 42 49",                                          // N
    "12 32 43 48 39 19 08 03 12",                           // O
    "02 09 39 48 46 35 05",                                 // P
    "12 32 43 48 39 19 08 03 12/23 42",                     // Q
    "02 09 39 48 46 35 05/25 42",                           // R
    "48 39 19 08 07 16 35 44 43 32 12 03",                  // S
    "09 49/29 22",                                          // T
    "09 03 12 32 43 49",                                    // U
    "09 22 49",                                             // V
    "09 02 26 42 49",                                       // W
    "09 42/02 49",                                          // X
    "09 26 49/26 22",                                       // Y
    "09 49 02 42",                                          // Z
    "39 29 22 32",                                          // [
    "09 42",                                                // (backslash)
    "19 29 22 12",                                          // ]
    "07 29 47",                                             // ^
    "01 41",                                                // _
    "19 27",                                                // `
    "06 17 37 46 42/43 32 12 03 14 44",                     // a
    "09 02/06 17 37 46 43 32 12 03",                        // b
    "46 37 17 06 03 12 32 43",                              // c
    "49 42/46 37 17 06 03 12 32 43",                        // d
    "04 44 46 37 17 06 03 12 32 43",                        // e
    "22 28 39 49/16 36",                                    // f
    "46 37 17 06 03 12 32 43/47 41 30 10 01",               // g
    "09 02/05 17 37 46 42",                                 // h
    "27 22/28 29",                                          // i
    "37 31 20 10 01/38 39",                                 // j
    "09 02/37 04 32",                                       // k
    "19 29 22 32",                                          // l
    "07 02/06 17 26 22/26 37 46 42",                        // m
    "07 02/06 17 37 46 42",                                 // n
    "12 32 43 46 37 17 06 03 12",                           // o
    "07 00/06 17 37 46 43 32 12 03",                        // p
    "47 40/46 37 17 06 03 12 32 43",                        // q
    "07 02/06 17 37",                                       // r
    "46 37 17 06 15 34 43 32 12 03",                        // s
    "19 13 22 32/07 27",                                    // t
    "07 03 12 32 43 47/47 42",                              // u
    "07 22 47",                                             // v
    "07 02 25 42 47",                                       // w
    "07 42/02 47",                                          // x
    "07 03 12 32 43 47/47 41 30 10",                        // y
    "07 47 02 42",                                          // z
    "39 28 26 15 24 22 32",                                 // {
    "29 21",                                                // |
    "19 28 26 35 24 22 12",                                 // }
    "05 16 36 45",                                          // ~
    "02 42 47 07 02",                                       // fallback (any other byte)
};
constexpr int kGlyphCount = (int)(sizeof(kGlyphStrokes) / sizeof(kGlyphStrokes[0]));

// Grid metrics (see kGlyphStrokes): the cap height spans y=2..9, and each
// glyph advances 6 units -- 4 units of drawn width plus 2 of side bearing.
constexpr float kGlyphBaselineUnits = 2.0f;
constexpr float kGlyphCapUnits = 7.0f;
constexpr float kGlyphWidthUnits = 4.0f;
constexpr float kGlyphAdvanceUnits = 6.0f;

// One grid unit in pixels, from the cap height the header fixes.
constexpr float kTextUnitPx = kTextCapHeightPx / kGlyphCapUnits;

// kGlyphStrokes decoded once into flat line segments (x0,y0,x1,y1 per
// segment, in grid units) so building a label is a scale-and-offset copy
// rather than a string parse -- the buffer is rebuilt on every pan, so this
// runs a lot.
const std::vector<std::vector<float>>& glyph_segments() {
    static const std::vector<std::vector<float>> table = [] {
        std::vector<std::vector<float>> glyphs;
        glyphs.reserve(kGlyphCount);
        for (int g = 0; g < kGlyphCount; g++) {
            std::vector<float> segments;
            float prev_x = 0.0f, prev_y = 0.0f;
            bool have_prev = false;
            for (const char* p = kGlyphStrokes[g]; *p; p++) {
                if (*p == '/' || *p == ' ') {
                    // '/' starts a new polyline; ' ' just separates points.
                    if (*p == '/') have_prev = false;
                    continue;
                }
                // Two digits, "xy". Anything else in the table is a typo, so
                // stop rather than read past the end of the string.
                if (p[1] < '0' || p[1] > '9') break;
                float x = (float)(p[0] - '0');
                float y = (float)(p[1] - '0');
                p++;
                if (have_prev) {
                    segments.push_back(prev_x);
                    segments.push_back(prev_y);
                    segments.push_back(x);
                    segments.push_back(y);
                }
                prev_x = x;
                prev_y = y;
                have_prev = true;
            }
            glyphs.push_back(std::move(segments));
        }
        return glyphs;
    }();
    return table;
}

// Width of `text` as drawn, in pixels: full advances between characters plus
// one glyph's drawn width for the last one (the trailing side bearing isn't
// part of the visible box, and including it would bias every centered label
// half a space to the left).
float text_width_px(const std::string& text) {
    if (text.empty()) return 0.0f;
    return ((float)(text.size() - 1) * kGlyphAdvanceUnits + kGlyphWidthUnits) * kTextUnitPx;
}

}  // namespace

void append_text_vertices(const std::string& text, float world_x, float world_y, uint8_t anchor,
                          std::vector<float>& out) {
    const std::vector<std::vector<float>>& glyphs = glyph_segments();

    float origin_x = 0.0f;
    switch (anchor & 3) {
        case 0: origin_x = 0.0f; break;                          // W (left)
        case 1: origin_x = -text_width_px(text) * 0.5f; break;    // center
        default: origin_x = -text_width_px(text); break;          // E (right)
    }
    float origin_y = 0.0f;
    switch ((anchor >> 2) & 3) {
        case 0: origin_y = -kTextCapHeightPx; break;         // N (top edge at origin)
        case 1: origin_y = -kTextCapHeightPx * 0.5f; break;  // middle
        default: origin_y = 0.0f; break;                     // S (baseline at origin)
    }
    // Grid y is measured from y=0, not the baseline -- shift so that the
    // baseline lands on origin_y.
    origin_y -= kGlyphBaselineUnits * kTextUnitPx;

    for (size_t i = 0; i < text.size(); i++) {
        unsigned char c = (unsigned char)text[i];
        int index = (c >= 0x20 && c <= 0x7E) ? (int)c - 0x20 : kGlyphCount - 1;
        const std::vector<float>& segments = glyphs[(size_t)index];
        float pen_x = origin_x + (float)i * kGlyphAdvanceUnits * kTextUnitPx;
        for (size_t s = 0; s + 3 < segments.size(); s += 4) {
            out.push_back(world_x);
            out.push_back(world_y);
            out.push_back(pen_x + segments[s] * kTextUnitPx);
            out.push_back(origin_y + segments[s + 1] * kTextUnitPx);
            out.push_back(world_x);
            out.push_back(world_y);
            out.push_back(pen_x + segments[s + 2] * kTextUnitPx);
            out.push_back(origin_y + segments[s + 3] * kTextUnitPx);
        }
    }
}

}  // namespace stroke_font
