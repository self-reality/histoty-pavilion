// Something for a metal to reflect.
//
// A mirror has no colour of its own, so a metal with nothing around it draws
// black however it is lit: the disco ball arrived as a black ball. The asset
// kit's viewer stands its stage in a painted studio for the same reason, and
// this is that studio — `studioEnvAtlas` is the kit's, from its
// viewer/src/viewer.mjs, painted the same so a prop reflects here what it
// reflected where it was looked at. Change one, change the other.
//
// The level keeps its own light. An atlas on the scene would replace
// `ambientLight` for every surface in it, so the studio is handed to the
// materials that need it instead, one by one (see `reflectStudio`).
import * as pc from 'playcanvas';

/**
 * A dim room with a softbox overhead and a strip light on three of its walls,
 * painted onto the six faces of a cubemap (+X, -X, +Y, -Y, +Z, -Z) and
 * prefiltered into an atlas, so a rough surface gets a blurred room and a
 * polished one a sharp one.
 */
export function studioEnvAtlas(device) {
  const S = 256;
  const faces = [0, 1, 2, 3, 4, 5].map((f) => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    if (f === 2) {                                   // ceiling: the softbox
      g.fillStyle = '#3a3b40'; g.fillRect(0, 0, S, S);
      const r = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.5);
      r.addColorStop(0, '#ffffff'); r.addColorStop(0.55, '#e8e6e0'); r.addColorStop(1, 'rgba(58,59,64,0)');
      g.fillStyle = r; g.fillRect(0, 0, S, S);
    } else if (f === 3) {                            // floor
      g.fillStyle = '#2a2b2f'; g.fillRect(0, 0, S, S);
    } else {                                         // walls: lighter at the horizon
      const v = g.createLinearGradient(0, 0, 0, S);
      v.addColorStop(0, '#5a5b62'); v.addColorStop(0.5, '#a9a7a2'); v.addColorStop(0.56, '#44454a'); v.addColorStop(1, '#2c2d31');
      g.fillStyle = v; g.fillRect(0, 0, S, S);
      if (f !== 4) {                                 // tall strip lights, none straight ahead
        const x = S * (f === 0 ? 0.3 : f === 1 ? 0.7 : 0.62);
        const h = g.createLinearGradient(x - 18, 0, x + 18, 0);
        h.addColorStop(0, 'rgba(255,255,255,0)'); h.addColorStop(0.5, f === 0 ? '#fff6e8' : '#eef3ff'); h.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = h; g.fillRect(x - 18, S * 0.08, 36, S * 0.5);
      }
    }
    return c;
  });
  const cube = new pc.Texture(device, {
    name: 'studio-env', cubemap: true, width: S, height: S,
    format: pc.PIXELFORMAT_SRGBA8, mipmaps: true,
  });
  cube.setSource(faces);
  const lighting = pc.EnvLighting.generateLightingSource(cube);
  const atlas = pc.EnvLighting.generateAtlas(lighting);
  lighting.destroy();
  cube.destroy();
  return atlas;
}

/**
 * Give a prop's metals the studio to reflect.
 *
 * Only its metals: a material with an atlas of its own takes its ambient from
 * that atlas too, and a painted wall or a cloth should go on being lit by the
 * level it stands in. A metal has next to no diffuse for the ambient to fall
 * on, so for it the trade is all gain. Unlit materials reflect nothing and are
 * left alone.
 */
export function reflectStudio(rootEntity, atlas) {
  let mirrored = 0;
  for (const rc of rootEntity.findComponents('render')) {
    for (const mi of rc.meshInstances) {
      const m = mi.material;
      // Materials are shared between instances of the same container, so a prop
      // placed twice would otherwise count its materials twice.
      if (!m || m.envAtlas === atlas) continue;
      if (m.useLighting === false || !m.useMetalness || !(m.metalness > 0)) continue;
      m.envAtlas = atlas;
      m.update();
      mirrored++;
    }
  }
  return mirrored;
}
