"""Export the Blender layout to scene.placements.json — the game reads it.

    npm run scene:export

Also runnable without leaving Blender: Scripting workspace > Open this file >
Run Script. Same output, plus a popup with the summary.

Walks the SCENE collection and writes one entry per top-level anchor, converted
into PlayCanvas space. Geometry is NOT exported: the .blend holds imported
copies of the prop GLBs purely so placement is WYSIWYG, and each anchor's `glb`
custom property points at the real asset the game loads. That keeps the diff a
handful of numbers per prop instead of a re-baked binary.

  anchor WITH a `glb` custom property  -> props[]    (loaded + placed)
  anchor WITHOUT one                   -> markers[]  (transform only)

Any other custom properties ride along in `extras`, so Blender-side conventions
(spawn_*, painting_*, ...) can grow without touching this script.

Run from the GUI, the export first *adopts*: `File > Import > glTF` drops a bare
hierarchy into whichever collection is active, and the walk above cannot see it
— no anchor, no `glb`, so the prop is invisible to the game no matter where you
put it. Any such loose import is wired up the way "Adding a new prop" in
BLENDER_SCENE.md describes by hand, and the .blend saved, before the layout is
written:

    SCENE collection ▸ anchor Empty (`glb` custom property)
                     ▸ payload parented under it, hide_select, no parent inverse

Only the placement you applied goes on the anchor. The glTF importer's own root
rotation stays on the payload, because the game rebuilds that from the GLB — put
it on the anchor too and it gets applied twice, which looks right in Blender and
wrong in game.

Both paths adopt; only the GUI saves the result. `npm run scene:export` anchors
in memory and writes the same layout, leaving the .blend untouched — saving it
from a headless run is what was never safe, because your next Cmd-S in an open
session would put the un-anchored scene straight back. So a headless export
ships the prop, and the anchor becomes permanent the next time you export from
Blender (or rebuild with `scene:import --force`).
"""

import json
import os
import re
import struct
import sys

import bpy
from mathutils import Matrix


