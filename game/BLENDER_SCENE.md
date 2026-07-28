# Editing the scene in Blender

Blender is the **layout tool**. It does not build the game and it is not the
source of truth — it reads and writes two git-tracked files:

| file | tracked | owner | holds |
| --- | --- | --- | --- |
| `scene.manifest.mjs` | yes | you, by hand | map, sky, glass, target count |
| `scene.placements.json` | yes | `scene:export` | where every prop sits |
| `scene/pavilion.blend` | **no** (gitignored) | Blender | 10 MB of imported GLB, rebuildable |
| `assets/*.glb` | yes | your modeller | the actual geometry |

The `.blend` is a working file. It embeds copies of the prop GLBs purely so you
can see what you are placing; nothing in it ships. Delete it whenever you like
and `npm run scene:build` recreates it from the two tracked files.

## The loop

```bash
npm run scene:build      # first time only — creates scene/pavilion.blend
npm run scene:edit       # opens Blender. Move things. Save (Cmd-S).
npm run scene:export     # writes scene.placements.json
npm start                # http://localhost:5173 — see it in game
```

`scene:export` is what the game reads. Saving in Blender is not enough; export
is the publish step. Review the `scene.placements.json` diff before committing —
one moved prop is one changed line.

**You do not have to open Blender through npm.** `scene:edit` just runs
`blender scene/pavilion.blend`; double-clicking the file, `File > Open`, or your
Recent Files list are all equivalent. Blender lives at `/Applications/Blender.app`
by default; override with `BLENDER=/path/to/blender npm run scene:edit`.

**You can also export without leaving Blender:** Scripting workspace ▸ Open ▸
`tools/export_scene.py` ▸ Run Script (`Alt-P`). Identical output to the command
line, plus a popup with the summary and any warnings — worth knowing on macOS,
where a script's `print()` output goes to a console you cannot see. Once the
file is open in the Text Editor it stays in the `.blend`, so subsequent exports
are one `Alt-P`.

## What's in the .blend

**`REF`** — the de_dust2 map, imported for reference. Locked (`hide_select`) and
never exported. It is there so you can see where the ground is.

**`SCENE`** — what you author. One **Empty** per placed thing, drawn as arrows:

- **Move the Empty, never the mesh under it.** Only the Empty's transform is
  exported. The meshes are `hide_select` so clicking passes through to the
  Empty — that is deliberate, not a glitch.
- An Empty with a **`glb` custom property** is a *prop*: the game loads that GLB
  and puts it at the Empty's transform.
- An Empty **without** one is a *marker*: exported as a transform under
  `markers`, for the game to do something with later (`spawn_*`, `painting_*`).
  Nothing consumes markers yet.

## Adding a new prop

1. Drop the GLB in `game/assets/`.
2. In Blender: `File > Import > glTF 2.0`, into the `SCENE` collection.
3. `Add > Empty > Plain Axes`, name it (`crate_01`, `tent_02`, …). Names are the
   identity used across export/rebuild, so make them unique and stable.
4. **Leave the Empty at the world origin for now** (`Alt-G`, `Alt-R`, `Alt-S` to
   be sure). Select the imported objects, then the Empty last, and
   `Ctrl-P > Object (Keep Transform Without Inverse)`.
5. Object Properties ▸ Custom Properties ▸ **New**, name `glb`, value
   `./assets/your_file.glb` (path relative to `game/`).
6. *Now* move the Empty where you want it. Save, `npm run scene:export`.

Step 4's order matters. The game applies the exported transform to a fresh copy
of the GLB, so the Empty has to sit at identity when the payload is attached —
parent it while the Empty is already out in the level and Blender bakes the
offset into the children instead, which looks right in Blender and lands the
prop somewhere else in game. "Without Inverse" is likewise not optional; plain
`Ctrl-P > Object` stores a compensating inverse that stops the Empty from
actually driving the payload.

Reusing the same GLB across many Empties is cheap — the game downloads and
parses each URL once, then instantiates per placement.

Anything else you add as a custom property rides along into `extras` in the
JSON, so you can invent conventions without touching the exporter.

## Coordinates

Blender is Z-up, PlayCanvas is Y-up. The tools convert; you never do the maths.
Work in **metres, Z-up**, the way Blender wants — the map is already imported at
game scale, so if a crate looks knee-high next to a doorway, it is knee-high in
game. Blender +Y is PlayCanvas −Z.

The exact conversion (and why it is a conjugation, not a point formula) is in
`tools/pc_axes.py`. Both directions live in that one file so they cannot drift.

Rotations export as a quaternion; the `euler` field next to it is for humans
reading diffs, and the game ignores it when `rot` is present.

## Rebuilding

`npm run scene:build -- --force` recreates the `.blend` from the tracked files.
It restores every prop and marker exactly — the build→export→build loop is a
byte-identical no-op. What it does *not* restore is Blender-side work nothing
exports: extra collections, lights, viewport layout, notes. Export first.

## Gotchas

- **Negative scale** (mirroring an object) does not survive the round-trip. The
  exporter warns; use rotation instead.
- **A prop that shows in Blender but not in game** — you almost certainly moved
  the mesh instead of the Empty, or forgot `npm run scene:export`.
- **Duplicate names**: Blender silently renames to `crate_01.001`, which exports
  as a *different* prop. Rename properly.
- **`props: []` in `scene.manifest.mjs`** is the hand-placement escape hatch and
  is normally empty. Entries there are shadowed by same-named ones from Blender.

## Collaborating

One `.blend` per area, one owner per file — Blender has no live co-editing. Since
the `.blend` is gitignored and rebuildable, what people actually merge is
`scene.placements.json`, which is small, ordered by name, and readable.
