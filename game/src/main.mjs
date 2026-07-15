import * as pc from 'playcanvas';
import { TriangleCollider } from './collision.mjs';
import { Player } from './player.mjs';
import { Weapon } from './weapon.mjs';
import { DebugTools } from './debug.mjs';

const { Vec3, Color, Entity, Asset } = pc;

// ---- Map transform: Source units, Z-up -> PlayCanvas metres, Y-up ----
const MAP_SCALE = 0.025;          // ~112 m across, human scale
const MAP_EULER = new Vec3(-90, 0, 0);

// ---- UI handles ----
const ui = {
  overlay: document.getElementById('overlay'),
  playBtn: document.getElementById('playBtn'),
  loading: document.getElementById('loading'),
  crosshair: document.getElementById('crosshair'),
  dot: document.getElementById('dot'),
  hud: document.getElementById('hud'),
  hitmarker: document.getElementById('hitmarker'),
  hud_mag: document.getElementById('mag'),
  hud_reserve: document.getElementById('reserve'),
  hud_reloading: document.getElementById('reloading'),
  scoreVal: document.getElementById('scoreVal'),
};

let score = 0;
function addScore(n) { score += n; ui.scoreVal.textContent = score; }

let hitmarkerTimer = 0;
const hud = {
  mag: ui.hud_mag,
  reserve: ui.hud_reserve,
  reloading: ui.hud_reloading,
  hit() { ui.hitmarker.style.opacity = 1; hitmarkerTimer = 0.12; },
};

// ---- Engine ----
const canvas = document.getElementById('app');
const app = new pc.Application(canvas, {
  mouse: new pc.Mouse(canvas),
  keyboard: new pc.Keyboard(window),
  graphicsDeviceOptions: { antialias: true, alpha: false, preferWebGl2: true },
});
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());

const SKY = new Color(0.61, 0.71, 0.83);
app.scene.ambientLight = new Color(0.55, 0.53, 0.5);
if ('exposure' in app.scene) app.scene.exposure = 1.0;

// ---- Lights ----
const sun = new Entity('sun');
sun.addComponent('light', {
  type: 'directional',
  color: new Color(1.0, 0.96, 0.86),
  intensity: 2.4,
  castShadows: true,
  shadowBias: 0.2,
  normalOffsetBias: 0.06,
  shadowDistance: 90,
  shadowResolution: 2048,
  shadowType: pc.SHADOW_PCF3 ?? undefined,
});
sun.setEulerAngles(52, 28, 0);
app.root.addChild(sun);

const fill = new Entity('fill');
fill.addComponent('light', { type: 'directional', color: new Color(0.6, 0.7, 0.85), intensity: 0.5, castShadows: false });
fill.setEulerAngles(120, -140, 0);
app.root.addChild(fill);

// ---- Viewmodel layer (drawn on top, depth cleared → gun never clips walls) ----
const vmLayer = new pc.Layer({ name: 'Viewmodel' });
app.scene.layers.push(vmLayer);

// ---- Camera + Player rig ----
const playerRoot = new Entity('player');
const cameraEntity = new Entity('camera');
cameraEntity.addComponent('camera', {
  clearColor: SKY,
  fov: 78,
  nearClip: 0.05,
  farClip: 600,
});
playerRoot.addChild(cameraEntity);
app.root.addChild(playerRoot);

// Second camera that renders ONLY the viewmodel layer, on top of the scene.
const vmCamera = new Entity('vmCamera');
vmCamera.addComponent('camera', {
  clearColorBuffer: false,
  clearDepthBuffer: true,
  fov: 65,
  nearClip: 0.01,
  farClip: 50,
  layers: [vmLayer.id],
  priority: 1,
});
cameraEntity.addChild(vmCamera);

// A light bound to the viewmodel layer so the gun is shaded (not just ambient).
const vmLight = new Entity('vmLight');
vmLight.addComponent('light', {
  type: 'directional', color: new Color(1, 0.97, 0.9), intensity: 2.2,
  castShadows: false, layers: [vmLayer.id],
});
vmLight.setEulerAngles(45, 20, 0);
app.root.addChild(vmLight);

