const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { decodeLayoutBytes } = require('./layout-bytes.js');

const logger = vscode.window.createOutputChannel("GDSII Debugger");

// globalState key holding the fsPath of the most recently loaded KLayout .lyp,
// so it's re-applied automatically to every GDS viewer opened afterwards
// (across windows and restarts). We store the path rather than the file text so
// edits to the .lyp are picked up on reopen, and so the stored state stays tiny.
const LAST_LYP_PATH_KEY = 'GDS-Lens.lastLypPath';

// workspaceState key holding a { gdsFsPath: markerFsPath } map. Unlike the
// global .lyp path above, marker databases are remembered *per GDS file* --
// DRC results are design-specific, so re-applying design A's markers to
// design B would be noise.
const MARKER_PATHS_KEY = 'GDS-Lens.markerPathByGds';

// Hard ceiling on the layout bytes. They have to be copied into the wasm
// module's 32-bit heap (4 GB, see src/wasm/CMakeLists.txt) and the flattened
// geometry built from them is always larger again, so a file this size cannot
// load however patient you are -- better to say so up front than to spend
// minutes copying it around first. Anything under this is attempted, and the
// viewer reports an out-of-memory error if it doesn't fit after all.
//
// For a gzipped layout this bounds what it *expands* to, which is the size that
// actually has to fit; the compressed file on disk is checked against it too,
// since one that big is certainly not going to expand to something smaller.
const MAX_LAYOUT_BYTES = 2 * 1024 * 1024 * 1024;

// How long the layout file has to hold a steady size+mtime before a reload
// reads it. Layout writers rarely produce one clean change event: generator
// scripts and KLayout write in chunks, and some tools write a temp file and
// rename it over the target (which arrives as delete-then-create). Reading on
// the first event would routinely hit a half-written file and report a bogus
// parse error.
const SETTLE_MS = 400;
// Give up waiting for quiet after this and read what's there -- a file being
// appended to continuously would otherwise never reload at all.
const SETTLE_TIMEOUT_MS = 30000;

function autoReloadEnabled() {
    return vscode.workspace.getConfiguration('GDS-Lens').get('autoReload', false);
}

// Global rather than workspace: layouts are usually opened from outside any
// workspace folder, where a workspace-scoped write would silently not apply.
function setAutoReload(enabled) {
    return vscode.workspace.getConfiguration('GDS-Lens')
        .update('autoReload', enabled, vscode.ConfigurationTarget.Global);
}

function formatBytes(bytes) {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
    return (bytes / 1024).toFixed(0) + ' KB';
}

