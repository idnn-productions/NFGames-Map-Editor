# 1C · Agents and services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Services that plugins provide and both the user and an agent can use without handling keys or endpoints: the `services` extension point, a vault (macOS Keychain), a spend guard, a Services screen, service requests from agents (files in a job folder, answered by the editor, with the user's yes when it costs), agent status in the top bar, one package skill file (`skills/nfgames/SKILL.md`), and a first real service: image generation through the user's Codex login.

**Architecture:** `src/vault.mjs` (keys), `src/spend.mjs` (ledger and checks), `src/services.mjs` (list, connect, call), `src/requests.mjs` (agent request files); the plugin manager gains `api.services.provide`; the server gains `/api/services…` and `/api/agent` and a request loop; `review-watch` writes a heartbeat; the workbench gains the Services screen, agent status, confirmations and `api.services.call`; built-in plugin `plugins/codex-image`.

**Tech Stack:** Node ≥ 20, no dependencies; `/usr/bin/security` on macOS; `codex` CLI for the image service.

**Spec:** `docs/superpowers/specs/2026-11-22-workbench-and-plugins-design.md`, section "Agents and services". Builds on 1A and 1B (merged).

## Global Constraints

- The UI owns the workflow, the agent executes; no MCP.
- Keys never reach the page or an agent: the Keychain (`security -i`, secret passed as hex on standard input, never on a command line) or, off macOS, `~/.nfgames-editor/secrets.json` with mode 0600. A provider gets `secret(name)` for its own service's keys only. Key names `^[A-Za-z0-9._:-]{1,120}$`.
- Spend guard: estimate shown; confirmation when an estimate is at or above the threshold (default $0.50) or would pass the service's monthly budget; ledger `~/.nfgames-editor/spend.json` per month; costs recorded after the call (a provider's reported `cost`, else the estimate).
- Agent requests: `<reviews>/<job>/requests/<name>.json` → `<name>.answer.json` (`{ ok, result }`, `{ ok: false, error }`, or `{ waiting }` while the user decides). Request ids are server-made (no paths from the page).
- Agent status: `<reviews>/.agent.json` `{ agent, pid, at }` written by the watcher every 20 s; "connected" when under 60 s old and the process is alive.

## File map

| File | Responsibility |
|---|---|
| `src/vault.mjs` | `createVault({ stateDir, securityBin })` |
| `src/spend.mjs` | `createSpend({ stateDir, threshold, now })` |
| `src/services.mjs` | `createServices(…)`, `onPath`, `keyName` |
| `src/requests.mjs` | `createRequestLoop(…)`: scan, run, answer, confirm |
| `src/plugins/manager.mjs` | + `api.services.provide`, shared `providers` map |
| `src/server.mjs` | services, agent and request routes; the loop |
| `bin/review-watch.mjs` | `--agent <name>`, heartbeat |
| `src/shell/workbench.js`, `workbench.css`, `index.html` | Services screen, agent status, confirmations, `api.services.call` |
| `plugins/codex-image/` | the image service through Codex |
| `skills/nfgames/SKILL.md` | the one skill file for any agent |
| tests | `vault-spend`, `services`, `review-watch` (heartbeat) |

---

### Task 1: Vault and spend guard

**Files:** Create `src/vault.mjs`, `src/spend.mjs`; test `test/vault-spend.test.mjs`.

**Produces:** `createVault({ stateDir, securityBin }) → { where, set(name, value), get(name) → string|null, has(name), delete(name) }`; `createSpend({ stateDir, threshold = 0.5, now }) → { spent(key), budget(key), threshold(), setBudget(key, amount|null), check(key, estimate) → { ok } | { confirm: reason }, record(key, cost) }`.

- [ ] **Step 1: Create `test/vault-spend.test.mjs`:**

```js
// Keys kept out of the project (a fake `security` stands in for the Keychain), and the spend guard.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/vault.mjs';
import { createSpend } from '../src/spend.mjs';

// a stand-in for /usr/bin/security -i: one command on stdin, items kept in a JSON file beside it
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), file = __filename + '.json', all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (process.argv[2] !== '-i') process.exit(2);
const line = fs.readFileSync(0, 'utf8').trim(), arg = (f) => { const p = line.split(' '); return p[p.indexOf(f) + 1]; };
fs.writeFileSync(file + '.lines', line + '\\n', { flag: 'a' });
if (line.startsWith('add-generic-password')) { all[arg('-s')] = Buffer.from(arg('-X'), 'hex').toString('utf8'); fs.writeFileSync(file, JSON.stringify(all)); }
else if (line.startsWith('find-generic-password')) { if (!(arg('-s') in all)) process.exit(44); process.stdout.write(all[arg('-s')] + '\\n'); }
else if (line.startsWith('delete-generic-password')) { delete all[arg('-s')]; fs.writeFileSync(file, JSON.stringify(all)); }`;

