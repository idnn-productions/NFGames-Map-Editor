// Whether a command a service needs is installed: a file on the PATH that a process started without a shell can run.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { commandFiles, onPath } from '../src/services.mjs';

describe('a command on the PATH', () => {
  let dir;
  const env = () => ({ PATH: `${join(dir, 'nowhere')}${delimiter}${dir}` });
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-onpath-')); for (const f of ['plain', 'tool.exe', 'old.com', 'shim.cmd', 'shim']) writeFileSync(join(dir, f), ''); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('elsewhere it is a file of that name', () => {
    assert.deepEqual(commandFiles('codex', 'linux'), ['codex']);
    assert.ok(onPath('plain', env(), 'darwin'));
    assert.ok(!onPath('tool', env(), 'linux'), 'tool.exe is not `tool`');
  });
  it('on Windows it is <name>.exe or <name>.com, which run without a shell', () => {
    assert.ok(onPath('tool', env(), 'win32')); assert.ok(onPath('old', env(), 'win32'));
    assert.ok(!onPath('plain', env(), 'win32'), 'a file with no ending is not a program there');
    assert.ok(!onPath('shim', env(), 'win32'), 'a .cmd shim (and npm\'s script beside it) cannot be started without a shell');
  });
  it('takes only a plain command name, and an empty PATH finds nothing', () => {
    for (const bad of ['../tool', 'a b', '', null, 'tool;x']) assert.ok(!onPath(bad, env(), 'win32'), String(bad));
    assert.ok(!onPath('tool', {}, 'win32')); assert.ok(!onPath('tool', { PATH: '' }, 'win32'));
  });
});
