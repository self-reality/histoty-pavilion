// Scene "look": distance fog, and the PBR surface response of the map.
//
// Shared by BOTH entry points (standalone/main.mjs and src/game.mjs) and, like
// the rest of ../src, engine-light — it never creates a pc.Application and never
// touches the DOM, so it stays safe to sync to the Editor. Defaults live in
// scene.manifest.mjs; the debug panel drives the very same setters live, so
// dialling a slider and then copying the number back into the manifest is the
// whole authoring loop.
import { CULLFACE_NONE, FogParams, FOG_NONE, FOG_LINEAR, FOG_EXP, FOG_EXP2 } from 'playcanvas';

// Panel-facing names -> engine constants. Insertion order is also the order of
// the debug panel's segmented control.
export const FOG_TYPES = { off: FOG_NONE, linear: FOG_LINEAR, exp: FOG_EXP, exp2: FOG_EXP2 };
export const FOG_TYPE_NAMES = Object.keys(FOG_TYPES);

export function fogTypeName(type) {
  return FOG_TYPE_NAMES.find((n) => FOG_TYPES[n] === type) ?? 'off';
}

// The Editor build's copy of scene.manifest.mjs's `fog` and `surface` blocks.
//
// It needs one because pcsync only uploads game/src/*.mjs, so game.mjs cannot
// import the manifest — the same reason it already hardcodes its own SKY. The
// manifest stays the tracked truth (the standalone build reads it directly);
// these two must be kept in step with it by hand.
export const EDITOR_FOG = { type: 'linear', color: [0.68, 0.72, 0.78], start: 15, end: 120, density: 0.008 };
export const EDITOR_SURFACE = { roughness: 0.9, specular: 0.35, metalness: 0 };

/**
 * Write a manifest `fog` block onto a scene and hand back the live FogParams.
 * The engine reads that object every frame, so the debug panel can keep poking
 * its fields directly — there is nothing to re-apply.
 */
export function applyFog(scene, fog) {
  const f = scene.fog;
  f.type = FOG_TYPES[fog.type] ?? FOG_NONE;
  f.color.set(fog.color[0], fog.color[1], fog.color[2]);
  f.start = fog.start;
  f.end = fog.end;
  f.density = fog.density;
  return f;
}

/**
 * Exempt a camera from the scene fog.
 *
 * Fog is a scene-global, and the viewmodel camera draws the gun ~0.5 m from the
 * lens. Linear fog never reaches that near, but exp/exp2 does — crank the
 * density slider and the AK would start hazing over. Giving that camera its own
 * default (type `off`) FogParams keeps the weapon crisp at any setting.
 */
export function disableFogOn(cameraComponent) {
  // A camera's own fogParams wins over scene.fog; a default FogParams is `off`.
  if (cameraComponent) cameraComponent.fogParams = new FogParams();
}

// ---- Map surface ----------------------------------------------------------

/**
 * Owns the map's materials and the handful of PBR numbers we impose on them.
 *
 * WHY THIS EXISTS — the map read as polished plastic under the sun, and the
 * cause was an inverted knob. PlayCanvas's glTF loader imports every material
 * with `glossInvert = true`, which means `material.gloss` no longer holds
 * glossiness: it holds ROUGHNESS, and the shader does `1.0 - gloss` at the end.
 * The old fixup set `gloss = 0.12` intending "matte", and got glossiness 0.88 —
 * a tight, wet highlight on every sandstone wall in the level. (de_dust2.glb
 * ships `roughnessFactor: 1` and no metallic-roughness texture, i.e. the asset
 * itself asks to be fully rough.)
 *
 * So this class takes ROUGHNESS as its input and writes whichever convention
 * the material is actually using. Everything else here is the same idea: one
 * honest name per knob, applied to all the map's materials at once.
 */
export class SurfaceLook {
  constructor(surface = {}) {
    this.params = {
      roughness: 0.9,
      specular: 0.35,
      metalness: 0,
      ...surface,
    };
    this.materials = new Set();
  }

  /** Collect every unique material under a render hierarchy and style it. */
  adopt(renderRoot) {
    for (const rc of renderRoot.findComponents('render')) {
      for (const mi of rc.meshInstances) {
        if (mi.material) this.materials.add(mi.material);
      }
    }
    this.apply();
    return this;
  }

  /** Set one param by name and push it to every adopted material. */
  set(key, value) {
    this.params[key] = value;
    this.apply();
  }

  apply() {
    for (const m of this.materials) this._style(m);
  }

  _style(m) {
    const p = this.params;

    // The map is ripped, single-sided geometry — draw both faces or you can see
    // straight through walls from the wrong side.
    m.cull = CULLFACE_NONE;

    if ('useMetalness' in m) {
      m.useMetalness = true;
      m.metalness = p.metalness;
    }

    // Roughness, written in whichever direction this material reads it.
    if ('gloss' in m) m.gloss = m.glossInvert ? p.roughness : 1 - p.roughness;

    // Dielectric reflectance. Dry stone barely reflects; `specularityFactor`
    // scales the 0.04 F0 the metalness workflow assumes, so 0 removes the sun
    // glint entirely and 1 is the physically-default plastic-ish sheen. The
    // factor is only wired into the shader when useMetalnessSpecularColor is on.
    if ('specularityFactor' in m) {
      m.useMetalnessSpecularColor = true;
      m.specularityFactor = p.specular;
    }

    m.update();
  }
}
