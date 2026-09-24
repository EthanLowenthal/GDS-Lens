# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

From 1.0.0 on, a breaking change to the element's API waits for a major
version. Before that, `0.x` releases changed it freely.

## [Unreleased]

### Changed

- The port overlay is off by default. Turn it on with **Display > Ports**. The
  **Ports** folder lists the top cell's ports whether the overlay is on or not.
- Ports inside placed cells are drawn only when 3,000 or fewer of them are in
  view. At full-die zoom, a photonics layout has a port at both ends of every
  waveguide, so the overlay covered the geometry. The top cell's ports are
  drawn at every zoom.

### Fixed

- On a layout with more than 200,000 port placements, the overlay stopped
  collecting ports partway through the hierarchy, so whole blocks had none.
  On the demo layout (230,228 placements) the top-left block was missing. The
  limit is now 1,000,000. The placements are counted first, and past the limit
  the overlay keeps every Nth one, so the sample covers the whole die. The
  panel reports N.
- The **Ports** folder said "Ports (0)" when every port was inside a placed
  cell. The heading now leaves out the count when the top cell has no ports,
  and the folder says how many placements there are inside cells.

- On layouts large enough to use the layer cache (about 5 million polygons),
  the ruler, the snap marker, labels, ports, markers and the cell highlight
  drew at about two thirds of their size, pulled toward the canvas centre, so
  a ruler did not start or end under the pointer. They also lagged behind the
  camera while panning. The cache renders at 1.5x the canvas size and left
  that size, and a stale camera, in the uniforms these overlays draw with. The
  overlays now get the canvas's size and the current camera every frame.
- The ruler lagged the pointer on large layouts. In measure mode every mouse
  move looks for a corner or edge to snap to, and did it by drawing a 33-pixel
  window around the cursor. Nothing culls below the layer level, so that window
  drew every outline on every layer it touched, which on a full chip is the
  whole layout, on every mouse move. The snap now draws the whole canvas once,
  reads it back, and answers each mouse move from that copy. It is drawn again
  only when the camera, the visible layers, the geometry or the canvas size
  change. On test layouts of about 10 million polygons, a mouse move in measure
  mode went from 13 to 15 ms to about 0.1 ms, the same as in pan mode. The
  first mouse move after a pan or zoom pays for the redraw, about one frame.
  The copy takes 16 bytes per canvas pixel and is released when measure mode
  ends.

### Added

- `?gdsCacheMinPolygons=N` overrides the polygon count at which the layer
  cache turns on. 0 turns it on for any layout, a very large value turns it
  off. It is there for diagnosing the cache and for the test that covers the
  overlay fix above.

## [1.4.0] - 2026-09-17

### Added

- **Split parse.** Loading a layout now spreads the work across several
  Workers instead of one. Each runs its own copy of the wasm module over its
  own copy of the file and reads only the layers it was assigned, so nothing
  is shared and nothing is locked -- which is what lets this work without
  `SharedArrayBuffer`, and so without asking the embedding page to be
  cross-origin isolated.

  Triangulation is most of a load's wall clock -- 94% of the per-layer work on
  a large layout -- and is per-polygon work with no dependencies, so this is
  where the time goes. Measured across eight shards, three layouts of varying
  size went from 1.89 s to 0.46 s, from 0.72 s to 0.22 s, and from 0.62 s to
  0.21 s. Layouts that already loaded quickly are unchanged.

  How many Workers a layout gets is decided from its size and its shape. Every
  shard holds its own copy of the file and its own parse's working set, so the
  count comes *down* as the file grows, and past a few hundred megabytes a
  layout parses in one Worker as it always has -- both because the memory is
  not there to spend and because the speedup has flattened out by then anyway.

  A layer whose share is more than one shard's worth is shared rather than
  assigned, each of several shards reading it and triangulating every Nth
  polygon. Without that, a design whose work sits almost entirely on one layer
  -- one routing or waveguide layer with a few marker layers beside it, which
  is a common shape -- could not be split at all, since a layer is the
  smallest thing gdstk's reader can filter on. One dominated by a single layer
  goes from 423 ms to 289 ms.

  What is not split is a design with little triangulation in it to divide.
  Splitting duplicates the parse and only divides the triangulation, and
  rectangles -- convex, filled by a fan in one linear pass -- are an order of
  magnitude cheaper per point than the ear clipping a concave polygon needs.
  A layout of nothing but small rectangles measured 205 ms in one Worker
  against 221 ms across eight, so layouts shaped like that load in one Worker.
  The same estimate decides how the shards are balanced.

  Nothing about this is visible in the API. The same frame is drawn either
  way, down to the pixel, and overlapping layers now stack in layer order
  rather than in whatever order the parse happened to emit them, so the same
  file draws the same on every machine. An instanced cell whose geometry
  spans several shards is folded back into one instance group, so it keeps
  one copy of its placements and one draw call a frame rather than one per
  shard.

  A `shards` attribute (or `?gdsShards=N`) overrides the count, `shards="1"`
  turning the split off -- the setting to reach for if a layout ever loads
  wrongly and the split parse is the suspect.

