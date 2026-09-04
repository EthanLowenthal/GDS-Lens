# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

From 1.0.0 on, a breaking change to the element's API waits for a major
version. Before that, `0.x` releases changed it freely.

## [1.2.0] - 2026-09-03

### Added

- `gds-load` and `gds-error` events on the element, dispatched however a load
  was started -- the `src` attribute, `load()`, or a host pushing bytes through
  its surface. Until now a load that came from `src` could fail only into the
  viewer's own error panel, with nothing for the embedding page to observe.
  `detail` carries `{ layerCount, cellCount }` and `{ message }` respectively.
  Prefixed rather than `load` / `error`, which every HTML element already has
  with other types attached.
- `showLoading(label?)` on the element. The surface had it; a page fetching its
  own bytes and calling `load(bytes)` could not reach it without `ready`, so it
  sat on "No layout loaded" for the length of the download.
- A message when WebGL2 cannot be had: unsupported, disabled, or the page over
  its limit on live contexts. The renderer's `main()` returns quietly when its
  context creation fails -- which is what lets the same module run in the parse
  worker and under Node, where there is no canvas -- and nothing on the other
  side ever asked, so the result was a canvas that never drew and a `load()`
  that reported success. The viewer now asks (`isGlReady`) and says so, and a
  lost context (`webglcontextlost`, after a GPU reset or the browser reclaiming
  it) is reported the same way rather than left as a black canvas.

### Changed

- `load()` settles on the outcome. It used to resolve as soon as the file had
  been handed to the parse worker, so it never rejected on a file the parser
  refused -- contrary to what the React docs claimed of it. It now resolves
  once the layout is on screen and rejects with the same message the viewer
  shows. A load superseded by a newer one rejects with an error named
  `AbortError`, the name `fetch()` uses for the same thing.

- The demo page's layout is served as gzipped OASIS rather than gzipped GDSII:
  the same design, 4.4 MB down from 8.1 MB. `site/make-demo-assets.py` writes
  OASIS now.

### Fixed

- The parse worker wrote a dozen lines to the console on every load, into the
  embedding page's DevTools, whether or not tracing had been asked for. The
  relay to the on-screen debug panel was always meant to be unconditional; the
  copy to the real console was not. It is now gated on the same flag as the
  main thread's breadcrumbs (the `debug` attribute or `?gdsDebug=1`). The test
  meant to catch this filtered on `[GDS]`, and the worker's prefix is
  `[GDS worker]`.
