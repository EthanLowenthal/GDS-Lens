"""Build the three files the demo page serves: the layout, a layermap, and a
marker database.

Not run by CI. Its outputs are committed beside it, so the page has nothing to
build and every file it serves is reviewable. Run this only when the demo
assets should change.

    pip install "gdsfactory==9.*" klayout
    python make-demo-assets.py [--source PATH]

The source layout is a randomly assembled collection of gdsfactory generic-PDK
cells: real component geometry, no design intent, and nothing from any process
design kit under NDA. This script adds two lines of signage saying exactly that
above the die, so the claim travels with the file rather than living only on the
page that happens to be serving it.

Why each output looks the way it does:

  demo-layout.oas.gz  OASIS rather than GDSII, because the repository has to
                      carry it and the page has to download it: the same layout
                      is 20 MB as GDSII, 8 MB gzipped, and 4.4 MB as gzipped
                      OASIS. Still gzipped, for the last 0.3 MB and because the
                      viewer sniffs gzip from the leading bytes rather than the
                      extension, so this exercises that path on every page load.
  demo-layers.lyp     gdsfactory's generic layer properties, plus the six
                      doping layers it omits. Without those, a sixth of the
                      layers in this layout render in fallback colours.
  demo-markers.lyrdb  Synthetic DRC results, placed on real geometry so that
                      clicking one goes somewhere worth looking. There is no
                      rule deck behind them; they exist to drive the marker
                      browser.
"""

import argparse
import gzip
import re
import pathlib
import random
import xml.etree.ElementTree as ET

import gdsfactory as gf
import klayout.db as kdb

gf.gpdk.PDK.activate()

HERE = pathlib.Path(__file__).parent
DEFAULT_SOURCE = pathlib.Path.home() / "code/circuit_gen/random_circuit.gds"

TEXT_LAYER = (66, 0)          # "Text" in the generic layer properties
TOP_CELL_NAME = "RANDOM_CIRCUIT"

# The source file names its ten top-level blocks tx_slice, mux_bank, rx_slice
# and so on, which reads as one specific transceiver floorplan. This layout is
# not that: each block is an independent random draw of generic-PDK components,
# and no name here describes the geometry under it. They are renamed to generic
# photonic structures so the cell tree, the on-die labels and find-by-name all
# describe the file as the component grab-bag it is.
#
# Keyed by the source name rather than positional, and every block has to be
# accounted for, so a different source file fails loudly instead of silently
# labelling its blocks with names meant for another layout.
BLOCK_NAMES = {
    "tx_slice_00": "photon_source_00",
    "mux_bank_00": "filter_bank_00",
    "rx_slice_00": "ring_array_00",
    "mod_array_00": "mzi_array_00",
    "core_mesh_00": "splitter_tree_00",
    "pd_array_00": "grating_array_00",
    "phase_trim_00": "phase_shifter_00",
    "demux_bank_00": "coupler_bank_00",
    "monitor_tap_00": "delay_line_00",
    "route_mesh_00": "waveguide_mesh_00",
}

TITLE = "GDS LENS DEMO"
SUBTITLE = "random gdsfactory generic-PDK cells"

# The demo layermap. It does two things gdsfactory's own layers.lyp does not:
# it groups layers into categories, which the viewer turns into collapsible
# sections in the layer panel, and it names the six doping layers that file
# omits.
#
# What it deliberately does NOT do is set any colour. A .lyp entry with no
# fill-color and no frame-color falls through to the viewer's own palette --
# a hash of layer and datatype, see default_color in renderer.cpp -- and only
# that fallback is theme-aware: it drops to a darker band under a light theme,
# while colours written into a .lyp are taken as the user's own deck and left
# exactly as given. Baking today's dark-theme colours into this file would
# therefore have made the demo unreadable for anyone whose OS is set to light.
#
# So the entries below are names only. Everything the panel shows -- names,
# categories, order -- comes from here; every colour comes from the viewer.
LAYER_NAMES = {
    (1, 0): "WG waveguide",
    (2, 0): "SLAB150",
    (3, 0): "SLAB90",
    (5, 0): "GE germanium",
    (20, 0): "N",
    (22, 0): "NP",
    (24, 0): "NPP",
    (21, 0): "P",
    (23, 0): "PP",
    (25, 0): "PPP",
    (40, 0): "VIAC contact",
    (44, 0): "VIA1",
    (43, 0): "VIA2",
    (41, 0): "M1",
    (45, 0): "M2",
    (49, 0): "M3",
    (47, 0): "MH heater",
    (64, 0): "FLOORPLAN",
    (66, 0): "Text",
}

# Group order is the order the panel shows them in, so it runs bottom of the
# stack upward: optical, then implants, then the metal stack, then annotation.
GROUP_ORDER = [
    "Waveguides",
    "Devices",
    "Dopants",
    "Contacts and vias",
    "Metals",
    "Frame and text",
    "Labels",
    "Other gdsfactory layers",
]


