// Tests for the viewer's behaviour as a *component in someone else's page*,
// and for the control surface it builds.
//
// These are the cases unit tests structurally cannot reach: whether the
// component leaves the host page's globals alone, whether it keeps its
// listeners inside its own element, whether an untrusted error message stays
// text, and whether the panels it generates are operable. All of them need a
// real DOM, a real shadow root and a real load, so they run against a built
// payload in headless Chromium (see test/payload.js).
//
// Skipped for payloads that have not been built (npm run build).
import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";

import { chromium, defaultVariant, withPayload } from "./payload.js";

const skip = !defaultVariant || !chromium
    ? "no built payload, or playwright's chromium is missing"
    : false;

// Every test here needs a loaded design before it means anything: the panels
// are built from the parse result, and the host is only connected once.
async function withLoadedViewer(fn, routes = {}, page_ = "gds-lens.html") {
    await withPayload(defaultVariant, async (page, port) => {
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        const consoleLogs = [];
        page.on("console", (message) => {
            if (message.type() === "log") consoleLogs.push(message.text());
        });

        await page.goto(`http://127.0.0.1:${port}/${page_}?src=sample_layout.gds`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function",
                                   { timeout: 30_000 });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        await fn(page, { pageErrors, consoleLogs });

        // A thrown error in a handler would otherwise leave a test green while
        // the thing it exercised half-failed.
        assert.deepEqual(pageErrors, [], "the page threw");
    }, routes);
}

// ---- The host page's globals are not ours ----

test("the host page's console is left alone", { skip }, async () => {
    await withLoadedViewer(async (page, { consoleLogs }) => {
        // The viewer used to assign window.console.log/error to feed its
        // on-screen debug panel, which meant the host application's own
        // logging appended to a <div> inside our shadow root for the life of
        // the page -- and kept doing it after the element was removed.
        assert.ok(await page.evaluate(() => String(console.log).includes("native code")),
                  "console.log was replaced");
        assert.ok(await page.evaluate(() => String(console.error).includes("native code")),
                  "console.error was replaced");

        // ...and the corollary: the host's own logging must not reach our panel.
        const leaked = await page.evaluate(async () => {
            const log = document.querySelector("gds-lens").shadowRoot.getElementById("debugLog");
            const before = log.childElementCount;
            for (let i = 0; i < 5; i++) console.log("host application line " + i);
            await new Promise((r) => setTimeout(r, 100));
            return log.childElementCount - before;
        });
        assert.equal(leaked, 0, "host console output landed in the viewer's debug panel");

        // The breadcrumbs are opt-in, so a successful load says nothing.
        assert.deepEqual(consoleLogs.filter((line) => line.includes("[GDS]")), [],
                         "trace output reached the console without being asked for");
    });
});

