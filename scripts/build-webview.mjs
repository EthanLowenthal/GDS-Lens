// Builds the viewer payload: the files a host copies or serves.
//
// Two payloads come out, differing only in how the wasm binary arrives (see
// GDS_LENS_INLINE_WASM in src/wasm/CMakeLists.txt):
//
//   dist/web/          gdstk_wasm.js + a separate gdstk_wasm.wasm it fetches.
//                      The default.
//
//   dist/inline-wasm/  the binary embedded in gdstk_wasm.js. For hosts that
//                      cannot fetch their own assets -- a VS Code webview
//                      cannot, from a Worker or from the main thread.
//
// Everything else in the two is byte-identical, so the choice is purely
// "can this host fetch a file next to its scripts".
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
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// lil-gui ships its stylesheet as dist/lil-gui.css but its exports map
// declares only import/require, so there is no subpath that reaches the file.
// Resolve the package and point an alias at it, rather than reaching past the
// exports map with a deep relative path that would break on any layout change.
const require = createRequire(import.meta.url);
// Resolved via the package's own entry point and then looked up beside it:
// the exports map blocks package.json too, and a hand-written
// node_modules/lil-gui path would break under pnpm or any hoisting layout.
const lilGuiCss = join(dirname(require.resolve("lil-gui")), "lil-gui.css");
const watch = process.argv.includes("--watch");

// Each variant's Emscripten build tree, and the files to lift out of it. The
// two trees exist because the variants differ in cached CMake link flags; see
// the note at the top of src/wasm/CMakeLists.txt.
const VARIANTS = [
    { name: "web", build: "src/wasm/build/web", files: ["gdstk_wasm.js", "gdstk_wasm.wasm"] },
    { name: "inline-wasm", build: "src/wasm/build/inline", files: ["gdstk_wasm.js"] }
];

// Copied as-is into every variant: the page harness. Emscripten's own output
// comes from the variant's build tree instead, and is loaded as a classic
// script for the createGdstkModule global it defines.
const COPY = [["src/viewer.html", "viewer.html"]];

// IIFE, not ESM: see the note above. `lil` and `createGdstkModule` stay
// globals, so they are external to the bundle and resolved at run time.
const BUNDLES = [
    ["src/gds-lens.js", "gds-lens.js"],
    ["src/wasm-worker.js", "wasm-worker.js"],
    // The default host. An embedder with different services replaces this one
    // file and leaves the rest of the payload alone.
    ["src/hosts/browser.js", "host.js"]
];

const exists = async (path) => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// A variant whose wasm has not been built is skipped rather than fatal, so
// working on one of them doesn't require building the other. Loudly, though:
// a payload silently missing here would only show up as a 404 in a host.
const present = [];
for (const variant of VARIANTS) {
    if (await exists(join(root, variant.build, variant.files[0]))) present.push(variant);
    else console.warn(`skipping dist/${variant.name}: no ${variant.build}/${variant.files[0]}`);
}
if (!present.length) {
    console.error(
        "No wasm build found. Run `npm run build:wasm` first " +
        "(needs the Emscripten SDK; see README.md)."
    );
    process.exit(1);
}

const outDir = (variant) => join(root, "dist", variant.name);

const options = (entry, name, variant) => ({
    entryPoints: [join(root, entry)],
    outfile: join(outDir(variant), name),
    bundle: true,
    format: "iife",
    target: "es2022",
    // The component carries its own markup and styles: there is no separate
    // document for a host page to load them from, so they are inlined as
    // strings and injected into the shadow root at mount.
    loader: { ".html": "text", ".css": "text" },
    // Escape non-ASCII rather than emitting UTF-8 bytes, so these bundles do
    // not care what encoding the embedding page declares. Note this cannot
    // save gdstk_wasm.js, which is Emscripten's output and embeds the wasm
    // binary as a raw string: see the UTF-8 note in gds-lens.js.
    charset: "ascii",
    alias: { "lil-gui-css": lilGuiCss },
    // Lets the encoding warning in gds-lens.js compile away in the build
    // where it cannot apply. See the note beside it.
    define: { __GDS_LENS_INLINE_WASM__: String(variant.name === "inline-wasm") },
    // Defined by the classic scripts loaded before these bundles.
    external: [],
    logLevel: "warning"
});

async function copyStatic(variant) {
    const out = outDir(variant);
    await mkdir(out, { recursive: true });
    for (const [from, to] of COPY) await copyFile(join(root, from), join(out, to));
    for (const file of variant.files) {
        await copyFile(join(root, variant.build, file), join(out, file));
    }
}

// The bundles are identical across variants, so this rebuilds them per
// variant rather than sharing one output. esbuild takes single-digit
// milliseconds on these, and a shared build would need a mirroring step that
// watch mode would have to reimplement.
if (watch) {
    for (const variant of present) await copyStatic(variant);
    const contexts = await Promise.all(present.flatMap((variant) =>
        BUNDLES.map(([e, n]) => context(options(e, n, variant)))));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log(`watching src/ -> ${present.map((v) => `dist/${v.name}`).join(", ")} (Ctrl-C to stop)`);
} else {
    for (const variant of present) {
        await rm(outDir(variant), { recursive: true, force: true });
        await copyStatic(variant);
        await Promise.all(BUNDLES.map(([e, n]) => build(options(e, n, variant))));
        console.log(`dist/${variant.name}: ${COPY.length + variant.files.length + BUNDLES.length} files`);
    }
}
