// Reference match: how well a model agrees with the images it was made from, measured by a scorer that runs in Blender
// (src/match/score.py) and checked here. Blender is an optional external program (src/blender.mjs): the editor needs
// nothing installed to run, and says so plainly when Blender is not there.
//
// A model's references are the images in <name>.refs/ (models.mjs). Those named front, back, left, right, top and bottom
// are scored (orthographic views); three-quarter and concept are shown, not scored. Everything the scorer is given is made
// here from the project's real paths and its config: it is started as a fixed command (program, fixed arguments, one JSON
// file of settings), with shell: false, and nothing from a request becomes part of a command.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLENDER_DOWNLOAD, findBlender } from './blender.mjs';
import { modelRefs, resolveModel } from './models.mjs';

export const SCORER = join(dirname(fileURLToPath(import.meta.url)), 'match', 'score.py');
export const SCORER_VERSION = 2;
/** The orthographic views that are scored, in this order. */
export const VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom'];
export const SCORES = ['combined', 'silhouette'];
/** The loop's limits, as the page's slider and fields show them. */
export const LOOP = { target: { min: 0.5, max: 0.99, step: 0.01, default: 0.9 }, maxRounds: { min: 1, max: 20, default: 5 }, plateau: { min: 0, max: 0.2, default: 0.01 }, score: 'combined' };
export const DEFAULTS = { weights: { silhouette: 0.6, colour: 0.4 }, colourFalloff: 0.4, grid: 256, upFix: false, planUp: 'auto', fit: true, tolerance: 0.05, limits: { size: 0.02, triangles: 1.25, pivot: 0.02, floating: true } };
const TIMEOUT = 15 * 60 * 1000, KEEP = 24;

const fail = (text) => { throw new Error(`map editor config: ${text}`); };
const bad = (text, code = 400) => { throw Object.assign(new Error(text), { code }); };
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** The config's `match` (all optional): { weights: { silhouette, colour }, colourFalloff, grid, upFix, planUp, fit, tolerance, limits: { size, triangles, pivot, floating } }. */
export function normaliseMatch(options) {
  if (options === undefined || options === null) return { ...DEFAULTS, weights: { ...DEFAULTS.weights }, limits: { ...DEFAULTS.limits } };
  if (typeof options !== 'object' || Array.isArray(options)) fail('"match" must be an object');
  const out = { ...DEFAULTS, weights: { ...DEFAULTS.weights }, limits: { ...DEFAULTS.limits } };
  if (options.weights !== undefined) {
    const w = options.weights;
    if (!w || typeof w !== 'object' || !['silhouette', 'colour'].every((k) => w[k] === undefined || (num(w[k]) && w[k] >= 0))) fail('match.weights: { silhouette, colour }, each a number of 0 or more');
    out.weights = { silhouette: w.silhouette ?? DEFAULTS.weights.silhouette, colour: w.colour ?? DEFAULTS.weights.colour };
    if (out.weights.silhouette + out.weights.colour <= 0) fail('match.weights: they cannot both be 0');
  }
  if (options.colourFalloff !== undefined) { if (!num(options.colourFalloff) || options.colourFalloff <= 0 || options.colourFalloff > 1) fail('match.colourFalloff: a number above 0 and at most 1'); out.colourFalloff = options.colourFalloff; }
  if (options.grid !== undefined) { if (!Number.isInteger(options.grid) || options.grid < 64 || options.grid > 1024) fail('match.grid: a whole number of 64 to 1024'); out.grid = options.grid; }
  if (options.upFix !== undefined) { if (typeof options.upFix !== 'boolean') fail('match.upFix: true or false'); out.upFix = options.upFix; }
  if (options.planUp !== undefined) { if (!['auto', 'up', 'right', 'down', 'left'].includes(options.planUp)) fail('match.planUp: "auto", "up", "right", "down" or "left"'); out.planUp = options.planUp; }
  if (options.fit !== undefined) { if (typeof options.fit !== 'boolean') fail('match.fit: true or false'); out.fit = options.fit; }
  if (options.tolerance !== undefined) { if (!num(options.tolerance) || options.tolerance <= 0 || options.tolerance > 1) fail('match.tolerance: a number above 0 and at most 1'); out.tolerance = options.tolerance; }
  if (options.limits !== undefined) {
    const l = options.limits;
    if (!l || typeof l !== 'object' || Array.isArray(l)) fail('match.limits: { size, triangles, pivot, floating }');
    for (const k of ['size', 'triangles', 'pivot']) {
      if (l[k] === undefined) continue;
      if (l[k] !== null && l[k] !== false && !(num(l[k]) && l[k] > 0)) fail(`match.limits.${k}: a number above 0, or null or false to turn it off`);
      out.limits[k] = l[k] || null;
    }
    if (l.floating !== undefined) { if (l.floating !== null && typeof l.floating !== 'boolean') fail('match.limits.floating: true, or false or null to turn it off'); out.limits.floating = l.floating || null; }
  }
  return out;
}

