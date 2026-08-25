import globals from "globals";

// This repo is several JavaScript environments in one tree, so the config is
// several blocks rather than one: the webview's <script> files (browser, one
// shared global scope), the parse Worker (no DOM), the pure modules that must
// run anywhere, and the unit tests (CommonJS under Node). One block covering
// all of them can only be the union of their globals, which is the same as not
// checking `no-undef` at all: a `document` reference in a pure module would
// pass.

// The globals this repo's own files hand each other. Each of these is loaded
// into the webview as a plain <script> (see the load order at the bottom of
// viewer.html), so what one defines at top level is a global to the ones after
// it -- there is no module system in the webview to import across.
const webviewScriptGlobals = {
    // src/cell-search.js
    rankCellMatches: "readonly",
    cellPathToTarget: "readonly",
    // src/marker-parsers.js
    sniffMarkerFormat: "readonly",
    parsePointList: "readonly",
    parseLyrdb: "readonly",
    parseDrcAscii: "readonly",
    parseMarkerFile: "readonly",
    flattenMarkerModel: "readonly",
    // src/load-errors.js
    describeLoadFailure: "readonly",
    isOutOfMemory: "readonly",
    // src/hosts/*.js
    gdsLensHost: "readonly",
    // Not ours: produced by the wasm build and by the vendored copy of
    // lil-gui respectively.
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
    // A leading underscore is this codebase's "required by the signature,
    // not used here" marker -- the VS Code API hands its providers arguments
    // they have no use for, and dropping them from the parameter list would
    // change the ones that follow.
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    "constructor-super": "warn",
    "valid-typeof": "warn",
};

export default [
    {
        // Generated and vendored code. gdstk_wasm.js is Emscripten's output and
        // lil-gui is a minified upstream build; neither is ours to fix, and
        // between them they accounted for well over half of everything this
        // config reported -- which is how a lint run stops being read at all.
        //
        // dist/ is esbuild's bundle of our own sources, so linting it would
        // only ever report the same thing twice. .vscode-test-web/ is a whole
        // VS Code web distribution that `npm run test:web` downloads: flat
        // config doesn't skip dot-directories on its own, and its multi-megabyte
        // single-line bundles run the linter out of memory rather than merely
        // slowing it down.
        ignores: ["src/wasm/build/**", "src/vendor/**", "dist/**", ".vscode-test-web/**"],
    },
    {
        // The webview's main script. Browser globals, plus everything the
        // <script> tags before it defined.
        files: ["src/viewer.js"],
        languageOptions: {
            globals: { ...globals.browser, ...webviewScriptGlobals },
            ecmaVersion: 2022,
            sourceType: "script",
        },
        rules,
    },
    {
        // The standalone helpers the webview and the Node tests share. Loaded
        // as browser <script>s and require()d by the tests, which is why they
        // get both sets: the module.exports tail each one ends with is only
        // reachable in the second case (see the comment at the top of
        // load-errors.js).
        files: ["src/cell-search.js", "src/marker-parsers.js", "src/load-errors.js", "src/hosts/*.js"],
        languageOptions: {
            globals: { ...globals.browser, ...globals.commonjs },
            ecmaVersion: 2022,
            sourceType: "script",
        },
        rules,
    },
    {
        // The parse Worker: its own global scope with no DOM in it, and
        // gdstk_wasm.js + load-errors.js prepended into its bundle by the
        // extension host rather than imported.
        files: ["src/wasm-worker.js"],
        languageOptions: {
            globals: {
                ...globals.worker,
                createGdstkModule: "readonly",
                describeLoadFailure: "readonly",
            },
            ecmaVersion: 2022,
            sourceType: "script",
        },
        rules,
    },
    {
        // The pure modules this package exports for use outside a browser
        // (a VS Code extension host, a worker, plain Node). Pointedly *not*
        // Node's global set: they have to run anywhere, so the globals here
        // are the web platform's minus the DOM, plus CommonJS's
        // module/require. Declaring it this way is what turns a `Buffer`,
        // `process` or `__dirname` creeping into them into a lint warning
        // rather than a crash that only happens in a browser.
        files: ["src/layout-bytes.js", "src/coord-parse.js"],
        languageOptions: {
            globals: { ...globals.worker, ...globals.commonjs },
            ecmaVersion: 2022,
            sourceType: "commonjs",
        },
        rules,
    },
    {
        // Build tooling. Real Node, ESM, runs on a developer's machine and
        // never ships.
        files: ["scripts/**/*.mjs"],
        languageOptions: {
            globals: { ...globals.node },
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules,
    },
    {
        // The unit tests: Node, CommonJS, and free to use Buffer and zlib to
        // build fixtures even where the code under test can't. They use
        // node:test (required explicitly, no injected globals), so there is no
        // test framework's global set to add.
        files: ["test/**/*.js"],
        languageOptions: {
            globals: { ...globals.node },
            ecmaVersion: 2022,
            sourceType: "commonjs",
        },
        rules,
    },
];
