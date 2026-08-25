// Tests <gds-lens> as a component rather than as a page: that importing it
// only registers the element, that an element created after load still works,
// that its src attribute and load() method drive it, and that a second one
// fails visibly rather than quietly fighting the first over the renderer's
// module-scope state.
//
// Skipped unless dist/webview has been built (npm run build).

import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webviewDir = path.join(__dirname, "..", "dist", "webview");
const fixture = path.join(__dirname, "fixtures", "sample_layout.gds");
const built = fs.existsSync(path.join(webviewDir, "gds-lens.js")) &&
              fs.existsSync(path.join(webviewDir, "gdstk_wasm.js"));

let chromium = null;
try {
    ({ chromium } = await import("playwright"));
} catch {
    // left null; the tests below skip
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".gds": "application/octet-stream" };

// Serves the payload plus a bare page that loads only the element bundle, so
// "importing does not mount" can be observed at all.
function serve() {
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
        if (name === "bare.html") {
            res.writeHead(200, { "Content-Type": "text/html" });
            // charset matters: gdstk_wasm.js embeds the wasm binary as a raw
            // string, so a document that is not UTF-8 mangles it.
            res.end(`<!DOCTYPE html><html><head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy"
                  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self';">
                </head><body>
                <script src="gdstk_wasm.js"></script>
                <script src="host.js"></script>
                <script src="gds-lens.js"></script>
                </body></html>`);
            return;
        }
        const file = name === "sample_layout.gds" ? fixture : path.join(webviewDir, name);
        if (!file.startsWith(webviewDir) && file !== fixture) return res.writeHead(403).end();
        fs.readFile(file, (err, data) => {
            if (err) return res.writeHead(404).end();
            res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
            res.end(data);
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function withPage(fn) {
    const server = await serve();
    const port = server.address().port;
    const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader"] });
    const page = await browser.newPage();
    try {
        await fn(page, port);
    } finally {
        await browser.close();
        server.close();
    }
}

const opts = { skip: !built || !chromium };

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

test("a second element refuses rather than fighting the first", opts, async () => {
    await withPage(async (page, port) => {
        const errors = [];
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/bare.html`);
        await page.evaluate(() => {
            document.body.appendChild(document.createElement("gds-lens"));
            const second = document.createElement("gds-lens");
            document.body.appendChild(second);
            window.second = second;
        });
        await page.waitForFunction(() => window.second.textContent.length > 0, { timeout: 10_000 });
        assert.match(await page.evaluate(() => window.second.textContent), /only one/i);
        assert.ok(errors.some((e) => /only one/i.test(e)),
            "the refusal should also be reported to the console");
        // The first one must still be intact.
        assert.ok(await page.evaluate(() => !!document.querySelector("gds-lens").shadowRoot),
            "the first element should still be mounted");
    });
});
