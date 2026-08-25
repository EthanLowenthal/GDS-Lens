// Tests the React integration the README documents, by building and running
// the wrapper component from it.
//
// It exists because those examples make claims about React specifically that
// nothing else here can check: that a ref is set before the effect that uses
// it, that a method called before the engine has finished mounting queues
// rather than throwing, that the `src` prop reaches the element as an
// attribute, and that unmounting and remounting reuses the parked viewer
// instead of building a second one. Every one of those is a fact about React's
// commit order or about the element, not about the viewer, so a hand-written
// page cannot stand in for it.
//
// React is a devDependency for this file alone -- nothing in the package
// depends on it, and the component below is deliberately a copy of what the
// README tells people to write rather than something exported from src/.
//
// Skipped unless dist/esm has been built (npm run build).

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { chromium } from "./payload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const esmDir = path.join(root, "dist", "esm");
const fixtures = path.join(__dirname, "fixtures");

const built = fs.existsSync(path.join(esmDir, "gds-lens.js"));
const skip = !built ? "dist/esm/gds-lens.js not built"
    : !chromium ? "playwright's chromium is missing"
    : false;

// The wrapper component from the README's "Using it from React", verbatim in
// substance, plus the harness that drives it. Written as a string and bundled
// rather than kept as a .jsx file so the repo needs no JSX build of its own.
const APP = `
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "gds-lens";

function LayoutViewer({ bytes, lyp, onError }) {
    const ref = useRef(null);

    useEffect(() => {
        if (!bytes) return;
        let cancelled = false;
        ref.current.load(bytes).catch((err) => {
            if (!cancelled) onError?.(err);
        });
        return () => { cancelled = true; };
    }, [bytes, onError]);

    useEffect(() => {
        if (lyp) ref.current.setLyp(lyp.name, lyp.text);
    }, [lyp]);

    return <gds-lens ref={ref} style={{ width: "400px", height: "300px" }} />;
}

function App() {
    const [bytes, setBytes] = useState(null);
    const [lyp, setLyp] = useState(null);
    const [mounted, setMounted] = useState(true);
    const [errors, setErrors] = useState([]);

    // Reached from the test rather than from any UI.
    window.harness = {
        setBytes, setLyp, setMounted,
        errors: () => errors,
    };

    return mounted
        ? <LayoutViewer bytes={bytes} lyp={lyp} onError={(e) => setErrors((p) => [...p, String(e)])} />
        : <p id="unmounted">unmounted</p>;
}

createRoot(document.getElementById("root")).render(<App />);
`;

