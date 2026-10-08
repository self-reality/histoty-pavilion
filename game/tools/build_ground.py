"""Build the ground the map is dug into: assets/ground.glb.

    npm run ground:build

A white plane at the height of the map's highest point, several times the
map's size and lower inside it, with holes where the map is open to the sky —
and a rim: the faces that join the edge of each hole to whatever of the map
stands under it, so the level reads as streets and yards sunk into flat white
ground.

The map is only read. What comes out is a prop like any other: one GLB, placed
by an anchor in the .blend (`ground_01`), solid, so the plane can be walked on.
Its origin is the middle of the plane, which puts the anchor at the map's
centre, at the height of the ground.

Run it again whenever the map GLB or its `scale` / `euler` in
scene.manifest.mjs changes; the anchor's position is printed at the end, and
moves only if the map's bounding box did.

The .blend keeps a copy of every prop's meshes under its anchor, to look at;
the game never reads it. That copy is replaced here too, or Blender would go
on showing the ground as it was — File > Revert if the file is open. The
balls (below) are left out of it.

What is ground
--------------
Everywhere you could not stand under the sky. Looking straight down on a
point, it is OPEN if the first thing met is a surface facing up — a street, a
roof, the top of a crate. It is GROUND if nothing is met at all — beyond the
map, in a yard the map walls in but never floored, in the gap between the two
faces of a wall — or if the first thing met is the back of a ceiling, which is
a tunnel: under the ground, not in a hole in it.

Inside the map
--------------
Around the map the ground is at the height of its highest point. Inside it —
a block between streets, a walled-in yard, the ground over a tunnel — it sits
as low as it can: on the highest thing the map has under it or along its
edge. Where the walls around a block all end at that height it is a lid on
them; where some end lower, a rim comes down to those.

The ground inside is one piece with the ground around, joined past the end of
a wall or over a tunnel, so it comes down in steps: a face across the neck
where a block meets higher ground. A step is put only where it lets enough
ground sit lower to be worth it (STEP, and see settle()). A patch that stands
alone — a pillar, a tower with streets all round it — needs none.

How the holes are found
-----------------------
Seen from above, the map is a pile of overlapping triangles. Blender's
constrained Delaunay triangulation is handed all of them at once and gives
back a triangulation of their overlay, across any one triangle of which the
answer above cannot change. Each is asked, and the edges between an open one
and a ground one are the edges of the holes.

How the rim is found
--------------------
An edge of a hole lies under some edge of the map — the top of a wall, the
lip of a floor that has none, the mouth of a tunnel. Every map edge that runs
along it is collected and the highest of them at each point (their upper
envelope) is where the rim comes down to. Where the map already reaches the
ground's height there is no rim at all.

  ground_plane   the plane, facing up, each part at its height
  ground_rim     the faces between the plane's holes and the map, facing the
                 open side, and the steps, facing the lower ground

The side
--------
The plane is white; the rim and the steps show what the ground is made of —
tools/ground_side.jpg, a cake cut through. The picture is hung by height, not
by face: its top edge is at the height of the plane around the map, its
bottom edge at the lowest point any rim reaches, so a layer is at one height
all over the map and a short rim shows only the top few. Along a face it
repeats, every other time mirrored so it has no seam, at its own proportions.

The balls
---------
The white is iced: small balls in a handful of colours lie scattered over
every part of the plane, at whatever height it is, each sunk in to its middle
— so a ball is a dome, and has no underside. One is put at a random spot in
each BALL_APART square of the plane, which is what keeps them that far apart
on average without two ever lying in a heap, and left out where it would hang
over the edge of a hole or of a step. They are the same balls in the same
places every time (BALL_SEED).

There are some twenty thousand, so the file does not hold them one by one:
one dome, and for each colour a node that says where its balls lie and how
big each is (EXT_mesh_gpu_instancing), which the game draws in one go. They
are not solid — a ball is a bump under the sole (`_nocol`).

  ground_balls_<colour>_nocol   the balls of one colour

Everything is in the game's space — metres, Y-up — which is glTF's as well, so
the file is written directly rather than through Blender's exporter.
"""

import json
import os
import struct
import subprocess
import sys
from collections import defaultdict

import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pc_axes import B2PC, pc_trs_to_matrix  # noqa: E402

GAME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(GAME_DIR, 'assets', 'ground.glb')
BLEND = os.path.join(GAME_DIR, 'scene', 'pavilion.blend')

SIZE = 6.0        # the plane, as a multiple of the map's own extent on each axis
MARGIN = 4.0      # metres around the map that are triangulated finely (see plane())
WHITE = (1.0, 1.0, 1.0, 1.0)
SIDE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ground_side.jpg')

WELD = 1e-4       # metres: two map vertices closer than this are one point from above
FLAT = 1e-6       # square metres: a triangle smaller than this from above is a wall
ON_LINE = 2e-3    # metres: how far off an edge of the hole a map edge may run and still be "along" it
TINY = 1e-5       # metres: shortest stretch of rim worth a face
THIN = 0.02       # metres: a patch narrower than this is a crack between triangles, not a place
STEP = 12.0       # square metres of ground a metre of step must let down to be worth having (see settle)
SAME_HEIGHT = 1e-3  # metres: two surfaces this close in height are one, seen from above

BALL = 0.037      # metres: a ball's radius — a baseball is 74 mm across
BALL_VARIES = 0.2  # a ball is bigger or smaller than that by up to this much of it
BALL_APART = 5.0  # metres between one ball and the next, on average
BALL_SEED = 1     # another number, another scattering
BALL_ROUND = (10, 3)  # the dome: how many sides around, how many rings up
COLOURS = (('red', 0xE5383B), ('orange', 0xFF8A1F), ('yellow', 0xFFD23F), ('green', 0x3DCB6C),
           ('blue', 0x2E9BFF), ('violet', 0x9B5DE5), ('pink', 0xFF6FB5))


