// Thin bootstrap: instantiate the wasm module and relay postMessage payloads
// from the extension host into it. JS never touches GDS/GL data -- that all
// lives in wasm/renderer.cpp (GL context + shaders + camera + input) and
// wasm/bindings.cpp (gdstk GDSII/OASIS parsing), which attach directly to
// #glCanvas and the DOM themselves. The control surface (load .lyp button +
// per-layer visibility toggles) is built with lil-gui
// (vendor/lil-gui.umd.min.js).
//
// Loading a layout file is split across a Worker (see wasm-worker.js) and this
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
    // Bound to the "Go to (x, y)" text box below; lil-gui writes the typed
    // string back into this property.
    gotoCoord: "",
    showInfill: false,
    showText: false,
    mergeOverlaps: false,
    // On by default -- matches g_show_grid in renderer.cpp, which is the
    // renderer's own initial state (nothing pushes this value down at startup).
    showGrid: true
};
const lypController = gui.add(actions, "loadLypFile").name("Load KLayout .lyp File");
const markerController = gui.add(actions, "loadMarkerFile").name("Load Marker File (.lyrdb / DRC)");
gui.add(actions, "resetView").name("Reset View");

// ---- Go to coordinate ----
// Coordinates arrive from outside the viewer all day -- a DRC report, a
// colleague's message, a generator's log -- and until now there was nowhere to
// put one. Panning is all this does: the zoom you already chose is information
// the pasted coordinate doesn't carry (see goToPoint in renderer.cpp).
//
// The accepted forms are whatever those sources actually produce, which is
// "x, y" with any of the usual decorations: parentheses, a semicolon or bare
// whitespace as the separator, and an optional per-number unit. Microns are the
// default because that's what the readout, the ruler and the .lyrdb files all
// speak.
const COORD_UNITS = {
    nm: 1e-3,
    um: 1,
    "µm": 1,  // MICRO SIGN
    "μm": 1,  // GREEK SMALL LETTER MU -- both are in the wild
    mm: 1e3
};
// One number plus an optional unit; the parse takes the first two matches and
// requires the rest of the string to be separators, so "1 2 3" is rejected
// rather than silently read as "1 2".
const COORD_TOKEN = /(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(nm|um|µm|μm|mm)?/gi;
// What may surround the two numbers -- punctuation, plus a bare x/y label,
// since "x=12.5, y=40" is a shape real reports print. Anything else means the
// string wasn't a coordinate pair, so it's rejected rather than half-read.
const COORD_FILLER = /^[\s(),;:=xy]*$/i;

function parseCoordinatePair(text) {
    const numbers = [];
    let start = 0;
    let end = 0;
    COORD_TOKEN.lastIndex = 0;
    for (let match = COORD_TOKEN.exec(text); match; match = COORD_TOKEN.exec(text)) {
        numbers.push(parseFloat(match[1]) * (match[2] ? COORD_UNITS[match[2].toLowerCase()] : 1));
        if (numbers.length === 1) start = match.index;
        end = COORD_TOKEN.lastIndex;
        if (numbers.length === 2) break;
    }
    if (numbers.length !== 2 || !numbers.every(Number.isFinite)) return null;
    if (!COORD_FILLER.test(text.slice(0, start)) || !COORD_FILLER.test(text.slice(end))) return null;
    return { x: numbers[0], y: numbers[1] };
}

const gotoController = gui.add(actions, "gotoCoord").name("Go to (x, y)");
const GOTO_IDLE_TITLE = "Center the view on a coordinate in µm — \"12.5, -40\", \"(1.2mm, 300nm)\"";
gotoController.domElement.title = GOTO_IDLE_TITLE;

// Reports back through the row itself: lil-gui has no validation affordance,
// and a coordinate that silently does nothing is worse than no box at all.
function setGotoStatus(message) {
    gotoController.domElement.classList.toggle("goto-bad", !!message);
    gotoController.domElement.title = message ? `${message}\n\n${GOTO_IDLE_TITLE}` : GOTO_IDLE_TITLE;
}

// onFinishChange, not onChange: this fires on Enter/blur, so a half-typed
// "12" doesn't fly the view to x=12 on its way to "12.5".
gotoController.onFinishChange((text) => {
    if (!text.trim()) {
        setGotoStatus(null);
        return;
    }
    const point = parseCoordinatePair(text);
    if (!point) {
        setGotoStatus(`Could not read "${text}" as an x, y pair`);
        return;
    }
    modulePromise.then((Module) => {
        const onScreen = Module.goToPoint(point.x, point.y);
        setGotoStatus(onScreen ? null : `(${point.x}, ${point.y}) µm is outside this layout`);
    });
});

gui.add(actions, "showInfill").name("Infill")
    .onChange((show) => modulePromise.then((Module) => Module.setShowInfill(show)));
// Draw the layout's own labels (GDSII/OASIS TEXT elements) at a fixed
// on-screen size, in each label's layer color -- off by default because a
// full chip's worth of text buries the geometry it sits on.
const textController = gui.add(actions, "showText").name("Text")
    .onChange((show) => modulePromise.then((Module) => Module.setShowText(show)));
textController.domElement.title = "Show layout text labels, drawn in their layer's color";
// Draw each layer as the union of its polygons (boundary + fill only, no
// internal edges) -- a pure render-mode toggle, no re-parse involved.
const mergeController = gui.add(actions, "mergeOverlaps").name("Merge Overlaps")
    .onChange((on) => modulePromise.then((Module) => Module.setMergeMode(on)));
// Background reference grid, pitched at a power-of-ten nm/µm/mm step that
// follows the zoom (see draw_grid).
const gridController = gui.add(actions, "showGrid").name("Grid")
    .onChange((show) => modulePromise.then((Module) => Module.setShowGrid(show)));
gridController.domElement.title = "Show the background grid, spaced at a round step that follows the zoom";

// ---- Interaction mode (Pan / Measure) ----
// The canvas can only do one thing with a click, so the two are exclusive
// modes rather than an "on top of panning" toggle: in Pan mode a drag moves
// the view, in Measure mode clicks place the ruler's two ends (see
// on_mousedown in renderer.cpp) and dragging does nothing. Rendered as a
// segmented pair of buttons -- a checkbox would say "measure is an extra",
// which is exactly the wrong mental model. Wasm only needs the boolean; the
// row below is the whole difference.
const MODES = [
    { id: "pan", label: "Pan", title: "Drag to pan the view, wheel to zoom" },
    { id: "measure", label: "Measure", title: "Click two points to measure the distance between them (Esc to cancel)" }
];
let currentMode = "pan";
const modeButtons = new Map();

// Built by hand instead of via gui.add(): lil-gui has no segmented-control
// type. Reusing its own .lil-controller/.lil-name/.lil-widget classes means
// the row picks up the panel's row metrics and theme colors for free (the
// button styling itself lives in viewer.html).
const modeRow = document.createElement("div");
modeRow.className = "lil-controller mode-row";
const modeName = document.createElement("div");
modeName.className = "lil-name";
modeName.textContent = "Mode";
const modeWidget = document.createElement("div");
modeWidget.className = "lil-widget mode-widget";
for (const mode of MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = mode.label;
    btn.title = mode.title;
    btn.addEventListener("click", () => setMode(mode.id));
    modeWidget.appendChild(btn);
    modeButtons.set(mode.id, btn);
}
modeRow.appendChild(modeName);
modeRow.appendChild(modeWidget);
// Same slot the old "Measure" checkbox occupied: directly after the render
// toggles, and ahead of the layer list the load handler appends below.
mergeController.domElement.after(modeRow);

function setMode(id) {
    if (currentMode === id) return;
    currentMode = id;
    for (const [modeId, btn] of modeButtons) {
        btn.classList.toggle("mode-active", modeId === id);
    }
    // Leaving measure mode also drops any in-progress/finished ruler
    // (setMeasureMode(false) -> clearMeasurement in renderer.cpp).
    modulePromise.then((Module) => Module.setMeasureMode(id === "measure"));
}
modeButtons.get(currentMode).classList.add("mode-active");

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

// ---- Hierarchy tree (left panel) ----
// The design's cell tree, as parseGdsToLayers hands it back (see
// build_hierarchy in renderer.cpp): a flat cells[] array of
// {name, polygons, labels, bbox, refs} plus the indices of the top-level
// cells, where each ref is {cell, count, bbox, xform} -- one entry per
// distinct cell a parent places, however many times it places it.
//
// Rows are built lazily, only when a branch is opened: cells[] describes each
// cell once, but the tree it spans is the expansion of a DAG, so a mid-sized
// chip's fully materialized tree is far larger than its library -- and nobody
// reads more than the few branches they opened.
const hierarchyPanel = document.getElementById("hierarchyPanel");
const hierarchyTree = document.getElementById("hierarchyTree");
const hierarchyCount = document.getElementById("hierarchyCount");
const hierarchyHide = document.getElementById("hierarchyHide");
const hierarchyShowBtn = document.getElementById("hierarchyShowBtn");

let hierarchyModel = null;
// Open branches and the selected row are keyed by their path of cell names
// ("TOP/PIXEL/TAP"), not by DOM node: a reload throws every row away, and a
// path still identifies the same branch in the re-read file, so an edit-and-
// reload lands back where you were rather than collapsed to the roots.
const hierarchyExpanded = new Set();
let hierarchySelectedPath = null;
let hierarchySelectedRow = null;
// The selected row's world-space boxes, one per placement it stands for (empty
// for a cell with no geometry), kept so the canvas outlines can be re-pushed
// whenever the panel opens or closes -- see syncCellHighlight.
let hierarchySelectedBoxes = [];
// Which design the state above belongs to, so opening a different file starts
// from a clean tree instead of inheriting another design's open branches.
let hierarchyRootKey = null;
// Set once the user hides or shows the panel by hand; from then on that
// decision wins over the default below on every subsequent load.
let hierarchyUserChoice = null;
// Mirrors kMaxHierarchyDepth in renderer.cpp. References form a DAG in any
// valid file, so this only bites a malformed one that closes a loop -- where a
// branch could otherwise be opened without end.
const HIERARCHY_MAX_DEPTH = 256;

// [a, b, c, d, tx, ty] laid out as renderer.cpp's Affine2D: x' = a*x + b*y + tx,
// y' = c*x + d*y + ty.
const HIERARCHY_IDENTITY = [1, 0, 0, 1, 0, 0];

// compose(outer, inner) applied to a point == outer applied to inner applied
// to it (the JS twin of compose_affine in renderer.cpp).
function composeXform(outer, inner) {
    return [
        outer[0] * inner[0] + outer[1] * inner[2],
        outer[0] * inner[1] + outer[1] * inner[3],
        outer[2] * inner[0] + outer[3] * inner[2],
        outer[2] * inner[1] + outer[3] * inner[3],
        outer[0] * inner[4] + outer[1] * inner[5] + outer[4],
        outer[2] * inner[4] + outer[3] * inner[5] + outer[5]
    ];
}

// A box mapped through a transform, as the box of its four mapped corners --
// an over-estimate under a non-90° rotation, same as the wasm side's
// placed_box, and for framing the camera that's immaterial.
function transformBox(m, box) {
    const corners = [[box.minX, box.minY], [box.maxX, box.minY], [box.minX, box.maxY], [box.maxX, box.maxY]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of corners) {
        const wx = m[0] * x + m[1] * y + m[4];
        const wy = m[2] * x + m[3] * y + m[5];
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy);
    }
    return { minX, maxX, minY, maxY };
}