/** The loop's settings from the page (or a job), checked: { target, maxRounds, plateau, score }. The target keeps two decimals. */
export function normaliseLoop(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('match: not an object');
  const t = input.target === undefined ? LOOP.target.default : input.target;
  if (!num(t) || t < LOOP.target.min - 1e-9 || t > LOOP.target.max + 1e-9) bad(`match.target: a number of ${LOOP.target.min} to ${LOOP.target.max}`);
  const rounds = input.maxRounds ?? LOOP.maxRounds.default;
  if (!Number.isInteger(rounds) || rounds < LOOP.maxRounds.min || rounds > LOOP.maxRounds.max) bad(`match.maxRounds: a whole number of ${LOOP.maxRounds.min} to ${LOOP.maxRounds.max}`);
  let plateau = input.plateau === undefined ? LOOP.plateau.default : input.plateau;
  if (plateau === '' || plateau === null) plateau = null;
  else if (!num(plateau) || plateau < 0 || plateau > LOOP.plateau.max) bad(`match.plateau: empty, or a number of 0 to ${LOOP.plateau.max}`);
  const score = input.score === undefined ? LOOP.score : input.score;
  if (!SCORES.includes(score)) bad(`match.score: ${SCORES.map((s) => `"${s}"`).join(' or ')}`);
  return { target: Math.round(t * 100) / 100, maxRounds: rounds, plateau: plateau === null ? null : Math.round(plateau * 1000) / 1000, score };
}

// ---- which references are scored
const labelOf = (name) => name.slice(0, name.length - extname(name).length).toLowerCase();
/** { view: reference name } for the references that are orthographic views; a name appearing twice (front.png, front.jpg) keeps the first. */
export function scoredViews(refs) {
  const out = {};
  for (const r of refs) { const v = labelOf(r.name); if (VIEWS.includes(v) && !out[v]) out[v] = r.name; }
  return Object.fromEntries(VIEWS.filter((v) => out[v]).map((v) => [v, out[v]]));
}

// ---- reference consistency: do the references describe one object?
// A view shows two of the object's three sizes (front, back: width x height; left, right: depth x height; top, bottom:
// width x depth, or depth x width when the reference has the front toward its side). Each image has its own scale, so only
// the aspect of each can be compared: log(w/h) of a view is the difference of the logs of its two sizes. Three or more views
// over-determine the sizes. The sizes that explain the most views (smallest total error) are taken as the truth, and the
// views that disagree with them by more than the tolerance are the ones whose images cap any model's score. When two sets
// of sizes explain the views equally well (three views, say, where any one could be the odd one out) the sides and the top
// are taken as right, then front, back and bottom: they are the views a person draws first, and the likeliest to be true.
const AXES = { front: ['X', 'Y'], back: ['X', 'Y'], left: ['Z', 'Y'], right: ['Z', 'Y'], top: ['X', 'Z'], bottom: ['X', 'Z'] };
const TRUST = ['left', 'right', 'top', 'front', 'back', 'bottom'];
const UNIT = { X: [1, 0], Y: [0, 0], Z: [0, 1] };
const axesOf = (view, v) => (view === 'top' || view === 'bottom') && (v.planUp === 'right' || v.planUp === 'left') ? [AXES[view][1], AXES[view][0]] : AXES[view];

