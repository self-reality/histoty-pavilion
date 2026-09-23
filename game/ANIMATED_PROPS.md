# Animated props

How a character gets into the pavilion, and which side does what. Written first
as a plan, when the only g-man was the one meditating in the tent; now the
record of how both of them work.

The short version: **a character is a prop that ships as a folder** — the
object, a manifest saying what it is, a script saying what it does, and any
clips the script plays. It is copied into `assets/`, placed in Blender like any
prop, and the runtime does the rest. Nothing is built here.

The manifest is data and the script is **code**. The dancer's script offers an
action that plays a clip when you press **E** at him; until you do he stands
in the pose his manifest holds, briefcase at his side. The meditator has no
script at all — his manifest holds a single pose, and a pose is how an object
stands, not something it does. Same folder shape, same loader, same contract.

```
assets/g-man-dance/
  g-man-dance.glb                ← the OBJECT: the rig, under one root node named g-man-dance_root
  g-man-dance.manifest.json      ← the MANIFEST: the pose he waits in, his clips, what to hang where first
  g-man-dance.script.js          ← the SCRIPT: offers `dance`, which plays the clip
  keep_it_gangsta_3.dance.json   ← a clip, retargeted to that rig

assets/g-man-sit/
  g-man-sit.glb                  ← the same rig, under a root node named g-man-sit_root
  g-man-sit.manifest.json        ← the MANIFEST: one pose, held; no clips, no script
```

## Who does what

| side | repo | does |
|---|---|---|
| **producer** | `motion-capture-4` (`/Volumes/Smartbuy/Projects/motion-capture-4`) | tracks a video, retargets it to the rig, writes an animated folder |
| **standard** | `singularity-development-kit` | `ASSET_CONTRACT.md` section 6, "Packages" — the manifest's fields and Script API 1; `npm run check <folder>/` |
| **consumer** | this repo | `tools/export_scene.py` writes the manifest's path into the placement; `src/script.mjs` applies it and runs the script |

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
from somewhere else. The standard governs what a manifest contains, not who
typed it. If the kit's armature pass ever reopens, this asset is the one to move.

## An object, its manifest and its script

A prop has always been two things: the object (the GLB) and what it does. A
package splits the second into what the object *is* and what it *does*,
because a consumer needs them at different times.

**The manifest** is read at boot with the layout, before any object has
landed: the level is cut by the holes an asset carries before its GLB has
arrived, and a pose's seat offset moves where the object stands. So it is data,
a few KB:

| field | means |
|---|---|
| `object` | the GLB beside it, its root node's name, what it was made from, its sha256 |
| `script` | the script's file name, when it has one |
| `solid` | the asset's own answer to collision — `false` for anything that moves |
| `rig.root` … `rig.right_thigh` | which bones the runtime reads the character's own axes off |
| `rig.attach` | hang `node` off `to` at load, keeping its bind world transform |
| `clips` | every clip in the folder: name, file, duration, bpm, loop, sha256 |
| `pose` / `hide` / `offset` / `move` | how it stands, in exactly the terms a `rigs` entry uses |
| `negatives` / `areas` | the volumes the object carries, copied out of its `_neg` / `_act` meshes by the kit's `npm run pack`: what it cuts out of the map, and where its action is offered |

The pavilion's `rigs` entry, if it has one, says how *this* copy stands
*here*, applied on top, the way placements shadow hand-written props. The
meditation pose used to be that `rigs` entry and moved into the asset; `rigs`
is empty today and stays for what an asset cannot know.

**The script** is what the object does once it has landed, and it is code —
one ES module whose default export is called with `object`. Everything it can
do is a member of that object, fixed by the kit's contract as **Script API 1**:
`play` a manifest clip on the rig, a `sound` from the folder where it stands, a
`video` or a live `canvas` on one of its materials, `on('tick')` every frame,
`wait` in game time, offer an `action`, `open` a link. It imports nothing and
touches no engine, so the same asset runs in any pavilion that implements the
API. The dancer's, as motion-capture-4 wrote it:

```js
export default function (object) {
  object.action({ name: 'dance', label: 'Dance', stop: 'Stop' },
    (run) => run.play('keep_it_gangsta_3', { loop: false }));
}
```

The producer rewrites that file on every export until its first line — a
comment saying so — is deleted; after that it is yours, and the export leaves
it alone and prints what to add by hand.

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

## Actions

What an object does **at rest** is whatever its script started with `object`
— a clip from `object.play`, a canvas it keeps drawing, or nothing. An action
is what it does instead, for a while, because a player walked up and pressed
**E**. The script offers it with a name, the word the hint shows, the word it
shows while running, how near "near" is (`radius`, metres, 2 if unsaid), and a
function:

```js
object.action({ name: 'dance', label: 'Dance', stop: 'Stop' },
  (run) => run.play('keep_it_gangsta_3', { loop: false }));
```