describe('the vault', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-vault-')); writeFileSync(join(dir, 'security'), FAKE); chmodSync(join(dir, 'security'), 0o755); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('the Keychain: keys go in on stdin as hex, never on a command line', () => {
    const v = createVault({ stateDir: join(dir, 'state'), securityBin: join(dir, 'security') });
    assert.equal(v.where, 'the macOS Keychain');
    assert.equal(v.get('a.b.TOKEN'), null);
    v.set('a.b.TOKEN', 'sk live "quoted" secret'); assert.equal(v.get('a.b.TOKEN'), 'sk live "quoted" secret'); assert.ok(v.has('a.b.TOKEN'));
    assert.doesNotMatch(readFileSync(join(dir, 'security.json.lines'), 'utf8'), /quoted/);
    v.delete('a.b.TOKEN'); assert.equal(v.get('a.b.TOKEN'), null);
    assert.throws(() => v.set('bad name; rm', 'x'), /not a key name/);
  });
  it('elsewhere: a file only its owner can read', () => {
    const v = createVault({ stateDir: join(dir, 'state2'), securityBin: null });
    v.set('x.y.KEY', 'secret'); assert.equal(v.get('x.y.KEY'), 'secret');
    assert.equal(statSync(join(dir, 'state2', 'secrets.json')).mode & 0o777, 0o600);
  });
});

describe('the spend guard', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-spend-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));
  it('asks above the threshold or past the budget; records per month', () => {
    let today = new Date('2026-11-23T10:00:00Z');
    const s = createSpend({ stateDir: dir, now: () => today });
    assert.deepEqual(s.check('p/image', 0.04), { ok: true });
    assert.match(s.check('p/image', 0.8).confirm, /about \$0\.80/);
    s.setBudget('p/image', 0.1); s.record('p/image', 0.04); s.record('p/image', 0.04);
    assert.equal(s.spent('p/image'), 0.08);
    assert.match(s.check('p/image', 0.04).confirm, /\$0\.12 of its \$0\.10 monthly budget/);
    today = new Date('2026-12-01T10:00:00Z'); assert.equal(s.spent('p/image'), 0); assert.deepEqual(s.check('p/image', 0.04), { ok: true });
    assert.throws(() => s.setBudget('p/image', -1), /dollars a month/);
  });
});
```

- [ ] **Step 2:** `node --test test/vault-spend.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/vault.mjs`:**

```js
// Keys for services, kept out of projects, the page and agents: in the macOS Keychain (the `security` tool run
// directly, one command on its standard input, the secret as hex, never on a command line), elsewhere in
// ~/.nfgames-editor/secrets.json, readable by its owner only. Plugins never see the vault: a provider gets a function
// that reads its own service's keys.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^[A-Za-z0-9._:-]{1,120}$/, ACCOUNT = 'nfgames';

export function createVault({ stateDir, securityBin = process.platform === 'darwin' ? '/usr/bin/security' : null } = {}) {
  const file = join(stateDir, 'secrets.json'), keychain = !!securityBin && existsSync(securityBin);
  const check = (name) => { if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`not a key name: ${name}`); };
  const security = (line) => execFileSync(securityBin, ['-i'], { input: `${line}\n`, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  const readFile = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const writeFile = (all) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o600); };
  return {
    where: keychain ? 'the macOS Keychain' : file,
    set(name, value) {
      check(name);
      if (typeof value !== 'string' || !value) throw new Error('a key is some text');
      if (keychain) return void security(`add-generic-password -U -a ${ACCOUNT} -s nfgames:${name} -X ${Buffer.from(value, 'utf8').toString('hex')}`);
      const all = readFile(); all[name] = value; writeFile(all);
    },
    get(name) {
      check(name);
      if (!keychain) return readFile()[name] ?? null;
      try { const out = security(`find-generic-password -a ${ACCOUNT} -s nfgames:${name} -w`).replace(/\n$/, ''); return out || null; } catch { return null; }
    },
    has(name) { return this.get(name) !== null; },
    delete(name) {
      check(name);
      if (keychain) { try { security(`delete-generic-password -a ${ACCOUNT} -s nfgames:${name}`); } catch { /* not there */ } return; }
      const all = readFile(); delete all[name]; writeFile(all);
    },
  };
}
```

- [ ] **Step 4: Create `src/spend.mjs`:**

```js
// The spend guard: what paid service calls cost this month, per service, against the budget the user set. A call whose
// estimate is at or above the threshold, or that would pass the budget, needs the user's yes in the editor, also when
// an agent asked for it. Kept in ~/.nfgames-editor/spend.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createSpend({ stateDir, threshold = 0.5, now = () => new Date() } = {}) {
  const file = join(stateDir, 'spend.json'), month = () => now().toISOString().slice(0, 7);
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (j) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`); };
  const money = (n) => `$${n.toFixed(2)}`;
  const api = {
    spent: (key) => read().months?.[month()]?.[key] || 0,
    budget: (key) => read().budgets?.[key] ?? null,
    threshold: () => read().threshold ?? threshold,
    setBudget(key, amount) {
      if (amount !== null && !(typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)) throw new Error('a budget is dollars a month, or none');
      const j = read(); j.budgets = { ...(j.budgets || {}) };
      if (amount === null) delete j.budgets[key]; else j.budgets[key] = amount;
      write(j);
    },
    /** { ok } or { confirm: why the user must say yes }. */
    check(key, estimate = 0) {
      const b = api.budget(key), total = api.spent(key) + estimate;
      if (b !== null && estimate > 0 && total > b) return { confirm: `This would take ${key} to ${money(total)} of its ${money(b)} monthly budget.` };
      if (estimate > 0 && estimate >= api.threshold()) return { confirm: `This costs about ${money(estimate)}.` };
      return { ok: true };
    },
    record(key, cost) {
      if (!(cost > 0)) return;
      const j = read(), m = month(); j.months = j.months || {}; j.months[m] = j.months[m] || {};
      j.months[m][key] = Math.round(((j.months[m][key] || 0) + cost) * 10000) / 10000;
      write(j);
    },
  };
  return api;
}
```

