// Plain-Node unit tests for src/marker-parsers.js (run with `npm test` /
// `node --test test/`). DOMParser comes from @xmldom/xmldom -- the parser
// takes the constructor as an argument precisely so these tests don't need a
// browser (see marker-parsers.js's header).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");
const {
    sniffMarkerFormat,
    parsePointList,
    parseLyrdb,
    parseCalibreAscii,
    parseMarkerFile,
    flattenMarkerModel,
} = require("../src/marker-parsers.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const lyrdbText = fixture("sample.lyrdb");
const calibreText = fixture("sample_calibre.txt");
const hierText = fixture("sample_calibre_hier.txt");

const catByName = (model, name) => model.categories.find((c) => c.name === name);

test("sniffMarkerFormat", () => {
    assert.strictEqual(sniffMarkerFormat(lyrdbText), "lyrdb");
    assert.strictEqual(sniffMarkerFormat("﻿ \n" + lyrdbText), "lyrdb");
    assert.strictEqual(sniffMarkerFormat(calibreText), "calibre");
    assert.strictEqual(sniffMarkerFormat("﻿TOP 1000\r\nRULE\n"), "calibre");
    assert.strictEqual(sniffMarkerFormat("<html><body>nope</body></html>"), null);
    assert.strictEqual(sniffMarkerFormat("just some words\nmore words"), null);
    assert.strictEqual(sniffMarkerFormat(""), null);
    assert.throws(() => parseMarkerFile("garbage in", DOMParser), /Unrecognized/);
});

test("parsePointList", () => {
    assert.deepStrictEqual(Array.from(parsePointList("(0,0;1.5,0;1.5,0.2)")), [0, 0, 1.5, 0, 1.5, 0.2]);
    assert.deepStrictEqual(Array.from(parsePointList(" 1,2 ; 3,4 ")), [1, 2, 3, 4]);
    assert.deepStrictEqual(Array.from(parsePointList("(1,2;\n3,4)")), [1, 2, 3, 4]);
    assert.throws(() => parsePointList("(1;2)"));
    assert.throws(() => parsePointList("(a,b)"));
});

test("lyrdb: categories, nesting, lazy defs", () => {
    const model = parseLyrdb(lyrdbText, DOMParser);
    assert.strictEqual(model.topCell, "TOP");
    assert.deepStrictEqual(
        model.categories.map((c) => c.name),
        ["width_check", "space", "space.m2", "empty_cat", "derived_cat"]
    );
    assert.strictEqual(catByName(model, "width_check").description, "M1 width < 0.14");
    assert.strictEqual(catByName(model, "space.m2").description, "M2 space < 0.2");
    assert.strictEqual(catByName(model, "width_check").items.length, 2);
    assert.strictEqual(catByName(model, "space").items.length, 0);
    assert.strictEqual(catByName(model, "space.m2").items.length, 3);
    assert.strictEqual(catByName(model, "empty_cat").items.length, 0);
    assert.strictEqual(catByName(model, "derived_cat").items.length, 1);
});

test("lyrdb: geometry, bboxes, notes", () => {
    const model = parseLyrdb(lyrdbText, DOMParser);
    const [polyItem, boxItem] = catByName(model, "width_check").items;

    assert.strictEqual(polyItem.polygons.length, 1);
    assert.deepStrictEqual(Array.from(polyItem.polygons[0]), [0, 0, 1.5, 0, 1.5, 0.2, 0, 0.2]);
    assert.deepStrictEqual(polyItem.bbox, { minX: 0, minY: 0, maxX: 1.5, maxY: 0.2 });

    assert.strictEqual(boxItem.polygons.length, 1);
    assert.deepStrictEqual(Array.from(boxItem.polygons[0]), [2, 1, 3, 1, 3, 2, 2, 2]);
    assert.match(boxItem.note, /×3/);

    const [edgeItem, edgePairItem, floatItem] = catByName(model, "space.m2").items;
    assert.deepStrictEqual(Array.from(edgeItem.edges), [0, 5, 2, 5]);
    assert.deepStrictEqual(edgeItem.bbox, { minX: 0, minY: 5, maxX: 2, maxY: 5 });
    assert.deepStrictEqual(Array.from(edgePairItem.edges), [0, 6, 2, 6, 0, 6.5, 2, 6.5]);

    // float: no geometry, raw value kept in the note, non-top cell flagged.
    assert.strictEqual(floatItem.bbox, null);
    assert.strictEqual(floatItem.polygons.length, 0);
    assert.strictEqual(floatItem.edges.length, 0);
    assert.match(floatItem.note, /cell SUB/);
    assert.match(floatItem.note, /float: 0.125/);

    // Multi-line value text tolerated.
    const derived = catByName(model, "derived_cat").items[0];
    assert.deepStrictEqual(derived.bbox, { minX: 10, minY: 10, maxX: 11, maxY: 11 });

    // ids are global and sequential in category-major order.
    const ids = model.categories.flatMap((c) => c.items.map((it) => it.id));
    assert.deepStrictEqual(ids, [0, 1, 2, 3, 4, 5]);

    assert.strictEqual(model.warnings.length, 2);
    assert.match(model.warnings[0], /1 marker\(s\) reference non-top cells/);
    assert.match(model.warnings[1], /float/);
});

test("lyrdb: polygon hole rings split", () => {
    const text = `<report-database><top-cell>T</top-cell><items><item><cell>T</cell>
        <category>'holes'</category><values>
        <value>polygon: (0,0;10,0;10,10;0,10/2,2;8,2;8,8;2,8)</value>
        </values></item></items></report-database>`;
    const model = parseLyrdb(text, DOMParser);
    const item = model.categories[0].items[0];
    assert.strictEqual(item.polygons.length, 2);
    assert.deepStrictEqual(item.bbox, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
});

test("lyrdb: rejects non-report XML", () => {
    assert.throws(() => parseLyrdb("<root><report-database/></root>", DOMParser), /report-database/);
});

test("calibre: rulechecks, scaling, descriptions", () => {
    const model = parseCalibreAscii(calibreText);
    assert.strictEqual(model.topCell, "TOPCELL");
    assert.deepStrictEqual(
        model.categories.map((c) => c.name),
        ["M2.SPACING.1", "M1.WIDTH", "EMPTY.CHECK"]
    );
    const spacing = catByName(model, "M2.SPACING.1");
    assert.strictEqual(spacing.description, "M2 space < 0.14 second description line");
    assert.strictEqual(spacing.items.length, 2);

    // precision 2000: integer coords divided by 2000 into µm.
    const [p1, e2] = spacing.items;
    assert.strictEqual(p1.label, "p 1");
    assert.deepStrictEqual(Array.from(p1.polygons[0]), [0.5, 1, 0.75, 1, 0.75, 1.2, 0.5, 1.2]);
    assert.deepStrictEqual(p1.bbox, { minX: 0.5, minY: 1, maxX: 0.75, maxY: 1.2 });

    // Even edge cluster: 4 vertices -> 2 independent edges.
    assert.strictEqual(e2.label, "e 2");
    assert.deepStrictEqual(Array.from(e2.edges), [1.5, 0.25, 1.8, 0.25, 1.5, 0.35, 1.8, 0.35]);

    // Odd edge cluster: polyline -> consecutive-vertex edges + a warning.
    const width = catByName(model, "M1.WIDTH");
    assert.strictEqual(width.items.length, 1);
    assert.deepStrictEqual(Array.from(width.items[0].edges), [0, 0, 0.5, 0, 0.5, 0, 0.5, 0.5]);
    assert.ok(model.warnings.some((w) => /odd vertex count 3/.test(w)));

    assert.strictEqual(catByName(model, "EMPTY.CHECK").items.length, 0);

    const ids = model.categories.flatMap((c) => c.items.map((it) => it.id));
    assert.deepStrictEqual(ids, [0, 1, 2]);
});

test("calibre: CRLF + blank lines tolerated", () => {
    const crlf = calibreText.replace(/\n/g, "\r\n").replace("p 1 4", "\r\np 1 4");
    const model = parseCalibreAscii(crlf);
    assert.strictEqual(catByName(model, "M2.SPACING.1").items.length, 2);
});

test("calibre: hierarchical CN records skipped with warning", () => {
    const model = parseCalibreAscii(hierText);
    assert.strictEqual(model.categories.length, 1);
    const item = model.categories[0].items[0];
    assert.strictEqual(item.polygons[0].length, 8);
    assert.deepStrictEqual(item.bbox, { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 });
    assert.ok(model.warnings.some((w) => /hierarchical/.test(w)));
});

test("parseMarkerFile dispatches by content", () => {
    assert.strictEqual(parseMarkerFile(lyrdbText, DOMParser).topCell, "TOP");
    assert.strictEqual(parseMarkerFile(calibreText, DOMParser).topCell, "TOPCELL");
});

test("flattenMarkerModel packs geometry per item id", () => {
    const model = parseLyrdb(lyrdbText, DOMParser);
    const flat = flattenMarkerModel(model);

    assert.strictEqual(flat.categories.length, 5);
    assert.deepStrictEqual(flat.categories[0], { itemStart: 0, itemCount: 2 });
    assert.strictEqual(flat.itemCategory.length, 6);
    // width_check items -> category 0; space.m2 -> category 2; derived -> 4.
    assert.deepStrictEqual(Array.from(flat.itemCategory), [0, 0, 2, 2, 2, 4]);

    // 3 rings (polygon, box, derived box) of 4 vertices each.
    assert.deepStrictEqual(Array.from(flat.polyVertCounts), [4, 4, 4]);
    assert.deepStrictEqual(Array.from(flat.polyItemIds), [0, 1, 5]);
    assert.strictEqual(flat.polyVerts.length, 24);

    // 3 segments: one edge + two from the edge-pair.
    assert.deepStrictEqual(Array.from(flat.edgeItemIds), [2, 3, 3]);
    assert.strictEqual(flat.edgeVerts.length, 12);

    // Geometry-less item gets the min>max sentinel bbox.
    assert.deepStrictEqual(Array.from(flat.itemBBoxes.slice(4 * 4, 4 * 4 + 4)), [0, 0, -1, -1]);
    // First item's bbox survives the Float32 round trip.
    assert.deepStrictEqual(Array.from(flat.itemBBoxes.slice(0, 4)), [0, 0, 1.5, 0.20000000298023224]);
});
