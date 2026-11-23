// A draft of a new model, and the rules of its three steps: a concept image is generated and approved, then one image
// per view (front, back, left, right…) made from that concept and approved, and then the draft is ready for the model
// step. Nothing here touches files: every function returns a new draft and leaves the one it was given alone.
//
//   { version: 1, slug, name, description, style, status: 'concept' | 'views' | 'ready', refs: [paths],
//     concept: { rounds: [round], pick: image | null, approved: image | null },
//     views: { list: [view], prompts: { view: text }, rounds: { view: [round] }, picks: { view: image }, approved: boolean } }
//     model: { path, length, at } }   (once the model step has made one)
//   round: { id, folder, prompt, count, state: 'pending' | 'done' | 'failed', images: [paths], error, at }
//   a round that revises an image also has `from` (that image), `pins: [{ x, y, note }]` (0 to 1 from the image's top
//   left), `note` and `marked` (the copy with the pins drawn on it, or null).
//   a view's round also has `concept`: the approved concept image it was made from. Rounds made from another
//   concept stay listed but are not this concept's views: their images cannot be picked.
export const VIEWS = ['front', 'back', 'left', 'right'];
export const EXTRA_VIEWS = ['three-quarter', 'top', 'bottom'];
/** What the model step is made from: these four, and top and bottom when there are both. */
export const MODEL_SIDES = ['front', 'left', 'back', 'right'], MODEL_POLES = ['top', 'bottom'];
const ALL_VIEWS = [...VIEWS, ...EXTRA_VIEWS];
const copy = (draft) => structuredClone(draft);
const refuse = (text, extra = {}) => { throw Object.assign(new Error(text), { code: 400, ...extra }); };

/** A folder name for a draft called `name`: letters, digits and dashes, at most 40, not one of `taken`. */
export function slugOf(name, taken = new Set()) {
  const base = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'model';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) { const s = `${base.slice(0, 40 - String(n).length - 1)}-${n}`; if (!taken.has(s)) return s; }
}

export function newDraft({ slug, name, description = '', style = '' }) {
  const shown = String(name ?? '').trim().slice(0, 200);
  if (!shown) refuse('name: give the model a name');
  return { version: 1, slug, name: shown, description: String(description), style: String(style), status: 'concept', refs: [],
    concept: { rounds: [], pick: null, approved: null }, views: { list: [...VIEWS], prompts: {}, rounds: {}, picks: {}, approved: false } };
}

const SIDES = { front: 'straight from the front', back: 'straight from the back', left: 'from its left side, its front pointing to the left of the picture', right: 'from its right side, its front pointing to the right of the picture', 'three-quarter': 'from a three-quarter angle, front and right side showing', top: 'straight down from above', bottom: 'straight up from below' };
/** The prompt for a view: the user's own once written, else drafted from the description, the style and the side. */
export function viewPrompt(draft, view) {
  const own = draft.views.prompts[view];
  if (typeof own === 'string' && own.trim()) return own;
  return [draft.description.trim(), draft.style.trim() && `Style: ${draft.style.trim()}.`,
    `The same object as in the reference image, unchanged in shape, proportions, colours and materials, seen ${SIDES[view] || view} (${view} view). Orthographic, no perspective. The whole object in frame with nothing cropped, centred, on a plain neutral grey background, in even soft light, with no shadow on the ground, no text and nothing else in the picture.${MODEL_POLES.includes(view) ? ' The front of the object pointing to the top of the picture, and its length and width in the same proportion as the reference shows.' : ''}`].filter(Boolean).join('\n');
}

/** The image service's folder for a round: a name it takes (letters, digits, dashes, at most 80), new each time. */
export function folderFor(draft, step, now) {
  const time = new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 17);   // to the millisecond
  return `${draft.slug.slice(0, 40)}-${String(step).replace(/[^a-z0-9]+/g, '-')}-${time}`.slice(0, 80);
}

const isView = (draft, step) => typeof step === 'string' && draft.views.list.includes(step);
/** The rounds of a step ('concept' or a listed view), made if there are none yet. */
function roundsOf(draft, step) {
  if (step === 'concept') return draft.concept.rounds;
  if (!isView(draft, step)) refuse(`step: ${step} is not a step of this draft`);
  if (!Object.hasOwn(draft.views.rounds, step)) draft.views.rounds[step] = [];
  return draft.views.rounds[step];
}
/** A change to the views after they were approved takes the draft back to the views step. */
const reopenViews = (draft) => { draft.views.approved = false; if (draft.status === 'ready') draft.status = 'views'; };

