# Animated props

How a character gets into the pavilion, and which side does what. Written first
as a plan, when the only g-man was the one meditating in the tent; now the
record of how both of them work.

The short version: **a character is a prop that ships as a folder** — the
object, a script saying what it does, and any clips the script plays. It is
copied into `assets/`, placed in Blender like any prop, and the runtime does the
rest. Nothing is built here.

A script does not have to animate. The dancer's plays a clip; the meditator's
holds a single pose. Same folder shape, same loader, same contract.

```
assets/g-man-dance/
  g-man-dance.glb                ← the OBJECT: the rig, under one root node named g-man-dance_root
  g-man-dance.script.json        ← the SCRIPT: which clip plays, how, and what to hang where first
  keep_it_gangsta_3.dance.json   ← a clip, retargeted to that rig

assets/g-man-sit/
  g-man-sit.glb                  ← the same rig, under a root node named g-man-sit_root
  g-man-sit.script.json          ← the SCRIPT: one pose, held; no clips
```

## Who does what

| side | repo | does |
|---|---|---|
| **producer** | `motion-capture-4` (`/Volumes/Smartbuy/Projects/motion-capture-4`) | tracks a video, retargets it to the rig, writes an animated folder |
| **standard** | `singularity-development-kit` | `ASSET_CONTRACT.md` section 6, "Scripts"; `npm run check <folder>/` |
| **consumer** | this repo | `tools/export_scene.py` writes the script's path into the placement; `src/script.mjs` runs it |

The same arrangement every other asset has: the kit builds props, the
frames-for-artwork app builds pictures, the sound-design repo builds the sound
bank, and each ships something finished and self-describing that this side
places without knowing who made it. The motion-capture tool is the fourth
producer, and what it produced is the first asset with a *script*.

**`g-man-sit` is the exception, and it is worth knowing why.** No producer owns
a *static* pose: the kit physically cannot build a rigged asset today
(`build_assets.py` drops every non-mesh on import, so its g-man has no
armature), and the motion-capture tool makes clips, not poses. The pose was also
dialled here, on the debug panel. So the pavilion authored this one folder, and
`npm run assets:check` holds it to the contract exactly as if it had arrived
from somewhere else. The standard governs what a script contains, not who typed
it. If the kit's armature pass ever reopens, this asset is the one to move.

## An object and its script

A prop has always been two things: the object (the GLB) and what it does. Both
g-men now carry their own second half: the script beside the GLB says what the
object does anywhere it stands — a clip for the dancer, a pose for the
meditator — and the pavilion's `rigs` entry, if it has one, says what *this*
copy does *here*, applied on top, the way placements shadow hand-written props.

The meditation pose used to be that `rigs` entry, dialled onto a model the
pavilion was handed. It moved into the asset: the same eleven bones and the same
numbers, now travelling with the model instead of waiting in the level that
happened to place it first. `rigs` is empty today and stays for what an asset
cannot know — the same character folded differently for one spot in one level.

The script is data, never code. Its vocabulary is the contract:

| field | means |
|---|---|
| `object` | the GLB beside it, its root node's name, what it was made from, its sha256 |
| `solid` | the asset's own answer to collision — `false` for anything that moves |
| `rig.root` … `rig.right_thigh` | which bones the runtime reads the character's own axes off |
| `rig.attach` | hang `node` off `to` at load, keeping its bind world transform |
| `clips` | every clip in the folder: name, file, duration, bpm, loop, sha256 |
| `play` | `{ clip, loop, speed }` — what plays from the moment the prop lands |
| `pose` / `hide` / `offset` / `move` | a static pose, in exactly the terms a `rigs` entry uses |

A clip is a shared `times` array and, per bone pattern, a flat `xyzw`
quaternion per key: a **delta on the bind pose**, composed as `delta × bind`,
in the parent's frame, with every node a pattern hits taking the same delta —
`Spine*` is four bones on g-man and the exporter has already divided by four.
`root.t` is the pelvis's travel in the character's own axes (right, up, behind)
and `root.q` its turn. The producer's `PAVILION_EXPORT.md` is the format's home;
the summary above is what this side needs to play one.

A `rigs` pose is composed the *other* way, `bind × delta`, so a hand-dialled
euler triple reads as "bend this joint in its own axes". Same words, opposite
order, one whole bind rotation apart — which is why `src/rig.mjs` and
`src/script.mjs` never share that line.

## What the runtime does

`standalone/main.mjs` fetches the script alongside the GLB (`loadProp`), and
once both are in, `PropScript` in `src/script.mjs` runs the script in a fixed
order:

1. **Capture the bind pose** — every node's local rotation and position, before
   anything moves. Every delta is a delta on this.
2. **Attach** what the script says. g-man's head is a second skeleton whose
   armature is a *sibling* of the body's, not a child of its spine, so bending
   the body would leave the head hanging in space. `rig.attach` names the
   armature (`gman_high_ARM.001`) and the bone to hang it off
   (`ValveBiped.Bip01_Spine4_gman_high_ARM`); the loader reparents it with its
   bind world transform preserved, measured against the host's *bind*, never a
   pose. The producer measured that trap and wrote it down; this side does what
   the entry says, by exact name, and nothing more.
