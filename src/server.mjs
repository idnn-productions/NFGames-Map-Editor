// The map editor's server: a map's plan (<maps>/<name>/layout.json) from above in the browser. Move, turn, size, add
// and remove pieces; move where the player arrives, the people, the things, the walkers' rounds; edit doors' and
// things' words; place plants (plants.json). Save checks the plan against its schema, writes it to a temporary file
// and renames it over the old one, keeping the old one as layout.prev.json. A project's Apply actions run its own
// steps and show their output.
//
// ONLY ON THIS MACHINE: bound to 127.0.0.1, never 0.0.0.0. A request whose Host is not this address is refused (so no
// other site, nor a DNS name pointed here, can read or write a plan), a write must come from this page (Origin) as
// JSON, and a map's name can only be a plain folder name under the maps folder. It serves its one page and its own
// API, no other file. Child processes are started with a fixed list of arguments from the project's config (and a
// checked map name): nothing from a request reaches a shell.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONFIG_NAME, EDITOR_ROOT, loadProject } from './project.mjs';
import { plantEditing } from './plan.mjs';
import { view3d } from './view3d.mjs';
import { checkFit, checkPlants } from './check.mjs';
import { createJobs } from './jobs.mjs';
import { listModels, resolveModel } from './models.mjs';
import { createReview, listReviews, publicWorkflows, LIMITS } from './reviews.mjs';
import { installThree, vendorBase, vendorFile, vendorState } from './vendor.mjs';
import { HOME, addRecent, browse, configTrust, insideHome, recentProjects, trustConfig } from './home.mjs';
import { createEvents } from './events.mjs';
import { createPluginManager } from './plugins/manager.mjs';
import { API_VERSION } from './plugins/manifest.mjs';
import { createVault } from './vault.mjs';
import { createSpend } from './spend.mjs';
import { createServices } from './services.mjs';
import { createRequestLoop } from './requests.mjs';

/** The connected agent, from the watcher's heartbeat: fresh (under 60 s) and its process alive. */
function agentStatus(reviewsDir) {
  try {
    const a = JSON.parse(readFileSync(join(reviewsDir, '.agent.json'), 'utf8'));
    let alive = false; try { process.kill(a.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    return Date.now() - a.at < 60000 && alive ? { connected: true, agent: String(a.agent || 'an agent') } : { connected: false };
  } catch { return { connected: false }; }
}

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };

const MAX_BODY = 2 * 1024 * 1024;
export const HOST = '127.0.0.1';

/** Only this machine's own page: the Host header must be this server's loopback address. */
export const hostAllowed = (host, port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
/** A write must come from this page, as JSON. */
export const writeAllowed = (headers, port) => hostAllowed(headers.host, port) && headers.origin === `http://${headers.host}` && String(headers['content-type'] || '').startsWith('application/json');

/** editor.html with the plant edits it shares with the server (plan.mjs plantEditing) and the 3D view's maths (view3d.mjs) written into it. */
const navHtml = () => readFileSync(join(EDITOR_ROOT, 'src', 'nav.html'), 'utf8');
const importMap = () => JSON.stringify({ imports: { three: `${vendorBase()}build/three.module.js`, 'three/addons/': `${vendorBase()}examples/jsm/` } });
export const page = () => readFileSync(join(EDITOR_ROOT, 'src', 'editor.html'), 'utf8').replace('/*@plantEditing*/ null', () => plantEditing.toString()).replace('/*@view3d*/ null', () => view3d.toString()).replace('<!--@nav-->', navHtml);

/** viewer.html with the import map for the pinned three.js written into it (served from /vendor once installed). */
export const viewerPage = () => readFileSync(join(EDITOR_ROOT, 'src', 'viewer.html'), 'utf8').replace('/*@importmap*/', importMap).replace('<!--@nav-->', navHtml);
/** The workbench (src/shell/index.html) with the import map and the nav bar written in. */
export const shellPage = () => readFileSync(join(EDITOR_ROOT, 'src', 'shell', 'index.html'), 'utf8').replace('/*@importmap*/', importMap).replace('<!--@nav-->', navHtml);
const SHELL = join(EDITOR_ROOT, 'src', 'shell');
/** A file of src/shell for /shell/<rest>: inside that folder, no hidden parts. */
function shellFile(rest) {
  let rel; try { rel = decodeURIComponent(rest); } catch { return null; }
  const f = resolve(SHELL, rel), r = relative(SHELL, f);
  if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep).some((x) => x.startsWith('.')) || rel.includes('\0') || !existsSync(f) || !statSync(f).isFile()) return null;
  return f;
}

