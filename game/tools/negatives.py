"""Negative spaces — the Blender half. Shared by build_blend.py and export_scene.py.

A negative is a closed volume placed in the NEG collection: what is inside it
is cut out of the map. It is authored the way a prop is (drop it in, move it,
export) and it works in the opposite direction: the game subtracts it from the
map's triangles instead of adding a GLB.

    NEG collection ▸ a closed mesh named `neg_*`

What ships depends on what the mesh still is. One that is still the unit cube
or cylinder it was added as — moved, turned and scaled in Object Mode — ships
as a shape and a transform, seven lines, and the unit primitives below are
generated with the same vertex formulas as src/negatives.mjs so that the mesh
you boolean against in the viewport and the volume the game clips with are the
same, down to which way a cylinder's ring is phased. Anything else — a dragged
corner, an L, a Bevel left unapplied — ships as itself: its vertices and
triangles, modifiers applied (mesh_payload). classify() decides which, off the
vertices. A `neg` custom property still forces a primitive, and check_primitive()
then holds the mesh to it.

A prop can carry cutters of its own — `*_neg` meshes modelled with the asset,
which arrive under its anchor with the rest of its payload and are never
exported from here; the game reads them from the asset's script. What this
module does for those is draw them as cutters (style_payload_volumes) and put
them in the boolean preview (payload_cutters).

The Boolean modifiers are what make the hole visible while you place it. They
live on the REF map objects, not on the cutter, and are wired here rather than
by hand — the map is 39 objects, all hide_select, and which of them a doorway
straddles changes every time you drag it.
"""

import re
from math import cos, pi, sin

import bmesh
import bpy
from mathutils import Vector

NEG_COLLECTION = 'NEG'
NEG_PREFIX = 'neg_'
SHAPE_KEY = 'neg'          # custom property naming the shape
MOD_PREFIX = 'NEG_'        # Boolean modifiers this module owns, by name
DEFAULT_SIDES = 32         # Blender's own default cylinder
SHAPES = ('box', 'cylinder')


# --- unit primitives (mirrors of the ones in src/negatives.mjs) -------------

def _unit_box():
    verts = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
             (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7),
             (0, 1, 5, 4), (3, 7, 6, 2),
             (0, 4, 7, 3), (1, 2, 6, 5)]
    return verts, faces


def _unit_cylinder(sides):
    verts = [(cos(i / sides * 2 * pi), sin(i / sides * 2 * pi), z)
             for z in (-1, 1) for i in range(sides)]
    faces = [(i, (i + 1) % sides, sides + (i + 1) % sides, sides + i) for i in range(sides)]
    faces.append(tuple(reversed(range(sides))))          # -Z cap
    faces.append(tuple(sides + i for i in range(sides)))  # +Z cap
    return verts, faces


def unit_shape(shape, sides=DEFAULT_SIDES):
    if shape == 'box':
        return _unit_box()
    if shape == 'cylinder':
        return _unit_cylinder(max(3, int(sides)))
    raise ValueError(f'unknown negative shape "{shape}" (expected one of {", ".join(SHAPES)})')


def _half_extents(points):
    """Centre and half-extents of an axis-aligned box around `points`."""
    lo = Vector((min(p[0] for p in points), min(p[1] for p in points), min(p[2] for p in points)))
    hi = Vector((max(p[0] for p in points), max(p[1] for p in points), max(p[2] for p in points)))
    return (lo + hi) / 2, (hi - lo) / 2


# --- reading a cutter -------------------------------------------------------

def infer_shape(obj):
    """Which primitive a cutter is, read off the mesh instead of asked for.

    A cube and a cylinder are not remotely alike in vertex and face count, so
    making the author declare which one they just added is a step that exists
    only to be forgotten. The `neg` custom property stays available as an
    override; nothing needs to set it.

    The one ambiguity is a four-sided cylinder, which has a cube's 8 vertices
    and 6 faces and reads as a cube — correctly, since it is one, give or take
    the 45 degrees you can put back with a rotation.
    """
    verts, faces = len(obj.data.vertices), len(obj.data.polygons)
    if verts == 8 and faces == 6:
        return 'box'
    sides = sides_of(obj)
    if verts == 2 * sides and faces == sides + 2:
        return 'cylinder'
    return None