let player = null;
let weapon = null;
let targets = null;
let collider = null;
let debug = null;
let started = false;

// ---- Targets ----
class TargetManager {
  constructor(app, collider, spots) {
    this.app = app;
    this.collider = collider;
    this.spots = spots;
    this.list = [];
    this.bodyMat = standard(0.85, 0.12, 0.1, [0.45, 0.04, 0.03]);
    this.headMat = standard(0.95, 0.8, 0.2, [0.5, 0.4, 0.05]);
    this.count = Math.min(10, spots.length);
    for (let i = 0; i < this.count; i++) this._spawn(i, this.spots[(i * 7) % this.spots.length]);
  }

  _spawn(i, spot) {
    const root = new Entity('target' + i);
    const H = 1.7, R = 0.32;
    const body = new Entity();
    body.addComponent('render', { type: 'capsule', material: this.bodyMat, castShadows: true });
    body.setLocalScale(R * 2, H / 2, R * 2);
    body.setLocalPosition(0, H / 2, 0);
    root.addChild(body);
    const head = new Entity();
    head.addComponent('render', { type: 'sphere', material: this.headMat, castShadows: true });
    head.setLocalScale(0.34, 0.34, 0.34);
    head.setLocalPosition(0, H + 0.05, 0);
    root.addChild(head);

    root.setPosition(spot.x, spot.y, spot.z);
    this.app.root.addChild(root);

    const t = {
      entity: root, alive: true, respawn: 0,
      center: new Vec3(spot.x, spot.y + H * 0.5, spot.z),
      head: new Vec3(spot.x, spot.y + H + 0.05, spot.z),
      bodyR: R + 0.12, headR: 0.28,
      onHit: () => this._hit(t),
    };
    this.list[i] = t;
  }

  _hit(t) {
    if (!t.alive) return;
    t.alive = false;
    t.entity.enabled = false;
    t.respawn = 2.4;
    addScore(100);
  }

  // Ray vs target spheres (body + head). Returns {dist, point, target} or null.
  query(origin, dir, maxDist) {
    let best = maxDist, hit = null, hpoint = null;
    for (const t of this.list) {
      if (!t.alive) continue;
      for (const [c, r] of [[t.center, t.bodyR], [t.head, t.headR]]) {
        const d = raySphere(origin, dir, c, r);
        if (d > 0 && d < best) {
          best = d; hit = t;
          hpoint = new Vec3().copy(dir).mulScalar(d).add(origin);
        }
      }
    }
    return hit ? { dist: best, point: hpoint, target: hit } : null;
  }

  update(dt) {
    for (const t of this.list) {
      if (t.alive) continue;
      t.respawn -= dt;
      if (t.respawn <= 0) {
        const spot = this.spots[Math.floor(Math.random() * this.spots.length)];
        t.center.set(spot.x, spot.y + 0.85, spot.z);
        t.head.set(spot.x, spot.y + 1.75, spot.z);
        t.entity.setPosition(spot.x, spot.y, spot.z);
        t.entity.enabled = true;
        t.alive = true;
      }
    }
  }
}

function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : -1;
}

function standard(r, g, b, emissive) {
  const m = new pc.StandardMaterial();
  m.diffuse = new Color(r, g, b);
  m.useMetalness = true; m.metalness = 0; m.gloss = 0.25;
  if (emissive) m.emissive = new Color(emissive[0], emissive[1], emissive[2]);
  m.update();
  return m;
}

// ---- Triangle extraction (world space) ----
function extractTriangles(rootEntity) {
  const tris = [];
  const renders = rootEntity.findComponents('render');
  for (const rc of renders) {
    for (const mi of rc.meshInstances) {
      const mesh = mi.mesh;
      const wt = mi.node.getWorldTransform();
      const positions = [];
      const indices = [];
      mesh.getPositions(positions);
      mesh.getIndices(indices);
      const wp = [];
      for (let i = 0; i < positions.length; i += 3) {
        const v = new Vec3(positions[i], positions[i + 1], positions[i + 2]);
        wt.transformPoint(v, v);
        wp.push(v);
      }
      const addTri = (a, b, c) => {
        const ab = new Vec3().sub2(b, a);
        const ac = new Vec3().sub2(c, a);
        const n = new Vec3().cross(ab, ac);
        const len = n.length();
        if (len < 1e-9) return;
        n.mulScalar(1 / len);
        tris.push({ a, b, c, n });
      };
      if (indices && indices.length) {
        for (let i = 0; i < indices.length; i += 3) addTri(wp[indices[i]], wp[indices[i + 1]], wp[indices[i + 2]]);
      } else {
        for (let i = 0; i < wp.length; i += 3) addTri(wp[i], wp[i + 1], wp[i + 2]);
      }
    }
  }
  return tris;
}

