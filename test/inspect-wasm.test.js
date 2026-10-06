// Headless tests for the click-to-inspect index (inspectLoad / inspectAt, see
// inspect.hpp): which shapes lie under a point, in what order, and which cell
// and placement each came from. Skipped when the wasm bundle hasn't been
// built.
//
// The fixture is written by inspect-fixture.js, which lists its geometry.
import test from "node:test";
import assert from "node:assert";
import { loadModule, skip } from "./wasm-build.js";
import { packTag } from "../src/parse-split.js";
import { inspectFixture, library, structure, box, aref } from "./inspect-fixture.js";

const bytes = inspectFixture();

// Every layer drawn, in an order of the test's choosing: later is on top.
const DRAW_ORDER = ["3/0", "4/0", "1/0", "5/0"];
function ranks(order = DRAW_ORDER) {
    return order.flatMap((tag, rank) => {
        const [layer, datatype] = tag.split("/").map(Number);
        return [packTag(layer, datatype), rank];
    });
}

async function indexed(options = {}) {
    const Module = await loadModule();
    Module.FS.writeFile("/input.layout", bytes);
    const result = Module.inspectLoad("/input.layout", { releaseFile: true, ...options });
    assert.ok(result.ok, result.error);
    return { Module, result };
}

const at = (Module, x, y, { order, tolerance = 0.001 } = {}) =>
    Module.inspectAt(x, y, tolerance, ranks(order), 64);

const tag = (hit) => `${hit.layer}/${hit.datatype}`;
const pathText = (hit) => hit.path.map((step) => step.cell).join(" > ");
function bbox(hit) {
    const xs = [], ys = [];
    for (let i = 0; i < hit.points.length; i += 2) {
        xs.push(hit.points[i]);
        ys.push(hit.points[i + 1]);
    }
    // Rounded to the 1 nm grid, so a rotation's last-bit noise doesn't matter.
    const r = (v) => Math.round(v * 1000) / 1000;
    return [r(Math.min(...xs)), r(Math.min(...ys)), r(Math.max(...xs)), r(Math.max(...ys))];
}

test("inspect: reads the hierarchy, not the flattened copies", { skip }, async () => {
    const { result } = await indexed();
    assert.strictEqual(result.root, null);
    assert.strictEqual(result.grid, 0.001);
    // TOP's five shapes, the path among them, and RING's one box: RING is
    // placed nine times but held once.
    assert.strictEqual(result.polygons, 5);
    assert.strictEqual(result.placements, 5);
});

test("inspect: overlapping shapes come back nearest edge first", { skip }, async () => {
    const { Module } = await indexed();
    const found = at(Module, 15, 15);
    assert.strictEqual(found.total, 3);
    // (15, 15) is 3 from the small 4/0 box's edges, 5 from the larger 4/0
    // box's and 15 from the 3/0 box enclosing both.
    assert.deepStrictEqual(found.hits.map(tag), ["4/0", "4/0", "3/0"]);
    assert.deepStrictEqual(found.hits.map((h) => h.area), [36, 100, 2500]);
    assert.deepStrictEqual(found.hits.map((h) => h.edgeDistance), [3, 5, 15]);
    assert.deepStrictEqual(bbox(found.hits[0]), [12, 12, 18, 18]);
    assert.deepStrictEqual(found.hits.map(pathText), ["TOP", "TOP", "TOP"]);
    // Drawing the enclosing 3/0 box on top does not put it first: what the
    // pointer is nearest decides, and draw order only breaks ties.
    const flipped = at(Module, 15, 15, { order: ["4/0", "3/0", "1/0", "5/0"] });
    assert.deepStrictEqual(flipped.hits.map(tag), ["4/0", "4/0", "3/0"]);
    // Next to the larger 4/0 box's edge, outside the small box: that box.
    const nearEdge = at(Module, 11, 15);
    assert.deepStrictEqual(nearEdge.hits.map((h) => h.area), [100, 2500]);
    // On the 3/0 box's own edge, it is the nearest.
    assert.strictEqual(tag(at(Module, 49.9, 30).hits[0]), "3/0");
});

