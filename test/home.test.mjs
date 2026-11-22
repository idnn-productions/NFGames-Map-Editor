// The folder browser: home only, no hidden folders, no links out; a config runs only once trusted, and asks again
// when it changes; ten recent projects.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browse, insideHome, configTrust, trustConfig, recentProjects, addRecent } from '../src/home.mjs';
import { makeGlb } from './helpers.mjs';

describe('the folder browser', () => {
  let top, home, state;
  before(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-home-'))); home = join(top, 'home'); state = join(home, '.nfgames-editor');
    for (const d of ['game/maps', 'art', '.ssh', 'Docs']) mkdirSync(join(home, d), { recursive: true });
    mkdirSync(join(top, 'outside'));
    writeFileSync(join(home, 'art', 'ship.glb'), makeGlb()); writeFileSync(join(home, 'art', 'notes.txt'), 'x');
    symlinkSync(join(top, 'outside'), join(home, 'escape')); symlinkSync(join(home, 'art'), join(home, 'art-link'));
  });
  after(() => rmSync(top, { recursive: true, force: true }));

  it('lists folders under home with markers, no hidden ones, no links out', () => {
    const b = browse(home, home);
    assert.deepEqual(b.entries.map((e) => e.name), ['art', 'art-link', 'Docs', 'game']);
    assert.equal(b.parent, null); assert.equal(b.name, '~');
    const art = b.entries.find((e) => e.name === 'art'); assert.equal(art.models, 1); assert.equal(art.project, false);
    assert.equal(b.entries.find((e) => e.name === 'game').project, true);
    assert.equal(browse(home, join(home, 'game')).parent, home);
  });
  it('refuses anything outside home', () => {
    for (const p of [top, join(top, 'outside'), join(home, 'escape'), join(home, '..'), '/etc', '', 'relative/path', join(home, 'missing')]) assert.throws(() => browse(home, p), /home folder/, p);
    assert.equal(insideHome(home, join(home, 'art-link')), join(home, 'art'));
  });
  it('asks before running a config, remembers the answer, asks again when the file changes', () => {
    const game = join(home, 'game');
    assert.equal(configTrust(state, game), 'none');
    writeFileSync(join(game, 'map-editor.config.mjs'), 'export default {};\n');
    assert.equal(configTrust(state, game), 'ask');
    trustConfig(state, game); assert.equal(configTrust(state, game), 'trusted');
    writeFileSync(join(game, 'map-editor.config.mjs'), 'export default { title: "changed" };\n');
    assert.equal(configTrust(state, game), 'ask');
    trustConfig(state, game);
    // another folder whose config links to this trusted one is not trusted
    mkdirSync(join(home, 'copycat')); symlinkSync(join(game, 'map-editor.config.mjs'), join(home, 'copycat', 'map-editor.config.mjs'));
    assert.equal(configTrust(state, join(home, 'copycat')), 'ask');
  });
  it('keeps ten recent projects, newest first, only those that still exist', () => {
    for (let i = 0; i < 12; i++) { mkdirSync(join(home, `p${i}`)); addRecent(state, join(home, `p${i}`)); }
    addRecent(state, join(home, 'p3'));
    const r = recentProjects(state);
    assert.equal(r.length, 10); assert.equal(r[0], join(home, 'p3')); assert.equal(r[1], join(home, 'p11'));
    rmSync(join(home, 'p11'), { recursive: true });
    assert.ok(!recentProjects(state).includes(join(home, 'p11')));
  });
});
