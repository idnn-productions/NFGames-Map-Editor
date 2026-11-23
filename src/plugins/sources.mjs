// Where plugins come from: built in (<editor>/plugins), the user's (~/.nfgames-editor/plugins), and the project's
// nfgames.json, which names its own folders, built-ins, and npm / git packages installed in the shared cache. The same
// id in several places: the project's (or a package it names) wins, then the user's, then the built-in.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ID, readManifest } from './manifest.mjs';

export const PROJECT_FILE = 'nfgames.json';
const RANK = { builtin: 0, user: 1, package: 2, project: 2 };

/** The `plugins` of the project's nfgames.json ({} when there is none). Throws when the file is not JSON. */
export function readProjectPlugins(root) {
  const file = join(root, PROJECT_FILE);
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return j && j.plugins && typeof j.plugins === 'object' && !Array.isArray(j.plugins) ? j.plugins : {};
}

const short = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
/** An installed package's folder in the shared cache, named by where its bytes came from, so two sources that claim
 *  the same id and version never share a folder: <id>@<version>-<integrity hash> or <id>@<commit>-<repository hash>. */
export function packageDir(packagesDir, id, spec) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error(`not a plugin id: ${JSON.stringify(id)}`);
  const tag = spec.npm ? `${spec.npm.slice(spec.npm.lastIndexOf('@') + 1).replace(/[^A-Za-z0-9.+-]/g, '_')}-${short(spec.integrity)}` : `${String(spec.commit).slice(0, 12).replace(/[^a-f0-9]/g, '_')}-${short(spec.git)}`;
  return join(packagesDir, `${id}@${tag}`);
}
/** Whether an installed folder came from exactly this pinned source (the installer writes .nfgames-source.json). */
export function sourceMatches(dir, spec) {
  try { const s = JSON.parse(readFileSync(join(dir, '.nfgames-source.json'), 'utf8')); return spec.npm ? s.npm === spec.npm && s.integrity === spec.integrity : s.git === spec.git && s.commit === spec.commit; } catch { return false; }
}

const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(dir, e.name)) : []);
const broken = (id, dir, source, error, extra = {}) => ({ id, dir, source, manifest: null, errors: [error], compatible: false, ...extra });

/** Every plugin the editor sees for a project, one per id: [{ id, dir, source, manifest, errors, compatible, spec?, missing? }]. */
export function discoverPlugins({ builtinDir, userDir, packagesDir, root }) {
  const found = new Map();
  const add = (dir, source, expectId = null, extra = {}) => {
    const r = readManifest(dir), id = expectId || (r.manifest && r.manifest.id) || dir;
    const entry = { id, dir, source, ...r, ...extra };
    if (expectId && r.manifest && r.manifest.id !== expectId) entry.errors = [...entry.errors, `nfgames.json calls it "${expectId}" but its plugin.json says "${r.manifest.id}"`];
    const had = found.get(id);
    if (!had || RANK[source] >= RANK[had.source]) found.set(id, entry);
  };
  for (const d of subdirs(builtinDir)) add(d, 'builtin');
  for (const d of subdirs(userDir)) add(d, 'user');
  let listed = {};
  try { listed = root ? readProjectPlugins(root) : {}; } catch (e) { found.set('(nfgames.json)', broken('(nfgames.json)', root, 'project', `nfgames.json: ${e.message}`)); }
  for (const [id, spec] of Object.entries(listed)) {
    if (spec === 'builtin') { if (found.get(id)?.source !== 'builtin') found.set(id, broken(id, null, 'builtin', 'nfgames.json asks for a built-in plugin this editor does not have', { missing: true })); continue; }
    if (typeof spec === 'string') {
      const dir = resolve(root, spec), r = relative(root, dir);
      if (r.startsWith('..') || isAbsolute(r)) { found.set(id, broken(id, dir, 'project', 'a project plugin folder must be inside the project')); continue; }
      add(dir, 'project', id); continue;
    }
    if (spec && (spec.npm || spec.git)) {
      let dir;
      try { dir = packageDir(packagesDir, id, spec); } catch (e) { found.set(id, broken(id, null, 'package', e.message)); continue; }
      if (existsSync(dir) && !sourceMatches(dir, spec)) { found.set(id, broken(id, dir, 'package', 'the installed copy did not come from the source nfgames.json pins: run `nfgames plugin install`', { spec, missing: true })); continue; }
      if (!existsSync(dir)) { found.set(id, broken(id, dir, 'package', 'not installed yet: run `nfgames plugin install`', { spec, missing: true })); continue; }
      add(dir, 'package', id, { spec }); continue;
    }
    found.set(id, broken(id, null, 'project', 'nfgames.json: a plugin is "builtin", a folder, { npm, integrity } or { git, commit }'));
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
