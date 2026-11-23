// New model, the server part: drafts kept in the project, one folder each under .nfgames/drafts/<slug>/ (draft.json,
// the user's reference images, and what the model step will read: concept.png and views/<view>.png once approved).
// The rules are in draft.mjs; here they meet the files. The page runs each generation through the image service and
// tells these routes when a round starts and ends; a round whose tab went away is settled from what is in its folder.
import { slugOf, newDraft, viewPrompt, folderFor, startRound, settleRound, reconcile, pickConcept, pickView, approveConcept, setViews, approveViews, filesToKeep } from './draft.mjs';

const DRAFTS = '.nfgames/drafts', IMAGES = '.nfgames/images', STYLE = `${DRAFTS}/style.txt`;
const IMAGE = /\.(png|jpe?g|webp)$/i, MAX_REFS = 8;
const refuse = (code, text) => { throw Object.assign(new Error(text), { code }); };

export function activate(api) {
  const f = api.files;
  const dirOf = (slug) => `${DRAFTS}/${slug}`, fileOf = (slug) => `${dirOf(slug)}/draft.json`;
  const slugs = () => (f.exists(DRAFTS) ? f.list(DRAFTS).filter((name) => /^[a-z0-9][a-z0-9-]{0,45}$/.test(name) && f.exists(fileOf(name))) : []);
  /** The slug a request names: one of the drafts there are, else 404. */
  const known = (slug) => (typeof slug === 'string' && slugs().includes(slug) ? slug : refuse(404, 'no such draft'));
  const read = (slug) => {
    let d = null; try { d = JSON.parse(f.read(fileOf(slug))); } catch { /* not JSON */ }
    if (!d || d.version !== 1 || d.slug !== slug) refuse(422, 'This draft\'s file cannot be read by this version of the editor.');
    return d;
  };
  const imagesIn = (folder) => { const dir = `${IMAGES}/${folder}`; return f.exists(dir) ? f.list(dir).filter((n) => IMAGE.test(n)).sort().map((n) => `${dir}/${n}`) : []; };
  /** What the page gets: the draft, and each listed view's prompt as it would be sent (the user's own, or drafted). */
  const shown = (draft) => ({ draft, prompts: Object.fromEntries(draft.views.list.map((v) => [v, viewPrompt(draft, v)])) });
  /** Writes the draft, and (files: true) what it keeps beside it: concept.png, and views/ only while they are approved. */
  const save = (draft, { files = false } = {}) => {
    f.write(fileOf(draft.slug), `${JSON.stringify(draft, null, 2)}\n`);
    if (files) {
      const keep = filesToKeep(draft), dir = dirOf(draft.slug);
      if (keep.concept) f.write(`${dir}/concept.png`, f.read(keep.concept, null));
      f.remove(`${dir}/views`);
      for (const [view, image] of Object.entries(keep.views)) f.write(`${dir}/views/${view}.png`, f.read(image, null));
    }
    api.events.emit('changed', { slug: draft.slug });
    return shown(draft);
  };
  const style = () => (f.exists(STYLE) ? f.read(STYLE).trim() : '');
  const keepStyle = (text) => { if (typeof text === 'string' && text.trim()) f.write(STYLE, `${text.trim()}\n`); };

  api.routes.get('/drafts', () => ({
    drafts: slugs().map((slug) => { try { const d = read(slug); return { slug, name: d.name, status: d.status }; } catch { return { slug, name: slug, status: 'unreadable' }; } }),
    style: style(),
  }));
  api.routes.post('/drafts', ({ body = {} }) => {
    const taken = new Set(f.exists(DRAFTS) ? f.list(DRAFTS) : []);
    const draft = newDraft({ slug: slugOf(body.name, taken), name: body.name, description: body.description ?? '', style: body.style ?? '' });
    keepStyle(draft.style);
    return save(draft);
  });
  // a round left pending is settled here, unless the page says the editor is still busy (it asks /api/job: a plugin cannot)
  api.routes.get('/draft', ({ query }) => {
    const draft = read(known(query.slug)), now = reconcile(draft, { imagesIn, busy: query.busy === '1' });
    return now === draft ? shown(draft) : save(now);
  });
  api.routes.post('/draft/save', ({ body = {} }) => {
    let draft = read(known(body.slug));
    for (const k of ['description', 'style']) if (typeof body[k] === 'string') draft = { ...draft, [k]: body[k] };
    if (typeof body.name === 'string' && body.name.trim()) draft = { ...draft, name: body.name.trim().slice(0, 200) };
    if (body.views) draft = setViews(draft, body.views);
    keepStyle(body.style);
    return save(draft, { files: !!body.views });
  });
  api.routes.post('/draft/ref', ({ body = {} }) => {
    const draft = read(known(body.slug)), m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(typeof body.data === 'string' ? body.data : '');
    if (!m) refuse(400, 'reference: a PNG, JPEG or WebP image');
    if (draft.refs.length >= MAX_REFS) refuse(400, `references: at most ${MAX_REFS}`);
    const n = draft.refs.reduce((max, r) => Math.max(max, Number(/ref-(\d+)\./.exec(r)?.[1]) || 0), 0) + 1;
    const path = `${dirOf(draft.slug)}/refs/ref-${n}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    f.write(path, Buffer.from(m[2], 'base64'));
    return save({ ...draft, refs: [...draft.refs, path] });
  });
  api.routes.post('/draft/unref', ({ body = {} }) => {
    const draft = read(known(body.slug));
    if (!draft.refs.includes(body.ref)) refuse(400, 'reference: not one of this draft\'s');
    f.remove(body.ref);
    return save({ ...draft, refs: draft.refs.filter((r) => r !== body.ref) });
  });
  // a round starts here and is run by the page through the image service, with the input this answers
  api.routes.post('/draft/round', ({ body = {} }) => {
    const before = read(known(body.slug));
    const { draft, round } = startRound(before, body.step, { prompt: body.prompt, count: body.count, folder: folderFor(before, body.step, Date.now()), at: Date.now() });
    const references = body.step === 'concept' ? draft.refs : [`${dirOf(draft.slug)}/concept.png`];
    return { ...save(draft, { files: body.step !== 'concept' }), round, input: { prompt: round.prompt, count: round.count, references, folder: round.folder } };
  });
  // ...and ends here: its images are what is in its folder, whatever the page says
  api.routes.post('/draft/settle', ({ body = {} }) => {
    const draft = read(known(body.slug)), rounds = body.step === 'concept' ? draft.concept.rounds : draft.views.rounds[body.step] || [];
    const round = rounds.find((r) => r.id === body.round);
    return save(settleRound(draft, body.step, body.round, { images: round ? imagesIn(round.folder) : [], error: typeof body.error === 'string' && body.error ? body.error.slice(0, 2000) : null }));
  });
  api.routes.post('/draft/pick', ({ body = {} }) => {
    const draft = read(known(body.slug));
    return save(body.step === 'concept' ? pickConcept(draft, body.image) : pickView(draft, body.step, body.image), { files: body.step !== 'concept' });
  });
  api.routes.post('/draft/approve', ({ body = {} }) => {
    const draft = read(known(body.slug));
    if (body.step === 'concept') return save(approveConcept(draft, { confirm: body.confirm === true }), { files: true });
    if (body.step === 'views') return save(approveViews(draft), { files: true });
    return refuse(400, 'step: concept or views');
  });
  api.routes.post('/draft/delete', ({ body = {} }) => { const slug = known(body.slug); f.remove(dirOf(slug)); api.events.emit('changed', { slug }); return {}; });
  // an image of a round or of a draft, for the page to show
  api.routes.get('/image', ({ query }) => {
    const path = String(query.path || '');
    if (!IMAGE.test(path) || !/^\.nfgames\/(images|drafts)\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) refuse(404, 'not here');
    return api.routes.file(path);
  });
}
