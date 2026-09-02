# de_dust2 — PlayCanvas FPS

A first-person shooter built on the [PlayCanvas](https://playcanvas.com) engine, set on
the classic Counter-Strike map **de_dust2**.

![spawn](https://example.invalid) <!-- run it and see :) -->

## Run it

The game is pure static files (engine is vendored in `lib/`), so any static server works:

```bash
cd game
npm start          # python3 -m http.server 5173
# then open http://localhost:5173/          production
#           http://localhost:5173/?debug    same game + the tweak panel
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
| `Esc` | Release mouse |

### Debug mode

The tweak panel lives on its own URL. `/` is the production build and has no
panel, no sliders and no way to reach them — it doesn't even fetch
`src/debug.mjs`. Add `?debug` (or open `/debug.html`, which redirects there) and
the same game comes up with the panel open:

```
http://localhost:5173/          production
http://localhost:5173/?debug    production + the tweak panel
http://localhost:5173/debug.html
```

There is one page, not two: `debug.html` is a four-line redirect, and the flag is
read by `src/debugmode.mjs`. The Editor build reads the same flag — append
`&debug` to the launch URL. `tests/debug.mjs` asserts both halves, so a slider
that leaks back into production fails the build rather than shipping.

In debug mode, `` ` `` toggles the panel and `V` cycles the view mode. What's in it:

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
| `index.html` | Canvas, HUD, crosshair, start overlay, import map — production, no debug markup |
| `debug.html` | Redirect to `/?debug`, so debug mode has a URL you can type |
| `standalone/main.mjs` | Engine bootstrap, GLB load, lighting, spawn-finding, targets, input, game loop |
| `src/atmosphere.mjs` | Distance fog + the map's PBR surface response (shared by both builds) |
| `src/collision.mjs` | Triangle-soup collider: uniform XZ grid, closest-point-on-triangle, grid-walked ray/triangle |
| `src/player.mjs` | Capsule collide-and-slide controller (gravity, jump, stair-stepping, resting-hold, ground-glue, mouse-look) |
| `src/weapon.mjs` | Procedural AK viewmodel, hitscan, recoil/spread, muzzle flash, tracers, impact FX |
| `src/debugmode.mjs` | The one rule for what counts as a debug URL, read by both builds |
| `src/debug.mjs` | Debug tweak panel: view modes, live readouts, live sliders — its own CSS and markup, loaded only in debug mode |

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

Assets are **not built here**. They arrive finished, and `assets/*.glb` is
tracked delivery — which is why this repo needs no Blender to run, serve or
deploy. Building them is the job of the **singularity-developement-kit**:

```
~/Downloads/statue.glb          ← raw, never modified
        ↓  singularity-developement-kit: npm run build
dist/statue.glb                 ← textures resized + WebP, decimated, collision sorted
        ↓  copy
game/assets/statue.glb          ← tracked here, place it in Blender like any prop
```

```bash
cp ../../singularity-developement-kit/dist/statue.glb assets/
```

That kit holds the pipeline, the budgets, a browser viewer that shows what the
collider actually gets, and `ASSET_CONTRACT.md` — the standard every `.glb` in
`assets/` keeps. Check one from anywhere:

```bash
node ../../singularity-developement-kit/test/contract.mjs assets/tent_military.glb
```

`tent_military.glb` went 9.8 MB → 1.17 MB and 38,544 → 19,998 triangles through
it, with no visible difference at play distance, and collides as 1,252.

**Copying by hand rather than depending on the kit is deliberate.** There is one
pavilion, so a submodule or a published package would be version-pinning
ceremony around a `cp`. It also keeps the dependency pointing one way: an asset
never learns which pavilion it is going to.

What stays on this side, because it is this pavilion's business and not an
asset's: where a prop stands (`scene.placements.json`), the lighting and fog,
the Z-up → Y-up axis correction the engine wants, and the per-frame budgets
`tests/perf.mjs` enforces. Moving props around never touches geometry.

Two things decimation cannot fix, worth knowing before you lean on it:

- Collapsing a mesh discards detail a normal map would have carried. Invisible on
  marketplace props at these ratios; **not** invisible on photogrammetry, where a
  20:1 collapse without baking a normal map from the original reads as soft. Bake
  first, or raise that asset's budget in the kit.
- Raw sources live with the kit, not here — scans bloat a repo permanently and
  irreversibly. Keep them on a drive or in cloud storage.

Textures arrive as WebP rather than KTX2 deliberately. KTX2/Basis is the better
answer for texture *memory*, because it stays compressed on the GPU — but it
needs a WASM transcoder vendored into `lib/` and an encoder binary on the build
machine, neither of which is here. WebP is decoded by the browser, the engine
already reads `EXT_texture_webp`, and Blender exports it directly. Revisit KTX2
when GPU memory rather than download is the binding constraint.

### Pictures

A picture is a GLB like any other prop — but it is **not built here**. Building
one used to mean a headless Blender run to decode a jpg, resize it and write out
a hardcoded 8-vertex box, which is a 1 GB desktop install doing work a browser
does natively. That moved out to a standalone app, **frames-for-artwork**:

```
kremlin_1904.jpg          ← drag it into the app
        ↓  frames-for-artwork (browser, no build step)
picture_kremlin_1904.glb  ← drop in assets/, place in Blender like any prop
```

Nothing on this side changed. The GLB it emits declares `KHR_materials_unlit`
and `EXT_texture_webp`, is named `picture_*` so the scene exporter names its
anchor after it, and carries a `*_nocol` mesh so it never collides. Those are
rules in the kit's `ASSET_CONTRACT.md`, which both builders answer to — the
`picture_*` prefix is a promise about behaviour, and `npm run check` enforces
it whoever wrote the file. `assets/picture_*.glb` here were built by the old
Blender path and pass unchanged.

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

Height is the one thing you author, in the app, before you download.

Unlit rather than lit is deliberate: this level is dusk-lit with a fast fog
falloff, and a lit picture on a wall the sun does not reach is a muddy grey
rectangle you cannot read. It exports as `KHR_materials_unlit`, which the engine
reads natively.

Unlit is not quite the whole story, though: the engine's unlit hook moves the
image into `emissive` and leaves `diffuse` white, and ambient light is still
added on top of a white diffuse. That put a flat ~0.24 of linear light under
every pixel — blacks came out at 134/255 and the picture read as washed out.
`unlitIgnoreAmbient` in `src/world.mjs` zeroes the diffuse on any unlit material
a prop ships, which multiplies that term away. Fog is left alone on purpose, so a
picture across the map still hazes with everything around it.

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

Bought props rarely name their ropes — they arrive as one welded mesh. The
naming is done for you at build time, by two per-asset settings in the kit's
`assets.config.json`:

| setting | does |
|---|---|
| `nocolMaxSpan: 0.5` | splits thin shells into `*_nocol` — 12,660 of the tent's 19,998 triangles, guy-ropes included |
| `collisionProxy: "dissolve"` | merges near-flat faces into a `*_col` stand-in — the tent collides as **1,252** triangles instead of 7,338 |

`collisionProxy` also takes `"hull"`, which is cheaper still but replaces each
shell with its convex hull — and a convex shell cannot hold an opening, so it
bricks up doorways. Use it for props you walk around, not into. BLENDER_SCENE.md
has the measurements.

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

### Deploying

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every
push to `main`. There is no build step — the game is already static files, so
the workflow uploads `game/` as-is. Deploying through Actions rather than
"deploy from a branch" is deliberate: it skips Jekyll, which would otherwise
mangle `.mjs` modules.

Live at **https://history.singularitymuseum.com**;
`self-reality.github.io/histoty-pavilion/` redirects there. Do not add a `CNAME`
file to set that up — the usual advice does not apply to Actions-published
sites. Tested: a deploy carrying `game/CNAME` left the domain unset. The domain
lives in repo settings only (Settings → Pages, or `PUT /repos/:o/:r/pages` with
`cname`), and a `CNAME` file next to `index.html` would just be published as a
stray file at `/CNAME`.

DNS is a `history` → `self-reality.github.io` CNAME record at Porkbun, which
holds `singularitymuseum.com`. Note the apex already points at a *different*
Pages site, so leave its `A` records alone.

Pages already gets the hosting details right for us: `.mjs` is served as
`text/javascript`, `.glb` as `model/gltf-binary`, everything with
`Access-Control-Allow-Origin: *` — which is what lets the Editor build pull the
textured map straight off this deploy (see `mapUrl` in `src/game.mjs`). It
gzips the engine to 770 KB but does **not** offer brotli, so the 0.5 MB figure
above needs a different host to collect.

## Tests

Headless Playwright smoke tests (require `npx playwright install chromium`, software WebGL):

```bash
node tests/smoke.mjs   # boots the page, asserts no errors, reports tri/floor counts
node tests/look.mjs    # screenshots a yaw sweep -> /tmp/dust2_yaw_*.png
node tests/fire.mjs    # drives the shooting loop, asserts ammo/recoil/target-hit
node tests/raycast.mjs # grid broadphase vs. a full triangle sweep, must agree exactly
node tests/props.mjs   # props are solid; `_nocol` is not, and `_col` is all that is
node tests/debug.mjs   # panel + sliders on ?debug, none of it on the production URL
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
