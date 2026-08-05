// PlayCanvas Editor entry point.
//
// Attach this script (scriptName "game") to a single entity in your Editor scene
// — the player root. On initialize it boots the whole FPS: loads the map from an
// asset attribute, builds collision, finds a spawn, and wires the Player, Weapon,
// Targets and Debug systems — the same classes the standalone build uses. The
// Editor owns the Application; this script never creates one.
//
// Find-or-create policy: anything you author in the Editor wins. If the scene
// already has a camera child or directional lights, they're used as-is; if not,
// the script supplies sensible defaults so it also runs on a bare entity. The
// viewmodel layer + second camera are always created in code (render plumbing you
// wouldn't hand-place).
import * as pc from 'playcanvas';
import { Script, Entity, Asset, Color, Layer } from 'playcanvas';
import { TriangleCollider } from './collision.mjs';
import { Player } from './player.mjs';
import { Weapon } from './weapon.mjs';
// Statically imported, unlike the standalone build's dynamic import: an Editor
// project resolves its scripts through the asset registry, where a bare relative
// import() at runtime has no reliable base URL. isDebugMode() still gates the
// panel — the code is merely present, never built.
import { DebugTools, togglePanel, removePanel } from './debug.mjs';
import { isDebugMode } from './debugmode.mjs';
import { TargetManager, extractTriangles, findFloors, pickSpawn } from './world.mjs';
import { applyFog, disableFogOn, SurfaceLook, EDITOR_FOG, EDITOR_SURFACE } from './atmosphere.mjs';
import { injectUI } from './ui.mjs';

export class Game extends Script {
  static scriptName = 'game';

  /**
   * The de_dust2 model, imported as a container (GLB) asset.
   * @attribute
   * @title Map (GLB container)
   * @type {Asset}
   * @resource container
   */
  mapAsset;

  /**
   * URL of the original GLB (embedded textures). Loaded through the engine's own
   * container parser so the map keeps its textures — the Editor's imported Map
   * asset above has its materials/textures stripped out of the stored file and
   * renders untextured. Defaults to this repo's GitHub Pages deploy, which serves
   * the unprocessed .glb with CORS enabled. Clear it to fall back to the Map asset.
   * @attribute
   * @title Map URL (embedded GLB)
   * @type {string}
   */
  mapUrl = 'https://history.singularitymuseum.com/assets/de_dust2.glb';

  /**
   * Map authored directly in the Editor scene — drag the GLB container into the
   * viewport and set its scale to 0.025 and X-rotation to -90. Assign it here so
   * you can SEE the world and place props against it at edit time.
   *
   * • If **Map URL is empty**, this authored entity IS the runtime map: its Editor
   *   materials/textures render as-is and collision is extracted from it.
   * • If **Map URL is set**, the textured URL map stays authoritative for rendering
   *   and collision; this entity's meshes are hidden at launch so they don't double
   *   up with it (they share the same transform). Props you author beside it survive.
   * @attribute
   * @title Map (authored in scene)
   * @type {Entity}
   */
  mapEntity;

  /**
   * FPS camera. Leave empty to use a child camera of this entity, or to have one
   * created automatically.
   * @attribute
   * @type {Entity}
   */
  cameraEntity;

  /**
   * Uniform scale applied to the map (Source units → metres).
   * @attribute
   */
  mapScale = 0.025;

  /**
   * Map rotation about X, degrees (Z-up → Y-up).
   * @attribute
   */
  mapRotationX = -90;

