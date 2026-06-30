# GDSII Viewer: C++/WASM Rewrite Plan

Status as of 2026-06-30: **done**. Both phases are implemented, build
cleanly, and have been manually verified in a real VSCode Extension
Development Host window (`F5`) against real sample files -- GDS loads,
parses, and renders in the webview canvas.

## Goal

Convert the VSCode extension from a Node-side JS GDS parser (`gdsii` npm package) +
JS/WebGL2 webview renderer into a single C++ application, built with Emscripten and
linked against `third_party/gdstk`, that owns **both** GDS parsing and WebGL rendering. The
extension host (`src/extension.cjs`, Node) is reduced to a thin shim: open the file,
shuttle raw bytes into the webview, relay the "load .lyp" file picker. Everything
GDS- and graphics-related lives in C++.

This was split into two phases:

1. **Parsing in C++/WASM** (DONE, verified) — replace the JS GDS parser with
   gdstk compiled to wasm.
2. **Rendering in C++/WASM** (DESIGNED, not yet implemented) — replace
   `src/viewer.js`'s WebGL2 code with C++ using Emscripten's GL bindings, so JS no
   longer touches geometry data at all.

---

## Phase 1 (done): gdstk parsing in WASM

### What exists on disk

- `third_party/gdstk` — git submodule, pinned at `29c86f9` (the GDSTK_VERSION read from
  `third_party/gdstk/include/gdstk/gdstk.hpp`).
- `third_party/qhull` — git submodule, pinned at tag `v8.0.2`. Only the
  reentrant C library (`src/libqhull_r/*.c`) is used — gdstk's `utils.cpp`
  calls `qh_new_qhull` etc. directly (see `third_party/gdstk/src/utils.cpp:22-23` and the
  `convex_hull()` function around line 590). No C++ qhull wrapper needed.
- `src/wasm/CMakeLists.txt` — builds gdstk's sources + qhull_r's sources +
  `src/wasm/bindings.cpp` directly into one Emscripten target. Does **not** reuse
  gdstk's own `CMakeLists.txt`/`find_package(ZLIB)`/`find_package(Qhull)`
  because those assume native (Homebrew) installs that don't exist for
  wasm32 — instead zlib comes from Emscripten's built-in port
  (`-sUSE_ZLIB=1` as both a compile and link flag — it must be on both or
  the headers aren't found), and qhull is compiled from source alongside
  everything else.
- `src/wasm/bindings.cpp` — embind glue exposing `parseGds(path: string) -> val`.
  Stages bytes into Emscripten's MEMFS (gdstk's `read_gds()` only takes a
  filename, it does real `FILE*` I/O), calls `gdstk::read_gds()` with
  `unit=1e-6` (normalizes every file to micron-scale coordinates regardless
  of native database unit — this is why `dbuPerMicron` is now always `1.0`),
  finds top-level cells via `Library::top_level()` (replaces the old JS
  heuristic that guessed the root cell from unreferenced-cell names), and
  flattens each with `Cell::get_polygons(apply_repetitions=true,
  include_paths=true, depth=-1, ...)` — this one call handles SREF, AREF
  (array references — the old JS parser silently ignored AREF/COLROW
  entirely, so this is a correctness fix, not just a port), rotation,
  mirroring, magnification, and path-to-polygon conversion, all of which
  the old JS code reimplemented by hand.
  - Filters out `$$$CONTEXT_INFO$$$`-style metadata cells that some tools
    (KLayout) emit as a sibling top-level cell.
  - Returns `{ok, error, dbuPerMicron, geometry: [{layer, points:
    Float64Array}, ...]}`. The Float64Array is built via
    `Float64Array.new_(count)` + `.set(typed_memory_view(...))`, which
    forces an immediate copy out of wasm linear memory during the embind
    call — safe even under `ALLOW_MEMORY_GROWTH=1` (growth can detach/move
    the underlying buffer, but only between calls, not mid-call).
  - Cleans up: `poly->clear(); free_allocation(poly);` per polygon,
    `lib.free_all()` at the end (this is gdstk's documented C++ idiom, see
    `third_party/gdstk/docs/cpp/filtering.cpp`).

