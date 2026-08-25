// Headless test for label (TEXT element) handling in renderer.cpp: evals the
// built gdstk_wasm.js in plain Node (no GL context needed -- this only
// exercises parseGdsToLayers's CPU half) and asserts labels are flattened out
// of the hierarchy onto the right layers, including the two paths that carry
// them: cells walked directly, and cells reused often enough to be GPU
// instanced (whose labels are expanded once per placement instead).
//
// The layout is built here rather than checked in as a fixture -- it's a
// handful of GDSII records, and writing them out beats a binary blob nothing
// in the repo can regenerate.
import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";

import { fileURLToPath } from "node:url";
import { loadModule, skip } from "./wasm-build.js";

// ESM has no __dirname; every path below is relative to this file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- minimal GDSII writer ---------------------------------------------------
// Every record is [uint16 total length][uint8 record type][uint8 data type]
// followed by big-endian data; ASCII data is NUL-padded to an even length.
const NO_DATA = 0x00, BITARRAY = 0x01, INT2 = 0x02, INT4 = 0x03, REAL8 = 0x05, ASCII = 0x06;

function record(recordType, dataType, data = Buffer.alloc(0)) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(data.length + 4, 0);
    header[2] = recordType;
    header[3] = dataType;
    return Buffer.concat([header, data]);
}

function int2(...values) {
    const buf = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => buf.writeInt16BE(v, i * 2));
    return buf;
}

function int4(...values) {
    const buf = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => buf.writeInt32BE(v, i * 4));
    return buf;
}

function ascii(text) {
    const bytes = Buffer.from(text, "ascii");
    return bytes.length % 2 === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(1)]);
}

// GDSII 8-byte real: sign + 7-bit excess-64 exponent (power of 16) + 56-bit
// mantissa, i.e. value = mantissa / 2^56 * 16^(exponent - 64).
function real8(value) {
    const buf = Buffer.alloc(8);
    if (value === 0) return buf;
    let sign = 0;
    if (value < 0) {
        sign = 0x80;
        value = -value;
    }
    let exponent = 64;
    while (value >= 1) { value /= 16; exponent++; }
    while (value < 1 / 16) { value *= 16; exponent--; }
    buf[0] = sign | exponent;
    for (let i = 1; i < 8; i++) {
        value *= 256;
        const byte = Math.floor(value);
        buf[i] = byte;
        value -= byte;
    }
    return buf;
}

const ZERO_DATE = int2(...new Array(12).fill(0));

// A TEXT element. `presentation` is the GDSII bit array whose low nibble holds
// the justification: bits 3-2 vertical (0 top, 1 middle, 2 bottom) and bits
// 1-0 horizontal (0 left, 1 center, 2 right). That nibble *is* gdstk's Anchor
// enum -- its reader takes it verbatim (`anchor = data16[0] & 0x000F`).
function text(layer, texttype, x, y, string, presentation = 0) {
    return Buffer.concat([
        record(0x0c, NO_DATA),
        record(0x0d, INT2, int2(layer)),
        record(0x16, INT2, int2(texttype)),
        record(0x17, BITARRAY, int2(presentation)),
        record(0x10, INT4, int4(x, y)),
        record(0x19, ASCII, ascii(string)),
        record(0x11, NO_DATA),
    ]);
}

function boundary(layer, datatype, x0, y0, x1, y1) {
    return Buffer.concat([
        record(0x08, NO_DATA),
        record(0x0d, INT2, int2(layer)),
        record(0x0e, INT2, int2(datatype)),
        record(0x10, INT4, int4(x0, y0, x1, y0, x1, y1, x0, y1, x0, y0)),
        record(0x11, NO_DATA),
    ]);
}

function sref(cellName, x, y) {
    return Buffer.concat([
        record(0x0a, NO_DATA),
        record(0x12, ASCII, ascii(cellName)),
        record(0x10, INT4, int4(x, y)),
        record(0x11, NO_DATA),
    ]);
}

function structure(name, elements) {
    return Buffer.concat([
        record(0x05, INT2, ZERO_DATE),
        record(0x06, ASCII, ascii(name)),
        ...elements,
        record(0x07, NO_DATA),
    ]);
}

// Coordinates are in database units of 1 nm (see the UNITS record below), and
// parseGdsToLayers normalizes everything to microns -- so 1000 here is 1 um.
const PLACEMENTS = 10;  // >= kInstanceThreshold (8), so PIN_CELL gets instanced

