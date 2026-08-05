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
import { isDebugMode } from '../src/debugmode.mjs';
import { TargetManager, extractTriangles, findFloors, pickSpawn, isNonColliding,
         propCollisionTriangles, hideCollisionProxies, unlitIgnoreAmbient } from '../src/world.mjs';
import { applyFog, disableFogOn, SurfaceLook } from '../src/atmosphere.mjs';
import { rigForProp } from '../src/rig.mjs';

const { Color, Entity, Asset, Quat } = pc;

// ---- Debug mode (see ../src/debugmode.mjs) ----
// Dynamic, not a static import: on the production URL the tweak panel is not
// merely hidden, its module is never requested. `debug` stays null everywhere
// below, which every call site already tolerates.
const { DebugTools, togglePanel } = isDebugMode() ? await import('../src/debug.mjs') : {};

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

// Distance haze, straight from the manifest. Live sliders on the debug URL (?debug).
applyFog(app.scene, manifest.fog);

// The map's PBR response. Materials are adopted once the GLB lands (see boot()).
const surface = new SurfaceLook(manifest.surface);

// ---- Lights ----
const sun = new Entity('sun');
sun.addComponent('light', {
  type: 'directional',
  color: new Color(1.0, 0.96, 0.86),
  intensity: 2.15,
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
fill.addComponent('light', { type: 'directional', color: new Color(0.6, 0.7, 0.85), intensity: 0.6, castShadows: false });
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
// The gun sits ~0.5 m from the lens; keep it out of the fog at any density.
disableFogOn(vmCamera.camera);
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

    // Both-sided ripped walls + dry-stone PBR response (see atmosphere.mjs).
    surface.adopt(renderRoot);

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

    // Debug tweak panel — debug URLs only; null on the production one.
    if (DebugTools) {
      debug = new DebugTools({
        app, player, collider, mapRender: renderRoot, spawn,
        surface, sun, fill, camera: cameraEntity,
      });
    }

    // Lightweight debug handle (handy for tweaking / automated checks).
    window.game = { app, player, weapon, targets, collider, debug, surface, camera: cameraEntity, root: playerRoot };

    ui.loading.textContent = `Ready — ${tris.length.toLocaleString()} tris, ${floors.length} floor samples`;
    ui.playBtn.disabled = false;
    ui.playBtn.textContent = 'Click to Play';

    // Authored props (tent, etc.) are cosmetic, so load them after the map is
    // playable rather than gating "Ready" on a 10 MB GLB.
    collectProps().then((props) => props.forEach(loadProp));
  });
}

// Where props come from, in increasing priority:
//   1. manifest.props        — hand-written entries
//   2. scene.placements.json — generated from scene/pavilion.blend by
//                              tools/export_scene.py (see BLENDER_SCENE.md)
// Same-named entries from Blender win, so migrating a prop into the .blend
// needs no manifest edit. A missing/invalid placements file is not fatal: the
// build still runs on the hand-written props alone.
async function collectProps() {
  const byName = new Map(manifest.props.map((p) => [p.name, p]));
  if (manifest.placements) {
    try {
      // `no-store`, because this file is rewritten by every `npm run
      // scene:export` and a stale copy silently shows the wrong layout. The dev
      // server (python http.server) sends Last-Modified but no Cache-Control or
      // ETag, so the browser is free to invent a freshness lifetime and serve
      // its cached copy without asking. Cmd-Shift-R does not save you: a hard
      // reload only forces revalidation for the navigation and the subresources
      // it pulls in, and this fetch is issued from script afterwards.
      const res = await fetch(manifest.placements, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const prop of data.props ?? []) byName.set(prop.name, prop);
    } catch (err) {
      console.warn(`[scene] no Blender placements (${manifest.placements}):`, err.message);
    }
  }
  return [...byName.values()];
}

// One container asset per URL — a scattered prop placed 50 times downloads and
// parses its GLB once, then instantiates 50 render entities off it.
const containers = new Map();
function loadContainer(url) {
  let asset = containers.get(url);
  if (!asset) {
    asset = new Asset(url, 'container', { url });
    asset.on('error', (err) => console.error(`[prop] ${url} failed to load:`, err));
    app.assets.add(asset);
    app.assets.load(asset);
    containers.set(url, asset);
  }
  return asset;
}

