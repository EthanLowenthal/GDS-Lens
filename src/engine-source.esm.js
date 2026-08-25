// The bundled ESM build's answer to "where does the engine come from": inlined
// text, because there is nothing beside a bundled module to fetch.
//
// Both the main thread and the parse Worker need Emscripten's module, and a
// Worker cannot share the main thread's copy -- it is a separate script
// context. Inlining it twice would put the ~400KB binary in the bundle twice,
// so it is inlined *once* as text and turned into a blob: URL that both sides
// load. That is why the main thread imports through a blob rather than
// importing gds-lens-engine.mjs directly.
//
// Both loads therefore need `blob:` in the page's CSP -- script-src for the
// main thread, worker-src for the Worker. The served payloads do not (only
// worker-src), which is the one thing this build asks for that they do not.
//
// The text import is aliased by scripts/build-webview.mjs to the built
// gds-lens-engine.mjs; the worker half arrives as a define.
import gdstkSource from "gds-lens:gdstk-source";

// Substituted by scripts/build-webview.mjs: the bundled wasm-worker.js as a
// string. A define rather than an import because it is built in an earlier
// pass and never written to disk.
const workerSource = __GDS_LENS_WORKER_SOURCE__;

// One object URL, made on first use and kept: revoking it would break the
// Worker, which loads from the same URL, and a second blob would be a second
// copy of half a megabyte in memory.
let moduleUrl = null;
function gdstkModuleUrl() {
    if (!moduleUrl) {
        moduleUrl = URL.createObjectURL(new Blob([gdstkSource], { type: "text/javascript" }));
    }
    return moduleUrl;
}

export async function loadGdstkFactory() {
    // A dynamic import, not an eval: no 'unsafe-eval' is needed, which is what
    // keeps -sDYNAMIC_EXECUTION=0 worth having.
    const module = await import(/* @vite-ignore */ gdstkModuleUrl());
    return module.default;
}

// Emscripten's ES module output uses import.meta.url, so this has to be loaded
// as a *module* Worker -- a classic one fails to parse. The factory is a
// top-level declaration in gdstkSource, so the worker half below simply sees
// it in scope once the two are concatenated.
export const workerBundle = {
    type: "module",
    text: () => `${gdstkSource}\n${workerSource}`,
};
