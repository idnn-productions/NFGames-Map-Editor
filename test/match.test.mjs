// The match module without Blender: its settings, the slider's limits, the references' own consistency, when a loop stops,
// the scorer's wrapper (a fixed command, a cache by hash, progress, Blender missing), and the loop's job and status fields.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { SCORER, VIEWS, consistency, createMatcher, decide, drift, normaliseLoop, normaliseMatch, outlinesOf, refsVerdict, scoredViews, blenderMissing, DEFAULTS, REFS_LIMITS } from '../src/match.mjs';
import { createReview, listReviews } from '../src/reviews.mjs';
import { finishLoop, openJob, recordRound, setStatus, startLoop } from '../src/matchloop.mjs';
import { REPO, sampleCopy, makeGlb, PNG_1PX, dataBytes } from './helpers.mjs';

describe('match settings', () => {
  it('the config\'s match: defaults, and mistakes named', () => {
    assert.deepEqual(normaliseMatch(undefined), DEFAULTS);
    assert.deepEqual(normaliseMatch({ weights: { colour: 0.2 }, upFix: true, planUp: 'right' }).weights, { silhouette: 0.6, colour: 0.2 });
    for (const [bad, why] of [[{ weights: { silhouette: -1 } }, /match\.weights/], [{ weights: { silhouette: 0, colour: 0 } }, /cannot both be 0/], [{ planUp: 'sideways' }, /match\.planUp/], [{ upFix: 'yes' }, /match\.upFix/], [{ fit: 'yes' }, /match\.fit: true or false/], [{ fit: null }, /match\.fit/], [{ grid: 8 }, /match\.grid/], [{ tolerance: 0 }, /match\.tolerance/], [[], /must be an object/]])
      assert.throws(() => normaliseMatch(bad), why);
    assert.equal(DEFAULTS.fit, true); assert.equal(normaliseMatch({ fit: false }).fit, false);
  });
  it('the config\'s match.limits: defaults, some keys, off with null or false, mistakes named', () => {
    assert.deepEqual(DEFAULTS.limits, { size: 0.02, triangles: 1.25, pivot: 0.02, floating: true });
    assert.deepEqual(normaliseMatch({ limits: { size: 0.1, triangles: null, pivot: false, floating: null } }).limits, { size: 0.1, triangles: null, pivot: null, floating: null });
    assert.deepEqual(normaliseMatch({ limits: { size: 0.1 } }).limits, { ...DEFAULTS.limits, size: 0.1 });
    assert.equal(normaliseMatch({ limits: { floating: false } }).limits.floating, null);
    for (const b of [{ size: 0 }, { triangles: 'x' }, { pivot: -1 }, { floating: 1 }, { floating: 'yes' }, [], 'x']) assert.throws(() => normaliseMatch({ limits: b }), /match\.limits/);
    assert.equal(DEFAULTS.limits.size, 0.02, 'the defaults are not changed');
  });
  it('the slider: 0.50 to 0.99 in steps of 0.01, kept to two decimals; rounds, plateau and the score are checked', () => {
    assert.deepEqual(normaliseLoop({}), { target: 0.9, maxRounds: 5, plateau: 0.01, score: 'combined' });
    assert.equal(normaliseLoop({ target: 0.857 }).target, 0.86); assert.equal(normaliseLoop({ target: 0.5 }).target, 0.5); assert.equal(normaliseLoop({ target: 0.99 }).target, 0.99);
    assert.equal(normaliseLoop({ target: 0.1 + 0.2 + 0.6 }).target, 0.9);                               // floating point noise does not leak
    for (const t of [0.49, 1, 'high', NaN, null]) assert.throws(() => normaliseLoop({ target: t }), /match\.target/, String(t));
    assert.deepEqual(normaliseLoop({ maxRounds: 12, plateau: '', score: 'silhouette' }), { target: 0.9, maxRounds: 12, plateau: null, score: 'silhouette' });
    for (const [b, why] of [[{ maxRounds: 0 }, /maxRounds/], [{ maxRounds: 2.5 }, /maxRounds/], [{ maxRounds: 21 }, /maxRounds/], [{ plateau: -0.1 }, /plateau/], [{ plateau: 'x' }, /plateau/], [{ score: 'vibes' }, /match\.score/], [[], /not an object/]])
      assert.throws(() => normaliseLoop(b), why);
  });
  it('the references that are scored are the six orthographic views; the others are shown', () => {
    const refs = ['concept.png', 'Front.PNG', 'left.jpg', 'front.jpg', 'three-quarter.png', 'top.webp', 'notes.png'].map((name) => ({ name }));
    assert.deepEqual(scoredViews(refs), { front: 'Front.PNG', left: 'left.jpg', top: 'top.webp' });
    assert.deepEqual(scoredViews([]), {});
  });
});

