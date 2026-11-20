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
  /** A box's 8 corners: index bit 0 is +x, bit 1 is +y, bit 2 is +z of its own frame. */
  function corners(box) {
    const t = rad(box.rot || 0), c = Math.cos(t), s = Math.sin(t), out = [];
    for (let i = 0; i < 8; i++) {
      const lx = i & 1 ? box.half[0] : -box.half[0], ly = i & 2 ? box.half[1] : -box.half[1], lz = i & 4 ? box.half[2] : -box.half[2];
      out.push([box.c[0] + lx * c + lz * s, box.c[1] + ly, box.c[2] - lx * s + lz * c]);
    }
    return out;
  }
  // a box's faces as corner indices (each a quad), with how bright each is: lit from above, one pair of sides darker than the other
  const FACES = [[[2, 3, 7, 6], 1], [[0, 4, 5, 1], 0.5], [[1, 5, 7, 3], 0.82], [[0, 2, 6, 4], 0.82], [[4, 6, 7, 5], 0.68], [[0, 1, 3, 2], 0.68]];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  /** Draws a scene with WebGL 1, or null when the browser has none:
   *  scene { clear: [r, g, b], ground: { disc: { c: [x, z], r } | rect: { min, max }, colour }, tris: [{ boxes, colour: [r, g, b, a] }], lines: [{ pts: [[x, y, z], ...], colour }] }.
   *  Colours are 0..1. See-through boxes (a < 1) are drawn last, without writing depth. */
  function renderer(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true }); } catch { gl = null; }
    if (!gl) return null;
    const shader = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec3 p; attribute vec4 c; uniform mat4 m; varying vec4 v; void main() { gl_Position = m * vec4(p, 1.0); v = c; }'));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec4 v; void main() { gl_FragColor = v; }'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    const aP = gl.getAttribLocation(prog, 'p'), aC = gl.getAttribLocation(prog, 'c'), uM = gl.getUniformLocation(prog, 'm'), buf = gl.createBuffer();
    const R = { lost: false };
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); R.lost = true; });
    /** Draws vertex data [x, y, z, r, g, b, a, ...] as triangles or lines. */
    const send = (data, mode) => {
      if (!data.length) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(mode, 0, data.length / 7);
    };
    const vert = (out, p, c, k = 1) => out.push(p[0], p[1], p[2], c[0] * k, c[1] * k, c[2] * k, c[3] ?? 1);
    const boxTris = (out, box, colour) => {
      const q = corners(box);
      for (const [[a, b, c, d], k] of FACES) for (const i of [a, b, c, a, c, d]) vert(out, q[i], colour, k);
    };
    R.resize = (w, h) => { canvas.width = w; canvas.height = h; };
    R.draw = (cam, scene) => {
      if (R.lost || gl.isContextLost()) { R.lost = true; return; }
      gl.viewport(0, 0, canvas.width, canvas.height);
      const bg = scene.clear || [0, 0, 0];
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog); gl.uniformMatrix4fv(uM, false, cam.viewProj);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // the ground, pushed back a little so what lies on it (grid, outlines) is not lost in it
      const g = scene.ground, ground = [];
      if (g && g.disc) { const { c, r } = g.disc, n = 96; for (let i = 0; i < n; i++) { const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2; vert(ground, [c[0], 0, c[1]], g.colour); vert(ground, [c[0] + Math.cos(a0) * r, 0, c[1] + Math.sin(a0) * r], g.colour); vert(ground, [c[0] + Math.cos(a1) * r, 0, c[1] + Math.sin(a1) * r], g.colour); } }
      else if (g && g.rect) { const [x0, z0] = g.rect.min, [x1, z1] = g.rect.max; for (const p of [[x0, z0], [x1, z0], [x1, z1], [x0, z0], [x1, z1], [x0, z1]]) vert(ground, [p[0], 0, p[1]], g.colour); }
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 2); send(ground, gl.TRIANGLES); gl.disable(gl.POLYGON_OFFSET_FILL);
      const solid = [], clear = [];
      for (const t of scene.tris || []) for (const b of t.boxes) boxTris((t.colour[3] ?? 1) < 1 ? clear : solid, b, t.colour);
      send(solid, gl.TRIANGLES);
      const lines = [];
      for (const l of scene.lines || []) for (let i = 0; i + 1 < l.pts.length; i++) { vert(lines, l.pts[i], l.colour); vert(lines, l.pts[i + 1], l.colour); }
      send(lines, gl.LINES);
      gl.depthMask(false); send(clear, gl.TRIANGLES); gl.depthMask(true);
    };
    return R;
  }

  return { camera, project, ray, rayPlaneY, rayBox, axisDrag, pieceBoxes, hostTop, corners, EDGES, renderer };
}
