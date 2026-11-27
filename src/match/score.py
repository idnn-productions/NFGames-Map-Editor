"""Reference-match scorer for the NFGames map editor. Runs in stock Blender, started by src/match.mjs as a fixed command:

  blender -b --factory-startup --python score.py -- <args.json>

args.json is written by the editor (never by hand): { model, refs: {view: path}, outDir, result, weights, colourFalloff,
grid, fill, upFix, planUp, fit, quick }. It reads the model (a GLB: glTF's frame, Y up, the front toward +Z) and one
orthographic reference image per view (front, back, left, right, top, bottom), and writes <result> (JSON) and, per view,
overlay-<view>.png (the model's outline over the reference) and render-<view>.png (a textured render) into outDir.
With { refs, outDir, result, refsOnly: true, planUp } (no model) it reads only the references and scores each pair of
opposite views against each other (left-right, front-back, top-bottom): see "the references alone" below. There a reference
that cannot be read ends the run with ok: false.

Views (the model seen from ...; the image's up is the model's up, except top and bottom, where it is the model's front):
  front: the front (+Z), the model's left on the image's right        back: behind, the model's right on the image's right
  left:  its left side (+X), the front on the image's left            right: its right side (-X), the front on the image's right
  top / bottom: from above / below, the front toward the image's top (planUp says where a reference has it instead)

Per view: silhouette IoU (each silhouette cropped to its bounding box and scaled to the same width, aspect kept, so framing
and scale do not count; in the final pass, with fit, the model's silhouette is then moved and scaled a little to where it agrees
best, so a part missing at one edge does not shift the rest), and a colour score inside the overlap of the two silhouettes (1 minus the mean colour distance
over a falloff; lighting is not counted as colour). Models from generators come out turned arbitrarily: the four quarter-turns about up (all 24 axis-aligned
orientations with upFix) are tried, the best kept, and which one is reported.
"""
import bpy, bmesh, json, math, os, sys, time
import mathutils.bvhtree
import numpy as np
from mathutils import Vector, Matrix

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1]))
OUT = cfg["outDir"]; os.makedirs(OUT, exist_ok=True)
GRID = int(cfg.get("grid", 256)); FILL = float(cfg.get("fill", 0.92)); FIT = bool(cfg.get("fit", True))
FIT_SCALES = (0.90, 0.95, 1.0, 1.05, 1.10)                                           # of the bounding-box width
FIT_STEPS = sorted({round(k * GRID / 256) for k in range(-8, 9, 2)})                 # -8 to 8 in steps of 2, in pixels of a 256 grid
W = cfg.get("weights", {"silhouette": 0.6, "colour": 0.4}); FALLOFF = float(cfg.get("colourFalloff", 0.4))
VIEWS = [v for v in ("front", "back", "left", "right", "top", "bottom") if v in cfg["refs"]]
PLAN = ("top", "bottom")
TMP = os.path.join(OUT, "_tmp"); os.makedirs(TMP, exist_ok=True)
SEARCH_RES, FINAL_RES, RENDER_RES, REF_MAX = 384, 768, 1024, 512
t0 = time.time()

def progress(i, n, text):
    print(f"PROGRESS {i}/{n} {text}", flush=True)

def finish(res):
    for f in os.listdir(TMP):
        try: os.remove(os.path.join(TMP, f))
        except OSError: pass
    try: os.rmdir(TMP)
    except OSError: pass
    json.dump(res, open(cfg["result"], "w"), indent=1)
    print("MATCH_DONE", flush=True)
    sys.exit(0)

def fail(text):
    finish({"ok": False, "error": text})

bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------------- the references
def pixels(im, w, h):
    a = np.empty(w * h * 4, np.float32); im.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1]

