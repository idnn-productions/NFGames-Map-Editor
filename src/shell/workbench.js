// The workbench: the regions, the page half of the plugin API, plugins' page parts loaded on demand, the ⌘K palette,
// the Plugins and Settings screens, and the Jobs, Problems and Output panels. Plugin parts only reach the page through
// the api object they are given; everything they register is undone when they are turned off or reloaded.
import { createRegistry } from './core/registry.js';
import { matches, parseKeys, showKeys } from './core/keys.js';
import { createCommands, rank } from './core/commands.js';
import { createSelection } from './core/selection.js';
import { createDocuments } from './core/documents.js';
import { contributionsOf } from './core/contributions.js';
import { lentFor } from './core/lent.js';
import { createProblems } from './core/problems.js';
import { MIN, RAIL, ROOM, clampWidths, readLayout, writeLayout } from './core/layout.js';
import { h, toast, dialog, confirmDialog } from './ui.js';

const $ = (id) => document.getElementById(id);
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const json = async (url, options) => { const r = await fetch(url, options), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`); return j; };
const post = (url, body = {}) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---- state
let plugins = [], model = contributionsOf([]), activeTool = null, bottomTab = 'core/jobs', jobsRunning = false;
const commands = createCommands(), selection = createSelection(), documents = createDocuments();
const tools = createRegistry(), editors = createRegistry(), panels = createRegistry(), inspectors = createRegistry(), statusItems = createRegistry();
const problems = createProblems(), output = [], listeners = new Map(), loaded = new Map(), declared = [];
const mounted = new Map();   // document id → { el, cleanup }

// ---- events from the host
// EventSource only delivers named events it subscribed to: each name is subscribed the first time someone asks for it;
// '*' hears every event the page is subscribed to (the workbench's own, and any a plugin asked for).
const stream = new EventSource('/api/events'), subscribed = new Set();
function subscribe(name) { if (name === '*' || subscribed.has(name)) return; subscribed.add(name); stream.addEventListener(name, (e) => dispatch(name, JSON.parse(e.data || '{}'))); }
function onEvent(name, fn) { subscribe(name); if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return { dispose: () => listeners.get(name)?.delete(fn) }; }
function dispatch(name, data) { for (const fn of listeners.get(name) || []) try { fn(data); } catch (e) { log(`listener for ${name}: ${e.message}`); } for (const fn of listeners.get('*') || []) try { fn(name, data); } catch { /* a listener's problem */ } }
for (const name of ['plugins/changed', 'plugins/failed', 'jobs/started', 'jobs/done', 'settings/changed', 'project/changed', 'services/changed', 'services/confirm', 'services/started', 'services/done']) subscribe(name);
function log(text) { output.push(`${new Date().toLocaleTimeString()}  ${text}`); if (output.length > 500) output.shift(); if (bottomTab === 'core/output') renderBottom(); }

// ---- the page plugin API, one per plugin
function makeApi(p, rec) {
  const own = (d) => { rec.disposers.push(() => d.dispose()); return d; };
  const full = (id) => (id.includes('/') ? id : `${p.id}/${id}`);
  const reg = (registry) => ({ register: (id, factory) => own(registry.add(`${p.id}/${id}`, factory)) });
  return {
    id: p.id,
    tools: reg(tools), editors: reg(editors), panels: reg(panels), inspectors: reg(inspectors), statusItems: reg(statusItems),
    commands: { register: (id, fn) => own(commands.handle(full(id), fn)), execute: (id, ...a) => commands.execute(full(id), ...a) },
    documents: { open: (o) => documents.open({ ...o, editor: full(o.editor) }), close: documents.close, setDirty: documents.setDirty, setTitle: documents.setTitle },
    fetch: (path, options = {}) => json(`/api/p/${p.id}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }),
    events: { on: (name, fn) => own(onEvent(name, fn)) },
    ui: { toast, dialog, confirm: confirmDialog, palette: openPalette },
    selection: { get: selection.get, set: (type, items) => selection.set(type, items), on: (fn) => own(selection.on(fn)) },
    problems: { set: (list) => { problems.set(p.id, list); own({ dispose: () => problems.drop(p.id) }); } },
    settings: { get: () => json(`/api/plugins/${p.id}/settings`).then((s) => s.values), set: (key, value) => post(`/api/plugins/${p.id}/settings`, { key, value }) },
    three: () => import('three'),
    services: { call: (key, action, input) => callService(key, action, input) },
  };
}

// ---- loading plugins' page parts (and server parts) on demand
async function ensure(id) {
  if (loaded.has(id)) return loaded.get(id);
  const run = (async () => {
    const p = plugins.find((x) => x.id === id);
    if (!p) throw new Error(`no plugin ${id}`);
    await post(`/api/plugins/${id}/activate`);
    const rec = { disposers: [], mod: null };
    if (p.web) { rec.mod = await import(`/p/${id}/${p.web}?v=${Date.now()}`); if (typeof rec.mod.activate === 'function') await rec.mod.activate(makeApi(p, rec)); }
    return rec;
  })();
  loaded.set(id, run);
  try { return await run; } catch (e) { loaded.delete(id); log(`${id}: ${e.message}`); toast(`${id} could not start: ${e.message}`, 'error'); throw e; }
}
async function unload(id) {
  const run = loaded.get(id); if (!run) return; loaded.delete(id);
  const rec = await run.catch(() => null); if (!rec) return;
  try { await rec.mod?.deactivate?.(); } catch (e) { log(`${id} deactivate: ${e.message}`); }
  for (const d of rec.disposers.splice(0).reverse()) try { d(); } catch (e) { log(`${id} clean-up: ${e.message}`); }
}

