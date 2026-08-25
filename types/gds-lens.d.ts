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
    load(bytes: Uint8Array | ArrayBuffer, options?: { reload?: boolean }): void;
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
    loadViews?(): Promise<NamedView[]> | NamedView[];
    saveViews?(views: NamedView[]): void;
    /** `existing` is the names already in use; `null` means cancelled. */
    promptViewName?(existing: string[]): Promise<string | null> | string | null;
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
 * The `<gds-lens>` element. Importing `gds-lens` registers it; the engine,
 * the wasm module and the WebGL context are all deferred until an element
 * actually connects.
 *
 * `display: block` with no intrinsic height, so give it one.
 */
export declare class GdsLens extends HTMLElement {
    /**
     * Resolves once the engine has mounted. Every method below awaits this,
     * so it is rarely needed directly. Rejects if the element is not
     * connected.
     */
    readonly ready: Promise<ViewerSurface>;

    /** `options.reload` keeps the current camera and layer visibility. */
    load(source: LayoutSource, options?: { reload?: boolean }): Promise<void>;

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
         */
        gdsLens?: ViewerSurface;
    }
}
