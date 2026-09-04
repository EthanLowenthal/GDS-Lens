# Embed the viewer

How to put the viewer somewhere other than a plain page: what a host is, which
of the three builds to reach for, and what the WebAssembly module can and
cannot do.

For the element's own API, see [the README](../README.md#the-gds-lens-element).
React specifically is covered in [React integration](react.md).

[`examples/multi-view.html`][example] is a working page of six viewers on the
default host: layouts arriving from `src` and from a button, a `.lyp` and a
marker database applied to one of them alone, and a viewer created and released
on demand. It is in the repository rather than in the package, so that link
goes to GitHub.

[example]: https://github.com/EthanLowenthal/GDS-Lens/blob/main/examples/multi-view.html

## The `ViewerHost` interface

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
does not implement, so a read-only embed can supply almost none of it. A host
can implement any of the following methods:

| Method | Returns | Called when |
|---|---|---|
| `pickLyp()` | `Promise<{name, text} \| null>` | The user asks for a `.lyp`. `null` means cancelled. |
| `unloadLyp()` | `void` | The loaded `.lyp` is dismissed. |
| `pickMarkers()` | `Promise<{name, text} \| null>` | The user asks for a marker database. |
| `unloadMarkers()` | `void` | The loaded marker database is dismissed. |
| `loadViews(viewer)` | `Promise<View[]>` | Once at mount, for saved camera positions. |
| `saveViews(views, viewer)` | `void` | The saved-view set changed. Persist it. |
| `promptViewName(existing)` | `Promise<string \| null>` | A view is being saved. `existing` is the names already used. |
| `requestReload()` | `void` | The user asks to re-read the layout. |
| `setAutoReload(on)` | `void` | The user asks to always reload on change. |
| `onGotoResult({ok, x, y})` | `void` | A `goToPoint` call finished, reporting whether it landed inside. |
| `isLightTheme()` | `boolean` | The viewer needs to know the theme. Defaults to the OS preference. |
| `createWorker()` | `Worker` | The parse Worker is needed. Where the scripts cannot be fetched by URL, override this. |
| `connect(viewer)` | `void` | At mount, handing you the surface described in the following section. |

### The viewer surface

`connect(viewer)` gives you the other direction, for pushing into the viewer
rather than answering it:

| Method | Description |
|---|---|
| `load(bytes, {reload})` | Display a layout from bytes. |
| `showLoading(label?)` | Say that a layout is on its way. Call it before fetching the bytes: a viewer that has not been handed anything shows "No layout loaded", and without this that is what it shows for the length of the download. |
| `showError(message)` | Show a fatal error. |
| `setLyp(name, text)` | Apply layer properties. |
| `setMarkers(name, text)` | Apply a marker database. |
| `showStale(text)` | Offer a reload, for when the file changed underneath. |
| `goToPoint(x, y)` | Center on a coordinate. |
| `toggleDebug()` | Show or hide the debug panel. |
| `setNamedViews(views)` | Replace the saved-view set. |
| `applyTheme()` | Re-ask `isLightTheme()` after a theme change. |
| `element` | The `<gds-lens>` the viewer is mounted in. Bind anything of your own to this rather than to `window`, so it stays inside the component. |

