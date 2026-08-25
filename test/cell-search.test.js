// Unit tests for cell-search.js: the ranking behind the hierarchy panel's find
// box, and the walk that finds the branch the tree has to open to show a cell.
import test from "node:test";
import assert from "node:assert";
import { rankCellMatches, cellPathToTarget } from "../src/cell-search.js";

// The shape build_hierarchy hands back, cut down to what these two functions
// read: a name, and which cells this one places.
function cell(name, refs = []) {
    return { name, polygons: 0, labels: 0, bbox: null, refs: refs.map((index) => ({ cell: index, count: 1 })) };
}

// ---- rankCellMatches --------------------------------------------------------

test("ranks the exact name first, then prefixes, then substrings", () => {
    const cells = [
        cell("SUB_PIXEL"),      // 0: contains it
        cell("PIXEL_ARRAY"),    // 1: starts with it
        cell("PIXEL"),          // 2: is it
        cell("TOP"),            // 3: no
        cell("MY_PIXEL_TAP"),   // 4: contains it
        cell("PIXELS"),         // 5: starts with it
    ];
    assert.deepStrictEqual(rankCellMatches(cells, "PIXEL"), [2, 1, 5, 0, 4]);
});

test("matches case-insensitively, and an exact match ignores case too", () => {
    const cells = [cell("pixel_array"), cell("PiXeL")];
    assert.deepStrictEqual(rankCellMatches(cells, "pixel"), [1, 0]);
    assert.deepStrictEqual(rankCellMatches(cells, "PIXEL"), [1, 0]);
});

test("a query matching nothing, or nothing to match, is empty", () => {
    const cells = [cell("TOP"), cell("SUB")];
    assert.deepStrictEqual(rankCellMatches(cells, "nope"), []);
    // An empty query is "nothing asked for" rather than "everything matches" --
    // the panel shows the tree on it, not a list of the whole library.
    assert.deepStrictEqual(rankCellMatches(cells, ""), []);
    assert.deepStrictEqual(rankCellMatches(cells, "   "), []);
    assert.deepStrictEqual(rankCellMatches([], "TOP"), []);
});

test("survives a cell entry with no usable name", () => {
    const cells = [cell("TOP"), { refs: [] }, null];
    assert.deepStrictEqual(rankCellMatches(cells, "top"), [0]);
});

// ---- cellPathToTarget -------------------------------------------------------

test("finds the path from the top cell down to a nested cell", () => {
    // TOP -> BLOCK -> TAP
    const cells = [cell("TOP", [1]), cell("BLOCK", [2]), cell("TAP")];
    assert.deepStrictEqual(cellPathToTarget(cells, [0], 2, 256), [0, 1, 2]);
    // A top cell is its own path.
    assert.deepStrictEqual(cellPathToTarget(cells, [0], 0, 256), [0]);
});

test("takes the first path in file order when a cell is placed more than once", () => {
    // TOP places LEFT then RIGHT, and both place SHARED.
    const cells = [cell("TOP", [1, 2]), cell("LEFT", [3]), cell("RIGHT", [3]), cell("SHARED")];
    assert.deepStrictEqual(cellPathToTarget(cells, [0], 3, 256), [0, 1, 3]);
});

test("searches every top cell, not just the first", () => {
    const cells = [cell("TOP_A", [2]), cell("TOP_B", [3]), cell("A_SUB"), cell("B_SUB")];
    assert.deepStrictEqual(cellPathToTarget(cells, [0, 1], 3, 256), [1, 3]);
});

test("a cell no top cell places has no path", () => {
    const cells = [cell("TOP", [1]), cell("BLOCK"), cell("ORPHAN")];
    assert.strictEqual(cellPathToTarget(cells, [0], 2, 256), null);
    // ...and neither does an index that isn't a cell at all.
    assert.strictEqual(cellPathToTarget(cells, [0], 7, 256), null);
    assert.strictEqual(cellPathToTarget(cells, [], 1, 256), null);
});

test("a reference cycle terminates instead of being walked forever", () => {
    // TOP -> A -> B -> A ... , with the target nowhere in it.
    const cells = [cell("TOP", [1]), cell("A", [2]), cell("B", [1]), cell("ELSEWHERE")];
    assert.strictEqual(cellPathToTarget(cells, [0], 3, 8), null);
    // The cycle doesn't hide what *is* in it.
    assert.deepStrictEqual(cellPathToTarget(cells, [0], 2, 8), [0, 1, 2]);
});

test("stops at the depth limit rather than descending past it", () => {
    // A chain of six: 0 -> 1 -> ... -> 5.
    const cells = [0, 1, 2, 3, 4, 5].map((i) => cell(`C${i}`, i < 5 ? [i + 1] : []));
    assert.deepStrictEqual(cellPathToTarget(cells, [0], 3, 256), [0, 1, 2, 3]);
    // depth is 0-based at the root, so a limit of 3 reaches C2 and no further.
    assert.deepStrictEqual(cellPathToTarget(cells, [0], 2, 3), [0, 1, 2]);
    assert.strictEqual(cellPathToTarget(cells, [0], 3, 3), null);
});

test("a widely shared hierarchy is walked once, not once per path into it", () => {
    // 40 stacked diamonds: every level places two cells that both place the
    // next level's pair, so there are 2^40 distinct root-to-bottom paths. Only
    // the memo of subtrees that came back empty makes an unreachable target
    // answerable at all -- without it this test does not finish.
    const LEVELS = 40;
    const cells = [];
    for (let level = 0; level < LEVELS; level++) {
        const nextLeft = (level + 1) * 2;
        const children = level + 1 < LEVELS ? [nextLeft, nextLeft + 1] : [];
        cells.push(cell(`L${level}_A`, children));
        cells.push(cell(`L${level}_B`, children));
    }
    const orphan = cells.push(cell("ORPHAN")) - 1;

    const started = process.hrtime.bigint();
    assert.strictEqual(cellPathToTarget(cells, [0, 1], orphan, 256), null);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `took ${elapsedMs.toFixed(1)}ms -- the failed-subtree memo is gone`);

    // And it still finds something that is in there, at the very bottom.
    const bottomRight = (LEVELS - 1) * 2 + 1;
    const path = cellPathToTarget(cells, [0, 1], bottomRight, 256);
    assert.strictEqual(path.length, LEVELS);
    assert.strictEqual(path[path.length - 1], bottomRight);
});
