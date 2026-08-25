# GDS Lens

GDSII and OASIS chip layouts, parsed and rendered in the browser. A drop-in
custom element wrapping [gdstk](https://github.com/heitzmann/gdstk) compiled to
WebAssembly and a WebGL2 renderer.

Reading and rendering only. Writing layouts is deliberately out of scope.

> **Status: pre-release, not yet published to npm.** The API is unstable and
> will change.

## Quick start

```html
<script type="module" src="gds-lens.js"></script>

<gds-lens src="chip.gds" style="width: 100%; height: 600px"></gds-lens>
```

That's the whole thing. Pan with the mouse, zoom with the wheel.

Or drive it from JavaScript:

```js
import "gds-lens";

const viewer = document.createElement("gds-lens");
viewer.style.cssText = "width: 100%; height: 600px";
document.body.append(viewer);

await viewer.load("chip.gds");        // a URL, or bytes you already have
await viewer.goToPoint(120.5, -40);   // centre on a coordinate, in microns
```

Serve `gds-lens.js` alongside the other files in the payload (below). They must
be on the same origin as the page: the WebAssembly binary and the parse worker
are both fetched relative to the scripts.

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

```sh
npm install gds-lens
```

The package ships prebuilt: no Emscripten toolchain required to consume it.
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

Sizing is yours: the element is `display: block` with no intrinsic height, so
give it one.

### One per page

The renderer keeps its state in module-scope globals, so only one `<gds-lens>`
can be active at a time. A second one refuses visibly rather than fighting the
first for the same WebGL context.

## Embedding: the `ViewerHost` interface

The viewer never touches the environment directly. Anything only an embedder
can do goes through a host object, which you install as `window.gdsLensHost`
before the element script runs. Leave it unset and a default host handles a
plain web page: `<input type=file>` for the pickers, `localStorage` for saved
views, `prompt()` for a name, plus `?src=` and drag-and-drop for loading.

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
| `gds-lens` | `GdsLens`, and registers `<gds-lens>` |
| `gds-lens/viewer` | `viewer`, the surface above, for mounting without the element |
| `gds-lens/parsers` | `parseMarkerFile`, `parseLyrdb`, `parseDrcAscii`, `sniffMarkerFormat`, `parsePointList`, `flattenMarkerModel` |
| `gds-lens/layout-bytes` | `decodeLayoutBytes`, `looksGzipped`, `gzipStoredSize` |
| `gds-lens/coord-parse` | `parseCoordinatePair` |
| `gds-lens/cell-search` | `rankCellMatches`, `cellPathToTarget` |
| `gds-lens/load-errors` | `describeLoadFailure`, `isOutOfMemory` |
| `gds-lens/hosts/browser` | `createBrowserHost` |
| `gds-lens/web/*` | The prebuilt payload, for hosts that serve files rather than bundle |
| `gds-lens/inline-wasm/*` | The same payload with the binary embedded, for hosts that cannot fetch |

### The two payloads

Use `dist/web/`. `gdstk_wasm.js` fetches `gdstk_wasm.wasm` from beside it, so
serve the two together.

`dist/inline-wasm/` is the same payload with the binary embedded in
`gdstk_wasm.js`, for hosts that cannot fetch a file next to their own scripts.
A VS Code webview is the case it was built for. Nothing else differs.

|  | `web` | `inline-wasm` |
|---|---|---|
| Module transfer, gzipped (JS + binary) | 188 KB | 196 KB |
| Streaming compile | yes | no |
| Binary cached separately from the JS | yes | no |
| Sensitive to the page's encoding | no | yes |

On the last row: the embedded binary is a raw string, so
`gdstk_wasm.js` has to be *decoded* as UTF-8 or it is corrupted, and the module
fails with a `WebAssembly.instantiate()` error about section lengths that says
nothing about the cause. Either `Content-Type: text/javascript; charset=utf-8`
or `<meta charset="UTF-8">` on the page satisfies it; only the absence of both
breaks. This payload warns in the console when the document is not UTF-8.

```js
import { decodeLayoutBytes } from "gds-lens/layout-bytes";

// Gzip is detected by magic number, not by extension.
const result = await decodeLayoutBytes(await file.arrayBuffer());
if (result.ok) viewer.load(result.bytes);
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
npm run build:wasm     # both variants -> src/wasm/build/{web,inline}/
npm run build          # -> dist/web/ and dist/inline-wasm/
npm test
```

`npm run build:wasm:web` and `npm run build:wasm:inline` build one variant
each; `npm run build` then produces whichever payloads it finds, and says which
it skipped.

`npm test` includes browser tests that need Chromium
(`npx playwright install chromium`); they skip if it is missing. The
end-to-end load test runs once per built payload.

## Licence

MIT, see [`LICENCE.md`](LICENCE.md).

The compiled WebAssembly statically links four permissive projects:
[gdstk](https://github.com/heitzmann/gdstk) (BSL-1.0), Clipper (BSL-1.0),
[Qhull](http://www.qhull.org) (Qhull licence) and
[earcut.hpp](https://github.com/mapbox/earcut.hpp) (ISC). Qhull's licence
requires its notice to accompany any distribution that includes it, so see
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md). Qhull's original source
can be obtained from [qhull.org](http://www.qhull.org).
