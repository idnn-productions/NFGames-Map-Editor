// Plugin trust. Built-in plugins are trusted. A user's or a project's folder plugin is asked about once, and again
// whenever its files change (a hash of everything in its folder); a project's plugins are not trusted just for being
// in the project, since a folder with no config is opened without asking. An installed package is trusted for its
// exact pinned bytes (npm integrity, or git URL and commit). Kept in <stateDir>/plugins-trusted.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** SHA-256 over every file a plugin could load (names and bytes; only .git and .DS_Store left out). */
export function folderHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || e.name === '.DS_Store') continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { h.update(relative(dir, f)); h.update('\0'); h.update(readFileSync(f)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

const fileOf = (stateDir) => join(stateDir, 'plugins-trusted.json');
const read = (stateDir) => { try { return JSON.parse(readFileSync(fileOf(stateDir), 'utf8')); } catch { return {}; } };
const keyOf = (p) => `${p.id}@${p.manifest.version}`;
const stamp = (p) => (p.source === 'package' ? `${p.spec?.npm || p.spec?.git}#${p.spec?.integrity || p.spec?.commit}` : folderHash(p.dir));

/** 'trusted' or 'ask'. */
export function pluginTrust(stateDir, p) {
  if (p.source === 'builtin') return 'trusted';
  return read(stateDir)[keyOf(p)] === stamp(p) ? 'trusted' : 'ask';
}
/** Remembers the user's yes for this plugin as it is now. */
export function trustPlugin(stateDir, p) {
  const all = read(stateDir);
  all[keyOf(p)] = stamp(p);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(fileOf(stateDir), `${JSON.stringify(all, null, 2)}\n`);
}
