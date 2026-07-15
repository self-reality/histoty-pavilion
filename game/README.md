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

Press `` ` `` for a right-side panel to diagnose fall-through-the-floor spots:

- **View / `V`** — switch the map to a collision-normals overlay (green = walkable
  floor, amber = slope, red = wall). A hole in the floor shows as a green gap.
- **Falls** — every un-commanded fall is logged with the spot you fell from and
  marked in-world with a red beacon. **Copy log** copies the coordinates; they
  also persist in `localStorage` and print to the console as `[[FALL]]` lines.
- **Sweep for holes** — drops the capsule straight down onto every floor sample
  and lists any that punch through the floor plane (`settle` = a gap right under
  the sample, `tunnel` = a fast fall from height passes through). It's a vertical
  drop test, so it finds genuine gaps / thin floors but **not** falls caused by
  running off an edge or into a seam — for those, just play and read the fall log.
- **Controller sliders** — gravity, jump, walk/run speed, capsule radius, step
  height, tweakable live while you play (purely diagnostic; nothing changes unless
  you drag a slider).

Red dummies are scattered around the map — shoot them for points. They respawn elsewhere.

## How it works

| File | Responsibility |
|------|----------------|
| `index.html` | Canvas, HUD, crosshair, start overlay, import map |
| `src/main.mjs` | Engine bootstrap, GLB load, lighting, spawn-finding, targets, input, game loop |
| `src/collision.mjs` | Triangle-soup collider: uniform XZ grid, closest-point-on-triangle, ray/triangle |
| `src/player.mjs` | Capsule collide-and-slide controller (gravity, jump, stair-stepping, resting-hold, ground-glue, mouse-look) |
| `src/weapon.mjs` | Procedural AK viewmodel, hitscan, recoil/spread, muzzle flash, tracers, impact FX |
| `src/debug.mjs` | Debug tweak panel: view modes, fall tracking + beacons, hole-sweep, live sliders |

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

## Tests

Headless Playwright smoke tests (require `npx playwright install chromium`, software WebGL):

```bash
node tests/smoke.mjs   # boots the page, asserts no errors, reports tri/floor counts
node tests/look.mjs    # screenshots a yaw sweep -> /tmp/dust2_yaw_*.png
node tests/fire.mjs    # drives the shooting loop, asserts ammo/recoil/target-hit
```

## Tuning

Most feel knobs live at the top of their modules:

- Movement: `Player` constructor opts in `src/main.mjs` (`walkSpeed`, `runSpeed`, `gravity`,
  `jumpSpeed`, `stepHeight`).
- Map scale / orientation: `MAP_SCALE`, `MAP_EULER` in `src/main.mjs`.
- Weapon: stats block in `src/weapon.mjs` (`fireInterval`, `magSize`, `range`, `reloadTime`).
- Lighting: `sun` / `fill` / ambient in `src/main.mjs`.
