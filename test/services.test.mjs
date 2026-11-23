// Services over HTTP: listed from manifests, connected with keys that stay in the editor, called under the spend guard;
// agent requests answered (after the user's yes when they cost); the agent's status; the Codex image service.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { sampleCopy, writePlugin, REPO } from './helpers.mjs';

const SERVICE = `export function activate(api) {
  api.services.provide('words', 'shout', async ({ text }, { secret }) => ({ text: String(text).toUpperCase() + '!', keyLength: secret('TOKEN').length }));
  api.services.provide('words', 'poem', async () => ({ text: 'roses', cost: 0.75 }));
}`;
// a stand-in for the codex CLI: writes one PNG where the prompt says. It reads its arguments like the real one: -i takes
// every value after it up to the next option, so a prompt placed after -i is taken as an image and there is no prompt.
const CODEX = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
let prompt = null;
for (let i = 1; i < a.length; i++) {
  if (a[i] === '-C' || a[i] === '-s') { i++; continue; }
  if (a[i] === '-i') { while (a[i + 1] !== undefined && !a[i + 1].startsWith('-')) i++; continue; }
  if (!a[i].startsWith('-') && prompt === null) prompt = a[i];
}
if (!prompt) { console.error('No prompt provided via stdin.'); process.exit(1); }
const m = /into \\.\\/(\\S+)\\/ named/.exec(prompt);
const dir = path.join(process.argv[process.argv.indexOf('-C') + 1], m[1]); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'image-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); console.log('made', dir);`;

