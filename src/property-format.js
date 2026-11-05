// Layout properties as rows to show: one key and one value string each.
//
// The engine hands property lists over as JSON (see property_json.hpp): a
// GDSII property is {attr, value}, an OASIS one {name, values}, and either
// has binary: true when its bytes were not text. Most become one row as they
// are. Cell metadata written in the "meta info" form is the exception: an
// OASIS KLAYOUT_CONTEXT property holds every entry as one of its values, and
// a GDSII context SREF holds one per property, each a string such as
//
//   META('kfactory:ports:0')={'name'=>'in0','trans'=>[trans:r180 0,0]}
//
// Joined into one value that is a wall of text, so each entry becomes its own
// row instead: the key is the META name and the value is read and laid out,
// a dictionary as one "key: value" line per entry, nested ones indented.
//
// Each row is { key, value, line, binary }: `value` whole, possibly over
// several lines, and `line` the same on one line for places that cannot wrap.

const CONTEXT_PROPERTY = "KLAYOUT_CONTEXT";

// ---- Variant parsable strings ----
// The value side of a META entry. The same grammar kfactory_ports.cpp reads:
// quoted strings with backslash escapes, `#l500` / `##1.5` tagged numbers,
// nil / true / false, `(a,b)` lists, `{'k'=>v}` dictionaries and
// `[class:body]` objects (a transformation, a layer).

function parseVariant(text) {
    let i = 0;
    const MAX_DEPTH = 64;
    const skipWs = () => {
        while (i < text.length && /\s/.test(text[i])) i++;
    };
    const accept = (ch) => {
        skipWs();
        if (text[i] === ch) {
            i++;
            return true;
        }
        return false;
    };
    const quoted = () => {
        const q = text[i++];
        let out = "";
        while (i < text.length) {
            const ch = text[i++];
            if (ch === "\\" && i < text.length) {
                const e = text[i++];
                out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
            } else if (ch === q) {
                return out;
            } else {
                out += ch;
            }
        }
        return out;
    };
    const value = (depth) => {
        skipWs();
        if (depth > MAX_DEPTH || i >= text.length) return { kind: "nil" };
        const ch = text[i];
        if (ch === "'" || ch === "\"") return { kind: "string", text: quoted() };
        if (ch === "[") {
            i++;
            let level = 1, body = "";
            while (i < text.length) {
                const c = text[i++];
                if (c === "[") level++;
                else if (c === "]" && --level === 0) break;
                body += c;
            }
            // The class name ("trans:", "layer:") goes: the key around it
            // already says what the value is.
            return { kind: "object", text: body.replace(/^[A-Za-z_]\w*:/, "") };
        }
        if (ch === "(") {
            i++;
            const items = [];
            if (accept(")")) return { kind: "list", items };
            while (i < text.length) {
                items.push(value(depth + 1));
                if (accept(",")) continue;
                accept(")");
                break;
            }
            return { kind: "list", items };
        }
        if (ch === "{") {
            i++;
            const entries = [];
            if (accept("}")) return { kind: "dict", entries };
            while (i < text.length) {
                const key = value(depth + 1);
                skipWs();
                if (text.startsWith("=>", i)) i += 2;
                entries.push([scalarText(key), value(depth + 1)]);
                if (accept(",")) continue;
                accept("}");
                break;
            }
            return { kind: "dict", entries };
        }
        let token = "";
        while (i < text.length && !",)}] \n".includes(text[i])) token += text[i++];
        if (token === "nil") return { kind: "nil" };
        if (token === "true" || token === "false") return { kind: "scalar", text: token };
        // "#", a type tag ("l", "u", "#" for a double, ...), then the digits.
        const tagged = /^#[a-z#]*([-+0-9.eE]+)$/i.exec(token);
        if (tagged) return { kind: "scalar", text: tagged[1] };
        return { kind: "scalar", text: token };
    };
    const result = value(0);
    skipWs();
    // Left-over text means this was not a parsable string after all.
    return i >= text.length ? result : null;
}

