// The New model screen: ① Concept (describe it, generate candidates, pick one), ② Views (one image per side, made
// from the approved concept), ③ Model (what the step needs, and the 3D model made from the approved views by the
// model service: ComfyUI and Blender on this computer).
// The server part keeps the draft and its rules; this draws it and runs each generation through the image service.
import { h, toast, confirmDialog } from '/shell/ui.js';
import { shrink } from './shrink.js';
import { openLarge } from './large.js';
import { notesPanel } from './notes.js';

const SERVICE = 'nfgames.codex-image/image', MODEL = 'nfgames.comfy-model/model', BLENDER = 'https://www.blender.org/download/', AUTOREMESHER = 'https://github.com/huxingyi/autoremesher/releases', ALL_VIEWS = ['front', 'back', 'left', 'right', 'three-quarter', 'top'];
const STEPS = [['concept', '① Concept'], ['views', '② Views'], ['model', '③ Model']];
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

export function createScreen({ el, api, doc, slug, then, reopen }) {
  const src = (path) => `/api/p/${api.id}/image?path=${encodeURIComponent(path)}`;
  let draft = null, prompts = {}, step = 'concept', connected = true, gone = false;
  const form = { name: '', description: '', style: '', count: 4, prompt: {}, viewCount: {}, length: '', faces: 60000, ultrashape: true, cleanup: false, quads: 12000 };   // what is typed, kept across redraws
  let made = { views: [], missing: [] };   // what a model would be made from now, as the server sees the draft
  let needs = null, checking = false, modelRun = { state: 'idle' }, elsewhere = null, viewsCheck = null;   // step 3: what it needs; this tab's run; a run this tab did not start; the views check ({ state, result, error })
  const running = new Set(), notes = {};   // steps generating in this tab; what went wrong, per step
  let closeLarge = null;   // the large view, while one is open

  // ---- talking to the server
  const take = (r) => { draft = r.draft; prompts = r.prompts || prompts; made = r.model || made; return r; };
  const call = async (path, body) => take(await api.fetch(path, post({ slug: draft.slug, ...body })));
  /** The job the editor is running now (it runs one at a time), or null. */
  const runningJob = async () => { try { const j = await (await fetch('/api/job')).json(); return j.state === 'running' ? j : null; } catch { return null; } };
  const busy = async () => !!(await runningJob());
  /** The draft from the server. `fields` also takes its name, description and style into the form: only as the tab
   *  opens, never while watching a run, when they may be half typed. */
  async function load({ fields = false } = {}) {
    take(await api.fetch(`/draft?slug=${encodeURIComponent(slug)}${running.size || (await busy()) ? '&busy=1' : ''}`));
    if (fields) Object.assign(form, { name: draft.name, description: draft.description, style: draft.style });
    api.documents.setTitle(doc.id, `New model: ${draft.name}`);
  }
  async function checkService() {
    try { const s = (await (await fetch('/api/services')).json()).services.find((x) => x.key === SERVICE); connected = !!s && s.connected; } catch { connected = false; }
  }
  const fail = (where, e) => { notes[where] = e.message; draw(); };

  // ---- generating
  /** One round of a step: started on the server, run by the image service, settled with what was saved. */
  const generate = (where, prompt, count) => run(where, () => call('/draft/round', { step: where, prompt, count }));
  /** A round made from one image and the user's notes on it. */
  const revise = (where, image, sent) => { const going = run(where, () => call('/draft/revise', { step: where, image, ...sent })); if (closeLarge) closeLarge(); return going; };
  async function run(where, start) {
    if (running.has(where)) return;
    running.add(where); delete notes[where]; draw();
    try {
      // the editor is busy (a map's Apply, another generation): say so, and start nothing
      const job = await runningJob();
      if (job) { notes[where] = `The editor is busy (${job.label || job.kind || 'a job'} is running). Try again when it is done.`; return; }
      const { round, input } = await start();
      draw();
      let error = null;
      try { await api.services.call(SERVICE, 'generate', input); } catch (e) { error = e.message; }
      if (gone) return;   // the tab closed: the draft is settled from the round's folder when it is next opened
      await call('/draft/settle', { step: where, round: round.id, error });
      if (error) notes[where] = error;
    } catch (e) { notes[where] = e.message; } finally { running.delete(where); if (!gone) draw(); }
  }
  /** The first Generate of a new draft: the draft is made, then this tab is swapped for the draft's own. */
  async function begin(next) {
    if (!form.name.trim()) return fail('concept', new Error('Give it a name first.'));
    try { const r = await api.fetch('/drafts', post({ name: form.name, description: form.description, style: form.style })); reopen(r.draft, next); } catch (e) { fail('concept', e); }
  }
  const conceptPrompt = () => [form.description.trim(), form.style.trim() && `Style: ${form.style.trim()}.`].filter(Boolean).join('\n');
  async function generateConcept() {
    delete notes.concept;
    if (!form.description.trim()) return fail('concept', new Error('Describe it first.'));
    if (!draft) return begin({ generate: true, count: form.count });
    await saveFields();
    return generate('concept', conceptPrompt(), form.count);
  }
  /** A view's rounds made from the approved concept (those from an earlier concept are only shown, under the fold). */
  const mine = (v) => (draft.views.rounds[v] || []).filter((r) => r.concept === draft.concept.approved);
  const others = (v) => (draft.views.rounds[v] || []).filter((r) => r.concept !== draft.concept.approved);
  async function generateViews() { for (const v of draft.views.list) if (!mine(v).length && !gone && !notes[v]) await generate(v, form.prompt[v] ?? prompts[v], form.viewCount[v] || 2); }
  async function saveFields(extra = {}) {
    if (!draft) return;
    try { await call('/draft/save', { name: form.name, description: form.description, style: form.style, ...extra }); api.documents.setTitle(doc.id, `New model: ${draft.name}`); } catch (e) { toast(e.message, 'error'); }
  }
  async function addRefs(files) {
    try {
      const urls = []; for (const file of files) urls.push(await shrink(file));
      if (!urls.length) return;
      if (!draft) return begin({ refs: urls });
      for (const data of urls) await call('/draft/ref', { name: 'reference', data });
      draw();
    } catch (e) { fail('concept', e); }
  }
  const act = (where, fn) => async () => { try { delete notes[where]; await fn(); } catch (e) { notes[where] = e.message; } draw(); };
  async function approveConcept() {
    try { await call('/draft/approve', { step: 'concept' }); }
    catch (e) {
      if (!/clears the views/.test(e.message)) throw e;   // the server asks first when views were made from another concept
      if (!(await confirmDialog('Use a different concept?', 'The views were made from the concept you approved before. Using this one clears the views you chose; their images stay under "earlier rounds".', 'Use it and clear the views'))) return;
      await call('/draft/approve', { step: 'concept', confirm: true });
    }
    step = 'views';
  }
  // ---- step 3: the model
  /** Asks the model service what it has and what it lacks. It never throws: a service that is off is one more thing missing. */
  async function checkModel() {
    if (checking) return;
    checking = true; draw();
    try { needs = await api.services.call(MODEL, 'status', { ultrashape: form.ultrashape, cleanup: form.cleanup }); }
    catch (e) { needs = { ready: false, queue: null, setup: null, checks: [{ id: 'service', ok: false, text: `The model service did not answer: ${e.message}`, help: 'See Plugins: "3D model generation (ComfyUI)" must be on.' }] }; }
    checking = false; draw();
  }
  /** Compares the approved views with each other (Blender on the CPU, seconds). It only warns: generating never waits on it. */
  async function checkViews() {
    if (viewsCheck && viewsCheck.state === 'running') return;
    const job = await runningJob();
    if (job) { viewsCheck = { state: 'failed', error: `The editor is busy (${job.label || job.kind || 'a job'} is running). Try again when it is done.` }; return draw(); }
    viewsCheck = { state: 'running' }; draw();
    try { const result = await api.services.call(MODEL, 'checkViews', { draft: draft.slug }); viewsCheck = { state: 'done', result }; }
    catch (e) { viewsCheck = { state: 'failed', error: e.message }; }
    if (!gone) draw();
  }
  /** The views check's answer: a cross per warning, a plain line per note, or that the views agree. */
  function viewsAnswer() {
    const c = viewsCheck;
    if (!c) return null;
    if (c.state === 'running') return h('p', { className: 'mm-wait', textContent: 'Comparing the views…' });
    if (c.state === 'failed') return h('p', { className: 'mm-bad', textContent: c.error });
    const r = c.result, lines = [...r.warnings.map((t) => ['bad', '✕', t]), ...r.notes.map((t) => ['unknown', '', t])];
    if (!lines.length) return h('p', { className: 'mm-note', textContent: 'The views agree.' });
    return h('ul', { className: 'mm-views-check' }, ...lines.map(([kind, mark, t]) => h('li', { className: `mm-need ${kind}` }, h('span', { className: 'mark', textContent: mark }), h('div', { textContent: t }))));
  }
  async function generateModel() {
    const length = Number(form.length), slug = draft.slug;
    if (!(length > 0)) { modelRun = { state: 'failed', error: 'Give the longest side in metres first.' }; return draw(); }
    if (running.has('model')) return;
    const job = await runningJob();
    if (job) { modelRun = { state: 'failed', error: `The editor is busy (${job.label || job.kind || 'a job'} is running). Try again when it is done.` }; return draw(); }
    await checkModel();
    if (!needs.ready) return;
    const input = { draft: slug, length, faces: form.faces, ultrashape: form.ultrashape, ...(form.cleanup ? { cleanup: true, quads: form.quads } : {}) };
    if (needs.queue > 0) {
      if (!(await confirmDialog('ComfyUI is busy', `ComfyUI is working on ${needs.queue} other prompt${needs.queue > 1 ? 's' : ''}: this one waits its turn, and the two share the graphics card.`, 'Queue it anyway'))) return;
      input.wait = true;
    }
    if (draft.model) {
      if (!(await confirmDialog('Make the model again?', `${draft.model.path} is replaced by the new one.`, 'Replace it'))) return;
      input.replace = true;
    }
    running.add('model'); modelRun = { state: 'running', step: 'Starting…' }; draw();
    const tick = setInterval(async () => { const j = await runningJob(); if (j && running.has('model')) { modelRun = { state: 'running', step: `${j.steps?.[j.step] || 'Working'} (${Math.round((Date.now() - j.startedAt) / 1000)} s)` }; draw(); } }, 2000);
    try {
      let result;
      try { result = await api.services.call(MODEL, 'generate', input); }
      catch (e) {
        if (!/is already there/.test(e.message) || input.replace) throw e;   // a model from before this draft knew of one
        if (!(await confirmDialog('Make the model again?', `models/${slug}/${slug}.glb is replaced by the new one.`, 'Replace it'))) { modelRun = { state: 'idle' }; return; }
        result = await api.services.call(MODEL, 'generate', { ...input, replace: true });
      }
      if (gone) return;
      await call('/draft/model', { path: result.model, length });
      modelRun = { state: 'done', result };
    } catch (e) { modelRun = { state: 'failed', error: e.message }; } finally { clearInterval(tick); running.delete('model'); if (!gone) draw(); }
  }

  async function remove() {
    if (!(await confirmDialog('Delete this draft?', `${draft.name}: its folder .nfgames/drafts/${draft.slug}/ is deleted. The generated images under .nfgames/images/ stay.`, 'Delete'))) return;
    await api.fetch('/draft/delete', post({ slug: draft.slug })); api.documents.close(doc.id);
  }

  // ---- drawing
  const field = (key, tag, props = {}) => h(tag, { ...props, value: form[key], oninput: (e) => { form[key] = e.target.value; }, onchange: () => saveFields() });
  field.key = (e, key) => { e.dataset.key = key; return e; };
  const btn = (text, onclick, { cls = '', disabled = false, title = '' } = {}) => h('button', { className: `mm-btn ${cls}`, textContent: text, onclick, disabled, title });
  /** Opens images large, at the one with this path. An image of a step that can be picked can also be sent back with notes. */
  function large(group, path) {
    if (closeLarge) closeLarge();
    closeLarge = openLarge({ host: el, images: group, index: Math.max(0, group.findIndex((g) => g.path === path)),
      onPick: async (image) => { const g = group.find((x) => x.path === image); try { delete notes[g.step]; await g.pick(image); } catch (e) { notes[g.step] = e.message; } draw(); },
      extra: (image, { stage, img }) => (image.pickable ? notesPanel({ stage, img, disabled: !connected ? 'Image generation is not connected.' : running.size ? 'Wait for the round that is being generated.' : '', onSend: (sent) => { revise(image.step, image.path, sent); } }) : null) });
  }
  /** An image tile: a click opens it large, among `group` (or alone). `pick`, when it can be picked, is the corner control. */
  const pic = (path, { on = false, pick = null, title = '', group = null } = {}) => h('div', { className: `mm-pic${on ? ' on' : ''}` },
    h('button', { className: 'mm-open', type: 'button', title: title || 'Look closer', onclick: () => large(group || [{ path, src: src(path), caption: title }], path) }, h('img', { src: src(path), alt: title || 'generated image', loading: 'lazy' })),
    pick ? h('button', { className: `mm-pick${on ? ' on' : ''}`, type: 'button', textContent: on ? '✓ Picked' : 'Pick', title: on ? 'This is the pick' : 'Pick this one', onclick: pick }) : null);
  const whyNot = () => (connected ? null : h('p', { className: 'mm-bad' }, 'Image generation is not connected. ', btn('Open Services', () => api.commands.execute('core/services'))));
  /** A step's rounds: the newest as a grid to pick from, the earlier ones under a fold. */
  function rounds(where, list, picked, onPick, old = []) {
    const out = [], [latest, ...earlier] = [...list].reverse();
    const one = (r, small, pickable = true) => {
      const what = `${where}, round ${r.id.slice(1)}${pickable ? '' : ' (from an earlier concept)'}`;
      const group = r.images.map((i) => ({ path: i, src: src(i), caption: what, pickable, picked: i === picked, step: where, pick: onPick }));
      return [
        r.from ? h('div', { className: 'mm-from' }, h('img', { src: src(r.from), alt: 'the image this round revises', loading: 'lazy' }),
          h('div', {}, h('p', { className: 'mm-note', textContent: 'revised from this, with:' }), h('ul', {}, ...(r.pins || []).map((p, n) => h('li', { textContent: `${n + 1}: ${p.note}` })), r.note ? h('li', { textContent: r.note }) : null))) : null,
        r.state === 'pending' ? h('p', { className: 'mm-wait', textContent: 'Generating…' }) : null,
        r.state === 'failed' ? h('p', { className: 'mm-bad', textContent: r.error || 'It failed.' }) : null,
        r.images.length ? h('div', { className: `mm-grid${small ? ' small' : ''}` }, ...r.images.map((i) => pic(i, { on: pickable && i === picked, group, title: what, pick: pickable ? act(where, () => onPick(i)) : null }))) : null,
      ];
    };
    if (latest) out.push(...one(latest, where !== 'concept'));
    if (earlier.length || old.length) out.push(h('details', {}, h('summary', { textContent: `earlier rounds (${earlier.length + old.length})` }), ...earlier.flatMap((r) => one(r, true)),
      ...(old.length ? [h('p', { className: 'mm-note', textContent: 'Made from an earlier concept (kept to look at, not to pick):' }), ...[...old].reverse().flatMap((r) => one(r, true, false))] : [])));
    if (notes[where] && !(latest && latest.state === 'failed')) out.push(h('p', { className: 'mm-bad', textContent: notes[where] }));
    return out;
  }
  function concept() {
    const c = draft ? draft.concept : { rounds: [], pick: null, approved: null }, refs = draft ? draft.refs : [];
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (e) => addRefs([...e.target.files]) });
    const drop = h('div', { className: 'mm-drop', ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'), ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); addRefs([...e.dataTransfer.files]); } },
      h('div', { className: 'mm-row' }, btn('+ add image', () => file.click(), { disabled: refs.length >= 8 }), h('span', { className: 'mm-note', textContent: refs.length ? `${refs.length} of 8` : 'Optional: drop, paste or pick images to go by (up to 8).' }), file),
      refs.length ? h('div', { className: 'mm-grid small', style: 'margin-top:8px' }, ...refs.map((r) => { const tile = pic(r, { title: 'reference', group: refs.map((x) => ({ path: x, src: src(x), caption: 'reference' })) }); tile.append(h('button', { className: 'x', textContent: '✕', title: 'Remove', onclick: act('concept', () => call('/draft/unref', { ref: r })) })); return tile; })) : null);
    return [
      h('label', { textContent: 'Name' }), field.key(field('name', 'input', { type: 'text', placeholder: 'brass lantern' }), 'name'),
      h('label', { textContent: 'Describe it' }), field.key(field('description', 'textarea', { placeholder: 'a small brass street lantern, worn, with hexagonal glass…' }), 'description'),
      h('label', { textContent: 'Style (kept for this project)' }), field.key(field('style', 'input', { type: 'text', placeholder: 'hand-painted, low poly, soft light' }), 'style'),
      h('label', { textContent: 'References' }), drop,
      h('div', { className: 'mm-row', style: 'margin-top:12px' }, h('span', { className: 'grow' }), h('span', { className: 'mm-note', textContent: 'How many' }),
        field.key(h('input', { type: 'number', min: 1, max: 8, value: form.count, oninput: (e) => { form.count = Math.max(1, Math.min(8, Number(e.target.value) || 1)); } }), 'count'),
        btn(running.has('concept') ? 'Generating…' : c.rounds.length ? 'Generate again' : 'Generate', generateConcept, { cls: 'primary', disabled: !connected || running.has('concept') })),
      whyNot(),
      ...rounds('concept', c.rounds, c.pick, (image) => call('/draft/pick', { step: 'concept', image })),
      c.rounds.length ? h('div', { className: 'mm-row' }, h('span', { className: 'grow' }), c.approved && c.approved === c.pick ? h('span', { className: 'mm-note', textContent: 'This is the approved concept.' }) : null,
        btn(c.approved && c.approved === c.pick ? 'Go to Views →' : 'Use this one → Views', act('concept', approveConcept), { cls: 'primary', disabled: !c.pick })) : null,
    ];
  }
  function views() {
    const v = draft.views, anyRunning = v.list.some((x) => running.has(x)), unmade = v.list.filter((x) => !mine(x).length);
    const row = (view) => h('div', { className: 'mm-view' },
      h('div', { className: 'mm-row' }, h('h3', { textContent: view }), h('span', { className: 'grow' }), h('span', { className: 'mm-note', textContent: 'How many' }),
        field.key(h('input', { type: 'number', min: 1, max: 8, value: form.viewCount[view] || 2, oninput: (e) => { form.viewCount[view] = Math.max(1, Math.min(8, Number(e.target.value) || 1)); } }), `count:${view}`),
        btn(running.has(view) ? 'Generating…' : mine(view).length ? 'Generate again' : 'Generate', () => generate(view, form.prompt[view] ?? prompts[view], form.viewCount[view] || 2), { disabled: !connected || anyRunning })),
      field.key(h('textarea', { value: form.prompt[view] ?? prompts[view] ?? '', oninput: (e) => { form.prompt[view] = e.target.value; }, onchange: () => saveFields({ views: { list: v.list, prompts: { [view]: form.prompt[view] } } }).then(draw) }), `prompt:${view}`),
      ...rounds(view, mine(view), v.picks[view], (image) => call('/draft/pick', { step: view, image }), others(view)));
    return [h('div', { className: 'mm-views' },
      h('div', {}, h('label', { textContent: 'Approved concept' }), pic(draft.concept.approved, { title: 'The approved concept' }), h('p', { className: 'mm-note', textContent: 'Every view is made from this image.' })),
      h('div', {},
        h('label', { textContent: 'Views to make' }),
        h('div', { className: 'mm-checks' }, ...ALL_VIEWS.map((x) => h('label', {}, h('input', { type: 'checkbox', checked: v.list.includes(x), disabled: anyRunning || (v.list.length === 1 && v.list[0] === x),
          onchange: act('views', (e) => call('/draft/save', { views: { list: ALL_VIEWS.filter((y) => (y === x ? !v.list.includes(x) : v.list.includes(y))), prompts: {} } })) }), ` ${x}`))),
        h('div', { className: 'mm-row', style: 'margin:12px 0' }, btn(anyRunning ? 'Generating…' : 'Generate views', generateViews, { cls: 'primary', disabled: !connected || anyRunning || !unmade.length, title: unmade.length ? `Makes ${unmade.join(', ')}, one after another` : 'Every view has images: generate one again from its row' }),
          h('span', { className: 'grow' }), v.approved ? h('span', { className: 'mm-note', textContent: 'These views are approved.' }) : null,
          btn(v.approved ? 'Go to Model →' : 'Approve views', act('views', async () => { if (!v.approved) await call('/draft/approve', { step: 'views' }); viewsCheck = null; step = 'model'; }), { cls: 'primary', disabled: v.list.some((x) => !v.picks[x]) })),
        whyNot(), notes.views ? h('p', { className: 'mm-bad', textContent: notes.views }) : null,
        ...v.list.map(row)))];
  }
  /** What the step needs: a tick, a cross or a question mark each, and for a cross what to do about it. */
  function needsBox() {
    const head = h('div', { className: 'mm-row' }, h('h3', { textContent: 'What this step needs' }), h('span', { className: 'grow' }), btn(checking ? 'Checking…' : 'Check again', () => checkModel(), { disabled: checking }));
    if (!needs) return h('div', { className: 'mm-needs' }, head, h('p', { className: 'mm-wait', textContent: 'Checking…' }));
    const link = (text, href) => Object.assign(h('a', { textContent: text, href }), { target: '_blank', rel: 'noopener noreferrer' });
    const guide = needs.setup && /^https:\/\//.test(needs.setup) ? needs.setup : null;
    const mark = { true: ['ok', '✓'], false: ['bad', '✕'], null: ['unknown', '?'] };
    const row = (c) => h('li', { className: `mm-need ${mark[c.ok][0]}` }, h('span', { className: 'mark', textContent: mark[c.ok][1] }), h('div', {}, h('div', { textContent: c.text }),
      c.ok === false ? h('div', { className: 'mm-note' }, c.help ? `${c.help} ` : '',
        ['workflows', 'nodes', 'models'].includes(c.id) && guide ? link('Setup guide', guide) : null, c.id === 'blender' ? link('Get Blender', BLENDER) : null, c.id === 'cleanup' ? link('Get AutoRemesher', AUTOREMESHER) : null, ' ',
        ['workflows', 'comfy', 'blender', 'cleanup'].includes(c.id) ? btn('Open Settings', () => api.commands.execute('core/settings')) : null, c.id === 'service' ? btn('Open Plugins', () => api.commands.execute('core/plugins')) : null) : null));
    const rows = needs.checks.map(row);
    if (needs.checks.every((c) => c.ok === true)) return h('div', { className: 'mm-needs' }, head, h('details', {}, h('summary', { className: 'mm-need ok', textContent: '✓ Everything this step needs is there.' }), h('ul', {}, ...rows)));
    return h('div', { className: 'mm-needs' }, head,
      h('p', { className: 'mm-note', textContent: 'The model is made on this computer: ComfyUI with the asset3d workflow and its model files, then Blender. None of it comes with the editor.' }),
      h('ul', {}, ...rows));
  }
  function model() {
    const v = draft.views, all = [['concept', draft.concept.approved], ...v.list.map((x) => [x, v.picks[x]])], unused = v.list.filter((x) => !made.views.includes(x));
    const busy = running.has('model') || !!elsewhere, can = !!needs && needs.ready && !made.missing.length && !busy && !checking;
    const r = modelRun.result, after = r && r.report && r.report.after, mesh = r && r.report && r.report.mesh;
    return [h('h2', { textContent: draft.name }),
      h('div', { className: 'mm-grid small' }, ...all.map(([title, path]) => pic(path, { title, group: all.map(([t, q]) => ({ path: q, src: src(q), caption: t })) }))),
      made.missing.length ? h('p', { className: 'mm-bad', textContent: `A model needs the front, left, back and right views. Missing: ${made.missing.join(', ')}. Add ${made.missing.length > 1 ? 'them' : 'it'} in Views.` })
        : h('p', { className: 'mm-note', textContent: `The model is made from ${made.views.join(', ')}.${unused.length ? ` Not used: ${unused.join(', ')}${unused.some((x) => x === 'top' || x === 'bottom') ? ' (top and bottom are used only as a pair)' : ''}.` : ''}` }),
      h('div', { className: 'mm-row' }, btn(viewsCheck && viewsCheck.state === 'running' ? 'Checking the views…' : 'Check the views against each other', checkViews,
        { disabled: busy || checking || !needs || (viewsCheck && viewsCheck.state === 'running') || needs.checks.some((c) => c.id === 'blender' && c.ok === false), title: 'Compares opposite views with each other in Blender: seconds, no graphics card. It only warns.' })),
      viewsAnswer(),
      needsBox(),
      h('div', { className: 'mm-row', style: 'margin-top:12px' },
        h('span', { className: 'mm-note', textContent: 'Longest side (metres)' }), field.key(h('input', { type: 'number', min: 0, step: 'any', placeholder: '1.2', value: form.length, style: 'width:90px', oninput: (e) => { form.length = e.target.value; const b = el.querySelector('.mm-go'); if (b) b.disabled = !can || !(Number(form.length) > 0); } }), 'length'),
        ...(form.cleanup
          ? [h('span', { className: 'mm-note', textContent: 'Quads (about)' }), field.key(h('input', { type: 'number', min: 500, max: 500000, step: 500, value: form.quads, style: 'width:100px', oninput: (e) => { form.quads = Math.max(500, Math.min(500000, Math.round(Number(e.target.value)) || 12000)); } }), 'quads')]
          : [h('span', { className: 'mm-note', textContent: 'Triangles' }), field.key(h('input', { type: 'number', min: 1000, max: 2000000, step: 1000, value: form.faces, style: 'width:100px', oninput: (e) => { form.faces = Math.max(1000, Math.min(2000000, Math.round(Number(e.target.value)) || 60000)); } }), 'faces')]),
        h('label', { className: 'mm-inline' }, field.key(h('input', { type: 'checkbox', checked: form.ultrashape, onchange: (e) => { form.ultrashape = e.target.checked; checkModel(); } }), 'ultrashape'), ' Refine with UltraShape'),
        h('label', { className: 'mm-inline', title: 'Remeshes the model into quads with AutoRemesher, unwraps it again and bakes its textures onto the new mesh' }, field.key(h('input', { type: 'checkbox', checked: form.cleanup, onchange: (e) => { form.cleanup = e.target.checked; checkModel(); } }), 'cleanup'), ' Clean up into quads'),
        h('span', { className: 'grow' }),
        btn(running.has('model') ? 'Generating…' : draft.model ? 'Generate model again' : 'Generate model', () => generateModel(), { cls: 'primary mm-go', disabled: !can || !(Number(form.length) > 0), title: 'A few minutes on the graphics card' })),
      modelRun.state === 'running' ? h('p', { className: 'mm-wait', textContent: `${modelRun.step}. A model takes a few minutes; Jobs shows its output.` }) : null,
      elsewhere && !running.has('model') ? h('p', { className: 'mm-wait', textContent: `${elsewhere}. This page shows the model when it is done.` }) : null,
      modelRun.state === 'failed' ? h('p', { className: 'mm-bad', textContent: modelRun.error }) : null,
      draft.model && modelRun.state !== 'running' ? h('div', { className: 'mm-made' },
        h('p', {}, `Saved as ${draft.model.path}, ${draft.model.length} m on its longest side`,
          after ? `: ${r.report.cleanup && r.report.cleanup.quads ? `${Number(r.report.cleanup.quads).toLocaleString()} quads, ` : ''}${Number(after.triangles).toLocaleString()} triangles${after.mb ? `, ${after.mb} MB` : ''}${r.seconds ? `, made in ${r.seconds} s` : ''}${mesh ? `, ${mesh.pieces} piece${mesh.pieces === 1 ? '' : 's'}, ${mesh.openEdges} open edge${mesh.openEdges === 1 ? '' : 's'}` : ''}.` : '.'),
        ...(mesh ? [[mesh.floating, 'floating piece', 'parts that touch nothing'], [mesh.flippedFaces, 'flipped face', 'faces that point into the model'], [mesh.nonManifoldEdges, 'non-manifold edge', 'edges shared by more than two faces']]
          .filter(([n]) => n > 0).map(([n, what, why]) => h('p', { className: 'mm-bad', textContent: `✕ ${n} ${what}${n === 1 ? '' : 's'}: ${why}` })) : []),
        r && r.report && r.report.inspectError ? h('p', { className: 'mm-note', textContent: `The mesh was not inspected: ${r.report.inspectError}` }) : null,
        Object.assign(h('a', { className: 'mm-btn primary', textContent: 'Open in the model viewer', href: `/viewer?model=${encodeURIComponent(draft.model.path.replace(/^models\//, ''))}` }), { target: '_blank', rel: 'noopener' })) : null];
  }
  function draw() {
    if (gone) return;
    const can = { concept: true, views: !!draft && !!draft.concept.approved, model: !!draft && draft.status === 'ready' };
    if (!can[step]) step = can.views && step === 'model' ? 'views' : 'concept';
    if (step === 'model' && !needs && !checking) queueMicrotask(checkModel);
    // what is being typed keeps the cursor across a redraw
    const active = el.contains(document.activeElement) ? document.activeElement : null, key = active && active.dataset.key, at = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const over = [...el.children].filter((c) => c.classList.contains('mm-large'));   // the large view stays open across a redraw
    el.replaceChildren(h('div', { className: 'mm', onpaste: (e) => { const files = [...(e.clipboardData?.files || [])]; if (step === 'concept' && files.length) { e.preventDefault(); addRefs(files); } } },
      h('div', { className: 'mm-steps' }, ...STEPS.flatMap(([id, title], i) => [i ? h('span', { className: 'line' }) : null, h('button', { className: `mm-step${step === id ? ' on' : ''}`, textContent: title, disabled: !can[id], onclick: () => { step = id; draw(); } })]),
        h('span', { className: 'grow' }), draft ? btn('Delete draft', () => remove().catch((e) => toast(e.message, 'error')), { cls: 'danger' }) : null),
      ...(step === 'concept' ? concept() : step === 'views' ? views() : model())), ...over);
    if (key) { const again = el.querySelector(`[data-key="${CSS.escape(key)}"]`); if (again) { again.focus(); if (at) try { again.setSelectionRange(at[0], at[1]); } catch { /* a number field */ } } }
  }

  // ---- starting, and watching a run this tab did not start (it began before a reload)
  const subs = [api.events.on('services/changed', () => checkService().then(draw))];
  const watch = setInterval(async () => {
    if (gone || !draft || running.size) return;
    const pending = [...draft.concept.rounds, ...Object.values(draft.views.rounds).flat()].some((r) => r.state === 'pending');
    if (pending) { try { await load(); draw(); } catch { /* next time */ } }
    else if (step === 'model') {   // a model being generated from before a reload: say so, and show it when it is done
      const j = await runningJob(), now = j && j.label === `Generate model: ${draft.name}` ? `${j.steps?.[j.step] || 'Generating the model'} (${Math.round((Date.now() - j.startedAt) / 1000)} s)` : null;
      if (now !== elsewhere) { const ended = elsewhere && !now; elsewhere = now; if (ended) { try { await load(); } catch { /* next time */ } } draw(); }
    }
  }, 5000);
  (async () => {
    el.replaceChildren(h('p', { className: 'nf-empty', textContent: 'Loading…' }));
    await checkService();
    if (slug) {
      try { await load({ fields: true }); } catch (e) { el.replaceChildren(h('p', { className: 'nf-empty', textContent: `This draft cannot be opened: ${e.message}` })); return; }
      step = draft.status === 'ready' ? 'model' : draft.status === 'views' ? 'views' : 'concept';
    } else { try { form.style = (await api.fetch('/drafts')).style || ''; } catch { /* no style kept yet */ } }
    draw();
    if (then && then.refs) { for (const data of then.refs) await call('/draft/ref', { name: 'reference', data }).catch((e) => { notes.concept = e.message; }); draw(); }
    if (then && then.generate) { form.count = then.count || form.count; generate('concept', conceptPrompt(), form.count); }
  })();
  return () => { gone = true; if (closeLarge) closeLarge(); clearInterval(watch); for (const s of subs) s.dispose(); };
}