def script_args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def read_manifest():
    """Run the node bridge so scene.manifest.mjs stays the single source."""
    out = subprocess.run(['node', os.path.join('tools', 'dump_manifest.mjs')],
                         cwd=GAME_DIR, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f'reading scene.manifest.mjs failed:\n{out.stderr.strip()}')
    return json.loads(out.stdout)


def map_triangles(map_cfg):
    """Every triangle of the map where the game puts it: (n, 3, 3), metres, Y-up."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(GAME_DIR, map_cfg['glb']))
    # The importer turned the payload by Rx(+90); B2PC takes that back off, and
    # then the map entity's own transform goes on, as in src/main.mjs.
    entity = pc_trs_to_matrix((0, 0, 0), map_cfg.get('euler'), [map_cfg['scale']] * 3) @ B2PC
    out = []
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        world = np.array(entity @ obj.matrix_world)
        co = np.empty(len(mesh.vertices) * 3)
        mesh.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3) @ world[:3, :3].T + world[:3, 3]
        idx = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
        mesh.loop_triangles.foreach_get('vertices', idx)
        out.append(co[idx.reshape(-1, 3)])
    return np.concatenate(out)


def cdt(points, edges, faces):
    """Triangulate the convex hull; returns (points, faces, edge ids, face ids)."""
    verts, _edges, tris, _ov, orig_edges, orig_faces = delaunay_2d_cdt(
        [Vector(p) for p in points], edges, faces, 0, WELD, True)
    return np.array([tuple(v) for v in verts]), tris, _edges, orig_edges, orig_faces


def edge_map(tris):
    """Which triangles lie on either side of each edge."""
    across = defaultdict(list)
    for f, tri in enumerate(tris):
        for i in range(3):
            across[frozenset((tri[i], tri[(i + 1) % 3]))].append(f)
    return across


def rect(lo, hi):
    return [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]


def hole_edges(tris3, inner):
    """The edges of the holes: [(a, b, toward)] in (x, z), each with ground on
    one side and open map on the other; `toward` is a point on the map's side.
    Also the area that is ground inside `inner`, for main() to check against,
    the map's faces as open_to_sky() wants them, for plane() to ask again, and
    the map's height wherever it is under the ground, as (spots in (x, z),
    heights), for needs()."""
    xz = tris3[:, :, [0, 2]]
    area = ((xz[:, 1, 0] - xz[:, 0, 0]) * (xz[:, 2, 1] - xz[:, 0, 1])
            - (xz[:, 1, 1] - xz[:, 0, 1]) * (xz[:, 2, 0] - xz[:, 0, 0])) / 2
    seen_from_above = np.abs(area) > FLAT

    index, points, faces, kept = {}, [], [], []

    def vid(p):
        key = (round(p[0] / WELD), round(p[1] / WELD))
        if key not in index:
            index[key] = len(points)
            points.append((float(p[0]), float(p[1])))
        return index[key]

    for n in np.nonzero(seen_from_above)[0]:
        ids = [vid(p) for p in xz[n]]
        if len(set(ids)) == 3:
            faces.append(ids if area[n] > 0 else ids[::-1])
            kept.append(n)
    corners = [vid(p) for p in inner]
    frame = [(corners[i], corners[(i + 1) % 4]) for i in range(4)]

    pts, tris, _e, _oe, _of = cdt(points, frame, faces)
    # With Y up, a triangle whose (x, z) footprint winds negative faces the sky.
    is_open, under = open_to_sky(pts, tris, tris3[kept], area[kept] < 0)
    across = edge_map(tris)
    heal_cracks(pts, tris, across, is_open)

    edges = []
    for key, fs in across.items():
        if len(fs) != 2 or (fs[0] in is_open) == (fs[1] in is_open):
            continue
        a, b = (pts[i] for i in key)
        m = fs[0] if fs[0] in is_open else fs[1]
        edges.append((a, b, pts[list(tris[m])].mean(axis=0)))
    solid = [f for f in range(len(tris)) if f not in is_open]
    ground = sum(tri_area(pts[list(tris[f])]) for f in solid)

    # Where the map is under the ground, how high it gets: each such triangle
    # speaks through its middle and three spots just inside its corners, so
    # one that lies across two triangles of the plane is counted in both.
    roofed = [f for f in solid if under[f] > -np.inf]
    corners = pts[np.array([tris[f] for f in roofed], dtype=int).reshape(-1, 3)]
    mids = corners.mean(axis=1, keepdims=True)
    spots = np.concatenate([mids, mids + (corners - mids) * 0.98], axis=1).reshape(-1, 2)
    return edges, ground, (tris3[kept], area[kept] < 0), (spots, np.repeat(under[roofed], 4))


def heal_cracks(pts, tris, across, is_open):
    """Give a patch too narrow to be anything to whatever surrounds it.

    Two floor triangles that should share an edge and miss by a hundredth of a
    millimetre leave a crack metres long between them: nothing of the map is
    there, so it is ground, and it would get a rim ten metres tall on both
    sides. A patch — of ground or of open map — whose area over half its
    outline is under THIN changes sides. Updates `is_open` in place."""
    group = list(range(len(tris)))

    def find(f):
        while group[f] != f:
            group[f] = group[group[f]]
            f = group[f]
        return f

    borders = []
    for key, fs in across.items():
        if len(fs) == 2 and (fs[0] in is_open) == (fs[1] in is_open):
            group[find(fs[0])] = find(fs[1])
        else:
            borders.append((key, fs))
    size, outline = defaultdict(float), defaultdict(float)
    for f, tri in enumerate(tris):
        size[find(f)] += tri_area(pts[list(tri)])
    for key, fs in borders:
        a, b = (pts[i] for i in key)
        for f in fs:
            outline[find(f)] += float(np.hypot(*(b - a)))
    for f in range(len(tris)):
        g = find(f)
        if outline[g] and size[g] / (outline[g] / 2) < THIN:
            is_open.symmetric_difference_update({f})


def open_to_sky(pts, tris, faces3, faces_up):
    """Which triangles of the overlay are open map: looking straight down on
    them, the first thing met is a surface that faces up — a floor, a roof.

    Everything else is ground. Nothing there at all (beyond the map, or the
    gap between the two faces of a wall), or the first thing met is the back
    of a ceiling: a tunnel, which is under the ground rather than in a hole.

    The triangulation offers part of this itself (which input faces an output
    face came from), but that answer assumes faces that do not overlap, and
    seen from above a level is nothing but overlap: it came back "all of
    them". So each output triangle's middle is tested against every footprint
    instead — the overlay's triangles never straddle a footprint's edge, so
    the middle speaks for the whole triangle.

    Returns the open triangles, and for every triangle the highest the map
    gets over it (-inf where there is none)."""
    a, b, c = faces3[:, 0], faces3[:, 1], faces3[:, 2]
    v0, v1 = (b - a)[:, [0, 2]], (c - a)[:, [0, 2]]
    den = v0[:, 0] * v1[:, 1] - v0[:, 1] * v1[:, 0]
    corners = pts[np.array(tris)]
    mids = corners.mean(axis=1)
    found, under = set(), np.full(len(mids), -np.inf)

    def height_at(q):
        p = q[:, None, :] - a[None][..., [0, 2]]
        u = (p[..., 0] * v1[:, 1] - p[..., 1] * v1[:, 0]) / den
        v = (v0[:, 0] * p[..., 1] - v0[:, 1] * p[..., 0]) / den
        return (u >= 0) & (v >= 0) & (u + v <= 1), a[:, 1] + u * (b - a)[:, 1] + v * (c - a)[:, 1]

    for start in range(0, len(mids), 512):
        chunk = slice(start, start + 512)
        inside, y = height_at(mids[chunk])
        y = np.where(inside, y, -np.inf)
        highest = y.max(axis=1, keepdims=True)
        # A sheet modelled as two faces back to back is open: up wins a tie.
        up = (inside & faces_up[None] & (y >= highest - SAME_HEIGHT)).any(axis=1)
        found.update(start + int(i) for i in np.nonzero(up)[0])
        # How high the map gets over the whole triangle, not just its middle:
        # the faces over the middle are over all of it, so their heights at
        # its three corners bound them.
        for k in range(3):
            at_corner = np.where(inside, height_at(corners[chunk, k])[1], -np.inf)
            under[chunk] = np.maximum(under[chunk], at_corner.max(axis=1))
    return found, under


def tri_area(p):
    return abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])) / 2


def envelope(a, b, ends_a, ends_b, top):
    """The map's height along the hole's edge a -> b: [(s, y_s, e, y_e)] with s
    and e in metres from `a`, covering the whole edge, highest geometry wins."""
    length = float(np.hypot(*(b - a)))
    d = (b - a) / length
    ra, rb = ends_a[:, [0, 2]] - a, ends_b[:, [0, 2]] - a
    ta, tb = ra @ d, rb @ d
    off_a = np.abs(d[0] * ra[:, 1] - d[1] * ra[:, 0])
    off_b = np.abs(d[0] * rb[:, 1] - d[1] * rb[:, 0])
    along = ((off_a < ON_LINE) & (off_b < ON_LINE) & (np.abs(tb - ta) > TINY)
             & (np.maximum(ta, tb) > TINY) & (np.minimum(ta, tb) < length - TINY))
    segs = []
    for t0, y0, t1, y1 in zip(ta[along], ends_a[along, 1], tb[along], ends_b[along, 1]):
        if t0 > t1:
            t0, y0, t1, y1 = t1, y1, t0, y0
        slope = (y1 - y0) / (t1 - t0)
        s, e = max(t0, 0.0), min(t1, length)
        segs.append((s, y0 + slope * (s - t0), e, y0 + slope * (e - t0), slope))

    cuts = {0.0, length}
    for s, _ys, e, _ye, _k in segs:
        cuts.update((s, e))
    for i, (s0, y0, e0, _y, k0) in enumerate(segs):
        for s1, y1, e1, _y, k1 in segs[i + 1:]:
            if abs(k0 - k1) < 1e-9:
                continue
            t = (y1 - k1 * s1 - y0 + k0 * s0) / (k0 - k1)
            if max(s0, s1) + TINY < t < min(e0, e1) - TINY:
                cuts.add(t)
    cuts = sorted(cuts)
    stops = [cuts[0]]
    for t in cuts[1:]:
        if t - stops[-1] > TINY:
            stops.append(t)
    stops[-1] = length

    pieces, missing = [], 0.0
    for s, e in zip(stops, stops[1:]):
        mid = (s + e) / 2
        best = None
        for s0, y0, e0, _y, k in segs:
            if s0 - TINY <= mid <= e0 + TINY:
                y = y0 + k * (mid - s0)
                if best is None or y > best[0]:
                    best = (y, y0 + k * (s - s0), y0 + k * (e - s0))
        if best is None:
            missing += e - s
            pieces.append([s, None, e, None])
        else:
            pieces.append([s, min(best[1], top), e, min(best[2], top)])
    # A stretch no map edge runs along takes its neighbours' height.
    for i, piece in enumerate(pieces):
        if piece[1] is None:
            near = [p for p in pieces[:i][::-1] + pieces[i + 1:] if p[1] is not None]
            piece[1] = piece[3] = near[0][3] if near else top
    return [tuple(p) for p in pieces], missing


def rim_pieces(edges, tris3, top):
    """Each edge of a hole, cut where the map's height along it changes:
    [(a, b, y_a, y_b, toward)] with a, b in (x, z)."""
    ends_a = tris3.reshape(-1, 3)
    ends_b = tris3[:, [1, 2, 0]].reshape(-1, 3)
    out, missing = [], 0.0
    for a, b, toward in edges:
        length = float(np.hypot(*(b - a)))
        d = (b - a) / length
        pieces, lost = envelope(a, b, ends_a, ends_b, top)
        missing += lost
        for s, ys, e, ye in pieces:
            out.append((a + d * s, a + d * e, ys, ye, toward))
    return merge_straight(out), missing


def merge_straight(pieces):
    """Join consecutive pieces that are one straight stretch of rim, so a wall
    the map built from twenty triangles is not twenty faces here."""
    def key(p):
        return (round(p[0] / TINY), round(p[1] / TINY))

    # Chain by endpoints, either way round: a piece's own direction is whatever
    # the triangulation happened to give its edge.
    at = defaultdict(list)
    for i, (a, b, *_rest) in enumerate(pieces):
        at[key(a)].append(i)
        at[key(b)].append(i)

    def straight(i, j, k):
        """Pieces i and j meet at point-key k: one line, in plan and in height?"""
        def outward(n):   # the piece as (far end, far y, near y, length), seen from k
            a, b, ya, yb = pieces[n][:4]
            return (b, yb, ya, a) if key(a) == k else (a, ya, yb, b)
        fi, fyi, nyi, here = outward(i)
        fj, fyj, nyj, _h = outward(j)
        if abs(nyi - nyj) > TINY:
            return False
        u, v = fi - here, fj - here
        lu, lv = float(np.hypot(*u)), float(np.hypot(*v))
        if abs(u[0] * v[1] - u[1] * v[0]) > 1e-6 * lu * lv or u @ v > 0:
            return False
        return abs((fyi - nyi) / lu + (fyj - nyj) / lv) < 1e-6

    used, out = set(), []
    for start in range(len(pieces)):
        if start in used:
            continue
        used.add(start)
        a, b, ya, yb, toward = pieces[start]
        ends = [[a, ya, start], [b, yb, start]]
        for end in ends:
            while True:
                k = key(end[0])
                here = at[k]
                if len(here) != 2:
                    break
                nxt = here[0] if here[1] == end[2] else here[1]
                if nxt in used or not straight(end[2], nxt, k):
                    break
                used.add(nxt)
                na, nb, nya, nyb = pieces[nxt][:4]
                end[0], end[1], end[2] = (nb, nyb, nxt) if key(na) == k else (na, nya, nxt)
        out.append((ends[0][0], ends[1][0], ends[0][1], ends[1][1], toward))
    return out


def plane(pieces, inner, sky):
    """The ground in and around the map, out to `inner`, triangulated between
    the holes: (points in (x, z), triangles, which triangles lie on either
    side of each edge, rim, the triangles that reach `inner`).

    The rim is the pieces again as the triangulation left them — cut where it
    put a point on one — each with the triangle of ground beside it:
    [(a, b, y_a, y_b, toward, triangle)]."""
    index, points, edges = {}, [], []

    def vid(p):
        key = (round(p[0] / TINY), round(p[1] / TINY))
        if key not in index:
            index[key] = len(points)
            points.append((float(p[0]), float(p[1])))
        return index[key]

    for a, b, *_rest in pieces:
        edges.append((vid(a), vid(b)))
    corners = [vid(p) for p in inner]
    edges += [(corners[i], corners[(i + 1) % 4]) for i in range(4)]

    pts, tris, out_edges, orig_edges, _of = cdt(points, edges, [])
    # Which side of the rim each triangle is on is asked of the map again, not
    # walked across the rim's edges: where two of the map's vertices sit a
    # hair apart the rim has a gap that size, and a walk would leak through it
    # and turn everything beyond inside out.
    is_open = open_to_sky(pts, tris, *sky)[0]
    tris = [list(tri) for f, tri in enumerate(tris) if f not in is_open]
    across = edge_map(tris)

    rim = []
    for i, src in enumerate(orig_edges):
        fs = across.get(frozenset(out_edges[i]), ())
        p, q = pts[out_edges[i][0]], pts[out_edges[i][1]]
        for n in src:
            if n >= len(pieces):
                continue
            a, b, ya, yb, toward = pieces[n]
            length = float(np.hypot(*(b - a)))
            s, e = float(np.hypot(*(p - a))) / length, float(np.hypot(*(q - a))) / length
            for f in fs:
                rim.append((p, q, ya + (yb - ya) * s, ya + (yb - ya) * e, toward, f))
    frame = {int(np.argmin(np.hypot(pts[:, 0] - p[0], pts[:, 1] - p[1]))) for p in inner}
    return pts, tris, across, rim, [f for f, tri in enumerate(tris) if frame & set(tri)]


def needs(pts, tris, rim, below, tris3):
    """How high the ground over each triangle has to be for nothing of the map
    to poke through it: the tops of the walls along its edge, a wall standing
    in it, the back of a ceiling under it. -inf where there is none of that."""
    need = np.full(len(tris), -np.inf)
    for _a, _b, ya, yb, _toward, f in rim:
        need[f] = max(need[f], ya, yb)

    # A wall that stands on a corner of the ground is the end of the rim on
    # both sides of it, which has measured it — and may be the taller
    # neighbour's, where a step begins.
    verts = np.unique(tris3.reshape(-1, 3), axis=0)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    verts = verts[(verts[:, [0, 2]] >= lo).all(axis=1) & (verts[:, [0, 2]] <= hi).all(axis=1)]
    apart = np.full(len(verts), np.inf)
    for start in range(0, len(pts), 256):
        d = verts[:, None, [0, 2]] - pts[None, start:start + 256]
        apart = np.minimum(apart, np.hypot(d[..., 0], d[..., 1]).min(axis=1))
    verts = verts[apart > ON_LINE]

    spots, heights = below
    for f, tri in enumerate(tris):
        a, b, c = pts[tri]
        v0, v1 = b - a, c - a
        den = v0[0] * v1[1] - v0[1] * v1[0]
        # Loosely for a wall: one standing on the triangle's edge counts as in it.
        for q, y, slack in ((verts[:, [0, 2]], verts[:, 1], ON_LINE / max(np.sqrt(abs(den)), TINY)),
                            (spots, heights, 0.0)):
            p = q - a
            u = (p[:, 0] * v1[1] - p[:, 1] * v1[0]) / den
            v = (v0[0] * p[:, 1] - v0[1] * p[:, 0]) / den
            inside = (u >= -slack) & (v >= -slack) & (u + v <= 1 + slack)
            if inside.any():
                need[f] = max(need[f], float(y[inside].max()))
    return need


def settle(pts, tris, across, need, outside, top):
    """How high the ground is over each triangle: as low as it can be.

    Around the map (`outside`, the triangles that reach the frame) it is at `top`.
    Inside, nowhere lower than it needs to be — but the ground inside the map
    is one piece with the ground around it, a block between streets reaching
    the outside past the end of a wall or over a tunnel, and what one corner
    needs is not what the next does. So it comes down in steps, and a step
    has to earn its place: of all the ways to hold the ground up where it
    must be held, the one taken is the least of

        ground that is higher than it need be, m3  +  STEP x faces of steps, m2

    which leaves a block between streets sitting on its own walls, with a
    step across the neck that joins it to higher ground, and does not dig a
    pit over a tunnel or raise a kerb along one tall wall of a wide yard.
    A patch that touches nothing — a pillar, a tower with streets all round
    it — has nowhere to put a step, and is a lid at the height of its
    highest wall.

    Each height the map asks for is taken in turn, lowest first: which
    triangles are at least that high is a question with two answers for each,
    and the best set of answers is a minimum cut."""
    need = np.minimum(need, top)
    need[list(outside)] = top
    # Heights a hair apart are one height, or the ground would step by it.
    heights = []
    for y in sorted(set(need[need > -np.inf])):
        if heights and y - heights[-1] < SAME_HEIGHT:
            need[need == heights[-1]] = y
            heights[-1] = y
        else:
            heights.append(y)

    area = [tri_area(pts[tri]) for tri in tris]
    doors = []
    for key, fs in across.items():
        if len(fs) == 2:
            a, b = (pts[i] for i in key)
            doors.append((fs[0], fs[1], STEP * float(np.hypot(*(b - a)))))
    level = np.full(len(tris), heights[0])
    for y in heights[1:]:
        level[min_cut(len(tris), np.nonzero(need >= y)[0], area, doors)] = y
    return level


def min_cut(n, held, weight, links):
    """The cheapest set that contains `held`, where having i in the set costs
    weight[i] and having only one of a and b costs c for each (a, b, c) in
    `links` — and the smallest such, if there are several. Dinic's algorithm:
    the set is what is still joined to the source when no more will flow."""
    src, sink = n, n + 1
    head, to, cap = [[] for _ in range(n + 2)], [], []

    def link(a, b, there, back):
        head[a].append(len(to))
        to.append(b)
        cap.append(there)
        head[b].append(len(to))
        to.append(a)
        cap.append(back)

    for i in held:
        link(src, int(i), np.inf, 0.0)
    for i in range(n):
        link(i, sink, weight[i], 0.0)
    for a, b, c in links:
        link(a, b, c, c)

    while True:
        depth = [-1] * (n + 2)
        depth[src] = 0
        queue = [src]
        for a in queue:
            for e in head[a]:
                if cap[e] > 1e-9 and depth[to[e]] < 0:
                    depth[to[e]] = depth[a] + 1
                    queue.append(to[e])
        if depth[sink] < 0:
            return [i for i in range(n) if depth[i] >= 0]
        nxt = [0] * (n + 2)

        def push(a, flow):
            if a == sink:
                return flow
            while nxt[a] < len(head[a]):
                e = head[a][nxt[a]]
                if cap[e] > 1e-9 and depth[to[e]] == depth[a] + 1:
                    got = push(to[e], min(flow, cap[e]))
                    if got > 1e-9:
                        cap[e] -= got
                        cap[e ^ 1] += got
                        return got
                nxt[a] += 1
            return 0.0

        while push(src, np.inf) > 1e-9:
            pass


def patches(tris, across, level):
    """The ground as pieces at one height each: which piece each triangle is in."""
    group = list(range(len(tris)))

    def find(f):
        while group[f] != f:
            group[f] = group[group[f]]
            f = group[f]
        return f

    for fs in across.values():
        if len(fs) == 2 and abs(level[fs[0]] - level[fs[1]]) < TINY:
            group[find(fs[0])] = find(fs[1])
    return [find(f) for f in range(len(tris))]


def steps(pts, tris, across, level):
    """Where ground at two heights meets: a face from the higher down to the
    lower, as rim_mesh() wants it."""
    out = []
    for key, fs in across.items():
        if len(fs) != 2 or abs(level[fs[0]] - level[fs[1]]) < TINY:
            continue
        low, high = sorted(fs, key=lambda f: level[f])
        a, b = (pts[i] for i in key)
        out.append((a, b, level[low], level[low], pts[tris[low]].mean(axis=0), level[high]))
    return out


def skirt(pts, tris, inner, outer):
    """The plane from `inner` out to its full size: the points with four
    more, and eight big triangles.

    Two rectangles rather than one because the triangulation fans the hole's
    edge out to whatever frame it is given, and a fan of slivers each 300 m
    long is filed under every cell of the collider's grid (src/collision.mjs)."""
    # The inner rectangle's corners are looked up in what the triangulation
    # returned, which may have reordered its input.
    def find(p):
        return int(np.argmin(np.hypot(pts[:, 0] - p[0], pts[:, 1] - p[1])))
    ring_in = [find(p) for p in inner]
    ring_out = [len(pts) + i for i in range(4)]
    out = []
    for i in range(4):
        j = (i + 1) % 4
        out.append([ring_in[i], ring_in[j], ring_out[j]])
        out.append([ring_in[i], ring_out[j], ring_out[i]])
    return np.vstack([pts, outer]), out


