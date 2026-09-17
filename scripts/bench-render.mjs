#!/usr/bin/env node
// Measures draw time, not load time -- the half scripts/bench.mjs in the
// extension repo deliberately leaves out because it needs a GPU.
//
//   node scripts/bench-render.mjs path/to/chip.gds [more.oas ...]
//
// Serves dist/web with the layout's own directory alongside it, opens the page
// in Chromium, loads the layout, then drives the camera from inside the page so
// every rAF tick has something to redraw, and reports the mean interval.
// draw_frame is redraw-on-demand (see renderer.cpp request_redraw), so a
// stationary camera measures nothing: each sample nudges the pan by a fraction
// of a pixel, which is a full redraw and no visible motion.
//
// The scenarios exist to split the one number into a cause. Frame time that
// falls with the canvas area is fragment-bound (fill rate, overdraw, the hatch
// shader); frame time that falls with the layer count but not the canvas is
// vertex-bound (too much geometry submitted per frame), which is the one LOD
// and tiling fix. Both falling means both matter.
//
// --gpu uses the machine's real GL through ANGLE. Without it the run is
// SwiftShader, which is reproducible but says nothing about a real driver.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadDir = path.join(__dirname, "..", "dist", "web");

const argv = process.argv.slice(2);
const useGpu = argv.includes("--gpu");
const headed = argv.includes("--headed");
const frames = Number(argv.find((a) => a.startsWith("--frames="))?.split("=")[1] ?? 60);
const files = argv.filter((a) => !a.startsWith("--"));

if (!files.length) {
    console.error("usage: node scripts/bench-render.mjs [--gpu] [--headed] [--frames=N] <layout> ...");
    process.exit(2);
}
if (!fs.existsSync(path.join(payloadDir, "gds-lens.html"))) {
    console.error(`no built payload at ${payloadDir} -- run: npm run build`);
    process.exit(2);
}

let chromium;
try {
    ({ chromium } = await import("playwright"));
} catch {
    console.error("playwright is not installed -- run: npm i && npx playwright install chromium");
    process.exit(2);
}

// The viewer is handed raw bytes, so gzipped layouts are expanded here the way
// every host does before load() (see gds-lens/layout-bytes).
function layoutBytes(file) {
    const bytes = fs.readFileSync(file);
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
}

