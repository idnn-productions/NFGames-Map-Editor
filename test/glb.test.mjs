// A model's bounds from its GLB header alone: what the editor sizes a model kind's footprint from.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glbJson, sceneBounds } from '../src/glb.mjs';
import { boxScene, makeGlb } from './helpers.mjs';

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const bounds = (items, extra) => sceneBounds(boxScene(items, extra));

describe('a model\'s bounds from its GLB header', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-glb-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the JSON chunk of a real GLB, and refuses other files', () => {
    writeFileSync(join(dir, 'tri.glb'), makeGlb()); writeFileSync(join(dir, 'bad.glb'), 'not a glb at all, really');
    assert.equal(glbJson(join(dir, 'tri.glb')).meshes[0].name, 'tri');
    assert.deepEqual(sceneBounds(glbJson(join(dir, 'tri.glb'))), { min: [0, 0, 0], max: [1, 1, 0] });
    assert.throws(() => glbJson(join(dir, 'bad.glb')), /not a GLB/);
  });
  it('moves, scales and turns with the nodes', () => {
    const b = bounds([{ min: [-1, 0, -2], max: [1, 3, 2], node: { translation: [10, 0, 5], scale: [2, 1, 1] } }]);
    assert.ok(near(b.min, [8, 0, 3]) && near(b.max, [12, 3, 7]), JSON.stringify(b));
    const s = Math.SQRT1_2, r = bounds([{ min: [0, 0, 0], max: [4, 1, 1], node: { rotation: [0, s, 0, s] } }]); // 90° about Y: +X → -Z
    assert.ok(near(r.min, [0, 0, -4]) && near(r.max, [1, 1, 0]), JSON.stringify(r));
    const m = bounds([{ min: [0, 0, 0], max: [1, 1, 1], node: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] } }]);
    assert.ok(near(m.min, [5, 6, 7]) && near(m.max, [6, 7, 8]));
  });
  it('follows children, and combines every mesh', () => {
    const gltf = boxScene([{ min: [0, 0, 0], max: [1, 1, 1] }, { min: [0, 0, 0], max: [1, 1, 1], node: { translation: [0, 0, 3] } }]);
    gltf.scenes[0].nodes = [0]; gltf.nodes[0].children = [1]; gltf.nodes[0].translation = [2, 0, 0];
    const b = sceneBounds(gltf);
    assert.ok(near(b.min, [2, 0, 0]) && near(b.max, [3, 1, 4]), JSON.stringify(b));
  });
  it('reads quantized positions as the GPU does (KHR_mesh_quantization)', () => {
    // normalized integers: min and max are stored in the integers' own units; the GPU divides by the type's largest
    const apple = boxScene([{ min: [-32767, -28535, -32143], max: [32767, 28535, 32143], node: { scale: [0.0487, 0.0487, 0.0487] } }]); // as Meshopt writes a 10 cm apple
    Object.assign(apple.accessors[0], { componentType: 5122, normalized: true });
    const a = sceneBounds(apple);
    assert.ok(near(a.min, [-0.0487, -0.0487 * 28535 / 32767, -0.0487 * 32143 / 32767]) && near(a.max, [0.0487, 0.0487 * 28535 / 32767, 0.0487 * 32143 / 32767]), JSON.stringify(a));
    const u8 = boxScene([{ min: [0, 0, 0], max: [255, 51, 255] }]); Object.assign(u8.accessors[0], { componentType: 5121, normalized: true });
    assert.ok(near(sceneBounds(u8).max, [1, 0.2, 1]));
    const s8 = boxScene([{ min: [-128, -127, 0], max: [127, 127, 127] }]); Object.assign(s8.accessors[0], { componentType: 5120, normalized: true });
    assert.ok(near(sceneBounds(s8).min, [-1, -1, 0]), 'a signed type\'s smallest value is -1, not below');
    const u16 = boxScene([{ min: [0, 0, 0], max: [65535, 65535, 13107] }]); Object.assign(u16.accessors[0], { componentType: 5123, normalized: true });
    assert.ok(near(sceneBounds(u16).max, [1, 1, 0.2]));
    // integers that are not normalized are positions as they are
    const raw = boxScene([{ min: [0, 0, 0], max: [3, 2, 1] }]); Object.assign(raw.accessors[0], { componentType: 5122 });
    assert.ok(near(sceneBounds(raw).max, [3, 2, 1]));
  });
  it('a scene with nothing sized says so', () => assert.throws(() => sceneBounds({ asset: { version: '2.0' }, nodes: [{}] }), /nothing with a size/));
});
