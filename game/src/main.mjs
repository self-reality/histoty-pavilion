// Entry point: index.html loads this module and nothing else.
//
// It creates the pc.Application and drives everything by hand — map, layout,
// lights, input, the game loop — out of the modules beside it. A second entry
// point for the PlayCanvas Editor shared those modules until September 2026;
// see BLENDER_MIGRATION.md for why it went.
import * as pc from 'playcanvas';
import { manifest } from '../scene.manifest.mjs';
import { TriangleCollider } from './collision.mjs';
import { Player } from './player.mjs';
import { Weapon } from './weapon.mjs';
import { isDebugMode } from './debugmode.mjs';
import { TargetManager, extractTriangles, findFloors, isNonColliding,
         propCollisionTriangles, hideCollisionProxies, hideVolumes, unlitIgnoreAmbient } from './world.mjs';
import { resolveSpawn, placeAtSpawn, FallRescue } from './spawn.mjs';
import { applyFog, disableFogOn, SurfaceLook } from './atmosphere.mjs';
import { rigForProp } from './rig.mjs';
import { loadScript, loadScriptJson, PropScript } from './script.mjs';
import { collectVolumes, volumeFromMesh, matrixOf, carve, carveRender } from './negatives.mjs';
import { Actions } from './actions.mjs';
import { SoundBank } from './audio.mjs';

const { Color, Entity, Asset, Quat } = pc;

// ---- Debug mode (see ./debugmode.mjs) ----
// Dynamic, not a static import: on the production URL the tweak panel is not
// merely hidden, its module is never requested. `debug` stays null everywhere
// below, which every call site already tolerates.
const { DebugTools, togglePanel } = isDebugMode() ? await import('./debug.mjs') : {};

// Marks the page for the stripped-down pause overlay (see the body.debug rules
// in index.html): no dimming over the scene you are tweaking, a small corner
// resume button, and the ready line alone at the foot.
if (isDebugMode()) document.body.classList.add('debug');

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
  actions: document.getElementById('actions'),
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
let audio = null;
let rescue = null;
let actions = null;
let started = false;
// Props whose script ticks — a clip playing, or an action that may be set off —
// in placement order. See ./script.mjs.
const scripted = [];

