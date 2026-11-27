// Review jobs: what the viewer sends is checked, written under server-made names, listed with its state, and seen once
// by the watcher. A model's own reference images are named in the job, not copied into it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { createReview, listReviews, newJobs, imageFromDataUrl, normaliseWorkflows, slug, jobId, DEFAULT_WORKFLOWS } from '../src/reviews.mjs';
import { sampleCopy, makeGlb, dataBytes, PNG_1PX, JPEG_SIG } from './helpers.mjs';

const pin = (extra = {}) => ({ note: 'nose too blunt', position: [1, 2, 3], normal: [0, 1, 0], mesh: 'hull', material: 'paint', uv: [0.5, 0.25], camera: { position: [10, 5, 10], target: [0, 0, 0], fov: 50 }, screenshot: JPEG_SIG, refs: [PNG_1PX], ...extra });
const MODEL = 'ships/Light Cruiser.glb';

describe('review jobs', () => {
  let copy, project, inbox;
  before(async () => {
    copy = sampleCopy();
    mkdirSync(join(copy.root, 'models', 'ships'), { recursive: true });
    writeFileSync(join(copy.root, 'models', MODEL), makeGlb());
    project = await loadProject({ root: copy.root, config: { models: 'models' } });
    inbox = join(copy.root, '.review');
  });
  after(() => copy.done());

  it('names', () => {
    assert.equal(slug('ships/Light Cruiser_v2.GLB'), 'light-cruiser-v2');
    assert.equal(slug('...glb'), 'model');
    assert.equal(jobId(join(copy.root, 'none'), 'a/b.glb', new Date('2026-11-22T04:12:33.456Z')), '2026-11-22T041233-b');
  });
  it('images are checked by their bytes', () => {
    assert.equal(imageFromDataUrl(PNG_1PX, 'x').ext, 'png');
    assert.equal(imageFromDataUrl(JPEG_SIG, 'x').ext, 'jpg');
    assert.throws(() => imageFromDataUrl(PNG_1PX.replace('image/png', 'image/jpeg'), 'ref'), /not a JPG image/);
    assert.throws(() => imageFromDataUrl('data:image/svg+xml;base64,PHN2Zz4=', 'ref'), /not a PNG, JPEG or WebP/);
    assert.throws(() => imageFromDataUrl(`data:image/png;base64,${Buffer.alloc(7 * 1024 * 1024).toString('base64')}`, 'ref'), /larger than/);
  });
  it('writes a job folder with server-made names', () => {
    const { id } = createReview(project, { model: MODEL, note: 'overall', workflow: 'auto', overview: JPEG_SIG, pins: [pin(), pin({ refs: [] })] }, { now: new Date('2026-11-22T04:12:33Z') });
    assert.equal(id, '2026-11-22T041233-light-cruiser');
    const dir = join(inbox, id);
    assert.deepEqual(readdirSync(dir).sort(), ['job.json', 'overview.jpg', 'pin-1-ref-1.png', 'pin-1.jpg', 'pin-2.jpg']);
    const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
    assert.equal(job.model.path, MODEL); assert.equal(job.model.sha256.length, 64);
    assert.equal(job.workflow.id, 'auto'); assert.match(job.workflow.instructions, /build/);
    assert.deepEqual(job.pins[0].refs, ['pin-1-ref-1.png']); assert.equal(job.pins[0].screenshot, 'pin-1.jpg'); assert.deepEqual(job.pins[0].uv, [0.5, 0.25]);
    assert.ok(!existsSync(`${dir}.tmp`));
  });
  it('names the model\'s own reference images in the job, without copying them', () => {
    const refs = join(copy.root, 'models', 'ships', 'Light Cruiser.refs');
    const bare = createReview(project, { model: MODEL, workflow: 'auto', note: 'no refs yet' }, { now: new Date('2026-11-22T05:00:00Z') });
    const before = JSON.parse(readFileSync(join(inbox, bare.id, 'job.json'), 'utf8'));
    assert.deepEqual(before.references, []); assert.doesNotMatch(before.workflow.instructions, /Reference images/);
    mkdirSync(refs);
    for (const [name, data] of [['left.png', dataBytes(PNG_1PX)], ['concept.png', dataBytes(PNG_1PX)], ['front.jpg', dataBytes(JPEG_SIG)], ['notes.txt', 'x'], ['icon.svg', '<svg/>']]) writeFileSync(join(refs, name), data);
    try {
      const { id } = createReview(project, { model: MODEL, workflow: 'auto', note: 'compare with the concept', pins: [pin()] }, { now: new Date('2026-11-22T05:00:01Z') });
      const job = JSON.parse(readFileSync(join(inbox, id, 'job.json'), 'utf8'));
      assert.deepEqual(job.references, ['models/ships/Light Cruiser.refs/concept.png', 'models/ships/Light Cruiser.refs/front.jpg', 'models/ships/Light Cruiser.refs/left.png']);
      for (const ref of job.references) assert.ok(existsSync(join(copy.root, ref)), ref);          // from the project root, forward slashes
      assert.match(job.workflow.instructions, /build/);                                              // the workflow's own words stay
      assert.match(job.workflow.instructions, /Reference images of this model[^]*models\/ships\/Light Cruiser\.refs\/concept\.png[^]*ground truth/);
      assert.deepEqual(readdirSync(join(inbox, id)).sort(), ['job.json', 'pin-1-ref-1.png', 'pin-1.jpg']);   // the pin's own image, none of the model's
      assert.deepEqual(job.pins[0].refs, ['pin-1-ref-1.png']);
      for (const done of [bare.id, id]) writeFileSync(join(inbox, done, 'status.json'), JSON.stringify({ state: 'done', summary: '' }));   // taken: the watcher's test wants its own job first
    } finally { rmSync(refs, { recursive: true, force: true }); }   // the tests after this one count the inbox, not the references
  });
  it('refuses bad jobs, writing nothing', () => {
    const count = readdirSync(inbox).length, base = { model: MODEL, workflow: 'auto', pins: [pin()] };
    for (const [job, why] of [
      [{ ...base, model: '../layout.json' }, /no such model/], [{ ...base, workflow: 'comfyui' }, /not set up yet/], [{ ...base, workflow: 'nope' }, /no such workflow/],
      [{ ...base, pins: [pin({ position: [1, 2] })] }, /three numbers/], [{ ...base, pins: [pin({ screenshot: 'x' })] }, /screenshot: not a PNG/],
      [{ ...base, pins: [pin({ refs: [PNG_1PX, PNG_1PX, PNG_1PX, PNG_1PX, PNG_1PX] })] }, /at most 4/], [{ ...base, pins: [] }, /a pin or a note/],
      [{ ...base, pins: Array.from({ length: 41 }, () => pin({ refs: [] })) }, /at most 40 pins/],
    ]) assert.throws(() => createReview(project, job), why);
    assert.equal(readdirSync(inbox).length, count);
  });
  it('lists jobs with their state', () => {
    const { id: a } = createReview(project, { model: MODEL, workflow: 'auto', note: 'a' }, { now: new Date('2026-11-23T00:00:00Z') });
    const { id: b } = createReview(project, { model: MODEL, workflow: 'auto', note: 'b' }, { now: new Date('2026-11-24T00:00:00Z') });
    writeFileSync(join(inbox, a, 'status.json'), JSON.stringify({ state: 'done', summary: 'fixed the nose', changedFiles: ['build/x.py'] }));
    writeFileSync(join(inbox, b, 'status.json'), '{ not json');
    const list = listReviews(project);
    assert.equal(list[0].id, b); assert.equal(list[0].state, 'unknown');
    const done = list.find((j) => j.id === a);
    assert.equal(done.state, 'done'); assert.equal(done.summary, 'fixed the nose'); assert.deepEqual(done.changedFiles, ['build/x.py']); assert.equal(done.modelChanged, false);
    assert.equal(list.find((j) => j.id === '2026-11-22T041233-light-cruiser').state, 'queued');
    const later = new Date(Date.now() + 60000); utimesSync(join(copy.root, 'models', MODEL), later, later);
    assert.equal(listReviews(project).find((j) => j.id === a).modelChanged, true);
  });
  it('the watcher sees each waiting job once, oldest first, never a .tmp one', () => {
    const seen = new Set();
    mkdirSync(join(inbox, '2099-01-01T000000-half.tmp'));
    const first = newJobs(inbox, seen);
    assert.deepEqual(first, ['2026-11-22T041233-light-cruiser']);
    assert.deepEqual(newJobs(inbox, seen), []);
    const { id } = createReview(project, { model: MODEL, workflow: 'auto', note: 'c' }, { now: new Date('2026-11-25T00:00:00Z') });
    assert.deepEqual(newJobs(inbox, seen), [id]);
  });
  it('workflows: the defaults, a default by its id, a project\'s own', () => {
    assert.deepEqual(normaliseWorkflows(undefined, copy.root).map((w) => [w.id, w.enabled]), [['auto', true], ['blender', true], ['angelo', true], ['measured', true], ['comfyui', false]]);
    const own = normaliseWorkflows(['auto', { id: 'cruiser-build', label: 'Cruiser build', instructionsFile: 'notes.md' }], copy.root);
    assert.deepEqual(own.map((w) => w.id), ['auto', 'cruiser-build']); assert.equal(own[1].instructionsFile, join(copy.root, 'notes.md'));
    assert.throws(() => normaliseWorkflows([{ id: 'x', instructionsFile: '../out.md' }], copy.root), /inside the project/);
    assert.throws(() => normaliseWorkflows(['nope'], copy.root), /no default workflow/);
    assert.throws(() => normaliseWorkflows([{ id: 'Bad Id' }], copy.root), /needs an id/);
    assert.equal(DEFAULT_WORKFLOWS[0].id, 'auto');
    const measured = DEFAULT_WORKFLOWS.find((w) => w.id === 'measured');
    assert.equal(measured.enabled, true); assert.equal(measured.label, 'Build from measurements');
    for (const word of ['match.mjs outline', 'parts.json', 'build.py']) assert.ok(measured.instructions.includes(word), word);
  });
});
