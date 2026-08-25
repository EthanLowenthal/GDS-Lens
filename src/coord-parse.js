// Reads a coordinate pair out of whatever text a layout engineer happens to
// have on the clipboard. Coordinates arrive from outside the viewer all day --
// a DRC report, a colleague's message, a generator's log -- and each source
// wraps them differently.
//
// This is a standalone script (no imports) following the same pattern as
// load-errors.js and marker-parsers.js, so it can be require()d from both the
// extension host (the "Go to Coordinate" command's input box validates with it)
// and Node unit tests. The webview doesn't need it: the host sends the parsed
// numbers, not the typed string.
//
// The accepted forms are whatever those sources actually produce, which is
// "x, y" with any of the usual decorations: parentheses, a semicolon or bare
// whitespace as the separator, and an optional per-number unit. Microns are the
// default because that's what the readout, the ruler and the .lyrdb files all
// speak.
const COORD_UNITS = {
    nm: 1e-3,
    um: 1,
    "µm": 1,  // MICRO SIGN
    "μm": 1,  // GREEK SMALL LETTER MU -- both are in the wild
    mm: 1e3
};
// One number plus an optional unit; the parse takes the first two matches and
// requires the rest of the string to be separators, so "1 2 3" is rejected
// rather than silently read as "1 2".
const COORD_TOKEN = /(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(nm|um|µm|μm|mm)?/gi;
// What may surround the two numbers -- punctuation, plus a bare x/y label,
// since "x=12.5, y=40" is a shape real reports print. Anything else means the
// string wasn't a coordinate pair, so it's rejected rather than half-read.
const COORD_FILLER = /^[\s(),;:=xy]*$/i;

// Returns {x, y} in microns, or null if the text isn't a coordinate pair.
function parseCoordinatePair(text) {
    const numbers = [];
    let start = 0;
    let end = 0;
    COORD_TOKEN.lastIndex = 0;
    for (let match = COORD_TOKEN.exec(text); match; match = COORD_TOKEN.exec(text)) {
        numbers.push(parseFloat(match[1]) * (match[2] ? COORD_UNITS[match[2].toLowerCase()] : 1));
        if (numbers.length === 1) start = match.index;
        end = COORD_TOKEN.lastIndex;
        if (numbers.length === 2) break;
    }
    if (numbers.length !== 2 || !numbers.every(Number.isFinite)) return null;
    if (!COORD_FILLER.test(text.slice(0, start)) || !COORD_FILLER.test(text.slice(end))) return null;
    return { x: numbers[0], y: numbers[1] };
}

export { parseCoordinatePair };
