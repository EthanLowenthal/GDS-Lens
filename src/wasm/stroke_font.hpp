// A vector (line-segment) font rather than a texture atlas: the glyphs are
// drawn with the same GL_LINES machinery every other overlay in the renderer
// uses, so there is no font texture to build, no atlas to pack, and nothing
// to re-rasterize when the pixel size changes. It is also what CAD viewers
// traditionally use for layout labels, so the result looks the part.
//
// The glyph table and its grid encoding live in stroke_font.cpp; nothing but
// the two declarations below is needed to draw with it.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace stroke_font {

// On-screen cap height of a label, in CSS pixels. Everything else about the
// text scales off this.
constexpr float kTextCapHeightPx = 11.0f;

// Appends `text` to `out` as GL_LINES vertices -- 4 floats each: the label's
// world origin (identical for every vertex of the label, so the camera places
// the whole label as a unit) followed by that vertex's pixel offset from the
// origin. `anchor` is gdstk's Anchor enum: bits 2-3 pick the vertical edge the
// origin sits on (0 = top, 1 = middle, 2 = baseline) and bits 0-1 the
// horizontal one (0 = left, 1 = center, 2 = right).
//
// The label is always drawn horizontally, ignoring any rotation/magnification
// on the label itself or in the references above it: at a fixed pixel size,
// inheriting the placement's transform would give upside-down and mirrored
// (unreadable) text for the many cells that are placed that way, which is not
// what a label is for.
void append_text_vertices(const std::string& text, float world_x, float world_y, uint8_t anchor,
                          std::vector<float>& out);

}  // namespace stroke_font
