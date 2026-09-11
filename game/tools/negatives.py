"""Negative spaces — the Blender half. Shared by build_blend.py and export_scene.py.

A negative is a convex cutter placed in the NEG collection. It is authored the
way a prop is (drop it in, move it, export) and it exports the way a prop does
— a name and a transform, no geometry — but it works in the opposite direction:
the game subtracts it from the map's triangles instead of adding a GLB.

    NEG collection ▸ mesh primitive named `neg_*`, `neg` custom property
                     naming the shape ('box' or 'cylinder')

Two things have to agree for a cutter to mean the same thing on both sides:

  1. The shape. The unit primitives below are generated with the same vertex
     formulas as src/negatives.mjs, so the mesh you boolean against in the
     viewport and the planes the game clips with enclose the same volume — down
     to which way a cylinder's ring is phased.
  2. The transform, and only the transform. Nothing about the mesh is exported,
     so a cutter must be scaled in Object Mode; edit its vertices and Blender
     shows one volume while the game carves another. check_primitive() is what
     notices.

The Boolean modifiers are what make the hole visible while you place it. They
live on the REF map objects, not on the cutter, and are wired here rather than
by hand — the map is 39 objects, all hide_select, and which of them a doorway
straddles changes every time you drag it.
"""

from math import cos, pi, sin

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