### Changed

- **Which cells are GPU-instanced is now decided on what instancing saves,
  not on how often a cell is placed.** A cell used to be instanced once it
  appeared eight times anywhere in the design. That is the wrong question: the
  memory instancing saves is the geometry of the copies it avoids flattening,
  and it is paid for with a draw call per (cell, layer) in every frame for as
  long as the layout is open. A cell of twenty rectangles placed a dozen times
  saves a few kilobytes and costs that draw call forever.

  Generated layouts are made of thousands of such cells, so the old rule put
  tens of thousands of draw calls in every frame. A synthetic test chip of
  8,000 distinct cells over six layers, 2.5 million polygons in 33 MB, drew at
  108 ms a frame -- and drew at the same 108 ms zoomed in on a corner of it,
  because nothing about the cost depended on what was on screen.

  A cell is now instanced when the geometry its extra copies would add comes
  to at least ~10 MB, subject to a ~600 MB ceiling on how much flattening the
  design as a whole may add, spent first on the cells that save the most. Both
  are counted in polygon points rather than polygons, because that is what the
  memory is proportional to and a via and a waveguide curve differ by two
  orders of magnitude. A cell placed a hundred thousand times still instances;
  a thousand cells placed twelve times each now flatten. The same test chip
  draws in under 1 ms and loads in 1.27 s rather than 4.35 s, and a cell placed
  5,000 times still instances and still loads a 500-million-polygon hierarchy
  from a 6 MB file.

- **Per-layer and per-batch attribute setup is baked into vertex array objects
  at upload time** instead of being re-issued on every draw of every frame.
  The same test chip went from 960,186 WebGL calls a frame to 144,000, of
  which 48,000 were the draws themselves. On its own this was worth about 6%,
  since the driver's cost is in the draw call rather than the setup around it,
  but it is what makes the remaining draw calls cheap.

  Fills and outlines are now drawn in two passes per layer rather than
  interleaved per batch, which is what lets the uniforms that differ between
  them be set twice per layer instead of twice per batch. One consequence is
  visible: a reused cell's outline is no longer drawn under the next cell's
  fill.

- **The debug readout counts the frame's draw calls** where it used to say
  `no culling`. It is the number to read first on a slow frame, because it
  separates the two reasons a frame is slow: tens of thousands of draw calls
  means the frame time is the calls, and a few hundred means it is the
  geometry, which is a different problem.

- **Panning and zooming a very large layout reprojects the last render instead
  of redrawing the geometry.** The layer pass costs what the geometry costs
  whatever moved, so a camera that moves every frame used to pay it every
  frame: a test chip of 127 million polygons measured 606 ms a frame, and a
  drag is sixty of those a second. The geometry is not what changed, though,
  only the camera. The layers are now rendered once into an offscreen texture
  covering half a viewport more than the canvas in each direction, and while
  the gesture lasts each frame maps that texture through the new camera. The
  same drag runs at the display's refresh rate, 8.4 ms a frame, with one real
  render once the camera stops.

  What this does not do is make the layout render any faster. It makes the
  wait land once, at the end of a gesture, instead of on every frame of it.

  Only the layers go through it. The grid under them and the labels, ports,
  markers, rulers and highlights over them are redrawn every frame at full
  sharpness: they cost almost nothing, and they are the parts a stale pixel
  would actually mislead about. The frame the view settles on is bit-identical
  to the one drawn without any of this -- verified pixel for pixel across a
  1200x800 canvas -- so nothing is approximated once you stop moving. During a
  fast drag the area beyond what was rendered is empty until the redraw
  catches up, rather than being smeared out of the texture's edge.

  It engages only above five million polygons in the layer pass, so layouts
  that were never slow are drawn exactly as before, with no texture copy and
  no staleness. Merge mode and the difference highlight are excluded: both
  rasterize per layer into the coverage mask at the canvas resolution, which
  does not survive being rendered at a larger extent and reprojected.