  initialize() {
    const app = this.app;

    // Guard against Editor hot-reload stacking handlers: tear down a prior
    // instance's listeners before this one attaches its own.
    if (app.__fpsGameCleanup) { try { app.__fpsGameCleanup(); } catch (e) { /* ignore */ } }
    app.__fpsGameCleanup = () => this._cleanup();

    this.started = false;
    this.score = 0;
    this.player = null;
    this.weapon = null;
    this.targets = null;
    this.collider = null;
    this.debug = null;
    this._created = [];              // entities/layers we made → removed in cleanup
    this._mapContainer = null;       // runtime-loaded map container → unloaded in cleanup
    this._winHandlers = [];          // [target, event, fn] for window/document
    this.input = { forward: 0, strafe: 0, jump: false, sprint: false };
    this._prevJump = false;

    if (!app.mouse || !app.keyboard) {
      console.warn('[game] app has no mouse/keyboard input device — enable them on the Application.');
    }

    // ---- HUD (injected DOM, kept in synced code) ----
    const { ui, hud, teardown } = injectUI();
    this.ui = ui; this.hud = hud; this._teardownUI = teardown;
    this.addScore = (n) => { this.score += n; this.ui.scoreVal.textContent = this.score; };

    // ---- Global scene look (Editor scene settings can override these) ----
    this.SKY = new Color(0.957, 0.839, 1);   // mirrors scene.manifest.mjs `sky`
    app.scene.ambientLight = new Color(0.55, 0.53, 0.5);
    if ('exposure' in app.scene) app.scene.exposure = 1.0;

    // Distance haze + the map's PBR response. Both are live sliders on a debug
    // launch (&debug); see atmosphere.mjs for the numbers' authoring home.
    applyFog(app.scene, EDITOR_FOG);
    this.surface = new SurfaceLook(EDITOR_SURFACE);

    this._setupCameraRig();
    this._setupLights();
    this._setupViewmodel();
    this._bindInput();
    this._boot();
  }

  // ---- Camera rig: this.entity is the player root; find or make a child camera.
  _setupCameraRig() {
    this.playerRoot = this.entity;
    let cam = this.cameraEntity;
    if (!cam) {
      const cc = this.entity.findComponent('camera');
      cam = cc ? cc.entity : null;
    }
    if (!cam) {
      cam = new Entity('camera');
      cam.addComponent('camera', { clearColor: this.SKY, fov: 78, nearClip: 0.05, farClip: 600 });
      this.entity.addChild(cam);
      this._created.push(cam);
    }
    this.camera = cam;

    // Refractive / glass materials (e.g. an imported prop's "Glass") sample a scene
    // color grab-pass via uSceneColorMap. It's off by default, so those shaders render
    // with no source and the engine warns ("uSceneColorMap ... not available"). Enable
    // it on the main camera — cheap when nothing refractive is in view, and it covers
    // any future glass prop without per-material fiddling in the Editor.
    if (cam.camera?.requestSceneColorMap) cam.camera.requestSceneColorMap(true);
  }

  // ---- Lights: respect any Editor-authored directional light; else add sun+fill.
  // Either way this.sun/this.fill end up pointing at whatever is lighting the
  // scene, so the debug panel's Lighting sliders drive the real lights.
  _setupLights() {
    const app = this.app;
    const dirs = app.root.findComponents('light').filter((l) => l.type === 'directional');
    if (dirs.length) {
      // Brightest authored directional is the key light; next one is the fill.
      const sorted = [...dirs].sort((a, b) => b.intensity - a.intensity);
      this.sun = sorted[0].entity;
      this.fill = sorted[1]?.entity ?? null;
      return;
    }

    const sun = new Entity('sun');
    sun.addComponent('light', {
      type: 'directional', color: new Color(1.0, 0.96, 0.86), intensity: 2.15,
      castShadows: true, shadowBias: 0.2, normalOffsetBias: 0.06,
      shadowDistance: 90, shadowResolution: 2048, shadowType: pc.SHADOW_PCF3 ?? undefined,
    });
    sun.setEulerAngles(52, 28, 0);
    app.root.addChild(sun);
    this._created.push(sun);
    this.sun = sun;

    const fill = new Entity('fill');
    fill.addComponent('light', { type: 'directional', color: new Color(0.6, 0.7, 0.85), intensity: 0.6, castShadows: false });
    fill.setEulerAngles(120, -140, 0);
    app.root.addChild(fill);
    this._created.push(fill);
    this.fill = fill;
  }

