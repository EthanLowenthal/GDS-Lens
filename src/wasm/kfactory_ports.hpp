// kfactory / gdsfactory port metadata.
//
// kfactory (the KLayout backend gdsfactory 8+ is built on) records each cell's
// ports as KLayout "meta info", which KLayout persists into the layout file
// itself rather than a sidecar: in GDSII as a `$$$CONTEXT_INFO$$$` cell holding
// one SREF per annotated cell whose PROPATTR/PROPVALUE records carry strings of
// the form `META('kfactory:ports:3')={'name'=>'o2',...}`, and in OASIS as a
// KLAYOUT_CONTEXT property on the cell with the same strings as its values. The
// values are KLayout tl::Variant "parsable strings": quoted strings, `#l500`
// numbers, `(a,b)` lists, `{'k'=>v}` dicts and `[trans:r90 100,200]` objects.
//
// This header reads those strings back into a per-cell list of ports -- name,
// type, position, direction, width, layer -- in the library's own coordinate
// unit, so a viewer can draw where a component's connections are without the
// Python stack that wrote them. Nothing here touches GL or embind; it runs in
// the parse worker under Node as readily as in the page.
#ifndef GDS_LENS_KFACTORY_PORTS_HPP
#define GDS_LENS_KFACTORY_PORTS_HPP

#include <string>
#include <unordered_map>
#include <vector>

#include <gdstk/gdstk.hpp>

namespace kfactory_ports {

struct PortDef {
    std::string name;
    // kfactory's port_type: "optical", "electrical", "placement", ... Free text.
    std::string type;
    // Position in the library's unit (microns in this viewer -- see read_layout).
    double x = 0.0, y = 0.0;
    // Direction the port faces, degrees counter-clockwise from +x, in [0, 360).
    double angle_deg = 0.0;
    // Width of the port's cross-section in the same unit; 0 when unknown.
    double width = 0.0;
    // The cross-section's main layer, when the file said; -1 otherwise.
    int32_t layer = -1, datatype = -1;
};

struct CellPorts {
    // Ports per cell, for every cell the file annotated (empty lists dropped).
    std::unordered_map<const gdstk::Cell*, std::vector<PortDef>> by_cell;
    uint64_t port_count = 0;
    // The file carried kfactory metadata at all (even if no cell had ports),
    // so the viewer can tell "no ports" from "not a kfactory file".
    bool present = false;
};

// Reads the kfactory context out of a library gdstk has already parsed.
// `dbu` is the size of one database unit in the library's unit (precision /
// unit), which is what the integer `trans` positions and `#l` widths are in.
CellPorts read(const gdstk::Library& lib, double dbu);

// Exposed for tests: the tl::Variant parsable-string reader.
struct Variant {
    enum class Kind { Nil, Bool, Number, String, List, Dict, Object };
    Kind kind = Kind::Nil;
    bool boolean = false;
    double number = 0.0;
    std::string text;  // String: the value. Object: the bracket body, e.g. "trans:r90 100,200".
    std::vector<Variant> items;                          // List
    std::vector<std::pair<std::string, Variant>> entries; // Dict, in file order

    const Variant* get(const char* key) const;
};

// Parses one parsable string. Tolerant: anything it does not understand comes
// back as a String holding the raw token, never an exception.
Variant parse_variant(const std::string& text);

// Splits `META('key')=value` (or `META("key",type)=value`) into its key and the
// value's raw text. Returns false for any other context string (LIB=, P(...)).
bool split_meta(const std::string& line, std::string& key, std::string& value);

}  // namespace kfactory_ports

#endif
