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
  it('a scene with nothing sized says so', () => assert.throws(() => sceneBounds({ asset: { version: '2.0' }, nodes: [{}] }), /nothing with a size/));
});
