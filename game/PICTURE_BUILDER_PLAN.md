# Plan: extract the picture builder into a standalone browser app

## Intent

Today, turning a photograph into a placeable picture requires a headless Blender
run (`npm run assets:build`). Blender is a ~1 GB desktop app, and for pictures it
only does four things: decode an image, resize it, build a hardcoded 8-vertex
box, and write a GLB. A browser does the first two natively and better.

So: build a small standalone browser app that takes an image and produces the
same GLB, with no Blender. Drag in a photo, get `picture_<name>.glb` downloaded.

**Nothing in this game changes.** The output is byte-compatible in contract with
what `tools/build_assets.py` emits today. You drop the GLB in `game/assets/`,
place it in Blender like any prop, and the runtime lights it correctly because
the GLB declares `KHR_materials_unlit` — the same one flag Blender was emitting.
The Blender picture path stays in place and keeps working; this is an
alternative front door, not a replacement.

## Reference

The behaviour to reproduce is `game/tools/build_assets.py`, the `# ---- Pictures`
section (lines 480–635). Read it first — it documents *why* each choice is what
it is, and those reasons still hold. `picture_out_name`, `build_slab`,
`flat_material`, `mount_material` and `process_picture` are the whole spec.

## Output contract — do not deviate

Getting these wrong produces a GLB that loads but sits wrong on the wall.

| thing | value | why |
|---|---|---|
| filename | `picture_<slug>.glb` | `tools/export_scene.py:218` special-cases the `picture_` prefix when naming anchors |
| slug | lowercase, non-alphanumerics → `_`, collapse runs, strip ends | `picture_out_name`, `build_assets.py:482` |
| mesh/node name | `picture_<slug>_nocol` | `NO_COLLIDE` in `src/world.mjs:127` — the wall already stops you |
| height | 1.4 m default, authored | the edge you judge by eye |
| width | `height * (px_w / px_h)` | never stretched; no aspect convention to remember |
| thickness | 0.03 m, absolute | small and large photos mount alike |
| origin | centre of the **back** face | snap the anchor Empty to the wall, picture stands proud by `thickness` |
| facing | Blender −Y (front view / numpad 1) | an unrotated picture faces you on import |
| front material | `KHR_materials_unlit` + baseColorTexture | this is the entire lighting handshake |
| other 5 faces | dark matte, base colour `(0.05, 0.045, 0.04)`, roughness 0.85 | lit normally so depth reads |
| backface culling | on, both materials | closed box; backfaces are wasted fill |
| texture | WebP, quality 85, long edge capped at 1024 px | declare `EXT_texture_webp` |
| UVs | full image on the front face only | the mount has nothing to map |

Winding: every normal points out of the slab. Front face is the first primitive.

## Approach

**Hand-write the glTF. Do not use PlayCanvas' `GltfExporter`.** It exists in
`game/lib/playcanvas.mjs:107378` and does write `KHR_materials_unlit`, but its
texture encoder is hardcoded to PNG/JPEG (`lib/playcanvas.mjs:107956`) with no
quality argument, so you lose WebP entirely — and it round-trips the image
through a GPU texture and back out through a canvas, re-encoding lossy source as
lossy output. The engine's *loader* reads `EXT_texture_webp`
(`lib/playcanvas.mjs:94079`); its exporter never writes it.

Hand-writing is smaller than it sounds. The geometry is 8 fixed vertices and 6
quads — already fully spelled out in `build_slab`. The exporter is a fixed JSON
chunk plus a binary chunk, no dependencies.

Browser primitives do the rest:

- decode — `createImageBitmap(file)` (handles jpg/png/webp)
- resize — draw to a `<canvas>` at the capped size
- encode — `canvas.toBlob(cb, 'image/webp', 0.85)`
- embed — the resulting blob's bytes go straight into a buffer view

## Steps

1. Read `build_assets.py:480-635` in full.
2. Scaffold the app in the destination dir (plain HTML + ES modules, no build
   step, no framework — it is one file input and one download button).
3. Image pipeline: decode → cap long edge at 1024 → WebP encode at 0.85.
4. Slab geometry: port `build_slab` to `Float32Array`s. Two glTF primitives, one
   per material, since a primitive carries exactly one material.
5. GLB writer: JSON chunk + BIN chunk, `EXT_texture_webp` declared on the
   texture, `KHR_materials_unlit` on the front primitive's material.
6. UI: drop an image, show computed `W × H m` and aspect, edit height, download.
7. Verify — the real test, do not skip:
   - Build a picture from the same source image with both paths and compare
     dimensions, node name, and declared extensions.
   - Drop the browser-built GLB into `game/assets/`, place it via
     `npm run scene:import`, run the game, confirm it is unlit (not washed out),
     not collidable, and flush to the wall.
   - `node game/tests/perf.mjs` still passes.

## Out of scope

- Do not touch anything in `game/`. The Blender picture path stays.
- No placement, no scene data. Where a picture hangs lives in
  `scene.placements.json` and this never comes near it.
- No per-image lighting knobs. The unlit flag is the whole handshake. If
  brightness control is ever wanted, it is `KHR_materials_emissive_strength`
  (the engine reads it at `lib/playcanvas.mjs:93460`) — but not now.
