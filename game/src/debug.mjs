import * as pc from 'playcanvas';

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

/**
 * DebugTools — owns the right-side tweak panel and the diagnostics behind it:
 *   • view modes: textured / wireframe / collision-normals overlay
 *   • live readouts for position / grounded / vertical speed
 *   • live sliders for the movement/controller params
 */
export class DebugTools {
  constructor({ app, player, collider, mapRender, spawn }) {
    this.app = app;
    this.player = player;
    this.collider = collider;
    this.mapRender = mapRender;   // entity holding the textured map render
    this.spawn = spawn;

    this.mode = 0;                // 0 textured, 1 wireframe, 2 normals
    this._frame = 0;

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
    const root = document.getElementById('debugPanel');
    root.innerHTML = '';
    root.classList.remove('dbg-hidden');

    const head = el('div', 'dbg-head', root);
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

    // Actions.
    section(bodyWrap, 'Actions');
    const row = el('div', 'dbg-row', bodyWrap);
    button(row, 'Teleport spawn', () => this.player.teleport(this.spawn.x, this.spawn.y, this.spawn.z));
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
function slider(parent, label, min, max, step, val, onInput) {
  const row = el('div', 'dbg-slider', parent);
  const head = el('div', 'dbg-slabel', row);
  el('span', '', head).textContent = label;
  const out = el('span', 'dbg-sval', head); out.textContent = (+val).toFixed(2);
  const input = el('input', '', row);
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = val;
  input.oninput = () => { const v = +input.value; out.textContent = v.toFixed(2); onInput(v); };
  return input;
}
function button(parent, label, onClick) {
  const b = el('button', 'dbg-btn', parent);
  b.textContent = label; b.onclick = onClick;
  return b;
}
