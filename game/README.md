# de_dust2 — PlayCanvas FPS

A first-person shooter built on the [PlayCanvas](https://playcanvas.com) engine, set on
the classic Counter-Strike map **de_dust2**.

![spawn](https://example.invalid) <!-- run it and see :) -->

## Run it

The game is pure static files (engine is vendored in `lib/`), so any static server works:

```bash
cd game
npm start          # python3 -m http.server 5173
# then open http://localhost:5173/
```

Click **Play** to lock the mouse and start. Press **Esc** to release the mouse (pauses).

### Controls

| Key | Action |
|-----|--------|
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| Left Click | Shoot (full-auto) |
| `Shift` | Sprint |
| `Space` | Jump |
| `R` | Reload |
| `T` | Teleport to a random spawn point |
| `` ` `` | Toggle the debug tweak panel |
| `V` | Cycle view: textured → wireframe → collision-normals |
| `Esc` | Release mouse |

### Debug panel

Press `` ` `` for a right-side panel with live diagnostics:

- **Readouts** — position, grounded state, vertical speed, current view mode.
- **View / `V`** — switch the map to a collision-normals overlay (green = walkable
  floor, amber = slope, red = wall).
- **Controller sliders** — gravity, jump, walk/run speed, capsule radius, step
  height, tweakable live while you play (purely diagnostic; nothing changes unless
  you drag a slider).
- **Atmosphere (fog)** — type (`off` / `linear` / `exp` / `exp2`), colour, and the
  distances that drive it: `start`/`end` for linear, `density` for the exponential
  modes. All four stay live, so you can switch type without re-dialling numbers.
  The viewmodel camera is exempt, so the gun never hazes over.
- **Map surface** — `roughness` (0 = mirror, 1 = chalk), `specular` (scales the
  dielectric reflectance; 0 removes the sun glint entirely) and `metalness`,
  applied to all 34 of the map's materials at once.
- **Lighting** — sun intensity/pitch/yaw, fill intensity, ambient level, sky colour.
- **Teleport spawn** — drop back at the spawn point.

Dial a look you like, then copy the numbers into the `fog` / `surface` blocks of
`scene.manifest.mjs` to make them the new defaults.

Red dummies are scattered around the map — shoot them for points. They respawn elsewhere.

## How it works

| File | Responsibility |
|------|----------------|
| `index.html` | Canvas, HUD, crosshair, start overlay, import map |
| `standalone/main.mjs` | Engine bootstrap, GLB load, lighting, spawn-finding, targets, input, game loop |
| `src/atmosphere.mjs` | Distance fog + the map's PBR surface response (shared by both builds) |
| `src/collision.mjs` | Triangle-soup collider: uniform XZ grid, closest-point-on-triangle, grid-walked ray/triangle |
| `src/player.mjs` | Capsule collide-and-slide controller (gravity, jump, stair-stepping, resting-hold, ground-glue, mouse-look) |
| `src/weapon.mjs` | Procedural AK viewmodel, hitscan, recoil/spread, muzzle flash, tracers, impact FX |
| `src/debug.mjs` | Debug tweak panel: view modes, live readouts, live controller sliders |

**No physics engine / WASM** — collision is a custom sphere-discretised capsule vs. the
map's triangle mesh, so the whole thing is plain JS + one engine file + one `.glb`. It runs
fully offline once served.

### The map

The source asset is an OBJ export of de_dust2 (Source-engine units, Z-up). It was converted
to a self-contained binary glTF with:

```bash
# textures: the .mtl's .tga refs were rewritten to the provided .png versions
npx obj2gltf -i de_dust2.obj -o assets/de_dust2.glb --binary
```

At load it's rotated -90° about X (Z-up → Y-up) and scaled by `MAP_SCALE` (0.025) to roughly
human proportions (~112 m across). Collision triangles are extracted from the loaded mesh in
world space and indexed into a 2 m grid.

### Assets

Raw downloads and scans are not what ships. `assets/source/` holds the originals
exactly as they arrived; `npm run assets:build` turns them into the files the
game loads:

```bash
cp ~/Downloads/statue.glb assets/source/
npm run assets:build            # only processes what changed
npm run assets:build -- --dry   # report, write nothing
npm run assets:build -- --force # reprocess everything
```

```
assets/source/statue.glb   ← raw, never modified, NOT in git
        ↓  tools/build_assets.py (headless Blender)
assets/statue.glb          ← textures resized + WebP, decimated to budget; tracked, ships
```

Budgets live in `assets/assets.config.json` — 1024 px textures, 20k triangles,
WebP quality 85 by default, overridable per asset. The step is content-addressed,
so it is a no-op unless a source file or its settings changed. **Moving props
around never triggers it**: placement lives in `scene.placements.json` and is
written by `npm run scene:export`, which touches no geometry.

`tent_military.glb` went 9.8 MB → 1.1 MB and 38,544 → 19,998 triangles through
this, with no visible difference at play distance.

Textures come out as WebP rather than KTX2 deliberately. KTX2/Basis is the
better answer for texture *memory*, because it stays compressed on the GPU — but
it needs a WASM transcoder vendored into `lib/` and an encoder binary on the
build machine, neither of which is here. WebP is decoded by the browser, the
engine already reads `EXT_texture_webp`, and Blender exports it directly. Revisit
KTX2 when GPU memory rather than download is the binding constraint.

Two things decimation cannot fix, worth knowing before you lean on it:

- Collapsing a mesh discards detail a normal map would have carried. Invisible on
  marketplace props at these ratios; **not** invisible on photogrammetry, where a
  20:1 collapse without baking a normal map from the original reads as soft. Bake
  first, or raise that asset's budget.
- Sources stay out of git on purpose (`assets/source/` is ignored) — scans bloat
  a repo permanently and irreversibly. Keep them on a drive or in cloud storage.

### Pictures

Drop an image in `assets/source/pictures/` and the same build turns it into a
placeable slab. No new command, and no engine code knows pictures exist:

```bash
cp ~/Downloads/kremlin_1904.jpg assets/source/pictures/
npm run assets:build
# -> assets/picture_kremlin_1904.glb — now place it in Blender like any prop
```

```
assets/source/pictures/kremlin_1904.jpg   ← raw photo, NOT in git
        ↓  tools/build_assets.py
assets/picture_kremlin_1904.glb           ← 12 tris, WebP texture; tracked, ships
```

The slab is a box, 1.4 m tall and 3 cm thick by default, with the image unlit on
the front face and a dark matte mount on the edges and back. Four things it
decides for you:

- **Width follows the image's pixel aspect**, so nothing is ever stretched and
  there is no aspect convention to remember. You author `height` only.
- **The origin sits on the centre of the back face**, not the middle of the slab.
  Snap the anchor Empty to a wall and the picture stands proud of it by its
  thickness — no half-depth offset to work out, nothing buried in the masonry.
- **It faces Blender −Y**, the direction the front view (numpad 1) looks from, so
  an unrotated picture faces you the moment you import it.
- **It never collides** — the mesh is named `*_nocol` (see below). The wall it
  hangs on already stops you, and a picture you can bump into is one you can get
  wedged against.

Override per picture in `assets/assets.config.json` under its filename —
`{"kremlin_1904.jpg": {"height": 2.4, "maxTexture": 2048}}` for a hero piece.
Defaults live in the `pictureDefaults` block.

Unlit rather than lit is deliberate: this level is dusk-lit with a fast fog
falloff, and a lit picture on a wall the sun does not reach is a muddy grey
rectangle you cannot read. It exports as `KHR_materials_unlit`, which the engine
reads natively.

The reason a picture is a GLB at all — rather than the `paintings` runtime loader
that `scene.manifest.mjs` still has a stub for — is that ~1 KB of glTF wrapper
makes it indistinguishable from a prop to everything downstream. It inherits
WYSIWYG Blender placement, one-line diffs in `scene.placements.json`, per-URL
container dedup (hang the same picture twice, download it once), the collision
opt-outs, and the `tests/perf.mjs` budget. The runtime path would have cost a
code path in *both* entry points, a new authoring convention, and its own test.

### Props and collision

Placed props are **solid by default** — their geometry joins the collider as they
load, so you walk into them and shoot them like the map. Three opt-outs:

- **Whole prop** — `solid: false` on its placement entry, or a `solid` = `0`
  custom property on the Blender anchor.
- **One mesh inside a prop** — end the object's name with **`_nocol`**. It still
  renders and still casts a shadow; collision just never sees it. This is for
  thin geometry you would otherwise snag on: a tent's guy-ropes and pegs should
  be `_nocol` while the fabric body stays solid.
- **The whole prop's collision, replaced** — a mesh named **`_col`** is
  collision-only: never drawn, never a shadow caster, and it collides *instead
  of* every visual mesh in that prop.

Bought props rarely name their ropes — they arrive as one welded mesh. Two
per-asset settings in `assets/assets.config.json` do the naming for you:

| setting | does |
|---|---|
| `nocolMaxSpan: 0.5` | splits thin shells into `*_nocol` — 12,660 of the tent's 19,998 triangles, guy-ropes included |
| `collisionProxy: "hull"` | hulls each remaining shell into a `*_col` stand-in — the tent collides as **1,384** triangles instead of 7,338 |

The proxy is the bigger win and the blunter tool: convex shells cannot hold a
dent, so a recessed doorway gets bridged. See BLENDER_SCENE.md for when to skip
it.

See BLENDER_SCENE.md for the authoring side. Collision triangles carry a `prop`
tag, so `collider.raycast(...).tri.prop` answers "what did I just hit?".

Props stream in after the map — the level is playable before a heavy GLB has
landed — so their triangles join a collider that already exists rather than
forcing a rebuild. The grid's bounds are fixed at construction for that reason;
see `TriangleCollider.add`.

### Serving it

Enable gzip or brotli on whatever hosts this. It is the single largest win
available and costs one server setting: the engine alone goes 3.4 MB → 0.5 MB
brotli'd. Minifying the engine on top of that saves a further ~150 KB and costs
readable stack traces, which is why `lib/playcanvas.mjs` is the unminified build.

## Tests

Headless Playwright smoke tests (require `npx playwright install chromium`, software WebGL):

```bash
node tests/smoke.mjs   # boots the page, asserts no errors, reports tri/floor counts
node tests/look.mjs    # screenshots a yaw sweep -> /tmp/dust2_yaw_*.png
node tests/fire.mjs    # drives the shooting loop, asserts ammo/recoil/target-hit
node tests/raycast.mjs # grid broadphase vs. a full triangle sweep, must agree exactly
node tests/props.mjs   # props are solid; `_nocol` is not, and `_col` is all that is
node tests/perf.mjs    # per-frame draw calls / triangles + budget check (exit 1 = over)
```

`perf.mjs` runs against a real GPU (ANGLE Metal) and counts the actual WebGL
command stream, splitting the frame into camera passes vs. the sun's shadow pass
by A/B-ing `castShadows`. It reports work submitted rather than frame times on
purpose — headless Chrome's present path dominates wall-clock timings and makes
them useless, whereas draw-call and triangle counts are exact and are what a
weak GPU actually chokes on.

It also **fails when the scene goes over budget**, which is the point of having
it: cost creeps in one prop at a time and nobody notices until the level is
finished and slow. The ceilings live in the `BUDGET` block at the top of the
file — draw calls, triangles per frame, triangles per prop, and total download.
They are aimed at a mid-range laptop on an integrated GPU reached over a public
link. Raise one only as a deliberate decision, not to make a red build green.

## Tuning

Most feel knobs live at the top of their modules:

- Movement: `Player` constructor opts in `src/main.mjs` (`walkSpeed`, `runSpeed`, `gravity`,
  `jumpSpeed`, `stepHeight`).
- Map scale / orientation: `MAP_SCALE`, `MAP_EULER` in `src/main.mjs`.
- Weapon: stats block in `src/weapon.mjs` (`fireInterval`, `magSize`, `range`, `reloadTime`).
- Lighting: `sun` / `fill` / ambient in `standalone/main.mjs`.
- Fog + map surface: the `fog` / `surface` blocks in `scene.manifest.mjs`, applied by
  `src/atmosphere.mjs`. Note that `surface.roughness` is authored as **roughness**, not
  as PlayCanvas's `gloss` — glTF-imported materials carry `glossInvert = true`, so
  writing `gloss` directly means the opposite of what it reads like. That inversion is
  what used to make the map's sandstone reflect the sun like polished plastic.
