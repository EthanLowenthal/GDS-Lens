// Thin bootstrap: instantiate the wasm module and relay postMessage payloads
// from the extension host into it. JS never touches GDS/GL data -- that all
// lives in wasm/renderer.cpp (GL context + shaders + camera + input) and
// wasm/bindings.cpp (gdstk parsing), which attach directly to #glCanvas and
// the DOM themselves. The control surface (load .lyp button + per-layer
// visibility toggles) is built with lil-gui (vendor/lil-gui.umd.min.js).
//
// Loading a GDS file is split across a Worker (see wasm-worker.js) and this
// main-thread module: the Worker instantiates its own copy of the same wasm
// module and runs parseGdsToLayers() (parse + flatten + triangulate, no
// GL/DOM) so the canvas/lil-gui panel stay responsive on very large files,
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
const debugPanelEl = document.getElementById("debugPanel");
const debugToggleBtn = document.getElementById("debugToggleBtn");
if (debugToggleBtn && debugPanelEl) {
    debugToggleBtn.addEventListener("click", () => {
        debugPanelEl.classList.toggle("hidden");
    });
}
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
console.log("[GDS] acquireVsCodeApi() OK, typeof createGdstkModule:", typeof createGdstkModule, "typeof lil:", typeof lil, "typeof Worker:", typeof Worker, "typeof Blob:", typeof Blob);

const gui = new lil.GUI({ width: 260 });
const actions = {
    // Clicking the row always opens the file dialog (load, or replace the
    // current file); the injected ✕ (see setFileChip) handles unloading.
    loadLypFile: () => vscode.postMessage({ command: "loadLypFile" }),
    loadMarkerFile: () => vscode.postMessage({ command: "loadMarkerFile" }),
    resetView: () => modulePromise.then((Module) => Module.resetView()),
    showInfill: false,
    mergeOverlaps: false,
    measure: false
};
const lypController = gui.add(actions, "loadLypFile").name("Load KLayout .lyp File");
const markerController = gui.add(actions, "loadMarkerFile").name("Load Marker File (.lyrdb / DRC)");
gui.add(actions, "resetView").name("Reset View");
gui.add(actions, "showInfill").name("Infill")
    .onChange((show) => modulePromise.then((Module) => Module.setShowInfill(show)));
// Draw each layer as the union of its polygons (boundary + fill only, no
// internal edges) -- a pure render-mode toggle, no re-parse involved.
gui.add(actions, "mergeOverlaps").name("Merge Overlaps")
    .onChange((on) => modulePromise.then((Module) => Module.setMergeMode(on)));
const measureController = gui.add(actions, "measure").name("Measure")
    .onChange((on) => modulePromise.then((Module) => Module.setMeasureMode(on)));

// Reflects a loaded-file state in a lil-gui button row (used by both the
// .lyp and marker-file rows). With no file it's a plain load button. Once a
// file is loaded it shows the filename with an ✕ on the right that unloads
// it via onUnload. Clicking the filename itself re-opens the dialog to swap
// in a different file. (The .lyp-* CSS classes are shared by both rows.)
function setFileChip(controller, name, { idleLabel, idleTitle, unloadTitle, onUnload }) {
    // Remove any ✕ from a previous loaded state before re-deciding.
    const existingX = controller.domElement.querySelector(".lyp-unload");
    if (existingX) existingX.remove();
    controller.domElement.classList.toggle("lyp-loaded", !!name);

    if (!name) {
        controller.name(idleLabel);
        controller.domElement.title = idleTitle;
        return;
    }

    controller.name(name);
    controller.domElement.title = `${name} — click to replace, ✕ to unload`;
    const x = document.createElement("span");
    x.className = "lyp-unload";
    x.textContent = "✕";
    x.title = unloadTitle;
    x.addEventListener("click", (event) => {
        // The ✕ overlays the row's full-width <button> but isn't inside it,
        // so a click here never reaches the load-dialog handler; stopping
        // propagation just makes that explicit.
        event.stopPropagation();
        onUnload();
    });
    controller.domElement.appendChild(x);
}

function setLypChip(name) {
    setFileChip(lypController, name, {
        idleLabel: "Load KLayout .lyp File",
        idleTitle: "Load a KLayout .lyp layer-properties file",
        unloadTitle: "Unload .lyp",
        onUnload: () => {
            modulePromise.then((Module) => {
                // Empty text clears g_lyp_info and reverts layers to hash colors.
                Module.loadLypText("");
                renderLayerList(Module.getLayers());
            });
            vscode.postMessage({ command: "unloadLypFile" });
            setLypChip(null);
        }
    });
}