def shape_of(obj):
    """The shape a cutter is, by declaration if it has one and by its mesh if not."""
    declared = obj.get(SHAPE_KEY)
    if declared is not None:
        return str(declared).strip().lower()
    return infer_shape(obj) or 'box'


def sides_of(obj):
    """A cylinder's side count, read off the mesh rather than assumed.

    Exported so the game builds the same prism the viewport booleaned with. Side
    faces are the ones whose normal is perpendicular to the local Z axis — the
    axis Blender's own cylinder stands on — which separates them from the two
    caps whatever the ring's resolution. (The game's unit cylinder stands on Y,
    because that is where the axis conversion puts Blender's Z. Same shape, two
    spaces; see src/negatives.mjs.)
    """
    sides = sum(1 for p in obj.data.polygons if abs(p.normal.z) < 0.5)
    return sides if sides >= 3 else DEFAULT_SIDES


def check_primitive(obj, shape, sides):
    """Warn if a cutter's mesh has drifted from the unit primitive it stands for.

    Only the object transform is exported, so an Edit Mode change is invisible
    to the game: the viewport shows the hole you cut, the game carves the one
    the transform describes, and nothing says they differ. Tolerance is 1% of
    the shape's own size, which no deliberate edit stays inside of.
    """
    try:
        verts, _ = unit_shape(shape, sides)
    except ValueError as err:
        return str(err)

    if len(obj.data.vertices) != len(verts):
        return (f'{obj.name}: {len(obj.data.vertices)} vertices, but a {shape} cutter has '
                f'{len(verts)} — edited in Edit Mode? Only the object transform is exported')

    want_c, want_h = _half_extents(verts)
    got_c, got_h = _half_extents([tuple(c) for c in obj.bound_box])
    if (got_c - want_c).length > 0.01 or max(abs(g - w) for g, w in zip(got_h, want_h)) > 0.01:
        return (f'{obj.name}: mesh is {got_h.x:.2f} x {got_h.y:.2f} x {got_h.z:.2f} in its own '
                f'space, not the unit {shape} — scale it in Object Mode, not Edit Mode')
    return None


# --- building a cutter ------------------------------------------------------

def style_cutter(obj):
    """Make a cutter look like a cutter: a wireframe you can see the map through."""
    obj.display_type = 'WIRE'
    obj.show_in_front = True
    obj.hide_render = True
    obj.color = (1.0, 0.25, 0.2, 1.0)


def make_cutter(name, shape, collection, sides=DEFAULT_SIDES):
    """Create the mesh object for one negative, unparented and at the origin.

    Built from the unit-shape tables rather than bpy.ops.mesh.primitive_*_add,
    which keeps it identical to what the game clips with and needs no context to
    run in.
    """
    verts, faces = unit_shape(shape, sides)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([Vector(v) for v in verts], [], [list(f) for f in faces])
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    # No `neg` property: a rebuilt cutter should be indistinguishable from one
    # you added by hand, and shape_of() reads both the same way.
    style_cutter(obj)
    collection.objects.link(obj)
    return obj


# --- the boolean preview ----------------------------------------------------

def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    return (Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners))),
            Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners))))


def _overlap(a, b):
    (a_lo, a_hi), (b_lo, b_hi) = a, b
    return all(a_lo[i] <= b_hi[i] and a_hi[i] >= b_lo[i] for i in range(3))


