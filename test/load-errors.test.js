// Unit tests for src/load-errors.js. The strings matched here are the real
// ones a too-large layout produces -- "memory access out of bounds" and
// "Aborted()" were both observed from the built wasm module by parsing a
// hierarchy that flattens to ~800M polygons (before and after raising
// MAXIMUM_MEMORY to 4GB respectively).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { describeLoadFailure, isOutOfMemory } = require("../src/load-errors.js");

test("classifies the wasm out-of-memory failures", () => {
    const oomErrors = [
        new WebAssembly.RuntimeError("memory access out of bounds"),
        new WebAssembly.RuntimeError("Aborted(). Build with -sASSERTIONS for more info."),
        new Error("Cannot enlarge memory arrays to size 4294967296 bytes"),
        new RangeError("Array buffer allocation failed"),
        new RangeError("Invalid typed array length: 1099511627776"),
    ];
    for (const err of oomErrors) {
        assert.ok(isOutOfMemory(err), `expected OOM: ${err.message}`);
        const described = describeLoadFailure(err);
        assert.match(described, /too large to open/);
        // The raw engine text is kept in parentheses -- useless to most
        // users, but the first thing a bug report needs.
        assert.ok(described.includes(err.message), "raw text should be retained");
    }
});

test("passes other failures through, with the caller's prefix", () => {
    const err = new Error("Invalid GDSII file");
    assert.strictEqual(isOutOfMemory(err), false);
    assert.strictEqual(describeLoadFailure(err), "Invalid GDSII file");
    assert.strictEqual(
        describeLoadFailure(err, "Layout worker failed"),
        "Layout worker failed: Invalid GDSII file");
});

test("an out-of-memory failure keeps its own wording despite a prefix", () => {
    // The layout is the cause, not whichever component noticed first.
    const described = describeLoadFailure(
        new WebAssembly.RuntimeError("Aborted()"), "Layout worker failed");
    assert.match(described, /too large to open/);
    assert.ok(!described.startsWith("Layout worker failed"));
});

test("handles non-Error throws", () => {
    assert.strictEqual(describeLoadFailure("plain string"), "plain string");
    assert.match(describeLoadFailure("out of memory"), /too large to open/);
    assert.doesNotThrow(() => describeLoadFailure(undefined));
    assert.doesNotThrow(() => describeLoadFailure(null));
});
