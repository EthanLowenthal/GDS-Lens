// Type-level smoke test for the JSX declaration the README tells React users to
// write. Compiled by `npm run check:types`, never shipped or run.
//
// It exists because that snippet is the one piece of the React section that
// cannot be checked by running anything: a wrong JSX namespace still builds
// under esbuild (which erases types) and only fails in a consumer's editor.
//
// Pinned to the React 19 form -- `declare module "react"` -- because that is
// what @types/react ^19 wants. The README also gives the React 18 form, which
// declares the same interface on the global JSX namespace instead; the two
// cannot both be checked here, since only one version of the types is
// installed.

import type { GdsLens } from "../../types/gds-lens.js";
import * as React from "react";

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

// The declarative form from the README's quick start.
const declarative = <gds-lens src="/chip.gds" style={{ width: "100%", height: 600 }} />;

// The ref form, which is what the wrapper component uses. The point of the
// declaration is that `ref` is typed as the element rather than as `unknown`,
// so the methods below resolve.
function Wrapper({ bytes }: { bytes: Uint8Array | null }) {
    const ref = React.useRef<GdsLens>(null);

    React.useEffect(() => {
        if (!bytes) return;
        // Every one of these comes from types/gds-lens.d.ts, so a signature
        // that drifts from the documented API fails here.
        void ref.current?.load(bytes).catch(() => {});
        void ref.current?.setLyp("layers.lyp", "<layer-properties/>");
        void ref.current?.goToPoint(0, 0);
        void ref.current?.destroy();
    }, [bytes]);

    return <gds-lens ref={ref} style={{ width: "100%", height: "100%" }} />;
}

// Referenced so nothing above is dead code the compiler may skip.
export { declarative, Wrapper };
