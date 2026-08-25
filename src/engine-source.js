// Where the wasm factory and the parse Worker's script come from.
//
// This is the default: the served payloads (dist/web, dist/inline-wasm) load
// Emscripten's output as a classic <script> before the bundle, so the factory
// is already a global (from gds-lens-engine.js) and the Worker can fetch the
// same scripts by URL.
//
// The bundled ESM build swaps this file for engine-source.esm.js, which
// carries both as inlined text instead (see scripts/build-webview.mjs). Every
// difference between "a payload you serve" and "a module you import" is in
// these two files, so nothing else has to know which one it is running in.

// Emscripten's MODULARIZE output defines this on the global object.
export function loadGdstkFactory() {
    return Promise.resolve(globalThis.createGdstkModule);
}

// Null means "no inlined script": viewer.js builds the Worker from
// document-relative URLs instead. See createParseWorker.
export const workerBundle = null;
