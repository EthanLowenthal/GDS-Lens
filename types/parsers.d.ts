// `gds-lens/parsers` -- DRC/LVS marker databases, normalized.
//
// Pure JavaScript: no DOM, no WebAssembly. The XML parser is passed in as a
// constructor argument rather than imported, so this runs in Node (with
// @xmldom/xmldom) and in a browser (with the built-in DOMParser) unchanged.

/** A `DOMParser` constructor -- the platform's, or @xmldom/xmldom's. */
export type DOMParserConstructor = new () => {
    parseFromString(text: string, type: string): Document;
};

export interface MarkerBBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * One marker. Coordinates are in µm, y-up world space.
 *
 * Items with no geometry (float or text values) keep the raw value in `note`,
 * have `bbox === null`, and draw nothing.
 */
export interface MarkerItem {
    /** Globally unique; equals the index in category-major order. */
    id: number;
    /** Short label for the list row. */
    label: string;
    /** Non-geometry values, multiplicity, cell reference. */
    note: string;
    /** One packed `(x, y, ...)` array per ring. */
    polygons: Float64Array[];
    /** Packed segments: `(x0, y0, x1, y1, ...)`. */
    edges: Float64Array;
    /** `null` when the item has no geometry. */
    bbox: MarkerBBox | null;
    /** True for a `WE<n>` waiver record. */
    waived: boolean;
}

export interface MarkerCategory {
    /** Full path; `.`-joined for lyrdb nesting. */
    name: string;
    description: string;
    items: MarkerItem[];
}

/** The normalized model both parsers emit. */
export interface MarkerModel {
    /** `""` when the file does not say. */
    topCell: string;
    warnings: string[];
    categories: MarkerCategory[];
}

/** Geometry repacked per item id, ready to hand to the renderer. */
export interface FlatMarkerModel {
    categories: MarkerCategory[];
    itemCategory: Int32Array;
    itemBBoxes: Float64Array;
    polyVerts: Float64Array;
    polyVertCounts: Int32Array;
    polyItemIds: Int32Array;
    edgeVerts: Float64Array;
    edgeItemIds: Int32Array;
}

/** Decided by content, not by extension. `null` when unrecognized. */
export function sniffMarkerFormat(text: string): "lyrdb" | "drc" | null;

/** Parses a whitespace-separated coordinate list into a packed array. */
export function parsePointList(text: string): Float64Array;

/** Parses a KLayout `.lyrdb` report database. Throws if it is not one. */
export function parseLyrdb(text: string, DOMParserCtor: DOMParserConstructor): MarkerModel;

/** Parses an ASCII DRC results database. */
export function parseDrcAscii(text: string): MarkerModel;

/** Dispatches on `sniffMarkerFormat`. Throws on an unrecognized format. */
export function parseMarkerFile(text: string, DOMParserCtor: DOMParserConstructor): MarkerModel;

export function flattenMarkerModel(model: MarkerModel): FlatMarkerModel;