def heights(pts, tris, level, q):
    """The height of the plane at each of `q` in (x, z); nan where it has a hole."""
    out = np.full(len(q), np.nan)
    for tri, y in zip(tris, level):
        a, b, c = pts[tri]
        v0, v1 = b - a, c - a
        den = v0[0] * v1[1] - v0[1] * v1[0]
        near = np.nonzero(((q >= np.minimum(np.minimum(a, b), c))
                           & (q <= np.maximum(np.maximum(a, b), c))).all(axis=1))[0]
        if abs(den) < 1e-12 or not len(near):
            continue
        p = q[near] - a
        u = (p[:, 0] * v1[1] - p[:, 1] * v1[0]) / den
        v = (v0[0] * p[:, 1] - v0[1] * p[:, 0]) / den
        out[near[(u >= 0) & (v >= 0) & (u + v <= 1)]] = y
    return out


def scatter(pts, tris, level, outer):
    """The balls: (where in (x, z), the height of the plane there, radius,
    which of COLOURS), one at a random spot in each BALL_APART square of the
    plane — unless that spot is a hole, or so near the edge of one, or of a
    step, that the ball would hang over it."""
    rng = np.random.default_rng(BALL_SEED)
    lo, hi = np.array(outer[0]), np.array(outer[2])
    nx, nz = np.ceil((hi - lo) / BALL_APART).astype(int)
    cells = np.stack(np.meshgrid(np.arange(nx), np.arange(nz), indexing='ij'), axis=-1).reshape(-1, 2)
    at = lo + (cells + rng.random(cells.shape)) * BALL_APART
    radius = BALL * (1 + BALL_VARIES * rng.uniform(-1, 1, len(at)))
    colour = rng.integers(len(COLOURS), size=len(at))
    y = heights(pts, tris, level, at)
    keep = ~np.isnan(y)
    for turn in np.arange(8) * np.pi / 4:
        keep &= heights(pts, tris, level, at + radius[:, None] * (np.cos(turn), np.sin(turn))) == y
    return at[keep], y[keep], radius[keep], colour[keep]


