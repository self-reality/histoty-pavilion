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
and `npm run scene:import` recreates it from the two tracked files.

## The loop

```bash
npm run scene:import     # first time only — creates scene/pavilion.blend
npm run scene:edit       # opens Blender. Move things. Save (Cmd-S).
npm run scene:export     # writes scene.placements.json
npm start                # http://localhost:5173 — see it in game
```

`scene:import` and `scene:export` are the two directions of the same round
trip: import pulls the tracked layout *into* the `.blend`, export writes it
back *out*. Neither has anything to do with `File > Import > glTF` inside
Blender, which brings a single prop's geometry in and is covered under
"Adding a new prop".

`scene:export` is what the game reads. Saving in Blender is not enough; export
is the publish step. Review the `scene.placements.json` diff before committing —
one moved prop is one changed line.

**You do not have to open Blender through npm.** `scene:edit` just runs
`blender scene/pavilion.blend`; double-clicking the file, `File > Open`, or your
Recent Files list are all equivalent. Blender lives at `/Applications/Blender.app`
by default; override with `BLENDER=/path/to/blender npm run scene:edit`.

**You can also export without leaving Blender:** Scripting workspace ▸ Open ▸
`tools/export_scene.py` ▸ Run Script (`Alt-P`). Same layout as the command line,
plus a popup with the summary and any warnings — worth knowing on macOS, where a
script's `print()` output goes to a console you cannot see. Once the file is open
in the Text Editor it stays in the `.blend`, so subsequent exports are one
`Alt-P`. The in-Blender run does one thing the headless one will not: it anchors
loose imports first, so a prop you just dragged in actually ships (see "Adding a
new prop").

## What's in the .blend

**`REF`** — the de_dust2 map, imported for reference. Locked (`hide_select`) and
never exported. It is there so you can see where the ground is.

**`SCENE`** — what you author. One **Empty** per placed thing, drawn as arrows:

- **Move the Empty, never the mesh under it.** Only the Empty's transform is
  exported. The meshes are `hide_select` so clicking passes through to the
  Empty — that is deliberate, not a glitch.
- An Empty with a **`glb` custom property** is a *prop*: the game loads that GLB
  and puts it at the Empty's transform.
- A **childless** Empty without one is a *marker*: exported as a transform under
  `markers`, for the game to do something with later (`spawn_*`, `painting_*`).
  Nothing consumes markers yet. (Childless is what separates a marker from a
  loose import whose root happens to be an Empty — see Gotchas.)

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

**Shortcut for steps 3-6:** import the GLB, put it where you want it, then run
the exporter from inside Blender (`tools/export_scene.py`, Scripting workspace ▸
Open ▸ Run Script). Before writing the layout it finds every top-level import
that no anchor owns — in `SCENE` or at the top of the Outliner, wherever `File >
Import` happened to drop it — works out which file in `assets/` it came from by
matching node names, builds the anchor around it, and saves, so the prop is in
game when the script finishes. It reuses the name a GLB already had in
`scene.placements.json`, so re-importing a prop you deleted keeps its identity
and the diff stays to the numbers that changed.

`npm run scene:export` adopts too, and writes the same numbers — what it will
not do is *save* the `.blend`. That is the part that was never safe from a
headless run: if you have the file open, your next `Cmd-S` writes the
un-anchored scene straight back over it. So the prop ships either way, and the
anchor becomes permanent in the file the next time you export from Blender (or
rebuild with `scene:import --force`). The command says so when it happens.

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

## Adding a picture

A picture is a prop, so the steps above are the steps — there is nothing new to
learn. What differs is only where the GLB comes from: drag the photograph into
**frames-for-artwork** (a standalone browser app — see the Pictures section of
README.md), set its height, and save the download into `game/assets/`.

```
~/scan.jpg  →  frames-for-artwork  →  game/assets/picture_kremlin_1904.glb
```

Then import and place it exactly like a crate — the in-Blender export handles
the anchor for you.

Two things that make hanging them painless:

- **The origin is on the back face**, so the anchor Empty belongs *on* the wall,
  not floating half a slab in front of it. With snapping on (`Shift-Tab`, mode
  **Face**, and **Align Rotation to Target** ticked in the Snapping popover), one
  click puts a picture flat against a wall at the correct rotation.
- **An imported picture faces you in front view** (numpad 1), i.e. Blender −Y. If
  a placed one looks black, you are behind it — backfaces are culled.

Pictures never collide, so you cannot get wedged against one and they cost the
collider nothing. The wall behind it is what stops you.

## Collision

A placed prop is **solid by default** — its geometry joins the collider when it
loads, so you walk into it and shoot it like the map.

Three ways to opt out, at different scales:

| Want | Do |
|------|----|
| The whole prop walk-through (decor, a distant silhouette) | Custom property `solid` = `0` on the anchor Empty |
| One mesh inside a solid prop walk-through | End that object's name with **`_nocol`** |
| A bought prop's ropes and pegs walk-through, without hand-editing it | `nocolMaxSpan`, in the asset kit — see below |

`_nocol` is the one you will reach for most. A tent's guy-ropes and pegs are
thin geometry that you snag on and get stuck against, while the fabric body is
something you genuinely should not walk through — so name the ropes
`tent_ropes_nocol` and leave the body alone. `_nocol` meshes still render and
still cast shadows; they are invisible only to collision.

The suffix survives export: the glTF importer appends a primitive index
(`pole_nocol` arrives in game as `pole_nocol_0`) and Blender appends `.001` to
duplicates, so both of those still match.

### When the prop has no ropes to name

Marketplace props usually arrive welded: `tent_military.glb` is one node holding
140 separate shells — fabric panels, but also 90 pegs, hinges and cross-bars.
There is no rope object to rename, so the whole thing has to be solid.

`nocolMaxSpan` does the naming for you at build time. That build no longer
happens here — it is `assets.config.json` in the **singularity-developement-kit**,
which is where props are made (see the Assets section of README.md). It splits
every mesh by loose parts, measures each shell across its **second-widest
axis**, and joins everything under the threshold into a sibling called
`<name>_nocol`:

```json
"assets": { "tent_military.glb": { "nocolMaxSpan": 0.5 } }
```

The second axis, not the smallest — a tent wall is 0.11 m thin too, but it is
6 m long and 4 m tall. Only pegs and ropes are narrow in *two* directions.

Measured along each shell's **own** axes (by PCA), not the world's. That is not
a detail: the tent's guy-ropes are 4.4 m long and 2 cm thick, but they run
diagonally from roof to ground, so an axis-aligned box around one is 2.5 m wide
on its second axis and the rope reads as solid — leaving trip-wires strung
across the approach, precisely the geometry you wanted gone.

It works here because the two populations do not overlap: the tent's widest thin
part is 0.38 m across (a rolled awning) and its narrowest solid one is 0.62 m (a
door flap), so 0.5 sits between them with room either side. Check that gap before
trusting a threshold on a new prop — `npm run build -- --force --dry` in the
kit reports what it would catch without writing anything, and its viewer shows
you the split in colour. Set it to `0` (the default) and nothing splits.

Doing it at build time rather than by hand in Blender is deliberate: a
hand-split file would live with the raw sources, which are untracked and treated
as the pristine download, so the work would exist on exactly one machine. As a
config number it is in git and `--force` reproduces it anywhere.

The cost is one extra draw call and one extra shadow caster per split object.
On the tent that bought 12,660 of its 19,998 triangles out of collision — the
controller now tests 7,338 — so it is a trade worth making, but it is a trade.

### Collision proxies

`_nocol` only ever removed geometry. Even with the tent's ropes and pegs gone,
the collider was still tracing 7,338 triangles of wrinkled fabric for something
a capsule experiences as six flat walls and a roof.

`collisionProxy` builds a stand-in instead:

```json
"assets": { "tent_military.glb": { "nocolMaxSpan": 0.5, "collisionProxy": "dissolve" } }
```

That adds one `<asset>_col` mesh to the GLB. A prop that ships one collides with
**it alone** — the visual meshes stop colliding entirely, `_nocol` or not — and
the proxy never renders and never casts a shadow. On the tent: **1,252 triangles
instead of 7,338**, with the frame budget untouched at 170 draw calls, because an
invisible mesh instance is never submitted.

Two modes, and the choice is entirely about whether the prop has a way in.

| mode | does | use for |
|------|------|---------|
| `dissolve` | merges faces flatter than `collisionProxyAngle` (default 15°) | anything with a door, arch, or interior |
| `hull` | replaces each connected shell with its convex hull | props you walk *around* — boulders, crates, statues |

**`dissolve` is the default choice**, because it only ever removes geometry.
Every opening in the mesh survives, and on the tent it is *cheaper* than the
hull anyway (1,252 vs 1,384 triangles).

**`hull` seals doorways, and that is not a bug to be fixed.** It is what convex
means. Hulling per shell rather than per prop already saves the concavity that
lives *between* panels — without it the whole tent becomes one solid block — but
an opening *inside* a single shell gets filled either way. Measured on the tent:
the hull proxy stays inside the visual silhouette everywhere (4.7 cm at worst,
5 cm along a head-height ray), so it does not fatten the prop; it just bricks up
the entrance. Approaching from every walkable direction, you get within 0.4 m of
the centre with `dissolve` and no closer than 3.84 m with `hull`.

`tests/props.mjs` asserts the tent is still enterable for exactly this reason.
That check exists because the sealed hull build passed every *other* check —
"the player was stopped by the tent" is precisely what a bricked-up entrance
looks like from the outside.

Raise `collisionProxyAngle` for a cheaper, blockier collider: on the tent, 15°
gives 1,252 triangles, 20° gives 897, 30° gives 682.

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

`npm run scene:import -- --force` recreates the `.blend` from the tracked files.
It restores every prop and marker exactly — the build→export→build loop is a
byte-identical no-op. What it does *not* restore is Blender-side work nothing
exports: extra collections, lights, viewport layout, notes. Export first.

## Gotchas

- **Which collection you import into does not matter.** `File > Import` drops
  objects into the **active** collection, so they land at the top of the
  Outliner or inside `SCENE` depending on what you last clicked; adoption picks
  them up either way. Inside `SCENE` it goes by type *and* children — what you
  author at that level is a childless Empty, so top-level geometry there is an
  import, and so is an Empty with a hierarchy under it. That second case is the
  usual one for a Sketchfab download, which arrives wrapped in a
  `Sketchfab_model` root node the importer represents as an Empty.
- **Negative scale** (mirroring an object) does not survive the round-trip. The
  exporter warns; use rotation instead.
- **A prop that shows in Blender but not in game** — you almost certainly moved
  the mesh instead of the Empty, or forgot `npm run scene:export`.
- **Duplicate names**: Blender silently renames to `crate_01.001`, which exports
  as a *different* prop. Rename properly.
- **Never edit the `.blend` from a second Blender while it is open here.** A
  headless `-b scene/pavilion.blend -P fix.py` writes the file, then your next
  Cmd-S writes this session's scene straight back over it and the change is
  gone. Run the script in the open session instead (Alt-P), or close Blender
  first. Symptom: `scene:export` reporting `no "SCENE" collection` right after
  something claimed to have created one.
- **`props: []` in `scene.manifest.mjs`** is the hand-placement escape hatch and
  is normally empty. Entries there are shadowed by same-named ones from Blender.

## Collaborating

One `.blend` per area, one owner per file — Blender has no live co-editing. Since
the `.blend` is gitignored and rebuildable, what people actually merge is
`scene.placements.json`, which is small, ordered by name, and readable.
