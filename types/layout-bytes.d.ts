// `gds-lens/layout-bytes` -- gzip in front of the parser.
//
// The result is a discriminated union rather than a throw: "too large for
// this machine" and "the file is broken" need different things said about
// them, and the caller is the one with the wording.

export interface DecodedLayout {
    ok: true;
    bytes: Uint8Array;
    gzipped: boolean;
    /** gzip's ISIZE trailer, or `null` when the input was too short. */
    storedSize: number | null;
}

export interface FailedLayout {
    ok: false;
    /** `"too-large"` is this machine's limit; `"corrupt"` is the file's. */
    reason: "too-large" | "corrupt";
    storedSize: number | null;
    /** The cap that was enforced, so a message can quote it. */
    limit: number;
    detail: string;
}

/** gzip's magic number (RFC 1952 ID1/ID2). Content, not extension. */
export function looksGzipped(bytes: Uint8Array | null | undefined): boolean;

/**
 * The uncompressed size gzip records in its trailer, or `null` if the input is
 * too short to hold one.
 *
 * A hint about the file rather than a fact about it: it is stored modulo 2^32,
 * and for a multi-member file it describes only the last member. Never use it
 * to enforce a limit -- `decodeLayoutBytes` counts actual output instead.
 */
export function gzipStoredSize(bytes: Uint8Array | null | undefined): number | null;

/**
 * Uncompressed layout bytes, whatever the input was. Non-gzipped input is
 * passed straight back, untouched and uncopied.
 *
 * `maxBytes` caps what a compressed file is allowed to expand to, enforced
 * against the running output total rather than the trailer's claim, so a
 * decompression bomb stops at the cap. Pass a non-finite value for no cap.
 */
export function decodeLayoutBytes(
    bytes: Uint8Array,
    maxBytes?: number,
): Promise<DecodedLayout | FailedLayout>;