- `destroy()` did not release the viewer. Six listeners on `window` (the
  keyboard shortcuts and the coordinate menu's dismissal) were never removed,
  and a listener's closure holds the whole viewer, wasm instance included; the
  renderer's own `mouseup` and `resize` callbacks on `window` did the same from
  the other side, and the WebGL context waited on garbage collection. Every
  listener now carries an abort signal that `dispose()` fires, and the renderer
  exports a `destroyRenderer()` that unregisters its callbacks and destroys the
  context outright -- so a page calling `destroy()` because it hit the per-page
  context cap gets its slot back when it asks, not when the collector gets to
  it.
- Two quick changes to `src` (or two `load(url)` calls) could show the older
  layout: the viewer superseded an in-flight *parse*, but the fetch in front of
  it was nobody's to cancel, so a slow first file landing after a small second
  one won. Each `load()` now aborts the fetch before it, and a load parked on
  gzip expansion notices it has been superseded when it wakes.

## [1.1.0] - 2026-08-31

### Added

- Touch: one finger pans the layout, two pinch to zoom about the point between
  them and drag the view with it. Lifting one finger of a pinch hands the
  gesture to the other rather than ending it, so a pinch that relaxes into a
  drag does not jump.

### Changed

- On a touch-only device (a coarse pointer *and* no hover, so a touchscreen
  laptop is not one) the control panel starts collapsed to its title bar, and
  both it and the cell hierarchy are capped at 85% of the viewport width. A
  panel sized for a window is most of a phone screen, and the layout is what
  someone opening the viewer came for.
- Measure mode is offered greyed out where there is no hovering pointer. It is
  placed by clicking two points, and without hover the snap indicator only
  appears after the tap that already used it, under a fingertip.
- The demo page drops its tagline, its file button, its status line and its
  what-this-is-built-from footer line below 620px. Two of those cannot work on
  touch anyway: there is no drag-and-drop, and the file picker's extension
  filter greys out `.gds`/`.oas` in the iOS Files app.

### Fixed

- Touch input did not work at all on iOS. The gestures were handled in the
  renderer, through `emscripten_set_touchstart_callback`, and that callback
  never runs on iOS Safari: the events reach the canvas and the handler behind
  them does not fire. Emscripten resolves mouse and touch targets through the
  same code path, so the mouse handlers next to them were fine, which is what
  made this invisible from a desktop. The gestures are now ordinary listeners
  on the element, driving the camera through the exported `getCamera` /
  `setCamera` -- the same arithmetic, with nothing between the DOM event and
  the state it changes. Covered by a test that spells out the touch lists.
- A two-finger pinch over the viewer zoomed the page on iOS instead of the
  layout. Safari answers a pinch with its own page zoom, delivered as a
  proprietary `GestureEvent`, and it does that over an element that has already
  claimed the gesture with `touch-action: none`. Refused on the canvas alone,
  so a pinch anywhere else in an embedding page still zooms it.

## [1.0.3] - 2026-08-31

### Fixed

- Thin shapes vanished when "merge overlapping shapes" was on. The merge pass
  builds a screen-space coverage mask out of fill triangles, but with infill
  off a layer is normally drawn as outlines -- and a GL line covers at least
  one fragment, while the triangles of a 0.5 um waveguide at fit zoom are about
  0.04 px across and cover no sample at all. Every waveguide in a full-die view
  simply disappeared. The mask now rasterises the outline edges as well as the
  fill, so what merge mode shows is what the layer draws. Raising the mask's
  supersampling was not the fix: even 8x still misses 0.04 px, at 16x the
  memory.
- `[` and `]` jumped into a different marker category. The step walked every
  category that was ticked visible, so with a marker selected in a hidden
  category the first press left it for an unrelated result somewhere else in
  the file. Stepping now stays inside the selected marker's own category
  whenever that category is hidden, including when the step runs off the end of
  the list.

## [1.0.2] - 2026-08-25

### Changed

- Marker-file warnings are spelled out rather than counted. The `⚠ N warnings`
  row is a folder now, with one wrapping row per warning inside it. The
  sentences used to live only in a hover title and a `?gdsDebug=1` console
  line, so the one thing the row existed to report -- a marker may be in the
  wrong place, a value was not drawn -- was the one thing it did not say.

### Fixed

- Right-click -> "Copy coordinate" did nothing. The menu is dismissed by a
  `pointerdown` listener on `window`, which asked whether the menu contained
  `event.target` -- but the viewer moved into a shadow root in 1.0.0, and an
  event from inside one is retargeted to the `<gds-lens>` host by the time it
  reaches `window`. The menu therefore hid itself (`display: none`) on the very
  press that was landing on its own item, so the button never became a click.
  The menu opened and showed the right coordinate throughout, which is what
  made it look alive.
- The keyboard guard that keeps `m`, `h` and `/` from reaching the viewer while
  someone is typing in one of lil-gui's text boxes, broken by the same
  retargeting: it saw the host element rather than the focused input for every
  keystroke, so typing in a filter box could switch modes, toggle the hierarchy
  tree, or move focus.

## [1.0.1] - 2026-08-25

### Fixed

- The background grid vanished after a reload. Reloading deletes the old
  file's vertex buffers, which also clears them out of the bound VAO's
  attribute bindings -- leaving the grid's attribute-less fullscreen draw
  pointing at an enabled array with no buffer behind it, which WebGL rejects
  and skips. Only the grid was affected (the layer draws rebind every frame),
  and it stayed missing until the next frame was requested.
- The link to `examples/multi-view.html` in the README and in
  `docs/embedding.md`. The example lives in the repository rather than in the
  package, so a relative link to it was broken for anyone reading the docs
  from an installed copy; both now point at GitHub and say why.

## [1.0.0] - 2026-08-25

### Added

- Several `<gds-lens>` elements can now be live on one page. Each drives its
  own viewer, with its own WebAssembly instance and WebGL2 context, so a `.lyp`
  or marker database applied to one leaves the others alone. A second element
  used to refuse visibly rather than contend for the renderer's state.
- `destroy()` on the element, releasing a viewer's WebAssembly instance and GL
  context for good. Rarely needed -- an ordinary unmount parks the viewer
  instead, which is what makes a framework remount free.
- `docs/react.md`: a wrapper component, the JSX type declaration for React 18
  and 19, server rendering, and what remounting does. The examples are covered
  by `test/react.test.js`, and the type declaration by
  `test/types/jsx-smoke.tsx`.
- `showLoading(label?)` on the viewer surface, for the wait before `load()`:
  a host that is fetching bytes can say so instead of leaving the viewer
  looking idle. The element calls it itself when `load()` is given a URL.
- `examples/multi-view.html`: six viewers on one page -- three loading a layout
  from `src`, three waiting for a button -- including applying a `.lyp` and a
  marker database to one viewer alone, and creating and releasing a viewer to
  keep a WebGL context free.
- `docs/embedding.md`, which is where the `ViewerHost` interface, the three
  builds, the subpath exports and the WebAssembly limits moved to. The README
  keeps the quick start and the element's own API and is a third of its previous
  length.

### Fixed

- Saved views were shared by every viewer on the page. Each read the whole set
  at mount and wrote the whole set back on save, so two viewers that both saved
  a view overwrote each other and the last one won. The default host now keeps a
  bucket per viewer, keyed by the element's `id`, else its `src`, else -- for a
  page with a single viewer and neither -- the key it has always used. `loadViews`
  and `saveViews` are handed the viewer asking, which is what a host serving
  several needs to tell them apart. A viewer with no `id` and no `src` on a page
  with others has nothing stable to key on: its views last for the life of the
  page. Views previously saved on a page whose element carries a `src` are not
  carried into the new per-layout bucket.
- The renderer sized its drawing buffer to the window rather than to the canvas
  element, which was only ever right for a viewer filling the page. In an
  embedded `<gds-lens>` the browser stretched a window-sized buffer over the
  element's box, so the layout was drawn distorted; every coordinate the mouse
  produced -- the readout, the ruler, the right-click "Copy coordinate",
  zoom-at-cursor -- answered for a pixel the pointer was not on; and each viewer
  allocated a window-sized buffer and mask texture however small it was on
  screen. It now sizes from the element, and a `ResizeObserver` on the canvas
  keeps it in step with a box that changes without the window changing.
- The canvas right-click menu passed viewport coordinates to the renderer and
  clamped itself against the window, so in an embedded viewer it opened in the
  wrong place and reported the coordinate of a different pixel.
- A viewer that had not been asked for a layout showed "Loading layout..." over
  an empty progress bar, which read as a load that had hung. It now says "No
  layout loaded" until something actually asks for one.
- `import "gds-lens"` shipped no default host. `sideEffects` in package.json
  did not list `src/hosts/browser.js`, whose whole purpose is the side effect
  of installing `window.gdsLensHost`, so every bundler dropped it -- including
  the one that builds `dist/esm`. The documented entry point therefore came up
  with no `.lyp` or marker pickers, no saved views, no drag-and-drop, no
  `window.gdsLens`, and a console error claiming no layout would ever appear on
  pages whose layout had loaded perfectly well. The served payloads were never
  affected, since they load `gds-lens-host.js` as a separate script.

  The `esm-bundle` test that was meant to catch this asserted on the string
  `gdsLensHost`, which viewer.js contains anyway; it now looks for the host's
  own implementation.
- A viewer adopted while its WebAssembly module was still starting failed to
  come up at all, reporting `Cannot set properties of null (setting 'width')`.
  `ready` resolves as soon as the viewer is built, which is well before `main()`
  creates the GL context, so an element could be removed and its viewer adopted
  inside that window -- and `adopt` re-pointed the module's DOM root on the next
  turn of the module promise, which is after `main()` has already read it. It
  now writes through the object Emscripten uses *as* the Module, so the new root
  is in place immediately.
- An element whose parked viewer had been adopted by another element went on
  driving it, so a stray `load()` or `src` change on a detached element wrote
  into whatever was on screen. Such an element now rejects instead.
- Removing a `<gds-lens>` before its engine finished loading raised an unhandled
  promise rejection, which reached the embedding app's error reporting.
- An element removed and re-added before its engine arrived built two viewers,
  orphaning the first one's WebAssembly instance and WebGL context behind the
  second's shadow tree.
- The viewer no longer assigns `window.onerror`, which clobbered the embedding
  page's handler. Page-level failures are reported through an added listener
  and fanned out to whichever debug panels are open.

### Changed

- `src/viewer.js` exports `createViewer(element)` instead of doing its work in
  its module body, which is what allows more than one viewer. `window.gdsLensHost`
  is consequently read when each viewer mounts rather than once at import, so an
  app can install a host any time before its first `<gds-lens>` renders.
- `src/mount-target.js` is gone. It existed only to hand an element to
  viewer.js's module body, which is now a parameter.

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

[Unreleased]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/EthanLowenthal/GDS-Lens/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/EthanLowenthal/GDS-Lens/releases/tag/v0.1.0