def wire_booleans(cutters, targets):
    """Point every cutter at the map objects it overlaps, and only those.

    Rebuilt from scratch each time rather than added to, because which objects a
    cutter reaches is a function of where it currently is: drag a doorway one
    wall to the left and the old modifiers would keep cutting the old wall while
    the new one stayed solid. Modifiers this module owns are recognised by name,
    so anything you added by hand is left alone.

    Returns (added, removed) counts.
    """
    cutters = [c for c in cutters if c.type == 'MESH']
    boxes = {c.name: world_bounds(c) for c in cutters}
    added = removed = 0

    for obj in targets:
        if obj.type != 'MESH':
            continue
        for mod in [m for m in obj.modifiers if m.name.startswith(MOD_PREFIX)]:
            obj.modifiers.remove(mod)
            removed += 1
        here = world_bounds(obj)
        for cutter in cutters:
            if not _overlap(here, boxes[cutter.name]):
                continue
            mod = obj.modifiers.new(name=MOD_PREFIX + cutter.name, type='BOOLEAN')
            mod.operation = 'DIFFERENCE'
            mod.object = cutter
            # EXACT, not FAST: a de_dust2 rip is not a tidy manifold, and FAST
            # quietly produces nothing on geometry it dislikes.
            mod.solver = 'EXACT'
            mod.show_expanded = False
            added += 1
    return added, removed


def collection(create=False):
    """The NEG collection, optionally creating it if the .blend predates it."""
    coll = bpy.data.collections.get(NEG_COLLECTION)
    if coll is None and create:
        coll = bpy.data.collections.new(NEG_COLLECTION)
        bpy.context.scene.collection.children.link(coll)
    return coll


# --- reading a cutter that is no longer a primitive -------------------------

# How far a vertex may sit from the unit primitive and still be it. Blender
# stores coordinates as float32, so this is slack for arithmetic, not for a
# nudge: a vertex pulled in Edit Mode moves by centimetres, and the mesh then
# ships as itself.
UNIT_TOLERANCE = 1e-4

VERTEX_DECIMALS = 4        # a tenth of a millimetre, in the mesh's own units


def evaluated_mesh(obj):
    """The mesh as the viewport shows it — modifiers applied — in the object's own space.

    What you see is what ships: an area rounded off with a Bevel or cut to shape
    with a Boolean is that shape in game, without anyone having to remember to
    apply the stack first. Returns (owner, mesh); call owner.to_mesh_clear() after.
    """
    owner = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    return owner, owner.to_mesh()


def classify(mesh):
    """Which unit primitive a mesh still is, if any: (shape, sides) — or ('mesh', None).

    Judged on the vertices themselves, not on counts or a bounding box, because
    a miss is harmless — the mesh ships as itself and means exactly what it
    looks like — while a false hit would replace a shape somebody drew with the
    primitive it started as. Every vertex has to be where the primitive has one:
    a cube's at (±1, ±1, ±1), a cylinder's on the unit circle at z = ±1.
    """
    verts = [v.co for v in mesh.vertices]
    faces = len(mesh.polygons)
    near = lambda a, b: abs(a - b) <= UNIT_TOLERANCE  # noqa: E731

    if len(verts) == 8 and faces == 6 and all(near(abs(c), 1) for v in verts for c in v):
        return 'box', None

    sides = sum(1 for p in mesh.polygons if abs(p.normal.z) < 0.5)
    if (sides >= 3 and len(verts) == 2 * sides and faces == sides + 2
            and all(near(abs(v.z), 1) and near(v.x * v.x + v.y * v.y, 1) for v in verts)):
        return 'cylinder', sides

    return 'mesh', None


