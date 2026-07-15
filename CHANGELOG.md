# Change Log

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