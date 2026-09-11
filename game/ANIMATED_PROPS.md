# Animated props

What it would take to put a *moving* character in the pavilion, written while
working out how to add a second, animated g-man beside the one meditating in
the tent.

The short version: **the placing half is ready and the animating half does not
exist yet.** Placing a copy of a prop is a five-minute job through the pipeline
we already have. Making that copy move is three separate pieces of work, one of
which is in the sibling asset kit and blocks the other two.

## Where it stands

| Piece | State |
|---|---|
| Placing a second copy of a GLB | **Ready** — Blender anchor + `scene:export`, see BLENDER_SCENE.md |
| One skeleton per copy | **Ready** — `instantiateRenderEntity()` builds per-node entities |
| A skeleton to animate | **Ready but fragile** — the shipped GLB has one; the kit would strip it |
| Animation clips in the asset | **Missing** — zero clips, and the kit can't carry them |
| Playing a clip at runtime | **Missing** — `src/rig.mjs` is write-once pose only |

## The blocker: the asset kit deletes armatures

`singularity-development-kit/tools/build_assets.py`, `keep_meshes_only()` at
line 261, drops every non-mesh object on import. Its own docstring says so at
line 286:

> THE LIMIT: this is a builder for static props, and dropping every non-mesh is
> what makes that assumption load-bearing. An armature arrives, gets deleted
> here, and the mesh ships in its rest pose with no way to move. If this ever
> needs to carry skinned or animated assets, this is the pass to reopen.

Which means **the skeleton the meditation pose depends on is a fossil.** It
survived an older build of the kit and nothing regenerates it today:

| file | skins | nodes named `ValveBiped` | clips |
|---|---|---|---|
| `game/assets/g-man.glb` — tracked, shipped | 2 | 72 | 0 |
| `singularity-development-kit/dist/g-man.glb` — rebuilt 2026-09-08 | 0 | 0 | 0 |

Copy the kit's current `dist/g-man.glb` over `game/assets/g-man.glb` and
`g-man_01`'s cross-legged sit dies quietly: `src/rig.mjs` logs `no node matched`
for all thirteen bone patterns and the figure stands up in its rest pose. **Do
not refresh that GLB from the kit until the armature pass is reopened.**

What is holding the fossil in place is only the build cache. `digest()`
(line 233) is the source bytes plus the settings that shaped them — *not* the
version of the tool doing the shaping — so an unchanged `source/g-man.glb` with
unchanged settings is skipped rather than rebuilt. The asset is one `--force`
away from losing its bones.

Two further things to fix in that same pass, both of which would break a rig
even after armatures survive:

- **`set_ground_origin()` (line 556) collects `MESH` objects only**, sets each
  one's origin to a shared cursor and then zeroes its location. Do that to a
  skinned mesh while its armature stays put and the deformation desyncs. A
  rigged asset either skips this or moves the armature with it.
- **The glTF export call (line 951) passes no `export_animations`.** Blender's
  default for that operator is `True`, so clips *would* come through once there
  is an armature to hang them on — but the kit's `npm run check` has no notion
  of a clip, so nothing would notice if they stopped.