test("?gdsDebug=1 puts the breadcrumbs back", { skip }, async () => {
    await withPayload(defaultVariant, async (page, port) => {
        const logs = [];
        page.on("console", (m) => { if (m.type() === "log") logs.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?gdsDebug=1&src=sample_layout.gds`);
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function",
                                   { timeout: 30_000 });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        assert.ok(logs.filter((line) => line.includes("[GDS]")).length > 5,
                  `expected trace output, got ${logs.length} console lines`);
    });
});

test("the debug panel drops old lines instead of growing forever", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        const counts = await page.evaluate(async () => {
            const log = document.querySelector("gds-lens").shadowRoot.getElementById("debugLog");
            const before = log.childElementCount;
            // Each showError writes exactly one line, so this overruns the cap
            // several times over.
            for (let i = 0; i < 700; i++) window.gdsLens.showError("flood " + i);
            await new Promise((r) => setTimeout(r, 400));
            return { before, after: log.childElementCount };
        });
        assert.ok(counts.before > 0, "the panel captured nothing at all");
        // MAX_DEBUG_LINES in viewer.js.
        assert.equal(counts.after, 500, "the panel is not being trimmed to its cap");
    });
});

test("drag-and-drop is bound to the element, not to the page", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        // The default host used to preventDefault every dragover on `window`,
        // which silently disabled the embedding application's own drop targets.
        const outside = await page.evaluate(() => {
            const target = document.body.appendChild(document.createElement("div"));
            const event = new Event("dragover", { bubbles: true, cancelable: true });
            target.dispatchEvent(event);
            return event.defaultPrevented;
        });
        assert.equal(outside, false, "a dragover elsewhere in the page was swallowed");

        // ...while the element's own drop target still works.
        const inside = await page.evaluate(() => {
            const event = new Event("dragover", { bubbles: true, cancelable: true });
            document.querySelector("gds-lens").dispatchEvent(event);
            return event.defaultPrevented;
        });
        assert.equal(inside, true, "the viewer stopped accepting drops");
    });
});

// ---- An error message is text, never markup ----

// gds-lens.html's own CSP (script-src 'self', no 'unsafe-inline') blocks an
// injected inline handler, which masks the bug this guards against. An
// embedder's page usually has a laxer policy, so the test serves one: same
// payload, permissive CSP. Without this the assertions below pass either way.
function permissiveEmbedderPage() {
    const html = fs.readFileSync(path.join(defaultVariant.dir, "gds-lens.html"), "utf8");
    const relaxed = html.replace(
        /<meta http-equiv="Content-Security-Policy"[\s\S]*?>/,
        '<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: '
        + "'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'\">");
    assert.ok(!relaxed.includes("script-src 'self'"), "the CSP was not actually relaxed");
    return relaxed;
}

test("an error message is rendered as text, not as markup", { skip }, async () => {
    // A load failure's message can carry a filename, a gdstk string, or -- via
    // the default host's ?src= handling -- text straight from the URL. It used
    // to be concatenated into innerHTML, so a crafted link could inject.
    const attacks = [
        '<img src=x onerror="window.__injected = true">',
        "<script>window.__injected = true</script>",
        '</b><svg onload="window.__injected = true">',
    ];

    await withLoadedViewer(async (page) => {
        for (const attack of attacks) {
            const result = await page.evaluate(async (message) => {
                window.__injected = false;
                await window.gdsLens.showError(message);
                await new Promise((r) => setTimeout(r, 300));
                const ui = document.querySelector("gds-lens").shadowRoot.getElementById("ui");
                return {
                    injected: window.__injected,
                    // <b> and <br> are the static chrome set_labelled_text builds.
                    unexpected: Array.from(ui.querySelectorAll("*"))
                        .map((el) => el.tagName)
                        .filter((tag) => tag !== "B" && tag !== "BR"),
                    text: ui.innerText,
                };
            }, attack);

            assert.equal(result.injected, false, `${attack} executed`);
            assert.deepEqual(result.unexpected, [], `${attack} produced elements`);
            // The point is not merely that it did not run: it has to still be
            // readable, since it is the explanation of a failed load.
            assert.ok(result.text.includes(attack),
                      `the message was mangled instead of shown: ${result.text}`);
        }
    }, { "embedder.html": { type: "text/html", body: permissiveEmbedderPage() } }, "embedder.html");
});

// ---- The generated panels are operable ----

test("the hierarchy panel and its find box are keyboard-operable", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        const state = await page.evaluate(async () => {
            const sr = document.querySelector("gds-lens").shadowRoot;
            const el = (id) => sr.getElementById(id);
            const settle = () => new Promise((r) => setTimeout(r, 250));
            const out = {};

            // Controls that were <span>s with click handlers: not focusable and
            // not operable without a pointer.
            out.tags = {
                dismiss: el("staleDismiss").tagName,
                hide: el("hierarchyHide").tagName,
                find: el("hierarchyFindToggle").tagName,
            };
            out.canvasTabIndex = el("glCanvas").tabIndex;
            out.canvasLabelled = !!el("glCanvas").getAttribute("aria-label");
            out.loadErrorRole = el("loadError").getAttribute("role");

            el("hierarchyShowBtn").click();
            await settle();
            out.opened = !el("hierarchyPanel").classList.contains("hidden");
            out.showExpanded = el("hierarchyShowBtn").getAttribute("aria-expanded");

            // Roles on rows the viewer generated, not on static markup.
            const rows = sr.querySelectorAll('#hierarchyTree [role="treeitem"]');
            out.treeItems = rows.length;
            out.firstLevel = rows[0] && rows[0].getAttribute("aria-level");
            out.expandableRowHasState = Array.from(rows)
                .some((row) => row.getAttribute("aria-expanded") !== null);

            el("hierarchyFindToggle").click();
            await settle();
            out.findOpened = !el("hierarchySearch").classList.contains("hidden");
            out.findExpanded = el("hierarchyFindToggle").getAttribute("aria-expanded");
            out.scopePressed = [el("hierarchyScopeCells").getAttribute("aria-pressed"),
                                el("hierarchyScopeLabels").getAttribute("aria-pressed")];

            // The dismiss control still does its job as a button.
            el("hierarchyHide").click();
            await settle();
            out.closedByDismiss = el("hierarchyPanel").classList.contains("hidden");
            out.hideExpanded = el("hierarchyHide").getAttribute("aria-expanded");
            return out;
        });

        assert.deepEqual(state.tags, { dismiss: "BUTTON", hide: "BUTTON", find: "BUTTON" });
        assert.equal(state.canvasTabIndex, 0, "the canvas cannot be focused");
        assert.ok(state.canvasLabelled, "the canvas has no accessible name");
        assert.equal(state.loadErrorRole, "alert");

        assert.ok(state.opened, "the hierarchy panel did not open");
        assert.equal(state.showExpanded, "true");
        // fixtures/sample_layout.gds is TOP with a CHILD placed 8 times.
        assert.equal(state.treeItems, 2, "the tree rows were not built");
        assert.equal(state.firstLevel, "1");
        assert.ok(state.expandableRowHasState, "no row reports whether it is expanded");

        assert.ok(state.findOpened, "the find box did not open");
        assert.equal(state.findExpanded, "true");
        assert.deepEqual(state.scopePressed, ["true", "false"]);

        assert.ok(state.closedByDismiss, "the dismiss button stopped closing the panel");
        assert.equal(state.hideExpanded, "false");
    });
});

// ---- The canvas right-click menu survives the click that operates it ----

test("the canvas menu copies the coordinate it is showing", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        // The menu is dismissed by a window-level pointerdown in the capture
        // phase, which used to ask whether the menu contained event.target.
        // Outside the shadow root that target is the <gds-lens> host, never the
        // menu -- so the press landing on "Copy coordinate" hid the menu
        // (display: none) before it could become a click, and nothing was ever
        // copied. Driving it with real mouse events is the point: a synthetic
        // click() on the button skips the pointerdown that broke it.
        const canvas = page.locator("#glCanvas");
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down({ button: "right" });
        await page.mouse.up({ button: "right" });

        const menu = page.locator("#canvasMenu");
        assert.ok(await menu.isVisible(), "right-click did not open the menu");
        const shown = (await page.locator("#canvasMenu .menu-value").textContent()).trim();
        assert.match(shown, /-?\d/, "the menu is offering no coordinate");

        // A short timeout, because the regression this guards makes the item
        // vanish mid-click: without it the click would sit out playwright's full
        // default wait before failing.
        await page.locator("#canvasMenuCopy").click({ timeout: 5000 });

        // The toast is written by the click handler on both the clipboard's
        // success and its failure path, so this says the click was delivered
        // without depending on clipboard permissions in headless Chromium.
        const toast = page.locator("#copyToast");
        await toast.waitFor({ state: "visible", timeout: 2000 });
        assert.ok((await toast.textContent()).includes(shown),
                  "the toast did not carry the coordinate that was clicked");
        assert.ok(!(await menu.isVisible()), "the menu stayed open after copying");
    });
});

// ---- A reload leaves the GL state a frame can be drawn from ----

test("a reload draws a clean frame, background grid included", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        // The grid is one attribute-less fullscreen triangle (see draw_grid),
        // drawn first in the frame from a VAO the layer draws left their own
        // a_position array enabled on. uploadLayers deletes those buffers, and
        // deleting a buffer clears it out of the bound VAO's attribute
        // bindings -- so on the first frame after a reload that draw used to
        // hit an enabled array with nothing behind it, which WebGL rejects
        // with INVALID_OPERATION and skips. The layers still drew (they rebind
        // and re-point every frame); only the grid went missing, and it stayed
        // missing until something else asked for a frame.
        //
        // getContext returns the viewer's own context rather than a second
        // one, so this reads the errors its draws actually raised.
        const glError = () => page.evaluate(() => {
            const canvas = document.querySelector("gds-lens").shadowRoot
                .getElementById("glCanvas");
            return canvas.getContext("webgl2").getError();
        });

        // Also clears the error flag, so what is read after the reload is the
        // reload's doing and not something left over from the first load.
        assert.equal(await glError(), 0, "the first load raised a GL error");

        await page.evaluate(async () => {
            const bytes = await (await fetch("sample_layout.gds")).arrayBuffer();
            await window.gdsLens.load(bytes, { reload: true });
        });
        // The reload's own frame has to have been drawn before the error flag
        // says anything about it.
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        await page.evaluate(() => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));

        assert.equal(await glError(), 0, "the frame after a reload raised a GL error");
    });
});

// ---- Marker-file warnings say what they are ----

// ---- Touch ----

test("one finger pans the layout and two pinch it", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        // Synthetic TouchEvents rather than an emulated touchscreen: the
        // gestures are ordinary listeners on the element (see the touch block
        // in viewer.js), and constructing the events is what lets a test spell
        // out the touch lists and the identifiers in them. `composed` is not
        // optional -- without it the event never leaves the shadow root, which
        // is exactly where the listeners are not.
        //
        // Worth guarding at all because the gestures used to live in
        // renderer.cpp behind emscripten_set_touchstart_callback, where they
        // worked in every browser that could be driven from a test and in none
        // that anyone holds: on iOS Safari that callback never runs.
        await page.evaluate(() => {
            const root = document.querySelector("gds-lens").shadowRoot;
            window.canvas = root.getElementById("glCanvas");
            window.readout = root.getElementById("coordReadout");
            // The world coordinate under a canvas pixel, which is the only
            // read on the camera this side has: the renderer writes it on
            // every mousemove.
            window.worldAt = (x, y) => {
                const box = window.canvas.getBoundingClientRect();
                window.canvas.dispatchEvent(new MouseEvent("mousemove", {
                    bubbles: true, composed: true,
                    clientX: box.left + x, clientY: box.top + y
                }));
                const [, wx, wy] = window.readout.textContent.match(/X:\s*(-?[\d.]+)\s+Y:\s*(-?[\d.]+)/);
                return { x: parseFloat(wx), y: parseFloat(wy) };
            };
            window.touch = (type, points, changed = points) => {
                const box = window.canvas.getBoundingClientRect();
                const make = ([id, x, y]) => new Touch({
                    identifier: id, target: window.canvas,
                    clientX: box.left + x, clientY: box.top + y
                });
                const touches = points.map(make);
                window.canvas.dispatchEvent(new TouchEvent(type, {
                    bubbles: true, cancelable: true, composed: true,
                    touches, targetTouches: touches, changedTouches: changed.map(make)
                }));
            };
        });

        // µm per 100 canvas px, i.e. 100/zoom, read off two points.
        const scale = () => page.evaluate(() => window.worldAt(300, 200).x - window.worldAt(200, 200).x);

        const perPx = (await scale()) / 100;
        const panned = await page.evaluate(() => {
            const before = window.worldAt(200, 200);
            window.touch("touchstart", [[1, 150, 200]]);
            for (let i = 1; i <= 4; i++) window.touch("touchmove", [[1, 150 + i * 50, 200]]);
            window.touch("touchend", [], [[1, 350, 200]]);
            return { before, after: window.worldAt(200, 200) };
        });
        // A finger dragged 200 px to the right brings the layout with it, so
        // the world under a fixed pixel moves 200 px worth of µm to the left.
        // The tolerance is set by the readout, not by the arithmetic: it is
        // rounded for reading, so two of them subtracted carry its granularity.
        const expected = 200 * perPx;
        assert.ok(Math.abs((panned.after.x - panned.before.x) + expected) < 0.25 + expected * 0.1,
                  `one finger did not pan: ${panned.before.x} -> ${panned.after.x} µm, ` +
                  `expected a move of ${-expected.toFixed(2)}`);

        // Fingers 200 px apart pulled to 400 px apart double the zoom, and the
        // point under the midpoint they share stays where it is.
        const before = await scale();
        const mid = await page.evaluate(() => window.worldAt(250, 200));
        await page.evaluate(() => {
            window.touch("touchstart", [[1, 150, 200], [2, 350, 200]]);
            for (let i = 1; i <= 4; i++) {
                const half = 100 + i * 25;
                window.touch("touchmove", [[1, 250 - half, 200], [2, 250 + half, 200]]);
            }
            window.touch("touchend", [], [[1, 50, 200], [2, 450, 200]]);
        });
        const after = await scale();
        const midAfter = await page.evaluate(() => window.worldAt(250, 200));
        assert.ok(Math.abs(after - before / 2) < before * 0.05,
                  `pinch did not double the zoom: ${before} -> ${after} µm per 100 px`);
        const slack = 0.25 + Math.abs(after) * 0.05;
        assert.ok(Math.abs(midAfter.x - mid.x) < slack && Math.abs(midAfter.y - mid.y) < slack,
                  `pinch did not hold its midpoint: ${JSON.stringify(mid)} -> ${JSON.stringify(midAfter)}`);
    });
});

test("the marker browser spells out its warnings, not just a count", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        // The warnings used to be a single inert row reading "⚠ 2 warnings",
        // with the text itself only in a hover title and a console line that is
        // off unless ?gdsDebug=1 -- so the one thing the row existed to say (a
        // marker may be in the wrong place; a value was not drawn) was the one
        // thing it did not say. fixtures/sample.lyrdb raises exactly two.
        await page.evaluate(async () => {
            const text = await (await fetch("sample.lyrdb")).text();
            await window.gdsLens.setMarkers("sample.lyrdb", text);
        });

        const folder = page.locator(".lil-gui .lil-title", { hasText: "warning" });
        await folder.waitFor({ timeout: 10_000 });
        assert.match((await folder.textContent()).trim(), /^⚠ 2 warnings$/);

        // Closed to start with: the file parsed, and the panel's first job is
        // the violations. Opening it is what produces the sentences.
        await folder.click();
        const rows = page.locator(".lil-gui .marker-warning-row");
        assert.equal(await rows.count(), 2, "the folder is not listing one row per warning");
        const texts = (await rows.allTextContents()).map((t) => t.trim());
        assert.ok(texts.some((t) => /non-top cells/.test(t)), `no non-top-cell warning in ${texts}`);
        assert.ok(texts.some((t) => /unsupported type/.test(t)), `no unsupported-type warning in ${texts}`);

        // A warning is a sentence: it has to wrap rather than be clipped to
        // lil-gui's one-line row, or the panel is back to saying nothing.
        const clipped = await page.evaluate(() => [...document.querySelector("gds-lens").shadowRoot
            .querySelectorAll(".marker-warning-row .lil-name")]
            .filter((el) => el.scrollHeight > el.clientHeight + 1).length);
        assert.equal(clipped, 0, "a warning row is clipping its text");
    });
});

test("[ / ] step within the selected marker's category even when it is hidden", { skip }, async () => {
    await withLoadedViewer(async (page) => {
        // Categories start hidden and their item rows stay clickable, so
        // selecting a marker in a hidden category is the ordinary way in.
        // stepMarker used to build its candidate list from visible categories
        // only: the selection was absent from that list, findIndex returned
        // -1, and [ / ] restarted at the first item of whichever *other*
        // category happened to be visible. From the user's side the selection
        // teleported to an unrelated rulecheck.
        await page.evaluate(async () => {
            const text = await (await fetch("sample.lyrdb")).text();
            await window.gdsLens.setMarkers("sample.lyrdb", text);
        });
        await page.locator(".lil-gui .lil-title", { hasText: "width_check" })
            .waitFor({ timeout: 10_000 });

        // Driven through the DOM rather than with real clicks: the folders
        // nest, and this test is about what ] does, not about opening panels.
        const setup = await page.evaluate(() => {
            const sr = document.querySelector("gds-lens").shadowRoot;
            const folderOf = (name) => [...sr.querySelectorAll("button.lil-title")]
                .find((t) => t.textContent.trim().startsWith(name))?.parentElement;
            const rows = (f) => [...f.querySelectorAll(":scope > .lil-children > .lil-controller")];
            const named = (f, text) => rows(f).find(
                (r) => (r.querySelector(".lil-name")?.textContent || "").includes(text));

            const hidden = folderOf("width_check");
            const shown = folderOf("space.m2");
            if (!hidden || !shown) return "missing a category folder";
            // space.m2 visible; width_check deliberately left hidden.
            named(shown, "visible").querySelector("input[type=checkbox]").click();
            // Select the first marker inside the hidden one.
            rows(hidden).find((r) => (r.querySelector(".lil-name")?.textContent || "")
                .trim().startsWith("#")).querySelector("button").click();
            return "ok";
        });
        assert.equal(setup, "ok", setup);

        const selected = () => page.evaluate(() => {
            const row = document.querySelector("gds-lens").shadowRoot.querySelector(".marker-selected");
            if (!row) return null;
            const title = row.closest(".lil-children")?.parentElement
                ?.querySelector("button.lil-title")?.textContent.trim();
            return `${title} ${(row.querySelector(".lil-name")?.textContent || "").trim()}`;
        });

        const first = await selected();
        assert.match(first ?? "", /width_check/,
            `expected a width_check row to be selected, got ${first}`);

        await page.keyboard.press("]");
        const next = await selected();
        assert.match(next ?? "", /width_check/,
            `] left the selected marker's own category: ${first} -> ${next}`);
        assert.notEqual(next, first, "] did not move the selection");

        await page.keyboard.press("[");
        assert.equal(await selected(), first, "[ did not step back to where ] started");

        // And it has to hold at the ends, which is the other half of the same
        // fault: width_check has two items, so a third ] has to wrap back to
        // its own first one rather than spill into the visible category.
        await page.keyboard.press("]");
        await page.keyboard.press("]");
        const wrapped = await selected();
        assert.equal(wrapped, first,
            `] off the end of a hidden category did not wrap inside it: ${wrapped}`);

        await page.keyboard.press("[");
        const back = await selected();
        assert.match(back ?? "", /width_check/,
            `[ off the start of a hidden category left it: ${back}`);
    });
});
