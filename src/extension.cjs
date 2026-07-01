const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const logger = vscode.window.createOutputChannel("GDSII Debugger");

function activate(context) {
    logger.show(true);
    logger.appendLine(">>> GDSII Extension Core Spinning Up (wasm parsing + rendering)...");

    const provider = new GdsEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('gdsii-view.editor', provider)
    );
}

class GdsEditorProvider {
    constructor(context) {
        this.context = context;
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
            const wasmJsPath = path.join(this.context.extensionPath, 'src', 'wasm', 'build', 'gdstk_wasm.js');
            const datGuiJsPath = path.join(this.context.extensionPath, 'src', 'vendor', 'dat.gui.min.js');
            const workerJsPath = path.join(this.context.extensionPath, 'src', 'wasm-worker.js');

            // 3. Convert the native viewer.js/wasm file paths into authenticated Webview URIs
            const jsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(jsPath));
            const wasmJsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(wasmJsPath));
            const datGuiJsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(datGuiJsPath));

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
            const workerBundleBase64 = Buffer.from(
                fs.readFileSync(wasmJsPath, 'utf8') + '\n' + fs.readFileSync(workerJsPath, 'utf8'),
                'utf8'
            ).toString('base64');

            // 4. Load the base HTML text and dynamically swap out the standard script references
            let htmlContent = fs.readFileSync(htmlPath, 'utf8');
            htmlContent = htmlContent.replace('src="wasm/build/gdstk_wasm.js"', 'src="' + wasmJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="vendor/dat.gui.min.js"', 'src="' + datGuiJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="viewer.js"', 'src="' + jsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('{{cspSource}}', webviewPanel.webview.cspSource);
            htmlContent = htmlContent.replace('{{workerBundleBase64}}', workerBundleBase64);

            webviewPanel.webview.html = htmlContent;

            logger.appendLine('\n>>> Intercepted layout open call for file: ' + document.uri.fsPath);
            const fileData = await vscode.workspace.fs.readFile(document.uri);

            webviewPanel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'loadLypFile') {
                    const options = {
                        canSelectMany: false,
                        openLabel: 'Load Layer Properties',
                        filters: { 'KLayout Properties': ['lyp'] }
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const lypRawText = fs.readFileSync(fileUri[0].fsPath, 'utf8');
                        webviewPanel.webview.postMessage({
                            type: 'lypLoaded',
                            text: lypRawText
                        });
                    }
                }
            });

            logger.appendLine('>>> Streaming raw GDS bytes down into the wasm webview context...');
            logger.appendLine('    fileData bytes: ' + fileData.byteLength);
            logger.appendLine('    cspSource: ' + webviewPanel.webview.cspSource);
            // fileData crosses as a raw ArrayBuffer (as it always has) --
            // only the worker bundle text needed the HTML-embedding
            // workaround above; binary ArrayBuffers here haven't shown the
            // same RPC-channel issue large strings did.
            webviewPanel.webview.postMessage({
                type: 'init',
                fileData: Uint8Array.from(fileData).buffer
            });
        } catch (err) {
            logger.appendLine('[FATAL CRASH ERROR] ' + err.stack);
            vscode.window.showErrorMessage("GDSII Viewer Error: " + err.message);
        }
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