/** The sizes that explain the views best: { eq, tied, pick } (pick.u is [ln(X/Y), ln(Z/Y)]), or { eq, why } when they cannot be solved. */
function solve(views) {
  const eq = [];
  for (const [name, v] of Object.entries(views || {})) {
    if (!v || !Array.isArray(v.refExtent) || !(v.refExtent[0] > 0) || !(v.refExtent[1] > 0)) continue;
    const [h, w] = axesOf(name, v);
    eq.push({ view: name, row: [UNIT[h][0] - UNIT[w][0], UNIT[h][1] - UNIT[w][1]], obs: Math.log(v.refExtent[0] / v.refExtent[1]) });
  }
  if (eq.length < 3) return { eq, why: 'needs at least three scored views to compare them' };
  const solutions = [];
  for (let i = 0; i < eq.length; i++) for (let j = i + 1; j < eq.length; j++) {
    const [a, b] = [eq[i].row, eq[j].row], det = a[0] * b[1] - a[1] * b[0];
    if (Math.abs(det) < 1e-9) continue;
    const u = [(eq[i].obs * b[1] - eq[j].obs * a[1]) / det, (a[0] * eq[j].obs - b[0] * eq[i].obs) / det];
    const res = eq.map((e) => e.obs - (e.row[0] * u[0] + e.row[1] * u[1]));
    solutions.push({ u, res, cost: res.reduce((s, r) => s + Math.abs(r), 0), rank: TRUST.indexOf(eq[i].view) + TRUST.indexOf(eq[j].view) });
  }
  if (!solutions.length) return { eq, why: 'these views do not share a size to compare' };
  const best = Math.min(...solutions.map((s) => s.cost)), tied = solutions.filter((s) => s.cost < best + 1e-9).sort((a, b) => a.rank - b.rank);
  return { eq, tied, pick: tied[0] };
}
/** The object's width, height and depth as a solution of solve() has them, the largest 1 (unrounded). */
function proportionsOf(pick) {
  const s = [Math.exp(pick.u[0]), 1, Math.exp(pick.u[1])], top = Math.max(...s);
  return { x: s[0] / top, y: s[1] / top, z: s[2] / top };
}
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** { checked, flagged: [view], views: { view: { aspect, expected, deviation, flagged } }, warnings: [text], proportions: { x, y, z } | null } from the scorer's per-view reference extents. `proportions`: the object's width, height and depth as the views imply them, the largest 1, to 3 decimals. */
export function consistency(views, tolerance = DEFAULTS.tolerance) {
  const { eq, tied, pick, why } = solve(views);
  if (!pick) return { checked: false, flagged: [], views: {}, warnings: [], why, proportions: null };
  const p = proportionsOf(pick), proportions = { x: round(p.x, 3), y: round(p.y, 3), z: round(p.z, 3) };
  const out = {}, flagged = [], warnings = [];
  eq.forEach((e, k) => {
    const worst = pick.res[k];
    const deviation = Math.exp(Math.abs(worst)) - 1, isOff = deviation > tolerance;
    out[e.view] = { aspect: Math.round(Math.exp(e.obs) * 1000) / 1000, deviation: Math.round(deviation * 1000) / 1000, flagged: isOff };
    if (isOff) {
      flagged.push(e.view);
      warnings.push(`${e.view} reference: its shape is ${Math.round(deviation * 100)}% ${worst > 0 ? 'wider' : 'narrower'} than the other references imply${tied.length > 1 ? ' (the references alone cannot tell which of them is off; the sides and the top are taken as right)' : ''}, which caps the score any model can reach there`);
    }
  });
  return { checked: true, flagged, views: out, warnings, ambiguous: tied.length > 1, proportions };
}