### Build flags (current, see src/wasm/CMakeLists.txt)

```
-O3 --bind -sUSE_ZLIB=1 -sMODULARIZE=1 -sEXPORT_NAME=createGdstkModule
-sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web,node
-sEXPORTED_RUNTIME_METHODS=FS,ccall -sNO_EXIT_RUNTIME=1
-sSTACK_SIZE=8388608
```

Two non-obvious ones:

- **`-sSTACK_SIZE=8388608`**: gdstk's GDSII record reader keeps a stack
  buffer sized for the largest possible record (GDS records are
  length-prefixed with a `uint16`, so up to 64KB). Emscripten's default
  stack is only 64KB total, so `read_gds()` blew it immediately
  (`RuntimeError: stack overflow ... in gdstk::read_gds`) before this was
  raised to 8MB. If you ever see a stack-overflow RuntimeError again,
  this is the first thing to check.
- **`-sEXPORT_NAME=createGdstkModule` without `-sEXPORT_ES6`**: produces a
  plain global `var createGdstkModule = ...` (UMD-style), loadable from a
  classic `<script>` tag. Originally built with `EXPORT_ES6=1` but that
  needs `<script type="module">` plus extra webview CSP fiddling for
  imports; not worth it for what's otherwise a synchronous local call.
  `ENVIRONMENT=web,node` is wider than strictly needed (webview is "web"
  only) but costs nothing and made local testing under plain `node`
  possible — keep it unless there's a reason not to.

### Why MEMFS + filename API instead of passing bytes directly

`gdstk::read_gds(const char* filename, ...)` does `FILE*` I/O internally —
there's no in-memory/buffer-based read API in gdstk. The JS side does:

```js
Module.FS.writeFile('/input.gds', uint8ArrayOfFileBytes);
const result = Module.parseGds('/input.gds');
Module.FS.unlink('/input.gds'); // cleanup, optional but avoids MEMFS growth across files
```

### Verification done