## [1.3.0] - 2026-09-14

### Added

- **Two layouts in one viewer.** A `<gds-lens>` can hold two layouts at once
  and draw them through one camera into one canvas, for comparing two
  revisions of a design:

  ```js
  await element.load(oldBytes);
  await element.load(newBytes, { slot: "b", name: "rev-b.gds" });
  await element.setBlend(0.5);
  ```

  - `load(source, { slot })` picks which layout to replace -- `"a"` (the
    default, and the only one a single-layout viewer ever uses) or `"b"`. A
    second layout arriving does not move the camera off what is already being
    read, and loading either slot leaves the other alone.
  - `unload(slot)` drops one again; `setBlend(t)` / `getBlend()` crossfade
    between them, `0` showing only A, `1` only B, between overlaying them.
  - With two loaded, the panel grows a **Compare** folder: the blend slider,
    an optional per-layout tint, and **Highlight differences**, which marks
    per (layer, datatype) where the two disagree -- one colour where only A
    has geometry, another where only B does. Both rasterize through the same
    camera into the same coverage mask in the same frame, so identical
    geometry cancels exactly. It is a difference of what is drawn at the zoom
    being viewed, not a geometric XOR, and differences under about half a
    pixel are ignored; zoom in to resolve a smaller one.
  - The layer list shows the **union** of both layouts' layers, chipped A or B
    where only one has it, so an added or removed layer is visible as a row
    rather than absent. The hierarchy browser roots both cell trees, and cell
    and label searches run over both with the same chips on the hits.
  - `getLayers()` entries gain `source` (0 for slot A, 1 for B), and
    `gds-load`'s detail gains `slot`.

  See [docs/embedding.md](docs/embedding.md#two-layouts-in-one-viewer). The
  single-layout case is unchanged in every respect: no attribute, no mode
  flag, and the Compare folder is not built at all until a second layout is
  loaded.

- **gdsfactory / kfactory ports.** kfactory records each cell's ports as
  KLayout meta info, which KLayout writes into the layout file itself: a
  `$$$CONTEXT_INFO$$$` cell in GDSII, `KLAYOUT_CONTEXT` properties in OASIS,
  each holding strings like `META('kfactory:ports:0')={'name'=>'o1',...}`. The
  viewer now reads those back (`src/wasm/kfactory_ports.cpp`) -- name, type,
  position, direction, width and layer, through the named cross-section --
  and expands them through every placement, so a component's ports are marked
  wherever it sits in the design: a bar across the port, an arrow the way it
  faces, and its name once few enough are on screen to read. Optical ports
  are orange, electrical green, anything else the highlight blue. A **Ports**
  toggle in Display turns the overlay off; a **Ports** folder lists the top
  cell's ports and centers the view on one when clicked. Each hierarchy cell
  entry carries a `ports` array and the hierarchy a `portCount`, the
  `gds-load` event's detail gains `portCount`, and the element exposes nothing
  new otherwise -- a file without the metadata looks exactly as before. The
  expansion stops at 200,000 port placements and says so in the panel.

- **`getCamera()` / `setCamera({zoom, panX, panY})`,
  `getMeasurements()` / `addMeasurement(x0, y0, x1, y1)` /
  `clearMeasurements()`, and `getLayers()` / `setLayerVisible(...)`** on the
  viewer surface and the element, for an app that wants to frame the view,
  place a ruler or drive layer visibility itself. Thin pass-throughs over
  behavior that already existed internally; `getLayers()` is also the only way
  to read a layer's name, group, colors and shape counts.

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

[Unreleased]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/EthanLowenthal/GDS-Lens/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/EthanLowenthal/GDS-Lens/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/EthanLowenthal/GDS-Lens/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/EthanLowenthal/GDS-Lens/releases/tag/v0.1.0
