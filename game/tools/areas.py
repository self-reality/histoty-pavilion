"""Action areas — the Blender half. Shared by build_blend.py and export_scene.py.

An asset's script says what a player can set its object off to do, and offers it
within a radius of the object — two metres, unless the script says otherwise.
That is the asset's guess for a scene that draws nothing better. An action area
is the scene drawing something better: a volume, placed in the level, that says
"the action is on offer HERE". A prop with any area is offered only inside its
areas; one with none keeps its radius.

    ACT collection ▸ a mesh named `act_<placement>` — `act_g-man-dance_01`
                     offers g-man-dance_01's action

It is the negative space's sibling and is authored the same way (drop a mesh
in the collection, move it, export). What differs is what the game asks of it.
A negative clips triangles, so it has to be a convex primitive and only its
transform ships. An area is only ever asked "is the player inside?", which has
an answer for any closed mesh — so an area can be ANY shape:

  box, cylinder, sphere   a mesh that still IS the unit primitive, however it
                          has been moved, turned and scaled in Object Mode:
                          the transform ships and nothing else, as a negative's
                          does, and a moved area is a one-line diff
  mesh                    anything else — an L, a wedge, a room traced round its
                          walls, a cube with one vertex pulled: the mesh's own
                          vertices and triangles ship in the entry

So Edit Mode is allowed here, which it is not on a cutter: the primitive is a
compact way to write the common case down, not a limit on what can be drawn.

Which placement an area is for:

  the name        `act_` + the placement's name. Blender's `.001` on a duplicate
                  is ignored, so two areas for one prop need nothing but Shift-D.
  `target`        a custom property naming the placement, when the name is
                  wanted for something else (`act_terrace`).
  `action`        a custom property naming WHICH of the script's actions, for a
                  prop that has several. Without it, the script's first.
"""

import re
from math import cos, pi, sin

import bmesh
import bpy
from mathutils import Vector

import negatives

ACT_COLLECTION = 'ACT'
ACT_PREFIX = 'act_'
TARGET_KEY = 'target'      # custom property: the placement whose action this offers
ACTION_KEY = 'action'      # custom property: which of its actions (default: the first)
SHAPES = ('box', 'cylinder', 'sphere', 'mesh')

SPHERE_SEGMENTS = 32       # Blender's own default UV sphere
SPHERE_RINGS = 16

# How far a vertex may sit from the unit primitive and still be it. Blender
# stores coordinates as float32 and its own sphere is only good to ~1e-7, so
# this is slack for arithmetic, not for a nudge: a vertex pulled in Edit Mode
# moves by centimetres, and the mesh then ships as itself.
UNIT_TOLERANCE = 1e-4

VERTEX_DECIMALS = 4        # a tenth of a millimetre, in the mesh's own units

DEDUP_SUFFIX = re.compile(r'\.\d{3}$')

# The volumes an ASSET carries, as opposed to the ones drawn in this level: a
# `*_neg` or `*_act` mesh inside a prop's GLB (section 2 of the kit's contract).
# They arrive under the prop's anchor with the rest of its payload, so they move
# when the prop moves and nothing here exports them — the game reads them from
# the asset's script. Same tolerance as the contract's patterns: glTF appends
# `_0`, Blender `.001`.
PAYLOAD_NEG = re.compile(r'_neg(?:[._]\d+)*$', re.I)
PAYLOAD_ACT = re.compile(r'_act(?:[._]\d+)*$', re.I)


def collection(create=False):
    """The ACT collection, optionally creating it if the .blend predates it."""
    coll = bpy.data.collections.get(ACT_COLLECTION)
    if coll is None and create:
        coll = bpy.data.collections.new(ACT_COLLECTION)
        bpy.context.scene.collection.children.link(coll)
    return coll


def target_of(obj):
    """The placement an area offers the action of: its `target`, or its name."""
    declared = obj.get(TARGET_KEY)
    if declared is not None and str(declared).strip():
        return str(declared).strip()
    name = DEDUP_SUFFIX.sub('', obj.name)
    return name[len(ACT_PREFIX):] if name.startswith(ACT_PREFIX) else name


def action_of(obj):
    declared = obj.get(ACTION_KEY)
    return str(declared).strip() if declared is not None and str(declared).strip() else None


# --- reading an area --------------------------------------------------------

def evaluated_mesh(obj):
    """The mesh as the viewport shows it — modifiers applied — in the object's own space.

    What you see is what ships: an area rounded off with a Bevel or cut to shape
    with a Boolean is that shape in game, without anyone having to remember to
    apply the stack first. Returns (owner, mesh); call owner.to_mesh_clear() after.
    """
    owner = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    return owner, owner.to_mesh()


