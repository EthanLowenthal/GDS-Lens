// Tests the split parse: the header scan and shard plan in parse-split.js, and
// the promise the whole design rests on -- that parsing a layout in N shards
// and concatenating the results gives the same geometry as parsing it in one.
//
// The second half is the one that matters. Splitting is only safe because each
// shard owns a disjoint set of layers and nothing is shared between them, so
// the test parses the same fixture both ways and compares a canonical summary,
// the same way layout-formats.test.js compares the GDSII and OASIS readers.
//
// fixtures/sample_layout.gds is a 10x5um box on layer 1/0 in TOP plus a 2x1um
// box on layer 2/0 in CHILD placed 8 times -- two tags, which is exactly
// enough to split two ways.
import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

import { scanGdsTags, planShards, shardCount, mergeShardResults, packTag, MIN_SPLIT_BYTES }
    from "../src/parse-split.js";
import { loadModule, skip } from "./wasm-build.js";
import { chromium, defaultVariant, withPayload } from "./payload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", name)));

test("the header scan totals polygon points per layer without parsing", () => {
    const tags = scanGdsTags(fixture("sample_layout.gds"));
    // Both boxes are 4-point rectangles, closed in GDSII (first point repeated).
    assert.deepStrictEqual(
        [...tags].sort((a, b) => a[0] - b[0]),
        [[packTag(1, 0), 5], [packTag(2, 0), 5]]);
});

test("the header scan declines anything it cannot walk", () => {
    // OASIS: not laid out in GDSII records at all, so there is nothing to walk.
    assert.strictEqual(scanGdsTags(fixture("sample_layout.oas")), null);
    // gzip: the viewer expands these before the parse (see layout-bytes.js),
    // but a caller staging one directly must not get counts out of it.
    assert.strictEqual(scanGdsTags(fixture("sample_layout.gds.gz")), null);
    assert.strictEqual(scanGdsTags(new Uint8Array(0)), null);
    assert.strictEqual(scanGdsTags(null), null);

    // A GDSII header on a file whose records then run off the end: the walk
    // has to notice rather than report whatever it counted on the way.
    const truncated = fixture("sample_layout.gds").slice(0, 60);
    assert.strictEqual(scanGdsTags(truncated), null);
});

test("shards are planned heaviest-first onto the lightest shard", () => {
    const tags = new Map([[10, 100], [20, 60], [30, 50], [40, 40]]);
    // The three heaviest seed a shard each, then 40 joins the lightest of
    // them: 100 | 60 | 50+40. Walking the tags in their own order would have
    // put 40 with 100 instead, for a makespan of 140 rather than 100.
    assert.deepStrictEqual(planShards(tags, 3), [[10], [20], [30, 40]]);
});

test("a plan asks for no more shards than it can keep busy", () => {
    // Two equal layers cannot occupy three Workers: the third would pay a full
    // parse to triangulate nothing.
    assert.deepStrictEqual(planShards(new Map([[10, 1], [20, 1]]), 3), [[10], [20]]);
    assert.strictEqual(planShards(null, 2), null, "nothing to plan from");
    assert.strictEqual(planShards(new Map(), 2), null, "no tags to plan from");
});

test("a design whose work is all on one layer is not split at all", () => {
    // The heaviest layer is the floor on how fast any split can finish, because
    // a layer is the smallest thing a shard can be handed. Nearly all on one
    // layer -- an ordinary shape for a design with one routing or waveguide --
    // eight Workers would finish no sooner than one, having paid eight parses.
    assert.strictEqual(planShards(new Map([[1, 925], [2, 40], [3, 35]]), 8), null);
    // Two layers of equal weight split cleanly in two, and no further.
    assert.deepStrictEqual(planShards(new Map([[1, 500], [2, 500]]), 8), [[1], [2]]);
    // A merely lopsided design still splits, just not as many ways as asked.
    const spread = new Map([[1, 300], [2, 200], [3, 200], [4, 150], [5, 150]]);
    assert.strictEqual(planShards(spread, 8).length, 4);
});