/** Starts a round of a step: { draft, round }, the round pending until settled. */
export function startRound(draft, step, { prompt, count, folder, at }) {
  const d = copy(draft), rounds = roundsOf(d, step);
  if (step !== 'concept' && !d.concept.approved) refuse('concept: approve a concept image before making views');
  if (typeof prompt !== 'string' || !prompt.trim()) refuse('prompt: describe the image');
  const round = { id: `r${rounds.reduce((n, r) => Math.max(n, Number(r.id.slice(1)) || 0), 0) + 1}`, folder, prompt, count: Math.max(1, Math.min(8, Math.round(Number(count)) || 1)), state: 'pending', images: [], error: null, at, ...(step === 'concept' ? {} : { concept: d.concept.approved }) };
  rounds.push(round);
  if (step !== 'concept') reopenViews(d);
  return { draft: d, round: { ...round } };
}

/** Where a point of an image is, in words: the ninth of the picture it falls in (x, y from 0 to 1, from the top left). */
export function whereOf(x, y) {
  const col = x < 1 / 3 ? 0 : x > 2 / 3 ? 2 : 1, row = y < 1 / 3 ? 0 : y > 2 / 3 ? 2 : 1;
  return [['upper left', 'top centre', 'upper right'], ['left side', 'centre', 'right side'], ['lower left', 'bottom centre', 'lower right']][row][col];
}
/** Notes as they are kept: pins inside the image with a note each (at most 12), and one overall note. */
export function cleanNotes({ pins = [], note = '' } = {}) {
  if (!Array.isArray(pins) || pins.some((p) => !p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y))) refuse('pins: each is { x, y, note } with x and y from 0 to 1');
  if (pins.length > 12) refuse('pins: at most 12');
  const unit = (n) => Math.max(0, Math.min(1, n));
  const kept = pins.map((p) => ({ x: unit(p.x), y: unit(p.y), note: String(p.note ?? '').trim().slice(0, 300) })).filter((p) => p.note);
  const all = String(note ?? '').trim().slice(0, 1000);
  if (!kept.length && !all) refuse('notes: say what to change');
  return { pins: kept, note: all };
}
/** The prompt of a round that revises an image of `round`: that round's own prompt, then what to change. */
export function revisionPrompt(draft, step, round, { pins, note, marked = null }) {
  return [`${round.prompt}\n`,
    'Revise the first reference image: make the same picture again with only the changes listed here, and leave everything not mentioned exactly as it is.',
    ...pins.map((p, i) => `${i + 1} (${whereOf(p.x, p.y)}): ${p.note}`), note && `Also: ${note}`,
    marked && 'The second reference image is the first with numbered markers showing where each change belongs. The markers are not part of the picture and must not appear in the result.',
    step !== 'concept' && 'The last reference image is the concept the object comes from.'].filter(Boolean).join('\n');
}
/** Starts a round that revises `image` (one of this step's; a view's must be of the approved concept): { draft, round }. */
export function startRevision(draft, step, { image, pins, note, count = 2, folder, at, marked = null }) {
  const mine = roundsOf(copy(draft), step).filter((r) => step === 'concept' || r.concept === draft.concept.approved);
  const source = typeof image === 'string' && mine.find((r) => r.images.includes(image));
  if (!source) refuse(step === 'concept' ? 'image: not an image of this draft\'s concept' : `image: not an image of this draft's ${step} view, made from the approved concept`);
  const notes = cleanNotes({ pins, note });
  const started = startRound(draft, step, { prompt: revisionPrompt(draft, step, source, { ...notes, marked }), count, folder, at });
  const round = (step === 'concept' ? started.draft.concept.rounds : started.draft.views.rounds[step]).find((r) => r.id === started.round.id);
  Object.assign(round, { from: image, ...notes, marked });
  return { draft: started.draft, round: structuredClone(round) };
}

/** Ends a round: done with at least one image and no error, else failed (what it saved is kept either way). */
export function settleRound(draft, step, id, { images = [], error = null } = {}) {
  const d = copy(draft), round = roundsOf(d, step).find((r) => r.id === id);
  if (!round) refuse(`round: no round ${id} in ${step}`);
  round.images = [...images]; round.error = error || (images.length ? null : 'It finished without saving an image.');
  round.state = images.length && !error ? 'done' : 'failed';
  return d;
}

