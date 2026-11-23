// A draft of a new model: its steps (concept, then views, then ready) and the rules between them, without files.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, EXTRA_VIEWS, slugOf, newDraft, viewPrompt, folderFor, startRound, settleRound, reconcile, pickConcept, pickView, approveConcept, setViews, approveViews, filesToKeep, MODEL_SIDES, MODEL_POLES, whereOf, cleanNotes, revisionPrompt, startRevision, modelViews, setModel } from '../plugins/model-maker/draft.mjs';

const img = (folder, n = 1) => `.nfgames/images/${folder}/image-${n}.png`;
/** A draft with a finished concept round ('c1', two images), nothing picked. */
function withConcept() {
  let d = newDraft({ slug: 'lantern', name: 'Brass lantern', description: 'a small brass street lantern', style: 'hand-painted, low poly' });
  ({ draft: d } = startRound(d, 'concept', { prompt: 'p', count: 2, folder: 'c1', at: 1 }));
  return settleRound(d, 'concept', d.concept.rounds[0].id, { images: [img('c1', 1), img('c1', 2)] });
}
/** ...the first image approved, and every listed view with a finished round and a pick. */
function withViews({ approve = false } = {}) {
  let d = approveConcept(pickConcept(withConcept(), img('c1', 1)));
  for (const v of d.views.list) {
    let r; ({ draft: d, round: r } = startRound(d, v, { prompt: viewPrompt(d, v), count: 1, folder: `v-${v}`, at: 2 }));
    d = pickView(settleRound(d, v, r.id, { images: [img(`v-${v}`)] }), v, img(`v-${v}`));
  }
  return approve ? approveViews(d) : d;
}

describe('a draft\'s name and folder', () => {
  it('the folder name is safe whatever the name is', () => {
    assert.equal(slugOf('Brass Lantern!'), 'brass-lantern');
    assert.equal(slugOf('../../etc'), 'etc'); assert.equal(slugOf('🏮'), 'model'); assert.equal(slugOf(''), 'model'); assert.equal(slugOf('   '), 'model');
    assert.equal(slugOf('x'.repeat(300)).length, 40); assert.equal(slugOf(`${'x'.repeat(39)} y`), 'x'.repeat(39));   // no dash left at the cut
    assert.equal(slugOf('Brass lantern', new Set(['brass-lantern', 'brass-lantern-2'])), 'brass-lantern-3');
    assert.equal(slugOf(null), 'model');
  });
  it('the name is kept as typed, trimmed and of a sane length; a draft needs one', () => {
    assert.equal(newDraft({ slug: 'a', name: '  Brass 🏮 ' }).name, 'Brass 🏮');
    assert.equal(newDraft({ slug: 'a', name: 'n'.repeat(300) }).name.length, 200);
    assert.throws(() => newDraft({ slug: 'a', name: '  ' }), /name/);
  });
  it('a new draft starts at the concept, with the four views listed', () => {
    const d = newDraft({ slug: 'a', name: 'A' });
    assert.equal(d.version, 1); assert.equal(d.status, 'concept'); assert.deepEqual(d.views.list, ['front', 'back', 'left', 'right']); assert.deepEqual(VIEWS, d.views.list);
    assert.deepEqual(EXTRA_VIEWS, ['three-quarter', 'top', 'bottom']);
  });
  it('a round\'s folder fits what the image service takes, however long the name', () => {
    const d = newDraft({ slug: 'x'.repeat(40), name: 'A' });
    for (const step of ['concept', 'three-quarter']) assert.match(folderFor(d, step, Date.UTC(2026, 10, 23, 12, 0, 0)), /^[a-z0-9][a-z0-9-]{0,79}$/);
    assert.notEqual(folderFor(d, 'front', 1000), folderFor(d, 'front', 2000));
  });
});