// ---- the manifests: tools, commands, panels the workbench shows before any plugin code runs
// one refresh at a time, in order: a button's refresh and the host's live event must not race (a stale list would try
// to start a plugin that was just turned off)
let refreshing = Promise.resolve();
function refreshPlugins() { refreshing = refreshing.then(doRefresh, doRefresh); return refreshing; }
async function doRefresh() {
  plugins = (await json('/api/plugins')).plugins;
  for (const id of [...loaded.keys()]) if (!['ready', 'active'].includes(plugins.find((p) => p.id === id)?.state)) await unload(id);
  model = contributionsOf(plugins);
  for (const d of declared.splice(0)) d.dispose();
  for (const c of model.commands) declared.push(commands.declare(c.key, { title: c.title, keys: c.keys, plugin: c.plugin, category: c.category, load: () => ensure(c.plugin) }));
  for (const s of model.statusItems) ensure(s.plugin).catch(() => {});
  render();
}

// ---- core commands
const core = (id, title, fn, keys = null) => { commands.declare(id, { title, keys, category: 'Workbench' }); commands.handle(id, fn); };
core('core/palette', 'Search commands', () => openPalette(), 'Mod+K');
core('core/toggle-side', 'Toggle the side panel', () => togglePanel('side'), 'Mod+B');
core('core/toggle-inspector', 'Toggle the inspector', () => togglePanel('inspector'), 'Mod+I');
core('core/toggle-bottom', 'Toggle the bottom panel', () => togglePanel('bottom'), 'Mod+J');
core('core/toggle-grid', 'Toggle the grids (map and model viewer)', () => window.nfGrid.toggle(), 'Mod+G');
core('core/plugins', 'Plugins: manage', () => documents.open({ title: 'Plugins', editor: 'core/plugins', uri: 'plugins' }));
core('core/settings', 'Settings', () => documents.open({ title: 'Settings', editor: 'core/settings', uri: 'settings' }));
core('core/services', 'Services', () => documents.open({ title: 'Services', editor: 'core/services', uri: 'services' }));
core('core/close-document', 'Close the document', () => { const d = documents.active(); if (d) documents.close(d.id); }, 'Alt+W');
core('core/open-project', 'Open project…', () => document.getElementById('nfOpen')?.click());
core('core/home', 'Home', () => documents.open({ title: 'Home', editor: 'core/home', uri: 'home' }));

// ---- the views in the top bar: Home, and today's map editor and model viewer, each a tab of the workbench
const VIEWS = { home: 'core/home', map: 'nfgames.classic/open-map', viewer: 'nfgames.classic/open-viewer' };
const viewOf = (d) => (!d ? null : d.uri === '/map' ? 'map' : d.uri === '/viewer' ? 'viewer' : d.editor === 'core/home' ? 'home' : null);
function showView(view) { if (VIEWS[view]) commands.execute(VIEWS[view]).catch((e) => toast(e.message, 'error')); }
function renderViews() {
  const shown = viewOf(documents.active()), dirty = new Set(documents.list().filter((d) => d.dirty).map(viewOf));
  for (const b of document.querySelectorAll('#nfnav .view')) { const on = b.dataset.view === shown; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.classList.toggle('dirty', dirty.has(b.dataset.view)); }
}
document.addEventListener('nf:view', (e) => showView(e.detail));
/** The frame of a view's page (the map editor's, the model viewer's), once its tab is there. */
const frameOf = (view) => { const d = documents.list().find((x) => x.uri === `/${view}`), m = d && mounted.get(d.id); return (m && m.el.querySelector('iframe')) || null; };
/** Shows a view's tab and, with a query, takes its page there ('viewer', { model }) unless it is there already. */
async function openView(view, query = null) {
  if (!VIEWS[view]) return;
  await commands.execute(VIEWS[view]);
  if (!query) return;
  const target = `/${view}?${new URLSearchParams(query)}`;
  for (let i = 0; i < 40; i++) {   // the tab's frame is made once its plugin has loaded
    const f = frameOf(view);
    if (f) { let at = null; try { at = f.contentWindow.location.pathname + f.contentWindow.location.search; } catch { /* still loading */ } if (at !== target) f.src = target; return; }
    await new Promise((r) => setTimeout(r, 50));
  }
}
// what the pages in frames ask of the workbench (same origin: they call window.top.nfWorkbench)
window.nfWorkbench = {
  /** A page's problems for the Problems tab: [{ kind, text, error? }]; goTo(index) shows one. An empty list clears. */
  setProblems: (source, list, goTo) => problems.set(String(source), list, goTo),
  openView: (view, query) => openView(view, query).catch((e) => toast(e.message, 'error')),
};

