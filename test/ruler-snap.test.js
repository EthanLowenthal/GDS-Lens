// Tests for the ruler's snap: in measure mode a click a few pixels off a
// corner lands exactly on it (see pick_snap_at in renderer.cpp).
//
// The snap reads a canvas-sized pick buffer that is drawn once and then reused
// for every mouse move until what it shows goes stale. So beyond "does a
// corner snap", what can go wrong is a stale buffer: a pan that leaves it
// answering for the old camera, or a hidden layer it still snaps to.
//
// sample_layout.gds: a 10x5um box on layer 1/0 with corners (0,0) and (10,5),
// and eight 2x1um boxes on layer 2/0 above it, among them one from (1,6) to
// (3,7) and one from (6,12) to (8,13).
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";

const skip = !defaultVariant || !chromium
    ? "no built payload, or playwright's chromium is missing"
    : false;

// Opens sample_layout.gds in measure mode and hands `fn` a click(corner,
// nudge) that clicks `nudge` pixels off a world point under the camera as it
// is at the time of the click.
async function withMeasureMode(fn) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=sample_layout.gds`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        const click = async ([wx, wy], [nx, ny]) => {
            // World to page coordinates, the inverse of screen_to_world.
            const view = await page.evaluate(async () => {
                const element = document.querySelector("gds-lens");
                const canvas = element.shadowRoot.getElementById("glCanvas");
                const rect = canvas.getBoundingClientRect();
                return { ...await element.getCamera(), left: rect.left, top: rect.top,
                         width: canvas.width, height: canvas.height };
            });
            const x = view.left + view.width / 2 + (wx - view.panX) * view.zoom + nx;
            const y = view.top + view.height / 2 - (wy - view.panY) * view.zoom + ny;
            // A move first, as a real pointer would make: the move is what
            // resolves the point under the cursor before the press.
            await page.mouse.move(x, y);
            await page.mouse.click(x, y);
        };
        const rulers = () => page.evaluate(async () =>
            (await document.querySelector("gds-lens").getMeasurements())
                .map((m) => [[m.x0, m.y0], [m.x1, m.y1]]));

        await page.mouse.move(10, 10);
        await page.keyboard.press("m");
        await fn({ page, click, rulers });
        assert.deepEqual(pageErrors, [], "the page threw");
    });
}

test("a click near a corner snaps the ruler onto it", { skip }, async () => {
    await withMeasureMode(async ({ click, rulers }) => {
        // Nudges well inside the 12px snap radius, pointing away from every
        // other vertex.
        await click([0, 0], [4, 3]);
        await click([10, 0], [-3, 4]);
        await click([1, 6], [3, 4]);
        await click([8, 13], [-4, -3]);
        assert.deepStrictEqual(await rulers(), [[[0, 0], [10, 0]], [[1, 6], [8, 13]]]);
    });
});

test("the snap follows the camera after a pan", { skip }, async () => {
    await withMeasureMode(async ({ page, click, rulers }) => {
        // Fills the pick buffer under the starting camera.
        await click([0, 0], [4, 3]);
        await click([10, 0], [-3, 4]);
        // Two micrometres is well over a hundred pixels at this zoom: a buffer
        // left over from before the pan has nothing at (1,6) to snap to, and
        // something else entirely under the cursor.
        await page.evaluate(async () => {
            const element = document.querySelector("gds-lens");
            const camera = await element.getCamera();
            await element.setCamera({ ...camera, panX: camera.panX - 2, panY: camera.panY + 2 });
        });
        await click([1, 6], [3, 4]);
        await click([8, 13], [-4, -3]);
        assert.deepStrictEqual(await rulers(), [[[0, 0], [10, 0]], [[1, 6], [8, 13]]]);
    });
});

test("a hidden layer is not snapped to", { skip }, async () => {
    await withMeasureMode(async ({ page, click, rulers }) => {
        await click([1, 6], [3, 4]);
        await click([8, 13], [-4, -3]);
        await page.evaluate(() => document.querySelector("gds-lens").setLayerVisible(2, 0, false));
        await click([1, 6], [3, 4]);
        await click([8, 13], [-4, -3]);
        const [before, after] = await rulers();
        assert.deepStrictEqual(before, [[1, 6], [8, 13]]);
        // Nothing else is within reach of either click, so both land where
        // the pointer was rather than on the hidden boxes.
        assert.notDeepStrictEqual(after[0], [1, 6]);
        assert.notDeepStrictEqual(after[1], [8, 13]);
    });
});
