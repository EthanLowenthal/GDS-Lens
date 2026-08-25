// Tests <gds-lens> as a component rather than as a page: that importing it
// only registers the element, that an element created after load still works,
// that its src attribute and load() method drive it, and that two of them on
// one page render independently rather than fighting over one renderer.
//
// None of that depends on how the wasm binary arrives, so unlike the smoke
// test this runs against one payload rather than every built variant.
//
// Skipped unless a payload has been built (npm run build).

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { chromium, defaultVariant, fixtures, withPayload } from "./payload.js";

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

test("two elements mount independently", opts, async () => {
    await withPage(async (page, port) => {
        const errors = [];
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            for (const name of ["first", "second"]) {
                const el = document.createElement("gds-lens");
                el.style.width = "400px";
                el.style.height = "300px";
                document.body.appendChild(el);
                window[name] = el;
            }
        });

        // Each has to build its own shadow tree and its own wasm instance. The
        // canvas is the tell: a GL context belongs to one canvas, so two live
        // canvases means the two are not sharing a renderer.
        for (const name of ["first", "second"]) {
            await page.waitForFunction(
                (n) => !!window[n].shadowRoot?.getElementById("glCanvas"),
                name, { timeout: 60_000 });
        }
        assert.ok(await page.evaluate(() => window.first.shadowRoot !== window.second.shadowRoot),
            "the two elements should not share a shadow root");

        // Both load, and each ends up with its own layer table -- the state
        // that used to be one set of C++ file-scope globals for the page.
        await page.evaluate(() => Promise.all([
            window.first.load("sample_layout.gds"),
            window.second.load("sample_layout.gds"),
        ]));
        for (const name of ["first", "second"]) {
            await page.waitForFunction(
                (n) => window[n].shadowRoot.getElementById("loadingOverlay")?.classList.contains("hidden"),
                name, { timeout: 60_000 });
            const err = await page.evaluate(
                (n) => window[n].shadowRoot.getElementById("loadError").textContent.trim(), name);
            assert.equal(err, "", `${name} reported a load error: ${err}`);
        }

        // The proof that the two renderers are actually separate: a .lyp names
        // layers by rewriting the layer table, which is the file-scope global
        // in renderer.cpp that the old one-at-a-time limit existed to protect.
        // Push it into the first viewer only. If the two shared a table -- or
        // shared a wasm instance -- the second would be renamed too.
        const lyp = fs.readFileSync(path.join(fixtures, "sample.lyp"), "utf8");
        await page.evaluate((text) => window.first.setLyp("sample.lyp", text), lyp);
        await page.waitForFunction(
            () => window.first.shadowRoot.textContent.includes("METAL1"),
            { timeout: 10_000 });
        assert.ok(
            !await page.evaluate(() => window.second.shadowRoot.textContent.includes("METAL1")),
            "a .lyp applied to one viewer leaked into the other: they share a layer table");

        assert.deepEqual(errors, [], `neither element should log an error: ${errors.join(" | ")}`);
    });
});

test("a remounted element keeps its viewer instead of rebuilding one", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        // The framework case: the node is destroyed and a fresh one takes its
        // place. The replacement should adopt the parked viewer, so the layout
        // that was already parsed is still on screen and nothing reloads.
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:400px;height:300px";
            document.body.appendChild(el);
            window.el = el;
            return el.load("sample_layout.gds");
        });
        await page.waitForFunction(
            () => window.el.shadowRoot.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        const layersBefore = await page.evaluate(async () => {
            const canvas = window.el.shadowRoot.getElementById("glCanvas");
            window.canvasBefore = canvas;
            return (await window.el.ready).getLayerCount?.() ?? null;
        });

        await page.evaluate(() => {
            window.el.remove();
            const next = document.createElement("gds-lens");
            next.style.cssText = "width:400px;height:300px";
            document.body.appendChild(next);
            window.next = next;
        });
        await page.waitForFunction(() => !!window.next.shadowRoot?.getElementById("glCanvas"),
            { timeout: 30_000 });

        // The same canvas node, moved -- not a new one. That is what proves the
        // GL context and the parsed geometry survived rather than being rebuilt.
        assert.ok(await page.evaluate(
            () => window.next.shadowRoot.getElementById("glCanvas") === window.canvasBefore),
            "the replacement element should have adopted the original canvas");
        if (layersBefore !== null) {
            assert.equal(
                await page.evaluate(async () => (await window.next.ready).getLayerCount?.() ?? null),
                layersBefore, "the adopted viewer should still hold the parsed design");
        }
    });
});

