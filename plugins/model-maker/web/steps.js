// The New model screen: ① Concept (describe it, generate candidates, pick one), ② Views (one image per side, made
// from the approved concept), ③ Model (what is saved for the model step, which comes in a later update).
// The server part keeps the draft and its rules; this draws it and runs each generation through the image service.
import { h, toast, confirmDialog } from '/shell/ui.js';
import { shrink } from './shrink.js';

const SERVICE = 'nfgames.codex-image/image', ALL_VIEWS = ['front', 'back', 'left', 'right', 'three-quarter', 'top'];
const STEPS = [['concept', '① Concept'], ['views', '② Views'], ['model', '③ Model']];
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

export function createScreen({ el, api, doc, slug, then, reopen }) {
  const src = (path) => `/api/p/${api.id}/image?path=${encodeURIComponent(path)}`;
  let draft = null, prompts = {}, step = 'concept', connected = true, gone = false;
  const form = { name: '', description: '', style: '', count: 4, prompt: {}, viewCount: {} };   // what is typed, kept across redraws
  const running = new Set(), notes = {};   // steps generating in this tab; what went wrong, per step

  // ---- talking to the server
  const take = (r) => { draft = r.draft; prompts = r.prompts || prompts; return r; };
  const call = async (path, body) => take(await api.fetch(path, post({ slug: draft.slug, ...body })));
  const busy = async () => { try { return (await (await fetch('/api/job')).json()).state === 'running'; } catch { return false; } };
  async function load() {
    take(await api.fetch(`/draft?slug=${encodeURIComponent(slug)}${running.size || (await busy()) ? '&busy=1' : ''}`));
    Object.assign(form, { name: draft.name, description: draft.description, style: draft.style });
    api.documents.setTitle(doc.id, `New model: ${draft.name}`);
  }
  async function checkService() {
    try { const s = (await (await fetch('/api/services')).json()).services.find((x) => x.key === SERVICE); connected = !!s && s.connected; } catch { connected = false; }
  }
  const fail = (where, e) => { notes[where] = e.message; draw(); };

  // ---- generating
  /** One round of a step: started on the server, run by the image service, settled with what was saved. */
  async function generate(where, prompt, count) {
    if (running.has(where)) return;
    running.add(where); delete notes[where]; draw();
    try {
      const { round, input } = await call('/draft/round', { step: where, prompt, count });
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
    if (!form.description.trim()) return fail('concept', new Error('Describe it first.'));
    if (!draft) return begin({ generate: true, count: form.count });
    await saveFields();
    return generate('concept', conceptPrompt(), form.count);
  }
  async function generateViews() { for (const v of draft.views.list) if (!(draft.views.rounds[v] || []).length && !gone) await generate(v, form.prompt[v] ?? prompts[v], form.viewCount[v] || 2); }
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
  async function remove() {
    if (!(await confirmDialog('Delete this draft?', `${draft.name}: its folder .nfgames/drafts/${draft.slug}/ is deleted. The generated images under .nfgames/images/ stay.`, 'Delete'))) return;
    await api.fetch('/draft/delete', post({ slug: draft.slug })); api.documents.close(doc.id);
  }

  // ---- drawing
  const field = (key, tag, props = {}) => h(tag, { ...props, value: form[key], oninput: (e) => { form[key] = e.target.value; }, onchange: () => saveFields() });
  field.key = (e, key) => { e.dataset.key = key; return e; };
  const btn = (text, onclick, { cls = '', disabled = false, title = '' } = {}) => h('button', { className: `mm-btn ${cls}`, textContent: text, onclick, disabled, title });
  const pic = (path, { on = false, onclick = null, title = '' } = {}) => h('button', { className: `mm-pic${on ? ' on' : ''}${onclick ? '' : ' still'}`, onclick, title }, h('img', { src: src(path), alt: title || 'generated image', loading: 'lazy' }));
  const whyNot = () => (connected ? null : h('p', { className: 'mm-bad' }, 'Image generation is not connected. ', btn('Open Services', () => api.commands.execute('core/services'))));
  /** A step's rounds: the newest as a grid to pick from, the earlier ones under a fold. */
  function rounds(where, list, picked, onPick) {
    const out = [], [latest, ...earlier] = [...list].reverse();
    const one = (r, small) => [
      r.state === 'pending' ? h('p', { className: 'mm-wait', textContent: 'Generating…' }) : null,
      r.state === 'failed' ? h('p', { className: 'mm-bad', textContent: r.error || 'It failed.' }) : null,
      r.images.length ? h('div', { className: `mm-grid${small ? ' small' : ''}` }, ...r.images.map((i) => pic(i, { on: i === picked, onclick: act(where, () => onPick(i)), title: 'Pick this one' }))) : null,
    ];
    if (latest) out.push(...one(latest, where !== 'concept'));
    if (earlier.length) out.push(h('details', {}, h('summary', { textContent: `earlier rounds (${earlier.length})` }), ...earlier.flatMap((r) => one(r, true))));
    if (notes[where] && !(latest && latest.state === 'failed')) out.push(h('p', { className: 'mm-bad', textContent: notes[where] }));
    return out;
  }
  function concept() {
    const c = draft ? draft.concept : { rounds: [], pick: null, approved: null }, refs = draft ? draft.refs : [];
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (e) => addRefs([...e.target.files]) });
    const drop = h('div', { className: 'mm-drop', ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'), ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); addRefs([...e.dataTransfer.files]); } },
      h('div', { className: 'mm-row' }, btn('+ add image', () => file.click(), { disabled: refs.length >= 8 }), h('span', { className: 'mm-note', textContent: refs.length ? `${refs.length} of 8` : 'Optional: drop, paste or pick images to go by (up to 8).' }), file),
      refs.length ? h('div', { className: 'mm-grid small', style: 'margin-top:8px' }, ...refs.map((r) => h('div', { className: 'mm-pic still' }, h('img', { src: src(r), alt: 'reference' }), h('button', { className: 'x', textContent: '✕', title: 'Remove', onclick: act('concept', () => call('/draft/unref', { ref: r })) })))) : null);
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
    const v = draft.views, anyRunning = v.list.some((x) => running.has(x)), unmade = v.list.filter((x) => !(v.rounds[x] || []).length);
    const row = (view) => h('div', { className: 'mm-view' },
      h('div', { className: 'mm-row' }, h('h3', { textContent: view }), h('span', { className: 'grow' }), h('span', { className: 'mm-note', textContent: 'How many' }),
        field.key(h('input', { type: 'number', min: 1, max: 8, value: form.viewCount[view] || 2, oninput: (e) => { form.viewCount[view] = Math.max(1, Math.min(8, Number(e.target.value) || 1)); } }), `count:${view}`),
        btn(running.has(view) ? 'Generating…' : (v.rounds[view] || []).length ? 'Generate again' : 'Generate', () => generate(view, form.prompt[view] ?? prompts[view], form.viewCount[view] || 2), { disabled: !connected || anyRunning })),
      field.key(h('textarea', { value: form.prompt[view] ?? prompts[view] ?? '', oninput: (e) => { form.prompt[view] = e.target.value; }, onchange: () => saveFields({ views: { list: v.list, prompts: { [view]: form.prompt[view] } } }).then(draw) }), `prompt:${view}`),
      ...rounds(view, v.rounds[view] || [], v.picks[view], (image) => call('/draft/pick', { step: view, image })));
    return [h('div', { className: 'mm-views' },
      h('div', {}, h('label', { textContent: 'Approved concept' }), pic(draft.concept.approved, { title: 'The approved concept' }), h('p', { className: 'mm-note', textContent: 'Every view is made from this image.' })),
      h('div', {},
        h('label', { textContent: 'Views to make' }),
        h('div', { className: 'mm-checks' }, ...ALL_VIEWS.map((x) => h('label', {}, h('input', { type: 'checkbox', checked: v.list.includes(x), disabled: anyRunning || (v.list.length === 1 && v.list[0] === x),
          onchange: act('views', (e) => call('/draft/save', { views: { list: ALL_VIEWS.filter((y) => (y === x ? !v.list.includes(x) : v.list.includes(y))), prompts: {} } })) }), ` ${x}`))),
        h('div', { className: 'mm-row', style: 'margin:12px 0' }, btn(anyRunning ? 'Generating…' : 'Generate views', generateViews, { cls: 'primary', disabled: !connected || anyRunning || !unmade.length, title: unmade.length ? `Makes ${unmade.join(', ')}, one after another` : 'Every view has images: generate one again from its row' }),
          h('span', { className: 'grow' }), v.approved ? h('span', { className: 'mm-note', textContent: 'These views are approved.' }) : null,
          btn(v.approved ? 'Go to Model →' : 'Approve views', act('views', async () => { if (!v.approved) await call('/draft/approve', { step: 'views' }); step = 'model'; }), { cls: 'primary', disabled: v.list.some((x) => !v.picks[x]) })),
        whyNot(), notes.views ? h('p', { className: 'mm-bad', textContent: notes.views }) : null,
        ...v.list.map(row)))];
  }
  function model() {
    const v = draft.views;
    return [h('h2', { textContent: draft.name }), h('p', { className: 'mm-note', textContent: `Saved in .nfgames/drafts/${draft.slug}/: concept.png and views/${v.list.join('.png, views/')}.png` }),
      h('div', { className: 'mm-grid small' }, pic(draft.concept.approved, { title: 'concept' }), ...v.list.map((x) => pic(v.picks[x], { title: x }))),
      h('div', { className: 'mm-row', style: 'margin-top:16px' }, btn('Generate model', null, { cls: 'primary', disabled: true }), h('span', { className: 'mm-note', textContent: 'Model generation comes in a later update.' }))];
  }
  function draw() {
    if (gone) return;
    const can = { concept: true, views: !!draft && !!draft.concept.approved, model: !!draft && draft.status === 'ready' };
    if (!can[step]) step = can.views && step === 'model' ? 'views' : 'concept';
    // what is being typed keeps the cursor across a redraw
    const active = el.contains(document.activeElement) ? document.activeElement : null, key = active && active.dataset.key, at = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    el.replaceChildren(h('div', { className: 'mm', onpaste: (e) => { const files = [...(e.clipboardData?.files || [])]; if (step === 'concept' && files.length) { e.preventDefault(); addRefs(files); } } },
      h('div', { className: 'mm-steps' }, ...STEPS.flatMap(([id, title], i) => [i ? h('span', { className: 'line' }) : null, h('button', { className: `mm-step${step === id ? ' on' : ''}`, textContent: title, disabled: !can[id], onclick: () => { step = id; draw(); } })]),
        h('span', { className: 'grow' }), draft ? btn('Delete draft', () => remove().catch((e) => toast(e.message, 'error')), { cls: 'danger' }) : null),
      ...(step === 'concept' ? concept() : step === 'views' ? views() : model())));
    if (key) { const again = el.querySelector(`[data-key="${CSS.escape(key)}"]`); if (again) { again.focus(); if (at) try { again.setSelectionRange(at[0], at[1]); } catch { /* a number field */ } } }
  }

  // ---- starting, and watching a run this tab did not start (it began before a reload)
  const subs = [api.events.on('services/changed', () => checkService().then(draw))];
  const watch = setInterval(async () => {
    if (gone || !draft || running.size) return;
    const pending = [...draft.concept.rounds, ...Object.values(draft.views.rounds).flat()].some((r) => r.state === 'pending');
    if (pending) { try { await load(); draw(); } catch { /* next time */ } }
  }, 5000);
  (async () => {
    el.replaceChildren(h('p', { className: 'nf-empty', textContent: 'Loading…' }));
    await checkService();
    if (slug) {
      try { await load(); } catch (e) { el.replaceChildren(h('p', { className: 'nf-empty', textContent: `This draft cannot be opened: ${e.message}` })); return; }
      step = draft.status === 'ready' ? 'model' : draft.status === 'views' ? 'views' : 'concept';
    } else { try { form.style = (await api.fetch('/drafts')).style || ''; } catch { /* no style kept yet */ } }
    draw();
    if (then && then.refs) { for (const data of then.refs) await call('/draft/ref', { name: 'reference', data }).catch((e) => { notes.concept = e.message; }); draw(); }
    if (then && then.generate) { form.count = then.count || form.count; generate('concept', conceptPrompt(), form.count); }
  })();
  return () => { gone = true; clearInterval(watch); for (const s of subs) s.dispose(); };
}