// Serves the bundled app plus the fixtures it fetches.
function serve(appJs) {
    const PAGE = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
        <body><div id="root"></div><script type="module" src="app.js"></script></body></html>`;
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
        if (name === "index.html") {
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end(PAGE);
        }
        if (name === "app.js") {
            res.writeHead(200, { "Content-Type": "text/javascript" });
            return res.end(appJs);
        }
        const file = path.join(fixtures, name);
        if (!file.startsWith(fixtures)) return res.writeHead(403).end();
        fs.readFile(file, (err, data) => err
            ? res.writeHead(404).end()
            : (res.writeHead(200, { "Content-Type": "application/octet-stream" }), res.end(data)));
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// One bundle for every test in this file: JSX transformed, React and the
// package resolved exactly as a consumer's bundler would resolve them.
async function bundleApp() {
    const result = await build({
        stdin: { contents: APP, resolveDir: root, loader: "jsx", sourcefile: "app.jsx" },
        bundle: true,
        write: false,
        format: "esm",
        target: "es2022",
        jsx: "automatic",
        // React reads this to pick its development or production build; without
        // it the bundle throws on `process is not defined`.
        define: { "process.env.NODE_ENV": '"production"' },
        logLevel: "warning",
    });
    return result.outputFiles[0].text;
}

const withApp = async (fn) => {
    const server = await serve(await bundleApp());
    const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader"] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err).split("\n")[0]));
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await fn(page, pageErrors);
        assert.deepEqual(pageErrors, [], "the React app threw");
    } finally {
        await browser.close();
        server.close();
    }
};

// The bundle is the claim that `import "gds-lens"` needs no configuration: no
// JSX pragma, no alias, no `ssr: false`. If esbuild cannot resolve the package
// through its exports map, this is where it shows up.
test("the documented wrapper component builds and mounts", { skip }, async () => {
    await withApp(async (page) => {
        await page.waitForFunction(
            () => !!document.querySelector("gds-lens")?.shadowRoot?.getElementById("glCanvas"),
            { timeout: 60_000 });
    });
});

// The ordering claim: React sets a ref during commit, before effects run, so
// the effect's ref.current.load() is called on a connected element -- and the
// element's own methods await `ready`, so a call made while the wasm module is
// still instantiating queues instead of throwing.
test("load() from an effect works before the engine has finished mounting", { skip }, async () => {
    await withApp(async (page) => {
        await page.evaluate(async () => {
            const bytes = new Uint8Array(
                await fetch("sample_layout.gds").then((r) => r.arrayBuffer()));
            window.harness.setBytes(bytes);
        });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        const loadError = await page.evaluate(
            () => document.querySelector("gds-lens").shadowRoot
                .getElementById("loadError").innerText.trim());
        assert.equal(loadError, "", `the viewer reported: ${loadError}`);
        assert.deepEqual(await page.evaluate(() => window.harness.errors()), [],
            "onError fired");
    });
});

// setLyp through a prop change, which is the pattern for everything that is a
// method rather than an attribute.
test("a prop change drives a method on the element", { skip }, async () => {
    const lyp = fs.readFileSync(path.join(fixtures, "sample.lyp"), "utf8");
    await withApp(async (page) => {
        await page.evaluate(async () => {
            window.harness.setBytes(new Uint8Array(
                await fetch("sample_layout.gds").then((r) => r.arrayBuffer())));
        });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });

        await page.evaluate((text) => window.harness.setLyp({ name: "sample.lyp", text }), lyp);
        // fixtures/sample.lyp names the two layers sample_layout.gds draws on.
        await page.waitForFunction(
            () => document.querySelector("gds-lens").shadowRoot.textContent.includes("METAL1"),
            { timeout: 10_000 });
    });
});

// The claim that makes a route change cheap: unmounting parks the viewer, and
// the element that replaces it adopts the same one. The canvas node is the
// evidence -- it is moved, not rebuilt, so the GL context and the geometry
// already on it survive.
test("unmounting and remounting reuses the parked viewer", { skip }, async () => {
    await withApp(async (page) => {
        await page.evaluate(async () => {
            window.harness.setBytes(new Uint8Array(
                await fetch("sample_layout.gds").then((r) => r.arrayBuffer())));
        });
        await page.waitForFunction(
            () => document.querySelector("gds-lens")?.shadowRoot
                ?.getElementById("loadingOverlay")?.classList.contains("hidden"),
            { timeout: 60_000 });
        await page.evaluate(() => {
            window.canvasBefore = document.querySelector("gds-lens").shadowRoot
                .getElementById("glCanvas");
        });

        await page.evaluate(() => window.harness.setMounted(false));
        await page.waitForFunction(() => !!document.getElementById("unmounted"), { timeout: 10_000 });
        assert.equal(await page.evaluate(() => document.querySelector("gds-lens")), null,
            "the element should be gone while unmounted");

        await page.evaluate(() => window.harness.setMounted(true));
        await page.waitForFunction(
            () => !!document.querySelector("gds-lens")?.shadowRoot?.getElementById("glCanvas"),
            { timeout: 30_000 });

        assert.ok(await page.evaluate(
            () => document.querySelector("gds-lens").shadowRoot
                .getElementById("glCanvas") === window.canvasBefore),
            "the remounted element built a new canvas instead of adopting the parked viewer");
    });
});