/** The plan compiled (when the project compiles) and checked, for the page: nothing is written. */
export async function preview(project, name, plan, plants = undefined, plugins = null) {
  const errors = await project.planErrors(plan, name);
  if (plugins) for (const list of await plugins.runHook('validate', { plan, name })) if (Array.isArray(list)) errors.push(...list.map(String));
  if (plants) errors.push(...(await project.plantsErrors(plants)));
  if (errors.length) return { errors, problems: [], seated: {}, overlays: null, status: null };
  const ctx = project.ctx, kinds = await project.kinds(name, plan), { hooks } = project;
  let built = null;
  if (hooks.compile) {
    try { built = (await hooks.compile({ plan, plants: plants ?? null, name, kinds }, ctx)) || null; } catch (e) { return { errors: [`the compile failed: ${e.message}`], problems: [], seated: {}, overlays: null, status: null }; }
  }
  const problems = [];
  if (project.builtInCheck) {
    problems.push(...checkFit(plan, kinds));
    if (plants && project.plants) problems.push(...checkPlants(plants, plan, kinds, { plantKinds: project.plants.kinds, clearance: project.plants.clearance, tall: project.plants.tall, tallClearance: project.plants.tallClearance }));
  }
  if (plugins) for (const list of await plugins.runHook('check', { plan, plants: plants ?? null, built, name, kinds })) if (Array.isArray(list)) problems.push(...list);
  for (const m of project.modelProblems ? project.modelProblems() : []) problems.push({ kind: 'model', text: `${m.file}: ${m.error} (drawn as 2 x 2 m)`, sel: [], at: null });
  if (hooks.check) problems.push(...((await hooks.check({ plan, plants: plants ?? null, built, name, kinds }, ctx)) || []));
  const status = hooks.status ? (await hooks.status({ plan, plants: plants ?? null, built, name }, ctx)) || [] : null;
  return { errors, problems, seated: (built && built.seated) || {}, overlays: (built && built.overlays) || null, status, log: (built && built.log) || [] };
}

