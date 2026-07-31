# Developing GDS Lens

Developer documentation for building and hacking on the extension. For usage,
see [`README.md`](README.md).

## Project layout

- `src/extension.cjs` — the extension host (Node). Opens the layout file
  (`.gds` / `.oas` / `.oasis`), streams its raw bytes into the webview, and
  relays the `.lyp` and marker file pickers.
- `src/viewer.html` / `src/viewer.js` — the webview: bootstraps the wasm
  module and wires up `postMessage` from the extension host.
- `src/marker-parsers.js` — standalone parsers for DRC/LVS marker databases
  (KLayout `.lyrdb`, Calibre DRC ASCII); loaded in the webview via a
  `<script>` tag and `require()`d directly by the unit tests.
- `src/wasm/` — C++ source (`bindings.cpp`, `renderer.cpp`, `gds_common.hpp`)
  compiled with Emscripten into `src/wasm/build/gdstk_wasm.js`, which does
  GDSII/OASIS parsing and WebGL rendering. Which of gdstk's two readers runs
  is decided by sniffing the file header in `gds_common.hpp`, so no caller
  has to know the format. See `docs/rendering-rewrite.md` for the design
  history of this C++/WASM architecture.
- `third_party/gdstk`, `third_party/qhull` — git submodules the wasm build
  links against.
- `test/` — plain-Node tests (`npm test`): marker-parser unit tests plus
  headless tests that eval the built wasm bundle in Node (skipped when
  `src/wasm/build/gdstk_wasm.js` hasn't been built) covering marker state and
  the GDSII/OASIS readers. `test/fixtures/sample_layout.{gds,oas}` are the
  same KLayout-built design written in both formats.

## Building

GDS parsing and WebGL rendering run in a C++/WebAssembly module (`src/wasm/`,
built against the bundled `gdstk` submodule). Building it requires the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(`emcc`/`emcmake` on `PATH`). After installing the SDK and initializing
submodules (`git submodule update --init --recursive`):

```sh
npm run build:wasm
```

This configures and builds `src/wasm/build/gdstk_wasm.js`, which
`src/extension.cjs` loads into the webview at runtime. Re-run it after
changing any `src/wasm/*.cpp` file or the `gdstk`/`third_party/qhull`
submodules.

## Running

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded, then open a `.gds` or `.oas` file.

## Layout size limits

Parsing, flattening and triangulating all happen inside a 32-bit WebAssembly
module, so everything has to fit in one 4 GB address space
(`-sMAXIMUM_MEMORY` in `src/wasm/CMakeLists.txt` — Emscripten's default is
only 2 GB). What that buys, measured against generated stress layouts:

- **Flat geometry is the expensive case.** ~1 KB per polygon end to end
  (gdstk polygon + triangulated vertices + the typed arrays handed to JS), so
  a couple of million top-level polygons is the practical ceiling.
- **Hierarchy is nearly free.** A cell placed at least `kInstanceThreshold`
  (8) times anywhere in the design becomes a GPU instance batch — 24 bytes per
  placement instead of a full geometry copy. A hierarchy that flattens to
  115M polygons loads in ~2 GB; the same 4 GB budget is exhausted somewhere
  under 1G.

Past that the module aborts. The abort is a JS throw, so it's caught in
`wasm-worker.js`, run through `describeLoadFailure` (`src/load-errors.js`) to
turn engine strings like `memory access out of bounds` / `Aborted()` into an
explanation, and shown in the viewer's `#loadError` panel. Files larger than
`MAX_LAYOUT_BYTES` (2 GB) are refused by the extension host before they're
even read, since the raw bytes alone have to be copied into that same heap.

Note that `#ui` — the upper-left readout — is `display:none` outside debug
mode, so it must never be the only place an error is written.

## Known issues

- `eslint.config.mjs` imports `globals`, which isn't a declared dependency —
  `npx eslint` currently fails with `ERR_MODULE_NOT_FOUND`.
