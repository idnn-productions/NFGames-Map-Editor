// Tiny models and reference images for the match tests, made here: real triangles in a GLB (a sphere, boxes), and reference
// PNGs drawn from the same shapes, seen from each view the way the scorer sees them (src/match/score.py, "Views").
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };

/** A PNG (RGBA, 8 bits) of w x h pixels, each from pixel(x, y) -> [r, g, b, a] (0..255). */
export function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = pixel(x, y), o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3] ?? 255; } }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** glTF colours are linear: the colour a reference shows (sRGB, 0..255) as a model's base colour. */
export const linear = (rgb) => rgb.map((c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });

/** A GLB of one mesh: positions (flat xyz, glTF's frame), triangle indices, a flat colour. */
export function meshGlb(positions, indices, colour = [0.8, 0.1, 0.1]) {
  const pos = Buffer.from(new Float32Array(positions).buffer), idx = Buffer.from(new Uint32Array(indices).buffer);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], positions[i + k]); hi[k] = Math.max(hi[k], positions[i + k]); }
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'shape' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...colour, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: lo, max: hi }, { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }], buffers: [{ byteLength: pos.length + idx.length }] };
  const bin = Buffer.concat([pos, idx]);
  let j = Buffer.from(JSON.stringify(json)); j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const part = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([head, part(0x4e4f534a, j), part(0x004e4942, bin)]);
}

/** boxes: [{ min: [x, y, z], max: [x, y, z] }] (glTF: Y up, the front toward +Z). A union of boxes as one mesh. */
export function boxesGlb(boxes, colour) {
  const positions = [], indices = [];
  for (const { min, max } of boxes) {
    const base = positions.length / 3;
    for (let i = 0; i < 8; i++) positions.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
    for (const [a, b, c] of [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]) indices.push(base + a, base + b, base + c);
  }
  return meshGlb(positions, indices, colour);
}
export function sphereGlb(r = 1, colour, segments = 32, rings = 16) {
  const positions = [], indices = [];
  for (let i = 0; i <= rings; i++) for (let j = 0; j <= segments; j++) {
    const th = (i / rings) * Math.PI, ph = (j / segments) * 2 * Math.PI;
    positions.push(r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph));
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) { const a = i * (segments + 1) + j, b = a + segments + 1; indices.push(a, b, a + 1, a + 1, b, b + 1); }
  return meshGlb(positions, indices, colour);
}
/** The same boxes turned about the up axis (+Y) by `deg` degrees: a model that came out of a generator facing the wrong way. */
export const turnedBoxes = (boxes, deg) => {
  const a = (deg * Math.PI) / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  const turn = ([x, y, z]) => [c * x + s * z, y, -s * x + c * z];   // rotation about +Y
  return boxes.map(({ min, max }) => { const p = turn(min), q = turn(max); return { min: p.map((v, i) => Math.min(v, q[i])), max: p.map((v, i) => Math.max(v, q[i])) }; });
};

// ---- reference images, drawn from the shape. A view's image axes in glTF's frame (see score.py): right, up.
const AXES = { front: [[1, 0, 0], [0, 1, 0]], back: [[-1, 0, 0], [0, 1, 0]], left: [[0, 0, -1], [0, 1, 0]], right: [[0, 0, 1], [0, 1, 0]], top: [[-1, 0, 0], [0, 0, 1]], bottom: [[1, 0, 0], [0, 0, 1]] };
const dot = (a, v) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
/** Is the point (u, v) of `view` inside the projection of `shape`? shape: { boxes } or { sphere: r } (about the origin). */
function covers(shape, view, u, v) {
  const [r, up] = AXES[view];
  if (shape.sphere) return u * u + v * v <= shape.sphere * shape.sphere;
  return shape.boxes.some(({ min, max }) => {
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
    const us = corners.map((c) => dot(r, c)), vs = corners.map((c) => dot(up, c));
    return u >= Math.min(...us) && u <= Math.max(...us) && v >= Math.min(...vs) && v <= Math.max(...vs);
  });
}
/**
 * A reference PNG of `shape` seen from `view`. Options: colour (the object), background ([r, g, b], default #404040),
 * transparent (the background is alpha 0), size (square, default 192), turn (quarter-turns the picture is turned, as a top
 * view drawn with the front toward its side), gradient (a background that is not one flat colour), scale (stretches the
 * picture horizontally, so the reference disagrees with the others).
 */
export function refPng(shape, view, { colour = [200, 30, 30], background = [64, 64, 64], transparent = false, size = 192, turn = 0, gradient = false, stretch = 1 } = {}) {
  let ext = 1;
  if (shape.sphere) ext = shape.sphere; else for (const { min, max } of shape.boxes) for (const k of [0, 1, 2]) ext = Math.max(ext, Math.abs(min[k]), Math.abs(max[k]));
  const scale = (size * 0.4) / ext;
  const pix = (x, y) => {
    let px = x, py = y;
    for (let t = 0; t < ((turn % 4) + 4) % 4; t++) [px, py] = [size - 1 - py, px];   // each turn: the picture turned a quarter, clockwise
    const u = (px + 0.5 - size / 2) / scale / stretch, v = -(py + 0.5 - size / 2) / scale;
    if (covers(shape, view, u, v)) return [...colour, 255];
    if (gradient) return [(x / size) * 255, (y / size) * 255, 128, 255];
    return [...background, transparent ? 0 : 255];
  };
  return png(size, size, pix);
}

/** Writes <dir>/<view>.png for each view of `shape`, with the same options for all. Returns the folder. */
export function writeRefs(dir, shape, views, options = {}, perView = {}) {
  mkdirSync(dir, { recursive: true });
  for (const v of views) writeFileSync(join(dir, `${v}.png`), refPng(shape, v, { ...options, ...(perView[v] || {}) }));
  return dir;
}
