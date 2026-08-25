// Turns the engine-level failures a layout load can hit into text a layout
// engineer can act on.
//
// Imported by both sides of the load: the main thread (viewer.js) and the
// parse Worker, which are separate script contexts and each get their own
// copy through the bundler. No imports of its own, and no DOM or wasm, so
// Node unit tests import it directly too.
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

// Wording for a failed gzip expansion (the {ok:false} half of what
// decodeLayoutBytes returns; see layout-bytes.js, which deliberately leaves
// the prose to its caller).
//
// The two reasons need different things said. "too-large" is about this
// machine: the file is fine, there is nowhere to put it, and the number worth
// quoting is the limit. "corrupt" is about the file: it is truncated or was
// written by something that stopped halfway, and no limit would have helped.
function describeDecodeFailure(result) {
    if (!result || result.ok) return "";
    if (result.reason === "too-large") {
        const gb = (result.limit / (1024 * 1024 * 1024)).toFixed(1);
        const claimed = result.storedSize
            ? ` The file's own trailer claims ${(result.storedSize / (1024 * 1024)).toFixed(0)} MB uncompressed.`
            : "";
        return "This compressed layout is too large to expand.\n\n"
            + `Expanding stopped at the ${gb} GB limit.${claimed} The viewer parses `
            + "layouts in a 32-bit WebAssembly module, so the expanded file and the "
            + "geometry built from it both have to fit in one 4 GB address space. "
            + "An uncompressed copy of the same design will not help; a design that "
            + "reuses cells rather than flattening them will.";
    }
    return "This layout looks gzipped, but the compressed data could not be read.\n\n"
        + "Usually a truncated or half-written file -- a copy that was interrupted, "
        + `or a download that stopped early. (${result.detail})`;
}

export { describeLoadFailure, isOutOfMemory, describeDecodeFailure };
