// Tests for choosing the top cell: the hierarchy's "Show as new top" button
// (⤒ on a row), the setTopCell/getTopCells surface, and how the choice behaves
// across a reload and in a comparison.
//
// test/fixtures/multi_top.gds has two top cells sharing one placed cell:
//   LEAF   a 2x2 µm box on 1/0
//   TOP_A  a 20x20 µm box on 2/0 at the origin, LEAF placed at (10, 10)
//   TOP_B  a 10x10 µm box on 3/0 at (100, 100), LEAF placed at (100, 100)
// so which layers are loaded says which cells are drawn.
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";

const skip = !defaultVariant || !chromium
    ? "no built payload, or playwright's chromium is missing"
    : false;

const waitForIdle = (page) => page.waitForFunction(
    () => document.querySelector("gds-lens")?.shadowRoot
        ?.getElementById("loadingOverlay")?.classList.contains("hidden") &&
        document.querySelector("gds-lens").shadowRoot
            .getElementById("reloadProgress")?.classList.contains("hidden"),
    { timeout: 60_000 });

async function withViewer(src, fn) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=${src}`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function",
                                   { timeout: 30_000 });
        await waitForIdle(page);
        await fn(page, port);
        assert.deepEqual(pageErrors, [], "the page threw");
    });
}

// The loaded layers as "layer/datatype", per slot, sorted.
const layerTags = (page, source = 0) => page.evaluate(async (wanted) => {
    const layers = await document.querySelector("gds-lens").getLayers();
    return layers.filter((l) => l.source === wanted).map((l) => `${l.layer}/${l.datatype}`).sort();
}, source);

const topCells = (page, slot = "a") =>
    page.evaluate((id) => document.querySelector("gds-lens").getTopCells(id), slot);

const crumb = (page) => page.evaluate(() => {
    const el = document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyCrumb");
    return el.classList.contains("hidden") ? null : el.textContent;
});

const treeRootNames = (page) => page.evaluate(() => {
    const tree = document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyTree");
    return [...tree.querySelectorAll(":scope > .hier-row .hier-name")].map((el) => el.textContent);
});

// Clicks the "Show as new top" button on the first row named `name`, among
// the root rows only when `rootOnly`, and on the row carrying slot chip
// `chip` ("A" / "B") when comparing. Then waits for the switch to land.
async function showAsTop(page, name, { rootOnly = false, chip = null, slot = "a" } = {}) {
    await page.evaluate(({ name: wanted, rootOnly: roots, chip: wantedChip }) => {
        const tree = document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyTree");
        const rows = [...tree.querySelectorAll(roots ? ":scope > .hier-row" : ".hier-row")];
        const row = rows.find((r) => r.querySelector(".hier-name").textContent === wanted &&
            (!wantedChip || r.querySelector(".slot-chip")?.textContent === wantedChip));
        const button = row.querySelector(".hier-open");
        button.click();
    }, { name, rootOnly, chip });
    await page.waitForFunction(async ({ wanted, id }) =>
        (await document.querySelector("gds-lens").getTopCells(id)).current === wanted,
        { wanted: name, id: slot });
    await waitForIdle(page);
}

const camera = (page) => page.evaluate(() => document.querySelector("gds-lens").getCamera());

test("a single top cell needs no way back", { skip }, async () => {
    await withViewer("sample_layout.gds", async (page) => {
        const info = await topCells(page);
        assert.deepStrictEqual(info, { cells: ["TOP"], current: null });
        assert.strictEqual(await crumb(page), null);
        // The only top cell is already drawn alone: its row has no button.
        const rootHasButton = await page.evaluate(() => {
            const tree = document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyTree");
            return !!tree.querySelector(":scope > .hier-row .hier-open");
        });
        assert.strictEqual(rootHasButton, false);
    });
});

test("a root row's button shows one of several top cells and frames it", { skip }, async () => {
    await withViewer("multi_top.gds", async (page) => {
        // The default is what was drawn before: every top cell, each a root row.
        assert.deepStrictEqual(await layerTags(page), ["1/0", "2/0", "3/0"]);
        const info = await topCells(page);
        assert.deepStrictEqual([...info.cells].sort(), ["TOP_A", "TOP_B"]);
        assert.strictEqual(info.current, null);
        assert.deepStrictEqual((await treeRootNames(page)).sort(), ["TOP_A", "TOP_B"]);
        // No dropdown in the panel: the hierarchy is the one way to pick.
        const dropdowns = await page.evaluate(() =>
            document.querySelector("gds-lens").shadowRoot.querySelectorAll(".lil-controller.lil-option").length);
        assert.strictEqual(dropdowns, 0);

        await page.keyboard.press("h");
        // The button's own hover text and accessible name, on the button
        // itself so the browser shows it rather than the row's tooltip.
        const button = await page.evaluate(() => {
            const tree = document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyTree");
            const b = tree.querySelector(":scope > .hier-row .hier-open");
            return { title: b.title, label: b.getAttribute("aria-label") };
        });
        assert.deepStrictEqual(button, { title: "Show as new top", label: "Show as new top" });
        // Hovering it shows that text: the button is the innermost element
        // with a title, and nothing hides it on hover.
        await page.locator("gds-lens #hierarchyTree > .hier-row").first().hover();
        const hovered = page.locator("gds-lens #hierarchyTree > .hier-row .hier-open").first();
        await hovered.hover();
        assert.strictEqual(await hovered.isVisible(), true);
        assert.strictEqual(await hovered.getAttribute("title"), "Show as new top");
        await showAsTop(page, "TOP_B", { rootOnly: true });

        assert.deepStrictEqual(await layerTags(page), ["1/0", "3/0"]);
        assert.deepStrictEqual(await treeRootNames(page), ["TOP_B"]);
        assert.match(await crumb(page), /Top: TOP_B/);
        // Framed on TOP_B, which spans (100, 100) to (110, 110).
        const view = await camera(page);
        assert.ok(Math.abs(view.panX - 105) < 0.5 && Math.abs(view.panY - 105) < 0.5,
                  `camera at (${view.panX}, ${view.panY})`);

        // Back through the line above the tree.
        await page.evaluate(() => document.querySelector("gds-lens").shadowRoot
            .querySelector("#hierarchyCrumb button").click());
        await page.waitForFunction(async () =>
            (await document.querySelector("gds-lens").getTopCells()).current === null);
        await waitForIdle(page);
        assert.deepStrictEqual(await layerTags(page), ["1/0", "2/0", "3/0"]);
        assert.strictEqual(await crumb(page), null);
    });
});

test("a placed cell's button shows it at its own origin, and Escape goes back", { skip }, async () => {
    await withViewer("multi_top.gds", async (page) => {
        await page.keyboard.press("h");
        // TOP_A's branch is open on first look, so LEAF's row is on screen.
        await showAsTop(page, "LEAF");

        assert.deepStrictEqual(await layerTags(page), ["1/0"]);
        assert.deepStrictEqual(await treeRootNames(page), ["LEAF"]);
        assert.match(await crumb(page), /Top: LEAF/);
        // At its own origin, not where either top cell places it.
        const view = await camera(page);
        assert.ok(Math.abs(view.panX - 1) < 0.1 && Math.abs(view.panY - 1) < 0.1,
                  `camera at (${view.panX}, ${view.panY})`);
        // The root row is the one drawn, so it has no button.
        const rootHasButton = await page.evaluate(() => {
            const tree = document.querySelector("gds-lens").shadowRoot.getElementById("hierarchyTree");
            return !!tree.querySelector(":scope > .hier-row .hier-open");
        });
        assert.strictEqual(rootHasButton, false);

        // A click on LEAF selects it, and the first Escape only clears that.
        await page.locator("gds-lens canvas").click();
        await page.waitForFunction(async () =>
            (await document.querySelector("gds-lens").getSelection())?.cell === "LEAF");
        await page.keyboard.press("Escape");
        await page.waitForFunction(async () =>
            (await document.querySelector("gds-lens").getSelection()) === null);
        assert.strictEqual((await topCells(page)).current, "LEAF");
        // Nothing selected, no rulers, already panning: Escape goes back.
        await page.keyboard.press("Escape");
        await page.waitForFunction(async () =>
            (await document.querySelector("gds-lens").getTopCells()).current === null);
        await waitForIdle(page);
        assert.deepStrictEqual(await layerTags(page), ["1/0", "2/0", "3/0"]);
        assert.strictEqual(await crumb(page), null);
    });
});

test("a reload keeps the chosen top cell, another file drops it", { skip }, async () => {
    await withViewer("multi_top.gds", async (page, port) => {
        await page.evaluate(() => document.querySelector("gds-lens").setTopCell("TOP_A"));
        await page.evaluate(async (url) => {
            const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
            await document.querySelector("gds-lens").load(bytes, { reload: true });
        }, `http://127.0.0.1:${port}/multi_top.gds`);
        await waitForIdle(page);
        assert.strictEqual((await topCells(page)).current, "TOP_A");
        assert.deepStrictEqual(await layerTags(page), ["1/0", "2/0"]);

        await page.evaluate((url) => document.querySelector("gds-lens").load(url),
                            `http://127.0.0.1:${port}/multi_top.gds`);
        await waitForIdle(page);
        assert.strictEqual((await topCells(page)).current, null);
        assert.deepStrictEqual(await layerTags(page), ["1/0", "2/0", "3/0"]);
    });
});