3. **The script's own pose**, if it has one — a `PropRig`, write-once, same as a
   `rigs` entry.
4. **Bind the clip.** `ClipPlayer` matches every pattern, keeps each node's
   captured bind rotation, reads the character's axes off the pelvis, spine top
   and thighs, and from then on is ticked from the game loop on the same clamped
   step as the player: slerp between the two neighbouring keys, `delta × bind`
   onto every matched node, the pelvis's travel turned through its parent's
   frame. A clip that does not loop holds its last key.

Then the manifest's `rigs` entry for the placement, if any, goes on top — with
a warning if a clip is also playing, since the clip rewrites its bones every
frame and the pose only survives on bones the clip leaves alone.

**Collision is the one thing a moving prop must not have.** `addPropCollision`
bakes world-space triangles into the static collider once, from whatever pose
the mesh is in at load; a dancer would leave a statue of his first frame
standing in the room. The script says `solid: false`, `propIsSolid` reads it
after the placement's own word (an anchor's `solid` custom property still
wins), and the log line says where the answer came from. An animated prop that
must block ships a `_col` stand-in the clip does not move.

`tests/anim.mjs` places the dancer from the test, through the same `loadProp`,
and checks all of it: the clip ticks, the head rides Spine4 at its bind
distance, the pelvis walks, nothing joins the collider, and the clock holds at
the end of a one-off clip.

## Placing one

Copy the folder in, import the GLB *inside* it, export from Blender. The steps
are in BLENDER_SCENE.md under "Adding an animated prop"; what matters here is
what the export writes:

```json
{ "name": "g-man-dance_01",
  "glb": "./assets/g-man-dance/g-man-dance.glb",
  "script": "./assets/g-man-dance/g-man-dance.script.json",
  "pos": [...], "rot": [...], "scale": [...] }
```

`script` is found on disk at export time — `<stem>.script.json` beside
`<stem>.glb` — and never stored on the anchor, so the `.blend` carries one
property per prop and a script added to an asset later is picked up by the next
export. A hand-written entry in `manifest.props` takes the same `script` field.

## Two g-men, two folders

`g-man-sit_01` sits in the tent; `g-man-dance_01` dances beside him. They are
the same model, they arrive the same way, and they are deliberately **not** the
same file:

| placement | folder | root node | its script says |
|---|---|---|---|
| `g-man-sit_01` | `assets/g-man-sit/` | `g-man-sit_root` | a pose — sukhasana, briefcase hidden, solid |
| `g-man-dance_01` | `assets/g-man-dance/` | `g-man-dance_root` | a clip — `keep_it_gangsta_3`, looped, not solid |

The copy costs ~1 MB of download and buys an unambiguous scene. Adoption in
`tools/export_scene.py` works out which file a hand-imported payload came from
by node names, and two copies carrying the same names would match both; each
wraps its payload in one extra root node named for the asset, and the exporter
prefers the file with nothing left over. So re-importing either g-man lands on
its own folder, and neither script can migrate onto the other.

Both objects are `rigs/g-man.glb` from the motion-capture repo — the same
fossil, each under its own root. **Neither
may be refreshed from the kit's `dist/`**: `build_assets.py` drops every
non-mesh on import, so its `g-man.glb` has no armature, and a copy would turn
either figure into a statue in its rest pose without a single error. Reopening
that armature pass in the kit is still the step that would let a rigged asset
be *built* rather than copied; until then the producer copies the rig it
retargeted against, and the kit's `npm run check` holds the copy to the same
contract as everything else.

## What is still true

- **The Editor build has no props.** `src/game.mjs` reads no placements and
  calls no `loadProp`; animation lands in the standalone build only.
- **Pose and clip on the same bone: the clip wins**, every frame. Give a dancer
  a `rigs` entry only for bones the clip does not touch, and expect the warning.
- **The kit's build drops armatures.** See above; the object is copied, not
  built.
- **`hide` still applies.** The briefcase is rigidly weighted to g-man's right
  hand. The dancer carries it, because his script does not hide it; the
  meditator's does, since a man with both palms on his knees has nowhere to put
  it.

## Where clips come from

- **The motion-capture tool** — the route that exists. A phone video of a
  performer, tracked with MediaPipe, camera motion undone, retargeted onto the
  rig's own bind pose, previewed on the rig beside the video, exported as the
  folder above. `keep_it_gangsta_3` is 22.6 s of that.
- **Valve's originals**, decompiled from `gman.mdl` and imported onto the same
  skeleton — the bone names already match. Highest fidelity, and the only route
  to his actual mannerisms; it would need a producer that writes the clip
  format, which is a glTF-channels-to-JSON walk.
- **Hand-keyed in Blender**, same producer gap.
- **Procedural** — extend `rig.mjs` with a ticking driver and drive a few
  joints from a sine. Breathing, a slow head turn; nothing with weight.

---

Background: `0012f18`, `c744a5f` and `59c7ca7` established the export-side
naming and merge behaviour; the script convention landed across all three repos
on 2026-09-15.