The function is handed a **run** — `play`, `sound`, `video` and `wait`, tied to
this one time the action was set off — and the action runs for as long as the
promise it returns is pending. The kit's contract has the rules, and they are
the whole state machine: **at rest it starts, running it stops, and it ends by
itself when what it returned settles.** Stopped, everything the run started
stops and whatever it was waiting on rejects, so an `async` sequence ends at the
`await` it was on. `PropScript` in `src/script.mjs` is the only place they live
(`trigger()`, `stop()`, `finish()`). So the dancer's one-off is a performance
you can cut short, a looped clip would be a switch, and an action that opens a
link is over the moment it is set off.

Who may press the key, and when, is not the asset's business and lives
elsewhere, in `src/actions.mjs`:

- **In reach** means inside the **action area** the asset carries — an `_act`
  mesh modelled with it, read from its manifest and placed by the prop's own
  transform, so it goes where the prop goes (BLENDER_SCENE.md, "What a prop
  brings with it") — or, when it carries none, within the action's `radius`.
  The radius is
  measured from the prop's live *bounds* to the player's whole standing height,
  not from origin to eye: g-man's origin is between his shoes, 1.6 m under the
  camera, so two metres origin-to-eye would be one metre across the floor. And
  live, so a dancer who has walked off his spot is reached where he is.
- **Which one**, of several in reach, is the one nearest the middle of your view
  — you press E at what you are looking at. Each prop in reach gets an `E` and
  its label on screen; the one the key would act on is lit and the rest are
  dimmed. One alone is lit wherever you look: the E is on screen, so the E works.
- **The hint** rides the prop at chest height and slides to the edge of the
  screen when the prop is beside or behind you, rather than vanishing while the
  key still works.

**Easing is the consumer's too**, and it matters more than it sounds: the last
key of a dance is nothing like the pose the dancer stands in, and neither is the
first. `PropScript` eases every bone either side drives over `EASE_SECONDS`
(0.35 s), from wherever it is that instant — part-way through an earlier ease
included, so pressing E twice in a hurry never snaps. Where a run's bones go
back to is captured when its first clip starts: bind, the manifest's pose, a
`rigs` entry on top, a slider dragged since — whatever rest was.

**The pose he waits in is part of the asset.** The rig's bind pose is an A-pose,
arms 41° out from his sides, which reads as a shop dummy. Four numbers — both
upper arms swung in 33° about Y, a few degrees of elbow — put his arms down and
his briefcase at his side. They were dialled here (`/?debug`, the Rig sliders)
and live in the manifest, which the producer keeps across re-exports: it
rewrites everything it measures and carries `pose`, `solid` and the volumes
over from the manifest it is replacing.

`tests/actions.mjs` is the proof: reach ends 2.00 m from his bounds, the first
frame after E has moved his arm under a degree, a second E brings him home to
within 0.1°, a held key is one press, every area shape contains what it should,
and of two dancers the one you look at is the one that dances.
`tests/script.mjs` holds the rest of the API to the contract on a box that
plays Game of Life on its sides.

## What the runtime does

`src/main.mjs` fetches the package — manifest, clips, script — alongside the
GLB (`loadProp`), and once both are in, `PropScript` in `src/script.mjs` puts
the object on stage in a fixed order:

1. **Capture the bind pose** — every node's local rotation and position, before
   anything moves. Every delta is a delta on this.
2. **Attach** what the manifest says. g-man's head is a second skeleton whose
   armature is a *sibling* of the body's, not a child of its spine, so bending
   the body would leave the head hanging in space. `rig.attach` names the
   armature (`gman_high_ARM.001`) and the bone to hang it off
   (`ValveBiped.Bip01_Spine4_gman_high_ARM`); the loader reparents it with its
   bind world transform preserved, measured against the host's *bind*, never a
   pose. The producer measured that trap and wrote it down; this side does what
   the entry says, by exact name, and nothing more.
3. **The manifest's own pose**, if it has one — a `PropRig`, write-once, same as
   a `rigs` entry.
4. **The scene manifest's `rigs` entry** for the placement, if any, on top — with
   a warning if the package has clips, since a clip rewrites its bones every
   frame and the pose only survives on bones the clip leaves alone.
5. **Collision is baked**, and the `_col` and volume meshes hidden.
6. **The script runs.** Its default export is called with `object`, once;
   whatever it offers is handed to `src/actions.mjs`. Every clip the manifest
   lists was fetched up front with it, so `play` binds a `ClipPlayer` on the
   spot — the key is answered on the frame it is pressed, not a fetch later.
   `ClipPlayer` matches every pattern, keeps each node's captured bind
   rotation, reads the character's axes off the pelvis, spine top and thighs,
   and from then on is ticked from the game loop on the same clamped step as
   the player: slerp between the two neighbouring keys, `delta × bind` onto
   every matched node, the pelvis's travel turned through its parent's frame.
   A clip that does not loop holds its last key.

A script is fetched as text and imported from a Blob, so a copy dropped in again
is the one that runs on the next reload, and only a script served from this
site is run: a script is code with the page's rights, and the ones that run are
the ones this repo ships.

**Collision is the one thing a moving prop must not have.** `addPropCollision`
bakes world-space triangles into the static collider once, from whatever pose
the mesh is in at load; a dancer would leave a statue of his first frame
standing in the room. The manifest says `solid: false`, `propIsSolid` reads it
after the placement's own word (an anchor's `solid` custom property still
wins), and the log line says where the answer came from. An animated prop that
must block ships a `_col` stand-in the clip does not move.

