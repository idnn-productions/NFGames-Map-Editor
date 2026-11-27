// The review inbox: jobs the model viewer writes for a Claude Code session to pick up. A job is a folder under the
// project's `reviews` folder: job.json, a screenshot per pin, the user's reference images and, once a session has it,
// status.json. The model's own references (models.mjs) are named in job.json by their paths, not copied. Every name in it is made here; nothing from the page becomes a path. A job is written to <id>.tmp and
// renamed into place, so a watcher never sees half of one.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { IMAGE_SIGNATURES as SIGNATURES, modelRefs, resolveModel } from './models.mjs';
import { VIEWS, createMatcher, normaliseLoop } from './match.mjs';
import { STOP_REASONS, roundOf } from './matchloop.mjs';

export const LIMITS = { body: 24 * 1024 * 1024, image: 6 * 1024 * 1024, pins: 40, refs: 4, note: 20000, name: 200 };
export const STATES = ['working', 'needs-input', 'done', 'failed'];

/** The workflows a job can name when the project lists none. ComfyUI is a placeholder (todo.md). Blender and Angelo are set up: their words live here and in skills/model-review. */
export const DEFAULT_WORKFLOWS = [
  { id: 'auto', label: 'Auto', description: 'Claude decides how to fix it', enabled: true,
    instructions: 'Decide how to fix it. If this project builds the model (a build script, a .blend, a generator), fix that source and rebuild rather than editing the exported GLB. Otherwise fix it in Blender, or edit the GLB as a last resort. Say which you chose in the summary.' },
  { id: 'blender', label: 'Blender', description: 'Fix the model\'s source with Blender scripts, re-export the GLB', enabled: true,
    instructions: 'Work through Blender, in the background (blender -b <file.blend> --python <script.py>), not by editing the GLB\'s bytes. Find the model\'s source first: a build script in the project (search for the model\'s file name), or a .blend (beside the model, or named by the project). If there is none, create <name>.blend beside the model by importing the GLB, and say so. Make each fix a script kept beside the .blend (<name>.fix-<round>.py), so a round can be re-run. Then re-export the GLB over the model file (glTF binary, +Y up, keeping its materials and textures) and, if textures were baked, re-bake them. Never leave the model file half written: export to a temporary name and rename. Check what you changed in a render before you re-export.' },
  { id: 'angelo', label: 'Angelo', description: 'Drive Angelo\'s agent (Blender 5.3 with its own AI) through its MCP server', enabled: true,
    instructions: 'Hand the work to Angelo\'s agent through the angelo_* MCP tools (angelo_send, angelo_status, angelo_read, angelo_look, angelo_new_chat, angelo_settings, angelo_usage), and supervise it as you would a subagent; you do not edit the scene yourself. Follow the "Angelo" section of the model-review skill: it lists what Angelo 0.1.0 cannot do on its own (it writes only where the person chose a folder, its background bakes cannot write files, it can end its turn while a job still runs, approvals and a busy viewport need the person) and what to do about each. If the angelo_* tools are not available in this session, write failed and say so.' },
  { id: 'comfyui', label: 'ComfyUI', description: 'Regenerate textures or references with a ComfyUI graph', enabled: false, instructions: '' },
];

/** What a match-loop job adds to its instructions: how a round is scored and when to stop. `cli` is the command that runs the editor's scorer. */
export function loopText(match, id, root) {
  const run = `${match.cli} <command> --project ${root}`;
  return [
    `MATCH LOOP. Bring this model's agreement with its reference images up to ${match.target.toFixed(2)} (the ${match.score === 'combined' ? 'combined silhouette and colour score' : 'silhouette score'}, averaged over the views ${match.views.join(', ')}). At most ${match.maxRounds} rounds${match.plateau === null ? '' : `; stop early when a round improves the mean by less than ${match.plateau}`}.`,
    `The editor's scorer measures every round, never you: after each change and re-export, run
  ${run.replace('<command>', 'round')} ${id} --changed <file you changed> --note "<what you changed>"
It scores the model as it is, records the round in status.json and prints the scores and a decision (continue, or stop with the reason). Run once first: ${run.replace('<command>', 'start')} ${id}
The job's current scores are in job.json (match.baseline); the overlay of each view is the job folder's match-0-overlay-<view>.png (the reference, the model's outline in yellow, red where only the reference has something, blue where only the model does). After a round, round-N-overlay-<view>.png.`,
    `Fix what is most wrong first (the lowest views, the largest red or blue areas). When the decision says stop, finish with
  ${run.replace('<command>', 'finish')} ${id} --summary "<what you did>"
If a view's reference disagrees with the others (match.baseline.consistency), that caps what any model can score there: do not bend the model to it; the loop will say it was held back by those references.`,
    `The loop holds the model's size, triangle count, origin and floating pieces to what was sent. \`round\` prints \`drift\`: while it is not empty the round cannot reach the target, so undo that first.`,
  ].join('\n\n');
}

