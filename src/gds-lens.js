// The <gds-lens> custom element: the package's entry point.
//
// Kept apart from viewer.js so that importing this module only *registers* the
// element. The engine, the wasm module and the WebGL context are all deferred
// until an element actually connects, which is what makes this a component
// someone can import into an app rather than a script that takes over the page
// on load.

// True only in the inline-wasm payload, where gds-lens-engine.js carries the ~400KB
// wasm binary inline as a raw string -- 66,000-odd non-ASCII bytes. A <script
// src> with no charset of its own is decoded using the *document's* encoding,
// so on a page that does not declare UTF-8 those bytes are mangled and the
// module fails with "WebAssembly.instantiate(): section was shorter than
// expected size" -- an error that says nothing whatsoever about the encoding
// that caused it. Say so plainly instead of letting someone lose an afternoon
// to it.
//
// esbuild substitutes this per payload (see scripts/build-webview.mjs), so the
// warning stays silent in the default build, where the binary is a separate
// file and the page's encoding is nobody's business. The typeof guard is for
// running from source through the package's exports map, where nothing has
// defined it and it should warn.
const INLINE_WASM = typeof __GDS_LENS_INLINE_WASM__ === "undefined" || __GDS_LENS_INLINE_WASM__;

function warnIfNotUtf8() {
    if (!INLINE_WASM) return;
    const encoding = document.characterSet || document.charset;
    if (encoding && encoding.toUpperCase() !== "UTF-8") {
        console.error(
            `[GDS] this document is ${encoding}, not UTF-8. This build of gds-lens ` +
            "embeds its WebAssembly binary in a script that must be decoded as " +
            'UTF-8; it will fail to load. Add <meta charset="UTF-8"> to the page, ' +
            "serve the scripts as text/javascript; charset=utf-8, or use the " +
            "default build, which keeps the binary in a separate file."
        );
    }
}

// One viewer per element. Each <gds-lens> builds its own viewer -- its own
// shadow tree, its own wasm instance, its own GL context -- so any number of
// them can be live at once. That works because the engine is instantiated
// through Emscripten's MODULARIZE factory: every call returns an instance with
// its own linear memory, so renderer.cpp's file-scope globals (its GL program,
// VAO, camera and layer table) are per-instance rather than shared.
//
// Two things are worth knowing before putting several on one page. Each viewer
// costs a WebAssembly instance and a WebGL2 context, and browsers cap live
// contexts per page at around eight to sixteen -- past that the browser drops
// the oldest, which is not something this code can prevent. The wasm binary
// itself is compiled once and instantiated per viewer, so the marginal cost of
// a second viewer is its heap rather than another download.
//
// ---- Viewers outliving their element ----
// A viewer is expensive to build, and its state (the parsed design, the camera,
// the layer visibility) is worth more than the element holding it. So when an
// element leaves the DOM its viewer is *parked* rather than torn down, and the
// next element to connect without one of its own adopts it.
//
// That is what makes a framework remount free: React and friends recreate the
// node on re-render, and an SPA route change destroys and rebuilds it. The
// element is new, the viewer is not, and nothing reloads.
//
// The queue is also why this stays correct with more than one viewer: only an
// element that has *left* the DOM parks its viewer, so a second element
// mounted alongside a live first one finds nothing to adopt and builds its own.
// A single viewer on a page therefore behaves exactly as it did when only one
// was allowed -- which is the point, since that is still the common case.
const parkedViewers = [];

// Which element each viewer currently belongs to. A viewer changes hands when
// a new element adopts one out of the park queue, and the element it left has
// to stop driving it -- otherwise a detached element's load() or src change
// lands in whichever element took its viewer over, which is a viewer showing
// something nobody asked it to show.
const viewerOwner = new WeakMap();

// Resolved once and shared: this is the module body, not the viewer, and it
// holds nothing per-viewer. Kept as the promise rather than the module so
// concurrent first mounts (two elements in the same markup) await one import
// instead of racing two.
let enginePromise = null;

function loadEngine() {
    // Deferred on purpose: this is what pulls in the engine and, on the first
    // createViewer call, instantiates the wasm module and creates the GL
    // context.
    if (!enginePromise) enginePromise = import("./viewer.js");
    return enginePromise;
}

