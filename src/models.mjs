// The models a project shows in the viewer: every .glb under its `models` folder. A path from a request is resolved
// against that folder and must stay in it (real paths compared, so a symlink cannot lead out), and must name a .glb.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_MODELS = 5000;
const isGlb = (name) => /\.glb$/i.test(name);

/** Every .glb under `dir` (subfolders too; dot-folders and symlinks skipped): [{ path, size, mtime }], sorted by path. */
export function listModels(dir) {
  const out = [];
  const walk = (at) => {
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_MODELS || e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = join(at, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && isGlb(e.name)) { const s = statSync(full); out.push({ path: relative(dir, full).split(sep).join('/'), size: s.size, mtime: Math.round(s.mtimeMs) }); }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The real path of model `rel` under `dir`, or null: a relative path to an existing .glb file inside the folder. */
export function resolveModel(dir, rel) {
  if (!dir || typeof rel !== 'string' || !rel || rel.length > 500 || rel.includes('\0') || isAbsolute(rel) || !isGlb(rel)) return null;
  try {
    const root = realpathSync(dir), file = realpathSync(resolve(root, rel));
    if (!file.startsWith(root + sep) || !statSync(file).isFile()) return null;
    return file;
  } catch { return null; }
}