test("inspect: a hidden layer is skipped", { skip }, async () => {
    const { Module } = await indexed();
    const found = at(Module, 15, 15, { order: ["3/0", "1/0", "5/0"] });
    assert.deepStrictEqual(found.hits.map(tag), ["3/0"]);
});

test("inspect: rotated, mirrored and magnified placements land in world space", { skip }, async () => {
    const { Module } = await indexed();
    const rotated = at(Module, 29.5, 31).hits[0];
    assert.strictEqual(tag(rotated), "1/0");
    assert.deepStrictEqual(bbox(rotated), [29, 30, 30, 32]);
    assert.ok(Math.abs(rotated.area - 2) < 1e-9, `area ${rotated.area}`);
    assert.strictEqual(pathText(rotated), "TOP > RING");
    // The first of TOP's three references to RING.
    assert.deepStrictEqual([rotated.path[1].sibling, rotated.path[1].siblings], [0, 3]);
    // The placement maps RING's frame into the world: 90 degrees about (30, 30).
    const p = rotated.placement;
    assert.ok(Math.abs(p.a) < 1e-12 && Math.abs(p.b + 1) < 1e-12 && Math.abs(p.c - 1) < 1e-12);
    assert.deepStrictEqual([p.tx, p.ty], [30, 30]);

    const mirrored = at(Module, 41, 39.5).hits[0];
    assert.deepStrictEqual(bbox(mirrored), [40, 39, 42, 40]);
    assert.strictEqual(mirrored.area, 2);
    assert.strictEqual(mirrored.path[1].sibling, 1);
    assert.ok(mirrored.placement.d < 0, "the mirror is in the placement");

    const magnified = at(Module, 62, 61).hits[0];
    assert.deepStrictEqual(bbox(magnified), [60, 60, 64, 62]);
    assert.strictEqual(magnified.area, 8);
    assert.strictEqual(magnified.path[1].sibling, 2);
});

test("inspect: an array copy reports which copy it is", { skip }, async () => {
    const { Module } = await indexed();
    const found = at(Module, 21, 105.5);
    assert.strictEqual(found.total, 1);
    const hit = found.hits[0];
    assert.strictEqual(pathText(hit), "TOP > ARR > RING");
    assert.deepStrictEqual(bbox(hit), [20, 105, 22, 106]);
    const step = hit.path[2];
    assert.deepStrictEqual([step.column, step.row, step.copies], [2, 1, 6]);
    // Between copies is empty.
    assert.strictEqual(at(Module, 25, 105.5).total, 0);
});

test("inspect: a path is hit as the outline it is drawn as", { skip }, async () => {
    const { Module } = await indexed();
    const hit = at(Module, 75, 0.25).hits[0];
    assert.strictEqual(tag(hit), "5/0");
    assert.deepStrictEqual(bbox(hit), [70, -0.5, 80, 0.5]);
    assert.strictEqual(hit.area, 10);
    assert.strictEqual(hit.points.length / 2, 4);
});

test("inspect: the tolerance reaches a shape just outside the point", { skip }, async () => {
    const { Module } = await indexed();
    assert.strictEqual(at(Module, 75, 0.6).total, 0);
    assert.strictEqual(tag(at(Module, 75, 0.6, { tolerance: 0.2 }).hits[0]), "5/0");
});

test("inspect: a chosen top cell is walked from that cell", { skip }, async () => {
    const { Module, result } = await indexed({ root: "ARR" });
    assert.strictEqual(result.root, "ARR");
    const hit = at(Module, 11, 5.5).hits[0];
    assert.strictEqual(pathText(hit), "ARR > RING");
    assert.deepStrictEqual(bbox(hit), [10, 5, 12, 6]);
    // TOP's own shapes are not drawn, so not found.
    assert.strictEqual(at(Module, 15, 15).total, 0);
});

