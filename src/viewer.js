// Thin bootstrap: instantiate the wasm module and relay postMessage payloads
// from the extension host into it. JS never touches GDS/GL data -- that all
// lives in wasm/renderer.cpp (GL context + shaders + camera + input) and
// wasm/bindings.cpp (gdstk parsing), which attach directly to #glCanvas and
// the DOM themselves. The control surface (load .lyp button + per-layer
// visibility toggles) is built with dat.gui (vendor/dat.gui.min.js).
//
// Loading a GDS file is split across a Worker (see wasm-worker.js) and this
// main-thread module: the Worker instantiates its own copy of the same wasm
// module and runs parseGdsToLayers() (parse + flatten + triangulate, no
// GL/DOM) so the canvas/dat.gui panel stay responsive on very large files,
// reporting progress via 'gdsProgress' messages along the way. Once it posts
// back the flattened geometry, this thread's Module.uploadLayers() does the
// (fast, GPU-bound) VBO upload -- the only part that needs the GL context.

// On-screen debug log (see #debugPanel in viewer.html): mirrors every
// console.log/error call here, plus 'gdsLog' messages relayed from the
// Worker (which has no DOM of its own to render into), so debugging doesn't
// depend on getting the right DevTools window attached to the right webview
// -- the log is just selectable text in the page itself.
const debugLogEl = document.getElementById("debugLog");
function safeStringify(arg) {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}
function appendDebugLine(text, isError) {
    if (!debugLogEl) return;
    const line = document.createElement("div");
    if (isError) line.className = "err";
    line.textContent = `[${new Date().toISOString().slice(11, 23)}] ${text}`;
    debugLogEl.appendChild(line);
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
}
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
console.log = (...args) => {
    originalConsoleLog(...args);
    appendDebugLine(args.map(safeStringify).join(" "), false);
};
console.error = (...args) => {
    originalConsoleError(...args);
    appendDebugLine(args.map(safeStringify).join(" "), true);
};
// Null-guarded: a missing element here (e.g. a webview still holding stale
// HTML from before this panel existed) must not throw and abort the rest of
// this script -- everything below, including the window "message" listener
// that shows the loading bar at all, depends on this file finishing setup.
const debugCopyBtn = document.getElementById("debugCopyBtn");
if (debugCopyBtn) {
    debugCopyBtn.addEventListener("click", () => {
        const text = debugLogEl ? debugLogEl.innerText : "";
        navigator.clipboard.writeText(text).then(
            () => console.log("[GDS] debug log copied to clipboard"),
            (err) => {
                // Clipboard API can be blocked in a sandboxed webview -- fall back
                // to selecting the text so the user can Cmd/Ctrl+C manually.
                console.error("[GDS] clipboard write failed, select-all instead:", err);
                if (!debugLogEl) return;
                const range = document.createRange();
                range.selectNodeContents(debugLogEl);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        );
    });
}

console.log("[GDS] viewer.js starting to execute");

window.onerror = (msg, url, line, col, err) => {
    console.error("[GDS] window.onerror:", msg, "at", url + ":" + line + ":" + col, err && err.stack);
};
window.addEventListener("unhandledrejection", (event) => {
    console.error("[GDS] unhandled promise rejection on main thread:", event.reason);
});

const vscode = acquireVsCodeApi();
console.log("[GDS] acquireVsCodeApi() OK, typeof createGdstkModule:", typeof createGdstkModule, "typeof dat:", typeof dat, "typeof Worker:", typeof Worker, "typeof Blob:", typeof Blob);

const gui = new dat.GUI({ width: 260 });
const actions = {
    loadLypFile: () => vscode.postMessage({ command: "loadLypFile" })
};
gui.add(actions, "loadLypFile").name("Load KLayout .lyp File");

let layersFolder = null;

// Rebuilds the layer folder from Module.getLayers() -- {layer, name,
// fillColor, frameColor, visible}[], all plain scalars/strings (no
// per-polygon geometry crosses into JS). Called after every
// loadAndRenderGds()/loadLypText() call since either can change the layer
// set, colors, or visibility.
function renderLayerList(layers) {
    if (layersFolder) {
        gui.removeFolder(layersFolder);
    }
    layersFolder = gui.addFolder("Layers");
    layersFolder.open();

    for (const layer of layers) {
        const label = layer.name ? `${layer.layer} – ${layer.name}` : `Layer ${layer.layer}`;
        const state = { visible: layer.visible };
        const controller = layersFolder.add(state, "visible")
            .name(label)
            .onChange((visible) => {
                modulePromise.then((Module) => Module.setLayerVisible(layer.layer, visible));
            });
        // dat.gui has no built-in color swatch for booleans -- tint the row's
        // left border with the layer's frame color as a visual cue.
        controller.__li.style.borderLeft = `4px solid ${layer.frameColor}`;
        controller.__li.title = label;
    }
}

const loadingOverlay = document.getElementById("loadingOverlay");
const loadingBarFill = document.getElementById("loadingBarFill");
const loadingPhase = document.getElementById("loadingPhase");
const loadingPercent = document.getElementById("loadingPercent");

const phaseLabels = {
    parsing: "Parsing GDS binary...",
    flattening: "Flattening hierarchy...",
    triangulating: "Triangulating geometry..."
};

function updateProgress(phase, current, total) {
    const label = phaseLabels[phase] || phase;
    const fraction = total > 0 ? current / total : 0;
    loadingPhase.textContent = label;
    loadingBarFill.style.width = `${Math.round(fraction * 100)}%`;
    loadingPercent.textContent = phase === "triangulating" ? `Layer ${current}/${total}` : `${Math.round(fraction * 100)}%`;
}

// Registered synchronously (not inside the .then() below) so an 'init'
// message that arrives before wasm instantiation finishes isn't dropped --
// window message events aren't queued for late listeners.
console.log("[GDS] calling createGdstkModule() on main thread...");
const modulePromise = createGdstkModule();
modulePromise.then(
    () => console.log("[GDS] main-thread createGdstkModule() resolved OK"),
    (err) => console.error("[GDS] main-thread createGdstkModule() REJECTED:", err)
);

window.addEventListener("message", (event) => {
    const message = event.data;
    console.log("[GDS] window message received, type:", message.type);
    if (message.type === "init") {
        console.log("[GDS] init payload: fileData byteLength =", message.fileData && message.fileData.byteLength);
        loadingOverlay.classList.remove("hidden");
        updateProgress("parsing", 0, 1);

        let worker;
        try {
            // atob() yields a "binary string" -- one JS char per raw byte
            // (0-255), NOT real UTF-16 text. gdstk_wasm.js contains genuine
            // non-ASCII bytes (its embedded wasm binary), so passing that
            // string straight to `new Blob([...])` would have the Blob
            // constructor UTF-8-*encode* it as if it were text, expanding
            // every byte >=128 into a 2-byte sequence and corrupting the
            // wasm binary (surfaced as a WebAssembly.instantiate()
            // "section was shorter than expected size" CompileError inside
            // the worker). Converting to a Uint8Array first makes the Blob
            // use the raw bytes as-is.
            const binaryString = atob(document.getElementById("workerBundle").textContent);
            const bundleBytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
            console.log("[GDS] decoded worker bundle, length =", bundleBytes.length);
            const blobUrl = URL.createObjectURL(new Blob([bundleBytes], { type: "application/javascript" }));
            console.log("[GDS] created worker blob URL:", blobUrl);
            worker = new Worker(blobUrl);
            console.log("[GDS] new Worker() constructor returned OK");
        } catch (err) {
            console.error("[GDS] failed to build/start worker:", err);
            modulePromise.then((Module) => {
                Module.showLoadError(`Failed to create worker: ${err.message || err}`);
                renderLayerList(Module.getLayers());
                loadingOverlay.classList.add("hidden");
            });
            return;
        }
        startWorker(worker, message.fileData);
    } else if (message.type === "lypLoaded") {
        modulePromise.then((Module) => {
            Module.loadLypText(message.text);
            renderLayerList(Module.getLayers());
        });
    }
});

function startWorker(worker, fileData) {
    // Only fires for the Worker failing to start at all (e.g. its script
    // URL rejected by CSP) -- failures inside the worker's own async code
    // are reported via a 'gdsResult' message instead (see wasm-worker.js),
    // since a Worker's unhandled promise rejections don't reach this
    // handler.
    worker.onerror = (err) => {
        console.error("[GDS] worker.onerror fired:", err.message, "at", err.filename + ":" + err.lineno + ":" + err.colno, err.error);
        modulePromise.then((Module) => {
            Module.showLoadError(`Worker failed to start: ${err.message || err}`);
            renderLayerList(Module.getLayers());
            loadingOverlay.classList.add("hidden");
        });
    };
    worker.onmessageerror = (err) => {
        console.error("[GDS] worker.onmessageerror fired (structured-clone failure):", err);
        modulePromise.then((Module) => {
            Module.showLoadError("Worker message failed to deserialize -- see devtools console");
            renderLayerList(Module.getLayers());
            loadingOverlay.classList.add("hidden");
        });
    };
    worker.onmessage = (workerEvent) => {
        const workerMessage = workerEvent.data;
        if (workerMessage.type === "gdsLog") {
            // Relayed from wasm-worker.js's console.log/error patch --
            // the worker has no DOM to render its own debug panel into.
            appendDebugLine("[worker] " + workerMessage.text, workerMessage.level === "error");
            return;
        }
        // Deliberately not logging the full workerMessage here: the
        // 'gdsResult' message carries the entire parsed geometry (every
        // layer's outline/fill vertex arrays), and console.log is patched
        // above to JSON.stringify + append everything it's given to
        // #debugLog -- serializing and DOM-inserting the whole design on
        // every load was the dominant cost of moving parsing into a Worker
        // at all, swamping whatever the off-main-thread parse saved.
        console.log("[GDS] main thread received worker message:", workerMessage.type);
        if (workerMessage.type === "gdsProgress") {
            updateProgress(workerMessage.phase, workerMessage.current, workerMessage.total);
        } else if (workerMessage.type === "gdsResult") {
            if (!workerMessage.ok) console.error("[GDS] load failed:", workerMessage.error);
            else console.log("[GDS] load succeeded, layer count:", workerMessage.layers.length);
            modulePromise.then((Module) => {
                if (workerMessage.ok) {
                    Module.uploadLayers(workerMessage.layers, workerMessage.bbox);
                } else {
                    Module.showLoadError(workerMessage.error);
                }
                renderLayerList(Module.getLayers());
                loadingOverlay.classList.add("hidden");
                console.log("[GDS] done, overlay hidden");
            });
            worker.terminate();
        }
    };
    console.log("[GDS] posting 'parse' message to worker...");
    worker.postMessage(
        { type: "parse", fileData: fileData },
        [fileData]
    );
    console.log("[GDS] worker.postMessage('parse') call returned");
}
