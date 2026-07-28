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
1. ~~**Create `game/scene.manifest.mjs`**~~ — done. `map`, `sky`, `glass[]`, `targets`, `props`,
   `paintings`, plus a `placements` pointer at the Blender-authored layout.
2. ~~**Wire `standalone/main.mjs`** to read the manifest~~ — done.
3. ~~**Naming + custom-property convention**~~ — done, and simpler than planned: an Empty
   with a `glb` custom property is a prop, one without is a marker (`spawn_*`, `painting_*`).
   Any other custom property rides through to `extras` in the JSON, so conventions can be added
   without touching the exporter. Blender Custom Properties → glTF `extras` was not needed —
   props stay separate GLBs and only their transforms are exported.
4. ~~**Headless exporter**~~ — done, split in two (`npm run scene:build` / `scene:export`), and
   it does **not** re-export a GLB. See **Layout, not geometry** below. Geometry-Nodes scatter
   still needs realizing before export if/when we use it.
5. **Loader binding** — partly done. Props load and place from `scene.placements.json`; the
   marker channel (`spawn_*`, `painting_*`) is exported but nothing consumes it yet. Behaviour /
   animation binding by name is still open. `world.mjs`'s runtime-derived floors/spawns are
   untouched and still drive the player spawn.

## Layout, not geometry (decided during task 4)
The exporter writes **`scene.placements.json`** — name + transform per prop — and nothing else.
Props stay as their own GLBs in `assets/`; the game loads each URL once and instantiates per
placement. Consequences:

- Moving a prop is a **one-line diff**, not a re-baked 10 MB binary.
- **No git-LFS needed.** `scene/pavilion.blend` is gitignored: it is 10 MB of imported GLB
  payload used purely for WYSIWYG placement, and `npm run scene:build` regenerates it from
  `scene.manifest.mjs` + `scene.placements.json`. That loop is a verified byte-identical no-op,
  so the `.blend` is a cache, not an artifact.
- The tracked truth stays two small text files. Claude-legible, as intended.

Day-to-day workflow, conventions and gotchas: **`BLENDER_SCENE.md`**.
Axis conversion (Blender Z-up ↔ PlayCanvas Y-up, both directions): `tools/pc_axes.py`.

## Collaboration setup (scene-builders)
- Shared **Blender Asset Browser library** folder of ready-made GLB/.blend assets (drag-drop, no modeling).
- **One `.blend` per area, one owner per file** (no live co-edit). ~~git-LFS~~ — not needed, see above.
- Builders only place + run export; PRs review the `scene.placements.json` diff.

## Constraints / non-goals
- Do **not** break the standalone build; do **not** delete the Editor path yet.
- No runtime switch (stay on PlayCanvas engine).
- Watch GLB polycount/size when scattering (stones on floors/walls).

## Still open
- `src/game.mjs` (the Editor build) does not read `placements` yet — only the standalone build does.
- Nothing consumes `markers[]`; wiring `spawn_*` into `world.mjs` is the obvious next use.
- One `.blend` per area (currently a single `pavilion.blend`) once more than one person builds.
