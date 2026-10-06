// Type-level smoke test: imports every declaration and uses it the way the
// README says to. Compiled by `npm run check:types`, never shipped or run.
//
// This exists so that a declaration that drifts from the documented API fails
// in CI rather than in a consumer's editor.

import type {
    GdsLens, GdsLensEventMap, ViewerHost, ViewerSurface, PickedFile, NamedView, GotoResult,
    LayoutSource, TopCellInfo, ShortcutRow, ViewerAction, ShapeInfo,
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
await element.showLoading();
await element.showLoading("Reading chip.gds...");
// The events, typed through GdsLensEventMap: detail must come out typed, and
// the built-in events must still be reachable through the same overload.
element.addEventListener("gds-load", (event) => {
    const layers: number = event.detail.layerCount;
    const cells: number = event.detail.cellCount;
    void (layers + cells);
});
element.addEventListener("gds-error", (event) => {
    const message: string = event.detail.message;
    void message;
});
element.addEventListener("click", (event) => {
    const x: number = event.clientX;
    void x;
});
const loadDetail: GdsLensEventMap["gds-load"]["detail"] =
    { slot: "a", layerCount: 1, cellCount: 2, portCount: 0, topCell: null };
void loadDetail;
const surface: ViewerSurface = await element.ready;
surface.element.addEventListener("drop", () => {});

// --- two layouts in one viewer ---
await element.load("new.gds", { slot: "b", name: "new.gds" });
await element.setBlend(0.5);
const blend: number = await element.getBlend();
void blend;
// getLayers says which of the two each entry came from.
const sources: Array<0 | 1> = (await element.getLayers()).map((layer) => layer.source);
void sources;
await element.unload("b");
void landed;

// --- the top cell ---
const tops: TopCellInfo = await element.getTopCells();
const drawn: string | null = tops.current;
void drawn;
await element.setTopCell(tops.cells[0] ?? null);
await element.setTopCell("SUB", "b");
await element.setTopCell(null);
await element.load(new Uint8Array(8), { topCell: "SUB" });

// --- the selected shape ---
const picked: ShapeInfo | null = await element.selectAt(15, 15);
if (picked) {
    const where: string = `${picked.pathText} ${picked.path[0].placement ?? ""} ${picked.slot}`;
    const area: number = picked.area + picked.bbox.maxX + picked.points.length;
    void where;
    void area;
}
await element.selectAt(15, 15, 1);
const current: ShapeInfo | null = await element.getSelection();
void current;
await element.clearSelection();
element.addEventListener("gds-select", (event) => {
    const layer: number | undefined = event.detail?.layer;
    void layer;
});

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

// --- a host that owns the keyboard shortcuts ---
const rows: ShortcutRow[] = [
    { label: "Toggle the hierarchy", keys: "Ctrl+K H", action: "toggleHierarchy" },
    { label: "Something of the host's own", keys: "F7" },
];
const keyHost: ViewerHost = {
    shortcuts: () => rows,
    customizeShortcuts() {},
    setKeyboardContext(active: boolean) { void active; },
    connect(viewer: ViewerSurface) {
        const action: ViewerAction = "toggleHierarchy";
        viewer.runAction(action);
        viewer.runAction("showShortcuts");
        viewer.refreshShortcuts();
        const shape: ShapeInfo | null = viewer.getSelection();
        void shape;
        viewer.clearSelection();
    },
};
const asyncKeyHost: ViewerHost = { shortcuts: async () => rows };
void keyHost;
void asyncKeyHost;

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