// Importing this module must not need a DOM. `import "gds-lens"` is the
// documented entry point, and every SSR framework -- Next, Nuxt, Astro,
// SvelteKit -- evaluates that import on the server first, where there is no
// HTMLElement. A class declaration is evaluated at import time, so extending
// it directly threw a ReferenceError before anything had even tried to use the
// component. Extending a stub instead moves the failure to the only place it
// can matter -- constructing an element, which nothing but a browser does --
// and leaves the import a no-op on the server, which is what a consumer's
// bundler and framework both expect of a custom element.
const ElementBase = typeof HTMLElement === "undefined" ? class {} : HTMLElement;

export class GdsLens extends ElementBase {
    #ready = null;

    // The viewer this element is driving, once its mount has resolved. Held
    // separately from #ready because disconnectedCallback has to reach it
    // synchronously, and an element can be removed while its mount is still
    // in flight.
    #viewer = null;

    // True while #mount() is in flight. An element removed and re-added before
    // its engine arrives must not start a second mount: both would finish
    // against the same element, and the loser's wasm instance and GL context
    // would be orphaned -- invisible, because the winner overwrites the shadow
    // tree, and unreclaimable, because nothing holds a reference to park.
    #mounting = false;

    connectedCallback() {
        // Re-added rather than created. Three cases, in order of likelihood:
        // a mount is still running and will attach to this element when it
        // lands; this element's own viewer is parked and it takes it back; or
        // another element adopted that viewer meanwhile, and this one has to
        // start over with a viewer of its own.
        if (this.#ready) {
            if (this.#mounting || this.#reclaim()) return;
            this.#ready = null;
            this.#viewer = null;
        }
        warnIfNotUtf8();
        this.#mounting = true;
        this.#ready = this.#mount();
        // #mount() rejects when the element is removed before the engine
        // arrives, which is an ordinary thing for a page to do and not worth
        // reporting. Without a handler here it surfaces as an unhandled
        // rejection -- in the console, and in whatever error reporting the
        // embedding app runs. Callers still see it through `ready`.
        this.#ready.catch(() => {});

        // Deliberately after #ready is assigned, and deliberately not awaited
        // inside #mount: load() waits on this.ready, so loading from within
        // the promise that resolves it would wait on itself forever.
        const src = this.getAttribute("src");
        if (src) this.#loadSrc(src);
    }

    // A layout named by the attribute rather than by a caller, so there is no
    // promise to hand a failure back on. Show it in the viewer, which is where
    // someone looking at a blank element will look.
    #loadSrc(src) {
        this.#ready
            .then(() => this.load(src))
            .catch((err) => {
                // Removed before it ever mounted: the reason there is no
                // layout is that there is no viewer, and the page moved on.
                if (!this.isConnected) return;
                this.showError(`Could not load ${src}: ${err && err.message ? err.message : err}`)
                    .catch(() => console.error(`[GDS] could not load ${src}:`, err));
            });
    }

    // Takes this element's own viewer back out of the park queue. False means
    // it is no longer there -- another element adopted it -- and the caller
    // has to mount a fresh one.
    #reclaim() {
        const index = parkedViewers.indexOf(this.#viewer);
        if (index === -1) return false;
        parkedViewers.splice(index, 1);
        // The viewer never left this element: its shadow tree, GL context and
        // listeners are all still here, so unlike an adopt there is nothing to
        // move. Re-pointing it at the element it is already in would be a
        // no-op anyway (see adopt's first line).
        return true;
    }

