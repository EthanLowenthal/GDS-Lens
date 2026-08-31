// Renders site/ in a headless browser and saves the link-preview image.
//
// A screenshot rather than a drawn graphic, because the card's job is to show
// what the page actually does: a dense layout, the panels, the real colours.
// Regenerate whenever the demo layout or the chrome changes; the result is
// committed, so the deploy has nothing to render.
//
//   node scripts/make-og-image.mjs [dir]      default: site
import fs from "fs";
import http from "http";
import path from "path";
import { chromium } from "playwright";

const root = path.resolve(process.argv[2] || "site");
const out = path.join(root, "og-preview.png");

// 1200x630 is what every scraper crops to; anything else gets letterboxed or
// centre-cropped, usually through the middle of the layout.
const WIDTH = 1200;
const HEIGHT = 630;

// How far to zoom in from the fit view before shooting. At fit, 18 mm of die
// in 740 px renders as texture: honest, but it could be anything. A few
// notches in and the card shows waveguides, rings and bends as shapes. One
// notch is 1.10x (kZoomPerNotch in renderer.cpp), so this is about 9x.
const ZOOM_NOTCHES = 23;

// The renderer caps a single wheel event at 4 notches, so the zoom has to
// arrive as a stream of events rather than one large delta.
const NOTCHES_PER_EVENT = 4;
const PIXELS_PER_NOTCH = 100;

const TYPES = {
    ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm",
    ".gz": "application/gzip", ".lyp": "application/xml", ".drc": "text/plain",
    ".png": "image/png", ".json": "application/json",
};

const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end();
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await chromium.launch();
// Dark, because the card is usually seen against a dark chat client and the
// layout reads better there. 1x on purpose: at 2x this shot is 1.5 MB, and a
// card is rendered around 600px wide, so the extra pixels buy nothing and some
// scrapers skip images over a megabyte.
const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: "dark",
});
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForFunction(() => {
    const sr = document.querySelector("gds-lens")?.shadowRoot;
    return sr?.getElementById("loadingOverlay")?.classList.contains("hidden")
        && (sr.textContent || "").includes("Markers (");
}, { timeout: 180_000 });
// The footer reads its version from build.json, which only the deploy writes,
// so a locally generated card would advertise "local build". Stamp the
// package's own version instead: the card is published alongside a release of
// it, and "local build" on a shared link is just noise.
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
await page.evaluate((v) => {
    const el = document.getElementById("build");
    if (el) el.textContent = `gds-lens ${v}`;
}, version);

// Zoom by driving the wheel rather than reaching into the renderer: there is
// no public zoom on ViewerSurface, and this exercises the same path a visitor
// does. Playwright's wheel goes to the current mouse position, so the pointer
// is parked on the middle of the canvas first, which is also the point the
// zoom holds fixed (see on_wheel in renderer.cpp).
const canvas = await page.evaluateHandle(
    () => document.querySelector("gds-lens").shadowRoot.querySelector("canvas"));
const box = await canvas.asElement().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let done = 0; done < ZOOM_NOTCHES; done += NOTCHES_PER_EVENT) {
    const notches = Math.min(NOTCHES_PER_EVENT, ZOOM_NOTCHES - done);
    // Negative deltaY is a scroll towards the viewer, which zooms in.
    await page.mouse.wheel(0, -notches * PIXELS_PER_NOTCH);
    await page.waitForTimeout(120);
}

// The frame after the markers land, so the shot is never mid-draw.
await page.waitForTimeout(1500);
await page.screenshot({ path: out });

const { size } = fs.statSync(out);
console.log(`wrote ${path.relative(process.cwd(), out)}  ${WIDTH}x${HEIGHT}  ${(size / 1024).toFixed(0)} KB`);
await browser.close();
server.close();