function setMarkerChip(name) {
    setFileChip(markerController, name, {
        idleLabel: "Load Marker File (.lyrdb / DRC)",
        idleTitle: "Load a KLayout report database (.lyrdb) or Calibre DRC ASCII results database",
        unloadTitle: "Unload marker file",
        onUnload: () => {
            modulePromise.then((Module) => Module.clearMarkers());
            vscode.postMessage({ command: "unloadMarkerFile" });
            removeMarkerBrowser();
            currentMarkers = null;
            setMarkerChip(null);
        }
    });
}
setLypChip(null);
setMarkerChip(null);

let layersFolder = null;

// Tints a lil-gui row/folder's 4px left border with a layer's frame color --
// lil-gui has no built-in color swatch for booleans, so the border is the cue.
function tintBorder(el, color) {
    if (el) el.style.borderLeft = `4px solid ${color}`;
}

// Adds one visibility checkbox for a single (layer, datatype) item to `parent`.
// onSync (optional) refreshes the enclosing category's "all" checkbox after a
// toggle. Returns {controller, state} so the category toggle can drive it.
function addLayerRow(parent, item, onSync) {
    const label = item.name
        ? `${item.layer}/${item.datatype} – ${item.name}`
        : `${item.layer}/${item.datatype}`;
    const state = { visible: item.visible };
    const controller = parent.add(state, "visible")
        .name(label)
        .onChange((visible) => {
            modulePromise.then((Module) => Module.setLayerVisible(item.layer, item.datatype, visible));
            if (onSync) onSync();
        });
    tintBorder(controller.domElement, item.frameColor);
    controller.domElement.title = label;
    return { controller, state };
}

// Rebuilds the layer folder from Module.getLayers() -- {layer, datatype, name,
// group, fillColor, frameColor, visible}[], all plain scalars/strings (no
// per-polygon geometry crosses into JS). Layers are keyed on the (layer,
// datatype) pair and organized into collapsible categories from the .lyp's
// top-level groups (`group`, e.g. "Metals"): each category folder has an "all"
// checkbox that toggles every layer under it, plus one checkbox per
// layer/datatype. Layers with no category (ungrouped, or present in the GDS but
// absent from the .lyp) go under "Other layers". Called after every
// load/loadLypText() since either can change the layer set, colors, or
// visibility.
function renderLayerList(layers) {
    if (layersFolder) {
        layersFolder.destroy();
    }
    // lil-gui folders open by default (dat.gui's were closed) -- keep the
    // panel compact until the user asks for the layer list.
    layersFolder = gui.addFolder("Layers");
    layersFolder.close();

    // Group by category, preserving getLayers()'s ordering (lyp order first).
    // Ungrouped layers collect under a single trailing "Other layers" bucket.
    const OTHER = "Other layers";
    const categories = new Map();
    for (const layer of layers) {
        const key = layer.group || OTHER;
        if (!categories.has(key)) categories.set(key, []);
        categories.get(key).push(layer);
    }

    for (const [category, items] of categories) {
        const folder = layersFolder.addFolder(`${category}  (${items.length})`);
        folder.close();
        // The folder's own <div.lil-gui> (title + children) carries a 4px
        // border too.
        tintBorder(folder.domElement, items[0].frameColor);

        const children = [];
        const syncCategory = () => {
            const all = children.every((c) => c.state.visible);
            if (allState.visible !== all) {
                allState.visible = all;
                allController.updateDisplay();
            }
        };
        const allState = { visible: items.every((it) => it.visible) };
        const allController = folder.add(allState, "visible")
            .name("◼ all")
            .onChange((visible) => {
                modulePromise.then((Module) => {
                    for (const c of children) {
                        c.state.visible = visible;
                        c.controller.updateDisplay();
                        Module.setLayerVisible(c.item.layer, c.item.datatype, visible);
                    }
                });
            });
        allController.domElement.title = `Toggle all ${items.length} layers in ${category}`;

        for (const item of items) {
            const row = addLayerRow(folder, item, syncCategory);
            row.item = item;
            children.push(row);
        }
    }
}