  // ---- Viewmodel layer + top-most camera + dedicated light (always code-made).
  _setupViewmodel() {
    const app = this.app;
    let vmLayer = app.scene.layers.getLayerByName('Viewmodel');
    if (!vmLayer) {
      vmLayer = new Layer({ name: 'Viewmodel' });
      app.scene.layers.push(vmLayer);
      this._createdLayer = vmLayer;
    }
    this.vmLayer = vmLayer;

    const vmCamera = new Entity('vmCamera');
    vmCamera.addComponent('camera', {
      clearColorBuffer: false, clearDepthBuffer: true, fov: 65,
      nearClip: 0.01, farClip: 50, layers: [vmLayer.id], priority: 1,
    });
    // The gun sits ~0.5 m from the lens; keep it out of the fog at any density.
    disableFogOn(vmCamera.camera);
    this.camera.addChild(vmCamera);
    this._created.push(vmCamera);

    const vmLight = new Entity('vmLight');
    vmLight.addComponent('light', {
      type: 'directional', color: new Color(1, 0.97, 0.9), intensity: 2.2,
      castShadows: false, layers: [vmLayer.id],
    });
    vmLight.setEulerAngles(45, 20, 0);
    app.root.addChild(vmLight);
    this._created.push(vmLight);
  }

  // ---- Load map, build collision, spawn systems ----
  _boot() {
    // Visual-authoring path: a map you dropped into the Editor scene so you can see
    // the world and place props against it. With no Map URL set, this authored
    // entity IS the runtime map (its Editor materials render as-is, collision comes
    // from it). With a Map URL set, the textured URL map below is authoritative, so
    // hide this reference's meshes at launch to avoid a doubled, z-fighting map —
    // it shares the URL map's transform, and props authored beside it survive.
    if (this.mapEntity && !this.mapUrl) {
      this._onAuthoredMap(this.mapEntity);
      return;
    }
    if (this.mapEntity && this.mapUrl) {
      for (const rc of this.mapEntity.findComponents('render')) rc.enabled = false;
    }

    // The Editor's GLB import splits the map's materials/textures into separate
    // assets and strips them from the stored container file, so both instantiating
    // the imported container and re-parsing its file URL render untextured
    // (defaultGlbMaterial). Instead load the ORIGINAL embedded-texture GLB from a
    // URL through the engine's own container parser — that keeps all 34 baseColor
    // textures (verified: 79/79 mesh instances get a diffuseMap), the same result
    // the standalone build gets. mapUrl defaults to this repo's GitHub Pages deploy,
    // which serves the unprocessed .glb with CORS enabled.
    if (this.mapUrl) {
      const asset = new Asset('de_dust2-embedded', 'container', { url: this.mapUrl });
      this._mapContainer = asset;      // unloaded in _cleanup (watch hot-reloads)
      asset.on('error', (err) => {
        this.ui.loading.textContent = 'Failed to load map: ' + err;
        console.error('[game] map container load error:', err);
      });
      this.app.assets.add(asset);
      asset.ready(() => this._onMapReady(asset));
      this.app.assets.load(asset);
      return;
    }
    // Fallback: no URL set — instantiate the assigned Editor container (untextured).
    const src = this.mapAsset;
    if (!src) {
      this.ui.loading.textContent = 'No map source (set Map URL, or assign the Map asset).';
      console.warn('[game] no mapUrl and no mapAsset set.');
      return;
    }
    const onReady = () => this._onMapReady(src);
    if (src.resource) onReady();
    else { src.ready(onReady); this.app.assets.load(src); }
  }

  _onMapReady(asset) {
    const app = this.app;
    this.ui.loading.textContent = 'Building collision…';

    const renderRoot = asset.resource.instantiateRenderEntity();
    const map = new Entity('map');
    map.addChild(renderRoot);
    map.setLocalScale(this.mapScale, this.mapScale, this.mapScale);
    map.setEulerAngles(this.mapRotationX, 0, 0);
    app.root.addChild(map);
    map.syncHierarchy();
    this._created.push(map);

    this._wireWorld(renderRoot);
  }

  // Use a map that already lives in the Editor scene (authored in the viewport).
  // Its transform is whatever you set in the Editor — set scale 0.025 and
  // X-rotation -90 there so it matches human proportions and the standalone build.
  _onAuthoredMap(mapEntity) {
    this.ui.loading.textContent = 'Building collision…';
    mapEntity.syncHierarchy();
    this._wireWorld(mapEntity);
  }