def load_ref(path):
    im = bpy.data.images.load(path); w, h = im.size
    px = pixels(im, w, h).copy(); bpy.data.images.remove(im)
    step = max(1, max(w, h) // REF_MAX)
    return px[::step, ::step], [w, h]

def ref_mask(px):
    """The object's silhouette in a reference, and how its background was found: 'alpha', 'flat', or 'unclean' with why."""
    h, w = px.shape[:2]; rgb, a = px[:, :, :3], px[:, :, 3]
    ring = np.zeros((h, w), bool); r = max(2, min(h, w) // 100); ring[:r] = ring[-r:] = True; ring[:, :r] = ring[:, -r:] = True
    if (a[ring] < 0.1).mean() > 0.9 and (a > 0.5).any():
        m = a > 0.5
        return m, "alpha", None
    bg = np.median(rgb[ring], 0); dist = np.abs(rgb - bg).max(2)
    spread = float(np.percentile(dist[ring], 95))
    tol = max(0.035, min(0.12, spread * 1.5)); bgl = dist < tol
    reach = np.zeros_like(bgl); reach[:r] = bgl[:r]; reach[-r:] = bgl[-r:]; reach[:, :r] = bgl[:, :r]; reach[:, -r:] = bgl[:, -r:]
    while True:
        g = reach.copy(); g[1:] |= reach[:-1]; g[:-1] |= reach[1:]; g[:, 1:] |= reach[:, :-1]; g[:, :-1] |= reach[:, 1:]
        g &= bgl
        if (g == reach).all(): break
        reach = g
    m = ~reach; cover = float(m.mean()); why = None
    if spread > 0.12: why = "the image's edge is not one flat colour (a gradient, a photo or a scene), so the background cannot be told from the object"
    elif cover > 0.85: why = "the background fills almost none of the image, so the object's outline is not clear"
    elif cover < 0.005: why = "no object was found: the image is one flat colour"
    return m, ("unclean" if why else "flat"), why

def box(a, r):
    """A box blur of a 2D or 3D array, radius r (edges repeated)."""
    k = 2 * r + 1; p = np.pad(a, [(r, r), (r, r)] + [(0, 0)] * (a.ndim - 2), mode='edge')
    c = np.cumsum(p, 0); c = np.concatenate([np.zeros_like(c[:1]), c], 0); v = (c[k:] - c[:-k])
    c = np.cumsum(v, 1); c = np.concatenate([np.zeros_like(c[:, :1]), c], 1); return (c[:, k:] - c[:, :-k]) / (k * k)

def crop(mask, rgb):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0: return None
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return mask[y0:y1, x0:x1], rgb[y0:y1, x0:x1, :3]

def fit(c, width):
    """A crop scaled so it is `width` pixels wide (aspect kept) and centred on the canvas."""
    m, rgb = c; h, w = m.shape; k = width / w; nh, nw = max(1, round(h * k)), max(1, round(w * k))
    yi = np.minimum((np.arange(nh) / k).astype(int), h - 1); xi = np.minimum((np.arange(nw) / k).astype(int), w - 1)
    cm = np.zeros((GRID, GRID), bool); cr = np.zeros((GRID, GRID, 3), np.float32)
    oy, ox = (GRID - nh) // 2, (GRID - nw) // 2
    ya, yb, xa, xb = max(0, oy), min(GRID, oy + nh), max(0, ox), min(GRID, ox + nw)
    cm[ya:yb, xa:xb] = m[yi][:, xi][ya - oy:yb - oy, xa - ox:xb - ox]; cr[ya:yb, xa:xb] = rgb[yi][:, xi][ya - oy:yb - oy, xa - ox:xb - ox]
    return cm, cr

def pair_width(ca, cb):
    """The width two crops are scaled to: FILL of the canvas, or less when either is taller than wide, so both fit."""
    return FILL * GRID / max(1.0, ca[0].shape[0] / ca[0].shape[1], cb[0].shape[0] / cb[0].shape[1])

def normalise_pair(a, b):
    """Two silhouettes (with their colours) cropped to their bounding boxes and scaled to the same width (pair_width), aspect
    kept, so framing and scale do not count."""
    ca, cb = crop(*a), crop(*b)
    if ca is None or cb is None: return None
    width = pair_width(ca, cb)
    return fit(ca, width), fit(cb, width)

def shifted(d, n):
    """The source and the destination slices of an axis of n pixels moved by d."""
    return slice(max(0, -d), n - max(0, d)), slice(max(0, d), n - max(0, -d))

def place(ca, width, bm):
    """The model's crop placed on the canvas where it agrees best with the reference's mask bm: at each of FIT_SCALES of `width`,
    moved by FIT_STEPS each way. The highest IoU wins, a tie going to the one nearest the bounding-box placement (the smallest
    |scale - 1|, then the smallest |dx| + |dy|). That placement (scale 1, no move) is one of those tried, so the IoU is never
    lower than it. Returns the placed mask and colours and { scale, dx, dy } (dx, dy: canvas pixels, right and down)."""
    nb = int(bm.sum()); best = None
    for k in FIT_SCALES:
        cm, cr = fit(ca, width * k)
        for dy in FIT_STEPS:
            sy, ty = shifted(dy, GRID)
            for dx in FIT_STEPS:
                sx, tx = shifted(dx, GRID); a = cm[sy, sx]
                inter = int((a & bm[ty, tx]).sum()); iou = inter / max(1, int(a.sum()) + nb - inter)
                key = (iou, -abs(k - 1), -(abs(dx) + abs(dy)))
                if best is None or key > best[0]: best = (key, k, dx, dy, cm, cr)
    _, k, dx, dy, cm, cr = best; (sy, ty), (sx, tx) = shifted(dy, GRID), shifted(dx, GRID)
    pm = np.zeros_like(cm); pr = np.zeros_like(cr); pm[ty, tx] = cm[sy, sx]; pr[ty, tx] = cr[sy, sx]
    return pm, pr, {"scale": k, "dx": dx, "dy": dy}

def erode(m, n=1):
    for _ in range(n):
        e = m.copy(); e[1:] &= m[:-1]; e[:-1] &= m[1:]; e[:, 1:] &= m[:, :-1]; e[:, :-1] &= m[:, 1:]; m = e
    return m

def colour_score(am, ar, bm, br):
    """1 minus the colour distance inside the overlap, over FALLOFF. References are shaded (lit, painted) and the model is drawn flat, so
    lighting must not count as a wrong colour: the distance is mostly the chromaticity (the colour with its brightness taken out),
    plus the lightness after each image's overall exposure is matched."""
    ov = erode(am & bm, 2)
    if ov.sum() < 30: return 0.0
    fa = box(ar * am[..., None], 2) / np.maximum(box(am.astype(np.float32), 2), 1e-3)[..., None]
    fb = box(br * bm[..., None], 2) / np.maximum(box(bm.astype(np.float32), 2), 1e-3)[..., None]
    ca = fa / (fa.sum(2, keepdims=True) + 1e-3); cb = fb / (fb.sum(2, keepdims=True) + 1e-3)
    chroma = 0.5 * np.abs(ca - cb).sum(2)
    la, lb = fa.mean(2), fb.mean(2); la = la / max(la[ov].mean(), 1e-3); lb = lb / max(lb[ov].mean(), 1e-3)
    light = np.clip(np.abs(la - lb) / 2, 0, 1)
    d = 0.75 * chroma + 0.25 * light
    return float(np.clip(1 - d[ov].mean() / FALLOFF, 0, 1))

def combined(iou, col):
    ws, wc = float(W.get("silhouette", 0.6)), float(W.get("colour", 0.4)); t = ws + wc
    return (ws * iou + wc * col) / t if t > 0 else iou

REFS = {}
for v in VIEWS:
    if not cfg.get("refsOnly"): px, size_px = load_ref(cfg["refs"][v]); m, how, why = ref_mask(px)
    else:   # a reference alone that cannot be read ends with ok: false (Blender loads a file it cannot decode as 0 x 0 pixels)
        try:
            px, size_px = load_ref(cfg["refs"][v])
            if min(size_px) <= 0: raise ValueError("Blender cannot decode it (not an image, or empty)")
            m, how, why = ref_mask(px)
        except Exception as e: fail(f"{v}: the image could not be read: {e}")
    REFS[v] = {"px": px, "mask": m, "background": how, "why": why, "size": size_px}
ref_warnings = [{"view": v, "kind": "background", "text": f"{v}: {REFS[v]['why']}"} for v in VIEWS if REFS[v]["why"]]

def ref_extent(R):
    c = crop(R["mask"], R["px"]); return None if c is None else list(c[0].shape[::-1])

# ---------------------------------------------------------------- the references alone (refsOnly): no model is read
# An object's outline seen from one side is the mirror image of its outline from the opposite side: each pair is scored as
# the first view's mask against the second's mirrored: left to right, except top and bottom drawn with the front toward
# the image's side (planUp right or left), where the quarter-turn makes it top to bottom. A pair needs both views, each with a
# clean background.
PAIRS = (("left", "right"), ("front", "back"), ("top", "bottom"))
if cfg.get("refsOnly"):
    pu = cfg.get("planUp"); pu = pu if pu in ("up", "right", "down", "left") else "up"
    pairs = {}
    for a, b in PAIRS:
        if a not in REFS or b not in REFS or "unclean" in (REFS[a]["background"], REFS[b]["background"]): continue
        A, B = REFS[a], REFS[b]
        flip = (slice(None, None, -1), slice(None)) if a in PLAN and pu in ("right", "left") else (slice(None), slice(None, None, -1))
        pair = normalise_pair((A["mask"], A["px"][:, :, :3]), (B["mask"][flip], B["px"][flip][:, :, :3]))
        if pair is None: iou = col = 0.0
        else:
            (am, ar), (bm, br) = pair
            iou = float((am & bm).sum() / max(1, (am | bm).sum())); col = colour_score(am, ar, bm, br)
        pairs[f"{a}-{b}"] = {"outline": round(iou, 4), "colour": round(col, 4)}
    finish({
        "ok": True, "refsOnly": True,
        "views": {v: {"background": REFS[v]["background"], "refSize": REFS[v]["size"], "refExtent": ref_extent(REFS[v]), "planUp": pu if v in PLAN else None} for v in VIEWS},
        "pairs": pairs, "warnings": ref_warnings, "seconds": round(time.time() - t0, 1),
    })

# ---------------------------------------------------------------- the model
sc = bpy.context.scene
try:
    bpy.ops.import_scene.gltf(filepath=cfg["model"])
except Exception as e:
    fail(f"Blender could not read the model: {e}")
meshes = [o for o in sc.objects if o.type == 'MESH']
if not meshes: fail("the model has no meshes")
for o in list(sc.objects):
    if o.type != 'MESH': o.hide_render = True

# Workbench shows a material's colour from its viewport colour or its active image: take them from Base Color
for mat in bpy.data.materials:
    if not mat.node_tree: continue
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is not None:
        sock = bsdf.inputs['Base Color']
        if not sock.is_linked: mat.diffuse_color = tuple(sock.default_value)
    for nd in mat.node_tree.nodes:
        if nd.type == 'TEX_IMAGE' and any(l.to_socket.name == 'Base Color' for l in nd.outputs[0].links):
            mat.node_tree.nodes.active = nd

def bbox():
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    return (Vector((min(p[i] for p in pts) for i in range(3))), Vector((max(p[i] for p in pts) for i in range(3))))

def mesh_shape(meshes, lo, hi):
    """What the mesh is made of, as imported (world space, metres): triangles, connected pieces (counted on a welded copy, so UV
    seams are not gaps), floating pieces (those that touch no other: no vertex of either within longest x 0.001 of the other's
    surface; None past 500 pieces), the longest side, and where the file's origin lies in the bounding box (0..1 per axis, in
    glTF's x, up, depth)."""
    ext = hi - lo; longest = max(ext)
    bm = bmesh.new()
    for o in meshes:
        me = o.data.copy(); me.transform(o.matrix_world); bm.from_mesh(me); bpy.data.meshes.remove(me)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=longest * 1e-6)
    bm.verts.index_update(); nv = len(bm.verts)
    parent = list(range(nv))
    def find(i):
        while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for e in bm.edges:
        a, b = find(e.verts[0].index), find(e.verts[1].index)
        if a != b: parent[a] = b
    piece = [find(i) for i in range(nv)]; pieces = len(set(piece))
    floating = 0
    if pieces > 500: floating = None
    elif pieces > 1:
        # a piece touches another when one of its vertices is within `near` of the other's surface (a box set on a face
        # shares no vertex with it), so the distance is to the faces, not to the vertices
        bm.faces.ensure_lookup_table(); face_piece = [piece[f.verts[0].index] for f in bm.faces]
        tree = mathutils.bvhtree.BVHTree.FromBMesh(bm); near = longest * 0.001; touching = set()
        for v in bm.verts:
            p = piece[v.index]
            if p in touching: continue
            for _co, _no, fi, _d in tree.find_nearest_range(v.co, near):
                if face_piece[fi] != p: touching.add(p); touching.add(face_piece[fi]); break
        floating = pieces - len(touching)
    bm.free()
    at = lambda d, e: 0.5 if e <= 0 else round(d / e, 4)
    origin = [at(0 - lo.x, ext.x), at(0 - lo.z, ext.z), at(hi.y, ext.y)]   # Blender's -Y is glTF's +Z: depth runs from hi.y
    return {"triangles": tris, "pieces": pieces, "floating": floating, "longest": round(longest, 4), "origin": origin}

lo, hi = bbox(); ext0 = hi - lo
if max(ext0) <= 0: fail("the model has no size")
shape = mesh_shape(meshes, lo, hi)   # as imported; the parenting below keeps world positions, so lo and hi stay right

root = bpy.data.objects.new("root", None); sc.collection.objects.link(root)
for o in [o for o in sc.objects if o.parent is None and o is not root]:
    mw = o.matrix_world.copy(); o.parent = root; o.matrix_world = mw
bpy.context.view_layer.update()

SCALE = 10.0 / max(ext0)
# the size in glTF's frame (x, up, depth), metres, before it is scaled
size = [round(ext0.x, 4), round(ext0.z, 4), round(ext0.y, 4)]

# the orientations tried: [(up axis of the model in glTF, turn about up)]
GLTF_AXES = {"+Y": (0, 0, 1), "+Z": (0, -1, 0), "-Z": (0, 1, 0), "+X": (1, 0, 0), "-X": (-1, 0, 0), "-Y": (0, 0, -1)}  # glTF axis -> Blender vector
def orientations():
    ups = ["+Y", "+Z", "-Z", "+X", "-X", "-Y"] if cfg.get("upFix") else ["+Y"]
    out = []
    for u in ups:
        base = Vector(GLTF_AXES[u]).rotation_difference(Vector((0, 0, 1))).to_matrix().to_4x4()
        for k in range(4):
            out.append({"up": u, "turn": k * 90, "matrix": Matrix.Rotation(math.radians(k * 90), 4, 'Z') @ base})
    return out

def orient(o):
    root.matrix_basis = Matrix.Identity(4)
    root.matrix_basis = o["matrix"] @ Matrix.Scale(SCALE, 4)
    bpy.context.view_layer.update()
    lo, hi = bbox(); c = (lo + hi) / 2
    root.matrix_basis = Matrix.Translation(-c) @ root.matrix_basis
    bpy.context.view_layer.update()
    return bbox()

# ---------------------------------------------------------------- cameras and renders
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.clip_start = 0.1; cam.data.clip_end = 400
VIEWDEF = {  # camera side and the image's up, in Blender's frame (Z up, the model's front toward -Y)
    "front": ((0, -1, 0), (0, 0, 1)), "back": ((0, 1, 0), (0, 0, 1)), "left": ((1, 0, 0), (0, 0, 1)),
    "right": ((-1, 0, 0), (0, 0, 1)), "top": ((0, 0, 1), (0, -1, 0)), "bottom": ((0, 0, -1), (0, -1, 0)),
}
FRONT = Vector((0, -1, 0))   # the model's front, in Blender's frame
PLAN_DIRS = {"up": (0, 1), "right": (1, 0), "down": (0, -1), "left": (-1, 0)}   # where the front lands in the image: (right, up)
def plan_up(view, where):
    """The camera's up vector for a top or bottom view that shows the model's front toward `where` in the image."""
    d = Vector(VIEWDEF[view][0]); best = None
    for u in (Vector((0, 1, 0)), Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((-1, 0, 0))):
        fwd = -d.normalized(); right = fwd.cross(u).normalized(); up2 = right.cross(fwd)
        got = (FRONT.dot(right), FRONT.dot(up2)); err = abs(got[0] - PLAN_DIRS[where][0]) + abs(got[1] - PLAN_DIRS[where][1])
        if best is None or err < best[0]: best = (err, u)
    return best[1]

def aim(view, up=None):
    d, u = (Vector(x) for x in VIEWDEF[view]); u = up if up is not None else u; loc = d.normalized() * 80.0
    fwd = (-loc).normalized(); right = fwd.cross(u).normalized(); up2 = right.cross(fwd)
    cam.matrix_world = Matrix(((right.x, up2.x, -fwd.x, loc.x), (right.y, up2.y, -fwd.y, loc.y), (right.z, up2.z, -fwd.z, loc.z), (0, 0, 0, 1)))
    return right, up2

def setup(mode):
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'STUDIO' if mode == 'studio' else 'FLAT'
    sh.color_type = 'SINGLE' if mode == 'mask' else 'TEXTURE'
    sh.single_color = (1, 1, 1)
    sh.show_object_outline = False; sh.show_cavity = False; sh.show_shadows = False; sh.show_specular_highlight = False
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'; sc.display_settings.display_device = 'sRGB'
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'; sc.render.image_settings.color_depth = '8'

def render(view, mode, res, bounds, path=None, up=None):
    setup(mode); right, up2 = aim(view, up)
    lo, hi = bounds; ext = hi - lo
    er = sum(abs(right[i]) * ext[i] for i in range(3)); eu = sum(abs(up2[i]) * ext[i] for i in range(3))
    cam.data.ortho_scale = max(er, eu) * 1.1
    sc.render.resolution_x = sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    p = path or os.path.join(TMP, f"{mode}_{view}{'' if up is None else '_p'}.png")
    sc.render.filepath = p; bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(p); px = pixels(im, res, res); bpy.data.images.remove(im)
    return px

def save_png(arr, path):
    h, w = arr.shape[:2]; rgba = np.ones((h, w, 4), np.float32)
    rgba[:, :, :arr.shape[2]] = arr[:, :, :4] if arr.shape[2] >= 4 else arr
    im = bpy.data.images.new("out", w, h, alpha=True)
    im.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel()); im.filepath_raw = path; im.file_format = 'PNG'; im.save()
    bpy.data.images.remove(im)

