// Headless test for parseGdsToLayers's `root` option: drawing one cell as the
// top instead of every top cell in the file. Skipped when the wasm bundle
// hasn't been built.
//
// The fixture (multi_top.gds) has two top cells and one cell they share:
//   LEAF   a 2x2 µm box on 1/0
//   TOP_A  a 20x20 µm box on 2/0 at the origin, LEAF placed at (10, 10)
//   TOP_B  a 10x10 µm box on 3/0 at (100, 100), LEAF placed at (100, 100)
import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { loadModule, skip } from "./wasm-build.js";
import { packTag } from "../src/parse-split.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bytes = fs.readFileSync(path.join(__dirname, "fixtures", "multi_top.gds"));

function parse(Module, options) {
    Module.FS.writeFile("/input.layout", bytes);
    const result = Module.parseGdsToLayers("/input.layout", options);
    Module.FS.unlink("/input.layout");
    assert.ok(result.ok, result.error);
    return result;
}

const tags = (result) => result.layers.map((l) => `${l.layer}/${l.datatype}`).sort();
const polygons = (result) => Number(result.totalPolygons);
const rootNames = (result) => result.hierarchy.roots.map((i) => result.hierarchy.cells[i].name);

test("top cell: default draws every top cell and lists them", { skip }, async () => {
    const Module = await loadModule();
    const result = parse(Module);
    assert.deepStrictEqual([...result.topCells].sort(), ["TOP_A", "TOP_B"]);
    assert.strictEqual(result.root, null);
    assert.deepStrictEqual(tags(result), ["1/0", "2/0", "3/0"]);
    assert.strictEqual(polygons(result), 4);
    assert.deepStrictEqual(rootNames(result).sort(), ["TOP_A", "TOP_B"]);
    assert.deepStrictEqual(result.bbox, { minX: 0, maxX: 110, minY: 0, maxY: 110 });
});

test("top cell: a chosen top draws only its own subtree", { skip }, async () => {
    const Module = await loadModule();
    const result = parse(Module, { root: "TOP_B" });
    assert.strictEqual(result.root, "TOP_B");
    // Still the file's own list, so the control can offer the others.
    assert.deepStrictEqual([...result.topCells].sort(), ["TOP_A", "TOP_B"]);
    assert.deepStrictEqual(tags(result), ["1/0", "3/0"]);
    assert.strictEqual(polygons(result), 2);
    assert.deepStrictEqual(rootNames(result), ["TOP_B"]);
    assert.deepStrictEqual(result.bbox, { minX: 100, maxX: 110, minY: 100, maxY: 110 });
});

test("top cell: a placed cell opens at its own origin", { skip }, async () => {
    const Module = await loadModule();
    const result = parse(Module, { root: "LEAF" });
    assert.strictEqual(result.root, "LEAF");
    assert.deepStrictEqual(tags(result), ["1/0"]);
    assert.strictEqual(polygons(result), 1);
    assert.deepStrictEqual(rootNames(result), ["LEAF"]);
    assert.deepStrictEqual(result.bbox, { minX: 0, maxX: 2, minY: 0, maxY: 2 });
});

test("top cell: an unknown name falls back to the default", { skip }, async () => {
    const Module = await loadModule();
    const result = parse(Module, { root: "GONE" });
    assert.strictEqual(result.root, null);
    assert.deepStrictEqual(tags(result), ["1/0", "2/0", "3/0"]);
});

test("top cell: every shard honours the root", { skip }, async () => {
    const Module = await loadModule();
    // Layers 1 and 3 on one shard, as a split parse would hand them out.
    const result = parse(Module, { root: "TOP_A", tags: [packTag(1, 0), packTag(3, 0)], hierarchy: false });
    assert.strictEqual(result.root, "TOP_A");
    assert.deepStrictEqual(tags(result), ["1/0"]);
});
