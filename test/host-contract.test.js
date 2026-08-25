// Exercises the ViewerHost contract with a mock host.
//
// This is the seam introduced when the viewer stopped calling VS Code
// directly: the viewer asks a host for files, names and persistence, and the
// host drives the viewer through the surface connect() hands it. The VS Code
// adapter is one implementation of this contract and cannot be tested without
// VS Code, but the contract itself can, and it is what the adapter is written
// against.
//
// The contract is the same whichever way the wasm arrives, so this runs
// against one payload rather than every built variant.
//
// Skipped unless a payload has been built (npm run build).

import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";

import { chromium, defaultVariant, fixtures, withPayload } from "./payload.js";

// The mock host is installed as window.gdsLensHost *before* gds-lens.js runs,
// which is exactly how a real embedder replaces the default one. It records
// every call so the test can assert what the viewer asked for.
const HOST_SCRIPT = `
window.__calls = [];
const record = (name, args) => window.__calls.push({ name, args });
window.gdsLensHost = {
    pickLyp: () => { record("pickLyp"); return Promise.resolve(window.__lyp || null); },
    unloadLyp: () => record("unloadLyp"),
    pickMarkers: () => { record("pickMarkers"); return Promise.resolve(window.__markers || null); },
    unloadMarkers: () => record("unloadMarkers"),
    loadViews: () => { record("loadViews"); return Promise.resolve(window.__views || []); },
    saveViews: (views) => record("saveViews", views.length),
    promptViewName: (names) => { record("promptViewName", names); return Promise.resolve("Overview"); },
    requestReload: () => record("requestReload"),
    setAutoReload: (on) => record("setAutoReload", on),
    onGotoResult: (r) => record("onGotoResult", r),
    connect: (viewer) => { window.viewer = viewer; record("connect"); }
};
`;

// Substituting gds-lens-host.js is the whole setup: the payload's own default host
// never runs, so nothing else has to be stubbed.
async function mounted(fn) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e)));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html`);
        // Getting a layout in is the host's job, and this mock replaces the
        // default host that would otherwise handle ?src=. Driving it through
        // the surface connect() hands over is the point: it is the same call
        // the VS Code adapter makes when the extension streams bytes down.
        await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });
        await page.evaluate(async () => {
            const bytes = await (await fetch("sample_layout.gds")).arrayBuffer();
            window.viewer.load(new Uint8Array(bytes), { reload: false });
        });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        await fn(page);
        assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join("; ")}`);
    }, { "gds-lens-host.js": HOST_SCRIPT });
}

const calls = (page) => page.evaluate(() => window.__calls.map((c) => c.name));
const opts = { skip: !defaultVariant || !chromium };

test("the host is connected and asked for its stored views", opts, async () => {
    await mounted(async (page) => {
        const names = await calls(page);
        assert.ok(names.includes("connect"), "connect() was never called");
        assert.ok(names.includes("loadViews"), "the viewer never asked for stored views");
        assert.ok(await page.evaluate(() => typeof window.viewer.load === "function"),
            "connect() should hand over the viewer surface");
    });
});

test("a .lyp pushed by the host names the layers", opts, async () => {
    const lyp = fs.readFileSync(path.join(fixtures, "sample.lyp"), "utf8");
    await mounted(async (page) => {
        await page.evaluate((text) => window.viewer.setLyp("sample.lyp", text), lyp);
        // fixtures/sample.lyp names layers 1/0 and 2/0, which is what
        // sample_layout.gds draws on.
        await page.waitForFunction(() => {
            const sr = document.querySelector("gds-lens").shadowRoot;
            return sr.textContent.includes("METAL1");
        }, { timeout: 10_000 });
    });
});

test("a marker database pushed by the host is parsed and shown", opts, async () => {
    const lyrdb = fs.readFileSync(path.join(fixtures, "sample.lyrdb"), "utf8");
    await mounted(async (page) => {
        await page.evaluate((text) => window.viewer.setMarkers("sample.lyrdb", text), lyrdb);
        await page.waitForFunction(() => {
            const sr = document.querySelector("gds-lens").shadowRoot;
            return sr.textContent.includes("width_check");
        }, { timeout: 10_000 });
    });
});

test("goToPoint reports back whether the point was on screen", opts, async () => {
    await mounted(async (page) => {
        await page.evaluate(() => window.viewer.goToPoint(1, 1));
        await page.waitForFunction(
            () => window.__calls.some((c) => c.name === "onGotoResult"), { timeout: 10_000 });
        const result = await page.evaluate(
            () => window.__calls.find((c) => c.name === "onGotoResult").args);
        assert.equal(typeof result.ok, "boolean", "the host should be told whether it landed");
        assert.equal(result.x, 1);
        assert.equal(result.y, 1);

        // Also returned, so a caller driving the viewer directly does not have
        // to implement onGotoResult just to learn the answer.
        const returned = await page.evaluate(() => window.viewer.goToPoint(1, 1));
        assert.equal(returned, result.ok, "goToPoint should resolve to the same answer it reports");
    });
});

