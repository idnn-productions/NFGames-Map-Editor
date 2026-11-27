// The scorer, for real: Blender (when this machine has it) measures tiny generated models against references drawn from the
// same shapes. A sphere, a box, a shape that is not symmetric in any view, a model turned 90 degrees that the orientation
// search must recover, references with a transparent or an unclean background, and a reference that disagrees with the rest.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { createMatcher } from '../src/match.mjs';
import { findBlender } from '../src/blender.mjs';
import { boxesGlb, linear, manyBoxesGlb, sphereGlb, turnedBoxes, writeRefs } from './match-fixtures.mjs';

const RED = [200, 30, 30];
const SHAPE = [{ min: [-1, 0, -1.5], max: [1, 0.8, 1.5] }, { min: [0.2, 0.8, -1.5], max: [1, 2, -0.5] }, { min: [-0.4, 0.2, 1.5], max: [0.4, 0.6, 2.5] }];   // a base, a tower to one side at the back, a nose at the front
const BOX = [{ min: [-1, -0.5, -0.75], max: [1, 0.5, 0.75] }];
const lie = (boxes) => boxes.map(({ min, max }) => { const p = [min[0], -min[2], min[1]], q = [max[0], -max[2], max[1]]; return { min: p.map((v, i) => Math.min(v, q[i])), max: p.map((v, i) => Math.max(v, q[i])) }; });   // turned about X by 90 degrees