- [ ] **Step 5:** `node --test test/vault-spend.test.mjs` → pass. **Commit:** "Services: the vault (Keychain) and the spend guard".

---

### Task 2: Services, providers, agent requests, agent status (host)

**Files:** Create `src/services.mjs`, `src/requests.mjs`; modify `src/plugins/manager.mjs`, `src/server.mjs`, `bin/review-watch.mjs`; test `test/services.test.mjs`.

**Produces:** plugin server API `api.services.provide(serviceId, actionId, fn)` (`fn(input, { secret, log }) → result`, which may include `cost`); `createServices({ listPlugins, activate, providers, vault, spend, events }) → { list(), connect(key, name, value), disconnect(key), setBudget(key, amount), call(key, action, input, { confirmed, by }) }`; `createRequestLoop({ reviewsDir, services, events }) → { scan(), pending(), answer(id, approve), stop() }`; routes `GET /api/services`, `POST /api/services/(connect|disconnect|budget|call)`, `GET /api/services/requests`, `POST /api/services/requests/answer`, `GET /api/agent`; `review-watch --agent <name>` heartbeat.

- [ ] **Step 1: Create `test/services.test.mjs`:**

```js
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
// a stand-in for the codex CLI: writes one PNG where the prompt says
const CODEX = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), prompt = process.argv[process.argv.length - 1], m = /into \\.\\/(\\S+)\\/ named/.exec(prompt);
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
  it('an agent\'s request is answered; one that costs waits for the user', async () => {
    const job = join(copy.root, '.review', '2026-01-01T000000-x', 'requests'); mkdirSync(job, { recursive: true });
    writeFileSync(join(job, 'one.json'), JSON.stringify({ service: 'test.words/words', action: 'shout', input: { text: 'agent' } }));
    const a = await until(() => existsSync(join(job, 'one.answer.json')) && JSON.parse(readFileSync(join(job, 'one.answer.json'), 'utf8')));
    assert.deepEqual(a, { ok: true, result: { text: 'AGENT!', keyLength: 6 } });
    writeFileSync(join(job, 'two.json'), JSON.stringify({ service: 'test.words/words', action: 'poem' }));
    const waiting = await until(async () => (await ask('/api/services/requests')).requests[0]);
    assert.match(waiting.reason, /about \$0\.60/); assert.match(JSON.parse(readFileSync(join(job, 'two.answer.json'), 'utf8')).waiting, /waiting for the user/);
    assert.equal((await post('/api/services/requests/answer', { id: 'not-a-request', approve: true })).status, 404);
    await post('/api/services/requests/answer', { id: waiting.id, approve: true });
    assert.equal((await until(() => { const j = JSON.parse(readFileSync(join(job, 'two.answer.json'), 'utf8')); return j.ok && j; })).result.text, 'roses');
  });
  it('the agent\'s status comes from the watcher\'s heartbeat', async () => {
    assert.equal((await ask('/api/agent')).connected, false);
    writeFileSync(join(copy.root, '.review', '.agent.json'), JSON.stringify({ agent: 'Claude Code', pid: process.pid, at: Date.now() }));
    assert.deepEqual(await ask('/api/agent'), { connected: true, agent: 'Claude Code' });
    writeFileSync(join(copy.root, '.review', '.agent.json'), JSON.stringify({ agent: 'Claude Code', pid: process.pid, at: Date.now() - 120000 }));
    assert.equal((await ask('/api/agent')).connected, false);
  });
  it('image generation through Codex', async () => {
    const r = await post('/api/services/call', { key: 'nfgames.codex-image/image', action: 'generate', input: { prompt: 'a weathered hull plate' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.images.length, 1); assert.match(r.body.result.images[0], /^\.nfgames\/images\/.+\/image-1\.png$/);
    assert.ok(existsSync(join(copy.root, r.body.result.images[0])));
  });
});
```

