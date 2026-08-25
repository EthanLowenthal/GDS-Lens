// Guards the lil-gui stylesheet copied into src/viewer.css.
//
// The panel lives in a shadow root, which cannot see the stylesheet lil-gui
// appends to document.head, so the CSS is vendored into our own. That copy is
// one minified line: a truncated one still parses as valid CSS and simply
// loses every selector past the cut, so it fails as a half-styled panel at
// runtime rather than as an error at build time. This is the check that turns
// that into a test failure.

import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function vendoredCss() {
    const src = fs.readFileSync(path.join(root, "src/vendor/lil-gui.umd.min.js"), "utf8");
    const at = src.indexOf(".lil-gui");
    let open = at;
    while (open > 0 && !"\"'`".includes(src[open])) open--;
    const quote = src[open];
    let close = at;
    while (close < src.length && !(src[close] === quote && src[close - 1] !== "\\")) close++;
    return new Function("return " + src.slice(open, close + 1))();
}

test("viewer.css carries lil-gui's stylesheet in full", () => {
    const css = fs.readFileSync(path.join(root, "src/viewer.css"), "utf8");
    const vendored = vendoredCss();

    assert.ok(css.includes(vendored),
        "the lil-gui block in viewer.css does not match the vendored build. " +
        "Regenerate it with `node scripts/extract-lil-gui-css.mjs`.");

    // Belt and braces: the truncation that prompted this test kept the token
    // block and dropped every rule that styles a control row, so name those
    // explicitly rather than relying on the whole-string compare alone.
    for (const selector of [".lil-controller", ".lil-widget", ".lil-name", ".lil-children"]) {
        assert.ok(css.includes(selector), `viewer.css is missing ${selector} rules`);
    }
});