test("the debug panel toggles", opts, async () => {
    await mounted(async (page) => {
        const visible = () => page.evaluate(() =>
            getComputedStyle(document.querySelector("gds-lens").shadowRoot
                .getElementById("debugToggleBtn")).display !== "none");
        assert.equal(await visible(), false, "debug tools should start hidden");
        await page.evaluate(() => window.viewer.toggleDebug());
        assert.equal(await visible(), true, "toggleDebug should reveal them");
    });
});

// ---- The default host's own view storage ----
//
// Everything above replaces the default host; this pins down what the default
// host does, because on a page with several viewers it is the piece with a
// per-viewer answer to give. capture.js runs between the real host and the
// element, so the surfaces it records belong to the default host.
const CAPTURE_SCRIPT = `
window.__surfaces = [];
const host = window.gdsLensHost;
const connect = host.connect.bind(host);
host.connect = (viewer) => { window.__surfaces.push(viewer); connect(viewer); };
`;

// Two viewers, two ids, and no ?src= -- nothing here needs a layout drawn, only
// the host's bookkeeping.
const TWO_VIEWERS = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    </head><body>
    <gds-lens id="before" style="width:200px;height:150px"></gds-lens>
    <gds-lens id="after" style="width:200px;height:150px"></gds-lens>
    <script src="gds-lens-engine.js"></script>
    <script src="gds-lens-host.js"></script>
    <script src="capture.js"></script>
    <script src="gds-lens.js"></script>
    </body></html>`;

test("the default host keeps a set of views per viewer, not per page", opts, async () => {
    await withPayload(defaultVariant, async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/two.html`);
        await page.waitForFunction(() => window.__surfaces?.length === 2, { timeout: 30_000 });

        // Saved one after the other, which is what used to lose the first set:
        // both viewers wrote the whole list to one key.
        const stored = await page.evaluate(() => {
            const host = window.gdsLensHost;
            const [first, second] = window.__surfaces;
            host.saveViews([{ name: "Corner", camera: { zoom: 1, panX: 0, panY: 0 } }], first);
            host.saveViews([{ name: "Pad", camera: { zoom: 2, panX: 1, panY: 1 } },
                            { name: "Via", camera: { zoom: 3, panX: 2, panY: 2 } }], second);
            return Promise.all([host.loadViews(first), host.loadViews(second)]);
        });
        assert.deepEqual(stored.map((views) => views.map((v) => v.name)),
                         [["Corner"], ["Pad", "Via"]],
                         "one viewer's saved views overwrote the other's");

        // And they are keyed by the element, so they are still there after a
        // reload rather than only for the life of the page.
        await page.reload();
        await page.waitForFunction(() => window.__surfaces?.length === 2, { timeout: 30_000 });
        const afterReload = await page.evaluate(() => {
            const host = window.gdsLensHost;
            return Promise.all(window.__surfaces.map((viewer) => host.loadViews(viewer)));
        });
        assert.deepEqual(afterReload.map((views) => views.map((v) => v.name)),
                         [["Corner"], ["Pad", "Via"]],
                         "the views did not survive a reload");
    }, { "two.html": TWO_VIEWERS, "capture.js": { type: "text/javascript", body: CAPTURE_SCRIPT } });
});

test("a lone viewer with nothing to key on keeps the shared bucket", opts, async () => {
    const LONE = TWO_VIEWERS
        .replace(/<gds-lens id="before"[^>]*><\/gds-lens>\s*/, "")
        .replace('id="after"', "");
    await withPayload(defaultVariant, async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/one.html`);
        await page.waitForFunction(() => window.__surfaces?.length === 1, { timeout: 30_000 });
        // The key a single-viewer page has always used: views saved before any
        // of this existed have to still be there.
        const key = await page.evaluate(async () => {
            const host = window.gdsLensHost;
            host.saveViews([{ name: "Whole chip", camera: { zoom: 1, panX: 0, panY: 0 } }],
                           window.__surfaces[0]);
            return localStorage.getItem("gds-lens:named-views");
        });
        assert.match(key || "", /Whole chip/,
            "a single viewer with no id and no src should still use the shared key");
    }, { "one.html": LONE, "capture.js": { type: "text/javascript", body: CAPTURE_SCRIPT } });
});