// ---- Marker browser (DRC/LVS violation databases) ----
// The parsed normalized model (see marker-parsers.js) is the JS-side source
// of truth for the browser UI; wasm only holds the flattened geometry it
// draws. Rebuilt from scratch on every marker load.
let currentMarkers = null;
let markersFolder = null;
let selectedMarkerId = -1;
let selectedMarkerRow = null; // the selected item's lil-gui row <div>, if it has one
const markerItemRows = new Map(); // item id -> row <div> (only the uncapped rows)

// Browser-wide controls, kept outside the model so they survive re-renders
// and marker-file swaps within a session. opacity scales the whole overlay's
// alpha in wasm; hideEmpty filters clean categories (0 violations) out of
// the panel (they draw nothing anyway).
const markerUiState = { opacity: 1.0, hideEmpty: false };

// The GUI's DOM does not survive 100k rows -- cap the rows per category and
// close with a disabled "… N more" row. Category visibility still covers
// capped-off items (it lives in wasm per-category), and [ / ] key stepping
// reaches them too.
const MAX_MARKER_ROWS_PER_CATEGORY = 200;

function removeMarkerBrowser() {
    if (markersFolder) {
        markersFolder.destroy();
        markersFolder = null;
    }
    markerItemRows.clear();
    selectedMarkerRow = null;
    selectedMarkerId = -1;
}

// Marks `item` selected (white emphasis in wasm + row highlight) and zooms
// the view to its bbox. Geometry-less items (bbox null) just select.
function selectMarker(Module, item) {
    if (selectedMarkerRow) selectedMarkerRow.classList.remove("marker-selected");
    selectedMarkerRow = markerItemRows.get(item.id) || null;
    if (selectedMarkerRow) selectedMarkerRow.classList.add("marker-selected");
    selectedMarkerId = item.id;
    Module.setSelectedMarker(item.id);
    if (item.bbox) {
        Module.zoomToBox(item.bbox.minX, item.bbox.minY, item.bbox.maxX, item.bbox.maxY);
    }
}

// %.4g-ish coordinate for the item rows -- full precision belongs in the
// tooltip, not a 260px panel.
function fmtCoord(v) {
    return Number(v.toPrecision(4)).toString();
}

function renderMarkerBrowser(model) {
    // Re-renders (e.g. the hide-empty toggle) keep the current selection;
    // fresh loads reset selectedMarkerId first (see the markersLoaded handler).
    const keepSelectedId = selectedMarkerId;
    removeMarkerBrowser();
    selectedMarkerId = keepSelectedId;

    const totalItems = model.categories.reduce((n, c) => n + c.items.length, 0);
    markersFolder = gui.addFolder(`Markers (${totalItems})`);
    markersFolder.open();

    if (model.warnings.length > 0) {
        console.error("[GDS] marker warnings:", model.warnings.join(" | "));
        const row = markersFolder.add({ w: () => {} }, "w")
            .name(`⚠ ${model.warnings.length} warning${model.warnings.length === 1 ? "" : "s"}`);
        row.domElement.title = model.warnings.join("\n");
    }

    const opacityController = markersFolder.add(markerUiState, "opacity", 0, 1, 0.05).name("Opacity")
        .onChange((value) => modulePromise.then((Module) => Module.setMarkerOpacity(value)));
    opacityController.domElement.title = "Opacity of the whole marker overlay";

    const emptyCount = model.categories.filter((c) => c.items.length === 0).length;
    const hideEmptyController = markersFolder.add(markerUiState, "hideEmpty").name("Hide empty categories")
        .onChange(() => renderMarkerBrowser(model));
    hideEmptyController.domElement.title =
        `Hide categories with 0 violations (currently ${emptyCount} of ${model.categories.length})`;

    model.categories.forEach((cat, categoryIndex) => {
        if (markerUiState.hideEmpty && cat.items.length === 0) return;
        const folder = markersFolder.addFolder(`${cat.name}  (${cat.items.length})`);
        folder.close();
        if (cat.description) folder.domElement.title = cat.description;

        // uiVisible (consulted by stepMarker so [ / ] skips hidden categories)
        // survives re-renders -- wasm keeps the real per-category visibility,
        // so the checkbox must not silently reset out of sync with it.
        // Categories start hidden (matching wasm's MarkerCategoryGL default):
        // the user opts in to the rulechecks they want drawn.
        if (cat.uiVisible === undefined) cat.uiVisible = false;
        const visState = { visible: cat.uiVisible };
        const visController = folder.add(visState, "visible").name("◼ visible")
            .onChange((visible) => {
                cat.uiVisible = visible;
                modulePromise.then((Module) => Module.setMarkerCategoryVisible(categoryIndex, visible));
            });
        visController.domElement.title = `Show/hide all ${cat.items.length} markers in ${cat.name}`;

        for (const item of cat.items.slice(0, MAX_MARKER_ROWS_PER_CATEGORY)) {
            const label = item.bbox
                ? `#${item.label} (${fmtCoord((item.bbox.minX + item.bbox.maxX) / 2)}, ${fmtCoord((item.bbox.minY + item.bbox.maxY) / 2)})`
                : `#${item.label}`;
            const controller = folder.add({ go: () => modulePromise.then((Module) => selectMarker(Module, item)) }, "go")
                .name(label);
            controller.domElement.title = [item.note, cat.description].filter(Boolean).join("\n") || label;
            markerItemRows.set(item.id, controller.domElement);
        }
        if (cat.items.length > MAX_MARKER_ROWS_PER_CATEGORY) {
            const more = folder.add({ m: () => {} }, "m")
                .name(`… ${cat.items.length - MAX_MARKER_ROWS_PER_CATEGORY} more (press [ or ] to step)`);
            more.domElement.classList.add("marker-more-row");
        }
    });

    // Restore the selected item's row highlight after a re-render.
    selectedMarkerRow = markerItemRows.get(selectedMarkerId) || null;
    if (selectedMarkerRow) selectedMarkerRow.classList.add("marker-selected");
}

