// GDSII properties as the engine hands them to the viewer: on the hierarchy
// (library, cells, and the references collapsed into each row) and on the
// inspect index's hits (the shape or label, and every step of its path).
// Skipped when the wasm bundle hasn't been built.
import test from "node:test";
import assert from "node:assert";
import { loadModule, skip } from "./wasm-build.js";
import { packTag } from "../src/parse-split.js";
import { library, structure, box, sref, text } from "./inspect-fixture.js";

// A NODE element, which gdstk skips. Its property must not land on the cell.
function nodeElement(attr, value) {
    const rec = (type, payload) => {
        const head = Buffer.alloc(4);
        head.writeUInt16BE(4 + payload.length, 0);
        head.writeUInt16BE(type, 2);
        return Buffer.concat([head, payload]);
    };
    const int2 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
    const xy = Buffer.alloc(8);
    const str = Buffer.from(value.length % 2 ? value + "\0" : value, "latin1");
    return [rec(0x1500, Buffer.alloc(0)), rec(0x0D02, int2(9)), rec(0x2A02, int2(0)), rec(0x1003, xy),
            rec(0x2B02, int2(attr)), rec(0x2C06, str), rec(0x1100, Buffer.alloc(0))];
}

const bytes = library([
    structure("CHILD", [
        box(1, 0, 0, 0, 2, 1, [[7, "poly"], [8, "odd"]]),
        text(6, 0, 1, 0.5, "mark", { props: [[3, "a label"]] }),
        nodeElement(99, "node-only")
    ], [[11, "child cell"]]),
    structure("LEAF", [box(3, 0, 0, 0, 1, 1, [[1, "bin\u0001ÿ"]])]),
    structure("TOP", [
        box(2, 0, 0, 0, 10, 10),
        sref("CHILD", 20, 0, { props: [[4, "ref a"]] }),
        sref("CHILD", 30, 0, { props: [[4, "ref b"]] }),
        sref("LEAF", 0, 30, { props: [[8, "shared"]] }),
        sref("LEAF", 5, 30, { props: [[8, "shared"]] })
    ], [[2, "top cell"]])
], { name: "PROPLIB", props: [[1, "the library"]] });

const RANKS = [[1, 0], [2, 0], [3, 0], [6, 0]].flatMap(([l, d], rank) => [packTag(l, d), rank]);

async function moduleWith(data) {
    const Module = await loadModule();
    Module.FS.writeFile("/input.layout", data);
    return Module;
}

test("properties: library, cells and reference rows on the hierarchy", { skip }, async () => {
    const Module = await moduleWith(bytes);
    const { hierarchy } = Module.parseGdsToLayers("/input.layout", {});
    assert.strictEqual(hierarchy.library.name, "PROPLIB");
    assert.deepStrictEqual(JSON.parse(hierarchy.library.properties), [{ attr: 1, value: "the library" }]);

    const cell = (name) => hierarchy.cells.find((c) => c.name === name);
    assert.deepStrictEqual(JSON.parse(cell("TOP").properties), [{ attr: 2, value: "top cell" }]);
    // The NODE's property stays off its cell.
    assert.deepStrictEqual(JSON.parse(cell("CHILD").properties), [{ attr: 11, value: "child cell" }]);
    assert.strictEqual(cell("LEAF").properties, undefined);

    const row = (name) => cell("TOP").refs.find((r) => hierarchy.cells[r.cell].name === name);
    const groups = (r) => r.propertyGroups.map((g) => [JSON.parse(g.properties), g.count]);
    assert.deepStrictEqual(groups(row("CHILD")), [
        [[{ attr: 4, value: "ref a" }], 1],
        [[{ attr: 4, value: "ref b" }], 1]
    ]);
    assert.deepStrictEqual(groups(row("LEAF")), [[[{ attr: 8, value: "shared" }], 2]]);
});

test("properties: hits carry the shape's and each path step's lists", { skip }, async () => {
    const reader = await moduleWith(bytes);
    const built = reader.inspectLoad("/input.layout", { releaseFile: true, snapshot: true });
    assert.ok(built.ok, built.error);
    const lists = JSON.parse(built.snapshot.propertyLists);
    const resolve = (id) => (id ? lists[id - 1] : null);

    // Through the snapshot, as the viewer does it.
    const answerer = await loadModule();
    answerer.inspectRestore(built.snapshot);

    const hit = answerer.inspectAt(31, 0.5, 0.001, RANKS, 8, 0).hits[0];
    assert.deepStrictEqual(resolve(hit.properties), [{ attr: 7, value: "poly" }, { attr: 8, value: "odd" }]);
    assert.deepStrictEqual(hit.path.map((s) => [s.cell, resolve(s.cellProperties), resolve(s.referenceProperties)]), [
        ["TOP", [{ attr: 2, value: "top cell" }], null],
        ["CHILD", [{ attr: 11, value: "child cell" }], [{ attr: 4, value: "ref b" }]]
    ]);

    const leaf = answerer.inspectAt(5.5, 30.5, 0.001, RANKS, 8, 0).hits[0];
    assert.deepStrictEqual(resolve(leaf.properties), [{ attr: 1, value: "bin\\x01\\xff", binary: true }]);
    assert.deepStrictEqual(resolve(leaf.path[1].referenceProperties), [{ attr: 8, value: "shared" }]);

    // Labels too, while text is drawn.
    const label = answerer.inspectAt(21, 0.5, 0.05, RANKS, 8, 0.01).hits.find((h) => h.kind === "label");
    assert.deepStrictEqual(resolve(label.properties), [{ attr: 3, value: "a label" }]);

    // A shape without any.
    const plain = answerer.inspectAt(5, 5, 0.001, RANKS, 8, 0).hits[0];
    assert.strictEqual(plain.properties, 0);
});
