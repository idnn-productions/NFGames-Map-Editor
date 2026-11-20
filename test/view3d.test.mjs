// The 3D view's maths (src/view3d.mjs): the camera, picking, axis drags, and the landing rule it shares with the fit check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { view3d } from '../src/view3d.mjs';
import { loadProject } from '../src/project.mjs';
import { checkFit } from '../src/check.mjs';
import { page } from '../src/server.mjs';
import { SAMPLE, samplePlan } from './helpers.mjs';

const V = view3d();
const project = await loadProject({ root: SAMPLE });
const kinds = await project.kinds('plaza', samplePlan());
const near = (a, b, eps, what = '') => { for (let i = 0; i < b.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= eps, `${what} ${a} is not ${b}`); };
const W = 1600, H = 900, cam = { target: [0, 0, 0], yaw: 35, pitch: 40, dist: 60, fov: 45 };
const C = V.camera(cam, W / H);
const rayThrough = (o, p) => { const d = p.map((v, i) => v - o[i]), n = Math.hypot(...d); return { o, d: d.map((v) => v / n) }; };

describe('the 3D camera', () => {
  it('project then ray round-trips', () => {
    const p = V.project(C, [6, 3, -10], W, H);
    assert.ok(p && p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H, `off screen: ${p}`);
    near(V.rayPlaneY(V.ray(C, p[0], p[1], W, H), 3), [6, 3, -10], 1e-3);
  });
  it('the centre of the view is the target', () => { near(V.project(C, cam.target, W, H), [W / 2, H / 2], 0.5); });
  it('a point behind the eye projects to null', () => {
    const back = C.eye.map((v, i) => v + (C.eye[i] - cam.target[i]));
    assert.equal(V.project(C, back, W, H), null);
  });
  it('a ray parallel to the ground meets no height', () => { assert.equal(V.rayPlaneY({ o: [0, 2, 0], d: [1, 0, 0] }, 0), null); });
});

describe('picking boxes', () => {
  it('rayBox picks the nearer of two boxes', () => {
    const r = { o: [0, 20, 0], d: [0, -1, 0] }, high = { c: [0, 5, 0], half: [1, 1, 1], rot: 0 }, low = { c: [0, 1, 0], half: [1, 1, 1], rot: 0 };
    const a = V.rayBox(r, high), b = V.rayBox(r, low);
    assert.ok(a !== null && b !== null && a < b, `${a} ${b}`);
    assert.equal(V.rayBox({ o: [5, 20, 0], d: [0, -1, 0] }, low), null);
  });
  it('rayBox respects rot', () => {
    const box = { c: [0, 0.5, 0], half: [4, 1, 0.5], rot: 90 };
    assert.notEqual(V.rayBox({ o: [0, 10, 3], d: [0, -1, 0] }, box), null);
    assert.equal(V.rayBox({ o: [3, 10, 0], d: [0, -1, 0] }, box), null);
  });
});

describe('dragging along an axis', () => {
  it('axisDrag moves only along its axis', () => {
    const v = V.axisDrag(rayThrough([5, 12, 10], [5, 2, 0]), [0, 2, 0], 0);
    assert.ok(Math.abs(v - 5) < 1e-3, `${v}`);
  });
  it('gives nothing for a ray along the axis', () => { assert.equal(V.axisDrag({ o: [-10, 2, 0], d: [1, 0, 0] }, [0, 2, 0], 0), null); });
  it('works on the Y axis', () => {
    const v = V.axisDrag(rayThrough([10, 3, 10], [0, 3, 0]), [0, 0, 0], 1);
    assert.ok(Math.abs(v - 3) < 1e-3, `${v}`);
  });
});

describe('a piece as boxes', () => {
  it('a whole kind is one box', () => {
    const b = V.pieceBoxes({ at: [2, 2], rot: 0, y: 0, size: [1, 1, 1], boxes: [[0, 0, 1, 1]], s: 1, st: 1, hs: 1 });
    assert.equal(b.length, 1); near(b[0].c, [2, 0.5, 2], 1e-9); near(b[0].half, [0.5, 0.5, 0.5], 1e-9);
  });
  it('the open hall is three walls of full height, lifted by y', () => {
    const k = kinds['kit:hall'], b = V.pieceBoxes({ at: [0, 0], rot: 0, y: 3.5, size: k.size, boxes: k.boxes, s: 1, st: 1, hs: 1 });
    assert.equal(b.length, 3);
    for (const x of b) { assert.equal(x.half[1], 2.5); assert.equal(x.c[1], 6); }
  });
  it('turns its parts with the piece', () => {
    const b = V.pieceBoxes({ at: [0, 0], rot: 90, y: 0, size: [10, 8, 5], boxes: [[0, -3.7, 10, 0.6]], s: 1, st: 1, hs: 1 });
    near([b[0].c[0], b[0].c[2]], [-3.7, 0], 1e-9); assert.equal(b[0].rot, 90);
  });
  it('a mark with no size gives no NaN', () => {
    const b = V.pieceBoxes({ at: [0, 0], rot: undefined, y: undefined, size: [2, 2, 2], boxes: [[0, 0, 2, 2]], s: 1, st: 1, hs: 1 });
    assert.ok(!JSON.stringify(b).includes('null'));
  });
});

describe('what a piece lands on', () => {
  it('the tank stands on its house', () => { assert.deepEqual(V.hostTop(samplePlan(), kinds, [-8, 10], new Set(['tank'])), { id: 'h1', top: 3.5 }); });
  it('lifted pieces and open ground are no host', () => {
    assert.equal(V.hostTop(samplePlan(), kinds, [-8, 10], new Set(['h1'])), null);
    assert.equal(V.hostTop(samplePlan(), kinds, [15, -3], new Set()), null);
  });
  it('a solid:false or unknown kind is no host', () => {
    const plan = samplePlan(); plan.pieces.push({ id: 'ghost', kind: 'kit:nothing', at: [15, -3], rot: 0 });
    assert.equal(V.hostTop(plan, kinds, [15, -3], new Set()), null);
    const soft = { ...kinds, 'kit:crate': { ...kinds['kit:crate'], solid: false } };
    assert.equal(V.hostTop(samplePlan(), soft, [2, 2], new Set()), null);
  });
  it('agrees with the fit check', () => {
    for (const p of samplePlan().pieces) {
      const plan = samplePlan(), t = V.hostTop(plan, kinds, p.at, new Set());
      if (!t || (p.y || 0) > 0.5) continue;
      plan.pieces.push({ id: 'probe', kind: 'kit:crate', at: p.at, rot: 0, y: t.top });
      const floats = checkFit(plan, kinds).filter((q) => q.kind === 'float' && q.sel.includes('piece:probe'));
      assert.deepEqual(floats, [], `on ${p.id}`);
    }
  });
});

describe('the page', () => {
  it('carries view3d', () => { const text = page(); assert.ok(text.includes('function view3d(')); assert.ok(!text.includes('/*@view3d*/ null')); });
});
