// Tests dist/esm: the one form of this package a consumer can `import` with no
// build configuration and no sibling files to serve.
//
// It is worth its own file because everything about it is a resolution and
// loading concern, and those fail in ways unit tests cannot see. What broke
// before it existed: `import "gds-lens"` resolved to src/gds-lens.js, which
// pulls in viewer.js, which needs `.html`/`.css` text imports, a `lil-gui-css`
// alias, and the wasm factory already present as a global. No consumer had any
// of those, so the package's documented entry point could not be loaded by
// Node or by any bundler.
//
// Skipped when dist/esm has not been built (npm run build).
import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "node:url";

import { chromium } from "./payload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const esmDir = path.join(__dirname, "..", "dist", "esm");
const bundle = path.join(esmDir, "gds-lens.js");
const fixtures = path.join(__dirname, "fixtures");

const built = fs.existsSync(bundle);
const skip = !built ? "dist/esm/gds-lens.js not built" : false;

// The exports map is the whole point, so assert on it rather than on a path we
// happen to know. Node self-references a package by its own name when it has
// an `exports` field, which is exactly the resolution a consumer performs.
test("the package's main entry resolves to the bundled module", { skip }, async () => {
    const resolved = import.meta.resolve("gds-lens");
    assert.match(resolved, /dist\/esm\/gds-lens\.js$/,
                 `"." resolved to ${resolved}`);

    // src/viewer.js cannot be imported by anything -- it needs a global
    // factory and text imports -- so it must not be offered.
    assert.throws(() => import.meta.resolve("gds-lens/viewer"),
                  "gds-lens/viewer is still exported but cannot be loaded");
});

// Importing in Node, with no DOM at all. This is what an SSR framework does on
// the server before a browser is ever involved, and it threw
// "HTMLElement is not defined" until the element stopped extending HTMLElement
// directly -- a class declaration is evaluated at import time, so the throw
// came from loading the module rather than from using it. Nothing here can
// render; the whole claim is that importing does not throw.
test("the main entry imports where there is no DOM", { skip }, async () => {
    assert.equal(typeof globalThis.HTMLElement, "undefined",
                 "this test proves nothing if the runner provides a DOM");

    const module = await import("gds-lens");
    assert.equal(typeof module.GdsLens, "function", "GdsLens is not exported");

    // And registers nothing, since there is nothing to register into. The
    // element is defined on the client, when the same module loads there.
    assert.equal(typeof globalThis.customElements, "undefined");
});

