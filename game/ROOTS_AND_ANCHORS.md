# Roots, Empties and anchors

Why a prop can come out of Blender standing on its head, what the `*_root` node
in a GLB is for, and who is responsible for which rotation.

Written after `cisterna_01` shipped pitched onto its face (fixed in `0012f18`).
The companion doc is [BLENDER_SCENE.md](BLENDER_SCENE.md), which tells you what
to *do*; this one tells you why it works.

---

## 1. The cast

Four things get called "the root" in conversation, and they are not the same
thing. Naming them is most of the battle.

| name | what it is | where it lives |
|---|---|---|
| **anchor** | an Empty holding a `glb` custom property | authored by you, in `SCENE` |
| **payload** | the imported geometry, parented under the anchor | a copy of the GLB, for looking at |
| **payload root** | the single parentless object of that payload | comes from the GLB |
| **GLB root node** | the one top-level node in the file | written by the asset kit |

The last two are the same thing on either side of an import. The asset kit
guarantees a GLB has **exactly one** top-level node — that rule is an *error* in
its contract, not a warning — so a payload has exactly one root, and a prop is
one prop.

The whole arrangement exists for one reason: **the game never loads your
Blender file.** It loads the GLB and applies the anchor's numbers to it. The
payload in Blender is a stand-in so you can see what you are placing. That is
why only the anchor's transform is exported, and why moving the mesh instead of
the Empty does nothing.

```
  Blender (what you author)             Game (what actually runs)

  SCENE
   └── cisterna_01          ← anchor     Entity "cisterna_01"
        └── cisterna_root   ← payload     └── instantiate(cisterna.glb)
             ├── cisterna       root           ├── cisterna
             └── cisterna_col                  └── cisterna_col

  exported: the anchor's transform      applied: that transform, to a fresh
  and its `glb` property, nothing else  copy of the file. The payload above
                                        is never exported — it is scenery.
```

## 2. The rule everything follows

> **The anchor carries the placement. Nothing else.**

The GLB already knows how to hold itself up — its own node rotations do that,
and the game gets them for free when it instantiates the file. So whatever
rotation the payload carries *because it came out of a GLB* must be kept off the
anchor. Put it on the anchor as well and it gets applied twice: once by the
anchor, once by the file. The prop looks right in Blender and wrong in game.

That is the entire bug class. Everything below is detail about one question:
**how much of the payload's rotation is the file's, and how much is yours?**

## 3. Where the axis conversion actually lives

glTF is Y-up. Blender is Z-up. Something, somewhere, has to rotate by 90° about
X to reconcile them — and *where that rotation sits differs from file to file*.
This is the part that is easy to assume and costly to get wrong, so here it is
measured, by importing each shipped asset into an empty Blender scene:

| file | payload root | root's rotation | first child's rotation |
|---|---|---|---|
| `tent_military.glb` | `Sketchfab_model` | **−90° X** | +90° X (cancels it) |
| `g-man.glb` | `Sketchfab_model` | **−90° X** | +90° X (cancels it) |
| `cisterna.glb` | `cisterna_root` | **none** | **+90° X** |

Both shapes are legitimate, and both files are correct. Sketchfab wraps its
downloads in a root that carries the conversion; the asset kit's `*_root` is a
bare Empty at the origin with no transform at all, so the conversion stays down
on the meshes.

So there is no constant to subtract. **The conversion has to be measured, per
file, on the node you are actually looking at.** `importer_rotation()` in
`tools/export_scene.py` does exactly that: it imports a throwaway copy of the
GLB, reads the rotation off the matching node, and deletes the copy.

## 4. What went wrong with the cistern

The `.blend` held a cistern imported from an **older** `cisterna.glb` — one from
before the asset kit added the `*_root` wrapper, which had `cisterna` and
`cisterna_col` as two separate top-level nodes. The kit fixed the file on 8 Sep;
the `.blend` kept the stale import. So in the scene those two meshes sat loose
at the top level with no root above them, each carrying its own +90° X.

Adoption then made two mistakes, both from the same assumption:

**It measured the wrong node.** `importer_rotation()` only ever looked at the
payload's *root*. It imported a probe copy of the current `cisterna.glb`, found
`cisterna_root`, and read **identity** off it — while the thing actually being
adopted was `cisterna`, a child carrying **+90° X**. Nothing was subtracted, the
+90 stayed on the anchor, and the game applied it a second time on top of the
file's own. Hence upside down.

**It adopted the same prop twice.** Two loose objects meant two adoption passes.
Both resolved to `cisterna.glb`, both wanted the name `cisterna_01`, and Blender
handed the second one `cisterna_01.001`. The whole GLB — geometry, collision
proxy and all — loaded twice at one spot.

```
  written                       should have been
  euler [90.01, 90.04, 0.01]    euler [ 0.00, 90.04, 0.00]
         -----                          ----
         the file's +90 X,              nothing; the file
         left on the anchor             supplies it already
         and applied twice

  plus a second prop, cisterna_01.001, at the identical transform
```

## 5. What the fix changed

Two things in `tools/export_scene.py`:

- **Measure the node being adopted, in world space** — not always the root. For
  a root that is the importer's rotation; for anything deeper it is that plus
  whatever the file stacks above it. Same node on both sides of the probe.