describe('reference consistency', () => {
  // a 4 x 2 x 3 object (width, height, depth) seen the way the scorer sees it; `ext` per view as the scorer reports it
  const sound = { front: { refExtent: [400, 200] }, back: { refExtent: [200, 100] }, left: { refExtent: [300, 200] }, right: { refExtent: [150, 100] }, top: { refExtent: [400, 300], planUp: 'up' }, bottom: { refExtent: [100, 75], planUp: null } };
  it('references of one object agree, whatever the scale of each image', () => {
    const c = consistency(sound, 0.05);
    assert.equal(c.checked, true); assert.deepEqual(c.flagged, []); assert.ok(Object.values(c.views).every((v) => v.deviation < 1e-6));
  });
  it('a view that is off is named, with how far; a top turned to its side is read as such', () => {
    const c = consistency({ ...sound, front: { refExtent: [600, 200] } }, 0.05);
    assert.deepEqual(c.flagged, ['front']); assert.ok(Math.abs(c.views.front.deviation - 0.5) < 0.01); assert.match(c.warnings[0], /^front reference: its shape is 50% wider/);
    const turned = { ...sound, top: { refExtent: [300, 400], planUp: 'right' } };
    assert.deepEqual(consistency(turned, 0.05).flagged, []);
    assert.deepEqual(consistency({ ...sound, top: { refExtent: [300, 400], planUp: 'up' } }, 0.05).flagged, ['top']);
  });
  it('the tolerance decides, and three views are enough where two cannot tell', () => {
    const near = { ...sound, front: { refExtent: [420, 200] } };                                        // 5% off
    assert.deepEqual(consistency(near, 0.08).flagged, []); assert.deepEqual(consistency(near, 0.03).flagged, ['front']);
    assert.equal(consistency({ front: sound.front, left: sound.left }, 0.05).checked, false);
    const three = consistency({ front: { refExtent: [600, 200] }, left: sound.left, top: sound.top }, 0.05);
    assert.equal(three.checked, true); assert.equal(three.ambiguous, true); assert.deepEqual(three.flagged, ['front']);      // any of the three could be the odd one: the sides and the top are trusted
    assert.equal(consistency({ front: { refExtent: [0, 5] }, left: sound.left, top: sound.top }).checked, false);
  });
  it('gives the object\'s proportions, the largest side 1, when the views solve them', () => {
    assert.deepEqual(consistency(VIEWS3).proportions, { x: 0.667, y: 0.333, z: 1 });
    assert.deepEqual(consistency(sound).proportions, { x: 1, y: 0.5, z: 0.75 });
    assert.equal(consistency({ front: sound.front, left: sound.left }).proportions, null);
    assert.equal(consistency({ front: sound.front, back: sound.back, top: { refExtent: [0, 3] } }).proportions, null);
  });
});

