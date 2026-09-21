"""A .blend with one prop anchor and an ACT collection holding every kind of action area.

    blender -b -P tests/fixtures/areas_scene.py -- out.blend

Run by tests/areas.mjs. Authored the way a person would — Blender's own
primitives, Object Mode scale, Edit Mode, a modifier — rather than through
tools/areas.py, so the exporter is tested against what Blender makes and not
against its own idea of a cube.

    act_g-man-dance_01       a cube, scaled and turned                   -> box
    act_g-man-dance_01.001   a 24-sided cylinder (a Shift-D duplicate)   -> cylinder, same target
    act_bubble               a UV sphere, squashed; `target` + `action`  -> sphere
    act_pulled               a cube with one corner dragged in Edit Mode -> mesh
    act_L                    an L-shaped room, extruded: concave         -> mesh
    act_soft                 a cube under a Bevel modifier               -> mesh (what you see ships)
    act_nobody               a cube with its lid off, aimed at no prop   -> two warnings
    act_stray                named like an area, filed outside ACT       -> a warning, not exported

tests/areas.mjs knows these numbers: move something here and move it there.
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
act = make_collection('ACT')

# The prop the areas are for. An Empty under it stands in for the payload, so
# the export does not warn that nobody can see what they are placing.
anchor = bpy.data.objects.new('g-man-dance_01', None)
scene.objects.link(anchor)
anchor['glb'] = './assets/g-man-dance/g-man-dance.glb'
anchor.location = (3, 4, 0)
payload = bpy.data.objects.new('g-man-dance_root', None)
scene.objects.link(payload)
payload.parent = anchor

bpy.ops.mesh.primitive_cube_add(size=2, location=(3, 2, 1))
box = file_under(act, bpy.context.object, 'act_g-man-dance_01')
box.scale = (2, 1.5, 1)
box.rotation_euler = (0, 0, radians(30))

bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=1, depth=2, location=(8, 2, 1))
cylinder = file_under(act, bpy.context.object, 'act_g-man-dance_01.001')
cylinder.scale = (3, 3, 1)

bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(-4, 0, 1))
bubble = file_under(act, bpy.context.object, 'act_bubble')
bubble.scale = (2, 2, 1.2)
bubble['target'] = 'g-man-dance_01'
bubble['action'] = 'dance'

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, -6, 1))
pulled = file_under(act, bpy.context.object, 'act_pulled')
pulled['target'] = 'g-man-dance_01'
pulled.data.vertices[7].co.x += 0.8           # the (+1, +1, +1) corner, dragged out along X

# An L on the ground plan — 4 x 5 with the 2 x 3 corner taken out — 2.5 m tall.
bm = bmesh.new()
outline = [(0, 0), (4, 0), (4, 2), (2, 2), (2, 5), (0, 5)]
floor = bm.faces.new([bm.verts.new((x, y, 0)) for x, y in outline])
lifted = bmesh.ops.extrude_face_region(bm, geom=[floor])
bmesh.ops.translate(bm, vec=(0, 0, 2.5),
                    verts=[e for e in lifted['geom'] if isinstance(e, bmesh.types.BMVert)])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
mesh = bpy.data.meshes.new('act_L')
bm.to_mesh(mesh)
bm.free()
room = bpy.data.objects.new('act_L', mesh)
act.objects.link(room)
room['target'] = 'g-man-dance_01'
room.location = (10, 10, 0)

bpy.ops.mesh.primitive_cube_add(size=2, location=(-8, 8, 1))
soft = file_under(act, bpy.context.object, 'act_soft')
soft['target'] = 'g-man-dance_01'
bevel = soft.modifiers.new('Bevel', 'BEVEL')
bevel.width = 0.3
bevel.segments = 2

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 12, 1))
nobody = file_under(act, bpy.context.object, 'act_nobody')
bm = bmesh.new()
bm.from_mesh(nobody.data)
bm.faces.remove(max(bm.faces, key=lambda f: f.calc_center_median().z))   # the lid
bm.to_mesh(nobody.data)
bm.free()

bpy.ops.mesh.primitive_cube_add(size=2, location=(20, 20, 1))
bpy.context.object.name = 'act_stray'          # left wherever Blender put it

bpy.ops.wm.save_as_mainfile(filepath=out_path)