def group_for(layer: int) -> str:
    """Which category a layer number belongs to.

    A rule rather than a table so that a layout using generic-PDK layers this
    demo happens not to contain still lands somewhere sensible.
    """
    if layer in (5, 47):          # germanium, and the metal heater over it
        return "Devices"
    if layer < 10:
        return "Waveguides"
    if 20 <= layer <= 29:
        return "Dopants"
    if layer in (40, 43, 44, 46, 48):
        return "Contacts and vias"
    if layer in (41, 42, 45, 49):
        return "Metals"
    if 60 <= layer <= 69:
        return "Frame and text"
    if 200 <= layer <= 299:
        return "Labels"
    return "Other gdsfactory layers"


def signage_polygons(text: str, size: float, layer=TEXT_LAYER):
    """Text as flat polygons in dbu, ready to drop into another layout.

    gdsfactory draws text as a cell per glyph. Flattening here keeps the demo
    layout's cell tree as it was found: the signage should be legible on the
    canvas without adding twenty glyph cells to a hierarchy that is the thing
    being shown off.
    """
    c = gf.Component()
    c.add_ref(gf.components.text(text=text, size=size, layer=layer))
    c.flatten()
    li = c.kcl.layout.layer(*layer)
    return [p.polygon for p in c.kdb_cell.each_shape(li)]


