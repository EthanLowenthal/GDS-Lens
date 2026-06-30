// Thin bootstrap: instantiate the wasm module and relay postMessage payloads
// from the extension host into it. JS never touches GDS/GL data -- that all
// lives in wasm/renderer.cpp (GL context + shaders + camera + input) and
// wasm/bindings.cpp (gdstk parsing), which attach directly to #glCanvas and
// the DOM themselves.

const vscode = acquireVsCodeApi();
const lypBtn = document.getElementById("lypBtn");

lypBtn.addEventListener("click", () => {
    vscode.postMessage({ command: "loadLypFile" });
});

// Registered synchronously (not inside the .then() below) so an 'init'
// message that arrives before wasm instantiation finishes isn't dropped --
// window message events aren't queued for late listeners.
const modulePromise = createGdstkModule();

window.addEventListener("message", (event) => {
    const message = event.data;
    modulePromise.then((Module) => {
        if (message.type === "init") {
            Module.FS.writeFile("/input.gds", new Uint8Array(message.fileData));
            Module.loadAndRenderGds("/input.gds");
            Module.FS.unlink("/input.gds");
        } else if (message.type === "lypLoaded") {
            Module.loadLypText(message.text);
        }
    });
});
