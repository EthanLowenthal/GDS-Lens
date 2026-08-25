# GDS Lens

GDSII and OASIS chip layouts, parsed and rendered in the browser. A drop-in
custom element wrapping [gdstk](https://github.com/heitzmann/gdstk) compiled to
WebAssembly and a WebGL2 renderer.

Reading and rendering only. Writing layouts is deliberately out of scope.

> **Status: pre-release, not yet published to npm.** The API is unstable and
> will change.

## Quick start

```sh
npm install gds-lens
```

```js
import "gds-lens";   // registers <gds-lens>
```

```html
<gds-lens src="chip.gds" style="width: 100%; height: 600px"></gds-lens>
```

That's the whole thing. Pan with the mouse, zoom with the wheel. The import
pulls in one self-contained module — the parser, the renderer, the WebAssembly
binary and the control panel — so there is nothing to copy and nothing else to
serve.

Or drive it from JavaScript:

```js
import "gds-lens";

const viewer = document.createElement("gds-lens");
viewer.style.cssText = "width: 100%; height: 600px";
document.body.append(viewer);

await viewer.load("chip.gds");        // a URL, or bytes you already have
await viewer.goToPoint(120.5, -40);   // centre on a coordinate, in microns
```

### Or serve the files instead

If you would rather serve a payload than bundle one — for a smaller download
and a streaming WebAssembly compile — copy `dist/web/` and load its scripts in
order. The order matters: both must precede `gds-lens.js`, which reads them as
it starts.

```html
<script src="gds-lens-engine.js"></script>  <!-- the wasm module -->
<script src="gds-lens-host.js"></script>    <!-- the default ViewerHost -->
<script src="gds-lens.js"></script>         <!-- the element -->

<gds-lens src="chip.gds" style="width: 100%; height: 600px"></gds-lens>
```

#### What each file is

Six files, of which four are load-bearing:

| File | | What it is |
|---|---|---|
| `gds-lens.js` | required | The element, the viewer and the control panel. This is the package. Load it **last**. |
| `gds-lens-engine.js` | required | gdstk's GDSII/OASIS reader and the WebGL2 renderer, compiled to WebAssembly. Defines the `createGdstkModule` global `gds-lens.js` looks for, which is why it goes first. The parse worker loads it too. |
| `gds-lens-engine.wasm` | required | The binary, fetched by `gds-lens-engine.js` from beside it. `inline-wasm` embeds it instead. |
| `gds-lens-worker.js` | required | The parse worker: reads and triangulates off the main thread so the canvas stays responsive. Fetched by the worker, never by your page. |
| `gds-lens-host.js` | optional | The default `ViewerHost` (below). Omit it if you set `window.gdsLensHost` yourself before `gds-lens.js` runs. |
| `gds-lens.html` | optional | A working reference page. Read it for the script order; no need to deploy it. |

Every name carries the package prefix because these get copied into someone
else's web root, where a bare `host.js` or `wasm-worker.js` is a collision
waiting to happen. Serve them from one directory, in the order above.

`dist/web/gds-lens.html` is a working page doing exactly this. Everything in the
payload must be on the same origin as the page: the WebAssembly binary and the
parse worker are both fetched relative to the scripts.

## What it does

- **Parses GDSII and OASIS.** Format and gzip are both detected from the
  leading bytes rather than the filename. The reader is gdstk itself, which is
  what other implementations validate against.
- **Renders with WebGL2.** Layer-batched vertex buffers, GPU instancing for
  repeated cells, and a stroke font, all in C++ compiled alongside the parser.
- **Reads `.lyp` layer properties** for colours, fill styles and layer names.
- **Browses DRC/LVS markers** from `.lyrdb` report databases and ASCII DRC
  results.
- **Navigates hierarchy**, searches cells and labels, and measures distances.

## Installing

The package ships prebuilt: no Emscripten toolchain is required to consume it.
Installing straight from a git URL will not work, because `dist/` is built in
CI rather than committed.

---

# Reference

## `<gds-lens>`

### Attributes

| Attribute | Description |
|---|---|
| `src` | URL of a layout to fetch and display. Setting it later reloads. |

### Properties and methods

| Member | Returns | Description |
|---|---|---|
| `ready` | `Promise<Viewer>` | Resolves once the engine has mounted. Every method below awaits this, so you rarely need it directly. |
| `load(source, options?)` | `Promise<void>` | `source` is a URL string, a `Uint8Array`, or an `ArrayBuffer`. `options.reload` keeps the current camera and layer visibility instead of framing the design. |
| `goToPoint(x, y)` | `Promise<boolean>` | Centres on a coordinate in microns and flashes a crosshair. Resolves `true` if the point is inside the layout. |
| `setLyp(name, text)` | `Promise<void>` | Applies a `.lyp` layer-properties file. Pass `""` to clear. |
| `setMarkers(name, text)` | `Promise<void>` | Applies a marker database. Format is sniffed from the content. |
| `showError(message)` | `Promise<void>` | Replaces the view with an error message. |

The element is `display: block` with no intrinsic height, so give it one.

### One at a time

The renderer keeps its state in module-scope globals, so only one `<gds-lens>`
can be *live* at a time. A second one alongside the first refuses visibly
rather than fighting it for the same WebGL context.

Removing one and adding another is fine, though, which is what matters in a
framework: React and friends recreate the node on re-render, and an SPA route
change destroys and rebuilds it. The engine is not torn down when the element
leaves the DOM — the next `<gds-lens>` to connect has it moved into it, keeping
the WebGL context, the parsed design and the camera. Nothing reloads.

## Embedding: the `ViewerHost` interface

The viewer never touches the environment directly. Anything only an embedder
can do goes through a host object, which you install as `window.gdsLensHost`
before the element script runs. Leave it unset and a default host handles a
plain web page: `<input type=file>` for the pickers, `localStorage` for saved
views, `prompt()` for a name, plus `?src=` and drag-and-drop for loading.

Two things the default host does to the page, both of which a replacement host
inherits responsibility for and neither of which the element itself does: it
publishes the viewer surface as `window.gdsLens`, so a plain page can drive it
from a script tag or the console; and it binds drag-and-drop to the
`<gds-lens>` element rather than to `window`, which leaves the rest of the
page's own drop targets alone.

Every method is optional. The viewer hides the control for anything a host
does not implement, so a read-only embed can supply almost none of it.

| Method | Returns | Called when |
|---|---|---|
| `pickLyp()` | `Promise<{name, text} \| null>` | The user asks for a `.lyp`. `null` means cancelled. |
| `unloadLyp()` | `void` | The loaded `.lyp` is dismissed. |
| `pickMarkers()` | `Promise<{name, text} \| null>` | The user asks for a marker database. |
| `unloadMarkers()` | `void` | The loaded marker database is dismissed. |
| `loadViews()` | `Promise<View[]>` | Once at mount, for saved camera positions. |
| `saveViews(views)` | `void` | The saved-view set changed. Persist it. |
| `promptViewName(existing)` | `Promise<string \| null>` | A view is being saved. `existing` is the names already used. |
| `requestReload()` | `void` | The user asks to re-read the layout. |
| `setAutoReload(on)` | `void` | The user asks to always reload on change. |
| `onGotoResult({ok, x, y})` | `void` | A `goToPoint` finished, reporting whether it landed inside. |
| `isLightTheme()` | `boolean` | The viewer needs to know the theme. Defaults to the OS preference. |
| `createWorker()` | `Worker` | The parse Worker is needed. Override where the scripts cannot be fetched by URL. |
| `connect(viewer)` | `void` | At mount, handing you the surface below. |

### The viewer surface

`connect(viewer)` gives you the other direction, for pushing into the viewer
rather than answering it:

| Method | Description |
|---|---|
| `load(bytes, {reload})` | Display a layout from bytes. |
| `showError(message)` | Show a fatal error. |
| `setLyp(name, text)` | Apply layer properties. |
| `setMarkers(name, text)` | Apply a marker database. |
| `showStale(text)` | Offer a reload, for when the file changed underneath. |
| `goToPoint(x, y)` | Centre on a coordinate. |
| `toggleDebug()` | Show or hide the debug panel. |
| `setNamedViews(views)` | Replace the saved-view set. |
| `applyTheme()` | Re-ask `isLightTheme()` after a theme change. |
| `element` | The `<gds-lens>` the viewer is mounted in. Bind anything of your own to this rather than to `window`, so it stays inside the component. |

### Example

```js
window.gdsLensHost = {
    async pickLyp() {
        const text = await fetch("/pdk/layers.lyp").then((r) => r.text());
        return { name: "layers.lyp", text };
    },
    isLightTheme: () => document.documentElement.dataset.theme === "light",
    connect(viewer) {
        myApp.on("layout", (bytes) => viewer.load(bytes));
    }
};
```

## Subpath exports

The parsers are pure JavaScript with no DOM and no WebAssembly, so they import
cleanly into Node, a worker, or an extension host.

| Import | Exports |
|---|---|
| `gds-lens` | `GdsLens`, and registers `<gds-lens>`. The bundled module — everything inlined |
| `gds-lens/parsers` | `parseMarkerFile`, `parseLyrdb`, `parseDrcAscii`, `sniffMarkerFormat`, `parsePointList`, `flattenMarkerModel` |
| `gds-lens/layout-bytes` | `decodeLayoutBytes`, `looksGzipped`, `gzipStoredSize` |
| `gds-lens/coord-parse` | `parseCoordinatePair` |
| `gds-lens/cell-search` | `rankCellMatches`, `cellPathToTarget` |
| `gds-lens/load-errors` | `describeLoadFailure`, `isOutOfMemory`, `describeDecodeFailure` |
| `gds-lens/hosts/browser` | `createBrowserHost` |
| `gds-lens/web/*` | The prebuilt payload, for hosts that serve files rather than bundle |
| `gds-lens/inline-wasm/*` | The same payload with the binary embedded, for hosts that cannot fetch |
| `gds-lens/esm/*` | The bundled module by path, if you would rather not rely on `.` |

TypeScript declarations ship for all of these.

### The three builds

`import "gds-lens"` gets you `dist/esm/`, and that is the right default. The
other two are there for cases it cannot cover.

|  | `esm` | `web` | `inline-wasm` |
|---|---|---|---|
| How it arrives | `import "gds-lens"` | scripts you serve | scripts you serve |
| Files to serve | none | 4 (+2 optional) | 3 (+2 optional) |
| Bundler configuration | none | n/a | n/a |
| Total transfer, gzipped | 252 KB | 235 KB | 243 KB |
| Streaming WebAssembly compile | no | yes | no |
| Binary cached separately from the JS | no | yes | no |
| Sensitive to the page's encoding | no | no | yes |
| Needs `blob:` in `script-src` | yes | no | no |

**`esm`** is one file with everything inside it: the markup, the styles,
lil-gui, the default host, the WebAssembly binary and the parse worker's whole
script. Nothing is fetched, so nothing has to be served or copied, and no
bundler needs configuring. It costs the streaming compile and about 17 KB over
the payload.

Both the main thread and the parse worker need Emscripten's module, and a
worker cannot share the main thread's copy. Rather than inline it twice — which
would add ~190 KB gzipped for nothing — it is inlined once as text and loaded
from a `blob:` URL by both. That is the one thing this build asks of a page's
CSP that the others do not: `blob:` in `script-src`, on top of the `worker-src
blob:` all three need.

**`web`** is the payload to serve if you can. `gds-lens-engine.js` fetches
`gds-lens-engine.wasm` from beside it, so serve the two together; the binary
compiles as it streams and is cached on its own.

**`inline-wasm`** is `web` with the binary embedded in `gds-lens-engine.js`, for
hosts that cannot fetch a file next to their own scripts — a VS Code webview
cannot, from a Worker or from the main thread. Nothing else differs.

On that last row: `inline-wasm` embeds the binary as a raw string, so
`gds-lens-engine.js` has to be *decoded* as UTF-8 or it is corrupted, and the module
then fails with a `WebAssembly.instantiate()` error about section lengths that
says nothing about the cause. Either `Content-Type: text/javascript;
charset=utf-8` or `<meta charset="UTF-8">` on the page satisfies it; only the
absence of both breaks. That payload warns in the console when the document is
not UTF-8. `esm` escapes its non-ASCII, so it does not care.

### Compressed layouts

Gzip is handled for you: `<gds-lens src="chip.gds.gz">` works, and so does a
plain `.gds` that is secretly gzipped, because the format is decided by magic
number rather than by filename. Expansion happens in JavaScript rather than
inside the WebAssembly heap, which is the one address space that can least
afford a second copy of the file, and it is capped at 2 GB.

The same decoder is exported if you want it separately — to check a file before
handing it over, say:

```js
import { decodeLayoutBytes } from "gds-lens/layout-bytes";

const result = await decodeLayoutBytes(new Uint8Array(await file.arrayBuffer()));
if (result.ok) await viewer.load(result.bytes);
else console.error(result.reason);   // "too-large" | "corrupt"
```

## Limits

Parsing, flattening and triangulating all happen inside a 32-bit WebAssembly
module, so everything has to fit in one 4 GB address space.

- **Flat geometry is the expensive case**, at roughly 1 KB per polygon end to
  end, so a couple of million top-level polygons is the practical ceiling.
- **Hierarchy is nearly free.** A cell placed eight or more times becomes a GPU
  instance batch: 24 bytes per placement rather than a full geometry copy. A
  design that flattens to 115M polygons loads in about 2 GB.

Past that the module aborts, and the error is turned into an explanation rather
than an engine string.

## Building from source

Requires the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(`emcc`/`emcmake` on `PATH`) and Python 3.10+ for its driver scripts. macOS's
system `python3` is 3.9 and fails with a `TypeError` on `list[str] | None`;
with [uv](https://docs.astral.sh/uv/):

```sh
uv python install 3.13
export EMSDK_PYTHON="$(uv python find 3.13)"
```

Then:

```sh
git submodule update --init --recursive
npm install
npm run build:wasm     # all three -> src/wasm/build/{web,inline,esm}/
npm run build          # -> dist/{web,inline-wasm,esm}/
npm test
```

`npm run build:wasm:web`, `:inline` and `:esm` build one variant each; `npm run
build` then produces whichever outputs it finds the wasm for, and says which it
skipped. The three differ only in link flags, but CMake caches those, so each
gets its own build tree.

`npm test` includes browser tests that need Chromium
(`npx playwright install chromium`); they skip if it is missing. The end-to-end
load test runs once per built payload.

Before publishing, `npm run check:dist` and `npm run check:package` verify that
the payloads are present and no newer than their sources, and that the tarball
carries nothing it should not. `prepublishOnly` runs both.

## Licence

MIT, see [`LICENCE.md`](LICENCE.md).

The payload carries third-party code in two places. Statically linked into the
WebAssembly: [gdstk](https://github.com/heitzmann/gdstk) (BSL-1.0), Clipper
(BSL-1.0), [Qhull](http://www.qhull.org) (Qhull licence),
[earcut.hpp](https://github.com/mapbox/earcut.hpp) (ISC) and
[zlib](https://github.com/madler/zlib) (zlib licence) - and `gds-lens-engine.js` is
itself [Emscripten](https://github.com/emscripten-core/emscripten)'s output
(MIT/NCSA). Bundled into the JavaScript beside it:
[lil-gui](https://github.com/georgealways/lil-gui) (MIT).

Every notice is reproduced in
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md). Qhull's licence in
particular requires its notice to accompany any distribution that includes it,
and its original source can be obtained from
[qhull.org](http://www.qhull.org).
