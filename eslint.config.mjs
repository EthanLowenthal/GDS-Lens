import js from "@eslint/js";
import globals from "globals";

// Every source file here is an ES module now, but they still run in four
// different places, and `no-undef` is only worth having if it knows which one
// a file is in: the viewer's main thread (browser, plus the globals the
// classic <script> tags before it define), the parse Worker (no DOM), the
// pure modules that must run anywhere, and the tests and build scripts (Node).
// One block covering all of them could only be the union of their globals,
// which is the same as not checking `no-undef` at all.

// Emscripten's output is loaded as a classic <script> ahead of the bundles, so
// its factory is a global rather than an import. See scripts/build-webview.mjs.
const vendorGlobals = {
    createGdstkModule: "readonly",
};

// Substituted at bundle time by esbuild's `define`, one value per payload
// variant (see scripts/build-webview.mjs). Never assigned in source, and
// read only behind a typeof guard.
const buildFlags = {
    __GDS_LENS_INLINE_WASM__: "readonly",
    __GDS_LENS_WORKER_SOURCE__: "readonly",
};

// eslint:recommended, as errors, plus the handful worth adding on top. Errors
// rather than warnings on purpose: `eslint .` exits 0 on a warning, so a
// warn-only config cannot gate anything -- CI would go green on a real fault.
// Anything genuinely intended gets a disable comment at its own line, where a
// reader can see the reasoning, rather than being switched off repo-wide.
const rules = {
    ...js.configs.recommended.rules,
    // A leading underscore is this codebase's "required by the signature, not
    // used here" marker, and dropping such a parameter would change the ones
    // that follow.
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    // Not in recommended, and all four have caught real faults in code like
    // this: coordinate maths that compares mixed types, event handlers that
    // shadow an outer element ref, and loops over parser state.
    eqeqeq: ["error", "smart"],
    "no-shadow": "error",
    "no-unmodified-loop-condition": "error",
    "no-unused-private-class-members": "error",
    "prefer-const": "error",
    "no-var": "error",
    "no-throw-literal": "error",
};

const module_ = (files, globalSet) => ({
    files,
    languageOptions: { globals: globalSet, ecmaVersion: 2022, sourceType: "module" },
    rules,
});

export default [
    {
        // Generated, vendored and built output, none of it ours to fix.
        //
        // emsdk-cache is the Emscripten SDK, which the CI action unpacks
        // *inside* the working tree. It carries its own eslint.config.mjs, and
        // `eslint .` finding that config -- not the SDK's code, the config --
        // fails the whole run with ERR_MODULE_NOT_FOUND for a plugin only
        // Emscripten depends on. ci.yml never hit this because its lint lane
        // has no SDK; the publish job runs both, so it did.
        ignores: ["src/wasm/build/**", "dist/**", "emsdk-cache/**"],
    },
    // The viewer's main thread: browser globals plus the vendored ones.
    module_(["src/viewer.js", "src/gds-lens.js", "src/esm-entry.js",
             "src/engine-source.js", "src/engine-source.esm.js"],
        { ...globals.browser, ...vendorGlobals, ...buildFlags }),
    // The parse Worker: its own global scope, with no DOM in it.
    module_(["src/wasm-worker.js"], { ...globals.worker, ...vendorGlobals }),
    // Hosts run on the main thread and touch the DOM, but nothing vendored.
    module_(["src/hosts/*.js"], { ...globals.browser }),
    // The pure modules: no DOM, no wasm, importable from Node, a worker or an
    // extension host. Deliberately *not* Node's global set, so a `Buffer`,
    // `process` or `__dirname` creeping in is an error rather than a crash
    // that only happens in a browser.
    module_(
        ["src/cell-search.js", "src/marker-parsers.js", "src/load-errors.js",
         "src/layout-bytes.js", "src/coord-parse.js"],
        { ...globals.worker }),
    {
        // The browser tests straddle both: the files run in Node, but the
        // bodies they hand to page.evaluate() are serialized and run inside
        // Chromium, so `window` and `document` in them are real. The Pages
        // deploy check drives a browser the same way and belongs here too,
        // even though it lives under scripts/.
        files: ["test/browser-smoke.test.js", "test/custom-element.test.js",
            "test/host-contract.test.js", "test/viewer-ui.test.js",
            "test/esm-bundle.test.js", "test/react.test.js",
            "scripts/check-site.mjs"],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules,
    },
    // Tests and build tooling: real Node, and free to use Buffer and zlib to
    // build fixtures even where the code under test cannot.
    module_(["test/**/*.js", "scripts/**/*.mjs"], { ...globals.node }),
];