// Place one authored prop. Kept in world space (child of root) so its numbers
// match what the exporter wrote / what was grabbed from the Editor scene.
function loadProp(prop) {
  const asset = loadContainer(prop.glb);
  asset.ready(() => {
    const root = new Entity(prop.name);
    root.addChild(asset.resource.instantiateRenderEntity());
    const [px, py, pz] = prop.pos ?? [0, 0, 0];
    root.setLocalPosition(px, py, pz);
    // Blender-authored props carry an exact quaternion; hand-written ones use
    // euler degrees. Quaternion wins — it has no axis-order ambiguity.
    if (prop.rot) {
      root.setLocalRotation(new Quat(prop.rot[0], prop.rot[1], prop.rot[2], prop.rot[3]));
    } else if (prop.euler) {
      root.setLocalEulerAngles(prop.euler[0], prop.euler[1], prop.euler[2]);
    }
    const [sx, sy, sz] = prop.scale ?? [1, 1, 1];
    root.setLocalScale(sx, sy, sz);
    app.root.addChild(root);
    // Fold the rig before the hierarchy syncs: the pose moves the prop root
    // (its seat offset), and that has to be settled before collision bakes
    // world-space triangles out of it.
    const rig = rigForProp(root, prop, manifest.rigs);
    if (rig) debug?.addRig(rig);
    root.syncHierarchy();          // world transforms must be final before we
                                   // bake collision triangles out of them
    const solid = addPropCollision(prop, root, rig);
    const proxies = hideCollisionProxies(root);   // after collision, before the first frame
    const unlit = unlitIgnoreAmbient(root);       // an unlit surface takes no ambient
    // Scale is in the line because "is my Blender edit actually in this tab?" is
    // the question you ask most while placing, and a stale placements file
    // answers it silently and wrongly. Read it, compare with the .blend.
    console.log(`[prop ${prop.name}] placed @ ${root.getLocalPosition().toString()}`
      + ` scale ${sx === sy && sy === sz ? sx : `${sx},${sy},${sz}`}${solid}`
      + (proxies ? ` (${proxies} collision proxy mesh hidden)` : '')
      + (unlit ? ` (${unlit} unlit material sealed from ambient)` : '')
      + (rig ? ` (rig: ${rig.count} bones posed${rig.moveCount ? `, ${rig.moveCount} nodes moved` : ''})` : ''));
  });
  return asset;
}

/**
 * Is this prop something you can walk into?
 *
 * Solid by default — that is what a placed object usually means. Opt a whole
 * prop out with `solid: false` on its placement entry, or with a `solid`
 * custom property in Blender (the exporter forwards unknown custom properties
 * into `extras`). Opt out one mesh inside an otherwise-solid prop with a
 * `_nocol` name suffix; see isNonColliding in ../src/world.mjs. A prop shipping
 * a `_col` proxy collides with that instead of its visual mesh entirely.
 */
function propIsSolid(prop) {
  const flag = prop.solid ?? prop.extras?.solid;
  if (flag === undefined || flag === null) return true;
  return !(flag === false || flag === 0 || flag === 'false');
}

// Fold a placed prop's geometry into the collider. Props land after the map, so
// this joins a collider that is already live and already being queried.
function addPropCollision(prop, root, rig) {
  if (!collider) return ' (no collider yet)';
  if (!propIsSolid(prop)) return ' — walk-through (solid: false)';
  // A rig that hid geometry vetoes it here too, so nothing the pose removed is
  // left standing as an invisible obstacle.
  const tris = propCollisionTriangles(root, rig ? { collides: (n) => rig.collides(n) } : {});
  if (!tris.length) return ' — no collidable meshes';
  // Provenance: raycast() hands back the triangle it hit, so tagging makes
  // "what did I just shoot / bump into?" answerable in the console and lets
  // tests assert they were stopped by the prop rather than by the map.
  for (const t of tris) t.prop = prop.name;
  collider.add(tris);
  // The debug view's normals overlay is built from the collider's triangles, so
  // it has to be rebuilt or pressing V would show the map without the prop.
  if (debug) debug.rebuildOverlay();
  return ` — solid, +${tris.length.toLocaleString()} collision tris`;
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
if (togglePanel) {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') togglePanel();
  });
}

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

  if (debug) debug.updateReadout();

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