// The boxes to outline for one tree node: one per placement the row stands for.
// A row is a cell *as one parent places it*, so a cell placed 40 times is 40
// separate rectangles where the copies actually sit -- the box spanning all 40
// (which is what the row frames the camera on) mostly encloses other cells'
// geometry, and drawing that instead says the selected cell is everything in it.
//
// Each placement transform maps the child's own frame into the parent's, so its
// world box is the child cell's own box carried through the placement and then
// through the parent's transform. Rows over the tree's placement cap (see
// kMaxRowPlacements in renderer.cpp) carry no transforms; those fall back to the
// spanning box, since a partial set of copies is worse than an honest envelope.
function hierarchyBoxes(node, cell, parentXform, spanningBox) {
    const placements = node.placements;
    if (!placements || placements.length < 6 || !cell.bbox) {
        return spanningBox ? [spanningBox] : [];
    }
    const boxes = [];
    for (let i = 0; i + 5 < placements.length; i += 6) {
        const xform = composeXform(parentXform, [
            placements[i], placements[i + 1], placements[i + 2],
            placements[i + 3], placements[i + 4], placements[i + 5]
        ]);
        boxes.push(transformBox(xform, cell.bbox));
    }
    return boxes;
}

// Shows/hides the panel. byUser marks the entry points the user drives (the
// header's ✕, the reopen button, the H key), which is what makes the choice
// stick across loads.
function setHierarchyOpen(open, byUser) {
    if (byUser) hierarchyUserChoice = open;
    if (hierarchyPanel) hierarchyPanel.classList.toggle("hidden", !open);
    document.body.classList.toggle("hierarchy-open", open);
    // The outline belongs to the panel: it's the tree pointing at the layout,
    // so with the tree away it would be a dashed rectangle with nothing on
    // screen to explain it. Putting the panel away takes it down, and bringing
    // the panel back puts it up again for whatever row is still selected.
    syncCellHighlight();
}

