// A GLB's JSON header, and the bounds of what its scene draws, read without loading the model: the editor sizes a
// model kind's footprint from this. glTF requires every POSITION accessor to carry min and max, so no vertex is read.
import { closeSync, openSync, readSync } from 'node:fs';

/** The JSON chunk of a .glb file, reading only the start of the file. Throws when it is not a GLB. */
export function glbJson(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20 || head.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file');
    const length = head.readUInt32LE(12), type = head.readUInt32LE(16);
    if (type !== 0x4e4f534a || length > 64 * 1024 * 1024) throw new Error('not a GLB file: no JSON chunk where a GLB has one');
    const json = Buffer.alloc(length);
    if (readSync(fd, json, 0, length, 20) < length) throw new Error('not a GLB file: it ends inside its JSON chunk');
    return JSON.parse(json.toString('utf8'));
  } finally { closeSync(fd); }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Column-major 4x4 product a·b. */
function mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }

/** A node's local matrix (column-major): its `matrix`, or translation · rotation (quaternion x, y, z, w) · scale. */
export function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0], [x, y, z, w] = node.rotation || [0, 0, 0, 1], [sx, sy, sz] = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

// Normalized integer positions (KHR_mesh_quantization, as Meshopt writes them) keep min and max in the integers' own
// units; the GPU reads them as these (glTF 2.0, "Animation" and "Meshes": a signed type is never below -1).
const UNNORMALIZE = { 5120: (c) => Math.max(c / 127, -1), 5121: (c) => c / 255, 5122: (c) => Math.max(c / 32767, -1), 5123: (c) => c / 65535 };
const asDrawn = (a, v) => { const f = a.normalized && UNNORMALIZE[a.componentType]; return f ? v.map(f) : v; };

/** The bounds of everything the default scene draws, in the model's frame (glTF: metres, Y up): { min, max }. */
export function sceneBounds(gltf) {
  const nodes = gltf.nodes || [], meshes = gltf.meshes || [], acc = gltf.accessors || [];
  const scene = (gltf.scenes || [])[gltf.scene ?? 0];
  const roots = scene && Array.isArray(scene.nodes) ? scene.nodes : nodes.map((_, i) => i).filter((i) => !nodes.some((n) => (n.children || []).includes(i)));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], seen = new Set();
  const visit = (i, parent) => {
    const node = nodes[i];
    if (!node || seen.has(i)) return;
    seen.add(i);
    const m = mul(parent, localMatrix(node));
    for (const prim of (node.mesh !== undefined && meshes[node.mesh] && meshes[node.mesh].primitives) || []) {
      const a = acc[prim.attributes && prim.attributes.POSITION];
      if (!a || !Array.isArray(a.min) || !Array.isArray(a.max)) continue;
      const lo = asDrawn(a, a.min), hi = asDrawn(a, a.max);
      for (let c = 0; c < 8; c++) {
        const p = [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]];
        for (let k = 0; k < 3; k++) { const v = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
      }
    }
    for (const ch of node.children || []) visit(ch, m);
  };
  for (const r of roots) visit(r, IDENTITY);
  if (!Number.isFinite(min[0])) throw new Error('nothing with a size in its scene');
  return { min, max };
}
