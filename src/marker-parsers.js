// Parsers for DRC/LVS marker databases: .lyrdb report databases (.lyrdb,
// XML) and ASCII DRC results databases (line-oriented text). This is
// a standalone script (no imports): the webview loads it via a <script> tag
// (see viewer.html / extension.cjs's asWebviewUri replacement), and plain
// Node unit tests require() it via the module.exports tail. parseLyrdb takes
// the DOMParser *constructor* as an argument so the file itself stays
// environment-free -- the webview passes the browser global, tests pass
// @xmldom/xmldom's.
//
// Both parsers emit the same normalized model. All coordinates are in µm,
// y-up world space -- the same space renderer.cpp draws in (integer
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
//         waived: false,                     // true = WE<n> waiver
//       }],
//     }],
//   }
//
// Items with no geometry (float/text values) keep the raw value in `note`,
// have bbox === null, and draw nothing.

"use strict";

// Decides the format by content, not extension (marker files are named all
// sorts of things): the .lyp/.lyrdb tooling writes XML with a <report-database> root; a ASCII DRC
// ASCII results database starts with a "<top-cell-name> <resolution>" header
// line, optionally preceded by '//' comment lines. Returns 'lyrdb' | 'drc'
// | null (unrecognized).
function sniffMarkerFormat(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    let t = text;
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // UTF-8 BOM survives decoding as U+FEFF
    t = t.replace(/^\s+/, "");
    if (t.startsWith("<")) {
        return t.slice(0, 2048).includes("<report-database") ? "lyrdb" : null;
    }
    // "<top cell> <resolution>", then a check name, then that check's counts
    // line -- three lines is what it takes to tell a results database from a
    // text file whose first line happens to be a word and a number.
    const head = [];
    for (const raw of t.slice(0, 8192).split("\n")) {
        const line = raw.replace(/\r$/, "").trim();
        if (line === "" || line.startsWith("//")) continue;
        head.push(line);
        if (head.length === 3) break;
    }
    const header = /^(\S+)\s+(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/.exec(head[0] || "");
    if (!header) return null;
    // Resolution is database units per µm; the format's usual sanity range.
    const resolution = parseFloat(header[2]);
    if (!(resolution >= 0.001 && resolution <= 1e6)) return null;
    // A file that stops after the header is an empty (clean) database.
    if (head.length < 3) return "drc";
    return /^\d+\s+\d+\s+\d+(\s|$)/.test(head[2]) ? "drc" : null;
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
            // The .lyrdb hole notation puts '/'-separated rings inside one paren
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
    } catch {
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

// .lyrdb report-database XML, written by DRC/LVS report(...).
// Units are µm floats already in layout space -- no scaling. domParserCtor
// is the DOMParser constructor to instantiate (see file header).
function parseLyrdb(text, domParserCtor) {
    const doc = new domParserCtor().parseFromString(text, "text/xml");
    const root = doc && doc.documentElement;
    if (!root || root.nodeName !== "report-database") {
        throw new Error("not a .lyrdb report database (no <report-database> root)");
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
    // emitted lazily by writers -- an item may reference a category with no
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

// ASCII DRC results database, a.k.a. an RVE database (rule-file's "DRC
// RESULTS DATABASE <file> ASCII"). Line-oriented, and rigidly counted -- the
// counts line says how many description lines and how many results follow, and
// those counts, not the shape of later lines, are what delimit a block:
//
//   <top-cell> <resolution>          resolution = database units per µm
//   <check name>                     one block per rulecheck, repeating:
//   <results> <original> <desc lines> <timestamp>
//     <desc line> ...               exactly <desc lines> of them: rule text,
//                                   prose, or WE<n> waiver records
//     <p|e> <ordinal> <count>       exactly <results> of these records:
//       [CN <cell> [c] <m11 m21 m12 m22 x y>]   cell + placement (hierarchical)
//       [<PropertyName> <number>]    per-result value (density, area, ...)
//       <x> <y> ...                 'p': <count> vertex lines -> one polygon
//       <x1> <y1> <x2> <y2> ...     'e': <count> edge lines (2 = an edge pair)
//
// Note the asymmetry in the record count: for 'p' it counts vertices, for 'e'
// it counts *edges*, each edge being four numbers on one line. '//' comment
// lines may appear anywhere.
//
// Grammar and semantics follow the common ASCII writer as decoded by open implementations's reader
// (src/rdb/rdb/rdbRVEReader.cc), including the trailing-'.' strip on check
// names and the CN 'c' flag. Never throws on malformed interior lines -- skips
// and records a warning instead. Not handled: the sibling "<file>.waived"
// database the .lyp/.lyrdb tooling looks for alongside the results file (the webview only ever
// receives one file's text).
function parseDrcAscii(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    const warnings = [];
    const model = { topCell: "", warnings, categories: [] };

    // A line cursor that hides '//' comments and blank lines: at every point in
    // this grammar where a line is expected, both are noise. peek() returns the
    // raw line (indentation intact, for rule text) or null at end of input.
    let i = 0;
    const peek = () => {
        while (i < lines.length) {
            const t = lines[i].trim();
            if (t !== "" && !t.startsWith("//")) return lines[i];
            i++;
        }
        return null;
    };
    const take = () => {
        const line = peek();
        if (line !== null) i++;
        return line;
    };

    const headerLine = peek();
    const header = /^(\S+)\s+(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/.exec((headerLine || "").trim());
    if (!header) throw new Error("not a ASCII DRC results database (bad header line)");
    model.topCell = header[1];
    // Resolution is database units per µm, and is a float in the grammar even
    // though every real file writes an integer. the format's usual sanity range.
    const resolution = parseFloat(header[2]);
    if (!(resolution >= 0.001 && resolution <= 1e6)) throw new Error("bad precision in ASCII DRC header");
    i++;

    // "<results> <original> <desc lines> <timestamp>". The third count is
    // optional only to tolerate hand-made files; the timestamp tail is ignored.
    const countsRe = /^(\d+)\s+(\d+)(?:\s+(\d+))?(?:\s+\S.*)?$/;
    const recordRe = /^([pePE])\s+(\d+)\s+(\d+)\s*(\S.*)?$/;
    const numberRe = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
    const waiverRe = /^WE(\d+)\s*(.*)$/;
    // CN <cell> [c|C] [m11 m21 m12 m22 x y] -- cell names may contain _.$-
    const cnRe = /^CN\s+(\S+)((?:\s+[cC])?)((?:\s+-?\d+){6})?\s*$/;
    const propRe = /^([A-Za-z_]\w*)\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/;

    // Numbers on a pure-numeric line, or null if the line is something else
    // (the next record, a property, the next check's name).
    const lineNumbers = (line) => {
        const parts = line.trim().split(/\s+/);
        for (const p of parts) if (!numberRe.test(p)) return null;
        return parts;
    };

    let unsupportedProps = 0;
    let cellRefCount = 0;
    let strayCoords = 0;
    let pendingName = null; // check name already read while ending a block

    while (true) {
        let name = pendingName;
        pendingName = null;
        if (name === null) {
            const line = take();
            if (line === null) break;
            name = line;
        }
        // Leftover coordinates from a record that wrote more points than it
        // declared land here too, once its count has already been satisfied.
        if (lineNumbers(name.trim())) {
            strayCoords++;
            continue;
        }
        // Some writers write some check names with a trailing period; one is
        // stripped so the name matches the rule as written in the deck.
        name = name.trim().replace(/\.$/, "");
        const cat = { name, description: "", items: [] };
        model.categories.push(cat);

        // Counts line. If what follows is already a result record, this file
        // omits the counts line: fall back to reading records until something
        // that isn't one (resultCount === null means "unbounded").
        let resultCount = null;
        let descCount = 0;
        const next = peek();
        const counts = next !== null && !recordRe.test(next.trim()) ? countsRe.exec(next.trim()) : null;
        if (counts) {
            i++;
            resultCount = parseInt(counts[1], 10);
            descCount = counts[3] === undefined ? 0 : parseInt(counts[3], 10);
        } else if (next !== null && !recordRe.test(next.trim())) {
            warnings.push(`${name}: no counts line after the check name`);
        }

        // Description block: exactly descCount lines. WE<n> lines are waiver
        // records for result n rather than description text -- the first line
        // of each is the waiver's author/timestamp and is dropped, the rest
        // become that result's comment (see rdbRVEReader.cc).
        const waivers = new Map();
        const descParts = [];
        for (let d = 0; d < descCount; d++) {
            const line = take();
            if (line === null) {
                warnings.push(`${name}: file ended inside the description block`);
                break;
            }
            const trimmed = line.trim();
            // A result record here means the count is too high; don't eat
            // geometry with it.
            if (recordRe.test(trimmed)) {
                i--;
                warnings.push(`${name}: description count ${descCount} overruns the results`);
                break;
            }
            const we = waiverRe.exec(trimmed);
            if (we) {
                const n = parseInt(we[1], 10);
                if (!waivers.has(n)) waivers.set(n, []);
                else waivers.get(n).push(we[2]);
                continue;
            }
            descParts.push(trimmed.startsWith('"') ? trimmed.replace(/^"/, "").replace(/"$/, "") : line.replace(/\s+$/, ""));
        }
        cat.description = descParts.join("\n");

        // Results. Coordinates are top-cell space unless a CN record says
        // otherwise; the state persists across the records of a check (ASCII DRC
        // writes one CN per cell, not per result) and resets at the next check.
        let cellName = "";
        let xf = null; // {m11,m21,m12,m22,tx,ty} in DB units, or null = identity
        let shape = 0;
        while (resultCount === null || shape < resultCount) {
            const line = take();
            if (line === null) {
                if (resultCount !== null && shape < resultCount) {
                    warnings.push(`${name}: file ended after ${shape} of ${resultCount} result(s)`);
                }
                break;
            }
            const rec = recordRe.exec(line.trim());
            if (!rec) {
                // A bare coordinate line here is a record that declared fewer
                // points than it wrote. Dropping it keeps the block on the
                // rails; treating it as a name would invent a check called
                // "123 456" and then read the strays after it as its counts.
                if (lineNumbers(line.trim())) {
                    strayCoords++;
                    continue;
                }
                // Anything else is the next check's name. ASCII DRC's counts are
                // trustworthy, so reaching this early means the file is
                // truncated or the count is wrong.
                if (resultCount !== null && shape < resultCount) {
                    warnings.push(`${name}: results ended after ${shape} of ${resultCount}; continuing with the next check`);
                }
                pendingName = line;
                break;
            }

            const kind = rec[1].toLowerCase();
            const ordinal = rec[2];
            const count = parseInt(rec[3], 10);
            const item = {
                id: -1,
                label: `${kind} ${ordinal}`,
                note: "",
                polygons: [],
                edges: [],
                bbox: null,
                waived: false,
            };
            const notes = [];
            if (rec[4]) notes.push(rec[4].trim());

            // Optional property records, between the record line and its
            // coordinates.
            while (true) {
                const propLine = peek();
                if (propLine === null) break;
                const trimmed = propLine.trim();
                if (lineNumbers(trimmed) || recordRe.test(trimmed)) break;
                const cn = cnRe.exec(trimmed);
                if (cn) {
                    i++;
                    cellName = cn[1];
                    const m = cn[3] ? cn[3].trim().split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0];
                    // Without the 'c' flag the coordinates are already in
                    // top-cell space and the matrix only says where the cell
                    // sits; with it they are cell-local and the matrix places
                    // them (some tools use shape_trans, others its inverse).
                    xf = cn[2].trim() === "" ? null
                        : { m11: m[0], m21: m[1], m12: m[2], m22: m[3], tx: m[4], ty: m[5] };
                    continue;
                }
                const prop = propRe.exec(trimmed);
                if (prop) {
                    i++;
                    notes.push(`${prop[1]}=${prop[2]}`);
                    continue;
                }
                // Any other word-leading line is a property record in a format
                // we don't read (several variants exist); consumed so it can't be
                // mistaken for the next check name, counted for one warning.
                if (/^[A-Za-z_]/.test(trimmed)) {
                    i++;
                    unsupportedProps++;
                    continue;
                }
                break;
            }
            if (cellName && cellName !== model.topCell) {
                cellRefCount++;
                notes.push("cell " + cellName);
            }

            // Coordinates: 2 numbers per vertex for 'p', 4 per edge for 'e'.
            // Read them by number rather than by line so a writer that wraps
            // differently still parses.
            const wanted = kind === "p" ? count * 2 : count * 4;
            const nums = [];
            while (nums.length < wanted) {
                const vline = peek();
                if (vline === null) break;
                const parts = lineNumbers(vline.trim());
                if (!parts) break;
                i++;
                for (const p of parts) nums.push(parseFloat(p));
            }
            if (nums.length < wanted) {
                warnings.push(
                    `${name} ${kind} ${ordinal}: ${nums.length / 2} of ${kind === "p" ? count : count * 2} point(s) present`
                );
            }

            // Divide rather than multiply by a reciprocal: 700/2000 is exactly
            // 0.35, 700*(1/2000) is not.
            const mapX = xf
                ? (x, y) => (xf.m11 * x + xf.m12 * y + xf.tx) / resolution
                : (x) => x / resolution;
            const mapY = xf
                ? (x, y) => (xf.m21 * x + xf.m22 * y + xf.ty) / resolution
                : (x, y) => y / resolution;
            if (kind === "p") {
                const usable = Math.floor(nums.length / 2) * 2;
                if (usable >= 6) {
                    const ring = new Float64Array(usable);
                    for (let k = 0; k < usable; k += 2) {
                        ring[k] = mapX(nums[k], nums[k + 1]);
                        ring[k + 1] = mapY(nums[k], nums[k + 1]);
                    }
                    item.polygons.push(ring);
                }
            } else {
                const usable = Math.floor(nums.length / 4) * 4;
                for (let k = 0; k < usable; k += 2) {
                    item.edges.push(mapX(nums[k], nums[k + 1]), mapY(nums[k], nums[k + 1]));
                }
            }

            const waiver = waivers.get(shape);
            if (waiver) {
                item.waived = true;
                notes.push(waiver.length ? "waived: " + waiver.join(" ") : "waived");
            }
            item.note = notes.join(" · ");
            item.bbox = computeItemBBox(item);
            cat.items.push(item);
            shape++;
        }
    }

    if (cellRefCount > 0) {
        warnings.push(cellRefCount + " marker(s) placed in cells other than " + model.topCell);
    }
    if (unsupportedProps > 0) {
        warnings.push(unsupportedProps + " unsupported per-result property record(s) ignored");
    }
    if (strayCoords > 0) {
        warnings.push(strayCoords + " coordinate line(s) past the declared point counts ignored");
    }
    return finalizeModel(model);
}

// Sniff + dispatch. Throws on unrecognized input (callers surface the
// message in the debug log / marker chip).
function parseMarkerFile(text, domParserCtor) {
    const format = sniffMarkerFormat(text);
    if (format === "lyrdb") return parseLyrdb(text, domParserCtor);
    if (format === "drc") return parseDrcAscii(text);
    throw new Error("Unrecognized marker file format (expected .lyrdb XML or ASCII DRC results)");
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
        parseDrcAscii,
        parseMarkerFile,
        flattenMarkerModel,
    };
}
