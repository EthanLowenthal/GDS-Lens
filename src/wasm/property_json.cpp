#include "property_json.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

using gdstk::Property;
using gdstk::PropertyType;
using gdstk::PropertyValue;

namespace property_json {

namespace {

// Length of a valid UTF-8 sequence starting at s[i], or 0 if there is none.
size_t utf8_length(const uint8_t* s, size_t n, size_t i) {
    const uint8_t c = s[i];
    size_t len = 0;
    uint32_t min = 0;
    if (c < 0x80) return 1;
    if ((c & 0xE0) == 0xC0) len = 2, min = 0x80;
    else if ((c & 0xF0) == 0xE0) len = 3, min = 0x800;
    else if ((c & 0xF8) == 0xF0) len = 4, min = 0x10000;
    else return 0;
    if (i + len > n) return 0;
    uint32_t code = c & (0x7F >> len);
    for (size_t k = 1; k < len; k++) {
        if ((s[i + k] & 0xC0) != 0x80) return 0;
        code = (code << 6) | (s[i + k] & 0x3F);
    }
    if (code < min || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return 0;
    return len;
}

void append_hex(std::string& out, uint8_t byte) {
    static const char digits[] = "0123456789abcdef";
    out += "\\\\x";  // a literal backslash in the JSON text, then xNN
    out += digits[byte >> 4];
    out += digits[byte & 15];
}

// Appends the bytes as a JSON string. Returns false when any of them had to
// be written as \xNN.
bool append_string(std::string& out, const uint8_t* bytes, size_t count) {
    // GDSII pads to an even length with NUL, and gdstk adds one more.
    while (count > 0 && bytes[count - 1] == 0) count--;
    bool text = true;
    out += '"';
    for (size_t i = 0; i < count;) {
        const uint8_t c = bytes[i];
        if (c == '"' || c == '\\') {
            out += '\\';
            out += (char)c;
            i++;
        } else if (c == '\n') {
            out += "\\n";
            i++;
        } else if (c == '\r') {
            out += "\\r";
            i++;
        } else if (c == '\t') {
            out += "\\t";
            i++;
        } else if (c < 0x20 || c == 0x7F) {
            append_hex(out, c);
            text = false;
            i++;
        } else {
            const size_t len = utf8_length(bytes, count, i);
            if (len == 0) {
                append_hex(out, c);
                text = false;
                i++;
            } else {
                out.append((const char*)bytes + i, len);
                i += len;
            }
        }
    }
    out += '"';
    return text;
}

void append_number(std::string& out, double value) {
    if (!std::isfinite(value)) {
        out += "null";
        return;
    }
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.17g", value);
    // The shortest form that reads back the same, so 0.2 is not 0.20000000000000001.
    for (int digits = 1; digits <= 17; digits++) {
        char shorter[32];
        std::snprintf(shorter, sizeof shorter, "%.*g", digits, value);
        if (std::strtod(shorter, nullptr) == value) {
            out += shorter;
            return;
        }
    }
    out += buf;
}

// Appends one value; returns false when it was a string that is not text.
bool append_value(std::string& out, const PropertyValue* v) {
    switch (v->type) {
        case PropertyType::UnsignedInteger:
            out += std::to_string(v->unsigned_integer);
            return true;
        case PropertyType::Integer:
            out += std::to_string(v->integer);
            return true;
        case PropertyType::Real:
            append_number(out, v->real);
            return true;
        case PropertyType::String:
            return append_string(out, v->bytes, v->count);
    }
    out += "null";
    return true;
}

bool is_gds(const Property* p) {
    const PropertyValue* attr = p->value;
    return p->name && std::strcmp(p->name, "S_GDS_PROPERTY") == 0 && attr &&
           attr->type == PropertyType::UnsignedInteger && attr->next && attr->next->type == PropertyType::String &&
           !attr->next->next;
}

}  // namespace

std::string encode(const Property* properties) {
    // gdstk keeps the list newest first.
    std::vector<const Property*> order;
    for (const Property* p = properties; p; p = p->next) order.push_back(p);
    if (order.empty()) return std::string();
    std::string out = "[";
    for (size_t i = order.size(); i-- > 0;) {
        const Property* p = order[i];
        if (out.size() > 1) out += ',';
        bool text = true;
        if (is_gds(p)) {
            out += "{\"attr\":";
            out += std::to_string(p->value->unsigned_integer);
            out += ",\"value\":";
            text = append_string(out, p->value->next->bytes, p->value->next->count);
        } else {
            out += "{\"name\":";
            const char* name = p->name ? p->name : "";
            append_string(out, (const uint8_t*)name, std::strlen(name));
            out += ",\"values\":[";
            bool first = true;
            for (const PropertyValue* v = p->value; v; v = v->next) {
                if (!first) out += ',';
                first = false;
                text = append_value(out, v) && text;
            }
            out += ']';
        }
        if (!text) out += ",\"binary\":true";
        out += '}';
    }
    out += ']';
    return out;
}

uint32_t Table::intern(const Property* properties) {
    if (!properties) return 0;
    std::string encoded = encode(properties);
    if (encoded.empty()) return 0;
    auto found = ids_.find(encoded);
    if (found != ids_.end()) return found->second;
    lists_.push_back(encoded);
    const uint32_t id = (uint32_t)lists_.size();
    ids_.emplace(std::move(encoded), id);
    return id;
}

std::string Table::json() const {
    std::string out = "[";
    for (size_t i = 0; i < lists_.size(); i++) {
        if (i) out += ',';
        out += lists_[i];
    }
    out += ']';
    return out;
}

void Table::clear() {
    lists_.clear();
    ids_.clear();
}

}  // namespace property_json