def plan_choices(view):
    p = cfg.get("planUp", "auto")
    return [p] if p in PLAN_DIRS else list(PLAN_DIRS)

# ---------------------------------------------------------------- scoring one view of the model as it stands
def score_view(view, bounds, res, full=False):
    """The best of the views' choices (top and bottom: where the reference has the model's front): its scores and the model's mask.
    `full` (the final pass) places the model where it agrees best when FIT is on (place()); otherwise as normalise_pair does."""
    R = REFS[view]; best = None
    for where in (plan_choices(view) if view in PLAN else [None]):
        up = None if where is None else plan_up(view, where)
        mask_px = render(view, 'mask', res, bounds, up=up); tex_px = render(view, 'flat', res, bounds, up=up)
        mm = mask_px[:, :, 3] > 0.5
        pair = normalise_pair((mm, tex_px[:, :, :3]), (R["mask"], R["px"][:, :, :3]))
        placed = {"scale": 1, "dx": 0, "dy": 0}; width = None
        if pair is None: iou = col = 0.0; ext = rext = None
        else:
            (am, ar), (bm, br) = pair
            ca, cb = crop(mm, tex_px), crop(R["mask"], R["px"]); width = pair_width(ca, cb)
            if full and FIT: am, ar, placed = place(ca, width, bm)
            iou = float((am & bm).sum() / max(1, (am | bm).sum())); col = colour_score(am, ar, bm, br)
            ext = list(ca[0].shape[::-1]); rext = list(cb[0].shape[::-1])
        s = {"silhouette": iou, "colour": col, "combined": combined(iou, col), "planUp": where, "refExtent": rext, "modelExtent": ext, "fit": placed, "mask": mm, "width": width}
        if best is None or s["silhouette"] > best["silhouette"] + 1e-9: best = s
    return best

