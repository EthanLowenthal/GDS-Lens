"""Generate the layout the demo page loads on first visit.

Not run by CI. The .gds it writes is committed next to it, so the page has
nothing to build and the file stays reviewable. Run this only when the demo
layout itself should change.

Everything here comes from gdsfactory's generic PDK, so the output is
synthetic and carries no process data. The point is a layout that exercises
what the viewer is for: several named layers, a cell hierarchy worth clicking
through, arrays that stay AREFs rather than flattening, curved waveguides with
real vertex counts, and text labels to search for.

    pip install "gdsfactory==9.*"
    python make-demo-layout.py

The rename pass at the bottom is the part worth reading. gdsfactory names
cells after the function and arguments that produced them, which is right for
a design flow and wrong for a demo: the cell tree is the feature being shown,
and a tree of `straight_gdsfactorypcomponentspwaveguidespstraight_L205_d12c49ab`
demonstrates nothing. The pass rewrites those to the shape a hand-drawn library
would have, keeping the one parameter that distinguishes siblings.
"""

import re

import gdsfactory as gf
import klayout.db as kdb

gf.gpdk.PDK.activate()

# Layers from the generic PDK. Named here because the demo is also a test of
# the layer panel, and a panel of unnamed numbers is a worse demo.
WG = (1, 0)          # waveguide core
SLAB = (3, 0)        # partial etch
PAD = (41, 0)        # bond pads
FLOORPLAN = (64, 0)  # die outline
LABEL = (66, 0)      # text and labels

DIE_W, DIE_H = 1600.0, 1000.0

OUT = "demo-layout.gds"


def signage(text: str, size: float = 24.0):
    """Polygon text, for lettering that is visible as geometry."""
    return gf.components.text(text=text, size=size, layer=LABEL)


def place(ref, x: float, y: float):
    """Position a reference by its bounding box rather than by translation.

    gdsfactory components disagree about where their origin sits: a rectangle
    has it at a corner, `spiral_double` at its centre. `move()` translates, so
    placing a centred component with it puts the geometry 150um from wherever
    the number said and captions end up on top of what they label. Setting
    dxmin/dymin places the box itself, which is what a floorplan wants.
    """
    ref.dxmin = x
    ref.dymin = y
    return ref


def caption(die, text: str, ref, size: float = 20.0, gap: float = 16.0):
    """Label a block just below it, measured off the block's own bbox."""
    sign = die.add_ref(signage(text, size=size))
    sign.dxmin = ref.dxmin
    sign.dymax = ref.dymin - gap
    return sign


def ring_bank() -> gf.Component:
    """Three ring resonators, radii stepped.

    A named cell of its own so the hierarchy tree has an interior node with
    children rather than one flat level under the die.
    """
    c = gf.Component("RING_BANK")
    for i, radius in enumerate((10.0, 15.0, 20.0)):
        ring = c.add_ref(gf.components.ring_single(radius=radius, gap=0.2))
        ring.move((i * 120.0, 0.0))
        c.add_label(f"ring_r{int(radius)}", position=(i * 120.0, 0.0), layer=LABEL)
    return c


def mzi_bank() -> gf.Component:
    """Two MZIs with different arm imbalances."""
    c = gf.Component("MZI_BANK")
    for i, length in enumerate((60.0, 120.0)):
        mzi = c.add_ref(gf.components.mzi(delta_length=length))
        mzi.move((0.0, -i * 180.0))
        c.add_label(f"mzi_dl{int(length)}", position=(0.0, -i * 180.0), layer=LABEL)
    return c


def delay_line() -> gf.Component:
    """A coiled delay line. The densest vertex count on the die, so it is what
    the renderer actually gets judged on, and the most obviously photonic
    shape on the page.

    `spiral` is the wrong component here despite the name: at these arguments
    it lays out as a flat 2 mm meander that overruns the die. `spiral_double`
    coils, which is both what a delay line looks like and what fits.
    """
    c = gf.Component("DELAY_LINE")
    c.add_ref(
        gf.components.spiral_double(
            min_bend_radius=30.0,
            separation=8.0,
            number_of_loops=8,
            # Default 1000 puts over 4096 vertices in one polygon, which is a
            # single XY record above 0x8000 bytes. Readers disagree about
            # whether a GDSII record length that long is signed or unsigned,
            # and a viewer's demo file is the wrong place to find out. 300
            # points stays well under and is still visually smooth.
            npoints=300,
        )
    )
    c.add_label("spiral_delay", position=(150.0, 150.0), layer=LABEL)
    return c


