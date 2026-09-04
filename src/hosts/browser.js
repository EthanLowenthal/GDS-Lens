// The default ViewerHost: the services the viewer needs from whatever is
// embedding it, implemented for a plain web page.
//
// The viewer itself knows nothing about VS Code, or about any other host. It
// asks for a file, asks for a name, asks to be reloaded, and hands back state
// to persist. Everything host-specific lives behind this interface, so a
// second embedder only has to supply these methods rather than fork the
// viewer.
//
// A host sets `window.gdsLensHost` before viewer.js runs to replace this one.
// Every method here is optional: the viewer hides the control for anything a
// host leaves out (a host with no pickLyp gets no "Load .lyp" row), so a
// read-only embed can implement almost none of it.
//
//   pickLyp()            -> Promise<{name, text} | null>   null = cancelled
//   unloadLyp()          -> void
//   pickMarkers()        -> Promise<{name, text} | null>
//   unloadMarkers()      -> void
//   loadViews(viewer)         -> Promise<view[]>
//   saveViews(views, viewer)  -> void
//   promptViewName(existingNames) -> Promise<string | null>
//   requestReload()      -> void
//   setAutoReload(on)    -> void
//   onGotoResult({ok, x, y}) -> void
//   connect(viewer)      -> void   the viewer's own surface, for pushing in
//
// `connect` is how a host drives the viewer rather than answering it:
//
//   viewer.load(bytes, { reload })   viewer.showLoading(label)
//   viewer.showError(message)
//   viewer.setLyp(name, text)        viewer.setMarkers(name, text)
//   viewer.showStale(text)           viewer.goToPoint(x, y)
//   viewer.toggleDebug()             viewer.element  (the mounted element)