def dome():
    """The half of a ball that shows, a metre in radius, its middle at the
    origin: (positions, normals, triangles)."""
    around, up = BALL_ROUND
    pos = [(np.cos(rise) * np.cos(turn), np.sin(rise), np.cos(rise) * np.sin(turn))
           for rise in np.arange(up) * np.pi / 2 / up
           for turn in np.arange(around) * 2 * np.pi / around] + [(0.0, 1.0, 0.0)]
    idx = []
    for r in range(up):
        for i in range(around):
            a, b = r * around + i, r * around + (i + 1) % around
            if r == up - 1:
                idx.append((a, len(pos) - 1, b))
            else:
                idx += [(a, a + around, b + around), (a, b + around, b)]
    return np.array(pos), np.array(pos), np.array(idx)


def linear(rgb):
    """0xRRGGBB as it looks on a screen -> the factors a material wants."""
    c = np.array([rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255]) / 255
    return [float(v) for v in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)] + [1.0]


def plane_mesh(pts, tris, level, origin):
    """Face-up triangles, each at its own height. Ground at two heights gets
    a vertex for each where they touch."""
    index, pos, idx = {}, [], []

    def vid(i, y):
        if (i, y) not in index:
            index[(i, y)] = len(pos)
            pos.append((pts[i][0] - origin[0], y - origin[1], pts[i][1] - origin[2]))
        return index[(i, y)]

    for (a, b, c), y in zip(tris, level):
        pa, pb, pc = pts[a], pts[b], pts[c]
        up = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1])
        a, b, c = vid(a, y), vid(b, y), vid(c, y)
        idx.append((a, b, c) if up > 0 else (a, c, b))
    return np.array(pos), np.tile((0.0, 1.0, 0.0), (len(pos), 1)), np.array(idx)