  // Shared world wiring given the map's render hierarchy (instantiated or authored):
  // material fixups, collision, spawn, and every gameplay system.
  _wireWorld(renderRoot) {
    const app = this.app;

    // Both-sided ripped walls + dry-stone PBR response (see atmosphere.mjs).
    this.surface.adopt(renderRoot);

    const tris = extractTriangles(renderRoot);
    this.collider = new TriangleCollider(tris, 2.0);

    const floors = findFloors(this.collider);
    const spawn = pickSpawn(floors, this.collider.bounds);

    this.player = new Player(this.playerRoot, this.camera, this.collider, {});
    this.player.teleport(spawn.x, spawn.y, spawn.z);
    this.player.spawn = spawn;
    this.player.floors = floors;

    this.targets = new TargetManager(app, this.collider, floors.length ? floors : [spawn], this.addScore);

    this.weapon = new Weapon(app, this.camera, this.player, this.collider, {
      hud: this.hud,
      layer: this.vmLayer.id,
      queryTargets: (o, d, maxDist) => this.targets.query(o, d, maxDist),
    });

    // Tweak panel on debug URLs only (launch with `&debug`); null otherwise.
    this.debug = isDebugMode() ? new DebugTools({
      app, player: this.player, collider: this.collider, mapRender: renderRoot, spawn,
      surface: this.surface, sun: this.sun, fill: this.fill, camera: this.camera,
    }) : null;

    // Debug handle (parity with the standalone build; used by automated checks).
    window.game = {
      app, player: this.player, weapon: this.weapon, targets: this.targets,
      collider: this.collider, debug: this.debug, surface: this.surface,
      camera: this.camera, root: this.playerRoot,
    };

    this.ui.loading.textContent = `Ready — ${tris.length.toLocaleString()} tris, ${floors.length} floor samples`;
    this.ui.playBtn.disabled = false;
    this.ui.playBtn.textContent = 'Click to Play';
  }

  // ---- Input wiring ----
  _bindInput() {
    const app = this.app;

    this._onMove = (e) => {
      if (!this.started || !pc.Mouse.isPointerLocked() || !this.player) return;
      this.player.addLook(e.dx, e.dy, 0.12);
    };
    this._onDown = (e) => {
      if (!this.started || !pc.Mouse.isPointerLocked()) return;
      if (e.button === pc.MOUSEBUTTON_LEFT && this.weapon) this.weapon.startFire();
    };
    this._onUp = (e) => {
      if (e.button === pc.MOUSEBUTTON_LEFT && this.weapon) this.weapon.stopFire();
    };
    this._onKey = (e) => {
      if (e.key === pc.KEY_V && this.debug) { this.debug.cycleMode(); return; }
      if (!this.started) return;
      if (e.key === pc.KEY_R && this.weapon) this.weapon.reload();
      if (e.key === pc.KEY_T && this.player && this.player.floors && this.player.floors.length) {
        const s = this.player.floors[Math.floor(Math.random() * this.player.floors.length)];
        this.player.teleport(s.x, s.y + 0.15, s.z);
      }
    };
    if (app.mouse) {
      app.mouse.on(pc.EVENT_MOUSEMOVE, this._onMove);
      app.mouse.on(pc.EVENT_MOUSEDOWN, this._onDown);
      app.mouse.on(pc.EVENT_MOUSEUP, this._onUp);
    }
    if (app.keyboard) app.keyboard.on(pc.EVENT_KEYDOWN, this._onKey);

    // Play button → pointer lock.
    this._onPlay = () => { if (!this.ui.playBtn.disabled && app.mouse) app.mouse.enablePointerLock(); };
    this.ui.playBtn.addEventListener('click', this._onPlay);

    // Backtick toggles the debug panel (no-op when there isn't one).
    this._onWinKey = (e) => {
      if (e.code === 'Backquote') togglePanel();
    };
    window.addEventListener('keydown', this._onWinKey);
    this._winHandlers.push([window, 'keydown', this._onWinKey]);

    // Overlay show/hide on pointer-lock change.
    this._onLockChange = () => {
      const locked = pc.Mouse.isPointerLocked();
      if (locked) {
        this.started = true;
        this.ui.overlay.classList.add('hidden');
        this.ui.crosshair.style.display = 'block';
        this.ui.dot.style.display = 'block';
        this.ui.hud.style.display = 'block';
      } else {
        if (this.weapon) this.weapon.stopFire();
        this.ui.overlay.classList.remove('hidden');
        this.ui.playBtn.textContent = 'Click to Resume';
        this.ui.crosshair.style.display = 'none';
        this.ui.dot.style.display = 'none';
      }
    };
    document.addEventListener('pointerlockchange', this._onLockChange);
    this._winHandlers.push([document, 'pointerlockchange', this._onLockChange]);
  }