Contract section 6 of `ASSET_CONTRACT.md` ("Behaviour, and why it is not here
yet") is the deliberate version of this gap: the current answer is *data, not
code* — a prop ships its rig and the consumer drives it from a table. Clips are
data, so they fit that policy; the builder simply hasn't been taught to carry
them.

## The other gaps

**No clips exist.** Both `assets/g-man.glb` and `assets/source/g-man.glb` report
`animations: 0`. What is there is a rig with nothing to play. The mesh is not
the problem — the cache records `trisBefore 9433, trisAfter 9433`, so g-man was
never decimated.

**Nothing in the game can play a clip.** `src/rig.mjs` writes bone rotations
once at spawn and holds them; its header is explicit that there is no anim
component and no clips, and that *"a driver that ticks would slot in beside it
without changing the lookup or the authoring format."* The engine side is fine:
`lib/playcanvas.mjs` contains `AnimComponentSystem`, and `standalone/main.mjs:68`
constructs a full `pc.Application`, which registers the whole component list —
so `addComponent('anim')` is available and this is wiring, not an engine swap.

Three things that will bite during that wiring:

- **Pose and animation are mutually exclusive on the same placement.** An anim
  component rewrites bone rotations every frame, so the animated copy must not
  get a `rigs` entry (`scene.manifest.mjs:135`) — and it wants neither the
  `hide: ['briefcase_reference*']` nor the `offset: [0, -0.93, 0]`, both of which
  are consequences of sitting rather than properties of the model.
- **Collision freezes at load.** `addPropCollision()` (`standalone/main.mjs:390`)
  bakes world-space triangles into the static collider once, from the posed mesh.
  An animated prop's collision would be stuck on frame one. Give it
  `solid: false` — a Blender custom property rides through to `extras` and
  `propIsSolid()` (line 382) reads it — or a `_col` capsule stand-in.
- **The Editor build has no props at all.** `src/game.mjs` reads no placements
  and calls no `loadProp`. Animation lands in the standalone build only.

## Steps, in order

1. **Reopen the armature pass in the kit.** Keep armatures, skins and clips
   instead of dropping every non-mesh; skip or extend `set_ground_origin` for
   rigged assets; add a contract assertion that bone count and clip count
   survive, or the next regression is as quiet as the current one. Probably an
   `animated: true` per-asset setting so static props keep today's behaviour.
2. **Get clips onto the rig.** See below.
3. **Wire playback.** An `anims: { '<placement>': { clip, loop } }` block in
   `scene.manifest.mjs`, keyed by placement name exactly as `rigs` is, read in
   `loadProp` (`standalone/main.mjs:333`). One gotcha: put the anim component on
   the entity returned by `instantiateRenderEntity()`, not on the outer
   `prop.name` wrapper, or the glTF track's node paths won't resolve.
4. **Place the copy.** Minutes — see the next section.

Steps 1 and 3 are the real work. Step 2 is as long as the animation is good.

## Where clips could come from

- **Valve's originals.** Decompile `gman.mdl` with Crowbar to `.smd` and import
  onto the existing skeleton with Blender Source Tools. The bone names already
  match `ValveBiped.Bip01_*`, so the authored pose and the clips would address
  the same joints. Highest fidelity, and the only route that gets his actual
  mannerisms.
- **Hand-keyed in Blender.** The rig is already there and the debug panel's Rig
  sliders already dial poses that paste back into the manifest — an idle sway or
  a breath is an afternoon.
- **Mixamo.** Works, but it re-rigs with its own skeleton, so the ValveBiped
  names and the existing pose entry would no longer apply to that copy.
- **A procedural driver.** No asset work at all: extend `rig.mjs` with the
  ticking driver its header anticipates and drive a few joints from a sine.
  Enough for breathing or a slow head turn, not for anything with weight. This
  is the one route that needs neither step 1 nor step 2.

## Placing the copy

The general rules now live in BLENDER_SCENE.md — "Adding a new prop", and the
Duplicate names and payload-merge entries under Gotchas. What follows is only
what is specific to making a *second* g-man.

**Duplicate the anchor, don't re-import.** `Shift-D` on the `g-man_01` Empty
takes its payload with it, and the duplicate already owns the `glb` custom
property — so `loose_roots()` skips it and `adopt()` never runs. It arrives as
`g-man_01.001`; **rename it to `g-man_02`**, then export. One pass, readable
name.

**The rename is not optional.** `collect()` in `tools/export_scene.py` reads
`obj.name` verbatim and nothing validates it: `DEDUP_SUFFIX` is used only for
matching node names, never for checking an anchor's. Skip the rename and the
layout gets a placement literally called `g-man_01.001`, with no warning line.
Adoption *does* protect against this — it takes the next free name instead — but
duplicating an anchor bypasses adoption, which is exactly what makes it
convenient.

**Re-importing instead gets you `g-man_01_02`.** Not `g-man_02`, and not a
`.001`. `anchor_base('g-man.glb')` returns `stem.split('_')[0] + '_01'`, and
`g-man` has a hyphen where that split wants an underscore, so the base is the
whole of `g-man_01`; `unique_name` then appends, giving `g-man_01_02`. Unique
and stable, just ugly — and it is the name in *both* adoption orders, so it does
not indicate anything went wrong.

**Anchor `g-man_01` permanently before adding anything.** Its payload is still
loose in `scene/pavilion.blend` (`Sketchfab_model.001`), and headless export
adopts in memory without saving — only the in-Blender run writes the anchor back
to the file. While no anchor named `g-man_01` exists as a saved object, adoption
order decides which payload claims that name, and because `manifest.rigs` is
keyed by placement name, a bad draw moves the meditation pose onto the new copy
and stands the original up. So: run one in-Blender export **now**, with nothing
new added, and commit it. That same run also merges `cisterna_col` permanently
under `cisterna_01`, so it is worth doing on its own account.

```bash
npm run scene:edit
# Scripting workspace > Open > tools/export_scene.py > Run Script (Alt-P)
```

**Keep the copy's transform away from the original's.** Anchors are keyed by
`(glb, anchor matrix)`, so a second g-man at exactly `g-man_01`'s transform
merges into one prop rather than becoming two. The export prints `merged X -> Y`
when it happens, so it is visible, but placing them apart avoids the question.

---

Background: `0012f18`, `c744a5f` and `59c7ca7` are the export-side fixes and
docs that established the naming and merge behaviour above.
