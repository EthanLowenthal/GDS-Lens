// Searching the cell hierarchy: which cells a typed name matches, and how the
// tree gets down to one of them. This is a standalone script (no imports)
// loaded two ways, following the same pattern as marker-parsers.js and
// load-errors.js: the webview pulls it in via a <script> tag, and Node unit
// tests require() it via the module.exports tail.
//
// Both functions work on the hierarchy model parseGdsToLayers hands back (see
// build_hierarchy in wasm/renderer.cpp): a flat `cells` array of
// {name, polygons, labels, bbox, refs} where each ref is {cell, count, ...},
// plus the indices of the top-level cells. Nothing here touches the DOM or the
// wasm module -- the panel work is in viewer.js.

// Indices of every cell whose name contains `query`, case-insensitively, best
// match first: the exact name, then names that start with the query, then the
// rest. Ordering matters because the panel only builds the first couple of
// hundred rows -- typing a cell's full name should not leave it below thirty
// cells that merely contain it.
function rankCellMatches(cells, query) {
    const needle = String(query).trim().toLowerCase();
    if (!needle) return [];

    const exact = [];
    const prefix = [];
    const rest = [];
    for (let i = 0; i < cells.length; i++) {
        const name = cells[i] && typeof cells[i].name === "string" ? cells[i].name : "";
        const at = name.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        // at >= 0 with equal lengths *is* an exact match -- the needle can only
        // have been found at 0.
        if (name.length === needle.length) exact.push(i);
        else if (at === 0) prefix.push(i);
        else rest.push(i);
    }
    return exact.concat(prefix, rest);
}

// One path of cell indices from a top cell down to `target`, starting at the
// root and ending at the target itself -- or null if no top cell reaches it
// (a reference cycle among non-top cells, or a cell the tree's own caps left
// out of `roots`).
//
// Depth-first, so it's *a* path rather than the shortest one: a cell placed in
// twenty places has twenty paths to it and none is more correct than another,
// so the first one found is as good an answer as any -- and it's the one the
// tree reads down to in the order the file placed things.
//
// `failed` is what keeps this cheap on a real library. References form a DAG,
// so without remembering the subtrees that turned out not to contain the
// target, a design that shares cells widely would re-walk the same ones once
// per path leading into them. `maxDepth` bounds the recursion, which is what
// makes a malformed file that closes a reference loop terminate: a cycle's
// cells are pushed until the limit, then unwound and marked failed.
function cellPathToTarget(cells, roots, target, maxDepth) {
    if (!cells || !cells[target]) return null;
    const limit = maxDepth > 0 ? maxDepth : 1;
    const failed = new Set();
    const path = [];

    function walk(index, depth) {
        path.push(index);
        if (index === target) return true;
        // Not "already on the path": `failed` also covers it, since a cell is
        // only marked once its own walk has come back empty.
        if (depth + 1 < limit && !failed.has(index)) {
            const refs = (cells[index] && cells[index].refs) || [];
            for (const ref of refs) {
                if (!cells[ref.cell]) continue;
                if (walk(ref.cell, depth + 1)) return true;
            }
        }
        path.pop();
        failed.add(index);
        return false;
    }

    for (const root of (roots || [])) {
        if (!cells[root]) continue;
        if (walk(root, 0)) return path;
        // walk() unwinds its own pushes on failure, but a root that failed at
        // depth 0 leaves nothing to unwind -- clear anyway rather than trusting
        // that from out here.
        path.length = 0;
    }
    return null;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { rankCellMatches, cellPathToTarget };
}