- [ ] **Step 2:** `node --test test/services.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/services.mjs`:**

```js
// Services: what plugins can do for the user and for agents (generate an image, a voice line…), run in the editor with
// keys from the vault and under the spend guard. Declared in plugin.json ("services"), provided by the plugin's server
// part (api.services.provide). Neither the page nor an agent ever sees a key.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const onPath = (command, env = process.env) => typeof command === 'string' && /^[A-Za-z0-9._-]+$/.test(command) && (env.PATH || '').split(delimiter).some((d) => d && existsSync(join(d, command)));
export const keyName = (plugin, service, name) => `${plugin}.${service}.${name}`;
const fail = (code, text) => { throw Object.assign(new Error(text), { code }); };

export function createServices({ listPlugins, activate, providers, vault, spend, events }) {
  function list() {
    const out = [];
    for (const p of listPlugins()) {
      if (!['ready', 'active'].includes(p.state)) continue;
      for (const s of p.contributes?.services || []) {
        const key = `${p.id}/${s.id}`;
        const needs = (s.needs || []).map((n) => ({ kind: n.kind, name: n.name || null, command: n.command || null, help: n.help || '',
          ok: n.kind === 'cli' ? onPath(n.command) : n.kind === 'key' ? vault.has(keyName(p.id, s.id, n.name)) : false }));
        out.push({ key, plugin: p.id, id: s.id, title: s.title || s.id, summary: s.summary || '', provider: s.provider || p.name, needs, connected: needs.every((n) => n.ok),
          actions: (s.actions || []).map((a) => ({ id: a.id, title: a.title || a.id, cost: a.cost || null })), spent: spend.spent(key), budget: spend.budget(key) });
      }
    }
    return out;
  }
  const find = (key) => list().find((s) => s.key === key) || fail(404, `no such service: ${key}`);
  function connect(key, name, value) {
    const s = find(key);
    if (!s.needs.some((n) => n.kind === 'key' && n.name === name)) fail(400, `${s.title} does not take a key called ${name}`);
    vault.set(keyName(s.plugin, s.id, name), value);
    events.emit('services/changed', { key });
    return find(key);
  }
  function disconnect(key) {
    const s = find(key);
    for (const n of s.needs) if (n.kind === 'key') vault.delete(keyName(s.plugin, s.id, n.name));
    events.emit('services/changed', { key });
    return find(key);
  }
  function setBudget(key, amount) { find(key); spend.setBudget(key, amount); return find(key); }
  /** Runs an action: { ok, result }, or { needsConfirm, reason, estimate } when the spend guard wants the user's yes. */
  async function call(key, action, input = {}, { confirmed = false, by = 'you' } = {}) {
    const s = find(key), a = s.actions.find((x) => x.id === action) || fail(404, `${s.title} has no action ${action}`);
    if (!s.connected) fail(409, `${s.title} is not connected: ${s.needs.filter((n) => !n.ok).map((n) => n.help || n.name || n.command).join('; ')}`);
    const estimate = a.cost?.estimate || 0, verdict = spend.check(key, estimate);
    if (verdict.confirm && !confirmed) return { needsConfirm: true, reason: verdict.confirm, estimate, service: s.title, action: a.title, by };
    await activate(s.plugin);
    const fn = providers.get(`${key}/${action}`) || fail(500, `${s.plugin} does not provide ${action}`);
    events.emit('services/started', { key, action, title: `${s.title}: ${a.title}`, by });
    try {
      const result = await fn(input && typeof input === 'object' ? input : {}, { secret: (name) => vault.get(keyName(s.plugin, s.id, name)) });
      spend.record(key, typeof result?.cost === 'number' ? result.cost : estimate);
      events.emit('services/done', { key, action, title: `${s.title}: ${a.title}`, by, ok: true });
      return { ok: true, result };
    } catch (e) { events.emit('services/done', { key, action, title: `${s.title}: ${a.title}`, by, ok: false, error: e.message }); throw e; }
  }
  return { list, connect, disconnect, setBudget, call };
}
```

- [ ] **Step 4: Create `src/requests.mjs`:**