  _pollKeyboard() {
    const k = this.app.keyboard;
    if (!k) return;
    let f = 0, s = 0;
    if (k.isPressed(pc.KEY_W) || k.isPressed(pc.KEY_UP)) f += 1;
    if (k.isPressed(pc.KEY_S) || k.isPressed(pc.KEY_DOWN)) f -= 1;
    if (k.isPressed(pc.KEY_D) || k.isPressed(pc.KEY_RIGHT)) s += 1;
    if (k.isPressed(pc.KEY_A) || k.isPressed(pc.KEY_LEFT)) s -= 1;
    this.input.forward = f;
    this.input.strafe = s;
    this.input.sprint = k.isPressed(pc.KEY_SHIFT);
    const jumpDown = k.isPressed(pc.KEY_SPACE);
    this.input.jump = jumpDown && !this._prevJump;
    this._prevJump = jumpDown;
  }

  // ---- Per-frame loop (engine calls this) ----
  update(dt) {
    if (!this.player) return;
    const d = Math.min(dt, 0.05);

    if (this.started && pc.Mouse.isPointerLocked()) {
      this._pollKeyboard();
    } else {
      this.input.forward = 0; this.input.strafe = 0; this.input.jump = false; this.input.sprint = false;
    }

    this.player.update(d, this.input);

    if (this.debug) this.debug.updateReadout();

    if (this.player.pos.y < this.collider.bounds.miny - 20 && this.player.spawn) {
      this.player.teleport(this.player.spawn.x, this.player.spawn.y, this.player.spawn.z);
    }

    if (this.weapon) this.weapon.update(d);
    if (this.targets) this.targets.update(d);
    this.hud.tick(d);
  }

  // ---- Teardown (hot-reload / entity destroy) ----
  _cleanup() {
    const app = this.app;
    if (app.mouse) {
      app.mouse.off(pc.EVENT_MOUSEMOVE, this._onMove);
      app.mouse.off(pc.EVENT_MOUSEDOWN, this._onDown);
      app.mouse.off(pc.EVENT_MOUSEUP, this._onUp);
    }
    if (app.keyboard) app.keyboard.off(pc.EVENT_KEYDOWN, this._onKey);
    if (this.ui?.playBtn && this._onPlay) this.ui.playBtn.removeEventListener('click', this._onPlay);
    for (const [target, ev, fn] of this._winHandlers) target.removeEventListener(ev, fn);
    this._winHandlers = [];

    for (const e of this._created) { try { e.destroy(); } catch (err) { /* ignore */ } }
    this._created = [];
    if (this._mapContainer) {
      try { app.assets.remove(this._mapContainer); this._mapContainer.unload(); } catch (err) { /* ignore */ }
      this._mapContainer = null;
    }
    if (this._createdLayer) {
      const layers = app.scene.layers;
      const i = layers.layerList.indexOf(this._createdLayer);
      if (i >= 0) layers.layerList.splice(i, 1);
      this._createdLayer = null;
    }
    if (this._teardownUI) this._teardownUI();
    removePanel();   // the panel lives outside the injected UI root
    if (app.__fpsGameCleanup) app.__fpsGameCleanup = null;
  }

  destroy() { this._cleanup(); }
}
