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

// ---- What a load reports ----
// load() used to resolve as soon as the file reached the parse worker, so a
// parser refusal never rejected it; and a load that came from `src` had no
// promise at all. The promise now settles on the outcome, and the two events
// say the same thing for every load however it was started.

test("load() settles on the outcome, and the events say the same", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        const result = await page.evaluate(async () => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:400px;height:300px";
            const events = [];
            el.addEventListener("gds-load", (e) => events.push(["gds-load", e.detail]));
            el.addEventListener("gds-error", (e) => events.push(["gds-error", e.detail]));
            document.body.appendChild(el);
            const shadow = () => el.shadowRoot;

            // A DRC report is not a layout.
            let rejected = null;
            try {
                await el.load("sample_drc.txt");
            } catch (err) {
                rejected = err.message;
            }
            const shownAfterFailure = shadow().getElementById("loadError").textContent;

            await el.load("sample_layout.gds");
            // "Resolves once the layout is on screen": the overlay is already
            // down and the error gone by the time the promise settles.
            const overlayHidden = shadow().getElementById("loadingOverlay").classList.contains("hidden");
            const errorAfterSuccess = shadow().getElementById("loadError").textContent;
            return { rejected, shownAfterFailure, overlayHidden, errorAfterSuccess, events };
        });

        assert.ok(result.rejected, "a file the parser refuses must reject load()");
        assert.ok(result.shownAfterFailure.includes(result.rejected),
            "the rejection carries the message the viewer shows");
        assert.equal(result.overlayHidden, true, "load() resolved before the layout was on screen");
        assert.equal(result.errorAfterSuccess, "");
        assert.equal(result.events.length, 2, `expected one error and one load, got ${JSON.stringify(result.events)}`);
        assert.equal(result.events[0][0], "gds-error");
        assert.equal(result.events[0][1].message, result.rejected);
        assert.equal(result.events[1][0], "gds-load");
        assert.ok(result.events[1][1].layerCount > 0, "gds-load should report the layers");
        assert.ok(result.events[1][1].cellCount > 0, "gds-load should report the cells");
    });
});

test("a load superseded by a newer one is dropped, however slow it was", opts, async () => {
    await withPage(async (page, port) => {
        // The fixture, half a second late: long enough for the layout asked for
        // second to be on screen before the first one's bytes even arrive.
        const bytes = fs.readFileSync(path.join(fixtures, "sample_layout.gds"));
        await page.route("**/slow.gds", async (route) => {
            await new Promise((r) => setTimeout(r, 500));
            await route.fulfill({ status: 200, contentType: "application/octet-stream", body: bytes });
        });
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        const result = await page.evaluate(async () => {
            const make = () => {
                const el = document.createElement("gds-lens");
                el.style.cssText = "width:300px;height:200px";
                el.loads = 0;
                el.errors = [];
                el.addEventListener("gds-load", () => el.loads++);
                el.addEventListener("gds-error", (e) => el.errors.push(e.detail.message));
                document.body.appendChild(el);
                return el;
            };
            // Through load(): the first must reject with AbortError, the
            // second resolve.
            const byMethod = make();
            const outcomes = await Promise.all([
                byMethod.load("slow.gds").then(() => "resolved", (err) => err.name),
                byMethod.load("sample_layout.gds").then(() => "resolved", (err) => err.name)
            ]);
            // Through src: nothing to await, so the events are the record.
            const byAttribute = make();
            byAttribute.setAttribute("src", "slow.gds");
            byAttribute.setAttribute("src", "sample_layout.gds");
            await new Promise((resolve) => byAttribute.addEventListener("gds-load", resolve, { once: true }));
            // Past when slow.gds would have landed, had it not been cancelled.
            await new Promise((r) => setTimeout(r, 900));
            return {
                outcomes,
                methodLoads: byMethod.loads,
                attributeLoads: byAttribute.loads,
                attributeErrors: byAttribute.errors
            };
        });
        assert.deepEqual(result.outcomes, ["AbortError", "resolved"]);
        assert.equal(result.methodLoads, 1, "the superseded load must not land later");
        assert.equal(result.attributeLoads, 1, "the superseded src must not land later");
        assert.deepEqual(result.attributeErrors, [], "a superseded src is not an error to show");
    });
});

test("showLoading() on the element puts up the overlay with its label", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        const result = await page.evaluate(async () => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:300px;height:200px";
            document.body.appendChild(el);
            await el.showLoading("Reading chip.gds...");
            const overlay = el.shadowRoot.getElementById("loadingOverlay");
            return {
                idle: overlay.classList.contains("idle"),
                hidden: overlay.classList.contains("hidden"),
                label: el.shadowRoot.getElementById("loadingPhase").textContent
            };
        });
        assert.deepEqual(result, { idle: false, hidden: false, label: "Reading chip.gds..." });
    });
});

