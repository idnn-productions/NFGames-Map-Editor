// A project: the folder whose maps the editor edits, and what its config file (map-editor.config.mjs in the
// project's root) says about them. Everything game-specific lives in that config; with none, the defaults below
// make a plain editor of <project>/maps/<name>/layout.json. README.md "Running it against your own project" lists
// every option and hook.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NAME, formatPlan, formatPlants, writeKeeping, fileStamp } from './plan.mjs';
import { checkFile } from './schema.mjs';
import { normaliseWorkflows } from './reviews.mjs';
import { normaliseMatch } from './match.mjs';
import { createModelKinds } from './modelkinds.mjs';
import { listModels, resolveModel } from './models.mjs';

export const EDITOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILT_IN_SCHEMAS = { layout: join(EDITOR_ROOT, 'schemas', 'map.schema.json'), plants: join(EDITOR_ROOT, 'schemas', 'map-plants.schema.json') };
export const CONFIG_NAME = 'map-editor.config.mjs';
export const DEFAULT_PORT = 8793;

/** The classes a kind can be in when the project names none: how it is tagged and coloured in the palette. */
const DEFAULT_CLASSES = {
  piece: { tag: 'piece', colour: '#e9dccb', legend: 'a piece', note: '' },
  mark: { tag: 'mark', colour: '#e58af0', legend: 'a mark: no model, or no known size', note: 'A kind with no known footprint: drawn as 2 x 2 m.' },
  model: { tag: 'model', colour: '#5fc9c0', legend: 'a model from the models folder', note: 'Sized from the model\'s bounds. A kit.json entry of the same name overrides it.' },
};
const DEFAULT_HINTS = { afterSave: { plan: '', plants: '', both: '' }, ring: '', person: 'Who they are and what they say is not in the map.', thing: '', plant: '', round: '' };

const isFn = (f) => typeof f === 'function';
const fail = (text) => { throw new Error(`map editor config: ${text}`); };

/** Reads a kit file: { "<kind>": { size: [w, d, h], boxes?, cls?, door?, group?, solid?, hidden?, across?, mayOverlap?, deck?, label? } }. */
export function readKit(file) {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')), out = {};
  for (const [kind, k] of Object.entries(raw)) if (k && typeof k === 'object' && !Array.isArray(k) && !kind.startsWith('$')) out[kind] = k;
  return out;
}

/** A kind as the editor uses it: every field there, boxes defaulting to the whole footprint. */
export function normaliseKind(k = {}) {
  const size = Array.isArray(k.size) && k.size.length >= 2 ? [k.size[0], k.size[1], k.size[2] ?? 1] : null;
  if (!size) return { size: [2, 2, 2], boxes: [[0, 0, 2, 2]], cls: k.cls || 'mark', unknown: true, solid: false, door: k.door || null, group: k.group || null, hidden: !!k.hidden, label: k.label, ...(k.model ? { model: k.model } : {}) };
  return {
    ...k, size,
    boxes: Array.isArray(k.boxes) ? k.boxes.map((b) => b.slice(0, 4)) : [[0, 0, size[0], size[1]]],
    cls: k.cls || 'piece', door: k.door || null, group: k.group || null, hidden: !!k.hidden, solid: k.solid !== false,
  };
}

/**
 * Loads a project. `root` is the project's folder; `config` a config file (default: <root>/map-editor.config.mjs when
 * there is one), or a config object (tests). Returns the project the server works with.
 */
