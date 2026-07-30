"""Adopt loose imported geometry into anchored props, then export.

Run it from Blender: Scripting workspace ▸ Open ▸ this file ▸ Run Script (Alt-P).

`File > Import > glTF` drops a bare hierarchy at the top of the scene. The
exporter ignores that — it only walks the SCENE collection, and only exports
Empties carrying a `glb` custom property — so a freshly imported prop is
invisible to the game no matter where you put it. This does the wiring that
BLENDER_SCENE.md ("Adding a new prop") describes by hand:

    SCENE collection ▸ anchor Empty (`glb` custom property)
                     ▸ payload parented under it, hide_select, no parent inverse

then saves and exports, so the prop is in game when the script finishes.

Run it in the session you are working in. Anchoring the .blend from a separate
headless Blender does not work while the file is open here: your next Cmd-S
writes this session's scene over it and the anchors vanish.

Only the placement you applied goes on the anchor. The glTF importer's own root
rotation stays on the payload, because the game rebuilds that from the GLB — put
it on the anchor too and it gets applied twice, which looks right in Blender and
wrong in game.
"""

import json
import os
import struct
import sys

import bpy
from mathutils import Matrix

SCENE_COLLECTION = 'SCENE'
REF_COLLECTION = 'REF'

# Matches PICTURE_PREFIX in build_assets.py — see anchor_base().
PICTURE_PREFIX = 'picture_'


def game_dir():
    """game/, derived from the open .blend at game/scene/*.blend."""
    if not bpy.data.filepath:
        raise SystemExit('save the .blend first — its path is how the tools find game/')
    return os.path.dirname(os.path.dirname(bpy.data.filepath))


def glb_node_names(path):
    """Node names in a .glb, read from its JSON chunk (no import, no bpy)."""
    with open(path, 'rb') as fh:
        magic, _version, _length = struct.unpack('<III', fh.read(12))
        if magic != 0x46546C67:
            return set()
        chunk_len, chunk_type = struct.unpack('<II', fh.read(8))
        if chunk_type != 0x4E4F534A:  # 'JSON'
            return set()
        doc = json.loads(fh.read(chunk_len).decode('utf-8'))
    return {n.get('name') for n in doc.get('nodes', []) if n.get('name')}


def find_source_glb(payload_names, assets_dir):
    """Which asset did this hierarchy come from? Match on node names.

    Unambiguous in practice: two GLBs sharing every node name are the same
    export. Returns (relative path, None) or (None, reason).
    """
    if not os.path.isdir(assets_dir):
        return None, f'no {assets_dir}'
    hits = []
    for entry in sorted(os.listdir(assets_dir)):
        if not entry.lower().endswith('.glb'):
            continue
        names = glb_node_names(os.path.join(assets_dir, entry))
        if names and payload_names <= names:
            hits.append(entry)
    if not hits:
        return None, ('no .glb in assets/ contains these node names — is the file '
                      'in game/assets/? (see BLENDER_SCENE.md, "Adding a new prop")')
    if len(hits) > 1:
        return None, f'ambiguous, matches {hits} — set the `glb` property by hand'
    return f'./assets/{hits[0]}', None


def importer_rotation(glb_path):
    """What the glTF importer puts on a root, measured rather than assumed.

    Import the file, read the root, throw the copy away — including the meshes
    and materials it dragged in, so the probe leaves no .001 junk behind.
    """
    before_objs = set(bpy.data.objects)
    before_data = set(bpy.data.meshes) | set(bpy.data.materials) | set(bpy.data.images)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    added = [o for o in bpy.data.objects if o not in before_objs]
    root = next((o for o in added if o.parent is None), None)
    rotation = root.matrix_world.copy() if root else Matrix.Identity(4)
    rotation.translation = (0, 0, 0)

    for obj in added:
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection, pool in ((bpy.data.meshes, before_data),
                             (bpy.data.materials, before_data),
                             (bpy.data.images, before_data)):
        for item in [d for d in collection if d not in pool]:
            try:
                collection.remove(item)
            except RuntimeError:
                pass  # still referenced by something we did not create; leave it
    return rotation


def existing_name_for(glb, game):
    """Reuse the name this GLB already had in the exported layout, if any.

    Keeps the placements diff to the numbers that actually changed instead of
    renaming the prop out from under whatever references it.
    """
    path = os.path.join(game, 'scene.placements.json')
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    for prop in data.get('props', []):
        if prop.get('glb') == glb:
            return prop.get('name')
    return None