def rim_mesh(faces, origin, top, bottom, aspect):
    """One flat face per stretch, [(a, b, y_a, y_b, toward, top)]: from the
    ground at `top` down to y_a .. y_b, facing `toward`.

    The picture on them runs from `top` to `bottom` whatever the face's own
    height, and along the face by where the face is in the map, so two faces
    in one line carry on from each other. `aspect` is its width over its
    height."""
    pos, nrm, uvs, idx = [], [], [], []
    span = top - bottom
    for a, b, ya, yb, toward, top_here in faces:
        if top_here - ya < TINY and top_here - yb < TINY:
            continue      # the map comes all the way up here
        d = b - a
        n = np.array([-d[1], d[0]])
        if n @ (toward - a) < 0:
            n = -n
        n = n / np.hypot(*n)
        normal = (n[0], 0.0, n[1])
        quad = [(a[0], top_here, a[1]), (b[0], top_here, b[1]), (b[0], yb, b[1]), (a[0], ya, a[1])]
        if top_here - yb < TINY:
            quad.pop(2)
        elif top_here - ya < TINY:
            quad.pop(3)
        q = np.array(quad)
        along = d / np.hypot(*d)
        uv = np.stack([(q[:, [0, 2]] @ along) / (span * aspect), (top - q[:, 1]) / span], axis=1)
        q = q - origin
        if np.cross(q[1] - q[0], q[2] - q[0]) @ normal < 0:
            q, uv = q[::-1], uv[::-1]
        base = len(pos)
        pos.extend(q)
        nrm.extend([normal] * len(q))
        uvs.extend(uv)
        idx.extend((base, base + i, base + i + 1) for i in range(1, len(q) - 1))
    return np.array(pos), np.array(nrm), np.array(idx), np.array(uvs)