test("shard count is bounded by memory, not just by cores", () => {
    // Every shard holds its own copy of the file and its own parse's working
    // set, so the ceiling comes down as the file grows -- the opposite of how
    // a thread count would scale.
    assert.strictEqual(shardCount(MIN_SPLIT_BYTES - 1, 8), 1, "too small to be worth splitting");
    assert.strictEqual(shardCount(26 * 1024 * 1024, 8), 8, "a typical layout gets every core");
    assert.ok(shardCount(512 * 1024 * 1024, 8) < 8, "a half-gigabyte layout has to back off");
    assert.strictEqual(shardCount(8 * 1024 * 1024 * 1024, 8), 1, "no room for a second copy");
    // Monotonic: a bigger file never earns more shards than a smaller one.
    let previous = Infinity;
    for (let mb = 8; mb <= 2048; mb *= 2) {
        const count = shardCount(mb * 1024 * 1024, 8);
        assert.ok(count <= previous, `${mb} MB got more shards than the size below it`);
        previous = count;
    }
});

// Mirrors what wasm-worker.js does for one shard: stage the bytes, parse with
// the shard's options, and hand back what it would have posted.
function parseShard(Module, bytes, options) {
    Module.FS.writeFile("/input.layout", bytes);
    const result = Module.parseGdsToLayers("/input.layout", options);
    if (!options || !options.releaseFile) Module.FS.unlink("/input.layout");
    return result;
}

const layerSummary = (layer) => ({
    tag: packTag(layer.layer, layer.datatype),
    outlineVertices: [...layer.outlineVertices],
    outlineRanges: [...layer.outlineRanges],
    fillVertices: [...layer.fillVertices],
});
const byTag = (a, b) => a.tag - b.tag;

// Layer order is shard order once a parse is split, and was a hash map's order
// before that, so compare sorted -- as layout-formats.test.js already does.
function summarize(layers, groups) {
    return {
        layers: layers.map(layerSummary).sort(byTag),
        groups: groups
            .map((group) => ({
                instances: [...group.instances],
                layers: group.layers.map(layerSummary).sort(byTag),
            }))
            .sort((a, b) => a.layers.length - b.layers.length || byTag(a.layers[0], b.layers[0])),
    };
}

