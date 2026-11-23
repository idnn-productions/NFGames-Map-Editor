// Plugin trust. Built-in plugins, and a project's own folder plugins (the project is already trusted), are trusted.
// A user's plugin is asked about once, and again when its files change (a hash of its folder); an installed package
// once per id and version (its bytes are pinned by nfgames.json). Kept in <stateDir>/plugins-trusted.json.
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
const stamp = (p) => (p.source === 'user' ? folderHash(p.dir) : 'package');

/** 'trusted' or 'ask'. */
export function pluginTrust(stateDir, p) {
  if (p.source === 'builtin' || p.source === 'project') return 'trusted';
  return read(stateDir)[keyOf(p)] === stamp(p) ? 'trusted' : 'ask';
}
/** Remembers the user's yes for this plugin as it is now. */
export function trustPlugin(stateDir, p) {
  const all = read(stateDir);
  all[keyOf(p)] = stamp(p);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(fileOf(stateDir), `${JSON.stringify(all, null, 2)}\n`);
}
