# React integration

`<gds-lens>` is a custom element, so React renders it directly — there is no
wrapper package to install. This page covers the wrapper component, TypeScript,
server rendering, and what happens when React remounts the element.

For the element's own API, see [the README](../README.md#the-gds-lens-element).
Other embedders are covered in [Embed the viewer](embedding.md).

Import once, anywhere in your app:

```jsx
import "gds-lens";

export function ChipView() {
    return <gds-lens src="/chip.gds" style={{ width: "100%", height: 600 }} />;
}
```

React passes `src` straight through as an attribute, so changing it reloads.
That covers the case where the layout is a URL. For anything else — bytes you
already have, a `.lyp`, a marker database — go through a ref, because those are
methods rather than attributes.

## A wrapper component

```jsx
import { useEffect, useRef } from "react";
import "gds-lens";

export function LayoutViewer({ bytes, lyp, markers, onLoad, onError }) {
    const ref = useRef(null);

    useEffect(() => {
        if (!bytes) return;
        // load() rejects on a bad fetch or a file the parser refuses, and an
        // unhandled rejection in an effect is invisible. Route it out instead.
        // A newer load superseding this one rejects too, with an AbortError;
        // that is the normal course of a prop changing, not a problem.
        ref.current.load(bytes).catch((err) => {
            if (err?.name !== "AbortError") onError?.(err);
        });
    }, [bytes, onError]);

    // The events are the other way to hear about a load -- the one that also
    // covers loads this component did not start, such as a host pushing bytes.
    useEffect(() => {
        const el = ref.current;
        const loaded = (event) => onLoad?.(event.detail);
        const failed = (event) => onError?.(new Error(event.detail.message));
        el.addEventListener("gds-load", loaded);
        el.addEventListener("gds-error", failed);
        return () => {
            el.removeEventListener("gds-load", loaded);
            el.removeEventListener("gds-error", failed);
        };
    }, [onLoad, onError]);

    useEffect(() => {
        if (lyp) ref.current.setLyp(lyp.name, lyp.text);
    }, [lyp]);

    useEffect(() => {
        if (markers) ref.current.setMarkers(markers.name, markers.text);
    }, [markers]);

    // display: block with no intrinsic height, so it needs one.
    return <gds-lens ref={ref} style={{ width: "100%", height: "100%" }} />;
}
```

Calling a method without awaiting `ready` is fine: every method on the element
awaits it internally, so a call in an effect that fires before the engine has
finished mounting queues rather than throwing.

Feeding it a file the user picked:

```jsx
function FilePicker({ onBytes }) {
    return (
        <input
            type="file"
            accept=".gds,.gds.gz,.oas,.oas.gz"
            onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) onBytes(new Uint8Array(await file.arrayBuffer()));
            }}
        />
    );
}
```

## TypeScript

The package declares `HTMLElementTagNameMap`, so `useRef<GdsLens>` and
`document.querySelector("gds-lens")` are typed with no work. JSX needs one
declaration of its own, and where it goes depends on your React version:

Put one of the following in a `.d.ts` anywhere on your project's include path.
Both declare the same props; they differ only in *where* the JSX namespace
lives, which changed in React 19. Use one, not both.

React 19 and later:

```tsx
import type { GdsLens } from "gds-lens";

type GdsLensProps = React.DetailedHTMLProps<
    React.HTMLAttributes<GdsLens> & { src?: string; debug?: boolean },
    GdsLens
>;

declare module "react" {
    namespace JSX {
        interface IntrinsicElements {
            "gds-lens": GdsLensProps;
        }
    }
}
```

React 18 and earlier, where the namespace is global:

```tsx
import type { GdsLens } from "gds-lens";

declare global {
    namespace JSX {
        interface IntrinsicElements {
            "gds-lens": React.DetailedHTMLProps<
                React.HTMLAttributes<GdsLens> & { src?: string; debug?: boolean },
                GdsLens
            >;
        }
    }
}
```

Then `useRef<GdsLens>(null)` gives you `load`, `goToPoint`, `setLyp` and the
rest with their real signatures.

## Server rendering

`import "gds-lens"` is safe to evaluate on the server: it registers nothing
when there is no `customElements`, and the element class does not touch
`HTMLElement` at import time. So Next, Remix, Astro and SvelteKit need no
`dynamic(..., { ssr: false })` and no `typeof window` guard around the import.

Nothing renders server-side — the element mounts its viewer when it connects
in the browser.

## Remounts and StrictMode

Unmounting a `<gds-lens>` parks its viewer rather than destroying it, and the
next one to mount adopts it (see [Removal parks the
viewer](../README.md#removal-parks-the-viewer)). So the things that would
otherwise be expensive are free:

- A route change that unmounts the viewer and later comes back to it.
- A conditional render, a changed `key`, or a parent remount that recreates the
  node.

In each case the WebAssembly instance, the WebGL context, the parsed design and
the camera all survive, and nothing reloads. You do not need `key` tricks or a
memoized wrapper to protect it.

StrictMode is a separate matter, and a smaller one. It double-invokes effects in
development without recreating the DOM node, so the viewer is never remounted by
it — but the preceding wrapper calls `load()` twice. That is safe: a second
load supersedes the first, terminating the in-flight parse rather than letting
two of them race to upload geometry. It costs a redundant parse in
development and nothing in production.

If a route never comes back and you want the resources returned,
call `destroy()` on the way out:

```jsx
useEffect(() => {
    const el = ref.current;
    return () => { el.destroy(); };
}, []);
```

Reach for that only if you are creating many viewers a user will never return
to; an ordinary unmount is better off parking.

## Supply your own host

A [`ViewerHost`](embedding.md#the-viewerhost-interface) is read when each viewer mounts, not
when the module is imported, so setting it anywhere before your first
`<gds-lens>` renders is early enough — a module-level assignment in your entry
file is the simplest place:

```js
// gds-host.js -- imported once from your app entry
window.gdsLensHost = {
    async pickLyp() {
        const text = await fetch("/pdk/layers.lyp").then((r) => r.text());
        return { name: "layers.lyp", text };
    },
    isLightTheme: () => document.documentElement.dataset.theme === "light",
};
```

Leave it unset and the default host takes over, which is usually what you want
in an app: file-picker dialogs for the `.lyp` and marker buttons, `localStorage`
for saved views, and drag-and-drop onto the element.
