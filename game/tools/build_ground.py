"""Build the ground the map is dug into: assets/ground.glb.

    npm run ground:build

A white plane at the height of the map's highest point, several times the
map's size, with a hole the shape of the map seen from above — and a rim: the
faces that join the edge of that hole to whatever of the map stands under it,
so the level reads as a pit sunk into a flat white ground.

The map is only read. What comes out is a prop like any other: one GLB, placed
by an anchor in the .blend (`ground_01`), solid, so the plane can be walked on.
Its origin is the middle of the plane, which puts the anchor at the map's
centre, at the height of the ground.

Run it again whenever the map GLB or its `scale` / `euler` in
scene.manifest.mjs changes; the anchor's position is printed at the end, and
moves only if the map's bounding box did.

How the hole is found
---------------------
Seen from above, the map is a union of triangles. Blender's constrained
Delaunay triangulation is handed all of them at once and gives back a
triangulation of their overlay, in which every output triangle lies wholly
under the map or wholly clear of it. The ground is the clear part, taken from
the outside in: emptiness the map
encloses (a courtyard between four buildings with no roof and no floor) is not
reached, so only the map's OUTER boundary is cut. A detached piece of the map
standing off on its own gets a hole of its own.

How the rim is found
--------------------
An edge of the hole lies under some edge of the map — the top of an outer
wall, or the lip of a floor that has no wall. Every map edge that runs along
it is collected and the highest of them at each point (their upper envelope)
is where the rim comes down to. Where the map already reaches the ground's
height there is no rim at all.

  ground_plane   the plane, facing up
  ground_rim     the faces between the plane's hole and the map, facing the pit

Everything is in the game's space — metres, Y-up — which is glTF's as well, so
the file is written directly rather than through Blender's exporter.
"""

import json
import os
import struct
import subprocess
import sys
from collections import defaultdict, deque

import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pc_axes import B2PC, pc_trs_to_matrix  # noqa: E402

GAME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(GAME_DIR, 'assets', 'ground.glb')

SIZE = 6.0        # the plane, as a multiple of the map's own extent on each axis
MARGIN = 4.0      # metres around the map that are triangulated finely (see plane())
WHITE = (1.0, 1.0, 1.0, 1.0)

WELD = 1e-4       # metres: two map vertices closer than this are one point from above
FLAT = 1e-6       # square metres: a triangle smaller than this from above is a wall
ON_LINE = 2e-3    # metres: how far off an edge of the hole a map edge may run and still be "along" it
TINY = 1e-5       # metres: shortest stretch of rim worth a face


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


def flood_from_hull(tris, blocked):
    """The triangles reachable from the hull's edge without entering a `blocked`
    one or crossing a `blocked` edge. `blocked` is (set of faces, set of edges)."""
    no_face, no_edge = blocked
    across = defaultdict(list)
    for f, tri in enumerate(tris):
        for i in range(3):
            across[frozenset((tri[i], tri[(i + 1) % 3]))].append(f)
    start = {fs[0] for fs in across.values() if len(fs) == 1 and fs[0] not in no_face}
    seen, queue = set(start), deque(start)
    while queue:
        f = queue.popleft()
        tri = tris[f]
        for i in range(3):
            key = frozenset((tri[i], tri[(i + 1) % 3]))
            if key in no_edge:
                continue
            for g in across[key]:
                if g not in seen and g not in no_face:
                    seen.add(g)
                    queue.append(g)
    return seen, across


def rect(lo, hi):
    return [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]


def hole_edges(tris3, inner):
    """The edges of the hole: [(a, b)] in (x, z), each with the ground on one
    side and the map on the other, and `toward` — the side the map is on."""
    xz = tris3[:, :, [0, 2]]
    area = ((xz[:, 1, 0] - xz[:, 0, 0]) * (xz[:, 2, 1] - xz[:, 0, 1])
            - (xz[:, 1, 1] - xz[:, 0, 1]) * (xz[:, 2, 0] - xz[:, 0, 0])) / 2
    seen_from_above = np.abs(area) > FLAT

    index, points, faces = {}, [], []

    def vid(p):
        key = (round(p[0] / WELD), round(p[1] / WELD))
        if key not in index:
            index[key] = len(points)
            points.append((float(p[0]), float(p[1])))
        return index[key]

    for tri, a in zip(xz[seen_from_above], area[seen_from_above]):
        ids = [vid(p) for p in tri]
        if len(set(ids)) == 3:
            faces.append(ids if a > 0 else ids[::-1])
    corners = [vid(p) for p in inner]
    frame = [(corners[i], corners[(i + 1) % 4]) for i in range(4)]

    pts, tris, _e, _oe, _of = cdt(points, frame, faces)
    covered = under_the_map(pts, tris, np.array([[points[i] for i in f] for f in faces]))
    ground, across = flood_from_hull(tris, (covered, set()))

    edges = []
    for key, fs in across.items():
        if len(fs) != 2 or (fs[0] in ground) == (fs[1] in ground):
            continue
        g, m = (fs[0], fs[1]) if fs[0] in ground else (fs[1], fs[0])
        if m not in covered:
            continue          # emptiness the flood did not reach cannot border it
        a, b = (pts[i] for i in key)
        centre = pts[list(tris[m])].mean(axis=0)
        edges.append((a, b, centre))
    empty = sum(tri_area(pts[list(tris[f])]) for f in ground)
    return edges, empty


