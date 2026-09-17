#!/usr/bin/env node
// Writes a synthetic GDSII file shaped like the layouts the renderer is slow
// on, for benchmarking without a real design (which are all under NDA).
//
//   node scripts/make-stress-gds.mjs out.gds [--routes=N] [--route-verts=V]
//                                            [--vias=N] [--layers=L] [--die=UM]
//                                            [--cells=N] [--cell-polys=N]
//                                            [--cell-layers=N] [--placements=N]
//
// The shape that matters, and the reason a photonic chip is harder than its
// polygon count suggests: most of the geometry is *unique*. Routing is curves,
// every curve is different, so nothing instances and nothing is shared -- the
// renderer has no choice but to hold and submit every vertex. That is modelled
// here as arcs of many vertices each (the routes), mixed with a large number of
// small rectangles (the vias/fill) for the other failure mode, polygon count
// without vertex count.
//
// --cells builds the other half of a real chip: a library of distinct small
// cells, each placed --placements times, which is what a generated layout
// actually looks like. Those go down draw_frame's instanced path, one
// InstancedBatch per (cell, layer) -- so the batch count this produces is
// cells * cell-layers, independent of how many polygons any of them holds.
// Without it the file is flat and exercises only the static per-layer buffers.

import fs from "node:fs";

const argv = process.argv.slice(2);
const out = argv.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => Number(argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt);

if (!out) {
    console.error("usage: node scripts/make-stress-gds.mjs out.gds [--routes=N] [--route-verts=V] [--vias=N] [--layers=L] [--die=UM]");
    process.exit(2);
}

const routes = opt("routes", 200_000);
const routeVerts = opt("route-verts", 40);
const vias = opt("vias", 1_000_000);
const layerCount = opt("layers", 12);
const cells = opt("cells", 0);
const cellPolys = opt("cell-polys", 40);
const cellLayers = opt("cell-layers", 4);
const placements = opt("placements", 20);
const dieUm = opt("die", 5000);

// Database units: 1 nm, the usual for these processes, so coordinates are
// integers of nm and the die is dieUm * 1000 of them.
const DBU_PER_UM = 1000;
const die = dieUm * DBU_PER_UM;

// GDSII record types used here.
const HEADER = 0x0002, BGNLIB = 0x0102, LIBNAME = 0x0206, UNITS = 0x0305;
const BGNSTR = 0x0502, STRNAME = 0x0606, BOUNDARY = 0x0800, LAYER = 0x0D02;
const SREF = 0x0A00, SNAME = 0x1206;
const DATATYPE = 0x0E02, XY = 0x1003, ENDEL = 0x1100, ENDSTR = 0x0700, ENDLIB = 0x0400;
// Data types, in the low byte of a record's second header halfword.
const NO_DATA = 0x00, INT2 = 0x02, INT4 = 0x03, REAL8 = 0x05, ASCII = 0x06;

// GDSII's own 8-byte float: sign, 7-bit exponent in excess-64 powers of *16*,
// and a 56-bit fraction normalised to [1/16, 1). Not IEEE 754, so it is built
// by hand -- only UNITS needs it.
function real8(value) {
    const buf = Buffer.alloc(8);
    if (value === 0) return buf;
    let v = Math.abs(value);
    let exp = 64;
    while (v >= 1) { v /= 16; exp++; }
    while (v < 1 / 16) { v *= 16; exp--; }
    buf[0] = (value < 0 ? 0x80 : 0) | (exp & 0x7f);
    // 56 bits of fraction, written a byte at a time from the top.
    for (let i = 1; i < 8; i++) {
        v *= 256;
        const byte = Math.floor(v);
        buf[i] = byte;
        v -= byte;
    }
    return buf;
}

function record(type, dataType, payload = Buffer.alloc(0)) {
    // Every record is an even number of bytes, header included.
    const pad = payload.length % 2;
    const head = Buffer.alloc(4);
    head.writeUInt16BE(4 + payload.length + pad, 0);
    head.writeUInt8(type >> 8, 2);
    head.writeUInt8(dataType, 3);
    return pad ? Buffer.concat([head, payload, Buffer.alloc(1)]) : Buffer.concat([head, payload]);
}

function int2(...values) {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeInt16BE(v, i * 2));
    return b;
}

function ascii(s) {
    return Buffer.from(s.length % 2 ? s + "\0" : s, "latin1");
}

const stream = fs.createWriteStream(out);
// Backpressure: this writes gigabytes of small buffers, and ignoring the
// return of write() buffers the whole file in memory.
const chunks = [];
let pending = 0;
function push(buf) {
    chunks.push(buf);
    pending += buf.length;
    if (pending >= 1 << 22) return flush();
    return null;
}
function flush() {
    const buf = Buffer.concat(chunks);
    chunks.length = 0;
    pending = 0;
    return stream.write(buf) ? null : new Promise((r) => stream.once("drain", r));
}

const now = new Date();
const stamp = int2(now.getFullYear(), now.getMonth() + 1, now.getDate(), 0, 0, 0,
                   now.getFullYear(), now.getMonth() + 1, now.getDate(), 0, 0, 0);