// ---- Letting go, and having nothing to hold ----

test("destroy() releases the viewer's listeners and its WebGL context", opts, async () => {
    await withPage(async (page, port) => {
        // Every listener anything puts on window, and whether it is gone
        // after destroy(): aborted through the signal it was added with (the
        // viewer's own) or removed outright (Emscripten's mouseup and resize,
        // which destroyRenderer unregisters). A listener on window holds its
        // closure, and the closure holds the whole viewer, wasm instance
        // included, so one left behind is the whole leak.
        await page.addInitScript(() => {
            const recorded = [];
            const add = EventTarget.prototype.addEventListener;
            const remove = EventTarget.prototype.removeEventListener;
            const capture = (options) => !!(typeof options === "object" ? options?.capture : options);
            EventTarget.prototype.addEventListener = function (type, listener, options) {
                if (this === window) {
                    const signal = options && typeof options === "object" ? options.signal : undefined;
                    recorded.push({ type, listener, capture: capture(options), signal, removed: false });
                }
                return add.call(this, type, listener, options);
            };
            EventTarget.prototype.removeEventListener = function (type, listener, options) {
                if (this === window) {
                    for (const entry of recorded) {
                        if (entry.type === type && entry.listener === listener &&
                            entry.capture === capture(options)) entry.removed = true;
                    }
                }
                return remove.call(this, type, listener, options);
            };
            window.__windowListeners = recorded;
        });
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:400px;height:300px";
            document.body.appendChild(el);
            window.el = el;
            return el.load("sample_layout.gds");
        });
        const result = await page.evaluate(async () => {
            const gl = window.el.shadowRoot.getElementById("glCanvas").getContext("webgl2");
            const lostBefore = gl.isContextLost();
            window.el.remove();
            await window.el.destroy();
            // The context goes on the module promise's next tick.
            await new Promise((r) => setTimeout(r, 100));
            // The page-level error hooks are installed once and stay: they
            // report failures no single viewer owns.
            const own = window.__windowListeners.filter(
                (l) => l.type !== "error" && l.type !== "unhandledrejection");
            return {
                lostBefore,
                lostAfter: gl.isContextLost(),
                total: own.length,
                leftBehind: own.filter((l) => !l.removed && !(l.signal && l.signal.aborted))
                    .map((l) => l.type)
            };
        });
        assert.equal(result.lostBefore, false, "the context should be live before destroy()");
        assert.equal(result.lostAfter, true, "destroy() should release the WebGL context");
        // Five from the viewer (the keyboard, the coordinate menu's dismissal)
        // and two from the renderer (mouseup, resize).
        assert.ok(result.total >= 7, `expected the viewer's window listeners to be recorded, saw ${result.total}`);
        assert.deepEqual(result.leftBehind, [],
            "destroy() must abort or remove every listener the viewer put on window");
    });
});

test("a browser without WebGL2 is told so, and load() fails with the reason", opts, async () => {
    await withPage(async (page, port) => {
        await page.addInitScript(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
                if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") return null;
                return original.call(this, type, ...rest);
            };
        });
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:400px;height:300px";
            document.body.appendChild(el);
            window.el = el;
        });
        await page.waitForFunction(
            () => window.el.shadowRoot?.getElementById("loadError")?.textContent.includes("WebGL2"),
            { timeout: 60_000 });
        const rejected = await page.evaluate(
            () => window.el.load("sample_layout.gds").then(() => null, (err) => err.message));
        assert.ok(rejected && rejected.includes("WebGL2"), `load() should fail with the reason, got: ${rejected}`);
    });
});

test("a lost WebGL context is reported rather than left as a black canvas", opts, async () => {
    await withPage(async (page, port) => {
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            const el = document.createElement("gds-lens");
            el.style.cssText = "width:400px;height:300px";
            document.body.appendChild(el);
            window.el = el;
            return el.load("sample_layout.gds");
        });
        const result = await page.evaluate(async () => {
            const errors = [];
            window.el.addEventListener("gds-error", (e) => errors.push(e.detail.message));
            const gl = window.el.shadowRoot.getElementById("glCanvas").getContext("webgl2");
            gl.getExtension("WEBGL_lose_context").loseContext();
            // webglcontextlost is dispatched asynchronously.
            await new Promise((r) => setTimeout(r, 200));
            const shown = window.el.shadowRoot.getElementById("loadError").textContent;
            const rejected = await window.el.load("sample_layout.gds").then(() => null, (err) => err.message);
            return { shown, errors, rejected };
        });
        assert.ok(result.shown.includes("context was lost"), `expected the loss to be shown, got: ${result.shown}`);
        assert.equal(result.errors.length >= 1, true, "gds-error should fire for the loss");
        assert.ok(result.rejected && result.rejected.includes("context was lost"),
            `a load after the loss should fail with the reason, got: ${result.rejected}`);
    });
});
