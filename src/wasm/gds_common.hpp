// Small helpers shared between bindings.cpp (parseGds, kept for
// non-graphical testing/debugging) and renderer.cpp (loadAndRenderGds).
#pragma once

#include <cstdio>
#include <cstring>

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

// Reads a GDSII or OASIS file into a Library, picking the reader by content.
// unit/tolerance mean the same thing for both readers; the detected format is
// reported through format_out so callers can word errors accordingly.
inline gdstk::Library read_layout(const char* path, double unit, double tolerance,
                                  FileFormat* format_out, gdstk::ErrorCode* error_code) {
    FileFormat format = detect_format(path);
    if (format_out) *format_out = format;
    if (format == FileFormat::Oasis) {
        return gdstk::read_oas(path, unit, tolerance, error_code);
    }
    return gdstk::read_gds(path, unit, tolerance, NULL, error_code);
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

}  // namespace gds_common
