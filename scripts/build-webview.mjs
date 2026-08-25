// Builds what the package ships: two payloads a host serves, and one module a
// consumer imports.
//
// The payloads differ only in how the wasm binary arrives (see
// GDS_LENS_INLINE_WASM in src/wasm/CMakeLists.txt):
//
//   dist/web/          gds-lens-engine.js + the gds-lens-engine.wasm it
//                      fetches from beside itself. The default.
//
//   dist/inline-wasm/  the binary embedded in gds-lens-engine.js. For hosts that
//                      cannot fetch their own assets -- a VS Code webview
//                      cannot, from a Worker or from the main thread.
//
// Everything else in the two is byte-identical, so the choice is purely
// "can this host fetch a file next to its scripts".
//
//   dist/esm/          one ES module, everything inlined: markup, styles,
//                      lil-gui, the default host, the wasm binary and the
//                      Worker's script. This is what `import "gds-lens"`
//                      resolves to, and it is the only form that needs no
//                      configuration and no sibling files -- which is the
//                      whole reason it exists (see buildEsm below).
//
// The sources are ES modules, but the two *payloads* deliberately are not. A
// VS Code webview cannot load a module script from inside a Worker -- neither
// importScripts() nor fetch() reaches its resource protocol -- so there the
// worker has to be one self-contained classic script that can be concatenated
// with gds-lens-engine.js and handed over as a blob. Bundling the main-thread side
// the same way keeps one loading story instead of two, and keeps the global
// factories (createGdstkModule, lil) resolvable from plain <script> tags.
//
// dist/esm is the opposite trade: a module Worker and a blob: import, which
// need no sibling files at all. Both exist because neither covers both cases.

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
    { name: "web", build: "src/wasm/build/web", files: ["gds-lens-engine.js", "gds-lens-engine.wasm"] },
    { name: "inline-wasm", build: "src/wasm/build/inline", files: ["gds-lens-engine.js"] }
];

// The ESM build's input is the EXPORT_ES6 wasm module, in its own tree.
const ESM_WASM = "src/wasm/build/esm/gds-lens-engine.mjs";

// Copied as-is into every variant: the reference page. Emscripten's own output
// comes from the variant's build tree instead, and is loaded as a classic
// script for the createGdstkModule global it defines.
//
// Every name here carries the package prefix: a payload gets copied into
// someone else's web root, and "host.js" or "wasm-worker.js" there is a
// collision waiting to happen.
const COPY = [["src/viewer.html", "gds-lens.html"]];

// IIFE, not ESM: see the note above. `lil` and `createGdstkModule` stay
// globals, so they are external to the bundle and resolved at run time.
const BUNDLES = [
    ["src/gds-lens.js", "gds-lens.js"],
    ["src/wasm-worker.js", "gds-lens-worker.js"],
    // The default host. An embedder with different services replaces this one
    // file and leaves the rest of the payload alone.
    ["src/hosts/browser.js", "gds-lens-host.js"]
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
    // save gds-lens-engine.js, which is Emscripten's output and embeds the wasm
    // binary as a raw string: see the UTF-8 note in gds-lens.js.
    charset: "ascii",
    alias: {
        "lil-gui-css": lilGuiCss,
        // The served payloads take the engine from a global and build the
        // Worker from URLs; dist/esm swaps this for the inlined version.
        "gds-lens:engine": join(root, "src/engine-source.js"),
    },
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

// dist/esm: one importable module with nothing beside it.
//
// Two passes, because the Worker's script has to exist as *text* before the
// main bundle can inline it. Pass one bundles src/wasm-worker.js on its own;
// pass two bundles the element and inlines both that text and the EXPORT_ES6
// wasm module through the two `gds-lens:` aliases engine-source.esm.js
// imports. Neither is written to dist -- the worker text only ever exists
// inside the final module.
async function buildEsm() {
    const out = join(root, "dist", "esm");
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });

    // Pass one. ESM rather than IIFE: this text is concatenated after
    // Emscripten's ES module and loaded as a module Worker, so it has to be
    // one. `createGdstkModule` is left as a free identifier, which resolves to
    // the top-level declaration in the half above it.
    const worker = await build({
        entryPoints: [join(root, "src/wasm-worker.js")],
        bundle: true,
        write: false,
        format: "esm",
        target: "es2022",
        charset: "ascii",
        logLevel: "warning",
    });
    const workerText = worker.outputFiles[0].text;

    // Pass two. The wasm module is inlined as text rather than imported as
    // code so that the Worker can share the one copy; see
    // engine-source.esm.js for why that matters.
    await build({
        entryPoints: [join(root, "src/gds-lens.js")],
        outfile: join(out, "gds-lens.js"),
        bundle: true,
        format: "esm",
        target: "es2022",
        loader: { ".html": "text", ".css": "text", ".mjs": "text" },
        charset: "ascii",
        alias: {
            "lil-gui-css": lilGuiCss,
            // Everything that differs between "serve the payload" and "import
            // the module" is behind this one swap.
            "gds-lens:engine": join(root, "src/engine-source.esm.js"),
            "gds-lens:gdstk-source": join(root, ESM_WASM),
        },
        // The Worker's text has no file to be aliased to, so it arrives as a
        // define -- JSON.stringify because it is a whole program as a string
        // literal.
        define: {
            __GDS_LENS_INLINE_WASM__: "false",
            __GDS_LENS_WORKER_SOURCE__: JSON.stringify(workerText),
        },
        logLevel: "warning",
    });
    return out;
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

    // Skipped rather than fatal, same as the payloads: building one variant
    // should not require having built the others.
    if (await exists(join(root, ESM_WASM))) {
        await buildEsm();
        console.log("dist/esm: 1 file");
    } else {
        console.warn(`skipping dist/esm: no ${ESM_WASM} (run \`npm run build:wasm:esm\`)`);
    }
}
