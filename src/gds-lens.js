// The <gds-lens> custom element: the package's entry point.
//
// Kept apart from viewer.js so that importing this module only *registers* the
// element. The engine, the wasm module and the WebGL context are all deferred
// until an element actually connects, which is what makes this a component
// someone can import into an app rather than a script that takes over the page
// on load.

import { setMountTarget } from "./mount-target.js";

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

// One viewer at a time. renderer.cpp holds its state (GL program, VAO, uniform
// locations, camera, layer table) in file-scope globals, so two live elements
// cannot share the module and would silently fight over the same state.
// Refusing the second with a visible message is the honest failure until that
// state is threaded through a context.
//
// "At a time" rather than "per page load", though: the element that holds the
// claim gives it up when it leaves the DOM, and the next one to connect gets
// the existing engine moved into it. Without that, a framework re-render or an
// SPA route change -- anything that recreates the node -- left every
// subsequent <gds-lens> permanently refusing, since the engine's module body
// had already run and could not run again.
let mounted = null;

// The loaded engine module, kept across mounts. Populated on the first mount
// and never torn down: it owns the wasm instance and the GL context, and a
// module body cannot be re-run.
let engine = null;

export class GdsLens extends HTMLElement {
    #ready = null;

    connectedCallback() {
        if (mounted && mounted !== this) {
            this.#refuse();
            return;
        }
        // Moved in the DOM rather than recreated: this element still owns its
        // own shadow tree, so there is nothing to redo.
        if (this.#ready) {
            mounted = this;
            return;
        }
        mounted = this;
        warnIfNotUtf8();
        this.#ready = this.#mount();

        // Deliberately after #ready is assigned, and deliberately not awaited
        // inside #mount: load() waits on this.ready, so loading from within
        // the promise that resolves it would wait on itself forever.
        const src = this.getAttribute("src");
        if (src) this.#ready.then(() => this.load(src));
    }

    async #mount() {
        // Already running from an earlier element: move it here rather than
        // building a second engine, which is not possible.
        if (engine) {
            engine.adopt(this);
            return engine.viewer;
        }
        setMountTarget(this);
        // Deferred on purpose: this is what pulls in the engine, instantiates
        // the wasm module and creates the GL context.
        engine = await import("./viewer.js");
        return engine.viewer;
    }

    #refuse() {
        console.error(
            "[GDS] only one <gds-lens> can be active at a time: the renderer keeps " +
            "its state in module-scope globals, so a second one would fight the first. " +
            "Remove the first from the DOM and this one will take over its engine."
        );
        this.textContent = "Only one <gds-lens> is supported at a time.";
    }

    // Resolves once the engine has mounted, so callers can await readiness
    // without racing the dynamic import.
    get ready() {
        return this.#ready || Promise.reject(new Error("<gds-lens> is not connected"));
    }

    // Accepts what a caller is likely to already have: a URL to fetch, or the
    // bytes themselves in either of the two shapes they usually arrive in.
    async load(source, options) {
        const viewer = await this.ready;
        if (typeof source === "string") {
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

    // Releases the claim without tearing anything down. The element is very
    // often coming straight back -- React and friends recreate the node on
    // re-render -- and discarding the wasm instance and GL context only to
    // rebuild them a tick later would be far worse than holding them. The
    // engine stays up; the next element to connect adopts it.
    disconnectedCallback() {
        if (mounted === this) mounted = null;
    }

    static get observedAttributes() {
        return ["src"];
    }

    attributeChangedCallback(name, previous, current) {
        if (name === "src" && current && current !== previous && this.#ready) {
            this.load(current);
        }
    }
}

if (typeof customElements !== "undefined" && !customElements.get("gds-lens")) {
    customElements.define("gds-lens", GdsLens);
}