def resolve_tools_dir():
    """Where this script lives — which is not always what __file__ says.

    `blender -P tools/export_scene.py` sets __file__ to the real path. Running
    the same file from Blender's *Scripting* workspace sets it to the text
    datablock's name instead, so the sibling import below would resolve against
    the cwd and fail. Fall back to the open .blend, which sits at
    game/scene/*.blend by construction.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.isfile(os.path.join(here, 'pc_axes.py')):
        return here
    if bpy.data.filepath:
        guess = os.path.join(os.path.dirname(os.path.dirname(bpy.data.filepath)), 'tools')
        if os.path.isfile(os.path.join(guess, 'pc_axes.py')):
            return guess
    raise SystemExit('cannot find tools/pc_axes.py next to this script or beside the '
                     'open .blend — run `npm run scene:export` instead')


TOOLS_DIR = resolve_tools_dir()
sys.path.insert(0, TOOLS_DIR)
from pc_axes import decompose_pc  # noqa: E402

GAME_DIR = os.path.dirname(TOOLS_DIR)
DEFAULT_OUT = os.path.join(GAME_DIR, 'scene.placements.json')

SCENE_COLLECTION = 'SCENE'
REF_COLLECTION = 'REF'

# Blender stashes addon state in custom properties too; keep them out of git.
NOISE_KEYS = {'cycles', 'cycles_visibility', '_RNA_UI'}

# The prefix the frames-for-artwork app puts on every GLB it emits — see
# anchor_base(). It is the one thing that side of the contract guarantees, so
# changing it here silently renames every picture anchor in the scene.
PICTURE_PREFIX = 'picture_'

# Blender's uniquifying suffix on a name that was already taken — see base_names().
DEDUP_SUFFIX = re.compile(r'\.\d{3}$')


def script_args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


# --- adopting loose imports -------------------------------------------------

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


def base_names(names):
    """Node names with Blender's uniquifying suffix taken off.

    Object names are unique per .blend, so importing a hierarchy whose root is
    already taken gets you `Sketchfab_model.001` — and Sketchfab names *every*
    download's root `Sketchfab_model`, so the second one you import no longer
    matches the file it came from and adoption gives up on a prop that is
    sitting right there. Normalising both sides costs nothing: a node the GLB
    genuinely calls `foo.001` reduces to the same `foo` on both sides, so it
    still matches itself.
    """
    return {DEDUP_SUFFIX.sub('', n) for n in names}


def find_source_glb(payload_names):
    """Which asset did this hierarchy come from? Match on node names.

    Unambiguous in practice: two GLBs sharing every node name are the same
    export. Returns (relative path, None) or (None, reason).
    """
    assets_dir = os.path.join(GAME_DIR, 'assets')
    if not os.path.isdir(assets_dir):
        return None, f'no {assets_dir}'
    wanted = base_names(payload_names)
    hits = []
    for entry in sorted(os.listdir(assets_dir)):
        if not entry.lower().endswith('.glb'):
            continue
        names = glb_node_names(os.path.join(assets_dir, entry))
        if names and wanted <= base_names(names):
            hits.append(entry)
    if not hits:
        return None, ('no .glb in assets/ contains these node names — is the file '
                      'in game/assets/? (see BLENDER_SCENE.md, "Adding a new prop")')
    if len(hits) > 1:
        return None, f'ambiguous, matches {hits} — set the `glb` property by hand'
    return f'./assets/{hits[0]}', None


def importer_rotation(glb_path, root_name=None):
    """What the glTF importer puts on the payload's root, measured not assumed.

    Import the file, read the root, throw the copy away — including the meshes
    and materials it dragged in, so the probe leaves no .001 junk behind.

    "The root" is not always the first parentless object: a glTF may open with
    several, and the extras are rarely the one that matters — g-man.glb leads
    with two stray lamp meshes before the `Sketchfab_model` empty that carries
    the whole character. Taking the first one read an identity rotation off a
    lamp, so the -90° the real root carries never came out of the anchor and
    the game applied it a second time, laying the character flat on the floor.

    So match the payload's own root by name when the caller knows it, and
    otherwise take the largest hierarchy, which is the payload by construction.
    """
    before_objs = set(bpy.data.objects)
    before_data = set(bpy.data.meshes) | set(bpy.data.materials) | set(bpy.data.images)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    added = [o for o in bpy.data.objects if o not in before_objs]
    roots = [o for o in added if o.parent is None]
    root = None
    if root_name:
        want = DEDUP_SUFFIX.sub('', root_name)
        root = next((o for o in roots if DEDUP_SUFFIX.sub('', o.name) == want), None)
    if root is None:
        root = max(roots, key=lambda o: len(o.children_recursive), default=None)
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


def existing_name_for(glb):
    """Reuse the name this GLB already had in the exported layout, if any.

    Keeps the placements diff to the numbers that actually changed instead of
    renaming the prop out from under whatever references it.
    """
    path = os.path.join(GAME_DIR, 'scene.placements.json')
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
    """Every hand-imported hierarchy no anchor owns — wherever it landed.

    `File > Import` drops objects into the *active* collection, so a loose
    import is at least as likely to be sitting inside SCENE as at the top of
    the outliner, and the two are equally invisible to the game: no anchor, no
    `glb`, nothing ships. Inside SCENE the tell is type *plus* children: what
    you author at that level is a *childless* Empty — a marker — so top-level
    geometry, or an Empty with a hierarchy hanging off it, came from the
    importer either way.

    Testing the type alone is what this used to do, and it silently lost every
    prop whose glTF has a root node: the importer represents that node as an
    Empty, so a Sketchfab download (all of which are wrapped in one) read as a
    marker — exported, diffed, and never drawn. Anchors are excluded before the
    type is ever consulted, by owning a `glb`.
    """
    ref = bpy.data.collections.get(REF_COLLECTION)
    scene_coll = bpy.data.collections.get(SCENE_COLLECTION)
    managed = set(ref.objects) if ref else set()
    managed.update(scene_coll.objects if scene_coll else ())

    roots = [o for o in bpy.context.scene.collection.objects
             if o.parent is None and o not in managed and 'glb' not in o]
    if scene_coll:
        roots += [o for o in sorted(scene_coll.objects, key=lambda o: o.name)
                  if o.parent is None and 'glb' not in o
                  and (o.type != 'EMPTY' or o.children)]
    return list(dict.fromkeys(roots))  # an object can be linked to both


def adopt(root, scene_coll):
    payload = [root] + list(root.children_recursive)
    glb, why = find_source_glb({o.name for o in payload})
    if glb is None:
        return None, f'{root.name}: {why}'

    placement = root.matrix_world.copy()
    rotation = importer_rotation(os.path.join(GAME_DIR, glb), root.name)

    name = existing_name_for(glb) or unique_name(anchor_base(glb))
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
    return (name, glb), None


def adopt_loose():
    """Anchor every hand-imported hierarchy. Returns (done, failed).

    Both paths adopt; only the GUI *saves*. Headless anchors in memory and
    leaves the .blend exactly as it found it — which is what makes it safe to
    run while you have the file open, the very thing that used to rule adoption
    out here. The layout written is identical either way, because the anchor's
    transform is computed, not read back off the saved file.

    A no-op when there is nothing loose, so a plain export of an already-tidy
    scene never touches the .blend.
    """
    roots = loose_roots()
    if not roots:
        return [], []
    if not bpy.data.filepath:
        return [], ['save the .blend before importing props — its path is how '
                    'the tools find game/']

    scene_coll = bpy.data.collections.get(SCENE_COLLECTION)
    if scene_coll is None:
        scene_coll = bpy.data.collections.new(SCENE_COLLECTION)
        bpy.context.scene.collection.children.link(scene_coll)
        print(f'[export] created "{SCENE_COLLECTION}" collection')

    done, failed = [], []
    for root in roots:
        result, problem = adopt(root, scene_coll)
        (failed if problem else done).append(problem or result)

    if done and not bpy.app.background:
        bpy.ops.wm.save_mainfile()
        print(f'[export] saved {bpy.data.filepath}')
    return done, failed


# --- exporting the layout ---------------------------------------------------

def extras_of(obj):
    return {
        k: v for k, v in obj.items()
        if not k.startswith('_') and k not in NOISE_KEYS and k != 'glb'
        and isinstance(v, (str, int, float, bool))
    }


def collect(collection):
    props, markers, warnings = [], [], []
    # Sorted so a layout-free re-export is a byte-identical no-op in git.
    for obj in sorted(collection.objects, key=lambda o: o.name):
        if obj.parent is not None:
            continue  # payload geometry hanging under an anchor
        entry = {'name': obj.name}
        entry.update(decompose_pc(obj.matrix_world))
        extras = extras_of(obj)
        if extras:
            entry['extras'] = extras
        if any(s < 0 for s in entry['scale']):
            warnings.append(f'{obj.name}: negative scale — mirrored props do not '
                            'survive the glTF round-trip, use rotation instead')
        if 'glb' in obj:
            entry['glb'] = obj['glb']
            if not obj.children:
                warnings.append(f'{obj.name}: no geometry parented under it — exports '
                                'fine, but nobody in Blender can see what they are placing')
            props.append(entry)
        else:
            if obj.type != 'EMPTY' or obj.children:
                # Loose imported geometry: it renders in Blender, so the scene
                # looks finished, but nothing references it and it never ships.
                # Adoption ran before we got here and would have claimed this,
                # so reaching this line means it could not — an unmatched GLB,
                # reported alongside as an adopt failure. An Empty *with*
                # children is the same story one level up: a glTF root node,
                # which is why the children are what it is judged on rather
                # than the type a marker happens to share with it.
                kind = 'empty holding imported geometry' if obj.type == 'EMPTY' \
                    else f'top-level {obj.type.lower()}'
                warnings.append(f'{obj.name}: {kind} with no "glb" '
                                'property — imported but never attached to an anchor? '
                                'It will NOT appear in game (see BLENDER_SCENE.md)')
            markers.append(entry)
    return props, markers, warnings


def main():
    args = script_args()
    out_path = os.path.abspath(args[args.index('--out') + 1]) if '--out' in args else DEFAULT_OUT

    adopted, adopt_failures = adopt_loose()

    collection = bpy.data.collections.get(SCENE_COLLECTION)
    if collection is None:
        raise SystemExit(
            f'no "{SCENE_COLLECTION}" collection in {os.path.basename(bpy.data.filepath)} — '
            'authored props live there (see tools/build_blend.py).'
        )

    props, markers, warnings = collect(collection)
    payload = {
        '_generated': 'tools/export_scene.py — do not hand-edit; edit the .blend',
        'version': 1,
        'source': os.path.relpath(bpy.data.filepath, GAME_DIR) if bpy.data.filepath else None,
        'props': props,
        'markers': markers,
    }

    # indent=2, except numeric arrays stay on one line — a moved prop should be
    # a one-line diff in review, not eight.
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    text = re.sub(
        r'\[\s*((?:-?[\d.eE+]+,\s*)*-?[\d.eE+]+)\s*\]',
        lambda m: '[' + ', '.join(m.group(1).replace(',', ' ').split()) + ']',
        text,
    )
    with open(out_path, 'w') as fh:
        fh.write(text + '\n')

    for w in warnings + adopt_failures:
        print(f'[export] WARNING {w}')
    for name, glb in adopted:
        print(f'[export] adopted {name:<20} <- {glb}')
    if adopted and bpy.app.background:
        # Say it, or the .blend and the layout disagree with nobody the wiser.
        print(f'[export] NOTE  the anchor{"s" if len(adopted) > 1 else ""} above '
              f'{"are" if len(adopted) > 1 else "is"} in the layout but not saved '
              'to the .blend — the prop ships now; export from Blender (or '
              '`npm run scene:import -- --force`) to make it permanent there')
    for p in props:
        print(f'[export] prop   {p["name"]:<20} pos {p["pos"]}  <- {p["glb"]}')
    for m in markers:
        print(f'[export] marker {m["name"]:<20} pos {m["pos"]}')

    summary = (f'{len(props)} props, {len(markers)} markers -> '
               f'{os.path.relpath(out_path, GAME_DIR)}')
    print(f'[export] wrote {summary}')

    lines = [f'adopted {name} <- {glb}' for name, glb in adopted] + [summary]
    notify(lines, warnings + adopt_failures)


def notify(lines, warnings):
    """Say something visible when run from the Scripting workspace.

    print() goes to the system console, which on macOS is invisible unless
    Blender was launched from a terminal — so the GUI path needs a popup or the
    export looks like it did nothing.
    """
    if bpy.app.background:
        return
    lines = lines + [f'WARNING: {w}' for w in warnings]

    def draw(self, _ctx):
        for line in lines:
            self.layout.label(text=line)

    try:
        bpy.context.window_manager.popup_menu(
            draw, title='Scene exported', icon='ERROR' if warnings else 'CHECKMARK')
    except Exception:
        pass  # never let cosmetics break an otherwise-successful export


main()
