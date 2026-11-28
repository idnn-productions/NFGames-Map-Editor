// What the tests share: the sample project, copied to a temporary folder when a test writes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Windows keeps no owner-only file modes and cannot run a `#!` script: tests of those say so with this. */
export const WINDOWS = process.platform === 'win32';

// The launcher: runs node (named in <own name>.node.txt beside it) on <own name>.stub.cjs with its own arguments,
// quoted the way Windows programs read them, and ends with node's exit code.
const LAUNCHER_CS = `using System; using System.Diagnostics; using System.IO; using System.Text;
class Launcher {
  static string Q(string s) {
    var b = new StringBuilder("\\""); int bs = 0;
    foreach (char c in s) {
      if (c == '\\\\') { bs++; continue; }
      if (c == '"') { b.Append('\\\\', bs * 2 + 1); } else { b.Append('\\\\', bs); }
      bs = 0; b.Append(c);
    }
    b.Append('\\\\', bs * 2); b.Append('"'); return b.ToString();
  }
  static int Main(string[] args) {
    string me = Process.GetCurrentProcess().MainModule.FileName, dir = Path.GetDirectoryName(me), name = Path.GetFileNameWithoutExtension(me);
    var line = new StringBuilder(Q(Path.Combine(dir, name + ".stub.cjs")));
    foreach (var a in args) { line.Append(' '); line.Append(Q(a)); }
    var p = new Process();
    p.StartInfo = new ProcessStartInfo(File.ReadAllText(Path.Combine(dir, name + ".node.txt")).Trim(), line.ToString()) { UseShellExecute = false };
    p.Start(); p.WaitForExit(); return p.ExitCode;
  }
}
`;
/** The compiled launcher's path (made on first use, then reused), or null where it cannot be compiled. */
function windowsLauncher() {
  const exe = join(tmpdir(), `nfgames-test-launcher-${createHash('sha256').update(LAUNCHER_CS).digest('hex').slice(0, 12)}.exe`);
  if (existsSync(exe)) return exe;
  for (const framework of ['Framework64', 'Framework']) {
    const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (!existsSync(csc)) continue;
    const work = mkdtempSync(join(tmpdir(), 'nfgames-launcher-'));
    try {
      writeFileSync(join(work, 'launcher.cs'), LAUNCHER_CS);
      execFileSync(csc, ['/nologo', '/optimize', `/out:${join(work, 'launcher.exe')}`, join(work, 'launcher.cs')], { stdio: 'ignore', windowsHide: true });
      copyFileSync(join(work, 'launcher.exe'), exe);
      return exe;
    } catch { /* the next one, or none */ } finally { rmSync(work, { recursive: true, force: true }); }
  }
  return null;
}

/**
 * Puts a stand-in for the program `name` first on the PATH: `source` is a Node script (CommonJS; it may start with a
 * `#!` line) that reads process.argv as [node, script, ...arguments]. Returns a function that undoes it.
 *
 * Elsewhere that is the script itself, made executable. Windows cannot start a script without a shell, and the editor
 * never uses one, so there the stand-in is a real program, <name>.exe: a small launcher (compiled once per machine
 * with the C# compiler every Windows has, and kept in the temporary folder) that runs node on the script kept beside
 * it, with the arguments it was given. Where there is no compiler, it is node itself under that name with a preload
 * (NODE_OPTIONS) that runs the script: enough for a program whose first argument is not an option, since node reads
 * its own options before the preload runs.
 */
