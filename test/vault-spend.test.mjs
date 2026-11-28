// Keys kept out of the project (a fake `security` stands in for the Keychain), and the spend guard.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/vault.mjs';
import { createSpend } from '../src/spend.mjs';
import { WINDOWS } from './helpers.mjs';

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

  it('the Keychain: keys go in on stdin as hex, never on a command line', { skip: WINDOWS && 'the Keychain is the Mac\'s, and its stand-in here is a script Windows cannot run' }, () => {
    const v = createVault({ stateDir: join(dir, 'state'), securityBin: join(dir, 'security') });
    assert.equal(v.where, 'the macOS Keychain');
    assert.equal(v.get('a.b.TOKEN'), null);
    v.set('a.b.TOKEN', 'sk live "quoted" secret'); assert.equal(v.get('a.b.TOKEN'), 'sk live "quoted" secret'); assert.ok(v.has('a.b.TOKEN'));
    const callsBefore = readFileSync(join(dir, 'security.json.lines'), 'utf8').trim().split('\n').length;
    assert.ok(v.has('a.b.TOKEN'));
    assert.equal(readFileSync(join(dir, 'security.json.lines'), 'utf8').trim().split('\n').length, callsBefore);
    assert.doesNotMatch(readFileSync(join(dir, 'security.json.lines'), 'utf8'), /quoted/);
    v.delete('a.b.TOKEN'); assert.equal(v.has('a.b.TOKEN'), false); assert.equal(v.get('a.b.TOKEN'), null);
    assert.throws(() => v.set('bad name; rm', 'x'), /not a key name/);
  });
  it('elsewhere: a file only its owner can read', () => {
    const v = createVault({ stateDir: join(dir, 'state2'), securityBin: null });
    v.set('x.y.KEY', 'secret'); assert.equal(v.get('x.y.KEY'), 'secret');
    if (!WINDOWS) assert.equal(statSync(join(dir, 'state2', 'secrets.json')).mode & 0o777, 0o600);   // Windows keeps no such modes: the file is under the user's own profile
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
    // a used-up budget asks even for a call estimated at nothing; an unknown estimate is not free
    s.setBudget('p/free', 0.05); s.record('p/free', 0.05);
    assert.match(s.check('p/free', 0).confirm, /has used its \$0\.05 budget/);
    s.setBudget('p/odd', 1); assert.match(s.check('p/odd', undefined).confirm, /not known/); assert.deepEqual(s.check('p/none', undefined), { ok: true });
  });
});
