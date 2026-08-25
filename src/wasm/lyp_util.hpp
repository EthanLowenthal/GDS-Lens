// String and color primitives for reading .lyp layer-property files.
//
// .lyp is XML, but the viewer scans it at the string level rather than pulling
// in a parser: the format is shallow and the handful of tags loadLypText()
// cares about are easy to find directly, which keeps the wasm module free of
// an XML dependency. These are the pieces that make that scanning safe --
// attribute-tolerant tag lookup, entity decoding, comment stripping -- plus
// the two color conversions the format's values need.
#pragma once

#include <array>
#include <string>

namespace lyp_util {

// Locates the next opening <tag> or <tag attr="...">, tolerating attributes,
// at or after `from`. Returns the position of the '<' (npos if absent) and
// sets content_start to just past the tag's closing '>'. Self-closing tags
// (<tag/>, <tag attr/>) are skipped: they carry no value, which for every tag
// this parser reads is equivalent to the tag being absent.
size_t find_open_tag(const std::string& text, const char* tag, size_t from, size_t& content_start);

// Decodes the five predefined XML entities plus numeric character references
// (&#nn; / &#xhh;) -- .lyp values are stored XML-escaped, so a layer named
// "A&B" arrives here as "A&amp;B".
std::string xml_unescape(const std::string& s);

// Strips <!-- --> comments up front so a commented-out block (which may well
// contain <properties> or <group-members> tags) can't confuse the
// string-level tag scanning in loadLypText.
std::string strip_xml_comments(const std::string& text);

// Reads the text content of the first <tag>...</tag> in `block` into `out`,
// XML-unescaped. False if the tag is missing or unterminated.
bool extract_tag_value(const std::string& block, const char* tag, std::string& out);

// Drops leading and trailing whitespace.
std::string trim(const std::string& s);

// alpha output of 0 signals "invalid hex" to the caller (mirrors the old
// hexToRgb() returning null); the requested alpha is otherwise always > 0.
std::array<float, 4> hex_to_rgba(const std::string& hex_in, float alpha);

// the format's <frame-brightness>/<fill-brightness>: -255..255 shifts the color
// toward black (negative) or white (positive), with +-255 reaching full
// white/black. Alpha is left alone.
void apply_brightness(std::array<float, 4>& color, long brightness);

}  // namespace lyp_util
