"""(Re)build the editable Blender scene from the git-tracked scene data.

    npm run scene:import            # -> scene/pavilion.blend
    npm run scene:import -- --force # rebuild over an existing .blend

The .blend is a *derived working file*, not the source of truth — it is 10 MB
of imported GLB payload and is gitignored. Everything that matters comes from
two files that are in git:

    scene.manifest.mjs      map, look, hand-written props
    scene.placements.json   the layout you authored in Blender

...and those two are exactly what this script reads back in, with placements
overriding same-named manifest props — the same precedence the game loader
uses. So the loop closes: import -> edit -> export -> (re-import reproduces it).
Clone the repo, run scene:import, and you get the current scene.

What a rebuild does NOT preserve is Blender-side state nobody exports: extra
collections, lights, viewport setup, notes. Hence the --force guard.

Layout of the generated .blend:

  REF     the map (de_dust2), imported for visual reference only. Never
          exported, and hide_select so it cannot be nudged by accident.
  SCENE   what you actually author. One Empty per prop ("anchor"), displayed as
          arrows, carrying a `glb` custom property; the imported geometry hangs
          underneath it purely so placement is WYSIWYG.
  NEG     negative spaces: convex cutters that carve the map instead of adding
          to it. Wireframe primitives, each wired into the REF objects it
          overlaps by a Boolean modifier, so the hole is visible while you place
          it. See tools/negatives.py.

Move the ANCHOR, never the mesh under it — only the anchor's transform is
exported. The meshes are hide_select to make that hard to get wrong.
"""

import json
import os
import subprocess
import sys

import bpy
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import negatives  # noqa: E402
from pc_axes import pc_to_blender, pc_trs_to_matrix  # noqa: E402

GAME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(GAME_DIR, 'scene', 'pavilion.blend')

REF_COLLECTION = 'REF'
SCENE_COLLECTION = 'SCENE'


