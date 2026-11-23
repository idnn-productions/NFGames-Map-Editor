// The model maker over HTTP: drafts kept in the project, rounds through the image service (a stand-in codex), picks
// and approvals copied into the draft's folder, a run that outlived its tab, and paths that must stay inside.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { REPO, sampleCopy, PNG_1PX } from './helpers.mjs';

// a stand-in for the codex CLI: writes as many PNGs as the prompt asks for, where it says (each one different)
const CODEX = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
let prompt = null;
for (let i = 1; i < a.length; i++) {
  if (a[i] === '-C' || a[i] === '-s') { i++; continue; }
  if (a[i] === '-i') { while (a[i + 1] !== undefined && !a[i + 1].startsWith('-')) i++; continue; }
  if (!a[i].startsWith('-') && prompt === null) prompt = a[i];
}
const m = /into \\.\\/(\\S+)\\/ named/.exec(prompt), n = Number(/make (\\d+) image/.exec(prompt)[1]);
const dir = path.join(process.argv[process.argv.indexOf('-C') + 1], m[1]); fs.mkdirSync(dir, { recursive: true });
for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, 'image-' + i + '.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, i, ...Buffer.from(m[1])]));
if (/STOP HALFWAY/.test(prompt)) process.exit(2);`;

describe('the model maker', () => {
  const port = 22393 + (process.pid % 500), origin = `http://127.0.0.1:${port}`, P = '/api/p/nfgames.model-maker';
  let top, copy, host, path0;
  const get = (p) => fetch(`${origin}${P}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body, base = P) => fetch(`${origin}${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const ok = async (p, body) => { const r = await post(p, body); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`); return r.body; };
  const inDraft = (slug, ...rest) => join(copy.root, '.nfgames', 'drafts', slug, ...rest);
  /** One round through the image service, as the page does it: start, generate, settle. */
  async function round(slug, step, { prompt = 'a brass lantern', count = 2 } = {}) {
    const started = await ok('/draft/round', { slug, step, prompt, count });
    const made = await post('/services/call', { key: 'nfgames.codex-image/image', action: 'generate', input: started.input, confirmed: true }, '/api');
    return { input: started.input, made, draft: (await ok('/draft/settle', { slug, step, round: started.round.id, error: made.status === 200 ? null : made.body.error })).draft };
  }
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-maker-'))); copy = sampleCopy();
    const builtinDir = join(top, 'builtin');
    for (const p of ['codex-image', 'model-maker']) cpSync(join(REPO, 'plugins', p), join(builtinDir, p), { recursive: true });
    mkdirSync(join(top, 'bin')); writeFileSync(join(top, 'bin', 'codex'), CODEX); chmodSync(join(top, 'bin', 'codex'), 0o755);
    path0 = process.env.PATH; process.env.PATH = `${join(top, 'bin')}:${path0}`;
    host = await createHost({ root: copy.root, port, pluginDirs: { builtinDir, userDir: join(top, 'user'), packagesDir: join(top, 'packages') }, stateDir: join(top, 'state'), home: top, securityBin: null });
    await host.listen();
  });
  after(async () => { process.env.PATH = path0; await new Promise((d) => host.server.close(d)); copy.done(); rmSync(top, { recursive: true, force: true }); });

  it('no drafts at first; a new one is listed, with the project\'s style kept', async () => {
    assert.deepEqual((await get('/drafts')).body, { drafts: [], style: '' });
    const { draft } = await ok('/drafts', { name: 'Brass lantern', description: 'a small brass street lantern', style: 'hand-painted' });
    assert.equal(draft.slug, 'brass-lantern'); assert.equal(draft.status, 'concept');
    assert.deepEqual((await get('/drafts')).body, { drafts: [{ slug: 'brass-lantern', name: 'Brass lantern', status: 'concept' }], style: 'hand-painted' });
    assert.equal((await ok('/drafts', { name: 'Brass lantern' })).draft.slug, 'brass-lantern-2');
    assert.equal((await post('/drafts', { name: '   ' })).status, 400);
  });
  it('a name that is not a folder name still lands in its own folder under drafts', async () => {
    const { draft } = await ok('/drafts', { name: '../x' });
    assert.equal(draft.slug, 'x'); assert.equal(draft.name, '../x'); assert.ok(existsSync(inDraft('x', 'draft.json'))); assert.ok(!existsSync(join(copy.root, '.nfgames', 'x')));
    for (const slug of ['../x', 'x/..', '', 'X', 'nobody']) assert.equal((await get(`/draft?slug=${encodeURIComponent(slug)}`)).status, 404, slug);
  });
  it('a reference from the user\'s disk is saved in the draft; eight at most; only images', async () => {
    const { draft } = await ok('/draft/ref', { slug: 'brass-lantern', name: 'photo.png', data: PNG_1PX });
    assert.deepEqual(draft.refs, ['.nfgames/drafts/brass-lantern/refs/ref-1.png']); assert.ok(existsSync(inDraft('brass-lantern', 'refs', 'ref-1.png')));
    assert.equal((await post('/draft/ref', { slug: 'brass-lantern', name: 'x.svg', data: 'data:image/svg+xml;base64,PHN2Zy8+' })).status, 400);
    for (let i = 2; i <= 8; i++) await ok('/draft/ref', { slug: 'brass-lantern', name: 'p.png', data: PNG_1PX });
    const ninth = await post('/draft/ref', { slug: 'brass-lantern', name: 'p.png', data: PNG_1PX });
    assert.equal(ninth.status, 400); assert.match(ninth.body.error, /8/);
    const less = await ok('/draft/unref', { slug: 'brass-lantern', ref: '.nfgames/drafts/brass-lantern/refs/ref-8.png' });
    assert.equal(less.draft.refs.length, 7); assert.ok(!existsSync(inDraft('brass-lantern', 'refs', 'ref-8.png')));
  });
  it('concept: a round through the image service, a pick, and approval copies it into the draft', async () => {
    const r = await round('brass-lantern', 'concept');
    assert.match(r.input.folder, /^brass-lantern-concept-\d+$/); assert.equal(r.input.count, 2); assert.equal(r.input.references.length, 7);
    assert.equal(r.made.status, 200, JSON.stringify(r.made.body));
    const done = r.draft.concept.rounds[0];
    assert.equal(done.state, 'done'); assert.deepEqual(done.images, [1, 2].map((i) => `.nfgames/images/${r.input.folder}/image-${i}.png`));
    assert.equal((await post('/draft/pick', { slug: 'brass-lantern', step: 'concept', image: 'maps/plaza/layout.json' })).status, 400);
    assert.equal((await post('/draft/approve', { slug: 'brass-lantern', step: 'concept' })).status, 400);   // nothing picked
    await ok('/draft/pick', { slug: 'brass-lantern', step: 'concept', image: done.images[1] });
    const { draft } = await ok('/draft/approve', { slug: 'brass-lantern', step: 'concept' });
    assert.equal(draft.status, 'views');
    assert.deepEqual(readFileSync(inDraft('brass-lantern', 'concept.png')), readFileSync(join(copy.root, done.images[1])));
  });
  it('views: each is made from the approved concept; all picked, then approved, then kept as files', async () => {
    assert.equal((await post('/draft/approve', { slug: 'brass-lantern', step: 'views' })).status, 400);
    const first = await round('brass-lantern', 'front', { count: 1 });
    assert.deepEqual(first.input.references, ['.nfgames/drafts/brass-lantern/concept.png']);
    await ok('/draft/pick', { slug: 'brass-lantern', step: 'front', image: first.draft.views.rounds.front[0].images[0] });
    assert.equal((await post('/draft/approve', { slug: 'brass-lantern', step: 'views' })).status, 400);   // three views still without a pick
    for (const v of ['back', 'left', 'right']) { const r = await round('brass-lantern', v, { count: 1 }); await ok('/draft/pick', { slug: 'brass-lantern', step: v, image: r.draft.views.rounds[v][0].images[0] }); }
    assert.ok(!existsSync(inDraft('brass-lantern', 'views')));   // not until they are approved
    const { draft } = await ok('/draft/approve', { slug: 'brass-lantern', step: 'views' });
    assert.equal(draft.status, 'ready'); assert.deepEqual(readdirSync(inDraft('brass-lantern', 'views')).sort(), ['back.png', 'front.png', 'left.png', 'right.png']);
    assert.deepEqual(readFileSync(inDraft('brass-lantern', 'views', 'left.png')), readFileSync(join(copy.root, draft.views.picks.left)));
    assert.deepEqual((await get('/drafts')).body.drafts.find((d) => d.slug === 'brass-lantern'), { slug: 'brass-lantern', name: 'Brass lantern', status: 'ready' });
  });
  it('tidying the image rounds away does not break an approved draft, nor turn the plugin off', async () => {
    const d0 = (await get('/draft?slug=brass-lantern')).body.draft, hold = join(top, 'held-images');
    cpSync(join(copy.root, '.nfgames', 'images'), hold, { recursive: true }); rmSync(join(copy.root, '.nfgames', 'images'), { recursive: true });
    const kept = readFileSync(inDraft('brass-lantern', 'views', 'left.png'));
    assert.equal((await ok('/draft/save', { slug: 'brass-lantern', description: 'a small brass street lantern, dented' })).draft.status, 'ready');   // nothing it keeps changed
    assert.deepEqual(readFileSync(inDraft('brass-lantern', 'views', 'left.png')), kept); assert.ok(existsSync(inDraft('brass-lantern', 'concept.png')));
    const gone = await post('/draft/pick', { slug: 'brass-lantern', step: 'concept', image: d0.concept.rounds[0].images[0] });   // picking is only a note in the draft
    assert.equal(gone.status, 200);
    const no = await post('/draft/approve', { slug: 'brass-lantern', step: 'concept', confirm: true });   // ...but approving needs the image itself
    assert.equal(no.status, 400); assert.match(no.body.error, /no longer there/);
    const still = (await get('/draft?slug=brass-lantern')).body.draft;
    assert.equal(still.status, 'ready'); assert.equal(still.concept.approved, d0.concept.approved); assert.deepEqual(readFileSync(inDraft('brass-lantern', 'views', 'left.png')), kept);
    assert.equal((await (await fetch(`${origin}/api/plugins`)).json()).plugins.find((p) => p.id === 'nfgames.model-maker').state, 'active');
    cpSync(hold, join(copy.root, '.nfgames', 'images'), { recursive: true });
    await ok('/draft/pick', { slug: 'brass-lantern', step: 'concept', image: d0.concept.approved });
  });
  it('a link among the drafts that leads out of the project is passed over; the other drafts go on', async () => {
    const outside = join(top, 'elsewhere'); mkdirSync(outside); writeFileSync(join(outside, 'draft.json'), '{}');
    symlinkSync(outside, inDraft('sneaky'));
    const list = await get('/drafts');
    assert.equal(list.status, 200); assert.ok(list.body.drafts.some((d) => d.slug === 'brass-lantern')); assert.ok(!list.body.drafts.some((d) => d.slug === 'sneaky'));
    assert.equal((await get('/draft?slug=brass-lantern')).status, 200); assert.equal((await get('/draft?slug=sneaky')).status, 404);
    rmSync(inDraft('sneaky'));
  });
  it('another concept after that asks first, then clears the views', async () => {
    const d0 = (await get('/draft?slug=brass-lantern')).body.draft;
    await ok('/draft/pick', { slug: 'brass-lantern', step: 'concept', image: d0.concept.rounds[0].images[0] });
    const asks = await post('/draft/approve', { slug: 'brass-lantern', step: 'concept' });
    assert.equal(asks.status, 409); assert.equal(asks.body.needsConfirm, true); assert.ok(existsSync(inDraft('brass-lantern', 'views', 'front.png')));
    const { draft } = await ok('/draft/approve', { slug: 'brass-lantern', step: 'concept', confirm: true });
    assert.equal(draft.status, 'views'); assert.ok(!existsSync(inDraft('brass-lantern', 'views')));
    assert.deepEqual(readFileSync(inDraft('brass-lantern', 'concept.png')), readFileSync(join(copy.root, d0.concept.rounds[0].images[0])));
  });
  it('a failed run keeps what it saved and its error; the draft goes on', async () => {
    const r = await round('brass-lantern', 'concept', { prompt: 'STOP HALFWAY', count: 1 });
    assert.notEqual(r.made.status, 200);
    const failed = r.draft.concept.rounds.at(-1);
    assert.equal(failed.state, 'failed'); assert.match(failed.error, /Codex did not finish/); assert.equal(failed.images.length, 1);
  });
  it('a run that outlived its tab: the round left pending is done once its images are there', async () => {
    const started = await ok('/draft/round', { slug: 'brass-lantern-2', step: 'concept', prompt: 'a lantern', count: 1 });
    assert.equal((await get('/draft?slug=brass-lantern-2')).body.draft.concept.rounds[0].state, 'failed');   // not busy, nothing saved: interrupted
    const again = await ok('/draft/round', { slug: 'brass-lantern-2', step: 'concept', prompt: 'a lantern', count: 1 });
    assert.equal((await get('/draft?slug=brass-lantern-2&busy=1')).body.draft.concept.rounds[1].state, 'pending');   // the editor is still at it
    await post('/services/call', { key: 'nfgames.codex-image/image', action: 'generate', input: again.input, confirmed: true }, '/api');   // ...and nobody settles
    const seen = (await get('/draft?slug=brass-lantern-2')).body.draft.concept.rounds[1];
    assert.equal(seen.state, 'done'); assert.equal(seen.images.length, 1);
    assert.equal(JSON.parse(readFileSync(inDraft('brass-lantern-2', 'draft.json'), 'utf8')).concept.rounds[1].state, 'done');   // and kept
    assert.ok(started.round.id !== again.round.id);
  });
  it('images are served from the drafts and the image rounds, and from nowhere else', async () => {
    const r = await fetch(`${origin}${P}/image?path=.nfgames/drafts/brass-lantern/concept.png`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(inDraft('brass-lantern', 'concept.png')));
    for (const bad of ['maps/plaza/layout.json', '.nfgames/../package.json', '.nfgames/drafts/brass-lantern/draft.json', '/etc/hosts', '.nfgames/images/../../kit.json', ''])
      assert.notEqual((await fetch(`${origin}${P}/image?path=${encodeURIComponent(bad)}`)).status, 200, bad);
  });
  it('the views a draft lists can change; the prompts the user wrote are kept', async () => {
    const { draft } = await ok('/draft/save', { slug: 'x', description: 'a crate', views: { list: ['front', 'top'], prompts: { top: 'from above' } } });
    assert.equal(draft.description, 'a crate'); assert.deepEqual(draft.views.list, ['front', 'top']); assert.equal(draft.views.prompts.top, 'from above');
    const seen = (await get('/draft?slug=x')).body.prompts;   // what would be sent for each view: the user's words, or drafted from the description
    assert.deepEqual(Object.keys(seen), ['front', 'top']); assert.equal(seen.top, 'from above'); assert.match(seen.front, /a crate[\s\S]*front view/);
    assert.equal((await post('/draft/save', { slug: 'x', views: { list: ['sideways'] } })).status, 400);
    assert.equal((await ok('/draft/save', { slug: 'x', style: 'flat colours' })).draft.style, 'flat colours'); assert.equal((await get('/drafts')).body.style, 'flat colours');
  });
  it('a draft file that cannot be read is listed as such and left alone', async () => {
    mkdirSync(inDraft('broken')); writeFileSync(inDraft('broken', 'draft.json'), '{ not json');
    mkdirSync(inDraft('newer')); writeFileSync(inDraft('newer', 'draft.json'), JSON.stringify({ version: 2, slug: 'newer', name: 'From later' }));
    const list = (await get('/drafts')).body.drafts;
    assert.deepEqual(list.find((d) => d.slug === 'broken'), { slug: 'broken', name: 'broken', status: 'unreadable' }); assert.equal(list.find((d) => d.slug === 'newer').status, 'unreadable');
    assert.equal((await get('/draft?slug=broken')).status, 422); assert.equal((await post('/draft/save', { slug: 'newer', description: 'x' })).status, 422);
    assert.equal(readFileSync(inDraft('broken', 'draft.json'), 'utf8'), '{ not json');
  });
  it('deleting a draft removes its folder and leaves the image rounds', async () => {
    const images = readdirSync(join(copy.root, '.nfgames', 'images')).length;
    await ok('/draft/delete', { slug: 'brass-lantern' });
    assert.ok(!existsSync(inDraft('brass-lantern'))); assert.ok(existsSync(inDraft('x', 'draft.json')));
    assert.equal(readdirSync(join(copy.root, '.nfgames', 'images')).length, images);
    assert.equal((await post('/draft/delete', { slug: '..' })).status, 404); assert.ok(existsSync(join(copy.root, '.nfgames', 'drafts')));
    await ok('/draft/delete', { slug: 'broken' });   // an unreadable one can still be deleted
  });
  it('the page part is served', async () => {
    const r = await fetch(`${origin}/p/nfgames.model-maker/web/index.js`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  });
});