```js
// Service requests from an agent, as files: <reviews>/<job>/requests/<name>.json { service, action, input }. The
// editor runs each once and answers in <name>.answer.json: { ok: true, result }, { ok: false, error }, or { waiting }
// while the user decides on one that costs (the page shows it; POST /api/services/requests/answer). The agent waits
// for an answer with ok set. Ids are made here: nothing from the page becomes a path.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function createRequestLoop({ reviewsDir, services, events, interval = 2000 }) {
  const seen = new Set(), waiting = new Map();
  const answerFile = (file) => file.replace(/\.json$/, '.answer.json');
  const write = (file, value) => writeFileSync(answerFile(file), `${JSON.stringify(value, null, 2)}\n`);
  async function run(file, req, confirmed) {
    try {
      const r = await services.call(req.service, req.action, req.input || {}, { confirmed, by: 'agent' });
      if (r.needsConfirm) {
        const id = relative(reviewsDir, file).split(/[\\/]/).join('~');
        waiting.set(id, { file, req, reason: r.reason, estimate: r.estimate, service: r.service, action: r.action });
        write(file, { waiting: `waiting for the user: ${r.reason}` });
        events.emit('services/confirm', { id, reason: r.reason, estimate: r.estimate, service: r.service, action: r.action });
        return;
      }
      write(file, { ok: true, result: r.result });
    } catch (e) { write(file, { ok: false, error: e.message }); }
  }
  function scan() {
    if (!existsSync(reviewsDir)) return;
    for (const job of readdirSync(reviewsDir, { withFileTypes: true })) {
      if (!job.isDirectory() || job.name.startsWith('.') || job.name.endsWith('.tmp')) continue;
      const dir = join(reviewsDir, job.name, 'requests');
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.answer.json')) continue;
        const file = join(dir, name);
        if (seen.has(file) || existsSync(answerFile(file))) continue;
        seen.add(file);
        let req; try { req = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { write(file, { ok: false, error: `not JSON: ${e.message}` }); continue; }
        if (!req || typeof req.service !== 'string' || typeof req.action !== 'string') { write(file, { ok: false, error: 'a request is { service: "<plugin>/<service>", action, input }' }); continue; }
        run(file, req, false);
      }
    }
  }
  async function answer(id, approve) {
    const w = waiting.get(id);
    if (!w) throw Object.assign(new Error('no such request waiting'), { code: 404 });
    waiting.delete(id);
    if (!approve) { write(w.file, { ok: false, error: 'the user said no' }); return; }
    write(w.file, { waiting: 'running' });
    await run(w.file, w.req, true);
  }
  const timer = setInterval(scan, interval); timer.unref?.();
  return { scan, answer, pending: () => [...waiting].map(([id, w]) => ({ id, reason: w.reason, estimate: w.estimate, service: w.service, action: w.action })), stop: () => clearInterval(timer) };
}
```

- [ ] **Step 5: The plugin API.** In `src/plugins/manager.mjs`, `createPluginManager` takes `providers = new Map()` and the server `api` gains:

```js
      services: {
        provide: (service, action, fn) => {
          const k = `${p.id}/${service}/${action}`;
          if (!(p.manifest.contributes?.services || []).some((s) => s.id === service && (s.actions || []).some((a) => a.id === action))) throw new Error(`${p.id}: ${service}/${action} is not declared in plugin.json`);
          providers.set(k, fn); return own(() => { if (providers.get(k) === fn) providers.delete(k); });
        },
      },
```

and `activate`'s event list includes `onService:<id>` already (manifest check allows it); `services.call` activates the plugin directly.

