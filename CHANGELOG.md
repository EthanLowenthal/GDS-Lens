# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.x` the public API may change in any release. See the
status note at the top of the README.

## [Unreleased]

## [0.1.1] - 2026-08-25

Nothing shipped in this release behaves differently. It exists because 0.1.0
was published by hand -- a trusted publisher can only be configured on a
package that already exists -- so this is the first tarball to go through the
tag-driven workflow, and the first to carry provenance.

### Changed

- A shorter README opening.

### Fixed

Release tooling only; none of it is in the package.

- `eslint .` no longer reads the Emscripten SDK's own config. The CI action
  unpacks the SDK *inside* the working tree, and the SDK ships an
  `eslint.config.mjs` importing a plugin only Emscripten depends on, so lint
  failed with `ERR_MODULE_NOT_FOUND` for a package this project has never
  heard of, before looking at a single file of its own.
- `check:package` reads `npm pack --dry-run --json` in both shapes npm emits:
  an array of packed-package objects on npm 11, the same objects keyed by
  package name on npm 12. It had destructured the array form, which fails as
  `TypeError: object is not iterable` -- naming neither npm nor a version.

Both of these could only fail in the publish job: it is the only place lint
runs alongside the SDK, and the only place npm is upgraded. `npm` is now
pinned to `^12` there rather than tracking `latest`, since the floor for
trusted publishing is 11.5.1 and a release is the worst place to learn that a
tool changed its output format.

## [0.1.0] - 2026-08-25

First release as a library.

GDS Lens was previously a VS Code extension, released under the tags `v1.0.0`
through `v1.6.3` and never published to npm. Those tags remain in the
repository as history; this is a different thing with a different API, so the
version starts again rather than continuing from `1.6.3`. The extension host
has been replaced by the `ViewerHost` interface, the viewer mounts as a
`<gds-lens>` custom element in a shadow root, and the payload is built for any
web page rather than for a webview.

### Added

- `<gds-lens>` custom element: `src`, `load`, `goToPoint`, `setLyp`,
  `setMarkers`, `showError`, `ready`.
- **`dist/esm/`, a single importable module.** `import "gds-lens"` now resolves
  to one file with the markup, styles, lil-gui, the default host, the
  WebAssembly binary and the parse worker's script all inside it -- no bundler
  configuration and no sibling files to serve. Built from a new
  `GDS_LENS_ESM` wasm variant (`-sEXPORT_ES6`). The binary is inlined once and
  shared with the worker through a `blob:` URL rather than inlined twice, which
  is why this build needs `blob:` in `script-src`; 252 KB gzipped. The module
  imports without a DOM, so a server render of a page that uses the element
  does not throw -- the element registers itself on the client, where
  `customElements` exists.
- `describeDecodeFailure` on `gds-lens/load-errors`, and `limit` on the failure
  result from `decodeLayoutBytes`.
- The `ViewerHost` interface, with every method optional -- the viewer removes
  the control for anything a host does not implement. A default host handles a
  plain page.
- Hand-written TypeScript declarations for the element, the host contract and
  every pure subpath export.
- Subpath exports for the parsers, which have no DOM and no WebAssembly:
  `gds-lens/parsers`, `/cell-search`, `/coord-parse`, `/layout-bytes`,
  `/load-errors`, `/hosts/browser`.
- Two prebuilt payloads, `gds-lens/web/*` and `gds-lens/inline-wasm/*`,
  differing only in whether the wasm binary is a separate file.
- `debug` attribute and `?gdsDebug=1` for trace output.
- Continuous integration: lint and the pure tests on every push, plus a lane
  that builds both wasm payloads and runs the browser suite against them.
  Publishing runs from a `v*` tag in the same way -- built and tested in the
  job that publishes it, so the tarball on the registry is one a green run
  produced rather than whatever a laptop had on disk. It authenticates with
  npm trusted publishing rather than a stored token, which also means the
  published tarball carries provenance: a signed statement of the commit and
  workflow that built it, verifiable with `npm audit signatures`.

### Changed

- **Every file in the served payloads carries the package prefix.** They get
  copied into someone else's web root, where `host.js`, `wasm-worker.js` and
  `gdstk_wasm.js` are collisions waiting to happen:

  | was | is |
  |---|---|
  | `host.js` | `gds-lens-host.js` |
  | `wasm-worker.js` | `gds-lens-worker.js` |
  | `gdstk_wasm.js` | `gds-lens-engine.js` |
  | `gdstk_wasm.wasm` | `gds-lens-engine.wasm` |
  | `viewer.html` | `gds-lens.html` |

  The `createGdstkModule` global is unchanged: it is distinctive enough not to
  clash, and it says what the module actually is.
- Lint runs `eslint:recommended` as errors rather than seven rules as
  warnings, so it can actually fail.