test("a two-shard parse rebuilds exactly what one shard produces", { skip }, async () => {
    const bytes = fixture("sample_layout.gds");
    const shards = planShards(scanGdsTags(bytes), 2);
    assert.strictEqual(shards.length, 2);

    const whole = parseShard(await loadModule(), bytes, null);
    assert.strictEqual(whole.ok, true, whole.error);

    // A fresh module per shard, which is what a Worker each really means: no
    // state carries between them.
    const results = [];
    for (const [index, tags] of shards.entries()) {
        const result = parseShard(await loadModule(), bytes,
                                  { tags, labels: index === 0, hierarchy: index === 0, releaseFile: true });
        assert.strictEqual(result.ok, true, result.error);
        results.push(result);
    }

    assert.deepStrictEqual(
        summarize(results.flatMap((r) => r.layers), results.flatMap((r) => r.instanceGroups)),
        summarize(whole.layers, whole.instanceGroups),
        "the shards' geometry does not add up to the unsplit parse's");

    // The bounding box is the union of the shards', and every shard here has
    // geometry, so none of them reports the empty-layout sentinel.
    const union = results.reduce((into, result) => {
        assert.strictEqual(result.hasGeometry, true);
        return {
            minX: Math.min(into.minX, result.bbox.minX), maxX: Math.max(into.maxX, result.bbox.maxX),
            minY: Math.min(into.minY, result.bbox.minY), maxY: Math.max(into.maxY, result.bbox.maxY),
        };
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    assert.deepStrictEqual(union, whole.bbox);
});

test("only the first shard describes the whole design", { skip }, async () => {
    const bytes = fixture("sample_layout.gds");
    const shards = planShards(scanGdsTags(bytes), 2);

    const first = parseShard(await loadModule(), bytes,
                             { tags: shards[0], labels: true, hierarchy: true, releaseFile: true });
    const second = parseShard(await loadModule(), bytes,
                              { tags: shards[1], labels: false, hierarchy: false, releaseFile: true });

    // The cell tree, the ports and the labels are properties of the file, not
    // of a set of layers: every shard reads the same records and would report
    // the same ones, so all but the first are told not to.
    assert.ok(first.hierarchy.cellCount > 0);
    assert.deepStrictEqual(second.hierarchy, [], "a later shard must not rebuild the cell tree");
    assert.deepStrictEqual(second.ports, [], "a later shard must not re-expand the ports");
    // totalLabels is a uint64 on the C++ side, so it arrives as a BigInt.
    assert.strictEqual(Number(second.totalLabels), 0, "a later shard must not re-collect the labels");
});

// The viewer never splits an OASIS parse -- the header scan cannot read one,
// so planShards gets nothing to partition and the load falls back to a single
// Worker. But `tags` is part of parseGdsToLayers's contract whatever the
// format, and OASIS has to honour it the long way round: read_oas takes no
// filter, so gds_common.hpp drops the shapes afterwards (see
// filter_shape_tags). Silently ignoring the filter would hand a caller a
// layer it did not ask for.
test("the tag filter applies to OASIS too, which has no reader-level filter", { skip }, async () => {
    // Unfiltered: 1/0 is TOP's own box, and 2/0 is CHILD's, which comes back
    // as the instanced cell's unit shape rather than as a static layer.
    const both = parseShard(await loadModule(), fixture("sample_layout.oas"), null);
    assert.deepStrictEqual([...both.layers].map((l) => l.layer), [1]);
    assert.deepStrictEqual([...both.instanceGroups].map((g) => [...g.layers].map((l) => l.layer)), [[2]]);

    // Filtered to 1/0: CHILD's geometry is gone, and with it the whole
    // instance group -- no layers left in it to draw.
    const outer = parseShard(await loadModule(), fixture("sample_layout.oas"),
                             { tags: [packTag(1, 0)], labels: true, hierarchy: true });
    assert.strictEqual(outer.ok, true, outer.error);
    assert.deepStrictEqual([...outer.layers].map((l) => l.layer), [1]);
    assert.deepStrictEqual([...outer.instanceGroups], []);

    // Filtered the other way: only the instanced cell's layer survives.
    const inner = parseShard(await loadModule(), fixture("sample_layout.oas"),
                             { tags: [packTag(2, 0)], labels: false, hierarchy: false });
    assert.strictEqual(inner.ok, true, inner.error);
    assert.deepStrictEqual([...inner.layers], []);
    assert.deepStrictEqual([...inner.instanceGroups].map((g) => [...g.layers].map((l) => l.layer)), [[2]]);
});

// fixtures/instanced_two_layers.gds exists for this one case: a cell placed
// nine times (over the instancing threshold) carrying geometry on two layers,
// plus a third layer on the top cell. Split three ways, the instanced cell's
// two layers land in two different shards -- so each reports the same cell as
// a group of its own, with the same nine placements and half the layers. Every
// other fixture has its instanced geometry on a single layer, where the
// question never comes up.
test("one cell's geometry split across shards merges back into one group", { skip }, async () => {
    const bytes = fixture("instanced_two_layers.gds");
    const shards = planShards(scanGdsTags(bytes), 3);
    assert.strictEqual(shards.length, 3, "three equal layers should split three ways");

    const whole = parseShard(await loadModule(), bytes, null);
    const parts = [];
    for (const [index, tags] of shards.entries()) {
        parts.push(parseShard(await loadModule(), bytes,
                              { tags, labels: index === 0, hierarchy: index === 0, releaseFile: true }));
    }

    // Unmerged, the instanced cell is reported by two of the three shards.
    assert.strictEqual(parts.reduce((n, part) => n + part.instanceGroups.length, 0), 2);

    const merged = mergeShardResults(parts);
    assert.deepStrictEqual(
        summarize(merged.layers, merged.instanceGroups),
        summarize(whole.layers, whole.instanceGroups),
        "the merge did not reproduce the unsplit parse");

    // Specifically: one group, its placements carried once rather than once
    // per shard, and both of the cell's layers on it.
    assert.strictEqual(merged.instanceGroups.length, 1);
    const group = merged.instanceGroups[0];
    assert.strictEqual(group.cell, "CHILD");
    assert.strictEqual(group.instances.length / 6, 9);
    assert.deepStrictEqual([...group.layers].map((l) => `${l.layer}/${l.datatype}`), ["1/0", "2/0"]);
    assert.deepStrictEqual(group.bbox, whole.instanceGroups[0].bbox,
                           "the group's world footprint is the union of what each shard saw");
    assert.deepStrictEqual(merged.bbox, whole.bbox);
});

test("a shard releases the staged file when asked", { skip }, async () => {
    const Module = await loadModule();
    Module.FS.writeFile("/input.layout", fixture("sample_layout.gds"));
    Module.parseGdsToLayers("/input.layout", { tags: [packTag(1, 0)], releaseFile: true });
    assert.throws(() => Module.FS.stat("/input.layout"), "the shard's copy of the file should be gone");
});

// ---- The same thing, through the real viewer ----

// Everything above tests the split in pieces. This runs it: a built payload in
// headless Chromium, loading one design twice -- once in a single Worker and
// once split across two -- and comparing the frames the renderer actually
// drew. The `shards` override is what makes that possible on a fixture far too
// small to be split on its own (see shardsRequested in viewer.js).
//
// Reading the frame back needs the dance compare-slots.test.js documents: no
// preserveDrawingBuffer, so nudge the camera to queue the renderer's own
// redraw and read inside a requestAnimationFrame registered after it.
async function loadAndRead(query) {
    let result = null;
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=sample_layout.gds${query}`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        result = await page.evaluate(async () => {
            const element = document.querySelector("gds-lens");
            await element.setCamera(await element.getCamera());
            const layers = [...await element.getLayers()].map((l) => `${l.layer}/${l.datatype}`);
            const frame = await new Promise((resolve) => requestAnimationFrame(() => {
                const canvas = element.shadowRoot.getElementById("glCanvas");
                const gl = canvas.getContext("webgl2");
                const pixels = new Uint8Array(canvas.width * canvas.height * 4);
                gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                // Hashed in the page: a full frame is several megabytes and
                // would have to cross as JSON.
                let hash = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    hash = (hash * 31 + pixels[i] + pixels[i + 1] * 3 + pixels[i + 2] * 7) >>> 0;
                }
                resolve(hash);
            }));
            return { frame, layers, bbox: element.getBounds ? element.getBounds() : null };
        });
        result.pageErrors = pageErrors;
    });
    return result;
}

test("a split parse draws the same frame as an unsplit one",
     { skip: !defaultVariant || !chromium ? "no built payload, or playwright's chromium is missing" : false },
     async () => {
    const whole = await loadAndRead("");
    const split = await loadAndRead("&gdsShards=2");

    assert.deepEqual(whole.pageErrors, [], "the unsplit load threw");
    assert.deepEqual(split.pageErrors, [], "the split load threw");
    assert.deepStrictEqual(split.layers, whole.layers, "the split load found different layers");
    // Pixel for pixel: the split is only worth having if it is invisible.
    assert.strictEqual(split.frame, whole.frame, "the split load drew a different frame");
});
