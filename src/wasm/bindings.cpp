// Embind glue exposing gdstk's GDSII reader/flattener to the webview.
//
// The webview stages the raw .gds bytes into Emscripten's in-memory FS
// (MEMFS) and calls parseGds() with the path. gdstk::read_gds() only takes a
// filename (it does FILE* I/O internally), so MEMFS is the simplest way to
// hand it bytes that originated from a postMessage payload.

#include <cstring>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <gdstk/gdstk.hpp>

#include "gds_common.hpp"

using namespace emscripten;
using namespace gdstk;

namespace {

// Copies wasm-heap doubles into a freshly allocated JS Float64Array. The
// Float64Array.set() call below copies the bytes out synchronously, so the
// returned val does not depend on the source memory staying alive or in
// place (relevant if the heap is later resized).
val to_float64_array(const double* data, size_t count) {
    val array = val::global("Float64Array").new_(count);
    array.call<void>("set", typed_memory_view(count, data));
    return array;
}

void flatten_cell_into(Cell* cell, val& geometry) {
    Array<Polygon*> polygons = {};
    // apply_repetitions: expand AREF/array repetitions into individual
    // polygons. include_paths: convert FlexPath/RobustPath outlines to
    // polygons too. depth = -1: recurse through the full reference tree.
    cell->get_polygons(true, true, -1, false, 0, polygons);

    for (uint64_t i = 0; i < polygons.count; i++) {
        Polygon* poly = polygons[i];

        val entry = val::object();
        entry.set("layer", get_layer(poly->tag));
        entry.set(
            "points",
            to_float64_array(reinterpret_cast<const double*>(poly->point_array.items),
                              poly->point_array.count * 2));
        geometry.call<void>("push", entry);

        poly->clear();
        free_allocation(poly);
    }
    polygons.clear();
}

}  // namespace

val parseGds(const std::string& path) {
    val result = val::object();

    ErrorCode error_code = ErrorCode::NoError;
    // unit = 1e-6 normalizes every file to micron-scale coordinates
    // regardless of its native database unit, so the renderer never needs to
    // know about per-file scale factors.
    Library lib = read_gds(path.c_str(), 1e-6, 1e-2, NULL, &error_code);

    if (gds_common::is_fatal(error_code)) {
        result.set("ok", false);
        result.set("error", std::string(gds_common::error_string(error_code)));
        lib.free_all();
        return result;
    }

    Array<Cell*> top_cells = {};
    Array<RawCell*> top_rawcells = {};
    lib.top_level(top_cells, top_rawcells);

    val geometry = val::array();

    uint64_t rendered_top_cells = 0;
    for (uint64_t i = 0; i < top_cells.count; i++) {
        if (gds_common::is_metadata_cell(top_cells[i])) continue;
        flatten_cell_into(top_cells[i], geometry);
        rendered_top_cells++;
    }

    if (rendered_top_cells == 0 && lib.cell_array.count > 0) {
        // No unreferenced cell found (e.g. a reference cycle) -- fall back to
        // the last cell defined in the file, mirroring common GDS tooling
        // behavior when the hierarchy doesn't have a clean root.
        flatten_cell_into(lib.cell_array[lib.cell_array.count - 1], geometry);
    }

    top_cells.clear();
    top_rawcells.clear();

    result.set("ok", true);
    result.set("error", std::string(gds_common::error_string(error_code)));
    result.set("dbuPerMicron", 1.0);
    result.set("geometry", geometry);

    lib.free_all();
    return result;
}

EMSCRIPTEN_BINDINGS(gdstk_module) {
    function("parseGds", &parseGds);
}
