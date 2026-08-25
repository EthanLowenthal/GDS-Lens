# GDS Lens

GDSII & OASIS layout parsing and WebGL2 rendering for the browser - the engine
behind the [GDS Lens VS Code extension](https://github.com/EthanLowenthal/GDS-Lens-Vscode).

Reading and rendering only. Writing layouts is deliberately out of scope.

> **Status: pre-release (`0.0.0`), not yet published to npm.** The API is
> unstable and the extraction from the VS Code extension is still in progress.

## What's here

- **Parsing** - GDSII and OASIS, format and gzip both sniffed from the leading
  bytes rather than the filename. [`gdstk`](https://github.com/heitzmann/gdstk)
  compiled to WebAssembly, so the reader is the same one other implementations
  validate themselves against.
- **Rendering** - a WebGL2 renderer with layer-batched vertex buffers, GPU
  instancing for repeated cells, camera, measurement and a stroke font, written
  in C++ and compiled alongside the parser.
- **`.lyp`** colour/style support.
- **DRC/LVS markers** - `.lyrdb` and ASCII DRC databases.

## Building

Requires the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(`emcc`/`emcmake` on `PATH`) and a Python 3.10+ for the emscripten driver
scripts - macOS's system `python3` (3.9) is too old and fails with a
`TypeError` on `list[str] | None`. With [uv](https://docs.astral.sh/uv/):

```sh
uv python install 3.13
export EMSDK_PYTHON="$(uv python find 3.13)"
```

Then:

```sh
git submodule update --init --recursive
npm install
npm run build:wasm     # -> src/wasm/build/gdstk_wasm.js
npm test
```

`gdstk_wasm.js` is a build artifact: produced in CI, shipped in the npm
tarball, never committed.

## Licence

MIT - see [`LICENCE.md`](LICENCE.md).

The compiled WebAssembly statically links four third-party projects, all
permissive: [gdstk](https://github.com/heitzmann/gdstk) (BSL-1.0), Clipper
(BSL-1.0), [Qhull](http://www.qhull.org) (Qhull licence) and
[earcut.hpp](https://github.com/mapbox/earcut.hpp) (ISC). Qhull's licence
requires its notice to accompany any distribution that includes it; see
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md). Qhull's original source
can be obtained from [qhull.org](http://www.qhull.org).
