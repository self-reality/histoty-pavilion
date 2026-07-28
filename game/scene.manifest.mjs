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

  // ---- Authored props: imported GLBs placed in the world ----
  // Transform reproduces the node's transform from the PlayCanvas scene.
  // tent_01 grabbed from the running Editor scene (see EXPORT_TENT.md):
  //   node "tent_military" @ pos (0,0,0) rot (-90,0,0) scale (1,1,1).
  props: [
    {
      name: 'tent_01',
      glb: './assets/tent_military.glb',
      pos: [0, 0, 0],
      euler: [-90, 0, 0],
      scale: [1, 1, 1],
    },
  ],

  // ---- Wall paintings (name -> image), filled later ----
  paintings: [],
};

export default manifest;
