# GDSII View

A VS Code extension that adds a custom editor for `.gds` (GDSII layout)
files: open one and it's parsed and rendered in a WebGL2 canvas, with
support for loading a KLayout `.lyp` file to drive layer colors.

## Project layout

- `src/extension.cjs` — the extension host (Node). Opens the `.gds` file,
  streams its raw bytes into the webview, and relays the `.lyp` file picker.
- `src/viewer.html` / `src/viewer.js` — the webview: bootstraps the wasm
  module and wires up `postMessage` from the extension host.
- `src/wasm/` — C++ source (`bindings.cpp`, `renderer.cpp`, `gds_common.hpp`)
  compiled with Emscripten into `src/wasm/build/gdstk_wasm.js`, which does
  GDS parsing and WebGL rendering. See `docs/rendering-rewrite.md` for the
  design history of this C++/WASM architecture.
- `third_party/gdstk`, `third_party/qhull` — git submodules the wasm build
  links against.
- `test/` — extension test suite.

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
extension loaded, then open a `.gds` file.

## Features

- Parses and renders GDSII layouts directly in a VS Code webview.
- Optional KLayout `.lyp` file loading for custom layer colors.
- Handles SREF/AREF (including array references), rotation, mirroring, and
  magnification via gdstk's flattening.

## Known issues

- `eslint.config.mjs` imports `globals`, which isn't a declared dependency —
  `npx eslint` currently fails with `ERR_MODULE_NOT_FOUND`.

## Release notes

See `CHANGELOG.md`.
