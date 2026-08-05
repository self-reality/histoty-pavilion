import * as pc from 'playcanvas';
import { FOG_TYPES, FOG_TYPE_NAMES, fogTypeName } from './atmosphere.mjs';

const { Color, Entity } = pc;

// Surface classes by |normal.y|: horizontal-ish = floor-like, vertical = wall.
const FLOOR = 0, SLOPE = 1, WALL = 2;
const CLASS_COLOR = [
  new Color(0.25, 0.95, 0.35),  // FLOOR — green (what you can stand on)
  new Color(1.0, 0.78, 0.15),   // SLOPE — amber (steep, you may slide)
  new Color(0.95, 0.25, 0.25),  // WALL  — red
];

function classify(ny) {
  const a = Math.abs(ny);
  if (a > 0.7) return FLOOR;
  if (a > 0.45) return SLOPE;   // ~0.5 is the controller's ground threshold
  return WALL;
}

function flatMat(color) {
  const m = new pc.StandardMaterial();
  m.useLighting = false;               // show emissive as a flat, readable colour
  m.diffuse = new Color(0, 0, 0);
  m.emissive = color;
  m.opacity = 0.9;
  m.blendType = pc.BLEND_NORMAL;
  m.depthTest = true;
  m.depthWrite = true;
  m.cull = pc.CULLFACE_NONE;
  m.update();
  return m;
}

// The panel's markup and CSS both live here rather than in the page, because
// this module is only loaded in debug mode (see debugmode.mjs) and a production
// page that carries the panel's stylesheet is a production page one line away
// from carrying the panel. Nothing outside this file knows the panel exists.
const PANEL_ID = 'debugPanel';
const STYLE_ID = 'debugPanelStyle';

const CSS = `
#${PANEL_ID} {
  position: fixed; top: 12px; right: 12px; width: 236px; z-index: 30;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
  color: #dfe3e8; background: rgba(14, 17, 22, 0.86);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  backdrop-filter: blur(6px); box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  max-height: calc(100vh - 24px); overflow-y: auto; user-select: none;
}
#${PANEL_ID}.dbg-hidden { display: none; }
#${PANEL_ID}::-webkit-scrollbar { width: 8px; }
#${PANEL_ID}::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 4px; }
.dbg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.1);
  position: sticky; top: 0; background: rgba(14,17,22,0.95);
}
.dbg-title { letter-spacing: 3px; font-weight: 700; color: #ffcf5a; font-size: 11px; }
.dbg-x {
  background: none; border: none; color: #aab; font-size: 16px; line-height: 1;
  cursor: pointer; padding: 0 4px;
}
.dbg-body { padding: 10px 12px 14px; }
.dbg-body.dbg-hidden { display: none; }
.dbg-sec {
  margin: 12px 0 6px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
  color: #8b93a0;
}
.dbg-stats { display: grid; grid-template-columns: 1fr; gap: 3px; }
.dbg-stat { display: flex; justify-content: space-between; }
.dbg-k { color: #8b93a0; }
.dbg-v { color: #eaeef3; }
.dbg-seg { display: flex; gap: 4px; }
.dbg-segbtn {
  flex: 1; padding: 5px 0; font: inherit; font-size: 11px; cursor: pointer;
  color: #cdd3da; background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
}
.dbg-segbtn.on { background: #ffcf5a; color: #1a140a; border-color: #ffcf5a; font-weight: 700; }
.dbg-slider { margin: 7px 0; }
.dbg-slabel { display: flex; justify-content: space-between; margin-bottom: 2px; color: #b9c0c9; }
.dbg-sval { color: #ffcf5a; }
.dbg-slider input[type=range] { width: 100%; accent-color: #ffcf5a; }
.dbg-color { display: flex; align-items: center; justify-content: space-between; margin: 7px 0; color: #b9c0c9; }
.dbg-color input[type=color] {
  width: 56px; height: 20px; padding: 0; cursor: pointer; background: none;
  border: 1px solid rgba(255,255,255,0.2); border-radius: 4px;
}
.dbg-row { display: flex; gap: 6px; margin: 6px 0; }
.dbg-btn {
  flex: 1; padding: 7px 6px; font: inherit; font-size: 11px; cursor: pointer;
  color: #eaeef3; background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
}
.dbg-btn:hover { background: rgba(255,255,255,0.16); }
`;

