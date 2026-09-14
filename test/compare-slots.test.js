// Tests for two layouts loaded into one viewer.
//
// The viewer holds up to two designs at once ("slots" a and b), drawn through
// one camera into one canvas, so comparing two revisions is one viewer with
// two documents rather than two viewers kept in step with each other. That is
// the whole design: there is no camera to synchronize, no panel state to
// mirror and no echo to suppress, because there is only ever one of each.
//
// What that leaves worth testing is the part that *is* new: that a second slot
// does not disturb the first, that the panel describes the union of the two,
// that the crossfade reaches the pixels, and that the difference highlight
// finds real differences and invents none.
//
// test/fixtures/sample_layout_rev.gds is sample_layout.gds with exactly two
// changes: the layer 1/0 boundary in TOP moved 2um to the right, and a 3x3um
// square added on layer 7/0, which the original does not use at all. Its
// library name, units, cell names, the CHILD cell and all three of its
// placements are byte-identical, so anything else that differs is a bug here.
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";

const skip = !defaultVariant || !chromium
    ? "no built payload, or playwright's chromium is missing"
    : false;

const REV = "sample_layout_rev.gds";

// Opens the viewer with the original design in slot a and nothing in slot b.
// Every test starts here, since a second layout is only meaningful next to a
// first one.
async function withViewer(fn) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));

        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=sample_layout.gds`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function",
                                   { timeout: 30_000 });
        await waitForIdle(page);

        await fn(page, { pageErrors, port });
        assert.deepEqual(pageErrors, [], "the page threw");
    });
}

const waitForIdle = (page) => page.waitForFunction(
    () => document.querySelector("gds-lens")?.shadowRoot
        ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
    { timeout: 60_000 });

// Loads the revision into slot b and waits for it to be drawn.
async function loadSecond(page, port) {
    await page.evaluate(async ({ url }) => {
        await document.querySelector("gds-lens").load(url, { slot: "b", name: "rev.gds" });
    }, { url: `http://127.0.0.1:${port}/${REV}` });
    await waitForIdle(page);
}

// Reads the drawn frame back out of the renderer's own WebGL context.
//
// Deliberately not canvas.toDataURL() or a 2D drawImage of the canvas: the
// context is created without preserveDrawingBuffer (see init_gl), so its
// colour buffer is only valid between the draw and the browser compositing it,
// and every other way of reading it comes back blank -- silently, which makes
// for tests that pass by finding nothing.
//
// So: nudge the camera to its current value, which queues the renderer's own
// requestAnimationFrame (see request_redraw), then register ours *after* it,
// so ours runs after the draw in the same frame with the buffer still intact.
async function readFrame(page) {
    return page.evaluate(async () => {
        const element = document.querySelector("gds-lens");
        await element.setCamera(await element.getCamera());
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                const canvas = element.shadowRoot.getElementById("glCanvas");
                const gl = canvas.getContext("webgl2");
                const pixels = new Uint8Array(canvas.width * canvas.height * 4);
                gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

                // Counted here rather than shipped to the test: a full frame is
                // several megabytes and crosses as JSON.
                let onlyA = 0, onlyB = 0, ink = 0, sum = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
                    // The difference highlight's two colours (kDiffColorA /
                    // kDiffColorB in renderer.cpp), with a generous tolerance
                    // because the highlight is alpha-blended over whatever it
                    // sits on.
                    if (r > 120 && g < r - 60 && b < r - 60) onlyA++;
                    else if (g > 120 && r < g - 60 && b < g - 60) onlyB++;
                    if (r > 24 || g > 24 || b > 24) ink++;
                    sum = (sum * 31 + r + g * 3 + b * 7) >>> 0;
                }
                resolve({ onlyA, onlyB, ink, sum, total: canvas.width * canvas.height });
            });
        });
    });
}

const getLayers = (page) => page.evaluate(() => document.querySelector("gds-lens").getLayers());

// Every layer row the panel is showing, in order, with the A/B chip it carries.
const panelLayerRows = (page) => page.evaluate(() => {
    const root = document.querySelector("gds-lens").shadowRoot;
    return [...root.querySelectorAll(".lil-controller.layer-row")].map((row) => ({
        name: row.querySelector(".lil-name")?.textContent.trim() || "",
        chip: row.querySelector(".slot-chip")?.textContent || null
    }));
});