def build_layout(source: pathlib.Path, out: pathlib.Path) -> dict:
    layout = kdb.Layout()
    layout.read(str(source))

    tops = layout.top_cells()
    if len(tops) != 1:
        raise SystemExit(f"expected one top cell in {source}, found {[c.name for c in tops]}")
    top = tops[0]
    original_top = top.name
    box = top.dbbox()

    # Before the labels below, which are derived from the cell names.
    blocks = {inst.cell.name: inst.cell for inst in top.each_inst()}
    unknown = sorted(blocks.keys() - BLOCK_NAMES.keys())
    if unknown:
        raise SystemExit(
            f"{source} has top-level blocks BLOCK_NAMES has no entry for: {unknown}")
    for old_name, cell in blocks.items():
        new_name = BLOCK_NAMES[old_name]
        clash = layout.cell(new_name)
        if clash is not None and clash is not cell:
            raise SystemExit(f"renaming {old_name} to {new_name} would collide with an existing cell")
        cell.name = new_name

    # Signage above the die, so it never lands on geometry whatever the source
    # file contains. Sized as a fraction of the die rather than in absolute
    # microns: this has to stay legible when the whole 18 mm is on screen.
    title_size = box.height() * 0.058
    sub_size = box.height() * 0.020
    gap = box.height() * 0.02

    li = layout.layer(*TEXT_LAYER)
    for text, size, baseline in (
        (SUBTITLE, sub_size, box.top + gap),
        (TITLE, title_size, box.top + gap + sub_size * 1.9),
    ):
        for polygon in signage_polygons(text, size):
            top.shapes(li).insert(polygon.transformed(
                kdb.Trans(kdb.Vector(int(box.left / layout.dbu), int(baseline / layout.dbu)))))

    # Real TEXT records, one per top-level block, not polygon outlines. These
    # are what find-by-name searches and what the label list shows: polygon
    # text is geometry the viewer cannot read back. Derived from the cell names
    # rather than written out, so renaming a block renames its label too.
    label_size = int((box.height() * 0.012) / layout.dbu)
    labels = 0
    die_area = box.width() * box.height()
    for inst in top.each_inst():
        ibox = inst.dbbox()
        centre = ibox.center()
        # A block spanning most of the die has its centre wherever the die's
        # centre is, which is already some other block's label. Tuck that one
        # into a corner of itself instead of stacking the two.
        if ibox.width() * ibox.height() > 0.6 * die_area:
            centre = kdb.DPoint(ibox.left + ibox.width() * 0.03,
                                ibox.bottom + ibox.height() * 0.02)
        text = kdb.Text(inst.cell.name,
                        kdb.Trans(kdb.Vector(int(centre.x / layout.dbu),
                                             int(centre.y / layout.dbu))))
        text.size = label_size
        top.shapes(li).insert(text)
        labels += 1

    # `core_s3` says nothing to anyone reading the cell tree on a demo page.
    top.name = TOP_CELL_NAME

    raw = out.with_suffix("")          # strip .gz
    # klayout picks the format from the extension; the options only apply to
    # OASIS. Level 10 is its maximum compression -- worth it for a file that
    # is downloaded on every visit and rewritten almost never.
    opts = kdb.SaveLayoutOptions()
    if raw.suffix == ".oas":
        opts.format = "OASIS"
        opts.oasis_compression_level = 10
    layout.write(str(raw), opts)
    data = raw.read_bytes()
    # mtime=0: the gzip header otherwise carries a timestamp, so rebuilding an
    # unchanged layout would produce a different file and a pointless diff.
    with gzip.GzipFile(out, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(data)
    raw.unlink()

    return {
        "labels": labels,
        "original_top": original_top,
        "top": TOP_CELL_NAME,
        "cells": layout.cells(),
        "layers": [str(layout.get_info(i)) for i in layout.layer_indexes()],
        "raw_bytes": len(data),
        "gz_bytes": out.stat().st_size,
        "bbox": top.dbbox(),
    }


def build_lyp(out: pathlib.Path) -> tuple:
    """Emit a grouped .lyp: gdsfactory's generic layers, sorted into
    categories and named, with no colour of its own (see LAYER_NAMES).

    A group in this format is a <properties> block whose leading <name> is the
    category and whose layers are <group-members> children. The viewer reads
    that leading name as the sidebar section (see LypEntry::group) and cascades
    the group's visibility to its members.
    """
    src = pathlib.Path(gf.__file__).parent / "generic_tech/klayout/layers.lyp"
    root = ET.parse(src).getroot()

    entries = {}
    for prop in root.findall("properties"):
        spec = (prop.findtext("source") or "").split("@")[0]
        m = re.fullmatch(r"(\d+)/(\d+)", spec)
        if not m:
            continue
        key = (int(m.group(1)), int(m.group(2)))
        # gdsfactory's own fill-color/frame-color are read past deliberately:
        # this file carries names and grouping, not colours.
        entries[key] = {
            "name": prop.findtext("name") or spec,
            "visible": prop.findtext("visible") or "true",
        }

    # This demo's own names win, and add the layers gdsfactory leaves out.
    for key, name in LAYER_NAMES.items():
        entries[key] = {"name": name, "visible": "true"}

    grouped = {}
    for key, entry in entries.items():
        grouped.setdefault(group_for(key[0]), []).append((key, entry))

    def leaf(key, entry) -> list:
        layer, datatype = key
        # No frame-color, fill-color, brightness or dither-pattern: those are
        # what hand styling back to the viewer means. KLayout fills in its own
        # defaults for the ones it wants.
        return [
            "   <group-members>",
            "    <line-style/>",
            "    <valid>true</valid>",
            f"    <visible>{entry['visible']}</visible>",
            "    <transparent>false</transparent>",
            "    <width>1</width>",
            "    <marked>false</marked>",
            "    <xfill>false</xfill>",
            "    <animation>0</animation>",
            f"    <name>{entry['name']}</name>",
            f"    <source>{layer}/{datatype}@1</source>",
            "   </group-members>",
        ]

    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<!-- Layer properties for the GDS Lens demo page. Built by",
        "     make-demo-assets.py from gdsfactory's generic-PDK layers.lyp",
        "     (MIT), regrouped into categories and recoloured. -->",
        "<layer-properties>",
    ]
    used = 0
    for group in GROUP_ORDER:
        members = grouped.get(group)
        if not members:
            continue
        members.sort(key=lambda item: item[0])
        lines.append(" <properties>")
        # The category name has to precede the first <group-members>: the
        # parser takes the block's leading <name> as the group.
        lines.append(f"  <name>{group}</name>")
        lines.append("  <valid>true</valid>")
        lines.append("  <visible>true</visible>")
        lines.append("  <source>*/*@1</source>")
        for key, entry in members:
            lines += leaf(key, entry)
            used += 1
        lines.append(" </properties>")
    lines += ["</layer-properties>", ""]
    out.write_text("\n".join(lines))
    return used, [g for g in GROUP_ORDER if grouped.get(g)]


# The rule deck. Real checks, run against the layout by KLayout's DRC engine,
# not markers scattered on top of it: every violation below is a place where
# the geometry genuinely breaks the rule.
#
# The thresholds are deliberately tight. A silicon-photonics deck would set
# minimum waveguide spacing at a micron or more to stop adjacent guides
# coupling, but this layout is randomly assembled, so that rule finds fifty
# million violations and takes two minutes to do it. At 0.1um the checks still
# describe something real and finish in seconds.
#
# (layer, rule name, description, check)
CHECKS = [
    ("WG.WIDTH.1", "minimum waveguide width 0.100 um",
     lambda r, dbu: r["wg"].width_check(int(0.10 / dbu))),
    ("WG.SPACE.1", "minimum waveguide spacing 0.100 um",
     lambda r, dbu: r["wg"].space_check(int(0.10 / dbu))),
    ("SLAB90.ENC.WG.1", "SLAB90 must enclose WG by 0.100 um",
     lambda r, dbu: r["slab"].enclosing_check(r["wg"], int(0.10 / dbu))),
]

