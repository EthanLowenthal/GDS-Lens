// Assembles the webview payload consumers load: every file viewer.html pulls
// in, flattened into one directory so the HTML can use bare relative srcs and
// a host only has to copy (or serve) a single folder.
//
// gdstk_wasm.js must already be built (npm run build:wasm); it is a build
// artifact and is never committed.

import { mkdir, copyFile, access, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "webview");

// Flattened on purpose: viewer.html references these by bare filename, so the
// directory the host serves is self-contained and position-independent.
const FILES = [
    ["src/viewer.html", "viewer.html"],
    ["src/viewer.js", "viewer.js"],
    ["src/cell-search.js", "cell-search.js"],
    ["src/marker-parsers.js", "marker-parsers.js"],
    ["src/load-errors.js", "load-errors.js"],
    // The default ViewerHost. A host with different services (VS Code, say)
    // replaces this one file and leaves the rest of the payload alone.
    ["src/hosts/browser.js", "host.js"],
    ["src/wasm-worker.js", "wasm-worker.js"],
    ["src/vendor/lil-gui.umd.min.js", "lil-gui.umd.min.js"],
    ["src/wasm/build/gdstk_wasm.js", "gdstk_wasm.js"]
];

const wasm = join(root, "src/wasm/build/gdstk_wasm.js");
try {
    await access(wasm);
} catch {
    console.error(
        "gdstk_wasm.js not found. Run `npm run build:wasm` first " +
        "(needs the Emscripten SDK; see README.md)."
    );
    process.exit(1);
}

async function build() {
    await mkdir(out, { recursive: true });
    for (const [from, to] of FILES) {
        await copyFile(join(root, from), join(out, to));
    }
}

await rm(out, { recursive: true, force: true });
await build();
console.log(`dist/webview: ${FILES.length} files`);

// --watch is the inner loop for a host consuming this package through a local
// path dependency: it republishes dist/webview on every source edit, so the
// host only has to re-copy rather than reinstall. Deliberately not watching
// gdstk_wasm.js's C++ sources -- rebuilding those means re-running emcc, which
// is `npm run build:wasm` and far too slow to trigger on keystrokes.
if (process.argv.includes("--watch")) {
    let queued = null;
    const rebuild = () => {
        clearTimeout(queued);
        // Editors write in bursts (temp file, rename, chmod); one trailing
        // rebuild per burst rather than one per event.
        queued = setTimeout(async () => {
            try {
                await build();
                console.log(`[${new Date().toISOString().slice(11, 19)}] dist/webview rebuilt`);
            } catch (err) {
                console.error("rebuild failed:", err.message);
            }
        }, 50);
    };
    for (const dir of ["src", "src/vendor", "src/wasm/build"]) {
        watch(join(root, dir), rebuild);
    }
    console.log("watching src/ -> dist/webview (Ctrl-C to stop)");
}