// Pushes the canvas outlines the current state calls for: the selected row's
// boxes while the panel is open, nothing otherwise. Every change to either half
// of that -- the selection, the panel's visibility -- goes through here rather
// than calling into wasm directly, so the two can't disagree.
function syncCellHighlight() {
    const open = hierarchyPanel && !hierarchyPanel.classList.contains("hidden");
    const boxes = open ? hierarchySelectedBoxes : null;
    modulePromise.then((Module) => {
        if (!boxes || boxes.length === 0) {
            Module.clearCellHighlight();
            return;
        }
        // Flat [minX, minY, maxX, maxY, ...] -- one bulk conversion in wasm
        // rather than a call (and a JS object read) per placement.
        const flat = [];
        for (const box of boxes) flat.push(box.minX, box.minY, box.maxX, box.maxY);
        Module.setCellHighlight(flat);
    });
}

// Marks a row selected: the row itself in the panel, and -- via `boxes`, the
// placements the row stands for (see hierarchyBoxes) -- an outline around each
// copy of that cell on the canvas. The outlines are the half that survives
// navigating away: framing a cell says which shapes it is only until the view
// moves, whereas the boxes stay glued to the geometry, so zooming out to see
// where the cell sits in the design keeps the answer instead of losing it. Cells
// with no geometry pass no boxes and draw nothing -- there's no region to point
// at.
function hierarchySelect(row, path, boxes) {
    if (hierarchySelectedRow) hierarchySelectedRow.classList.remove("hier-selected");
    hierarchySelectedRow = row;
    hierarchySelectedPath = path;
    hierarchySelectedBoxes = boxes || [];
    row.classList.add("hier-selected");
    syncCellHighlight();
}

