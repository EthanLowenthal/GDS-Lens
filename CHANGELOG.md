# Change Log

## [Unreleased]

- KLayout `.lyp` loading now handles grouped/nested `<group-members>` files, so
  every layer in a group is imported (previously only the first member of each
  group was), and colors/visibility are keyed on the full (layer, datatype)
  pair instead of the layer number alone.
- The layer panel is organized into collapsible categories from the `.lyp`'s
  top-level groups (e.g. "Metals"), each with an "all" toggle plus a per
  layer/datatype visibility toggle.
- The last loaded `.lyp` is remembered and re-applied automatically to viewers
  opened afterwards. The load control shows the loaded filename with an ✕ to
  unload it (which also forgets it for next time); clicking the name swaps in a
  different file.

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