function activate(context) {
    logger.show(true);
    logger.appendLine(">>> GDSII Extension Core Spinning Up (wasm parsing + rendering)...");

    const provider = new GdsEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('GDS-Lens.editor', provider, {
            // Without this, VS Code destroys the webview's DOM whenever the tab
            // is hidden and re-runs viewer.js from scratch when it comes back --
            // but resolveCustomEditor() (the only thing that posts 'init' with
            // the file bytes) runs once per editor, so the restored webview sits
            // on "Loading layout..." forever. Keeping the context also means a
            // tab switch doesn't re-parse the layout, which for a large GDS is
            // the difference between instant and tens of seconds. The cost is
            // that the wasm heap and GL context stay resident while hidden.
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // "GDSLens: Toggle Debug Tools" -- shows/hides the upper-left readout and
    // the debug-log panel/button (all hidden by default) in every open GDS
    // viewer.
    context.subscriptions.push(
        vscode.commands.registerCommand('GDS-Lens.showDebugTools', () => {
            provider.toggleDebugTools();
        })
    );

    // The only in-editor way back out of auto-reload: with it on, the viewer's
    // "newer version on disk" banner (which is where you turn it on) never
    // appears, so without this the Settings UI would be the sole off switch.
    context.subscriptions.push(
        vscode.commands.registerCommand('GDS-Lens.toggleAutoReload', async () => {
            const enabled = !autoReloadEnabled();
            await setAutoReload(enabled);
            vscode.window.setStatusBarMessage(
                enabled
                    ? 'GDS Lens: auto-reload on layout change is ON'
                    : 'GDS Lens: auto-reload on layout change is OFF',
                4000
            );
        })
    );
}

class GdsEditorProvider {
    constructor(context) {
        this.context = context;
        // Every currently-open GDS webview panel, so showDebugTools() can
        // reach them (removed on dispose, see resolveCustomEditor).
        this.panels = new Set();
    }

    toggleDebugTools() {
        for (const panel of this.panels) {
            panel.webview.postMessage({ type: 'toggleDebugTools' });
        }
    }

    // Reads a .lyp from disk and pushes it to one viewer, tagged with its
    // basename so the panel can show it as a "filename.lyp ✕" chip. Returns
    // false (without throwing) if the file can't be read, so callers can drop a
    // stale remembered path.
    postLyp(webviewPanel, fsPath) {
        try {
            const text = fs.readFileSync(fsPath, 'utf8');
            webviewPanel.webview.postMessage({
                type: 'lypLoaded',
                text: text,
                name: path.basename(fsPath)
            });
            return true;
        } catch (err) {
            logger.appendLine('>>> Could not read .lyp at ' + fsPath + ': ' + err.message);
            return false;
        }
    }

    // Marker-database twin of postLyp: reads a .lyrdb / Calibre results file
    // and pushes its text to one viewer (format sniffing happens in the
    // webview -- see marker-parsers.js). Returns false if unreadable so
    // callers can drop a stale remembered path.
    postMarkers(webviewPanel, fsPath) {
        try {
            const text = fs.readFileSync(fsPath, 'utf8');
            webviewPanel.webview.postMessage({
                type: 'markersLoaded',
                text: text,
                name: path.basename(fsPath)
            });
            return true;
        } catch (err) {
            logger.appendLine('>>> Could not read marker file at ' + fsPath + ': ' + err.message);
            return false;
        }
    }

    async updateMarkerMap(mutate) {
        const map = { ...(this.context.workspaceState.get(MARKER_PATHS_KEY) || {}) };
        mutate(map);
        await this.context.workspaceState.update(MARKER_PATHS_KEY, map);
    }

    async openCustomDocument(uri, openContext, token) {
        return {
            uri: uri,
            onDidDispose: new vscode.EventEmitter().event,
            dispose: () => {}
        };
    }

        async resolveCustomEditor(document, webviewPanel, _token) {
        try {
            // 1. Grant permission to execute scripts and access local extensions directories
            webviewPanel.webview.options = {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(this.context.extensionPath)]
            };

            // 2. Fetch the absolute disk file path vectors
            const htmlPath = path.join(this.context.extensionPath, 'src', 'viewer.html');
            const jsPath = path.join(this.context.extensionPath, 'src', 'viewer.js');
            const markerParsersJsPath = path.join(this.context.extensionPath, 'src', 'marker-parsers.js');
            const loadErrorsJsPath = path.join(this.context.extensionPath, 'src', 'load-errors.js');
            const wasmJsPath = path.join(this.context.extensionPath, 'src', 'wasm', 'build', 'gdstk_wasm.js');
            const lilGuiJsPath = path.join(this.context.extensionPath, 'src', 'vendor', 'lil-gui.umd.min.js');
            const workerJsPath = path.join(this.context.extensionPath, 'src', 'wasm-worker.js');

            // 3. Convert the native viewer.js/wasm file paths into authenticated Webview URIs
            const jsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(jsPath));
            const markerParsersJsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(markerParsersJsPath));
            const loadErrorsJsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(loadErrorsJsPath));
            const wasmJsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(wasmJsPath));
            const lilGuiJsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(lilGuiJsPath));

            // The Worker (see viewer.js) needs gdstk_wasm.js's and
            // wasm-worker.js's full text to build its own Blob script from --
            // neither `importScripts(asWebviewUri(...))` from inside the
            // Worker nor `fetch(asWebviewUri(...))` from the main thread can
            // reach VS Code's webview resource protocol (confirmed in
            // practice: both fail, even though the identical URL loads fine
            // as a <script src> tag). Sending the ~270KB text through
            // postMessage() also reliably broke opening the editor entirely
            // (VS Code's extension-host<->webview RPC channel threw an
            // internal assertion on a payload that size). Embedding it
            // directly into the HTML document instead sidesteps both: it's
            // base64 inside an inert `type="text/plain"` <script> tag (avoids
            // any risk of the bundle's own text containing a literal
            // "</script>"), and `webview.html = ...` is a different code path
            // from postMessage's RPC channel that routinely handles content
            // this size without issue (webviews load real HTML documents
            // with inline images/fonts far larger than this all the time).
            // load-errors.js goes in too: the Worker calls describeLoadFailure
            // when a parse dies, and it can't import from the main thread.
            const workerBundleBase64 = Buffer.from(
                fs.readFileSync(wasmJsPath, 'utf8') + '\n' +
                fs.readFileSync(loadErrorsJsPath, 'utf8') + '\n' +
                fs.readFileSync(workerJsPath, 'utf8'),
                'utf8'
            ).toString('base64');

            // 4. Load the base HTML text and dynamically swap out the standard script references
            let htmlContent = fs.readFileSync(htmlPath, 'utf8');
            htmlContent = htmlContent.replace('src="wasm/build/gdstk_wasm.js"', 'src="' + wasmJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="vendor/lil-gui.umd.min.js"', 'src="' + lilGuiJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="marker-parsers.js"', 'src="' + markerParsersJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="load-errors.js"', 'src="' + loadErrorsJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="viewer.js"', 'src="' + jsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('{{cspSource}}', webviewPanel.webview.cspSource);
            htmlContent = htmlContent.replace('{{workerBundleBase64}}', workerBundleBase64);

            webviewPanel.webview.html = htmlContent;

            // Track this panel so the "Show Debug Tools" command can post to it.
            this.panels.add(webviewPanel);
            // Everything registered per-editor below (watcher, its event
            // handlers, the settings listener) has to go when the tab does --
            // unlike the panel itself, none of it is cleaned up automatically.
            const disposables = [];
            let disposed = false;
            webviewPanel.onDidDispose(() => {
                disposed = true;
                this.panels.delete(webviewPanel);
                for (const d of disposables) d.dispose();
            });

            // postMessage on a disposed webview throws, and every path below
            // can reach one: the reload flow awaits stats and reads, and the
            // user is free to close the tab in the middle of any of them.
            const post = (message) => {
                if (disposed) return;
                webviewPanel.webview.postMessage(message);
            };

            logger.appendLine('\n>>> Intercepted layout open call for file: ' + document.uri.fsPath);

            // Size+mtime of the bytes currently loaded in the viewer. The
            // watcher compares against this so events that don't reflect a
            // real content change (a touch, an editor saving an unchanged
            // buffer) don't cost a multi-second re-parse.
            let loadedStamp = null;

            const statOrNull = async () => {
                try {
                    return await vscode.workspace.fs.stat(document.uri);
                } catch {
                    return null;  // deleted, or mid-rename
                }
            };

            // Reads the file and hands it to the webview, as the first load
            // (isReload false, viewer frames the design) or a re-read
            // (isReload true, viewer keeps camera and layer visibility).
            const sendLayout = async (isReload) => {
                // Size-check before reading: the read itself allocates the
                // whole file, so on an oversized one this is the difference
                // between an instant explanation and a long stall ending in a
                // failure the webview never hears about (it would sit on the
                // loading overlay forever, since 'init' is what starts its
                // progress reporting).
                const stat = await statOrNull();
                if (!stat) {
                    logger.appendLine('>>> Layout file is not readable (deleted or moved?)');
                    post({
                        type: 'loadError',
                        message: `${path.basename(document.uri.fsPath)} is no longer on disk.`
                    });
                    return false;
                }
                logger.appendLine('    file size: ' + formatBytes(stat.size));
                if (stat.size > MAX_LAYOUT_BYTES) {
                    const message =
                        `This layout is ${formatBytes(stat.size)}, past the ${formatBytes(MAX_LAYOUT_BYTES)} ` +
                        `limit GDS Lens can load.\n\nThe viewer parses layouts in a 32-bit WebAssembly module, ` +
                        `which has to hold the file and the geometry built from it in 4 GB of memory.`;
                    logger.appendLine('>>> Refusing oversized layout: ' + formatBytes(stat.size));
                    post({ type: 'loadError', message: message });
                    vscode.window.showErrorMessage(`GDS Lens: layout is too large to open (${formatBytes(stat.size)}).`);
                    return false;
                }

                let fileData;
                try {
                    fileData = await vscode.workspace.fs.readFile(document.uri);
                } catch (err) {
                    // Out of memory on a large-but-allowed file, a disk error,
                    // a vanished network mount -- the viewer is already showing
                    // its progress bar, so it needs telling either way.
                    logger.appendLine('>>> Failed to read layout: ' + err.stack);
                    post({
                        type: 'loadError',
                        message: `Could not read ${path.basename(document.uri.fsPath)}: ${err.message}`
                    });
                    vscode.window.showErrorMessage('GDS Lens: could not read layout file: ' + err.message);
                    return false;
                }

                // A gzipped layout (.gds.gz and friends) is expanded here, so
                // everything past this point -- the webview, the parse Worker,
                // the wasm module's own GDSII/OASIS header sniffing -- sees
                // exactly the bytes an uncompressed file would have produced.
                // Detected by gzip's magic number rather than by the name, so a
                // compressed layout called ".gds" works too.
                const decoded = decodeLayoutBytes(fileData, MAX_LAYOUT_BYTES);
                if (!decoded.ok) {
                    const name = path.basename(document.uri.fsPath);
                    let message;
                    if (decoded.reason === 'too-large') {
                        // storedSize is gzip's own claim about the expanded size
                        // and can be wrong (see gzipStoredSize) -- hence "about",
                        // and hence it only ever softens the wording rather than
                        // being what refused the file.
                        const expands = decoded.storedSize
                            ? `expands to about ${formatBytes(decoded.storedSize)}`
                            : 'expands past';
                        message =
                            `${name} ${expands}, past the ${formatBytes(MAX_LAYOUT_BYTES)} limit ` +
                            `GDS Lens can load.\n\nThe viewer parses layouts in a 32-bit WebAssembly ` +
                            `module, which has to hold the file and the geometry built from it in ` +
                            `4 GB of memory.`;
                    } else {
                        message =
                            `Could not decompress ${name}.\n\nIt starts with a gzip header, but the ` +
                            `compressed data can't be read -- the file may be truncated, or still ` +
                            `being written.\n\n(${decoded.detail})`;
                    }
                    logger.appendLine('>>> Gzip decode failed (' + decoded.reason + '): ' + decoded.detail);
                    post({ type: 'loadError', message: message });
                    vscode.window.showErrorMessage(`GDS Lens: could not open ${name}.`);
                    return false;
                }
                if (decoded.gzipped) {
                    logger.appendLine('    gunzipped: ' + formatBytes(fileData.byteLength) + ' -> ' +
                                      formatBytes(decoded.bytes.byteLength));
                }
                fileData = decoded.bytes;

                // Stamped from the pre-read stat: if the file changes again
                // between the stat and the read, the watcher fires once more
                // and this compares unequal, so the newer bytes still land.
                loadedStamp = { mtime: stat.mtime, size: stat.size };

                logger.appendLine(
                    (isReload ? '>>> Re-reading changed layout' : '>>> Streaming raw layout bytes') +
                    ' down into the wasm webview context...');
                logger.appendLine('    fileData bytes: ' + fileData.byteLength);
                // fileData crosses as a raw ArrayBuffer (as it always has) --
                // only the worker bundle text needed the HTML-embedding
                // workaround above; binary ArrayBuffers here haven't shown the
                // same RPC-channel issue large strings did.
                post({
                    type: 'init',
                    fileData: Uint8Array.from(fileData).buffer,
                    reload: !!isReload
                });
                return true;
            };

            // Polls until size and mtime stop moving (see SETTLE_MS), so a
            // reload reads a finished file rather than a partial one.
            const waitForQuiet = async () => {
                const deadline = Date.now() + SETTLE_TIMEOUT_MS;
                let previous = await statOrNull();
                while (Date.now() < deadline && !disposed) {
                    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
                    const current = await statOrNull();
                    if (current && previous &&
                        current.size === previous.size && current.mtime === previous.mtime) {
                        return current;
                    }
                    previous = current;
                }
                return previous;
            };

            // Serialized: watcher events arrive in bursts, and running this
            // concurrently would stack up reads of the same file. A change
            // seen while one pass is in flight re-runs the loop instead.
            let checking = false;
            let changedWhileChecking = false;
            const onDiskChange = async () => {
                if (checking) {
                    changedWhileChecking = true;
                    return;
                }
                checking = true;
                try {
                    do {
                        changedWhileChecking = false;
                        const stat = await waitForQuiet();
                        if (disposed) return;
                        // Gone for now -- a temp-file-plus-rename writer will
                        // fire onDidCreate once the new file lands, so this
                        // isn't the moment to complain about it.
                        if (!stat) continue;
                        if (loadedStamp &&
                            stat.mtime === loadedStamp.mtime && stat.size === loadedStamp.size) {
                            continue;
                        }
                        if (autoReloadEnabled()) {
                            logger.appendLine('>>> Layout changed on disk, auto-reloading');
                            await sendLayout(true);
                        } else {
                            logger.appendLine('>>> Layout changed on disk, offering reload');
                            post({ type: 'fileChanged' });
                        }
                    } while (changedWhileChecking && !disposed);
                } catch (err) {
                    logger.appendLine('>>> Reload check failed: ' + err.stack);
                } finally {
                    checking = false;
                }
            };

            // A RelativePattern rooted at the file's own directory (rather
            // than a workspace-relative glob) is what makes this work for
            // layouts opened from outside the workspace, which is the common
            // case -- a GDS usually lives in a build/output directory, not
            // the repo. The pattern is a non-recursive '*' with the filename
            // matched in the handler instead of baked into the glob: layout
            // names do contain glob metacharacters ("chip[v2].gds"), and
            // there's no way to escape those in a VS Code glob.
            const watchedPath = document.uri.fsPath;
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(path.dirname(watchedPath)), '*')
            );
            const onWatchEvent = (uri) => {
                if (uri.fsPath === watchedPath) onDiskChange();
            };
            disposables.push(
                watcher,
                watcher.onDidChange(onWatchEvent),
                // Rename-over-target writers delete and re-create rather than
                // modifying in place, so a create is a content change too.
                watcher.onDidCreate(onWatchEvent)
            );

            webviewPanel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'reloadFile') {
                    await sendLayout(true);
                    return;
                }
                if (message.command === 'setAutoReload') {
                    await setAutoReload(!!message.value);
                    return;
                }
                if (message.command === 'loadLypFile') {
                    const options = {
                        canSelectMany: false,
                        openLabel: 'Load Layer Properties',
                        filters: { 'KLayout Properties': ['lyp'] }
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const fsPath = fileUri[0].fsPath;
                        // Remember for next time (this and future viewers).
                        await this.context.globalState.update(LAST_LYP_PATH_KEY, fsPath);
                        this.postLyp(webviewPanel, fsPath);
                    }
                } else if (message.command === 'unloadLypFile') {
                    // Forget the remembered .lyp so it isn't re-applied next time.
                    await this.context.globalState.update(LAST_LYP_PATH_KEY, undefined);
                } else if (message.command === 'loadMarkerFile') {
                    const options = {
                        canSelectMany: false,
                        openLabel: 'Load Marker Database',
                        // Content-sniffed in the webview, so the filter is loose:
                        // Calibre ASCII results get named all sorts of things.
                        filters: {
                            'Marker databases': ['lyrdb', 'rdb', 'results', 'db', 'ascii', 'txt'],
                            'All files': ['*']
                        }
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const markerPath = fileUri[0].fsPath;
                        // Remember per GDS file (see MARKER_PATHS_KEY).
                        await this.updateMarkerMap((map) => { map[document.uri.fsPath] = markerPath; });
                        this.postMarkers(webviewPanel, markerPath);
                    }
                } else if (message.command === 'unloadMarkerFile') {
                    await this.updateMarkerMap((map) => { delete map[document.uri.fsPath]; });
                }
            });

            logger.appendLine('    cspSource: ' + webviewPanel.webview.cspSource);
            if (!(await sendLayout(false))) return;

            // Re-apply the most recently loaded .lyp, if any. Safe to post now:
            // viewer.js's 'lypLoaded' handler waits on the wasm module, and the
            // parsed styling persists until the GDS geometry finishes loading
            // and picks it up. If the file has since moved/been deleted, drop
            // the stale remembered path so it stops trying.
            const savedLypPath = this.context.globalState.get(LAST_LYP_PATH_KEY);
            if (savedLypPath && !this.postLyp(webviewPanel, savedLypPath)) {
                await this.context.globalState.update(LAST_LYP_PATH_KEY, undefined);
            }

            // Re-apply this GDS file's remembered marker database, if any
            // (per-GDS, unlike the .lyp above). Same ordering guarantee: the
            // webview parses and holds the markers until geometry arrives.
            const markerMap = this.context.workspaceState.get(MARKER_PATHS_KEY) || {};
            const savedMarkerPath = markerMap[document.uri.fsPath];
            if (savedMarkerPath && !this.postMarkers(webviewPanel, savedMarkerPath)) {
                await this.updateMarkerMap((map) => { delete map[document.uri.fsPath]; });
            }
        } catch (err) {
            logger.appendLine('[FATAL CRASH ERROR] ' + err.stack);
            // Best-effort: if the webview got far enough to render, it's
            // sitting on the loading overlay waiting for bytes that are never
            // coming, so give it something to show.
            try {
                webviewPanel.webview.postMessage({ type: 'loadError', message: err.message });
            } catch {
                // Panel already disposed -- the message box below is enough.
            }
            vscode.window.showErrorMessage("GDSII Viewer Error: " + err.message);
        }
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
