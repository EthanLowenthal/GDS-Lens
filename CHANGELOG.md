# Change Log

## [Unreleased]

- Wheel zoom is no longer wildly over-sensitive on a trackpad. Every wheel
  event applied one fixed 1.15× step regardless of how far the event said the
  wheel had turned, which is right for a stepped mouse wheel (one event per
  detent) and badly wrong for a trackpad or any smooth-scrolling wheel, which
  report a stream of small deltas instead — a single two-finger swipe could
  arrive as 40 events and zoom by more than 100×. The step is now proportional
  to the event's delta, normalized against the conventional 100 pixels (or 3
  lines) per notch, and capped per event so momentum scrolling can't leap
  decades of zoom in one frame. A notch is now 1.10× rather than 1.15×, so a
  stepped wheel is also slightly calmer than before.
- A cell hierarchy tree down the left edge of the viewer. The renderer
  flattens the design to draw it, which left nothing on screen saying what the
  design is *made of*; the panel now lists the top cell(s) and, as branches are
  opened, the cells each one places. Clicking a row frames that cell in the
  view, which makes the tree a way to navigate a layout rather than just read
  it — the fastest way to get from a whole reticle to one macro.
  - Rows collapse per cell, not per placement: a cell a parent places 40,000
    times is one row marked `×40000`, since the alternative is a panel with
    40,000 identical siblings in it. Clicking that row frames all of the
    placements; opening it descends into the first, because a repeated cell has
    no single deeper coordinate frame to offer. The row's tooltip says so,
    along with the cell's own shape/label/child counts and its size and centre.
  - Rows are built only for branches that are open. `cells[]` describes each
    cell once, but the tree it spans is that DAG expanded, which for a real
    chip is orders of magnitude larger than the library it came from — and
    nobody reads more of it than they opened.
  - The structure comes out of the same wasm parse as the geometry (a new
    `build_hierarchy` in `renderer.cpp`), before the flatten, since it needs
    the gdstk `Library`'s reference arrays. Nothing per-polygon crosses into JS
    with it: one entry per cell in the file, carrying names, counts, and a box.
  - Each cell's extent is measured bottom-up over a memo, so a cell shared by a
    thousand parents is measured once, and an arrayed reference is sized from
    its repetition's extreme offsets rather than by walking every copy — an
    AREF can hold millions. The one deliberate approximation is that a rotated
    cell is framed by the box of its box's mapped corners, which over-estimates
    slightly and is invisible when it's used to aim a camera. Past 50,000 cells
    the tree is dropped rather than built (the panel says so): describing a
    library that size costs more than the geometry it's meant to navigate.
  - The panel floats over the canvas like the layer panel on the right rather
    than taking width from it, so nothing about the renderer's sizing,
    hit-testing or camera had to learn it exists. It starts collapsed behind a
    button in the top-left corner (`H` toggles it too) — the viewport belongs
    to the layout, and 260px of it is something to ask for rather than be
    given — and opening it by hand makes that choice stick for the rest of the
    session. Open branches and the selected cell are keyed by cell-name path,
    so reloading an edited file leaves the tree where it was instead of
    collapsing it to the roots.

## [1.5.0] - 2026-08-11

- The measure tool is now a mouse mode instead of a checkbox: the panel shows a
  Pan | Measure pair, with the active mode filled in. A checkbox implied
  measuring was something layered on top of panning, when in fact it replaces
  what a click does. `M` switches modes from the keyboard and `Escape` returns
  to Pan (clearing the measurement), as the docs already claimed — neither key
  had actually been wired up.
- Reloading when the layout changes on disk. A viewer now watches its own
  file, and when a generator script or KLayout rewrites it, a header offers a
  Reload button. Reloading keeps the camera and the per-layer visibility
  checkboxes, so re-running a generator drops the new geometry in place
  instead of throwing you back to a framed view of the whole design; layers
  the edit newly introduced keep the fresh load's defaults. An "Always" button
  beside it re-reads without asking from then on, storing the
  `GDS-Lens.autoReload` setting (off by default); "GDSLens: Toggle Auto-Reload
  on Change" turns it back off. A reload leaves the design on screen and
  reports progress in a hairline bar along the top edge — the full-screen
  loading overlay is for opening a file, and blacking out the viewport would
  undo the point of putting the camera back. Reads wait for the file
  to hold a steady size and mtime before starting, since layout writers rarely
  produce one clean change event — chunked writes and write-to-temp-then-rename
  would otherwise be read half-finished — and a reload supersedes any load
  still in flight rather than racing it.
