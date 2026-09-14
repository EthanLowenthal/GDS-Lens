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
    "gds-load": CustomEvent<{ slot: Slot; layerCount: number; cellCount: number; portCount: number }>;
    /** A load failed, or `showError()` was called. `message` is what the viewer shows. */
    "gds-error": CustomEvent<{ message: string }>;
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