// Drops the selection entirely (Escape, and every path that replaces the tree).
// hierarchySelectedPath is cleared too, so a rebuild doesn't re-select it.
function hierarchyDeselect() {
    if (hierarchySelectedRow) hierarchySelectedRow.classList.remove("hier-selected");
    hierarchySelectedRow = null;
    hierarchySelectedPath = null;
    hierarchySelectedBoxes = [];
    syncCellHighlight();
}

function hierarchyTooltip(cell, node, box, boxes) {
    const lines = [cell.name];
    if (node.count > 1) {
        // Only the first copy is walked into, so say so on the row rather than
        // leaving "expand" and "×64" to look like a contradiction. Whether the
        // copies are outlined one by one or covered by a single box is a visible
        // difference on screen, so the row says which it is.
        const each = boxes.length > 1 ? "each outlined" : "outlined as one box, too many to mark separately";
        lines.push(`${node.count} placements here, ${each} (expanding follows the first)`);
    }
    lines.push(`${cell.polygons} own shape${cell.polygons === 1 ? "" : "s"}, ` +
               `${cell.labels} label${cell.labels === 1 ? "" : "s"}, ` +
               `${cell.refs.length} child cell${cell.refs.length === 1 ? "" : "s"}`);
    if (box) {
        lines.push(`${fmtCoord(box.maxX - box.minX)} × ${fmtCoord(box.maxY - box.minY)} µm ` +
                   `at (${fmtCoord((box.minX + box.maxX) / 2)}, ${fmtCoord((box.minY + box.maxY) / 2)}) — ` +
                   `click to zoom to it and outline it (Esc clears)`);
    } else {
        lines.push("empty — no geometry to zoom to");
    }
    return lines.join("\n");
}

// Appends a row per entry of `nodes` (ref entries, or the synthetic root
// entries built in renderHierarchy) to `container`.
//
// parentXform maps the parent cell's own coordinates into world space, so a
// node's world box is its bbox -- which is in the parent's frame, spanning
// every placement the entry stands for -- mapped through it. Descending
// instead composes the entry's own xform, the *first* placement's: a cell
// placed 64 times is one row that frames all 64, and opening it walks into one
// of them, because there is no single deeper coordinate frame to offer. The
// per-placement boxes (what selecting the row outlines) are the other side of
// that same collapse -- see hierarchyBoxes.
function addHierarchyRows(container, nodes, depth, parentPath, parentXform) {
    for (const node of nodes) {
        const cell = hierarchyModel.cells[node.cell];
        if (!cell) continue;

        const path = parentPath ? `${parentPath}/${cell.name}` : cell.name;
        const box = node.bbox ? transformBox(parentXform, node.bbox) : null;
        const boxes = hierarchyBoxes(node, cell, parentXform, box);
        const childXform = composeXform(parentXform, node.xform);
        const expandable = cell.refs.length > 0 && depth + 1 < HIERARCHY_MAX_DEPTH;

        const row = document.createElement("div");
        row.className = "hier-row";
        row.style.paddingLeft = `${6 + depth * 12}px`;
        if (!box) row.classList.add("hier-boxless");

        const twisty = document.createElement("span");
        twisty.className = "hier-twisty";
        twisty.textContent = expandable ? "▸" : "";
        const name = document.createElement("span");
        name.className = "hier-name";
        name.textContent = cell.name;
        const count = document.createElement("span");
        count.className = "hier-count";
        if (node.count > 1) count.textContent = `×${node.count}`;
        row.append(twisty, name, count);
        row.title = hierarchyTooltip(cell, node, box, boxes);

        const children = document.createElement("div");
        children.className = "hier-children hidden";
        container.append(row, children);

        let built = false;
        function setExpanded(open) {
            if (!expandable) return;
            if (open && !built) {
                built = true;
                addHierarchyRows(children, cell.refs, depth + 1, path, childXform);
            }
            children.classList.toggle("hidden", !open);
            twisty.textContent = open ? "▾" : "▸";
            if (open) hierarchyExpanded.add(path);
            else hierarchyExpanded.delete(path);
        }

        twisty.addEventListener("click", (event) => {
            // The twisty sits inside the row, whose own click moves the
            // camera -- opening a branch shouldn't also fly the view there.
            event.stopPropagation();
            setExpanded(children.classList.contains("hidden"));
        });
        row.addEventListener("click", () => {
            // Selection outlines every placement; the camera still frames all of
            // them at once, since that's the one view that shows the row's whole
            // meaning.
            hierarchySelect(row, path, boxes);
            if (!box) return;
            modulePromise.then((Module) => Module.zoomToBox(box.minX, box.minY, box.maxX, box.maxY));
        });

        // Re-selecting after a rebuild (a reload, or reopening a branch) puts
        // the outlines back without moving the camera -- only a click moves it.
        if (path === hierarchySelectedPath) hierarchySelect(row, path, boxes);
        if (hierarchyExpanded.has(path)) setExpanded(true);
    }
}

