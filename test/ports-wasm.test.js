// Headless test for the kfactory port metadata reader (kfactory_ports.cpp) and
// the world-space expansion in renderer.cpp: parses a gdsfactory-written GDS
// in plain Node and checks the ports it declared come back, per cell in the
// hierarchy and expanded through every placement for the overlay, then pushes
// them into the renderer's CPU-side state via setPorts. Skipped when the wasm
// bundle hasn't been built.
//
// The fixture was written by gdsfactory 9.44 / kfactory 2.5 (meta_format v3):
// a top cell `ports_top` placing an mzi and a bend_euler rotated 45° and moved
// to (300, 100), with the two components' ports re-exported under `mzi_` and
// `bend_` prefixes. Its metadata strings are the ones quoted in the comments.
import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { loadModule, skip } from "./wasm-build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function parseFixture(Module, name) {
    const bytes = fs.readFileSync(path.join(__dirname, "fixtures", name));
    Module.FS.writeFile("/input.layout", bytes);
    const result = Module.parseGdsToLayers("/input.layout");
    Module.FS.unlink("/input.layout");
    assert.ok(result.ok, result.error);
    return result;
}

const close = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test("kfactory ports: per-cell list in the hierarchy", { skip }, async () => {
    const Module = await loadModule();
    const result = await parseFixture(Module, "kfactory_ports.gds");
    const h = result.hierarchy;

    assert.strictEqual(h.kfactory, true);
    // 4 on the top cell + the components' own (mzi 2, bend 2, mmi1x2 3,
    // three straights 2 each) = 17 declared ports across 7 annotated cells.
    assert.strictEqual(h.portCount, 17);

    // The context cell is not a root, so the design has one top cell.
    assert.strictEqual(h.roots.length, 1);
    const top = h.cells[h.roots[0]];
    assert.strictEqual(top.name, "ports_top");
    assert.ok(Array.isArray(top.ports));
    assert.deepStrictEqual(top.ports.map((p) => p.name), ["mzi_o1", "mzi_o2", "bend_o1", "bend_o2"]);

    // META('kfactory:ports:0')={...,'name'=>'mzi_o1','trans'=>[trans:r180 -10000,0]}
    // -- dbu positions (1 nm) into microns, r180 facing -x.
    const o1 = top.ports[0];
    assert.ok(close(o1.x, -10) && close(o1.y, 0), `mzi_o1 at (${o1.x}, ${o1.y})`);
    assert.strictEqual(o1.angle, 180);
    assert.strictEqual(o1.type, "optical");
    // 'cross_section'=>'78687732_500' -> META('kfactory:cross_section:78687732_500')
    // ={'layer_enclosure'=>'78687732','width'=>#l500}, enclosure main_layer WG (1/0).
    assert.ok(close(o1.width, 0.5), `width ${o1.width}`);
    assert.strictEqual(o1.layer, 1);
    assert.strictEqual(o1.datatype, 0);

    // 'trans'=>[trans:r0 81100,0]
    assert.ok(close(top.ports[1].x, 81.1) && top.ports[1].angle === 0);

    // The rotated bend's ports were written as a complex transform in microns:
    // 'dcplx_trans'=>[dcplxtrans:r225 *1 141.421,282.843]
    const b1 = top.ports[2];
    assert.ok(close(b1.x, 141.421) && close(b1.y, 282.843), `bend_o1 at (${b1.x}, ${b1.y})`);
    assert.strictEqual(b1.angle, 225);
    assert.strictEqual(top.ports[3].angle, 135);

    // A cell without metadata carries no `ports` key at all.
    const plain = h.cells.find((c) => c.name === "$$$CONTEXT_INFO$$$");
    assert.ok(plain && plain.ports === undefined);
});