- `prepublishOnly` gates a publish on lint, tests and two checks:
  `scripts/check-dist.mjs`, which refuses a `dist/` that is missing, older than
  the sources it was built from, or still carrying a template placeholder; and
  `scripts/check-package.mjs`, which reads the file list npm would actually
  publish and refuses build output, object files, CMake artifacts, the wasm
  sources, or anything containing the build machine's home directory.
- Third-party notices now cover the whole payload, not only what is linked
  into the WebAssembly: zlib and Emscripten (in `gdstk_wasm.js`) and lil-gui
  (bundled into `gds-lens.js`) have been added.

### Fixed

- **`import "gds-lens"` works.** The main entry pointed at `src/gds-lens.js`,
  which pulls in `viewer.js` -- needing `.html`/`.css` text imports, a
  `lil-gui-css` alias that existed only inside this repo's build, and the wasm
  factory already present as a global. Nothing could load it: not Node, not any
  bundler. It now resolves to the bundled module above.
- **Gzipped layouts open.** `decodeLayoutBytes` was fully implemented and unit
  tested but had no caller anywhere in `src/`, so `.gds.gz` and `.oas.gz`
  failed with "Could not open this layout" despite the README advertising
  them. It is wired into the load path, which every entry point goes through.
  Bytes handed in as an `ArrayBuffer` are normalized too, so a compressed file
  arriving in that shape is detected rather than sailing past the sniff.
- **A removed `<gds-lens>` can be replaced.** The one-per-page guard was never
  cleared, so after the first element left the DOM every later one refused
  permanently -- which is what a framework re-render or an SPA route change
  does. The element now releases its claim on disconnect and the next one has
  the running engine moved into it, keeping the WebGL context, the parsed
  design and the camera.
- **An error message is no longer treated as markup.** A load failure's text
  can carry a filename, a gdstk string, or -- through the default host's
  `?src=` handling -- text straight from the URL, and it was concatenated into
  `innerHTML` for the debug readout. A crafted link could inject into the page.
  It is built as a text node now. Pages using the payload's own `viewer.html`
  were protected by its CSP; an embedder with a laxer policy was not.
- **The host page's `console` is no longer replaced.** The viewer overwrote
  `console.log` and `console.error` to feed its on-screen debug panel, so a
  host application's own logging appended to a detached `<div>` for the life of
  the page. Trace output now goes through an internal logger and reaches the
  console only when asked for.
- **Drag-and-drop no longer covers the whole page.** The default host bound
  `dragover`/`drop` to `window` and called `preventDefault`, which silently
  disabled the embedding application's own drop targets. Both are bound to the
  `<gds-lens>` element.
- **Neither the Emscripten build tree nor the C++ ships.** `files` in
  `package.json` is an allowlist that overrides `.gitignore`, so listing `src/`
  published the whole build directory: 211 object files and CMake caches,
  2.0 MB, with absolute paths from the build machine inside them. The wasm
  sources went with them, which is no better a use of an install -- a consumer
  gets the compiled payload and has no toolchain to rebuild it from
  `renderer.cpp`. A `!src/wasm` negation excludes both, and `check:package`
  fails on either coming back. The tarball is 39 files, 812 KB packed.
- **Absolute build paths no longer end up in the WebAssembly.** With no
  `CMAKE_BUILD_TYPE`, `NDEBUG` was never defined, so `assert()` stayed live in
  gdstk, earcut and libcxxabi -- each embedding `__FILE__` as the full path of
  the machine that compiled it, six of which shipped inside `gdstk_wasm.wasm`
  and the inline payload. `-ffile-prefix-map` rewrites the prefix, which also
  makes the binary reproducible across checkouts. The asserts are deliberately
  kept: this module parses untrusted layouts, and an assert turns a violated
  invariant into a clean abort the viewer already explains.
- Saved views coming back from `localStorage` are checked for being an array,
  not merely for parsing.
- The debug panel drops old lines past a cap instead of growing without bound.

### Accessibility

- Controls that were `<span>`s with click handlers are real buttons, so they
  can be reached and operated from the keyboard.
- The canvas is focusable and named; the hierarchy is a proper `tree` with
  per-row expanded state and depth.
- Load progress, load errors and the stale-file banner are announced;
  disclosures report `aria-expanded` and the search scope pair
  `aria-pressed`.
- The progress bars respect `prefers-reduced-motion`.

### Removed

- The `gds-lens/viewer` export. It pointed at `src/viewer.js`, which cannot be
  imported by anything -- it needs the wasm factory as a pre-loaded global and
  text imports for its markup and styles -- so it was a promise nothing could
  keep. The same surface is reachable through `element.ready`.
- `bindings.cpp` and its `parseGds` export, a second parse path with no
  caller, compiled into every build.
- The `loadAndRenderGds` export, also unused.
- The `#workerBundle` placeholder element, left over from the extension's
  worker-loading route and shipped unsubstituted. The `createWorker` host hook
  replaces it.

[Unreleased]: https://github.com/EthanLowenthal/GDS-Lens/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/EthanLowenthal/GDS-Lens/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/EthanLowenthal/GDS-Lens/releases/tag/v0.1.0