// Rebuilds the tree from a freshly loaded design (or clears it, for model
// null -- a load that failed has no hierarchy to browse).
function renderHierarchy(model) {
    if (!hierarchyTree) return;
    hierarchyModel = model;
    // Every row is about to be thrown away. The selected *path* is kept -- the
    // rows rebuilt below re-select it, which puts the canvas outlines back at
    // the reloaded file's coordinates -- but the boxes themselves are dropped
    // first: if this design has no cell on that path, nothing else would.
    hierarchySelectedRow = null;
    hierarchySelectedBoxes = [];
    syncCellHighlight();
    hierarchyTree.textContent = "";

    const cells = (model && model.cells) || [];
    // Filtered once here so everything below can index cells[] freely -- the
    // omitted case ships no cells at all, and a root that names no cell would
    // otherwise throw somewhere less obvious.
    const roots = ((model && model.roots) || []).filter((index) => cells[index]);
    const cellCount = model ? model.cellCount : 0;

    // .hierarchy-available says there's a tree to show, open or not, which is
    // what the stale banner's left edge keys off (the reopen button sits in
    // the same corner it starts in).
    document.body.classList.toggle("hierarchy-available", cellCount > 0);

    if (!model || cellCount === 0) {
        if (hierarchyCount) hierarchyCount.textContent = "";
        if (hierarchyShowBtn) hierarchyShowBtn.classList.add("hidden");
        setHierarchyOpen(false);
        return;
    }
    if (hierarchyShowBtn) hierarchyShowBtn.classList.remove("hidden");
    if (hierarchyCount) hierarchyCount.textContent = `${cellCount} cell${cellCount === 1 ? "" : "s"}`;

    // A different design: drop the previous one's open branches and selection
    // rather than matching them against unrelated cell names.
    const rootKey = roots.map((i) => cells[i].name).join(" ");
    if (rootKey !== hierarchyRootKey) {
        hierarchyRootKey = rootKey;
        hierarchyExpanded.clear();
        hierarchySelectedPath = null;
    }

    if (model.omitted) {
        const note = document.createElement("div");
        note.className = "hier-note";
        note.textContent = `This design has ${cellCount} cells — too many to browse as a tree, so it isn't built.`;
        hierarchyTree.append(note);
        setHierarchyOpen(hierarchyUserChoice === true);
        return;
    }

    // First look at a design: open the top cell, so the panel shows what it's
    // made of instead of a single row you have to click to learn anything.
    if (hierarchyExpanded.size === 0 && roots.length > 0) {
        hierarchyExpanded.add(cells[roots[0]].name);
    }

    // Top-level cells are drawn as if referenced once by an invisible parent
    // at the identity transform -- their own coordinates *are* world
    // coordinates, which is exactly what that entry says.
    const rootNodes = roots.map((index) => ({
        cell: index,
        count: 1,
        bbox: cells[index].bbox,
        xform: HIERARCHY_IDENTITY
    }));
    addHierarchyRows(hierarchyTree, rootNodes, 0, "", HIERARCHY_IDENTITY);

    // Closed by default: the viewport belongs to the layout, and a panel that
    // takes 260px of it should be something you ask for. The rows above are
    // built either way -- they're what makes reopening instant -- and once the
    // panel has been opened by hand it stays open for the rest of the session,
    // including across reloads and other files.
    setHierarchyOpen(hierarchyUserChoice === true);
}

// Both the ✕ and the reopen button are the user speaking, as is the H key
// below -- all three go through here so the choice sticks.
function toggleHierarchy() {
    // Nothing loaded (or nothing to show): don't open an empty panel.
    if (!hierarchyPanel || !hierarchyModel || !hierarchyModel.cellCount) return;
    setHierarchyOpen(hierarchyPanel.classList.contains("hidden"), true);
}

if (hierarchyHide) {
    hierarchyHide.addEventListener("click", () => setHierarchyOpen(false, true));
}
if (hierarchyShowBtn) {
    hierarchyShowBtn.addEventListener("click", () => setHierarchyOpen(true, true));
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
    // Mode switching from the keyboard, since measuring is a two-hand job
    // (click, click, then back to panning): M enters measure mode, Escape
    // always lands back in pan mode and drops the ruler.
    else if (event.key === "m" || event.key === "M") setMode(currentMode === "measure" ? "pan" : "measure");
    // Escape is the "put the canvas back" key: it drops the ruler (by leaving
    // measure mode) and the selected cell's outline, the two things the viewer
    // draws on top of the layout at the user's request.
    else if (event.key === "Escape") {
        setMode("pan");
        hierarchyDeselect();
    }
    // H shows/hides the hierarchy tree -- it's the one panel that takes a
    // slice of the viewport, so getting it out of the way is worth a key.
    else if (event.key === "h" || event.key === "H") toggleHierarchy();
}, true);

