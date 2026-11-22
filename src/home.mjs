// The folder browser, and the projects the editor may switch to: folders under the user's home folder (hidden ones
// left out), as names and a few markers only, never contents. A project's config is code the editor runs, so the
// first time a folder's config would run, and whenever the file changes, the user is asked; the answer is kept
// with the file's hash in ~/.nfgames-editor/trusted.json. Recent projects: ~/.nfgames-editor/recent.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { CONFIG_NAME } from './project.mjs';

export const HOME = homedir();
const MAX_ENTRIES = 2000;
const outside = () => Object.assign(new Error('only folders in your home folder can be opened'), { code: 400 });

/** The real path of `path` when it is the home folder or inside it, else null. */
export function insideHome(home, path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return null;
  try { const h = realpathSync(home), p = realpathSync(path); return p === h || p.startsWith(h + sep) ? p : null; } catch { return null; }
}
const isProject = (dir) => existsSync(join(dir, CONFIG_NAME)) || existsSync(join(dir, 'maps')) || existsSync(join(dir, 'data', 'maps'));
const glbCount = (dir) => { try { return readdirSync(dir).filter((n) => /\.glb$/i.test(n)).length; } catch { return 0; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** One folder for the browser: its sub-folders (no hidden ones, no links out of home) with markers, and its parent. */
export function browse(home, path = home) {
  const dir = insideHome(home, path);
  if (!dir || !isDir(dir)) throw outside();
  const h = realpathSync(home), entries = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (entries.length >= MAX_ENTRIES || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && insideHome(home, full) && isDir(full)))) continue;
    entries.push({ name: e.name, path: full, project: isProject(full), models: glbCount(full) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: dir, name: dir === h ? '~' : basename(dir), parent: dir === h ? null : dirname(dir), home: h, project: isProject(dir), models: glbCount(dir), entries };
}

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 'none' (no config), 'trusted' (this exact file was trusted before) or 'ask'. */
export function configTrust(stateDir, root) {
  const file = join(root, CONFIG_NAME);
  if (!existsSync(file)) return 'none';
  return readJson(join(stateDir, 'trusted.json'), {})[realpathSync(file)] === sha(file) ? 'trusted' : 'ask';
}
/** Remembers that the user trusts this project's config, as it is now. */
export function trustConfig(stateDir, root) {
  const file = join(root, CONFIG_NAME);
  if (!existsSync(file)) return;
  const all = readJson(join(stateDir, 'trusted.json'), {});
  all[realpathSync(file)] = sha(file);
  writeJson(join(stateDir, 'trusted.json'), all);
}
export const recentProjects = (stateDir) => readJson(join(stateDir, 'recent.json'), []).filter((p) => typeof p === 'string' && existsSync(p));
export function addRecent(stateDir, root) { writeJson(join(stateDir, 'recent.json'), [root, ...recentProjects(stateDir).filter((p) => p !== root)].slice(0, 10)); }