const fail = (text) => { throw new Error(`map editor config: ${text}`); };
const bad = (text) => { throw Object.assign(new Error(text), { code: 400 }); };

/** The config's `reviewWorkflows`: objects, or the id of a default ("auto"). No list: the defaults. */
export function normaliseWorkflows(list, root) {
  if (list === undefined || list === null) return DEFAULT_WORKFLOWS.map((w) => ({ ...w, instructionsFile: null }));
  if (!Array.isArray(list) || !list.length) fail('reviewWorkflows must be a list with at least one workflow');
  const seen = new Set();
  return list.map((w) => {
    if (typeof w === 'string') { const d = DEFAULT_WORKFLOWS.find((x) => x.id === w); if (!d) fail(`no default workflow called "${w}"`); w = d; }
    if (!w || typeof w.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(w.id)) fail(`a review workflow needs an id (lower case): ${JSON.stringify(w)}`);
    if (seen.has(w.id)) fail(`two review workflows are called "${w.id}"`);
    seen.add(w.id);
    let instructionsFile = null;
    if (w.instructionsFile) {
      instructionsFile = resolve(root, w.instructionsFile);
      const r = relative(root, instructionsFile);
      if (r.startsWith('..') || isAbsolute(r)) fail(`workflow "${w.id}": instructionsFile must be inside the project`);
    }
    return { id: w.id, label: w.label || w.id, description: w.description || '', enabled: w.enabled !== false, instructions: w.instructions || '', instructionsFile };
  });
}

/** What the page lists: no file paths. */
export const publicWorkflows = (workflows) => workflows.map(({ id, label, description, enabled }) => ({ id, label, description, enabled }));

/** An image from the page (a data: URL): its extension and bytes, checked by their signature, not their label. */
export function imageFromDataUrl(url, what) {
  const m = typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(url);
  if (!m) bad(`${what}: not a PNG, JPEG or WebP image`);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1], bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > LIMITS.image) bad(`${what}: larger than ${LIMITS.image / 1024 / 1024} MB`);
  if (!SIGNATURES[ext](bytes)) bad(`${what}: its bytes are not a ${ext.toUpperCase()} image`);
  return { ext, bytes };
}

const vec = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const text = (v, max, what) => { if (v === undefined || v === null) return ''; if (typeof v !== 'string' || v.length > max) bad(`${what}: text of at most ${max} characters`); return v; };
const label = (v, what) => (v === undefined || v === null || v === '' ? null : text(v, LIMITS.name, what));