    async #mount() {
        try {
            // An earlier element's viewer, parked when that element left the
            // DOM. Moving it here keeps the parsed design, the camera and the
            // GL context, which is what makes a framework remount cost nothing.
            const parked = parkedViewers.shift();
            if (parked) {
                // The element it came from keeps a reference to it, and would
                // otherwise go on driving it from outside the DOM.
                viewerOwner.get(parked)?.#surrender();
                parked.adopt(this);
                this.#claim(parked);
                return parked.viewer;
            }
            const engine = await loadEngine();
            // Removed while the import was in flight, and not re-added --
            // connectedCallback would have left #mounting set if it had been.
            // Building a viewer for a detached element would create a WebGL
            // context nothing can see and that nothing would ever park.
            if (!this.isConnected) {
                throw new Error("<gds-lens> was removed before it finished mounting");
            }
            const created = engine.createViewer(this);
            this.#claim(created);
            return created.viewer;
        } finally {
            this.#mounting = false;
        }
    }

    #claim(viewer) {
        this.#viewer = viewer;
        viewerOwner.set(viewer, this);
    }

    // Called on the element a viewer is being taken from. It keeps its shadow
    // tree (now empty -- adopt moves the nodes out), but it is no longer
    // driving anything, so `ready` and every method on it reject rather than
    // reaching into the element that took over.
    #surrender() {
        this.#ready = null;
        this.#viewer = null;
    }

    // Resolves once the engine has mounted, so callers can await readiness
    // without racing the dynamic import. Rejects for an element that is not
    // driving a viewer: one that was never connected, or one whose parked
    // viewer another element has since adopted.
    get ready() {
        return this.#ready || Promise.reject(new Error(
            "<gds-lens> is not driving a viewer: it has not been connected, or it was " +
            "removed from the DOM and another <gds-lens> adopted its viewer."));
    }

    // Accepts what a caller is likely to already have: a URL to fetch, or the
    // bytes themselves in either of the two shapes they usually arrive in.
    async load(source, options) {
        const viewer = await this.ready;
        if (typeof source === "string") {
            // The fetch is this side's work, so the viewer has no way to know
            // it is happening -- and until it does it shows an idle "no layout
            // loaded". Tell it, or a slow download looks like a viewer that
            // was never asked for anything.
            viewer.showLoading?.();
            const response = await fetch(source);
            if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
            return viewer.load(new Uint8Array(await response.arrayBuffer()), options);
        }
        return viewer.load(source, options);
    }

    async goToPoint(x, y) {
        return (await this.ready).goToPoint(x, y);
    }

    async setLyp(name, text) {
        return (await this.ready).setLyp(name, text);
    }

    async setMarkers(name, text) {
        return (await this.ready).setMarkers(name, text);
    }

    async showError(message) {
        return (await this.ready).showError(message);
    }

    // Parks the viewer without tearing anything down. The element is very
    // often coming straight back -- React and friends recreate the node on
    // re-render -- and discarding the wasm instance and GL context only to
    // rebuild them a tick later would be far worse than holding them.
    //
    // Nothing frees a parked viewer, which is deliberate: there is no reliable
    // Emscripten teardown, and a page that mounts and unmounts one <gds-lens>
    // repeatedly reuses the same parked viewer every time rather than growing
    // the queue. A page that really is done with a viewer calls destroy().
    disconnectedCallback() {
        if (this.#viewer && !parkedViewers.includes(this.#viewer)) {
            parkedViewers.push(this.#viewer);
        }
    }

    // Gives up this element's viewer for good: detaches its listeners and
    // drops the last reference to its wasm instance and GL context, so the
    // browser can reclaim both. Only worth calling on a page that creates
    // viewers it will not use again -- an ordinary unmount should just let
    // disconnectedCallback park it.
    async destroy() {
        const viewer = this.#viewer;
        this.#surrender();
        if (!viewer) return;
        // Out of the queue first: a viewer that has been disposed must not be
        // handed to the next element that mounts.
        const index = parkedViewers.indexOf(viewer);
        if (index !== -1) parkedViewers.splice(index, 1);
        viewerOwner.delete(viewer);
        viewer.dispose();
    }

    static get observedAttributes() {
        return ["src"];
    }

    attributeChangedCallback(name, previous, current) {
        // #ready is null for an element that is not driving a viewer -- never
        // connected, or its viewer adopted away after it left the DOM. Loading
        // then would push this layout into whichever element took the viewer
        // over. The initial value is handled by connectedCallback instead.
        if (name === "src" && current && current !== previous && this.#ready) {
            this.#loadSrc(current);
        }
    }
}

if (typeof customElements !== "undefined" && !customElements.get("gds-lens")) {
    customElements.define("gds-lens", GdsLens);
}
