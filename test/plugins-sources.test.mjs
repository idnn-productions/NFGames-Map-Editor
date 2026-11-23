// Where plugins come from, which one wins, and which are trusted.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins, packageDir } from '../src/plugins/sources.mjs';
import { pluginTrust, trustPlugin } from '../src/plugins/trust.mjs';
import { writePlugin } from './helpers.mjs';

describe('plugin sources', () => {
  let top, dirs, root, state;
  before(() => {
    top = mkdtempSync(join(tmpdir(), 'nfgames-sources-'));
    dirs = { builtinDir: join(top, 'builtin'), userDir: join(top, 'user'), packagesDir: join(top, 'packages') }; root = join(top, 'game'); state = join(top, 'state');
    writePlugin(join(dirs.builtinDir, 'viewer'), { id: 'nfgames.viewer' });
    writePlugin(join(dirs.builtinDir, 'shared'), { id: 'acme.shared', version: '1.0.0' });
    writePlugin(join(dirs.userDir, 'shared'), { id: 'acme.shared', version: '1.1.0' });
    writePlugin(join(dirs.userDir, 'mine'), { id: 'jacek.mine' });
    writePlugin(join(root, 'tools', 'bake'), { id: 'thoon.bake' });
    writePlugin(join(root, 'tools', 'liar'), { id: 'thoon.other-name' });
    writePlugin(packageDir(dirs.packagesDir, 'acme.terrain', { npm: '@acme/terrain@2.1.0' }), { id: 'acme.terrain', version: '2.1.0' });
    writeFileSync(join(root, 'nfgames.json'), JSON.stringify({ plugins: {
      'nfgames.viewer': 'builtin', 'thoon.bake': './tools/bake', 'thoon.liar': './tools/liar', 'thoon.escape': '../outside',
      'acme.terrain': { npm: '@acme/terrain@2.1.0', integrity: 'sha512-x' }, 'acme.missing': { git: 'https://example.com/x.git', commit: 'abcdef1234567890' },
    } }));
  });
  after(() => rmSync(top, { recursive: true, force: true }));

  it('finds built-in, user, project and installed plugins; the project\'s and user\'s win', () => {
    const found = Object.fromEntries(discoverPlugins({ ...dirs, root }).map((p) => [p.id, p]));
    assert.equal(found['nfgames.viewer'].source, 'builtin');
    assert.equal(found['acme.shared'].source, 'user'); assert.equal(found['acme.shared'].manifest.version, '1.1.0');
    assert.equal(found['jacek.mine'].source, 'user');
    assert.equal(found['thoon.bake'].source, 'project'); assert.deepEqual(found['thoon.bake'].errors, []);
    assert.match(found['thoon.liar'].errors.join(), /its plugin\.json says "thoon\.other-name"/);
    assert.match(found['thoon.escape'].errors.join(), /inside the project/);
    assert.equal(found['acme.terrain'].source, 'package'); assert.equal(found['acme.terrain'].spec.npm, '@acme/terrain@2.1.0');
    assert.equal(found['acme.missing'].missing, true); assert.match(found['acme.missing'].errors.join(), /not installed yet/);
  });
  it('a project with no nfgames.json, or a broken one', () => {
    const empty = join(top, 'empty'); mkdirSync(empty);
    assert.ok(discoverPlugins({ ...dirs, root: empty }).some((p) => p.id === 'nfgames.viewer'));
    writeFileSync(join(empty, 'nfgames.json'), '{ broken');
    assert.match(discoverPlugins({ ...dirs, root: empty }).find((p) => p.id === '(nfgames.json)').errors[0], /nfgames\.json/);
  });
  it('trust: built-in and project plugins are trusted; a user plugin is asked about again when its files change', () => {
    const found = Object.fromEntries(discoverPlugins({ ...dirs, root }).map((p) => [p.id, p]));
    assert.equal(pluginTrust(state, found['nfgames.viewer']), 'trusted');
    assert.equal(pluginTrust(state, found['thoon.bake']), 'trusted');
    assert.equal(pluginTrust(state, found['jacek.mine']), 'ask');
    trustPlugin(state, found['jacek.mine']); assert.equal(pluginTrust(state, found['jacek.mine']), 'trusted');
    writeFileSync(join(dirs.userDir, 'mine', 'server.mjs'), 'export function activate() {}\n');
    assert.equal(pluginTrust(state, found['jacek.mine']), 'ask');
    trustPlugin(state, found['jacek.mine']);
    mkdirSync(join(dirs.userDir, 'mine', 'node_modules', 'dep'), { recursive: true }); writeFileSync(join(dirs.userDir, 'mine', 'node_modules', 'dep', 'index.js'), 'evil');
    assert.equal(pluginTrust(state, found['jacek.mine']), 'ask'); // code it could import is covered too
    assert.equal(pluginTrust(state, found['acme.terrain']), 'ask');
    trustPlugin(state, found['acme.terrain']); assert.equal(pluginTrust(state, found['acme.terrain']), 'trusted');
  });
});
