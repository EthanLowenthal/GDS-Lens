// Public types for the `gds-lens` entry point: the custom element, the host
// interface an embedder implements, and the surface the viewer hands back.
//
// Hand-written rather than emitted, because these describe a contract that is
// deliberately looser than the implementation: every ViewerHost method is
// optional, and the viewer hides the control for anything a host leaves out.
// That optionality is the interesting part, and it is the part a generated
// declaration would get wrong.

/** A file a host picked on the viewer's behalf. */
export interface PickedFile {
    name: string;
    text: string;
}

/** A saved camera position, persisted by the host between sessions. */
export interface NamedView {
    name: string;
    [key: string]: unknown;
}

/** The Display folder's toggles, as `loadDisplay`/`saveDisplay` pass them. */
export interface DisplayPrefs {
    showInfill: boolean;
    showText: boolean;
    showPorts: boolean;
    mergeOverlaps: boolean;
    showGrid: boolean;
}

/** The result of a `goToPoint`, reported back to the host. */
export interface GotoResult {
    ok: boolean;
    x: number;
    y: number;
}

/** Pan/zoom state, in the units `getCamera`/`setCamera` use throughout. */
export interface Camera {
    /** CSS pixels per micron. */
    zoom: number;
    /** World-space (micron) coordinate at the canvas centre. */
    panX: number;
    panY: number;
}

/**
 * Which of the two layouts a viewer can hold something belongs to. `"a"` is
 * the ordinary single-layout case and the default everywhere; `"b"` is the
 * second layout a comparison loads alongside it, drawn through the same
 * camera into the same canvas.
 */
export type Slot = "a" | "b";

/** One row of `getLayers()` -- everything the layer panel shows for a layer. */
export interface LayerInfo {
    layer: number;
    datatype: number;
    /**
     * Which loaded layout this entry came from: 0 for slot `"a"`, 1 for slot
     * `"b"`. With two layouts loaded, `getLayers()` returns `10/0` twice when
     * both have it -- the pair is not merged, because a comparison needs to
     * draw and difference them against each other.
     */
    source: 0 | 1;
    name: string;
    group: string;
    fillColor: string;
    frameColor: string;
    visible: boolean;
    polygonCount: number;
    labelCount: number;
}