describe('a draft\'s rounds', () => {
  it('a round is pending, then done with its images, or failed with what it saved', () => {
    let { draft, round } = startRound(newDraft({ slug: 'a', name: 'A' }), 'concept', { prompt: 'p', count: 99, folder: 'f1', at: 5 });
    assert.deepEqual(round, { id: round.id, folder: 'f1', prompt: 'p', count: 8, state: 'pending', images: [], error: null, at: 5 });
    assert.equal(settleRound(draft, 'concept', round.id, { images: [img('f1')] }).concept.rounds[0].state, 'done');
    const failed = settleRound(draft, 'concept', round.id, { images: [img('f1')], error: 'Codex did not finish' }).concept.rounds[0];
    assert.equal(failed.state, 'failed'); assert.deepEqual(failed.images, [img('f1')]); assert.equal(failed.error, 'Codex did not finish');
    assert.equal(settleRound(draft, 'concept', round.id, {}).concept.rounds[0].state, 'failed');   // finished with nothing saved
    assert.throws(() => settleRound(draft, 'concept', 'nope', {}), /round/);
    assert.equal(draft.concept.rounds[0].state, 'pending');   // the draft given is not changed
  });
  it('rounds of one step have different ids', () => {
    let d = newDraft({ slug: 'a', name: 'A' }), a, b;
    ({ draft: d, round: a } = startRound(d, 'concept', { prompt: 'p', count: 1, folder: 'f1', at: 1 }));
    ({ draft: d, round: b } = startRound(d, 'concept', { prompt: 'p', count: 1, folder: 'f2', at: 1 }));
    assert.notEqual(a.id, b.id); assert.equal(d.concept.rounds.length, 2);
  });
  it('a view cannot be generated before the concept is approved, nor a step that is not one', () => {
    assert.throws(() => startRound(newDraft({ slug: 'a', name: 'A' }), 'front', { prompt: 'p', count: 1, folder: 'f', at: 1 }), /concept/);
    assert.throws(() => startRound(withViews(), 'top', { prompt: 'p', count: 1, folder: 'f', at: 1 }), /step/);   // not in this draft's list
    assert.throws(() => startRound(withViews(), '__proto__', { prompt: 'p', count: 1, folder: 'f', at: 1 }), /step/);
  });
  it('a tab closed mid-run: the round waits while the editor is busy, then is done with its images or failed', () => {
    const { draft } = startRound(newDraft({ slug: 'a', name: 'A' }), 'concept', { prompt: 'p', count: 4, folder: 'a-concept-1', at: 1 });
    assert.equal(reconcile(draft, { imagesIn: () => [img('a-concept-1')], busy: true }).concept.rounds[0].state, 'pending');
    const done = reconcile(draft, { imagesIn: (f) => (f === 'a-concept-1' ? [img(f)] : []), busy: false }).concept.rounds[0];
    assert.equal(done.state, 'done'); assert.deepEqual(done.images, [img('a-concept-1')]);
    const lost = reconcile(draft, { imagesIn: () => [], busy: false }).concept.rounds[0];
    assert.equal(lost.state, 'failed'); assert.match(lost.error, /interrupted/);
  });
  it('reconciling looks at view rounds too, and leaves finished rounds alone', () => {
    let d = withViews(); ({ draft: d } = startRound(d, 'left', { prompt: 'p', count: 1, folder: 'v-left-2', at: 3 }));
    const r = reconcile(d, { imagesIn: (f) => [img(f)], busy: false });
    assert.deepEqual(r.views.rounds.left.map((x) => x.state), ['done', 'done']); assert.deepEqual(r.concept.rounds[0].images, [img('c1', 1), img('c1', 2)]);
    assert.equal(reconcile(r, { imagesIn: () => [], busy: false }), r);   // nothing pending: the same draft
  });
});