def lowest(faces):
    """The lowest point any face of the rim reaches."""
    return min(min(ya, yb) for _a, _b, ya, yb, _toward, top_here in faces
               if top_here - min(ya, yb) >= TINY)


def jpeg_size(data):
    """(width, height) of a JPEG, from its frame header."""
    at = 2
    while at < len(data):
        marker, length = data[at + 1], struct.unpack('>H', data[at + 2:at + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack('>HH', data[at + 5:at + 9])
            return width, height
        at += 2 + length
    raise SystemExit(f'[ground] {os.path.relpath(SIDE, GAME_DIR)} is not a JPEG')


def write_glb(path, meshes, side, ball, balls):
    """A root node, one child per mesh. `meshes` is [(name, positions,
    normals, triangles)], white, or with a fifth, texture coordinates, in
    which case it wears `side`, the bytes of a JPEG.

    Then one child per entry of `balls`, [(name, colour, where, sizes)]: the
    mesh `ball`, (positions, normals, triangles), in that colour, once at each
    of `where` and as big as `sizes` says."""
    blob, views, accessors = bytearray(), [], []

    def accessor(data, kind, component, target, bounds=False):
        while len(blob) % 4:
            blob.append(0)
        raw = data.tobytes()
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(raw)})
        if target:      # none for what is said of a whole ball rather than of a vertex
            views[-1]['target'] = target
        blob.extend(raw)
        acc = {'bufferView': len(views) - 1, 'componentType': component,
               'count': int(data.size if kind == 'SCALAR' else len(data)), 'type': kind}
        if bounds:
            acc['min'] = [float(v) for v in data.min(axis=0)]
            acc['max'] = [float(v) for v in data.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    nodes = [{'name': 'ground', 'children': list(range(1, len(meshes) + 1))}]
    gl_meshes = []
    for name, pos, nrm, tris, *uv in meshes:
        prim = {
            'attributes': {
                'POSITION': accessor(pos.astype('<f4'), 'VEC3', 5126, 34962, bounds=True),
                'NORMAL': accessor(nrm.astype('<f4'), 'VEC3', 5126, 34962),
            },
            'indices': accessor(tris.astype('<u4').reshape(-1), 'SCALAR', 5125, 34963),
            'material': len(uv),
        }
        if uv:
            prim['attributes']['TEXCOORD_0'] = accessor(uv[0].astype('<f4'), 'VEC2', 5126, 34962)
        nodes.append({'name': name, 'mesh': len(gl_meshes)})
        gl_meshes.append({'name': name, 'primitives': [prim]})

    materials = [
        {'name': 'ground_white', 'pbrMetallicRoughness': {
            'baseColorFactor': list(WHITE), 'metallicFactor': 0.0, 'roughnessFactor': 1.0}},
        {'name': 'ground_side', 'pbrMetallicRoughness': {
            'baseColorTexture': {'index': 0}, 'metallicFactor': 0.0, 'roughnessFactor': 1.0}},
    ]
    pos, nrm, tris = ball
    shape = {'attributes': {'POSITION': accessor(pos.astype('<f4'), 'VEC3', 5126, 34962, bounds=True),
                            'NORMAL': accessor(nrm.astype('<f4'), 'VEC3', 5126, 34962)},
             'indices': accessor(tris.astype('<u4').reshape(-1), 'SCALAR', 5125, 34963)}
    for name, colour, where, sizes in balls:
        nodes[0]['children'].append(len(nodes))
        nodes.append({'name': name, 'mesh': len(gl_meshes), 'extensions': {'EXT_mesh_gpu_instancing': {
            'attributes': {'TRANSLATION': accessor(where.astype('<f4'), 'VEC3', 5126, None),
                           'SCALE': accessor(sizes.astype('<f4'), 'VEC3', 5126, None)}}}})
        gl_meshes.append({'name': name, 'primitives': [dict(shape, material=len(materials))]})
        materials.append({'name': name.removesuffix('_nocol'), 'pbrMetallicRoughness': {
            'baseColorFactor': colour, 'metallicFactor': 0.0, 'roughnessFactor': 0.5}})

    gltf = {
        'asset': {'version': '2.0', 'generator': 'tools/build_ground.py'},
        'scene': 0,
        'scenes': [{'name': 'ground', 'nodes': [0]}],
        'nodes': nodes,
        'meshes': gl_meshes,
        'extensionsUsed': ['EXT_mesh_gpu_instancing'],
        'materials': materials,
        'textures': [{'sampler': 0, 'source': 0}],
        # Mirrored along the face, so the picture meets itself; held at its
        # edge up and down, where it is hung to fit.
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33648, 'wrapT': 33071}],
        'images': [{'name': 'ground_side', 'mimeType': 'image/jpeg', 'bufferView': len(views)}],
        'accessors': accessors,
        'bufferViews': views,
    }
    while len(blob) % 4:
        blob.append(0)
    views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(side)})
    blob.extend(side)
    gltf['buffers'] = [{'byteLength': len(blob) + (-len(blob) % 4)}]
    text = json.dumps(gltf, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    blob += b'\0' * (-len(blob) % 4)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(blob)))
        fh.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
        fh.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def refresh_blend(glb):
    """Swap the meshes under the ground's anchor in the .blend for the ones
    just written. Only the look of the file changes: the anchor is not moved,
    and it is the anchor that is exported."""
    if not os.path.exists(BLEND):
        return None
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    ref = './' + os.path.relpath(glb, GAME_DIR).replace(os.sep, '/')
    anchors = [o for o in bpy.data.objects if o.get('glb') == ref]
    if not anchors:
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=glb)
    fresh = [o for o in bpy.data.objects if o not in before]
    # Not the balls: the importer makes an object of every one, and twenty
    # thousand objects are a file nobody can work in.
    balls = [o for o in fresh if o.name.startswith('ground_balls_')]
    shapes = {o.data for o in balls if o.data is not None}
    fresh = [o for o in fresh if o not in balls]
    bpy.data.batch_remove(balls)
    bpy.data.batch_remove([m for m in shapes if m.users == 0])
    for anchor in anchors[1:] + anchors[:1]:      # the last one takes the import itself
        old = [o for o in anchor.children_recursive if o not in fresh]
        names = {o.name: o for o in old}
        mine = fresh if anchor is anchors[0] else [o.copy() for o in fresh]
        twin = dict(zip(fresh, mine))
        for src, obj in twin.items():
            for coll in list(obj.users_collection):
                coll.objects.unlink(obj)
            for coll in anchor.users_collection:
                coll.objects.link(obj)
            obj.parent = twin.get(src.parent, anchor)
            if src.parent is None:
                obj.matrix_parent_inverse.identity()
            was = names.get(src.name.rsplit('.', 1)[0])
            obj.hide_select = True
            if was is not None:
                obj.hide_viewport, obj.hide_render = was.hide_viewport, was.hide_render
        for obj in old:
            name = obj.name
            data = obj.data
            bpy.data.objects.remove(obj)
            if data is not None and data.users == 0:
                bpy.data.meshes.remove(data)
            for src, new in twin.items():
                if src.name.rsplit('.', 1)[0] == name and new.name != name:
                    new.name = name
    bpy.ops.wm.save_mainfile()
    return [a.name for a in anchors]


