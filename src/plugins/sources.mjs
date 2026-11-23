// Where plugins come from: built in (<editor>/plugins), the user's (~/.nfgames-editor/plugins), and the project's
// nfgames.json, which names its own folders, built-ins, and npm / git packages installed in the shared cache. The same
// id in several places: the project's (or a package it names) wins, then the user's, then the built-in.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readManifest } from './manifest.mjs';

export const PROJECT_FILE = 'nfgames.json';
const RANK = { builtin: 0, user: 1, package: 2, project: 2 };

/** The `plugins` of the project's nfgames.json ({} when there is none). Throws when the file is not JSON. */
export function readProjectPlugins(root) {
  const file = join(root, PROJECT_FILE);
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return j && j.plugins && typeof j.plugins === 'object' && !Array.isArray(j.plugins) ? j.plugins : {};
}

/** An installed package's folder in the shared cache: <packagesDir>/<id>@<version, or the commit's first 12>. */
export const packageDir = (packagesDir, id, spec) => join(packagesDir, `${id}@${spec.npm ? spec.npm.slice(spec.npm.lastIndexOf('@') + 1) : String(spec.commit).slice(0, 12)}`);

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
      const dir = packageDir(packagesDir, id, spec);
      if (!existsSync(dir)) { found.set(id, broken(id, dir, 'package', 'not installed yet: run `nfgames plugin install`', { spec, missing: true })); continue; }
      add(dir, 'package', id, { spec }); continue;
    }
    found.set(id, broken(id, null, 'project', 'nfgames.json: a plugin is "builtin", a folder, { npm, integrity } or { git, commit }'));
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