// The payload plus one layout, which is everything the page fetches. The layout
// is served under a fixed name so the page URL does not depend on the path.
function serve(bytes) {
    const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "gds-lens.html";
        if (name === "layout.bin") {
            res.writeHead(200, { "Content-Type": "application/octet-stream" });
            return res.end(bytes);
        }
        const file = path.join(payloadDir, name);
        if (!file.startsWith(payloadDir)) return res.writeHead(403).end();
        fs.readFile(file, (err, data) => {
            if (err) return res.writeHead(404).end();
            res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
            res.end(data);
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const launch = {
    headless: !headed,
    args: useGpu
        // Headless Chromium picks SwiftShader on its own unless told otherwise;
        // these are what get it onto the real device on macOS.
        ? ["--use-gl=angle", "--use-angle=metal", "--enable-gpu",
           "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        : ["--use-gl=angle", "--use-angle=swiftshader"]
};

// Runs inside the page: drives the camera for `n` rAF ticks and returns the
// intervals. Each tick moves the pan by a sub-pixel amount so the redraw is
// real work on identical geometry rather than a new view to compare against.
const SAMPLE = async ({ n }) => {
    const viewer = window.gdsLens;
    const base = await viewer.getCamera();
    const step = 0.25 / base.zoom;  // a quarter pixel in world units
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const samples = [];
    // Two throwaway frames: the first redraw after a resize or a layer change
    // carries that change's own cost (buffer re-uploads, shader recompiles).
    for (let i = 0; i < 2; i++) { await viewer.setCamera({ ...base, panX: base.panX + step * i }); await raf(); }
    let last = performance.now();
    for (let i = 0; i < n; i++) {
        await viewer.setCamera({ ...base, panX: base.panX + step * (i % 8) });
        await raf();
        const now = performance.now();
        samples.push(now - last);
        last = now;
    }
    return samples;
};

function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    return { mean, median: sorted[sorted.length >> 1], min: sorted[0], max: sorted[sorted.length - 1] };
}

function fmt(label, s) {
    const fps = 1000 / s.mean;
    console.log(`  ${label.padEnd(22)} ${s.mean.toFixed(1).padStart(8)} ms  ` +
                `${fps.toFixed(1).padStart(6)} fps   (median ${s.median.toFixed(1)}, min ${s.min.toFixed(1)}, max ${s.max.toFixed(1)})`);
}

async function benchOne(browser, file) {
    const bytes = layoutBytes(file);
    const server = await serve(bytes);
    const port = server.address().port;
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
        const t0 = Date.now();
        await page.goto(`http://127.0.0.1:${port}/gds-lens.html?src=layout.bin`);
        await page.waitForFunction(() => typeof window.gdsLens?.getCamera === "function", { timeout: 60_000 });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 600_000 });
        const loadMs = Date.now() - t0;

        const layers = await page.evaluate(() => window.gdsLens.getLayers());
        const polygons = layers.reduce((a, l) => a + l.polygonCount, 0);
        // The debug readout is where the renderer reports what it asked the
        // driver for -- the only view of how much the layout costs on the GPU,
        // since WebGL cannot be asked.
        const gpu = await page.evaluate(async () => {
            window.gdsLens.toggleDebug();
            await new Promise((r) => requestAnimationFrame(r));
            const text = document.querySelector("gds-lens").shadowRoot
                ?.getElementById("renderStats")?.textContent ?? "";
            window.gdsLens.toggleDebug();
            return text.match(/GPU: ([\d.]+) MB/)?.[1] ?? null;
        });
        console.log(`\n${path.basename(file)}  ${(bytes.length / (1 << 20)).toFixed(1)} MB in memory, ` +
                    `${layers.length} layers, ${polygons.toLocaleString("en-US")} polygons, ` +
                    `${gpu ? `${gpu} MB on the GPU, ` : ""}` +
                    `page load to first frame ${(loadMs / 1000).toFixed(2)} s`);

        const runs = {};
        // Fit view: everything on screen, which is the view a file opens in.
        runs["fit"] = stats(await page.evaluate(SAMPLE, { n: frames }));

        // Same geometry, a quarter of the pixels. A fragment-bound frame
        // follows the area down; a vertex-bound one barely moves.
        await page.evaluate(() => {
            const el = document.querySelector("gds-lens");
            el.style.width = "800px";
            el.style.height = "500px";
        });
        await page.waitForTimeout(300);
        runs["fit, 1/4 the pixels"] = stats(await page.evaluate(SAMPLE, { n: frames }));
        await page.evaluate(() => {
            const el = document.querySelector("gds-lens");
            el.style.width = "";
            el.style.height = "";
        });
        await page.waitForTimeout(300);

        // Same pixels, half the geometry. The other half of the same question.
        const half = layers.filter((_, i) => i % 2 === 0);
        await page.evaluate(async (hidden) => {
            for (const l of hidden) await window.gdsLens.setLayerVisible(l.layer, l.datatype, false);
        }, half);
        await page.waitForTimeout(300);
        runs["half the layers"] = stats(await page.evaluate(SAMPLE, { n: frames }));
        await page.evaluate(async (shown) => {
            for (const l of shown) await window.gdsLens.setLayerVisible(l.layer, l.datatype, true);
        }, half);
        await page.waitForTimeout(300);

        // Zoomed in far enough that most of the design is off screen. Nothing
        // in draw_frame culls below the layer level, so this should cost the
        // same as the fit view -- and that it does is the case for tiling.
        await page.evaluate(async () => {
            const c = await window.gdsLens.getCamera();
            await window.gdsLens.setCamera({ ...c, zoom: c.zoom * 20 });
        });
        await page.waitForTimeout(300);
        runs["zoomed in 20x"] = stats(await page.evaluate(SAMPLE, { n: frames }));

        for (const [label, s] of Object.entries(runs)) fmt(label, s);
        if (errors.length) console.log(`  page errors: ${errors.join("; ")}`);
        return { file, layers: layers.length, polygons, loadMs, runs };
    } finally {
        await page.close();
        server.close();
    }
}

const browser = await chromium.launch(launch);
console.log(`renderer: ${useGpu ? "real GPU via ANGLE" : "SwiftShader (software)"}, ${frames} frames per scenario`);
try {
    for (const file of files) await benchOne(browser, file);
} finally {
    await browser.close();
}