- The debug tools are one panel instead of two. The engine readout (polygon
  and label counts, live visible-polygon stats, GPU memory) floated over the
  top-left of the canvas while the log sat at the bottom, both lit up by the
  same command; the readout now sits beside the log inside the debug panel,
  and its text is selectable.
- Switching away from a viewer tab and back no longer leaves it stuck on
  "Loading layout...". VS Code was destroying the webview's DOM whenever the
  tab was hidden and re-running the viewer from scratch on return, but the
  file bytes are only ever sent once per editor, so the restored webview had
  nothing to load. The webview now retains its context while hidden, which
  also means a tab switch no longer costs a re-parse on a large design. The
  trade-off is that a hidden viewer keeps its wasm heap and GL context
  resident.
- The viewer follows VS Code's light and dark themes instead of always being
  dark. Switching themes re-themes an open viewer immediately; nothing has to
  be reopened, and there is no setting to keep in sync. Both halves of the
  viewer move: the panel, banners, overlays and readouts (which now take every
  color from one token block), and the canvas itself — the background, the
  ruler and the selected marker's highlight, all of which assumed white-on-
  near-black. Layers with no `.lyp` entry get their generated fallback color
  darkened on a light background, since roughly half of that palette was
  bright enough to disappear against white; hue and saturation are preserved,
  so layers stay as distinguishable from each other as they were. Colors that
  came from a `.lyp` are left exactly as authored in either theme. The drawing
  buffer is also kept fully opaque now: its alpha channel was being blended
  down by every semi-transparent draw, which let the page background back in
  through the compositor and washed low-alpha ink out on a light background.
- A background reference grid, on by default, with a "Grid" toggle in the
  panel. Its pitch is a round nm/µm/mm step that follows the zoom, so it
  agrees with the scale bar rather than being an arbitrary fraction of the
  viewport, and it crosses between decades without the lines ever popping in
  or out: two decade levels draw at once and the finer one fades out as it
  approaches too dense to read. It costs one fullscreen pass regardless of
  design size.

## [1.4.1] - 2026-08-05

- GDS Lens is now published on [Open VSX](https://open-vsx.org/extension/ethml/GDS-Lens)
  as well as the VS Code Marketplace, so it can be installed in Cursor,
  Windsurf, VSCodium, code-server, Gitpod and Theia.
- Layer outlines render substantially faster, most noticeably on large designs
  and when zoomed out. Each polygon's boundary was drawn as a `GL_LINE_LOOP`,
  with primitive-restart markers separating one polygon from the next. No
  current GPU API has a line-loop primitive — not D3D11/12, not Vulkan, not
  Metal — so every backend was emulating the topology and scanning the index
  stream for restart boundaries. Outlines are now plain `GL_LINES` edge pairs,
  which pass through unconverted everywhere. Output is visually identical; the
  outline index buffers are roughly twice the size in exchange.
- The debug readout now reports GPU memory usage, split into geometry (vertex,
  index, and instance buffers, which grow with the design) and merge mode's
  coverage mask (which grows with the window).
- The load progress bar advances at a more even rate. Per-layer triangulation
  cost spans orders of magnitude, and layers of similar cost tended to sit
  next to each other, so the bar would sprint through a cheap run and then
  appear to hang on an expensive one. All layers — static, label-only, and
  each instance group's unit shape — now run as a single pass against one
  denominator, in an interleaved order. The interleaving is seeded fixed, so a
  given layout still triangulates in the same order every time, and the order
  layers are emitted in is unchanged.

## [1.4.0] - 2026-07-31

- Text labels: GDSII/OASIS `TEXT` elements now render, behind a "Text" toggle
  in the panel (off by default). Labels draw at a constant on-screen size in
  their own layer's color, follow that layer's visibility checkbox, and honor
  the label's justification (anchor). Text found on a layer/texttype with no
  geometry on it gets a layer entry of its own, so pin text on a text-only
  texttype is visible and toggleable like any other layer.

## [1.3.0] - 2026-07-31

- OASIS support: `.oas` and `.oasis` files open in the viewer alongside
  `.gds`, going through the same flatten/triangulate/render path (gdstk's
  `read_oas`, normalized to microns exactly like GDSII). Cell references,
  repetitions, and the `.lyp` / marker-database features all work the same
  way.
- The format is detected from the file's header rather than its extension, so
  a layout saved under an unexpected name still loads as the right format.

- Load failures are now visible. They were being written to the upper-left
  readout, which is hidden unless the debug-tools command has been run — so a
  layout that failed to open left an empty canvas and no explanation. Errors
  now show in a panel of their own, including when the failure happens before
  the renderer starts.
- Layouts too large to fit in memory report that, instead of a bare
  "memory access out of bounds". The 32-bit WebAssembly module's memory
  ceiling was also raised from Emscripten's default 2 GB to the 4 GB maximum
  a wasm32 module can address, which roughly doubles the size of design that
  opens successfully.
- Files above 2 GB are declined up front with an explanation rather than
  after a long stall, and a layout that can't be read at all (disk error,
  unmounted share) now reports that instead of leaving the progress bar
  spinning forever.
