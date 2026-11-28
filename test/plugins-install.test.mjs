// Installing shared plugins: npm tarballs checked by hash, git at a fixed commit, pinned in nfgames.json. No network.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGit, installMissing, installNpm, parseNpmSpec, pin, unpin } from '../src/plugins/install.mjs';
import { integrityOf } from '../src/vendor.mjs';
import { makeTgz } from './helpers.mjs';

const manifest = (id, version) => JSON.stringify({ id, name: id, version, engines: { nfgames: '^1.0.0' } });
const fakeRegistry = (pkgs) => async (url) => {
  const meta = /registry\.npmjs\.org\/(.+)\/([^/]+)$/.exec(url);
  if (meta) { const p = pkgs[`${decodeURIComponent(meta[1])}@${meta[2]}`]; return { ok: !!p, status: p ? 200 : 404, json: async () => (p ? { version: p.version, dist: { tarball: `https://tarballs/${p.version}.tgz`, integrity: p.integrity } } : {}) }; }
  const p = Object.values(pkgs).find((x) => url === `https://tarballs/${x.version}.tgz`);
  return { ok: true, status: 200, arrayBuffer: async () => p.tgz.buffer.slice(p.tgz.byteOffset, p.tgz.byteOffset + p.tgz.length) };
};

describe('installing plugins', () => {
  let top, packages, root;
  before(() => { top = mkdtempSync(join(tmpdir(), 'nfgames-install-')); packages = join(top, 'packages'); root = join(top, 'game'); mkdirSync(root); });
  after(() => rmSync(top, { recursive: true, force: true }));

  it('reads npm specs', () => {
    assert.deepEqual(parseNpmSpec('@acme/terrain@2.1.0'), { name: '@acme/terrain', version: '2.1.0' });
    assert.deepEqual(parseNpmSpec('terrain'), { name: 'terrain', version: 'latest' });
  });
  it('npm: checks the hash, unpacks, pins; a mismatch or a path out of the folder installs nothing', async () => {
    const tgz = makeTgz({ 'package/plugin.json': manifest('acme.terrain', '2.1.0'), 'package/server.mjs': 'export function activate() {}' });
    const pkgs = { '@acme/terrain@2.1.0': { version: '2.1.0', tgz, integrity: integrityOf(tgz) } };
    const got = await installNpm(packages, { npm: '@acme/terrain@2.1.0' }, { fetchImpl: fakeRegistry(pkgs) });
    assert.equal(got.id, 'acme.terrain'); assert.ok(existsSync(join(got.dir, 'server.mjs'))); assert.match(got.dir, /acme\.terrain@2\.1\.0-[0-9a-f]{10}$/);
    assert.deepEqual(got.spec, { npm: '@acme/terrain@2.1.0', integrity: integrityOf(tgz) });
    await assert.rejects(installNpm(packages, { npm: '@acme/terrain@2.1.0', integrity: 'sha512-AAAA' }, { fetchImpl: fakeRegistry(pkgs) }), /differs from the one pinned/);
    const lying = { '@acme/terrain@2.1.0': { ...pkgs['@acme/terrain@2.1.0'], integrity: 'sha512-AAAA' } };
    await assert.rejects(installNpm(join(top, 'p2'), { npm: '@acme/terrain@2.1.0' }, { fetchImpl: fakeRegistry(lying) }), /does not match/);
    const evil = makeTgz({ 'package/plugin.json': manifest('acme.evil', '1.0.0'), 'package/../../escaped.txt': 'x' });
    await assert.rejects(installNpm(join(top, 'p3'), { npm: 'evil@1.0.0' }, { fetchImpl: fakeRegistry({ 'evil@1.0.0': { version: '1.0.0', tgz: evil, integrity: integrityOf(evil) } }) }), /outside the package/);
    assert.ok(!existsSync(join(top, 'escaped.txt')));
    const sneaky = makeTgz({ 'package/plugin.json': manifest('../../outside', '1.0.0') });
    await assert.rejects(installNpm(join(top, 'p4'), { npm: 'sneaky@1.0.0' }, { fetchImpl: fakeRegistry({ 'sneaky@1.0.0': { version: '1.0.0', tgz: sneaky, integrity: integrityOf(sneaky) } }) }), /not a valid plugin/);
    const other = makeTgz({ 'package/plugin.json': manifest('acme.other', '1.0.0') });
    await assert.rejects(installNpm(join(top, 'p5'), { npm: 'other@1.0.0' }, { fetchImpl: fakeRegistry({ 'other@1.0.0': { version: '1.0.0', tgz: other, integrity: integrityOf(other) } }), expectId: 'acme.terrain' }), /pins "acme.terrain" but this package is "acme.other"/);
  });
  it('git: a local repository at a fixed commit, without its .git', () => {
    const repo = join(top, 'repo'); mkdirSync(repo);
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init', '-q'); git('config', 'user.email', 't@e.st'); git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'plugin.json'), manifest('jacek.comfy', '0.1.0')); git('add', '.'); git('commit', '-qm', 'one');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'plugin.json'), manifest('jacek.comfy', '0.2.0')); git('commit', '-qam', 'two');
    const got = installGit(packages, { git: repo, commit: first });
    assert.equal(got.manifest.version, '0.1.0'); assert.equal(got.spec.commit, first);
    assert.ok(!existsSync(join(got.dir, '.git')));
    assert.throws(() => installGit(packages, { git: '--upload-pack=evil' }), /not a repository address/);
    assert.throws(() => installGit(packages, { git: repo, commit: '--force' }), /not a commit/);
  });
  it('pins in nfgames.json, installs what is missing, unpins', async () => {
    const tgz = makeTgz({ 'package/plugin.json': manifest('acme.trees', '1.0.0') });
    const pkgs = { 'trees@1.0.0': { version: '1.0.0', tgz, integrity: integrityOf(tgz) } };
    pin(root, 'acme.trees', { npm: 'trees@1.0.0', integrity: integrityOf(tgz) });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'nfgames.json'), 'utf8')).plugins['acme.trees'].npm, 'trees@1.0.0');
    assert.deepEqual(await installMissing(root, packages, { fetchImpl: fakeRegistry(pkgs) }), ['acme.trees']);
    assert.deepEqual(await installMissing(root, packages, { fetchImpl: fakeRegistry(pkgs) }), []);
    unpin(root, 'acme.trees'); assert.equal(JSON.parse(readFileSync(join(root, 'nfgames.json'), 'utf8')).plugins['acme.trees'], undefined);
  });
});
