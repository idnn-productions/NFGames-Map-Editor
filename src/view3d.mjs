// The 3D view's own parts: the camera, picking boxes with a ray, dragging along an axis, a piece as boxes, and what a piece
// lands on. The page runs this function's source (the server writes it in, as it does plan.mjs's plantEditing), so it
// must stay self-contained: no imports, nothing from this module's scope. The tests run the same code in Node.
//
// Frame: metres, +X east, +Z south, Y up; a point is [x, y, z]. A piece's `rot` is degrees about Y, 0 facing +Z; a point
// (lx, lz) of its own frame is at (x + lx cos + lz sin, z - lx sin + lz cos), as in check.mjs.
export function view3d() {
  const rad = (d) => (d * Math.PI) / 180;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  /** 4x4 matrices are column-major Float32Arrays, as WebGL takes them. */
  const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const xform = (m, [x, y, z], w = 1) => [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
  function invert(m) {
    const o = new Float32Array(16), a = Array.from(m);
    o[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    o[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    o[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    o[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    o[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    o[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    o[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    o[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    o[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    o[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    o[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    o[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    o[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    o[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    o[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    o[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    const det = a[0] * o[0] + a[1] * o[4] + a[2] * o[8] + a[3] * o[12];
    for (let i = 0; i < 16; i++) o[i] /= det || 1;
    return o;
  }

  /** The camera orbits `target`: yaw 0 looks north (toward -Z), 90 looks east; pitch is how far it looks down. */
  function camera(cam, aspect) {
    const y = rad(cam.yaw), p = rad(cam.pitch);
    const f = [Math.sin(y) * Math.cos(p), -Math.sin(p), -Math.cos(y) * Math.cos(p)];
    const eye = cam.target.map((v, i) => v - f[i] * cam.dist);
    const s = unit(cross(f, [0, 1, 0])), u = cross(s, f);
    const view = new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
    const near = 0.5, far = 2000, t = 1 / Math.tan(rad(cam.fov) / 2);
    const proj = new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    const viewProj = mul(proj, view);
    return { eye, viewProj, inv: invert(viewProj) };
  }
  /** A point on the canvas (pixels, y down) and its depth 0..1, or null when it is behind the eye. */
  function project(c, pt, W, H) {
    const [x, y, z, w] = xform(c.viewProj, pt);
    if (w <= 1e-6) return null;
    return [((x / w + 1) / 2) * W, ((1 - y / w) / 2) * H, (z / w + 1) / 2];
  }
  /** The ray from the eye through a pixel. */
  function ray(c, sx, sy, W, H) {
    const nx = (sx / W) * 2 - 1, ny = 1 - (sy / H) * 2;
    const at = (z) => { const v = xform(c.inv, [nx, ny, z]); return [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; };
    const o = at(-1);
    return { o, d: unit(sub(at(1), o)) };
  }
  /** Where a ray meets the level y, or null (parallel to it, or behind the eye). */
  function rayPlaneY(r, y) {
    if (Math.abs(r.d[1]) < 1e-9) return null;
    const t = (y - r.o[1]) / r.d[1];
    if (t < 0) return null;
    return [r.o[0] + r.d[0] * t, y, r.o[2] + r.d[2] * t];
  }
  /** How far along a ray it enters a box turned `rot` degrees about Y (0 when it starts inside), or null when it misses. */
  function rayBox(r, box) {
    const t = rad(box.rot || 0), c = Math.cos(t), s = Math.sin(t);
    const local = ([dx, dy, dz]) => [dx * c - dz * s, dy, dx * s + dz * c];
    const o = local(sub(r.o, box.c)), d = local(r.d);
    let lo = -Infinity, hi = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) { if (Math.abs(o[i]) > box.half[i]) return null; continue; }
      let a = (-box.half[i] - o[i]) / d[i], b = (box.half[i] - o[i]) / d[i];
      if (a > b) [a, b] = [b, a];
      lo = Math.max(lo, a); hi = Math.min(hi, b);
      if (lo > hi) return null;
    }
    return hi < 0 ? null : Math.max(lo, 0);
  }
  /** The coordinate on `axis` (0 x, 1 y, 2 z) of the point of the line through `origin` along that axis nearest the ray; null when the ray is within 3 degrees of the axis. */
  function axisDrag(r, origin, axis) {
    const e = [0, 0, 0]; e[axis] = 1;
    const b = dot(r.d, e), denom = 1 - b * b;
    if (denom < Math.sin(rad(3)) ** 2) return null;
    const w = sub(r.o, origin), s = (dot(e, w) - b * dot(r.d, w)) / denom;
    return origin[axis] + s;
  }
  /** A piece as boxes, one per entry of its kind's `boxes`, standing at height y. s scales x and z, st stretches x, hs scales height. */
  function pieceBoxes(q) {
    const t = rad(q.rot || 0), c = Math.cos(t), sn = Math.sin(t), h = q.size[2] * q.hs, y = q.y || 0;
    return q.boxes.map(([bx, bz, bw, bd]) => {
      const lx = bx * q.s * q.st, lz = bz * q.s;
      return { c: [q.at[0] + lx * c + lz * sn, y + h / 2, q.at[1] - lx * sn + lz * c], half: [(bw * q.s * q.st) / 2, h / 2, (bd * q.s) / 2], rot: q.rot || 0 };
    });
  }
  /** What a piece set down at `at` stands on: the fit check's rule (check.mjs). A piece on the ground (y <= 0.5), of a known
   *  kind, not solid:false, whose footprint holds the point; the first in file order. Its top is `deck`, else its height,
   *  times its scale. `skip`: ids not to land on (what is being moved). */
  function hostTop(plan, kinds, at, skip) {
    const kindScale = plan.kindScale || {};
    for (const p of [...(plan.pieces || []), ...(plan.marks || [])]) {
      const k = kinds[p.kind];
      if (skip.has(p.id) || (p.y || 0) > 0.5 || !k || k.solid === false) continue;
      const s = p.scale || kindScale[p.kind] || 1, st = p.stretch || 1, t = rad(p.rot || 0), c = Math.cos(t), sn = Math.sin(t);
      const dx = at[0] - p.at[0], dz = at[1] - p.at[1], u = dx * c - dz * sn, v = dx * sn + dz * c;
      if (k.boxes.some(([bx, bz, bw, bd]) => Math.abs(u - bx * s * st) <= (bw * s * st) / 2 && Math.abs(v - bz * s) <= (bd * s) / 2)) return { id: p.id, top: (k.deck ?? k.size[2]) * s };
    }
    return null;
  }
  function renderer() { return null; }

  return { camera, project, ray, rayPlaneY, rayBox, axisDrag, pieceBoxes, hostTop, renderer };
}
