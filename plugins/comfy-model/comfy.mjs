// What the model service is made of, without the editor: the workflows folder (pipeline.json), where Blender is,
// ComfyUI over HTTP, and the checks that say what is missing. Nothing here starts a process or writes a file.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, posix, resolve, win32 } from 'node:path';

export const PIPELINE_VERSION = 1;
export const BLENDER_DOWNLOAD = 'https://www.blender.org/download/';
const MODEL_FILE = /\.(safetensors|sft|pt|pth|ckpt|bin|gguf|onnx)$/i;
const VIEW_LOADER = /^in_.*_image$/;

/** The workflows folder `dir` as its pipeline.json describes it: { dir, version, multiview (the graph), finish, setup }.
 *  Throws an Error whose message is for the user. */
export function readPipeline(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Set the workflows folder: your checkout of comfy-ui-model-workflows.');
  const root = resolve(dir.trim()), file = resolve(root, 'pipeline.json');
  if (!existsSync(root)) throw new Error(`The workflows folder is not there: ${root}`);
  if (!existsSync(file)) throw new Error(`${root} has no pipeline.json: it is not a checkout of comfy-ui-model-workflows (or an old one).`);
  let p; try { p = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} cannot be read as JSON.`); }
  if (!p || p.pipeline !== 'asset3d') throw new Error(`${file} is not the asset3d pipeline.`);
  if (p.version !== PIPELINE_VERSION) throw new Error(`The workflows folder is version ${p.version}; this editor knows version ${PIPELINE_VERSION}. Update whichever is older.`);
  const inside = (rel, what) => {
    if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`pipeline.json: ${what} must be a path inside the folder.`);
    const at = resolve(root, rel); if (!existsSync(at)) throw new Error(`The workflows folder is missing ${rel}.`);
    return at;
  };
  const finish = inside(p.finish, 'finish');
  let multiview; try { multiview = JSON.parse(readFileSync(inside(p.multiview, 'multiview'), 'utf8')); } catch (e) { throw new Error(/missing|inside/.test(e.message) ? e.message : `${p.multiview} cannot be read as JSON.`); }
  if (!multiview || typeof multiview !== 'object' || Array.isArray(multiview) || !Object.values(multiview).every((n) => n && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object'))
    throw new Error(`${p.multiview} is not a workflow in ComfyUI's API format.`);
  return { dir: root, version: p.version, multiview, finish, setup: typeof p.setup === 'string' && /^https:\/\//.test(p.setup) ? p.setup : null };
}

/** Where Blender is: the setting when it names a file; else on the PATH; else where it is usually installed. Or null. */
export function findBlender(setting, { env = process.env, platform = process.platform, exists = existsSync, list = (d) => readdirSync(d) } = {}) {
  if (typeof setting === 'string' && setting.trim()) return exists(setting.trim()) ? setting.trim() : null;
  const path = platform === 'win32' ? win32 : posix, names = platform === 'win32' ? ['blender.exe'] : ['blender', 'Blender'];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')) for (const n of names) if (dir && exists(path.join(dir, n))) return path.join(dir, n);
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      const home = win32.join(base, 'Blender Foundation'); let versions = [];
      try { versions = list(home).filter((n) => /^Blender/i.test(n)); } catch { /* not installed there */ }
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));   // the newest first
      for (const v of versions) if (exists(win32.join(home, v, 'blender.exe'))) return win32.join(home, v, 'blender.exe');
    }
  } else if (platform === 'darwin' && exists('/Applications/Blender.app/Contents/MacOS/Blender')) return '/Applications/Blender.app/Contents/MacOS/Blender';
  return null;
}

