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
  sky: [0.957, 0.839, 1], // camera clear colour / sky — warm pink-white

  // ---- Distance fog ----
  // Read by src/atmosphere.mjs into scene.fog; every field is a live slider on
  // the debug URL (/?debug), and these numbers were dialled in there and copied
  // back. A cool blue-lilac haze under the warm sky, closing in fast: the level
  // fades out well inside its own ~112 m span, so sight lines read as depth
  // rather than as a flat wall of geometry. type: off | linear | exp | exp2.
  fog: {
    type: 'linear',
    color: [0.741, 0.749, 1], // cool blue-lilac, deliberately not the sky hue
    start: 6,                 // metres where the haze begins (linear only)
    end: 66,                  // metres where it's fully opaque (linear only)
    density: 0.012,           // exp/exp2 only; ignored by linear
  },

  // ---- Map surface response (PBR) ----
  // Applied to the map's 34 materials by src/atmosphere.mjs, live-tweakable in
  // the debug panel.
  //
  // `roughness` is authored as roughness (0 = mirror, 1 = chalk) — NOT as
  // PlayCanvas's `gloss`. See atmosphere.mjs for why that distinction matters.
  surface: {
    roughness: 0.44,  // half-polished: a broad sheen, not a point highlight
    specular: 0,      // scales dielectric F0 — 0 kills the sun glint outright
    metalness: 0.15,  // slight metal lift: darkens albedo, tints what specular remains
  },

  // ---- Refractive props ----
  // Meshes whose names match these sample the camera's scene-colour grab-pass
  // (requestSceneColorMap). The grab-pass is enabled globally on the camera, so
  // this list is the authored record of what needs it — one entry per glass mesh.
  glass: ['Military_tent_Glass_0'],

  // ---- Red dummy targets scattered on floor samples ----
  targets: { max: 10 },

  // ---- Sound bank ----
  // Like the GLBs, these files are not built here: they arrive finished from
  // the sibling `sound-design` repo and are tracked in assets/sounds/. The
  // directory is all this side declares, because the bank ships its own
  // `sounds.manifest.json` naming every file and the voice it is a take of —
  // adding a fifth footstep is a re-copy, not an edit. See src/audio.mjs.
  //
  // `volume` is a master trim over the whole bank, and wants to stay at 1:
  // the files are peak-normalised per category (weapon > handling > movement),
  // so their relative levels ARE the mix and are already right at unity gain.
  sounds: {
    dir: './assets/sounds/',
    volume: 1,
  },

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

  // ---- Negative spaces: convex volumes subtracted from the map ----
  // The mirror of `props` — a prop adds geometry at a transform, a negative
  // takes it away. Authored in Blender's NEG collection and normally arriving
  // through `placements` above; entries here are the same escape hatch `props`
  // is, and are shadowed by same-named ones from Blender.
  //
  //   { name: 'neg_door_01', shape: 'box', pos: [x, y, z], euler: [...], scale: [...] }
  //
  // `shape` is 'box' or 'cylinder' (add `sides`), sized like the Blender
  // primitive: a cube is 2 m across at scale 1, and a cylinder is radius 1,
  // 2 m tall, standing on Y — so an entry with no rotation is upright, which
  // is what Blender exports for an upright cutter. See src/negatives.mjs.
  negatives: [],

  // ---- Articulated props: named nodes of a placed GLB, driven at runtime ----
  // Keyed by placement name, so this composes with both prop sources — the
  // Blender-generated placements and the hand-written `props` above — without
  // the exporter learning what a bone is. The .blend says where the prop is;
  // this says how it is folded. See src/rig.mjs for the axis convention.
  //
  // Angles are DELTAS on the bind pose in degrees, in each bone's own frame.
  // On a ValveBiped rig +X runs down the bone, so Z is the hinge (hip flex,
  // knee, ankle), Y swings sideways (hip abduction), X twists. Every number
  // here was dialled on the debug panel's Rig sliders (/?debug) and pasted back with
  // its Copy button — the same loop `fog` and `surface` use.
  rigs: {
    // Sukhasana — simple cross-legged. Hips flex forward and abduct so the
    // thighs lie open and near-horizontal; knees fold hard so the shins come
    // back and cross at the ankles; arms come off the body so they rest on the
    // knees instead of intersecting them.
    'g-man_01': {
      pose: {
        // The big X twist on the thighs is external hip rotation, and it is not
        // decoration: without it the knee hinge stays in a vertical plane and
        // folding the calf drives the shin down through the floor instead of
        // back along it. That rotation is the whole trick of a cross-legged sit.
        //
        // The two legs are near-mirrors but not exact — the right is 5° more
        // twisted and 11° less flexed, which is what tucks its shin BEHIND the
        // left instead of through it. Mirroring the left exactly puts both
        // ankles in the same 5 cm of space.
        'ValveBiped.Bip01_L_Thigh*':    [-77.5, -40, -72.5],
        'ValveBiped.Bip01_L_Calf*':     [0, 0, 135],
        'ValveBiped.Bip01_L_Foot*':     [0, 0, 30],
        'ValveBiped.Bip01_R_Thigh*':    [82.5, 35, -61.5],
        'ValveBiped.Bip01_R_Calf*':     [0, 0, 141],
        'ValveBiped.Bip01_R_Foot*':     [0, 0, 30],
        // Arms come in off the body and the elbows bend, so the hands land on
        // the knees rather than passing through the thighs. Both forearms carry
        // a big twist about their own length — that is what rolls the palms
        // over onto the knees instead of leaving them edge-on, and it is the
        // difference between sitting and merely being folded up.
        //
        // The two sides are near-mirrors, which is what a mirror looks like on
        // this rig: X and Y flip, Z keeps. Dialled by hand, so they are close to
        // that rather than exactly it.
        'ValveBiped.Bip01_L_UpperArm*': [0, 20, -25],
        'ValveBiped.Bip01_L_Forearm*':  [74.5, 0, -38.5],
        'ValveBiped.Bip01_R_UpperArm*': [0, -20, -21.5],
        'ValveBiped.Bip01_R_Forearm*':  [-63.5, -7.5, -39],
        'ValveBiped.Bip01_Spine1*':     [0, 0, 4],
      },
      // The briefcase is rigidly weighted to his right hand, so with both arms
      // resting on the knees it would sit in his lap. He is meditating, not
      // doing paperwork — drop it from the camera, the shadow pass and the
      // collider alike.
      hide: ['briefcase_reference*'],
      // Metres. Sitting puts the hips ~1 m below where standing left them, and
      // that metre is the pose's, not the layout's — move him in the .blend and
      // it still holds. Applied to the prop root, so it is world metres and
      // independent of the model's own 0.03 scale.
      offset: [0, -0.93, 0],
    },
  },

  // ---- Wall paintings (name -> image), filled later ----
  paintings: [],
};

export default manifest;
