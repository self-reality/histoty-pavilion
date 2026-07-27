# Blender scene-authoring migration — handoff

## Context (current state)
- **Runtime:** PlayCanvas *engine* (`playcanvas` npm ^2.19), not tied to the cloud.
- Two working builds:
  - `standalone/main.mjs` — code-first, own `pc.Application`, served from `index.html`. **This is the target build.**
  - `src/game.mjs` — PlayCanvas Editor script (cloud), synced via `pcsync`.
- Shared logic in `src/world.mjs` (targets/floors/spawns built in code), `collision.mjs`, `player.mjs`, `weapon.mjs`.
- Map is an imported GLB: `assets/de_dust2.glb`, transformed in code (`MAP_SCALE=0.025`, `MAP_EULER=(-90,0,0)`).

## Goal
Move **scene construction** to Blender. Keep the PlayCanvas engine as runtime. Make the
**source of truth = GLB(s) + a git-tracked manifest** (`scene.manifest.mjs`). Blender = asset/layout
factory; git = truth; Claude-legible.

## Tasks (in order, each reversible)
1. **Create `game/scene.manifest.mjs`** — lift hardcoded constants out of `standalone/main.mjs`:
   `map {glb, scale, euler}`, `sky` color, `glass[]` (grab-pass prop names), target/spawn params.
   Add empty slots: `props: []`, `paintings: []`.
2. **Wire `standalone/main.mjs`** to import and read the manifest instead of literals. Verify the
   standalone build still runs identically (`npm start`, open `index.html`).
3. **Naming + custom-property convention** so code can bind nodes after glTF import:
   `tent_*`, `painting_*`, `spawn_*`, `glass_*`, `prop_*`. Blender Custom Properties → glTF `extras`.
4. **Headless exporter** `game/tools/export_glb.py` run via `blender -b <file>.blend -P tools/export_glb.py`
   → writes `assets/<name>.glb` **plus** `assets/<name>.placements.json` (name + world transform of
   every top-level empty/prop). Realize/apply Geometry-Nodes scatter before export.
5. **Loader binding:** after GLB load, `findByName` the named nodes and attach behavior/animation
   per the manifest. Keep `world.mjs`'s runtime-derived floors/spawns working alongside authored ones.

## Collaboration setup (scene-builders)
- Shared **Blender Asset Browser library** folder of ready-made GLB/.blend assets (drag-drop, no modeling).
- **One `.blend` per area, one owner per file** (no live co-edit). **git-LFS** for `.blend`/`.glb`.
- Builders only place + run export; PRs review the `.placements.json` diff.

## Constraints / non-goals
- Do **not** break the standalone build; do **not** delete the Editor path yet.
- No runtime switch (stay on PlayCanvas engine).
- Watch GLB polycount/size when scattering (stones on floors/walls).

## First concrete step
Generate the skeleton `scene.manifest.mjs` from current `standalone/main.mjs` constants and add the
`tent_01` entry once its transform is provided (see `EXPORT_TENT.md`).
