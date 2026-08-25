// Tests <gds-lens> as a component rather than as a page: that importing it
// only registers the element, that an element created after load still works,
// that its src attribute and load() method drive it, and that a second one
// fails visibly rather than quietly fighting the first over the renderer's
// module-scope state.
//
// None of that depends on how the wasm binary arrives, so unlike the smoke
// test this runs against one payload rather than every built variant.
//
// Skipped unless a payload has been built (npm run build).

import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";

// A page that loads only the bundles, with no <gds-lens> in it, so "importing
// does not mount" can be observed at all. charset matters: the inline-wasm
// build embeds the binary as a raw string, so a document that is not UTF-8
// mangles it.
const BARE = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self';">
    </head><body>
    <script src="gds-lens-engine.js"></script>
    <script src="gds-lens-host.js"></script>
    <script src="gds-lens.js"></script>
    </body></html>`;

const withPage = (fn) => withPayload(defaultVariant, fn, { "bare.html": BARE });

const opts = { skip: !defaultVariant || !chromium };

test("importing the element does not mount a viewer", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        assert.ok(await page.evaluate(() => !!customElements.get("gds-lens")),
            "the element should be registered on import");
        // The whole point of deferring: no element, so no shadow root, no wasm
        // instance and no GL context.
        assert.equal(await page.evaluate(() => document.querySelector("gds-lens")), null,
            "importing should not place an element in the page");
    });
});

test("an element created after load mounts and loads a layout", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.width = "800px";
            el.style.height = "600px";
            document.body.appendChild(el);
            window.el = el;
        });
        // createElement on a registered name has to produce the real class,
        // not an unknown element.
        assert.ok(await page.evaluate(() => typeof window.el.load === "function"),
            "createElement should upgrade to the component class");

        await page.evaluate(() => window.el.load("sample_layout.gds"));
        await page.waitForFunction(
            () => window.el.shadowRoot?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        const err = await page.evaluate(
            () => window.el.shadowRoot.getElementById("loadError").textContent.trim());
        assert.equal(err, "", `load reported an error: ${err}`);
    });
});

test("the src attribute loads a layout", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.setAttribute("src", "sample_layout.gds");
            document.body.appendChild(el);
            window.el = el;
        });
        await page.waitForFunction(
            () => window.el.shadowRoot?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
    });
});

test("a second element refuses rather than fighting the first", opts, async () => {
    await withPage(async (page, port) => {
        const errors = [];
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            document.body.appendChild(document.createElement("gds-lens"));
            const second = document.createElement("gds-lens");
            document.body.appendChild(second);
            window.second = second;
        });
        await page.waitForFunction(() => window.second.textContent.length > 0, { timeout: 10_000 });
        assert.match(await page.evaluate(() => window.second.textContent), /only one/i);
        assert.ok(errors.some((e) => /only one/i.test(e)),
            "the refusal should also be reported to the console");
        // The first one must still be intact.
        assert.ok(await page.evaluate(() => !!document.querySelector("gds-lens").shadowRoot),
            "the first element should still be mounted");
    });
});
