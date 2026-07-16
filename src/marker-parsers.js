// Parsers for DRC/LVS marker databases: KLayout report databases (.lyrdb,
// XML) and Calibre DRC ASCII results databases (line-oriented text). This is
// a standalone script (no imports): the webview loads it via a <script> tag
// (see viewer.html / extension.cjs's asWebviewUri replacement), and plain
// Node unit tests require() it via the module.exports tail. parseLyrdb takes
// the DOMParser *constructor* as an argument so the file itself stays
// environment-free -- the webview passes the browser global, tests pass
// @xmldom/xmldom's.
//
// Both parsers emit the same normalized model. All coordinates are in µm,
// y-up world space -- the same space renderer.cpp draws in (Calibre integer
// coordinates are divided by the header's precision here, at parse time):
//
//   {
//     topCell: "TOP",                      // "" if unknown
//     warnings: ["...", ...],
//     categories: [{
//       name,                              // full path, '.'-joined for lyrdb nesting
//       description,
//       items: [{
//         id,                              // global, unique, == index in category-major order
//         label,                           // short label for the list row
//         note,                            // non-geometry values, multiplicity, cell ref
//         polygons: [Float64Array(x,y,...), ...],  // one array per ring
//         edges: Float64Array(x0,y0,x1,y1,...),    // packed segments
//         bbox: {minX,minY,maxX,maxY} | null,      // null = no geometry
//       }],
//     }],
//   }
//
// Items with no geometry (float/text values) keep the raw value in `note`,
// have bbox === null, and draw nothing.

"use strict";

// Decides the format by content, not extension: KLayout writes XML with a
// <report-database> root; a Calibre ASCII results database starts with a
// "<top-cell-name> <precision>" header line. Returns 'lyrdb' | 'calibre' |
// null (unrecognized).
function sniffMarkerFormat(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    let t = text;
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // UTF-8 BOM survives decoding as U+FEFF
    t = t.replace(/^\s+/, "");
    if (t.startsWith("<")) {
        return t.slice(0, 2048).includes("<report-database") ? "lyrdb" : null;
    }
    const nl = t.indexOf("\n");
    const firstLine = (nl < 0 ? t : t.slice(0, nl)).replace(/\r$/, "").trim();
    if (/^\S+\s+\d+$/.test(firstLine)) return "calibre";
    return null;
}

// "(0,0;1.5,0;1.5,0.2)" (parens optional, whitespace/newlines tolerated) ->
// Float64Array [x,y,x,y,...]. Throws on malformed points.
function parsePointList(text) {
    const cleaned = text.trim().replace(/^\(/, "").replace(/\)$/, "").trim();
    if (cleaned === "") return new Float64Array(0);
    const parts = cleaned.split(";");
    const pts = new Float64Array(parts.length * 2);
    for (let i = 0; i < parts.length; i++) {
        const xy = parts[i].split(",");
        if (xy.length !== 2) throw new Error(`bad point "${parts[i].trim()}"`);
        const x = parseFloat(xy[0]);
        const y = parseFloat(xy[1]);
        if (!isFinite(x) || !isFinite(y)) throw new Error(`bad point "${parts[i].trim()}"`);
        pts[i * 2] = x;
        pts[i * 2 + 1] = y;
    }
    return pts;
}

// One .lyrdb <value> payload: "<type>: <geometry>". Appends geometry to
// item.polygons / item.edges (a plain array while building). Returns a
// display note ("" when the value was pure geometry): unknown types,
// malformed geometry, and bare strings all fall back to showing the raw
// text. unknownTypes accumulates unsupported type names for a single
// summary warning.
function parseLyrdbValue(raw, item, unknownTypes) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text === "") return "";
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/.exec(text);
    if (!m) return text; // bare string -> note only
    const type = m[1].toLowerCase();
    const body = m[2].trim();
    try {
        if (type === "box") {
            const p = parsePointList(body);
            if (p.length !== 4) throw new Error("box needs 2 points");
            const l = Math.min(p[0], p[2]);
            const r = Math.max(p[0], p[2]);
            const b = Math.min(p[1], p[3]);
            const t = Math.max(p[1], p[3]);
            item.polygons.push(Float64Array.from([l, b, r, b, r, t, l, t]));
            return "";
        }
        if (type === "polygon") {
            // KLayout hole notation puts '/'-separated rings inside one paren
            // group: (hull/hole1/...). v1 renders every ring as its own
            // outline+fill (holes fill too -- acceptable, outline correct).
            const inner = body.replace(/^\(/, "").replace(/\)$/, "");
            for (const ringText of inner.split("/")) {
                const ring = parsePointList(ringText);
                if (ring.length >= 6) item.polygons.push(ring);
            }
            return "";
        }
        if (type === "edge") {
            const p = parsePointList(body);
            if (p.length !== 4) throw new Error("edge needs 2 points");
            item.edges.push(p[0], p[1], p[2], p[3]);
            return "";
        }
        if (type === "edge-pair") {
            const mm = /\(([^)]*)\)\s*[/|]\s*\(([^)]*)\)/.exec(body);
            if (!mm) throw new Error("malformed edge-pair");
            for (const part of [mm[1], mm[2]]) {
                const p = parsePointList(part);
                if (p.length !== 4) throw new Error("edge-pair edge needs 2 points");
                item.edges.push(p[0], p[1], p[2], p[3]);
            }
            return "";
        }
    } catch (err) {
        return text; // malformed geometry: keep the raw string as the note
    }
    unknownTypes.add(type);
    return text;
}