// a 2 x 1 x 3 object (width, height, depth): front 2 by 1, left 3 by 1, top 2 by 3
const VIEWS3 = { front: { refExtent: [200, 100], planUp: null }, left: { refExtent: [300, 100], planUp: null }, top: { refExtent: [200, 300], planUp: 'up' } };
describe('the references as outlines', () => {
  const result = (planUp = 'up') => ({ ok: true, refsOnly: true, views: { ...VIEWS3, front: { ...VIEWS3.front, outlines: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, left: { ...VIEWS3.left, outlines: [[[0, 0], [1, 1], [0.123456, 0.5]], [[0.5, 0.5], [0.6, 0.5], [0.6, 0.6]]] }, top: { refExtent: planUp === 'up' ? [200, 300] : [300, 200], planUp, outlines: [[[1, 1]]] } }, pairs: {}, warnings: [] });
  it('in metres from the longest side: the object\'s size, each view\'s size and its points', () => {
    const r = result(), o = outlinesOf(r, refsVerdict(r), 30);
    assert.equal(o.length, 30); assert.deepEqual(o.size, { x: 20, y: 10, z: 30 });
    assert.deepEqual(o.views.left.size, [30, 10]); assert.deepEqual(o.views.left.outlines[0][1], [30, 10]); assert.deepEqual(o.views.left.outlines[0][2], [3.704, 5]);
    assert.equal(o.views.left.outlines.length, 2); assert.deepEqual(o.views.front.outlines[0], [[0, 0], [20, 0], [20, 10], [0, 10]]);
    assert.deepEqual(o.views.top.size, [20, 30]); assert.deepEqual(o.views.top.outlines, [[[20, 30]]]);
    assert.deepEqual(o.views.front.axes, ['width, the model\'s left on the right', 'height']); assert.deepEqual(o.views.left.axes, ['depth, front toward the left', 'height']);
    assert.deepEqual(o.views.top.axes, ['width', 'depth, front toward the top']);
  });
  it('a top drawn with the front toward its side is depth by width', () => {
    const r = result('right'), o = outlinesOf(r, refsVerdict(r), 30);
    assert.deepEqual(o.size, { x: 20, y: 10, z: 30 }); assert.deepEqual(o.views.top.size, [30, 20]); assert.deepEqual(o.views.top.axes, ['depth, front toward the right', 'width']);
  });
  it('without a length, or without proportions, the points stay fractions of each view\'s outline box', () => {
    const r = result(), o = outlinesOf(r, refsVerdict(r));
    assert.equal(o.length, null); assert.equal(o.size, null); assert.equal(o.views.left.size, null);
    assert.deepEqual(o.views.left.outlines[0][2], [0.1235, 0.5]); assert.deepEqual(o.views.left.axes, ['depth, front toward the left', 'height']);
    const two = { ...r, views: { front: r.views.front, left: r.views.left } }, t = outlinesOf(two, refsVerdict(two), 30);
    assert.equal(t.length, 30); assert.equal(t.size, null); assert.equal(t.views.front.size, null); assert.deepEqual(t.views.front.outlines[0][1], [1, 0]);
    const all = { ok: true, views: Object.fromEntries(VIEWS.map((v) => [v, { refExtent: [1, 1], planUp: ['top', 'bottom'].includes(v) ? 'down' : null, outlines: [] }])) };
    assert.deepEqual(Object.fromEntries(Object.entries(outlinesOf(all, refsVerdict(all)).views).map(([v, x]) => [v, x.axes])), {
      front: ['width, the model\'s left on the right', 'height'], back: ['width, the model\'s right on the right', 'height'],
      left: ['depth, front toward the left', 'height'], right: ['depth, front toward the right', 'height'],
      top: ['width', 'depth, front toward the bottom'], bottom: ['width', 'depth, front toward the bottom'],
    });
  });
});

describe('references alone: the verdict', () => {
  const views = { left: { refExtent: [300, 200] }, right: { refExtent: [150, 100] } };
  const verdict = (pairs, limits) => refsVerdict({ ok: true, refsOnly: true, views, pairs, warnings: [] }, undefined, limits);
  it('opposite views whose outlines disagree are named; a pair that is a mirrored copy is noted', () => {
    assert.deepEqual(REFS_LIMITS, { outline: 0.9, copy: 0.97 });
    const low = verdict({ 'left-right': { outline: 0.71, colour: 0.9 } });
    assert.equal(low.checked, true); assert.deepEqual(low.notes, []);
    assert.deepEqual(low.warnings, ['left and right: their outlines agree 0.71 (below 0.9): they show two different shapes']);
    assert.deepEqual(verdict({ 'front-back': { outline: 0.88, colour: 0.9 } }).warnings, ['front and back: their outlines agree 0.88 (below 0.9): they show two different shapes']);
    const copy = verdict({ 'top-bottom': { outline: 0.99, colour: 0.99 } });
    assert.deepEqual(copy.warnings, []); assert.deepEqual(copy.notes, ['bottom looks like a mirrored copy of top: right for a symmetric object; redraw one if it has one-sided details']);
    const fine = verdict({ 'left-right': { outline: 0.93, colour: 0.6 } });
    assert.deepEqual([fine.warnings, fine.notes], [[], []]);
    assert.deepEqual(verdict({ 'left-right': { outline: 0.88, colour: 0.9 } }, { outline: 0.85, copy: 0.97 }).warnings, [], 'the limits decide');
  });
  it('the references\' sizes are checked too; with no pair and too few views nothing is', () => {
    const off = refsVerdict({ ok: true, views: { front: { refExtent: [600, 200] }, back: { refExtent: [200, 100] }, left: { refExtent: [300, 200] }, top: { refExtent: [400, 300], planUp: 'up' } }, pairs: {} }, 0.05);
    assert.equal(off.checked, true); assert.deepEqual(off.consistency.flagged, ['front']); assert.match(off.warnings[0], /^front reference: its shape is/);
    const none = refsVerdict({ ok: true, views: { front: { refExtent: [400, 200] } }, pairs: {} });
    assert.equal(none.checked, false); assert.deepEqual(none.warnings, []); assert.deepEqual(none.notes, ['fewer than two views with a clean background: not checked']);
  });
  it('a result that is not ok is not checked, and says why', () => {
    const failed = refsVerdict({ ok: false, error: 'x' });
    assert.deepEqual([failed.checked, failed.pairs, failed.warnings, failed.notes, failed.consistency.checked], [false, {}, [], ['x'], false]);
    for (const r of [{ ok: false }, { ok: true }, null]) assert.deepEqual(refsVerdict(r).notes, ['fewer than two views with a clean background: not checked']);
  });
});

describe('when a loop stops', () => {
  const loop = { target: 0.9, maxRounds: 3, plateau: 0.01, score: 'combined' };
  const rounds = (...means) => means.map((mean, round) => ({ round, mean }));
  it('on the target, on the rounds, on a plateau', () => {
    assert.deepEqual(decide(loop, rounds(0.6)), { stop: false });
    assert.deepEqual(decide(loop, rounds(0.6, 0.75, 0.84)), { stop: false });
    const hit = decide(loop, rounds(0.6, 0.75, 0.91)); assert.equal(hit.reason, 'target-reached'); assert.match(hit.detail, /0\.91 reached the target 0\.90 after 2 rounds/);
    assert.equal(decide(loop, rounds(0.6, 0.9)).reason, 'target-reached');                                   // exactly the target counts
    assert.equal(decide(loop, rounds(0.6, 0.7, 0.8, 0.85)).reason, 'out-of-rounds');
    const flat = decide(loop, rounds(0.6, 0.7, 0.705)); assert.equal(flat.reason, 'plateau'); assert.match(flat.detail, /round 2 improved the mean by 0\.01/);
    assert.equal(decide({ ...loop, plateau: null }, rounds(0.6, 0.7, 0.7)).stop, false);                     // no plateau field: never
    assert.equal(decide(loop, rounds(0.6, 0.7, 0.65)).reason, 'plateau');                                    // worse is under the threshold too
    assert.equal(decide({ ...loop, maxRounds: 1 }, rounds(0.6, 0.7)).reason, 'out-of-rounds');
  });
  it('drift: size, triangles, the origin and floating pieces are held to round 0, each by its own limit', () => {
    const base = { triangles: 60000, pieces: 1, floating: 0, longest: 40, origin: [0.5, 0.5, 0.5] }, L = DEFAULTS.limits;
    assert.deepEqual(drift(base, { ...base, longest: 40.5, triangles: 70000 }, L), []);
    assert.match(drift(base, { ...base, longest: 42 }, L)[0], /longest side is 42 m, was 40 m.*match\.limits\.size/);
    assert.match(drift(base, { ...base, triangles: 90000 }, L)[0], /90000 triangles, was 60000/);
    assert.match(drift(base, { ...base, origin: [0.5, 0, 0.5] }, L)[0], /origin moved/);
    assert.match(drift(base, { ...base, floating: 2 }, L)[0], /2 floating pieces, was 0/);
    assert.deepEqual(drift(base, { ...base, longest: 80 }, { ...L, size: null }), []);       // turned off
    assert.deepEqual(drift(undefined, base, L), []); assert.deepEqual(drift(base, undefined, L), []);   // a job from before
    assert.deepEqual(drift({ ...base, floating: null }, { ...base, floating: 3 }, L), []);    // not counted then
  });
  it('drift: the texts, the first axis that moved, and the limits that are off', () => {
    const base = { triangles: 60000, pieces: 1, floating: 0, longest: 40, origin: [0.5, 0.5, 0.5] }, L = DEFAULTS.limits;
    assert.deepEqual(drift(base, { ...base, longest: 42 }, L), ['the longest side is 42 m, was 40 m (more than 2% off; match.limits.size)']);
    assert.deepEqual(drift(base, { ...base, triangles: 90000 }, L), ['90000 triangles, was 60000 (more than 1.25 times; match.limits.triangles)']);
    assert.deepEqual(drift(base, { ...base, origin: [0.5, 0.5, 0.1234] }, L), ['the origin moved in the bounding box (depth: 0.5 to 0.12; match.limits.pivot)']);
    assert.match(drift(base, { ...base, origin: [0.9, 0, 0.5] }, L)[0], /\(x: 0\.5 to 0\.9;/);
    assert.deepEqual(drift(base, { ...base, floating: 2 }, L), ['2 floating pieces, was 0 (match.limits.floating)']);
    assert.deepEqual(drift(base, { ...base, floating: 2 }, { ...L, floating: false }), []);
    assert.deepEqual(drift(base, { ...base, triangles: 90000 }, { ...L, triangles: false }), []);
    assert.deepEqual(drift(base, { ...base, origin: [0, 0, 0] }, { ...L, pivot: null }), []);
    assert.equal(drift(base, { ...base, longest: 42, triangles: 90000, floating: 1 }, L).length, 3);
  });
  it('a round that drifted cannot reach the target, and is named when the rounds run out', () => {
    const loop = normaliseLoop({ target: 0.9, maxRounds: 2, plateau: 0.01 });
    const r = (round, mean, drift) => ({ round, mean, ...(drift ? { drift } : {}) });
    assert.deepEqual(decide(loop, [r(0, 0.7), r(1, 0.95, ['x'])]), { stop: false });
    assert.deepEqual(decide(loop, [r(0, 0.7), r(1, 0.701, ['x'])]), { stop: false });        // no plateau while it drifts
    const end = decide(loop, [r(0, 0.7), r(1, 0.95, ['x']), r(2, 0.95, ['42 m'])]);
    assert.equal(end.reason, 'out-of-rounds'); assert.match(end.detail, /drifted from what was sent: 42 m/);
    assert.match(decide(loop, [r(0, 0.7), r(1, 0.8), r(2, 0.95, ['a', 'b'])]).detail, /drifted from what was sent: a; b$/);
  });
  it('held back: the references that disagree are what stands between the model and the target', () => {
    const scores = { front: { combined: 0.5 }, left: { combined: 0.95 }, top: { combined: 0.93 } };
    const held = decide(loop, rounds(0.6, 0.7, 0.8, 0.79), { flagged: ['front'] }, scores);
    assert.equal(held.reason, 'held-back'); assert.match(held.detail, /held back by references that disagree with each other \(front\): the other views average 0\.94/);
    const notHeld = decide(loop, rounds(0.6, 0.7, 0.8, 0.79), { flagged: ['front'] }, { front: { combined: 0.5 }, left: { combined: 0.7 }, top: { combined: 0.93 } });
    assert.equal(notHeld.reason, 'out-of-rounds'); assert.match(notHeld.detail, /front reference disagrees with the others/);
    assert.equal(decide(loop, rounds(0.6, 0.95), { flagged: ['front'] }, scores).reason, 'target-reached');   // the target wins
    assert.equal(decide({ ...loop, score: 'silhouette' }, rounds(0.6, 0.7, 0.8, 0.79), { flagged: ['front'] }, { front: { silhouette: 0.5 }, left: { silhouette: 0.95 } }).reason, 'held-back');
  });
});

// a Blender that is not one: the child process the wrapper starts, and the result it would write
function fakeSpawn({ views = ['front', 'left', 'top'], means = [0.7], fail = false, hold = false, shapes = [] } = {}) {
  const calls = [], held = [];
  let n = 0;
  const impl = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    calls.push({ file, args, options, settings: JSON.parse(readFileSync(args[args.length - 1], 'utf8')) });
    const shape = shapes[Math.min(n, shapes.length - 1)], mean = means[Math.min(n++, means.length - 1)], settings = calls[calls.length - 1].settings;
    const end = () => {
      if (!fail) {
        const per = typeof mean === 'object' ? mean : Object.fromEntries(views.map((v) => [v, mean]));
        const out = {}; for (const v of Object.keys(settings.refs)) { out[v] = { silhouette: per[v], colour: per[v] - 0.1, combined: per[v] - 0.04, background: 'flat', refExtent: SOUND[v], modelExtent: [10, 10], planUp: null, overlay: `overlay-${v}.png`, render: `render-${v}.png` }; writeFileSync(join(settings.outDir, `overlay-${v}.png`), dataBytes(PNG_1PX)); }
        const vals = Object.values(out), avg = (k) => vals.reduce((s, x) => s + x[k], 0) / vals.length;
        writeFileSync(settings.result, JSON.stringify({ ok: true, blender: '5.3.0', views: out, size: [1, 1, 1], mean: { silhouette: avg('silhouette'), colour: avg('colour'), combined: avg('combined') }, orientation: { up: '+Y', turn: 0, tried: [] }, warnings: [], ...(shape ? { shape } : {}) }));
      }
      child.emit('close', fail ? 1 : 0);
    };
    child.stdout.write('PROGRESS 2/9 orientation +Y turn 90: front\n');
    if (hold) held.push(end); else setImmediate(end);
    return child;
  };
  return { impl, calls, release: () => held.splice(0).forEach((f) => f()) };
}
const SOUND = { front: [400, 200], back: [200, 100], left: [300, 200], right: [150, 100], top: [400, 300], bottom: [100, 75] };

describe('the scorer\'s wrapper', () => {
  let copy, project;
  const setup = async (config = {}) => {
    copy = sampleCopy(); mkdirSync(join(copy.root, 'models', 'ships', 'cruiser.refs'), { recursive: true });
    writeFileSync(join(copy.root, 'models', 'ships', 'cruiser.glb'), makeGlb());
    for (const n of ['concept', 'front', 'left', 'top', 'three-quarter']) writeFileSync(join(copy.root, 'models', 'ships', 'cruiser.refs', `${n}.png`), dataBytes(PNG_1PX));
    project = await loadProject({ root: copy.root, config: { models: 'models', blender: process.execPath, ...config } });
  };
  after(() => copy && copy.done());

  it('starts Blender as a fixed command: the scorer and one settings file, no shell', async () => {
    await setup();
    const fake = fakeSpawn(), matcher = createMatcher(project, { spawnImpl: fake.impl });
    const { started, done } = matcher.start('ships/cruiser.glb'); assert.equal(started, true);
    const { result, dir } = await done, call = fake.calls[0];
    assert.equal(call.file, process.execPath);
    assert.deepEqual(call.args.slice(0, 4), ['-b', '--factory-startup', '--python', SCORER]); assert.equal(call.args[4], '--'); assert.equal(call.args.length, 6);
    assert.equal(call.options.shell, false);
    const s = call.settings;
    assert.deepEqual(Object.keys(s.refs), ['front', 'left', 'top']);                                         // not the concept, not the three-quarter view
    assert.ok(s.model.endsWith('cruiser.glb') && s.refs.front.endsWith('front.png'));
    assert.deepEqual(s.weights, { silhouette: 0.6, colour: 0.4 }); assert.equal(s.upFix, false); assert.equal(s.planUp, 'auto'); assert.equal(s.fit, true);
    assert.equal(result.consistency.checked, true); assert.ok(existsSync(join(dir, 'result.json'))); assert.ok(existsSync(join(dir, 'overlay-front.png')));
    assert.ok(dir.startsWith(join(copy.root, '.review', '.match')), 'kept under the reviews folder, out of the jobs\' way');
    assert.equal(listReviews(project).length, 0);
  });
  it('is cached by the hash of the model, its references and the settings', async () => {
    await setup();
    const fake = fakeSpawn(), matcher = createMatcher(project, { spawnImpl: fake.impl });
    await matcher.start('ships/cruiser.glb').done;
    const again = matcher.start('ships/cruiser.glb'); assert.equal(again.started, false); await again.done; assert.equal(fake.calls.length, 1);
    assert.equal(matcher.status('ships/cruiser.glb').state, 'done');
    writeFileSync(join(copy.root, 'models', 'ships', 'cruiser.glb'), Buffer.concat([makeGlb(), Buffer.alloc(4)]));        // the model changed
    assert.equal(matcher.status('ships/cruiser.glb').state, 'idle');
    await matcher.start('ships/cruiser.glb').done; assert.equal(fake.calls.length, 2);
    writeFileSync(join(copy.root, 'models', 'ships', 'cruiser.refs', 'left.png'), Buffer.concat([dataBytes(PNG_1PX), Buffer.alloc(1)]));  // a reference changed
    await matcher.start('ships/cruiser.glb').done; assert.equal(fake.calls.length, 3);
    const other = createMatcher(await loadProject({ root: copy.root, config: { models: 'models', blender: process.execPath, match: { weights: { colour: 0 } } } }), { spawnImpl: fake.impl });
    await other.start('ships/cruiser.glb').done; assert.equal(fake.calls.length, 4, 'other weights, other scores');
  });
  it('says how far it is while it runs, and runs one at a time', async () => {
    await setup();
    const fake = fakeSpawn({ hold: true }), matcher = createMatcher(project, { spawnImpl: fake.impl });
    const { done } = matcher.start('ships/cruiser.glb');
    await new Promise((ok) => setImmediate(ok));                                                              // the child's first line of output
    const s = matcher.status('ships/cruiser.glb');
    assert.equal(s.state, 'running'); assert.deepEqual(s.progress, { done: 2, total: 9, text: 'orientation +Y turn 90: front' }); assert.deepEqual(s.views, ['front', 'left', 'top']);
    assert.throws(() => matcher.start('ships/cruiser.glb'), /busy/);
    fake.release(); await done; assert.equal(matcher.status('ships/cruiser.glb').state, 'done');
  });
  it('says plainly when Blender is not there, or the scorer fails, or there is nothing to match', async () => {
    await setup({ blender: join(copy ? copy.root : '.', 'no-such-blender') });
    const matcher = createMatcher(project);
    const s = matcher.status('ships/cruiser.glb'); assert.equal(s.blender.found, false); assert.match(s.blender.text, /Blender was not found at ".*no-such-blender" \(the config's "blender"\)/);
    assert.throws(() => matcher.start('ships/cruiser.glb'), (e) => e.code === 409 && /Blender was not found/.test(e.message));
    assert.match(blenderMissing(''), /Matching a model against its references needs Blender \(https:\/\/www\.blender\.org\/download\/\): install it, or set "blender" in map-editor\.config\.mjs/);
    await setup();
    const bad = createMatcher(project, { spawnImpl: fakeSpawn({ fail: true }).impl });
    await assert.rejects(bad.start('ships/cruiser.glb').done, /Blender stopped \(exit 1\) without a result/);
    assert.equal(bad.status('ships/cruiser.glb').state, 'failed'); assert.match(bad.status('ships/cruiser.glb').error, /exit 1/);
    writeFileSync(join(copy.root, 'models', 'bare.glb'), makeGlb());
    assert.equal(bad.status('bare.glb').state, 'no-views'); assert.throws(() => bad.start('bare.glb'), /no front, back, left, right, top or bottom reference/);
    assert.throws(() => bad.status('../x.glb'), /no such model/);
    assert.throws(() => createMatcher(project).status('nope.glb'), (e) => e.code === 400);
  });
  it('outlines: the references alone, as a fixed command, never from or into the scores\' cache', async () => {
    await setup();
    const calls = [], impl = (file, args, options) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} }), s = JSON.parse(readFileSync(args[args.length - 1], 'utf8'));
      calls.push({ file, args, options, settings: s });
      setImmediate(() => { writeFileSync(s.result, JSON.stringify({ ok: true, refsOnly: true, views: { front: { refExtent: [1, 1], outlines: [] } }, pairs: {}, warnings: [] })); child.emit('close', 0); });
      return child;
    };
    const matcher = createMatcher(project, { spawnImpl: impl });
    await matcher.start('ships/cruiser.glb', {}).done.catch(() => {});                                       // a score in the cache does not answer for outlines
    const r = await matcher.outlines('ships/cruiser.glb', { points: 12 }), call = calls[calls.length - 1];
    assert.deepEqual(r.views.front.outlines, []);
    assert.equal(call.file, process.execPath); assert.deepEqual(call.args.slice(0, 5), ['-b', '--factory-startup', '--python', SCORER, '--']); assert.equal(call.args.length, 6); assert.equal(call.options.shell, false);
    assert.deepEqual(Object.keys(call.settings.refs), ['front', 'left', 'top']); assert.equal(call.settings.model, undefined);
    assert.deepEqual([call.settings.refsOnly, call.settings.outlines, call.settings.planUp], [true, 12, 'up']);
    await matcher.outlines('ships/cruiser.glb', { points: 12 }); assert.equal(calls.length, 3, 'run again each time');
    assert.deepEqual(readdirSync(join(copy.root, '.review', '.match')).filter((n) => n.startsWith('outlines-')), [], 'its folder goes');
    const left = createMatcher(await loadProject({ root: copy.root, config: { models: 'models', blender: process.execPath, match: { planUp: 'left' } } }), { spawnImpl: impl });
    await left.outlines('ships/cruiser.glb', { points: 40 }); assert.equal(calls[calls.length - 1].settings.planUp, 'left');
    writeFileSync(join(copy.root, 'models', 'bare.glb'), makeGlb());
    assert.throws(() => matcher.outlines('bare.glb', { points: 40 }), /no front, back, left, right, top or bottom reference/);
  });
  it('match.mjs outline: --points is a whole number of 4 to 200', async () => {
    await setup();
    for (const p of ['3', '201', '4.5', 'x']) {
      const r = spawnSync(process.execPath, [join(REPO, 'bin', 'match.mjs'), 'outline', '--project', copy.root, 'ships/cruiser.glb', '--points', p], { encoding: 'utf8', shell: false });
      assert.equal(r.status, 2, p); assert.match(r.stderr, /--points: a whole number of 4 to 200/);
    }
  });
  it('serves only the scorer\'s own pictures, by a key it made', async () => {
    await setup();
    const matcher = createMatcher(project, { spawnImpl: fakeSpawn().impl }), { key } = (await matcher.start('ships/cruiser.glb').done);
    assert.ok(matcher.image(key, 'overlay-front.png').endsWith('overlay-front.png'));
    for (const [k, n] of [[key, 'result.json'], [key, 'args.json'], [key, '../result.json'], [key, 'overlay-front.png/../../x'], [key, 'overlay-sideways.png'], [key, 'overlay-front.PNG'], ['../..', 'overlay-front.png'], [key.slice(1), 'overlay-front.png'], [undefined, 'overlay-front.png'], [key, undefined], [key, 'render-back.png']])
      assert.equal(matcher.image(k, n), null, `${k} ${n}`);
  });
  it('remembers the last slider values for the project', async () => {
    await setup();
    const matcher = createMatcher(project);
    assert.deepEqual(matcher.settings(), { target: 0.9, maxRounds: 5, plateau: 0.01, score: 'combined' });
    assert.deepEqual(matcher.saveSettings({ target: 0.757, maxRounds: 8, plateau: '', score: 'silhouette' }), { target: 0.76, maxRounds: 8, plateau: null, score: 'silhouette' });
    assert.deepEqual(createMatcher(project).settings(), { target: 0.76, maxRounds: 8, plateau: null, score: 'silhouette' });          // a new matcher (a restart) finds them
    assert.throws(() => matcher.saveSettings({ target: 2 }), /match\.target/);
    assert.equal(createMatcher(project).settings().target, 0.76, 'a refused value changes nothing');
    writeFileSync(join(copy.root, '.review', '.match', 'settings.json'), '{ no');
    assert.equal(createMatcher(project).settings().target, 0.9, 'a damaged file means the defaults');
  });
});