// ---- Find walkable floor samples + a spawn ----
function findFloors(collider) {
  const b = collider.bounds;
  const top = b.maxy + 5;
  const down = new Vec3(0, -1, 0);
  const maxd = (top - b.miny) + 10;
  const samples = [];
  const N = 26;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = b.minx + (b.maxx - b.minx) * ((ix + 0.5) / N);
      const z = b.minz + (b.maxz - b.minz) * ((iz + 0.5) / N);
      const hit = collider.raycast(new Vec3(x, top, z), down, maxd);
      if (hit && hit.normal.y > 0.6) samples.push({ x, y: hit.point.y, z });
    }
  }
  return samples;
}

function pickSpawn(samples, bounds) {
  if (!samples.length) return { x: 0, y: 5, z: 0 };
  const ys = samples.map(s => s.y).sort((a, b) => a - b);
  const ground = ys[Math.floor(ys.length * 0.25)]; // 25th percentile = main floor
  const cx = (bounds.minx + bounds.maxx) / 2, cz = (bounds.minz + bounds.maxz) / 2;
  let best = null, bestD = Infinity;
  for (const s of samples) {
    if (s.y > ground + 1.5) continue;            // skip rooftops/ledges
    const d = (s.x - cx) ** 2 + (s.z - cz) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  best = best || samples[0];
  return { x: best.x, y: best.y + 0.15, z: best.z };
}

// ---- Boot ----
function boot() {
  const asset = new Asset('de_dust2', 'container', { url: './assets/de_dust2.glb' });
  asset.on('error', (err) => { ui.loading.textContent = 'Failed to load map: ' + err; });
  app.assets.add(asset);
  app.assets.load(asset);

  asset.ready(() => {
    ui.loading.textContent = 'Building collision…';

    const renderRoot = asset.resource.instantiateRenderEntity();
    const map = new Entity('map');
    map.addChild(renderRoot);
    map.setLocalScale(MAP_SCALE, MAP_SCALE, MAP_SCALE);
    map.setEulerAngles(MAP_EULER.x, MAP_EULER.y, MAP_EULER.z);
    app.root.addChild(map);
    map.syncHierarchy();

    // Make ripped single-sided walls render from both sides + matte.
    const seen = new Set();
    for (const rc of renderRoot.findComponents('render')) {
      for (const mi of rc.meshInstances) {
        const m = mi.material;
        if (!m || seen.has(m)) continue;
        seen.add(m);
        m.cull = pc.CULLFACE_NONE;
        if ('useMetalness' in m) { m.useMetalness = true; m.metalness = 0; }
        if ('gloss' in m) m.gloss = 0.12;
        m.update();
      }
    }

    const tris = extractTriangles(renderRoot);
    collider = new TriangleCollider(tris, 2.0);

    const floors = findFloors(collider);
    const spawn = pickSpawn(floors, collider.bounds);

    player = new Player(playerRoot, cameraEntity, collider, {});
    player.teleport(spawn.x, spawn.y, spawn.z);
    player.spawn = spawn;
    player.floors = floors;

    targets = new TargetManager(app, collider, floors.length ? floors : [spawn]);

    weapon = new Weapon(app, cameraEntity, player, collider, {
      hud,
      layer: vmLayer.id,
      queryTargets: (o, d, maxDist) => targets.query(o, d, maxDist),
    });

    // Debug tweak panel + fall diagnostics.
    debug = new DebugTools({ app, player, collider, mapRender: renderRoot, spawn });

    // Lightweight debug handle (handy for tweaking / automated checks).
    window.game = { app, player, weapon, targets, collider, debug, camera: cameraEntity, root: playerRoot };

    ui.loading.textContent = `Ready — ${tris.length.toLocaleString()} tris, ${floors.length} floor samples`;
    ui.playBtn.disabled = false;
    ui.playBtn.textContent = 'Click to Play';
  });
}

// ---- Input ----
const input = { forward: 0, strafe: 0, jump: false, sprint: false };
let prevJump = false;

function pollKeyboard() {
  const k = app.keyboard;
  let f = 0, s = 0;
  if (k.isPressed(pc.KEY_W) || k.isPressed(pc.KEY_UP)) f += 1;
  if (k.isPressed(pc.KEY_S) || k.isPressed(pc.KEY_DOWN)) f -= 1;
  if (k.isPressed(pc.KEY_D) || k.isPressed(pc.KEY_RIGHT)) s += 1;
  if (k.isPressed(pc.KEY_A) || k.isPressed(pc.KEY_LEFT)) s -= 1;
  input.forward = f;
  input.strafe = s;
  input.sprint = k.isPressed(pc.KEY_SHIFT);
  const jumpDown = k.isPressed(pc.KEY_SPACE);
  input.jump = jumpDown && !prevJump;
  prevJump = jumpDown;
}

function isLocked() { return pc.Mouse.isPointerLocked(); }

app.mouse.on(pc.EVENT_MOUSEMOVE, (e) => {
  if (!started || !isLocked() || !player) return;
  player.addLook(e.dx, e.dy, 0.12);
});
app.mouse.on(pc.EVENT_MOUSEDOWN, (e) => {
  if (!started || !isLocked()) return;
  if (e.button === pc.MOUSEBUTTON_LEFT && weapon) weapon.startFire();
});
app.mouse.on(pc.EVENT_MOUSEUP, (e) => {
  if (e.button === pc.MOUSEBUTTON_LEFT && weapon) weapon.stopFire();
});

app.keyboard.on(pc.EVENT_KEYDOWN, (e) => {
  if (e.key === pc.KEY_V && debug) { debug.cycleMode(); return; } // works while paused too
  if (!started) return;
  if (e.key === pc.KEY_R && weapon) weapon.reload();
  if (e.key === pc.KEY_T && player && player.floors && player.floors.length) {
    const s = player.floors[Math.floor(Math.random() * player.floors.length)];
    player.teleport(s.x, s.y + 0.15, s.z);
  }
});

ui.playBtn.addEventListener('click', () => {
  if (ui.playBtn.disabled) return;
  app.mouse.enablePointerLock();
});

// Backtick toggles the debug panel; V cycles view mode (handled in PlayCanvas keydown).
window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    const panel = document.getElementById('debugPanel');
    if (panel) panel.classList.toggle('dbg-hidden');
  }
});