export function createBrowserHost() {
    // ---- Where a viewer's saved views live ----
    //
    // One bucket per viewer, not one per page. Every viewer used to share a
    // single key, and since each reads the whole set at mount and writes the
    // whole set back on save, two viewers that both saved a view wrote over
    // each other and the last one won.
    //
    // A bucket needs a name that is still the same on the next page load, and
    // an element's position in the page is not one: keying on it would hand one
    // viewer's views to a different viewer after an edit to the markup. So, in
    // order of preference:
    //
    //   1. the element's `id`   -- author-chosen, stable, and per instance,
    //                              which is what a page of several viewers
    //                              should give them.
    //   2. its `src`            -- views belong to a layout, and on a plain
    //                              page this is the only thing that names one.
    //   3. the page's only viewer -- keeps a single-viewer page on the key it
    //                              has always used, rather than silently
    //                              orphaning views saved before this existed.
    //   4. none of those        -- nothing stable to key on. The views are kept
    //                              for the life of the page and not persisted,
    //                              which is still per viewer; give the element
    //                              an id to have them outlive the page.
    //
    // Worked out once per viewer and remembered: a page that mounts a second
    // viewer later must not move the first one's views out from under it, and a
    // viewer adopted by a new element keeps the bucket it has been using.
    const VIEWS_KEY = "gds-lens:named-views";
    const viewsKeys = new WeakMap();
    // Rule 4's viewers. Keyed on the viewer surface rather than the element,
    // which is the one identity that survives being adopted by a new element.
    const sessionViews = new WeakMap();

    const viewsKeyFor = (viewer) => {
        // A host call with no viewer at all is a viewer older than this
        // argument; the shared key is what it used to get.
        if (!viewer) return VIEWS_KEY;
        if (viewsKeys.has(viewer)) return viewsKeys.get(viewer);
        const element = viewer.element;
        const src = element && element.getAttribute("src");
        let key = null;
        if (element && element.id) {
            key = `${VIEWS_KEY}:#${element.id}`;
        } else if (src) {
            // Resolved, so the same layout reached by a relative and an
            // absolute path is one bucket rather than two. A src the URL parser
            // refuses is still a name, so keep it as written.
            let resolved = src;
            try {
                resolved = new URL(src, location.href).href;
            } catch {
                // left as written
            }
            key = `${VIEWS_KEY}:${resolved}`;
        } else if (document.querySelectorAll("gds-lens").length <= 1) {
            key = VIEWS_KEY;
        }
        viewsKeys.set(viewer, key);
        return key;
    };

    // Wrapped because storage throws outright in some privacy modes rather
    // than merely coming back empty.
    const readViews = (viewer) => {
        const key = viewsKeyFor(viewer);
        if (!key) return sessionViews.get(viewer) || [];
        try {
            // Array-checked, not just parse-guarded: the catch only covers a
            // throw, and `null` or `5` parse perfectly well while being
            // nothing the caller can iterate.
            const parsed = JSON.parse(localStorage.getItem(key) || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    };

    // One <input type=file> reused for both pickers: creating it lazily and
    // leaving it detached keeps it out of the layout, and the click has to
    // happen inside the user gesture that opened the picker or the browser
    // discards it.
    const pickText = (accept) => new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (!file) return resolve(null);
            file.text().then(
                (text) => resolve({ name: file.name, text }),
                () => resolve(null)
            );
        });
        // No "cancel" event fires reliably across browsers, so a dismissed
        // dialog simply never resolves. That is fine here: the viewer treats
        // a pick as pending until it answers, and nothing is blocked on it.
        input.click();
    });

    return {
        pickLyp: () => pickText(".lyp"),
        pickMarkers: () => pickText(".lyrdb,.txt,.db"),
        loadViews: async (viewer) => readViews(viewer),
        saveViews: (views, viewer) => {
            const key = viewsKeyFor(viewer);
            if (!key) {
                // Nothing stable to key on -- see viewsKeyFor. Held for the
                // page rather than dropped: the views still work, they just do
                // not come back tomorrow.
                sessionViews.set(viewer, views);
                return;
            }
            try {
                localStorage.setItem(key, JSON.stringify(views));
            } catch {
                // Full or blocked storage: the views stay live in this page,
                // they just will not outlive it. Not worth interrupting for.
            }
        },
        // A plain page has to be told which layout to show. Three ways in,
        // covering the three situations a page is actually in: a URL for an
        // embed, a drop for a scratch look at a local file, and a direct call
        // for a page driving the viewer itself (or a test).
        connect: (viewer) => {
            // Published for a plain page (and the test suite) to drive the
            // viewer from the console or a script tag. This is the default
            // host's doing, not the element's: an embedder that replaces
            // gds-lens-host.js gets no such global unless it sets one.
            //
            // connect runs once per viewer, so on a page with several this
            // ends up holding whichever mounted last -- there is one global
            // and no name to distinguish them by. `viewer.element` is the way
            // to a particular one. Left as a plain assignment rather than, say,
            // a list, because the console convenience this exists for wants
            // one obvious handle and a page with two viewers has the elements.
            window.gdsLens = viewer;

            // load() settles on the outcome, and a failure has already been
            // shown by the viewer itself -- so the rejection is taken here
            // rather than letting it fall into the fetch/read catch blocks
            // below, which would paint the parser's message over again with a
            // "could not fetch" it did not earn.
            const loadBytes = (bytes) => {
                viewer.load(bytes, { reload: false }).catch(() => {});
            };

            const src = new URLSearchParams(location.search).get("src");
            if (src) {
                // Same reason as the element's load(): the viewer cannot see a
                // fetch this host is doing, so it would sit idle through it.
                viewer.showLoading?.();
                fetch(src)
                    .then((response) => {
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        return response.arrayBuffer();
                    })
                    .then((buffer) => loadBytes(new Uint8Array(buffer)))
                    .catch((err) => viewer.showError(`Could not fetch ${src}: ${err.message || err}`));
            }

            // Bound to the viewer's own element, not to window. On window,
            // the preventDefault below fires for every drag anywhere in the
            // embedding page, which silently disables the host application's
            // own drop targets -- a component has no business doing that. The
            // fallback keeps a plain page working if the surface predates
            // `element`.
            // Both handlers are required: without preventDefault on dragover
            // the browser navigates away to the dropped file instead of
            // handing it over.
            const bindDrop = (target) => {
                if (!target) return;
                target.addEventListener("dragover", (event) => event.preventDefault());
                target.addEventListener("drop", (event) => {
                    event.preventDefault();
                    const file = event.dataTransfer && event.dataTransfer.files[0];
                    if (!file) return;
                    file.arrayBuffer().then(
                        (buffer) => loadBytes(new Uint8Array(buffer)),
                        (err) => viewer.showError(`Could not read ${file.name}: ${err.message || err}`)
                    );
                });
            };

            bindDrop(viewer.element || document.querySelector("gds-lens"));
            // The viewer can move to a different element (a framework
            // re-render recreates the node), which leaves the listeners above
            // on something detached. Rebind on the new one.
            if (typeof viewer.onAdopt === "function") viewer.onAdopt(bindDrop);
        },

        promptViewName: async (existingNames) => {
            const name = window.prompt(
                existingNames.length
                    ? `Name this view (reusing a name replaces it):\n${existingNames.join(", ")}`
                    : "Name this view:"
            );
            return name && name.trim() ? name.trim() : null;
        }
        // No requestReload / setAutoReload / onGotoResult: a plain page has no
        // file on disk to watch and no command palette to answer. The viewer
        // hides the stale-file banner when requestReload is missing.
    };
}

if (typeof window !== "undefined" && !window.gdsLensHost) {
    window.gdsLensHost = createBrowserHost();
}
