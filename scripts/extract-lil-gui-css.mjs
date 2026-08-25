// Regenerates the lil-gui block at the end of src/viewer.css.
//
// lil-gui normally appends its stylesheet to document.head, which a shadow
// root cannot see, so the GUI is constructed with injectStyles:false and its
// CSS is carried in our own stylesheet instead. Run this after updating the
// vendored lil-gui build.
//
// Written as a script rather than done by hand because the rules are one
// minified line: a truncated copy still parses as valid CSS and simply loses
// every selector past the cut, which shows up as a half-styled panel rather
// than as an error.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = await readFile(join(root, "src/vendor/lil-gui.umd.min.js"), "utf8");

// Walk out to the enclosing string literal rather than pattern-matching the
// rules: a lazy regex stops at the first quote inside the stylesheet.
const at = src.indexOf(".lil-gui");
if (at < 0) throw new Error("no .lil-gui rules found in the vendored build");
let open = at;
while (open > 0 && !"\"'`".includes(src[open])) open--;
const quote = src[open];
let close = at;
while (close < src.length && !(src[close] === quote && src[close - 1] !== "\\")) close++;

// Evaluate the literal so escapes become real characters.
const css = new Function("return " + src.slice(open, close + 1))();

const MARKER = "\n/* ---- lil-gui ----";
const cssPath = join(root, "src/viewer.css");
const existing = await readFile(cssPath, "utf8");
const head = existing.slice(0, existing.indexOf(MARKER));

await writeFile(cssPath, head + `${MARKER}
   Vendored verbatim from lil-gui.umd.min.js, which normally appends this to
   document.head. The panel lives inside our shadow root, which does not see
   document-level styles, so lil-gui is constructed with injectStyles:false and
   its stylesheet is carried here instead.

   Regenerate with scripts/extract-lil-gui-css.mjs rather than by hand: the
   rules are one minified line, so a truncated copy looks perfectly valid and
   simply loses every selector past the cut. */
` + css.trimEnd() + "\n");

console.log(`viewer.css: lil-gui block is ${css.length} chars`);