/** Settles rounds left pending (the tab closed mid-run) from what is in their folders, once the editor is not busy. */
export function reconcile(draft, { imagesIn, busy }) {
  const steps = ['concept', ...Object.keys(draft.views.rounds)];
  const pending = steps.flatMap((step) => (step === 'concept' ? draft.concept.rounds : draft.views.rounds[step]).filter((r) => r.state === 'pending').map((r) => [step, r]));
  if (busy || !pending.length) return draft;
  const d = copy(draft);
  for (const [step, r] of pending) {
    const images = imagesIn(r.folder), round = (step === 'concept' ? d.concept.rounds : d.views.rounds[step]).find((x) => x.id === r.id);
    round.images = images; round.state = images.length ? 'done' : 'failed'; round.error = images.length ? null : 'This run was interrupted.';
  }
  return d;
}

const has = (rounds, image) => typeof image === 'string' && rounds.some((r) => r.images.includes(image));
export function pickConcept(draft, image) {
  if (!has(draft.concept.rounds, image)) refuse('image: not an image of this draft\'s concept');
  const d = copy(draft); d.concept.pick = image; return d;
}
export function pickView(draft, view, image) {
  const d = copy(draft);
  if (!has(roundsOf(d, view).filter((r) => r.concept === d.concept.approved), image)) refuse(`image: not an image of this draft's ${view} view, made from the approved concept`);
  d.views.picks[view] = image; reopenViews(d);
  return d;
}

/** Approves the picked concept. A different concept from the one the views were made from clears their picks: that
 *  needs `confirm`, else the error has code 409 and needsConfirm. */
export function approveConcept(draft, { confirm = false } = {}) {
  if (!draft.concept.pick) refuse('pick: choose a concept image first');
  const d = copy(draft), changed = d.concept.approved && d.concept.approved !== d.concept.pick;
  const made = Object.keys(d.views.picks).length || Object.values(d.views.rounds).some((r) => r.length);
  if (changed && made) {
    if (!confirm) refuse('The views were made from the concept approved before: approving this one clears the views you chose.', { code: 409, needsConfirm: true });
    d.views.picks = {}; d.views.approved = false;
  }
  d.concept.approved = d.concept.pick;
  if (d.status === 'concept' || (changed && made)) d.status = 'views';
  return d;
}

/** Which views the draft lists (known views, in their order, at least one) and the prompts the user wrote for them. */
export function setViews(draft, { list, prompts = {} } = {}) {
  if (!Array.isArray(list) || !list.length || list.some((v) => !ALL_VIEWS.includes(v))) refuse(`views: one or more of ${ALL_VIEWS.join(', ')}`);
  const d = copy(draft);
  d.views.list = ALL_VIEWS.filter((v) => list.includes(v));
  d.views.picks = Object.fromEntries(Object.entries(d.views.picks).filter(([v]) => d.views.list.includes(v)));
  d.views.prompts = Object.fromEntries(d.views.list.map((v) => [v, typeof prompts[v] === 'string' ? prompts[v] : d.views.prompts[v]]).filter(([, text]) => typeof text === 'string' && text.trim()));
  reopenViews(d);
  return d;
}

export function approveViews(draft) {
  if (!draft.concept.approved) refuse('concept: approve a concept image first');
  const missing = draft.views.list.filter((v) => !draft.views.picks[v]);
  if (missing.length) refuse(`every view needs a pick: ${missing.join(', ')}`);
  const d = copy(draft); d.views.approved = true; d.status = 'ready'; return d;
}

/** What the draft's folder holds besides draft.json: concept.png from this image, views/<view>.png from these. */
export function filesToKeep(draft) {
  return { concept: draft.concept.approved, views: draft.views.approved ? Object.fromEntries(draft.views.list.map((v) => [v, draft.views.picks[v]])) : {} };
}

/** What a model can be made from now: the approved sides and, as a pair, top and bottom; and the sides still missing. */
export function modelViews(draft) {
  const got = (v) => draft.views.approved && draft.views.list.includes(v) && !!draft.views.picks[v];
  const poles = MODEL_POLES.every(got) ? MODEL_POLES : [];
  return { views: [...MODEL_SIDES.filter(got), ...poles], missing: draft.views.approved ? MODEL_SIDES.filter((v) => !got(v)) : [] };
}
/** Records the model the model step made. */
export function setModel(draft, { path, length, at }) {
  if (draft.status !== 'ready') refuse('model: approve the views first');
  const d = copy(draft); d.model = { path, length, at }; return d;
}