// The [ and ] keys step the selection backward/forward through every item
// in checked categories (wrapping), including items past the per-category
// row cap. With no category checked (the default state right after a load),
// step through everything instead -- the selected marker draws regardless of
// category visibility, so stepping is never a dead key.
function stepMarker(direction) {
    if (!currentMarkers) return;
    let items = [];
    for (const cat of currentMarkers.categories) {
        if (cat.uiVisible === false) continue;
        items.push(...cat.items);
    }
    if (items.length === 0) {
        items = currentMarkers.categories.flatMap((cat) => cat.items);
    }
    if (items.length === 0) return;
    let idx = items.findIndex((it) => it.id === selectedMarkerId);
    idx = idx < 0 ? (direction > 0 ? 0 : items.length - 1) : (idx + direction + items.length) % items.length;
    modulePromise.then((Module) => selectMarker(Module, items[idx]));
}

// Capture phase, because every lil-gui controller stopPropagation()s keydown
// in the bubble phase -- a plain window listener would never hear [ / ]
// while focus sits anywhere inside the panel, which is the normal state
// after clicking any row (boolean rows are <label>s that focus their
// checkbox; marker rows are <button>s that keep focus).
window.addEventListener("keydown", (event) => {
    // Don't hijack typing in lil-gui's text/number inputs -- but focused
    // checkboxes and buttons must not block marker stepping.
    const t = event.target;
    const tag = t && t.tagName;
    if (tag === "TEXTAREA" || (tag === "INPUT" && t.type !== "checkbox")) return;
    if (event.key === "[") stepMarker(-1);
    else if (event.key === "]") stepMarker(1);
}, true);

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
        setLypChip(message.name || null);
    } else if (message.type === "markersLoaded") {
        modulePromise.then((Module) => {
            let model;
            try {
                // Format sniffed by content (lyrdb XML vs Calibre ASCII) --
                // see marker-parsers.js, loaded via its own <script> tag.
                model = parseMarkerFile(message.text, DOMParser);
            } catch (err) {
                console.error("[GDS] marker parse failed:", err);
                removeMarkerBrowser();
                currentMarkers = null;
                Module.clearMarkers();
                setMarkerChip(message.name || null);
                markerController.domElement.title = `Failed to parse ${message.name}: ${err.message || err}`;
                return;
            }
            currentMarkers = model;
            Module.setMarkers(flattenMarkerModel(model));
            // The slider state outlives marker swaps; wasm resets selection
            // on setMarkers but keeps opacity, so re-assert both explicitly.
            Module.setMarkerOpacity(markerUiState.opacity);
            selectedMarkerId = -1;
            renderMarkerBrowser(model);
            setMarkerChip(message.name || null);
        });
    } else if (message.type === "toggleDebugTools") {
        // "GDSLens: Toggle Debug Tools" command -- show/hide the upper-left
        // #ui readout and the debug-log toggle button (both hidden by
        // default, see viewer.html).
        document.body.classList.toggle("debug");
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
                    Module.uploadLayers(workerMessage.layers, workerMessage.instanceGroups, workerMessage.bbox);
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
