// Layout properties in a real browser: the card lists a few, cut to one line
// each, and never grows past its width; Details shows every one in full along
// with the cell and reference properties on the way to the shape; the
// hierarchy panel's buttons open the same dialog for a cell and the library.
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";

import { chromium, defaultVariant, withPayload } from "./payload.js";
import { library, structure, box, sref } from "./inspect-fixture.js";

const skip = !defaultVariant || !chromium
    ? "no built payload, or playwright's chromium is missing"
    : false;

const LONG = "x".repeat(400);
const fixture = library([
    structure("CHILD", [box(1, 0, 0, 0, 2, 1, [[1, "child shape"]])], [[5, "component=ring"]]),
    structure("TOP", [
        box(2, 0, 0, 0, 10, 10, [
            [1, "net=VDD"], [2, LONG], [3, "two\nlines"], [4, "four"], [5, "five"], [6, "six"], [7, "seven"]
        ]),
        sref("CHILD", 20, 0, { props: [[1, "instance=ring_a"]] }),
        sref("CHILD", 30, 0, { props: [[1, "instance=ring_b"]] })
    ], [[2, "design=demo"]])
], { name: "PROPDEMO", props: [[1, "pdk=demo 1.2"]] });

const ROUTES = { "props.gds": { type: "application/octet-stream", body: fixture } };

async function withViewer(fn) {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=props.gds`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        await fn(page);
        assert.deepEqual(pageErrors, [], "the page threw");
    }, ROUTES);
}

async function clickAt(page, x, y) {
    const [px, py] = await page.evaluate(async ([wx, wy]) => {
        const element = document.querySelector("gds-lens");
        const camera = await element.getCamera();
        const rect = element.shadowRoot.getElementById("glCanvas").getBoundingClientRect();
        return [rect.left + rect.width / 2 + (wx - camera.panX) * camera.zoom,
                rect.top + rect.height / 2 - (wy - camera.panY) * camera.zoom];
    }, [x, y]);
    await page.mouse.click(px, py);
}

// The dialog's sections as { heading: [text of each row or note] }.
const dialog = (page) => page.evaluate(() => {
    const root = document.querySelector("gds-lens").shadowRoot;
    if (root.getElementById("detailsOverlay").classList.contains("hidden")) return null;
    const out = { title: root.getElementById("detailsTitle").textContent };
    for (const section of root.querySelectorAll(".details-section")) {
        out[section.querySelector(".details-heading").textContent] =
            [...section.querySelectorAll("tr, .details-note, .details-subheading")]
                .map((el) => el.tagName === "TR"
                    ? `${el.querySelector("th").textContent}: ${el.querySelector("td").firstChild?.textContent ?? ""}`
                    : el.textContent);
    }
    return out;
});

const inViewer = (page, selector) => page.locator(`gds-lens ${selector}`);

test("the card crops properties and Details shows them whole", { skip }, async () => {
    await withViewer(async (page) => {
        // Inside TOP's box, away from CHILD.
        await clickAt(page, 5, 5);
        await page.waitForFunction(() => !document.querySelector("gds-lens").shadowRoot
            .getElementById("inspectProps").classList.contains("hidden"), { timeout: 30_000 });

        const shown = await page.evaluate(() => {
            const root = document.querySelector("gds-lens").shadowRoot;
            const props = root.getElementById("inspectProps");
            const cells = [...props.querySelectorAll("td")];
            return {
                heading: root.getElementById("inspectPropsHeading").textContent,
                rows: [...props.querySelectorAll("tr")].map((tr) => tr.textContent),
                cardWidth: root.getElementById("inspectCard").offsetWidth,
                longCut: cells[1].scrollWidth > cells[1].clientWidth
            };
        });
        assert.equal(shown.heading, "Properties (7)");
        assert.equal(shown.rows.length, 5, "four rows and the pointer to Details");
        assert.equal(shown.rows[4], "3 more in Details");
        assert.ok(shown.cardWidth <= 330, `the card grew to ${shown.cardWidth}px`);
        assert.ok(shown.longCut, "the 400-character value was not cut");

        await inViewer(page, "#inspectDetails").click();
        const details = await dialog(page);
        assert.equal(details.title, "Shape on 2/0");
        // The path ends in the cell, so there is no separate Cell row; the
        // path marks it instead.
        const owner = await page.evaluate(() => {
            const td = [...document.querySelector("gds-lens").shadowRoot.querySelectorAll(".details-table tr")]
                .find((tr) => tr.querySelector("th").textContent === "Path").querySelector("td");
            return { text: td.textContent, tag: td.querySelector(".owner-cell")?.textContent };
        });
        assert.deepEqual(owner, { text: "TOP", tag: "TOP" });
        assert.ok(!details.Shape.some((row) => row.startsWith("Cell:")), "Cell repeats the path");
        assert.deepEqual(details.Properties, [
            "1: net=VDD", `2: ${LONG}`, "3: two\nlines", "4: four", "5: five", "6: six", "7: seven"
        ]);
        assert.deepEqual(details["TOP (top)"], ["Cell", "2: design=demo"]);

        await page.keyboard.press("Escape");
        assert.equal(await dialog(page), null, "Escape did not close the dialog");
        // Only the dialog: the selection is still there.
        assert.ok(await inViewer(page, "#inspectCard").isVisible());
    });
});

test("Details names the instance a shape was placed through", { skip }, async () => {
    await withViewer(async (page) => {
        await clickAt(page, 31, 0.5);
        await inViewer(page, "#inspectDetails").waitFor({ state: "visible", timeout: 30_000 });
        await inViewer(page, "#inspectDetails").click();
        const details = await dialog(page);
        assert.deepEqual(details.Properties, ["1: child shape"]);
        assert.ok(details.Shape.includes("Path: TOP"), details.Shape.join(" | "));
        assert.deepEqual(details["CHILD (in TOP)"], [
            "Cell", "5: component=ring", "Reference #2 in TOP", "1: instance=ring_b"
        ]);
    });
});

test("the hierarchy panel opens cell and library details", { skip }, async () => {
    await withViewer(async (page) => {
        await inViewer(page, "#hierarchyShowBtn").click();
        await inViewer(page, "#hierarchyInfo").click();
        const lib = await dialog(page);
        assert.equal(lib.title, "Library PROPDEMO");
        assert.deepEqual(lib["Library properties"], ["1: pdk=demo 1.2"]);
        await inViewer(page, "#detailsClose").click();

        // TOP's row, then the CHILD row under it.
        const top = inViewer(page, "#hierarchyTree > .hier-row").first();
        // A single top cell starts open.
        if (await top.getAttribute("aria-expanded") === "false") await top.locator(".hier-twisty").click();
        const child = inViewer(page, "#hierarchyTree .hier-children .hier-row").first();
        await child.hover();
        await child.locator(".hier-info").click();
        const cell = await dialog(page);
        assert.equal(cell.title, "Cell CHILD");
        assert.deepEqual(cell["Cell properties"], ["5: component=ring"]);
        assert.deepEqual(cell["References in TOP"], [
            "1 placement", "1: instance=ring_a", "1 placement", "1: instance=ring_b"
        ]);
    });
});