// The renderer instances RING (nine placements) only when the threshold lets
// it, and draws it flattened otherwise. The index never flattens, so the two
// must answer alike.
test("inspect: instanced and flattened draws give the same answers", { skip }, async () => {
    const answers = [];
    for (const threshold of [0, -1]) {
        const Module = await loadModule();
        Module.setInstanceThreshold(threshold);
        Module.FS.writeFile("/input.layout", bytes);
        const parsed = Module.parseGdsToLayers("/input.layout", {});
        assert.strictEqual(parsed.instanceGroups.length, threshold === 0 ? 1 : 0);
        const loaded = Module.inspectLoad("/input.layout", {});
        assert.ok(loaded.ok);
        answers.push([[29.5, 31], [41, 39.5], [21, 105.5], [62, 61]].map(([x, y]) => {
            const hit = Module.inspectAt(x, y, 0.001, ranks(), 64).hits[0];
            return { tag: tag(hit), path: pathText(hit), bbox: bbox(hit), area: hit.area };
        }));
    }
    assert.deepStrictEqual(answers[0], answers[1]);
});

// Big enough to need the per-cell grid and the array arithmetic: a cell of
// 40,000 own boxes, and a 2000 x 2000 array of a small cell. A query that
// scanned either would show in the timing long before it failed the answer.
test("inspect: large cells and arrays are searched, not scanned", { skip }, async () => {
    const boxes = [];
    for (let i = 0; i < 200; i++) {
        for (let j = 0; j < 200; j++) boxes.push(box(2, 0, 3 * i, 3 * j, 3 * i + 1, 3 * j + 1));
    }
    const big = library([
        structure("DOT", [box(1, 0, 0, 0, 0.5, 0.5)]),
        structure("TOP", [...boxes, aref("DOT", 0, 1000, 2000, 2000, 1, 1)])
    ]);
    const Module = await loadModule();
    Module.FS.writeFile("/input.layout", big);
    assert.ok(Module.inspectLoad("/input.layout", {}).ok);
    const order = ["1/0", "2/0"];
    // First query builds TOP's grid; time the ones after it.
    at(Module, 0.5, 0.5, { order });
    const start = performance.now();
    const own = at(Module, 300.5, 450.5, { order });
    const copy = at(Module, 1234.25, 1000 + 1777.25, { order });
    const elapsed = performance.now() - start;
    assert.deepStrictEqual(bbox(own.hits[0]), [300, 450, 301, 451]);
    assert.strictEqual(own.total, 1);
    assert.deepStrictEqual(bbox(copy.hits[0]), [1234, 2777, 1234.5, 2777.5]);
    const step = copy.hits[0].path[1];
    assert.deepStrictEqual([step.column, step.row, step.copies], [1234, 1777, 4_000_000]);
    assert.strictEqual(copy.truncated, false);
    assert.ok(elapsed < 50, `two queries took ${elapsed.toFixed(1)} ms`);
});

// The viewer reads the file in one Worker and answers clicks from another,
// handing the index across as flat arrays (inspectLoad's `snapshot`, then
// inspectRestore), so the Worker that stays up never held the whole file.
test("inspect: an index handed to another module answers the same", { skip }, async () => {
    const points = [[15, 15], [29.5, 31], [41, 39.5], [21, 105.5], [62, 61], [75, 0.25], [25, 105.5]];
    const summary = (Module) => points.map(([x, y]) => {
        const found = at(Module, x, y);
        return found.hits.map((hit) => ({ tag: tag(hit), path: hit.path, bbox: bbox(hit), area: hit.area }));
    });
    const { Module: reader } = await indexed();
    const expected = summary(reader);

    const source = await loadModule();
    source.FS.writeFile("/input.layout", bytes);
    const loaded = source.inspectLoad("/input.layout", { snapshot: true });
    assert.ok(loaded.ok);
    assert.strictEqual(loaded.polygons, 5);
    // Handed off: the reading module keeps nothing to answer with.
    assert.strictEqual(at(source, 15, 15).total, 0);
    const answering = await loadModule();
    answering.inspectRestore(loaded.snapshot);
    assert.deepStrictEqual(summary(answering), expected);
});
