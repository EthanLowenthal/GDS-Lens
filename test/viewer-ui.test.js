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