/** A finished ruler, in world-space (micron) endpoints. */
export interface Measurement {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Which top cell a layout draws, as `getTopCells()` reports it. */
export interface TopCellInfo {
    /** The file's own top cells: the cells nothing else in it places. */
    cells: string[];
    /**
     * The cell drawn as the top, or `null` when every top cell is drawn (the
     * default). Can name a cell that is not in `cells`, after a cell placed
     * inside the design was shown as the top cell.
     */
    current: string | null;
}

/**
 * What a rebindable key does, for `runAction()`. By default the viewer binds
 * these itself: `toggleHierarchy` to H, `focusFind` to /, `toggleMeasure`
 * (between Pan and Measure) to M, `previousMarker` and `nextMarker` to [ and
 * ]. `showShortcuts` opens the Keyboard Shortcuts dialog and has no key of
 * its own.
 */
export type ViewerAction =
    | "toggleHierarchy"
    | "focusFind"
    | "toggleMeasure"
    | "previousMarker"
    | "nextMarker"
    | "showShortcuts";

/** One row of the Keyboard Shortcuts dialog, as a host's `shortcuts()` lists it. */
export interface ShortcutRow {
    /** What the key does. */
    label: string;
    /**
     * The key as it should be shown, such as `"H"` or `"Ctrl+K D"`. Each key
     * is drawn as its own `<kbd>`: chords split on spaces, combinations on
     * `+`, and alternatives on `" / "`.
     */
    keys: string;
    /**
     * The action this key runs. The viewer's tooltips that name a key, such
     * as the hierarchy button's, take it from the row with the matching
     * action, and leave the key out when no row has one.
     */
    action?: ViewerAction;
}

/** One step of a `ShapeInfo` path, from the drawn top cell down. */
export interface ShapePathStep {
    /** The cell's name. */
    cell: string;
    /**
     * Which placement of this cell the shape is in, when its parent places it
     * more than once: `"#2"` for the second of several references to it,
     * `"[2,1]"` for the copy at column 2, row 1 of an array (from 0), `"[5]"`
     * for a copy in a repetition that lists its offsets, or both. `null` for
     * the top cell and for a cell placed once.
     */
    placement: string | null;
}

/**
 * A shape picked by a click on the canvas or by `selectAt`. Coordinates and
 * lengths are world µm, areas µm². Paths and boxes are given as the polygon
 * they are drawn as.
 */
export interface ShapeInfo {
    /** Which loaded layout the shape is in. */
    slot: Slot;
    layer: number;
    datatype: number;
    /** The layer's name from the `.lyp`, or `""`. */
    layerName: string;
    /** The layer's frame and fill colors, as `getLayers()` gives them. */
    color: string;
    fillColor: string;
    /** The cell whose own geometry holds the shape. */
    cell: string;
    /** From the drawn top cell down to `cell`, through the placements the point is in. */
    path: ShapePathStep[];
    /** `path` as one line, such as `"TOP > ring_array > ring [2,1]"`. */
    pathText: string;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    width: number;
    height: number;
    area: number;
    perimeter: number;
    vertexCount: number;
    /** The polygon's vertices in world space, x and y interleaved. */
    points: number[];
    /** Which of the shapes under the point this is (0 has the outline nearest the point), and how many there are. */
    index: number;
    count: number;
    /** The layout's database unit in µm, the step its coordinates sit on. */
    unit: number;
}

/** Options for `load()`. */
export interface LoadOptions {
    /**
     * Keeps the current camera and layer visibility rather than framing the
     * new geometry -- for re-reading a file that changed on disk.
     */
    reload?: boolean;
    /**
     * Which layout this is. Omit (or `"a"`) for the ordinary single-layout
     * case. `"b"` loads a second layout alongside the first, to compare them:
     * one camera, one control panel, one set of rulers over both. Loading a
     * slot replaces only that slot, and a second layout arriving does not move
     * the camera off what the user is already reading.
     */
    slot?: Slot;
    /** Filename to show for this layout in the panel's Compare folder. */
    name?: string;
    /**
     * The cell to draw as the top, as `setTopCell()` takes it. Omitted, a
     * reload keeps the current choice and any other load draws every top
     * cell. A name the file does not have draws every top cell.
     */
    topCell?: string | null;
}

/**
 * What the viewer can be told to do, handed to the host in `connect`.
 *
 * This is the push direction: the host calls these to drive the viewer,
 * rather than answering questions the viewer asks.
 */
export interface ViewerSurface {
    /**
     * The element the viewer is mounted in. Bind anything of your own to this
     * rather than to `window`, so it stays inside the component -- a listener
     * on `window` reaches the whole embedding page.
     */
    element: HTMLElement;
    load(bytes: Uint8Array | ArrayBuffer, options?: LoadOptions): void;
    /**
     * Say that a layout is on its way, for the wait before `load()` -- a host
     * fetching or reading the bytes it is about to hand over. Without it the
     * viewer shows "No layout loaded" for the length of that wait, since a
     * viewer that has not been given anything is idle, not loading.
     *
     * `label` replaces the default "Fetching layout...".
     */
    showLoading(label?: string): void;
    showError(message: string): void;
    setLyp(name: string, text: string): void;
    setMarkers(name: string, text: string): void;
    /** Offer a reload, for when the file changed underneath. */
    showStale(text: string): void;
    goToPoint(x: number, y: number): void;
    toggleDebug(): void;
    setNamedViews(views: NamedView[]): void;
    /** Re-ask `isLightTheme()` after a theme change. */
    applyTheme(): void;

    /** Drops the second layout, leaving the viewer showing one again. */
    unload(slot?: Slot): Promise<void>;
    /**
     * Crossfade between two loaded layouts: 0 shows only the first, 1 only the
     * second, and anything between overlays them. Harmless, and meaningless,
     * with a single layout loaded.
     */
    setBlend(value: number): Promise<void>;
    getBlend(): number;

