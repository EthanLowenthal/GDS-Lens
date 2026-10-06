// Writes the GDSII fixture the click-to-inspect tests run against, in memory,
// so the geometry each assertion depends on is spelled out here rather than
// hidden in a binary file. Database unit 1 nm, user unit 1 µm.
//
//   RING  a 2 x 1 µm box on 1/0 at its origin
//   ARR   RING arrayed 3 columns x 2 rows, 10 µm and 5 µm apart
//   TOP   a 50 x 50 µm box on 3/0 at the origin
//         two boxes on 4/0 over it: (10,10)-(20,20) and (12,12)-(18,18)
//         RING at (30, 30) rotated 90 degrees    -> (29,30)-(30,32)
//         RING at (40, 40) mirrored about x      -> (40,39)-(42,40)
//         RING at (60, 60) magnified 2x          -> (60,60)-(64,62)
//         ARR at (0, 100)                        -> RING copies at (10i, 100 + 5j)
//         a 1 µm wide path on 5/0 from (70, 0) to (80, 0)
//
// RING is placed nine times in all, one more than the fewest the renderer will
// instance, so pinning the instancing threshold to 0 draws it instanced.

const HEADER = 0x0002, BGNLIB = 0x0102, LIBNAME = 0x0206, UNITS = 0x0305;
const BGNSTR = 0x0502, STRNAME = 0x0606, ENDSTR = 0x0700, ENDLIB = 0x0400;
const BOUNDARY = 0x0800, PATH = 0x0900, SREF = 0x0A00, AREF = 0x0B00;
const LAYER = 0x0D02, DATATYPE = 0x0E02, WIDTH = 0x0F03, XY = 0x1003, ENDEL = 0x1100;
const SNAME = 0x1206, COLROW = 0x1302, STRANS = 0x1A01, MAG = 0x1B05, ANGLE = 0x1C05;

const NM = 1000;

function real8(value) {
    const buf = Buffer.alloc(8);
    if (value === 0) return buf;
    let v = Math.abs(value);
    let exp = 64;
    while (v >= 1) { v /= 16; exp++; }
    while (v < 1 / 16) { v *= 16; exp--; }
    buf[0] = (value < 0 ? 0x80 : 0) | (exp & 0x7f);
    for (let i = 1; i < 8; i++) {
        v *= 256;
        const byte = Math.floor(v);
        buf[i] = byte;
        v -= byte;
    }
    return buf;
}

function record(type, payload = Buffer.alloc(0)) {
    const pad = payload.length % 2;
    const head = Buffer.alloc(4);
    head.writeUInt16BE(4 + payload.length + pad, 0);
    head.writeUInt16BE(type, 2);
    return pad ? Buffer.concat([head, payload, Buffer.alloc(1)]) : Buffer.concat([head, payload]);
}

const int2 = (...values) => {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeInt16BE(v, i * 2));
    return b;
};
const int4 = (...values) => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeInt32BE(Math.round(v * NM), i * 4));
    return b;
};
const ascii = (s) => Buffer.from(s.length % 2 ? s + "\0" : s, "latin1");

export function box(layer, datatype, x0, y0, x1, y1) {
    return [
        record(BOUNDARY), record(LAYER, int2(layer)), record(DATATYPE, int2(datatype)),
        record(XY, int4(x0, y0, x1, y0, x1, y1, x0, y1, x0, y0)), record(ENDEL)
    ];
}

export function sref(name, x, y, { angle = 0, mirror = false, mag = 1 } = {}) {
    const out = [record(SREF), record(SNAME, ascii(name))];
    if (angle || mirror || mag !== 1) {
        out.push(record(STRANS, int2(mirror ? -0x8000 : 0)));
        if (mag !== 1) out.push(record(MAG, real8(mag)));
        if (angle) out.push(record(ANGLE, real8(angle)));
    }
    out.push(record(XY, int4(x, y)), record(ENDEL));
    return out;
}

export function structure(name, elements) {
    const stamp = int2(2026, 1, 1, 0, 0, 0, 2026, 1, 1, 0, 0, 0);
    return [record(BGNSTR, stamp), record(STRNAME, ascii(name)), ...elements.flat(), record(ENDSTR)];
}

// A rectangular array of `name`, `columns` x `rows` copies `dx` and `dy` apart.
export function aref(name, x, y, columns, rows, dx, dy) {
    return [
        record(AREF), record(SNAME, ascii(name)), record(COLROW, int2(columns, rows)),
        record(XY, int4(x, y, x + columns * dx, y, x, y + rows * dy)), record(ENDEL)
    ];
}

// A whole library from structures (see `structure`), children first.
export function library(structures) {
    const stamp = int2(2026, 1, 1, 0, 0, 0, 2026, 1, 1, 0, 0, 0);
    return Buffer.concat([
        record(HEADER, int2(600)), record(BGNLIB, stamp), record(LIBNAME, ascii("INSPECT")),
        record(UNITS, Buffer.concat([real8(1 / NM), real8(1e-9)])),
        ...structures.flat(), record(ENDLIB)
    ]);
}

export function inspectFixture() {
    return library([
        structure("RING", [box(1, 0, 0, 0, 2, 1)]),
        structure("ARR", [aref("RING", 0, 0, 3, 2, 10, 5)]),
        structure("TOP", [
            box(3, 0, 0, 0, 50, 50),
            box(4, 0, 10, 10, 20, 20),
            box(4, 0, 12, 12, 18, 18),
            sref("RING", 30, 30, { angle: 90 }),
            sref("RING", 40, 40, { mirror: true }),
            sref("RING", 60, 60, { mag: 2 }),
            sref("ARR", 0, 100),
            [record(PATH), record(LAYER, int2(5)), record(DATATYPE, int2(0)),
             record(WIDTH, int4(1)), record(XY, int4(70, 0, 80, 0)), record(ENDEL)]
        ])
    ]);
}
