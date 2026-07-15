import * as pc from 'playcanvas';

const { Vec3, Color, Entity } = pc;

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
 *   • fall tracking with in-world beacons + a copyable log
 *   • an automated hole-sweep that drops the capsule on every floor sample
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
    this.showMarkers = true;
    this.falls = [];              // { x, y, z, count, reason }
    this._lastGround = null;
    this._falling = false;
    this._sweeping = false;
    this._frame = 0;

    this._mapMeshInstances = [];
    for (const rc of mapRender.findComponents('render')) {
      for (const mi of rc.meshInstances) this._mapMeshInstances.push(mi);
    }

    this._buildOverlay();
    this._markersRoot = new Entity('fallMarkers');
    app.root.addChild(this._markersRoot);

    this._buildPanel();
    this._restore();
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

  // ---- Fall tracking (called every frame from the game loop) ----
  track() {
    if (this._sweeping) return;
    const p = this.player;
    const b = this.collider.bounds;
    if (p.grounded) {
      if (!this._lastGround) this._lastGround = new Vec3();
      this._lastGround.copy(p.pos);
      this._falling = false;
      return;
    }
    if (!this._lastGround || this._falling) return;
    // A genuine fall: dropped well below the last ground without re-catching,
    // or plunged out of the world entirely.
    const dropped = this._lastGround.y - p.pos.y;
    if ((dropped > 3 && p.vel.y < -1) || p.pos.y < b.miny - 5) {
      this._falling = true;
      this.recordFall(this._lastGround.x, this._lastGround.y, this._lastGround.z, 'play');
    }
  }

  recordFall(x, y, z, reason) {
    // Merge with a nearby existing spot instead of stacking duplicates.
    for (const f of this.falls) {
      if ((f.x - x) ** 2 + (f.z - z) ** 2 < 4) { f.count++; this._renderFalls(); this._persist(); return; }
    }
    const f = { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), count: 1, reason };
    console.log('[[FALL]] ' + JSON.stringify(f)); // before the (circular) marker entity is attached
    this.falls.push(f);
    this._addMarker(f);
    this._renderFalls();
    this._persist();
  }

  _addMarker(f) {
    const m = new Entity('mark');
    const ball = new Entity();
    ball.addComponent('render', { type: 'sphere', castShadows: false });
    ball.render.meshInstances[0].material = flatMat(new Color(1, 0.15, 0.15));
    ball.setLocalScale(0.6, 0.6, 0.6);
    ball.setLocalPosition(0, 0.3, 0);
    m.addChild(ball);
    const beam = new Entity();
    beam.addComponent('render', { type: 'cylinder', castShadows: false });
    const bm = flatMat(new Color(1, 0.15, 0.15)); bm.opacity = 0.35; bm.update();
    beam.render.meshInstances[0].material = bm;
    beam.setLocalScale(0.12, 6, 0.12);
    beam.setLocalPosition(0, 6, 0);
    m.addChild(beam);
    m.setPosition(f.x, f.y, f.z);
    m.enabled = this.showMarkers;
    f._marker = m;
    this._markersRoot.addChild(m);
  }

  clearFalls() {
    for (const f of this.falls) if (f._marker) f._marker.destroy();
    this.falls = [];
    this._renderFalls();
    this._persist();
  }

  logText() {
    if (!this.falls.length) return '(no falls recorded)';
    return this.falls
      .map(f => `x=${f.x}  z=${f.z}  (y=${f.y})  ×${f.count}  [${f.reason}]`)
      .join('\n');
  }

  // ---- Automated hole-sweep ----
  // Drops the capsule onto every floor sample twice: a settle test (does it stay
  // put?) and a high-drop test (does a fast fall tunnel through?). Blocks for a
  // moment — it runs the controller synchronously, outside the render loop.
  sweep() {
    const floors = this.player.floors || [];
    if (!floors.length) return { tested: 0, holes: [] };
    this._sweeping = true;
    const saved = { pos: this.player.pos.clone(), vel: this.player.vel.clone(), g: this.player.grounded };
    const zero = { forward: 0, strafe: 0, jump: false, sprint: false };
    const dt = 1 / 60;
    const holes = [];

    // Returns true only if the capsule passes DOWN through the floor plane (a
    // real fall-through). Being caught by any surface — including landing on
    // higher geometry or sticking to a ledge — does NOT count as a hole.
    const fellThrough = (x, floorY, z, startY, maxFrames) => {
      this.player.teleport(x, startY, z);
      for (let i = 0; i < maxFrames; i++) {
        this.player.update(dt, zero);
        if (this.player.pos.y < floorY - 2) return true;   // went through the floor
        if (this.player.grounded) return false;            // caught by a surface
      }
      return this.player.pos.y < floorY - 1;               // never settled, still sinking
    };

    for (const s of floors) {
      // settle: dropped right onto the floor — does it stay, or is there a gap?
      if (fellThrough(s.x, s.y, s.z, s.y + 0.2, 90)) { holes.push({ x: s.x, y: s.y, z: s.z, reason: 'settle' }); continue; }
      // tunnel: does a fast fall from height punch straight through the floor?
      if (fellThrough(s.x, s.y, s.z, s.y + 6, 150)) holes.push({ x: s.x, y: s.y, z: s.z, reason: 'tunnel' });
    }

    // Restore the player exactly where they were.
    this.player.pos.copy(saved.pos);
    this.player.vel.copy(saved.vel);
    this.player.grounded = saved.g;
    this._sweeping = false;

    for (const h of holes) this.recordFall(h.x, h.y, h.z, h.reason);
    console.log(`[[SWEEP]] tested ${floors.length} floor samples, ${holes.length} fell through`);
    return { tested: floors.length, holes };
  }

  // ---- localStorage persistence ----
  _persist() {
    try { localStorage.setItem('dust2.falls', JSON.stringify(this.falls.map(({ _marker, ...r }) => r))); } catch {}
  }
  _restore() {
    try {
      const raw = localStorage.getItem('dust2.falls');
      if (!raw) return;
      for (const f of JSON.parse(raw)) this.recordFall(f.x, f.y, f.z, f.reason || 'saved');
    } catch {}
  }

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

    // Toggles.
    section(bodyWrap, 'Options');
    this._chkMarkers = check(bodyWrap, 'Fall markers', this.showMarkers, (v) => {
      this.showMarkers = v;
      for (const f of this.falls) if (f._marker) f._marker.enabled = v;
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
    section(bodyWrap, 'Falls');
    this._fallCount = el('div', 'dbg-count', bodyWrap);
    const rowA = el('div', 'dbg-row', bodyWrap);
    button(rowA, 'Sweep for holes', () => {
      this._fallCount.textContent = 'sweeping…';
      // Let the label paint before the blocking sweep.
      setTimeout(() => { const r = this.sweep(); this._flash(`swept ${r.tested}, ${r.holes.length} holes`); }, 20);
    });
    button(rowA, 'Teleport spawn', () => this.player.teleport(this.spawn.x, this.spawn.y, this.spawn.z));
    const rowB = el('div', 'dbg-row', bodyWrap);
    button(rowB, 'Copy log', async () => {
      const txt = this.logText();
      try { await navigator.clipboard.writeText(txt); this._flash('copied'); }
      catch { this._flash('see console'); }
      console.log('[[FALLLOG]]\n' + txt);
    });
    button(rowB, 'Clear', () => { this.clearFalls(); this._flash('cleared'); });

    this._fallList = el('div', 'dbg-list', bodyWrap);
    this._renderFalls();
  }

  _flash(msg) {
    this._fallCount.textContent = msg;
    this._fallCount.classList.add('dbg-flash');
    setTimeout(() => this._fallCount && this._fallCount.classList.remove('dbg-flash'), 600);
  }

  _renderFalls() {
    if (!this._fallList) return;
    this._fallCount.textContent = this.falls.length + ' spot' + (this.falls.length === 1 ? '' : 's');
    this._fallList.innerHTML = '';
    this.falls.forEach((f, i) => {
      const row = el('div', 'dbg-fall', this._fallList);
      const label = el('span', '', row);
      label.textContent = `${f.x}, ${f.z}`;
      const tag = el('span', 'dbg-tag', row);
      tag.textContent = f.reason + (f.count > 1 ? ' ×' + f.count : '');
      row.title = 'Teleport here';
      row.onclick = () => this.player.teleport(f.x, f.y + 1.5, f.z);
    });
  }

  // Called from the game loop; light DOM writes, throttled.
  updateReadout() {
    if (((this._frame++) & 3) !== 0) return;
    const p = this.player;
    this._rPos.textContent = `${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)}`;
    this._rGround.textContent = p.grounded ? 'yes' : 'FALLING';
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
function check(parent, label, val, onChange) {
  const row = el('label', 'dbg-check', parent);
  const input = el('input', '', row); input.type = 'checkbox'; input.checked = val;
  input.onchange = () => onChange(input.checked);
  el('span', '', row).textContent = label;
  return input;
}
function button(parent, label, onClick) {
  const b = el('button', 'dbg-btn', parent);
  b.textContent = label; b.onclick = onClick;
  return b;
}
