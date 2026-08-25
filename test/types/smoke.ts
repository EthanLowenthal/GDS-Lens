// Type-level smoke test: imports every declaration and uses it the way the
// README says to. Compiled by `npm run check:types`, never shipped or run.
//
// This exists so that a declaration that drifts from the documented API fails
// in CI rather than in a consumer's editor.

import type {
    GdsLens, ViewerHost, ViewerSurface, PickedFile, NamedView, GotoResult, LayoutSource,
} from "../../types/gds-lens.js";
import type { MarkerModel, FlatMarkerModel, DOMParserConstructor } from "../../types/parsers.js";
import type { CellNode } from "../../types/cell-search.js";
import type { DecodedLayout, FailedLayout } from "../../types/layout-bytes.js";

// --- the element, as the README's JS quick start uses it ---
declare const element: GdsLens;
const source: LayoutSource = "chip.gds";
await element.load(source);
await element.load(new Uint8Array(8), { reload: true });
const landed: boolean = await element.goToPoint(120.5, -40);
await element.setLyp("layers.lyp", "<layer-properties/>");
await element.setMarkers("drc.lyrdb", "<report-database/>");
await element.showError("nope");
const surface: ViewerSurface = await element.ready;
surface.element.addEventListener("drop", () => {});
void landed;

// createElement must come back typed, via HTMLElementTagNameMap.
const created = document.createElement("gds-lens");
await created.goToPoint(0, 0);

// --- a host, as the README's example writes one ---
const host: ViewerHost = {
    async pickLyp(): Promise<PickedFile | null> {
        return { name: "layers.lyp", text: "" };
    },
    isLightTheme: () => true,
    connect(viewer: ViewerSurface) {
        viewer.load(new Uint8Array(0));
        viewer.showStale("changed on disk");
    },
};
window.gdsLensHost = host;

// A read-only embed implements almost nothing -- this must still type.
const minimalHost: ViewerHost = {};
void minimalHost;

// The optional members must be optional, not merely nullable.
const views: NamedView[] = [{ name: "overview" }];
host.saveViews?.(views);
const result: GotoResult = { ok: true, x: 1, y: 2 };
host.onGotoResult?.(result);

// --- the pure subpaths ---
declare const parseMarkerFile: (t: string, d: DOMParserConstructor) => MarkerModel;
declare const flattenMarkerModel: (m: MarkerModel) => FlatMarkerModel;
declare const DOMParserImpl: DOMParserConstructor;
const model: MarkerModel = parseMarkerFile("<report-database/>", DOMParserImpl);
const topCell: string = model.topCell;
const firstBBox = model.categories[0]?.items[0]?.bbox;
if (firstBBox) {
    const width: number = firstBBox.maxX - firstBBox.minX;
    void width;
}
const flat: FlatMarkerModel = flattenMarkerModel(model);
void topCell;
void flat.polyItemIds.length;

declare const rankCellMatches: (c: CellNode[], q: string) => number[];
declare const cellPathToTarget: (c: CellNode[], r: number[], t: number, d: number) => number[] | null;
const cells: CellNode[] = [{ name: "TOP", references: [{ cell: 1 }] }, { name: "SUB" }];
const ranked: number[] = rankCellMatches(cells, "sub");
const path: number[] | null = cellPathToTarget(cells, [0], 1, 32);
void ranked;
void path;

declare const parseCoordinatePair: (t: string) => { x: number; y: number } | null;
const point = parseCoordinatePair("(1.5um, -2)");
if (point) void (point.x + point.y);

declare const describeLoadFailure: (e: unknown, p?: string) => string;
declare const isOutOfMemory: (e: unknown) => boolean;
void describeLoadFailure(new Error("boom"), "worker");
void describeLoadFailure("a bare string");
void isOutOfMemory(new Error("Aborted()"));

// The discriminated union is the point of this one: `bytes` must only be
// reachable on the ok branch, and `reason` only on the failure branch.
declare const decodeLayoutBytes: (b: Uint8Array, max?: number) => Promise<DecodedLayout | FailedLayout>;
const decoded = await decodeLayoutBytes(new Uint8Array([0x1f, 0x8b]), 1024);
if (decoded.ok) {
    const bytes: Uint8Array = decoded.bytes;
    void bytes.byteLength;
} else {
    const reason: "too-large" | "corrupt" = decoded.reason;
    void reason;
}

declare const createBrowserHost: () => ViewerHost;
void createBrowserHost();