describe('the scorer in Blender', { skip: findBlender('') ? false : 'Blender is not installed here' }, () => {
  let dir, n = 0;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-match-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));
  /** A project with one model and its references; scores it. `refs`: (folder) => void writes the reference images. */
  async function score(glb, refs, match = {}) {
    const root = join(dir, `p${++n}`); mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'models', 'thing.glb'), glb); refs(join(root, 'models', 'thing.refs'));
    const project = await loadProject({ root, config: { models: 'models', match } });
    return (await createMatcher(project).start('thing.glb').done).result;
  }
  const mean = (r) => r.mean.silhouette;

  it('a sphere matches a circle in every view, and its colour is what tells a red one from a grey one', async () => {
    const shape = { sphere: 1 }, refs = (d) => writeRefs(d, shape, ['front', 'left', 'top'], { colour: RED });
    const red = await score(sphereGlb(1, linear(RED)), refs), grey = await score(sphereGlb(1, [0.2, 0.2, 0.2]), refs);
    assert.ok(mean(red) > 0.95, `red silhouette ${mean(red)}`); assert.ok(red.mean.colour > 0.85, `red colour ${red.mean.colour}`);
    assert.ok(mean(grey) > 0.95, 'the silhouette alone flatters the grey sphere'); assert.ok(grey.mean.colour < 0.5, `grey colour ${grey.mean.colour}`);
    assert.ok(red.mean.combined - grey.mean.combined > 0.25, `combined ${red.mean.combined} vs ${grey.mean.combined}`);
    for (const f of ['overlay-front.png', 'render-front.png']) assert.ok(red.views.front[f.startsWith('overlay') ? 'overlay' : 'render'] === f);
    assert.deepEqual(Object.keys(red.views), ['front', 'left', 'top']);          // only the views there are references for
  });
  it('a box, from all six views', async () => {
    const r = await score(boxesGlb(BOX, linear(RED)), (d) => writeRefs(d, { boxes: BOX }, ['front', 'back', 'left', 'right', 'top', 'bottom'], { colour: RED }));
    for (const [v, s] of Object.entries(r.views)) assert.ok(s.silhouette > 0.95, `${v} ${s.silhouette}`);
    assert.ok([0, 180].includes(r.orientation.turn), `turn ${r.orientation.turn}`);
    assert.equal(r.orientation.tried.length, 4); assert.equal(r.consistency.checked, true); assert.deepEqual(r.consistency.flagged, []);
  });
  it('a shape that is not symmetric: right, then turned 90 degrees (the orientation search turns it back), then a different shape', async () => {
    const refs = (d) => writeRefs(d, { boxes: SHAPE }, ['front', 'left', 'right', 'top'], { colour: RED });
    const right = await score(boxesGlb(SHAPE, linear(RED)), refs);
    assert.equal(right.orientation.turn, 0); assert.ok(mean(right) > 0.93, `${mean(right)}`);
    const turned = await score(boxesGlb(turnedBoxes(SHAPE, 90), linear(RED)), refs);
    assert.equal(turned.orientation.turn, 270, 'it is turned back by 270 degrees'); assert.ok(mean(turned) > 0.93, `${mean(turned)}`);
    const tried = Object.fromEntries(turned.orientation.tried.map((t) => [t.turn, t.mean]));
    assert.ok(tried[0] < tried[270] - 0.1 && tried[90] < tried[270] - 0.1 && tried[180] < tried[270] - 0.1, `the other turns scored lower: ${JSON.stringify(tried)}`);
    const nonose = await score(boxesGlb(SHAPE.slice(0, 2), linear(RED)), refs);
    assert.ok(mean(nonose) < mean(right) - 0.03, `without the nose ${mean(nonose)} vs ${mean(right)}`);
  });
  it('with upFix it also finds the way up: a model lying on its side', async () => {
    const r = await score(boxesGlb(lie(SHAPE), linear(RED)), (d) => writeRefs(d, { boxes: SHAPE }, ['front', 'left', 'top'], { colour: RED }), { upFix: true });
    assert.equal(r.orientation.tried.length, 24); assert.notEqual(r.orientation.up, '+Y'); assert.ok(mean(r) > 0.9, `${mean(r)}`);
    const flat = await score(boxesGlb(lie(SHAPE), linear(RED)), (d) => writeRefs(d, { boxes: SHAPE }, ['front', 'left', 'top'], { colour: RED }));
    assert.ok(mean(flat) < 0.8, 'without it the model stays on its side');
  });
  it('a transparent background is the alpha, a flat one is flood-filled from the edges, one that is neither is reported', async () => {
    const shape = { boxes: SHAPE }, glb = boxesGlb(SHAPE, linear(RED)), views = ['front', 'left', 'top'];
    const flat = await score(glb, (d) => writeRefs(d, shape, views, { colour: RED, background: [250, 250, 250] }));
    const alpha = await score(glb, (d) => writeRefs(d, shape, views, { colour: RED, transparent: true }));
    const messy = await score(glb, (d) => writeRefs(d, shape, views, { colour: RED, gradient: true }));
    assert.equal(flat.views.front.background, 'flat'); assert.equal(alpha.views.front.background, 'alpha');
    assert.ok(Math.abs(mean(flat) - mean(alpha)) < 0.02, `${mean(flat)} vs ${mean(alpha)}`);
    assert.equal(messy.views.front.background, 'unclean');
    assert.equal(messy.warnings.length, 3); assert.match(messy.warnings[0].text, /^front: the image's edge is not one flat colour/); assert.equal(flat.warnings.length, 0);
  });
  it('a top view drawn with the front toward its side: found, or told with planUp', async () => {
    const shape = { boxes: SHAPE }, views = ['front', 'left', 'top'], glb = boxesGlb(SHAPE, linear(RED));
    const refs = (d) => writeRefs(d, shape, views, { colour: RED }, { top: { turn: 1 } });
    const auto = await score(glb, refs);
    assert.ok(['left', 'right'].includes(auto.views.top.planUp), `planUp ${auto.views.top.planUp}`); assert.ok(auto.views.top.silhouette > 0.9, `${auto.views.top.silhouette}`);
    const fixed = await score(glb, refs, { planUp: 'up' });
    assert.equal(fixed.views.top.planUp, 'up'); assert.ok(fixed.views.top.silhouette < auto.views.top.silhouette - 0.15, 'a wrong planUp is not forgiven');
  });
  it('a reference that disagrees with the others is named, and the sides and the top are taken as right', async () => {
    const shape = { boxes: SHAPE }, glb = boxesGlb(SHAPE, linear(RED));
    const r = await score(glb, (d) => writeRefs(d, shape, ['front', 'left', 'right', 'top'], { colour: RED }, { front: { stretch: 1.6 } }));
    assert.deepEqual(r.consistency.flagged, ['front']); assert.match(r.consistency.warnings[0], /^front reference: its shape is \d+% wider/);
    assert.ok(r.views.front.silhouette < r.views.left.silhouette - 0.1, 'and that view is where the model cannot score');
  });
  it('describes the mesh: triangles, pieces, floating pieces, and where its origin is', async () => {
    const refs = (d) => writeRefs(d, { boxes: BOX }, ['front', 'left', 'top'], { colour: RED });
    const box = await score(boxesGlb(BOX, linear(RED)), refs);
    assert.deepEqual([box.shape.triangles, box.shape.pieces, box.shape.floating], [12, 1, 0]);
    assert.equal(box.shape.longest, 2);
    box.shape.origin.forEach((f) => assert.ok(Math.abs(f - 0.5) < 0.01));
    const shape = await score(boxesGlb(SHAPE, linear(RED)), refs);          // base on y = 0, three boxes that touch
    assert.ok(Math.abs(shape.shape.origin[1]) < 0.01); assert.equal(shape.shape.floating, 0);
    const apart = await score(boxesGlb([...BOX, { min: [5, 5, 5], max: [6, 6, 6] }], linear(RED)), refs);
    assert.deepEqual([apart.shape.pieces, apart.shape.floating], [2, 2]);  // neither touches the other
  });
  it('a mesh in hundreds of pieces is still scored, and its floating pieces are not counted', async () => {
    const r = await score(manyBoxesGlb(600), (d) => writeRefs(d, { boxes: BOX }, ['front', 'left', 'top'], { colour: RED }));
    assert.equal(r.shape.pieces, 600); assert.equal(r.shape.floating, null);
  });
});