    /** Which top cell `slot` (default `"a"`) draws, and the file's own top cells. */
    getTopCells(slot?: Slot): TopCellInfo;
    /**
     * Draws `name` as the top cell of `slot` (default `"a"`): only that cell
     * and what it places, at the cell's own origin, framed. Any cell in the
     * file can be named, not only a top cell. `null` goes back to drawing
     * every top cell. Layer visibility is kept; rulers are dropped, as on any
     * load. The layout is parsed again from the bytes it was loaded from.
     *
     * Resolves once the new top is on screen. Rejects if the layout has no
     * cell by that name, or nothing is loaded in `slot`.
     */
    setTopCell(name: string | null, slot?: Slot): Promise<void>;

    // The rest are for an app driving the viewer itself -- framing the view,
    // reading the layer table, placing a ruler.
    getCamera(): Promise<Camera>;
    /**
     * Clamps to the loaded design's bounds and fit zoom (the union of both,
     * with two layouts loaded), so the value passed in is not always the value
     * that lands -- read `getCamera()` back if that matters.
     */
    setCamera(camera: Camera): Promise<void>;
    getLayers(): Promise<LayerInfo[]>;
    setLayerVisible(layer: number, datatype: number, visible: boolean): Promise<void>;
    getMeasurements(): Promise<Measurement[]>;
    /** Appends a finished ruler without disturbing measure mode or a ruler already mid-placement. */
    addMeasurement(x0: number, y0: number, x1: number, y1: number): Promise<void>;
    /** Rulers do not survive a load into either slot -- re-add them after a `gds-load` if that matters to you. */
    clearMeasurements(): Promise<void>;

    /**
     * Does what the action's key does. For a host that binds the keys itself
     * (see `ViewerHost.shortcuts`), and for a toolbar or menu of your own.
     * An action this viewer does not know is ignored.
     */
    runAction(action: ViewerAction): void;
    /**
     * Asks `ViewerHost.shortcuts` again, for a host whose bindings changed
     * after the viewer mounted: the tooltips that name a key follow, and the
     * Keyboard Shortcuts dialog redraws if it is open. A no-op for a host
     * without `shortcuts`.
     */
    refreshShortcuts(): void;

