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
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
export const DEFAULTS = { weights: { silhouette: 0.6, colour: 0.4 }, colourFalloff: 0.4, grid: 256, upFix: false, planUp: 'auto', tolerance: 0.05, limits: { size: 0.02, triangles: 1.25, pivot: 0.02, floating: true } };
const TIMEOUT = 15 * 60 * 1000, KEEP = 24;

const fail = (text) => { throw new Error(`map editor config: ${text}`); };
const bad = (text, code = 400) => { throw Object.assign(new Error(text), { code }); };
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** The config's `match` (all optional): { weights: { silhouette, colour }, colourFalloff, grid, upFix, planUp, tolerance, limits: { size, triangles, pivot, floating } }. */
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

/** { checked, flagged: [view], views: { view: { aspect, expected, deviation, flagged } }, warnings: [text] } from the scorer's per-view reference extents. */
export function consistency(views, tolerance = DEFAULTS.tolerance) {
  const eq = [];
  for (const [name, v] of Object.entries(views || {})) {
    if (!v || !Array.isArray(v.refExtent) || !(v.refExtent[0] > 0) || !(v.refExtent[1] > 0)) continue;
    const [h, w] = axesOf(name, v);
    eq.push({ view: name, row: [UNIT[h][0] - UNIT[w][0], UNIT[h][1] - UNIT[w][1]], obs: Math.log(v.refExtent[0] / v.refExtent[1]) });
  }
  if (eq.length < 3) return { checked: false, flagged: [], views: {}, warnings: [], why: 'needs at least three scored views to compare them' };
  const solutions = [];
  for (let i = 0; i < eq.length; i++) for (let j = i + 1; j < eq.length; j++) {
    const [a, b] = [eq[i].row, eq[j].row], det = a[0] * b[1] - a[1] * b[0];
    if (Math.abs(det) < 1e-9) continue;
    const u = [(eq[i].obs * b[1] - eq[j].obs * a[1]) / det, (a[0] * eq[j].obs - b[0] * eq[i].obs) / det];
    const res = eq.map((e) => e.obs - (e.row[0] * u[0] + e.row[1] * u[1]));
    solutions.push({ u, res, cost: res.reduce((s, r) => s + Math.abs(r), 0), rank: TRUST.indexOf(eq[i].view) + TRUST.indexOf(eq[j].view) });
  }
  if (!solutions.length) return { checked: false, flagged: [], views: {}, warnings: [], why: 'these views do not share a size to compare' };
  const best = Math.min(...solutions.map((s) => s.cost)), tied = solutions.filter((s) => s.cost < best + 1e-9).sort((a, b) => a.rank - b.rank), pick = tied[0];
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
  return { checked: true, flagged, views: out, warnings, ambiguous: tied.length > 1 };
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
    writeFileSync(argsFile, JSON.stringify({ model: p.file, refs: p.files, outDir: tmp, result: join(tmp, 'result.json'), weights: config.weights, colourFalloff: config.colourFalloff, grid: config.grid, upFix: config.upFix, planUp: config.planUp }));
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
  return { status, start, cached, image, settings, saveSettings, config, plan };
}

export const blenderMissing = (setting) => (typeof setting === 'string' && setting.trim()
  ? `Blender was not found at "${setting.trim()}" (the config's "blender"). Fix that path, or remove it to look on the PATH.`
  : `Blender was not found. Matching a model against its references needs Blender (${BLENDER_DOWNLOAD}): install it, or set "blender" in map-editor.config.mjs to its program.`);