test("the bundled module carries everything it needs", { skip }, async () => {
    const text = await fs.promises.readFile(bundle, "utf8");

    // No imports at all: an unresolved bare specifier here is precisely the
    // failure this build exists to prevent, and it would only surface in a
    // consumer's bundler.
    const imports = text.match(/(?:^|[;}\s])import\s*[({'"]/g) || [];
    const bareImports = imports.filter((m) => !m.includes("("));
    assert.deepEqual(bareImports, [], "the bundle has unresolved static imports");

    // The pieces that used to live in sibling files. The host is checked by
    // something only its implementation contains -- matching "gdsLensHost"
    // proves nothing, because viewer.js reads that global itself, so the
    // identifier was in the bundle for years while the host was not.
    assert.match(text, /createBrowserHost/, "the default host is not bundled");
    assert.match(text, /gds-lens:named-views/,
        "the default host is bundled but not its localStorage-backed saved views");
    assert.match(text, /lil-gui/, "lil-gui is not bundled");
    assert.match(text, /type:\s*"module"/, "the worker is not created as a module worker");

    // One copy of the wasm module, not two. It is inlined as text and shared
    // between the main thread and the Worker (see engine-source.esm.js); a
    // second copy would add ~190 KB gzipped for nothing.
    const wasmCopies = (text.match(/wasmExports\s*=\s*await createWasm\(\)/g) || []).length;
    assert.equal(wasmCopies, 1, "the wasm module appears to be inlined more than once");
});

// Serves the bundle plus test/fixtures, as an ordinary consumer page would.
function serve(routes) {
    const TYPES = { ".js": "text/javascript", ".gds": "application/octet-stream",
                    ".gz": "application/octet-stream", ".html": "text/html" };
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
        if (routes[name]) {
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end(routes[name]);
        }
        const asFixture = path.join(fixtures, name);
        const file = fs.existsSync(asFixture) ? asFixture : path.join(esmDir, name);
        if (!file.startsWith(esmDir) && !file.startsWith(fixtures)) return res.writeHead(403).end();
        fs.readFile(file, (err, data) => err
            ? res.writeHead(404).end()
            : (res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }),
               res.end(data)));
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Deliberately no scripts other than the module itself, and no CSP: this is
// the page from the README's quick start, and the claim being tested is that
// nothing else is required.
const consumerPage = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  html, body { margin: 0; height: 100% }
  gds-lens { display: block; width: 100%; height: 100% }
</style></head><body>
<gds-lens src="SRC"></gds-lens>
<script type="module" src="gds-lens.js"></script>
</body></html>`;

// The default host is the half of the package that talks to the environment:
// the .lyp and marker pickers, saved views, drag-and-drop, ?src=. In the
// served payloads it arrives as gds-lens-host.js, which a consumer of the
// bundled module has no way to load -- so the bundle has to carry it. It did
// not, and the symptom was a console error insisting no layout would ever
// appear on a page whose layout had loaded perfectly well.
test("importing the module installs a working default host",
     { skip: skip || (!chromium && "playwright's chromium is missing") }, async () => {
    const server = await serve({ "index.html": consumerPage.replace("SRC", "sample_layout.gds") });
    const browser = await chromium.launch({
        args: ["--use-gl=angle", "--use-angle=swiftshader"],
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        assert.equal(await page.evaluate(() => typeof window.gdsLensHost), "object",
            "no default host was installed");
        // connect() ran, which is what publishes the surface and binds
        // drag-and-drop. Its absence is how the missing host went unnoticed:
        // the element's own load() does not go through the host at all.
        assert.equal(await page.evaluate(() => typeof window.gdsLens?.load), "function",
            "the host never called connect()");

        // The controls the viewer removes when the host cannot back them.
        const ui = await page.evaluate(
            () => document.querySelector("gds-lens").shadowRoot.textContent);
        assert.match(ui, /Load \.lyp/, "the .lyp picker was removed: no pickLyp on the host");
        assert.match(ui, /Load Marker File/, "the marker picker was removed: no pickMarkers");

        assert.deepEqual(consoleErrors, [],
            `the console should be clean: ${consoleErrors.join(" | ")}`);
    } finally {
        await browser.close();
        server.close();
    }
});

for (const fixture of ["sample_layout.gds", "sample_layout.gds.gz", "sample_layout.oas"]) {
    test(`a page with only the module loads ${fixture}`,
         { skip: skip || (!chromium && "playwright's chromium is missing") }, async () => {
        const server = await serve({ "index.html": consumerPage.replace("SRC", fixture) });
        const browser = await chromium.launch({
            args: ["--use-gl=angle", "--use-angle=swiftshader"],
        });
        const page = await browser.newPage();
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
        try {
            await page.goto(`http://127.0.0.1:${server.address().port}/`);

            // The overlay hides once geometry is on the GPU, which means the
            // module instantiated, the module Worker started from a blob, the
            // parse ran and the upload landed -- the whole chain, with nothing
            // served but the one file.
            await page.waitForFunction(
                () => document.querySelector("gds-lens")?.shadowRoot
                    ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
                { timeout: 60_000 });

            const loadError = await page.evaluate(
                () => document.querySelector("gds-lens").shadowRoot
                    .getElementById("loadError").innerText.trim());
            assert.equal(loadError, "", `the viewer reported: ${loadError}`);

            // fixtures/sample_layout has shapes on two layers.
            const stats = await page.evaluate(
                () => document.querySelector("gds-lens").shadowRoot
                    .getElementById("ui").innerText);
            assert.match(stats, /Polygons:\s*[1-9]/, `no geometry reached the renderer: ${stats}`);

            assert.deepEqual(pageErrors, [], "the page threw");
        } finally {
            await browser.close();
            server.close();
        }
    });
}
