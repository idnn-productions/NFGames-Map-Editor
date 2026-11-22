// What the tests share: the sample project, copied to a temporary folder when a test writes.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
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

/** Tiny images as data URLs: real signatures, for the checks. */
export const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const JPEG_SIG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64')}`;

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