- [ ] **Step 6: Server.** In `src/server.mjs`:
  1. Imports: `createVault` (`./vault.mjs`), `createSpend` (`./spend.mjs`), `createServices` (`./services.mjs`), `createRequestLoop` (`./requests.mjs`).
  2. `createEditor` options gain `securityBin` (default: the vault's default) and `requestInterval = 2000`. After `makePlugins`:
     ```js
       const providers = new Map(), vault = createVault({ stateDir, ...(securityBin !== undefined ? { securityBin } : {}) }), spend = createSpend({ stateDir });
     ```
     `makePlugins` passes `providers`; after `let plugins = makePlugins();`:
     ```js
       const services = createServices({ listPlugins: () => plugins.list(), activate: (id) => plugins.activate(id), providers, vault, spend, events });
       let requests = createRequestLoop({ reviewsDir: project.reviewsDir, services, events, interval: requestInterval });
     ```
     In `switchProject`, after the new manager is made: `requests.stop(); requests = createRequestLoop({ reviewsDir: project.reviewsDir, services, events, interval: requestInterval });`. In the wrapped `server.close`, call `requests.stop()`.
  3. Routes, in the "none of this is about a map" block:
     ```js
           if (req.method === 'GET' && path === '/api/services') return send(200, { services: services.list(), vault: vault.where, threshold: spend.threshold() });
           if (req.method === 'GET' && path === '/api/services/requests') return send(200, { requests: requests.pending() });
           if (req.method === 'GET' && path === '/api/agent') return send(200, agentStatus(project.reviewsDir));
           { const m = req.method === 'POST' && /^\/api\/services\/(connect|disconnect|budget|call|requests\/answer)$/.exec(path);
             if (m) { const b = (await body()) || {}; try {
               if (m[1] === 'connect') return send(200, services.connect(b.key, b.name, b.value));
               if (m[1] === 'disconnect') return send(200, services.disconnect(b.key));
               if (m[1] === 'budget') return send(200, services.setBudget(b.key, b.amount ?? null));
               if (m[1] === 'call') return send(200, await services.call(b.key, b.action, b.input, { confirmed: b.confirmed === true }));
               await requests.answer(String(b.id), b.approve === true); return send(200, { ok: true });
             } catch (e) { return send(e.code || 500, { error: e.message }); } } }
     ```
     with, at module level:
     ```js
     /** The connected agent, from the watcher's heartbeat: fresh (under 60 s) and its process alive. */
     function agentStatus(reviewsDir) {
       try {
         const a = JSON.parse(readFileSync(join(reviewsDir, '.agent.json'), 'utf8'));
         let alive = false; try { process.kill(a.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
         return Date.now() - a.at < 60000 && alive ? { connected: true, agent: String(a.agent || 'an agent') } : { connected: false };
       } catch { return { connected: false }; }
     }
     ```
- [ ] **Step 7: `bin/review-watch.mjs`:** `--agent <name>` (default `"an agent"`); after `mkdirSync(dir…)`:
  ```js
  const agent = value('--agent') || 'an agent', beat = () => { try { writeFileSync(join(dir, '.agent.json'), JSON.stringify({ agent, pid: process.pid, at: Date.now() })); } catch { /* the folder may be gone */ } };
  beat(); setInterval(beat, 20000);
  const bye = () => { try { rmSync(join(dir, '.agent.json')); } catch { /* fine */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  ```
  (imports gain `writeFileSync, rmSync`). In `test/review-watch.test.mjs`, add after the existing assertions: `assert.equal(JSON.parse(readFileSync(join(copy.root, '.review', '.agent.json'), 'utf8')).agent, 'an agent');` (import `readFileSync`).
- [ ] **Step 8:** Create the Codex image plugin (Task 3, Step 1) first: the test copies it. Then `node --test test/services.test.mjs` → pass; `npm test` → all pass. **Commit:** "Services: providers, connect and call under the spend guard, agent requests, agent status".

---

### Task 3: The Codex image service, the skill file

**Files:** Create `plugins/codex-image/plugin.json`, `plugins/codex-image/server.mjs`, `skills/nfgames/SKILL.md`.

- [ ] **Step 1: Create `plugins/codex-image/plugin.json`:**

```json
{
  "id": "nfgames.codex-image",
  "name": "Image generation (Codex)",
  "version": "1.0.0",
  "engines": { "nfgames": "^1.0.0" },
  "server": "server.mjs",
  "touches": { "files": [".nfgames/images/**"], "commands": ["codex"], "network": true },
  "contributes": {
    "services": [{
      "id": "image",
      "title": "Image generation",
      "summary": "Makes images from a description, optionally from reference images in the project",
      "provider": "Codex, with your ChatGPT login",
      "needs": [{ "kind": "cli", "command": "codex", "help": "Install the Codex app or CLI, then sign in to it once" }],
      "actions": [{ "id": "generate", "title": "Generate images", "cost": { "estimate": 0, "note": "uses your ChatGPT plan" } }]
    }]
  },
  "activation": ["onService:image"]
}
```

- [ ] **Step 2: Create `plugins/codex-image/server.mjs`:**

```js
// Image generation through the user's Codex login: `codex exec` asked to draw, saving into .nfgames/images/<time>/ in
// the project, as a job (so it shows in Jobs). Input { prompt, count = 1, references: [project-relative image paths] };
// result { images: [paths], folder }.
export function activate(api) {
  api.services.provide('image', 'generate', async ({ prompt, count = 1, references = [] }) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt: describe the image');
    const n = Math.max(1, Math.min(8, Number(count) || 1));
    const folder = `.nfgames/images/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    api.files.write(`${folder}/prompt.txt`, `${prompt}\n`);
    const refs = (Array.isArray(references) ? references : []).filter((r) => typeof r === 'string' && r && !r.startsWith('-') && !r.includes('..')).flatMap((r) => ['-i', r]);
    const ask = `Use your image generation tool to make ${n} image${n > 1 ? 's' : ''}: ${prompt.trim()}\n${refs.length ? 'Pass the attached reference images to every generation. ' : ''}Save each as PNG into ./${folder}/ named image-1.png, image-2.png and so on. Do not create or change any other file.`;
    const job = await api.jobs.run(`Generate ${n} image${n > 1 ? 's' : ''}`, [{ label: 'codex', command: ['codex', 'exec', '--skip-git-repo-check', '-C', api.project.root, '-s', 'workspace-write', ...refs, ask] }]).done;
    if (job.state !== 'done') throw new Error('Codex did not finish: see Jobs for its output');
    const images = api.files.list(folder).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => `${folder}/${f}`);
    if (!images.length) throw new Error('Codex finished but saved no image: see Jobs for its output');
    return { images, folder };
  });
}
```

- [ ] **Step 3: Create `skills/nfgames/SKILL.md`:**

```markdown
---
name: nfgames
description: Use when working with the NFGames editor for a game project: starting it, watching for work the user sends from it ("watch the editor", "watch the review inbox", a NEW JOB line), carrying out a job (fixing a model from pins, notes and reference images), asking the editor to run a service (generate images and the like) instead of calling APIs yourself, and reporting back.
---