    /** The selected shape, or `null`. */
    getSelection(): ShapeInfo | null;
    /**
     * Selects the shape under a world point (µm), as a click there in Pan mode
     * does, and resolves to it. `index` picks the shape that many after the
     * first in nearest-outline order (wrapping), which is what clicking the same spot again steps
     * through. Resolves to `null`, and clears the selection, when there is
     * nothing under the point on a drawn layer.
     *
     * The first pick in a layout reads the layout's bytes again to index its
     * cells, which on a large file takes about as long as parsing it once.
     */
    selectAt(x: number, y: number, index?: number): Promise<ShapeInfo | null>;
    /** Clears the selection, as Escape does. */
    clearSelection(): void;
}

/**
 * Everything the viewer needs from whatever is embedding it. Install as
 * `window.gdsLensHost` before the element script runs.
 *
 * Every method is optional: a missing one is not an error, it means the
 * embedder does not offer that service, and the viewer removes the control
 * for it. A read-only embed can implement almost none of this.
 */
export interface ViewerHost {
    /** `null` means the user cancelled. */
    pickLyp?(): Promise<PickedFile | null> | PickedFile | null;
    unloadLyp?(): void;
    pickMarkers?(): Promise<PickedFile | null> | PickedFile | null;
    unloadMarkers?(): void;
    /** Called once at mount, for saved camera positions. */
    /**
     * `viewer` is the viewer asking, so a host serving several can keep a set
     * per viewer rather than one for the page. It is the same surface
     * `connect` is given; `viewer.element` is the way to a stable identity.
     */
    loadViews?(viewer?: ViewerSurface): Promise<NamedView[]> | NamedView[];
    saveViews?(views: NamedView[], viewer?: ViewerSurface): void;
    /**
     * Called once at mount, for the Display toggles to start with. Keys that
     * are missing or not booleans keep the viewer's defaults. Ignored if the
     * user has already flipped a toggle by the time it resolves.
     */
    loadDisplay?(viewer?: ViewerSurface): Promise<Partial<DisplayPrefs> | null> | Partial<DisplayPrefs> | null;
    /**
     * The user flipped a Display toggle; `prefs` holds all of them. Not called
     * when the viewer changes one itself, such as turning Text on to show a
     * label search's result.
     */
    saveDisplay?(prefs: DisplayPrefs, viewer?: ViewerSurface): void;
    /** `existing` is the names already in use; `null` means cancelled. */
    promptViewName?(existing: string[]): Promise<string | null> | string | null;
    /** The user asked to re-read the layout. */
    requestReload?(): void;
    setAutoReload?(on: boolean): void;
    onGotoResult?(result: GotoResult): void;
    /** Defaults to the OS preference when not implemented. */
    isLightTheme?(): boolean;
    /** Override where the payload's scripts cannot be fetched by URL. */
    createWorker?(): Worker;
    /**
     * Implementing this takes over the rebindable keys (H, /, M, [ and ]): the
     * viewer stops handling them, and the host binds keys of its own that
     * call `runAction`. The rows returned are listed at the top of the
     * Keyboard Shortcuts dialog, above the keys the viewer keeps (Esc, the
     * find box's Up, Down and Enter, Alt and Shift while measuring, drag and
     * scroll). Called at mount and each time the dialog opens, and again
     * when you call `ViewerSurface.refreshShortcuts`. Give each row its
     * `action` so the viewer's tooltips name your key rather than none.
     */
    shortcuts?(): ShortcutRow[] | Promise<ShortcutRow[]>;
    /**
     * Adds a "Customize..." button to the Keyboard Shortcuts dialog, which
     * closes the dialog and calls this.
     */
    customizeShortcuts?(): void;
    /**
     * `true` while the page has focus and that focus is not in a text field;
     * `false` otherwise. For a host that binds single keys, so they do not
     * fire while the user is typing in the find box. Called once at mount
     * and then on every change.
     */
    setKeyboardContext?(active: boolean): void;
    /** Called at mount, handing over the push-direction surface. */
    connect?(viewer: ViewerSurface): void;
}

/** Accepted by `load`: a URL to fetch, or bytes you already have. */
export type LayoutSource = string | Uint8Array | ArrayBuffer;

/**
 * The events a `<gds-lens>` dispatches, on itself. Neither bubbles nor
 * crosses a shadow boundary. They fire however the load was started -- the
 * `src` attribute, `load()`, or a host pushing bytes through its surface --
 * which is what makes them the way to observe a load you did not call.
 *
 * Prefixed rather than the bare `load` / `error`, which `HTMLElementEventMap`
 * already types as `Event` / `ErrorEvent`; a `CustomEvent` under those names
 * would be typed wrongly for everyone.
 */
export interface GdsLensEventMap extends HTMLElementEventMap {
    /** A layout finished loading and is on screen. `slot` says which one. */
    "gds-load": CustomEvent<{
        slot: Slot;
        layerCount: number;
        cellCount: number;
        portCount: number;
        /** The cell drawn as the top, or `null` for every top cell. See `setTopCell`. */
        topCell: string | null;
    }>;
    /** A load failed, or `showError()` was called. `message` is what the viewer shows. */
    "gds-error": CustomEvent<{ message: string }>;
    /**
     * The selection changed: a click on the canvas, `selectAt`, Escape, or
     * the layout it was in being replaced. `detail` is the new selection, or
     * `null` when it was cleared.
     */
    "gds-select": CustomEvent<ShapeInfo | null>;
}

/**
 * The `<gds-lens>` element. Importing `gds-lens` registers it; the engine,
 * the wasm module and the WebGL context are all deferred until an element
 * actually connects.
 *
 * `display: block` with no intrinsic height, so give it one.
 *
 * Each element drives its own viewer, so several can be live at once. Each
 * one costs a WebAssembly instance and a WebGL2 context, and browsers cap
 * live contexts per page at roughly eight to sixteen.
 *
 * One element is one viewer, but a viewer holds up to two layouts: load a
 * second one with `load(url, { slot: "b" })` to compare two revisions through
 * one camera, one control panel and one set of rulers. There is no second
 * element and nothing to keep in step.
 *
 * Attributes: `src`, a layout URL, equivalent to `load(url)`.
 */
export declare class GdsLens extends HTMLElement {
    /**
     * Resolves once the engine has mounted. Every method below awaits this,
     * so it is rarely needed directly. Rejects if the element is not
     * connected.
     */
    readonly ready: Promise<ViewerSurface>;