# Per rule. Enough to browse, few enough that the panel stays readable and the
# file stays a few kilobytes.
MAX_PER_RULE = 20


def run_drc(layout_path: pathlib.Path) -> tuple:
    """Run the deck and return (top cell name, [(rule, description, found,
    [(edge, edge)])]).

    Deep mode rather than flat: the layout is ten thousand cells, and a flat
    region would expand every array before checking anything.
    """
    layout = kdb.Layout()
    with gzip.open(layout_path, "rb") as fh:
        # Keeps the real extension, which is how klayout picks the reader.
        raw = layout_path.with_name("tmp-" + layout_path.name.removesuffix(".gz"))
        raw.write_bytes(fh.read())
    layout.read(str(raw))
    raw.unlink()
    top = layout.top_cells()[0]
    dbu = layout.dbu

    store = kdb.DeepShapeStore()
    regions = {
        "wg": kdb.Region(top.begin_shapes_rec(layout.layer(1, 0)), store),
        "slab": kdb.Region(top.begin_shapes_rec(layout.layer(3, 0)), store),
    }

    results = []
    for rule, description, check in CHECKS:
        pairs = [(ep.first, ep.second) for ep in check(regions, dbu).each()]
        found = len(pairs)
        # Spread the sample over the die instead of taking the first twenty,
        # which all land in whichever corner the engine happened to start in.
        if found > MAX_PER_RULE:
            stride = found / MAX_PER_RULE
            pairs = [pairs[int(i * stride)] for i in range(MAX_PER_RULE)]
        results.append((rule, description, found, pairs))
    return top.name, results


def build_ascii_drc(top_cell: str, results: list, out: pathlib.Path) -> tuple:
    """Write a Calibre-style ASCII results database.

    Line-oriented and rigidly counted: the header is "<top cell> <precision>",
    and each check is a name, a counts line of
    "<results> <original> <description lines> <timestamp>", that many
    description lines, then that many results. `original` is the count the
    check actually found, so a reader can see that this file reports a sample
    of them rather than silently claiming twenty is all there was.

    Coordinates are integers divided by the precision at read time, so at 1000
    they are nanometres, which is this layout's database unit exactly and means
    nothing rounds on the way out.
    """
    precision = 1000
    stamp = "Aug 31 12:00:00 2026"

    lines = [f"{top_cell} {precision}"]
    shown = 0
    for rule, description, found, pairs in results:
        note = (f"reporting {len(pairs)} of {found} violations"
                if found > len(pairs) else f"{found} violations")
        lines.append(rule)
        lines.append(f"{len(pairs)} {found} 2 {stamp}")
        lines.append(f'"{description}"')
        lines.append(f'"{note}"')
        for n, (a, b) in enumerate(pairs, start=1):
            # An edge pair is one result carrying two edges: the two facing
            # edges that are too close, too thin, or short of enclosure.
            lines.append(f"e {n} 2")
            lines.append(f"{a.x1} {a.y1} {a.x2} {a.y2}")
            lines.append(f"{b.x1} {b.y1} {b.x2} {b.y2}")
        shown += len(pairs)
    lines.append("")
    out.write_text("\n".join(lines))
    return shown, [(r, f, len(p)) for r, _, f, p in results]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=pathlib.Path, default=DEFAULT_SOURCE)
    args = ap.parse_args()
    if not args.source.exists():
        raise SystemExit(f"no such layout: {args.source}")

    layout_out = HERE / "demo-layout.oas.gz"
    info = build_layout(args.source, layout_out)
    props, groups = build_lyp(HERE / "demo-layers.lyp")

    top_cell, drc = run_drc(layout_out)
    shown, summary = build_ascii_drc(top_cell, drc, HERE / "demo-markers.drc")

    b = info["bbox"]
    print(f"source      {args.source}")
    print(f"top cell    {info['original_top']} -> {info['top']}")
    print(f"cells       {info['cells']}")
    print(f"layers      {len(info['layers'])}: {' '.join(info['layers'])}")
    print(f"bbox um     ({b.left:.0f},{b.bottom:.0f})-({b.right:.0f},{b.top:.0f})"
          f"  {b.width():.0f} x {b.height():.0f}")
    print(f"layout      {layout_out.name}  {info['raw_bytes'] / 1e6:.1f} MB raw"
          f" -> {info['gz_bytes'] / 1e6:.1f} MB gzipped")
    print(f"labels      {info['labels']} TEXT records on {TEXT_LAYER[0]}/{TEXT_LAYER[1]}")
    print(f"layermap    demo-layers.lyp  {props} layers in {len(groups)} groups")
    for g in groups:
        print(f"            - {g}")
    print(f"markers     demo-markers.drc  {shown} results, ASCII DRC")
    for rule, found, kept in summary:
        print(f"            - {rule:18} {kept:3d} shown of {found} found")


if __name__ == "__main__":
    main()
