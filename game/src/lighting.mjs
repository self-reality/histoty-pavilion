// Baked lighting: what the sky and the sand's bounce do in the map's tunnels.
//
// The realtime sun casts its shadows as before. What it could never do is the
// light that is not the sun: the sky seen through a doorway, the warm glow off
// a sunlit floor. That used to be a flat ambient plus an unshadowed fill, the
// same everywhere — a tunnel as bright as the open street. It is now baked in
// Blender (tools/bake_light.py, `npm run lighting:bake`) into three files a
// descriptor names (assets/de_dust2.lighting.json):
//
//   • de_dust2.lit.glb       — the map, byte for byte, plus a second UV set
//   • de_dust2.lightmap.png  — the sky + bounce light on that UV set, RGBM
//   • de_dust2.probes.bin    — the same light as an L1 SH grid, for whatever
//                              is not the map: props, characters, ghosts
//
// The map's materials take the lightmap (which drops the flat ambient on them,
// and leaves the sun alone). Everything else lit takes `ambientSH`, sampled at
// where each mesh instance stands — once for a prop that stays put, again
// whenever one moves. Nothing here keeps time, so a recorded frame is a pure
// function of where things are.
//
// `?lighting=flat` is today's look exactly: the original GLB, the fill on, no
// lightmap and no SH. `?lighting=<url of a .lighting.json>` loads another bake
// (tests use a fixture). With no bake named in the manifest, the default is flat.
import * as pc from 'playcanvas';

const { Asset, Color } = pc;

const MAGIC = 0x474c4350;   // 'PCLG', little-endian
const MOVED2 = 0.02 * 0.02; // a stamp is redone once its instance has moved 2 cm

// The engine's own lightmap chunk with two uniforms more: the strength and tint,
// and the contrast and saturation (see Lighting.curve) — the same curve
// sample() puts on the probes, so a prop reads like the floor it stands on.
const LIGHTMAP_PS = /* glsl */`
uniform vec3 lightmap_scale;
uniform vec3 lightmap_curve;
void getLightMap() {
    dLightmap = vec3(1.0);
    #ifdef STD_LIGHT_TEXTURE
        vec3 lm = {STD_LIGHT_TEXTURE_DECODE}(texture2DBias({STD_LIGHT_TEXTURE_NAME}, {STD_LIGHT_TEXTURE_UV}, textureBias)).{STD_LIGHT_TEXTURE_CHANNEL};
        float lmL = max(dot(lm, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
        dLightmap *= lmL * pow(lmL * lightmap_curve.y, lightmap_curve.x) * mix(vec3(1.0), lm / lmL, lightmap_curve.z);
    #endif
    #ifdef STD_LIGHT_VERTEX
        dLightmap *= saturate(vVertexColor.{STD_LIGHT_VERTEX_CHANNEL});
    #endif
    dLightmap *= lightmap_scale;
}
`;

// The newest shader-chunk API this engine knows, so an overridden chunk is not
// reported as written for an older one.
const CHUNK_API = ['CHUNKAPI_2_8', 'CHUNKAPI_2_7', 'CHUNKAPI_2_6', 'CHUNKAPI_2_5'].map((k) => pc[k]).find(Boolean);

/** 'flat' | 'baked' | { url } from `?lighting=`; absent means baked (which is flat until a bake is named). */
export function lightingMode(search = location.search) {
  const v = new URLSearchParams(search).get('lighting');
  if (!v || v === 'baked') return 'baked';
  if (v === 'flat') return 'flat';
  return { url: v };
}