push(record(HEADER, INT2, int2(600)));
push(record(BGNLIB, INT2, stamp));
push(record(LIBNAME, ASCII, ascii("STRESS")));
push(record(UNITS, REAL8, Buffer.concat([real8(1 / DBU_PER_UM), real8(1e-9)])));
// Reproducible without pulling in a PRNG: any cheap 32-bit LCG does, since the
// only property that matters is that the geometry is spread out and unequal.
let seed = 0x2545f491;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);

function boundary(layer, datatype, coords) {
    // XY holds closed rings: the first point is repeated as the last.
    const xy = Buffer.alloc((coords.length + 2) * 4);
    for (let i = 0; i < coords.length; i++) xy.writeInt32BE(coords[i] | 0, i * 4);
    xy.writeInt32BE(coords[0] | 0, coords.length * 4);
    xy.writeInt32BE(coords[1] | 0, (coords.length + 1) * 4);
    push(record(BOUNDARY, NO_DATA));
    push(record(LAYER, INT2, int2(layer)));
    push(record(DATATYPE, INT2, int2(datatype)));
    return push(record(XY, INT4, xy));
}

// A waveguide-ish arc: a constant-width ribbon swept along a circular arc, as a
// single polygon of 2 * segments points. This is the unique-geometry half.
function route(cx, cy, radius, startAngle, sweep, width, segments) {
    const pts = [];
    const half = width / 2;
    for (let i = 0; i < segments; i++) {
        const t = startAngle + sweep * (i / (segments - 1));
        pts.push(cx + Math.cos(t) * (radius + half), cy + Math.sin(t) * (radius + half));
    }
    for (let i = segments - 1; i >= 0; i--) {
        const t = startAngle + sweep * (i / (segments - 1));
        pts.push(cx + Math.cos(t) * (radius - half), cy + Math.sin(t) * (radius - half));
    }
    return pts.map(Math.round);
}

const segments = Math.max(3, routeVerts >> 1);

// The cell library, written before TOP so every SREF below names a structure
// that already exists. Each cell is a few microns of geometry spread over
// cell-layers layers -- small, which is the point: the cost being measured is
// per batch, not per vertex.
const cellSize = 4 * DBU_PER_UM;
for (let c = 0; c < cells; c++) {
    push(record(BGNSTR, INT2, stamp));
    push(record(STRNAME, ASCII, ascii(`CELL${c}`)));
    for (let i = 0; i < cellPolys; i++) {
        const layer = 1 + ((c + i) % cellLayers);
        const x = Math.round(rand() * cellSize), y = Math.round(rand() * cellSize);
        const w = Math.round((0.1 + rand() * 0.5) * DBU_PER_UM);
        const p = boundary(layer, 2, [x, y, x + w, y, x + w, y + w, x, y + w]);
        if (p) await p;
    }
    push(record(ENDSTR, NO_DATA));
}

push(record(BGNSTR, INT2, stamp));
push(record(STRNAME, ASCII, ascii("TOP")));

for (let c = 0; c < cells; c++) {
    const name = ascii(`CELL${c}`);
    for (let i = 0; i < placements; i++) {
        const x = Math.round(rand() * die), y = Math.round(rand() * die);
        const xy = Buffer.alloc(8);
        xy.writeInt32BE(x, 0);
        xy.writeInt32BE(y, 4);
        push(record(SREF, NO_DATA));
        push(record(SNAME, ASCII, name));
        push(record(XY, INT4, xy));
        const p = push(record(ENDEL, NO_DATA));
        if (p) await p;
    }
}

for (let i = 0; i < routes; i++) {
    const layer = 1 + (i % layerCount);
    const cx = rand() * die, cy = rand() * die;
    const radius = (5 + rand() * 200) * DBU_PER_UM;
    const await_ = boundary(layer, 0, route(cx, cy, radius, rand() * Math.PI * 2,
                                            (0.2 + rand() * 1.4), 0.5 * DBU_PER_UM, segments));
    if (await_) await await_;
}

// The other half: many small rectangles, few vertices each. Vias, contacts and
// fill look like this, and a real chip has far more of them than it has routes.
for (let i = 0; i < vias; i++) {
    const layer = 1 + (i % layerCount);
    const x = Math.round(rand() * die), y = Math.round(rand() * die);
    const w = Math.round((0.1 + rand() * 0.4) * DBU_PER_UM);
    const p = boundary(layer, 1, [x, y, x + w, y, x + w, y + w, x, y + w]);
    if (p) await p;
}

push(record(ENDSTR, NO_DATA));
push(record(ENDLIB, NO_DATA));
await flush();
await new Promise((r) => stream.end(r));

const size = fs.statSync(out).size;
const flatPolys = routes + vias;
const placedPolys = cells * cellPolys * placements;
console.log(`${out}: ${(size / (1 << 20)).toFixed(1)} MB, ` +
            `${(flatPolys + placedPolys).toLocaleString("en-US")} polygons ` +
            `(${flatPolys.toLocaleString("en-US")} flat + ${placedPolys.toLocaleString("en-US")} placed), ` +
            `${(routes * segments * 2 + vias * 4).toLocaleString("en-US")} flat vertices, ` +
            `${cells} cells x ${placements} placements -> ` +
            `${(cells * cellLayers).toLocaleString("en-US")} instanced batches, ` +
            `${dieUm} um die`);
