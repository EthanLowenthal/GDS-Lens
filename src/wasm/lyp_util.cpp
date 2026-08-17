#include "lyp_util.hpp"

#include <algorithm>
#include <cstdlib>

namespace lyp_util {

size_t find_open_tag(const std::string& text, const char* tag, size_t from, size_t& content_start) {
    std::string prefix = std::string("<") + tag;
    size_t pos = text.find(prefix, from);
    while (pos != std::string::npos) {
        size_t after = pos + prefix.length();
        char c = after < text.length() ? text[after] : '\0';
        if (c == '>') {
            content_start = after + 1;
            return pos;
        }
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            size_t gt = text.find('>', after);
            if (gt == std::string::npos) return std::string::npos;
            if (text[gt - 1] != '/') {
                content_start = gt + 1;
                return pos;
            }
        }
        // '/' (self-closing), or a longer tag name that merely starts with
        // `tag` (e.g. <name> vs <names>) -- keep scanning.
        pos = text.find(prefix, pos + prefix.length());
    }
    return std::string::npos;
}

std::string xml_unescape(const std::string& s) {
    if (s.find('&') == std::string::npos) return s;
    std::string out;
    out.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        if (s[i] != '&') {
            out += s[i++];
            continue;
        }
        size_t semi = s.find(';', i + 1);
        // Entities are short; a far-away ';' means this '&' is just a bare
        // ampersand in the text (technically invalid XML, but tolerated).
        if (semi == std::string::npos || semi - i > 10) {
            out += s[i++];
            continue;
        }
        std::string ent = s.substr(i + 1, semi - i - 1);
        long code = -1;
        if (ent == "amp") code = '&';
        else if (ent == "lt") code = '<';
        else if (ent == "gt") code = '>';
        else if (ent == "quot") code = '"';
        else if (ent == "apos") code = '\'';
        else if (ent.size() > 1 && ent[0] == '#') {
            code = (ent[1] == 'x' || ent[1] == 'X') ? strtol(ent.c_str() + 2, nullptr, 16)
                                                    : strtol(ent.c_str() + 1, nullptr, 10);
        }
        if (code <= 0 || code > 0x10FFFF) {
            out += s[i++];  // unknown entity -- pass the '&' through untouched
            continue;
        }
        // UTF-8 encode; embind hands the result back to JS as UTF-8.
        if (code < 0x80) {
            out += (char)code;
        } else if (code < 0x800) {
            out += (char)(0xC0 | (code >> 6));
            out += (char)(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
            out += (char)(0xE0 | (code >> 12));
            out += (char)(0x80 | ((code >> 6) & 0x3F));
            out += (char)(0x80 | (code & 0x3F));
        } else {
            out += (char)(0xF0 | (code >> 18));
            out += (char)(0x80 | ((code >> 12) & 0x3F));
            out += (char)(0x80 | ((code >> 6) & 0x3F));
            out += (char)(0x80 | (code & 0x3F));
        }
        i = semi + 1;
    }
    return out;
}

std::string strip_xml_comments(const std::string& text) {
    size_t c = text.find("<!--");
    if (c == std::string::npos) return text;
    std::string out;
    out.reserve(text.size());
    size_t pos = 0;
    while (c != std::string::npos) {
        out.append(text, pos, c - pos);
        size_t e = text.find("-->", c + 4);
        if (e == std::string::npos) return out;  // unterminated -- drop the rest
        pos = e + 3;
        c = text.find("<!--", pos);
    }
    out.append(text, pos, text.size() - pos);
    return out;
}

bool extract_tag_value(const std::string& block, const char* tag, std::string& out) {
    size_t content_start = 0;
    size_t open_pos = find_open_tag(block, tag, 0, content_start);
    if (open_pos == std::string::npos) return false;
    std::string close_tag = std::string("</") + tag + ">";
    size_t close_pos = block.find(close_tag, content_start);
    if (close_pos == std::string::npos) return false;
    out = xml_unescape(block.substr(content_start, close_pos - content_start));
    return true;
}

std::string trim(const std::string& s) {
    size_t start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(start, end - start + 1);
}

std::array<float, 4> hex_to_rgba(const std::string& hex_in, float alpha) {
    std::string hex = trim(hex_in);
    if (!hex.empty() && hex[0] == '#') hex = hex.substr(1);
    if (hex.size() != 6) return {0.0f, 0.0f, 0.0f, 0.0f};

    char byte_buf[3] = {0, 0, 0};
    auto hex_byte = [&](size_t pos) -> float {
        byte_buf[0] = hex[pos];
        byte_buf[1] = hex[pos + 1];
        return (float)strtol(byte_buf, nullptr, 16);
    };
    return {hex_byte(0) / 255.0f, hex_byte(2) / 255.0f, hex_byte(4) / 255.0f, alpha};
}

void apply_brightness(std::array<float, 4>& color, long brightness) {
    if (brightness == 0) return;
    float t = (float)std::max(-255l, std::min(255l, brightness)) / 255.0f;
    for (int i = 0; i < 3; i++) {
        color[i] = t > 0 ? color[i] + (1.0f - color[i]) * t : color[i] * (1.0f + t);
    }
}

}  // namespace lyp_util