- **One anchor per placement.** Anchors are keyed by `(glb, anchor matrix)`, so
  two loose objects that resolve to the same file *and* the same anchor become
  one prop. That is what puts a dismembered payload back together. Genuine reuse
  of a GLB is untouched: two crates set apart differ in the transform, so they
  key apart. The export prints `merged X -> Y` when it happens.

## 6. How to tell if this is biting you

- A prop is pitched exactly 90° (or 180°) off, in game but **not** in Blender.
  That asymmetry is the signature — Blender is showing you the payload, the game
  is showing you anchor × file.
- The export prints `merged X -> Y` for something you expected to be two props.
- A placement named `*.001` in `scene.placements.json`.
- `npm run scene:export` reports more props than you think you placed.

The underlying cause is almost always the same: **a payload in the `.blend` that
no longer matches the GLB on disk.** Re-import the prop and the question goes
away.

---

# Does the asset kit need changes?

**No — for this, it is already correct, and it got there first.**

`singularity-development-kit` commit `5c4289a` ("Assets: give a prop exactly one
root node", 8 Sep) added `single_root()` to `tools/build_assets.py`: when a build
would leave two top-level objects, it wraps them in a `*_root` Empty at the
origin. The same commit made "exactly one top-level node" an **error** in
`src/contract.mjs`, deliberately, on the grounds that the receiving project is
the one that pays for it. That commit message describes the cistern's two-root
problem precisely. All three current builds satisfy it:

| file | roots today |
|---|---|
| `dist/cisterna.glb` | `cisterna_root` |
| `dist/g-man.glb` | `g-man_root` |
| `dist/tent_military.glb` | `tent_military_root` |

And the three GLBs the game actually ships all pass the kit's own check today:

```
node test/contract.mjs …/game/assets/cisterna.glb       → contract ok
node test/contract.mjs …/game/assets/g-man.glb          → contract ok
node test/contract.mjs …/game/assets/tent_military.glb  → contract ok
```

So the kit needs no code change on account of the cistern. The pavilion-side
fix was the right place for it: the exporter should not have been assuming where
a rotation lives, whoever built the file.

Two things are worth knowing anyway. Neither is a defect in the kit.

### The two repos have drifted apart

Every GLB in `game/assets/` is an **older build** than the kit's current `dist/`:

| asset | game/assets | kit/dist |
|---|---|---|
| `cisterna.glb` | 6.73 MB, 3 nodes, root `cisterna_root` | 11.83 MB, 9 nodes — adds `Toilet*`, `Venus` |
| `g-man.glb` | 0.95 MB, 167 nodes, **2 skins**, root `Sketchfab_model` | 0.79 MB, 10 nodes, **0 skins**, root `g-man_root` |
| `tent_military.glb` | 1.17 MB, 10 nodes, root `Sketchfab_model` | 1.17 MB, 5 nodes, root `tent_military_root` |

**Do not bulk-resync these.** The g-man row is the trap: the game's copy has two
skins and a full bone hierarchy, and the kit's current build has none, because
`build_assets.py` deletes armatures. That is a documented limit, stated in the
code itself:

> THE LIMIT: this is a builder for static props, and dropping every non-mesh is
> what makes that assumption load-bearing. An armature arrives, gets deleted
> here, and the mesh ships in its rest pose with no way to move. If this ever
> needs to carry skinned or animated assets, this is the pass to reopen.

`scene.manifest.mjs` poses `g-man_01` through `rigs`, which drives named bones.
Copying `dist/g-man.glb` over `assets/g-man.glb` would silently flatten the
meditation pose into a rest pose. **If animated characters are ever wanted, that
armature pass is the change the kit needs** — and it is a real piece of work, not
a flag.

The cistern row is the opposite: the kit's build is *newer and better* (decimated
to budget, refraction removed from the Venus) and the game is missing it. That
one is probably worth pulling across deliberately, on its own, with a look at it
in game afterwards.

### Nothing on the pavilion side ever runs the contract

The kit ships the check — `node test/contract.mjs <file.glb>` — and the pavilion
never calls it. A GLB dropped into `game/assets/` is accepted unchallenged, which
is how a two-root cistern got in before the rule existed.

Run over everything in `assets/` today, every prop passes and exactly one file
fails:

```
cisterna.glb                    contract ok
de_dust2.glb                    ERROR  39 top-level nodes …adopted as 39 props
g-man.glb                       contract ok
picture_data_full_hd.glb        contract ok
picture_fragile_fullhd.glb      contract ok
picture_innocent_full_hd_2.glb  contract ok
tent_military.glb               contract ok
```

**That failure is correct and must be skipped, not fixed.** `de_dust2.glb` is the
map, not a prop: it arrives through `manifest.map`, gets its own transform in
`standalone/main.mjs`, and lives in the `REF` collection, which adoption never
looks at. "One prop, one root" is a rule about props, and the map is not one. A
check that reports it every run is a check people learn to ignore, so exclude it:

```json
"assets:check": "node ../../singularity-development-kit/test/contract.mjs $(ls assets/*.glb | grep -v de_dust2)"
```

Worth doing at some point. Not urgent, because the exporter no longer trusts the
shape of what it is given — which is the more durable half of the fix.