// ---- "Newer version on disk" banner ----
// The extension host watches the layout file and posts 'fileChanged' when it
// changes underneath us (see the watcher in extension.cjs); this is only the
// UI for that. Clicking Reload asks the host to re-read and re-send the file
// as a fresh 'init' -- the webview never touches disk itself.
const staleBanner = document.getElementById("staleBanner");
const staleText = document.getElementById("staleText");
const staleReloadBtn = document.getElementById("staleReloadBtn");
const staleAlwaysBtn = document.getElementById("staleAlwaysBtn");
const staleDismiss = document.getElementById("staleDismiss");

function showStaleBanner(show, text) {
    if (!staleBanner) return;
    if (text) staleText.textContent = text;
    staleBanner.classList.toggle("hidden", !show);
}

if (staleReloadBtn) {
    staleReloadBtn.addEventListener("click", () => {
        showStaleBanner(false);
        vscode.postMessage({ command: "reloadFile" });
    });
}
if (staleAlwaysBtn) {
    // "Reload, and stop asking": writes through to the GDS-Lens.autoReload
    // setting so the choice sticks across viewers and restarts. One-way by
    // design -- the banner only exists while auto-reload is off, so there's
    // nothing here to turn it back off with; that's the "GDSLens: Toggle
    // Auto-Reload on Change" command (and the Settings UI).
    staleAlwaysBtn.addEventListener("click", () => {
        showStaleBanner(false);
        vscode.postMessage({ command: "setAutoReload", value: true });
        vscode.postMessage({ command: "reloadFile" });
    });
}
if (staleDismiss) {
    staleDismiss.addEventListener("click", () => showStaleBanner(false));
}

// State carried across a reload so re-reading the file doesn't reset the
// user's working context. Captured just before the new geometry is uploaded
// (uploadLayers re-frames the camera and rebuilds the layer table from the
// new file), re-applied just after.
function captureViewState(Module) {
    const layers = Module.getLayers();
    // Nothing drawn yet (reload triggered while the first load was still in
    // flight) -- there's no camera worth keeping, and restoring the default
    // zoom-1-at-origin would override the framing uploadLayers is about to do.
    if (layers.length === 0) return null;
    const visibility = {};
    for (const layer of layers) {
        visibility[`${layer.layer}/${layer.datatype}`] = layer.visible;
    }
    return { camera: Module.getCamera(), visibility: visibility };
}

function restoreViewState(Module, saved) {
    if (!saved) return;
    // Only layers that existed before are restored -- ones the edit newly
    // introduced keep the fresh load's default so they aren't invisible for
    // no discoverable reason.
    for (const layer of Module.getLayers()) {
        const wasVisible = saved.visibility[`${layer.layer}/${layer.datatype}`];
        if (wasVisible !== undefined && wasVisible !== layer.visible) {
            Module.setLayerVisible(layer.layer, layer.datatype, wasVisible);
        }
    }
    Module.setCamera(saved.camera.zoom, saved.camera.panX, saved.camera.panY);
}

const loadingOverlay = document.getElementById("loadingOverlay");
const loadingBarFill = document.getElementById("loadingBarFill");
const loadingPhase = document.getElementById("loadingPhase");
const loadingPercent = document.getElementById("loadingPercent");
const reloadProgress = document.getElementById("reloadProgress");
const reloadBarFill = document.getElementById("reloadBarFill");
const reloadLabel = document.getElementById("reloadLabel");
const loadError = document.getElementById("loadError");

// Every load-failure path ends here. Writing the DOM directly rather than
// going through Module.showLoadError matters: the module itself may be the
// thing that failed (instantiation rejected, or aborted on OOM mid-parse), in
// which case `modulePromise.then(...)` never runs and the user would be left
// staring at a stalled progress bar with no explanation. The wasm side is
// then told separately, best-effort, so it can clear any half-loaded layers.
function showFatalError(message) {
    console.error("[GDS] load failed:", message);
    loadError.textContent = "Could not open this layout\n\n" + message;
    endProgress();
    // Nothing loaded, so there's no cell tree to browse -- and leaving the
    // previous file's one up beside the error would invite clicking rows that
    // frame geometry no longer on screen.
    renderHierarchy(null);
    modulePromise.then((Module) => {
        Module.showLoadError(message);
        renderLayerList(Module.getLayers());
    }).catch(() => {
        // Module is gone -- the DOM message above is all we can offer.
    });
}

function clearFatalError() {
    loadError.textContent = "";
}

// describeLoadFailure comes from load-errors.js (its own <script> tag).

const phaseLabels = {
    parsing: "Parsing layout file...",
    flattening: "Flattening hierarchy...",
    triangulating: "Triangulating geometry..."
};

