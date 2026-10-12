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
import { inspectFixture, library, structure, box, aref, text } from "./inspect-fixture.js";

const bytes = inspectFixture();

// Every layer drawn, in an order of the test's choosing: later is on top.
const DRAW_ORDER = ["3/0", "4/0", "1/0", "5/0", "6/0", "7/0"];
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

// `labelPx` is world µm per screen pixel, as the viewer passes it while text
// is drawn; 0 leaves labels out, as it does while text is not.
const at = (Module, x, y, { order, tolerance = 0.001, labelPx = 0 } = {}) =>
    Module.inspectAt(x, y, tolerance, ranks(order), 64, labelPx);

// At 100 px/µm, with the viewer's 3 px tolerance.
const ZOOMED = { labelPx: 0.01, tolerance: 0.03 };

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
    // TOP's three labels and RING's one.
    assert.strictEqual(result.labels, 4);
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
            const hit = Module.inspectAt(x, y, 0.001, ranks(), 64, 0).hits[0];
            return { tag: tag(hit), path: pathText(hit), bbox: bbox(hit), area: hit.area };
        }));
    }
    assert.deepStrictEqual(answers[0], answers[1]);
});

// Big enough to need the per-cell grid and the array arithmetic: a cell of
// 40,000 own boxes, and a 2000 x 2000 array of a small labelled cell. A query
// that scanned either would show in the timing long before it failed the
// answer.
test("inspect: large cells and arrays are searched, not scanned", { skip }, async () => {
    const boxes = [];
    for (let i = 0; i < 200; i++) {
        for (let j = 0; j < 200; j++) boxes.push(box(2, 0, 3 * i, 3 * j, 3 * i + 1, 3 * j + 1));
    }
    const big = library([
        structure("DOT", [box(1, 0, 0, 0, 0.5, 0.5), text(6, 0, 0.25, 0.25, "d")]),
        structure("TOP", [...boxes, aref("DOT", 0, 1000, 2000, 2000, 1, 1)])
    ]);
    const Module = await loadModule();
    Module.FS.writeFile("/input.layout", big);
    assert.ok(Module.inspectLoad("/input.layout", {}).ok);
    const order = ["1/0", "2/0", "6/0"];
    // First query builds TOP's grid; time the ones after it.
    at(Module, 0.5, 0.5, { order });
    const start = performance.now();
    const own = at(Module, 300.5, 450.5, { order });
    const copy = at(Module, 1234.25, 1000 + 1777.25, { order });
    // The label in that copy, at 20 px per µm: its text reaches into the
    // copies around it, which are entered as well, and no further.
    const label = at(Module, 1234.25, 1000 + 1777.25, { order, labelPx: 0.05, tolerance: 0.15 });
    const elapsed = performance.now() - start;
    assert.strictEqual(label.hits[0].kind, "label");
    assert.strictEqual(label.hits[0].text, "d");
    assert.deepStrictEqual([label.hits[0].path[1].column, label.hits[0].path[1].row], [1234, 1777]);
    assert.deepStrictEqual(bbox(own.hits[0]), [300, 450, 301, 451]);
    assert.strictEqual(own.total, 1);
    assert.deepStrictEqual(bbox(copy.hits[0]), [1234, 2777, 1234.5, 2777.5]);
    const step = copy.hits[0].path[1];
    assert.deepStrictEqual([step.column, step.row, step.copies], [1234, 1777, 4_000_000]);
    assert.strictEqual(copy.truncated, false);
    assert.ok(elapsed < 50, `three queries took ${elapsed.toFixed(1)} ms`);
});

