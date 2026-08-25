// Plain-Node unit tests for src/coord-parse.js (run with `npm test` /
// `node --test test/`). The parser backs the "GDSLens: Go to Coordinate"
// command's input box, including its as-you-type validation, so what it
// accepts and what it refuses are both worth pinning down.
import test from "node:test";
import assert from "node:assert";
import { parseCoordinatePair } from "../src/coord-parse.js";

test("plain pairs, in microns", () => {
    assert.deepStrictEqual(parseCoordinatePair("12.5, -40"), { x: 12.5, y: -40 });
    assert.deepStrictEqual(parseCoordinatePair("12.5 -40"), { x: 12.5, y: -40 });
    assert.deepStrictEqual(parseCoordinatePair("12.5; -40"), { x: 12.5, y: -40 });
    assert.deepStrictEqual(parseCoordinatePair("  0,0  "), { x: 0, y: 0 });
    assert.deepStrictEqual(parseCoordinatePair(".5, -.25"), { x: 0.5, y: -0.25 });
    assert.deepStrictEqual(parseCoordinatePair("1e3, -2.5E-2"), { x: 1000, y: -0.025 });
});

test("the decorations coordinates arrive wrapped in", () => {
    assert.deepStrictEqual(parseCoordinatePair("(12.5, -40)"), { x: 12.5, y: -40 });
    assert.deepStrictEqual(parseCoordinatePair("x=12.5, y=-40"), { x: 12.5, y: -40 });
    assert.deepStrictEqual(parseCoordinatePair("X: 12.5 Y: -40"), { x: 12.5, y: -40 });
    assert.deepStrictEqual(parseCoordinatePair("(12.5;-40)"), { x: 12.5, y: -40 });
});

test("per-number units, converted to microns", () => {
    assert.deepStrictEqual(parseCoordinatePair("300nm, 1.5um"), { x: 0.3, y: 1.5 });
    assert.deepStrictEqual(parseCoordinatePair("1.2mm, 300nm"), { x: 1200, y: 0.3 });
    assert.deepStrictEqual(parseCoordinatePair("1 µm, 2 μm"), { x: 1, y: 2 });  // MICRO SIGN, then GREEK MU
    assert.deepStrictEqual(parseCoordinatePair("1NM, 2MM"), { x: 1e-3, y: 2000 });
    // A unit on one number only -- the other stays microns.
    assert.deepStrictEqual(parseCoordinatePair("500nm, 2"), { x: 0.5, y: 2 });
});

test("rejects anything that isn't a pair", () => {
    assert.strictEqual(parseCoordinatePair(""), null);
    assert.strictEqual(parseCoordinatePair("   "), null);
    assert.strictEqual(parseCoordinatePair("12.5"), null);
    assert.strictEqual(parseCoordinatePair("not a coordinate"), null);
    // A third number means the text wasn't a coordinate pair, so it's refused
    // rather than half-read as its first two.
    assert.strictEqual(parseCoordinatePair("1 2 3"), null);
    // Leftover words on either side, likewise.
    assert.strictEqual(parseCoordinatePair("cell TOP at 1, 2"), null);
    assert.strictEqual(parseCoordinatePair("1, 2 in metal1"), null);
});

test("state doesn't leak between calls", () => {
    // COORD_TOKEN is a /g regex shared across calls, so a run that stops early
    // (two matches found, or a rejection) must not leave lastIndex behind.
    assert.deepStrictEqual(parseCoordinatePair("1, 2"), { x: 1, y: 2 });
    assert.strictEqual(parseCoordinatePair("1 2 3"), null);
    assert.deepStrictEqual(parseCoordinatePair("1, 2"), { x: 1, y: 2 });
});
