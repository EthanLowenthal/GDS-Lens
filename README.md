# GDS Lens

[View  GDS Lens on Marketplace](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)

A VS Code extension that adds a custom editor for `.gds` (GDSII layout)
files: open one and it's parsed and rendered in a WebGL2 canvas, with
support for loading a KLayout `.lyp` file to drive layer colors.

![GDS Lens rendering a GDSII layout](images/example.png)

## Features

- Parses and renders GDSII layouts directly in a VS Code webview.
- Optional KLayout `.lyp` file loading for custom layer colors.
- Handles SREF/AREF (including array references), rotation, mirroring, and
  magnification via gdstk's flattening.
- Per-layer visibility toggles and an infill (fill pattern) toggle.

## Usage

Open any `.gds` file in VS Code and it opens in the GDS Lens viewer:

- **Pan / zoom** — drag to pan, scroll to zoom.
- **Layers** — toggle individual layer visibility from the panel.
- **Infill** — toggle the hatched layer fill on or off from the panel.
- **Reset View** — refit the layout to the window from the panel.
- **Load KLayout .lyp File** — apply custom layer colors from a `.lyp` file.
- **GDSLens: Toggle Debug Tools** — command palette entry that shows/hides
  the render stats readout and debug log.

## Release notes

See [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

Build and development instructions are in [`DEVELOPING.md`](DEVELOPING.md).