// ---- the references alone, before any model: an outline seen from one side is the mirror image of the outline from the
// opposite side, so a pair whose outlines (the scorer's refsOnly `pairs`) disagree shows two different shapes; one that agrees
// in outline and colour both is likely a mirrored copy, right only for a symmetric object.
export const REFS_LIMITS = { outline: 0.9, copy: 0.97 };
/** { checked, pairs, consistency, warnings: [text], notes: [text] } from a refsOnly result: its pairs, and consistency() of its views. A result that is not ok, or has no views, is not checked: its error is the note. */
export function refsVerdict(result, tolerance = DEFAULTS.tolerance, limits = REFS_LIMITS) {
  if (!result || !result.ok || !result.views) return { checked: false, pairs: {}, consistency: consistency(undefined, tolerance), warnings: [], notes: [(result && typeof result.error === 'string' && result.error) || 'fewer than two views with a clean background: not checked'] };
  const pairs = (result && result.pairs) || {}, c = consistency(result && result.views, tolerance);
  const warnings = [...c.warnings], notes = [];
  for (const [name, p] of Object.entries(pairs)) {
    const [a, b] = name.split('-');
    if (p.outline < limits.outline) warnings.push(`${a} and ${b}: their outlines agree ${p.outline.toFixed(2)} (below ${limits.outline}): they show two different shapes`);
    if (p.outline >= limits.copy && p.colour >= limits.copy) notes.push(`${b} looks like a mirrored copy of ${a}: right for a symmetric object; redraw one if it has one-sided details`);
  }
  const checked = Object.keys(pairs).length > 0 || c.checked;
  if (!checked) notes.push('fewer than two views with a clean background: not checked');
  return { checked, pairs, consistency: c, warnings, notes };
}

// ---- the references as outlines, for building a model from measurements: the scorer's refsOnly `outlines` (fractions of each
// view's outline box, y up) in metres, from the proportions the views imply and the length of the object's longest side, and the
// same points in parts.json's frame: along (from the back end toward the front), across (from the middle, positive toward the
// model's left, glTF +X), up (from the lowest point).
// Where each side of the model lands in a picture, from score.py's VIEWDEF, aim() and plan_up() (the camera's right is its
// forward x its up): [the picture's horizontal, its vertical], each the frame's number it is and +1 when that number grows
// toward the picture's right (or top), -1 when it shrinks. Front: the model's left (+X) on the right. Back: its right. Left: the
// front on the left. Right: the front on the right. Top, from above: front up, the model's right on the right; front down, its
// left on the right; front right, its left toward the top; front left, its right toward the top. Bottom, from below, is the
// mirror of top: front up, its left on the right; down, its right; front right, its right toward the top; front left, its left.
const PICTURE = {
  front: [['across', 1], ['up', 1]], back: [['across', -1], ['up', 1]], left: [['along', -1], ['up', 1]], right: [['along', 1], ['up', 1]],
  top: { up: [['across', -1], ['along', 1]], down: [['across', 1], ['along', -1]], right: [['along', 1], ['across', 1]], left: [['along', -1], ['across', -1]] },
  bottom: { up: [['across', 1], ['along', 1]], down: [['across', -1], ['along', -1]], right: [['along', 1], ['across', -1]], left: [['along', -1], ['across', 1]] },
};
const FRAME = { front: ['across', 'up'], back: ['across', 'up'], left: ['along', 'up'], right: ['along', 'up'], top: ['across', 'along'], bottom: ['across', 'along'] };
const pictureOf = (view, planUp) => (Array.isArray(PICTURE[view]) ? PICTURE[view] : PICTURE[view][['right', 'down', 'left'].includes(planUp) ? planUp : 'up']);
/** What a view's horizontal and vertical are, as score.py draws the views (from PICTURE). */
function axesText(view, planUp) {
  return pictureOf(view, planUp).map(([k, sign], i) => {
    if (k === 'up') return 'height';
    if (k === 'across') return `width, the model's ${sign > 0 ? 'left' : 'right'} ${i === 0 ? 'on the right' : 'toward the top'}`;
    return `depth, front toward the ${i === 0 ? (sign > 0 ? 'right' : 'left') : (sign > 0 ? 'top' : 'bottom')}`;
  });
}
/** A point of a view's picture in metres ([x, y] from its bottom-left corner, the view's size [w, h]) in the view's FRAME. */
function framed(view, planUp, [x, y], wh) {
  const out = {};
  pictureOf(view, planUp).forEach(([k, sign], i) => {
    const f = i === 0 ? x : y, s = wh[i];
    out[k] = k === 'across' ? (sign > 0 ? f * s - s / 2 : s / 2 - f * s) : k === 'along' && sign < 0 ? s - f * s : f * s;
  });
  return FRAME[view].map((k) => round(out[k], 3) + 0);   // + 0: no -0
}
/**
 * { length, size: { x, y, z } | null, views: { view: { axes: [horizontal, vertical], size: [w, h] | null, outlines, frame, parts } } }
 * from a refsOnly result with outlines, its refsVerdict() and the longest side in metres. With the verdict's proportions and a
 * length, the size and each view's points are in metres (3 decimals; the size from the proportions unrounded), and `parts` are the
 * same polygons in parts.json's terms, `frame` naming their two numbers; without, the points stay fractions (4 decimals) and the
 * sizes, `frame` and `parts` are null.
 */
