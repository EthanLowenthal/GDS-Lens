// Turns the bytes read off disk into the bytes the viewer parses: a gzipped
// layout (`.gds.gz` and friends) is expanded here, and everything downstream --
// the webview, the parse Worker, the wasm module's own GDSII/OASIS sniffing --
// sees exactly what an uncompressed file would have produced.
//
// Expanding in the extension host rather than in the webview or the wasm module
// is a memory decision. The viewer's entire size budget is the 32-bit wasm heap:
// the file's bytes and the flattened geometry built from them both have to fit
// in 4 GB (see DEVELOPING.md), and that heap is the one address space that can
// least afford a second full copy of the file. Node has no such ceiling, so
// doing it here spends the compressed copy and zlib's scratch space where they
// cost nothing, and hands the wasm side a single buffer.
//
// Standalone, Node builtins only, with a module.exports tail -- the same shape
// as marker-parsers.js and load-errors.js, so the tests can require() it
// directly.
"use strict";

const zlib = require("zlib");

// gzip's magic number: RFC 1952's ID1/ID2. Detection is by content rather than
// by a ".gz" on the name, matching how GDSII vs OASIS is already decided (see
// detect_format in gds_common.hpp). That way a layout named with an unexpected
// extension still loads, and so does a plain ".gds" that is secretly gzipped --
// which is how these arrive out of some flows.
const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;

// Smallest possible gzip member: a 10-byte header plus an 8-byte trailer.
const GZIP_MIN_BYTES = 18;

function looksGzipped(bytes) {
    return !!bytes && bytes.length >= 2 && bytes[0] === GZIP_ID1 && bytes[1] === GZIP_ID2;
}

// The uncompressed size gzip records in its trailer (RFC 1952's ISIZE), or null
// if the input is too short to hold one.
//
// Only ever used to word a message. It's stored modulo 2^32, and for a
// multi-member file it describes the last member alone, so it is a hint about
// the file rather than a fact about it -- which is exactly why it isn't what
// enforces the limit below. maxOutputLength does that, by stopping zlib the
// moment it overruns instead of trusting what the file claims about itself.
//
// Read by hand rather than with Buffer.readUInt32LE: the caller's bytes come
// from vscode.workspace.fs.readFile, which yields a plain Uint8Array. The top
// byte is multiplied rather than shifted, since `<< 24` would make sizes over
// 2 GB come back negative.
function gzipStoredSize(bytes) {
    if (!bytes || bytes.length < GZIP_MIN_BYTES) return null;
    const end = bytes.length;
    return bytes[end - 4] + bytes[end - 3] * 0x100 + bytes[end - 2] * 0x10000 +
           bytes[end - 1] * 0x1000000;
}

// Uncompressed layout bytes, whatever the input was.
//
//   { ok: true,  bytes, gzipped, storedSize }
//   { ok: false, reason: "too-large" | "corrupt", storedSize, detail }
//
// Not-gzipped input is passed straight back, untouched and uncopied, so the
// ordinary path costs one two-byte comparison. maxBytes caps what a compressed
// file is allowed to expand to; pass a non-finite value for no cap. The reason
// codes are split because the two failures need different things said about
// them -- one is about this machine's limits, the other about the file being
// broken or half-written -- and the prose for both lives with the caller's other
// messages rather than here.
function decodeLayoutBytes(bytes, maxBytes) {
    if (!looksGzipped(bytes)) return { ok: true, bytes: bytes, gzipped: false, storedSize: null };

    const storedSize = gzipStoredSize(bytes);
    try {
        const options = Number.isFinite(maxBytes) ? { maxOutputLength: maxBytes } : {};
        return { ok: true, bytes: zlib.gunzipSync(bytes, options), gzipped: true, storedSize: storedSize };
    } catch (err) {
        // ERR_BUFFER_TOO_LARGE is maxOutputLength being hit -- the one failure
        // here that's about size rather than about the data. Everything else
        // (Z_DATA_ERROR on a bad header, Z_BUF_ERROR on a truncated or corrupted
        // body) means the compressed stream itself can't be read.
        return {
            ok: false,
            reason: err && err.code === "ERR_BUFFER_TOO_LARGE" ? "too-large" : "corrupt",
            storedSize: storedSize,
            detail: err && err.message ? err.message : String(err)
        };
    }
}

module.exports = { looksGzipped, gzipStoredSize, decodeLayoutBytes };
