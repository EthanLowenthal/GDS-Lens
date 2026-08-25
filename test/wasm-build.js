// Locates a built gds-lens-engine.js for the tests that run the reader headlessly
// in Node.
//
// Two builds exist (see src/wasm/CMakeLists.txt) and either will do here:
// these tests exercise parseGdsToLayers's CPU half, not how the binary got
// loaded. The web build is preferred only because it is the default one.
// Emscripten resolves its sibling .wasm against __filename, which the eval
// below supplies, so both resolve without help.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// gds-lens-engine.js is Emscripten output targeting web+node, so it calls
// require() internally when it detects Node. ESM has none to hand it.
const require = createRequire(import.meta.url);

const candidates = ["web", "inline"].map(
    (name) => path.join(__dirname, "..", "src", "wasm", "build", name, "gds-lens-engine.js"));

export const wasmJsPath = candidates.find((p) => fs.existsSync(p)) || null;
export const skip = wasmJsPath ? false : "src/wasm/build/*/gds-lens-engine.js not built";

// MODULARIZE puts createGdstkModule in the script's own scope rather than
// exporting it, and this is a classic script, so it is eval'd with the four
// CommonJS names it expects and the factory lifted out afterwards.
export async function loadModule(args = {}) {
    const src = fs.readFileSync(wasmJsPath, "utf8");
    const scope = {};
    new Function("scope", "require", "__dirname", "__filename",
        src + "\nscope.createGdstkModule = createGdstkModule;")(
        scope, require, path.dirname(wasmJsPath), wasmJsPath);
    return scope.createGdstkModule(args);
}
