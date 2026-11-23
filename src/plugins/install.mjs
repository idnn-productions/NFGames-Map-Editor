// Installing shared plugins into ~/.nfgames-editor/packages/<id>@<version or commit>: an npm package (its tarball,
// checked against the registry's SHA-512, or the one already pinned) or a git repository at a fixed commit. Pinned in
// the project's nfgames.json, so everyone on the project gets the same bytes. git runs directly, never through a shell.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { integrityOf, tarEntries } from '../vendor.mjs';
import { readManifest } from './manifest.mjs';
import { PROJECT_FILE, packageDir, readProjectPlugins } from './sources.mjs';

const REGISTRY = 'https://registry.npmjs.org';

/** "@scope/name@1.2.3" or "name@1.2.3" or "name" (the latest) → { name, version }. */
export function parseNpmSpec(spec) { const at = spec.lastIndexOf('@'); return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: 'latest' }; }

function settle(tmp, packagesDir, spec) {
  const r = readManifest(tmp);
  if (!r.manifest) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`not a plugin: ${r.errors.join('; ')}`); }
  const dir = packageDir(packagesDir, r.manifest.id, spec);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dirname(dir), { recursive: true }); renameSync(tmp, dir);
  return { id: r.manifest.id, dir, manifest: r.manifest, spec };
}

export async function installNpm(packagesDir, { npm, integrity = null }, { fetchImpl = fetch } = {}) {
  const { name, version } = parseNpmSpec(npm);
  const res = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2F')}/${version}`);
  const meta = res.ok ? await res.json() : null;
  if (!meta || !meta.dist) throw new Error(`no such package: ${npm}`);
  if (integrity && meta.dist.integrity && integrity !== meta.dist.integrity) throw new Error(`${name}@${meta.version}: the registry's hash differs from the one pinned`);
  const want = integrity || meta.dist.integrity;
  const got = await fetchImpl(meta.dist.tarball);
  if (!got.ok) throw new Error(`download failed: ${got.status}`);
  const buf = Buffer.from(await got.arrayBuffer());
  if (integrityOf(buf) !== want) throw new Error(`${name}@${meta.version}: the download does not match its SHA-512; nothing installed`);
  const files = [];
  for (const { name: entry, data } of tarEntries(gunzipSync(buf))) {
    const rel = normalize(entry.replace(/^[^/]+\//, ''));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: a file outside the package (${entry}); nothing installed`);
    files.push([rel, Buffer.from(data)]);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'nfgames-plugin-'));
  for (const [rel, data] of files) { const to = join(tmp, rel); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, data); }
  return settle(tmp, packagesDir, { npm: `${name}@${meta.version}`, integrity: want });
}

export function installGit(packagesDir, { git, commit = null }, { gitBin = 'git' } = {}) {
  if (typeof git !== 'string' || !git || git.startsWith('-')) throw new Error(`not a repository address: ${git}`);
  const tmp = mkdtempSync(join(tmpdir(), 'nfgames-plugin-'));
  const run = (args, cwd = tmp) => execFileSync(gitBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    run(['clone', '--quiet', '--', git, tmp], tmpdir());
    if (commit) run(['checkout', '--quiet', commit]);
    const sha = run(['rev-parse', 'HEAD']);
    rmSync(join(tmp, '.git'), { recursive: true, force: true });
    return settle(tmp, packagesDir, { git, commit: sha });
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`git: ${(e.stderr && String(e.stderr).trim()) || e.message}`); }
}

const projectFile = (root) => join(root, PROJECT_FILE);
const readProject = (root) => (existsSync(projectFile(root)) ? JSON.parse(readFileSync(projectFile(root), 'utf8')) : {});
const writeProject = (root, j) => writeFileSync(projectFile(root), `${JSON.stringify(j, null, 2)}\n`);
export function pin(root, id, spec) { const j = readProject(root); j.plugins = { ...(j.plugins || {}), [id]: spec }; writeProject(root, j); }
export function unpin(root, id) { const j = readProject(root); if (j.plugins) delete j.plugins[id]; writeProject(root, j); }

/** Installs every npm / git plugin nfgames.json pins that is not in the cache yet: the ids installed. */
export async function installMissing(root, packagesDir, opts = {}) {
  const done = [];
  for (const [id, spec] of Object.entries(readProjectPlugins(root))) {
    if (!spec || typeof spec !== 'object' || existsSync(packageDir(packagesDir, id, spec))) continue;
    if (spec.npm) await installNpm(packagesDir, spec, opts); else if (spec.git) installGit(packagesDir, spec, opts); else continue;
    done.push(id);
  }
  return done;
}