/** IEEE half to float, without DataView.getFloat16. */
function half(h) {
  const e = (h >> 10) & 0x1f, f = h & 0x3ff, s = h & 0x8000 ? -1 : 1;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/** Parse a probes.bin (format: see the lighting spec §2.1). Throws on a bad file. */
export function parseProbes(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 48 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a PCLG probe file');
  if (dv.getUint32(4, true) !== 1) throw new Error(`probe file version ${dv.getUint32(4, true)}`);
  const n = [dv.getUint32(8, true), dv.getUint32(12, true), dv.getUint32(16, true)];
  const origin = [dv.getFloat32(20, true), dv.getFloat32(24, true), dv.getFloat32(28, true)];
  const cell = [dv.getFloat32(32, true), dv.getFloat32(36, true), dv.getFloat32(40, true)];
  const N = n[0] * n[1] * n[2];
  if (!N || buffer.byteLength < 48 + 25 * N) throw new Error(`probe file is ${buffer.byteLength} bytes, ${48 + 25 * N} expected`);
  const coeffs = new Float32Array(12 * N);
  for (let i = 0; i < 12 * N; i++) coeffs[i] = half(dv.getUint16(48 + 2 * i, true));
  const valid = new Uint8Array(buffer, 48 + 24 * N, N).slice();
  let invalid = 0;
  for (let i = 0; i < N; i++) if (!valid[i]) invalid++;
  return { n, origin, cell, coeffs, valid, invalid };
}

const lum3 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const asArray3 = (c) => (Array.isArray(c) ? c.slice(0, 3) : [c.r, c.g, c.b]);

export class Lighting {
  /**
   * Read the bake's descriptor and resolve { mapGlb, lighting } as soon as it
   * is read: mapGlb is the lit GLB to load the map from (null: the original),
   * and lighting a promise of the Lighting, which resolves once the lightmap
   * and probes are in memory. So the map downloads alongside them rather than
   * after them. Any failure is a console warning and flat — it never rejects.
   * (A lightmap that fails after the lit GLB was named leaves the lit GLB in
   * use: it is the original map plus a UV set nothing reads.)
   */
  static async open({ app, cfg = {}, mode = 'baked', base = location.href, fill = null }) {
    const flat = (why) => {
      if (why) console.warn(`[lighting] ${why} — flat`);
      else console.log('[lighting] flat');
      return new Lighting({ app, cfg, fill });
    };
    const url = mode === 'flat' ? null : typeof mode === 'object' ? mode.url : cfg?.file;
    if (!url) return { mapGlb: null, lighting: Promise.resolve(flat()) };
    let at, desc;
    try {
      at = new URL(url, base);
      const res = await fetch(at, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${at.pathname}: HTTP ${res.status}`);
      desc = await res.json();
      if (desc.version !== 1) throw new Error(`descriptor version ${desc.version}`);
      if (desc.encoding && desc.encoding !== 'rgbm') throw new Error(`lightmap encoding ${desc.encoding}`);
    } catch (err) {
      return { mapGlb: null, lighting: Promise.resolve(flat(`${url}: ${err.message ?? err}`)) };
    }
    const file = (name) => new URL(name, at).href;
    const lighting = Promise.all([
      loadLightmap(app, file(desc.lightmap)),
      fetch(file(desc.probes)).then((r) => {
        if (!r.ok) throw new Error(`${desc.probes}: HTTP ${r.status}`);
        return r.arrayBuffer();
      }).then(parseProbes),
    ]).then(([texture, probes]) => {
      const lit = new Lighting({ app, cfg, fill, texture, probes, desc });
      const [nx, ny, nz] = probes.n;
      console.log(`[lighting] baked: ${texture.width}² rgbm lightmap, probes ${nx}×${ny}×${nz}`
        + ` (${probes.invalid} invalid filled)`);
      lit._checkSun(desc.sun);
      return lit;
    }, (err) => flat(`${url}: ${err.message ?? err}`));
    return { mapGlb: file(desc.glb), lighting };
  }

  constructor({ app, cfg = {}, fill = null, texture = null, probes = null, desc = null }) {
    this.app = app;
    this.fill = fill;
    this.texture = texture;
    this.probes = probes;
    this.desc = desc;
    this.available = !!(texture && probes);
    this.mode = this.available ? 'baked' : 'flat';
    this.strength = cfg?.strength ?? 1;
    this.propStrength = cfg?.propStrength ?? 1;
    this.tint = asArray3(cfg?.tint ?? [1, 1, 1]);
    // Contrast: 1 is the bake as it came out of Cycles. Below 1 the dark is
    // lifted towards the open — L' = ref·(L/ref)^contrast on luminance, hue
    // kept — so the open floor (ref, the bake's own reading of it) stays put
    // and a deep tunnel is dim rather than black. A look, not physics.
    this.contrast = cfg?.contrast ?? 1;
    // Saturation: 1 is the bake's colour. Sand bounces sand-coloured light,
    // and three bounces deep a tunnel is orange-brown; below 1 that colour is
    // pulled towards grey (the open floor, nearly grey already, hardly moves).
    this.saturation = cfg?.saturation ?? 1;
    const of = desc?.stats?.openFloor;
    this.ref = of ? Math.max(lum3(of[0], of[1], of[2]), 1e-3) : 0.4;
    this.curve = new Float32Array(3);
    this.scale3 = new Float32Array(3);
    this._scale();
    this.mapMaterials = new Set();
    this.prepared = new Set();       // materials given ambientSH here
    this.roots = new Set();          // entities whose instances are stamped
    this.stamps = new WeakMap();     // MeshInstance -> { x, y, z, arr }
    // What an instance looks like before its first stamp: today's ambient, as
    // the shader receives it (the engine linearises scene.ambientLight). Kept
    // in step with the ambient by ambientChanged().
    this.defaultSH = new Float32Array(27);
    this.ambientChanged();
  }

  /** scene.ambientLight was changed (the debug panel): the not-yet-stamped default follows it. */
  ambientChanged() {
    const a = new Color().linear(this.app.scene.ambientLight);
    this.defaultSH.set([a.r, a.g, a.b]);
    for (const m of this.prepared ?? []) if (m.ambientSH === this.defaultSH) m.update();
  }

  /** A bake is applied right now. */
  get baked() { return this.available && this.mode === 'baked'; }

  get settings() {
    return {
      mode: this.mode, strength: this.strength, propStrength: this.propStrength,
      contrast: this.contrast, saturation: this.saturation, tint: this.tint.slice(),
    };
  }

  _scale() {
    for (let i = 0; i < 3; i++) this.scale3[i] = this.strength * this.tint[i];
    this.curve[0] = this.contrast - 1;
    this.curve[1] = 1 / this.ref;
    this.curve[2] = this.saturation;
  }

  _checkSun(sun) {
    const want = this.app.root.findByName('sun')?.light;
    if (!sun || !want) return;
    const e = this.app.root.findByName('sun').getEulerAngles();
    const near = (a, b) => Math.abs(a - b) < 1e-3;
    const same = near(want.intensity, sun.intensity)
      && asArray3(want.color).every((c, i) => near(c, sun.color[i]))
      && [e.x, e.y, e.z].every((v, i) => near(v, sun.euler[i]) || near(Math.abs(v - sun.euler[i]), 360));
    if (!same) console.warn('[lighting] the sun differs from the one the lightmap was baked with — run `npm run lighting:bake` again');
  }

  /** The map's materials: the lightmap on uv1, with the strength/tint chunk. */
  adoptMap(materials) {
    if (!this.available) return;
    for (const m of materials) {
      if (m.useLighting === false) continue;
      this.mapMaterials.add(m);
      m.getShaderChunks('glsl').set('lightmapPS', LIGHTMAP_PS);
      if (CHUNK_API) m.shaderChunksVersion = CHUNK_API;
      m.setParameter('lightmap_scale', this.scale3);
      m.setParameter('lightmap_curve', this.curve);
      this._mapOn(m, this.baked);
    }
    if (this.fill) this.fill.enabled = !this.baked;
  }

  _mapOn(m, on) {
    m.lightMap = on ? this.texture : null;
    m.lightMapUv = 1;
    m.lightMapChannel = 'rgb';
    m.update();
  }

  /** Give one lit material probe ambient (today's ambient until stamped). True when it has it. */
  prepareMaterial(m) {
    if (!this.baked || !m || m.useLighting === false || !('ambientSH' in m)) return false;
    if (m.ambientSH) return true;
    m.ambientSH = this.defaultSH;
    m.update();
    this.prepared.add(m);
    return true;
  }

  /** prepareMaterial over every material drawn under a root. */
  prepareAll(root) {
    if (!this.baked) return 0;
    let n = 0;
    for (const rc of root.findComponents('render')) {
      for (const mi of rc.meshInstances) if (this.prepareMaterial(mi.material)) n++;
    }
    return n;
  }

  track(root) { if (this.available) this.roots.add(root); }
  untrack(root) { this.roots.delete(root); }

  /** Stamp every probe-lit instance under one root now (a level just drawn, a prop just placed). */
  stamp(root) {
    if (!this.baked || !root.parent) return;
    for (const rc of root.findComponents('render')) {
      for (const mi of rc.meshInstances) {
        const m = mi.material;
        // A material met for the first time (a script's own, a level's) is
        // prepared here; an unlit one never is.
        if (!m || (!m.ambientSH && !this.prepareMaterial(m))) continue;
        const c = mi.aabb.center;
        let s = this.stamps.get(mi);
        if (s) {
          const dx = c.x - s.x, dy = c.y - s.y, dz = c.z - s.z;
          if (dx * dx + dy * dy + dz * dz <= MOVED2 && mi.parameters['ambientSH[0]']?.data === s.arr) continue;
        } else {
          s = { x: 0, y: 0, z: 0, arr: new Float32Array(27) };
          this.stamps.set(mi, s);
        }
        s.x = c.x; s.y = c.y; s.z = c.z;
        this.sample(c.x, c.y, c.z, s.arr);
        mi.setParameter('ambientSH[0]', s.arr);
      }
    }
  }

  /** Once a frame, after everything has moved. */
  update() {
    if (!this.baked) return;
    for (const root of this.roots) {
      // Destroyed (or taken off stage): an entity has no flag for it, only no parent.
      if (!root.parent) { this.roots.delete(root); continue; }
      this.stamp(root);
    }
  }

  /**
   * The probe ambient at a world point, into out27 as ambientSH[0..8]: c0 and
   * the three L1 terms, scaled by propStrength × tint; the L2 terms zero.
   * Trilinear over the valid corners; with none valid, the nearest cell's value.
   */
  sample(x, y, z, out) {
    out.fill(0);
    const P = this.probes;
    if (!P) { out.set(this.defaultSH); return out; }
    const { n, origin, cell, coeffs, valid } = P;
    const p = [x, y, z];
    const i0 = [0, 0, 0], i1 = [0, 0, 0], f = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const g = Math.min(Math.max((p[k] - origin[k]) / cell[k], 0), n[k] - 1);
      i0[k] = Math.floor(g);
      i1[k] = Math.min(i0[k] + 1, n[k] - 1);
      f[k] = g - i0[k];
    }
    const nx = n[0], nxy = n[0] * n[1];
    let wsum = 0;
    for (let c = 0; c < 8; c++) {
      const ix = c & 1 ? i1[0] : i0[0], iy = c & 2 ? i1[1] : i0[1], iz = c & 4 ? i1[2] : i0[2];
      const idx = ix + nx * iy + nxy * iz;
      if (!valid[idx]) continue;
      const w = (c & 1 ? f[0] : 1 - f[0]) * (c & 2 ? f[1] : 1 - f[1]) * (c & 4 ? f[2] : 1 - f[2]);
      if (w <= 0) continue;
      wsum += w;
      for (let j = 0; j < 12; j++) out[j] += w * coeffs[12 * idx + j];
    }
    if (wsum < 1e-4) {
      const ix = f[0] < 0.5 ? i0[0] : i1[0], iy = f[1] < 0.5 ? i0[1] : i1[1], iz = f[2] < 0.5 ? i0[2] : i1[2];
      const idx = ix + nx * iy + nxy * iz;
      for (let j = 0; j < 12; j++) out[j] = coeffs[12 * idx + j];
    } else {
      for (let j = 0; j < 12; j++) out[j] /= wsum;
    }
    // The lightmap's curve: contrast on c0's luminance (L1 scales with it),
    // saturation on c0's colour.
    const L = Math.max(lum3(out[0], out[1], out[2]), 1e-6);
    const g = Math.pow(L / this.ref, this.contrast - 1), s = this.saturation;
    for (let ch = 0; ch < 3; ch++) out[ch] = g * (L * (1 - s) + out[ch] * s);
    for (let j = 3; j < 12; j++) out[j] *= g;
    for (let j = 0; j < 12; j++) out[j] *= this.propStrength * this.tint[j % 3];
    return out;
  }

  /** The debug panel's live toggle; baked is only there when the page booted with a bake. */
  setMode(mode) {
    if (!this.available || (mode !== 'flat' && mode !== 'baked') || mode === this.mode) return;
    if (mode === 'flat') {
      // Every material carrying the SH now, including copies made from prepared ones.
      for (const root of this.roots) {
        for (const rc of root.findComponents('render')) {
          for (const mi of rc.meshInstances) if (mi.material?.ambientSH) this.prepared.add(mi.material);
        }
      }
      for (const m of this.prepared) { m.ambientSH = null; m.update(); }
    }
    this.mode = mode;
    if (mode === 'baked') {
      for (const m of this.prepared) { m.ambientSH = this.defaultSH; m.update(); }
    }
    for (const m of this.mapMaterials) this._mapOn(m, mode === 'baked');
    if (this.fill) this.fill.enabled = mode === 'flat';
    this.update();
  }

  /** 'strength' (the lightmap), 'propStrength' (the probes), 'contrast', 'saturation' (both) or 'tint' ([r,g,b] or a Color). */
  set(key, value) {
    if (key === 'strength') this.strength = +value;
    else if (key === 'propStrength') this.propStrength = +value;
    else if (key === 'contrast') this.contrast = +value;
    else if (key === 'saturation') this.saturation = +value;
    else if (key === 'tint') this.tint = asArray3(value);
    else return;
    this._scale();
    // Probe stamps carry propStrength and tint: every instance is sampled afresh.
    this.stamps = new WeakMap();
    this.update();
  }
}

function loadLightmap(app, url) {
  return new Promise((resolve, reject) => {
    // No mipmaps. A mip of RGBM averages the encoded bytes, which is not the
    // average of the light, and past the first levels it reaches across the
    // 4-texel gutters into the next chart — a far floor would turn patchy. The
    // light is soft enough that plain bilinear at a distance does not shimmer.
    const asset = new Asset('de_dust2.lightmap', 'texture', { url }, {
      type: 'rgbm', rgbm: true, mipmaps: false,
      minfilter: 'linear', magfilter: 'linear', addressu: 'clamp', addressv: 'clamp',
    });
    asset.once('error', (err) => reject(new Error(`lightmap: ${err}`)));
    asset.ready(() => {
      const t = asset.resource;
      if (t?.encoding !== 'rgbm') reject(new Error(`lightmap decoded as ${t?.encoding}, not rgbm`));
      else resolve(t);
    });
    app.assets.add(asset);
    app.assets.load(asset);
  });
}