`tests/anim.mjs` places the dancer from the test, through the same `loadProp`,
sets his action off by hand, and checks all of it: the clip ticks, the head
rides Spine4 at its bind distance, the pelvis walks, nothing joins the collider,
and a one-off clip ends with him back at rest.

## Placing one

Copy the folder in, import the GLB *inside* it, export from Blender. The steps
are in BLENDER_SCENE.md under "Adding an animated prop"; what matters here is
what the export writes:

```json
{ "name": "g-man-dance_01",
  "glb": "./assets/g-man-dance/g-man-dance.glb",
  "manifest": "./assets/g-man-dance/g-man-dance.manifest.json",
  "pos": [...], "rot": [...], "scale": [...] }
```

`manifest` is found on disk at export time — `<stem>.manifest.json` beside
`<stem>.glb` — and never stored on the anchor, so the `.blend` carries one
property per prop and a package an asset becomes later is picked up by the next
export. The manifest names the script. A hand-written entry in
`manifest.props` takes the same `manifest` field.

## The sit pose, and why those numbers

`g-man-sit.manifest.json` holds eleven bone triples, and four of them are not
obvious. They were dialled on the debug panel's Rig sliders (`/?debug`) and
pasted back with its Copy button — the same loop `fog` and `surface` use — so
this is the record of what the sliders were actually solving.

Angles are deltas on the bind pose, in each bone's own frame. On a ValveBiped
rig +X runs down the bone, so **Z is the hinge** (hip flex, knee, ankle), **Y
swings sideways** (hip abduction), **X twists**.

- **The big X twist on the thighs is external hip rotation, and it is not
  decoration.** Without it the knee hinge stays in a vertical plane, and folding
  the calf drives the shin down *through the floor* instead of back along it.
  That rotation is the whole trick of a cross-legged sit.
- **The legs are near-mirrors but deliberately not exact.** The right is 5° more
  twisted and 11° less flexed, which is what tucks its shin *behind* the left
  instead of through it. Mirroring the left exactly puts both ankles in the same
  5 cm of space.
- **Both forearms carry a big twist about their own length.** That is what rolls
  the palms over onto the knees instead of leaving them edge-on — the difference
  between sitting and merely being folded up.
- **`offset` is metres on the prop root, and it belongs to the pose.** Sitting
  puts the hips ~1 m below where standing left them. That metre is the pose's,
  not the layout's, so it travels with the asset: move him in the `.blend` and it
  still holds.

`hide` drops the briefcase. It is rigidly weighted to his right hand, so with
both palms on his knees it would sit in his lap — and he is meditating, not
doing paperwork.

## Two g-men, two folders

`g-man-sit_01` sits in the tent; `g-man-dance_01` dances beside him. They are
the same model, they arrive the same way, and they are deliberately **not** the
same file:

| placement | folder | root node | its package says |
|---|---|---|---|
| `g-man-sit_01` | `assets/g-man-sit/` | `g-man-sit_root` | a pose — sukhasana, briefcase hidden, solid; no script |
| `g-man-dance_01` | `assets/g-man-dance/` | `g-man-dance_root` | a pose to wait in, and a script offering `dance`, which plays `keep_it_gangsta_3` once on E; not solid |

The copy costs ~1 MB of download and buys an unambiguous scene. Adoption in
`tools/export_scene.py` works out which file a hand-imported payload came from
by node names, and two copies carrying the same names would match both; each
wraps its payload in one extra root node named for the asset, and the exporter
prefers the file with nothing left over. So re-importing either g-man lands on
its own folder, and neither package can migrate onto the other.

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

- **One key, one action at a time.** A prop offers the first action its script
  offers, unless the area you are standing in names another, and one run at a
  time: setting off another stops the first. A script cannot see the player,
  the collider or another prop — those would be members of a later script API,
  added in the contract when an asset needs one.
- **Pose and clip on the same bone: the clip wins**, every frame. Give a dancer
  a `rigs` entry only for bones the clip does not touch, and expect the warning.
- **The kit's build drops armatures.** See above; the object is copied, not
  built.
- **`hide` still applies.** The briefcase is rigidly weighted to g-man's right
  hand. The dancer carries it, because his manifest does not hide it; the
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
- **Procedural** — a script's `on('tick')` is the place for it once the API
  grows a member that writes a bone; today a script plays clips, not joints.

---

Background: `0012f18`, `c744a5f` and `59c7ca7` established the export-side
naming and merge behaviour; the script convention landed across all three repos
on 2026-09-15, and actions across the same three on 2026-09-21. On 2026-09-23 the
script became code and what the object is moved into a manifest beside it.
