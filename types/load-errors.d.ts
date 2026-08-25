// `gds-lens/load-errors` -- turning engine-level failures into text a layout
// engineer can act on.

/**
 * A human-readable explanation of a load failure.
 *
 * Running out of room in the 32-bit wasm heap surfaces as one of a handful of
 * unhelpful strings depending on which allocation happened to fail; they all
 * mean the same thing, and all get the same explanation. `prefix` labels
 * anything else with where it came from, and is ignored for out-of-memory,
 * since that is about the layout rather than the component that noticed.
 */
export function describeLoadFailure(err: unknown, prefix?: string): string;

/** Whether a failure is the wasm heap running out, however it surfaced. */
export function isOutOfMemory(err: unknown): boolean;

/**
 * Wording for a failed gzip expansion -- the `{ ok: false }` result from
 * `decodeLayoutBytes`. Returns `""` for a successful one.
 *
 * The two reasons get different prose: `"too-large"` is about this machine's
 * limit, `"corrupt"` about the file being truncated or half-written.
 */
export function describeDecodeFailure(
    result: { ok: boolean; reason?: string; storedSize?: number | null; limit?: number; detail?: string },
): string;
