# Developing GDS Lens

Developer documentation for building and hacking on the extension. For usage,
see [`README.md`](README.md).

## Project layout

- `src/extension.cjs` — the extension host (Node). Opens the layout file
  (`.gds` / `.oas` / `.oasis`), streams its raw bytes into the webview, and
  relays the `.lyp` and marker file pickers.
- `src/viewer.html` / `src/viewer.js` — the webview: bootstraps the wasm
  module and wires up `postMessage` from the extension host.
- `src/marker-parsers.js` — standalone parsers for DRC/LVS marker databases
  (KLayout `.lyrdb`, Calibre DRC ASCII); loaded in the webview via a
  `<script>` tag and `require()`d directly by the unit tests.
- `src/wasm/` — C++ source (`bindings.cpp`, `renderer.cpp`, `gds_common.hpp`)
  compiled with Emscripten into `src/wasm/build/gdstk_wasm.js`, which does
  GDSII/OASIS parsing and WebGL rendering. Which of gdstk's two readers runs
  is decided by sniffing the file header in `gds_common.hpp`, so no caller
  has to know the format. See `docs/rendering-rewrite.md` for the design
  history of this C++/WASM architecture.
- `third_party/gdstk`, `third_party/qhull` — git submodules the wasm build
  links against.
- `test/` — plain-Node tests (`npm test`): marker-parser unit tests plus
  headless tests that eval the built wasm bundle in Node (skipped when
  `src/wasm/build/gdstk_wasm.js` hasn't been built) covering marker state and
  the GDSII/OASIS readers. `test/fixtures/sample_layout.{gds,oas}` are the
  same KLayout-built design written in both formats.

## Building

GDS parsing and WebGL rendering run in a C++/WebAssembly module (`src/wasm/`,
built against the bundled `gdstk` submodule). Building it requires the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(`emcc`/`emcmake` on `PATH`). After installing the SDK and initializing
submodules (`git submodule update --init --recursive`):

```sh
npm run build:wasm
```

This configures and builds `src/wasm/build/gdstk_wasm.js`, which
`src/extension.cjs` loads into the webview at runtime. Re-run it after
changing any `src/wasm/*.cpp` file or the `gdstk`/`third_party/qhull`
submodules.

## Running

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded, then open a `.gds` or `.oas` file.

## Layout size limits

Parsing, flattening and triangulating all happen inside a 32-bit WebAssembly
module, so everything has to fit in one 4 GB address space
(`-sMAXIMUM_MEMORY` in `src/wasm/CMakeLists.txt` — Emscripten's default is
only 2 GB). What that buys, measured against generated stress layouts:

- **Flat geometry is the expensive case.** ~1 KB per polygon end to end
  (gdstk polygon + triangulated vertices + the typed arrays handed to JS), so
  a couple of million top-level polygons is the practical ceiling.
- **Hierarchy is nearly free.** A cell placed at least `kInstanceThreshold`
  (8) times anywhere in the design becomes a GPU instance batch — 24 bytes per
  placement instead of a full geometry copy. A hierarchy that flattens to
  115M polygons loads in ~2 GB; the same 4 GB budget is exhausted somewhere
  under 1G.

Past that the module aborts. The abort is a JS throw, so it's caught in
`wasm-worker.js`, run through `describeLoadFailure` (`src/load-errors.js`) to
turn engine strings like `memory access out of bounds` / `Aborted()` into an
explanation, and shown in the viewer's `#loadError` panel. Files larger than
`MAX_LAYOUT_BYTES` (2 GB) are refused by the extension host before they're
even read, since the raw bytes alone have to be copied into that same heap.

Note that `#ui` — the upper-left readout — is `display:none` outside debug
mode, so it must never be the only place an error is written.

## Publishing

The extension goes to two registries: the **VS Code Marketplace** (VS Code
proper) and **Open VSX** (Cursor, Windsurf, VSCodium, code-server, Gitpod,
Theia). Both should ship the same build.

### One-time setup

Copy [`.env.publish.example`](.env.publish.example) to `.env.publish` and fill
in both tokens. That file is gitignored and excluded from the packaged `.vsix`
via `.vscodeignore`; `scripts/with-env.sh` loads it so no token ever lands in
shell history.

- `VSCE_PAT` — an Azure DevOps personal access token, scoped **Marketplace →
  Manage**, with organization set to **All accessible organizations**. Azure
  caps PAT lifetime at one year, so this expires and has to be reissued.

  > **Deadline: 1 December 2026.** Azure DevOps retires *global* PATs on that
  > date — and "All accessible organizations" is exactly what makes this one
  > global, so `VSCE_PAT` publishing stops working then. See
  > [Migrating off `VSCE_PAT`](#migrating-off-vsce_pat) below. `OVSX_PAT` is an
  > Eclipse token and is unaffected.
- `OVSX_PAT` — from your open-vsx.org profile. Before the first publish you
  must sign the Eclipse Publisher Agreement (with an Eclipse account whose
  email matches your GitHub account) and claim the namespace, which has to
  match `publisher` in `package.json`:

  ```sh
  sh scripts/with-env.sh npx ovsx create-namespace ethml
  ```

  The namespace starts unverified, which shows a warning on the listing;
  ownership verification is requested via an issue on the
  `EclipseFdn/open-vsx.org` repo.

### Releasing

Bump `version` in `package.json`, update `CHANGELOG.md`, rebuild the wasm
(`npm run build:wasm` — the built bundle is committed, and stale output ships
silently), then:

```sh
npm run package       # -> GDS-Lens-<version>.vsix
npm run publish:all   # package + both registries
```

`publish:vsce` and `publish:ovsx` can be run individually; both publish the
prebuilt `GDS-Lens-<version>.vsix` rather than repackaging, so the two
registries get byte-identical artifacts.

Marketplace metadata (`displayName`, `description`, `categories`, `keywords`,
`galleryBanner`) only takes effect on the next publish — editing it without
shipping a new version changes nothing on the listing.

### Migrating off `VSCE_PAT`

Global PATs stop working on 1 December 2026. Two replacements exist; only the
Marketplace side is affected, so Open VSX keeps using `OVSX_PAT` either way.

**`vsce publish --oidc` — the intended target, but NOT YET RELEASED.** As of
vsce 3.9.2 this flag does not exist (`unknown option '--oidc'`); it is
documented only on the vsce `main` branch README. Re-check with
`npx @vscode/vsce publish --help | grep oidc` before planning around it.

When it ships, it publishes from GitHub Actions with no stored Marketplace
secret at all: the workflow requests a GitHub OIDC token for the
`marketplace.visualstudio.com` audience and exchanges it for a short-lived
credential. Setup is a trusted-publishing policy on the Marketplace naming this
repo and workflow, plus `id-token: write` on the job:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - run: npm ci
  - run: npx @vscode/vsce publish --oidc
```

It deliberately does *not* fall back to a PAT if the exchange fails. The
tradeoff is that releases must run in CI — `--oidc` cannot work from a laptop,
since there is no Actions token to exchange. Note the wasm bundle is committed
rather than built in CI, so a CI release publishes whatever
`src/wasm/build/gdstk_wasm.js` was last committed.

**`vsce publish --azure-credential`.** Available today, and the only documented
replacement. Entra ID via workload identity federation: an Azure DevOps service
connection, a user-assigned managed identity in Azure with a Reader role,
federated credentials exchanged between the two, the identity added as a
Contributor member of the Marketplace publisher, and an Azure Pipelines job that
mints an Entra token. It assumes an Azure subscription and Azure Pipelines,
neither of which this project uses — disproportionate for a solo extension.

**Plan of record:** stay on `VSCE_PAT` for now, and re-check `--oidc` around
Q3 2026. Microsoft needs a GitHub Actions story before retiring PATs on
1 December 2026, and `--oidc` already exists on `main`, so it is very likely to
ship in time. If it has not shipped by ~November 2026, fall back to
`--azure-credential`.

## Known issues

- `eslint.config.mjs` imports `globals`, which isn't a declared dependency —
  `npx eslint` currently fails with `ERR_MODULE_NOT_FOUND`.