describe('match jobs and their rounds', () => {
  let copy, project, fake, matcher;
  const MODEL = 'ships/cruiser.glb', modelFile = () => join(copy.root, 'models', MODEL);
  const model = (n) => writeFileSync(modelFile(), Buffer.concat([makeGlb(), Buffer.alloc(4 * n)]));        // each export of the model is different bytes
  const send = (extra = {}) => createReview(project, { model: MODEL, workflow: 'blender', match: { target: 0.9, maxRounds: 4, plateau: 0.01, score: 'combined' }, ...extra }, { matcher, now: new Date('2026-11-26T10:00:00Z') });
  /** A round as the session would run it: the model re-exported, then the editor's scorer. */
  let exported = 0;
  const round = (id, extra = {}) => { model(++exported); return recordRound(project, id, matcher, extra); };
  const setup = async (means, views, shapes) => {
    copy = sampleCopy(); mkdirSync(join(copy.root, 'models', 'ships', 'cruiser.refs'), { recursive: true });
    for (const n of ['front', 'left', 'top']) writeFileSync(join(copy.root, 'models', 'ships', 'cruiser.refs', `${n}.png`), dataBytes(PNG_1PX));
    exported = 0; model(0);
    project = await loadProject({ root: copy.root, config: { models: 'models', blender: process.execPath } });
    fake = fakeSpawn({ means, views, shapes }); matcher = createMatcher(project, { spawnImpl: fake.impl });
    await matcher.start(MODEL).done;                                                                          // "Measure" on the page
  };
  after(() => copy && copy.done());

  it('is refused without a measurement of the model as it is, or with a target off the slider', async () => {
    await setup([0.62]); model(99);                                                                           // the model changed since it was measured
    assert.throws(() => send(), /measure the model against its references first/);
    assert.throws(() => send({ match: { target: 0.4 } }), /match\.target/);
    assert.throws(() => send({ match: { target: 0.9, maxRounds: 99 } }), /match\.maxRounds/);
    assert.throws(() => send({ match: 'high' }), /match: not an object/);
    assert.equal(listReviews(project).length, 0, 'nothing was written');
  });
  it('writes the loop into job.json, the overlays beside it, and the status\'s rounds are listed', async () => {
    await setup([0.62, 0.71, 0.84, 0.93]);
    const { id } = send({ match: { target: 0.9, maxRounds: 4, plateau: 0.01, score: 'combined' } });
    const dir = join(copy.root, '.review', id), job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
    assert.deepEqual([job.match.target, job.match.maxRounds, job.match.plateau, job.match.score], [0.9, 4, 0.01, 'combined']);
    assert.deepEqual(job.match.views, ['front', 'left', 'top']);
    assert.equal(job.match.baseline.round, 0); assert.ok(Math.abs(job.match.baseline.mean - 0.58) < 1e-9); assert.equal(job.match.baseline.scores.front.silhouette, 0.62);
    assert.ok(existsSync(join(dir, 'match-0-overlay-front.png'))); assert.deepEqual(job.match.baseline.overlays, { front: 'match-0-overlay-front.png', left: 'match-0-overlay-left.png', top: 'match-0-overlay-top.png' });
    assert.equal(job.match.consistency.checked, true); assert.match(job.match.cli, /bin[\\/]match\.mjs$/);
    assert.match(job.workflow.instructions, /Work through Blender/); assert.match(job.workflow.instructions, /MATCH LOOP\. Bring this model's agreement with its reference images up to 0\.90/);
    assert.match(job.workflow.instructions, new RegExp(`match\\.mjs round --project .+ ${id} --changed`));
    assert.deepEqual(matcher.settings(), { target: 0.9, maxRounds: 4, plateau: 0.01, score: 'combined' }, 'the last values are kept');
    assert.deepEqual(listReviews(project)[0].match, { target: 0.9, maxRounds: 4, plateau: 0.01, score: 'combined', views: ['front', 'left', 'top'] });
    assert.equal(send({ match: { target: 0.857 } }).id !== id, true); assert.equal(listReviews(project)[0].match.target, 0.86);
  });
  it('a job with a target needs no pin and no note; one without a target still does', async () => {
    await setup([0.62]);
    assert.ok(send({ note: '', pins: [] }).id);
    assert.throws(() => createReview(project, { model: MODEL, workflow: 'blender', pins: [] }), /a pin or a note, or a match target/);
  });
  it('each round is scored by the editor, written to status.json, and the mean rises until the target is reached', async () => {
    await setup([0.62, 0.71, 0.84, 0.97]);
    const { id } = send(), dir = join(copy.root, '.review', id);
    const started = startLoop(project, id); assert.equal(started.rounds.length, 1); assert.equal(openJob(project, id).status.state, 'working');
    const r1 = await round(id, { changed: ['art/ship.blend', 'models/ships/cruiser.glb'], note: 'lengthened the hull', seconds: 41, cost: 0.12 });
    assert.equal(r1.decision.stop, false); assert.equal(r1.round.round, 1); assert.ok(r1.round.mean > 0.6);
    const r2 = await round(id, { changed: ['art/ship.blend'], note: 'added the pods' }); assert.equal(r2.decision.stop, false);
    const r3 = await round(id, { note: 'rounded the nose' });
    assert.equal(r3.decision.stop, true); assert.equal(r3.decision.reason, 'target-reached');
    const status = openJob(project, id).status;
    assert.deepEqual(status.rounds.map((r) => r.round), [0, 1, 2, 3]);
    const means = status.rounds.map((r) => r.mean); assert.deepEqual([...means].sort((a, b) => a - b), means, 'the mean rises round by round');
    assert.equal(status.rounds[1].seconds, 41); assert.equal(status.rounds[1].cost, 0.12); assert.deepEqual(status.rounds[1].changed, ['art/ship.blend', 'models/ships/cruiser.glb']); assert.equal(status.rounds[1].note, 'lengthened the hull');
    assert.ok(existsSync(join(dir, 'round-3-overlay-front.png')));
    assert.equal(status.stopReason, 'target-reached'); assert.deepEqual(status.changedFiles, ['art/ship.blend', 'models/ships/cruiser.glb']);
    assert.rejects(round(id), /the loop already stopped \(target-reached\)/);
    const fin = finishLoop(project, id, { summary: 'three rounds' }); assert.equal(fin.state, 'done'); assert.equal(fin.rounds.length, 4); assert.equal(fin.stopReason, 'target-reached');
    const listed = listReviews(project).find((j) => j.id === id);
    assert.equal(listed.state, 'done'); assert.equal(listed.stopReason, 'target-reached'); assert.match(listed.stopDetail, /reached the target 0\.90 after 3 rounds/);
    assert.deepEqual(listed.rounds.map((r) => Math.round(r.mean * 100)), means.map((m) => Math.round(m * 100))); assert.equal(listed.rounds[2].note, 'added the pods');
  });
  it('stops on the rounds, or on a plateau, and says which', async () => {
    await setup([0.62, 0.7, 0.75]);
    const a = send({ match: { target: 0.9, maxRounds: 2, plateau: null } }); startLoop(project, a.id);
    await round(a.id); const last = await round(a.id);
    assert.equal(last.decision.reason, 'out-of-rounds'); assert.equal(openJob(project, a.id).status.stopReason, 'out-of-rounds');
    await setup([0.62, 0.7, 0.705]);
    const b = send({ match: { target: 0.9, maxRounds: 5, plateau: 0.01 } }); startLoop(project, b.id);
    assert.equal((await round(b.id)).decision.stop, false); const flat = await round(b.id);
    assert.equal(flat.decision.reason, 'plateau'); assert.equal(listReviews(project)[0].stopReason, 'plateau');
  });
  it('a job from before the shape has no drift and reaches its target', async () => {
    await setup([0.62, 0.95]);
    const { id } = send(); assert.equal(openJob(project, id).job.match.baseline.shape, undefined); startLoop(project, id);
    const r = await round(id); assert.equal(r.round.drift, undefined); assert.equal('drift' in r.round, false); assert.equal(r.decision.reason, 'target-reached');
  });
  it('a round whose model drifted from round 0 cannot reach the target, and the end is out-of-rounds', async () => {
    const shape = { triangles: 1000, pieces: 1, floating: 0, longest: 10, origin: [0.5, 0, 0.5] };
    await setup([0.62, 0.95, 0.95], undefined, [shape, { ...shape, longest: 20 }, { ...shape, longest: 20 }]);
    const { id } = send({ match: { target: 0.9, maxRounds: 4, plateau: 0.01, score: 'combined' } });
    assert.deepEqual(openJob(project, id).job.match.baseline.shape, shape); startLoop(project, id);
    assert.deepEqual(openJob(project, id).status.rounds[0].shape, shape);
    const r = await round(id);
    assert.equal(r.decision.stop, false); assert.equal(r.round.drift.length, 1); assert.match(r.round.drift[0], /longest side is 20 m, was 10 m/);
    assert.deepEqual(openJob(project, id).status.rounds[1].shape, { ...shape, longest: 20 });
    const fin = finishLoop(project, id, { summary: 'gave up' });
    assert.equal(fin.stopReason, 'out-of-rounds'); assert.match(fin.stopDetail, /drifted from what was sent: the longest side is 20 m, was 10 m/);
  });
  it('held back by references that disagree: they are named', async () => {
    const odd = { front: 0.45, left: 0.95, top: 0.95 };                                                       // the front is the one view that cannot score: its reference is off
    await setup([odd, odd, odd], ['front', 'left', 'top']);
    // the fake's reference extents make the front reference disagree with the rest
    const real = SOUND.front; SOUND.front = [700, 200];
    try {
      const { id } = send({ match: { target: 0.9, maxRounds: 1, plateau: 0.01, score: 'silhouette' } }); startLoop(project, id);
      const r = await round(id);
      assert.deepEqual(r.round.flagged, ['front']); assert.equal(r.decision.reason, 'held-back'); assert.match(r.decision.detail, /held back by references that disagree with each other \(front\)/);
      assert.equal(listReviews(project)[0].stopReason, 'held-back');
    } finally { SOUND.front = real; }
  });
  it('knows when nothing was re-exported, keeps rounds through other statuses, and refuses what is not a job', async () => {
    await setup([0.62, 0.62]);
    const { id } = send(); startLoop(project, id);
    const same = await recordRound(project, id, matcher);                                                     // the model file is the one that was sent
    assert.equal(same.round.unchanged, true); assert.equal(listReviews(project)[0].rounds[1].unchanged, true);
    const asked = setStatus(project, id, { state: 'needs-input', question: 'Save the file into the model\'s folder?' });
    assert.equal(asked.state, 'needs-input'); assert.equal(asked.rounds.length, 2); assert.equal(listReviews(project)[0].question, 'Save the file into the model\'s folder?');
    assert.equal(setStatus(project, id, { state: 'working' }).question, undefined);
    assert.throws(() => setStatus(project, id, { state: 'done' }), /working or needs-input/);
    assert.equal(startLoop(project, id).rounds.length, 2, 'starting again keeps the rounds');
    for (const bad of ['../x', '', 'a/b', '..', 'nope']) assert.throws(() => openJob(project, bad), /not a job id|no such job/, bad);
    const plain = createReview(project, { model: MODEL, workflow: 'auto', note: 'a plain one' });
    assert.throws(() => startLoop(project, plain.id), /no match loop/);
    assert.equal(listReviews(project).find((j) => j.id === plain.id).match, null);
  });
});
