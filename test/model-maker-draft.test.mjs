// A draft of a new model: its steps (concept, then views, then ready) and the rules between them, without files.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, EXTRA_VIEWS, slugOf, newDraft, viewPrompt, folderFor, startRound, settleRound, reconcile, pickConcept, pickView, approveConcept, setViews, approveViews, filesToKeep } from '../plugins/model-maker/draft.mjs';

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
    assert.deepEqual(EXTRA_VIEWS, ['three-quarter', 'top']);
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