/**
 * Find or create the panel's <style> and root element.
 *
 * Both are keyed by id and reused, so rebuilding the panel (an Editor
 * hot-reload re-runs the whole script) replaces its contents instead of
 * stacking a second copy on top of the first.
 */
function ensurePanelRoot() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let root = document.getElementById(PANEL_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = PANEL_ID;
    document.body.appendChild(root);
  }
  return root;
}

/**
 * Toggle the panel's visibility (bound to the backtick key by both builds).
 * A no-op when there is no panel, which is every production page.
 */
export function togglePanel() {
  document.getElementById(PANEL_ID)?.classList.toggle('dbg-hidden');
}

/**
 * Drop the panel and its stylesheet. The Editor build calls this when the
 * script tears down, so a hot-reload never leaves a panel wired to a dead game.
 */
export function removePanel() {
  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * DebugTools — owns the right-side tweak panel and the diagnostics behind it:
 *   • view modes: textured / wireframe / collision-normals overlay
 *   • live readouts for position / grounded / vertical speed
 *   • live sliders for the movement/controller params
 *   • live atmosphere / surface / lighting sliders (see atmosphere.mjs)
 *
 * Only built in debug mode — the entry points construct this behind
 * isDebugMode() (see debugmode.mjs), so production ships no sliders.
 *
 * The look sections are optional: pass `surface` (a SurfaceLook), `sun` and
 * `fill` (directional light entities) to get them. Without them the panel is
 * exactly what it was before, so nothing here needs a fully-wired scene.
 */
export class DebugTools {
  constructor({ app, player, collider, mapRender, spawn, surface, sun, fill, camera }) {
    this.app = app;
    this.player = player;
    this.collider = collider;
    this.mapRender = mapRender;   // entity holding the textured map render
    this.spawn = spawn;
    this.surface = surface;       // SurfaceLook over the map materials (optional)
    this.sun = sun;               // key directional light (optional)
    this.fill = fill;             // bounce/sky fill light (optional)
    this.camera = camera;         // main camera entity — owns the sky clear colour

    this.mode = 0;                // 0 textured, 1 wireframe, 2 normals
    this._frame = 0;
    this.rigs = [];               // PropRigs, added as their props finish loading

    this._mapMeshInstances = [];
    for (const rc of mapRender.findComponents('render')) {
      for (const mi of rc.meshInstances) this._mapMeshInstances.push(mi);
    }

    this._buildOverlay();
    this._buildPanel();
    this.setMode(0);
  }

  // ---- Collision-normals overlay (one flat mesh per surface class) ----
  _buildOverlay() {
    this._overlay = new Entity('collisionOverlay');
    const buckets = [[], [], []];
    for (const t of this.collider.tris) buckets[classify(t.n.y)].push(t);

    const device = this.app.graphicsDevice;
    for (let cls = 0; cls < 3; cls++) {
      const tris = buckets[cls];
      if (!tris.length) continue;
      const positions = new Array(tris.length * 9);
      const indices = new Array(tris.length * 3);
      let p = 0, ii = 0;
      for (const t of tris) {
        positions[p++] = t.a.x; positions[p++] = t.a.y; positions[p++] = t.a.z;
        positions[p++] = t.b.x; positions[p++] = t.b.y; positions[p++] = t.b.z;
        positions[p++] = t.c.x; positions[p++] = t.c.y; positions[p++] = t.c.z;
        indices[ii] = ii++; indices[ii] = ii++; indices[ii] = ii++;
      }
      const mesh = new pc.Mesh(device);
      mesh.setPositions(positions);
      mesh.setIndices(indices);
      mesh.update(pc.PRIMITIVE_TRIANGLES);
      const mi = new pc.MeshInstance(mesh, flatMat(CLASS_COLOR[cls]));
      const child = new Entity('overlay' + cls);
      child.addComponent('render', { meshInstances: [mi] });
      this._overlay.addChild(child);
    }
    // Triangles are already world-space, so keep the overlay at the origin.
    this._overlay.enabled = false;
    this.app.root.addChild(this._overlay);
  }

  /**
   * Rebuild the normals overlay from the collider's current triangles.
   *
   * The overlay is baked geometry, so it goes stale the moment the collider
   * gains anything — which it now does every time a solid prop finishes
   * loading. Without this, pressing V after a prop lands would show the map's
   * collision and quietly omit the prop's.
   */
  rebuildOverlay() {
    const wasEnabled = this._overlay?.enabled ?? false;
    this._overlay?.destroy();
    this._buildOverlay();
    this._overlay.enabled = wasEnabled;
  }

  setMode(mode) {
    this.mode = mode;
    const wire = mode === 1 ? pc.RENDERSTYLE_WIREFRAME : pc.RENDERSTYLE_SOLID;
    for (const mi of this._mapMeshInstances) mi.renderStyle = wire;
    this.mapRender.enabled = mode !== 2;   // hide texture under the normals overlay
    this._overlay.enabled = mode === 2;
    if (this._segBtns) {
      this._segBtns.forEach((b, i) => b.classList.toggle('on', i === mode));
    }
  }

  cycleMode() { this.setMode((this.mode + 1) % 3); }

  // ---- Right-side tweak panel ----
  _buildPanel() {
    const root = ensurePanelRoot();
    root.innerHTML = '';
    root.classList.remove('dbg-hidden');

    const head = el('div', 'dbg-head', root);
    // The two keys the panel itself can't show you: it is the only place they
    // are documented now that production's controls list doesn't mention them.
    head.title = '` toggles this panel · V cycles the view mode';
    el('span', 'dbg-title', head).textContent = 'DEBUG';
    const collapse = el('button', 'dbg-x', head); collapse.textContent = '–';
    const bodyWrap = el('div', 'dbg-body', root);
    collapse.onclick = () => {
      const hidden = bodyWrap.classList.toggle('dbg-hidden');
      collapse.textContent = hidden ? '+' : '–';
    };

    // Live readouts.
    const stats = el('div', 'dbg-stats', bodyWrap);
    this._rPos = stat(stats, 'pos');
    this._rGround = stat(stats, 'grounded');
    this._rVspd = stat(stats, 'v-speed');
    this._rMode = stat(stats, 'view');

    // View-mode segmented control.
    section(bodyWrap, 'View');
    const seg = el('div', 'dbg-seg', bodyWrap);
    this._segBtns = ['Textured', 'Wire', 'Normals'].map((label, i) => {
      const b = el('button', 'dbg-segbtn', seg);
      b.textContent = label;
      b.onclick = () => this.setMode(i);
      return b;
    });

    // Live controller sliders.
    section(bodyWrap, 'Controller');
    slider(bodyWrap, 'gravity', 4, 40, 0.5, this.player.gravity, (v) => this.player.gravity = v);
    slider(bodyWrap, 'jump', 3, 12, 0.1, this.player.jumpSpeed, (v) => this.player.jumpSpeed = v);
    slider(bodyWrap, 'walk', 2, 14, 0.5, this.player.walkSpeed, (v) => this.player.walkSpeed = v);
    slider(bodyWrap, 'run', 4, 18, 0.5, this.player.runSpeed, (v) => this.player.runSpeed = v);
    slider(bodyWrap, 'radius', 0.2, 0.9, 0.02, this.player.radius, (v) => this.player.setRadius(v));
    // Climb height: the tallest step/stair the player walks up without jumping
    // (drives player.stepHeight — see _horizontalWithStep). Raise it if there are
    // stairs the player can't get up; ~0.5 = knee-high, 1.5 = waist-high.
    slider(bodyWrap, 'climb height', 0.1, 1.5, 0.05, this.player.stepHeight, (v) => this.player.stepHeight = v);

    this._buildAtmosphere(bodyWrap);
    this._buildSurface(bodyWrap);
    this._buildLighting(bodyWrap);

    // Actions.
    section(bodyWrap, 'Actions');
    const row = el('div', 'dbg-row', bodyWrap);
    button(row, 'Teleport spawn', () => this.player.teleport(this.spawn.x, this.spawn.y, this.spawn.z));

    // Rig sections are appended here as props land — they can't be built up
    // front because the GLBs load well after the panel does.
    this._body = bodyWrap;
    for (const rig of this.rigs) this._buildRig(rig);
  }

  /**
   * Add a placed prop's rig to the panel.
   *
   * Called from the prop loader, which finishes long after _buildPanel, so this
   * appends rather than assuming a build order — and it tolerates being called
   * before the panel exists, so wiring order stays the caller's business.
   */
  addRig(rig) {
    this.rigs.push(rig);
    if (this._body) this._buildRig(rig);
  }

  // ---- One prop's joints, as live sliders (see src/rig.mjs) ----
  //
  // A pose is a couple of dozen angles that only mean anything when you look at
  // them, so this is the authoring tool, not a diagnostic: drag until it reads
  // right, hit Copy, paste into the manifest's `rigs`. Folded by default because
  // a rig is 3 sliders per bone and would otherwise bury the rest of the panel.
  _buildRig(rig) {
    const parent = this._body;
    const head = el('div', 'dbg-sec', parent);
    const group = el('div', '', parent);
    group.classList.add('dbg-hidden');
    const label = `Rig — ${rig.label} (${rig.count})`;
    head.textContent = `▸ ${label}`;
    head.style.cursor = 'pointer';
    head.onclick = () => {
      const hidden = group.classList.toggle('dbg-hidden');
      head.textContent = `${hidden ? '▸' : '▾'} ${label}`;
    };

    // Strip the boilerplate the pattern needs but the eye doesn't:
    // "ValveBiped.Bip01_L_Thigh*" reads as "L_Thigh".
    const short = (pattern) => pattern.replace(/^ValveBiped\.Bip01_/, '').replace(/\*$/, '');

    // Half-degree steps: solved joint angles land on halves, and a 1° slider
    // would show -73 for a bone actually sitting at -72.5 — the readout has to
    // agree with what Copy pose writes back.
    for (const bone of rig.bones) {
      for (let axis = 0; axis < 3; axis++) {
        slider(group, `${short(bone.pattern)} ${'xyz'[axis]}`, -180, 180, 0.5, bone.angles[axis],
          (v) => rig.set(bone.pattern, axis, v), 1);
      }
    }
    // Carried nodes. Their deltas are in model units, so the range is derived
    // from the prop's own scale — ±2 m of travel whatever the model was authored
    // in, instead of a number that means 7 cm on one prop and 70 m on the next.
    const perMetre = 1 / (rig.root.getLocalScale().x || 1);
    for (const move of rig.moves) {
      for (let axis = 0; axis < 3; axis++) {
        slider(group, `${short(move.pattern)} ${'xyz'[axis]}`, -2 * perMetre, 2 * perMetre, perMetre / 200,
          move.delta[axis], (v) => rig.setMove(move.pattern, axis, v), 1);
      }
    }
    // Seat height. Sitting drops the hips ~1 m; this is the knob that finds it.
    for (let axis = 0; axis < 3; axis++) {
      slider(group, `offset ${'xyz'[axis]} (m)`, -3, 3, 0.01, rig.offset[['x', 'y', 'z'][axis]],
        (v) => rig.setOffset(axis, v), 2);
    }

    const row = el('div', 'dbg-row', group);
    button(row, 'Copy pose', () => {
      const text = `'${rig.label}': ${JSON.stringify(rig.toSpec(), null, 2)},`;
      console.log(text);
      navigator.clipboard?.writeText(text).catch(() => {});   // console copy is the fallback
    });
  }

  // ---- Fog. scene.fog is read by the renderer every frame, so writing its
  // fields here IS the apply — there is nothing to flush.
  _buildAtmosphere(parent) {
    const fog = this.app.scene.fog;

    section(parent, 'Atmosphere (fog)');
    segmented(parent, FOG_TYPE_NAMES, FOG_TYPE_NAMES.indexOf(fogTypeName(fog.type)),
      (name) => { fog.type = FOG_TYPES[name]; });
    colorPicker(parent, 'color', fog.color, (c) => fog.color.copy(c));
    // start/end drive linear fog, density drives exp/exp2. Both stay live so you
    // can switch type and keep the numbers you already dialled in.
    slider(parent, 'start (m)', 0, 120, 1, fog.start, (v) => fog.start = v);
    slider(parent, 'end (m)', 5, 400, 1, fog.end, (v) => fog.end = v);
    slider(parent, 'density', 0, 0.06, 0.001, fog.density, (v) => fog.density = v, 3);
  }

  // ---- Map PBR response. See atmosphere.mjs for why `roughness` is the knob
  // and not PlayCanvas's `gloss`.
  _buildSurface(parent) {
    if (!this.surface) return;
    const p = this.surface.params;

    section(parent, 'Map surface');
    slider(parent, 'roughness', 0, 1, 0.01, p.roughness, (v) => this.surface.set('roughness', v));
    slider(parent, 'specular', 0, 1, 0.01, p.specular, (v) => this.surface.set('specular', v));
    slider(parent, 'metalness', 0, 1, 0.01, p.metalness, (v) => this.surface.set('metalness', v));
  }

  // ---- The lights the surface is reacting to, plus the sky it sits against.
  _buildLighting(parent) {
    if (!this.sun) return;
    const scene = this.app.scene;
    const sunLight = this.sun.light;

    section(parent, 'Lighting');
    slider(parent, 'sun', 0, 6, 0.05, sunLight.intensity, (v) => sunLight.intensity = v);
    // Euler X/Y of a directional light is just its direction: pitch = elevation
    // (90 = straight down / noon), yaw = compass bearing. The range spans the
    // full -90..90 so an Editor-authored light is never shown clamped to a
    // number it isn't actually at.
    const angles = this.sun.getEulerAngles();
    let pitch = angles.x, yaw = angles.y;
    slider(parent, 'sun pitch', -90, 90, 1, pitch, (v) => { pitch = v; this.sun.setEulerAngles(pitch, yaw, 0); });
    slider(parent, 'sun yaw', -180, 180, 1, yaw, (v) => { yaw = v; this.sun.setEulerAngles(pitch, yaw, 0); });
    if (this.fill) {
      slider(parent, 'fill', 0, 3, 0.05, this.fill.light.intensity, (v) => this.fill.light.intensity = v);
    }
    // ambientLight is a colour, but the useful knob is its brightness — keep the
    // authored hue and scale it.
    const ambientHue = scene.ambientLight.clone();
    const peak = Math.max(ambientHue.r, ambientHue.g, ambientHue.b) || 1;
    ambientHue.set(ambientHue.r / peak, ambientHue.g / peak, ambientHue.b / peak);
    slider(parent, 'ambient', 0, 1.5, 0.01, peak, (v) => {
      scene.ambientLight = new Color(ambientHue.r * v, ambientHue.g * v, ambientHue.b * v);
    });
    if (this.camera?.camera) {
      colorPicker(parent, 'sky', this.camera.camera.clearColor, (c) => this.camera.camera.clearColor = c);
    }
  }

  // Called from the game loop; light DOM writes, throttled.
  updateReadout() {
    if (((this._frame++) & 3) !== 0) return;
    const p = this.player;
    this._rPos.textContent = `${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)}`;
    this._rGround.textContent = p.grounded ? 'yes' : 'airborne';
    this._rGround.style.color = p.grounded ? '' : '#ff7676';
    this._rVspd.textContent = p.vel.y.toFixed(1);
    this._rMode.textContent = ['textured', 'wireframe', 'normals'][this.mode];
  }
}

// ---- tiny DOM helpers ----
function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}
function section(parent, label) { el('div', 'dbg-sec', parent).textContent = label; }
function stat(parent, label) {
  const row = el('div', 'dbg-stat', parent);
  el('span', 'dbg-k', row).textContent = label;
  return el('span', 'dbg-v', row);
}
function slider(parent, label, min, max, step, val, onInput, digits = 2) {
  const row = el('div', 'dbg-slider', parent);
  const head = el('div', 'dbg-slabel', row);
  el('span', '', head).textContent = label;
  const out = el('span', 'dbg-sval', head); out.textContent = (+val).toFixed(digits);
  const input = el('input', '', row);
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = val;
  input.oninput = () => { const v = +input.value; out.textContent = v.toFixed(digits); onInput(v); };
  return input;
}
// Generic segmented control. Calls back with the picked label, not its index,
// so the caller reads as prose ('linear', 'exp2') rather than magic numbers.
function segmented(parent, labels, current, onPick) {
  const seg = el('div', 'dbg-seg', parent);
  const btns = labels.map((label, i) => {
    const b = el('button', 'dbg-segbtn', seg);
    b.textContent = label;
    b.classList.toggle('on', i === current);
    b.onclick = () => {
      btns.forEach((other, j) => other.classList.toggle('on', j === i));
      onPick(label, i);
    };
    return b;
  });
  return btns;
}
// Colour swatch bound to a pc.Color. Hands the callback a fresh Color so the
// caller decides whether to copy in place or assign.
function colorPicker(parent, label, color, onInput) {
  const row = el('div', 'dbg-color', parent);
  el('span', '', row).textContent = label;
  const input = el('input', '', row);
  input.type = 'color';
  input.value = rgb2hex(color);
  input.oninput = () => onInput(hex2rgb(input.value));
  return input;
}
const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
function rgb2hex(c) { return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`; }
function hex2rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function button(parent, label, onClick) {
  const b = el('button', 'dbg-btn', parent);
  b.textContent = label; b.onclick = onClick;
  return b;
}