export async function loadProject({ root = process.cwd(), config = undefined } = {}) {
  root = resolve(root);
  let options = {}, configFile = null;
  if (config && typeof config === 'object') options = config;
  else {
    configFile = config ? resolve(config) : join(root, CONFIG_NAME);
    if (config && !existsSync(configFile)) fail(`no such file: ${configFile}`);
    if (existsSync(configFile)) {
      const mod = await import(`${pathToFileURL(configFile).href}?v=${statSync(configFile).mtimeMs}`); // a changed config is read again
      options = mod.default ?? {};
      if (isFn(options)) options = await options({ root, editorRoot: EDITOR_ROOT });
      if (!options || typeof options !== 'object') fail(`${configFile} must export an object (or a function returning one) as its default`);
    } else configFile = null;
  }
  const at = (p) => (isAbsolute(p) ? p : join(root, p));

  // the model viewer: where the .glb files are, and where review jobs go (both inside the project)
  const inside = (p, what) => { const abs = resolve(root, p), r = relative(root, abs); if (r.startsWith('..') || isAbsolute(r)) fail(`${what} must be a folder inside the project: ${p}`); return abs; };
  const modelsDir = options.models === false || options.models === null ? null : options.models ? inside(options.models, '"models"') : existsSync(join(root, 'models')) ? join(root, 'models') : root;
  const modelKindsOn = options.modelKinds !== false, modelKinds = createModelKinds(modelKindsOn ? modelsDir : null);
  // what the viewer browses: every model of the project, wherever it is kept (models.mjs says which folders are left out).
  // `assets: false` keeps it to the models folder; `assets: { skip, levels }` leaves folders out and names levels.
  const assetsOpt = options.assets;
  if (assetsOpt !== undefined && assetsOpt !== false && (!assetsOpt || typeof assetsOpt !== 'object' || Array.isArray(assetsOpt))) fail('"assets" must be false or { skip, levels }');
  const assetPaths = (key, isOk = () => true) => {
    const list = (assetsOpt && assetsOpt[key]) || [];
    if (!Array.isArray(list) || !list.every((p) => typeof p === 'string' && p && isOk(p))) fail(`"assets.${key}" must be a list of ${key === 'levels' ? '.glb files' : 'folders'} inside the project`);
    return list.map((p) => relative(root, inside(p, `"assets.${key}"`)).split(/[\\/]/).join('/'));
  };
  const assetSkip = assetPaths('skip'), assetLevels = assetPaths('levels', (p) => /\.glb$/i.test(p));
  const assetsDir = assetsOpt === false ? modelsDir : root;
  let assetList = null, assetsAt = 0;
  /** Every model the viewer lists: [{ path (from assetsDir), size, mtime, level? }], looked for again after 2 seconds. */
  function assets() {
    if (!assetsDir) return [];
    if (!assetList || Date.now() - assetsAt > 2000) { assetList = listModels(assetsDir, assetsOpt === false ? {} : { skip: assetSkip, levels: assetLevels }); assetsAt = Date.now(); }
    return assetList;
  }
  /** A model by its path from a request: { file (its real path), path (from assetsDir) }, or null. A path that is not
   *  there is tried under the models folder, where paths were counted from before the viewer browsed the whole project. */
  function resolveAsset(rel) {
    for (const dir of new Set([assetsDir, modelsDir])) {
      const file = dir && resolveModel(dir, rel);
      if (!file) continue;
      const base = realpathSync(assetsDir), path = relative(base, file);
      if (path.startsWith('..') || isAbsolute(path)) continue;
      return { file, path: path.split(/[\\/]/).join('/') };
    }
    return null;
  }
  const reviewsDir = inside(options.reviews || '.review', '"reviews"');
  const reviewWorkflows = normaliseWorkflows(options.reviewWorkflows, root);
  normaliseMatch(options.match);                                   // a mistake in the match settings is found at start
  if (options.blender !== undefined && typeof options.blender !== 'string') fail('"blender" must be the path of the Blender program');

  // where the maps are: the config's, or the first of maps/ and data/maps/ that exists
  const mapsDir = options.maps ? at(options.maps) : [join(root, 'maps'), join(root, 'data', 'maps')].find((d) => existsSync(d)) || join(root, 'maps');
  const schemaFile = options.schema ? at(options.schema) : BUILT_IN_SCHEMAS.layout;
  const plantsCfg = options.plants === false ? null : { kinds: {}, labels: {}, draw: {}, excludeRadius: 0.6, clearance: 0.6, tall: [], tallClearance: 1.0, debris: [], follows: [], ...(options.plants || {}) };
  const plantsSchemaFile = plantsCfg && plantsCfg.schema ? at(plantsCfg.schema) : BUILT_IN_SCHEMAS.plants;
  for (const f of [schemaFile, ...(plantsCfg ? [plantsSchemaFile] : [])]) if (!existsSync(f)) fail(`schema not found: ${f}`);
  const reserved = options.reservedIds instanceof RegExp ? options.reservedIds : null;
  const presets = (options.presets || []).map((p) => {
    if (!p || typeof p.id !== 'string' || typeof p.kind !== 'string' || !/^[a-z][a-z0-9_]*$/.test(p.idPrefix || '')) fail(`a preset needs an id, a kind and an idPrefix (lower case): ${JSON.stringify(p)}`);
    return { label: p.id, group: 'Presets', scale: undefined, colour: '#3fae49', note: '', when: null, ...p };
  });
  const actions = normaliseActions(options.actions || {}, root);
  const overlays = {};
  for (const [id, o] of Object.entries(options.overlays || {})) {
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(id) || !o || !isFn(o.load)) fail(`overlay "${id}" needs a plain id and a load function`);
    overlays[id] = { label: id, on: true, lazy: false, legend: [], ...o };
  }

  const mapDir = (name) => {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`not a map name: ${JSON.stringify(name)}`);
    const dir = join(mapsDir, name);
    if (dirname(dir) !== mapsDir) throw new Error(`not a map name: ${JSON.stringify(name)}`);
    return dir;
  };
  const planFile = (name) => join(mapDir(name), 'layout.json');
  const plantsFile = (name) => join(mapDir(name), 'plants.json');
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const readPlan = (name) => readJson(planFile(name));
  const readPlants = (name) => (plantsCfg && existsSync(plantsFile(name)) ? readJson(plantsFile(name)) : null);
  const listMaps = () => (existsSync(mapsDir) ? readdirSync(mapsDir).filter((n) => NAME.test(n) && statSync(join(mapsDir, n)).isDirectory() && existsSync(join(mapsDir, n, 'layout.json'))).sort() : []);
  /** A map name from a request: a plain folder name with a plan in it, or null. */
  const knownMap = (name) => { if (typeof name !== 'string' || !NAME.test(name)) return null; try { return existsSync(planFile(name)) ? name : null; } catch { return null; } };
  // a path of the project from its root: a file's real path (a model's, say) is measured from the root's real path too, as a temporary folder on macOS is behind a link
  let realRoot = root; try { realRoot = realpathSync(root); } catch { /* not there: the root as given */ }
  const rel = (file) => { for (const base of [root, realRoot]) { const r = relative(base, file); if (!r.startsWith('..') && !isAbsolute(r)) return r.replace(/\\/g, '/'); } return file.replace(/\\/g, '/'); };

  // what every hook gets as its second argument: where things are, and the editor's own helpers (no import of the editor needed)
  const ctx = { root, editorRoot: EDITOR_ROOT, mapsDir, mapDir, planFile, plantsFile, readPlan, readPlants, readJson, rel, formatPlan, formatPlants, fileStamp, dryRun: false };

  /** A piece of a preset (a planter, say): its kind and an id of its series, while the preset applies to the plan. */
  const presetOf = (plan, p) => presets.find((s) => p && s.kind === p.kind && new RegExp(`^${s.idPrefix}\\d+$`).test(p.id) && (!s.when || (plan && plan[s.when.field] === s.when.equals)));

  /** Problems that stop a plan being saved: its schema's, then what a schema cannot say, then the project's own. */
  async function planErrors(layout, name = null) {
    const errors = checkFile(layout, schemaFile);
    if (errors.length || !layout || typeof layout !== 'object') return errors;
    if (name && layout.id !== name) errors.push(`id: the map is "${name}" but its id is "${layout.id}"`);
    const seen = new Set();
    for (const p of [...(layout.pieces || []), ...(layout.marks || [])]) {
      if (seen.has(p.id)) errors.push(`pieces: two are called "${p.id}"`);
      else if (reserved && reserved.test(p.id) && !presetOf(layout, p)) errors.push(`pieces: "${p.id}" is a name kept for things the project's tools make`);
      seen.add(p.id);
    }
    for (const list of ['doors', 'things']) { const ids = new Set(); for (const d of layout[list] || []) { if (ids.has(d.id)) errors.push(`${list}: two are called "${d.id}"`); ids.add(d.id); } }
    for (const d of layout.doors || []) if (d.piece && !seen.has(d.piece)) errors.push(`doors: "${d.id}" hangs on "${d.piece}", which is not a piece`);
    if (!layout.ring && !layout.bounds) errors.push('(top): needs a ring or bounds');
    if (isFn(options.validate)) errors.push(...((await options.validate({ plan: layout, name }, ctx)) || []));
    return errors;
  }
  /** What stops plants.json being saved: its schema. */
  const plantsErrors = async (plants) => checkFile(plants, plantsSchemaFile).map((e) => `plants.json ${e}`);

  /** Every kind a plan can place: the project's (its `kinds` hook, or its kit file), then the plan's own `sizes`. */
  async function kinds(name, plan) {
    let raw = {};
    if (isFn(options.kinds)) raw = (await options.kinds({ name, plan }, ctx)) || {};
    else { const kit = options.kit === undefined ? 'kit.json' : options.kit; if (kit) raw = readKit(at(kit)); }
    // the models folder's .glb files, under the kit's entries of the same name (a kit size without boxes drops the model's box)
    for (const [kind, k] of Object.entries(modelKinds().kinds)) { const own = raw[kind] || {}; raw = { ...raw, [kind]: { ...k, ...own } }; if (own.size && !own.boxes) delete raw[kind].boxes; }
    const out = {};
    for (const [kind, k] of Object.entries(raw)) out[kind] = normaliseKind(k);
    for (const [kind, size] of Object.entries((plan && plan.sizes) || {})) out[kind] = normaliseKind({ ...(raw[kind] || {}), size, boxes: undefined });
    // the palette's groups: the kind's own `group`, else the first of the config's that matches
    const groups = (options.palette && options.palette.groups) || [];
    for (const [kind, k] of Object.entries(out)) if (!k.group) { const g = groups.find((q) => (q.match instanceof RegExp ? q.match.test(kind) : isFn(q.match) ? q.match(kind, k) : false)); if (g) k.group = g.title; }
    return out;
  }

  return {
    root, configFile, mapsDir, schemaFile, plantsSchemaFile, ctx, options,
    modelsDir, assetsDir, assets, resolveAsset, reviewsDir, reviewWorkflows, modelProblems: () => modelKinds().problems,
    port: options.port || DEFAULT_PORT, defaultMap: options.defaultMap || null,
    mapDir, planFile, plantsFile, readPlan, readPlants, listMaps, knownMap, rel,
    planErrors, plantsErrors, kinds, presets, presetOf, actions, overlays, plants: plantsCfg, reserved,
    builtInCheck: options.builtInCheck !== false,
    hooks: { compile: options.compile, check: options.check, status: options.status, beforeSave: options.beforeSave, afterSave: options.afterSave, ruleMade: plantsCfg && plantsCfg.ruleMade },
    writePlan: (name, layout) => writeKeeping(planFile(name), formatPlan(layout), 'layout.prev.json'),
    writePlants: (name, plants) => writeKeeping(plantsFile(name), formatPlants(plants), 'plants.prev.json'),
    stamps: (name) => ({ layout: fileStamp(planFile(name)), plants: fileStamp(plantsFile(name)) }),
    /** What the page needs to know about the project's look and words (all plain data). */
    ui: (name = null) => ({
      classes: { ...DEFAULT_CLASSES, ...(options.classes || {}) },
      groups: ((options.palette && options.palette.groups) || []).map((g) => g.title),
      presets: presets.map(({ id, label, group, kind, scale, idPrefix, colour, note, when }) => ({ id, label, group, kind, scale, idPrefix, colour, note, when })),
      reserved: reserved ? { source: reserved.source, flags: reserved.flags } : null,
      display: { planScale: 1, kindScale: {}, defaultKindScale: 1, attach: {}, wallThickness: 0.6, snap: 0.25, gameLabel: 'in the game', ...((isFn(options.display) ? options.display({ name }) : options.display) || {}) },
      help: Array.isArray(options.help) ? options.help.map((r) => [String(r[0]), String(r[1])]) : [],
      hints: { ...DEFAULT_HINTS, ...(options.hints || {}), afterSave: { ...DEFAULT_HINTS.afterSave, ...((options.hints || {}).afterSave || {}) } },
      overlays: Object.entries(overlays).map(([id, o]) => ({ id, label: o.label, on: !!o.on, lazy: !!o.lazy, legend: o.legend || [] })),
      compileLayers: (options.compileLayers || []).map((l) => ({ id: l.id, label: l.label || l.id, on: l.on !== false, legend: l.legend || [] })),
      plantsOn: !!plantsCfg,
      title: options.title || null,
    }),
  };
}

