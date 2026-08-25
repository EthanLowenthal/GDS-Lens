// The <gds-lens> custom element: the package's entry point.
//
// Kept apart from viewer.js so that importing this module only *registers* the
// element. The engine, the wasm module and the WebGL context are all deferred
// until an element actually connects, which is what makes this a component
// someone can import into an app rather than a script that takes over the page
// on load.

import { setMountTarget } from "./mount-target.js";

// gdstk_wasm.js is Emscripten's SINGLE_FILE output: it carries the ~400KB wasm
// binary inline as a raw string, which is 66,000-odd non-ASCII bytes. A
// <script src> with no charset of its own is decoded using the *document's*
// encoding, so on a page that does not declare UTF-8 those bytes are mangled
// and the module fails with "WebAssembly.instantiate(): section was shorter
// than expected size" -- an error that says nothing whatsoever about the
// encoding that caused it. Say so plainly instead of letting someone lose an
// afternoon to it.
function warnIfNotUtf8() {
    const encoding = document.characterSet || document.charset;
    if (encoding && encoding.toUpperCase() !== "UTF-8") {
        console.error(
            `[GDS] this document is ${encoding}, not UTF-8. gds-lens embeds its ` +
            "WebAssembly binary in a script that must be decoded as UTF-8; it will " +
            'fail to load. Add <meta charset="UTF-8"> to the page, or serve the ' +
            "scripts as text/javascript; charset=utf-8."
        );
    }
}

// One viewer per page for now. renderer.cpp holds its state (GL program, VAO,
// uniform locations, camera, layer table) in file-scope globals, so a second
// element cannot share the module and would silently fight the first over the
// same state. Refusing it with a visible message is the honest failure until
// that state is threaded through a context.
let mounted = null;

export class GdsLens extends HTMLElement {
    #ready = null;

    connectedCallback() {
        if (mounted && mounted !== this) {
            this.#refuse();
            return;
        }
        if (this.#ready) return;   // moved in the DOM, not a fresh mount
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
        setMountTarget(this);
        // Deferred on purpose: this is what pulls in the engine, instantiates
        // the wasm module and creates the GL context.
        const { viewer } = await import("./viewer.js");
        return viewer;
    }

    #refuse() {
        console.error(
            "[GDS] only one <gds-lens> can be active per page: the renderer keeps " +
            "its state in module-scope globals, so a second one would fight the first."
        );
        this.textContent = "Only one <gds-lens> is supported per page.";
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
