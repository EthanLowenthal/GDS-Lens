import { describeLoadFailure } from "./load-errors.js";

// Runs the parse/flatten/triangulate half of loading a layout file (GDSII or
// OASIS) off the main thread. Either way createGdstkModule is already in
// scope by the time this file's own code runs, but how it got there depends
// on the host (see createParseWorker in viewer.js):
//
// On an ordinary page the worker is a small blob that importScripts() both
// gdstk_wasm.js and this file by absolute URL, and the wasm binary is a
// separate file the module fetches for itself.
//
// A VS Code webview can do neither. Its resource protocol (vscode-cdn.net)
// serves `<script src>` tags in the main document fine, but a Worker (even a
// blob one) can't reach it at all: importScripts against that URL fails with
// a NetworkError before it even gets to CSP, and `fetch()` fails the same way
// even from the main thread -- so the binary can't be fetched either. That
// host uses the inline-wasm build (-sSINGLE_FILE=1, binary embedded in the
// .js) and prepends its full text to this file's, no network involved. The
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

// Where to fetch gdstk_wasm.wasm from, for the build that keeps it separate.
// Emscripten would resolve it against this worker's own script URL, which is
// a blob: with no directory to speak of, so viewer.js passes the real one in.
// Absent (the inline-wasm build, or a host that assembles the worker itself)
// there is no binary to locate and the default is left alone.
function moduleArgs() {
    const base = self.gdsLensScriptBase;
    if (!base) return {};
    return { locateFile: (file) => new URL(file, base).href };
}

console.log("[GDS worker] registering onmessage handler");
self.onmessage = (event) => {
    const message = event.data;
    console.log("[GDS worker] received message, type:", message.type);
    if (message.type !== "parse") return;

    console.log("[GDS worker] fileData byteLength:", message.fileData && message.fileData.byteLength);
    console.log("[GDS worker] calling createGdstkModule()...");
    createGdstkModule(moduleArgs()).then((Module) => {
        console.log("[GDS worker] createGdstkModule() resolved, Module keys:", Object.keys(Module).filter(k => typeof Module[k] === "function"));
        // Extension-less name on purpose: GDSII vs OASIS is decided by the
        // file's own header inside the wasm (gds_common::detect_format), so
        // nothing here has to know or plumb through which one this is.
        console.log("[GDS worker] writing /input.layout to MEMFS...");
        Module.FS.writeFile("/input.layout", new Uint8Array(message.fileData));
        console.log("[GDS worker] calling Module.parseGdsToLayers('/input.layout')...");
        const result = Module.parseGdsToLayers("/input.layout");
        console.log("[GDS worker] parseGdsToLayers returned, ok:", result.ok, "format:", result.format, "error:", result.error);
        Module.FS.unlink("/input.layout");

        if (!result.ok) {
            postMessage({type: "gdsResult", ok: false, error: result.error});
            return;
        }

        console.log("[GDS worker] layers:", result.layers.length, "instance groups:", result.instanceGroups.length, "labels:", result.totalLabels, "cells:", result.hierarchy.cellCount, "-- posting gdsResult back to main thread");
        const transferList = [];
        for (const layer of result.layers) {
            transferList.push(layer.outlineVertices.buffer, layer.outlineRanges.buffer,
                              layer.fillVertices.buffer);
            // Label text (see attach_labels in renderer.cpp). Only the
            // top-level layer entries carry it -- an instanced cell's labels
            // are expanded into world space during the flatten, so the
            // per-group entries below have no text of their own.
            transferList.push(layer.textChars.buffer, layer.textLengths.buffer,
                              layer.textOrigins.buffer, layer.textAnchors.buffer);
        }
        for (const group of result.instanceGroups) {
            transferList.push(group.instances.buffer);
            for (const layer of group.layers) {
                transferList.push(layer.outlineVertices.buffer, layer.outlineRanges.buffer,
                                  layer.fillVertices.buffer);
            }
        }
        // hierarchy (see build_hierarchy in renderer.cpp) is plain objects and
        // numbers -- one entry per cell in the file -- except for each row's
        // per-placement transforms, which are Float64Arrays and so worth
        // transferring rather than cloning. They're capped library-wide
        // (kMaxHierarchyPlacements), so this walk is bounded and most rows
        // (single placements) carry none at all.
        for (const cell of result.hierarchy.cells) {
            for (const ref of cell.refs) {
                if (ref.placements) transferList.push(ref.placements.buffer);
            }
        }
        postMessage(
            {type: "gdsResult", ok: true, layers: result.layers, instanceGroups: result.instanceGroups,
             hierarchy: result.hierarchy, bbox: result.bbox},
            transferList
        );
        console.log("[GDS worker] postMessage(gdsResult) call returned");
    }).catch((err) => {
        console.error("[GDS worker] createGdstkModule() chain rejected:", err, err && err.stack);
        postMessage({type: "gdsResult", ok: false, error: describeLoadFailure(err, "Layout worker failed")});
    });
};
console.log("[GDS worker] onmessage handler registered, script finished top-level execution");