def classify(mesh):
    """Which unit primitive a mesh still is, if any: (shape, sides).

    Judged on the vertices themselves, not on counts or a bounding box, because
    here a miss is harmless — the mesh ships as itself and means exactly what it
    looks like — while a false hit would replace a shape somebody drew with the
    primitive it started as. Every vertex has to be where the primitive has one:
    a cube's at (±1, ±1, ±1), a cylinder's on the unit circle at z = ±1, a
    sphere's on the unit sphere.
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

    if len(verts) >= 12 and all(near(v.length, 1) for v in verts):
        return 'sphere', None

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
                   'Fill the hole (select it, F) or the area will leak')
    return verts, tris, problem


# --- building an area -------------------------------------------------------

def _unit_sphere():
    """A UV sphere on Blender's own defaults, poles on Z."""
    verts = [(0.0, 0.0, 1.0)]
    for ring in range(1, SPHERE_RINGS):
        phi = pi * ring / SPHERE_RINGS
        verts += [(sin(phi) * cos(2 * pi * s / SPHERE_SEGMENTS),
                   sin(phi) * sin(2 * pi * s / SPHERE_SEGMENTS), cos(phi))
                  for s in range(SPHERE_SEGMENTS)]
    verts.append((0.0, 0.0, -1.0))
    last = len(verts) - 1
    row = lambda ring: 1 + (ring - 1) * SPHERE_SEGMENTS  # noqa: E731
    faces = [(0, row(1) + s, row(1) + (s + 1) % SPHERE_SEGMENTS) for s in range(SPHERE_SEGMENTS)]
    for ring in range(1, SPHERE_RINGS - 1):
        a, b = row(ring), row(ring + 1)
        faces += [(a + s, b + s, b + (s + 1) % SPHERE_SEGMENTS, a + (s + 1) % SPHERE_SEGMENTS)
                  for s in range(SPHERE_SEGMENTS)]
    a = row(SPHERE_RINGS - 1)
    faces += [(last, a + (s + 1) % SPHERE_SEGMENTS, a + s) for s in range(SPHERE_SEGMENTS)]
    return verts, faces


def geometry_for(entry):
    """The Blender-space mesh an exported entry stands for: (verts, faces)."""
    shape = entry.get('shape', 'box')
    if shape == 'sphere':
        return _unit_sphere()
    if shape == 'mesh':
        flat, idx = entry.get('verts') or [], entry.get('tris') or []
        if len(flat) % 3 or len(idx) % 3 or not idx:
            raise ValueError('a mesh area with no usable `verts`/`tris`')
        # PlayCanvas (x, y, z) back to Blender (x, -z, y).
        verts = [(flat[i], -flat[i + 2], flat[i + 1]) for i in range(0, len(flat), 3)]
        return verts, [tuple(idx[i:i + 3]) for i in range(0, len(idx), 3)]
    if shape in ('box', 'cylinder'):
        return negatives.unit_shape(shape, entry.get('sides', negatives.DEFAULT_SIDES))
    raise ValueError(f'unknown area shape "{shape}" (expected one of {", ".join(SHAPES)})')


def style_payload_volumes(objs):
    """Draw an imported prop's own volumes as what they are. Returns its `_neg` meshes.

    Straight out of the importer a `_neg` is a grey box standing over the prop
    it belongs to, hiding it. As a red cage it reads as the hole the prop will
    cut, and an `_act` as the green cage its action is offered from — the same
    colours the level's own cutters and areas wear, because they are the same
    things; these ones just came with the asset and go where it goes.
    """
    cutters = []
    for obj in objs:
        if obj.type != 'MESH':
            continue
        if PAYLOAD_NEG.search(obj.name):
            negatives.style_cutter(obj)
            cutters.append(obj)
        elif PAYLOAD_ACT.search(obj.name):
            style_area(obj)
    return cutters


def payload_cutters(scene_collection):
    """Every `_neg` mesh hanging under an anchor — the holes the placed props bring."""
    if scene_collection is None:
        return []
    return [o for o in scene_collection.objects
            if o.type == 'MESH' and o.parent is not None and PAYLOAD_NEG.search(o.name)]


def style_area(obj):
    """Make an area look like one: a green wireframe, where a cutter is red."""
    obj.display_type = 'WIRE'
    obj.show_in_front = True
    obj.hide_render = True
    obj.color = (0.25, 1.0, 0.45, 1.0)


def make_area(entry, coll):
    """Create the mesh object for one exported area, unparented and at the origin.

    A `mesh` area comes back triangulated — the triangles are what shipped, and
    the quads they were cut from did not. It is the same volume and exports to
    the same entry; tidy it with Alt-J if the wireframe bothers you.
    """
    verts, faces = geometry_for(entry)
    mesh = bpy.data.meshes.new(entry['name'])
    mesh.from_pydata([Vector(v) for v in verts], [], [list(f) for f in faces])
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(entry['name'], mesh)
    style_area(obj)
    coll.objects.link(obj)
    # Only what the name does not already say: a rebuilt area should be
    # indistinguishable from one drawn by hand, as a rebuilt cutter is.
    if entry.get('target') and entry['target'] != target_of(obj):
        obj[TARGET_KEY] = entry['target']
    if entry.get('action'):
        obj[ACTION_KEY] = entry['action']
    return obj
