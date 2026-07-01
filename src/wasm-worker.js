// Runs the parse/flatten/triangulate half of loading a GDS file off the
// main thread. viewer.js instantiates this via a Blob URL built from THIS
// file's text with the full gdstk_wasm.js source prepended -- not
// `importScripts(wasmUrl)`. VS Code's webview resource protocol
// (vscode-cdn.net) serves `<script src>` tags in the main document fine, but
// a Worker (even a Blob one) can't reach it at all: importScripts against
// that URL fails with a NetworkError before it even gets to CSP, and
// `fetch()` against it fails the same way even from the main thread. Since
// gdstk_wasm.js is built with -sSINGLE_FILE=1 (wasm embedded as base64, no
// separate binary fetch needed), prepending its full text avoids needing any
// network fetch from inside the worker -- createGdstkModule is simply
// already in scope by the time this file's own code below runs. The
// concatenated text itself reaches viewer.js embedded as base64 in
// viewer.html's #workerBundle element (see extension.cjs) rather than via
// postMessage, since a ~270KB string sent that way reliably broke opening
// the editor at all (a VS Code-internal RPC assertion).
//
// createGdstkModule() instantiates the *same* wasm module used on the main
// thread. Its main() calls init_gl(), which fails harmlessly here (no
// "#glCanvas" -- no DOM at all, same as running under plain Node for
// headless testing) and returns before touching any DOM/GL state, so this
// stays a pure computation module in this context: renderer.cpp's
// parseGdsToLayers() does the parse/flatten/triangulate work and posts
// 'gdsProgress' messages directly (see report_progress() in renderer.cpp).
//
// createGdstkModule() returns a Promise -- a rejection there (or any other
// async failure below) would otherwise vanish as an unhandled rejection
// inside this Worker instead of reaching viewer.js's worker.onerror (that
// only fires for *synchronous* throws), leaving the main thread waiting
// forever with no error and no progress. Every path below explicitly
// posts a 'gdsResult' failure instead of letting anything fail silently.
// Relay console.log/error to the main thread as 'gdsLog' messages -- this
// worker has no DOM of its own, so viewer.js's on-screen #debugPanel is the
// only way these are visible without a DevTools window correctly attached to
// this specific webview (which has proven fiddly to get right). Args are
// stringified defensively since not everything passed to console.log here
// (e.g. Error objects, the Module object) is guaranteed structured-cloneable.
function safeStringify(arg) {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
console.log = (...args) => {
    originalLog(...args);
    try {
        postMessage({type: "gdsLog", level: "log", text: args.map(safeStringify).join(" ")});
    } catch {
        // ignore -- best-effort relay only
    }
};
console.error = (...args) => {
    originalError(...args);
    try {
        postMessage({type: "gdsLog", level: "error", text: args.map(safeStringify).join(" ")});
    } catch {
        // ignore -- best-effort relay only
    }
};

console.log("[GDS worker] script started executing, typeof createGdstkModule:", typeof createGdstkModule);

self.onerror = (msg, url, line, col, err) => {
    console.error("[GDS worker] self.onerror:", msg, "at", url + ":" + line + ":" + col, err && err.stack);
};
self.addEventListener("unhandledrejection", (event) => {
    console.error("[GDS worker] unhandled promise rejection inside worker:", event.reason);
});

console.log("[GDS worker] registering onmessage handler");
self.onmessage = (event) => {
    const message = event.data;
    console.log("[GDS worker] received message, type:", message.type);
    if (message.type !== "parse") return;

    console.log("[GDS worker] fileData byteLength:", message.fileData && message.fileData.byteLength);
    console.log("[GDS worker] calling createGdstkModule()...");
    createGdstkModule().then((Module) => {
        console.log("[GDS worker] createGdstkModule() resolved, Module keys:", Object.keys(Module).filter(k => typeof Module[k] === "function"));
        console.log("[GDS worker] writing /input.gds to MEMFS...");
        Module.FS.writeFile("/input.gds", new Uint8Array(message.fileData));
        console.log("[GDS worker] calling Module.parseGdsToLayers('/input.gds')...");
        const result = Module.parseGdsToLayers("/input.gds");
        console.log("[GDS worker] parseGdsToLayers returned, ok:", result.ok, "error:", result.error);
        Module.FS.unlink("/input.gds");

        if (!result.ok) {
            postMessage({type: "gdsResult", ok: false, error: result.error});
            return;
        }

        console.log("[GDS worker] layers:", result.layers.length, "-- posting gdsResult back to main thread");
        const transferList = [];
        for (const layer of result.layers) {
            transferList.push(layer.outlineVertices.buffer, layer.fillVertices.buffer);
        }
        postMessage({type: "gdsResult", ok: true, layers: result.layers, bbox: result.bbox}, transferList);
        console.log("[GDS worker] postMessage(gdsResult) call returned");
    }).catch((err) => {
        console.error("[GDS worker] createGdstkModule() chain rejected:", err, err && err.stack);
        postMessage({type: "gdsResult", ok: false, error: `GDS worker failed: ${err && err.message ? err.message : err}`});
    });
};
console.log("[GDS worker] onmessage handler registered, script finished top-level execution");
