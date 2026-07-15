# .lyp spec gaps

Remaining differences between the .lyp loader (`loadLypText`/`parse_lyp_leaf` in
`src/wasm/renderer.cpp`) and the KLayout layer-properties format
(<https://www.klayout.de/lyp_format.html>, source syntax:
<https://www.klayout.de/doc/about/layer_sources.html>). Items already handled:
colors, names, per-leaf and group-cascaded visibility, fill/frame brightness,
top-level groups, first tab of multi-tab files, `@n` layout binding (non-first
skipped), XML attributes/entities/comments/self-closing tags, and entries with
no colors (kept, hash-color fallback).

## High value

- **Dither patterns** — `<dither-pattern>` is ignored; fill patterns are
  hash-derived (`pattern_for_layer`). Matching KLayout needs the built-in
  `I0`–`I47` stipple bitmaps plus `<custom-dither-pattern>` support
  (`<pattern>` of 8/16/32-wide `.`/`*` `<line>` rows, referenced as `Cx`).
  Real PDK files rely on these heavily (the test file defines 134 custom
  patterns). Rendering: sample the bitmap in the fragment shader instead of
  the current `patternType` branches (`kFragmentShaderSrc`).
- **Wildcard / partial source matching** — `10/*` should style *every*
  datatype on layer 10 (currently keyed as datatype 0 only), `*/*` should act
  as a catch-all, and a group header's partial `<source>` provides defaults
  merged into children (child fields override parent). Requires match-time
  resolution (exact tag → layer-wildcard → catch-all) in `apply_layer_colors`,
  `getLayers`, and `setLayerVisible` rather than the current exact
  `g_lyp_info` map lookup.
- **Arbitrary group nesting** — subgroups are flattened into the top-level
  category and subgroup names are dropped. The spec allows unlimited
  `<group-members>` depth; the sidebar would need a recursive folder build
  (viewer.js `renderLayerList`).

## Styling

- `<line-style>` (`Ix` built-ins) and `<custom-line-style>` — outline dashing.
- `<width>` — frame line width in pixels (WebGL `lineWidth` support is
  spotty; likely needs shader-based thick lines to honor it).
- `<transparent>` — bitwise-transparent vs opaque fill rendering mode.
- `<marked>` — draw small crosses on shapes.
- `<xfill>` — diagonal cross over boxes.
- `<animation>` — 0 none / 1 scrolling / 2 blinking / 3 inverse blinking.
- `<valid>` — selectability flag; irrelevant until the viewer has selection.

## Structure / UI

- `<expanded>` — group nodes' initial open/closed state; could drive the
  dat.gui folders' default state (needs plumbing a per-group flag through
  `getLayers`).
- **Duplicate sources** — KLayout keeps duplicate entries as separate rows;
  `g_lyp_info` is a map so the last one wins (test file hits this once:
  `TDVB 251/200`). Would need a list keyed by order, not a map.
- **Multi-tab choice** — only the first `<layer-properties>` tab is parsed;
  KLayout lets the user pick a tab (each has a `<name>`).

## Source selectors (mostly N/A for a single-layout viewer)

- Named layers (OASIS layer names) as `<source>` — gdstk parses OASIS
  `layer_names`; relevant only if OASIS input support lands.
- Transformations `(r90 …)`, property filters `[#k==v]`, hierarchy level
  selectors `#0..1` — currently stripped harmlessly by the numeric parse;
  honoring them is out of scope for now.

## Parser robustness

- CDATA sections (`<![CDATA[…]]>`) are not recognized.
- The parser is still string-scanning, not a real XML parser; pathological
  but valid XML (e.g. a `>` inside an attribute value) can break tag
  boundary detection.