- A design that parsed but was too big to upload to the GPU used to leave the
  progress bar stuck at 100%; it now reports the failure.

## [1.2.0] - 2026-07-20

- Control panel migrated from dat.gui (unmaintained) to lil-gui. Same layout
  and behavior; the panel now has a "Controls" title bar at the top instead
  of a "Close Controls" footer.

- Marker database support: load DRC/LVS violation markers on top of the
  layout via the new "Load Marker File" panel button. One button, format
  auto-detected by content:
  - KLayout report databases (`.lyrdb`) — boxes, polygons (including hole
    rings), edges, and edge-pairs; nested categories; text/float-only values
    shown in the item label.
  - Calibre DRC ASCII results databases (any extension) — polygon and edge
    clusters, with coordinates scaled by the header's precision.
- Markers draw as a red highlight overlay above all layers (translucent fill,
  outlines, and end ticks on edge markers so they're findable when zoomed
  out), unaffected by layer visibility, infill, or merge mode.
- Marker browser panel: one folder per category (rulecheck) with item counts,
  a per-category visibility toggle, and clickable items that zoom the view to
  the violation (selected marker is re-highlighted in white). `[` / `]` step
  the selection through visible markers. Categories start hidden — turn on
  the rulechecks you want drawn; the selected marker always draws, even from
  a hidden category.
- Marker overlay opacity slider, and a "Hide empty categories" toggle that
  filters rulechecks with 0 violations out of the browser panel.
- Non-top-cell / hierarchical results are detected and surfaced as a ⚠
  warnings row (positions may be wrong) instead of failing the load.
- The loaded marker file is remembered per GDS file and re-applied when that
  file is reopened (unlike the `.lyp`, which is global).

## [1.1.0] - 2026-07-15

- Measure tool: toggle from the panel, then click two points to measure the
  distance between them (total, Δx, Δy). Clicking again starts a fresh
  measurement.
- Merge Overlaps mode: draws each layer as the antialiased union of its
  polygons (fill + outer boundary only, no internal edges).
- Infill is now hidden by default.
- Layer list: names are no longer cut off after the layer number — labels
  stay on one line, truncate with an ellipsis, and show in full on hover.
- KLayout `.lyp` handling:
  - Entries without usable colors are kept (their names and visibility
    apply; colors fall back to the defaults) instead of being dropped.
  - A group's `<visible>` flag now cascades to the layers inside it,
    matching KLayout.
  - `<fill-brightness>`/`<frame-brightness>` are applied to the colors.
  - More robust XML parsing: tag attributes, character entities, comments,
    and self-closing tags are handled.
  - Multi-tab files load the first tab; entries bound to other layouts
    (`@2` and up) are skipped instead of misapplied.
- Debug overlay shows frame time / fps.

## [1.0.0]

Initial release.

- Custom editor for `.gds` (GDSII layout) files that parses and renders the
  layout in a WebGL2 canvas.
- GDS parsing and rendering run in a C++/WebAssembly module (gdstk) for fast
  loading of large layouts, with parsing off the main thread.
- Handles SREF/AREF (including array references), rotation, mirroring, and
  magnification via gdstk's flattening.
- Pan (drag) and zoom (scroll) navigation, with a Reset View action to refit
  the layout to the window.
- Per-layer visibility toggles.
- Infill toggle to show or hide the hatched layer fill.
- Optional KLayout `.lyp` file loading to drive layer colors.
- "GDSLens: Toggle Debug Tools" command to show/hide the render stats readout
  and debug log.