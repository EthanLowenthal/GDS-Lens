// Loads site/ in headless Chromium and fails if the demo page does not render
// a layout. Run against the payload the Pages workflow is about to deploy, so
// a broken publish stops there rather than on the live page.
//
// This catches what a build cannot: whether the payload and the page still
// agree. The page loads three scripts in a required order and the parse Worker
// resolves its own scripts against document.baseURI, so a renamed file or a
// payload in the wrong directory fails here and nowhere else.
//
//   node scripts/check-site.mjs [dir]      default: site
import fs from "fs";
import http from "http";
import path from "path";
import { chromium } from "playwright";

const root = path.resolve(process.argv[2] || "site");

const TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    // Not optional: without it instantiateStreaming refuses the response and
    // Emscripten falls back to a slower non-streaming compile.
    ".wasm": "application/wasm",
    ".gds": "application/octet-stream",
    ".css": "text/css",
};

const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("requestfailed", (req) => errors.push(`${req.url()}: ${req.failure()?.errorText}`));

const fail = async (message) => {
    console.error(`FAIL ${message}`);
    await browser.close();
    server.close();
    process.exit(1);
};

try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

    // The host has to install itself before the element script reads it.
    if (await page.evaluate(() => typeof window.gdsLensHost) !== "object") {
        await fail("window.gdsLensHost was never installed (is gds-lens-host.js present, and before gds-lens.js?)");
    }

    // connect() publishes the surface, so this proves the handshake ran rather
    // than that a global happens to exist.
    await page.waitForFunction(() => typeof window.gdsLens?.load === "function", { timeout: 30_000 });

    // The overlay hides only once geometry reached the renderer, which means
    // the Worker started, wasm instantiated, and the parse succeeded.
    await page.waitForFunction(
        () => document.querySelector("gds-lens")?.shadowRoot
            ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
        { timeout: 60_000 });

    const loadError = await page.evaluate(
        () => document.querySelector("gds-lens")?.shadowRoot
            ?.getElementById("loadError")?.textContent.trim() || null);
    if (loadError) await fail(`the viewer reported a load error: ${loadError}`);

    // The demo layout's own top cell, so a page that renders some other file
    // (or an empty one) is still a failure.
    const tree = await page.evaluate(
        () => document.querySelector("gds-lens")?.shadowRoot
            ?.getElementById("hierarchyTree")?.textContent || "");
    if (!tree.includes("DEMO_DIE")) await fail(`the cell tree does not mention DEMO_DIE: ${tree.slice(0, 120)}`);

    if (errors.length) await fail(`the page logged errors:\n  ${errors.join("\n  ")}`);

    console.log("OK the demo page renders demo-layout.gds with no errors");
} finally {
    await browser.close();
    server.close();
}