Built a throwaway native (non-wasm) test binary
(`clang++` + Homebrew's `qhull`/`zlib`) running the same gdstk calls as
`bindings.cpp`, to get ground-truth output decoupled from the
embind/wasm transfer path — this caught that an early "all zeros" reading
was a misread of a genuinely-degenerate `(0,0,0,0,0,0,0,0)` polygon in the
test file, not a real bug. Worth redoing this kind of native cross-check
if the parsing path changes again.

Ran the wasm module against all 22 sample files in
`~/Downloads/gds_run/` (sizes 0.7KB–49MB). All parse successfully. Notable
timings (Apple Silicon, `node`, single run, includes module
instantiation):

| file | size | polygons | points | time |
|---|---|---|---|---|
| `laser_distribution_B.gds` | 49.4MB | 839,012 | 9,828,764 | 539ms |
| `row_B12.gds` | 16.7MB | 307,182 | 2,844,646 | 187ms |
| `thermal_diodes.gds` | 7.3MB | 229,536 | 918,144 | 136ms |
| `pl_gf_basic.gds` (original test file) | 30KB | 42 | 3,053 | <1ms |

This is the data point that justifies batching by layer instead of
per-polygon GL buffers in phase 2 (see below) — at 800K+ polygons, the old
JS renderer's "one `gl.createBuffer()` + one `gl.drawArrays()` per polygon"
approach would be the bottleneck, not parsing.

### Test harness (scratch, not committed)

A throwaway test script was used at
`/private/tmp/claude-502/.../scratchpad/test_all.mjs` (session-scoped
scratch dir, won't persist) — it does `createGdstkModule()` once, then for
each sample file: `FS.writeFile`, `parseGds`, sum up polygon/point counts,
`FS.unlink`. Recreate similarly if you need to re-verify after changes;
takes <5 lines.

---

## Phase 2 (designed, not implemented): C++/WebGL rendering

Decision made: **everything moves to C++**, not just the GL draw calls.
JS becomes pure bootstrap/glue:

```
viewer.html: <canvas id="glCanvas">, minimal CSS/DOM (ui overlay div,
             scale label, .lyp button), CSP with 'wasm-unsafe-eval'.
viewer.js:   instantiate the module, wire up `postMessage` from the
             extension host to two exported C++ entry points
             (load GDS bytes, load .lyp text), nothing else.
C++:         GL context + shaders + buffers + draw calls + camera
             (pan/zoom) state + input handling + layer coloring +
             .lyp parsing + scale-bar text computation.
```

### Why fold rendering into C++ instead of keeping the JS WebGL2 code

The current JS renderer's `parseGds()` → JS geometry array → per-polygon
`gl.createBuffer()`/`gl.bufferData()` round-trip means: for an 800K-polygon
file, gdstk builds ~800K `Polygon*` objects in C++, copies each one's
points into a JS `Float64Array` via embind (allocation + copy per
polygon), JS then iterates the array building 800K separate GL buffers.
That's three full passes over the data and ~1.6M small allocations
(800K Float64Arrays + 800K GL buffers) for files that already take >500ms
just to parse. Moving rendering into C++ means gdstk's flattened polygon
data goes straight from `Cell::get_polygons()` into batched GL vertex
buffers in the same process, with JS never touching per-polygon data at
all — only summary scalars (bbox, polygon count, current zoom/scale-bar
text) cross the JS/wasm boundary, once per frame at most.

### GL context setup

Use Emscripten's HTML5 API to attach directly to the existing canvas
instead of receiving a JS-passed context:

```cpp
EmscriptenWebGLContextAttributes attrs;
emscripten_webgl_init_context_attributes(&attrs);
attrs.majorVersion = 2;  // WebGL2 (the old code used "webgl2" already)
attrs.minorVersion = 0;
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx =
    emscripten_webgl_create_context("#glCanvas", &attrs);
emscripten_webgl_make_context_current(ctx);
```

Build flags to add: `-sUSE_WEBGL2=1 -sMIN_WEBGL_VERSION=2
-sMAX_WEBGL_VERSION=2 -sFULL_ES3=1` (lets C++ use GLES3 calls, which
Emscripten maps onto the WebGL2 context — the existing shaders are already
`#version 300 es`, i.e. GLES3/WebGL2 shading language, so they port
essentially unchanged).

### Shader porting

The existing GLSL in `src/viewer.js:12-28` (`vsSource`/`fsSource`) ports
directly as C string literals — no GLSL changes needed, just move the
`createShader`/`gl.attachShader`/`gl.linkProgram` calls to the GLES3 C
API (`glCreateShader`, `glShaderSource`, `glCompileShader`, etc.), same
structure as the JS version.

### Buffer strategy: batch by layer, not by polygon

This is the one real design change vs. a literal port. Old JS: one VBO +
one `drawArrays(LINE_LOOP, ...)` per polygon (renderData array of `{buffer,
count, color, layer}`). New plan: one VBO per **layer**, containing all of
that layer's polygons back-to-back, plus a small CPU-side array of
`(firstVertex, vertexCount)` pairs per polygon so each polygon can still
be drawn as its own `LINE_LOOP` (line loops can't be naively concatenated
into one draw call — the loop-closing edge would connect unrelated
polygons). Concretely:

- One `glBufferData` call per layer (not per polygon) — built once when a
  file loads, from gdstk's `get_polygons()` output directly.
- Render loop still issues one `glDrawArrays(GL_LINE_LOOP, first, count)`
  per polygon, but they all read from the same bound VBO per layer, so
  it's N draw calls + 1 buffer upload per layer instead of N draw calls +
  N buffer uploads total. If draw-call count itself becomes the
  bottleneck (worth profiling before optimizing further), the next step
  up is precomputing degenerate-triangle/primitive-restart joins so each
  layer is a single draw call — skip this unless profiling shows it's
  needed.
- Layer → color: replicate the existing JS fallback hash
  (`src/viewer.js:151-156`, `(layer*65)%200+55` etc.) in C++ for layers with
  no `.lyp` entry, plus a `std::unordered_map<uint32_t, vec4>` (or reuse
  gdstk's own `Map<T>` from `third_party/gdstk/include/gdstk/map.hpp`) populated from
  parsed `.lyp` text for layers that do.

### Input handling

Bind directly to the canvas via Emscripten's HTML5 event API instead of
JS `addEventListener` + forwarding:

```cpp
emscripten_set_mousedown_callback("#glCanvas", nullptr, false, on_mousedown);
emscripten_set_mousemove_callback("#glCanvas", nullptr, false, on_mousemove);
emscripten_set_mouseup_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, nullptr, false, on_mouseup);
emscripten_set_wheel_callback("#glCanvas", nullptr, false, on_wheel);
emscripten_set_resize_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, nullptr, false, on_resize);
```

Port the pan/zoom math directly from `src/viewer.js:200-214` — it's simple
enough (drag delta / zoom factor, wheel zoom by 1.15^±1) that it's a
straight translation, no redesign needed. Same for the
`updateScaleBar()`/scale-bar-step logic (`src/viewer.js:91-110`) — compute in
C++, but the result still needs to land on a DOM element
(`#scaleLabel`/`#scaleBar` width), which means either:
  - a tiny embind-exported `updateScaleBarDOM(text, widthPx)` called from
    C++ once per change (not per frame — only when zoom/dbu changes), or
  - keep the scale bar as a JS-side concern fed by an exported "get
    current zoom" call.
  First option is more in the spirit of "everything in C++"; it's one
  `val::global("document").call<val>("getElementById", ...)` or a small
  bound JS callback — either is fine, pick whichever is less fiddly when
  actually writing it.

### Render loop / redraw-on-demand

Old code redraws via `requestAnimationFrame(drawScene)` triggered only by
actual state changes (resize, new data, drag move, wheel), not a ticking
loop — keep that behavior (cheap given mostly-static layouts, no reason to
burn CPU redrawing 800K-polygon scenes every frame when nothing changed).
Emscripten equivalent: `emscripten_request_animation_frame(callback,
userdata)` called only from the input/data-change handlers, not
`emscripten_set_main_loop` (which runs continuously).

### Data flow from extension host (unchanged from phase-1 plan)

`src/extension.cjs` reads the raw `.gds` bytes (`vscode.workspace.fs.readFile`)
and `postMessage`s them to the webview. Since `engines.vscode` in
`package.json` is `^1.125.0` (well past the 1.57 threshold noted in
`@types/vscode`'s `Webview.postMessage` doc comment), an `ArrayBuffer`
payload is transferred efficiently and reconstructed as an `ArrayBuffer`
in the webview — no base64 needed even for the 49MB file. `.lyp` file text
(loaded via the existing `loadLypFile` file-picker round-trip,
`src/extension.cjs:64-80`) stays a plain string message, small.

In the webview, `src/viewer.js` becomes roughly:

```js
const Module = await createGdstkModule();
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    Module.FS.writeFile('/input.gds', new Uint8Array(msg.fileData));
    Module.loadAndRenderGds('/input.gds'); // new C++ entry point, replaces parseGds
    Module.FS.unlink('/input.gds');
  } else if (msg.type === 'lypLoaded') {
    Module.loadLypText(msg.text); // new C++ entry point, replaces parseLypText in JS
  }
});
vscode.postMessage({...}); // lypBtn click handler, unchanged
```

`loadAndRenderGds`/`loadLypText` are new embind-exported C++ functions
that supersede `bindings.cpp`'s current `parseGds` — they'd reuse the same
gdstk-calling code but build GL buffers internally instead of returning a
JS geometry array. Decide whether to keep `parseGds` around too (useful
for non-graphical testing/debugging the parse path in isolation, the way
it was verified in phase 1) or delete it once the renderer subsumes it —
leaning toward **keep it**, it's cheap to keep and was the thing that
made phase-1 verification tractable.

### CSP changes needed in viewer.html

Add a CSP meta tag (none exists today):

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src {{cspSource}}; style-src 'unsafe-inline'; script-src {{cspSource}} 'wasm-unsafe-eval';">
```

`'wasm-unsafe-eval'` is required for `WebAssembly.instantiate` from the
base64-embedded binary (`-sSINGLE_FILE=1`, already in use). `{{cspSource}}`
is a placeholder `src/extension.cjs` would `.replace()` with
`webviewPanel.webview.cspSource`, same mechanism it already uses for the
`src/viewer.js` src swap.

**This was incomplete.** `'wasm-unsafe-eval'` alone is not enough: embind
generates its invoker functions via `new Function(...)` (a plain JS
string-eval, not wasm bytecode generation), which needs `'unsafe-eval'`
specifically and throws `EvalError` under a CSP that only grants
`'wasm-unsafe-eval'`. This only showed up once actually loaded in the real
VSCode webview (Node-based testing has no CSP at all, so it never caught
this). Fixed by adding `-sDYNAMIC_EXECUTION=0` to `src/wasm/CMakeLists.txt`'s
link options instead of loosening the CSP — it makes embind use a slower
but eval-free invocation path, so `'unsafe-eval'` is never needed. Confirmed
zero `new Function` occurrences in the built `gdstk_wasm.js` after the
change.

### Known risks / things to double check when implementing

- **`ALLOW_MEMORY_GROWTH` + raw GL buffer pointers**: phase 1's
  `to_float64_array` was careful to copy out of wasm memory immediately
  within a single embind call specifically because growth can detach the
  backing buffer. The renderer will be doing `glBufferData(..., ptr, ...)`
  with pointers into wasm memory directly (no JS copy step at all) — that
  part is fine since `glBufferData` already copies into the GPU buffer
  synchronously, same reasoning applies, just flagging it's worth
  re-confirming once real code exists rather than assuming.
- **49MB-file frame budget**: parsing alone is ~540ms for the largest
  sample file; if `get_polygons()` + GL upload pushes total
  first-paint time past ~1-2s, consider showing a "parsing..." message in
  the `ui` div immediately (before the wasm call) — currently
  `src/viewer.html` already defaults to "Parsing GDS hierarchical
  layout..." as the initial `#ui` text, so this may already be adequate;
  just confirm it actually paints before the blocking wasm call starts
  (may need a `requestAnimationFrame` yield before calling into wasm).
- **Per-polygon `LINE_LOOP` draw calls at 800K+ polygons**: flagged above
  as "profile before optimizing further" — do actually profile in a real
  webview before adding primitive-restart/degenerate-triangle complexity;
  it may simply be fine.
- **MEMFS growth across repeated file opens**: if a user opens many `.gds`
  files in the same VSCode session (same webview instance reused or new
  ones spun up — check whether VSCode reuses the webview per tab), make
  sure `/input.gds` is unlinked after each parse, already noted above.

---

## Implementation notes (phase 2, as built)

All of the steps originally listed here are done:

- `src/wasm/gds_common.hpp` — new shared header for `error_string`/`is_fatal`/
  `is_metadata_cell`, used by both `bindings.cpp` and `renderer.cpp` so the
  two don't carry diverging copies.
- `src/wasm/renderer.cpp` — GL context setup, shader compile, layer-batched
  buffer upload, camera/input handling, `.lyp` parsing, scale-bar text, and
  the `loadAndRenderGds`/`loadLypText` embind exports, as designed above.
  One addition not originally called out: `main()` runs automatically at
  module load (Emscripten's default behavior) and now checks whether
  `emscripten_webgl_create_context("#glCanvas", ...)` actually succeeded
  before touching any further GL/DOM state. Without that check, loading the
  module in an environment with no real canvas (plain Node — how
  `parseGds()` is exercised for headless testing, see phase 1) made the
  whole module's instantiation promise reject, breaking even `parseGds()`.
  `g_gl_ready` gates `loadAndRenderGds`/`request_redraw`/input-callback
  registration; `parseGds()` is unaffected either way since it never touches
  GL.
- `src/viewer.html` — CSP meta tag added, GL/shader/event JS dropped, now loads
  `src/wasm/build/gdstk_wasm.js` then `src/viewer.js`.
- `src/viewer.js` — down to the bootstrap shown above, with one correction: the
  `message` listener is registered synchronously (not inside
  `createGdstkModule().then(...)`), because an `init` message arriving
  before wasm instantiation finishes would otherwise be silently dropped
  (window `message` events aren't queued for listeners that don't exist
  yet). Each handler awaits the cached module promise instead.
- `src/extension.cjs` — `gdsii` import and `parseWithOfficialLibrary` removed;
  sends raw bytes (`Uint8Array.from(fileData).buffer`) via the `init`
  message; swaps in webview URIs for both `src/viewer.js` and
  `src/wasm/build/gdstk_wasm.js`, plus `{{cspSource}}`.
- `npm uninstall gdsii` — done. This surfaced a separate pre-existing bug:
  `package.json` had no `dependencies`/`devDependencies` keys at all even
  though `package-lock.json` carried a full devDependency tree (eslint,
  mocha, `@vscode/test-cli`, etc.) — so `npm uninstall` reconciled the
  lockfile against the incomplete `package.json` and deleted all of it.
  Fixed by adding the matching `devDependencies` block back to
  `package.json` and re-running `npm install`. Unrelated, still-open issue
  found in the process: `eslint.config.mjs` imports `globals`, which was
  never a declared dependency in this repo (predates this rewrite) — running
  `npx eslint` fails with `ERR_MODULE_NOT_FOUND`. Not fixed; out of scope
  for this rewrite, listed here so it isn't mistaken for a regression.
- `npm run build:wasm` script added, plus a "Building" section in
  `README.md` documenting the Emscripten prerequisite.

### Verification done

Headless, under plain Node (`src/wasm/build/gdstk_wasm.js` loaded directly, no
VSCode/browser involved):
- Module instantiates without throwing (confirms the `g_gl_ready` fix).
- `parseGds()` still works against a real sample file.
- `loadAndRenderGds()` and `loadLypText()` no-op safely (don't throw) when
  there's no real WebGL2 canvas, rather than crashing.

In a real VSCode Extension Development Host window (`F5`), against real
`.gds` files: confirmed loading, parsing, and rendering work end-to-end in
the actual webview (this is what caught the `'unsafe-eval'` CSP issue
above — headless Node testing has no CSP and couldn't have caught it).

## Possible follow-ups (not blocking, not started)

- Verify against the largest sample file (49MB) specifically for the
  first-paint frame-budget concern noted above — confirmed working on
  smaller files (`grat27.gds`, `pl_gf_basic.gds`) but not yet re-checked at
  that size since the `DYNAMIC_EXECUTION=0` fix.
- Exercise pan/drag/wheel-zoom and the `.lyp` file picker round-trip
  interactively to confirm camera math and color overrides match the old
  JS behavior pixel-for-pixel (loading/rendering is confirmed; interactive
  controls haven't been explicitly exercised yet).
- The pre-existing `eslint.config.mjs` → missing `globals` package issue
  noted above is still unfixed and unrelated to this rewrite.