# ---------------------------------------------------------------- the orientation search, then the real thing
cands = orientations(); total = len(cands) * len(VIEWS) + len(VIEWS) * 2
n = 0; tried = []
for o in cands:
    bounds = orient(o); per = []
    for v in VIEWS:
        n += 1; progress(n, total, f"orientation {o['up']} turn {o['turn']}: {v}")
        per.append(score_view(v, bounds, SEARCH_RES)["combined"])
    tried.append({"up": o["up"], "turn": o["turn"], "mean": round(sum(per) / len(per), 4)})
bi = max(range(len(cands)), key=lambda i: (tried[i]["mean"], -i))
best = cands[bi]; bounds = orient(best)

res_views = {}; warnings = ref_warnings
for v in VIEWS:
    n += 1; progress(n, total, f"scoring {v}")
    s = score_view(v, bounds, FINAL_RES, full=True); mm = s.pop("mask"); width = s.pop("width"); R = REFS[v]; f = s["fit"]
    # the overlay: the reference, the model's silhouette placed as the score places it (the same width, centred, then fit's
    # scale and move; a canvas pixel is the reference's box width over `width` of its pixels)
    ref_rgb = R["px"][:, :, :3]; ref_m = R["mask"]
    H, Wd = ref_m.shape; over = np.zeros((H, Wd), bool)
    ys, xs = np.nonzero(ref_m); ms_y, ms_x = np.nonzero(mm)
    if len(xs) and len(ms_x):
        rx0, rx1, ry0, ry1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        mc = mm[ms_y.min():ms_y.max() + 1, ms_x.min():ms_x.max() + 1]; mh, mw = mc.shape
        kk = (rx1 - rx0) * f["scale"] / mw; per = (rx1 - rx0) / width; nh, nw = max(1, round(mh * kk)), max(1, round(mw * kk))
        yi = np.minimum((np.arange(nh) / kk).astype(int), mh - 1); xi = np.minimum((np.arange(nw) / kk).astype(int), mw - 1)
        sm = mc[yi][:, xi]; oy = (ry0 + ry1 - nh) // 2 + round(f["dy"] * per); ox = (rx0 + rx1 - nw) // 2 + round(f["dx"] * per)
        ya, yb, xa, xb = max(0, oy), min(H, oy + nh), max(0, ox), min(Wd, ox + nw)
        over[ya:yb, xa:xb] = sm[ya - oy:yb - oy, xa - ox:xb - ox]
    img = ref_rgb * 0.8
    img[over & ~ref_m] = img[over & ~ref_m] * 0.4 + np.array([0.2, 0.5, 1.0]) * 0.6      # the model has it, the reference does not: blue
    img[ref_m & ~over] = img[ref_m & ~over] * 0.4 + np.array([1.0, 0.25, 0.2]) * 0.6      # the reference has it, the model does not: red
    edge = over & ~erode(over, 1); img[edge] = (1.0, 0.9, 0.2)                              # the model's outline: yellow
    save_png(np.ascontiguousarray(img), os.path.join(OUT, f"overlay-{v}.png"))
    n += 1; progress(n, total, f"rendering {v}")
    render(v, 'studio', RENDER_RES, bounds, os.path.join(OUT, f"render-{v}.png"), up=None if s["planUp"] is None else plan_up(v, s["planUp"]))
    res_views[v] = {
        "silhouette": round(s["silhouette"], 4), "colour": round(s["colour"], 4), "combined": round(s["combined"], 4),
        "background": R["background"], "refSize": R["size"], "refExtent": s["refExtent"], "modelExtent": s["modelExtent"],
        "planUp": s["planUp"], "fit": f, "overlay": f"overlay-{v}.png", "render": f"render-{v}.png",
    }

def mean(key): return round(sum(res_views[v][key] for v in VIEWS) / len(VIEWS), 4)
finish({
    "ok": True, "blender": bpy.app.version_string, "views": res_views, "size": size, "shape": shape,
    "mean": {"silhouette": mean("silhouette"), "colour": mean("colour"), "combined": mean("combined")},
    "orientation": {"up": best["up"], "turn": best["turn"], "tried": tried, "searched": "all 24 orientations" if cfg.get("upFix") else "the 4 quarter-turns about up"},
    "warnings": warnings, "seconds": round(time.time() - t0, 1),
})
