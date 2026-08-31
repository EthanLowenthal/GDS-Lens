// The demo page's own wiring. Four jobs: load a layout on arrival, colour it,
// offer the sample DRC results, and let the visitor open a file of their own.
//
// Everything else the page can do -- pan, zoom, the layer panel, the cell tree,
// find-by-name, the ruler, drag-and-drop, saved views in localStorage -- is the
// element and its default browser host. None of it is here.

const viewer = document.getElementById("viewer");
const status = document.getElementById("status");

const LAYOUT = "demo-layout.gds.gz";
const LAYERS = "demo-layers.lyp";
const MARKERS = "demo-markers.drc";

// Which published version the page is serving, written by the Pages workflow
// (see pages.yml). Absent when the site is served from a working tree, which
// is worth saying rather than papering over: a local build is not what a
// visitor to the deployed page is looking at.
fetch("build.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((build) => {
        const el = document.getElementById("build");
        if (!el) return;
        el.textContent = build
            ? `gds-lens ${build.version}`
            : "gds-lens, local build";
        if (build?.built) el.title = `deployed ${build.built}`;
    })
    .catch(() => {});

const say = (html) => { status.innerHTML = html; };

const DROP_HINT =
    "or drop a <code>.gds</code> or <code>.oas</code> onto the viewer.";

// The default host already fetches `?src=` on connect. Loading the demo on top
// of that would race it and one of the two would win at random, so a page asked
// for a specific layout is left alone.
const asked = new URLSearchParams(location.search).get("src");

const text = (url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
});

async function start() {
    await viewer.ready;
    if (asked) {
        say(`Loading <code>${escape_(asked)}</code>...`);
        return;
    }

    // The layermap goes on before the layout rather than after. Both orders end
    // up correct, but this one does not show the layout in fallback colours
    // first and then recolour it a beat later.
    try {
        await viewer.setLyp(LAYERS, await text(LAYERS));
    } catch (err) {
        // Worth continuing without: the layout is the point, the colours are
        // an improvement on it.
        console.warn(`could not apply ${LAYERS}:`, err);
    }

    say("Fetching a 20 MB layout (8 MB gzipped)...");
    await viewer.load(LAYOUT);

    // Markers after the layout, not before: they are read against the loaded
    // design, and a marker database applied to nothing has nowhere to land.
    try {
        await viewer.setMarkers(MARKERS, await text(MARKERS));
    } catch (err) {
        // The layout is the page; DRC results are an extra on top of it.
        console.warn(`could not apply ${MARKERS}:`, err);
    }
    say(DROP_HINT);
}

start().catch((err) => say(`The viewer failed to start: ${escape_(String(err))}`));

// ---- Opening a file of your own -------------------------------------------

const input = document.getElementById("file");
document.getElementById("open").addEventListener("click", () => input.click());

input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    say(`Reading <code>${escape_(file.name)}</code>...`);
    file.arrayBuffer().then(
        (bytes) => viewer.load(bytes).then(
            () => say(`Showing <code>${escape_(file.name)}</code>, read in this tab.`),
            (err) => say(`Could not open ${escape_(file.name)}: ${escape_(String(err))}`)
        ),
        (err) => say(`Could not read ${escape_(file.name)}: ${escape_(String(err))}`)
    );
    // So that picking the same file twice in a row still fires a change event.
    input.value = "";
});

// A dropped or picked filename is attacker-controlled in the only sense that
// matters here: it is not ours, and it goes into innerHTML.
function escape_(value) {
    const node = document.createElement("span");
    node.textContent = value;
    return node.innerHTML;
}