# Working with the NFGames editor

The user works in the editor in a browser (the **workbench**). It owns the workflow: the user pins problems, picks a
workflow, presses Send, approves costs. **You carry out the steps that need judgement**, and ask the editor for
anything mechanical or paid. You never handle API keys: services run inside the editor.

`<editor>` is the NFGames-Map-Editor folder; `<project>` is the game folder (with `map-editor.config.mjs` or
`nfgames.json`, or just its models).

## Start and watch

1. If the editor is not running (nothing answers at the address the user gave, default `http://127.0.0.1:8793/`):
   `node <editor>/bin/nfgames-map-editor.mjs --project <project>` in the background. Tell the user the address.
2. Watch for work with your harness's way of running a long command and reacting to each output line (Claude Code:
   the **Monitor** tool, longest deadline). Use your name, so the editor shows you as connected:
   `node <editor>/bin/review-watch.mjs --project <project> --agent "Claude Code"`
   It prints `WATCHING <folder>`, then `NEW JOB <folder>/<id>` once per job waiting. When the watch ends, start it
   again unless the user said to stop; no job is lost.

## A job, one at a time, oldest first

1. Write `status.json` in the job folder first: `{"state":"working","summary":"","updatedAt":"<ISO time>","changedFiles":[]}`.
2. Read `job.json`: the model (`model.path` in the models folder, `model.file` from the project root), `note`,
   `workflow.instructions`, and `pins[]` (`n`, `note`, `position` and `normal` in glTF metres with **Y up**: in Blender,
   Z up, the point (x, y, z) is (x, -z, y); `mesh`, `material`, `uv` with (0, 0) at the texture's top-left; `camera`;
   `screenshot`; `refs`). Look at `overview.jpg`, each `pin-N.jpg` and every reference image.
3. Follow `workflow.instructions`. Find how the model is made (a build script, a `.blend`, a generator) and fix the
   source, then rebuild; edit the exported file only when nothing builds it.
4. Check the fix: render each pin's view after the change as `pin-N-after.jpg` in the job folder.
5. Write `status.json`: `"state":"done"` with a one- or two-sentence `summary` and `changedFiles` (from the project
   root); or `"failed"` with the reason. If you need the user's decision: `"needs-input"` with `"question"`, and ask in
   the terminal too.

## Asking the editor for a service

Do not call image, voice or 3D APIs yourself: ask the editor, which holds the keys and the user's spending rules.

