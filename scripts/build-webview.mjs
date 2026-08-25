// Builds the webview payload: the files a host copies or serves.
//
// The sources are ES modules, but the payload deliberately is not. A VS Code
// webview cannot load a module script from inside a Worker -- neither
// importScripts() nor fetch() reaches its resource protocol -- so the worker
// has to be one self-contained classic script that can be concatenated with
// gdstk_wasm.js and handed over as a blob. Bundling the main-thread side the
// same way keeps one loading story instead of two, and keeps the global
// factories (createGdstkModule, lil) resolvable from plain <script> tags.
//
// Consumers who want modules import the sources directly through the package's
// exports map; this directory is the ready-to-serve form.

import { mkdir, copyFile, access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "webview");
const watch = process.argv.includes("--watch");

// Copied as-is: generated or vendored third-party files that already define
// the globals the bundles expect.
const COPY = [
    ["src/viewer.html", "viewer.html"],
    ["src/vendor/lil-gui.umd.min.js", "lil-gui.umd.min.js"],
    ["src/wasm/build/gdstk_wasm.js", "gdstk_wasm.js"]
];

// IIFE, not ESM: see the note above. `lil` and `createGdstkModule` stay
// globals, so they are external to the bundle and resolved at run time.
const BUNDLES = [
    ["src/viewer.js", "viewer.js"],
    ["src/wasm-worker.js", "wasm-worker.js"],
    // The default host. An embedder with different services replaces this one
    // file and leaves the rest of the payload alone.
    ["src/hosts/browser.js", "host.js"]
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

const options = (entry, name) => ({
    entryPoints: [join(root, entry)],
    outfile: join(out, name),
    bundle: true,
    format: "iife",
    target: "es2022",
    // The component carries its own markup and styles: there is no separate
    // document for a host page to load them from, so they are inlined as
    // strings and injected into the shadow root at mount.
    loader: { ".html": "text", ".css": "text" },
    // Defined by the classic scripts loaded before these bundles.
    external: [],
    logLevel: "warning"
});

async function copyStatic() {
    await mkdir(out, { recursive: true });
    for (const [from, to] of COPY) await copyFile(join(root, from), join(out, to));
}

if (watch) {
    await copyStatic();
    const contexts = await Promise.all(BUNDLES.map(([e, n]) => context(options(e, n))));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("watching src/ -> dist/webview (Ctrl-C to stop)");
} else {
    await rm(out, { recursive: true, force: true });
    await copyStatic();
    await Promise.all(BUNDLES.map(([e, n]) => build(options(e, n))));
    console.log(`dist/webview: ${COPY.length + BUNDLES.length} files`);
}
