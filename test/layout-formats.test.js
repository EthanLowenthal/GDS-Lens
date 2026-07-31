// Headless test for the GDSII/OASIS reader dispatch in gds_common.hpp: evals
// the built gdstk_wasm.js in plain Node (no GL context needed -- this only
// exercises parseGdsToLayers's CPU half) and parses the same design saved in
// both formats, asserting the format is sniffed from the file header and that
// the two produce identical flattened geometry.
//
// fixtures/sample_layout.{gds,oas} are two writes of one KLayout-built layout:
// a 10x5um box on layer 1/0 in TOP, plus a 2x1um box on layer 2/0 in CHILD
// placed twice standalone and once as a 3x2 array (6) -- 8 CHILD placements
// in all.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const wasmJsPath = path.join(__dirname, "..", "src", "wasm", "build", "gdstk_wasm.js");
const wasmBuilt = fs.existsSync(wasmJsPath);
const skip = !wasmBuilt && "src/wasm/build/gdstk_wasm.js not built";

// Same eval-the-bundle trick as marker-wasm.test.js (MODULARIZE + SINGLE_FILE).
async function loadModule() {
    const src = fs.readFileSync(wasmJsPath, "utf8");
    const scope = {};
    new Function("scope", "require", "__dirname", "__filename",
        src + "\nscope.createGdstkModule = createGdstkModule;")(
        scope, require, path.dirname(wasmJsPath), wasmJsPath);
    return scope.createGdstkModule({});
}

// Stages a fixture into MEMFS under an extension-less name (exactly like
// wasm-worker.js does) so nothing but the file's own header can decide the
// format, and parses it.
function parseFixture(Module, fixtureName) {
    const bytes = fs.readFileSync(path.join(__dirname, "fixtures", fixtureName));
    Module.FS.writeFile("/input.layout", new Uint8Array(bytes));
    try {
        return Module.parseGdsToLayers("/input.layout");
    } finally {
        Module.FS.unlink("/input.layout");
    }
}

// parseGdsToLayers splits a design into static per-layer geometry plus one
// instance group per repeatedly-placed cell, and the two are keyed by
// unordered maps -- so compare a canonical summary rather than raw ordering.
function summarize(result) {
    const layerSummary = (layer) => ({
        layer: layer.layer,
        polygons: layer.polygonCount,
        outlineVertices: layer.outlineVertices.length,
        fillVertices: layer.fillVertices.length,
    });
    const byLayer = (a, b) => a.layer - b.layer;
    return {
        layers: result.layers.map(layerSummary).sort(byLayer),
        instanceGroups: result.instanceGroups
            .map((group) => ({
                // 6 floats per instance (2x3 affine).
                instances: group.instances.length / 6,
                layers: group.layers.map(layerSummary).sort(byLayer),
            }))
            .sort((a, b) => a.instances - b.instances),
        bbox: result.bbox,
        totalPolygons: result.totalPolygons,
    };
}

test("parses GDSII and OASIS, detecting the format from the header", { skip }, async () => {
    const Module = await loadModule();

    const gds = parseFixture(Module, "sample_layout.gds");
    assert.strictEqual(gds.ok, true, gds.error);
    assert.strictEqual(gds.format, "GDSII");

    const oas = parseFixture(Module, "sample_layout.oas");
    assert.strictEqual(oas.ok, true, oas.error);
    assert.strictEqual(oas.format, "OASIS");

    // Both readers run with unit=1e-6, so coordinates land in microns either
    // way: TOP's box spans 10x5um from the origin, and the 3x2 array's top row
    // sits at y=12um and is 1um tall, putting the design's ceiling at 13um.
    assert.deepStrictEqual(oas.bbox, {minX: 0, maxX: 10, minY: 0, maxY: 13});
    assert.deepStrictEqual(summarize(oas), summarize(gds));

    // 1 box in TOP + 8 CHILD placements of 1 box each. (uint64 on the C++
    // side, so embind hands it back as a BigInt.)
    assert.strictEqual(oas.totalPolygons, 9n);
});

test("rejects a file that is neither GDSII nor OASIS", { skip }, async () => {
    const Module = await loadModule();

    Module.FS.writeFile("/input.layout", new TextEncoder().encode("not a layout file\n"));
    const result = Module.parseGdsToLayers("/input.layout");
    Module.FS.unlink("/input.layout");

    // No OASIS magic, so it falls through to the GDSII reader, which rejects
    // it (as a truncated record stream -- InputFileError, before it ever gets
    // to a header check) rather than the caller getting an empty render.
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.length > 0);
});