// destroy() is the escape hatch from parking: it drops the viewer for good so
// the browser can reclaim the wasm instance and the GL context. The next
// element to mount must therefore build a fresh one rather than adopt it.
test("destroy() gives up the viewer instead of parking it", opts, async () => {
    await withPage(async (page, port) => {
        const errors = [];
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:400px;height:300px";
            document.body.appendChild(el);
            window.el = el;
            return el.load("sample_layout.gds");
        });
        await page.waitForFunction(
            () => window.el.shadowRoot.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        await page.evaluate(async () => {
            window.canvasBefore = window.el.shadowRoot.getElementById("glCanvas");
            window.el.remove();
            await window.el.destroy();
            const next = document.createElement("gds-lens");
            next.style.cssText = "width:400px;height:300px";
            document.body.appendChild(next);
            window.next = next;
        });
        await page.waitForFunction(() => !!window.next.shadowRoot?.getElementById("glCanvas"),
            { timeout: 60_000 });

        assert.ok(await page.evaluate(
            () => window.next.shadowRoot.getElementById("glCanvas") !== window.canvasBefore),
            "the destroyed viewer was adopted anyway");
        // And the replacement is a working viewer, not a husk.
        await page.evaluate(() => window.next.load("sample_layout.gds"));
        await page.waitForFunction(
            () => window.next.shadowRoot.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        assert.equal(await page.evaluate(
            () => window.next.shadowRoot.getElementById("loadError").textContent.trim()), "");
        assert.deepEqual(errors, [], `destroy() should be quiet: ${errors.join(" | ")}`);
    });
});

// ---- The three ways an element and its viewer can come apart ----
// All of these are about a viewer changing hands or a mount racing a removal,
// which only became possible once an element stopped being the only one.

test("an element whose viewer was adopted stops driving it", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        // `first` mounts, leaves the DOM (parking its viewer), and `second`
        // adopts it. `first` still holds a reference to that viewer, and used
        // to go on driving it -- so a stray call on a detached element wrote
        // into whatever was on screen.
        await page.evaluate(async () => {
            for (const name of ["first", "second"]) {
                const el = document.createElement("gds-lens");
                el.style.cssText = "width:300px;height:200px";
                window[name] = el;
            }
            document.body.appendChild(window.first);
            await window.first.ready;
            window.first.remove();
            document.body.appendChild(window.second);
            await window.second.ready;
        });

        const outcome = await page.evaluate(async () => {
            try {
                await window.first.showError("written by the detached element");
                return { rejected: false };
            } catch (err) {
                return { rejected: true, message: err.message };
            }
        });
        assert.ok(outcome.rejected, "the detached element drove the adopted viewer anyway");
        assert.match(outcome.message, /not driving a viewer/);
        assert.equal(await page.evaluate(
            () => window.second.shadowRoot.getElementById("loadError").textContent.trim()), "",
            "the detached element's message leaked into the element that adopted its viewer");
    });
});

test("removing an element mid-mount does not raise an unhandled rejection", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        // Mounting waits on a dynamic import, so a page that adds and removes
        // an element in one tick leaves a promise nobody is waiting on. It
        // rejects by design; the point is that it is handled, because an
        // unhandled rejection reaches the embedding app's error reporting.
        const rejections = await page.evaluate(async () => {
            const seen = [];
            addEventListener("unhandledrejection", (e) => seen.push(String(e.reason)));
            const el = document.createElement("gds-lens");
            document.body.appendChild(el);
            el.remove();
            await new Promise((r) => setTimeout(r, 2500));
            return seen;
        });
        assert.deepEqual(rejections, []);
    });
});

test("an element re-added mid-mount builds only one viewer", opts, async () => {
    // connect() runs once per viewer built, so counting it counts wasm
    // instances -- which is what has to be counted here, because a second
    // viewer overwrites the first's shadow tree and leaves nothing visible to
    // find. The first one's GL context is simply orphaned.
    const countingHost = "window.gdsLensHost = { connect: () => " +
        "{ window.connects = (window.connects || 0) + 1; } };";
    await withPayload(defaultVariant, async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        const result = await page.evaluate(async () => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:300px;height:200px";
            document.body.appendChild(el);   // mount starts
            el.remove();                     // disconnected before it lands
            document.body.appendChild(el);   // and straight back
            await new Promise((r) => setTimeout(r, 3000));
            return { connects: window.connects,
                     canvases: el.shadowRoot.querySelectorAll("canvas").length };
        });
        assert.equal(result.connects, 1, "a second viewer was built and orphaned");
        assert.equal(result.canvases, 1);
    }, { "bare.html": BARE,
         "gds-lens-host.js": { type: "text/javascript", body: countingHost } });
});