def script_args():
    """Everything after the `--` separator Blender uses to hand off argv."""
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def read_manifest():
    """Run the node bridge so scene.manifest.mjs stays the single source."""
    out = subprocess.run(
        ['node', os.path.join('tools', 'dump_manifest.mjs')],
        cwd=GAME_DIR, capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise SystemExit(f'reading scene.manifest.mjs failed:\n{out.stderr.strip()}')
    return json.loads(out.stdout)


def read_placements(manifest):
    """Load the exported layout, if there is one. Absent on a first build."""
    rel = manifest.get('placements')
    if not rel:
        return {}
    path = os.path.join(GAME_DIR, rel)
    if not os.path.exists(path):
        print(f'[build] no {rel} yet — building from the manifest alone')
        return {}
    with open(path) as fh:
        return json.load(fh)


def merged_props(manifest, placements):
    """Manifest props, then Blender-authored ones — placements win by name.

    Mirrors collectProps() in standalone/main.mjs; if you change the precedence
    in one place, change it in the other.
    """
    by_name = {p['name']: p for p in manifest.get('props', [])}
    for prop in placements.get('props', []):
        by_name[prop['name']] = prop
    return [by_name[k] for k in sorted(by_name)]


def merged_markers(manifest, placements):
    """The same merge as the props, for the transforms that carry no geometry.

    A marker usually has no hand-written half — it is authored in the .blend —
    but `spawn_01` can start life in the manifest and be dragged into Blender
    later, and a rebuild has to carry it across or the Empty it should have
    become is simply missing.
    """
    by_name = {entry['name']: entry for entry in manifest.get('markers', [])}
    for entry in placements.get('markers', []):
        by_name[entry['name']] = entry
    return [by_name[k] for k in sorted(by_name)]


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    return scene


def make_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def import_glb(path, collection):
    """Import a GLB and return its top-level objects, moved into `collection`.

    Blender's importer rotates the payload by Rx(+90) on the way in (glTF is
    Y-up, Blender is Z-up). pc_axes accounts for that, so leave it alone.
    """
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    added = [o for o in bpy.data.objects if o not in before]
    for obj in added:
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        collection.objects.link(obj)
    return added, [o for o in added if o.parent is None]


def matrix_of(entry):
    """TRS fields of a manifest/placements entry -> PlayCanvas-space matrix."""
    return pc_trs_to_matrix(entry.get('pos'), entry.get('euler'),
                            entry.get('scale'), entry.get('rot'))


def anchor_for(name, matrix_pc, collection, extras=None):
    """Create the Empty that represents one placed thing, in Blender space."""
    anchor = bpy.data.objects.new(name, None)
    anchor.empty_display_type = 'ARROWS'
    anchor.empty_display_size = 1.5
    collection.objects.link(anchor)
    anchor.matrix_world = pc_to_blender(matrix_pc)
    for key, value in (extras or {}).items():
        anchor[key] = value
    return anchor


def attach(children, anchor, selectable=False):
    for child in children:
        child.parent = anchor
        # Identity, so the child's world transform is simply anchor @ its own
        # basis. Blender's parenting *operator* would bake an inverse here to
        # preserve the child's screen position; we want the anchor to actually
        # drive the payload, so it must stay identity.
        child.matrix_parent_inverse = Matrix.Identity(4)
    if not selectable:
        for child in children:
            child.hide_select = True
            # Descendants too. `children` is only the GLB's import roots, and a
            # prop whose root is unselectable but whose meshes are not is worse
            # than no guard at all: clicking the tent in the viewport grabs the
            # mesh, moving it looks like it worked, and the export — which reads
            # anchors only — silently writes the same numbers as before.
            for sub in child.children_recursive:
                sub.hide_select = True


def build_negatives(entries, collection, ref):
    """Recreate the cutters and re-point the Boolean modifiers at the map.

    Geometry is generated, never restored: an entry holds a shape name and a
    transform, exactly as a prop entry holds a filename and a transform, so what
    comes back is the unit primitive the game will clip with rather than
    whatever mesh the last session happened to hold.
    """
    cutters = []
    for entry in entries:
        shape = entry.get('shape', 'box')
        try:
            cutter = negatives.make_cutter(entry['name'], shape, collection,
                                           entry.get('sides', negatives.DEFAULT_SIDES))
        except ValueError as err:
            print(f'[build] SKIP {entry["name"]}: {err}')
            continue
        cutter.matrix_world = pc_to_blender(matrix_of(entry))
        for key, value in (entry.get('extras') or {}).items():
            cutter[key] = value
        print(f'[build] negative {entry["name"]}  ({shape})')
        cutters.append(cutter)

    added, _ = negatives.wire_booleans(cutters, list(ref.objects))
    if cutters:
        print(f'[build] wired  {added} boolean modifier(s) across the map for '
              f'{len(cutters)} cutter(s)')
    return cutters


def build(manifest, placements, out_path):
    reset_scene()
    ref = make_collection(REF_COLLECTION)
    scene = make_collection(SCENE_COLLECTION)
    neg = make_collection(negatives.NEG_COLLECTION)

    map_cfg = manifest['map']
    map_path = os.path.join(GAME_DIR, map_cfg['glb'])
    print(f'[build] map    {map_cfg["glb"]}')
    added, roots = import_glb(map_path, ref)
    map_anchor = anchor_for(
        'map_ref',
        pc_trs_to_matrix((0, 0, 0), map_cfg.get('euler'), [map_cfg['scale']] * 3),
        ref,
        {'glb': map_cfg['glb'], 'role': 'reference'},
    )
    attach(roots, map_anchor)
    for obj in added:
        obj.hide_select = True
    map_anchor.hide_select = True

    for prop in merged_props(manifest, placements):
        prop_path = os.path.join(GAME_DIR, prop['glb'])
        if not os.path.exists(prop_path):
            print(f'[build] SKIP {prop["name"]}: {prop["glb"]} not found')
            continue
        print(f'[build] prop   {prop["name"]}  <-  {prop["glb"]}')
        added, roots = import_glb(prop_path, scene)
        extras = dict(prop.get('extras') or {})
        extras['glb'] = prop['glb']
        anchor = anchor_for(prop['name'], matrix_of(prop), scene, extras)
        attach(roots, anchor)

    for marker in merged_markers(manifest, placements):
        print(f'[build] marker {marker["name"]}')
        anchor_for(marker['name'], matrix_of(marker), scene,
                   dict(marker.get('extras') or {}))

    # Last, so the booleans are wired against a map that is fully imported.
    build_negatives(placements.get('negatives', []), neg, ref)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out_path)
    print(f'[build] wrote {os.path.relpath(out_path, GAME_DIR)}')


def main():
    args = script_args()
    force = '--force' in args
    out_path = DEFAULT_OUT
    if '--out' in args:
        out_path = os.path.abspath(args[args.index('--out') + 1])

    if os.path.exists(out_path) and not force:
        raise SystemExit(
            f'{os.path.relpath(out_path, GAME_DIR)} already exists.\n'
            'A rebuild restores the exported layout but drops un-exported Blender work '
            '(extra collections, lights, viewport setup).\n'
            'Run `npm run scene:export` first if you have unsaved layout, then pass --force.'
        )

    manifest = read_manifest()
    build(manifest, read_placements(manifest), out_path)


main()
