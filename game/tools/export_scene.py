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
"""

import json
import os
import re
import sys

import bpy


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

# Blender stashes addon state in custom properties too; keep them out of git.
NOISE_KEYS = {'cycles', 'cycles_visibility', '_RNA_UI'}


def script_args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


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
            if obj.type != 'EMPTY':
                # Loose imported geometry: it renders in Blender, so the scene
                # looks finished, but nothing references it and it never ships.
                warnings.append(f'{obj.name}: top-level {obj.type.lower()} with no "glb" '
                                'property — imported but never attached to an anchor? '
                                'It will NOT appear in game (see BLENDER_SCENE.md)')
            markers.append(entry)
    return props, markers, warnings


def main():
    args = script_args()
    out_path = os.path.abspath(args[args.index('--out') + 1]) if '--out' in args else DEFAULT_OUT

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

    for w in warnings:
        print(f'[export] WARNING {w}')
    for p in props:
        print(f'[export] prop   {p["name"]:<20} pos {p["pos"]}  <- {p["glb"]}')
    for m in markers:
        print(f'[export] marker {m["name"]:<20} pos {m["pos"]}')

    summary = (f'{len(props)} props, {len(markers)} markers -> '
               f'{os.path.relpath(out_path, GAME_DIR)}')
    print(f'[export] wrote {summary}')
    notify(summary, warnings)


def notify(summary, warnings):
    """Say something visible when run from the Scripting workspace.

    print() goes to the system console, which on macOS is invisible unless
    Blender was launched from a terminal — so the GUI path needs a popup or the
    export looks like it did nothing.
    """
    if bpy.app.background:
        return
    lines = [summary] + [f'WARNING: {w}' for w in warnings]

    def draw(self, _ctx):
        for line in lines:
            self.layout.label(text=line)

    try:
        bpy.context.window_manager.popup_menu(
            draw, title='Scene exported', icon='ERROR' if warnings else 'CHECKMARK')
    except Exception:
        pass  # never let cosmetics break an otherwise-successful export


main()