test("a viewer adopted while its module is still starting still comes up", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        // `ready` resolves as soon as createViewer returns, which is well
        // before main() has created the GL context. Adopting in that window
        // moves the shadow tree out from under a module that has not looked
        // at it yet, so whatever tells renderer.cpp where its DOM is has to be
        // current *now*, not on the next turn of the module promise.
        await page.evaluate(async () => {
            const first = document.createElement("gds-lens");
            first.style.cssText = "width:300px;height:200px";
            document.body.appendChild(first);
            await first.ready;               // module still initializing here
            first.remove();
            const second = document.createElement("gds-lens");
            second.style.cssText = "width:300px;height:200px";
            document.body.appendChild(second);
            window.second = second;
            await second.ready;
        });
        // Long enough for the module to finish and fail if it is going to.
        await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
        assert.equal(await page.evaluate(
            () => window.second.shadowRoot.getElementById("loadError").textContent.trim()), "",
            "the adopted viewer's module failed to start");
        // And it is a working viewer, not merely a quiet one.
        await page.evaluate(() => window.second.load("sample_layout.gds"));
        await page.waitForFunction(
            () => window.second.shadowRoot.getElementById("loadingOverlay")
                ?.classList.contains("hidden"), { timeout: 60_000 });
    });
});

// Both of these are about a viewer that is a box on a page rather than the
// page itself -- the case the renderer used to assume away by sizing its
// drawing buffer to the window.
test("an embedded viewer sizes its buffer to the element and reads the right coordinate",
     opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        // Deliberately neither the window's size nor its shape, and offset from
        // the origin: a window-sized buffer stretched over this box distorts the
        // layout, and viewport coordinates read as canvas ones are off by the
        // offset.
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "display:block;width:520px;height:300px;margin:120px 0 0 180px";
            document.body.appendChild(el);
            window.el = el;
        });
        await page.evaluate(() => window.el.load("sample_layout.gds"));
        await page.waitForFunction(
            () => window.el.shadowRoot?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        const size = await page.evaluate(() => {
            const canvas = window.el.shadowRoot.querySelector("canvas");
            const box = canvas.getBoundingClientRect();
            return { css: [Math.round(box.width), Math.round(box.height)],
                     buffer: [canvas.width, canvas.height] };
        });
        assert.deepEqual(size.buffer, size.css,
            `drawing buffer ${size.buffer} does not match the element's box ${size.css}`);

        // The end-to-end version of the same claim, and the one a user would
        // notice: centre the camera on a coordinate, put the pointer on the
        // middle of the canvas, and the readout has to agree. It did not when
        // the buffer was the window's -- the middle of the buffer was not the
        // middle of the box, and the box was not where the pointer thought.
        const box = await page.locator("gds-lens").boundingBox();
        await page.evaluate(() => window.el.goToPoint(2, 3));
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForFunction(() => window.el.shadowRoot
            .getElementById("coordReadout").textContent.includes("X"), { timeout: 10_000 });
        const readout = await page.evaluate(() => window.el.shadowRoot
            .getElementById("coordReadout").textContent.trim());
        assert.match(readout, /X:\s*2\.0\s+Y:\s*3\.0/,
            `the pointer at the canvas centre read ${readout}, not the point the camera is on`);

        // Resizing the element alone leaves the window untouched, so nothing but
        // the ResizeObserver can catch it.
        await page.evaluate(() => { window.el.style.width = "300px"; window.el.style.height = "560px"; });
        await page.waitForFunction(() => {
            const canvas = window.el.shadowRoot.querySelector("canvas");
            return canvas.width === 300 && canvas.height === 560;
        }, { timeout: 10_000 });
    });
});

test("a viewer with nothing to show says so rather than showing a progress bar",
     opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "display:block;width:520px;height:300px";
            document.body.appendChild(el);
            window.el = el;
            return el.ready;
        });
        // An empty progress bar over "Loading layout..." is what a hung load
        // looks like, and a viewer nobody has handed a layout to is not loading.
        const idle = await page.evaluate(() => {
            const root = window.el.shadowRoot;
            const overlay = root.getElementById("loadingOverlay");
            return { visible: !overlay.classList.contains("hidden"),
                     phase: root.getElementById("loadingPhase").textContent.trim(),
                     // offsetParent is null for a display:none ancestor chain,
                     // which is how the idle rule hides the bar.
                     bar: !!root.getElementById("loadingBarTrack").offsetParent };
        });
        assert.ok(idle.visible, "the idle viewer should still say something");
        assert.equal(idle.phase, "No layout loaded");
        assert.equal(idle.bar, false, "an idle viewer should show no progress bar");

        // And it turns into a real load when one starts.
        await page.evaluate(() => window.el.load("sample_layout.gds"));
        await page.waitForFunction(
            () => window.el.shadowRoot.getElementById("loadingOverlay").classList.contains("hidden"),
            { timeout: 60_000 });
    });
});