export function outlinesOf(result, verdict, length) {
  const views = (result && result.views) || {}, L = num(length) && length > 0 ? length : null;
  const pick = L && verdict && verdict.consistency && verdict.consistency.proportions ? solve(views).pick : null, p = pick ? proportionsOf(pick) : null;
  const size = p && { x: round(p.x * L, 3), y: round(p.y * L, 3), z: round(p.z * L, 3) };
  return { length: L, size, views: Object.fromEntries(Object.entries(views).map(([name, v]) => {
    const wh = p ? axesOf(name, v).map((a) => p[a.toLowerCase()] * L) : null, raw = v.outlines || [];
    const outlines = raw.map((o) => o.map(([x, y]) => (wh ? [round(x * wh[0], 3), round(y * wh[1], 3)] : [round(x, 4), round(y, 4)])));
    const parts = wh && raw.map((o) => o.map((pt) => framed(name, v.planUp, pt, wh)));
    return [name, { axes: axesText(name, v.planUp), size: wh && wh.map((s) => round(s, 3)), outlines, frame: wh ? [...FRAME[name]] : null, parts }];
  })) };
}

// ---- what must stay as it was sent
// The score ignores scale and framing, so a model could reach the target by being made bigger, heavier, moved off its origin
// or broken into floating pieces. Each of those is held to round 0's shape (the scorer's `shape`), by its own limit.
const AXIS = ['x', 'up', 'depth'], two = (x) => Math.round(x * 100) / 100;
/** The ways `shape` differs from the shape `base` had, past `limits`: a list of texts, empty when neither shape is known or nothing moved. */
export function drift(base, shape, limits) {
  const out = [];
  if (!base || !shape || !limits) return out;
  if (limits.size && base.longest > 0 && Math.abs(shape.longest - base.longest) / base.longest > limits.size) out.push(`the longest side is ${shape.longest} m, was ${base.longest} m (more than ${two(limits.size * 100)}% off; match.limits.size)`);
  if (limits.triangles && shape.triangles > base.triangles * limits.triangles) out.push(`${shape.triangles} triangles, was ${base.triangles} (more than ${limits.triangles} times; match.limits.triangles)`);
  if (limits.pivot && Array.isArray(base.origin) && Array.isArray(shape.origin)) {
    const a = AXIS.findIndex((_, i) => Math.abs(shape.origin[i] - base.origin[i]) > limits.pivot);
    if (a >= 0) out.push(`the origin moved in the bounding box (${AXIS[a]}: ${two(base.origin[a])} to ${two(shape.origin[a])}; match.limits.pivot)`);
  }
  if (limits.floating && base.floating !== null && base.floating !== undefined && shape.floating !== null && shape.floating !== undefined && shape.floating > base.floating) out.push(`${shape.floating} floating pieces, was ${base.floating} (match.limits.floating)`);
  return out;
}

// ---- when a loop stops
/** The value a round counts for: the job's chosen score. */
export const valueOf = (means, score) => (means ? means[score] ?? means.combined : undefined);

/**
 * Whether a loop goes on after its latest round. `rounds` is status.json's list (round 0 is the model as sent);
 * `consistent` is the reference check's result for the model. Returns { stop: false } or { stop: true, reason, detail }
 * where reason is "target-reached", "out-of-rounds", "plateau" or "held-back" (a round with `drift` can be neither the target nor a plateau; references that disagree with each other
 * are what stands between the model and the target: they are named).
 */