document.addEventListener('pointerlockchange', () => {
  const locked = isLocked();
  if (locked) {
    started = true;
    ui.overlay.classList.add('hidden');
    ui.crosshair.style.display = 'block';
    ui.dot.style.display = 'block';
    ui.hud.style.display = 'block';
  } else {
    // Paused — show overlay again.
    if (weapon) weapon.stopFire();
    ui.overlay.classList.remove('hidden');
    ui.playBtn.textContent = 'Click to Resume';
    ui.crosshair.style.display = 'none';
    ui.dot.style.display = 'none';
  }
});

// ---- Loop ----
app.on('update', (dt) => {
  if (!player) return;
  const d = Math.min(dt, 0.05); // clamp big frames (tab switches)

  if (started && isLocked()) {
    pollKeyboard();
  } else {
    input.forward = 0; input.strafe = 0; input.jump = false; input.sprint = false;
  }

  player.update(d, input);

  if (debug) { debug.track(); debug.updateReadout(); }

  // Respawn if the player falls out of the world.
  if (player.pos.y < collider.bounds.miny - 20 && player.spawn) {
    player.teleport(player.spawn.x, player.spawn.y, player.spawn.z);
  }

  if (weapon) weapon.update(d);
  if (targets) targets.update(d);

  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= d;
    if (hitmarkerTimer <= 0) ui.hitmarker.style.opacity = 0;
  }
});

app.start();
boot();