test("setTopCell rejects a name the layout does not have", { skip }, async () => {
    await withViewer("multi_top.gds", async (page) => {
        const message = await page.evaluate(() =>
            document.querySelector("gds-lens").setTopCell("NOPE").then(() => null, (err) => err.message));
        assert.match(message, /No cell named "NOPE"/);
        assert.deepStrictEqual(await layerTags(page), ["1/0", "2/0", "3/0"]);
    });
});

test("a row's button acts on its own layout when comparing", { skip }, async () => {
    await withViewer("multi_top.gds", async (page, port) => {
        await page.evaluate((url) => document.querySelector("gds-lens").load(url, { slot: "b", name: "b.gds" }),
                            `http://127.0.0.1:${port}/multi_top.gds`);
        await waitForIdle(page);
        await page.keyboard.press("h");

        // TOP_A as the second layout's root row, picked by its B chip.
        await showAsTop(page, "TOP_A", { rootOnly: true, chip: "B", slot: "b" });
        assert.deepStrictEqual(await layerTags(page, 0), ["1/0", "2/0", "3/0"]);
        assert.deepStrictEqual(await layerTags(page, 1), ["1/0", "2/0"]);
        assert.strictEqual((await topCells(page, "a")).current, null);
        assert.strictEqual((await topCells(page, "b")).current, "TOP_A");
        assert.match(await crumb(page), /Top: TOP_A/);

        // The first layout's choice is its own, through the API this time.
        await page.evaluate(() => document.querySelector("gds-lens").setTopCell("TOP_B", "a"));
        assert.deepStrictEqual(await layerTags(page, 0), ["1/0", "3/0"]);
        assert.strictEqual((await topCells(page, "b")).current, "TOP_A");

        // Dropping the second layout drops its choice with it.
        await page.evaluate(() => document.querySelector("gds-lens").unload("b"));
        assert.deepStrictEqual(await topCells(page, "b"), { cells: [], current: null });
        assert.match(await crumb(page), /Top: TOP_B/);
        assert.doesNotMatch(await crumb(page), /TOP_A/);
    });
});