// Which of the two progress UIs the current load is driving (see
// beginProgress). Only one is on screen at a time, so updateProgress writes
// whichever that is.
let progressInline = false;

// inline: keep the viewport as it is and report progress in the top strip.
// Otherwise take the screen with the full overlay. Reloads pass true only
// when there's geometry already drawn to keep showing -- blanking the
// viewport for a reload throws away the very view the reload restores.
function beginProgress(inline) {
    progressInline = inline;
    loadingOverlay.classList.toggle("hidden", inline);
    reloadProgress.classList.toggle("hidden", !inline);
    updateProgress("parsing", 0, 1);
}

function endProgress() {
    loadingOverlay.classList.add("hidden");
    reloadProgress.classList.add("hidden");
}

function updateProgress(phase, current, total) {
    const label = phaseLabels[phase] || phase;
    const fraction = total > 0 ? current / total : 0;
    const percent = Math.round(fraction * 100);
    // Triangulation reports layers rather than a fraction of the file.
    const detail = phase === "triangulating" ? `Layer ${current}/${total}` : `${percent}%`;
    if (progressInline) {
        reloadBarFill.style.width = `${percent}%`;
        reloadLabel.textContent = `Reloading — ${label} ${detail}`;
        return;
    }
    loadingPhase.textContent = label;
    loadingBarFill.style.width = `${percent}%`;
    loadingPercent.textContent = detail;
}

// Registered synchronously (not inside the .then() below) so an 'init'
// message that arrives before wasm instantiation finishes isn't dropped --
// window message events aren't queued for late listeners.
console.log("[GDS] calling createGdstkModule() on main thread...");
// Synchronous handle on the same module modulePromise resolves to. The
// 'init' handler needs to read the *current* camera/layer state before the
// incoming parse replaces it, and a .then() would run too late for that.
let resolvedModule = null;
// The load currently in flight, so a reload can cancel it (see 'init').
let activeWorker = null;
// View state captured for the in-flight reload, re-applied once its geometry
// is uploaded. Null on a first open.
let pendingViewState = null;
const modulePromise = createGdstkModule();
modulePromise.then(
    (Module) => {
        resolvedModule = Module;
        console.log("[GDS] main-thread createGdstkModule() resolved OK");
    },
    (err) => {
        console.error("[GDS] main-thread createGdstkModule() REJECTED:", err);
        // Nothing else will ever run if this fails, so this is the one place
        // the message has to come from -- showFatalError's own best-effort
        // call into the module simply no-ops on the same rejection.
        showFatalError(`WebAssembly module failed to load: ${describeLoadFailure(err)}`);
    }
);

// ---- Theme (follows VS Code's light/dark theme) ----
// VS Code stamps the active theme kind onto <body> as vscode-light /
// vscode-dark / vscode-high-contrast[-light] and rewrites it live when the
// user switches themes, so the page chrome themes itself off that class in
// CSS alone (see the token block in viewer.html). What's left for JS is the
// half CSS can't reach: the canvas is drawn by renderer.cpp, which owns the
// background it clears to, the ruler/selection ink, and the fallback layer
// palette (all three assume a near-black background otherwise) -- plus the
// fallback for running this page outside a webview, where there is no
// vscode-* class and the OS preference is the only signal.
const lightMediaQuery = window.matchMedia("(prefers-color-scheme: light)");

function detectLightTheme() {
    const kinds = document.body.classList;
    // High-contrast light carries both vscode-high-contrast and
    // vscode-high-contrast-light, so the light check has to come first.
    if (kinds.contains("vscode-high-contrast-light") || kinds.contains("vscode-light")) return true;
    if (kinds.contains("vscode-high-contrast") || kinds.contains("vscode-dark")) return false;
    return lightMediaQuery.matches;
}

// Null until the first applyTheme(), so it can't match either decision and
// the initial push to wasm always happens.
let lightTheme = null;

function applyTheme() {
    const light = detectLightTheme();
    if (light === lightTheme) return;
    lightTheme = light;
    // The same class VS Code's own vscode-light would have set, so the OS
    // fallback lands on exactly the rules a webview gets for free. Toggling it
    // re-triggers the observer below, which then no-ops on this early return.
    document.body.classList.toggle("theme-light", light);
    modulePromise.then((Module) => {
        Module.setTheme(light);
        // setTheme recolors the layers in place (the fallback palette is
        // theme-dependent), so the panel's per-row color chips are stale.
        // Only worth rebuilding once there's a layer list to rebuild -- before
        // the first load renderLayerList would add an empty "Layers" folder.
        const layers = Module.getLayers();
        if (layers.length > 0) renderLayerList(layers);
    });
}

// A theme switch rewrites <body>'s class list rather than posting a message,
// so this is the only notification there is. (It also fires for the debug
// command's own class toggle, which applyTheme ignores.)
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
lightMediaQuery.addEventListener("change", applyTheme);
applyTheme();

