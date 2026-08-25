// Turns the engine-level failures a layout load can hit into text a layout
// engineer can act on. This is a standalone script (no imports) loaded three
// ways, following the same pattern as marker-parsers.js: the webview pulls it
// in via a <script> tag, the parse Worker gets it prepended into its bundle
// (see extension.cjs -- the Worker is a separate script context that can't
// import from the main thread), and Node unit tests require() it via the
// module.exports tail.
//
// Running out of room in the wasm heap surfaces as one of a handful of
// unhelpful strings depending on which allocation happened to be the one that
// failed -- "memory access out of bounds" when a bounds check catches it
// first, "Aborted()" when Emscripten's allocator gives up, a RangeError when
// it's a JS-side typed array. They all mean the same thing to the user.
const OOM_PATTERN = /memory access out of bounds|Cannot enlarge memory|Aborted\(|out of memory|Array buffer allocation failed|Invalid (typed )?array length/i;

const OOM_MESSAGE =
    "Out of memory: this layout is too large to open.\n\n" +
    "The viewer parses layouts in a 32-bit WebAssembly module, so the whole " +
    "flattened design has to fit in 4 GB. Layouts that reuse cells (arrays " +
    "and repeated placements) go much further than fully flattened ones, " +
    "because a repeated cell is drawn as GPU instances instead of being " +
    "copied for every placement.";

// `prefix` labels non-memory failures with where they came from (the Worker
// passes one); out-of-memory keeps its own wording either way, since the
// cause is the layout rather than the component that happened to notice.
function describeLoadFailure(err, prefix) {
    const text = err && err.message ? err.message : String(err);
    if (OOM_PATTERN.test(text)) return `${OOM_MESSAGE}\n\n(${text})`;
    return prefix ? `${prefix}: ${text}` : text;
}

function isOutOfMemory(err) {
    return OOM_PATTERN.test(err && err.message ? err.message : String(err));
}

export { describeLoadFailure, isOutOfMemory };
