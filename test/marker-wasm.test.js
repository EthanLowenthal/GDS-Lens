// Headless smoke test for renderer.cpp's marker bindings: evals the built
// gdstk_wasm.js in plain Node (no GL context -- g_gl_ready stays false, so
// only the CPU-side marker state is exercised) and asserts setMarkers /
// setMarkerCategoryVisible / setSelectedMarker / clearMarkers transitions via
// getMarkerStats(). Skipped when the wasm bundle hasn't been built.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const wasmJsPath = path.join(__dirname, "..", "src", "wasm", "build", "gdstk_wasm.js");
const wasmBuilt = fs.existsSync(wasmJsPath);

test("wasm marker state (headless)", { skip: !wasmBuilt && "src/wasm/build/gdstk_wasm.js not built" }, async () => {
    const { DOMParser } = require("@xmldom/xmldom");
    const { parseMarkerFile, flattenMarkerModel } = require("../src/marker-parsers.js");

    // The bundle is MODULARIZE + SINGLE_FILE: eval its source with `require`
    // in scope and capture the factory (see memory/DEVELOPING.md's headless
    // flow).
    const src = fs.readFileSync(wasmJsPath, "utf8");
    const scope = {};
    new Function("scope", "require", "__dirname", "__filename",
        src + "\nscope.createGdstkModule = createGdstkModule;")(
        scope, require, path.dirname(wasmJsPath), wasmJsPath);
    const Module = await scope.createGdstkModule({});

    const model = parseMarkerFile(fs.readFileSync(path.join(__dirname, "fixtures", "sample.lyrdb"), "utf8"), DOMParser);
    Module.setMarkers(flattenMarkerModel(model));

    let stats = Module.getMarkerStats();
    assert.strictEqual(stats.items, 6);
    assert.strictEqual(stats.polygons, 3);
    assert.strictEqual(stats.edges, 3);
    assert.strictEqual(stats.categories, 5);
    // Categories start hidden -- the user opts in per rulecheck.
    assert.strictEqual(stats.categoriesVisible, 0);
    assert.strictEqual(stats.selected, -1);

    Module.setMarkerCategoryVisible(2, true);
    stats = Module.getMarkerStats();
    assert.strictEqual(stats.categoriesVisible, 1);
    Module.setMarkerCategoryVisible(99, true); // out of range: ignored
    assert.strictEqual(Module.getMarkerStats().categoriesVisible, 1);
    Module.setMarkerCategoryVisible(2, false);
    assert.strictEqual(Module.getMarkerStats().categoriesVisible, 0);

    Module.setSelectedMarker(3);
    assert.strictEqual(Module.getMarkerStats().selected, 3);

    assert.strictEqual(Module.getMarkerStats().opacity, 1);
    Module.setMarkerOpacity(0.4);
    assert.ok(Math.abs(Module.getMarkerStats().opacity - 0.4) < 1e-6);
    Module.setMarkerOpacity(7); // clamped to [0, 1]
    assert.strictEqual(Module.getMarkerStats().opacity, 1);
    Module.setMarkerOpacity(-1);
    assert.strictEqual(Module.getMarkerStats().opacity, 0);
    Module.setMarkerOpacity(1);

    // zoomToBox is GL-only and must be a harmless no-op headlessly.
    Module.zoomToBox(0, 0, 10, 10);

    Module.clearMarkers();
    stats = Module.getMarkerStats();
    assert.strictEqual(stats.items, 0);
    assert.strictEqual(stats.polygons, 0);
    assert.strictEqual(stats.edges, 0);
    assert.strictEqual(stats.categories, 0);
    assert.strictEqual(stats.selected, -1);
});