/**
 * The Apply actions: fixed commands with fixed arguments, from the config only. The one value that can come from a
 * request is a map's name, already checked against NAME and the maps folder, which replaces a whole argument `{map}`.
 */
function normaliseActions(actions, root) {
  const out = {};
  for (const [id, a] of Object.entries(actions)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) fail(`an action's id must be a plain word: ${JSON.stringify(id)}`);
    if (!a || !Array.isArray(a.steps) || !a.steps.length) fail(`action "${id}" needs a list of steps`);
    const steps = a.steps.map((s, i) => {
      const argv = s.node || s.command;
      if (!Array.isArray(argv) || !argv.length || !argv.every((x) => typeof x === 'string')) fail(`action "${id}" step ${i}: "node" or "command" must be a list of strings`);
      if (s.node && s.command) fail(`action "${id}" step ${i}: one of "node" or "command", not both`);
      return { key: s.key || `step${i}`, label: s.label || argv.join(' '), heavy: !!s.heavy, node: !!s.node, argv: [...argv], cwd: s.cwd ? resolve(root, s.cwd) : root };
    });
    out[id] = { id, label: a.label || id, title: a.title || '', confirm: a.confirm || null, maps: Array.isArray(a.maps) ? a.maps : null, doneText: a.doneText || '', steps, hooks: { beforeJob: a.beforeJob, beforeStep: a.beforeStep, afterStep: a.afterStep, afterJob: a.afterJob } };
  }
  return out;
}
