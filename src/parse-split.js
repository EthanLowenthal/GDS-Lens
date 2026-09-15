// Decides how to split one layout parse across several Workers, and works out
// what each of them should read.
//
// The viewer's load is dominated by triangulation -- on a large layout it is
// four fifths of the wall clock, with the parse and flatten that feed it
// taking the rest -- and triangulation is per-polygon work with no
// dependencies between polygons. The obvious fix is to do it on more than one
// core, and the way this codebase can reach more than one core is more
// Workers: wasm threads would need SharedArrayBuffer, which needs the
// embedding page to be cross-origin isolated, which is not something a library
// can ask of every host that puts a <gds-lens> on a page (and which a VS Code
// webview does not offer at all).
//
// So each Worker instead runs its own copy of the wasm module over its own
// copy of the file, and reads only the layers it was assigned -- gdstk's
// read_gds() takes a tag filter, and parseGdsToLayers() passes one through
// (see the sharding options on it). Nothing is shared, nothing is locked, and
// the main thread concatenates the per-layer geometry that comes back.
//
// What that costs is the parse: every shard walks the whole file, because the
// records it must skip are only identifiable by reading them. That duplicated
// parse is the floor on how much splitting can buy, and it is why shard count
// is chosen against the file's size rather than just the core count -- see
// planShards.
//
// No imports, no DOM and no wasm, the same shape as layout-bytes.js.
"use strict";

// GDSII record types, from the subset this scan cares about. Same values as
// gdstk's GdsiiRecord enum (third_party/gdstk/include/gdstk/gdsii.hpp); only
// the element-shaped records are listed, since everything else is skipped by
// its own length.
const REC_BOUNDARY = 0x08;
const REC_PATH = 0x09;
const REC_LAYER = 0x0d;
const REC_DATATYPE = 0x0e;
const REC_XY = 0x10;
const REC_ENDEL = 0x11;
const REC_BOX = 0x2d;
const REC_BOXTYPE = 0x2e;

// A GDSII file opens with a HEADER record: 6 bytes long, record type 0x00,
// data type 0x02 (two-byte signed int). Checking that before walking keeps
// this from grinding through an OASIS file -- or anything else -- record by
// record only to produce nonsense.
function looksLikeGds(bytes) {
    return !!bytes && bytes.length >= 6 && bytes[0] === 0x00 && bytes[1] === 0x06 &&
           bytes[2] === 0x00 && bytes[3] === 0x02;
}

// A layer/datatype pair as one number, matching the packing gdstk's Tag uses
// (datatype in the high half, layer in the low half) so the result can be
// handed to parseGdsToLayers's `tags` option untouched. Both halves are 16-bit
// in GDSII, so this stays well inside a double's exact-integer range.
function packTag(layer, datatype) {
    return datatype * 2 ** 32 + layer;
}