def build() -> gf.Component:
    """A die in four horizontal bands: fibre I/O, a row of test structures,
    the title, and the pad row. Bands rather than free placement so that
    captions have somewhere to go and nothing lands on anything else."""
    die = gf.Component("DEMO_DIE")

    # Floorplan frame, drawn as four bars rather than a filled box so nothing
    # inside sits underneath a solid layer.
    t = 6.0
    for x, y, w, h in (
        (0, 0, DIE_W, t),
        (0, DIE_H - t, DIE_W, t),
        (0, 0, t, DIE_H),
        (DIE_W - t, 0, t, DIE_H),
    ):
        place(die.add_ref(gf.components.rectangle(size=(w, h), layer=FLOORPLAN)), x, y)

    # --- Band 1: fibre I/O along the bottom edge. An array, so it lands in the
    # file as one AREF rather than ten placements.
    couplers = place(
        die.add_ref(
            gf.components.grating_coupler_elliptical(),
            columns=10,
            rows=1,
            column_pitch=127.0,
        ),
        150.0,
        55.0,
    )
    caption(die, "FIBER ARRAY 127um", couplers)
    die.add_label("gc_array", position=(150.0, 60.0), layer=LABEL)

    # --- Band 2: test structures, all captioned along the same baseline.
    #
    # The ring banks are the case worth showing: an array of a cell that itself
    # has children, so the renderer instances RING_BANK three times instead of
    # flattening nine rings, and the cell tree shows one node with a count.
    rings = place(
        die.add_ref(ring_bank(), columns=1, rows=3, row_pitch=130.0), 100.0, 220.0
    )
    caption(die, "RING BANK x3", rings)

    # A large-area layer behind them, so the layer panel has something whose
    # absence is obvious when it is switched off.
    slab = die.add_ref(gf.components.rectangle(size=(320.0, 340.0), layer=SLAB))
    place(slab, rings.dxmin - 15.0, rings.dymin - 15.0)

    splitters = place(
        die.add_ref(gf.components.mmi1x2(), columns=1, rows=4, row_pitch=60.0),
        470.0,
        300.0,
    )
    # Captions share a baseline, so the columns have to be spaced for the
    # widest caption rather than the widest device. These are the narrowest
    # names that still say what the structure is.
    caption(die, "MMI 1x2", splitters)

    mmi = place(die.add_ref(gf.components.mmi2x2()), 640.0, 300.0)
    caption(die, "MMI 2x2", mmi)
    die.add_label("mmi_2x2", position=(640.0, 300.0), layer=LABEL)

    mzis = place(
        die.add_ref(mzi_bank(), columns=2, rows=1, column_pitch=150.0), 820.0, 220.0
    )
    caption(die, "MZI ARRAY", mzis)

    spiral = place(die.add_ref(delay_line()), 1150.0, 220.0)
    caption(die, "SPIRAL DELAY", spiral)

    # --- Band 3: the title, in the gap between the structures and the pads.
    place(die.add_ref(signage("GDS LENS DEMO", size=42.0)), 100.0, 640.0)
    place(
        die.add_ref(signage("synthetic layout, gdsfactory generic PDK", size=15.0)),
        100.0,
        610.0,
    )

    # --- Band 4: bond pads on their own layer along the top edge.
    pads = place(
        die.add_ref(
            gf.components.pad(size=(70.0, 70.0), layer=PAD),
            columns=11,
            rows=1,
            column_pitch=100.0,
        ),
        200.0,
        820.0,
    )
    caption(die, "DC PADS", pads)
    die.add_label("pad_row", position=(200.0, 820.0), layer=LABEL)

    return die


# ---- The rename pass ----------------------------------------------------

# `straight_gdsfactorypcomponentspwaveguidespstraight_L205_d12c49ab` splits
# into the function name, the module path gdsfactory flattens into the name,
# and the arguments with a content hash. Only the first and the arguments are
# worth keeping.
SPLIT = re.compile(r"_gdsfactoryp")
# An argument gdsfactory encoded, e.g. L205, R20, G0p2, S24, T followed by a
# string. Trailing hashes are hex and do not match.
PARAM = re.compile(r"_([A-Z][A-Za-z0-9p]*)")


def readable(name: str) -> str | None:
    """A library-style name for a gdsfactory auto-name, or None to leave it."""
    if not SPLIT.search(name):
        return None
    head, tail = SPLIT.split(name, 1)
    base = head.upper()
    # The text components carry their string as the T argument, which is a far
    # better name than the function that drew it.
    caption = re.search(r"_T(.+?)_(?:S\d.*|[0-9a-f]{8})$", tail)
    if caption:
        return f"TEXT_{caption.group(1).upper().strip('_')}"
    # Otherwise keep the first argument, which is what distinguishes siblings
    # (the length of a straight, the radius of a bend).
    params = [p for p in PARAM.findall(tail) if not p.startswith("T")]
    return f"{base}_{params[0].upper()}" if params else base


def tidy_names(path: str) -> None:
    layout = kdb.Layout()
    layout.read(path)

    taken = {c.name for c in layout.each_cell()}
    for cell in layout.each_cell():
        want = readable(cell.name)
        if not want or want == cell.name:
            continue
        unique, n = want, 2
        while unique in taken:
            unique, n = f"{want}_{n}", n + 1
        taken.discard(cell.name)
        taken.add(unique)
        cell.name = unique

    layout.write(path)


if __name__ == "__main__":
    die = build()
    # with_metadata=False drops gdsfactory's $$$CONTEXT_INFO$$$ cell, which
    # carries the build settings and shows up in the cell tree as noise.
    die.write_gds(OUT, with_metadata=False)
    tidy_names(OUT)
    print(f"wrote {OUT}")
