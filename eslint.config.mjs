import globals from "globals";

// Every source file here is an ES module now, but they still run in four
// different places, and `no-undef` is only worth having if it knows which one
// a file is in: the viewer's main thread (browser, plus the globals the
// classic <script> tags before it define), the parse Worker (no DOM), the
// pure modules that must run anywhere, and the tests and build scripts (Node).
// One block covering all of them could only be the union of their globals,
// which is the same as not checking `no-undef` at all.

// Defined by files loaded as classic <script> tags ahead of the bundles, so
// they are globals rather than imports: gdstk_wasm.js is Emscripten's output
// and lil-gui is a minified upstream build. See scripts/build-webview.mjs.
const vendorGlobals = {
    createGdstkModule: "readonly",
    lil: "readonly",
};

// The same set for every block: these are the mistakes worth a warning in a
// codebase this size, not a style guide.
const rules = {
    "no-const-assign": "warn",
    "no-this-before-super": "warn",
    "no-undef": "warn",
    "no-unreachable": "warn",
    // A leading underscore is this codebase's "required by the signature, not
    // used here" marker, and dropping such a parameter would change the ones
    // that follow.
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    "constructor-super": "warn",
    "valid-typeof": "warn",
};

const module_ = (files, globalSet) => ({
    files,
    languageOptions: { globals: globalSet, ecmaVersion: 2022, sourceType: "module" },
    rules,
});

export default [
    {
        // Generated, vendored and built output, none of it ours to fix.
        // .vscode-test-web/ is a whole VS Code web distribution: flat config
        // doesn't skip dot-directories on its own, and its multi-megabyte
        // single-line bundles run the linter out of memory rather than merely
        // slowing it down.
        ignores: ["src/wasm/build/**", "src/vendor/**", "dist/**", ".vscode-test-web/**"],
    },
    // The viewer's main thread: browser globals plus the vendored ones.
    module_(["src/viewer.js"], { ...globals.browser, ...vendorGlobals }),
    // The parse Worker: its own global scope, with no DOM in it.
    module_(["src/wasm-worker.js"], { ...globals.worker, ...vendorGlobals }),
    // Hosts run on the main thread and touch the DOM, but nothing vendored.
    module_(["src/hosts/*.js"], { ...globals.browser }),
    // The pure modules: no DOM, no wasm, importable from Node, a worker or an
    // extension host. Deliberately *not* Node's global set, so a `Buffer`,
    // `process` or `__dirname` creeping in is a warning rather than a crash
    // that only happens in a browser.
    module_(
        ["src/cell-search.js", "src/marker-parsers.js", "src/load-errors.js",
         "src/layout-bytes.js", "src/coord-parse.js"],
        { ...globals.worker }),
    {
        // The browser smoke test straddles both: the file runs in Node, but
        // the bodies it hands to page.evaluate() are serialized and run inside
        // Chromium, so `window` and `document` in them are real.
        files: ["test/browser-smoke.test.js"],
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
