// Small helpers shared between bindings.cpp (parseGds, kept for
// non-graphical testing/debugging) and renderer.cpp (loadAndRenderGds).
#pragma once

#include <cstring>

#include <gdstk/gdstk.hpp>

namespace gds_common {

inline const char* error_string(gdstk::ErrorCode error_code) {
    using gdstk::ErrorCode;
    switch (error_code) {
        case ErrorCode::NoError: return "";
        case ErrorCode::BooleanError: return "Boolean operation error";
        case ErrorCode::EmptyPath: return "Empty path";
        case ErrorCode::IntersectionNotFound: return "Intersection not found";
        case ErrorCode::MissingReference: return "Missing cell reference";
        case ErrorCode::UnsupportedRecord: return "Unsupported GDSII record";
        case ErrorCode::UnofficialSpecification: return "Unofficial GDSII specification";
        case ErrorCode::InvalidRepetition: return "Invalid repetition";
        case ErrorCode::Overflow: return "Overflow";
        case ErrorCode::ChecksumError: return "Checksum error";
        case ErrorCode::OutputFileOpenError: return "Could not open output file";
        case ErrorCode::InputFileOpenError: return "Could not open input file";
        case ErrorCode::InputFileError: return "Input file error";
        case ErrorCode::FileError: return "File error";
        case ErrorCode::InvalidFile: return "Invalid GDSII file";
        case ErrorCode::InsufficientMemory: return "Insufficient memory";
        case ErrorCode::ZlibError: return "Zlib error";
    }
    return "Unknown error";
}

// Errors strictly below ChecksumError are warnings: gdstk still produced a
// usable library, just flagging something odd about the input.
inline bool is_fatal(gdstk::ErrorCode error_code) {
    return error_code >= gdstk::ErrorCode::ChecksumError;
}

// Some tools (e.g. KLayout) emit a "$$$CONTEXT_INFO$$$" cell holding
// editor-state metadata as a sibling top-level cell. It's not part of the
// design and shouldn't be rendered.
inline bool is_metadata_cell(const gdstk::Cell* cell) {
    return cell->name && strncmp(cell->name, "$$$", 3) == 0;
}

}  // namespace gds_common