def under_the_map(pts, tris, footprints):
    """Which triangles of the overlay have map over them.

    The triangulation offers this itself (which input faces an output face came
    from), but that answer assumes faces that do not overlap, and seen from
    above a level is nothing but overlap: it came back "all of them". So each
    output triangle's middle is tested against every footprint instead — the
    overlay's triangles never straddle a footprint's edge, so the middle
    speaks for the whole triangle."""
    a, b, c = footprints[:, 0], footprints[:, 1], footprints[:, 2]
    v0, v1 = b - a, c - a
    den = v0[:, 0] * v1[:, 1] - v0[:, 1] * v1[:, 0]
    mids = pts[np.array(tris)].mean(axis=1)
    covered = set()
    for start in range(0, len(mids), 512):
        p = mids[start:start + 512, None, :] - a[None]
        u = (p[..., 0] * v1[:, 1] - p[..., 1] * v1[:, 0]) / den
        v = (v0[:, 0] * p[..., 1] - v0[:, 1] * p[..., 0]) / den
        inside = ((u >= 0) & (v >= 0) & (u + v <= 1)).any(axis=1)
        covered.update(start + int(i) for i in np.nonzero(inside)[0])
    return covered


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
    """Each edge of the hole, cut where the map's height along it changes:
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
            a, b, ya, yb, _t = pieces[n]
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
                na, nb, nya, nyb, _t = pieces[nxt]
                end[0], end[1], end[2] = (nb, nyb, nxt) if key(na) == k else (na, nya, nxt)
        out.append((ends[0][0], ends[1][0], ends[0][1], ends[1][1], toward))
    return out


def plane(pieces, inner, outer):
    """The plane as (points in (x, z), triangles): finely triangulated between
    the hole and `inner`, and eight big triangles from there out to `outer`.

    Two rectangles rather than one because the triangulation fans the hole's
    edge out to whatever frame it is given, and a fan of slivers each 300 m
    long is filed under every cell of the collider's grid (src/collision.mjs)."""
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
    hole = {frozenset(out_edges[i]) for i, src in enumerate(orig_edges)
            if any(s < len(pieces) for s in src)}
    ground, _across = flood_from_hull(tris, (set(), hole))
    tris = [list(tris[f]) for f in sorted(ground)]

    # Out to the full size. The inner rectangle's corners are looked up in what
    # the triangulation returned, which may have reordered its input.
    def find(p):
        return int(np.argmin(np.hypot(pts[:, 0] - p[0], pts[:, 1] - p[1])))
    ring_in = [find(p) for p in inner]
    pts = np.vstack([pts, outer])
    ring_out = [len(pts) - 4 + i for i in range(4)]
    for i in range(4):
        j = (i + 1) % 4
        tris.append([ring_in[i], ring_in[j], ring_out[j]])
        tris.append([ring_in[i], ring_out[j], ring_out[i]])
    return pts, tris


def plane_mesh(pts, tris, origin):
    """Face-up triangles at the origin's height."""
    pos = np.column_stack([pts[:, 0] - origin[0], np.zeros(len(pts)), pts[:, 1] - origin[2]])
    idx = []
    for a, b, c in tris:
        up = (pos[b, 2] - pos[a, 2]) * (pos[c, 0] - pos[a, 0]) - (pos[b, 0] - pos[a, 0]) * (pos[c, 2] - pos[a, 2])
        idx.append((a, b, c) if up > 0 else (a, c, b))
    nrm = np.tile((0.0, 1.0, 0.0), (len(pos), 1))
    return pos, nrm, np.array(idx)