    /**
     * `options.reload` keeps the current camera and layer visibility.
     * `options.slot` picks which of the two layouts this is -- `"b"` loads a
     * second one alongside the first rather than replacing it.
     *
     * Resolves once the layout is on screen. Rejects on a failed fetch, a
     * file the parser refuses, or -- with an error whose `name` is
     * `"AbortError"` -- when a later `load()` into the same slot (or a change
     * to `src`) superseded this one before it finished.
     */
    load(source: LayoutSource, options?: LoadOptions): Promise<void>;

    /**
     * Says that a layout is on its way, for the wait before a `load()` of
     * bytes the page is fetching itself. Without it the viewer shows "No
     * layout loaded" for the length of the download. `load(url)` does this
     * on its own. `label` replaces the default "Fetching layout...".
     */
    showLoading(label?: string): Promise<void>;

    /**
     * Centres on a coordinate in microns and flashes a crosshair. Resolves
     * `true` if the point is inside the layout.
     */
    goToPoint(x: number, y: number): Promise<boolean>;

    /** Applies a `.lyp` layer-properties file. Pass `""` to clear. */
    setLyp(name: string, text: string): Promise<void>;

    /** Applies a marker database; the format is sniffed from the content. */
    setMarkers(name: string, text: string): Promise<void>;

    /** Replaces the view with an error message. */
    showError(message: string): Promise<void>;

    // Thin pass-throughs to `ViewerSurface`; see there for the caveats on each.
    getCamera(): Promise<Camera>;
    setCamera(camera: Camera): Promise<void>;
    getLayers(): Promise<LayerInfo[]>;
    setLayerVisible(layer: number, datatype: number, visible: boolean): Promise<void>;
    getMeasurements(): Promise<Measurement[]>;
    addMeasurement(x0: number, y0: number, x1: number, y1: number): Promise<void>;
    clearMeasurements(): Promise<void>;
    unload(slot?: Slot): Promise<void>;
    setBlend(value: number): Promise<void>;
    getBlend(): Promise<number>;
    getTopCells(slot?: Slot): Promise<TopCellInfo>;
    setTopCell(name: string | null, slot?: Slot): Promise<void>;
    getSelection(): Promise<ShapeInfo | null>;
    selectAt(x: number, y: number, index?: number): Promise<ShapeInfo | null>;
    clearSelection(): Promise<void>;

    /**
     * Gives up this element's viewer for good, releasing its WebAssembly
     * instance and WebGL context.
     *
     * Rarely needed. Removing an element from the DOM *parks* its viewer
     * instead, so the next `<gds-lens>` to mount adopts it and a framework
     * remount costs nothing -- which is what you want almost always. Call
     * this only on a page that creates viewers it will never use again, and
     * is running into the browser's per-page context limit.
     */
    destroy(): Promise<void>;

    addEventListener<K extends keyof GdsLensEventMap>(
        type: K,
        listener: (this: GdsLens, ev: GdsLensEventMap[K]) => unknown,
        options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener<K extends keyof GdsLensEventMap>(
        type: K,
        listener: (this: GdsLens, ev: GdsLensEventMap[K]) => unknown,
        options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
    ): void;
}

declare global {
    interface HTMLElementTagNameMap {
        "gds-lens": GdsLens;
    }
    interface Window {
        /** Install before the element script runs to replace the default host. */
        gdsLensHost?: ViewerHost;
        /**
         * Published by the default browser host (not by the element), so a
         * plain page can drive the viewer from a script tag or the console.
         *
         * With more than one viewer on the page this is the one that mounted
         * most recently, since there is only one global to hold it. Reach a
         * specific viewer through its element instead.
         */
        gdsLens?: ViewerSurface;
    }
}