// ---- Boot ----
function boot() {
  // The layout fetch is started here rather than after the map lands, because
  // the negatives in it have to be applied before the collider is built. Kicked
  // off alongside the GLB download it costs nothing; awaited afterwards it
  // would put a round trip on the critical path.
  const layout = loadLayout();

  const asset = new Asset('de_dust2', 'container', { url: MAP.glb });
  asset.on('error', (err) => { ui.loading.textContent = 'Failed to load map: ' + err; });
  app.assets.add(asset);
  app.assets.load(asset);

  asset.ready(() => layout.then((scene) => {
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

    // Negative spaces, subtracted before anything can hold a reference to the
    // soup — a carved doorway has to be a doorway to the spawn finder and the
    // target scatter too, not only to the player (see ./negatives.mjs).
    // The level's own, and the ones the placed assets brought with them: every
    // hole there will ever be is known by now, so the map is cut exactly once.
    // The assets' first: when a prop starts carrying the hole the level used to
    // draw for it, it is the level's cutter that finds nothing left and is named
    // as the redundant one — see reportNegatives.
    const negatives = [...packagedNegatives(scene), ...collectVolumes(scene.negatives)];
    const raw = extractTriangles(renderRoot);
    const tris = carve(raw, negatives);
    // The same volumes out of the render mesh, so it is a hole you can see
    // through as well as walk through. After the soup is taken, not before, so
    // that both carves read the geometry the GLB shipped and each can report
    // what it removed rather than the second one finding the work already done.
    const shown = carveRender(renderRoot, negatives, app.graphicsDevice);
    reportNegatives(negatives, raw.length, tris.length, shown);

    collider = new TriangleCollider(tris, 2.0);

    const floors = findFloors(collider);
    // Where you start is authored in the .blend like everything else, falls
    // back to the map's own middle when nothing says otherwise, and yields to
    // the address bar over both (see ./spawn.mjs). The marker is read
    // against the bare map — props land after this — so a spawn stood in
    // front of one still finds the floor rather than the prop's roof.
    const spawn = resolveSpawn({ markers: scene.markers, floors, collider });
    console.log(`[spawn] ${spawn.name ?? 'nearest floor to the map centre'}`
      + ` @ ${spawn.x.toFixed(2)}, ${spawn.y.toFixed(2)}, ${spawn.z.toFixed(2)}`
      + ` facing ${spawn.yaw.toFixed(0)}\u00b0` + (spawn.pitch ? `, pitched ${spawn.pitch.toFixed(0)}\u00b0` : ''));

    player = new Player(playerRoot, cameraEntity, collider, {});
    placeAtSpawn(player, spawn);
    player.spawn = spawn;
    player.floors = floors;
    rescue = new FallRescue(player, collider);

    // Who is in reach of what, and which of them E would act on (see
    // ./actions.mjs). Built before any prop lands, because the props
    // register with it as they do; the areas ride in on the same layout.
    actions = new Actions({ app, camera: cameraEntity, player, layer: ui.actions });
    actions.setAreas(scene.areas);

    targets = new TargetManager(app, collider, floors.length ? floors : [spawn], addScore, { max: manifest.targets.max });

    // The whole bank is ~170 KB, so it loads up front rather than streaming —
    // the first footstep must not be the one that stalls. It is not gated on
    // below: "Ready" means the map is walkable, and the audio lands long
    // before anyone finishes reading the controls and clicks Play (which is
    // also the gesture that unlocks the AudioContext).
    audio = new SoundBank(app, cameraEntity, manifest.sounds);

    weapon = new Weapon(app, cameraEntity, player, collider, {
      hud,
      layer: vmLayer.id,
      queryTargets: (o, d, maxDist) => targets.query(o, d, maxDist),
      onEvent: (event) => audio.onWeaponEvent(event),
    });

    // Debug tweak panel — debug URLs only; null on the production one.
    if (DebugTools) {
      debug = new DebugTools({
        app, player, collider, mapRender: renderRoot, spawn,
        surface, sun, fill, camera: cameraEntity,
      });
    }

    // Lightweight debug handle (handy for tweaking / automated checks).
    window.game = { app, player, rescue, weapon, targets, collider, debug, audio, negatives, actions, surface, camera: cameraEntity, root: playerRoot,
                    // Place a prop by hand from the console or a test — the same
                    // entry the layout goes through — and see what is animating.
                    loadProp, scripted };

    ui.loading.textContent = `Ready — ${tris.length.toLocaleString()} tris, ${floors.length} floor samples`;
    ui.playBtn.disabled = false;
    ui.playBtn.textContent = 'Click to Play';

    // Authored props (tent, etc.) are cosmetic, so load them after the map is
    // playable rather than gating "Ready" on a 10 MB GLB.
    scene.props.forEach(loadProp);
  }).catch((err) => {
    // Boot used to run straight inside asset.ready(), where a throw was an
    // uncaught error the console and tests/smoke.mjs both see. Inside a promise
    // chain the same throw is a silent rejection, so put it back on the stack.
    ui.loading.textContent = 'Failed to build the scene: ' + err.message;
    setTimeout(() => { throw err; });
  }));
}

// The negative spaces placed assets carry, put where the assets stand.
//
// An asset's `_neg` meshes are copied into its script by the kit's pack step,
// in the asset's own space, which is what lets them be known HERE — with the
// layout, before the map's collision exists — rather than whenever a megabyte
// of GLB finishes arriving. The prop itself is not on stage yet, so where it
// will stand is worked out from the same numbers placeProp() will use: its
// placement, plus the seat offset of its script's pose and of any `rigs` entry,
// which both move the prop root.
function packagedNegatives(scene) {
  const volumes = [];
  for (const prop of scene.props) {
    const script = scene.scripts.get(prop.name);
    if (!script?.negatives?.length) continue;
    const [px, py, pz] = prop.pos ?? [0, 0, 0];
    const lift = [script.offset, manifest.rigs?.[prop.name]?.offset].filter(Array.isArray);
    const at = matrixOf({ ...prop, pos: lift.reduce((p, o) => [p[0] + o[0], p[1] + o[1], p[2] + o[2]], [px, py, pz]) });
    for (const entry of script.negatives) {
      const volume = volumeFromMesh({ ...entry, name: `${prop.name}/${entry.name}` }, at);
      if (volume) volumes.push(volume);
    }
  }
  return volumes;
}

