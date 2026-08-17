# GDS Lens

[View GDS Lens on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)
| [View GDS Lens on Open VSX](https://open-vsx.org/extension/ethml/GDS-Lens)

A VS Code extension that adds a custom editor for `.gds` (GDSII) and `.oas` /
`.oasis` (OASIS) layout files: open one and it's parsed and rendered in a
WebGL2 canvas, with support for loading a KLayout `.lyp` file to drive layer
colors.

![GDS Lens rendering a GDSII layout](images/example.png)

## Features

- Parses and renders GDSII and OASIS layouts directly in a VS Code webview.
- Optional KLayout `.lyp` file loading for custom layer colors.
- Handles SREF/AREF (including array references), rotation, mirroring, and
  magnification via gdstk's flattening.
- A cell hierarchy tree down the left edge: browse the design's cells and
  click one to frame it and outline each of its placements.
- A layer panel built for a real PDK: per-layer visibility with shape counts,
  a filter box, per-layer solo, and show-all/hide-all/invert over whatever the
  filter is showing. Plus an infill (fill pattern) toggle and a text toggle for
  the layout's own labels.
- Measure tool: click two points to read out the distance between them.
- A pointer coordinate readout, and a "Go to (x, y)" box for driving the view
  from a coordinate out of a DRC report or a colleague's message.
- Hover identify: rest the pointer on a shape to see which layer it's on.
- Marker databases: load DRC/LVS violation markers (KLayout `.lyrdb` or
  Calibre DRC ASCII results) as a highlight overlay with a browsable
  category/item panel that zooms to each violation.
- Follows your VS Code theme: light or dark, canvas and panel both, switching
  live when you change themes.
- A background reference grid, pitched at a round distance that follows the
  zoom.

## Usage

Open any `.gds`, `.oas`, or `.oasis` file in VS Code and it opens in the GDS
Lens viewer (the format is read from the file's own header, so a layout named
with an unexpected extension still loads correctly):

- **Pan / zoom** — drag to pan, scroll to zoom.
- **Hierarchy** — the panel down the left edge is the design's cell tree,
  starting from its top cell(s). Click the ▸ to open a cell and see the cells
  it places; click the row itself to frame that cell in the view and mark every
  placement of it with a dashed outline on the canvas (dashed so it can't be
  mistaken for a shape in the layout). The outlines stay on the geometry as you
  pan and zoom, so pulling back to see where the cell sits in the design keeps
  showing you which parts of it the cell is; `Esc` clears them, and putting the
  panel away takes them down with the tree (reopening the panel brings them
  back). A cell placed more than once by its parent is one row marked `×N` —
  clicking it outlines all N copies and frames the view on them together, and
  opening it follows the first. (Past ~1,000 copies the row is marked with one
  outline around the lot instead; its tooltip says so.) The panel starts collapsed:
  the **Hierarchy** button in the top-left corner opens it (as does `H`), and
  the ✕ in its header puts it away again. Once opened it stays open for the rest
  of the session, and open branches and the selected cell survive a reload, so
  re-running a generator leaves the tree where you had it.
- **Layers** — toggle individual layer visibility from the panel. Each row shows
  how many shapes that layer holds in this file (a layer carrying only text is
  counted as `T`*n* instead), and the folder groups them by the `.lyp`'s
  categories. A **Filter** box at the top narrows the list to layers whose
  number, datatype, name or group matches what you type — folders with a hit
  open themselves while you're typing and go back as they were when you clear
  it. **Show: All | None | Invert** applies to whatever the filter is currently
  showing, so filtering to one family and hiding it takes two clicks. The **S**
  on each row solos that layer (hides every other one); clicking it again puts
  back exactly the layers that were on before, rather than turning everything on.
- **Infill** — toggle the hatched layer fill on or off from the panel.
- **Text** — toggle the layout's text labels (GDSII/OASIS `TEXT` elements) on
  or off. Labels draw at a constant on-screen size in their layer's color and
  respect that layer's visibility checkbox. Off by default, since a dense
  design's labels can bury the geometry underneath them.
- **Grid** — toggle the background reference grid. Its spacing is a round
  nm/µm/mm step chosen from the zoom, so it agrees with the scale bar; on by
  default.
- **Hover identify** — rest the pointer on a shape and the layer/datatype (and
  its `.lyp` name, if one is loaded) appears above the coordinate readout. It
  reports the topmost *visible* layer covering that point, and it counts a
  polygon's whole interior whether or not **Infill** is on — a shape occupies
  its area regardless of how it's shaded.
- **Coordinates** — the world coordinate under the pointer is shown above the
  scale bar in the bottom-right corner, in whichever of nm/µm/mm the grid's
  current step falls in and to a tenth of that step, so the digits on screen are
  the ones the grid can actually distinguish.
- **Go to (x, y)** — type or paste a coordinate into the panel and press Enter to
  center the view on it. Microns unless a per-number unit says otherwise
  (`nm`/`um`/`µm`/`mm`), and the decorations coordinates arrive wrapped in —
  parentheses, `x=`/`y=`, commas or bare spaces — are all accepted, so a pair
  copied straight out of a DRC report or a Slack message works as-is. The zoom is
  left alone (the coordinate doesn't say how much around it you want to see); if
  the point isn't inside this layout the row turns red and says so.
- **Reset View** — refit the layout to the window from the panel.
- **Mode: Pan | Measure** — pick the mouse's mode in the panel (or press `M` to
  switch). In **Measure**, click two points to measure the distance between them
  (total, Δx, and Δy); the cursor turns into a crosshair, and wheel zoom keeps
  working. `Escape` returns to **Pan** and clears the measurement.
- **Reload on change** — when the open layout is rewritten on disk (by a
  generator script, KLayout, ...) a header offers **Reload**, which re-reads the
  file while keeping the camera and per-layer visibility, so the new geometry
  lands in place. **Always** reloads from then on without asking; the
  "GDSLens: Toggle Auto-Reload on Change" command turns that back off.
- **Load KLayout .lyp File** — apply custom layer colors from a `.lyp` file.
- **Load Marker File** — load a DRC/LVS marker database (KLayout `.lyrdb`
  report database or Calibre DRC ASCII results database; the format is
  detected from the file's content, not its extension). Violations draw as a
  red overlay above all layers, and a "Markers" panel lists each category
  (rulecheck) with a visibility toggle and clickable items that zoom the view
  to the violation — press `[` / `]` to step through them. Categories start
  hidden; check the rulechecks you want drawn (clicking an item always shows
  that marker, even if its category is hidden). The panel also has
  an overlay opacity slider and a "Hide empty categories" toggle to hide
  rulechecks with 0 violations. The marker file is
  remembered per layout file and re-applied when you reopen it; unload it with
  the ✕ on the panel row.
- **GDSLens: Toggle Debug Tools** — command palette entry that shows/hides the
  debug panel button, which opens the render stats readout and debug log.
- **GDSLens: Toggle Auto-Reload on Change** — command palette entry that turns
  automatic reloading on layout changes on or off (the `GDS-Lens.autoReload`
  setting).

## Release notes

See [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

Build and development instructions are in [`DEVELOPING.md`](DEVELOPING.md).