/** The server for `project`. `port` is the one it will listen on (the Host check needs it). */
export function createEditor(initial, { port = initial.port, defaultMap = null, dryRun = false, editorRoot = EDITOR_ROOT, fetchImpl = fetch, home = HOME, stateDir = join(HOME, '.nfgames-editor'), pluginDirs = {}, securityBin = undefined, requestInterval = 2000 } = {}) {
  let project = initial, jobs = createJobs(project, { dryRun }), startMap = defaultMap;
  const events = createEvents();
  const dirs = { builtinDir: join(EDITOR_ROOT, 'plugins'), userDir: join(stateDir, 'plugins'), packagesDir: join(stateDir, 'packages'), ...pluginDirs };
  const providers = new Map(), vault = createVault({ stateDir, ...(securityBin !== undefined ? { securityBin } : {}) }), spend = createSpend({ stateDir });
  const makePlugins = () => createPluginManager({ ...dirs, stateDir, project, jobs, events, providers, log: (...a) => console.error('plugins:', ...a) });
  let plugins = makePlugins();
  const services = createServices({ listPlugins: () => plugins.list(), activate: (id) => plugins.activate(id), providers, vault, spend, events });
  const requestLoop = () => createRequestLoop({ reviewsDir: project.reviewsDir, services, events, interval: requestInterval, agentConnected: () => agentStatus(project.reviewsDir).connected });
  let requests = requestLoop();
  const ready = plugins.fire('onStartup', 'onProject');
  project.ctx.dryRun = dryRun;
  const fallback = () => startMap || project.defaultMap || project.listMaps()[0] || null;
  /** Opens another project folder (inside home). A config not yet trusted is not run: { needsTrust, config }. */
  async function switchProject(root, { trust = false } = {}) {
    const dir = insideHome(home, root);
    if (!dir) throw Object.assign(new Error('only folders in your home folder can be opened'), { code: 400 });
    const running = jobs.current();
    if (running && running.state === 'running') throw Object.assign(new Error(`wait for ${running.kind} to finish`), { code: 409 });
    const t = configTrust(stateDir, dir);
    if (t === 'ask' && !trust) return { needsTrust: true, config: join(dir, CONFIG_NAME) };
    if (t === 'ask') trustConfig(stateDir, dir);
    let next;
    try { next = await loadProject({ root: dir }); } catch (e) { throw Object.assign(new Error(e.message), { code: 400 }); }
    await plugins.close();
    project = next; jobs = createJobs(project, { dryRun }); project.ctx.dryRun = dryRun; startMap = null;
    plugins = makePlugins(); await plugins.fire('onStartup', 'onProject'); events.emit('project/changed', { root: dir });
    requests.stop(); requests = requestLoop();
    addRecent(stateDir, dir);
    return { ok: true, root: dir, maps: project.listMaps() };
  }
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    try {
      if (!hostAllowed(req.headers.host, port)) return send(403, { error: `local only: open http://127.0.0.1:${port}/` });
      const url = new URL(req.url, 'http://x'), path = url.pathname;
      const body = async (limit = MAX_BODY) => {
        const parts = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > limit) { req.resume(); throw Object.assign(new Error('too big'), { code: 413 }); } parts.push(part); }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
      };
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(200, shellPage(), 'text/html; charset=utf-8');
      // the map editor and the model viewer are tabs of the workbench: a browser opening one at the top goes to the
      // workbench with that tab open (?alone keeps the bare page, for scripts); the workbench's own frames get the page
      const topLevel = req.headers['sec-fetch-dest'] === 'document' && !url.searchParams.has('alone');
      const asTab = (view) => { res.writeHead(302, { Location: `/?view=${view}`, 'Cache-Control': 'no-store' }); res.end(); };
      if (req.method === 'GET' && path === '/map') return topLevel ? asTab('map') : send(200, page(), 'text/html; charset=utf-8');
      { const m = req.method === 'GET' && /^\/shell\/(.+)$/.exec(path);
        if (m) { const f = shellFile(m[1]); return f ? send(200, readFileSync(f), TYPES[extname(f)] || 'application/octet-stream') : send(404, { error: 'not here' }); } }
      if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && path === '/viewer') return topLevel ? asTab('viewer') : send(200, viewerPage(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && path.startsWith('/vendor/')) { const f = vendorFile(editorRoot, path); return f ? send(200, readFileSync(f.file), f.type) : send(404, { error: 'not here' }); }
      { const m = req.method === 'GET' && /^\/p\/([a-z0-9.-]+)\/(.+)$/.exec(path);
        if (m) { let rest; try { rest = decodeURIComponent(m[2]); } catch { rest = ''; } const f = rest.includes('\0') ? null : plugins.asset(m[1], rest); return f ? send(200, readFileSync(f), TYPES[extname(f)] || 'application/octet-stream') : send(404, { error: 'not here' }); } }
      if (req.method === 'GET' && path === '/api/maps') return send(200, { maps: project.listMaps(), default: fallback() });
      if (req.method === 'GET' && path === '/api/job') { const job = jobs.current(), from = Math.max(0, Number(url.searchParams.get('from')) || 0); return send(200, job ? { ...job, log: job.log.slice(from), next: job.log.length } : { state: 'idle', log: '', next: 0 }); }
      if (!path.startsWith('/api/')) return send(404, { error: 'not here' });
      if (req.method !== 'GET' && req.method !== 'POST') return send(405, { error: 'GET or POST' });
      if (req.method === 'POST' && !writeAllowed(req.headers, port)) return send(403, { error: 'a write must come from this page, as JSON' });

      // the model viewer and the open project: none of this is about a map
      if (req.method === 'GET' && path === '/api/events') return events.handle(req, res);
      if (req.method === 'GET' && path === '/api/plugins') return send(200, { api: API_VERSION, plugins: plugins.list() });
      if (req.method === 'GET' && path === '/api/services') return send(200, { services: services.list(), vault: vault.where, threshold: spend.threshold() });
      if (req.method === 'GET' && path === '/api/services/requests') return send(200, { requests: requests.pending() });
      if (req.method === 'GET' && path === '/api/agent') return send(200, agentStatus(project.reviewsDir));
      { const m = req.method === 'POST' && /^\/api\/services\/(connect|disconnect|budget|call|requests\/answer)$/.exec(path);
        if (m) { const b = (await body()) || {}; try {
          if (m[1] === 'connect') return send(200, services.connect(b.key, b.name, b.value));
          if (m[1] === 'disconnect') return send(200, services.disconnect(b.key));
          if (m[1] === 'budget') return send(200, services.setBudget(b.key, b.amount ?? null));
          if (m[1] === 'call') return send(200, await services.call(b.key, b.action, b.input, { confirmed: b.confirmed === true }));
          await requests.answer(String(b.id), b.approve === true); return send(200, { ok: true });
        } catch (e) { return send(e.code || 500, { error: e.message }); } } }
      { const m = req.method === 'POST' && /^\/api\/plugins\/([a-z0-9.-]+)\/(trust|enable|disable|reload|activate)$/.exec(path);
        if (m) { try { const [, id, verb] = m; if (verb === 'trust') plugins.trust(id); else if (verb === 'reload') await plugins.reload(id); else if (verb === 'activate') await plugins.activate(id); else await plugins.setEnabled(id, verb === 'enable'); return send(200, { plugins: plugins.list() }); } catch (e) { return send(e.code || 500, { error: e.message, plugins: plugins.list() }); } } }
      { const m = /^\/api\/plugins\/([a-z0-9.-]+)\/settings$/.exec(path);
        if (m) { try { if (req.method === 'GET') return send(200, plugins.getSettings(m[1])); const { key, value } = await body(); return send(200, plugins.setSetting(m[1], key, value)); } catch (e) { return send(e.code || 500, { error: e.message }); } } }
      { const m = /^\/api\/p\/([a-z0-9.-]+)\/(.*)$/.exec(path);
        if (m) { const r = await plugins.route(m[1], req.method, m[2], req, res, () => body()); return send(r.status, r.body); } }
      if (req.method === 'GET' && path === '/api/projects') return send(200, { current: { root: project.root, name: basename(project.root), title: project.options.title || null, maps: project.listMaps().length }, recent: recentProjects(stateDir), home: insideHome(home, home) });
      if (req.method === 'GET' && path === '/api/browse') { try { return send(200, browse(home, url.searchParams.get('path') || home)); } catch (e) { return send(e.code === 400 ? 400 : 500, { error: e.message }); } }
      if (req.method === 'POST' && path === '/api/project') { const b = await body(); try { return send(200, await switchProject(b && b.root, { trust: !!b && b.trust === true })); } catch (e) { return send(e.code || 500, { error: e.message }); } }
      if (req.method === 'GET' && path === '/api/viewer') return send(200, { three: vendorState(editorRoot), models: project.modelsDir ? project.rel(project.modelsDir) || '.' : null, reviews: project.rel(project.reviewsDir), workflows: publicWorkflows(project.reviewWorkflows), title: project.options.title || null });
      if (req.method === 'POST' && path === '/api/vendor/install') { try { return send(200, await installThree(editorRoot, { fetchImpl })); } catch (e) { return send(502, { error: e.message }); } }
      if (req.method === 'GET' && path === '/api/models') return send(200, { models: project.modelsDir ? listModels(project.modelsDir) : [] });
      if (req.method === 'GET' && path === '/api/model') {
        const file = resolveModel(project.modelsDir, url.searchParams.get('path'));
        if (!file) return send(404, { error: 'no such model' });
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' });
        return createReadStream(file).pipe(res);
      }
      if (req.method === 'POST' && path === '/api/review') { const job = await body(LIMITS.body); try { return send(200, createReview(project, job)); } catch (e) { return send(e.code === 400 ? 400 : 500, { error: e.message }); } }
      if (req.method === 'GET' && path === '/api/reviews') return send(200, { reviews: listReviews(project) });

      // everything below is about one map, named in the query: a plain folder name under the maps folder, or the default
      const name = project.knownMap(url.searchParams.get('map') ?? fallback());
      if (!name) return send(400, { error: `no such map (a map is a folder of ${project.rel(project.mapsDir) || '.'}/ with a layout.json; its name is lower-case letters, digits, _ and -)` });

      if (req.method === 'GET' && path === '/api/state') {
        const plan = project.readPlan(name), plants = project.readPlants(name), kinds = await project.kinds(name, plan);
        const actions = Object.values(project.actions).filter((a) => !a.maps || a.maps.includes(name)).map((a) => ({ id: a.id, label: a.label, title: a.title || a.steps.map((s) => s.label).join(', then '), confirm: a.confirm, doneText: a.doneText, heavy: a.steps.some((s) => s.heavy) }));
        const p = project.plants;
        return send(200, {
          name, plan, plants, kinds, dryRun, file: project.rel(project.planFile(name)), plantsFile: plants ? project.rel(project.plantsFile(name)) : null,
          actions, ui: project.ui(name), stamps: project.stamps(name),
          plantKinds: p ? p.kinds : {}, plantLabels: p ? p.labels : {}, plantDraw: p ? p.draw : {}, pointKindOf: p ? (p.pointKindOf || Object.fromEntries(Object.entries(p.kinds).filter(([, [, f]]) => f === 1).reverse().map(([k, [b]]) => [b, k]))) : {},
          plantRules: p ? { excludeRadius: p.excludeRadius, debris: p.debris, follows: p.follows, ruleMade: !!project.hooks.ruleMade } : null,
          ...(await preview(project, name, plan, plants ?? undefined, plugins)),
        });
      }
      if (req.method === 'POST' && path === '/api/preview') { const { plan, plants } = await body(); return send(200, await preview(project, name, plan, plants ?? undefined, plugins)); }
      if (req.method === 'POST' && path === '/api/save') {
        const { plan, plants, stamps } = await body();
        const errors = await project.planErrors(plan, name);
        if (plants !== undefined && plants !== null) { if (!project.plants) errors.push('plants.json: this project has no plants'); else errors.push(...(await project.plantsErrors(plants))); }
        if (errors.length) return send(400, { error: 'not saved: the plan does not pass its schema', errors });
        // a file changed on disk since the page read it (another editor, a hand edit) is not overwritten
        const now = project.stamps(name);
        if (stamps) for (const what of ['layout', 'plants']) if (typeof stamps[what] === 'string' && stamps[what] !== now[what] && (what === 'layout' || plants)) return send(409, { error: `not saved: ${project.rel(what === 'layout' ? project.planFile(name) : project.plantsFile(name))} has changed on disk since this page read it (another editor open, or an edit by hand). Reload the page to see it (your changes here are lost on reload: note them first).` });
        const ctx = project.ctx, hooks = project.hooks;
        if (hooks.beforeSave) await hooks.beforeSave({ name, plan, plants: plants ?? null }, ctx);
        const planChanged = project.writePlan(name, plan).changed;
        const plantsChanged = plants ? project.writePlants(name, plants).changed : false;
        const savedPlan = project.readPlan(name), savedPlants = project.readPlants(name);
        const result = await preview(project, name, savedPlan, savedPlants ?? undefined, plugins);
        if (hooks.afterSave) await hooks.afterSave({ name, plan: savedPlan, plants: savedPlants, changed: planChanged || plantsChanged }, ctx);
        return send(200, { ok: true, changed: planChanged || plantsChanged, planChanged, plantsChanged, bytes: statSync(project.planFile(name)).size, plan: savedPlan, plants: savedPlants, stamps: project.stamps(name), ...result });
      }
      if (req.method === 'GET' && path === '/api/overlay') { // a layer the project draws from its own files: read-only on the page
        const id = url.searchParams.get('id');
        if (typeof id !== 'string' || !Object.hasOwn(project.overlays, id)) return send(400, { error: 'no such overlay' });
        const plan = project.readPlan(name);
        try { return send(200, { id, ...((await project.overlays[id].load({ name, plan }, project.ctx)) || { present: false }) }); } catch (e) { return send(200, { id, present: false, error: e.message }); }
      }
      if (req.method === 'GET' && path === '/api/rule-plants') { // the plants the project's rules made, where its hook says (movable on the page)
        if (!project.hooks.ruleMade) return send(200, { present: false });
        try { return send(200, (await project.hooks.ruleMade({ name, plan: project.readPlan(name) }, project.ctx)) || { present: false }); } catch (e) { return send(200, { present: false, error: e.message }); }
      }
      if (req.method === 'POST' && path === '/api/job') {
        const { job: kind } = await body();
        if (typeof kind !== 'string' || !Object.hasOwn(project.actions, kind)) return send(400, { error: 'no such action' });
        try { const started = jobs.start(kind, name); return send(200, { id: started.id, kind, state: started.state }); } catch (e) { return send(e.code || 500, { error: e.message }); }
      }
      return send(404, { error: 'not here' });
    } catch (e) { send(e.code === 413 ? 413 : e instanceof SyntaxError ? 400 : 500, { error: String(e.message || e) }); }
  });
  Object.defineProperty(server, 'jobs', { get: () => jobs });
  Object.defineProperty(server, 'project', { get: () => project });
  server.switchProject = switchProject;
  Object.defineProperty(server, 'plugins', { get: () => plugins });
  server.events = events; server.ready = ready;
  const closeServer = server.close.bind(server);
  server.close = (cb) => { requests.stop(); events.close(); plugins.close().finally(() => closeServer(cb)); return server; };
  return server;
}
