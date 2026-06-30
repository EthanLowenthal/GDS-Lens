// Thin bootstrap: instantiate the wasm module and relay postMessage payloads
// from the extension host into it. JS never touches GDS/GL data -- that all
// lives in wasm/renderer.cpp (GL context + shaders + camera + input) and
// wasm/bindings.cpp (gdstk parsing), which attach directly to #glCanvas and
// the DOM themselves. The control surface (load .lyp button + per-layer
// visibility toggles) is built with dat.gui (vendor/dat.gui.min.js).

const vscode = acquireVsCodeApi();

const gui = new dat.GUI({ width: 260 });
const actions = {
    loadLypFile: () => vscode.postMessage({ command: "loadLypFile" })
};
gui.add(actions, "loadLypFile").name("Load KLayout .lyp File");

let layersFolder = null;

// Rebuilds the layer folder from Module.getLayers() -- {layer, name,
// fillColor, frameColor, visible}[], all plain scalars/strings (no
// per-polygon geometry crosses into JS). Called after every
// loadAndRenderGds()/loadLypText() call since either can change the layer
// set, colors, or visibility.
function renderLayerList(layers) {
    if (layersFolder) {
        gui.removeFolder(layersFolder);
    }
    layersFolder = gui.addFolder("Layers");
    layersFolder.open();

    for (const layer of layers) {
        const label = layer.name ? `${layer.layer} – ${layer.name}` : `Layer ${layer.layer}`;
        const state = { visible: layer.visible };
        const controller = layersFolder.add(state, "visible")
            .name(label)
            .onChange((visible) => {
                modulePromise.then((Module) => Module.setLayerVisible(layer.layer, visible));
            });
        // dat.gui has no built-in color swatch for booleans -- tint the row's
        // left border with the layer's frame color as a visual cue.
        controller.__li.style.borderLeft = `4px solid ${layer.frameColor}`;
        controller.__li.title = label;
    }
}

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
            renderLayerList(Module.getLayers());
        } else if (message.type === "lypLoaded") {
            Module.loadLypText(message.text);
            renderLayerList(Module.getLayers());
        }
    });
});