/** A folder-safe name for a model file: "Light Cruiser_v2.glb" → "light-cruiser-v2". */
export const slug = (file) => basename(String(file)).replace(/\.glb$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model';

/** A new job's id: UTC date and time to the second, then the model's slug; "-2", "-3" ... when taken. */
export function jobId(reviewsDir, model, now = new Date()) {
  const iso = now.toISOString(), base = `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, '')}-${slug(model)}`;
  for (let i = 1; ; i++) { const id = i === 1 ? base : `${base}-${i}`; if (!existsSync(join(reviewsDir, id)) && !existsSync(join(reviewsDir, `${id}.tmp`))) return id; }
}

/** Checks a job from the page and writes it under project.reviewsDir. Returns { id }. Throws (code 400) on a bad job. */
export function createReview(project, job, { now = new Date(), matcher = null } = {}) {
  if (!job || typeof job !== 'object') bad('not a job');
  if (!project.modelsDir) bad('this project has no models folder (the config\'s "models")');
  const modelFile = resolveModel(project.modelsDir, job.model);
  if (!modelFile) bad('no such model');
  const workflow = project.reviewWorkflows.find((w) => w.id === job.workflow);
  if (!workflow || !workflow.enabled) bad('no such workflow, or it is not set up yet');
  const pins = Array.isArray(job.pins) ? job.pins : job.pins === undefined ? [] : bad('pins: a list');
  if (pins.length > LIMITS.pins) bad(`at most ${LIMITS.pins} pins`);
  const note = text(job.note, LIMITS.note, 'note');
  const wantsMatch = job.match !== undefined && job.match !== null;
  if (!pins.length && !note.trim() && !wantsMatch) bad('a job needs a pin or a note, or a match target');
  // a match loop: its limits, checked; the model's scores as they are now (the editor's scorer's cached result: measure first)
  let loop = null, scored = null;
  if (wantsMatch) {
    loop = normaliseLoop(job.match);
    matcher = matcher || createMatcher(project);
    scored = matcher.cached(job.model);
    if (!scored) bad('measure the model against its references first (Match, Measure): a loop starts from its current scores');
  }

  const files = [];
  const cleanPins = pins.map((p, i) => {
    const n = i + 1, w = `pin ${n}`;
    if (!p || typeof p !== 'object') bad(`${w}: not a pin`);
    if (!vec(p.position, 3) || !vec(p.normal, 3)) bad(`${w}: position and normal are three numbers each`);
    if (p.uv !== null && p.uv !== undefined && !vec(p.uv, 2)) bad(`${w}: uv is two numbers`);
    const cam = p.camera;
    if (!cam || !vec(cam.position, 3) || !vec(cam.target, 3) || typeof cam.fov !== 'number' || !Number.isFinite(cam.fov)) bad(`${w}: camera needs position, target and fov`);
    const shot = imageFromDataUrl(p.screenshot, `${w} screenshot`);
    files.push([`pin-${n}.${shot.ext}`, shot.bytes]);
    const refs = p.refs === undefined ? [] : Array.isArray(p.refs) ? p.refs : bad(`${w}: refs is a list`);
    if (refs.length > LIMITS.refs) bad(`${w}: at most ${LIMITS.refs} reference images`);
    const refNames = refs.map((r, j) => { const img = imageFromDataUrl(r, `${w} reference ${j + 1}`), name = `pin-${n}-ref-${j + 1}.${img.ext}`; files.push([name, img.bytes]); return name; });
    return { n, note: text(p.note, LIMITS.note, `${w} note`), position: p.position, normal: p.normal, mesh: label(p.mesh, `${w} mesh`), material: label(p.material, `${w} material`), uv: p.uv ?? null, camera: { position: cam.position, target: cam.target, fov: cam.fov }, screenshot: `pin-${n}.${shot.ext}`, refs: refNames };
  });
  let match = null;
  if (loop) {
    const overlays = {};
    for (const v of VIEWS) { const src = join(scored.dir, `overlay-${v}.png`); if (scored.result.views[v] && existsSync(src)) { overlays[v] = `match-0-overlay-${v}.png`; files.push([overlays[v], readFileSync(src)]); } }
    const views = VIEWS.filter((v) => scored.result.views[v]);
    match = { ...loop, views, cli: `node ${join(project.ctx.editorRoot, 'bin', 'match.mjs')}`, baseline: roundOf(0, scored.result, loop, { note: 'the model as it was sent', overlays, at: now.toISOString() }), consistency: scored.result.consistency, warnings: scored.result.warnings || [], blender: scored.result.blender };
    matcher.saveSettings(loop);
  }
  let overview = null;
  if (job.overview) { const img = imageFromDataUrl(job.overview, 'overview'); overview = `overview.${img.ext}`; files.push([overview, img.bytes]); }

  const st = statSync(modelFile);
  // the model's own reference images (<name>.refs/ beside it) are named, not copied: the job stays small and there is one set of them
  const refsDir = project.rel(modelFile).replace(/\.glb$/i, '.refs'), references = modelRefs(project.modelsDir, job.model).map((r) => `${refsDir}/${r.name}`);
  const refText = references.length ? `Reference images of this model (paths from the project root): ${references.join(', ')}. They are what the model was made from: open them, and treat them as the ground truth for what it should look like.` : '';
  const instructions = [workflow.instructions, workflow.instructionsFile && existsSync(workflow.instructionsFile) ? readFileSync(workflow.instructionsFile, 'utf8') : '', refText].filter(Boolean).join('\n\n');
  mkdirSync(project.reviewsDir, { recursive: true });
  const id = jobId(project.reviewsDir, job.model, now), dir = join(project.reviewsDir, id), tmp = `${dir}.tmp`;
  const record = {
    id, createdAt: now.toISOString(),
    model: { path: job.model, file: project.rel(modelFile), sha256: createHash('sha256').update(readFileSync(modelFile)).digest('hex'), size: st.size, mtime: Math.round(st.mtimeMs) },
    note, workflow: { id: workflow.id, label: workflow.label, instructions }, references, overview, pins: cleanPins, match,
  };
  if (match) record.workflow.instructions = [instructions, loopText(match, id, project.root)].join('\n\n');
  try {
    mkdirSync(tmp);
    for (const [name, data] of files) writeFileSync(join(tmp, name), data);
    writeFileSync(join(tmp, 'job.json'), `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, dir);
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  return { id };
}

const readJsonOr = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

/** The finished job folders (no .tmp ones), newest first. */
const jobDirs = (reviewsDir) => (existsSync(reviewsDir)
  ? readdirSync(reviewsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.endsWith('.tmp') && !e.name.startsWith('.') && existsSync(join(reviewsDir, e.name, 'job.json'))).map((e) => e.name).sort().reverse()
  : []);

/** The jobs for the page, newest first: what was asked, and how far a session has got. */
export function listReviews(project, { limit = 50 } = {}) {
  return jobDirs(project.reviewsDir).slice(0, limit).map((id) => {
    const dir = join(project.reviewsDir, id), job = readJsonOr(join(dir, 'job.json'), null);
    if (!job) return { id, state: 'unknown', summary: 'job.json cannot be read', pins: 0, changedFiles: [], modelChanged: false };
    const hasStatus = existsSync(join(dir, 'status.json')), status = hasStatus ? readJsonOr(join(dir, 'status.json'), null) : null;
    const state = !hasStatus ? 'queued' : status && STATES.includes(status.state) ? status.state : 'unknown';
    const file = resolveModel(project.modelsDir, job.model && job.model.path);
    let modelChanged = false;
    if (file) { const s = statSync(file); modelChanged = Math.round(s.mtimeMs) !== job.model.mtime || s.size !== job.model.size; }
    const str = (v) => (status && typeof status[v] === 'string' ? status[v] : '');
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    // the match loop: its limits, and the rounds the editor's scorer recorded (a round's mean, scores per view, what was changed and why)
    const loop = job.match && typeof job.match === 'object' ? { target: job.match.target, maxRounds: job.match.maxRounds, plateau: job.match.plateau, score: job.match.score, views: job.match.views || [] } : null;
    const rounds = status && Array.isArray(status.rounds) ? status.rounds.filter((r) => r && typeof r === 'object' && num(r.mean) !== null).slice(0, 60).map((r) => ({
      round: num(r.round), mean: r.mean, means: r.means && typeof r.means === 'object' ? r.means : null, scores: r.scores && typeof r.scores === 'object' ? r.scores : {},
      changed: Array.isArray(r.changed) ? r.changed.filter((f) => typeof f === 'string').slice(0, 20) : [], note: typeof r.note === 'string' ? r.note : '', flagged: Array.isArray(r.flagged) ? r.flagged : [],
      unchanged: r.unchanged === true, seconds: num(r.seconds), cost: num(r.cost) })) : [];
    return {
      id, createdAt: job.createdAt, model: job.model && job.model.path, note: job.note, workflow: job.workflow && job.workflow.label, pins: (job.pins || []).length,
      state, summary: str('summary'), question: str('question'), updatedAt: str('updatedAt') || null,
      match: loop, rounds, stopReason: STOP_REASONS.includes(str('stopReason')) ? str('stopReason') : '', stopDetail: str('stopDetail'),
      changedFiles: status && Array.isArray(status.changedFiles) ? status.changedFiles.filter((f) => typeof f === 'string') : [], modelChanged,
    };
  });
}

/** For the watcher: ids of jobs waiting for a session (no status.json) that are not in `seen`, oldest first. Adds them to `seen`. */
export function newJobs(reviewsDir, seen) {
  const out = [];
  for (const id of jobDirs(reviewsDir).reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!existsSync(join(reviewsDir, id, 'status.json'))) out.push(id);
  }
  return out;
}