export function decide(loop, rounds, consistent = null, scores = null) {
  const last = rounds[rounds.length - 1];
  if (!last) return { stop: false };
  const done = rounds.length - 1, was = rounds.length > 1 ? rounds[rounds.length - 2] : null;
  const pct = (x) => x.toFixed(2), drifted = last.drift && last.drift.length ? last.drift : null;
  if (drifted) return done >= loop.maxRounds ? { stop: true, reason: 'out-of-rounds', detail: `${done} round${done === 1 ? '' : 's'} used, the mean ${pct(last.mean)}, the target ${pct(loop.target)}. The model drifted from what was sent: ${drifted.join('; ')}` } : { stop: false };
  if (last.mean >= loop.target - 1e-9) return { stop: true, reason: 'target-reached', detail: `the mean ${pct(last.mean)} reached the target ${pct(loop.target)} after ${done} round${done === 1 ? '' : 's'}` };
  const reason = done >= loop.maxRounds ? 'out-of-rounds' : loop.plateau !== null && was && last.mean - was.mean < loop.plateau ? 'plateau' : null;
  if (!reason) return { stop: false };
  const why = reason === 'out-of-rounds' ? `${done} round${done === 1 ? '' : 's'} used, the mean ${pct(last.mean)} is below the target ${pct(loop.target)}` : `round ${last.round} improved the mean by ${pct(Math.max(0, last.mean - was.mean))}, less than ${pct(loop.plateau)}; the mean is ${pct(last.mean)}, the target ${pct(loop.target)}`;
  const flagged = (consistent && consistent.flagged) || [];
  if (flagged.length && scores) {
    const rest = Object.entries(scores).filter(([v]) => !flagged.includes(v)).map(([, s]) => s[loop.score]);
    if (rest.length && rest.reduce((a, b) => a + b, 0) / rest.length >= loop.target - 1e-9) {
      return { stop: true, reason: 'held-back', detail: `held back by references that disagree with each other (${flagged.join(', ')}): the other views average ${pct(rest.reduce((a, b) => a + b, 0) / rest.length)}. ${why}` };
    }
  }
  return { stop: true, reason, detail: why + (flagged.length ? `. Note: the ${flagged.join(', ')} reference${flagged.length === 1 ? '' : 's'} disagree${flagged.length === 1 ? 's' : ''} with the others` : '') };
}

// ---- running the scorer
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const SAFE_NAME = /^(overlay|render)-(front|back|left|right|top|bottom)\.png$/;

/**
 * The matcher of a project: runs the scorer in the background (one at a time), caches its results by the hash of the model,
 * its reference images and the settings, and answers for the page. `spawnImpl` is for tests.
 */