/** ComfyUI at `url`, over HTTP. Every call has a time limit and fails with a sentence that names ComfyUI and the address. */
export function comfy(url) {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/i.test(base)) throw new Error(`ComfyUI's address should look like http://127.0.0.1:8188 (it is "${url}").`);
  async function ask(path, { timeout = 5000, bytes = false, or404 = false, ...options } = {}) {
    let r;
    try { r = await fetch(base + path, { ...options, signal: AbortSignal.timeout(timeout) }); }
    catch (e) { throw new Error(`ComfyUI does not answer at ${base} (${e.name === 'TimeoutError' ? 'no reply in time' : 'nothing is listening, or it refused'}).`); }
    if (or404 && r.status === 404) { await r.arrayBuffer().catch(() => {}); return null; }
    if (bytes) { if (!r.ok) throw new Error(`ComfyUI at ${base} answered ${r.status} for ${path.split('?')[0]}.`); return Buffer.from(await r.arrayBuffer()); }
    const text = await r.text(); let body;
    try { body = JSON.parse(text); } catch { throw new Error(`What answers at ${base} is not ComfyUI (${path.split('?')[0]} did not give JSON).`); }
    if (!r.ok) throw Object.assign(new Error(`ComfyUI at ${base} answered ${r.status} for ${path.split('?')[0]}.`), { status: r.status, body });
    return body;
  }
  return {
    base,
    objectInfo: () => ask('/object_info', { timeout: 15000 }),
    queueLength: async () => { const q = await ask('/queue'); return (q.queue_running || []).length + (q.queue_pending || []).length; },
    /** The node pack's own report (UltraShape's code, packages, checkpoints), or null from a pack too old to have it. */
    asset3dStatus: () => ask('/asset3d/status', { or404: true }),
    /** Puts an image in ComfyUI's input folder; answers the name a LoadImage node takes. */
    upload: async (name, subfolder, data) => {
      const form = new FormData();
      form.set('image', new Blob([data], { type: 'image/png' }), name); form.set('subfolder', subfolder); form.set('type', 'input'); form.set('overwrite', 'true');
      const r = await ask('/upload/image', { method: 'POST', body: form, timeout: 120000 });
      return [r.subfolder, r.name].filter(Boolean).join('/');
    },
    /** Queues a graph: the prompt's id. ComfyUI refusing it (a missing file, a wrong value) is an Error with its reasons. */
    prompt: async (graph) => {
      try { return (await ask('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }), timeout: 60000 })).prompt_id; }
      catch (e) {
        if (!e.body) throw e;
        const why = Object.values(e.body.node_errors || {}).flatMap((n) => (n.errors || []).map((x) => `${n.class_type}: ${x.message}${x.details ? ` (${x.details})` : ''}`));
        throw new Error(`ComfyUI refused the workflow: ${[e.body.error?.message, ...why].filter(Boolean).join('; ').slice(0, 1500) || `status ${e.status}`}`);
      }
    },
    history: async (id) => (await ask(`/history/${encodeURIComponent(id)}`, { timeout: 15000 }))[id] || null,
    view: ({ filename, subfolder = '', type = 'output' }) => ask(`/view?${new URLSearchParams({ filename, subfolder, type })}`, { bytes: true, timeout: 120000 }),
  };
}

const titled = (graph, title) => Object.values(graph).filter((n) => n._meta?.title === title);
/** The node types the graph uses that this ComfyUI does not have. */
export const missingNodes = (graph, info) => [...new Set(Object.values(graph).map((n) => n.class_type))].filter((t) => !Object.hasOwn(info, t)).sort();
/** The model files the graph names that are not among their loader's options: [{ node, input, value }]. */
export function missingModels(graph, info) {
  const out = [];
  for (const node of Object.values(graph)) {
    if (VIEW_LOADER.test(node._meta?.title || '')) continue;   // the views are sent when a model is generated
    const spec = info[node.class_type]?.input; if (!spec) continue;
    const all = { ...(spec.required || {}), ...(spec.optional || {}) };
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string' || !MODEL_FILE.test(value) || !Array.isArray(all[input])) continue;
      const options = Array.isArray(all[input][0]) ? all[input][0] : Array.isArray(all[input][1]?.options) ? all[input][1].options : null;
      if (options && !options.includes(value)) out.push({ node: node.class_type, input, value });
    }
  }
  return out;
}

/** What the model step needs, one by one: [{ id, ok, text, help }], ok true, false, or null (could not be checked). */
export function checksOf({ pipeline, pipelineError, url, info, comfyError, a3d, blender, blenderSetting, ultrashape = true }) {
  const setup = pipeline?.setup || 'https://github.com/idnn-productions/comfy-ui-model-workflows/blob/main/SETUP.md';
  const checks = [];
  checks.push(pipeline ? { id: 'workflows', ok: true, text: `Workflows folder: ${pipeline.dir}`, help: '' }
    : { id: 'workflows', ok: false, text: pipelineError, help: 'Download comfy-ui-model-workflows and set its folder in Settings, under 3D model generation.' });
  checks.push(info ? { id: 'comfy', ok: true, text: `ComfyUI answers at ${url}`, help: '' }
    : { id: 'comfy', ok: false, text: comfyError, help: 'Start ComfyUI, or set its address in Settings.' });
  if (!pipeline || !info) {
    for (const [id, what] of [['nodes', 'The workflow\'s nodes'], ['models', 'The model files']]) checks.push({ id, ok: null, text: `${what}: not checked (${!info ? 'ComfyUI does not answer' : 'no workflows folder'})`, help: '' });
  } else {
    const nodes = missingNodes(pipeline.multiview, info);
    checks.push(nodes.length ? { id: 'nodes', ok: false, text: `ComfyUI is missing node types the workflow uses: ${nodes.join(', ')}`, help: 'Install the node pack from the workflows folder (custom_nodes/) and update ComfyUI, then restart it.' }
      : { id: 'nodes', ok: true, text: 'ComfyUI has every node the workflow uses', help: '' });
    const files = nodes.length ? [] : missingModels(pipeline.multiview, info), bad = files.map((f) => f.value);
    let unknown = false;
    if (ultrashape) {
      const u = a3d?.ultrashape;
      if (!u) unknown = true;
      else { if (!u.code) bad.push('UltraShape\'s code'); if (u.packages?.length) bad.push(`Python packages: ${u.packages.join(', ')}`); if (!u.checkpoints?.length) bad.push('UltraShape\'s checkpoint'); }
    }
    checks.push(bad.length ? { id: 'models', ok: false, text: `Missing in ComfyUI: ${bad.join('; ')}`, help: 'The setup guide says where each file comes from and where it goes.' }
      : nodes.length ? { id: 'models', ok: null, text: 'The model files: not checked (nodes are missing)', help: '' }
        : unknown ? { id: 'models', ok: null, text: 'The model files are there. UltraShape: not checked (update the node pack from the workflows folder and restart ComfyUI)', help: '' }
          : { id: 'models', ok: true, text: ultrashape ? 'The model files and UltraShape are there' : 'The model files are there', help: '' });
  }
  checks.push(blender ? { id: 'blender', ok: true, text: `Blender: ${blender}`, help: '' }
    : { id: 'blender', ok: false, text: blenderSetting ? `Blender is not at ${blenderSetting}` : 'Blender was not found', help: `Install Blender (${BLENDER_DOWNLOAD}), or set where it is in Settings.` });
  return { checks, setup };
}

/** The graph with a draft's inputs set, by node title. views: { front: 'nfgames/x/front.png', … }; poles: top and bottom are used. */
export function setInputs(graph, { views, poles, ultrashape, faces, prefix }) {
  const g = structuredClone(graph);
  const set = (title, input, value) => {
    const nodes = titled(g, title);
    if (nodes.length !== 1 || !Object.hasOwn(nodes[0].inputs, input)) throw new Error(`The workflow has no "${title}" to set (${input}): the workflows folder and this editor do not match.`);
    nodes[0].inputs[input] = value;
  };
  for (const side of ['front', 'left', 'back', 'right']) set(`in_${side}_image`, 'image', views[side]);
  for (const pole of ['top', 'bottom']) set(`in_${pole}_image`, 'image', poles ? views[pole] : views.front);   // a loader needs a file even when unused
  set('in_use_top_bottom_views', 'value', !!poles); set('in_use_ultrashape', 'value', !!ultrashape); set('in_target_faces', 'target_face_count', faces);
  set('out_model', 'filename_prefix', prefix); set('out_preview_textured', 'filename_prefix', `${prefix}_preview_textured`); set('out_preview_clay', 'filename_prefix', `${prefix}_preview_clay`);
  return g;
}

/** What a finished prompt's history entry holds: { ok, error, glb: { filename, subfolder, type } | null }. */
export function outcomeOf(entry) {
  const status = entry?.status || {};
  if (status.status_str !== 'success') {
    const errors = (status.messages || []).filter((m) => m[0] === 'execution_error').map((m) => `${m[1]?.node_type || 'a node'}: ${m[1]?.exception_message || 'failed'}`.trim());
    const stopped = (status.messages || []).some((m) => m[0] === 'execution_interrupted');
    return { ok: false, error: errors.join('; ').slice(0, 1500) || (stopped ? 'it was stopped in ComfyUI' : 'ComfyUI reported an error'), glb: null };
  }
  const files = Object.values(entry.outputs || {}).flatMap((o) => Object.values(o)).filter(Array.isArray).flat();
  const glb = files.find((f) => f && typeof f.filename === 'string' && /\.glb$/i.test(f.filename) && f.type === 'output') || null;
  return { ok: true, error: null, glb };
}