function isScalar(v) {
    return v.kind === "string" || v.kind === "scalar" || v.kind === "nil" || v.kind === "object";
}

function scalarText(v) {
    if (v.kind === "nil") return "nil";
    if (v.kind === "object") return v.text;
    return v.text ?? "";
}

// One line: what the card shows.
function formatLine(v) {
    if (isScalar(v)) return scalarText(v);
    if (v.kind === "list") return `(${v.items.map(formatLine).join(", ")})`;
    return `{${v.entries.map(([k, item]) => `${k}: ${formatLine(item)}`).join(", ")}}`;
}

// Several lines, nested values indented: what Details shows.
function formatBlock(v, indent = "") {
    if (isScalar(v)) return indent + scalarText(v);
    if (v.kind === "list") {
        if (v.items.every(isScalar)) return indent + formatLine(v);
        return v.items.map((item) => isScalar(item)
            ? `${indent}- ${scalarText(item)}`
            : `${indent}-\n${formatBlock(item, indent + "  ")}`).join("\n");
    }
    if (v.entries.length === 0) return `${indent}{}`;
    return v.entries.map(([k, item]) => {
        if (isScalar(item) || (item.kind === "list" && item.items.every(isScalar))) {
            return `${indent}${k}: ${formatLine(item)}`;
        }
        if (item.kind === "dict" && item.entries.length === 0) return `${indent}${k}: {}`;
        return `${indent}${k}:\n${formatBlock(item, indent + "  ")}`;
    }).join("\n");
}

// ---- META entries ----

// `META('key')=value` or `META('key',type)=value` as { key, value } rows, or
// null for any other string.
function metaRow(text) {
    const m = /^META\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^,)\s]*))\s*(?:,[^)]*)?\)\s*=\s*/s.exec(text);
    if (!m) return null;
    const key = (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, "$1");
    const raw = text.slice(m[0].length);
    const parsed = parseVariant(raw);
    if (!parsed) return { key, value: raw, line: oneLine(raw), binary: false };
    return { key, value: formatBlock(parsed), line: oneLine(formatLine(parsed)), binary: false };
}

// A value squeezed onto one line, for a cell that cannot wrap.
export function oneLine(text) {
    return text.replace(/\r\n|\r|\n/g, " ↵ ").replace(/\t/g, " ");
}

function plainRow(key, value, binary) {
    return { key, value, line: oneLine(value), binary };
}

function valueText(v) {
    return v === null ? "null" : String(v);
}

// The rows a property list shows as.
export function propertyRows(list) {
    const rows = [];
    // GDSII context strings too long for one PROPVALUE come in pieces,
    // "#n,p:payload", which join back up by n in order of p.
    const pieces = new Map();
    for (const entry of list || []) {
        const binary = !!entry.binary;
        if (entry.attr !== undefined) {
            const value = entry.value ?? "";
            const piece = !binary && /^#(\d+),(\d+):/s.exec(value);
            if (piece) {
                let group = pieces.get(piece[1]);
                if (!group) {
                    group = { parts: [], row: rows.length };
                    pieces.set(piece[1], group);
                    rows.push(null);
                }
                group.parts.push([Number(piece[2]), value.slice(piece[0].length)]);
                continue;
            }
            rows.push((!binary && metaRow(value)) || plainRow(String(entry.attr), value, binary));
            continue;
        }
        const name = entry.name || "(unnamed)";
        const values = (entry.values || []).map(valueText);
        if (name === CONTEXT_PROPERTY && !binary) {
            for (const v of values) rows.push(metaRow(v) || plainRow(name, v, false));
            continue;
        }
        rows.push(plainRow(name, values.join(", "), binary));
    }
    for (const [n, group] of pieces) {
        const whole = group.parts.sort((a, b) => a[0] - b[0]).map((p) => p[1]).join("");
        rows[group.row] = metaRow(whole) || plainRow(`#${n}`, whole, false);
    }
    return rows;
}