def anchor_base(glb):
    """A readable anchor name from a GLB filename.

    The first token is usually the useful part of a prop's name and the rest is
    the vendor's variant noise: tent_military.glb -> tent_01. Generated pictures
    invert that — every one of them starts with `picture_`, so the first token
    alone would name them picture_01, picture_02, picture_03 and lose which
    picture each anchor holds. Those names then stick, because existing_name_for
    reuses whatever landed in scene.placements.json.
    """
    stem = os.path.splitext(os.path.basename(glb))[0]
    if stem.startswith(PICTURE_PREFIX) and len(stem) > len(PICTURE_PREFIX):
        return stem + '_01'
    return stem.split('_')[0] + '_01'


def unique_name(base):
    if base not in bpy.data.objects:
        return base
    n = 2
    while f'{base}_{n:02d}' in bpy.data.objects:
        n += 1
    return f'{base}_{n:02d}'


def loose_roots():
    """Top-level imports sitting outside SCENE/REF, i.e. nothing exports them."""
    managed = set()
    for name in (SCENE_COLLECTION, REF_COLLECTION):
        coll = bpy.data.collections.get(name)
        if coll:
            managed.update(coll.objects)
    return [o for o in bpy.context.scene.collection.objects
            if o.parent is None and o not in managed and 'glb' not in o]


def adopt(root, game, scene_coll):
    payload = [root] + list(root.children_recursive)
    glb, why = find_source_glb({o.name for o in payload}, os.path.join(game, 'assets'))
    if glb is None:
        return None, f'{root.name}: {why}'

    placement = root.matrix_world.copy()
    rotation = importer_rotation(os.path.join(game, glb))

    name = existing_name_for(glb, game) or unique_name(anchor_base(glb))
    anchor = bpy.data.objects.new(name, None)
    anchor.empty_display_type = 'ARROWS'
    anchor.empty_display_size = 1.5
    scene_coll.objects.link(anchor)
    anchor['glb'] = glb
    anchor.matrix_world = placement @ rotation.inverted()  # your move only
    if anchor.rotation_mode != 'QUATERNION':
        anchor.rotation_mode = 'QUATERNION'

    root.matrix_basis = rotation          # importer's rotation stays with the payload
    root.parent = anchor
    root.matrix_parent_inverse = Matrix.Identity(4)

    for obj in payload:
        obj.hide_select = True            # so clicks land on the anchor, not the mesh
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        scene_coll.objects.link(obj)

    bpy.context.view_layer.update()
    drift = max(abs(a - b) for ra, rb in zip(placement, root.matrix_world)
                for a, b in zip(ra, rb))
    if drift > 1e-5:
        raise SystemExit(f'{name}: payload moved by {drift:.3e} — aborting, nothing saved')
    return (name, glb, drift), None


def report(lines, title, ok):
    for line in lines:
        print(f'[adopt] {line}')
    if bpy.app.background:
        return

    def draw(self, _ctx):
        for line in lines:
            self.layout.label(text=line)

    try:
        bpy.context.window_manager.popup_menu(
            draw, title=title, icon='CHECKMARK' if ok else 'ERROR')
    except Exception:
        pass


def main():
    game = game_dir()
    roots = loose_roots()
    if not roots:
        report(['Nothing loose to adopt — every top-level object is already',
                'in SCENE or REF. If a prop is missing from the game, run',
                'scene:export (Alt-P on tools/export_scene.py).'],
               'Nothing to do', True)
        return

    scene_coll = bpy.data.collections.get(SCENE_COLLECTION)
    if scene_coll is None:
        scene_coll = bpy.data.collections.new(SCENE_COLLECTION)
        bpy.context.scene.collection.children.link(scene_coll)
        print(f'[adopt] created "{SCENE_COLLECTION}" collection')

    done, failed = [], []
    for root in roots:
        result, problem = adopt(root, game, scene_coll)
        (failed if problem else done).append(problem or result)

    if not done:
        report(['Adopted nothing:'] + failed, 'Could not adopt', False)
        return

    bpy.ops.wm.save_mainfile()
    lines = [f'{name} <- {glb}' for name, glb, _ in done]
    print('[adopt] saved', bpy.data.filepath)

    # Export in the same run, so the prop is in game when this finishes.
    export = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'export_scene.py')
    if not os.path.isfile(export):
        export = os.path.join(game, 'tools', 'export_scene.py')
    argv = sys.argv[:]
    sys.argv = [export]                   # export_scene reads args after '--'
    try:
        with open(export) as fh:
            exec(compile(fh.read(), export, 'exec'),
                 {'__file__': export, '__name__': '__main__'})
    finally:
        sys.argv = argv

    report([f'Adopted {len(done)} prop(s), saved and exported:'] + lines + failed,
           'Prop adopted', not failed)


main()