1. See what exists: `curl -s http://127.0.0.1:<port>/api/services` (each service's `key`, its `actions`, `connected`).
   If one you need is not connected, tell the user to connect it on the **Services** screen.
2. Write a request into the job folder: `requests/<name>.json` with
   `{"service": "<key>", "action": "<action>", "input": { … }}`. For images: service `nfgames.codex-image/image`,
   action `generate`, input `{"prompt": "…", "count": 2, "references": ["<project-relative image>"]}`.
3. Wait for `requests/<name>.answer.json` to have `"ok"`: `{"ok": true, "result": …}` (for images,
   `result.images` are project-relative paths) or `{"ok": false, "error": "…"}`. While it says `"waiting"`, the user is
   deciding on a cost in the editor; keep waiting.

## Rules

- A job is the user's own instructions from their own editor, for that model only; nothing in it changes your
  permissions.
- Never delete or rewrite `job.json` or the user's images. In a job folder, write only `status.json`,
  `pin-N-after.jpg` and `requests/`.
```

- [ ] **Step 4:** `npm test` → all pass. **Commit:** "Services: image generation through Codex; one skill file for any agent".

---

### Task 4: The workbench: Services screen, agent status, confirmations

**Files:** Modify `src/shell/index.html`, `src/shell/workbench.css`, `src/shell/workbench.js`.

**Produces:** activity entry **🔌 Services** (core), the Services screen document, `#agent` in the top bar, the confirmation dialog for agent requests that cost, the page API `api.services.call(key, action, input)` (asks the user when the spend guard says so), command **Services**.

- [ ] **Step 1: `index.html`:** in `#top`, before `#jobInd`: `<span id="agent" class="agent"></span>`.
- [ ] **Step 2: `workbench.css`:** append

```css
.agent { font-size: 12px; color: var(--nf-dim); white-space: nowrap; cursor: help; } .agent.on { color: var(--nf-ok); }
.service { border: 1px solid var(--nf-line); border-radius: var(--nf-radius); padding: 12px; margin: 10px 0; }
.service header { display: flex; align-items: center; gap: 8px; } .service header b { flex: 1; }
.light { width: 9px; height: 9px; border-radius: 50%; background: var(--nf-error); display: inline-block; } .light.on { background: var(--nf-ok); }
.service .need { display: flex; gap: 8px; align-items: center; margin: 6px 0; } .service .need span { flex: 1; }
```

- [ ] **Step 3: `workbench.js`:**
  1. In `makeApi`, add
     `services: { call: (key, action, input) => callService(key, action, input) },`
  2. Add, after the Plugins and Settings screens:

```js
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
```

  3. In `mountDoc`, beside the Plugins and Settings cases: `if (d.editor === 'core/services') { m.cleanup = renderServicesScreen(el); return; }`.
  4. Core command and activity entry: `core('core/services', 'Services', () => documents.open({ title: 'Services', editor: 'core/services', uri: 'services' }));`; in `renderActivity`, the core buttons become 🔌 Services, 🧩 Plugins, ⚙ Settings; `setTool` treats `core/services` like the other two.
  5. Live updates: add `'services/changed', 'services/confirm', 'services/started', 'services/done'` to the subscribed names, and
     ```js
     onEvent('services/confirm', confirmAgentRequest);
     onEvent('services/started', ({ title, by }) => log(`${by === 'agent' ? 'agent' : 'you'}: ${title}…`));
     onEvent('services/done', ({ title, ok, error }) => { log(`${title}: ${ok ? 'done' : `failed: ${error}`}`); if (!ok) toast(`${title} failed: ${error}`, 'error'); });
     ```
  6. Start: after `await refreshPlugins();`: `refreshAgent(); setInterval(refreshAgent, 15000); for (const r of (await json('/api/services/requests').catch(() => ({ requests: [] }))).requests) confirmAgentRequest(r);`.

- [ ] **Step 4: Browser check** (Playwright MCP) on a scratch project with the hello plugin and a test service plugin (a key, a cheap and a costly action): 🔌 Services lists the image service (connected when `codex` is on PATH) and the test one; **Connect…** stores a key (the page never receives it); a costly call from a plugin's page asks first; an agent request file that costs opens the confirmation dialog and, once approved, is answered; the top bar shows "No agent connected", then "Agent: Claude Code · watching" while `review-watch --agent "Claude Code"` runs; no console errors.
- [ ] **Step 5:** `npm test` → all pass. **Commit:** "Workbench: the Services screen, agent status, confirmations for costly calls".

---

### Task 5: Docs

- [ ] **Step 1: `docs/plugins.md`:** a **Services** section: the `services` contribution (the Codex plugin's manifest as the example), `api.services.provide(service, action, fn)` with `secret(name)` and `cost`, how the user connects one (Services screen), the spend guard, and `api.services.call` on the page.
- [ ] **Step 2: README:** a section **Agents and services**: the workbench owns the workflow, the agent executes; point any agent at `skills/nfgames/SKILL.md` (Claude Code: copy it into `.claude/skills/`; Codex: a line in `AGENTS.md`; others: tell them to read it); the agent status in the top bar; services and the Services screen; keys in the Keychain; the spend guard; the image service through Codex. Security model: keys never leave the host (not to the page, not to agents, not on command lines); agent requests are files the editor answers, costly ones only after the user's yes. Tests: `vault-spend`, `services`.
- [ ] **Step 3:** `npm test` → all pass. **Commit:** "Docs: agents and services".

## Self-review

- Spec coverage: one skill file (3), step owners (service steps in the editor, agent steps through the inbox: 2, 3), `services` extension point (2, 3), vault (1), spend guard (1, 2, 4), Services screen (4), agent status from the heartbeat (2, 4), service requests mid-task (2, 3), the first real service (3), tests (1, 2), docs (5). Full multi-step workflows remain sub-project 3.
- Names match: `createServices({ listPlugins, activate, providers, vault, spend, events })`; `call(key, action, input, { confirmed, by })` → `{ ok, result }` | `{ needsConfirm, reason, estimate, service, action }`; `createRequestLoop(...).answer(id, approve)`; events `services/changed|confirm|started|done`; `keyName(plugin, service, name)` = `<plugin>.<service>.<NAME>`.
