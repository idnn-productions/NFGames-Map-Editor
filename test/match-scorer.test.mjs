// The scorer, for real: Blender (when this machine has it) measures tiny generated models against references drawn from the
// same shapes. A sphere, a box, a shape that is not symmetric in any view, a model turned 90 degrees that the orientation
// search must recover, references with a transparent or an unclean background, and a reference that disagrees with the rest.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { SCORER, VIEWS, createMatcher, outlinesOf, refsVerdict } from '../src/match.mjs';
import { findBlender } from '../src/blender.mjs';
import { boxesGlb, linear, manyBoxesGlb, sphereGlb, turnedBoxes, writeRefs } from './match-fixtures.mjs';
import { REPO } from './helpers.mjs';

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
  /** The scorer on the references in `refs` alone (<view>.png), run as createMatcher runs it: a fixed command, one settings file. */
  function refsOnly(refs, extra = {}) {
    const out = join(dir, `r${++n}`); mkdirSync(out, { recursive: true });
    const args = join(out, 'args.json'), result = join(out, 'result.json');
    const files = Object.fromEntries(VIEWS.filter((v) => existsSync(join(refs, `${v}.png`))).map((v) => [v, join(refs, `${v}.png`)]));
    writeFileSync(args, JSON.stringify({ refs: files, outDir: out, result, refsOnly: true, planUp: 'auto', ...extra }));
    return new Promise((ok, no) => {
      const child = spawn(findBlender(''), ['-b', '--factory-startup', '--python', SCORER, '--', args], { shell: false, stdio: 'ignore' });
      child.on('error', no); child.on('close', () => { try { ok(JSON.parse(readFileSync(result, 'utf8'))); } catch (e) { no(e); } });
    });
  }

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
  it('a model missing one part is placed where the rest agrees, so only that part is red', async () => {
    const refs = (d) => writeRefs(d, { boxes: SHAPE }, ['left', 'top'], { colour: RED });
    const noNose = boxesGlb(SHAPE.slice(0, 2), linear(RED));
    const fitted = await score(noNose, refs), boxed = await score(noNose, refs, { fit: false });
    assert.ok(fitted.mean.silhouette > boxed.mean.silhouette + 0.03, `${fitted.mean.silhouette} vs ${boxed.mean.silhouette}`);
    assert.notDeepEqual(fitted.views.left.fit, { scale: 1, dx: 0, dy: 0 });
    const whole = await score(boxesGlb(SHAPE, linear(RED)), refs), wholeBoxed = await score(boxesGlb(SHAPE, linear(RED)), refs, { fit: false });
    assert.ok(Math.abs(whole.mean.silhouette - wholeBoxed.mean.silhouette) < 0.005);   // nothing to gain when it already fits
    assert.ok(whole.mean.silhouette >= wholeBoxed.mean.silhouette);                     // and never lower
  });
  it('with the fit on, no view scores lower, in silhouette or combined, than with it off', async () => {
    const refs = (d) => writeRefs(d, { boxes: SHAPE }, ['front', 'left', 'top'], { colour: RED });
    for (const boxes of [SHAPE.slice(0, 2), SHAPE]) {
      const on = await score(boxesGlb(boxes, linear(RED)), refs), off = await score(boxesGlb(boxes, linear(RED)), refs, { fit: false });
      for (const v of Object.keys(off.views)) for (const k of ['silhouette', 'combined']) assert.ok(on.views[v][k] >= off.views[v][k], `${boxes.length} boxes, ${v} ${k}: ${on.views[v][k]} vs ${off.views[v][k]}`);
    }
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
  it('references alone: opposite views of one shape agree, a pair that does not is found', async () => {
    const d = join(dir, 'refs1'); writeRefs(d, { boxes: SHAPE }, ['front', 'back', 'left', 'right', 'top', 'bottom'], { colour: RED });
    const same = await refsOnly(d);
    assert.equal(same.ok, true); assert.equal(same.refsOnly, true);
    for (const p of ['left-right', 'front-back', 'top-bottom']) assert.ok(same.pairs[p].outline > 0.95, `${p} ${same.pairs[p].outline}`);
    assert.deepEqual(Object.keys(same.pairs), ['left-right', 'front-back', 'top-bottom']);
    assert.equal(same.views.top.planUp, 'up'); assert.equal(same.views.front.planUp, null); assert.equal(same.views.front.background, 'flat');
    assert.equal(same.views.front.refExtent.length, 2); assert.deepEqual(same.views.front.refSize, [192, 192]); assert.deepEqual(same.warnings, []);
    const e = join(dir, 'refs2'); writeRefs(e, { boxes: SHAPE }, ['front', 'left'], { colour: RED }); writeRefs(join(e, 'x'), { boxes: BOX }, ['right'], { colour: RED });
    copyFileSync(join(e, 'x', 'right.png'), join(e, 'right.png'));
    const other = await refsOnly(e);
    assert.ok(other.pairs['left-right'].outline < 0.9, `left-right ${other.pairs['left-right'].outline}`);
    assert.deepEqual(Object.keys(other.pairs), ['left-right']);            // front has no back
  });
  it('references alone: one view, or an unclean background, is not a pair', async () => {
    const one = await refsOnly(writeRefs(join(dir, 'refs3'), { boxes: SHAPE }, ['front'], { colour: RED }));
    assert.equal(one.ok, true); assert.deepEqual(one.pairs, {}); assert.deepEqual(Object.keys(one.views), ['front']);
    const messy = await refsOnly(writeRefs(join(dir, 'refs4'), { boxes: SHAPE }, ['front', 'back', 'left', 'right'], { colour: RED }, { left: { gradient: true } }));
    assert.deepEqual(Object.keys(messy.pairs), ['front-back']); assert.equal(messy.views.left.background, 'unclean');
    assert.equal(messy.warnings.length, 1); assert.equal(messy.warnings[0].view, 'left'); assert.equal(messy.warnings[0].kind, 'background');
    assert.match(messy.warnings[0].text, /^left: the image's edge is not one flat colour/);
  });
  it('references alone: a top and a bottom both drawn with the front toward the right agree, told with planUp', async () => {
    const r = await refsOnly(writeRefs(join(dir, 'refs5'), { boxes: SHAPE }, ['top', 'bottom'], { colour: RED, turn: 1 }), { planUp: 'right' });
    assert.ok(r.pairs['top-bottom'].outline > 0.95, `top-bottom ${r.pairs['top-bottom'].outline}`); assert.equal(r.views.bottom.planUp, 'right');
  });
  it('references alone: a reference that is not an image ends with ok: false, naming the view', async () => {
    const d = writeRefs(join(dir, 'refs6'), { boxes: SHAPE }, ['front'], { colour: RED }); writeFileSync(join(d, 'back.png'), 'not an image');
    const r = await refsOnly(d);
    assert.equal(r.ok, false); assert.match(r.error, /^back: the image could not be read/);
  });
  const shoelace = (pts) => Math.abs(pts.reduce((s, [x, y], i) => { const [u, v] = pts[(i + 1) % pts.length]; return s + x * v - u * y; }, 0)) / 2;
  const near = (a, b, d) => Math.abs(a - b) <= d;
  it('references alone, as outlines: a box is its four corners in every view, a shape keeps its area in a few points', async () => {
    const box = await refsOnly(writeRefs(join(dir, 'refs7'), { boxes: BOX }, VIEWS, { colour: RED }), { outlines: 40 });
    for (const v of VIEWS) {
      const o = box.views[v].outlines[0]; assert.equal(o.length, 4, `${v} ${JSON.stringify(o)}`); assert.equal(box.views[v].outlines.length, 1);
      for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) assert.ok(o.some((p) => near(p[0], x, 0.02) && near(p[1], y, 0.02)), `${v}: no point at ${x}, ${y}: ${JSON.stringify(o)}`);
    }
    assert.deepEqual(Object.keys(box.pairs), ['left-right', 'front-back', 'top-bottom']);
    // the left view of SHAPE: 4 m (depth) by 2 m (height), 4 m² of it covered, the front (the nose, 0.2 to 0.6 m up) on the left
    const shape = await refsOnly(writeRefs(join(dir, 'refs8'), { boxes: SHAPE }, ['left'], { colour: RED }), { outlines: 40 }), left = shape.views.left.outlines[0];
    assert.ok(left.length <= 12, `${left.length} points`); assert.ok(near(shoelace(left), 0.5, 0.5 * 0.03), `area ${shoelace(left)}`);
    const nose = left.filter(([x]) => x < 0.1).map(([, y]) => y).sort();
    assert.equal(nose.length, 2); assert.ok(near(nose[0], 0.1, 0.02) && near(nose[1], 0.3, 0.02), `the nose at ${nose}`);
    const few = await refsOnly(writeRefs(join(dir, 'refs9'), { sphere: 1 }, ['front'], { colour: RED }), { outlines: 8 });
    assert.ok(few.views.front.outlines[0].length <= 8); assert.ok(near(shoelace(few.views.front.outlines[0]), Math.PI / 4, 0.1), 'a circle in 8 points is still about a circle');
  });
  it('references alone, as outlines: one polygon per piece, the largest first; none for an unclean background', async () => {
    const apart = [{ min: [-2, 0, -0.5], max: [0, 1, 0.5] }, { min: [1, 0, -0.5], max: [1.5, 0.5, 0.5] }, { min: [1.9, 0, -0.5], max: [2, 0.1, 0.5] }];   // two boxes apart, and a speck under 1% of the area (it still counts for the box the points are in)
    const r = await refsOnly(writeRefs(join(dir, 'refs10'), { boxes: apart }, ['front', 'left'], { colour: RED }, { left: { gradient: true } }), { outlines: 40 });
    const [big, small] = r.views.front.outlines;
    assert.equal(r.views.front.outlines.length, 2); assert.ok(shoelace(big) > shoelace(small));
    assert.ok(big.every(([x]) => x <= 0.51) && small.every(([x]) => x >= 0.74 && x <= 0.89), `${JSON.stringify(r.views.front.outlines)}`);
    assert.deepEqual(r.views.left.outlines, []); assert.equal(r.views.left.background, 'unclean');
  });
  it('references alone, as parts: no view is mirrored (a tower at the back on the model\'s left, a nose at the front, a box out on its left)', async () => {
    // x -1 to 1.2 (the middle at 0.1, so across is x - 0.1), up 0 to 2, depth -1.5 to 2.5 (along is z + 1.5): the depth, 4, is the longest
    const boxes = [...SHAPE, { min: [1, 0.2, 0], max: [1.2, 0.5, 0.6] }], tol = 0.08;
    const r = await refsOnly(writeRefs(join(dir, 'refs11'), { boxes }, VIEWS, { colour: RED }), { outlines: 40 }), o = outlinesOf(r, refsVerdict(r), 4);
    for (const v of VIEWS) {
      const { frame, parts } = o.views[v], pts = parts[0], at = (k) => (p) => p[frame.indexOf(k)], across = at('across'), along = at('along'), up = at('up');
      const has = (k) => frame.includes(k), say = `${v} ${JSON.stringify(frame)} ${JSON.stringify(pts)}`;
      assert.equal(parts.length, 1, say);
      if (has('up')) {                                                                   // front, back, left, right: the tower's top
        const top = pts.filter((p) => up(p) > 2 - tol); assert.equal(top.length, 2, say);
        for (const p of top) assert.ok(has('across') ? across(p) > 0 : along(p) <= 1 + tol, say);
      }
      if (has('along')) {                                                                // left, right, top, bottom: the nose (0.2 to 0.6 up; x -0.4 to 0.4)
        const nose = pts.filter((p) => (has('up') ? up(p) > 0.1 && up(p) < 0.7 : across(p) > -0.8 && across(p) < 0.6)); assert.ok(nose.length >= 2, say);
        for (const p of nose) assert.ok(along(p) >= 3 - tol, say);
      }
      if (has('across')) {                                                               // front, back, top, bottom: the box on the left (0.2 to 0.5 up; z 0 to 0.6)
        const side = pts.filter((p) => (has('up') ? up(p) > 0.1 && up(p) < 0.6 : along(p) > 1.4 && along(p) < 2.2)); assert.equal(side.length, 4, say);
        for (const p of side) assert.ok(across(p) > 0.9 - tol, say);
        assert.ok(side.some((p) => across(p) > 1.1 - tol), say);
      }
    }
  });
  it('match.mjs outline: the references in metres, written beside the model; the length from the model\'s score when not given', async () => {
    const root = join(dir, `p${++n}`); mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'models', 'thing.glb'), boxesGlb(BOX, linear(RED))); writeRefs(join(root, 'models', 'thing.refs'), { boxes: BOX }, ['front', 'left', 'top'], { colour: RED });
    writeFileSync(join(root, 'map-editor.config.mjs'), 'export default { models: "models" };\n');
    const cli = (...a) => { const r = spawnSync(process.execPath, [join(REPO, 'bin', 'match.mjs'), 'outline', '--project', root, 'thing.glb', ...a], { encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    const file = join(root, 'models', 'thing.outlines.json'), within = (a, b) => near(a, b, b * 0.03 + 1e-9);
    const metres = cli('--length', '4');                                                                  // the box is 2 x 1 x 1.5: twice that
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), metres); assert.equal(metres.model, 'thing.glb'); assert.equal(metres.length, 4);
    assert.ok(within(metres.size.x, 4) && within(metres.size.y, 2) && within(metres.size.z, 3), JSON.stringify(metres.size));
    const front = metres.views.front;
    assert.deepEqual(front.axes, ['width, the model\'s left on the right', 'height']); assert.ok(within(front.size[0], 4) && within(front.size[1], 2));
    for (const [x, y] of [[0, 0], [front.size[0], 0], front.size, [0, front.size[1]]]) assert.ok(front.outlines[0].some((p) => near(p[0], x, 0.01) && near(p[1], y, 0.01)), `front: no point at ${x}, ${y}`);
    assert.deepEqual(metres.views.left.axes, ['depth, front toward the left', 'height']); assert.deepEqual(metres.warnings, []);
    assert.equal(metres.note, 'Top and bottom were read with the front toward the top of the picture (no score of the model to take the direction from).');
    const fractions = cli();
    assert.equal(fractions.length, null); assert.equal(fractions.size, null); assert.equal(fractions.views.front.size, null); assert.match(fractions.note, /fractions/);
    assert.ok(fractions.views.front.outlines[0].every((p) => p.every((c) => c >= 0 && c <= 1)));
    const score = spawnSync(process.execPath, [join(REPO, 'bin', 'match.mjs'), 'score', '--project', root, 'thing.glb'], { encoding: 'utf8', shell: false });
    assert.equal(score.status, 0, score.stderr);                                                          // a score of the model gives its longest side
    const printed = JSON.parse(score.stdout); assert.equal(typeof printed.shape.floating, 'number'); assert.ok(near(printed.shape.longest, 2, 0.06), JSON.stringify(printed.shape));
    const scored = cli('--points', '4');
    assert.equal(scored.length, 2); assert.ok(within(scored.size.x, 2), JSON.stringify(scored.size)); assert.equal(scored.note, undefined);
    assert.ok(Object.values(scored.views).every((v) => v.outlines.every((o) => o.length <= 4)));
  });
});