describe('a draft\'s steps', () => {
  it('only an image of that step\'s rounds can be picked', () => {
    assert.equal(pickConcept(withConcept(), img('c1', 2)).concept.pick, img('c1', 2));
    assert.throws(() => pickConcept(withConcept(), 'maps/plaza/layout.json'), /image/);
    assert.throws(() => pickView(withViews(), 'front', img('v-back')), /image/);
    assert.throws(() => pickView(withViews(), 'top', img('v-back')), /step/);
  });
  it('approving the concept needs a pick and opens the views', () => {
    assert.throws(() => approveConcept(withConcept()), /pick/);
    const d = approveConcept(pickConcept(withConcept(), img('c1', 1)));
    assert.equal(d.status, 'views'); assert.equal(d.concept.approved, img('c1', 1)); assert.deepEqual(filesToKeep(d), { concept: img('c1', 1), views: {} });
  });
  it('a view\'s prompt is drafted from the description, the style and the side, until it is written', () => {
    const d = withViews(), p = viewPrompt(d, 'left');
    assert.match(p, /a small brass street lantern/); assert.match(p, /hand-painted, low poly/); assert.match(p, /left/); assert.match(p, /orthographic/i);
    assert.notEqual(p, viewPrompt(d, 'back'));
    assert.equal(viewPrompt(setViews(d, { list: d.views.list, prompts: { left: 'my own words' } }), 'left'), 'my own words');
  });
  it('the views are approved when every listed view has a pick', () => {
    let d = approveConcept(pickConcept(withConcept(), img('c1', 1)));
    assert.throws(() => approveViews(d), /every view/);
    d = withViews({ approve: true });
    assert.equal(d.status, 'ready'); assert.equal(d.views.approved, true);
    assert.deepEqual(filesToKeep(d), { concept: img('c1', 1), views: { front: img('v-front'), back: img('v-back'), left: img('v-left'), right: img('v-right') } });
  });
  it('a new concept clears the approved views, only after a yes', () => {
    const ready2 = pickConcept(withViews({ approve: true }), img('c1', 2));
    assert.equal(ready2.status, 'ready');   // picking alone changes nothing yet
    assert.throws(() => approveConcept(ready2), (e) => e.code === 409 && e.needsConfirm === true);
    const back = approveConcept(ready2, { confirm: true });
    assert.equal(back.status, 'views'); assert.equal(back.concept.approved, img('c1', 2)); assert.deepEqual(back.views.picks, {}); assert.equal(back.views.approved, false);
    assert.deepEqual(filesToKeep(back).views, {}); assert.equal(back.views.rounds.front.length, 1);   // the old rounds stay listed
    assert.equal(approveConcept(withViews({ approve: true })).status, 'ready');   // the same concept again: nothing to clear
  });
  it('views made from another concept are not this concept\'s: they cannot be picked, so they cannot be approved', () => {
    const d = approveConcept(pickConcept(withViews({ approve: true }), img('c1', 2)), { confirm: true });
    assert.equal(d.views.rounds.front[0].concept, img('c1', 1));   // each view round says which concept it was made from
    assert.throws(() => pickView(d, 'front', img('v-front')), /image/);
    const { draft, round } = startRound(d, 'front', { prompt: 'p', count: 1, folder: 'v-front-b', at: 5 });
    assert.equal(round.concept, img('c1', 2));
    assert.equal(pickView(settleRound(draft, 'front', round.id, { images: [img('v-front-b')] }), 'front', img('v-front-b')).views.picks.front, img('v-front-b'));
  });
  it('touching a view after the views were approved takes the draft back to the views step', () => {
    const ready = withViews({ approve: true });
    const again = startRound(ready, 'front', { prompt: 'p', count: 1, folder: 'v-front-2', at: 9 }).draft;
    assert.equal(again.status, 'views'); assert.equal(again.views.approved, false); assert.deepEqual(filesToKeep(again).views, {});
    assert.equal(pickView(ready, 'front', img('v-front')).status, 'views');
    assert.equal(setViews(ready, { list: ['front', 'back'], prompts: {} }).status, 'views');
  });
  it('the list of views: known views only, in their order, at least one; a dropped view loses its pick', () => {
    const d = setViews(withViews(), { list: ['top', 'front'], prompts: { top: 'from above' } });
    assert.deepEqual(d.views.list, ['front', 'top']); assert.deepEqual(Object.keys(d.views.picks), ['front']); assert.equal(d.views.prompts.top, 'from above');
    assert.throws(() => setViews(withViews(), { list: [] }), /view/); assert.throws(() => setViews(withViews(), { list: ['front', 'inside-out'] }), /view/);
    assert.throws(() => approveViews(d), /every view/);   // top has no pick yet
  });
});

