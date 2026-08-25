// End-to-end smoke test for the payload as an ordinary web page: serves
// dist/webview over HTTP, opens it in headless Chromium, hands it a layout,
// and waits for geometry to reach the renderer.
//
// This covers the half that unit tests structurally cannot -- whether the
// files actually wire together. The scripts loading in the right order, the
// host installing itself, connect() running, the Worker starting from
// document-relative URLs, wasm instantiating, and the parse landing. A
// missing or misnamed script in the payload fails here and nowhere else.
//
// Skipped unless dist/webview has been built (npm run build).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const webviewDir = path.join(__dirname, "..", "dist", "webview");
const fixture = path.join(__dirname, "fixtures", "sample_layout.gds");

const built = fs.existsSync(path.join(webviewDir, "viewer.html")) &&
              fs.existsSync(path.join(webviewDir, "gdstk_wasm.js"));

let chromium;
try {
    ({ chromium } = require("playwright"));
} catch {
    chromium = null;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".gds": "application/octet-stream" };

// Serves dist/webview plus the fixture, so the page can fetch the layout
// through ?src= exactly as an embedding page would.
function serve() {
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "viewer.html";
        const file = name === "sample_layout.gds" ? fixture : path.join(webviewDir, name);
        // Refuse anything that escapes the two locations we mean to serve.
        if (!file.startsWith(webviewDir) && file !== fixture) {
            res.writeHead(403).end();
            return;
        }
        fs.readFile(file, (err, data) => {
            if (err) return res.writeHead(404).end();
            res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
            res.end(data);
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("the payload loads a layout as a plain web page", { skip: !built || !chromium }, async () => {
    const server = await serve();
    const port = server.address().port;
    // Chromium's SwiftShader fallback: CI has no GPU, and the renderer needs a
    // real WebGL2 context to upload into.
    const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    try {
        await page.goto(`http://127.0.0.1:${port}/viewer.html?src=sample_layout.gds`);

        // The host has to install itself before viewer.js reads it. This is
        // exactly what broke when host.js was left out of the payload.
        assert.ok(await page.evaluate(() => typeof window.gdsLensHost === "object"),
                  "window.gdsLensHost was never installed");

        // connect() publishes the viewer surface, so this proves the handshake
        // ran rather than merely that a global exists.
        await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });

        // The overlay hides only once geometry has been uploaded, which means
        // the Worker started, wasm instantiated and the parse succeeded.
        await page.waitForFunction(
            () => document.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        // #loadError hides via `:empty` in CSS rather than a class, so any
        // text in it at all is a failure.
        const loadError = await page.evaluate(
            () => document.getElementById("loadError")?.textContent.trim() || null);
        assert.equal(loadError, null, `viewer reported a load error: ${loadError}`);

        // fixtures/sample_layout.gds has shapes on layers 1/0 and 2/0.
        const layers = await page.evaluate(() => window.gdsLens.getLayerCount?.() ?? null);
        if (layers !== null) assert.ok(layers > 0, "no layers reached the renderer");

        assert.deepEqual(errors, [], `uncaught errors on the page: ${errors.join("; ")}`);
    } finally {
        await browser.close();
        server.close();
    }
});