function buildLayout() {
    return Buffer.concat([
        record(0x00, INT2, int2(600)),
        record(0x01, INT2, ZERO_DATE),
        record(0x02, ASCII, ascii("LABELS")),
        // 1 nm database unit, 1000 db units per user unit.
        record(0x03, REAL8, Buffer.concat([real8(1e-3), real8(1e-9)])),
        // A cell whose only content is text, placed often enough to be GPU
        // instanced -- covers both the label-only layer and the per-instance
        // label expansion.
        structure("PIN_CELL", [text(5, 2, 0, 0, "PIN")]),
        // Placed twice, so it stays part of the plain (non-instanced) walk.
        structure("SUB", [
            boundary(2, 0, 0, 0, 1000, 1000),
            text(2, 0, 500, 500, "sub_box"),
        ]),
        structure("TOP", [
            boundary(1, 0, 0, 0, 10000, 5000),
            text(1, 0, 2000, 3000, "TOPLABEL"),
            // Bottom-left justified (vertical 2, horizontal 0) -> Anchor::SW.
            text(1, 0, 4000, 1000, "SW_ANCHORED", (2 << 2) | 0),
            ...Array.from({ length: PLACEMENTS }, (_, i) => sref("PIN_CELL", i * 500, 2000)),
            sref("SUB", 0, 0),
            sref("SUB", 2000, 0),
        ]),
        record(0x04, NO_DATA),
    ]);
}

function parseLayout(Module, bytes) {
    Module.FS.writeFile("/input.layout", new Uint8Array(bytes));
    try {
        return Module.parseGdsToLayers("/input.layout");
    } finally {
        Module.FS.unlink("/input.layout");
    }
}

// Undoes attach_labels' packing: one flat byte blob plus a length per label.
function decodeLabels(layer) {
    const labels = [];
    let cursor = 0;
    for (let i = 0; i < layer.textLengths.length; i++) {
        const length = layer.textLengths[i];
        labels.push({
            text: Buffer.from(layer.textChars.slice(cursor, cursor + length)).toString("ascii"),
            x: layer.textOrigins[i * 2],
            y: layer.textOrigins[i * 2 + 1],
            anchor: layer.textAnchors[i],
        });
        cursor += length;
    }
    return labels;
}

function findLayer(result, layer, datatype) {
    return result.layers.find((entry) => entry.layer === layer && entry.datatype === datatype);
}

test("flattens labels onto their layers, including instanced cells", { skip }, async () => {
    const Module = await loadModule();
    const result = parseLayout(Module, buildLayout());
    assert.strictEqual(result.ok, true, result.error);

    // 2 in TOP + 1 per PIN_CELL placement + 1 per SUB placement.
    assert.strictEqual(result.totalLabels, BigInt(2 + PLACEMENTS + 2));
    assert.strictEqual(result.labelsCapped, false);

    // Labels ride on the layer they name, alongside that layer's geometry.
    const top = findLayer(result, 1, 0);
    const topLabels = decodeLabels(top);
    assert.deepStrictEqual(topLabels.map((l) => l.text).sort(), ["SW_ANCHORED", "TOPLABEL"]);
    const topLabel = topLabels.find((l) => l.text === "TOPLABEL");
    // Database units (1 nm) normalized to microns.
    assert.deepStrictEqual([topLabel.x, topLabel.y], [2, 3]);
    // An all-zero presentation is top + left justified, i.e. Anchor::NW (0).
    assert.strictEqual(topLabel.anchor, 0);
    assert.strictEqual(topLabels.find((l) => l.text === "SW_ANCHORED").anchor, 8);

    // A cell placed twice is walked directly, so its label lands once per
    // placement at the placement's world position.
    const subLabels = decodeLabels(findLayer(result, 2, 0));
    assert.deepStrictEqual(subLabels.map((l) => [l.text, l.x, l.y]).sort((a, b) => a[1] - b[1]),
        [["sub_box", 0.5, 0.5], ["sub_box", 2.5, 0.5]]);

    // A cell reused past the instancing threshold has no geometry of its own
    // in the layer list -- but its labels are still expanded per placement,
    // onto a layer that exists only because of them.
    const pinLayer = findLayer(result, 5, 2);
    assert.ok(pinLayer, "expected a layer entry for the label-only texttype 5/2");
    assert.strictEqual(pinLayer.outlineVertices.length, 0);
    const pinLabels = decodeLabels(pinLayer);
    assert.strictEqual(pinLabels.length, PLACEMENTS);
    assert.ok(pinLabels.every((l) => l.text === "PIN"));
    assert.deepStrictEqual(pinLabels.map((l) => l.x).sort((a, b) => a - b),
        Array.from({ length: PLACEMENTS }, (_, i) => i * 0.5));
    assert.ok(pinLabels.every((l) => l.y === 2));

    // Label origins are part of the design bbox: TOP's box spans 10x5 um and
    // every label sits inside it, so the frame is unchanged by them.
    assert.deepStrictEqual(result.bbox, { minX: 0, maxX: 10, minY: 0, maxY: 5 });
});

test("a layout with no labels reports none", { skip }, async () => {
    const Module = await loadModule();
    const bytes = fs.readFileSync(path.join(__dirname, "fixtures", "sample_layout.gds"));
    const result = parseLayout(Module, bytes);
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.totalLabels, 0n);
    // Every layer entry still carries the (empty) text arrays, so the upload
    // path never has to special-case their absence.
    for (const layer of result.layers) {
        assert.strictEqual(layer.textLengths.length, 0);
        assert.strictEqual(layer.textChars.length, 0);
    }
});
