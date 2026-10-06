// Small helpers shared between bindings.cpp (parseGds, kept for
// non-graphical testing/debugging) and renderer.cpp (loadAndRenderGds).
#pragma once

#include <cstdio>
#include <cstring>
#include <vector>

#include <gdstk/gdstk.hpp>

namespace gds_common {

// The two layout formats the viewer reads. Both go through gdstk and land in
// the same Library type, so everything downstream of read_layout() is
// format-agnostic; the format is only kept around to word error messages.
enum class FileFormat { Gds, Oasis };

inline const char* format_name(FileFormat format) {
    return format == FileFormat::Oasis ? "OASIS" : "GDSII";
}

inline const char* error_string(gdstk::ErrorCode error_code, FileFormat format = FileFormat::Gds) {
    using gdstk::ErrorCode;
    const bool oas = format == FileFormat::Oasis;
    switch (error_code) {
        case ErrorCode::NoError: return "";
        case ErrorCode::BooleanError: return "Boolean operation error";
        case ErrorCode::EmptyPath: return "Empty path";
        case ErrorCode::IntersectionNotFound: return "Intersection not found";
        case ErrorCode::MissingReference: return "Missing cell reference";
        case ErrorCode::UnsupportedRecord:
            return oas ? "Unsupported OASIS record" : "Unsupported GDSII record";
        case ErrorCode::UnofficialSpecification:
            return oas ? "Unofficial OASIS specification" : "Unofficial GDSII specification";
        case ErrorCode::InvalidRepetition: return "Invalid repetition";
        case ErrorCode::Overflow: return "Overflow";
        case ErrorCode::ChecksumError: return "Checksum error";
        case ErrorCode::OutputFileOpenError: return "Could not open output file";
        case ErrorCode::InputFileOpenError: return "Could not open input file";
        case ErrorCode::InputFileError: return "Input file error";
        case ErrorCode::FileError: return "File error";
        case ErrorCode::InvalidFile: return oas ? "Invalid OASIS file" : "Invalid GDSII file";
        case ErrorCode::InsufficientMemory: return "Insufficient memory";
        case ErrorCode::ZlibError: return "Zlib error";
    }
    return "Unknown error";
}

// An OASIS file always opens with the magic string below (immediately followed
// by the START record's 0x01 id); anything else is treated as GDSII, whose own
// header check then rejects genuine garbage. Sniffing the bytes rather than
// the filename means the JS side can keep staging the file into MEMFS under
// one fixed name, and matches how marker databases are already detected.
inline FileFormat detect_format(const char* path) {
    static const char kOasisMagic[] = "%SEMI-OASIS\r\n";
    const size_t magic_length = sizeof(kOasisMagic) - 1;

    FILE* file = fopen(path, "rb");
    // Unreadable: fall through to read_gds, which reports the open error.
    if (!file) return FileFormat::Gds;
    char header[magic_length];
    size_t read = fread(header, 1, magic_length, file);
    fclose(file);

    if (read == magic_length && memcmp(header, kOasisMagic, magic_length) == 0) {
        return FileFormat::Oasis;
    }
    return FileFormat::Gds;
}

// Drops every polygon whose tag isn't in shape_tags, for the OASIS path --
// read_oas has no filter argument of its own, unlike read_gds. Labels are left
// alone either way: the filter selects *geometry*, and which worker keeps the
// labels is decided above this (see parseGdsToLayers).
inline void filter_shape_tags(gdstk::Library& lib, const gdstk::Set<gdstk::Tag>& shape_tags) {
    for (uint64_t c = 0; c < lib.cell_array.count; c++) {
        gdstk::Cell* cell = lib.cell_array[c];
        gdstk::Array<gdstk::Polygon*>& polys = cell->polygon_array;
        uint64_t kept = 0;
        for (uint64_t i = 0; i < polys.count; i++) {
            gdstk::Polygon* poly = polys[i];
            if (shape_tags.has_value(poly->tag)) {
                polys[kept++] = poly;
            } else {
                poly->clear();
                gdstk::free_allocation(poly);
            }
        }
        polys.count = kept;

        gdstk::Array<gdstk::FlexPath*>& paths = cell->flexpath_array;
        kept = 0;
        for (uint64_t i = 0; i < paths.count; i++) {
            gdstk::FlexPath* path = paths[i];
            if (path->num_elements > 0 && shape_tags.has_value(path->elements[0].tag)) {
                paths[kept++] = path;
            } else {
                path->clear();
                gdstk::free_allocation(path);
            }
        }
        paths.count = kept;
    }
}

// Reads a GDSII or OASIS file into a Library, picking the reader by content.
// unit/tolerance mean the same thing for both readers; the detected format is
// reported through format_out so callers can word errors accordingly.
//
// shape_tags, when non-NULL, keeps only geometry on those layer/datatype pairs
// -- the split one parse worker reads for (see parseGdsToLayers). read_gds
// takes it directly; read_oas has no equivalent, so OASIS is filtered after
// the fact. Either way the *records* are all still read, so this saves
// retained memory rather than parse time.
inline gdstk::Library read_layout(const char* path, double unit, double tolerance,
                                  FileFormat* format_out, gdstk::ErrorCode* error_code,
                                  const gdstk::Set<gdstk::Tag>* shape_tags = NULL) {
    FileFormat format = detect_format(path);
    if (format_out) *format_out = format;
    if (format == FileFormat::Oasis) {
        gdstk::Library lib = gdstk::read_oas(path, unit, tolerance, error_code);
        if (shape_tags) filter_shape_tags(lib, *shape_tags);
        return lib;
    }
    return gdstk::read_gds(path, unit, tolerance, shape_tags, error_code);
}

// Errors strictly below ChecksumError are warnings: gdstk still produced a
// usable library, just flagging something odd about the input.
inline bool is_fatal(gdstk::ErrorCode error_code) {
    return error_code >= gdstk::ErrorCode::ChecksumError;
}

// Some tools emit a "$$$CONTEXT_INFO$$$" cell holding
// editor-state metadata as a sibling top-level cell. It's not part of the
// design and shouldn't be rendered.
inline bool is_metadata_cell(const gdstk::Cell* cell) {
    return cell->name && strncmp(cell->name, "$$$", 3) == 0;
}

// The cells a layout is drawn from when no top cell was chosen: every
// non-metadata top cell, or -- if the hierarchy has no clean root (e.g. a
// reference cycle) -- the last cell defined, mirroring common GDS tooling.
// Shared by the parse and the inspect index (inspect.cpp), which have to agree
// on what is drawn for a click to find what is on screen.
inline std::vector<gdstk::Cell*> default_roots(const gdstk::Library& lib) {
    gdstk::Array<gdstk::Cell*> top_cells = {};
    gdstk::Array<gdstk::RawCell*> top_rawcells = {};
    lib.top_level(top_cells, top_rawcells);
    std::vector<gdstk::Cell*> roots;
    for (uint64_t i = 0; i < top_cells.count; i++) {
        if (!is_metadata_cell(top_cells[i])) roots.push_back(top_cells[i]);
    }
    if (roots.empty() && lib.cell_array.count > 0) {
        roots.push_back(lib.cell_array[lib.cell_array.count - 1]);
    }
    top_cells.clear();
    top_rawcells.clear();
    return roots;
}

}  // namespace gds_common
