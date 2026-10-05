// Tests for the keyboard shortcuts: a host taking over the rebindable keys
// (shortcuts(), runAction), the keyboard context it is told about, and the
// Keyboard Shortcuts dialog. The default host, which implements none of
// this, keeps the viewer's own keys.
//
// Skipped unless a payload has been built (npm run build).

import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";

// A host that owns the keys, the way the VS Code extension does: it lists
// its own bindings, offers a Customize button and wants the keyboard context.
const HOST_SCRIPT = `
window.__calls = [];
window.__context = [];
window.gdsLensHost = {
    shortcuts: () => {
        window.__calls.push("shortcuts");
        return Promise.resolve([
            { label: "Toggle the hierarchy", keys: "Ctrl+K H" },
            { label: "Measure", keys: "M" }
        ]);
    },
    customizeShortcuts: () => window.__calls.push("customizeShortcuts"),
    setKeyboardContext: (active) => window.__context.push(active),
    connect: (viewer) => { window.viewer = viewer; }
};
`;

const opts = { skip: !defaultVariant || !chromium };

async function withViewer(fn, routes, url) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e)));
        await page.goto(`http://127.0.0.1:${port}/${url}`);
        await page.waitForFunction(() => !!(window.viewer || window.gdsLens), { timeout: 30_000 });
        if (routes) {
            await page.evaluate(async () => {
                const bytes = await (await fetch("sample_layout.gds")).arrayBuffer();
                window.viewer.load(new Uint8Array(bytes), { reload: false });
            });
        }
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        await fn(page);
        assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join("; ")}`);
    }, routes || {});
}

const withHostViewer = (fn) => withViewer(fn, { "gds-lens-host.js": HOST_SCRIPT }, "gds-lens.html");
const withDefaultViewer = (fn) => withViewer(fn, null, "gds-lens.html?src=sample_layout.gds");

const hierarchyOpen = (page) => page.evaluate(() =>
    !document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyPanel").classList.contains("hidden"));
const dialogOpen = (page) => page.evaluate(() =>
    !document.querySelector("gds-lens").shadowRoot.getElementById("shortcutsOverlay").classList.contains("hidden"));
// Each row of the dialog as [keys, label], keys as the <kbd>s' text joined.
const dialogRows = (page) => page.evaluate(() =>
    [...document.querySelector("gds-lens").shadowRoot.querySelectorAll("#shortcutsTable tr")]
        .map((tr) => [tr.cells[0].textContent, tr.cells[1].textContent]));

test("a host that lists shortcuts owns the keys, and runAction runs them", opts, async () => {
    await withHostViewer(async (page) => {
        await page.locator("gds-lens canvas").click();
        await page.keyboard.press("h");
        await page.waitForTimeout(100);
        assert.equal(await hierarchyOpen(page), false, "H was handled by the viewer, not left to the host");

        await page.evaluate(() => window.viewer.runAction("toggleHierarchy"));
        assert.equal(await hierarchyOpen(page), true, "runAction(\"toggleHierarchy\") did not open the tree");
        // Unknown actions are ignored.
        await page.evaluate(() => window.viewer.runAction("noSuchAction"));
    });
});

test("the dialog lists the host's rows, then the fixed ones", opts, async () => {
    await withHostViewer(async (page) => {
        await page.locator("gds-lens canvas").click();
        await page.evaluate(() => window.viewer.runAction("showShortcuts"));
        await page.waitForFunction(() =>
            document.querySelector("gds-lens").shadowRoot.querySelectorAll("#shortcutsTable tr").length > 7);
        const rows = await dialogRows(page);
        assert.deepEqual(rows.slice(0, 2), [["Ctrl+K H", "Toggle the hierarchy"], ["M", "Measure"]]);
        const keys = rows.slice(2).map(([k]) => k);
        assert.deepEqual(keys, ["Esc", "Up / Down", "Enter", "Alt", "Shift", "Drag", "Scroll"]);
        // The built-in H row is the host's to give, not the viewer's.
        assert.ok(!keys.includes("H"));
        const dialog = await page.evaluate(() => {
            const d = document.querySelector("gds-lens").shadowRoot.getElementById("shortcutsDialog");
            return {
                role: d.getAttribute("role"),
                modal: d.getAttribute("aria-modal"),
                title: d.getRootNode().getElementById(d.getAttribute("aria-labelledby")).textContent,
                focused: d.getRootNode().activeElement === d
            };
        });
        assert.deepEqual(dialog, { role: "dialog", modal: "true", title: "Keyboard Shortcuts", focused: true });

        // Customize hands off to the host and closes the dialog.
        await page.locator("gds-lens #shortcutsCustomize").click();
        assert.ok((await page.evaluate(() => window.__calls)).includes("customizeShortcuts"));
        assert.equal(await dialogOpen(page), false);

        // Asked again on every opening.
        await page.evaluate(() => window.viewer.runAction("showShortcuts"));
        await page.waitForFunction(() => window.__calls.filter((c) => c === "shortcuts").length === 2);
    });
});

test("Escape closes the dialog and leaves the rulers alone", opts, async () => {
    await withHostViewer(async (page) => {
        // A click on the canvas does not move focus (the renderer takes the
        // mousedown), so it is focused the way Tab would.
        await page.evaluate(() => document.querySelector("gds-lens").shadowRoot.getElementById("glCanvas").focus());
        await page.evaluate(() => window.viewer.addMeasurement(0, 0, 5, 5));
        await page.evaluate(() => window.viewer.runAction("showShortcuts"));
        assert.equal(await dialogOpen(page), true);
        await page.keyboard.press("Escape");
        assert.equal(await dialogOpen(page), false, "Escape did not close the dialog");
        assert.equal((await page.evaluate(() => window.viewer.getMeasurements())).length, 1,
            "the Escape that closed the dialog also cleared the rulers");
        // Focus went back to the canvas it was taken from.
        assert.equal(await page.evaluate(() =>
            document.querySelector("gds-lens").shadowRoot.activeElement?.id), "glCanvas");
    });
});

test("the keyboard context follows focus in and out of the find box", opts, async () => {
    await withHostViewer(async (page) => {
        const context = () => page.evaluate(() => window.__context.slice());
        assert.deepEqual(await context(), [true], "not reported once, as active, at mount");

        await page.evaluate(() => window.viewer.runAction("focusFind"));
        await page.waitForFunction(() => window.__context.at(-1) === false, undefined, { timeout: 5_000 });

        await page.evaluate(() => document.querySelector("gds-lens").shadowRoot.getElementById("glCanvas").focus());
        await page.waitForFunction(() => window.__context.at(-1) === true, undefined, { timeout: 5_000 });
        // Only changes are reported.
        assert.deepEqual(await context(), [true, false, true]);
    });
});

test("the default host keeps the viewer's own keys and lists them", opts, async () => {
    await withDefaultViewer(async (page) => {
        await page.locator("gds-lens canvas").click();
        await page.keyboard.press("h");
        await page.waitForFunction(() =>
            !document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyPanel").classList.contains("hidden"),
            { timeout: 5_000 });

        // The panel's button, inside the Display folder.
        await page.evaluate(() => {
            const root = document.querySelector("gds-lens").shadowRoot;
            const row = [...root.querySelectorAll(".lil-controller")]
                .find((r) => r.querySelector(".lil-name")?.textContent === "Keyboard Shortcuts");
            row.querySelector("button").click();
        });
        assert.equal(await dialogOpen(page), true);
        const keys = (await dialogRows(page)).map(([k]) => k);
        assert.deepEqual(keys.slice(0, 5), ["H", "/", "M", "[", "]"]);
        assert.ok(keys.includes("Esc"));
        // No customizeShortcuts on this host, so no button for it.
        assert.equal(await page.evaluate(() => document.querySelector("gds-lens").shadowRoot
            .getElementById("shortcutsFooter").classList.contains("hidden")), true);

        // A click on the backdrop closes it.
        await page.mouse.click(5, 5);
        assert.equal(await dialogOpen(page), false);
    });
});