function computeItemBBox(item) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const eat = (arr) => {
        for (let i = 0; i + 1 < arr.length; i += 2) {
            if (arr[i] < minX) minX = arr[i];
            if (arr[i] > maxX) maxX = arr[i];
            if (arr[i + 1] < minY) minY = arr[i + 1];
            if (arr[i + 1] > maxY) maxY = arr[i + 1];
        }
    };
    for (const ring of item.polygons) eat(ring);
    eat(item.edges);
    if (minX > maxX) return null;
    return { minX, minY, maxX, maxY };
}

// Final pass shared by both parsers: assign global ids in category-major
// emission order (flattenMarkerModel indexes its per-item arrays by id, so
// this ordering is load-bearing) and freeze each item's edge array.
function finalizeModel(model) {
    let id = 0;
    for (const cat of model.categories) {
        for (const item of cat.items) {
            item.id = id++;
            if (!(item.edges instanceof Float64Array)) item.edges = Float64Array.from(item.edges);
        }
    }
    return model;
}

// KLayout report database (.lyrdb) XML, written by DRC/LVS report(...).
// Units are µm floats already in layout space -- no scaling. domParserCtor
// is the DOMParser constructor to instantiate (see file header).
function parseLyrdb(text, domParserCtor) {
    const doc = new domParserCtor().parseFromString(text, "text/xml");
    const root = doc && doc.documentElement;
    if (!root || root.nodeName !== "report-database") {
        throw new Error("not a KLayout report database (no <report-database> root)");
    }

    const childElements = (node, name) => {
        const out = [];
        for (let c = node.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === 1 && c.nodeName === name) out.push(c);
        }
        return out;
    };
    const childText = (node, name) => {
        const els = childElements(node, name);
        return els.length ? els[0].textContent || "" : null;
    };

    const topCell = (childText(root, "top-cell") || "").trim();
    const warnings = [];
    const model = { topCell, warnings, categories: [] };

    // Category defs can be nested (path components '.'-joined) and are
    // emitted lazily by KLayout -- an item may reference a category with no
    // def at all, so ensureCategory also derives categories from item refs.
    const catByPath = new Map();
    const ensureCategory = (path, description) => {
        let cat = catByPath.get(path);
        if (!cat) {
            cat = { name: path, description: description || "", items: [] };
            catByPath.set(path, cat);
            model.categories.push(cat);
        } else if (description && !cat.description) {
            cat.description = description;
        }
        return cat;
    };
    const walkCategories = (categoriesEl, prefix) => {
        for (const catEl of childElements(categoriesEl, "category")) {
            const name = (childText(catEl, "name") || "").trim();
            if (!name) continue;
            const path = prefix ? prefix + "." + name : name;
            ensureCategory(path, (childText(catEl, "description") || "").trim());
            for (const sub of childElements(catEl, "categories")) walkCategories(sub, path);
        }
    };
    for (const catsEl of childElements(root, "categories")) walkCategories(catsEl, "");

    let nonTopCount = 0;
    const unknownTypes = new Set();

    for (const itemsEl of childElements(root, "items")) {
        for (const itemEl of childElements(itemsEl, "item")) {
            // Item refs quote the path: <category>'cat.subcat'</category>.
            let catRef = (childText(itemEl, "category") || "").trim().replace(/^'+|'+$/g, "");
            if (!catRef) catRef = "(uncategorized)";
            const cat = ensureCategory(catRef, "");

            const item = { id: -1, label: String(cat.items.length + 1), note: "", polygons: [], edges: [], bbox: null };
            const notes = [];

            // Coordinates are interpreted as top-cell space; items bound to
            // another cell (or a "CELL:variant" of any cell) may be placed
            // wrong -- rendered anyway, counted for one summary warning.
            const cellRef = (childText(itemEl, "cell") || "").trim();
            if (cellRef) {
                const baseCell = cellRef.split(":")[0];
                if ((topCell && baseCell !== topCell) || cellRef.includes(":")) {
                    nonTopCount++;
                    notes.push("cell " + cellRef);
                }
            }

            const mult = parseInt((childText(itemEl, "multiplicity") || "").trim(), 10);
            if (mult > 1) notes.push("×" + mult);

            for (const valuesEl of childElements(itemEl, "values")) {
                for (const valueEl of childElements(valuesEl, "value")) {
                    const note = parseLyrdbValue(valueEl.textContent || "", item, unknownTypes);
                    if (note) notes.push(note);
                }
            }

            item.note = notes.join(" · ");
            item.bbox = computeItemBBox(item);
            cat.items.push(item);
        }
    }

    if (nonTopCount > 0) {
        warnings.push(nonTopCount + " marker(s) reference non-top cells; positions may be wrong");
    }
    if (unknownTypes.size > 0) {
        warnings.push("values of unsupported type shown as text only: " + Array.from(unknownTypes).join(", "));
    }
    return finalizeModel(model);
}

