// The review inbox: jobs the model viewer writes for a Claude Code session to pick up. A job is a folder under the
// project's `reviews` folder: job.json, a screenshot per pin, the user's reference images and, once a session has it,
// status.json. The model's own references (models.mjs) are named in job.json by their paths, not copied. Every name in it is made here; nothing from the page becomes a path. A job is written to <id>.tmp and
// renamed into place, so a watcher never sees half of one.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { IMAGE_SIGNATURES as SIGNATURES, modelRefs, resolveModel } from './models.mjs';

export const LIMITS = { body: 24 * 1024 * 1024, image: 6 * 1024 * 1024, pins: 40, refs: 4, note: 20000, name: 200 };
export const STATES = ['working', 'needs-input', 'done', 'failed'];

/** The workflows a job can name when the project lists none. Blender and ComfyUI are placeholders (todo.md). */
export const DEFAULT_WORKFLOWS = [
  { id: 'auto', label: 'Auto', description: 'Claude decides how to fix it', enabled: true,
    instructions: 'Decide how to fix it. If this project builds the model (a build script, a .blend, a generator), fix that source and rebuild rather than editing the exported GLB. Otherwise fix it in Blender, or edit the GLB as a last resort. Say which you chose in the summary.' },
  { id: 'blender', label: 'Blender', description: 'Fix through Blender scripts, re-bake, re-export', enabled: false, instructions: '' },
  { id: 'comfyui', label: 'ComfyUI', description: 'Regenerate textures or references with a ComfyUI graph', enabled: false, instructions: '' },
];

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
export function createReview(project, job, { now = new Date() } = {}) {
  if (!job || typeof job !== 'object') bad('not a job');
  if (!project.modelsDir) bad('this project has no models folder (the config\'s "models")');
  const modelFile = resolveModel(project.modelsDir, job.model);
  if (!modelFile) bad('no such model');
  const workflow = project.reviewWorkflows.find((w) => w.id === job.workflow);
  if (!workflow || !workflow.enabled) bad('no such workflow, or it is not set up yet');
  const pins = Array.isArray(job.pins) ? job.pins : job.pins === undefined ? [] : bad('pins: a list');
  if (pins.length > LIMITS.pins) bad(`at most ${LIMITS.pins} pins`);
  const note = text(job.note, LIMITS.note, 'note');
  if (!pins.length && !note.trim()) bad('a job needs a pin or a note');

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
    note, workflow: { id: workflow.id, label: workflow.label, instructions }, references, overview, pins: cleanPins,
  };
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
    return {
      id, createdAt: job.createdAt, model: job.model && job.model.path, note: job.note, workflow: job.workflow && job.workflow.label, pins: (job.pins || []).length,
      state, summary: str('summary'), question: str('question'), updatedAt: str('updatedAt') || null,
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