describe('services', () => {
  const port = 21393 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let top, copy, host, path0;
  const ask = (p) => fetch(`${origin}${p}`).then((r) => r.json());
  const post = (p, body) => fetch(`${origin}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const until = async (fn, ms = 6000) => { for (let t = 0; t < ms; t += 100) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-services-'))); copy = sampleCopy();
    const builtinDir = join(top, 'builtin');
    writePlugin(join(builtinDir, 'words'), { id: 'test.words', server: 'server.mjs', activation: ['onService:words'],
      contributes: { services: [{ id: 'words', title: 'Words', summary: 'Shouts', provider: 'Test', needs: [{ kind: 'key', name: 'TOKEN', help: 'Paste your token' }],
        actions: [{ id: 'shout', title: 'Shout', cost: { estimate: 0.01 } }, { id: 'poem', title: 'Poem', cost: { estimate: 0.6 } }] }] } }, { 'server.mjs': SERVICE });
    mkdirSync(join(builtinDir, 'codex-image'), { recursive: true });
    for (const f of ['plugin.json', 'server.mjs']) writeFileSync(join(builtinDir, 'codex-image', f), readFileSync(join(REPO, 'plugins', 'codex-image', f)));
    mkdirSync(join(top, 'bin')); writeFileSync(join(top, 'bin', 'codex'), CODEX); chmodSync(join(top, 'bin', 'codex'), 0o755);
    path0 = process.env.PATH; process.env.PATH = `${join(top, 'bin')}:${path0}`;
    host = await createHost({ root: copy.root, port, pluginDirs: { builtinDir, userDir: join(top, 'user'), packagesDir: join(top, 'packages') }, stateDir: join(top, 'state'), home: top, securityBin: null, requestInterval: 100 });
    await host.listen();
  });
  after(async () => { process.env.PATH = path0; await new Promise((d) => host.server.close(d)); copy.done(); rmSync(top, { recursive: true, force: true }); });

  it('the session file is written without following a link planted in the project', async () => {
    const { symlinkSync, lstatSync } = await import('node:fs');
    const victim = join(top, 'victim.txt'); writeFileSync(victim, 'keep me');
    const { createRequestLoop } = await import('../src/requests.mjs');
    const dir = join(top, 'planted', '.review'); mkdirSync(dir, { recursive: true }); symlinkSync(victim, join(dir, '.session.json'));
    const loop = createRequestLoop({ reviewsDir: dir, services: {}, events: { emit() {} } }); loop.stop();
    assert.equal(readFileSync(victim, 'utf8'), 'keep me'); assert.ok(!lstatSync(join(dir, '.session.json')).isSymbolicLink());
    assert.equal(lstatSync(join(dir, '.session.json')).mode & 0o777, 0o600);
  });
  it('lists services with what they need; the key stays in the editor', async () => {
    const { services, vault } = await ask('/api/services');
    const words = services.find((s) => s.key === 'test.words/words');
    assert.equal(words.connected, false); assert.equal(words.needs[0].ok, false); assert.match(vault, /secrets\.json/);
    assert.equal((await post('/api/services/call', { key: 'test.words/words', action: 'shout', input: { text: 'hi' } })).status, 409);
    const c = await post('/api/services/connect', { key: 'test.words/words', name: 'TOKEN', value: 'abc123' });
    assert.equal(c.body.connected, true); assert.doesNotMatch(JSON.stringify(c.body), /abc123/);
    assert.ok(services.find((s) => s.key === 'nfgames.codex-image/image').needs[0].ok, 'codex found on PATH');
  });
  it('a cheap call runs; a costly one asks first; spend is recorded', async () => {
    const r = await post('/api/services/call', { key: 'test.words/words', action: 'shout', input: { text: 'hi' } });
    assert.deepEqual(r.body.result, { text: 'HI!', keyLength: 6 });
    const ask1 = await post('/api/services/call', { key: 'test.words/words', action: 'poem' });
    assert.equal(ask1.body.needsConfirm, true); assert.match(ask1.body.reason, /about \$0\.60/);
    assert.equal((await post('/api/services/call', { key: 'test.words/words', action: 'poem', confirmed: true })).body.result.text, 'roses');
    assert.equal((await ask('/api/services')).services.find((s) => s.key === 'test.words/words').spent, 0.76);
  });
  it('an agent\'s request needs the session token and a connected agent; the first use of a service asks; one that costs waits', async () => {
    const review = join(copy.root, '.review'), job = join(review, '2026-01-01T000000-x', 'requests'); mkdirSync(job, { recursive: true });
    const token = JSON.parse(readFileSync(join(review, '.session.json'), 'utf8')).token;
    const answerOf = (n) => existsSync(join(job, `${n}.answer.json`)) && JSON.parse(readFileSync(join(job, `${n}.answer.json`), 'utf8'));
    writeFileSync(join(job, 'early.json'), JSON.stringify({ token, service: 'test.words/words', action: 'shout', input: { text: 'x' } }));
    await new Promise((r) => setTimeout(r, 400)); assert.equal(answerOf('early'), false);                    // no agent connected: nothing runs
    writeFileSync(join(review, '.agent.json'), JSON.stringify({ agent: 'Claude Code', pid: process.pid, at: Date.now() }));
    writeFileSync(join(job, 'forged.json'), JSON.stringify({ token: 'guess', service: 'test.words/words', action: 'shout', input: {} }));
    assert.match((await until(() => answerOf('forged'))).error, /session token/);
    const allow = await until(async () => (await ask('/api/services/requests')).requests.find((r) => r.kind === 'allow'));
    assert.match(allow.reason, /Allow it for this session/);
    await post('/api/services/requests/answer', { id: allow.id, approve: true });
    assert.deepEqual(await until(() => { const a = answerOf('early'); return a && a.ok && a; }), { ok: true, result: { text: 'X!', keyLength: 6 } });
    writeFileSync(join(job, 'one.json'), JSON.stringify({ token, service: 'test.words/words', action: 'shout', input: { text: 'agent' } }));
    const a = await until(() => { const x = answerOf('one'); return x && x.ok && x; });
    assert.deepEqual(a, { ok: true, result: { text: 'AGENT!', keyLength: 6 } });
    writeFileSync(join(job, 'two.json'), JSON.stringify({ token, service: 'test.words/words', action: 'poem' }));
    const waiting = await until(async () => (await ask('/api/services/requests')).requests.find((r) => r.kind === 'spend'));
    assert.match(waiting.reason, /about \$0\.60/); assert.match(JSON.parse(readFileSync(join(job, 'two.answer.json'), 'utf8')).waiting, /waiting for the user/);
    assert.equal((await post('/api/services/requests/answer', { id: 'not-a-request', approve: true })).status, 404);
    await post('/api/services/requests/answer', { id: waiting.id, approve: true });
    assert.equal((await until(() => { const j = JSON.parse(readFileSync(join(job, 'two.answer.json'), 'utf8')); return j.ok && j; })).result.text, 'roses');
  });
  it('the agent\'s status comes from the watcher\'s heartbeat', async () => {
    writeFileSync(join(copy.root, '.review', '.agent.json'), JSON.stringify({ agent: 'Claude Code', pid: process.pid, at: Date.now() }));
    assert.deepEqual(await ask('/api/agent'), { connected: true, agent: 'Claude Code' });
    writeFileSync(join(copy.root, '.review', '.agent.json'), JSON.stringify({ agent: 'Claude Code', pid: process.pid, at: Date.now() - 120000 }));
    assert.equal((await ask('/api/agent')).connected, false);
  });
  it('image generation through Codex: references only from inside the project', async () => {
    for (const bad of ['/etc/passwd.png', '../outside.png', 'maps/plaza/layout.json'])
      assert.match((await post('/api/services/call', { key: 'nfgames.codex-image/image', action: 'generate', input: { prompt: 'x', references: [bad] } })).body.error, /references/, bad);
  });
  it('image generation through Codex', async () => {
    writeFileSync(join(copy.root, 'maps', 'plaza', 'ref.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await post('/api/services/call', { key: 'nfgames.codex-image/image', action: 'generate', input: { prompt: 'a weathered hull plate', references: ['maps/plaza/ref.png'] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.images.length, 1); assert.match(r.body.result.images[0], /^\.nfgames\/images\/.+\/image-1\.png$/);
    assert.ok(existsSync(join(copy.root, r.body.result.images[0])));
  });
});