// Calibre DRC ASCII results database (DRC RESULTS DATABASE <file> ASCII).
// Header line: "<top-cell> <precision>", precision = database units per µm;
// all coordinates are integers scaled here by 1/precision. Then repeating
// rulecheck blocks: name line, counts+timestamp line, optional metadata /
// "quoted description" lines, and `p <ordinal> <vcount>` / `e <ordinal>
// <vcount>` results each followed by vcount "x y" vertex lines. Never throws
// on malformed interior lines -- skips and records a warning instead.
function parseCalibreAscii(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    const warnings = [];
    const model = { topCell: "", warnings, categories: [] };

    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    const header = /^(\S+)\s+(\d+)$/.exec(i < lines.length ? lines[i].trim() : "");
    if (!header) throw new Error("not a Calibre ASCII results database (bad header line)");
    model.topCell = header[1];
    const precision = parseInt(header[2], 10);
    if (!(precision > 0)) throw new Error("bad precision in Calibre header");
    i++;

    const resultRe = /^([pe])\s+(\S+)\s+(\d+)$/;
    const vertexRe = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/;
    // Counts line: 2+ integers then a timestamp tail ("2 2 2 Jul 10 ...").
    const countsRe = /^\d+(\s+\d+)+\s+\S/;

    let currentCat = null;
    let hierCount = 0;

    while (i < lines.length) {
        const line = lines[i].trim();
        if (line === "") {
            i++;
            continue;
        }

        const res = resultRe.exec(line);
        if (res) {
            const kind = res[1];
            const ordinal = res[2];
            const vcount = parseInt(res[3], 10);
            i++;
            if (!currentCat) {
                // Results before any rulecheck header: malformed; skip the
                // record (and its vertices) rather than inventing a category.
                warnings.push(`result record before any rulecheck header at line ${i}; skipped`);
                let taken = 0;
                while (taken < vcount && i < lines.length && vertexRe.test(lines[i].trim())) {
                    taken++;
                    i++;
                }
                continue;
            }

            const verts = [];
            while (verts.length < vcount * 2 && i < lines.length) {
                const vline = lines[i].trim();
                if (vline === "") {
                    i++;
                    continue;
                }
                const vm = vertexRe.exec(vline);
                if (vm) {
                    verts.push(parseFloat(vm[1]) / precision, parseFloat(vm[2]) / precision);
                    i++;
                    continue;
                }
                if (/^CN\b/.test(vline)) {
                    // Hierarchical cell-name/placement record interleaved with
                    // the vertices (hierarchical output) -- skip, count, warn once.
                    hierCount++;
                    i++;
                    continue;
                }
                // Anything else is malformed: stop this record without
                // consuming the line so it can be re-examined as a header.
                warnings.push(`malformed line ${i + 1} inside ${currentCat.name} ${kind} ${ordinal}: "${vline}"`);
                break;
            }

            const item = { id: -1, label: `${kind} ${ordinal}`, note: "", polygons: [], edges: [], bbox: null };
            if (kind === "p") {
                if (verts.length >= 6) item.polygons.push(Float64Array.from(verts));
            } else if (vcount % 2 === 0) {
                // Even cluster: vertices pairwise form independent edges.
                const usable = Math.floor(verts.length / 4) * 4;
                item.edges = verts.slice(0, usable);
            } else {
                // Odd cluster: treat as a polyline (consecutive vertices form
                // edges) and log it.
                warnings.push(`${currentCat.name} e ${ordinal}: odd vertex count ${vcount}; treated as polyline`);
                for (let k = 0; k + 3 < verts.length; k += 2) {
                    item.edges.push(verts[k], verts[k + 1], verts[k + 2], verts[k + 3]);
                }
            }
            item.bbox = computeItemBBox(item);
            currentCat.items.push(item);
            continue;
        }

        if (line.startsWith('"')) {
            if (currentCat) {
                const desc = line.replace(/^"/, "").replace(/"$/, "");
                currentCat.description = currentCat.description ? currentCat.description + " " + desc : desc;
            }
            i++;
            continue;
        }
        if (/^Rule File Pathname\s*:/.test(line)) {
            i++;
            continue;
        }
        if (/^CN\b/.test(line)) {
            hierCount++;
            i++;
            continue;
        }

        // Anything else starts a new rulecheck block. Category = rulecheck
        // name, flat (no nesting).
        currentCat = { name: line, description: "", items: [] };
        model.categories.push(currentCat);
        i++;
        // The next non-blank line should be the counts/timestamp line (only a
        // sanity marker -- results are read until the next header). Tolerate
        // it being absent: don't consume a line that's already a result record.
        let j = i;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length) {
            const next = lines[j].trim();
            if (!resultRe.test(next) && countsRe.test(next)) i = j + 1;
        }
    }

    if (hierCount > 0) {
        warnings.push(hierCount + " hierarchical record(s) (CN/placements) skipped; positions may be wrong");
    }
    return finalizeModel(model);
}