def mesh_payload(mesh):
    """(verts, tris, problem) — a mesh's geometry in the GAME's local space.

    Blender (x, y, z) is PlayCanvas (x, z, -y), and because the entry's
    transform is the object's converted by conjugation (pc_axes.py), the
    vertices under it convert by that same rotation and nothing else. A
    rotation, so the winding survives — not that the game's inside test reads
    it. Flat lists, because that is what the exporter keeps on one line: a
    reshaped area is a changed line of `verts`, a moved one is a changed `pos`.

    `problem` is set when the surface is not closed. The game decides "inside"
    by counting how many times a ray out of the point crosses the surface, and
    a surface with a hole in it has rays that leave without crossing anything.
    """
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()

    def r(v):
        return round(v, VERTEX_DECIMALS) + 0.0   # +0.0 folds -0.0 into 0.0

    verts = []
    for v in bm.verts:
        verts += [r(v.co.x), r(v.co.z), r(-v.co.y)]
    tris = [v.index for f in bm.faces for v in f.verts]
    open_edges = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    bm.free()

    problem = None
    if len(tris) < 12:
        problem = 'fewer than four triangles — not a volume'
    elif open_edges:
        problem = (f'{open_edges} edge(s) not shared by exactly two faces — the surface is not '
                   'closed, and the game tells inside from outside by counting crossings of it. '
                   'Fill the hole (select it, F) or the cutter will leak')
    return verts, tris, problem


def make_mesh_cutter(entry, collection):
    """Recreate a cutter that shipped as itself, from its `verts` and `tris`.

    Triangulated — the triangles are what shipped, and the quads they were cut
    from did not. Same volume, same export; tidy it with Alt-J if the wireframe
    bothers you.
    """
    flat, idx = entry.get('verts') or [], entry.get('tris') or []
    if len(flat) % 3 or len(idx) % 3 or not idx:
        raise ValueError('a mesh cutter with no usable `verts`/`tris`')
    # PlayCanvas (x, y, z) back to Blender (x, -z, y).
    verts = [(flat[i], -flat[i + 2], flat[i + 1]) for i in range(0, len(flat), 3)]
    faces = [tuple(idx[i:i + 3]) for i in range(0, len(idx), 3)]
    mesh = bpy.data.meshes.new(entry['name'])
    mesh.from_pydata([Vector(v) for v in verts], [], [list(f) for f in faces])
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(entry['name'], mesh)
    style_cutter(obj)
    collection.objects.link(obj)
    return obj


# --- the volumes a prop carries ---------------------------------------------

# `*_neg` and `*_act` meshes inside a prop's GLB (section 2 of the kit's
# contract). Same tolerance as the contract's patterns: glTF appends `_0`,
# Blender `.001`.
PAYLOAD_NEG = re.compile(r'_neg(?:[._]\d+)*$', re.I)
PAYLOAD_ACT = re.compile(r'_act(?:[._]\d+)*$', re.I)


def style_carried_area(obj):
    """A prop's own action area: a green cage, where a cutter is red."""
    obj.display_type = 'WIRE'
    obj.show_in_front = True
    obj.hide_render = True
    obj.color = (0.25, 1.0, 0.45, 1.0)


def style_payload_volumes(objs):
    """Draw an imported prop's own volumes as what they are. Returns its `_neg` meshes.

    Straight out of the importer a `_neg` is a grey box standing over the prop
    it belongs to, hiding it. As a red cage it reads as the hole the prop will
    cut, and an `_act` as the green cage its action is offered from. The red is
    the same red a cutter drawn in NEG wears, because it is the same thing; this
    one just came with the asset and goes where it goes.
    """
    cutters = []
    for obj in objs:
        if obj.type != 'MESH':
            continue
        if PAYLOAD_NEG.search(obj.name):
            style_cutter(obj)
            cutters.append(obj)
        elif PAYLOAD_ACT.search(obj.name):
            style_carried_area(obj)
    return cutters


def payload_cutters(scene_collection):
    """Every `_neg` mesh hanging under an anchor — the holes the placed props bring."""
    if scene_collection is None:
        return []
    return [o for o in scene_collection.objects
            if o.type == 'MESH' and o.parent is not None and PAYLOAD_NEG.search(o.name)]


def payload_cutters(scene_collection):
    """Every `_neg` mesh hanging under an anchor — the holes the placed props bring."""
    if scene_collection is None:
        return []
    return [o for o in scene_collection.objects
            if o.type == 'MESH' and o.parent is not None and PAYLOAD_NEG.search(o.name)]