// The viewer reads the file in one Worker and answers clicks from another,
// handing the index across as flat arrays (inspectLoad's `snapshot`, then
// inspectRestore), so the Worker that stays up never held the whole file.
test("inspect: an index handed to another module answers the same", { skip }, async () => {
    const points = [[15, 15], [29.5, 31], [41, 39.5], [21, 105.5], [62, 61], [75, 0.25], [25, 105.5]];
    const summary = (Module) => points.map(([x, y]) => {
        const found = at(Module, x, y, ZOOMED);
        return found.hits.map((hit) => ({ kind: hit.kind, tag: tag(hit), path: hit.path, bbox: bbox(hit),
                                          area: hit.area, text: hit.text, rotation: hit.rotation }));
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
    // Labels made the trip too, and their reach beyond a cell's box with them.
    assert.ok(expected.flat().some((hit) => hit.kind === "label"));
    const far = (Module) => at(Module, 22.6, 105.5, { labelPx: 0.1, tolerance: 0.3 }).hits.map((hit) => hit.text);
    assert.deepStrictEqual(far(answering), ["ring"]);
});

// ---- Labels ----
// Labels are found only when the query names a zoom (labelPx), and then where
// their text is drawn at that zoom: upright, 11 px cap height, from their
// anchor. "PAD  A" is drawn from its bottom left, so at 100 px/µm its text
// runs about 0.53 µm right of (25, 40) and 0.11 µm up.

const labels = (found) => found.hits.filter((hit) => hit.kind === "label");

test("inspect: a label is hit on its drawn text, before the shape under it", { skip }, async () => {
    const { Module } = await indexed();
    const found = at(Module, 25.2, 40.05, ZOOMED);
    assert.deepStrictEqual(found.hits.map((hit) => hit.kind), ["label", "polygon"]);
    const label = found.hits[0];
    assert.strictEqual(label.text, "PAD  A");
    assert.strictEqual(tag(label), "6/0");
    assert.strictEqual(pathText(label), "TOP");
    assert.deepStrictEqual(Array.from(label.points), [25, 40]);
    assert.strictEqual(label.edgeDistance, 0);
    assert.strictEqual(label.area, 0);
    assert.deepStrictEqual([label.rotation, label.magnification], [0, 1]);
    // Its box in pixels from the anchor: six characters wide, from the
    // descender line to the ascenders.
    const [x0, y0, x1, y1] = label.box;
    assert.strictEqual(x0, 0);
    assert.ok(Math.abs(x1 - 34 * 11 / 7) < 1e-4, `width ${x1}`);
    assert.ok(Math.abs(y0 + 2 * 11 / 7) < 1e-4 && Math.abs(y1 - 11) < 1e-4, `height ${y0}..${y1}`);
    assert.strictEqual(tag(found.hits[1]), "3/0");

    // Zoomed out ten times further, the same text covers ten times the µm.
    assert.strictEqual(labels(at(Module, 28, 40.5, { labelPx: 0.1, tolerance: 0.3 }))[0].text, "PAD  A");
    assert.strictEqual(labels(at(Module, 28, 40.5, ZOOMED)).length, 0);
    // Clicking the anchor hits it, and so does a click within the tolerance.
    assert.strictEqual(labels(at(Module, 25, 40, ZOOMED))[0].text, "PAD  A");
    assert.strictEqual(labels(at(Module, 24.98, 40, ZOOMED))[0].text, "PAD  A");
    assert.strictEqual(labels(at(Module, 24.96, 40, ZOOMED)).length, 0);
});

test("inspect: labels are left out without a zoom, and on hidden layers", { skip }, async () => {
    const { Module } = await indexed();
    assert.deepStrictEqual(at(Module, 25.2, 40.05).hits.map(tag), ["3/0"]);
    const hidden = at(Module, 25.2, 40.05, { ...ZOOMED, order: ["3/0", "4/0", "1/0", "5/0", "7/0"] });
    assert.deepStrictEqual(hidden.hits.map(tag), ["3/0"]);
});

test("inspect: a label tied with a shape's edge comes first", { skip }, async () => {
    const { Module } = await indexed();
    // (50, 20) is EDGE's anchor, on the left side of its text, and on the
    // 3/0 box's right edge: both at distance 0.
    const found = at(Module, 50, 20, ZOOMED);
    assert.deepStrictEqual(found.hits.map((hit) => [hit.kind, hit.edgeDistance]), [["label", 0], ["polygon", 0]]);
    assert.strictEqual(found.hits[0].text, "EDGE");
    // Nearer one shape's edge than the label's text, the shape comes first.
    const offText = at(Module, 49.99, 20.1, { labelPx: 0.01, tolerance: 0.05 });
    assert.deepStrictEqual(offText.hits.map((hit) => hit.kind), ["polygon", "label"]);
});

test("inspect: labels in placed cells report their path, anchor and turn", { skip }, async () => {
    const { Module } = await indexed();
    const copy = at(Module, 21, 105.5, ZOOMED);
    assert.deepStrictEqual(copy.hits.map((hit) => hit.kind), ["label", "polygon"]);
    const label = copy.hits[0];
    assert.strictEqual(label.text, "ring");
    assert.strictEqual(pathText(label), "TOP > ARR > RING");
    assert.deepStrictEqual([label.path[2].column, label.path[2].row, label.path[2].copies], [2, 1, 6]);
    assert.deepStrictEqual(Array.from(label.points), [21, 105.5]);

    const rotated = labels(at(Module, 29.5, 31, ZOOMED))[0];
    assert.strictEqual(pathText(rotated), "TOP > RING");
    assert.strictEqual(rotated.path[1].sibling, 0);
    assert.deepStrictEqual(Array.from(rotated.points).map((v) => Math.round(v * 1000) / 1000), [29.5, 31]);
    assert.deepStrictEqual([rotated.rotation, rotated.magnification], [90, 1]);

    const mirrored = labels(at(Module, 41, 39.5, ZOOMED))[0];
    assert.strictEqual(mirrored.path[1].sibling, 1);
    assert.deepStrictEqual(Array.from(mirrored.points), [41, 39.5]);

    const magnified = labels(at(Module, 62, 61, ZOOMED))[0];
    assert.strictEqual(magnified.path[1].sibling, 2);
    assert.deepStrictEqual(Array.from(magnified.points), [62, 61]);
    assert.deepStrictEqual([magnified.rotation, magnified.magnification], [0, 2]);

    // The label's own rotation and magnification.
    const own = labels(at(Module, 45, 5, ZOOMED))[0];
    assert.strictEqual(own.text, "ROT");
    assert.strictEqual(tag(own), "7/0");
    assert.ok(Math.abs(own.rotation - 30) < 1e-4, `rotation ${own.rotation}`);
    assert.strictEqual(own.magnification, 2);
});

test("inspect: a label's text reaches past its cell's box", { skip }, async () => {
    const { Module } = await indexed();
    // 1.6 µm right of the ring label in copy [2,1], 0.6 µm past the copy's
    // box: at 0.1 µm per pixel, still within the text's half width of 17 px.
    const found = at(Module, 22.6, 105.5, { labelPx: 0.1, tolerance: 0.3 });
    assert.deepStrictEqual(found.hits.map((hit) => [hit.kind, hit.text]), [["label", "ring"]]);
    assert.strictEqual(found.hits[0].path[2].column, 2);
    assert.ok(Math.abs(found.hits[0].edgeDistance) < 1e-9);
    // Closer in, the text is smaller and that point misses it.
    assert.strictEqual(at(Module, 22.6, 105.5, ZOOMED).total, 0);
});
