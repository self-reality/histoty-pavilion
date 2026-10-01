// Entry point: index.html loads this module and nothing else.
//
// It builds the world — the pc.Application, map, layout, lights, collision,
// props and their scripts, sound, the E key — and then lets a game be played
// in it. The games are modes (./modes/<id>/), loaded with import() when one is
// entered and never imported from here or anywhere else in the world: the
// world does not know what is played in it (see ./modes/README.md). A second
// entry point for the PlayCanvas Editor shared these modules until September
// 2026; see BLENDER_MIGRATION.md for why it went.
import * as pc from 'playcanvas';
import { manifest } from '../scene.manifest.mjs';
import { TriangleCollider } from './collision.mjs';
import { Player } from './player.mjs';
import { isDebugMode } from './debugmode.mjs';
import { extractTriangles, findFloors,
         propCollisionTriangles, hideCollisionProxies, hideVolumes, unlitIgnoreAmbient } from './world.mjs';
import { resolveSpawn, placeAtSpawn, FallRescue } from './spawn.mjs';
import { applyFog, SurfaceLook } from './atmosphere.mjs';
import { rigForProp } from './rig.mjs';
import { loadManifest, loadPackage, PropScript } from './script.mjs';
import { collectVolumes, volumeFromMesh, matrixOf, carve, carveRender } from './negatives.mjs';
import { Actions } from './actions.mjs';
import { SoundBank } from './audio.mjs';
import { Presence } from './presence.mjs';
import { Net, roomsUrl } from './net.mjs';

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

// ---- The games that can be played here ----
// Names only — id and the word on its button. Each is ./modes/<id>/index.mjs,
// fetched the first time someone picks it; the first is the one a bare URL
// opens, `?mode=<id>` opens another. None of them is the game and the rest
// extras: the first is only the one a link without `?mode=` lands in.
const MODE_NAMES = { shooter: 'Shooter', flyover: 'Fly-over' };
const MODES = Object.keys(MODE_NAMES);