test("kfactory ports: expanded to world space through placements", { skip }, async () => {
    const Module = await loadModule();
    const result = await parseFixture(Module, "kfactory_ports.gds");
    const ports = result.ports;

    // 17 declared, but the straights and the mmi are each placed several times
    // inside the mzi, so more instances than declarations; and not capped.
    assert.ok(ports.count > 17, `count ${ports.count}`);
    assert.strictEqual(ports.capped, false);
    assert.strictEqual(ports.xydw.length, ports.count * 5);
    assert.strictEqual(ports.type.length, ports.count);
    assert.strictEqual(ports.nameOffsets.length, ports.count + 1);
    assert.deepStrictEqual(Array.from(ports.typeNames), ["optical"]);

    // Root ports come first, in declaration order, at their own coordinates.
    const [x, y, dx, dy, w] = Array.from(ports.xydw.subarray(0, 5));
    assert.ok(close(x, -10) && close(y, 0), `first world port at (${x}, ${y})`);
    assert.ok(close(dx, -1) && close(dy, 0), `facing (${dx}, ${dy})`);
    assert.ok(close(w, 0.5));
    const decoder = new TextDecoder();
    const firstName = decoder.decode(ports.nameChars.subarray(ports.nameOffsets[0], ports.nameOffsets[1]));
    assert.strictEqual(firstName, "mzi_o1");

    // The bend is placed rotated 45° at (300, 100); its own o1 port sits at its
    // origin facing 180°, so the placed copy faces 225° from (300, 100) -- the
    // same place the top cell re-exported it (bend_o1, checked above).
    const names = [];
    for (let i = 0; i < ports.count; i++) {
        names.push(decoder.decode(ports.nameChars.subarray(ports.nameOffsets[i], ports.nameOffsets[i + 1])));
    }
    const bendIdx = names.indexOf("o1", 4);  // first nested o1 after the 4 root ports
    assert.ok(bendIdx > 0);
    // Every nested o1 at (300,100) must face 225°; find the one that is there.
    let found = false;
    for (let i = 4; i < ports.count; i++) {
        const px = ports.xydw[i * 5], py = ports.xydw[i * 5 + 1];
        if (close(px, 141.421, 0.01) && close(py, 282.843, 0.01)) {
            const ddx = ports.xydw[i * 5 + 2], ddy = ports.xydw[i * 5 + 3];
            assert.ok(close(ddx, Math.cos(Math.PI * 1.25), 1e-3) && close(ddy, Math.sin(Math.PI * 1.25), 1e-3),
                      `nested bend port faces (${ddx}, ${ddy})`);
            found = true;
        }
    }
    assert.ok(found, "the bend's own o1 port was expanded to where the top cell placed it");

    // Into the renderer's state (CPU side only -- no GL here).
    Module.setPorts(ports);
    const stats = Module.getPortStats();
    assert.strictEqual(stats.count, ports.count);
    assert.strictEqual(stats.capped, false);
    assert.strictEqual(stats.visible, true);
    assert.strictEqual(stats.types, 1);
    assert.strictEqual(stats.sample[0].name, "mzi_o1");
    assert.strictEqual(stats.sample[0].type, "optical");
    assert.ok(close(stats.sample[0].x, -10));

    Module.setShowPorts(false);
    assert.strictEqual(Module.getPortStats().visible, false);
    Module.setShowPorts(true);

    // An empty payload (a file with no metadata) clears them.
    Module.setPorts({xydw: new Float32Array(0), type: new Uint32Array(0), nameChars: new Uint8Array(0),
                     nameOffsets: new Uint32Array([0]), typeNames: [], capped: false, count: 0});
    assert.strictEqual(Module.getPortStats().count, 0);
});

test("kfactory ports: a plain layout has none", { skip }, async () => {
    const Module = await loadModule();
    const result = await parseFixture(Module, "sample_layout.gds");
    assert.strictEqual(result.hierarchy.kfactory, false);
    assert.strictEqual(result.hierarchy.portCount, 0);
    assert.strictEqual(result.ports.count, 0);
    for (const cell of result.hierarchy.cells) assert.strictEqual(cell.ports, undefined);
});