// ---- One layout behaves exactly as it did before slots existed ----

test("loading only slot a leaves a single-layout viewer untouched", { skip }, async () => {
    await withViewer(async (page) => {
        // No Compare folder, no chips, and every layer reporting slot 0: the
        // common case has to be indistinguishable from the viewer that had no
        // notion of a second layout at all.
        const folders = await page.evaluate(() => [...document.querySelector("gds-lens").shadowRoot
            .querySelectorAll(".lil-gui .lil-title")].map((t) => t.textContent.trim()));
        assert.ok(!folders.some((name) => name.startsWith("Compare")),
                  `Compare folder built with one layout loaded: ${folders.join(", ")}`);

        const rows = await panelLayerRows(page);
        assert.ok(rows.length > 0, "no layer rows at all");
        assert.deepEqual(rows.filter((row) => row.chip), [], "chips drawn with one layout loaded");

        const layers = await getLayers(page);
        assert.deepEqual([...new Set(layers.map((l) => l.source))], [0]);
    });
});

// ---- A second layout arrives without disturbing the first ----

test("loading slot b leaves the camera where the user put it", { skip }, async () => {
    await withViewer(async (page, { port }) => {
        // Somewhere that is deliberately not the framing either design would
        // choose, so "did not move" is a real assertion.
        await page.evaluate(() => document.querySelector("gds-lens")
            .setCamera({ zoom: 12, panX: 3, panY: 4 }));
        const before = await page.evaluate(() => document.querySelector("gds-lens").getCamera());

        await loadSecond(page, port);

        const after = await page.evaluate(() => document.querySelector("gds-lens").getCamera());
        assert.deepEqual(after, before,
                         "the camera jumped when the second layout arrived");
    });
});

test("both layouts' layers are present, tagged with the slot they came from", { skip }, async () => {
    await withViewer(async (page, { port }) => {
        await loadSecond(page, port);
        const layers = await getLayers(page);

        const bySource = (source) => layers.filter((l) => l.source === source)
            .map((l) => `${l.layer}/${l.datatype}`).sort();
        // The original has 1/0 and 2/0; the revision adds 7/0.
        assert.deepEqual(bySource(0), ["1/0", "2/0"]);
        assert.deepEqual(bySource(1), ["1/0", "2/0", "7/0"]);
    });
});

test("the layer panel lists the union, chipped where a layer is in only one", { skip }, async () => {
    await withViewer(async (page, { port }) => {
        await loadSecond(page, port);
        const rows = await panelLayerRows(page);

        // One row per (layer, datatype) across both designs, not one per wasm
        // entry -- 1/0 and 2/0 exist in both and must not be listed twice.
        const names = rows.map((row) => row.name);
        assert.equal(new Set(names).size, names.length, `duplicate rows: ${names.join(", ")}`);

        const chipFor = (prefix) => rows.find((row) => row.name.startsWith(prefix))?.chip;
        assert.equal(chipFor("1/0"), null, "1/0 is in both layouts and should carry no chip");
        assert.equal(chipFor("2/0"), null, "2/0 is in both layouts and should carry no chip");
        // The whole point of listing the union: a layer only the revision has
        // still gets a row, and says so.
        assert.equal(chipFor("7/0"), "B", "7/0 is only in the second layout");
    });
});

// ---- The crossfade ----

test("the blend slider reaches the pixels, and its ends are the two layouts", { skip }, async () => {
    await withViewer(async (page, { port }) => {
        await loadSecond(page, port);
        const setBlend = (value) =>
            page.evaluate((v) => document.querySelector("gds-lens").setBlend(v), value);

        await setBlend(0);
        const zero = await readFrame(page);
        await setBlend(1);
        const one = await readFrame(page);
        await setBlend(0.5);
        const half = await readFrame(page);

        // Something was actually drawn: every assertion below is "these frames
        // differ", which an empty read-back would satisfy for the wrong reason.
        assert.ok(zero.ink > 0, "nothing was drawn at blend 0");
        assert.ok(one.ink > 0, "nothing was drawn at blend 1");

        assert.notEqual(zero.sum, one.sum, "the two layouts render identically");
        assert.notEqual(half.sum, zero.sum, "the overlay looks like the first layout alone");
        assert.notEqual(half.sum, one.sum, "the overlay looks like the second layout alone");
    });
});