// Sniff + dispatch. Throws on unrecognized input (callers surface the
// message in the debug log / marker chip).
function parseMarkerFile(text, domParserCtor) {
    const format = sniffMarkerFormat(text);
    if (format === "lyrdb") return parseLyrdb(text, domParserCtor);
    if (format === "calibre") return parseCalibreAscii(text);
    throw new Error("Unrecognized marker file format (expected KLayout .lyrdb XML or Calibre DRC ASCII results)");
}

// Concatenates a normalized model's geometry into the flat typed-array
// payload renderer.cpp's setMarkers() consumes (one bulk copy per array
// across the wasm boundary -- no chatty per-item objects):
//   categories:     [{itemStart, itemCount}]      (index into the item arrays)
//   itemCategory:   Int32Array, category index per item id
//   itemBBoxes:     Float32Array, 4 per item ([0,0,-1,-1] = no geometry)
//   polyVerts:      Float32Array x,y pairs, rings back-to-back
//   polyVertCounts: Uint32Array vertices per ring
//   polyItemIds:    Uint32Array owning item per ring
//   edgeVerts:      Float32Array x0,y0,x1,y1 per segment
//   edgeItemIds:    Uint32Array owning item per segment
function flattenMarkerModel(model) {
    const categories = [];
    let itemCount = 0;
    let ringCount = 0;
    let ringVertCount = 0;
    let edgeSegCount = 0;
    for (const cat of model.categories) {
        categories.push({ itemStart: itemCount, itemCount: cat.items.length });
        for (const item of cat.items) {
            itemCount++;
            for (const ring of item.polygons) {
                ringCount++;
                ringVertCount += ring.length / 2;
            }
            edgeSegCount += Math.floor(item.edges.length / 4);
        }
    }

    const itemCategory = new Int32Array(itemCount);
    const itemBBoxes = new Float32Array(itemCount * 4);
    const polyVerts = new Float32Array(ringVertCount * 2);
    const polyVertCounts = new Uint32Array(ringCount);
    const polyItemIds = new Uint32Array(ringCount);
    const edgeVerts = new Float32Array(edgeSegCount * 4);
    const edgeItemIds = new Uint32Array(edgeSegCount);

    let ring = 0;
    let vert = 0;
    let seg = 0;
    model.categories.forEach((cat, ci) => {
        for (const item of cat.items) {
            itemCategory[item.id] = ci;
            const bb = item.bbox;
            itemBBoxes.set(bb ? [bb.minX, bb.minY, bb.maxX, bb.maxY] : [0, 0, -1, -1], item.id * 4);
            for (const r of item.polygons) {
                polyVerts.set(r, vert * 2);
                polyVertCounts[ring] = r.length / 2;
                polyItemIds[ring] = item.id;
                vert += r.length / 2;
                ring++;
            }
            const segs = Math.floor(item.edges.length / 4);
            edgeVerts.set(item.edges.subarray(0, segs * 4), seg * 4);
            for (let k = 0; k < segs; k++) edgeItemIds[seg + k] = item.id;
            seg += segs;
        }
    });

    return { categories, itemCategory, itemBBoxes, polyVerts, polyVertCounts, polyItemIds, edgeVerts, edgeItemIds };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        sniffMarkerFormat,
        parsePointList,
        parseLyrdb,
        parseCalibreAscii,
        parseMarkerFile,
        flattenMarkerModel,
    };
}