describe('revisions and the model step', () => {
  /** A draft with these views listed, each with a round and a pick, approved. */
  const ready = (list) => {
    let d = setViews(approveConcept(pickConcept(withConcept(), img('c1', 1))), { list });
    for (const v of d.views.list) {
      let r; ({ draft: d, round: r } = startRound(d, v, { prompt: 'p', count: 1, folder: `v-${v}`, at: 2 }));
      d = pickView(settleRound(d, v, r.id, { images: [img(`v-${v}`)] }), v, img(`v-${v}`));
    }
    return approveViews(d);
  };
  it('bottom is a view that can be listed, after top', () => {
    const d = setViews(withConcept(), { list: ['bottom', 'front', 'top'] });
    assert.deepEqual(d.views.list, ['front', 'top', 'bottom']);
    assert.match(viewPrompt(d, 'bottom'), /straight up from below/);
    assert.match(viewPrompt(d, 'top'), /front of the object pointing to the top of the picture/);
    assert.doesNotMatch(viewPrompt(d, 'front'), /pointing to the top of the picture/);
    assert.match(viewPrompt(d, 'front'), /nothing cropped/);
  });
  it('whereOf names the ninth of the picture', () => {
    assert.equal(whereOf(0, 0), 'upper left'); assert.equal(whereOf(0.5, 0.5), 'centre');
    assert.equal(whereOf(1, 1), 'lower right'); assert.equal(whereOf(0.5, 0.1), 'top centre'); assert.equal(whereOf(0.9, 0.5), 'right side');
    assert.equal(whereOf(0.1, 0.5), 'left side'); assert.equal(whereOf(0.5, 0.9), 'bottom centre'); assert.equal(whereOf(0.9, 0.1), 'upper right'); assert.equal(whereOf(0.1, 0.9), 'lower left');
  });
  it('cleanNotes clamps, cuts and refuses', () => {
    const c = cleanNotes({ pins: [{ x: -1, y: 2, note: ' wrong window ' }, { x: 0.5, y: 0.5, note: '' }], note: 'x'.repeat(1200) });
    assert.deepEqual(c.pins, [{ x: 0, y: 1, note: 'wrong window' }]); assert.equal(c.note.length, 1000);
    assert.equal(cleanNotes({ pins: [{ x: 0, y: 0, note: 'n'.repeat(400) }] }).pins[0].note.length, 300);
    assert.throws(() => cleanNotes({ pins: [{ x: 'a', y: 0, note: 'n' }] }), /pins/);
    assert.throws(() => cleanNotes({ pins: [{ x: NaN, y: 0, note: 'n' }] }), /pins/);
    assert.throws(() => cleanNotes({ pins: 'nope', note: 'n' }), /pins/);
    assert.throws(() => cleanNotes({ pins: Array.from({ length: 13 }, () => ({ x: 0, y: 0, note: 'n' })) }), /at most 12/);
    assert.throws(() => cleanNotes({ pins: [], note: '  ' }), /say what to change/);
    assert.throws(() => cleanNotes(), /say what to change/);
    assert.deepEqual(cleanNotes({ note: ' wider ' }), { pins: [], note: 'wider' });
  });
  it('a revision is a new round of the step, made from the image', () => {
    const d0 = withConcept();
    const { draft, round } = startRevision(d0, 'concept', { image: img('c1', 1), pins: [{ x: 0.1, y: 0.1, note: 'no antenna' }], note: 'keep the glass', folder: 'f2', at: 2, marked: 'm.png' });
    assert.equal(round.from, img('c1', 1)); assert.equal(round.count, 2); assert.equal(round.state, 'pending'); assert.equal(round.marked, 'm.png');
    assert.deepEqual(round.pins, [{ x: 0.1, y: 0.1, note: 'no antenna' }]); assert.equal(round.note, 'keep the glass');
    assert.ok(round.prompt.startsWith('p\n\nRevise the first reference image'));
    assert.match(round.prompt, /1 \(upper left\): no antenna/); assert.match(round.prompt, /Also: keep the glass/); assert.match(round.prompt, /markers are not part of the picture/);
    assert.doesNotMatch(round.prompt, /concept the object comes from/);
    assert.equal(draft.concept.rounds.length, 2); assert.equal(d0.concept.rounds.length, 1);
    assert.throws(() => startRevision(d0, 'concept', { image: 'zzz.png', pins: [], note: 'n', folder: 'f', at: 1 }), /not an image/);
    assert.throws(() => startRevision(d0, 'concept', { image: img('c1', 1), pins: [], note: '', folder: 'f', at: 1 }), /say what to change/);
    // without a marked copy the prompt does not speak of one
    assert.doesNotMatch(startRevision(d0, 'concept', { image: img('c1', 1), note: 'n', folder: 'f', at: 1 }).round.prompt, /markers/);
    assert.equal(startRevision(d0, 'concept', { image: img('c1', 1), note: 'n', count: 5, folder: 'f', at: 1 }).round.count, 5);
  });
  it('a view is revised from a round of the approved concept only, and the concept goes with it', () => {
    let d = withViews({ approve: true });
    const { draft, round } = startRevision(d, 'front', { image: img('v-front'), note: 'door on the other side', folder: 'f', at: 3 });
    assert.equal(round.concept, d.concept.approved); assert.match(round.prompt, /The last reference image is the concept the object comes from/);
    assert.equal(draft.status, 'views'); assert.equal(draft.views.approved, false);
    d = approveConcept(pickConcept(d, img('c1', 2)), { confirm: true });
    assert.throws(() => startRevision(d, 'front', { image: img('v-front'), note: 'n', folder: 'f', at: 4 }), /made from the approved concept/);
    assert.equal(revisionPrompt(d, 'concept', { prompt: 'base' }, { pins: [], note: 'n', marked: null }), 'base\n\nRevise the first reference image: make the same picture again with only the changes listed here, and leave everything not mentioned exactly as it is.\nAlso: n');
  });
  it('modelViews: four sides needed, the poles only as a pair', () => {
    assert.deepEqual(MODEL_SIDES, ['front', 'left', 'back', 'right']); assert.deepEqual(MODEL_POLES, ['top', 'bottom']);
    assert.deepEqual(modelViews(ready(['front', 'back', 'left', 'right', 'top'])), { views: ['front', 'left', 'back', 'right'], missing: [] });
    assert.deepEqual(modelViews(ready(['front', 'back', 'left', 'right', 'top', 'bottom'])).views, ['front', 'left', 'back', 'right', 'top', 'bottom']);
    assert.deepEqual(modelViews(ready(['front', 'back', 'three-quarter'])).missing, ['left', 'right']);
    assert.deepEqual(modelViews(withViews()), { views: [], missing: [] });   // picked but not approved: nothing to make a model from yet
  });
  it('setModel records the model on a ready draft only', () => {
    const d = setModel(withViews({ approve: true }), { path: 'models/lantern/lantern.glb', length: 0.6, at: 9 });
    assert.deepEqual(d.model, { path: 'models/lantern/lantern.glb', length: 0.6, at: 9 });
    assert.throws(() => setModel(withViews(), { path: 'x', length: 1, at: 1 }), /approve the views/);
  });
});
