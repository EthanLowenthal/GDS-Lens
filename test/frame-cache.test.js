// Tests for the layer cache: on a large layout, pan and zoom reproject the
// last render out of an offscreen texture instead of drawing the geometry (see
// the g_cache_* declarations in renderer.cpp).
//
// Only the layers go through the cache. Everything drawn over them -- the
// ruler, labels, markers, highlights -- is drawn fresh every frame, and has to
// land exactly where it would with no cache at all. It once did not: the cache
// path left the shared program's resolution uniform at the cache's larger size
// and its camera at whatever the last real render used, so the ruler drew
// shrunk toward the canvas centre and stopped lining up with the pointer, on
// exactly the layouts big enough to turn the cache on.
//
// The cache normally waits for millions of polygons; ?gdsCacheMinPolygons=0
// turns it on for sample_layout.gds (a 10x5um box plus eight small ones), and
// a huge value keeps it off, so the two runs differ in nothing else.
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";

const skip = !defaultVariant || !chromium
    ? "no built payload, or playwright's chromium is missing"
    : false;

// Off-centre on purpose: a ruler through the middle of the canvas would look
// right even when scaled about it.
const RULER = [1, 1, 9, 4];

// Where the ruler's pixels are, as the difference between a frame with it and
// the same frame without it -- which takes the layers out of the comparison,
// so the cache's own reprojection cannot fail or pass it. Read once settled at
// the starting camera, and once mid-pan: a reprojected frame, which is the one
// that never set the camera for the overlays.
async function rulerPixels(cacheMin) {
    let result = null;
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=sample_layout.gds` +
                        `&gdsCacheMinPolygons=${cacheMin}`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        result = await page.evaluate(async (ruler) => {
            const element = document.querySelector("gds-lens");
            const canvas = element.shadowRoot.getElementById("glCanvas");
            const gl = canvas.getContext("webgl2");
            const home = await element.getCamera();
            // Half a canvas width of pan, which stays inside the cache's
            // margin, so the moved frame is a reprojection and not a re-render.
            const moved = { ...home, panX: home.panX + canvas.width * 0.25 / home.zoom };

            // Same dance as compare-slots.test.js: no preserveDrawingBuffer, so
            // set the camera to queue the renderer's own frame, then read
            // inside a requestAnimationFrame registered after it.
            const readAt = async (camera) => {
                await element.setCamera(camera);
                return new Promise((resolve) => requestAnimationFrame(() => {
                    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
                    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                    resolve(pixels);
                }));
            };
            // At home long enough for the settle timer to fire and the cache to
            // be rendered there, whichever path this run is on.
            const settleAtHome = async () => {
                for (let i = 0; i < 3; i++) {
                    await readAt(home);
                    await new Promise((resolve) => setTimeout(resolve, 150));
                }
                return readAt(home);
            };
            const settledThenMoved = async () => {
                const settled = await settleAtHome();
                return { settled, moved: await readAt(moved) };
            };
            const changed = (a, b) => {
                const out = [];
                for (let i = 0; i < a.length; i += 4) {
                    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) out.push(i / 4);
                }
                return out;
            };

            const without = await settledThenMoved();
            await element.addMeasurement(...ruler);
            const withRuler = await settledThenMoved();
            return {
                width: canvas.width,
                settled: changed(without.settled, withRuler.settled),
                moved: changed(without.moved, withRuler.moved)
            };
        }, RULER);
        result.pageErrors = pageErrors;
    });
    return result;
}

// Pixel indices as the rows and columns they span, for a failure message a
// person can read.
const extent = (indices, width) => {
    const xs = indices.map((i) => i % width);
    const ys = indices.map((i) => Math.floor(i / width));
    return `x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}`;
};

test("the ruler draws in the same place with the layer cache on as off", { skip }, async () => {
    const direct = await rulerPixels(1e15);
    const cached = await rulerPixels(0);

    assert.deepEqual(direct.pageErrors, [], "the uncached run threw");
    assert.deepEqual(cached.pageErrors, [], "the cached run threw");
    assert.ok(direct.settled.length > 0, "the ruler drew nothing without the cache");
    assert.ok(direct.moved.length > 0, "the ruler drew nothing mid-pan without the cache");

    assert.ok(cached.settled.length > 0 && cached.moved.length > 0, "the ruler drew nothing with the cache");
    assert.deepStrictEqual(cached.settled, direct.settled,
        `settled: the ruler spans ${extent(cached.settled, cached.width)} with the cache, ` +
        `${extent(direct.settled, direct.width)} without`);
    assert.deepStrictEqual(cached.moved, direct.moved,
        `mid-pan: the ruler spans ${extent(cached.moved, cached.width)} with the cache, ` +
        `${extent(direct.moved, direct.width)} without`);
});
