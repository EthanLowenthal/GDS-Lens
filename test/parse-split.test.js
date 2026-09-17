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

test("the header scan totals points and polygons per layer without parsing", () => {
    const tags = scanGdsTags(fixture("sample_layout.gds"));
    // Both boxes are 4-point rectangles, closed in GDSII (first point repeated).
    // Points say how much work a layer is; polygons say how finely it divides.
    assert.deepStrictEqual(
        [...tags].sort((a, b) => a[0] - b[0]),
        [[packTag(1, 0), { points: 5, polygons: 1 }],
         [packTag(2, 0), { points: 5, polygons: 1 }]]);
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

// Shaped like the scan's output, at a scale the planner takes seriously: the
// weights are millions of points, spread over polygons big enough to count as
// the expensive kind to triangulate, unless a case says otherwise.
const scanned = (...pairs) =>
    new Map(pairs.map(([tag, millions, polygons = null]) => {
        const points = millions * 1e6;
        return [tag, { points, polygons: polygons === null ? Math.round(points / 50) : polygons }];
    }));

test("shards are planned heaviest-first onto the lightest shard", () => {
    // Six layers even enough that none needs striping, so every piece is a
    // whole layer and this is a test of the assignment alone.
    const plan = planShards(scanned([1, 10], [2, 9], [3, 8], [4, 7], [5, 6], [6, 5]), 2);
    assert.deepStrictEqual(plan.map((shard) => shard.stripes), [[], []], "nothing should be striped");
    assert.deepStrictEqual(plan.map((shard) => shard.tags), [[1, 4, 5], [2, 3, 6]]);
    // 23 and 22 against a total of 45: the best a two-way split can do.
    // Walking the layers in their own order would have given 27 and 18.
    assert.deepStrictEqual(plan.map((shard) => shard.tags.reduce((n, t) => n + (11 - t), 0)), [23, 22]);
});

test("there is nothing to plan from", () => {
    assert.strictEqual(planShards(null, 2), null);
    assert.strictEqual(planShards(new Map(), 2), null);
    // A design of a dozen polygons is not worth a second Worker whatever its
    // layers look like.
    assert.strictEqual(planShards(scanned([10, 100, 6], [20, 100, 6]), 4), null);
});

test("a design of rectangles is not split, however large", () => {
    // Splitting divides the triangulation but duplicates the parse, so it only
    // pays where there is triangulation to divide. Rectangles are convex and
    // filled by a fan in one linear pass, which is an order of magnitude
    // cheaper per point than the ear clipping a concave polygon needs -- so a
    // design of nothing but rectangles spends its time in the parse, and
    // splitting it makes the load slower rather than faster.
    //
    // Five point averages per polygon is what a layer of rectangles looks like
    // to the scan (four corners, closed).
    const rectangles = new Map([[1, { points: 3e6, polygons: 600000 }],
                                [2, { points: 2e6, polygons: 400000 }]]);
    assert.strictEqual(planShards(rectangles, 8), null);

    // The same point count on polygons of a hundred points each is real work,
    // and is split.
    const curves = new Map([[1, { points: 3e6, polygons: 30000 }],
                            [2, { points: 2e6, polygons: 20000 }]]);
    assert.ok(planShards(curves, 8));
});

test("a layer too heavy for one shard is striped across several", () => {
    // Nearly all on one layer, an ordinary shape for a design with one routing
    // or waveguide layer. Assigning whole layers cannot split this at all --
    // the heaviest one is a floor on the makespan -- so the heavy layer is
    // shared, each shard taking every Nth polygon of it.
    const plan = planShards(scanned([1, 925], [2, 40], [3, 35]), 4);
    assert.strictEqual(plan.length, 4);
    for (const shard of plan) assert.ok(shard.tags.includes(1), "every shard should share layer 1");
    // Flat [tag, index, count] triples, one per shared layer, and the indices
    // are a complete cover of the stripe count -- no polygon read twice, none
    // dropped.
    const indices = plan.map((shard) => {
        assert.deepStrictEqual(shard.stripes.length, 3);
        assert.deepStrictEqual([shard.stripes[0], shard.stripes[2]], [1, 4]);
        return shard.stripes[1];
    });
    assert.deepStrictEqual([...indices].sort(), [0, 1, 2, 3]);
});

test("a layer is not striped more finely than it has polygons to divide", () => {
    // Same lopsided shape, but the heavy layer is 40 polygons: dividing that
    // eight ways gives shards five polygons each, which is not worth a parse.
    const plan = planShards(scanned([1, 925, 40], [2, 40], [3, 35]), 8);
    const shared = plan.filter((shard) => shard.stripes.length > 0);
    for (const shard of shared) assert.ok(shard.stripes[2] <= 1 || shard.stripes[2] <= 40 / 32 + 1);
    assert.ok(plan.length <= 8);
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
    // Instancing is decided on how many polygons a cell's copies would add if
    // flattened, and these fixtures are a few rectangles -- far under the
    // threshold, so nothing in them would be instanced at the real setting.
    // These tests are about sharding rather than about that decision, and a
    // fixture large enough to cross the threshold on its own merits would be
    // hundreds of kilobytes of repository, so the threshold is pinned to 0
    // instead: every cell placed often enough is instanced, which is what the
    // fixtures were built for.
    Module.setInstanceThreshold(0);
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

// Shard assignments written out rather than planned, so these stay tests of
// what the reader does with them. planShards has its own tests above, and
// would refuse these fixtures anyway -- they hold a handful of polygons, far
// below what it considers worth a second Worker.
const shardOf = (tags, stripes = []) => ({ tags, stripes });

test("a two-shard parse rebuilds exactly what one shard produces", { skip }, async () => {
    const bytes = fixture("sample_layout.gds");
    const shards = [shardOf([packTag(1, 0)]), shardOf([packTag(2, 0)])];

    const whole = parseShard(await loadModule(), bytes, null);
    assert.strictEqual(whole.ok, true, whole.error);

    // A fresh module per shard, which is what a Worker each really means: no
    // state carries between them.
    const results = [];
    for (const [index, shard] of shards.entries()) {
        const result = parseShard(await loadModule(), bytes,
                                  { ...shard, labels: index === 0, hierarchy: index === 0, releaseFile: true });
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
    const shards = [shardOf([packTag(1, 0)]), shardOf([packTag(2, 0)])];

    const first = parseShard(await loadModule(), bytes,
                             { ...shards[0], labels: true, hierarchy: true, releaseFile: true });
    const second = parseShard(await loadModule(), bytes,
                              { ...shards[1], labels: false, hierarchy: false, releaseFile: true });

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
    const shards = [shardOf([packTag(1, 0)]), shardOf([packTag(2, 0)]), shardOf([packTag(3, 0)])];

    const whole = parseShard(await loadModule(), bytes, null);
    const parts = [];
    for (const [index, shard] of shards.entries()) {
        parts.push(parseShard(await loadModule(), bytes,
                              { ...shard, labels: index === 0, hierarchy: index === 0, releaseFile: true }));
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

// Every polygon in the design, keyed by layer and reduced to its vertices, so
// a striped parse can be checked against an unsplit one: the polygons are the
// same set even though they arrive spread across several entries per layer
// instead of one. Sorted, since which shard produced which polygon is exactly
// what changes.
function polygonsByTag(layers, groups) {
    const byLayer = new Map();
    const take = (entries) => {
        for (const entry of entries) {
            const key = `${entry.layer}/${entry.datatype}`;
            if (!byLayer.has(key)) byLayer.set(key, []);
            const into = byLayer.get(key);
            const vertices = entry.outlineVertices;
            const ranges = entry.outlineRanges;
            for (let i = 0; i < ranges.length; i += 2) {
                const first = ranges[i];
                const count = ranges[i + 1];
                into.push([...vertices.subarray(first * 2, (first + count) * 2)].join(","));
            }
        }
    };
    take(layers);
    for (const group of groups) take(group.layers);
    for (const list of byLayer.values()) list.sort();
    return byLayer;
}

// fixtures/striped_layer.gds puts 401 polygons on 1/0 against one each on 2/0
// and 3/0, which is the shape no assignment of whole layers can split: the one
// heavy layer would be a floor on the makespan however many Workers ran. So
// the layer itself is shared, each shard taking every Nth polygon of it.
//
// What has to hold is that the stripes are a partition -- every polygon built
// exactly once across the shards. An off-by-one in the stride would silently
// drop or double a slice of the design, which is the kind of thing that shows
// up as a subtly wrong picture rather than as an error.
test("striping a layer across shards partitions it exactly", { skip }, async () => {
    const bytes = fixture("striped_layer.gds");
    // What a plan for this design looks like: the heavy layer shared four ways,
    // the two small ones riding along on the first shard.
    const heavyTag = packTag(1, 0);
    const shards = [0, 1, 2, 3].map((index) => shardOf(
        index === 0 ? [heavyTag, packTag(2, 0), packTag(3, 0)] : [heavyTag],
        [heavyTag, index, 4]));

    const whole = parseShard(await loadModule(), bytes, null);
    assert.strictEqual(whole.ok, true, whole.error);

    const parts = [];
    for (const [index, shard] of shards.entries()) {
        const part = parseShard(await loadModule(), bytes,
                                { ...shard, labels: index === 0, hierarchy: index === 0, releaseFile: true });
        assert.strictEqual(part.ok, true, part.error);
        parts.push(part);
    }

    const merged = mergeShardResults(parts);
    const got = polygonsByTag(merged.layers, merged.instanceGroups);
    const want = polygonsByTag(whole.layers, whole.instanceGroups);
    assert.deepStrictEqual([...got.keys()].sort(), [...want.keys()].sort());
    for (const [tag, polygons] of want) {
        assert.deepStrictEqual(got.get(tag), polygons, `layer ${tag} did not come back whole`);
    }

    // The heavy layer arrives as several entries rather than one -- which is
    // what the sidebar's per-tag folding is for -- holding between them every
    // polygon an unsplit parse put in the single entry.
    const entriesOn = (result) => result.layers.concat(...result.instanceGroups.map((g) => g.layers))
        .filter((entry) => entry.layer === 1 && entry.datatype === 0);
    const polygonsOn = (result) =>
        entriesOn(result).reduce((n, entry) => n + entry.outlineRanges.length / 2, 0);
    assert.ok(entriesOn(merged).length > entriesOn(whole).length, "the layer should arrive striped");
    assert.strictEqual(polygonsOn(merged), polygonsOn(whole));
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
async function loadAndRead(query, src = "sample_layout.gds") {
    let result = null;
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=${src}${query}`);
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
            // One row per (layer, datatype) in the sidebar, whatever the parse
            // produced -- a striped layer arrives as several entries.
            const rows = [...element.shadowRoot.querySelectorAll(".lil-controller.layer-row")]
                .map((row) => row.textContent.trim());
            return { frame, layers, rows };
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

// The same check for the harder case: a layer shared between shards, so the
// wasm side is handed the same tag four times over and the sidebar has four
// entries to fold into one row. Everything downstream of the parse -- the
// upload, the layer panel, the drawing -- meets a shape it never sees from an
// unsplit load.
test("a striped layer draws and lists the same as an unstriped one",
     { skip: !defaultVariant || !chromium ? "no built payload, or playwright's chromium is missing" : false },
     async () => {
    const whole = await loadAndRead("&gdsShards=1", "striped_layer.gds");
    const striped = await loadAndRead("&gdsShards=4", "striped_layer.gds");

    assert.deepEqual(whole.pageErrors, [], "the unsplit load threw");
    assert.deepEqual(striped.pageErrors, [], "the striped load threw");
    assert.strictEqual(striped.frame, whole.frame, "the striped load drew a different frame");
    // Four parse entries for layer 1/0, one row for it.
    assert.deepStrictEqual(striped.rows, whole.rows, "the striped load listed different layers");
});
