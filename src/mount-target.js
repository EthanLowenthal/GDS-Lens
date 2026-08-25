// The element the engine mounts into, handed over between <gds-lens>'s
// connectedCallback and viewer.js.
//
// It exists because viewer.js does its work as a module body rather than in a
// mount function: 172 top-level statements spread through the file, holding
// the renderer's state in module scope. Wrapping all of that in a function
// would mean indenting the entire file for no behavioural gain, so the element
// defers it with a dynamic import instead and leaves the target here for it to
// pick up. Passing the element rather than having viewer.js query for it also
// keeps this correct when the <gds-lens> is itself inside someone else's
// shadow root, where document.querySelector would not find it.

let target = null;

export function setMountTarget(element) {
    target = element;
}

export function takeMountTarget() {
    const element = target;
    target = null;
    return element;
}
