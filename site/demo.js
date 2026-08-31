// The demo page's own wiring. Three jobs: load something on arrival, let the
// visitor open a file of their own, and say which of the two they are looking
// at.
//
// Everything else the page can do -- pan, zoom, the layer panel, the cell
// tree, drag-and-drop, saved views in localStorage -- is the element and its
// default browser host. None of it is here.

const viewer = document.getElementById("viewer");
const status = document.getElementById("status");
const button = document.getElementById("open");
const input = document.getElementById("file");

const DEMO = "demo-layout.gds";

const say = (html) => { status.innerHTML = html; };

// The default host already fetches `?src=` on connect. Loading the demo on top
// of that would race it and one of the two would win at random, so a page
// asked for a specific layout is left alone.
const asked = new URLSearchParams(location.search).get("src");

viewer.ready
    .then(() => {
        if (asked) return say(`Loading <code>${escape_(asked)}</code>...`);
        return viewer.load(DEMO).then(
            () => say(
                "Showing a synthetic demo layout " +
                `(<a href="${DEMO}" download>download</a>). Drop a <code>.gds</code> ` +
                "or <code>.oas</code> onto the viewer to open your own."
            ),
            (err) => say(`Could not load the demo layout: ${escape_(String(err))}`)
        );
    })
    .catch((err) => say(`The viewer failed to start: ${escape_(String(err))}`));

button.addEventListener("click", () => input.click());

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
function escape_(text) {
    const node = document.createElement("span");
    node.textContent = text;
    return node.innerHTML;
}
