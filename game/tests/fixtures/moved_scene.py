"""A .blend whose anchor still points at an asset's OLD path, from before it became a package.

    blender -b -P tests/fixtures/moved_scene.py -- out.blend

Run by tests/carried.mjs. `assets/g-man-dance.glb` does not exist; the asset lives
at `assets/g-man-dance/g-man-dance.glb`, with its script beside it. That is the
state every anchor of a prop is left in the day the prop grows a script — a
clip, an action, a volume it carries — and moves into a folder of its own.
"""

import sys

import bpy

out_path = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)

scene = bpy.data.collections.new('SCENE')
bpy.context.scene.collection.children.link(scene)

anchor = bpy.data.objects.new('dancer_01', None)
scene.objects.link(anchor)
anchor['glb'] = './assets/g-man-dance.glb'
anchor.location = (1, 2, 0)
payload = bpy.data.objects.new('g-man-dance_root', None)     # so the anchor is seen to hold something
scene.objects.link(payload)
payload.parent = anchor

lost = bpy.data.objects.new('lost_01', None)
scene.objects.link(lost)
lost['glb'] = './assets/no_such_prop.glb'
held = bpy.data.objects.new('no_such_root', None)
scene.objects.link(held)
held.parent = lost

bpy.ops.wm.save_as_mainfile(filepath=out_path)