// Walks the record headers of a GDSII file and totals up, for each
// layer/datatype pair, how many polygon points sit on it and how many polygons
// those points belong to. Returns null for anything that is
// not GDSII (OASIS, above all -- its records are not laid out this way), and
// for a file whose records do not tile it exactly, which means the walk
// desynchronized and the totals cannot be trusted.
//
// This is a header walk, not a parse: it reads each record's 4-byte prologue
// and jumps by the length it declares, touching element payloads only for the
// two-byte layer and datatype numbers. That is why it is worth doing at all --
// it costs a fraction of a second even on a very large file, against the several
// seconds a real parse takes, which is what makes it affordable on the
// critical path before any Worker has started.
//
// The counts are deliberately rough. They are taken per cell *definition*,
// before any hierarchy is flattened, so a cell placed a thousand times counts
// once; a PATH counts its centerline points rather than the outline it will
// expand to; and TEXT elements are not counted at all, having no geometry.
// planShards only needs them to be roughly proportional to work.
function scanGdsTags(bytes) {
    if (!looksLikeGds(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.byteLength;
    // tag -> {points, polygons}. The point total stands in for how much work
    // the layer is; the polygon count is how finely that work can be divided,
    // since a polygon is the smallest thing a shard can be given.
    const perTag = new Map();

    let pos = 0;
    let layer = -1;
    let datatype = -1;
    let elementPoints = 0;
    let inElement = false;

    while (pos + 4 <= end) {
        const length = view.getUint16(pos, false);
        // A record shorter than its own header means the walk has lost the
        // record boundary; anything counted past that point is noise.
        if (length < 4) return null;
        switch (bytes[pos + 2]) {
            case REC_BOUNDARY:
            case REC_PATH:
            case REC_BOX:
                inElement = true;
                layer = -1;
                datatype = -1;
                elementPoints = 0;
                break;
            case REC_LAYER:
                if (length >= 6) layer = view.getInt16(pos + 4, false);
                break;
            // BOXTYPE is to a BOX what DATATYPE is to a BOUNDARY; a PATH uses
            // DATATYPE itself. Either way it is the element's second number.
            case REC_DATATYPE:
            case REC_BOXTYPE:
                if (length >= 6) datatype = view.getInt16(pos + 4, false);
                break;
            // XY holds pairs of 4-byte coordinates, and may be split across
            // several records for a long boundary.
            case REC_XY:
                elementPoints += (length - 4) / 8;
                break;
            case REC_ENDEL:
                if (inElement && layer >= 0 && datatype >= 0) {
                    const tag = packTag(layer, datatype);
                    const seen = perTag.get(tag);
                    if (seen) {
                        seen.points += elementPoints;
                        seen.polygons++;
                    } else {
                        perTag.set(tag, { points: elementPoints, polygons: 1 });
                    }
                }
                inElement = false;
                break;
        }
        pos += length;
    }

    // The last record has to land exactly on the end of the file. Overshooting
    // it means some record's declared length was wrong and the walk has been
    // reading arbitrary bytes as record headers ever since.
    if (pos !== end) return null;
    return perTag;
}

// Peak memory, not core count, is what bounds how many shards a layout can be
// split into. Every shard holds its own copy of the file and its own parse's
// working set, and that working set does not shrink in proportion to the tags
// the shard keeps: gdstk's reader builds each polygon in full and frees it
// again if its tag is outside the filter, so the heap still grows to hold
// roughly the whole design once. Measured on a very large layout, one shard
// of eight peaked around 2 GB against 5 GB for the unsplit parse -- a bit
// over four times the file, however few layers it was asked for.
//
// The same duplicated work is why the speedup falls away on the largest files
// rather than holding. A mid-size layout splits eight ways and parses 3.7x
// faster; a very large one manages 1.3x across two shards and 1.5x across six,
// because every shard walks every record and N of those walks at once saturate
// memory bandwidth long before they saturate the cores. Paying two or three
// extra gigabytes for the last of that is a bad trade in a browser tab, which
// is what the budget below is set to avoid: it runs out at a few hundred
// megabytes, and past that a layout parses in one Worker as it always has.
//
// Both limits have the same fix, which is to teach gdstk's reader to skip a
// filtered shape at its LAYER/DATATYPE record rather than after building it.
// That would cut the per-shard footprint and the per-shard parse together, at
// which point this can be loosened a long way.
const SHARD_PEAK_FACTOR = 4;
const TOTAL_MEMORY_BUDGET = 2 * 1024 * 1024 * 1024;

// Below this there is nothing to win: the fixed cost of starting a Worker and
// instantiating a second copy of the wasm module is a larger share of the load
// than the triangulation being split.
const MIN_SPLIT_BYTES = 4 * 1024 * 1024;

// Leaves a core for the main thread (which still has to upload the geometry
// and draw) and for whatever else the machine is doing. navigator is absent
// under Node and in some Workers, hence the guard.
function coreBudget() {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(8, cores - 1));
}

// How many shards to split a layout of this size into.
function shardCount(byteLength, cores = coreBudget()) {
    if (!(byteLength >= MIN_SPLIT_BYTES)) return 1;
    const affordable = Math.floor(TOTAL_MEMORY_BUDGET / (SHARD_PEAK_FACTOR * byteLength));
    return Math.max(1, Math.min(cores, affordable));
}

// A layer too heavy for one shard is divided by handing each shard every Nth
// polygon of it. Below this many polygons there is nothing to divide -- and a
// layer of three polygons spread over three shards is three parses to save
// nothing -- so such a layer is always given to one shard whole.
const MIN_POLYGONS_PER_STRIPE = 32;

// Striping is aimed at pieces this many times smaller than one shard's share,
// rather than at exactly one share. Cutting the work finer than the number of
// shards is what lets a greedy assignment absorb a bad estimate: a layer that
// costs twice what its point count suggested is then two or three pieces
// spread over different shards instead of one shard's whole allocation.
//
// Measured on a mid-size layout across eight shards, where the per-shard
// triangulation spread was 159-340 ms with whole layers: at 2 the spread
// closes to roughly 1.2x and the load drops from 510 ms to 441 ms, for 6% more
// peak memory (every shard sharing a layer reads all of it). At 4 the load
// drops a further 10 ms for 23% more memory, which is not a trade worth
// making.
const STRIPE_OVERSUBSCRIBE = 2;

// Triangulation cost is not proportional to point count, and the gap is wide
// enough to decide whether splitting is worth doing at all. A convex polygon
// is filled by a fan over its points in one linear pass; a concave one goes
// through ear clipping, which measured ten times dearer per point (20 ms per
// million points on a layer of rectangles against 250 on a layer of curves).
//
// Nothing in the file says which a polygon is without reading its points, but
// the average points per polygon on a layer is a fair stand-in: a layer
// averaging four or five points is rectangles, and rectangles are convex.
// Weighting each layer's points by that guess gives an estimate of the work a
// split would divide -- used both to balance the shards and, below, to decide
// whether there is enough of it to bother.
const SIMPLE_POLYGON_POINTS = 8;
const COMPLEX_POLYGON_WEIGHT = 10;

// Splitting doubles the parse -- more than doubles it, since shards contend
// for memory bandwidth -- and only divides the triangulation, so a design with
// little triangulation in it comes out slower. Measured on a layout of small
// rectangles: 205 ms in one Worker against 221 ms across eight, the
// per-shard parse going from 61 ms to 131 ms to divide 72 ms of triangulation.
//
// This is where that design falls below and the designs that gain fall above,
// with the nearest on either side at 6.0M and 8.5M weighted points.
const MIN_SPLIT_WORK = 8e6;

// Same idea for the design as a whole: a layout with only a handful of
// polygons in it parses faster than a second Worker takes to start. This is a
// backstop rather than the real gate -- MIN_SPLIT_BYTES already turns away
// anything small -- so it is set low enough not to refuse a design that is a
// few large polygons per shard.
const MIN_POLYGONS_PER_SHARD = 64;

// Assigns work to shards, heaviest piece first onto whichever shard is
// lightest so far (longest-processing-time first, the standard greedy makespan
// heuristic). Returns null when the layout should not be split at all.
//
// The piece is usually a whole layer, because that is the unit gdstk's reader
// can filter on: a shard reads only its own tags, which keeps each shard's
// parse to the geometry it will actually use.
//
// But a layer is a lumpy unit. Per-point triangulation cost spans more than a
// tenfold range between layers -- a convex polygon is triangulated by a fan in
// one linear pass while a concave one goes through ear clipping, and nothing
// in the file says which a polygon will be without reading its points -- so a
// plan that looks balanced by point count often is not. Worse, plenty of real
// designs put almost everything on one layer (one routing or waveguide layer
// with a few marker layers beside it), and no assignment of whole layers can
// split that at all: measured on a design dominated by one layer, eight shards
// left the one holding it doing as much work as an unsplit parse.
//
// So a layer whose share is more than one shard's worth is striped: each of
// several shards reads it and triangulates every Nth polygon of it, skipping
// the rest. Striping cuts through the cost-model problem as well as the
// dominant-layer one, since every Nth polygon of a layer is a fair sample of
// that layer whatever the polygons look like.
//
// What striping costs is that its shards each read the whole layer rather than
// a slice. That is less expensive than it sounds, because gdstk's reader
// builds every polygon before discarding the ones outside the filter anyway
// (see the note on read_layout), so a shard's peak is set by the design's size
// rather than by its own share of it either way.
function planShards(perTag, count) {
    if (!perTag || perTag.size === 0) return null;

    // Estimated triangulation work per layer, and the totals over all of them.
    const cost = new Map();
    let total = 0;
    let polygons = 0;
    for (const [tag, seen] of perTag) {
        const perPolygon = seen.points / Math.max(1, seen.polygons);
        const weighted = seen.points * (perPolygon <= SIMPLE_POLYGON_POINTS ? 1 : COMPLEX_POLYGON_WEIGHT);
        cost.set(tag, weighted);
        total += weighted;
        polygons += seen.polygons;
    }
    if (!(total > 0)) return null;
    if (total < MIN_SPLIT_WORK) return null;

    // No more shards than there is work to keep them busy.
    const useful = Math.min(count, Math.max(1, Math.floor(polygons / MIN_POLYGONS_PER_SHARD)));
    if (useful < 2) return null;

    // One shard's fair share of the total. A layer over that gets striped, by
    // as many ways as it is over -- bounded by the shard count, and by having
    // enough polygons that the stripes are worth having.
    const share = total / (useful * STRIPE_OVERSUBSCRIBE);
    const pieces = [];
    for (const [tag, seen] of perTag) {
        const weighted = cost.get(tag);
        let stripes = weighted > share ? Math.ceil(weighted / share) : 1;
        stripes = Math.min(stripes, useful, Math.max(1, Math.floor(seen.polygons / MIN_POLYGONS_PER_STRIPE)));
        if (stripes <= 1) {
            pieces.push({ tag, index: 0, stripes: 1, cost: weighted });
            continue;
        }
        for (let index = 0; index < stripes; index++) {
            pieces.push({ tag, index, stripes, cost: weighted / stripes });
        }
    }

    // Ties broken on tag then stripe so the same file always plans the same way.
    pieces.sort((a, b) => b.cost - a.cost || a.tag - b.tag || a.index - b.index);

    const shards = [];
    for (let i = 0; i < useful; i++) shards.push({ tags: [], stripes: [], cost: 0, holds: new Set() });
    for (const piece of pieces) {
        // Two stripes of one layer on one shard would be a shard reading that
        // layer once and triangulating two disjoint samples of it, which the
        // per-shard options have no way to say. There is always a shard free:
        // a layer is never striped more ways than there are shards.
        let lightest = null;
        for (const shard of shards) {
            if (shard.holds.has(piece.tag)) continue;
            if (!lightest || shard.cost < lightest.cost) lightest = shard;
        }
        if (!lightest) continue;
        lightest.tags.push(piece.tag);
        lightest.holds.add(piece.tag);
        lightest.cost += piece.cost;
        if (piece.stripes > 1) lightest.stripes.push(piece.tag, piece.index, piece.stripes);
    }

    // A shard with nothing on it would pay a full parse to produce nothing.
    const used = shards.filter((shard) => shard.tags.length > 0);
    if (used.length < 2) return null;
    return used.map((shard) => ({ tags: shard.tags, stripes: shard.stripes }));
}

// Grows one bounding box by another, skipping the shards renderer.cpp
// flagged as holding no geometry (see the `hasGeometry` note there).
function unionBbox(into, next, hasGeometry) {
    if (!next || hasGeometry === false) return into;
    if (!into) return { minX: next.minX, maxX: next.maxX, minY: next.minY, maxY: next.maxY };
    return {
        minX: Math.min(into.minX, next.minX),
        maxX: Math.max(into.maxX, next.maxX),
        minY: Math.min(into.minY, next.minY),
        maxY: Math.max(into.maxY, next.maxY)
    };
}

// Puts the shards back together into the single result the upload path
// expects. The per-layer geometry simply concatenates -- every shard owns
// a disjoint set of layers, so no entry can collide -- and the hierarchy,
// ports and labels come from the one shard that was asked for them.
//
// Sorted by layer and datatype rather than left in the order the shards
// happened to come back in, because that order is what decides how
// overlapping translucent fills stack. Left alone it would depend on how
// many shards the parse was split into, which depends on the file's size
// and the machine's core count -- so the same layout would draw
// differently on two engineers' laptops. Sorting costs nothing here (one
// entry per layer, not per polygon) and makes the stack the same
// everywhere, split or not.
function mergeShardResults(results) {
    const merged = { layers: [], instanceGroups: [], hierarchy: null, ports: null, bbox: null };
    // Instanced cells are decided from the hierarchy, which no shard
    // filters, so every shard holding any of a cell's geometry reports
    // that cell as a group of its own -- same placements, a slice of the
    // layers. Folding them back by cell name gives the one group an
    // unsplit parse produces, instead of N groups each re-uploading the
    // same per-instance transforms and each costing an instanced draw call
    // of its own every frame.
    const byCell = new Map();
    for (const result of results) {
        for (const layer of result.layers) merged.layers.push(layer);
        for (const group of result.instanceGroups) {
            // No name to fold on (an unsplit parse, or a nameless cell):
            // keep the group as it stands rather than merging blind.
            const existing = group.cell ? byCell.get(group.cell) : null;
            if (!existing) {
                merged.instanceGroups.push(group);
                if (group.cell) byCell.set(group.cell, group);
                continue;
            }
            for (const layer of group.layers) existing.layers.push(layer);
            // Each shard saw only its own layers of the unit shape, so the
            // group's world footprint is the union of what they each
            // worked out from their slice of it.
            existing.bbox = {
                minX: Math.min(existing.bbox.minX, group.bbox.minX),
                maxX: Math.max(existing.bbox.maxX, group.bbox.maxX),
                minY: Math.min(existing.bbox.minY, group.bbox.minY),
                maxY: Math.max(existing.bbox.maxY, group.bbox.maxY)
            };
        }
        if (result.hierarchy) merged.hierarchy = result.hierarchy;
        if (result.ports) merged.ports = result.ports;
        merged.bbox = unionBbox(merged.bbox, result.bbox, result.hasGeometry);
    }
    merged.layers.sort((a, b) => a.layer - b.layer || a.datatype - b.datatype);
    for (const group of merged.instanceGroups) {
        group.layers.sort((a, b) => a.layer - b.layer || a.datatype - b.datatype);
    }
    if (!merged.bbox) merged.bbox = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    return merged;
}

export { scanGdsTags, planShards, shardCount, mergeShardResults, packTag, looksLikeGds, MIN_SPLIT_BYTES };