def rim_mesh(pieces, origin, top):
    """One flat face per piece, from the plane down to the map, facing the pit."""
    pos, nrm, idx = [], [], []
    for a, b, ya, yb, toward in pieces:
        if top - ya < TINY and top - yb < TINY:
            continue      # the map comes all the way up here
        d = b - a
        n = np.array([-d[1], d[0]])
        if n @ (toward - a) < 0:
            n = -n
        n = n / np.hypot(*n)
        normal = (n[0], 0.0, n[1])
        quad = [(a[0], top, a[1]), (b[0], top, b[1]), (b[0], yb, b[1]), (a[0], ya, a[1])]
        if top - yb < TINY:
            quad.pop(2)
        elif top - ya < TINY:
            quad.pop(3)
        q = np.array(quad) - origin
        if np.cross(q[1] - q[0], q[2] - q[0]) @ normal < 0:
            q = q[::-1]
        base = len(pos)
        pos.extend(q)
        nrm.extend([normal] * len(q))
        idx.extend((base, base + i, base + i + 1) for i in range(1, len(q) - 1))
    return np.array(pos), np.array(nrm), np.array(idx)


def write_glb(path, meshes):
    """A root node, one child per mesh, one white material. `meshes` is
    [(name, positions, normals, triangles)]."""
    blob, views, accessors = bytearray(), [], []

    def accessor(data, kind, component, target, bounds=False):
        while len(blob) % 4:
            blob.append(0)
        raw = data.tobytes()
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(raw), 'target': target})
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
    for name, pos, nrm, tris in meshes:
        prim = {
            'attributes': {
                'POSITION': accessor(pos.astype('<f4'), 'VEC3', 5126, 34962, bounds=True),
                'NORMAL': accessor(nrm.astype('<f4'), 'VEC3', 5126, 34962),
            },
            'indices': accessor(tris.astype('<u4').reshape(-1), 'SCALAR', 5125, 34963),
            'material': 0,
        }
        nodes.append({'name': name, 'mesh': len(gl_meshes)})
        gl_meshes.append({'name': name, 'primitives': [prim]})

    gltf = {
        'asset': {'version': '2.0', 'generator': 'tools/build_ground.py'},
        'scene': 0,
        'scenes': [{'name': 'ground', 'nodes': [0]}],
        'nodes': nodes,
        'meshes': gl_meshes,
        'materials': [{'name': 'ground_white', 'pbrMetallicRoughness': {
            'baseColorFactor': list(WHITE), 'metallicFactor': 0.0, 'roughnessFactor': 1.0}}],
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': len(blob)}],
    }
    text = json.dumps(gltf, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    blob += b'\0' * (-len(blob) % 4)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(blob)))
        fh.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
        fh.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


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

    edges, empty = hole_edges(tris3, inner)
    pieces, missing = rim_pieces(edges, tris3, top)
    pts, tris = plane(pieces, inner, outer)
    plane_pos, plane_nrm, plane_idx = plane_mesh(pts, tris, origin)
    rim_pos, rim_nrm, rim_idx = rim_mesh(pieces, origin, top)

    # The second triangulation must fill exactly what the first found empty,
    # or a piece of rim was lost between them.
    filled = sum(tri_area(pts[t]) for t in tris[:-8])
    if abs(filled - empty) > 1e-3 * empty:
        raise SystemExit(f'[ground] the plane covers {filled:.2f} m2 around the map, '
                         f'but {empty:.2f} m2 is empty there — the hole did not close')

    write_glb(out_path, [('ground_plane', plane_pos, plane_nrm, plane_idx),
                         ('ground_rim', rim_pos, rim_nrm, rim_idx)])

    size = (hi - lo) * SIZE
    print(f'[ground] map    {hi[0] - lo[0]:.1f} x {hi[2] - lo[2]:.1f} m, highest point {top:.3f} m')
    print(f'[ground] plane  {size[0]:.1f} x {size[2]:.1f} m, {len(plane_idx)} triangles')
    print(f'[ground] rim    {len(edges)} edges of the hole -> {len(pieces)} stretches, {len(rim_idx)} triangles, '
          f'down to {min(min(p[2], p[3]) for p in pieces):.2f} m at the lowest')
    if missing > 1e-3:
        print(f'[ground] WARNING {missing:.2f} m of the hole has no map edge under it; '
              'the rim there takes its neighbour\'s height')
    print(f'[ground] wrote  {os.path.relpath(out_path, GAME_DIR)} ({os.path.getsize(out_path):,} bytes)')
    print(f'[ground] anchor pos {origin[0]:.5f}, {origin[1]:.5f}, {origin[2]:.5f} (game space)')


main()
