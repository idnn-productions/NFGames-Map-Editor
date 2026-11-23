// Installing shared plugins into ~/.nfgames-editor/packages/<id>@<version or commit>: an npm package (its tarball,
// checked against the registry's SHA-512, or the one already pinned) or a git repository at a fixed commit. Pinned in
// the project's nfgames.json, so everyone on the project gets the same bytes. git runs directly, never through a shell.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { integrityOf, tarEntries } from '../vendor.mjs';
import { readManifest } from './manifest.mjs';
import { PROJECT_FILE, packageDir, readProjectPlugins, sourceMatches } from './sources.mjs';

const REGISTRY = 'https://registry.npmjs.org';

/** "@scope/name@1.2.3" or "name@1.2.3" or "name" (the latest) → { name, version }. */
export function parseNpmSpec(spec) { const at = spec.lastIndexOf('@'); return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: 'latest' }; }

/** Moves a checked download into the cache: a valid plugin, the id the project expects, a folder inside the cache
 *  named by its source, and a record of that source beside it. Anything else installs nothing. */
function settle(tmp, packagesDir, spec, expectId = null) {
  const r = readManifest(tmp), refuse = (why) => { rmSync(tmp, { recursive: true, force: true }); throw new Error(why); };
  if (!r.manifest || r.errors.length) refuse(`not a valid plugin: ${r.errors.join('; ')}`);
  if (expectId && r.manifest.id !== expectId) refuse(`nfgames.json pins "${expectId}" but this package is "${r.manifest.id}"; nothing installed`);
  const dir = packageDir(packagesDir, r.manifest.id, spec), rel = relative(packagesDir, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) refuse('the package would land outside the plugin cache; nothing installed');
  writeFileSync(join(tmp, '.nfgames-source.json'), `${JSON.stringify(spec)}\n`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(packagesDir, { recursive: true }); renameSync(tmp, dir);
  return { id: r.manifest.id, dir, manifest: r.manifest, spec };
}

export async function installNpm(packagesDir, { npm, integrity = null }, { fetchImpl = fetch, expectId = null } = {}) {
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
  return settle(tmp, packagesDir, { npm: `${name}@${meta.version}`, integrity: want }, expectId);
}

export function installGit(packagesDir, { git, commit = null }, { gitBin = 'git', expectId = null } = {}) {
  if (typeof git !== 'string' || !git || git.startsWith('-')) throw new Error(`not a repository address: ${git}`);
  const tmp = mkdtempSync(join(tmpdir(), 'nfgames-plugin-'));
  const run = (args, cwd = tmp) => execFileSync(gitBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    run(['clone', '--quiet', '--', git, tmp], tmpdir());
    if (commit) run(['checkout', '--quiet', commit]);
    const sha = run(['rev-parse', 'HEAD']);
    rmSync(join(tmp, '.git'), { recursive: true, force: true });
    return settle(tmp, packagesDir, { git, commit: sha }, expectId);
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
    if (!spec || typeof spec !== 'object' || !(spec.npm || spec.git)) continue;
    const dir = packageDir(packagesDir, id, spec);   // throws on an id that is not a plugin id
    if (existsSync(dir) && sourceMatches(dir, spec)) continue;
    if (spec.npm) await installNpm(packagesDir, spec, { ...opts, expectId: id }); else installGit(packagesDir, spec, { ...opts, expectId: id });
    done.push(id);
  }
  return done;
}