// ---- which panels show: the side panel (tools), the inspector and the bottom panel (Jobs, Problems, Output), each
// hidden or shown from the bar's buttons, its key or the palette, and remembered in this browser
const PANELS = [
  { key: 'side', title: 'Tools panel', cmd: 'core/toggle-side', icon: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M5.5 2.5v11"/>' },
  { key: 'bottom', title: 'Jobs, Problems and Output', cmd: 'core/toggle-bottom', icon: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 9.5h13"/>' },
  { key: 'inspector', title: 'Inspector', cmd: 'core/toggle-inspector', icon: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10.5 2.5v11"/>' },
];
const LAYOUT_KEY = 'nfgames.workbench.hidden';   // the name is from when only the hidden panels were kept
let layout = readLayout(null);
try { layout = readLayout(localStorage.getItem(LAYOUT_KEY)); } catch { /* none kept */ }
const keepLayout = () => { try { localStorage.setItem(LAYOUT_KEY, writeLayout(layout)); } catch { /* not kept: fine */ } };
/** Puts the layout on the page: hidden panels, and the two widths clamped to this window (too narrow: no Inspector). */
function applyLayout() {
  const wb = $('wb'), w = clampWidths(layout, innerWidth);
  for (const p of PANELS) wb.classList.toggle(`no-${p.key}`, layout.hidden.includes(p.key) || (p.key === 'inspector' && !w.inspector));
  wb.style.setProperty('--side-w', `${w.side}px`); wb.style.setProperty('--inspector-w', `${w.inspector}px`);
}
/** Hides or shows a panel. The bottom panel "hidden" rests as a strip of its tabs. */
function togglePanel(key, hide = !layout.hidden.includes(key)) {
  layout.hidden = PANELS.map((p) => p.key).filter((k) => (k === key ? hide : layout.hidden.includes(k)));
  keepLayout(); applyLayout(); renderLayout(); if (key === 'bottom') renderBottom();
}
addEventListener('resize', applyLayout);
// the side panel's and the Inspector's inner edges drag to set their widths
for (const [id, key] of [['sideGrip', 'side'], ['inspectorGrip', 'inspector']]) {
  const grip = $(id);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId); $('wb').classList.add('dragging');   // frames would swallow the moves
    const other = key === 'side' ? 'inspector' : 'side', shown = clampWidths(layout, innerWidth);
    const most = innerWidth - RAIL - ROOM - (layout.hidden.includes(other) ? 0 : shown[other]);   // the other panel keeps its width, the documents their room
    const move = (ev) => { layout[key] = Math.max(MIN, Math.min(most, Math.round(key === 'side' ? ev.clientX - RAIL : innerWidth - ev.clientX))); applyLayout(); };
    const up = () => { grip.removeEventListener('pointermove', move); $('wb').classList.remove('dragging'); keepLayout(); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true }); grip.addEventListener('pointercancel', up, { once: true });
  });
}
function renderLayout() {
  const g = h('button', { title: `${window.nfGrid.get() ? 'Hide' : 'Show'} the grids in every view (${showKeys(parseKeys('Mod+G', { mac }), { mac })})`, onclick: () => window.nfGrid.toggle() });
  g.setAttribute('aria-label', 'Grids'); g.setAttribute('aria-pressed', String(window.nfGrid.get()));
  g.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.5 5.5h13M1.5 10.5h13M5.5 1.5v13M10.5 1.5v13"/></svg>';
  $('layout').replaceChildren(g, h('span', { className: 'layout-sep' }), ...PANELS.map((p) => {
    const shown = !layout.hidden.includes(p.key), c = commands.list().find((x) => x.id === p.cmd);
    const b = h('button', { title: `${p.key === 'bottom' ? (shown ? 'Close' : 'Open') : shown ? 'Hide' : 'Show'} the ${p.title.toLowerCase()}${c && c.keys ? ` (${showKeys(parseKeys(c.keys, { mac }), { mac })})` : ''}`, onclick: () => togglePanel(p.key) });
    b.setAttribute('aria-label', p.title); b.setAttribute('aria-pressed', String(shown));
    b.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${p.icon}</svg>`;
    return b;
  }));
}
applyLayout();
renderLayout();
window.nfGrid.onChange(renderLayout);

// ---- rendering
function render() { renderActivity(); renderSide(); renderDocs(); renderInspector(); renderBottom(); renderStatus(); }

function renderActivity() {
  // the shown tool's button hides or shows the side panel; another tool's shows it with that tool
  const btn = (t) => h('button', { className: `act${activeTool === t.key ? ' on' : ''}`, textContent: t.icon, title: t.title, onclick: () => (activeTool === t.key ? togglePanel('side') : setTool(t.key)) });
  // the views first (the same as the top bar's): lit while shown; the shown one's button hides or shows the side panel
  const shown = !activeTool && viewOf(documents.active());
  const view = (key, icon, title) => h('button', { className: `act${shown === key ? ' on' : ''}`, textContent: icon, title, onclick: () => (shown === key ? togglePanel('side') : (activeTool = null, togglePanel('side', false), showView(key))) });
  $('activityTools').replaceChildren(view('map', '🗺', 'Map editor'), view('viewer', '🧊', 'Model viewer'), ...(model.tools.length ? [h('hr', { className: 'act-sep' })] : []), ...model.tools.map(btn));
  $('activityCore').replaceChildren(btn({ key: 'core/services', icon: '🔌', title: 'Services' }), btn({ key: 'core/plugins', icon: '🧩', title: 'Plugins' }), btn({ key: 'core/settings', icon: '⚙', title: 'Settings' }));
}
async function setTool(key) {
  activeTool = key; renderActivity();
  if (key === 'core/plugins' || key === 'core/settings' || key === 'core/services') { activeTool = null; renderActivity(); return commands.execute(key); }
  const t = model.tools.find((x) => x.key === key);
  if (t) { togglePanel('side', false); renderSide(); try { await ensure(t.plugin); } catch { return; } }
  renderSide();
}
// The side panel shows the selected item: a tool picked in the rail, else the shown tab's own panel (the map editor's
// pieces, Show, Legend and Keys; the model viewer's models), which its page lends while the tab is shown.
let sideCleanup = null;
/** What the shown tab's page lends (see lend.js), by region; null when the tab is not a page or lends nothing. */
function lentParts() {
  const d = documents.active(), m = d && mounted.get(d.id), f = m && m.el.querySelector('iframe');
  try { return (f && f.contentWindow && f.contentWindow.__nfLent) || null; } catch { return null; }
}
const lent = (region) => lentFor(region, { activeTool, frame: lentParts() });
/** Shows a lent part in a region's body, once: drawing the region again leaves a part that is already there alone. */
const shownLent = { inspector: null, bottom: null };
function showLent(region, part, body) {
  if (shownLent[region] === part) return;
  hideLent(region);
  body.classList.add('flush');
  const host = h('div', { className: 'lent' }); body.replaceChildren(host);
  try { part.mount(host); shownLent[region] = part; } catch (e) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: `${part.title}: ${e.message}` })); }
}
function hideLent(region) {
  const part = shownLent[region]; if (!part) return;
  shownLent[region] = null;
  try { part.unmount(); } catch { /* its tab is gone */ }
  $(region === 'inspector' ? 'inspectorBody' : 'bottomBody').classList.remove('flush');
}
function renderSide() {
  if (typeof sideCleanup === 'function') sideCleanup(); sideCleanup = null;
  const t = model.tools.find((x) => x.key === activeTool), body = $('sideBody');
  $('sideTitle').textContent = t ? t.title : 'Tools'; body.classList.remove('flush');
  const part = lent('side');
  if (part) {
    $('sideTitle').textContent = part.title; body.classList.add('flush');
    const host = h('div', { className: 'lent' }); body.replaceChildren(host);
    try { part.mount(host); sideCleanup = () => { try { part.unmount(); } catch { /* its tab is gone */ } }; } catch (e) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: `${part.title}: ${e.message}` })); }
    return;
  }
  if (!t) {
    const d = documents.active(); if (d) $('sideTitle').textContent = d.title;
    body.replaceChildren(h('p', { className: 'nf-muted', textContent: d ? `${d.title} has nothing to show here.${model.tools.length ? ' Tools are on the left.' : ''}` : model.tools.length ? 'Pick a tool on the left.' : 'Pick a view in the bar above.' }));
    return;
  }
  const factory = tools.get(t.key);
  if (!factory) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: loaded.has(t.plugin) ? `${t.title} has no side panel.` : 'Loading…' })); return; }
  body.replaceChildren(); try { sideCleanup = factory(body, {}); } catch (e) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: `${t.title} failed: ${e.message}` })); }
}
tools.onChange(renderSide);

function renderDocs() {
  const docs = documents.list(), active = documents.active();
  $('tabs').replaceChildren(...docs.map((d) => h('div', { className: `doc-tab${active && d.id === active.id ? ' on' : ''}${d.dirty ? ' dirty' : ''}`, title: d.uri || d.title, onclick: () => documents.focus(d.id) },
    h('span', { textContent: d.title }), h('span', { className: 'x', textContent: '✕', onclick: (e) => { e.stopPropagation(); documents.close(d.id); } }))));
  for (const [id, m] of mounted) if (!docs.some((d) => d.id === id)) { if (typeof m.cleanup === 'function') m.cleanup(); m.el.remove(); mounted.delete(id); }
  for (const d of docs) if (!mounted.has(d.id)) mountDoc(d);
  for (const [id, m] of mounted) m.el.hidden = !active || id !== active.id;
  if (!docs.length && !$('docBody').querySelector('.nf-empty')) $('docBody').append(h('div', { className: 'nf-empty', textContent: 'Open something from a tool, or press ⌘K.' }));
  if (docs.length) $('docBody').querySelector(':scope > .nf-empty')?.remove();
}
async function mountDoc(d) {
  const el = h('div', { className: 'doc-pane' }); $('docBody').append(el); const m = { el, cleanup: null }; mounted.set(d.id, m);
  if (d.editor === 'core/plugins') { m.cleanup = renderPluginsScreen(el); return; }
  if (d.editor === 'core/settings') { m.cleanup = renderSettingsScreen(el); return; }
  if (d.editor === 'core/services') { m.cleanup = renderServicesScreen(el); return; }
  if (d.editor === 'core/home') { renderHomeScreen(el); return; }
  const owner = d.editor.split('/')[0];
  if (!editors.has(d.editor)) { el.append(h('p', { className: 'nf-empty', textContent: 'Loading…' })); try { await ensure(owner); } catch { return; } }
  const factory = editors.get(d.editor);
  el.replaceChildren();
  if (!factory) { el.append(h('p', { className: 'nf-empty', textContent: `No editor ${d.editor}.` })); return; }
  try { m.cleanup = factory(el, d); } catch (e) { el.append(h('p', { className: 'nf-empty', textContent: `${d.editor} failed: ${e.message}` })); }
}
// a newly shown tab takes the side panel back from a rail tool: the panel follows what is selected
let shownDoc = null;
documents.on(() => {
  renderDocs(); renderStatus(); renderViews();
  for (const view of ['map', 'viewer']) if (!documents.list().some((d) => d.uri === `/${view}`)) problems.drop(view);   // a closed page's problems go with it
  const now = documents.active()?.id ?? null;
  if (now !== shownDoc) { shownDoc = now; activeTool = null; renderActivity(); renderSide(); renderInspector(); renderBottom(); }
});
document.addEventListener('nf:panel', () => { if (!activeTool) renderSide(); renderInspector(); renderBottom(); });
document.addEventListener('nf:title', () => { const i = lent('inspector'); if (i) $('inspectorTitle').textContent = i.title; renderBottom(); });
// Home: a place to start, for now
async function renderHomeScreen(el) {
  const p = (await json('/api/projects').catch(() => ({ current: {} }))).current;
  el.append(h('div', { className: 'home' }, h('h1', { textContent: p.title || p.name || 'Home' }), h('p', { className: 'nf-muted', textContent: p.root || '' }),
    h('p', { textContent: 'Pick a view in the bar above, a tool on the left, or press ⌘K.' }),
    h('div', { className: 'actions' }, h('button', { className: 'nf-btn', textContent: 'Map editor', onclick: () => showView('map') }), h('button', { className: 'nf-btn', textContent: 'Model viewer', onclick: () => showView('viewer') }))));
}

let inspectorCleanups = [];
function renderInspector() {
  const sel = selection.get(), body = $('inspectorBody'), part = lent('inspector');
  // the shown page's own part (the map's Selected, the viewer's review) takes the Inspector while its tab is shown
  $('inspectorTitle').textContent = part ? part.title : 'Inspector';
  if (part) { for (const c of inspectorCleanups.splice(0)) if (typeof c === 'function') c(); showLent('inspector', part, body); return; }
  hideLent('inspector');
  for (const c of inspectorCleanups.splice(0)) if (typeof c === 'function') c();
  if (!sel.type) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: 'Nothing selected.' })); return; }
  const wanted = model.inspectors.filter((i) => i.for === sel.type);
  body.replaceChildren(h('p', { className: 'nf-muted', textContent: `${sel.items.length} selected (${sel.type})` }));
  for (const i of wanted) {
    const box = h('nf-panel', { title: i.title }); body.append(box);
    const show = () => { const f = inspectors.get(i.key); if (f) { const inner = box.querySelector('.nf-panel-body') || box; inner.replaceChildren(); inspectorCleanups.push(f(inner, sel)); } };
    if (inspectors.has(i.key)) show(); else ensure(i.plugin).then(show).catch(() => {});
  }
}
selection.on(() => { renderInspector(); renderStatus(); });

function renderBottom() {
  const strip = layout.hidden.includes('bottom');
  const tabs = [{ key: 'core/jobs', title: `Jobs${jobsRunning ? ' ●' : ''}` }, { key: 'core/problems', title: `Problems${countProblems() ? ` (${countProblems()})` : ''}` }, { key: 'core/output', title: 'Output' }, ...model.panels.filter((p) => p.region === 'bottom')];
  const part = lent('bottom'), lentKey = part && `lent/${part.key}`;
  if (part) tabs.push({ key: lentKey, title: part.title });
  if (bottomTab.startsWith('lent/') && bottomTab !== lentKey) bottomTab = 'core/jobs';   // that page's tab is no longer shown
  if (bottomTab !== lentKey || !part) hideLent('bottom');
  $('bottomTabs').replaceChildren(...tabs.map((t) => h('span', { className: `nf-tab${!strip && bottomTab === t.key ? ' on' : ''}`, textContent: t.title, title: strip ? `Open ${t.title}` : bottomTab === t.key ? 'Close the panel' : '',
    onclick: () => { if (!strip && bottomTab === t.key) return togglePanel('bottom', true); bottomTab = t.key; if (strip) togglePanel('bottom', false); else renderBottom(); } })));
  const body = $('bottomBody');
  if (part && bottomTab === lentKey) return showLent('bottom', part, body);
  if (bottomTab === 'core/jobs') return renderJobs(body);
  if (bottomTab === 'core/problems') {
    const all = problems.all();
    body.replaceChildren(all.length ? h('ul', { className: 'nf-log nf-problems' }, ...all.map((p) => h('li', { className: `${problems.canGo(p) ? 'go' : ''}${p.error ? ' error' : ''}`, title: problems.canGo(p) ? 'click to show it' : '', onclick: () => problems.go(p) },
      h('b', { textContent: `${p.kind || 'problem'} ` }), p.text, h('span', { className: 'nf-muted', textContent: `  ${p.source}` })))) : h('p', { className: 'nf-muted', textContent: 'No problems.' }));
    return;
  }
  if (bottomTab === 'core/output') { body.replaceChildren(h('pre', { className: 'nf-log', textContent: output.join('\n') || 'Nothing yet.' })); return; }
  const panel = model.panels.find((p) => p.key === bottomTab);
  if (!panel) { bottomTab = 'core/jobs'; return renderBottom(); }
  const mount = () => { const f = panels.get(panel.key); body.replaceChildren(); if (f) f(body, {}); else body.append(h('p', { className: 'nf-muted', textContent: 'Nothing to show.' })); };
  if (panels.has(panel.key)) mount(); else { body.replaceChildren(h('p', { className: 'nf-muted', textContent: 'Loading…' })); ensure(panel.plugin).then(mount).catch(() => {}); }
}
const countProblems = () => problems.count();
problems.on(() => { renderStatus(); renderBottom(); });
async function renderJobs(body) {
  const j = await json('/api/job').catch(() => null);
  if (bottomTab !== 'core/jobs') return;
  if (!j || j.state === 'idle') { body.replaceChildren(h('p', { className: 'nf-muted', textContent: 'No job has run yet.' })); return; }
  body.replaceChildren(h('p', {}, h('nf-tag', { textContent: j.state, tone: j.state === 'done' ? 'ok' : j.state === 'failed' ? 'error' : 'accent' }), ` ${j.label || j.kind}`), ...(j.state === 'running' ? [h('nf-progress')] : []), h('pre', { className: 'nf-log', textContent: j.log }));
  for (const t of body.querySelectorAll('nf-tag')) t.setAttribute('tone', t.tone);
}

function renderStatus() {
  const sel = selection.get(), doc = documents.active();
  $('statusLeft').replaceChildren(h('span', { textContent: doc ? `${doc.title}${doc.dirty ? ' · unsaved' : ''}` : 'No document' }), ...(sel.items.length ? [h('span', { textContent: `${sel.items.length} selected` })] : []), ...(countProblems() ? [h('span', { textContent: `⚠ ${countProblems()}` })] : []));
  const right = $('statusRight'); right.replaceChildren();
  for (const s of model.statusItems) { const f = statusItems.get(s.key); if (!f) continue; const el = h('span'); right.append(el); try { f(el, {}); } catch (e) { el.textContent = `${s.plugin}: ${e.message}`; } }
  right.append(h('span', { textContent: mac ? '⌘K commands' : 'Ctrl+K commands' }));
}
statusItems.onChange(renderStatus);
panels.onChange(() => { if (model.panels.some((p) => p.key === bottomTab)) renderBottom(); });

// ---- Plugins and Settings screens
function renderPluginsScreen(el) {
  const draw = () => {
    const page = h('div', { className: 'doc-page' }, h('h2', { textContent: 'Plugins' }), h('p', { className: 'nf-muted', textContent: 'Built-in plugins are trusted. Every other plugin runs only once you trust it, and asks again when it changes.' }));
    for (const p of plugins) {
      const tone = { active: 'ok', ready: 'ok', 'needs-trust': 'warn', off: '', failed: 'error', invalid: 'error', incompatible: 'warn' }[p.state] || '';
      const act = async (verb) => { try { await post(`/api/plugins/${p.id}/${verb}`); if (verb !== 'trust') await unload(p.id); await refreshPlugins(); draw(); } catch (e) { toast(e.message, 'error'); } };
      const buttons = [];
      if (p.state === 'needs-trust') buttons.push(h('button', { className: 'nf-btn primary', textContent: 'Trust…', onclick: async () => {
        const body = h('div', {}, h('p', { textContent: `${p.name} ${p.version} (${p.source}) runs with your rights once trusted.` }), h('p', { textContent: `Touches: ${JSON.stringify(p.touches)}` }), h('p', { textContent: `Adds: ${Object.entries(p.contributes || {}).map(([k, v]) => `${k} (${Array.isArray(v) ? v.length : Object.keys(v).length})`).join(', ') || 'nothing'}` }));
        if (await confirmDialog(`Trust ${p.name}?`, body, 'Trust it')) act('trust');
      } }));
      if (['ready', 'active', 'failed', 'needs-trust'].includes(p.state)) buttons.push(h('button', { className: 'nf-btn', textContent: 'Turn off', onclick: () => act('disable') }));
      if (p.state === 'off') buttons.push(h('button', { className: 'nf-btn', textContent: 'Turn on', onclick: () => act('enable') }));
      if (['active', 'failed'].includes(p.state)) buttons.push(h('button', { className: 'nf-btn', textContent: 'Reload', onclick: () => act('reload') }));
      page.append(h('div', { className: 'plugin-row' }, h('header', {}, h('b', { textContent: `${p.name} ` }, h('span', { className: 'nf-muted', textContent: `${p.id} ${p.version || ''} · ${p.source}` })), h('nf-tag', { textContent: p.state, tone }), ...buttons),
        ...(p.errors.length ? [h('div', { className: 'why', textContent: p.errors.join('; ') })] : []), ...(p.failure ? [h('div', { className: 'why', textContent: p.failure })] : []),
        ...(p.state === 'incompatible' ? [h('div', { className: 'why', textContent: `needs editor plugin API ${p.needs}` })] : [])));
    }
    for (const t of page.querySelectorAll('nf-tag')) if (t.tone) t.setAttribute('tone', t.tone);
    el.replaceChildren(page);
  };
  draw(); const sub = onEvent('plugins/changed', () => refreshPlugins().then(draw)); return () => sub.dispose();
}
function renderSettingsScreen(el) {
  const page = h('div', { className: 'doc-page' }, h('h2', { textContent: 'Settings' }));
  if (!model.settings.length) page.append(h('p', { className: 'nf-muted', textContent: 'No plugin has settings.' }));
  for (const s of model.settings) {
    const box = h('nf-panel', { title: s.name }); page.append(box);
    json(`/api/plugins/${s.plugin}/settings`).then(({ schema, values }) => {
      const inner = box.querySelector('.nf-panel-body') || box;
      for (const [key, def] of Object.entries(schema)) {
        const save = (value) => post(`/api/plugins/${s.plugin}/settings`, { key, value }).then(() => toast(`Saved ${def.title || key}`)).catch((e) => toast(e.message, 'error'));
        const type = def.type || typeof def.default, title = def.title || key;
        let field;
        if (Array.isArray(def.enum)) { field = h('nf-select'); field.setAttribute('label', title); field.options = def.enum.map((v) => ({ value: String(v) })); field.value = String(values[key]); field.addEventListener('change', () => save(type === 'number' ? Number(field.value) : field.value)); }
        else if (type === 'boolean') { const box2 = h('input', { type: 'checkbox', checked: !!values[key], onchange: () => save(box2.checked) }); field = h('nf-field', {}, box2); field.setAttribute('label', title); }
        else if (type === 'number') { field = h('nf-number'); field.setAttribute('label', title); field.setAttribute('value', values[key]); field.addEventListener('change', () => save(field.value)); }
        else { const input = h('input', { className: 'nf-input', value: values[key] ?? '', onchange: () => save(input.value) }); field = h('nf-field', {}, input); field.setAttribute('label', title); }
        inner.append(field);
      }
    }).catch((e) => box.append(h('p', { className: 'nf-muted', textContent: e.message })));
  }
  el.replaceChildren(page); return null;
}

// ---- services: calls that may need the user's yes, the Services screen, agent requests that cost
async function callService(key, action, input = {}, confirmed = false) {
  const r = await post('/api/services/call', { key, action, input, confirmed });
  if (!r.needsConfirm) return r.result;
  if (!(await confirmDialog(`${r.service}: ${r.action}`, r.reason, 'Go ahead'))) throw new Error('cancelled');
  return callService(key, action, input, true);
}
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
function renderServicesScreen(el) {
  const draw = async () => {
    const { services, vault, threshold } = await json('/api/services');
    const page = h('div', { className: 'doc-page' }, h('h2', { textContent: 'Services' }),
      h('p', { className: 'nf-muted', textContent: `What plugins can do for you and for your agent. Keys are kept in ${vault}, never in the project or the page. Calls estimated at ${money(threshold)} or more, or past a budget, ask you first.` }));
    if (!services.length) page.append(h('p', { className: 'nf-muted', textContent: 'No plugin offers a service yet.' }));
    for (const s of services) {
      const needs = s.needs.map((n) => h('div', { className: 'need' }, h('i', { className: `light${n.ok ? ' on' : ''}` }),
        h('span', { textContent: n.kind === 'cli' ? `${n.command} on this computer${n.ok ? '' : `: ${n.help}`}` : `${n.name}${n.ok ? ' (saved)' : n.help ? `: ${n.help}` : ''}` }),
        ...(n.kind === 'key' ? [h('button', { className: 'nf-btn', textContent: n.ok ? 'Replace…' : 'Connect…', onclick: async () => {
          const input = h('input', { className: 'nf-input', type: 'password', placeholder: n.name });
          const ok = await confirmDialog(`Connect ${s.title}`, h('div', {}, h('p', { textContent: n.help || `Paste ${n.name}.` }), input, h('p', { className: 'nf-muted', textContent: `Kept in ${vault}.` })), 'Save');
          if (ok && input.value) { try { await post('/api/services/connect', { key: s.key, name: n.name, value: input.value }); toast(`${s.title} connected`); draw(); } catch (e) { toast(e.message, 'error'); } }
        } })] : [])));
      const budget = h('input', { className: 'nf-input', type: 'number', min: 0, step: 1, value: s.budget ?? '', placeholder: 'none', style: 'width:110px',
        onchange: () => post('/api/services/budget', { key: s.key, amount: budget.value === '' ? null : Number(budget.value) }).then(() => toast('Budget saved')).catch((e) => toast(e.message, 'error')) });
      page.append(h('div', { className: 'service' },
        h('header', {}, h('i', { className: `light${s.connected ? ' on' : ''}`, title: s.connected ? 'connected' : 'not connected' }), h('b', { textContent: s.title }), h('span', { className: 'nf-muted', textContent: s.provider })),
        h('p', { textContent: s.summary }), ...needs,
        h('p', { className: 'nf-muted', textContent: `Actions: ${s.actions.map((a) => `${a.title}${a.cost ? ` (${a.cost.note || `about ${money(a.cost.estimate)}`})` : ''}`).join(', ')}` }),
        h('div', { className: 'need' }, h('span', { textContent: `This month: ${money(s.spent)}${s.budget !== null ? ` of ${money(s.budget)}` : ''} · monthly budget ($)` }), budget)));
    }
    el.replaceChildren(page);
  };
  draw().catch((e) => el.replaceChildren(h('p', { className: 'nf-empty', textContent: e.message })));
  const sub = onEvent('services/changed', () => draw()); return () => sub.dispose();
}
async function confirmAgentRequest({ id, reason, service, action }) {
  const yes = await confirmDialog(`Your agent asks: ${service}: ${action}`, reason, 'Go ahead');
  try { await post('/api/services/requests/answer', { id, approve: yes }); } catch (e) { toast(e.message, 'error'); }
}
async function refreshAgent() {
  const a = await json('/api/agent').catch(() => ({ connected: false }));
  const el = $('agent'); el.classList.toggle('on', a.connected);
  el.textContent = a.connected ? `● Agent: ${a.agent} · watching` : '○ No agent connected';
  el.title = a.connected ? 'Jobs you send are picked up.' : 'Tell your agent (Claude Code, Codex…): read <editor>/skills/nfgames/SKILL.md and watch this project.';
}

// ---- the palette
function openPalette(initial = '') {
  if (document.querySelector('.palette')) return;
  const input = h('input', { placeholder: 'Type a command…', value: initial }), list = h('ul'), wrap = h('div', { className: 'palette' }, h('div', {}, input, list));
  const items = () => [...commands.list(), ...model.tools.map((t) => ({ id: `tool:${t.key}`, title: `Open tool: ${t.title}`, category: 'Tools', tool: t.key }))];
  let shown = [], at = 0;
  const run = async (item) => { close(); try { if (item.tool) await setTool(item.tool); else await commands.execute(item.id); } catch (e) { toast(e.message, 'error'); } };
  const draw = () => { shown = rank(items(), input.value).slice(0, 40).map((r) => r.item); at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((c, i) => h('li', { className: i === at ? 'on' : '', onclick: () => run(c) }, h('span', { textContent: c.title }), h('span', { className: 'cat', textContent: [c.category, c.keys && showKeys(parseKeys(c.keys, { mac }), { mac })].filter(Boolean).join('  ') })))); };
  const close = () => wrap.remove();
  input.addEventListener('input', () => { at = 0; draw(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { at = Math.min(at + 1, shown.length - 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { at = Math.max(at - 1, 0); draw(); e.preventDefault(); } else if (e.key === 'Enter' && shown[at]) run(shown[at]); else if (e.key === 'Escape') close(); });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap); draw(); input.focus();
}
$('paletteOpen').textContent = `Search commands…   ${mac ? '⌘K' : 'Ctrl+K'}`;
$('paletteOpen').onclick = () => openPalette();

// ---- keys
addEventListener('keydown', (e) => {
  if (document.querySelector('.palette, dialog[open]')) return;
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
  for (const c of commands.list()) {
    if (!c.keys) continue;
    let chord; try { chord = parseKeys(c.keys, { mac }); } catch { continue; }
    if (matches(chord, e) && (!typing || chord.ctrl || chord.meta)) { e.preventDefault(); commands.execute(c.id).catch((err) => toast(err.message, 'error')); return; }
  }
});

// ---- live updates
onEvent('plugins/changed', () => refreshPlugins());
onEvent('plugins/failed', ({ id, message }) => { log(`${id}: ${message}`); toast(`${id} was turned off: ${message}`, 'error'); unload(id); refreshPlugins(); });
onEvent('jobs/started', ({ label }) => { jobsRunning = true; $('jobInd').textContent = `● ${label}`; $('jobInd').classList.add('on'); renderBottom(); });
onEvent('jobs/done', ({ label, state }) => { jobsRunning = false; $('jobInd').textContent = 'No jobs'; $('jobInd').classList.remove('on'); toast(`${label}: ${state}`, state === 'done' ? '' : 'error'); renderBottom(); });
// reload only when the editor now has another project than this page shows (a stale event must never loop)
let shownRoot = null;
onEvent('project/changed', ({ root }) => { if (root && root !== shownRoot) location.reload(); });
onEvent('services/confirm', confirmAgentRequest);
onEvent('services/started', ({ title, by }) => log(`${by === 'agent' ? 'agent' : 'you'}: ${title}…`));
onEvent('services/done', ({ title, ok, error }) => { log(`${title}: ${ok ? 'done' : `failed: ${error}`}`); if (!ok) toast(`${title} failed: ${error}`, 'error'); });

// ---- start
shownRoot = (await json('/api/projects').catch(() => ({ current: {} }))).current.root || null;
await refreshPlugins();
// /?view=map (where /map and /viewer send a browser) opens that view's tab; Home otherwise
{ const asked = new URLSearchParams(location.search).get('view'); showView(VIEWS[asked] ? asked : 'home'); if (asked) history.replaceState(null, '', '/'); }
renderViews();
refreshAgent(); setInterval(refreshAgent, 15000);
for (const r of (await json('/api/services/requests').catch(() => ({ requests: [] }))).requests) confirmAgentRequest(r);
window.__workbench = { callService, commands, selection, documents, get plugins() { return plugins; }, ensure, unload, openPalette, problems };