// A cutter that removed nothing is the failure mode worth printing: the entry
// is in the layout, the export said nothing, and the doorway simply is not
// there. Usually it has been left somewhere the map has no geometry.
function reportNegatives(volumes, before, after, shown) {
  if (!volumes.length) return;
  const cut = volumes.filter((v) => v.hits);
  console.log(`[negatives] ${cut.length}/${volumes.length} carved the map: `
    + `collision ${before.toLocaleString()} -> ${after.toLocaleString()} tris, `
    + `render ${shown.meshes} mesh${shown.meshes === 1 ? '' : 'es'} rebuilt `
    + `(${shown.before.toLocaleString()} -> ${shown.after.toLocaleString()} tris)`);
  for (const v of volumes) {
    if (v.hits) { console.log(`[negatives] ${v.name} cut ${v.hits} triangle${v.hits > 1 ? 's' : ''}`); continue; }
    // Nothing left to cut is a different story from nothing there: a cutter
    // wholly inside the reach of one that did its work is the second of two
    // doing the same job — typically a level cutter left behind after the prop
    // it was drawn for began bringing its own.
    const inside = (a, b) => [0, 1, 2].every((i) => a.box[i] >= b.box[i] - 1e-3 && a.box[i + 3] <= b.box[i + 3] + 1e-3);
    const earlier = volumes.find((o) => o !== v && o.hits && inside(v, o));
    if (earlier) console.warn(`[negatives] ${v.name} cut NOTHING — ${earlier.name} had already taken it. One of the two is redundant`);
    else console.warn(`[negatives] ${v.name} cut NOTHING — is it inside the map?`);
  }
}

// Where the authored scene comes from, in increasing priority:
//   1. scene.manifest.mjs    — hand-written `props` / `negatives`
//   2. scene.placements.json — generated from scene/pavilion.blend by
//                              tools/export_scene.py (see BLENDER_SCENE.md)
// Same-named entries from Blender win, so migrating a prop into the .blend
// needs no manifest edit. A missing/invalid placements file is not fatal: the
// build still runs on the hand-written entries alone.
//
// Props and negatives ride the same file and the same precedence — one is
// geometry added, the other geometry taken away — so they are fetched together
// rather than each reaching for the layout on its own. Markers ride along on
// the same terms: a transform with no geometry at either end of it — where the
// player starts is one. So do action areas: a negative's sibling, a volume
// that is asked whether the player is in it instead of being cut out of the map.
//
// The scripts of the placed assets are fetched here too, JSON only. They are a
// few KB each and the map is megabytes, so they are always in long before it
// is — and they have to be, because an asset may carry a hole for the map.
async function loadLayout() {
  const props = new Map(manifest.props.map((p) => [p.name, p]));
  const negatives = new Map((manifest.negatives ?? []).map((n) => [n.name, n]));
  const markers = new Map((manifest.markers ?? []).map((m) => [m.name, m]));
  const areas = new Map((manifest.areas ?? []).map((a) => [a.name, a]));
  const placements = placementsUrl();
  if (placements) {
    try {
      // `no-store`, because this file is rewritten by every `npm run
      // scene:export` and a stale copy silently shows the wrong layout. The dev
      // server (python http.server) sends Last-Modified but no Cache-Control or
      // ETag, so the browser is free to invent a freshness lifetime and serve
      // its cached copy without asking. Cmd-Shift-R does not save you: a hard
      // reload only forces revalidation for the navigation and the subresources
      // it pulls in, and this fetch is issued from script afterwards.
      const res = await fetch(placements, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const prop of data.props ?? []) props.set(prop.name, prop);
      for (const neg of data.negatives ?? []) negatives.set(neg.name, neg);
      for (const marker of data.markers ?? []) markers.set(marker.name, marker);
      for (const area of data.areas ?? []) areas.set(area.name, area);
    } catch (err) {
      console.warn(`[scene] no Blender placements (${placements}):`, err.message);
    }
  }
  // A script that fails here fails again, loudly, when its prop is placed.
  const scripts = new Map();
  await Promise.all([...props.values()].filter((p) => p.script).map(async (p) => {
    try { scripts.set(p.name, await loadScriptJson(p.script)); } catch { /* reported by loadProp */ }
  }));
  return { props: [...props.values()], negatives: [...negatives.values()], markers: [...markers.values()],
           areas: [...areas.values()], scripts };
}

