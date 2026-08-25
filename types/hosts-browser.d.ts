// `gds-lens/hosts/browser` -- the default ViewerHost, for a plain web page.

import type { ViewerHost } from "./gds-lens.js";

/**
 * A host implemented for an ordinary page: `<input type=file>` for the
 * pickers, `localStorage` for saved views, `prompt()` for a name, and three
 * ways in for a layout -- `?src=`, drag-and-drop on the element, and a direct
 * call through `window.gdsLens`.
 *
 * Installs itself as `window.gdsLensHost` on import if nothing else has.
 */
export function createBrowserHost(): ViewerHost;
