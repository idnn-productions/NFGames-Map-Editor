// The plugin manager: the open project's plugins, which are trusted and on, and their server parts, loaded on demand
// (an activation event) and undone completely when unloaded. A plugin that fails is turned off alone; the rest go on.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPlugins } from './sources.mjs';
import { pluginTrust, trustPlugin } from './trust.mjs';
import { matchesAny } from './glob.mjs';

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
/** What a route answers with when it sends a project file (api.routes.file): the bytes go out with this type. */
class FileAnswer { constructor(path, type) { this.path = path; this.type = type; } }
// what a browser shows but does not run; anything else is sent as bytes to save
const FILE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };

export function createPluginManager({ builtinDir, userDir, packagesDir, stateDir, project, jobs, events, providers = new Map(), log = () => {} }) {
  let plugins = [];
  const live = new Map(), failures = new Map();
  const disabledFile = join(stateDir, 'plugins-disabled.json'), settingsFile = join(stateDir, 'plugin-settings.json');
  const disabled = () => new Set(readJson(disabledFile, []));

  function refresh() { plugins = discoverPlugins({ builtinDir, userDir, packagesDir, root: project.root }); return plugins; }
  const find = (id) => plugins.find((p) => p.id === id);
  function stateOf(p) {
    if (p.errors.length) return 'invalid';
    if (!p.compatible) return 'incompatible';
    if (disabled().has(p.id)) return 'off';
    if (pluginTrust(stateDir, p) === 'ask') return 'needs-trust';
    if (failures.has(p.id)) return 'failed';
    return live.has(p.id) ? 'active' : 'ready';
  }
  const usable = (p) => !!p && ['ready', 'active'].includes(stateOf(p));

  /** What the page shows about every plugin (no code). */
  function list() {
    return plugins.map((p) => ({
      id: p.id, source: p.source, state: stateOf(p), name: p.manifest?.name || p.id, version: p.manifest?.version || null, needs: p.manifest?.engines?.nfgames || null,
      errors: p.errors, failure: failures.get(p.id) || null, touches: p.manifest?.touches || {}, contributes: p.manifest?.contributes || {},
      activation: p.manifest?.activation || [], web: p.manifest?.web || null,
    }));
  }

  function makeApi(p, rec) {
    const own = (fn) => { rec.disposers.push(fn); return { dispose: fn }; };
    const globs = p.manifest.touches?.files || [], programs = p.manifest.touches?.commands || [];
    const outside = (rel) => new Error(`${p.id}: ${rel} is outside the project`);
    /** Throws unless `at`, or the nearest thing above it that exists, really is in the project (links followed). */
    const reallyInside = (at, rel) => {
      const root = realpathSync(project.root);
      for (let cur = at; ; cur = dirname(cur)) {
        let real = null, there = true;
        try { lstatSync(cur); } catch { there = false; }
        if (there) { try { real = realpathSync(cur); } catch { throw outside(rel); } }   // a link to nowhere: writing it would make its target
        if (real !== null) { if (real !== root && !real.startsWith(root + sep)) throw outside(rel); return; }
        if (dirname(cur) === cur) throw outside(rel);
      }
    };
    /** The path of project file `rel`, which must be declared in touches.files and really in the project. `self: false`
     *  checks the folder it is in and not what it is, for removing a link without following it. */
    const inProject = (rel, { self = true } = {}) => {
      const abs = resolve(project.root, String(rel)), r = relative(project.root, abs);
      if (!r || r.startsWith('..') || isAbsolute(r)) throw outside(rel);
      const path = r.split(sep).join('/');
      if (!matchesAny(path, globs)) throw new Error(`${p.id} did not declare ${path} in touches.files`);
      reallyInside(self ? abs : dirname(abs), rel);
      return abs;
    };
    const defaults = Object.fromEntries(Object.entries(p.manifest.contributes?.settings || {}).map(([k, v]) => [k, v && v.default]));
    const mine = () => readJson(settingsFile, {})[p.id] || {};
    const storage = join(stateDir, 'storage', p.id);
    mkdirSync(storage, { recursive: true });
    return {
      id: p.id, dir: p.dir, version: p.manifest.version,
      project: { root: project.root, name: basename(project.root), options: project.options || {} },
      files: {
        read: (rel, encoding = 'utf8') => readFileSync(inProject(rel), encoding),
        write: (rel, data) => { const f = inProject(rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); },
        exists: (rel) => existsSync(inProject(rel)),
        list: (rel) => readdirSync(inProject(rel)),
        /** Removes a file, or a folder with what is in it. Nothing there is not an error. A link goes; what it points at stays. */
        remove: (rel) => rmSync(inProject(rel, { self: false }), { recursive: true, force: true }),
      },
      jobs: {
        run: (label, steps) => {
          for (const s of steps) if (Array.isArray(s.command) && !programs.includes(basename(s.command[0]))) throw new Error(`${p.id} did not declare ${basename(s.command[0])} in touches.commands`);
          const run = jobs.runSteps({ kind: p.id, label, steps }, { onDone: (j) => events.emit('jobs/done', { id: j.id, kind: j.kind, label: j.label, state: j.state }) });
          events.emit('jobs/started', { id: run.job.id, kind: p.id, label });
          return run;
        },
      },
      routes: {
        get: (path, fn) => { rec.routes.set(`GET ${path}`, fn); return own(() => rec.routes.delete(`GET ${path}`)); },
        post: (path, fn) => { rec.routes.set(`POST ${path}`, fn); return own(() => rec.routes.delete(`POST ${path}`)); },
        /** For a route to return: the project file `rel` itself, sent with its type (an image, JSON, text; else as bytes). */
        file: (rel) => new FileAnswer(inProject(rel), FILE_TYPES[extname(String(rel)).toLowerCase()] || 'application/octet-stream'),
      },
      events: { emit: (name, data) => events.emit(`${p.id}/${name}`, data) },
      services: {
        provide: (service, action, fn) => {
          const k = `${p.id}/${service}/${action}`;
          if (!(p.manifest.contributes?.services || []).some((s) => s.id === service && (s.actions || []).some((a) => a.id === action))) throw new Error(`${p.id}: ${service}/${action} is not declared in plugin.json`);
          providers.set(k, fn); return own(() => { if (providers.get(k) === fn) providers.delete(k); });
        },
      },
      hooks: { on: (name, fn) => { rec.hooks.set(name, [...(rec.hooks.get(name) || []), fn]); return own(() => rec.hooks.set(name, (rec.hooks.get(name) || []).filter((f) => f !== fn))); } },
      settings: {
        get: (k) => (k in mine() ? mine()[k] : defaults[k]),
        set: (k, v) => { const all = readJson(settingsFile, {}); all[p.id] = { ...(all[p.id] || {}), [k]: v }; writeJson(settingsFile, all); },
      },
      storage,
      log: (...a) => log(`[${p.id}]`, ...a),
      onDispose: (fn) => own(fn),
    };
  }

  function undo(rec, id) { for (const d of rec.disposers.splice(0).reverse()) { try { d(); } catch (e) { log(`[${id}] clean-up: ${e.message}`); } } }
  function fail(id, message) {
    failures.set(id, message); log(`[${id}] ${message}`);
    const rec = live.get(id);
    if (rec) { live.delete(id); undo(rec, id); }
    events.emit('plugins/failed', { id, message });
  }
  async function activate(id) {
    const p = find(id);
    if (!usable(p)) throw Object.assign(new Error(`${id} cannot be activated (${p ? stateOf(p) : 'unknown'})`), { code: 409 });
    if (live.has(id)) return live.get(id);
    const rec = { disposers: [], routes: new Map(), hooks: new Map(), deactivate: null };
    live.set(id, rec);
    if (p.manifest.server) {
      try {
        const file = join(p.dir, p.manifest.server);
        const mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
        rec.api = makeApi(p, rec);
        if (typeof mod.activate === 'function') await mod.activate(rec.api);
        rec.deactivate = typeof mod.deactivate === 'function' ? mod.deactivate : null;
      } catch (e) { fail(id, `activate failed: ${e.message}`); throw e; }
    }
    events.emit('plugins/changed', { id, state: 'active' });
    return rec;
  }
  async function deactivate(id) {
    const rec = live.get(id);
    if (!rec) return;
    live.delete(id);
    try { await rec.deactivate?.(); } catch (e) { log(`[${id}] deactivate: ${e.message}`); }
    undo(rec, id);
    events.emit('plugins/changed', { id, state: find(id) ? stateOf(find(id)) : 'gone' });
  }
  /** Activates every usable plugin that lists one of these activation events. */
  async function fire(...names) {
    for (const p of plugins) if (usable(p) && !live.has(p.id) && (p.manifest.activation || []).some((e) => names.includes(e))) { try { await activate(p.id); } catch { /* recorded as failed */ } }
  }
  /** /api/p/<id>/<rest>: activates the plugin if needed ("onRoute") and calls its handler with { query, body }. */
  async function route(id, method, rest, req, res, body) {
    const p = find(id);
    if (!usable(p)) return { status: 404, body: { error: 'no such plugin, or it is not on' } };
    try { await activate(id); } catch (e) { return { status: 500, body: { error: e.message } }; }
    const fn = live.get(id)?.routes.get(`${method} /${rest}`);
    if (!fn) return { status: 404, body: { error: 'not here' } };
    const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams), payload = method === 'POST' ? await body() : undefined;
    try {
      const answer = await fn({ query, body: payload });
      if (answer instanceof FileAnswer) { let isFile = false; try { isFile = statSync(answer.path).isFile(); } catch { /* not there */ } return isFile ? { status: 200, file: { path: answer.path, type: answer.type } } : { status: 404, body: { error: 'not here' } }; }
      return { status: 200, body: answer ?? {} };
    }
    catch (e) {
      if (/did not declare|outside the project/.test(e.message)) return { status: 500, body: { error: e.message } };
      // a refusal the route means (400 to 499 as the error's code) is an answer, not the plugin failing
      if (Number.isInteger(e.code) && e.code >= 400 && e.code < 500) return { status: e.code, body: { error: e.message, ...(e.needsConfirm === true ? { needsConfirm: true } : {}) } }; fail(id, `route /${rest} failed: ${e.message}`); return { status: 500, body: { error: `${id} failed: ${e.message}` } }; }
  }
  /** Runs a hook in every active plugin: their results, in order. A hook that throws turns its plugin off. */
  async function runHook(name, payload) {
    const out = [];
    for (const [id, rec] of [...live]) for (const fn of rec.hooks.get(name) || []) { try { out.push(await fn(payload)); } catch (e) { fail(id, `hook ${name} failed: ${e.message}`); } }
    return out;
  }
  async function setEnabled(id, on) {
    const d = disabled();
    if (on) d.delete(id); else d.add(id);
    writeJson(disabledFile, [...d]); failures.delete(id);
    if (!on) await deactivate(id);
    events.emit('plugins/changed', { id, state: find(id) ? stateOf(find(id)) : 'gone' });
  }
  function trust(id) { const p = find(id); if (!p || !p.manifest) throw Object.assign(new Error('no such plugin'), { code: 404 }); trustPlugin(stateDir, p); failures.delete(id); events.emit('plugins/changed', { id, state: stateOf(p) }); }
  async function reload(id) { await deactivate(id); failures.delete(id); refresh(); return activate(id); }
  async function close() { for (const id of [...live.keys()]) await deactivate(id); }
  /** The file for /p/<id>/<rest>: inside the plugin's own folder, no hidden parts, only for a usable plugin. */
  function asset(id, rest) {
    const p = find(id);
    if (!usable(p) || !p.dir || !rest) return null;
    const f = resolve(p.dir, rest), r = relative(p.dir, f);
    if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep).some((s) => s.startsWith('.')) || !existsSync(f) || !statSync(f).isFile()) return null;
    return f;
  }
  /** A plugin's settings: { schema, values } (the manifest's defaults where nothing was set). */
  function getSettings(id) {
    const p = find(id);
    if (!p || !p.manifest) throw Object.assign(new Error('no such plugin'), { code: 404 });
    const schema = p.manifest.contributes?.settings || {}, saved = readJson(settingsFile, {})[id] || {};
    return { schema, values: Object.fromEntries(Object.entries(schema).map(([k, s]) => [k, k in saved ? saved[k] : s?.default])) };
  }
  /** Sets one setting, checked against its schema (type, and enum when there is one). */
  function setSetting(id, key, value) {
    const { schema } = getSettings(id), s = schema[key], bad = (t) => { throw Object.assign(new Error(t), { code: 400 }); };
    if (!s) bad(`no such setting: ${key}`);
    const type = s.type || typeof s.default;
    if (['number', 'boolean', 'string'].includes(type) && typeof value !== type) bad(`${key} is a ${type}`);
    if (Array.isArray(s.enum) && !s.enum.includes(value)) bad(`${key} is one of ${s.enum.join(', ')}`);
    const all = readJson(settingsFile, {}); all[id] = { ...(all[id] || {}), [key]: value }; writeJson(settingsFile, all);
    events.emit('settings/changed', { id, key });
    return getSettings(id);
  }
  refresh();
  return { refresh, list, activate, deactivate, fire, route, runHook, setEnabled, trust, reload, close, asset, getSettings, setSetting, get plugins() { return plugins; } };
}