// Which layout: the manifest's, unless the address bar names another —
// `?placements=./tests/fixtures/package.placements.json`. Same idea as `?at=`:
// the authored answer stands until the URL says otherwise. It is how a test
// stands a fixture in the level at BOOT, which is the only time a packaged
// asset's hole can be cut. Same-origin only; anything else is ignored.
function placementsUrl() {
  const asked = new URLSearchParams(location.search).get('placements');
  if (!asked) return manifest.placements;
  try {
    const url = new URL(asked, location.href);
    if (url.origin === location.origin) return url.href;
  } catch { /* not a URL */ }
  console.warn(`[scene] ?placements=${asked} is not a layout on this site — using ${manifest.placements}`);
  return manifest.placements;
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
// match what the exporter wrote.
//
// A prop is an object and, optionally, its script: `glb` names the one, `script`
// the other, and the scene exporter writes both paths when the asset ships a
// script beside its GLB (an animated character does — see ANIMATED_PROPS.md).
// The script is fetched alongside the GLB rather than after it, so the two
// downloads overlap instead of queueing; a script that fails is reported and
// the object still lands, as a statue.
function loadProp(prop) {
  const asset = loadContainer(prop.glb);
  const script = prop.script
    ? loadScript(prop.script).catch((err) => {
      console.error(`[prop ${prop.name}] script ${prop.script} failed to load: ${err.message}`);
      return null;
    })
    : Promise.resolve(null);
  asset.ready(() => script.then((loaded) => placeProp(prop, asset, loaded)).catch((err) => {
    // Same reason boot() does this: inside a promise chain a throw is a silent
    // rejection, and a prop that failed to place should fail the smoke test.
    console.error(`[prop ${prop.name}] failed to place:`, err);
    setTimeout(() => { throw err; });
  }));
  return asset;
}

function placeProp(prop, asset, loaded) {
  {
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
    // The asset's own script first — what the object does wherever it stands:
    // its bind pose captured, anything it says to hang hung, its own pose, and
    // its clip bound. Then the manifest's per-placement pose on top, the way
    // placements shadow hand-written props.
    const script = loaded ? new PropScript(root, loaded, prop.name) : null;
    if (script) {
      for (const w of script.warnings) console.warn(`[script ${prop.name}] ${w}`);
      if (script.ticks) scripted.push(script);
      if (script.rig) debug?.addRig(script.rig);
    }
    // Fold the rig before the hierarchy syncs: the pose moves the prop root
    // (its seat offset), and that has to be settled before collision bakes
    // world-space triangles out of it.
    const rig = rigForProp(root, prop, manifest.rigs);
    if (rig && script?.player) {
      console.warn(`[rig ${prop.name}] a pose in scene.manifest.mjs and a clip from ${prop.script} `
        + 'both drive this prop — the clip rewrites its bones every frame, so the pose only '
        + 'holds on bones the clip leaves alone');
    }
    if (rig) debug?.addRig(rig);
    root.syncHierarchy();          // world transforms must be final before we
                                   // bake collision triangles out of them
    const solid = addPropCollision(prop, root, rig, script);
    const proxies = hideCollisionProxies(root);   // after collision, before the first frame
    const volumes = hideVolumes(root);            // `_neg` / `_act`: read from the script long ago
    const unlit = unlitIgnoreAmbient(root);       // an unlit surface takes no ambient
    // Anything its script lets a player set off is now in reach of the E key.
    if (script) actions?.add(prop.name, root, script);
    // Scale is in the line because "is my Blender edit actually in this tab?" is
    // the question you ask most while placing, and a stale placements file
    // answers it silently and wrongly. Read it, compare with the .blend.
    console.log(`[prop ${prop.name}] placed @ ${root.getLocalPosition().toString()}`
      + ` scale ${sx === sy && sy === sz ? sx : `${sx},${sy},${sz}`}${solid}`
      + (proxies ? ` (${proxies} collision proxy mesh hidden)` : '')
      + (volumes ? ` (${volumes} volume mesh hidden)` : '')
      + (unlit ? ` (${unlit} unlit material sealed from ambient)` : '')
      + (rig ? ` (rig: ${rig.count} bones posed${rig.moveCount ? `, ${rig.moveCount} nodes moved` : ''})` : '')
      + (script ? ` (script: ${script.describe()})` : ''));
    return script;
  }
}

/**
 * Is this prop something you can walk into?
 *
 * Solid by default — that is what a placed object usually means. Opt a whole
 * prop out with `solid: false` on its placement entry, or with a `solid`
 * custom property in Blender (the exporter forwards unknown custom properties
 * into `extras`). Opt out one mesh inside an otherwise-solid prop with a
 * `_nocol` name suffix; see isNonColliding in ./world.mjs. A prop shipping
 * a `_col` proxy collides with that instead of its visual mesh entirely.
 *
 * An asset's script may answer too — an animated one says `solid: false`,
 * because collision is baked once at load and a dancer would leave a statue
 * of his first frame standing in the room. The placement's own word wins
 * over the script's: the asset says what it is, the pavilion says what this
 * copy is here.
 */
function propIsSolid(prop, script) {
  const flag = prop.solid ?? prop.extras?.solid ?? script?.solid;
  if (flag === undefined || flag === null) return true;
  return !(flag === false || flag === 0 || flag === 'false');
}

// Fold a placed prop's geometry into the collider. Props land after the map, so
// this joins a collider that is already live and already being queried.
function addPropCollision(prop, root, rig, script) {
  if (!collider) return ' (no collider yet)';
  if (!propIsSolid(prop, script)) {
    const own = prop.solid ?? prop.extras?.solid;
    return ` — walk-through (solid: false${own === undefined || own === null ? ', from its script' : ''})`;
  }
  // A rig that hid geometry vetoes it here too, so nothing the pose removed is
  // left standing as an invisible obstacle.
  const tris = propCollisionTriangles(root, {
    collides: (n) => (!rig || rig.collides(n)) && (!script || script.collides(n)),
  });
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
  // Once per press: a held key repeats, and a dance set off and stopped thirty
  // times a second is a man twitching.
  if (e.key === pc.KEY_E && actions && isLocked() && !e.event?.repeat) actions.trigger();
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

  // Immediately after the controller, and never before it: the jump and the
  // landing are edges player.update() consumes as it goes past. See audio.mjs.
  if (audio) audio.update(d, player, input);

  if (debug) debug.updateReadout();

  // Fell out of the world: back onto the last floor stood on (see ./spawn.mjs).
  rescue.update();

  if (weapon) weapon.update(d);
  if (targets) targets.update(d);

  // Clips tick on the same clamped step as the controller, so a tab switch
  // does not fast-forward a dance any more than it fast-forwards a fall.
  for (const s of scripted) s.update(d);

  // After the clips, so a dancer is reached where this frame's pose put him;
  // the hints come down with the pause overlay and the crosshair.
  actions.update(started && isLocked());

  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= d;
    if (hitmarkerTimer <= 0) ui.hitmarker.style.opacity = 0;
  }
});

app.start();
boot();
