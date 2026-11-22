// three.js for the model viewer, installed on demand and never shipped: one pinned version, downloaded from the npm
// registry when the user presses Install, checked against the SHA-512 written here (other bytes install nothing), and
// only the files the viewer needs are kept, in <editor>/vendor/three-<version>/ (git-ignored). They are served from
// there to this editor's own page, and nothing else is. No npm, no shell: Node's fetch, zlib and the tar reader below.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const THREE = {
  version: '0.187.0',
  tarball: 'https://registry.npmjs.org/three/-/three-0.187.0.tgz',
  integrity: 'sha512-Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA==',
  size: 4795351, // bytes, shown on the Install button
  // what the viewer imports, and what those import (paths inside the package, without "package/")
  files: [
    'LICENSE', 'build/three.module.js', 'build/three.core.js',
    'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/loaders/DRACOLoader.js', 'examples/jsm/loaders/KTX2Loader.js',
    'examples/jsm/controls/OrbitControls.js', 'examples/jsm/environments/RoomEnvironment.js',
    'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js', 'examples/jsm/utils/WorkerPool.js',
    'examples/jsm/math/ColorSpaces.js',
    'examples/jsm/libs/ktx-parse.module.js', 'examples/jsm/libs/zstddec.module.js', 'examples/jsm/libs/meshopt_decoder.module.js',
    'examples/jsm/libs/draco/gltf/draco_decoder.js', 'examples/jsm/libs/draco/gltf/draco_decoder.wasm', 'examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js',
    'examples/jsm/libs/basis/basis_transcoder.js', 'examples/jsm/libs/basis/basis_transcoder.wasm',
  ],
};
const MAX_DOWNLOAD = 64 * 1024 * 1024;
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '': 'text/plain; charset=utf-8' };

let installing = null;

export const vendorDir = (editorRoot, t = THREE) => join(editorRoot, 'vendor', `three-${t.version}`);
export const vendorBase = (t = THREE) => `/vendor/three-${t.version}/`;

/** What the page needs to know: is the pinned version installed, and where it is served from. */
export function vendorState(editorRoot, t = THREE) {
  return { version: t.version, size: t.size, base: vendorBase(t), installed: existsSync(join(vendorDir(editorRoot, t), '.complete')), installing: !!installing };
}

/** The regular files of a tar archive (USTAR, and the PAX long names npm can write): { name, data }. */
export function* tarEntries(buf) {
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return;
    const str = (at, n) => { const s = h.subarray(at, at + n), z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString('utf8'); };
    const size = parseInt(str(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('not a tar archive');
    const type = String.fromCharCode(h[156] || 48), prefix = str(257, 5) === 'ustar' ? str(345, 155) : '';
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8')); longName = m ? m[1] : null; continue; }
    const name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    if (type === '0') yield { name, data };
  }
}

/** The allow-listed files of an npm package tarball (.tgz): path (without "package/") → bytes. Throws when one is missing. */
export function extractAllowed(tgz, files) {
  const wanted = new Set(files), out = new Map();
  for (const { name, data } of tarEntries(gunzipSync(tgz))) {
    const path = name.replace(/^package\//, '');
    if (wanted.has(path)) out.set(path, Buffer.from(data));
  }
  const missing = files.filter((f) => !out.has(f));
  if (missing.length) throw new Error(`the package lacks ${missing.join(', ')}`);
  return out;
}

export const integrityOf = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

/** Downloads, checks and installs the pinned three.js. One install at a time: a second call gets the first's promise. */
export function installThree(editorRoot, { fetchImpl = fetch, t = THREE } = {}) {
  if (!installing) installing = install(editorRoot, fetchImpl, t).finally(() => { installing = null; });
  return installing;
}

async function install(editorRoot, fetchImpl, t) {
  const dir = vendorDir(editorRoot, t), tmp = `${dir}.tmp`;
  const res = await fetchImpl(t.tarball);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText || ''}`.trim());
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error('download failed: larger than expected');
  if (integrityOf(buf) !== t.integrity) throw new Error(`not installed: the download of three ${t.version} does not match its pinned SHA-512`);
  const files = extractAllowed(buf, t.files);
  rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [path, data] of files) { const to = join(tmp, path); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, data); }
    writeFileSync(join(tmp, '.complete'), `${t.version}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  return vendorState(editorRoot, t);
}

/** The file for a /vendor/... URL path, or null: only the pinned version, only allow-listed files, only once installed. */
export function vendorFile(editorRoot, urlPath, t = THREE) {
  const base = vendorBase(t);
  if (typeof urlPath !== 'string' || !urlPath.startsWith(base)) return null;
  const path = urlPath.slice(base.length);
  if (!t.files.includes(path) || !existsSync(join(vendorDir(editorRoot, t), '.complete'))) return null;
  const ext = /\.[a-z]+$/.exec(path)?.[0] ?? '';
  return { file: join(vendorDir(editorRoot, t), path), type: TYPES[ext] || 'application/octet-stream' };
}