// ---- UI handles ----
const ui = {
  overlay: document.getElementById('overlay'),
  playBtn: document.getElementById('playBtn'),
  loading: document.getElementById('loading'),
  actions: document.getElementById('actions'),
  title: document.getElementById('title'),
  sub: document.getElementById('sub'),
  controls: document.getElementById('controls'),
  modes: document.getElementById('modes'),
  people: document.getElementById('people'),
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

// ---- Camera rig ----
// The world's one view. Whichever game is being played drives it: the walker
// through the root's yaw and position and the camera's pitch and eye height,
// the fly-over through the same two entities.
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

let player = null;
let collider = null;
let debug = null;
let audio = null;
let rescue = null;
let actions = null;
let started = false;
// Everyone else in the world, whatever they play — seen as ghosts (./presence.mjs).
const presence = new Presence(app);
// Their browsers, linked to this one; null when there is no rooms server to
// find them through (./net.mjs), and the list above then stays empty.
let net = null;
// What the games are handed (see ./modes/README.md), filled in by boot().
let world = null;
// The game being played: its module, and what its enter() returned.
let mode = null;
let session = null;
// Placed objects whose package has a manifest — and so, perhaps, a script that
// ticks, plays or may be set off — in placement order. See ./script.mjs.
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

  asset.ready(() => layout.then(async (scene) => {
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
    // register with it as they do.
    actions = new Actions({ app, camera: cameraEntity, player, layer: ui.actions });

    // The whole bank is ~170 KB, so it loads up front rather than streaming —
    // the first footstep must not be the one that stalls. It is not gated on
    // below: "Ready" means the map is walkable, and the audio lands long
    // before anyone finishes reading the controls and clicks Play (which is
    // also the gesture that unlocks the AudioContext).
    audio = new SoundBank(app, cameraEntity, manifest.sounds);

    // Debug tweak panel — debug URLs only; null on the production one.
    if (DebugTools) {
      debug = new DebugTools({
        app, player, collider, mapRender: renderRoot, spawn,
        surface, sun, fill, camera: cameraEntity,
      });
    }

    world = {
      app, manifest, collider, floors, spawn, audio, actions, presence,
      camera: cameraEntity, rig: playerRoot,
      // The walking body — standing, stepping, falling, put back when it falls
      // out. Any game on foot drives this one; the others leave it parked.
      walker: player, rescue,
    };

    // Lightweight debug handle (handy for tweaking / automated checks). What
    // belongs to a game is read through `session`, so it is always the game
    // being played now: `game.weapon` is null in the fly-over.
    window.game = { app, player, rescue, collider, debug, audio, negatives, actions, surface, presence, camera: cameraEntity, root: playerRoot,
                    // Place a prop by hand from the console or a test — the same
                    // entry the layout goes through — and see what is animating.
                    loadProp, scripted, switchMode, clock,
                    get mode() { return mode?.id ?? null; },
                    get net() { return net; },
                    get session() { return session; },
                    get weapon() { return session?.weapon ?? null; },
                    get targets() { return session?.targets ?? null; } };

    await switchMode(initialMode());

    // Other people, now that there is a game on stage to tell them about.
    const rooms = roomsUrl(manifest.rooms);
    if (rooms) {
      net = new Net({
        url: rooms,
        room: new URLSearchParams(location.search).get('room') || 'lobby',
        presence,
        me: () => session && { mode: mode.id, body: mode.body, pos: session.body.pos, yaw: session.body.yaw },
        onChange: showPeople,
      });
      showPeople();
    }

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
// An asset's `_neg` meshes are copied into its manifest by the kit's pack step,
// in the asset's own space, which is what lets them be known HERE — with the
// layout, before the map's collision exists — rather than whenever a megabyte
// of GLB finishes arriving. The prop itself is not on stage yet, so where it
// will stand is worked out from the same numbers placeProp() will use: its
// placement, plus the seat offset of its manifest's pose and of any `rigs`
// entry, which both move the prop root.
function packagedNegatives(scene) {
  const volumes = [];
  for (const prop of scene.props) {
    const own = scene.manifests.get(prop.name);
    if (!own?.negatives?.length) continue;
    const [px, py, pz] = prop.pos ?? [0, 0, 0];
    const lift = [own.offset, manifest.rigs?.[prop.name]?.offset].filter(Array.isArray);
    const at = matrixOf({ ...prop, pos: lift.reduce((p, o) => [p[0] + o[0], p[1] + o[1], p[2] + o[2]], [px, py, pz]) });
    for (const entry of own.negatives) {
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
// player starts is one.
//
// The manifests of the placed assets are fetched here too, JSON only. They are
// a few KB each and the map is megabytes, so they are always in long before it
// is — and they have to be, because an asset may carry a hole for the map.
async function loadLayout() {
  const props = new Map(manifest.props.map((p) => [p.name, p]));
  const negatives = new Map((manifest.negatives ?? []).map((n) => [n.name, n]));
  const markers = new Map((manifest.markers ?? []).map((m) => [m.name, m]));
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
    } catch (err) {
      console.warn(`[scene] no Blender placements (${placements}):`, err.message);
    }
  }
  // A manifest that fails here fails again, loudly, when its prop is placed.
  const manifests = new Map();
  await Promise.all([...props.values()].filter((p) => p.manifest).map(async (p) => {
    try { manifests.set(p.name, await loadManifest(p.manifest)); } catch { /* reported by loadProp */ }
  }));
  return { props: [...props.values()], negatives: [...negatives.values()], markers: [...markers.values()], manifests };
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
// A prop is an object and, when it ships as a package, its manifest and
// script: `glb` names the object, `manifest` the manifest, and the manifest
// names the script. The scene exporter writes both paths when the asset ships
// a manifest beside its GLB (an animated character does — see
// ANIMATED_PROPS.md). The package is fetched alongside the GLB rather than
// after it, so the downloads overlap instead of queueing; a package that fails
// is reported and the object still lands, as a statue.
function loadProp(prop) {
  const asset = loadContainer(prop.glb);
  if (prop.script && !prop.manifest) {
    console.warn(`[prop ${prop.name}] names a script (${prop.script}) and no manifest — a layout from before `
      + 'scripts were code; run `npm run scene:export` again');
  }
  const pkg = prop.manifest
    ? loadPackage(prop.manifest).catch((err) => {
      console.error(`[prop ${prop.name}] package ${prop.manifest} failed to load: ${err.message}`);
      return null;
    })
    : Promise.resolve(null);
  asset.ready(() => pkg.then((loaded) => placeProp(prop, asset, loaded)).catch((err) => {
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
    // The asset's own manifest first — how the object stands wherever it
    // stands: its bind pose captured, anything it says to hang hung, its own
    // pose. Then the scene manifest's per-placement pose on top, the way
    // placements shadow hand-written props. The script runs last, below.
    // The world's clock is the script's: held, its videos wait to be seeked by
    // each step; and what it sounds is logged while held, for the recorder's mix.
    const script = loaded ? new PropScript(root, loaded, prop.name, { app, held: () => clock.held, report: heard }) : null;
    if (script) {
      for (const w of script.warnings) console.warn(`[script ${prop.name}] ${w}`);
      scripted.push(script);
      if (script.rig) debug?.addRig(script.rig);
    }
    // Fold the rig before the hierarchy syncs: the pose moves the prop root
    // (its seat offset), and that has to be settled before collision bakes
    // world-space triangles out of it.
    const rig = rigForProp(root, prop, manifest.rigs);
    if (rig && loaded?.manifest.clips?.length) {
      console.warn(`[rig ${prop.name}] a pose in scene.manifest.mjs and clips from ${prop.manifest} `
        + 'may both drive this prop — a clip rewrites its bones every frame, so the pose only '
        + 'holds on bones the clip leaves alone');
    }
    if (rig) debug?.addRig(rig);
    root.syncHierarchy();          // world transforms must be final before we
                                   // bake collision triangles out of them
    const solid = addPropCollision(prop, root, rig, script);
    const proxies = hideCollisionProxies(root);   // after collision, before the first frame
    const volumes = hideVolumes(root);            // `_neg` / `_act`: read from the manifest long ago
    const unlit = unlitIgnoreAmbient(root);       // an unlit surface takes no ambient
    // Now the script: on stage, posed, collision baked, so nothing it plays is
    // frozen into the collider. Whatever it offers a player is then in reach
    // of the E key.
    if (script) {
      script.start();
      actions?.add(prop.name, root, script);
    }
    // Scale is in the line because "is my Blender edit actually in this tab?" is
    // the question you ask most while placing, and a stale placements file
    // answers it silently and wrongly. Read it, compare with the .blend.
    console.log(`[prop ${prop.name}] placed @ ${root.getLocalPosition().toString()}`
      + ` scale ${sx === sy && sy === sz ? sx : `${sx},${sy},${sz}`}${solid}`
      + (proxies ? ` (${proxies} collision proxy mesh hidden)` : '')
      + (volumes ? ` (${volumes} volume mesh hidden)` : '')
      + (unlit ? ` (${unlit} unlit material sealed from ambient)` : '')
      + (rig ? ` (rig: ${rig.count} bones posed${rig.moveCount ? `, ${rig.moveCount} nodes moved` : ''})` : '')
      + (script ? ` (package: ${script.describe()})` : ''));
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
 * An asset's manifest may answer too — an animated one says `solid: false`,
 * because collision is baked once at load and a dancer would leave a statue
 * of his first frame standing in the room. The placement's own word wins
 * over the manifest's: the asset says what it is, the pavilion says what this
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
    return ` — walk-through (solid: false${own === undefined || own === null ? ', from its manifest' : ''})`;
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

// ---- Modes ----
// Which game a bare page opens: the address bar's, if it names one we have.
function initialMode() {
  const asked = new URLSearchParams(location.search).get('mode');
  if (!asked) return MODES[0];
  if (MODES.includes(asked)) return asked;
  console.warn(`[mode] ?mode=${asked} is not a game here (${MODES.join(', ')}) — playing ${MODES[0]}`);
  return MODES[0];
}

// Leave the game being played and enter another, in the same world, where the
// last one's view was — or at `view` ({ x, y, z, yaw, pitch }, the eye), which
// enters the game afresh even if it is the one being played: that is how a
// shot framed in the fly-over is put back by tools/record.mjs. Serialised: a
// second pick while a module is still downloading waits its turn instead of
// racing it.
let switching = Promise.resolve();
function switchMode(id, view = null) {
  switching = switching.then(async () => {
    if (!MODES.includes(id)) throw new Error(`no mode "${id}" (${MODES.join(', ')})`);
    if (mode?.id === id && !view) return;
    const next = (await import(`./modes/${id}/index.mjs`)).default;
    const from = view ?? session?.view() ?? null;
    session?.exit();
    mode = next;
    session = next.enter(world, from);
    // E measures reach from whatever the game moves around as.
    actions.player = session.body;
    // The others redraw this browser's ghost as whatever it now moves as.
    net?.hello();
    document.body.dataset.mode = id;
    showMode();
    // The address says what is being played, so a reload or a shared link
    // comes back to it. The first mode is the bare URL.
    const url = new URL(location.href);
    if (id === MODES[0]) url.searchParams.delete('mode');
    else url.searchParams.set('mode', id);
    history.replaceState(history.state, '', url);
    console.log(`[mode] ${id}`);
  });
  return switching;
}

// The overlay speaks for the game picked: its name, its keys, and the keys
// every game shares, which are the world's.
function showMode() {
  ui.title.textContent = mode.title;
  ui.sub.textContent = `PlayCanvas · ${mode.sub}`;
  ui.controls.replaceChildren();
  for (const [k, d] of [...mode.controls, ['E', 'Use what the E is on'], ['Esc', 'Release mouse']]) {
    const key = document.createElement('span'); key.className = 'k'; key.textContent = k;
    const what = document.createElement('span'); what.className = 'd'; what.textContent = d;
    ui.controls.append(key, what);
  }
  for (const b of ui.modes.children) b.classList.toggle('picked', b.dataset.mode === mode.id);
}

// Who else is here, on the overlay. Nothing at all when there is no network.
function showPeople() {
  const n = net.others, lost = net.lost.size;
  const s = (k) => (k > 1 ? 's' : '');
  ui.people.textContent = net.state === 'connecting' ? `Room ${net.room} — connecting…`
    : net.state === 'full' ? `Room ${net.room} is full — playing alone`
    : n ? `Room ${net.room} — ${n} other${s(n)} here` + (lost ? `, ${lost} more could not be reached` : '')
    : net.linking ? `Room ${net.room} — someone is here, linking…`
    : lost ? `Room ${net.room} — ${lost} other${s(lost)} here, but no direct link could be made: a network is blocking it`
    : net.state === 'closed' ? 'Playing alone — the rooms server is not answering'
    : `Room ${net.room} — nobody else here yet`;
}

for (const [id, name] of Object.entries(MODE_NAMES)) {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.mode = id; b.textContent = name;
  ui.modes.append(b);
  b.addEventListener('click', () => {
    if (!world) return;              // not built yet: the pick waits for Ready
    switchMode(b.dataset.mode).catch((err) => console.error('[mode]', err));
  });
}

// ---- Input ----
// The world's keys are E (and V / backtick on the debug URL); everything else
// is handed to the game being played.
function isLocked() { return pc.Mouse.isPointerLocked(); }

app.mouse.on(pc.EVENT_MOUSEMOVE, (e) => {
  if (!started || !isLocked() || !session) return;
  session.look?.(e.dx, e.dy);
});
app.mouse.on(pc.EVENT_MOUSEDOWN, (e) => {
  if (!started || !isLocked()) return;
  session?.down?.(e.button);
});
app.mouse.on(pc.EVENT_MOUSEUP, (e) => {
  session?.up?.(e.button);
});

app.keyboard.on(pc.EVENT_KEYDOWN, (e) => {
  if (e.key === pc.KEY_V && debug) { debug.cycleMode(); return; } // works while paused too
  if (!started) return;
  // Once per press: a held key repeats, and a dance set off and stopped thirty
  // times a second is a man twitching.
  if (e.key === pc.KEY_E && actions && isLocked() && !e.event?.repeat) { actions.trigger(); return; }
  session?.press?.(e.key);
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
  // What shows while playing is CSS, keyed on these and on data-mode (see
  // index.html): the dot for every game, the crosshair and HUD for one.
  document.body.classList.toggle('playing', locked);
  if (locked) {
    started = true;
    document.body.classList.add('started');
    ui.overlay.classList.add('hidden');
  } else {
    // Paused — show overlay again.
    session?.pause?.();
    ui.overlay.classList.remove('hidden');
    ui.playBtn.textContent = 'Click to Resume';
  }
});

// ---- Clock ----
// Time is a value the world is given, not something the frame timer decides.
// Played, the timer gives it: each frame's real dt, clamped. Held, nobody
// does until step(dt) is called, which advances the world by exactly dt and
// draws it — however long drawing takes. That is how tools/record.mjs renders
// a dance frame-exact under a software renderer. There is one clock and one
// loop body; holding changes who feeds it, never what a frame does.
const clock = {
  held: false,
  time: 0,        // world seconds, advanced by every frame, played or stepped
  // What the placed objects sounded while held, each stamped with `time`:
  // { t, kind: 'sound', id, object, file, url, loop, volume, pos } as one
  // starts, { t, kind: 'stop', id } when one is cut short. Emptied by hold().
  log: [],

  hold() {
    if (this.held) return;
    this.held = true;
    this.log = [];
    cancelAnimationFrame(app.frameRequestId);
    app.frameRequestId = null;
  },

  release() {
    if (!this.held) return;
    this.held = false;
    app._time = 0;               // the first frame back measures from itself, not from the hold
    app.requestAnimationFrame();
  },

  // Advance by exactly dt and draw. Async because a frame may depend on
  // something that has to arrive before it is drawn — a video seeked to the
  // frame's time. Resolves right after the draw, in the same task, so the
  // canvas can still be read.
  async step(dt) {
    if (!this.held) throw new Error('clock.step: hold the clock first');
    app.update(dt);              // the engine's systems, then the loop body below
    await Promise.all(scripted.map((s) => s.ready?.()));
    app.render();
  },
};

function heard(event) {
  if (clock.held) clock.log.push({ t: clock.time, ...event });
}

// ---- Loop ----
app.on('update', (dt) => {
  if (!session) return;
  // A played frame is clamped (tab switches); a stepped one is what was asked.
  const d = clock.held ? dt : Math.min(dt, 0.05);
  clock.time += d;
  const live = started && isLocked();

  // The game first: it moves the view everything below is measured from.
  session.update(d, live);

  if (debug) debug.updateReadout();

  // Scripts tick on the same clamped step as the controller, so a tab switch
  // does not fast-forward a dance any more than it fast-forwards a fall.
  for (const s of scripted) s.update(d);

  // Where this browser is, said to the others; where they are, drawn.
  net?.update();

  // After the clips, so a dancer is reached where this frame's pose put him;
  // the hints come down with the pause overlay and the crosshair.
  actions.update(live);
});

app.start();
boot();