window.addEventListener("message", (event) => {
    const message = event.data;
    console.log("[GDS] window message received, type:", message.type);
    if (message.type === "init") {
        console.log("[GDS] init payload: fileData byteLength =", message.fileData && message.fileData.byteLength,
                    "reload:", !!message.reload);
        // A reload supersedes any load still running (the file can change
        // again while a slow one is in flight) -- drop the old worker rather
        // than letting two of them race to upload geometry.
        if (activeWorker) {
            console.log("[GDS] superseding an in-flight load");
            activeWorker.terminate();
            activeWorker = null;
        }
        showStaleBanner(false);

        // Only meaningful on a reload: on first open there's nothing to keep,
        // and framing the view on the design is exactly what we want.
        // Captured synchronously off resolvedModule rather than through
        // modulePromise: the geometry has to be read *before* the new parse
        // lands, and a .then() would run after this handler returns.
        pendingViewState = null;
        if (message.reload && resolvedModule) {
            try {
                pendingViewState = captureViewState(resolvedModule);
            } catch (err) {
                // Nothing loaded yet, or the module is wedged -- reload as if
                // it were a first open (framed on the design) rather than
                // failing the reload outright.
                console.error("[GDS] could not capture view state, reloading framed:", err);
            }
        }

        // Captured state doubles as the test for "is there a view worth
        // keeping on screen": it's null exactly when nothing is drawn yet, and
        // an empty viewport behind a hairline bar reads as a hung viewer.
        beginProgress(pendingViewState !== null);

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
            showFatalError(`Failed to create worker: ${err.message || err}`);
            return;
        }
        startWorker(worker, message.fileData);
    } else if (message.type === "loadError") {
        // The extension host gave up before it could send any bytes (file too
        // large, unreadable, ...) -- without this the overlay would spin
        // forever waiting for an 'init' that never comes.
        showFatalError(message.message);
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
    } else if (message.type === "fileChanged") {
        // The file changed on disk and auto-reload is off, so offer it.
        showStaleBanner(true, message.text || "A newer version of this file is on disk.");
    } else if (message.type === "toggleDebugTools") {
        // "GDSLens: Toggle Debug Tools" command -- show/hide the debug entry
        // point (the button that opens #debugPanel, which holds both the
        // engine readout and the log), hidden by default, see viewer.html.
        document.body.classList.toggle("debug");
    }
});

function startWorker(worker, fileData) {
    activeWorker = worker;
    // Only fires for the Worker failing to start at all (e.g. its script
    // URL rejected by CSP) -- failures inside the worker's own async code
    // are reported via a 'gdsResult' message instead (see wasm-worker.js),
    // since a Worker's unhandled promise rejections don't reach this
    // handler.
    worker.onerror = (err) => {
        console.error("[GDS] worker.onerror fired:", err.message, "at", err.filename + ":" + err.lineno + ":" + err.colno, err.error);
        showFatalError(`Worker failed to start: ${err.message || err}`);
    };
    worker.onmessageerror = (err) => {
        console.error("[GDS] worker.onmessageerror fired (structured-clone failure):", err);
        showFatalError("Worker message failed to deserialize -- see devtools console");
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
            // Free the worker's copy of the geometry before uploading ours:
            // on a big design both threads holding it at once is what tips a
            // borderline load over the edge.
            worker.terminate();
            if (activeWorker === worker) activeWorker = null;
            if (!workerMessage.ok) {
                showFatalError(workerMessage.error);
                return;
            }
            console.log("[GDS] load succeeded, layer count:", workerMessage.layers.length);
            modulePromise.then((Module) => {
                // uploadLayers is the other place a big layout can run out of
                // memory -- the parse fit in the worker, but this thread's
                // module now has to hold the same geometry plus its VBOs. An
                // unhandled throw here would leave the progress bar spinning
                // forever, so surface it like any other load failure.
                try {
                    Module.uploadLayers(workerMessage.layers, workerMessage.instanceGroups, workerMessage.bbox);
                } catch (err) {
                    showFatalError(describeLoadFailure(err));
                    return;
                }
                clearFatalError();
                // Put the camera and per-layer visibility back before the
                // panel is rebuilt, so renderLayerList reflects the restored
                // checkboxes rather than the fresh load's defaults.
                if (pendingViewState) {
                    try {
                        restoreViewState(Module, pendingViewState);
                    } catch (err) {
                        console.error("[GDS] could not restore view state:", err);
                    }
                    pendingViewState = null;
                }
                renderLayerList(Module.getLayers());
                renderHierarchy(workerMessage.hierarchy);
                endProgress();
                console.log("[GDS] done, progress hidden");
            }, (err) => {
                showFatalError(`WebAssembly module failed to load: ${err && err.message ? err.message : err}`);
            });
        }
    };
    console.log("[GDS] posting 'parse' message to worker...");
    worker.postMessage(
        { type: "parse", fileData: fileData },
        [fileData]
    );
    console.log("[GDS] worker.postMessage('parse') call returned");
}
