#include "kfactory_ports.hpp"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>

namespace kfactory_ports {

using gdstk::Cell;
using gdstk::Library;
using gdstk::Property;
using gdstk::PropertyType;
using gdstk::PropertyValue;
using gdstk::Reference;
using gdstk::ReferenceType;

namespace {

// ---- tl::Variant parsable strings --------------------------------------

struct Cursor {
    const std::string& s;
    size_t i = 0;
    explicit Cursor(const std::string& text) : s(text) {}
    bool done() const { return i >= s.size(); }
    char peek() const { return done() ? '\0' : s[i]; }
    void skip_ws() {
        while (!done() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
    }
    bool accept(char c) {
        skip_ws();
        if (peek() == c) {
            i++;
            return true;
        }
        return false;
    }
};

// A quoted string with backslash escapes, or -- when the cursor is not on a
// quote -- a bare word (letters, digits, _ . : - +), which is how KLayout
// writes a key that needs no quoting.
std::string read_word_or_quoted(Cursor& c) {
    c.skip_ws();
    std::string out;
    char q = c.peek();
    if (q == '\'' || q == '"') {
        c.i++;
        while (!c.done()) {
            char ch = c.s[c.i++];
            if (ch == '\\' && !c.done()) {
                char e = c.s[c.i++];
                switch (e) {
                    case 'n': out += '\n'; break;
                    case 't': out += '\t'; break;
                    case 'r': out += '\r'; break;
                    default: out += e; break;
                }
            } else if (ch == q) {
                break;
            } else {
                out += ch;
            }
        }
        return out;
    }
    while (!c.done()) {
        char ch = c.s[c.i];
        if (isalnum((unsigned char)ch) || ch == '_' || ch == '.' || ch == ':' || ch == '-' || ch == '+' ||
            ch == '$') {
            out += ch;
            c.i++;
        } else {
            break;
        }
    }
    return out;
}

Variant parse_value(Cursor& c, int depth);

// `[class:body]` -- the body runs to the matching bracket; nested brackets
// (a layer's "(1/0)" is parenthesised, not bracketed, but be safe) are counted.
Variant parse_object(Cursor& c) {
    Variant v;
    v.kind = Variant::Kind::Object;
    c.i++;  // '['
    int level = 1;
    while (!c.done()) {
        char ch = c.s[c.i++];
        if (ch == '[') {
            level++;
        } else if (ch == ']') {
            if (--level == 0) break;
        }
        v.text += ch;
    }
    return v;
}

Variant parse_list(Cursor& c, int depth) {
    Variant v;
    v.kind = Variant::Kind::List;
    c.i++;  // '('
    if (c.accept(')')) return v;
    while (!c.done()) {
        v.items.push_back(parse_value(c, depth + 1));
        if (c.accept(',')) continue;
        c.accept(')');
        break;
    }
    return v;
}

Variant parse_dict(Cursor& c, int depth) {
    Variant v;
    v.kind = Variant::Kind::Dict;
    c.i++;  // '{'
    if (c.accept('}')) return v;
    while (!c.done()) {
        Variant key = parse_value(c, depth + 1);
        std::string key_text = key.kind == Variant::Kind::String ? key.text : std::string();
        if (key.kind == Variant::Kind::Number) key_text = std::to_string((long long)key.number);
        c.skip_ws();
        if (c.s.compare(c.i, 2, "=>") == 0) c.i += 2;
        Variant value = parse_value(c, depth + 1);
        v.entries.emplace_back(key_text, std::move(value));
        if (c.accept(',')) continue;
        c.accept('}');
        break;
    }
    return v;
}

// Everything up to the next delimiter: a `#l500` / `##1.5` / `#u3` number, a
// bare `nil`, `true`, `false`, or a word.
Variant parse_token(Cursor& c) {
    Variant v;
    std::string tok;
    while (!c.done()) {
        char ch = c.s[c.i];
        if (ch == ',' || ch == ')' || ch == '}' || ch == ']' || ch == ' ' || ch == '\n') break;
        tok += ch;
        c.i++;
    }
    if (tok == "nil") return v;
    if (tok == "true" || tok == "false") {
        v.kind = Variant::Kind::Bool;
        v.boolean = tok == "true";
        return v;
    }
    if (!tok.empty() && tok[0] == '#') {
        // "#" then a type tag of letters ("l", "lu", "ll", "u", "f", "" for
        // int, "#" for double, "c"/"s"/...), then the digits.
        size_t p = 1;
        while (p < tok.size() && (isalpha((unsigned char)tok[p]) || tok[p] == '#')) p++;
        const char* digits = tok.c_str() + p;
        char* end = nullptr;
        double value = strtod(digits, &end);
        if (end != digits) {
            v.kind = Variant::Kind::Number;
            v.number = value;
            return v;
        }
    }
    // A bare number without a tag (older writers), else raw text.
    char* end = nullptr;
    double value = strtod(tok.c_str(), &end);
    if (!tok.empty() && end && *end == '\0') {
        v.kind = Variant::Kind::Number;
        v.number = value;
        return v;
    }
    v.kind = Variant::Kind::String;
    v.text = tok;
    return v;
}

Variant parse_value(Cursor& c, int depth) {
    c.skip_ws();
    if (depth > 64 || c.done()) return Variant{};
    char ch = c.peek();
    if (ch == '\'' || ch == '"') {
        Variant v;
        v.kind = Variant::Kind::String;
        v.text = read_word_or_quoted(c);
        return v;
    }
    if (ch == '[') return parse_object(c);
    if (ch == '(') return parse_list(c, depth);
    if (ch == '{') return parse_dict(c, depth);
    return parse_token(c);
}

// ---- KLayout transformation strings ------------------------------------

// "r90 100,200" / "m45 *1 141.421,296.985" / "r0 *1.5 1,2": the rotation code
// (r<deg> or m<axis angle>, a mirror at the x axis followed by a rotation of
// twice the axis angle), an optional magnification, then the displacement.
// KLayout prints half the rotation for m codes -- m45 is "mirror, then r90" --
// so the direction a port faces is 2a for a mirrored transform and a otherwise.
struct TransParts {
    double angle_deg = 0.0;
    bool mirror = false;
    double mag = 1.0;
    double x = 0.0, y = 0.0;
    bool ok = false;
};

TransParts parse_trans_body(const std::string& body) {
    TransParts t;
    size_t i = 0;
    auto skip_ws = [&]() {
        while (i < body.size() && body[i] == ' ') i++;
    };
    skip_ws();
    if (i >= body.size()) return t;
    char code = body[i];
    if (code != 'r' && code != 'm') return t;
    i++;
    char* end = nullptr;
    double a = strtod(body.c_str() + i, &end);
    if (end == body.c_str() + i) return t;
    i = (size_t)(end - body.c_str());
    t.mirror = code == 'm';
    t.angle_deg = t.mirror ? 2.0 * a : a;
    skip_ws();
    if (i < body.size() && body[i] == '*') {
        i++;
        double m = strtod(body.c_str() + i, &end);
        if (end != body.c_str() + i) {
            t.mag = m;
            i = (size_t)(end - body.c_str());
        }
    }
    skip_ws();
    double x = strtod(body.c_str() + i, &end);
    if (end == body.c_str() + i) return t;
    i = (size_t)(end - body.c_str());
    if (i < body.size() && body[i] == ',') i++;
    double y = strtod(body.c_str() + i, &end);
    if (end == body.c_str() + i) return t;
    t.x = x;
    t.y = y;
    t.ok = true;
    return t;
}

// The object body of a `[layer:...]`: KLayout's LayerInfo string, "WG (1/0)",
// "1/0", "1/0 (name)" or a bare name. The layer/datatype pair is the "L/D" that
// appears in it; -1/-1 when there is none.
void parse_layer_body(const std::string& body, int32_t& layer, int32_t& datatype) {
    layer = -1;
    datatype = -1;
    size_t slash = body.find('/');
    if (slash == std::string::npos) return;
    // Digits run backwards from the slash for the layer, forwards for the type.
    size_t ls = slash;
    while (ls > 0 && isdigit((unsigned char)body[ls - 1])) ls--;
    size_t de = slash + 1;
    while (de < body.size() && isdigit((unsigned char)body[de])) de++;
    if (ls == slash || de == slash + 1) return;
    layer = atoi(body.substr(ls, slash - ls).c_str());
    datatype = atoi(body.substr(slash + 1, de - slash - 1).c_str());
}

double normalize_deg(double a) {
    a = std::fmod(a, 360.0);
    if (a < 0) a += 360.0;
    // -0.0 and rounding dust from the fmod.
    if (std::fabs(a) < 1e-9 || std::fabs(a - 360.0) < 1e-9) a = 0.0;
    return a;
}

// ---- Context strings out of gdstk properties ----------------------------

// Collects the context strings attached to one element, in KLayout's order.
// GDSII: gdstk keeps each PROPATTR/PROPVALUE pair as an "S_GDS_PROPERTY" entry
// whose values are [attribute, string]; the attribute is the string's index,
// and a string over 32000 bytes was split into "#<n>,<part>:<payload>" pieces
// (KLayout issue #1794) that are put back together here. OASIS: the strings are
// the values of a property named KLAYOUT_CONTEXT.
void collect_context_strings(const Property* props, std::vector<std::string>& out) {
    std::map<long, std::string> plain;                      // index -> string
    std::map<long, std::map<long, std::string>> chunked;    // index -> part -> payload
    for (const Property* p = props; p; p = p->next) {
        if (!p->name) continue;
        if (strcmp(p->name, "S_GDS_PROPERTY") == 0) {
            const PropertyValue* attr = p->value;
            if (!attr || attr->type != PropertyType::UnsignedInteger || !attr->next) continue;
            const PropertyValue* sv = attr->next;
            if (sv->type != PropertyType::String) continue;
            std::string s((const char*)sv->bytes, sv->count);
            while (!s.empty() && s.back() == '\0') s.pop_back();
            if (!s.empty() && s[0] == '#') {
                // "#n,p:" -- a piece of a longer string.
                char* end = nullptr;
                long n = strtol(s.c_str() + 1, &end, 10);
                if (end && *end == ',') {
                    char* end2 = nullptr;
                    long part = strtol(end + 1, &end2, 10);
                    if (end2 && *end2 == ':') {
                        chunked[n][part] = std::string(end2 + 1);
                        continue;
                    }
                }
            }
            plain[(long)attr->unsigned_integer] = std::move(s);
        } else if (strcmp(p->name, "KLAYOUT_CONTEXT") == 0) {
            long idx = 0;
            for (const PropertyValue* v = p->value; v; v = v->next, idx++) {
                if (v->type != PropertyType::String) continue;
                std::string s((const char*)v->bytes, v->count);
                while (!s.empty() && s.back() == '\0') s.pop_back();
                plain[idx] = std::move(s);
            }
        }
    }
    for (auto& kv : chunked) {
        std::string whole;
        for (auto& part : kv.second) whole += part.second;
        plain[kv.first] = std::move(whole);
    }
    for (auto& kv : plain) out.push_back(std::move(kv.second));
}

struct CrossSection {
    double width = 0.0;  // dbu
    std::string enclosure;
    int32_t layer = -1, datatype = -1;
};

struct Globals {
    std::unordered_map<std::string, CrossSection> cross_sections;
    // layer_enclosure name -> main layer
    std::unordered_map<std::string, std::pair<int32_t, int32_t>> enclosures;
    bool present = false;
};

void read_globals(const std::vector<std::string>& lines, Globals& g) {
    for (const std::string& line : lines) {
        std::string key, value;
        if (!split_meta(line, key, value)) continue;
        if (key.compare(0, 9, "kfactory:") != 0) continue;
        g.present = true;
        const char* xs_prefix = "kfactory:cross_section:";
        const char* enc_prefix = "kfactory:layer_enclosure:";
        if (key.compare(0, strlen(xs_prefix), xs_prefix) == 0) {
            Variant v = parse_variant(value);
            CrossSection xs;
            if (const Variant* w = v.get("width")) xs.width = w->number;
            if (const Variant* e = v.get("layer_enclosure")) xs.enclosure = e->text;
            // Older formats put the layer on the cross-section itself.
            if (const Variant* l = v.get("layer")) {
                if (l->kind == Variant::Kind::Object) parse_layer_body(l->text, xs.layer, xs.datatype);
            }
            g.cross_sections[key.substr(strlen(xs_prefix))] = xs;
        } else if (key.compare(0, strlen(enc_prefix), enc_prefix) == 0) {
            Variant v = parse_variant(value);
            int32_t layer = -1, datatype = -1;
            if (const Variant* l = v.get("main_layer")) {
                if (l->kind == Variant::Kind::Object) parse_layer_body(l->text, layer, datatype);
            }
            g.enclosures[key.substr(strlen(enc_prefix))] = {layer, datatype};
        }
    }
}

// One cell's strings -> its ports. Two layouts of the keys exist: the current
// one, `kfactory:ports:<i>` holding a dict of the port, and the older
// per-field one, `kfactory:ports:<i>:<field>`. Both collect into the same
// per-index dict here.
void read_cell_ports(const std::vector<std::string>& lines, const Globals& g, double dbu,
                     std::vector<PortDef>& out) {
    std::map<long, std::vector<std::pair<std::string, Variant>>> per_index;
    const char* prefix = "kfactory:ports:";
    for (const std::string& line : lines) {
        std::string key, value;
        if (!split_meta(line, key, value)) continue;
        if (key.compare(0, strlen(prefix), prefix) != 0) continue;
        std::string rest = key.substr(strlen(prefix));
        size_t colon = rest.find(':');
        char* end = nullptr;
        long index = strtol(rest.c_str(), &end, 10);
        if (end == rest.c_str()) continue;
        Variant v = parse_variant(value);
        if (colon == std::string::npos) {
            if (v.kind == Variant::Kind::Dict) {
                for (auto& e : v.entries) per_index[index].emplace_back(e.first, std::move(e.second));
            }
        } else {
            per_index[index].emplace_back(rest.substr(colon + 1), std::move(v));
        }
    }

    for (auto& kv : per_index) {
        Variant dict;
        dict.kind = Variant::Kind::Dict;
        dict.entries = std::move(kv.second);
        PortDef port;
        if (const Variant* n = dict.get("name")) port.name = n->text;
        if (const Variant* t = dict.get("port_type")) port.type = t->text;
        if (port.name.empty()) port.name = std::to_string(kv.first);

        bool placed = false;
        if (const Variant* t = dict.get("trans")) {
            if (t->kind == Variant::Kind::Object && t->text.compare(0, 6, "trans:") == 0) {
                TransParts parts = parse_trans_body(t->text.substr(6));
                if (parts.ok) {
                    port.x = parts.x * dbu;
                    port.y = parts.y * dbu;
                    port.angle_deg = normalize_deg(parts.angle_deg);
                    placed = true;
                }
            }
        }
        if (!placed) {
            if (const Variant* t = dict.get("dcplx_trans")) {
                if (t->kind == Variant::Kind::Object) {
                    size_t colon = t->text.find(':');
                    TransParts parts = parse_trans_body(colon == std::string::npos ? t->text : t->text.substr(colon + 1));
                    if (parts.ok) {
                        port.x = parts.x;
                        port.y = parts.y;
                        port.angle_deg = normalize_deg(parts.angle_deg);
                        placed = true;
                    }
                }
            }
        }
        if (!placed) continue;  // a port with no position is nothing to draw

        // Width and layer: from the named cross-section (current format), else
        // from the port's own fields (older formats wrote width in dbu and the
        // layer directly on the port).
        if (const Variant* xs = dict.get("cross_section")) {
            auto found = g.cross_sections.find(xs->text);
            if (found != g.cross_sections.end()) {
                port.width = found->second.width * dbu;
                port.layer = found->second.layer;
                port.datatype = found->second.datatype;
                if (port.layer < 0) {
                    auto enc = g.enclosures.find(found->second.enclosure);
                    if (enc != g.enclosures.end()) {
                        port.layer = enc->second.first;
                        port.datatype = enc->second.second;
                    }
                }
            }
        }
        if (port.width <= 0.0) {
            if (const Variant* w = dict.get("width")) port.width = w->number * dbu;
            else if (const Variant* w = dict.get("dwidth")) port.width = w->number;
        }
        if (port.layer < 0) {
            if (const Variant* l = dict.get("layer")) {
                if (l->kind == Variant::Kind::Object) parse_layer_body(l->text, port.layer, port.datatype);
            }
        }
        out.push_back(std::move(port));
    }
}

}  // namespace

const Variant* Variant::get(const char* key) const {
    if (kind != Kind::Dict) return nullptr;
    for (const auto& e : entries) {
        if (e.first == key) return &e.second;
    }
    return nullptr;
}

Variant parse_variant(const std::string& text) {
    Cursor c(text);
    return parse_value(c, 0);
}

bool split_meta(const std::string& line, std::string& key, std::string& value) {
    if (line.compare(0, 5, "META(") != 0) return false;
    Cursor c(line);
    c.i = 5;
    key = read_word_or_quoted(c);
    if (c.accept(',')) read_word_or_quoted(c);  // the value's type name; unused
    if (!c.accept(')')) return false;
    if (!c.accept('=')) return false;
    c.skip_ws();
    value = line.substr(c.i);
    return true;
}

CellPorts read(const Library& lib, double dbu) {
    CellPorts result;
    if (!(dbu > 0.0)) dbu = 1.0;

    // Where the strings are. GDSII: the $$$CONTEXT_INFO$$$ cell -- library-wide
    // strings on its one dummy BOUNDARY, per-cell strings on an SREF to each
    // cell. OASIS: KLAYOUT_CONTEXT properties on the library and on each cell.
    Globals globals;
    std::vector<std::string> lines;

    collect_context_strings(lib.properties, lines);
    read_globals(lines, globals);

    const Cell* context_cell = nullptr;
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        const Cell* cell = lib.cell_array[i];
        if (cell->name && strcmp(cell->name, "$$$CONTEXT_INFO$$$") == 0) {
            context_cell = cell;
            break;
        }
    }
    if (context_cell) {
        for (uint64_t i = 0; i < context_cell->polygon_array.count; i++) {
            lines.clear();
            collect_context_strings(context_cell->polygon_array[i]->properties, lines);
            read_globals(lines, globals);
        }
    }

    auto take_cell = [&](const Cell* cell, const Property* props) {
        lines.clear();
        collect_context_strings(props, lines);
        if (lines.empty()) return;
        for (const std::string& line : lines) {
            if (line.find("kfactory:") != std::string::npos) {
                globals.present = true;
                break;
            }
        }
        std::vector<PortDef> ports;
        read_cell_ports(lines, globals, dbu, ports);
        if (ports.empty()) return;
        result.port_count += ports.size();
        auto& slot = result.by_cell[cell];
        slot.insert(slot.end(), ports.begin(), ports.end());
    };

    if (context_cell) {
        for (uint64_t r = 0; r < context_cell->reference_array.count; r++) {
            const Reference* ref = context_cell->reference_array[r];
            if (ref->type != ReferenceType::Cell || ref->cell == nullptr) continue;
            take_cell(ref->cell, ref->properties);
        }
    }
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        const Cell* cell = lib.cell_array[i];
        if (cell == context_cell) continue;
        take_cell(cell, cell->properties);
    }

    result.present = globals.present;
    return result;
}

}  // namespace kfactory_ports
