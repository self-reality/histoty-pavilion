// Standalone / engine-only entry point.
//
// This is the original code-first build: it creates its own pc.Application and
// drives everything by hand, served straight from index.html (no Editor). It is
// deliberately kept OUT of ../src (the Editor-synced folder) so the PlayCanvas
// Editor never tries to parse a file that news up a second Application.
//
// Shared world logic (targets, triangle extraction, floor/spawn finding) lives
// in ../src/world.mjs and is reused by the Editor build (../src/game.mjs).
import * as pc from 'playcanvas';
import { manifest } from '../scene.manifest.mjs';
import { TriangleCollider } from '../src/collision.mjs';
import { Player } from '../src/player.mjs';
import { Weapon } from '../src/weapon.mjs';
import { DebugTools } from '../src/debug.mjs';
import { TargetManager, extractTriangles, findFloors, pickSpawn } from '../src/world.mjs';

const { Color, Entity, Asset } = pc;

// ---- Scene constants come from the git-tracked manifest (see ../scene.manifest.mjs) ----
const MAP = manifest.map;                 // { glb, scale, euler } — Source Z-up -> metres, Y-up
const SKY = new Color(...manifest.sky);   // camera clear / sky colour

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
// Refractive props (e.g. the tent's glass) sample a scene-colour grab-pass via
// uSceneColorMap; enable it on the main camera so those shaders have a source.
if (manifest.glass.length && cameraEntity.camera?.requestSceneColorMap) {
  cameraEntity.camera.requestSceneColorMap(true);
}
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

// ---- Boot ----
function boot() {
  const asset = new Asset('de_dust2', 'container', { url: MAP.glb });
  asset.on('error', (err) => { ui.loading.textContent = 'Failed to load map: ' + err; });
  app.assets.add(asset);
  app.assets.load(asset);

  asset.ready(() => {
    ui.loading.textContent = 'Building collision…';

    const renderRoot = asset.resource.instantiateRenderEntity();
    const map = new Entity('map');
    map.addChild(renderRoot);
    map.setLocalScale(MAP.scale, MAP.scale, MAP.scale);
    map.setEulerAngles(MAP.euler[0], MAP.euler[1], MAP.euler[2]);
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

    targets = new TargetManager(app, collider, floors.length ? floors : [spawn], addScore, { max: manifest.targets.max });

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

    // Authored props (tent, etc.) are cosmetic, so load them after the map is
    // playable rather than gating "Ready" on a 10 MB GLB.
    for (const prop of manifest.props) loadProp(prop);
  });
}

// Load one authored prop GLB and place it per its manifest transform. Kept in
// world space (child of root) so its coordinates match what was grabbed from the
// Editor scene (see EXPORT_TENT.md).
function loadProp(prop) {
  const asset = new Asset(prop.name, 'container', { url: prop.glb });
  asset.on('error', (err) => console.error(`[prop ${prop.name}] load failed:`, err));
  app.assets.add(asset);
  app.assets.load(asset);
  asset.ready(() => {
    const root = new Entity(prop.name);
    root.addChild(asset.resource.instantiateRenderEntity());
    root.setLocalPosition(prop.pos[0], prop.pos[1], prop.pos[2]);
    root.setEulerAngles(prop.euler[0], prop.euler[1], prop.euler[2]);
    root.setLocalScale(prop.scale[0], prop.scale[1], prop.scale[2]);
    app.root.addChild(root);
    root.syncHierarchy();
    console.log(`[prop ${prop.name}] placed @ ${prop.pos.join(',')}`);
  });
  return asset;
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
