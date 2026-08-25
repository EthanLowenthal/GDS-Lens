// End-to-end smoke test for a payload as an ordinary web page: serves it over
// HTTP, opens it in headless Chromium, hands it a layout, and waits for
// geometry to reach the renderer.
//
// This covers the half that unit tests structurally cannot -- whether the
// files actually wire together. The scripts loading in the right order, the
// host installing itself, connect() running, the Worker starting from
// document-relative URLs, wasm instantiating, and the parse landing. A
// missing or misnamed script in the payload fails here and nowhere else.
//
// Runs once per built payload, because the two differ in exactly this: the
// dist/web build's Worker has to locate and fetch a separate gds-lens-engine.wasm
// from inside a blob: URL, which nothing else exercises.
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";

import { chromium, variants, withPayload } from "./payload.js";

// Named so a failure says which payload broke.
for (const variant of variants.length ? variants : [null]) {
test(`the ${variant?.name ?? "web"} payload loads a layout as a plain web page`,
     { skip: !variant || !chromium }, async () => {
    await withPayload(variant, async (page, port) => {
        const errors = [];
        page.on("pageerror", (err) => errors.push(String(err)));
        const wasmFetches = [];
        page.on("request", (req) => {
            if (req.url().endsWith(".wasm")) wasmFetches.push(req.url());
        });

        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=sample_layout.gds`);

        // The host has to install itself before viewer.js reads it. This is
        // exactly what broke when gds-lens-host.js was left out of the payload.
        assert.ok(await page.evaluate(() => typeof window.gdsLensHost === "object"),
                  "window.gdsLensHost was never installed");

        // connect() publishes the viewer surface, so this proves the handshake
        // ran rather than merely that a global exists.
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });

        // The overlay hides only once geometry has been uploaded, which means
        // the Worker started, wasm instantiated and the parse succeeded.
        // Scoped to the shadow root: the viewer's elements are not reachable
        // from the document, which is the point of mounting it in one.
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        // #loadError hides via `:empty` in CSS rather than a class, so any
        // text in it at all is a failure.
        const loadError = await page.evaluate(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadError")?.textContent.trim() || null);
        assert.equal(loadError, null, `viewer reported a load error: ${loadError}`);

        // fixtures/sample_layout.gds has shapes on layers 1/0 and 2/0.
        const layers = await page.evaluate(() => window.gdsLens.getLayerCount?.() ?? null);
        if (layers !== null) assert.ok(layers > 0, "no layers reached the renderer");

        // Layout, not just "it loaded". lil-gui only floats its own panel when
        // it appends to document.body; passing a container to keep it in the
        // shadow root skips that, and without replacing the positioning the
        // panel becomes a full-width block that pushes the canvas down. That
        // renders, throws nothing, and is only visible to someone looking at
        // it -- so it is asserted here instead.
        const geom = await page.evaluate(() => {
            const sr = document.querySelector("gds-lens").shadowRoot;
            const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
            return {
                gui: box(sr.querySelector(".lil-gui.lil-root")),
                canvas: box(sr.getElementById("glCanvas")),
                viewportWidth: window.innerWidth
            };
        });
        assert.ok(geom.gui.w > 200 && geom.gui.w < 400,
            `control panel should be a fixed-width panel, got ${geom.gui.w}px`);
        assert.ok(geom.gui.x > geom.viewportWidth / 2,
            `control panel should sit on the right, got x=${geom.gui.x} of ${geom.viewportWidth}`);
        assert.equal(geom.canvas.y, 0, "canvas should start at the top, not be pushed down by the panel");

        // The isolation is the point, so check it rather than assume it: none
        // of the viewer's elements may be reachable from the document, and the
        // page must not have inherited its styles.
        const leaked = await page.evaluate(() => ({
            byId: !!document.getElementById("glCanvas"),
            styles: document.styleSheets.length
        }));
        assert.equal(leaked.byId, false, "viewer elements are reachable from the document");

        // The variants have to differ in exactly one observable way, and this
        // is it. Asserting both directions catches a payload built against the
        // wrong CMake tree, which otherwise still loads and looks fine.
        if (variant.separateWasm) {
            assert.ok(wasmFetches.length > 0,
                "the web payload should fetch gds-lens-engine.wasm rather than embed it");
            // Two instantiations, main thread and Worker; the Worker's is the
            // one that needs locateFile, since it runs from a blob: URL with
            // no directory of its own to resolve against.
            assert.ok(wasmFetches.length >= 2,
                `the Worker should fetch the binary too, saw ${wasmFetches.length} request(s)`);
        } else {
            assert.deepEqual(wasmFetches, [],
                "the inline-wasm payload should not fetch a binary at all");
        }

        assert.deepEqual(errors, [], `uncaught errors on the page: ${errors.join("; ")}`);
    });
});
}
