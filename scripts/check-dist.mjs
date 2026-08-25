// Publish guard: refuses to ship a dist/ that is missing, stale or unfinished.
//
// `files` in package.json lists dist/, so `npm publish` includes whatever is
// there -- including nothing at all. A tarball with no payload installs
// cleanly and then 404s in the consumer's browser, which is the worst place to
// find out. This runs from prepublishOnly so that failure happens here.
//
// Three things get checked, each of which has actually gone wrong:
//   missing      a payload that was never built, or a dist/ wiped since
//   stale        a payload older than the C++ it was built from
//   unfinished   a {{placeholder}} left unsubstituted in the shipped HTML

import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Kept in step with build-webview.mjs's VARIANTS/COPY/BUNDLES: the payload is
// those three lists flattened, so this is what "complete" means.
const PAYLOADS = [
    { name: "web", files: ["gds-lens.html", "gds-lens.js", "gds-lens-worker.js", "gds-lens-host.js", "gds-lens-engine.js", "gds-lens-engine.wasm"] },
    { name: "inline-wasm", files: ["gds-lens.html", "gds-lens.js", "gds-lens-worker.js", "gds-lens-host.js", "gds-lens-engine.js"] },
    // One file on purpose: everything it needs is inside it.
    { name: "esm", files: ["gds-lens.js"] },
];

// Anything the payload is built from. A payload older than any of these was
// built before the current source and must not be published as if it were it.
const SOURCES = [
    "src/wasm/renderer.cpp", "src/wasm/lyp_util.cpp",
    "src/wasm/stroke_font.cpp", "src/wasm/shaders.hpp",
    "src/viewer.js", "src/gds-lens.js", "src/wasm-worker.js", "src/hosts/browser.js",
    "src/esm-entry.js", "src/engine-source.js", "src/engine-source.esm.js",
    "src/viewer-shell.html", "src/viewer.css", "src/viewer.html",
];

const problems = [];

const mtime = async (path) => {
    try {
        return (await stat(path)).mtimeMs;
    } catch {
        return null;
    }
};

// The newest source wins: a payload has to be at least as new as all of them.
let newestSource = 0;
let newestSourceName = null;
for (const source of SOURCES) {
    const at = await mtime(join(root, source));
    if (at === null) {
        problems.push(`${source}: listed in check-dist.mjs but not on disk`);
    } else if (at > newestSource) {
        newestSource = at;
        newestSourceName = source;
    }
}

for (const payload of PAYLOADS) {
    const dir = join(root, "dist", payload.name);
    for (const file of payload.files) {
        const path = join(dir, file);
        const at = await mtime(path);
        const shown = relative(root, path);

        if (at === null) {
            problems.push(`${shown}: missing -- run \`npm run build:wasm && npm run build\``);
            continue;
        }
        // One second of slack: the build copies files, and a copy can land in
        // the same tick as the source it came from.
        if (at + 1000 < newestSource) {
            problems.push(`${shown}: older than ${newestSourceName} -- rebuild before publishing`);
        }
        // Substitution is the build's job; one left behind means an unfinished
        // template shipped. See the note in build-webview.mjs.
        if (file.endsWith(".html")) {
            const text = await readFile(path, "utf8");
            const placeholder = text.match(/\{\{\s*\w+\s*\}\}/);
            if (placeholder) problems.push(`${shown}: unsubstituted placeholder ${placeholder[0]}`);
        }
    }
}

if (problems.length) {
    console.error("dist/ is not publishable:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
    process.exit(1);
}

console.log(`dist/ ok: ${PAYLOADS.map((p) => `${p.name} (${p.files.length} files)`).join(", ")}`);