`load()` resolves once the layout is on screen and rejects when it fails (or
when a newer load supersedes it, with an `AbortError`). The viewer also
dispatches `gds-load` and `gds-error` on `element` for every load, however it
was started; see [Events](../README.md#events).

### Saved views on a page with several viewers

Both view methods are handed the viewer asking, which is the same surface
`connect` receives. A host serving one viewer can ignore it; a host serving
several needs it, or every viewer reads and writes one shared set and whichever
saves last overwrites the rest.

The default host keys its `localStorage` bucket per viewer, in this order: the
element's `id`, then its `src`, then -- for a page with a single viewer and
neither -- the one key it has always used. A viewer with none of the three has
nothing stable to key on, so its views last as long as the page does; give the
element an `id` to have them outlive it.

```html
<!-- two viewers, two sets of saved views, both still there tomorrow -->
<gds-lens id="before" src="rev-a.gds"></gds-lens>
<gds-lens id="after"  src="rev-b.gds"></gds-lens>
```

An embedder with a real document identity to key on -- a file path, a document
URI -- should implement `loadViews`/`saveViews` itself rather than inherit any
of that.

### Example: a custom host

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

## Serve the files instead of bundling

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

### What each file is

The payload is six files, four of which are required:

| File | Status | What it is |
|---|---|---|
| `gds-lens.js` | required | The element, the viewer, and the control panel. This is the package. Load it last. |
| `gds-lens-engine.js` | required | gdstk's GDSII and OASIS reader and the WebGL2 renderer, compiled to WebAssembly. Defines the `createGdstkModule` global `gds-lens.js` looks for, which is why it goes first. The parse worker loads it too. |
| `gds-lens-engine.wasm` | required | The binary, fetched by `gds-lens-engine.js` from beside it. `inline-wasm` embeds it instead. |
| `gds-lens-worker.js` | required | The parse worker: reads and triangulates off the main thread so the canvas stays responsive. Fetched by the worker, never by your page. |
| `gds-lens-host.js` | optional | The default `ViewerHost`, described in [The ViewerHost interface](#the-viewerhost-interface). If you set `window.gdsLensHost` yourself before `gds-lens.js` runs, omit it. |
| `gds-lens.html` | optional | A working reference page. For the script order, read this file; there is no need to deploy it. |

Every name carries the package prefix because these get copied into someone
else's web root, where a bare `host.js` or `wasm-worker.js` is a likely
collision. Serve them from one directory, in the preceding order.

`dist/web/gds-lens.html` is a working page doing exactly this. Everything in the
payload must be on the same origin as the page: the WebAssembly binary and the
parse worker are both fetched relative to the scripts.

## Subpath exports

The parsers are pure JavaScript with no DOM and no WebAssembly, so they import
cleanly into Node, a worker, or an extension host. The package exposes the
following entry points:

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
other two are there for cases it cannot cover. The following table compares
them:

| Property | `esm` | `web` | `inline-wasm` |
|---|---|---|---|
| How it arrives | `import "gds-lens"` | scripts you serve | scripts you serve |
| Files to serve | none | 4 (+2 optional) | 3 (+2 optional) |
| Bundler configuration | none | N/A | N/A |
| Total transfer, gzipped | 252 KB | 235 KB | 243 KB |
| Streaming WebAssembly compile | no | yes | no |
| Binary cached separately from the JS | no | yes | no |
| Sensitive to the page's encoding | no | no | yes |
| Needs `blob:` in `script-src` | yes | no | no |

**`esm`** is one file with everything inside it: the markup, the styles,
lil-gui, the default host, the WebAssembly binary, and the parse worker's whole
script. Nothing is fetched, so nothing has to be served or copied, and no
bundler needs configuring. It costs the streaming compile and about 17 KB over
the payload.

Both the main thread and the parse worker need Emscripten's module, and a
worker cannot share the main thread's copy. Rather than inline it twice —
which would add about 190 KB gzipped for nothing — it is inlined once as text
and loaded from a `blob:` URL by both. That is the one thing this build asks
of a page's CSP that the others do not: `blob:` in `script-src`, on top of
the `worker-src blob:` all three need.

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
inside the WebAssembly heap, which is where a second copy of the
file is most expensive, and it is capped at 2 GB.

The same decoder is exported if you want it separately — to check a file before
handing it over, say:

```js
import { decodeLayoutBytes } from "gds-lens/layout-bytes";

const result = await decodeLayoutBytes(new Uint8Array(await file.arrayBuffer()));
if (result.ok) await viewer.load(result.bytes);
else console.error(result.reason);   // "too-large" | "corrupt"
```

## Limits

Parsing, flattening, and triangulating all happen inside a 32-bit WebAssembly
module, so everything has to fit in one 4 GB address space. Two cases bound
what fits:

- **Flat geometry is the expensive case**. It costs roughly 1 KB per polygon
  end to end, so a couple of million top-level polygons is the practical
  ceiling.
- **Hierarchy is nearly free**. A cell placed eight or more times becomes a GPU
  instance batch: 24 bytes per placement rather than a full geometry copy. A
  design that flattens to 115 million polygons loads in about 2 GB.

Past that the module aborts, and the viewer turns the error into an explanation
rather than an engine string.
