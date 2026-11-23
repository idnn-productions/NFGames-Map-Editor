// The plugin system's small parts: versions, globs, and what a plugin.json must say.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { satisfies, validVersion } from '../src/plugins/semver.mjs';
import { globToRegExp, matchesAny } from '../src/plugins/glob.mjs';
import { checkManifest, readManifest } from '../src/plugins/manifest.mjs';

const good = { id: 'studio.terrain-tools', name: 'Terrain tools', version: '1.2.0', engines: { nfgames: '^1.0.0' }, server: 'server.mjs',
  touches: { files: ['maps/**', 'art/*.glb'], commands: ['blender'], network: false },
  contributes: { tools: [{ id: 'terrain', title: 'Terrain' }], commands: [{ id: 'smooth', title: 'Smooth' }], settings: { strength: { type: 'number', default: 1 } } },
  activation: ['onTool:terrain', 'onCommand:smooth', 'onRoute'] };

describe('versions', () => {
  it('ranges', () => {
    assert.ok(validVersion('1.0.0')); assert.ok(!validVersion('one'));
    for (const [v, r, ok] of [['1.4.2', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.3.1', '^0.3.0', true], ['0.4.0', '^0.3.0', false], ['1.2.9', '~1.2.0', true], ['1.3.0', '~1.2.0', false], ['1.0.0', '1.0.0', true], ['3.1.0', '>=2.0.0', true], ['1.0.0', '*', true], ['0.9.0', '^1.0.0', false]])
      assert.equal(satisfies(v, r), ok, `${v} ${r}`);
  });
});
describe('globs', () => {
  it('match project-relative paths', () => {
    assert.ok(globToRegExp('models/**').test('models/ships/a.glb'));
    assert.ok(globToRegExp('art/*.glb').test('art/a.glb')); assert.ok(!globToRegExp('art/*.glb').test('art/x/a.glb'));
    assert.ok(globToRegExp('**/*.json').test('a/b/c.json')); assert.ok(globToRegExp('**/*.json').test('c.json'));
    assert.ok(matchesAny('.review/x/job.json', ['models/**', '.review/**'])); assert.ok(!matchesAny('maps/a', ['models/**']));
  });
});
describe('plugin.json', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-manifest-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));
  it('a good manifest passes', () => assert.deepEqual(checkManifest(good), []));
  it('says what is wrong', () => {
    const bad = (patch) => checkManifest({ ...good, ...patch }).join(' | ');
    assert.match(bad({ id: 'Terrain' }), /id:/); assert.match(bad({ version: 'v1' }), /version/); assert.match(bad({ engines: {} }), /engines\.nfgames/);
    assert.match(bad({ server: '../evil.mjs' }), /server: a path inside/);
    assert.match(bad({ server: '.hidden/server.mjs' }), /not in a hidden folder/); assert.match(bad({ web: 'node_modules/x/index.js' }), /node_modules/); assert.match(bad({ contributes: { gadgets: [] } }), /not an extension point/);
    assert.match(bad({ contributes: { tools: [{ id: 'a' }, { id: 'a' }] } }), /two are called "a"/);
    assert.match(bad({ activation: ['whenever'] }), /activation/); assert.match(bad({ touches: { files: ['/etc/**'] } }), /touches\.files/);
  });
  it('reads a folder: incompatible API versions and broken files are reported, never thrown', () => {
    const w = (name, text) => { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'plugin.json'), text); return join(dir, name); };
    assert.equal(readManifest(w('ok', JSON.stringify(good))).compatible, true);
    const later = readManifest(w('later', JSON.stringify({ ...good, engines: { nfgames: '^2.0.0' } })));
    assert.deepEqual([later.errors, later.compatible], [[], false]);
    assert.match(readManifest(w('broken', '{ nope')).errors[0], /plugin\.json/);
    assert.deepEqual(readManifest(join(dir, 'missing')).errors, ['no plugin.json']);
  });
});
