// The bundled ESM build's entry point: the element plus a default host.
//
// The served payloads (dist/web, dist/inline-wasm) keep the host in its own
// gds-lens-host.js, so an embedder can replace that one file and leave the
// rest of the payload alone. A bundled module has no sibling files to replace,
// and `import "gds-lens"` is documented as the whole thing -- so without the
// host in here, importing the package gave a viewer with no pickers, no saved
// views, no drag-and-drop and a console error claiming no layout would ever
// appear. Every one of those is the host's work, not the element's.
//
// Ordering does not matter: hosts/browser.js installs itself only if nothing
// else has (see its foot), and viewer.js reads window.gdsLensHost when a
// viewer mounts rather than when this module loads. So an app that sets its
// own host anywhere before the first <gds-lens> connects still wins, which is
// what makes `import "gds-lens"` safe to put at the top of an entry file.
import "./hosts/browser.js";

export * from "./gds-lens.js";