export function createMatcher(project, { spawnImpl = spawn } = {}) {
  const root = join(project.reviewsDir, '.match'), config = normaliseMatch(project.options.match);
  let run = null;                         // { path, key, state: 'running', done, total, text, startedAt, child } while a scorer runs; last failure kept
  let failed = null;
  const memo = new Map();                 // model path -> { stamp, key } : hashing a 25 MB model on every poll would be a waste

  function plan(rel) {
    const file = resolveModel(project.modelsDir, rel);
    if (!file) bad('no such model');
    const refs = modelRefs(project.modelsDir, rel), named = scoredViews(refs), views = Object.keys(named);
    const stamp = [statSync(file).mtimeMs, statSync(file).size, ...refs.map((r) => `${r.name}:${r.size}:${r.mtime}`)].join('|');
    let m = memo.get(rel);
    if (!m || m.stamp !== stamp) {
      const files = Object.fromEntries(views.map((v) => [v, refs.find((r) => r.name === named[v]).file]));
      const key = createHash('sha256').update(JSON.stringify({ v: SCORER_VERSION, scorer: sha(SCORER), model: sha(file), refs: Object.fromEntries(views.map((v) => [v, sha(files[v])])), config: { ...config, limits: undefined } })).digest('hex').slice(0, 32);
      m = { stamp, key, files }; memo.set(rel, m);
    }
    return { file, refs, views, named, files: m.files, key: m.key, dir: join(root, m.key) };
  }
  const readResult = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); } catch { return null; } };

  /** What the page shows for a model: its scoreable views, whether Blender is there, the cached result, any run. */
  function status(rel) {
    const p = plan(rel), blender = findBlender(project.options.blender);
    const out = { views: p.views, references: p.refs.map((r) => r.name), blender: blender ? { found: true } : { found: false, text: blenderMissing(project.options.blender) }, key: p.key, config: { weights: config.weights, upFix: config.upFix, planUp: config.planUp, tolerance: config.tolerance } };
    if (run && run.path === rel && run.state === 'running') return { ...out, state: 'running', progress: { done: run.done, total: run.total, text: run.text }, startedAt: run.startedAt };
    const cached = readResult(p.dir);
    if (cached && cached.ok) return { ...out, state: 'done', result: cached };
    if (failed && failed.path === rel && failed.key === p.key) return { ...out, state: 'failed', error: failed.error };
    return { ...out, state: p.views.length ? 'idle' : 'no-views' };
  }
  /** The cached result for the model as it is now, or null (a job carries it; nothing is run). */
  const cached = (rel) => { const r = readResult(plan(rel).dir); return r && r.ok ? { result: r, dir: plan(rel).dir, key: plan(rel).key } : null; };

  /** Starts scoring `rel` in the background. Resolves with the result (also from the cache) when it ends: { result, dir, key }. */
  function start(rel, { onProgress = () => {} } = {}) {
    const p = plan(rel);
    if (!p.views.length) bad('this model has no front, back, left, right, top or bottom reference to match against');
    const have = cached(rel);
    if (have) return { started: false, done: Promise.resolve(have) };
    if (run && run.state === 'running') bad(`busy: ${run.path} is being matched`, 409);
    const blender = findBlender(project.options.blender);
    if (!blender) bad(blenderMissing(project.options.blender), 409);
    failed = null;
    const tmp = `${p.dir}.tmp`; rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
    const argsFile = join(tmp, 'args.json');
    writeFileSync(argsFile, JSON.stringify({ model: p.file, refs: p.files, outDir: tmp, result: join(tmp, 'result.json'), weights: config.weights, colourFalloff: config.colourFalloff, grid: config.grid, upFix: config.upFix, planUp: config.planUp, fit: config.fit }));
    const mine = run = { path: rel, key: p.key, state: 'running', done: 0, total: 0, text: 'starting Blender', startedAt: Date.now() };
    const done = new Promise((ok, no) => {
      let log = '', buf = '', timer;
      const end = (error, result) => {
        clearTimeout(timer); mine.state = error ? 'failed' : 'done';
        if (error) { failed = { path: rel, key: p.key, error }; rmSync(tmp, { recursive: true, force: true }); return no(Object.assign(new Error(error), { code: 502 })); }
        try { rmSync(p.dir, { recursive: true, force: true }); renameSync(tmp, p.dir); } catch (e) { return no(e); }
        prune(p.key); ok({ result, dir: p.dir, key: p.key });
      };
      // a fixed command: Blender, in the background, with the scorer and one settings file; no shell, no input
      const child = spawnImpl(blender, ['-b', '--factory-startup', '--python', SCORER, '--', argsFile], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, TIMEOUT);
      const take = (d) => {
        log = (log + d).slice(-4000); buf += d;
        for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          const m = /^PROGRESS (\d+)\/(\d+) (.*)$/.exec(line);
          if (m) { mine.done = +m[1]; mine.total = +m[2]; mine.text = m[3].slice(0, 120); onProgress({ done: mine.done, total: mine.total, text: mine.text }); }
        }
      };
      child.stdout.on('data', (d) => take(String(d))); child.stderr.on('data', (d) => take(String(d)));
      child.on('error', (e) => end(`Blender could not be started: ${e.message}`));
      child.on('close', (code) => {
        const result = readResult(tmp);
        if (!result) return end(`Blender stopped (exit ${code}) without a result. ${log.trim().split('\n').slice(-3).join(' | ')}`);
        if (!result.ok) return end(`the scorer could not score this model: ${result.error}`);
        result.consistency = consistency(result.views, config.tolerance);
        result.key = p.key; result.model = rel; result.config = { weights: config.weights, upFix: config.upFix, planUp: config.planUp, colourFalloff: config.colourFalloff, tolerance: config.tolerance };
        writeFileSync(join(tmp, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
        end(null, result);
      });
    });
    done.catch(() => {});                 // the page polls; a caller that awaits it hears the failure itself
    return { started: true, done };
  }
  /**
   * The references of `rel` alone, each traced as outlines of at most `points` points (the scorer's refsOnly with outlines). Resolves
   * with the scorer's result. It is run every time, in a folder of its own that then goes: the scores' cache is neither read nor written.
   */
  function outlines(rel, { points = 40 } = {}) {
    const p = plan(rel);
    if (!p.views.length) bad('this model has no front, back, left, right, top or bottom reference to trace');
    const blender = findBlender(project.options.blender);
    if (!blender) bad(blenderMissing(project.options.blender), 409);
    mkdirSync(root, { recursive: true }); const tmp = mkdtempSync(join(root, 'outlines-')), argsFile = join(tmp, 'args.json');
    writeFileSync(argsFile, JSON.stringify({ refs: p.files, outDir: tmp, result: join(tmp, 'result.json'), refsOnly: true, outlines: points, planUp: ['up', 'right', 'down', 'left'].includes(config.planUp) ? config.planUp : 'up' }));
    return new Promise((ok, no) => {
      let log = '';
      // the same fixed command as a score: Blender, in the background, with the scorer and one settings file; no shell, no input
      const child = spawnImpl(blender, ['-b', '--factory-startup', '--python', SCORER, '--', argsFile], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, TIMEOUT);
      const end = (error, result) => { clearTimeout(timer); rmSync(tmp, { recursive: true, force: true }); return error ? no(Object.assign(new Error(error), { code: 502 })) : ok(result); };
      child.stdout.on('data', (d) => { log = (log + d).slice(-4000); }); child.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
      child.on('error', (e) => end(`Blender could not be started: ${e.message}`));
      child.on('close', (code) => { const result = readResult(tmp); return result ? end(null, result) : end(`Blender stopped (exit ${code}) without a result. ${log.trim().split('\n').slice(-3).join(' | ')}`); });
    });
  }
  /** Keeps the newest KEEP result folders (and never `keep`); stray .tmp folders go. */
  function prune(keep) {
    try {
      const all = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{32}$/.test(e.name)).map((e) => ({ name: e.name, t: statSync(join(root, e.name)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const d of all.slice(KEEP)) if (d.name !== keep) rmSync(join(root, d.name), { recursive: true, force: true });
    } catch { /* nothing to prune */ }
  }
  /** One of a result's pictures, to serve: the real file, or null. Only overlay-<view>.png and render-<view>.png of a result folder. */
  function image(key, name) {
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key) || typeof name !== 'string' || !SAFE_NAME.test(name)) return null;
    const file = join(root, key, name);
    try { return statSync(file).isFile() ? file : null; } catch { return null; }
  }
  // the last values of the slider and its fields, kept per project
  const settingsFile = join(root, 'settings.json');
  const settings = () => { try { return normaliseLoop(JSON.parse(readFileSync(settingsFile, 'utf8'))); } catch { return normaliseLoop({}); } };
  const saveSettings = (input) => { const s = normaliseLoop(input); mkdirSync(root, { recursive: true }); writeFileSync(settingsFile, `${JSON.stringify(s)}\n`); return s; };
  return { status, start, outlines, cached, image, settings, saveSettings, config, plan };
}

export const blenderMissing = (setting) => (typeof setting === 'string' && setting.trim()
  ? `Blender was not found at "${setting.trim()}" (the config's "blender"). Fix that path, or remove it to look on the PATH.`
  : `Blender was not found. Matching a model against its references needs Blender (${BLENDER_DOWNLOAD}): install it, or set "blender" in map-editor.config.mjs to its program.`);
