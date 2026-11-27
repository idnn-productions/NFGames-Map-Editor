// The models a project shows in the viewer: every .glb under its `models` folder. A path from a request is resolved
// against that folder and must stay in it (real paths compared, so a symlink cannot lead out), and must name a .glb.
// A model's reference images (what it was made from) are the image files in the folder next to it, <name>.refs/.
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

const MAX_MODELS = 5000;
const isGlb = (name) => /\.glb$/i.test(name);

/** Folders that hold copies of a project's models, or other people's, and never its own: skipped at any depth. */
export const SKIPPED = ['node_modules', 'dist', 'build', 'out', 'Library', 'Temp'];

/**
 * Every .glb under `dir` (subfolders too; dot-folders, the SKIPPED folders and symlinks left out): [{ path, size, mtime, level? }],
 * sorted by path. `skip`: folders (paths from `dir`) left out with everything under them. A model is a level (`level: true`)
 * when a .json of its name is beside it (town.glb, town.json: what the game reads with it), or `levels` names its path.
 */
export function listModels(dir, { skip = [], levels = [] } = {}) {
  const out = [], tidy = (p) => String(p).split(/[\\/]+/).filter((s) => s && s !== '.').join('/');
  const skipped = new Set(skip.map(tidy)), named = new Set(levels.map(tidy));
  const walk = (at, rel) => {
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    const data = new Set(entries.filter((e) => /\.json$/i.test(e.name)).map((e) => e.name.slice(0, -5).toLowerCase()));
    for (const e of entries) {
      if (out.length >= MAX_MODELS || e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = join(at, e.name), path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIPPED.includes(e.name) && !skipped.has(path)) walk(full, path); }
      else if (e.isFile() && isGlb(e.name)) {
        const s = statSync(full), model = { path, size: s.size, mtime: Math.round(s.mtimeMs) };
        if (named.has(path) || data.has(e.name.slice(0, -4).toLowerCase())) model.level = true;
        out.push(model);
      }
    }
  };
  walk(dir, '');
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

// ---- reference images: <dir>/<name>.refs/ beside <dir>/<name>.glb. No manifest: the files are the list.
export const REF_LIMITS = { count: 24, size: 40 * 1024 * 1024, name: 120 };
const REF_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }; // never SVG: it can carry script
const REF_ORDER = ['concept', 'front', 'left', 'back', 'right', 'top', 'bottom', 'three-quarter'];

/** What an image's first bytes must be, by kind: a file's name alone is not believed. */
export const IMAGE_SIGNATURES = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
const refType = (name) => REF_TYPES[extname(name).toLowerCase()] || null;
const refLabel = (name) => name.slice(0, -extname(name).length);
/** A reference's name from a request: one plain file name with an image extension, nothing that could be a path. */
const refName = (name) => typeof name === 'string' && name.length > 0 && name.length <= REF_LIMITS.name && !/[\\/\0:]/.test(name) && !name.startsWith('.') && !!refType(name);
const head = (file) => { const b = Buffer.alloc(12), fd = openSync(file, 'r'); try { readSync(fd, b, 0, 12, 0); } finally { closeSync(fd); } return b; };

/** The .refs folder of the model at real path `file`, or null: a real folder (not a link) beside the model. */
function refsFolder(file) {
  const dir = file.replace(/\.glb$/i, '.refs');
  try { return lstatSync(dir).isDirectory() && realpathSync(dir) === join(realpathSync(dirname(file)), basename(dir)) ? dir : null; } catch { return null; }
}
/** One reference in `dir`, or null: a real file (not a link) that stays in the folder, of a size we serve, whose bytes are the image its name says. */
function refEntry(dir, name) {
  if (!refName(name)) return null;
  try {
    const full = join(dir, name), st = lstatSync(full);
    if (!st.isFile() || st.size > REF_LIMITS.size || realpathSync(full) !== join(realpathSync(dir), name)) return null;
    const type = refType(name);
    if (!IMAGE_SIGNATURES[type === 'image/jpeg' ? 'jpg' : type.slice(6)](head(full))) return null;
    return { name, file: full, type, size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch { return null; }
}
const refRank = (name) => { const i = REF_ORDER.indexOf(refLabel(name).toLowerCase()); return i < 0 ? REF_ORDER.length : i; };

/** The references of model `rel` under `dir`: [{ name, size, mtime, file, type }], the concept first, then the views in their order, then the rest by name. None: []. */
export function modelRefs(dir, rel) {
  const model = resolveModel(dir, rel), folder = model && refsFolder(model);
  if (!folder) return [];
  let names; try { names = readdirSync(folder); } catch { return []; }
  return names.filter(refName).sort((a, b) => refRank(a) - refRank(b) || a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b))
    .slice(0, REF_LIMITS.count * 4).map((n) => refEntry(folder, n)).filter(Boolean).slice(0, REF_LIMITS.count);   // a folder of junk is not read to its end
}
/** For the page: no paths on disk. */
export const listRefs = (dir, rel) => modelRefs(dir, rel).map(({ name, size, mtime }) => ({ name, size, mtime }));

/** One reference of model `rel`, to serve: { name, file, type, size, mtime }, or null. The name must be a file the folder really holds, spelled as it is there. */
export function resolveRef(dir, rel, name) {
  const model = resolveModel(dir, rel), folder = model && refsFolder(model);
  if (!folder || !refName(name)) return null;
  try { if (!readdirSync(folder).includes(name)) return null; } catch { return null; }
  return refEntry(folder, name);
}