export function fakeCommand(dir, name, source) {
  mkdirSync(dir, { recursive: true });
  const before = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
  if (!WINDOWS) { writeFileSync(join(dir, name), source); chmodSync(join(dir, name), 0o755); }
  else {
    writeFileSync(join(dir, `${name}.stub.cjs`), source);
    const launcher = windowsLauncher();
    if (launcher) { copyFileSync(launcher, join(dir, `${name}.exe`)); writeFileSync(join(dir, `${name}.node.txt`), process.execPath); }
    else {
      try { linkSync(process.execPath, join(dir, `${name}.exe`)); } catch { copyFileSync(process.execPath, join(dir, `${name}.exe`)); }
      writeFileSync(join(dir, 'preload.cjs'), "const path = require('path'), stub = path.join(path.dirname(process.execPath), path.basename(process.execPath, '.exe') + '.stub.cjs');\nif (require('fs').existsSync(stub)) { process.argv.splice(1, 0, stub); require(stub); process.exit(); }\n");
      process.env.NODE_OPTIONS = `--require "${join(dir, 'preload.cjs').replaceAll('\\', '/')}"${before.NODE_OPTIONS ? ` ${before.NODE_OPTIONS}` : ''}`;
    }
  }
  process.env.PATH = `${dir}${delimiter}${before.PATH}`;
  return () => { process.env.PATH = before.PATH; if (before.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before.NODE_OPTIONS; };
}
export const SAMPLE = join(REPO, 'examples', 'sample');
export const samplePlan = () => JSON.parse(readFileSync(join(SAMPLE, 'maps', 'plaza', 'layout.json'), 'utf8'));
export const samplePlants = () => JSON.parse(readFileSync(join(SAMPLE, 'maps', 'plaza', 'plants.json'), 'utf8'));

/** A copy of the sample project in a temporary folder: { root, done() }. */
export function sampleCopy() {
  const root = mkdtempSync(join(tmpdir(), 'nfgames-map-editor-'));
  cpSync(SAMPLE, root, { recursive: true, filter: (src) => !/[\\/]out([\\/]|$)|\.prev\.json$/.test(src) });
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A tar archive (USTAR, regular files only) of { name: text or bytes }, as npm packs them (names under package/). */
export function makeTar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
export const makeTgz = (files) => gzipSync(makeTar(files));

/** The smallest valid GLB: one triangle, no material. */
export function makeGlb() {
  const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }] };
  let j = Buffer.from(JSON.stringify(json)); j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([head, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
}

/** A small valid GLB with two named materials and two animation clips (for testing animations, stats and material tinting). */
export function makeAnimatedGlb() {
  const posA = Buffer.from(new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]).buffer);
  const posB = Buffer.from(new Float32Array([0, 0, 1, 2, 0, 1, 0, 1, 1]).buffer);
  const times = Buffer.from(new Float32Array([0, 1]).buffer);
  const trans = Buffer.from(new Float32Array([0, 0, 0, 0, 0.5, 0]).buffer);
  const scale = Buffer.from(new Float32Array([1, 1, 1, 1.2, 1.2, 1.2]).buffer);
  const parts = [posA, posB, times, trans, scale];
  const views = []; let off = 0;
  for (const p of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: p.length }); off += p.length; }
  const bin = Buffer.concat(parts);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, name: 'hull' }, { mesh: 1, name: 'trim' }],
    materials: [
      { name: 'HullSteel', pbrMetallicRoughness: { baseColorFactor: [0.3, 0.4, 0.5, 1] } },
      { name: 'TrimBrass', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.2, 1] } },
    ],
    meshes: [
      { name: 'hull', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      { name: 'trim', primitives: [{ attributes: { POSITION: 1 }, material: 1 }] },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 1], max: [2, 1, 1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    animations: [
      { name: 'Hover', samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] },
      { name: 'Pulse', samplers: [{ input: 2, output: 4, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'scale' } }] },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json)); j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([head, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
}

/** Minimal valid ASCII FBX 7.4 containing a single textured-free triangle mesh with one named material. */
export function makeFbx() {
  return Buffer.from(`; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",100
\t}
}
Objects:  {
\tGeometry: 1001, "Geometry::", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,2,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t\tGeometryVersion: 124
\t\tLayerElementMaterial: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tMaterials: *1 {
\t\t\t\ta: 0
\t\t\t}
\t\t}
\t\tLayer: 0 {
\t\t\tVersion: 100
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementMaterial"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t}
\t}
\tModel: 2001, "Model::FbxTri", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
\tMaterial: 3001, "Material::FbxClay", "" {
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tMultiLayer: 0
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",0.6,0.4,0.2
\t\t}
\t}
}
Connections:  {
\tC: "OO",2001,0
\tC: "OO",1001,2001
\tC: "OO",3001,2001
}
`, 'utf8');
}

/** Tiny images as data URLs: real signatures, for the checks. */
export const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const JPEG_SIG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64')}`;

/** The bytes of a data: URL, and the smallest thing that passes for a WebP: for image files on disk. */
export const dataBytes = (url) => Buffer.from(url.split(',')[1], 'base64');
export const WEBP_SIG = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

/** A GLB whose JSON chunk is `json` (the binary chunk is 4 empty bytes): enough for reading bounds from its header. */
export function glbOf(json) {
  let j = Buffer.from(JSON.stringify(json)); j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bin = Buffer.alloc(4), head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([head, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
}
/** glTF JSON of boxes: each { min, max, node? } is a mesh whose positions span min..max, on a node of the scene. */
export function boxScene(items, extra = {}) {
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: items.map((_, i) => i) }],
    nodes: items.map((it, i) => ({ mesh: i, ...(it.node || {}) })),
    meshes: items.map((_, i) => ({ primitives: [{ attributes: { POSITION: i } }] })),
    accessors: items.map((it) => ({ componentType: 5126, count: 8, type: 'VEC3', min: it.min, max: it.max })), ...extra };
}

/** Writes a plugin folder: plugin.json from `manifest` (name, version and engines filled in), plus { relPath: text } files. */
export function writePlugin(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: manifest.id, version: '1.0.0', engines: { nfgames: '^1.0.0' }, ...manifest }, null, 2));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
  return dir;
}
