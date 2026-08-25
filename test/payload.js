// Shared harness for the tests that drive a built payload in a real browser.
//
// There are two payloads (see scripts/build-webview.mjs): dist/web, where the
// wasm binary is a separate file the module fetches, and dist/inline-wasm,
// where it is embedded in the JS. They are byte-identical apart from that, so
// most tests only need one -- but the difference is exactly a loading concern,
// so the end-to-end load test runs against every variant that has been built.

import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional: the rest of the suite must still run where playwright's browser
// download has not happened.
export let chromium = null;
try {
    ({ chromium } = await import("playwright"));
} catch {
    // left null; callers skip
}

const NAMES = ["web", "inline-wasm"];

// A payload counts as built only if Emscripten's output is there too, since
// esbuild will happily produce the bundles without it.
export const variants = NAMES
    .map((name) => ({ name, dir: path.join(__dirname, "..", "dist", name) }))
    .filter((v) => fs.existsSync(path.join(v.dir, "gds-lens.js")) &&
                   fs.existsSync(path.join(v.dir, "gds-lens-engine.js")))
    // Read off the payload rather than the name, so this says what the files
    // are rather than what they are called.
    .map((v) => ({ ...v, separateWasm: fs.existsSync(path.join(v.dir, "gds-lens-engine.wasm")) }));

// The one every test that isn't specifically about loading uses.
export const defaultVariant = variants[0] || null;

export const fixtures = path.join(__dirname, "fixtures");
export const fixture = path.join(fixtures, "sample_layout.gds");

// text/javascript without a charset on purpose: it is what a plainly
// configured host sends, and the payload has to survive it. application/wasm
// is not optional in the same way -- without it instantiateStreaming refuses
// the response and Emscripten falls back to a non-streaming compile.
const TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".gds": "application/octet-stream"
};

// Serves one payload directory plus test/fixtures, so a page can fetch a
// design through ?src= exactly as an embedding page would (and a test can hand
// the viewer a .lyp or a marker database the same way).
//
// `routes` supplies generated files, keyed by request path, either as a body
// string or as `{ type, body }`. A route wins over a file of the same name,
// which is how a test substitutes its own gds-lens-host.js for the payload's.
export function serve(dir, routes = {}) {
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "gds-lens.html";
        if (routes[name]) {
            const route = routes[name];
            const { type = TYPES[path.extname(name)] || "text/html", body } =
                typeof route === "string" ? { body: route } : route;
            res.writeHead(200, { "Content-Type": type });
            res.end(body);
            return;
        }
        // Fixtures shadow the payload: nothing in the payload shares a name
        // with one, and this keeps a test from having to enumerate them.
        const asFixture = path.join(fixtures, name);
        const file = fs.existsSync(asFixture) ? asFixture : path.join(dir, name);
        // Refuse anything that escapes the two locations we mean to serve.
        if (!file.startsWith(dir) && !file.startsWith(fixtures)) {
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

// Chromium's SwiftShader fallback: CI has no GPU, and the renderer needs a
// real WebGL2 context to upload into.
const LAUNCH = { args: ["--use-gl=angle", "--use-angle=swiftshader"] };

// Runs `fn(page, port)` against a served payload, tearing both down after.
export async function withPayload(variant, fn, routes = {}) {
    const server = await serve(variant.dir, routes);
    const browser = await chromium.launch(LAUNCH);
    const page = await browser.newPage();
    try {
        await fn(page, server.address().port, browser);
    } finally {
        await browser.close();
        server.close();
    }
}
