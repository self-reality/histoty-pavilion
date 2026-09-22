"""A .blend with one prop anchor and a NEG collection holding every kind of cutter.

    blender -b -P tests/fixtures/cutters_scene.py -- out.blend

Run by tests/cutters.mjs. Authored the way a person would — Blender's own
primitives, Object Mode scale, Edit Mode, a modifier — rather than through
tools/negatives.py, so the exporter is tested against what Blender makes and
not against its own idea of a cube.

    neg_plain      a cube, scaled                               -> box
    neg_turned     a cube, scaled and turned 30 degrees         -> box
    neg_L          an L-shaped pit, extruded: concave           -> mesh
    neg_pulled     a cube with one corner dragged in Edit Mode  -> mesh
    neg_soft       a cube under a Bevel modifier                -> mesh (what you see ships)
    neg_open       a cube with its lid off                      -> mesh, and a warning
    neg_stray      named like a cutter, filed outside NEG       -> a warning, not exported

tests/cutters.mjs knows these numbers: move something here and move it there.
"""

import sys
from math import radians

import bmesh
import bpy

out_path = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)


def make_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def file_under(coll, obj, name):
    """bpy.ops adds to the active collection; move the new object where it belongs."""
    obj.name = name
    for user in list(obj.users_collection):
        user.objects.unlink(obj)
    coll.objects.link(obj)
    return obj


scene = make_collection('SCENE')
neg = make_collection('NEG')

# A prop, so the layout is a layout. An Empty under it stands in for the
# payload, so the export does not warn that nobody can see what they are placing.
anchor = bpy.data.objects.new('g-man-dance_01', None)
scene.objects.link(anchor)
anchor['glb'] = './assets/g-man-dance/g-man-dance.glb'
anchor.location = (3, 4, 0)
payload = bpy.data.objects.new('g-man-dance_root', None)
scene.objects.link(payload)
payload.parent = anchor

bpy.ops.mesh.primitive_cube_add(size=2, location=(-20, 30, 1))
plain = file_under(neg, bpy.context.object, 'neg_plain')
plain.scale = (1.5, 0.5, 1)

bpy.ops.mesh.primitive_cube_add(size=2, location=(-30, 30, 1))
turned = file_under(neg, bpy.context.object, 'neg_turned')
turned.scale = (2, 0.5, 1)
turned.rotation_euler = (0, 0, radians(30))

# An L on the ground plan — 4 x 5 with the 2 x 3 corner taken out — 2.5 m deep.
bm = bmesh.new()
outline = [(0, 0), (4, 0), (4, 2), (2, 2), (2, 5), (0, 5)]
floor = bm.faces.new([bm.verts.new((x, y, 0)) for x, y in outline])
lifted = bmesh.ops.extrude_face_region(bm, geom=[floor])
bmesh.ops.translate(bm, vec=(0, 0, 2.5),
                    verts=[e for e in lifted['geom'] if isinstance(e, bmesh.types.BMVert)])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
mesh = bpy.data.meshes.new('neg_L')
bm.to_mesh(mesh)
bm.free()
pit = bpy.data.objects.new('neg_L', mesh)
neg.objects.link(pit)
pit.location = (30, 30, 0)

bpy.ops.mesh.primitive_cube_add(size=2, location=(-20, -30, 1))
pulled = file_under(neg, bpy.context.object, 'neg_pulled')
pulled.data.vertices[7].co.x += 0.8           # the (+1, +1, +1) corner, dragged out along X

bpy.ops.mesh.primitive_cube_add(size=2, location=(-20, -10, 1))
soft = file_under(neg, bpy.context.object, 'neg_soft')
bevel = soft.modifiers.new('Bevel', 'BEVEL')
bevel.width = 0.3
bevel.segments = 2

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 40, 1))
lidless = file_under(neg, bpy.context.object, 'neg_open')
bm = bmesh.new()
bm.from_mesh(lidless.data)
bm.faces.remove(max(bm.faces, key=lambda f: f.calc_center_median().z))   # the lid
bm.to_mesh(lidless.data)
bm.free()

bpy.ops.mesh.primitive_cube_add(size=2, location=(20, 20, 1))
bpy.context.object.name = 'neg_stray'          # left wherever Blender put it

bpy.ops.wm.save_as_mainfile(filepath=out_path)
