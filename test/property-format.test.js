// Property lists as display rows: plain properties pass through, and cell
// metadata in META('key')=value form becomes one readable row per entry.
import test from "node:test";
import assert from "node:assert";

import { propertyRows } from "../src/property-format.js";

const CONTEXT = [
    "META('kfactory:function_name')='mmi_1x2_sin_c_te'",
    "META('kfactory:info')={'tower_cell'=>'mmi_1x2_CDNS_7319765003449'}",
    "META('kfactory:ports:0')={'cross_section'=>'6a105480_700','info'=>{'cross_section'=>'nitride'},'name'=>'in0','port_type'=>'optical','trans'=>[trans:r180 0,0]}",
    "META('kfactory:ports:1')={'cross_section'=>'6a105480_700','info'=>{'cross_section'=>'nitride'},'name'=>'out0','port_type'=>'optical','trans'=>[trans:r0 99252,-2500]}"
];

test("plain GDSII and OASIS properties pass through", () => {
    const rows = propertyRows([
        { attr: 1, value: "net=VDD" },
        { name: "S_CELL_OFFSET", values: [12, "text", null] },
        { attr: 2, value: "\\x01", binary: true }
    ]);
    assert.deepStrictEqual(rows.map((r) => [r.key, r.value, r.binary]), [
        ["1", "net=VDD", false],
        ["S_CELL_OFFSET", "12, text, null", false],
        ["2", "\\x01", true]
    ]);
});

test("a KLAYOUT_CONTEXT property becomes one row per META entry", () => {
    const rows = propertyRows([{ name: "KLAYOUT_CONTEXT", values: [...CONTEXT, "LIB=Basic"] }]);
    assert.deepStrictEqual(rows.map((r) => r.key), [
        "kfactory:function_name", "kfactory:info", "kfactory:ports:0", "kfactory:ports:1", "KLAYOUT_CONTEXT"
    ]);
    assert.strictEqual(rows[0].value, "mmi_1x2_sin_c_te");
    assert.strictEqual(rows[1].value, "tower_cell: mmi_1x2_CDNS_7319765003449");
    assert.strictEqual(rows[2].value, [
        "cross_section: 6a105480_700",
        "info:",
        "  cross_section: nitride",
        "name: in0",
        "port_type: optical",
        "trans: r180 0,0"
    ].join("\n"));
    assert.strictEqual(rows[3].line,
        "{cross_section: 6a105480_700, info: {cross_section: nitride}, name: out0, port_type: optical, trans: r0 99252,-2500}");
    assert.strictEqual(rows[4].value, "LIB=Basic");
});

test("tagged numbers, lists, escapes and typed META keys", () => {
    const [row] = propertyRows([{ name: "KLAYOUT_CONTEXT", values: [
        "META('w',double)={'width'=>#l500,'pts'=>(#1,##2.5),'s'=>'it\\'s','n'=>nil}"
    ] }]);
    assert.strictEqual(row.key, "w");
    assert.strictEqual(row.value, "width: 500\npts: (1, 2.5)\ns: it's\nn: nil");
});

test("unparsable META values are shown raw", () => {
    const [row] = propertyRows([{ name: "KLAYOUT_CONTEXT", values: ["META('x')={'a'=>1} trailing"] }]);
    assert.strictEqual(row.key, "x");
    assert.strictEqual(row.value, "{'a'=>1} trailing");
});

test("GDSII context strings, whole and in pieces", () => {
    const rows = propertyRows([
        { attr: 0, value: "META('kfactory:function_name')='mmi'" },
        { attr: 1, value: "#7,1:'out0'}" },
        { attr: 2, value: "#7,0:META('kfactory:ports:1')={'name'=>" },
        { attr: 3, value: "other" }
    ]);
    assert.deepStrictEqual(rows.map((r) => [r.key, r.value]), [
        ["kfactory:function_name", "mmi"],
        ["kfactory:ports:1", "name: out0"],
        ["3", "other"]
    ]);
});
