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

// Substituting host.js is the whole setup: the payload's own default host
// never runs, so nothing else has to be stubbed.
async function mounted(fn) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e)));
        await page.goto(`http://127.0.0.1:${port}/viewer.html`);
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
    }, { "host.js": HOST_SCRIPT });
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