test("unloading the second layout returns the viewer to a single one", { skip }, async () => {
    await withViewer(async (page, { port }) => {
        await loadSecond(page, port);
        // Left mid-crossfade on purpose: dropping back to one layout must not
        // leave the only thing on screen half-faded.
        await page.evaluate(() => document.querySelector("gds-lens").setBlend(0.25));
        await page.evaluate(() => document.querySelector("gds-lens").unload("b"));

        const layers = await getLayers(page);
        assert.deepEqual([...new Set(layers.map((l) => l.source))], [0],
                         "the second layout's geometry outlived its slot");

        const rows = await panelLayerRows(page);
        assert.deepEqual(rows.filter((row) => row.chip), [], "chips left behind after unload");
        assert.equal(await page.evaluate(() => document.querySelector("gds-lens").getBlend()), 0.5,
                     "the crossfade was left applied to a single layout");

        const folders = await page.evaluate(() => [...document.querySelector("gds-lens").shadowRoot
            .querySelectorAll(".lil-gui .lil-title")].map((t) => t.textContent.trim()));
        assert.ok(!folders.some((name) => name.startsWith("Compare")),
                  "the Compare folder outlived the second layout");
    });
});

// ---- The difference highlight ----

test("a layout compared against itself highlights nothing", { skip }, async () => {
    await withViewer(async (page, { port }) => {
        // The load-bearing test for the whole screen-space approach. Both
        // sides rasterize through the same camera into the same mask in the
        // same frame, so identical geometry has to cancel exactly -- an
        // unthresholded or misaligned comparison would light up every edge in
        // the design, and this is where that shows up.
        await page.evaluate(async ({ url }) => {
            await document.querySelector("gds-lens").load(url, { slot: "b", name: "same.gds" });
        }, { url: `http://127.0.0.1:${port}/sample_layout.gds` });
        await waitForIdle(page);

        await setDiff(page, true);

        const { onlyA, onlyB, ink } = await readFrame(page);
        assert.ok(ink > 0, "nothing was drawn, so there was nothing to disagree about");
        assert.equal(onlyA, 0, `${onlyA} pixels marked as present only in the first copy`);
        assert.equal(onlyB, 0, `${onlyB} pixels marked as present only in the second copy`);
    });
});

test("a moved shape and an added layer are both highlighted", { skip }, async () => {
    await withViewer(async (page, { port }) => {
        await loadSecond(page, port);
        const before = await readFrame(page);
        assert.deepEqual({ onlyA: before.onlyA, onlyB: before.onlyB }, { onlyA: 0, onlyB: 0 },
                         "the highlight drew while switched off");

        await setDiff(page, true);
        const { onlyA, onlyB, total } = await readFrame(page);

        // The moved 1/0 boundary leaves the strip it vacated marked as A-only
        // and the strip it moved into marked as B-only; the added 7/0 square
        // is B-only as well. Both counts are bounded because a highlight over
        // the whole canvas would mean the comparison matched nothing at all.
        assert.ok(onlyA > 0, "the vacated strip of the moved shape was not marked");
        assert.ok(onlyB > 0, "neither the moved shape's new position nor the added layer was marked");
        assert.ok(onlyA < total / 2, `${onlyA} of ${total} pixels marked A-only: nothing matched`);
        assert.ok(onlyB < total / 2, `${onlyB} of ${total} pixels marked B-only: nothing matched`);
    });
});

// The checkbox in the panel rather than a method, so this covers the row
// being wired up as well as the renderer doing the work.
async function setDiff(page, on) {
    const clicked = await page.evaluate((want) => {
        const root = document.querySelector("gds-lens").shadowRoot;
        const row = [...root.querySelectorAll(".lil-controller")]
            .find((r) => r.querySelector(".lil-name")?.textContent.trim() === "Highlight differences");
        const box = row?.querySelector("input[type=checkbox]");
        if (!box || box.checked === want) return false;
        box.click();
        return true;
    }, on);
    assert.ok(clicked, `could not toggle the difference highlight ${on ? "on" : "off"}`);
}
