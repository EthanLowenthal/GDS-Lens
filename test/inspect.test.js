// Click to inspect in a real browser: a click in Pan mode selects the nearest
// shape under it and shows the card, clicking again steps down, Escape and
// empty space clear, a drag selects nothing, and the card's buttons work.
//
// The fixture is written by inspect-fixture.js, which lists its geometry.
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";
import { inspectFixture } from "./inspect-fixture.js";

const skip = !defaultVariant || !chromium
    ? "no built payload, or playwright's chromium is missing"
    : false;

const ROUTES = { "inspect.gds": { type: "application/octet-stream", body: inspectFixture() } };

const waitForIdle = (page) => page.waitForFunction(
    () => document.querySelector("gds-lens")?.shadowRoot
        ?.getElementById("loadingOverlay")?.classList.contains("hidden") &&
        document.querySelector("gds-lens").shadowRoot
            .getElementById("reloadProgress")?.classList.contains("hidden"),
    { timeout: 60_000 });

async function withViewer(fn) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=inspect.gds`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });
        await waitForIdle(page);
        // Every gds-select, so a test can check what was announced.
        await page.evaluate(() => {
            window.selectEvents = [];
            document.querySelector("gds-lens").addEventListener("gds-select", (event) => {
                window.selectEvents.push(event.detail && `${event.detail.layer}/${event.detail.datatype}`);
            });
        });
        await fn(page, port);
        assert.deepEqual(pageErrors, [], "the page threw");
    }, ROUTES);
}

// The page coordinates of a world point, through the viewer's own camera.
const toPage = (page, x, y) => page.evaluate(async ([wx, wy]) => {
    const element = document.querySelector("gds-lens");
    const camera = await element.getCamera();
    const rect = element.shadowRoot.getElementById("glCanvas").getBoundingClientRect();
    return [rect.left + rect.width / 2 + (wx - camera.panX) * camera.zoom,
            rect.top + rect.height / 2 - (wy - camera.panY) * camera.zoom];
}, [x, y]);

async function clickAt(page, x, y) {
    const [px, py] = await toPage(page, x, y);
    await page.mouse.click(px, py);
}

// The card as text, row by row, or null while it is hidden.
const card = (page) => page.evaluate(() => {
    const root = document.querySelector("gds-lens").shadowRoot;
    const el = root.getElementById("inspectCard");
    if (el.classList.contains("hidden")) return null;
    const rows = {};
    for (const tr of root.querySelectorAll("#inspectTable tr")) {
        rows[tr.querySelector("th").textContent] = tr.querySelector("td").textContent;
    }
    return { title: root.getElementById("inspectTitle").textContent, rows,
             status: root.getElementById("inspectStatus").textContent };
});

const waitForCard = (page, title, area) => page.waitForFunction(([wantedTitle, wantedArea]) => {
    const root = document.querySelector("gds-lens").shadowRoot;
    if (root.getElementById("inspectCard").classList.contains("hidden")) return false;
    if (root.getElementById("inspectTitle").textContent !== wantedTitle) return false;
    const row = [...root.querySelectorAll("#inspectTable tr")]
        .find((tr) => tr.querySelector("th").textContent === "Area");
    return !wantedArea || (row && row.querySelector("td").textContent === wantedArea);
}, [title, area], { timeout: 30_000 });

const waitForNoCard = (page) => page.waitForFunction(() => document.querySelector("gds-lens").shadowRoot
    .getElementById("inspectCard").classList.contains("hidden"), null, { timeout: 30_000 });

const selected = (page) => page.evaluate(async () => {
    const info = await document.querySelector("gds-lens").getSelection();
    return info && { layer: `${info.layer}/${info.datatype}`, cell: info.cell, path: info.pathText,
                     area: info.area, slot: info.slot, index: info.index, count: info.count };
});

test("a click selects the nearest shape and describes it", { skip }, async () => {
    await withViewer(async (page) => {
        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0", "36 µm²");
        const shown = await card(page);
        assert.deepStrictEqual(shown.rows, {
            Cell: "TOP",
            Path: "TOP",
            "Bounding box": "(12, 12)–(18, 18) µm",
            Size: "6 × 6 µm",
            Area: "36 µm²",
            Perimeter: "24 µm",
            Vertices: "4"
        });
        assert.match(shown.status, /Shape 1 of 3 here/);
        assert.deepStrictEqual(await selected(page),
            { layer: "4/0", cell: "TOP", path: "TOP", area: 36, slot: "a", index: 0, count: 3 });
        assert.deepStrictEqual(await page.evaluate(() => window.selectEvents), ["4/0"]);

        // A placed copy reports its path and which copy of the array it is.
        await clickAt(page, 21, 105.5);
        await waitForCard(page, "1/0", "2 µm²");
        const ring = await card(page);
        assert.strictEqual(ring.rows.Cell, "RING");
        assert.strictEqual(ring.rows.Path, "TOP > ARR > RING [2,1]");
        assert.strictEqual(ring.rows["Bounding box"], "(20, 105)–(22, 106) µm");
        // One layout loaded: no Layout row.
        assert.strictEqual(ring.rows.Layout, undefined);
    });
});

test("clicking the same spot again steps down through the shapes there", { skip }, async () => {
    await withViewer(async (page) => {
        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0", "36 µm²");
        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0", "100 µm²");
        await clickAt(page, 15, 15);
        await waitForCard(page, "3/0", "2500 µm²");
        assert.match((await card(page)).status, /Shape 3 of 3/);
        // And round again.
        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0", "36 µm²");
        // Somewhere else starts from the top there: the magnified copy of RING,
        // the third of TOP's three references to it.
        await clickAt(page, 62, 61);
        await waitForCard(page, "1/0", "8 µm²");
        assert.strictEqual((await card(page)).rows.Path, "TOP > RING #3");
    });
});

test("Escape, empty space and the close button clear the selection", { skip }, async () => {
    await withViewer(async (page) => {
        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0");
        await page.keyboard.press("Escape");
        await waitForNoCard(page);
        assert.strictEqual(await selected(page), null);

        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0");
        await clickAt(page, 60, 20);  // nothing there
        await waitForNoCard(page);

        await clickAt(page, 75, 0);
        await waitForCard(page, "5/0", "10 µm²");
        await page.locator("gds-lens #inspectClose").click();
        await waitForNoCard(page);
        assert.deepStrictEqual(await page.evaluate(() => window.selectEvents),
            ["4/0", null, "4/0", null, "5/0", null]);
    });
});

test("a drag pans and selects nothing", { skip }, async () => {
    await withViewer(async (page) => {
        const before = await page.evaluate(() => document.querySelector("gds-lens").getCamera());
        const [px, py] = await toPage(page, 15, 15);
        await page.mouse.move(px, py);
        await page.mouse.down();
        await page.mouse.move(px + 40, py + 10, { steps: 4 });
        await page.mouse.up();
        const after = await page.evaluate(() => document.querySelector("gds-lens").getCamera());
        assert.notStrictEqual(after.panX, before.panX, "the drag did not pan");
        // Give a selection the chance to land, if one had been started.
        await page.waitForTimeout(300);
        assert.strictEqual(await card(page), null);
        assert.strictEqual(await selected(page), null);
    });
});

test("a hidden layer is passed over", { skip }, async () => {
    await withViewer(async (page) => {
        await page.evaluate(() => document.querySelector("gds-lens").setLayerVisible(4, 0, false));
        await clickAt(page, 15, 15);
        await waitForCard(page, "3/0", "2500 µm²");
        assert.strictEqual((await selected(page)).count, 1);
    });
});

test("Measure mode places rulers and selects nothing", { skip }, async () => {
    await withViewer(async (page) => {
        await page.keyboard.press("m");
        await clickAt(page, 15, 15);
        await clickAt(page, 30, 15);
        await page.waitForTimeout(300);
        assert.strictEqual(await card(page), null);
        const rulers = await page.evaluate(() => document.querySelector("gds-lens").getMeasurements());
        assert.strictEqual(rulers.length, 1);
    });
});

test("the card's buttons frame, copy, and show the cell as the top", { skip }, async () => {
    await withViewer(async (page) => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await clickAt(page, 21, 105.5);
        await waitForCard(page, "1/0", "2 µm²");

        await page.locator("gds-lens #inspectCopy").click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.strictEqual(copied, [
            "Layer: 1/0",
            "Cell: RING",
            "Path: TOP > ARR > RING [2,1]",
            "Bounding box: (20, 105)–(22, 106) µm",
            "Size: 2 × 1 µm",
            "Area: 2 µm²",
            "Perimeter: 6 µm",
            "Vertices: 4"
        ].join("\n"));

        await page.locator("gds-lens #inspectFrame").click();
        await page.waitForFunction(async () => {
            const camera = await document.querySelector("gds-lens").getCamera();
            return Math.abs(camera.panX - 21) < 0.01 && Math.abs(camera.panY - 105.5) < 0.01;
        });

        await page.locator("gds-lens #inspectTop").click();
        await page.waitForFunction(async () =>
            (await document.querySelector("gds-lens").getTopCells()).current === "RING");
        await waitForIdle(page);
        // The layout it was selected in was replaced, so the selection went with it.
        assert.strictEqual(await card(page), null);
        // RING drawn alone at its own origin: a click there finds it as the top.
        await clickAt(page, 1, 0.5);
        await waitForCard(page, "1/0", "2 µm²");
        assert.strictEqual((await card(page)).rows.Path, "RING");
        assert.strictEqual(await page.evaluate(() => document.querySelector("gds-lens")
            .shadowRoot.getElementById("inspectTop").disabled), true);
    });
});

test("selectAt picks from code, and steps with an index", { skip }, async () => {
    await withViewer(async (page) => {
        const picks = await page.evaluate(async () => {
            const element = document.querySelector("gds-lens");
            const first = await element.selectAt(15, 15);
            const third = await element.selectAt(15, 15, 2);
            const none = await element.selectAt(60, 20);
            return [first.area, third.area, none, await element.getSelection()];
        });
        assert.deepStrictEqual(picks, [36, 2500, null, null]);
    });
});

test("comparing, the card says which layout the shape is from", { skip }, async () => {
    await withViewer(async (page) => {
        await page.evaluate(() => document.querySelector("gds-lens").load("inspect.gds", { slot: "b" }));
        await waitForIdle(page);
        // Both layouts have the same three shapes here, so each pair ties on
        // edge distance and area, and the second layout's layers, drawn after
        // the first's, come first within a pair.
        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0", "36 µm²");
        const first = await card(page);
        assert.match(first.rows.Layout, /^B/);
        assert.match(first.status, /Shape 1 of 6/);
        const stack = await page.evaluate(async () => {
            const element = document.querySelector("gds-lens");
            const out = [];
            for (let i = 0; i < 6; i++) {
                const info = await element.selectAt(15, 15, i);
                out.push(`${info.slot} ${info.layer}/${info.datatype} ${info.area}`);
            }
            return out;
        });
        assert.deepStrictEqual(stack.map((entry) => entry[0]), ["b", "a", "b", "a", "b", "a"]);
        for (let i = 0; i < 6; i += 2) assert.strictEqual(stack[i].slice(2), stack[i + 1].slice(2));
        await waitForCard(page, stack[5].split(" ")[1]);
        assert.match((await card(page)).rows.Layout, /^A/);

        // Unloading the layout the selection came from clears it.
        await clickAt(page, 15, 15);
        await waitForCard(page, "4/0", "36 µm²");
        assert.strictEqual((await selected(page)).slot, "b");
        await page.evaluate(() => document.querySelector("gds-lens").unload("b"));
        await waitForNoCard(page);
    });
});