def main():
    args = script_args()
    out_path = os.path.abspath(args[args.index('--out') + 1]) if '--out' in args else OUT

    tris3 = map_triangles(read_manifest()['map'])
    lo, hi = tris3.reshape(-1, 3).min(axis=0), tris3.reshape(-1, 3).max(axis=0)
    top = float(hi[1])
    centre = (lo + hi) / 2
    half = (hi - lo) / 2
    origin = np.array([centre[0], top, centre[2]])

    inner = rect((lo[0] - MARGIN, lo[2] - MARGIN), (hi[0] + MARGIN, hi[2] + MARGIN))
    outer = rect((centre[0] - half[0] * SIZE, centre[2] - half[2] * SIZE),
                 (centre[0] + half[0] * SIZE, centre[2] + half[2] * SIZE))

    edges, ground, sky, below = hole_edges(tris3, inner)
    pieces, missing = rim_pieces(edges, tris3, top)
    pts, tris, across, rim, outside = plane(pieces, inner, sky)

    # The second triangulation must fill exactly what the first found to be
    # ground, or a piece of rim was lost between them.
    filled = sum(tri_area(pts[t]) for t in tris)
    if abs(filled - ground) > 1e-3 * ground:
        raise SystemExit(f'[ground] the plane covers {filled:.2f} m2 in and around the map, '
                         f'but {ground:.2f} m2 is ground there — a hole did not close')

    level = settle(pts, tris, across, needs(pts, tris, rim, below, tris3), outside, top)
    faces = [(a, b, ya, yb, toward, level[f]) for a, b, ya, yb, toward, f in rim]
    risers = steps(pts, tris, across, level)
    all_pts, ring = skirt(pts, tris, inner, outer)
    plane_pos, plane_nrm, plane_idx = plane_mesh(all_pts, tris + ring, list(level) + [top] * 8, origin)
    with open(SIDE, 'rb') as fh:
        side = fh.read()
    width, height = jpeg_size(side)
    bottom = lowest(faces + risers)
    rim_pos, rim_nrm, rim_idx, rim_uv = rim_mesh(faces + risers, origin, top, bottom, width / height)

    at, at_y, radius, colour = scatter(all_pts, tris + ring, list(level) + [top] * 8, outer)
    where = np.stack([at[:, 0], at_y, at[:, 1]], axis=1) - origin
    balls = [(f'ground_balls_{name}_nocol', linear(rgb), where[colour == n], np.repeat(radius[colour == n], 3).reshape(-1, 3))
             for n, (name, rgb) in enumerate(COLOURS)]

    write_glb(out_path, [('ground_plane', plane_pos, plane_nrm, plane_idx),
                         ('ground_rim', rim_pos, rim_nrm, rim_idx, rim_uv)], side, dome(), balls)

    size = (hi - lo) * SIZE
    print(f'[ground] map    {hi[0] - lo[0]:.1f} x {hi[2] - lo[2]:.1f} m, highest point {top:.3f} m')
    print(f'[ground] plane  {size[0]:.1f} x {size[2]:.1f} m, {len(plane_idx)} triangles')
    print(f'[ground] rim    {len(edges)} edges of the holes -> {len(pieces)} stretches, {len(rim_idx)} triangles, '
          f'down to {min(min(p[2], p[3]) for p in pieces):.2f} m at the lowest')
    print(f'[ground] side   {os.path.relpath(SIDE, GAME_DIR)}, {width} x {height}: its top at {top:.2f} m, '
          f'its bottom at {bottom:.2f} m, once every {(top - bottom) * width / height:.1f} m along')
    print(f'[ground] steps  {len(risers)}, {sum(float(np.hypot(*(b - a))) for a, b, *_r in risers):.1f} m of them, '
          f'the tallest {max((r[5] - r[2] for r in risers), default=0):.2f} m')
    print(f'[ground] balls  {len(at)} in {len(COLOURS)} colours, {radius.min() * 200:.1f} to {radius.max() * 200:.1f} cm across, '
          f'{int((top - at_y > TINY).sum())} of them on the ground inside the map; '
          f'a dome of {len(dome()[2])} triangles each')
    patch = patches(tris, across, level)
    lowered = 0.0
    for r in sorted({p for f, p in enumerate(patch) if top - level[f] > TINY}, key=lambda p: (level[p], p)):
        mine = [f for f in range(len(tris)) if patch[f] == r]
        area = sum(tri_area(pts[tris[f]]) for f in mine)
        lowered += area
        at = sum(pts[tris[f]].mean(axis=0) * tri_area(pts[tris[f]]) for f in mine) / area
        low = min((min(ya, yb) for _a, _b, ya, yb, _t, f in rim if patch[f] == r), default=level[r])
        alone = all(len(fs) == 1 or (patch[fs[0]] == r) == (patch[fs[1]] == r) for fs in across.values())
        print(f'[ground] {"island" if alone else "block "} at {at[0]:6.1f}, {at[1]:6.1f}: {area:6.1f} m2 at {level[r]:.2f} m'
              + (' — a lid' if level[r] - low < TINY else f', rim down to {low:.2f} m'))
    print(f'[ground] inside the map {lowered:.0f} m2 of ground is below {top:.2f} m')
    if missing > 1e-3:
        print(f'[ground] WARNING {missing:.2f} m of the holes has no map edge under it; '
              'the rim there takes its neighbour\'s height')
    print(f'[ground] wrote  {os.path.relpath(out_path, GAME_DIR)} ({os.path.getsize(out_path):,} bytes)')
    print(f'[ground] anchor pos {origin[0]:.5f}, {origin[1]:.5f}, {origin[2]:.5f} (game space)')
    if out_path == OUT:
        shown = refresh_blend(out_path)
        if shown:
            print(f'[ground] scene  {os.path.relpath(BLEND, GAME_DIR)}: new meshes under {", ".join(shown)} '
                  '— File > Revert if it is open in Blender')


main()
