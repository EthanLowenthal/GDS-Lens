// Publish guard: asserts the tarball contains only what it should.
//
// This exists because `files` in package.json is an allowlist that *overrides*
// .gitignore -- npm will not exclude a path the field explicitly includes. So
// listing "src/" once shipped the entire Emscripten build tree: 211 object
// files, CMake caches, and the developer's absolute home paths baked into
// them, at 2 MB. Nothing warned, because as far as npm was concerned that was
// all requested.
//
// The fix is the "!src/wasm/build" negation in `files`. This is what stops the
// fix silently regressing -- if the negation is dropped, or a new generated
// directory appears under a shipped one, publishing fails here instead of
// putting object files on the registry.
//
// Reads the file list from `npm pack --dry-run`, so it checks what npm will
// actually do rather than re-implementing its rules. Safe to call from
// prepublishOnly: pack runs prepack/prepare, never prepublishOnly, so there
// is no recursion.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Build output and toolchain droppings. None of this is any use to a consumer,
// and the CMake files in particular embed absolute paths from the machine that
// produced them.
const FORBIDDEN = [
    [/(^|\/)build\//, "build output"],
    [/\.o$/, "object file"],
    [/\.d$/, "compiler dependency file"],
    [/(^|\/)CMakeFiles\//, "CMake internals"],
    [/(^|\/)CMakeCache\.txt$/, "CMake cache (embeds absolute paths)"],
    [/(^|\/)cmake_install\.cmake$/, "CMake install script"],
    [/(^|\/)Makefile$/, "generated Makefile"],
    [/\.tsbuildinfo$/, "TypeScript build info"],
    [/(^|\/)node_modules\//, "dependencies"],
    [/\.(log|tmp|bak|orig)$/, "scratch file"],
    [/(^|\/)\.DS_Store$/, "macOS metadata"],
];

// Anything that could carry a path from this machine. The wasm binary is
// excluded by extension rather than size: it is compiled output with no text
// to inspect meaningfully.
const SCANNABLE = new Set([".js", ".mjs", ".cjs", ".ts", ".json", ".html", ".css",
                           ".md", ".cpp", ".hpp", ".h", ".txt", ".cmake"]);

const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    // The file list for this package is a few KB, but a stray warning on
    // stdout should not truncate the JSON.
    maxBuffer: 32 * 1024 * 1024,
});

const [packed] = JSON.parse(stdout);
const paths = packed.files.map((file) => file.path);
const problems = [];

for (const path of paths) {
    for (const [pattern, what] of FORBIDDEN) {
        if (pattern.test(path)) {
            problems.push(`${path}: ${what} -- should not be published`);
            break;
        }
    }
}

// The developer's own home directory, matched literally rather than as
// /Users/ or /home/: Emscripten's runtime legitimately contains the string
// "/home/web_user" (its virtual MEMFS root), and a generic pattern flags it
// on every build.
const home = homedir();
if (home && home !== "/" && !problems.length) {
    for (const path of paths) {
        if (!SCANNABLE.has(extname(path))) continue;
        const full = join(root, path);
        try {
            if ((await stat(full)).size > 8 * 1024 * 1024) continue;
            const text = await readFile(full, "utf8");
            if (text.includes(home)) {
                problems.push(`${path}: contains this machine's home directory (${home})`);
            }
        } catch {
            // A path npm reports but we cannot read is npm's business, not
            // ours -- the file list above is what matters.
        }
    }
}

if (problems.length) {
    console.error("the package would ship files it should not:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
        "\n`files` in package.json is an allowlist that overrides .gitignore, so an\n"
        + "unwanted path has to be excluded there -- see the \"!src/wasm/build\" entry.\n");
    process.exit(1);
}

const kb = Math.round(packed.size / 1024);
console.log(`package ok: ${paths.length} files, ${kb} KB packed, ${Math.round(packed.unpackedSize / 1024)} KB unpacked`);
