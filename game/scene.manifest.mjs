// Scene manifest — the git-tracked source of truth for scene construction.
// See BLENDER_MIGRATION.md. Blender is the asset/layout factory; this file is
// the truth that both builds read.
//
// PURE DATA: no imports, no pc.Application, no DOM. Keep it that way so it stays
// Claude-legible and so the headless Blender exporter can rewrite prop entries
// mechanically (name + world transform) without touching engine code.
//
// Conventions:
//   • Colours are [r, g, b] in 0..1 linear.
//   • Transforms are in PlayCanvas space: metres, Y-up, euler degrees XYZ.
//   • euler [-90, 0, 0] is the glTF Z-up -> PlayCanvas Y-up import correction
//     (the same one the map uses); imported GLBs authored Z-up need it.

export const manifest = {
  // ---- Imported level geometry (Source units, Z-up -> metres, Y-up) ----
  map: {
    glb: './assets/de_dust2.glb',
    scale: 0.025,          // ~112 m across, human scale
    euler: [-90, 0, 0],
  },

  // ---- Global look ----
  sky: [0.61, 0.71, 0.83], // camera clear colour / sky

  // ---- Refractive props ----
  // Meshes whose names match these sample the camera's scene-colour grab-pass
  // (requestSceneColorMap). The grab-pass is enabled globally on the camera, so
  // this list is the authored record of what needs it — one entry per glass mesh.
  glass: ['Military_tent_Glass_0'],

  // ---- Red dummy targets scattered on floor samples ----
  targets: { max: 10 },

  // ---- Blender-authored layout ----
  // Written by tools/export_scene.py from scene/pavilion.blend; see
  // BLENDER_SCENE.md. Entries here override same-named ones in `props` below,
  // so moving a prop into Blender needs no edit on this side. Missing file is
  // fine — the game just falls back to `props`.
  placements: './scene.placements.json',

  // ---- Hand-placed props: imported GLBs placed in the world ----
  // Escape hatch for props not authored in Blender. Same shape as a placements
  // entry: { name, glb, pos, euler|rot, scale } in PlayCanvas space.
  //
  // tent_01 used to live here (grabbed from the Editor scene, see
  // EXPORT_TENT.md); it now lives in scene/pavilion.blend and comes back
  // through scene.placements.json. Anything listed here is a *second*
  // definition that Blender will shadow — prefer the .blend.
  props: [],

  // ---- Wall paintings (name -> image), filled later ----
  paintings: [],
};

export default manifest;
