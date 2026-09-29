// The shooter: on foot, an AK, red dummies to score on.
//
// One of the games played in the world, with no more standing than any other
// (see ../README.md for the shape every mode has). It walks the world's
// walker, draws its gun on a layer of its own, and takes all of it away again
// on exit(): after it the world is as it was before it came.
import * as pc from 'playcanvas';
import { Weapon } from './weapon.mjs';
import { TargetManager } from './targets.mjs';
import { placeAtSpawn } from '../../spawn.mjs';
import { disableFogOn } from '../../atmosphere.mjs';

const { Color, Entity } = pc;

export default {
  id: 'shooter',
  title: 'DE_DUST2',
  sub: 'First-Person Shooter',
  body: 'walker',
  controls: [
    ['W A S D', 'Move'],
    ['Mouse', 'Look'],
    ['L-Click', 'Shoot'],
    ['Shift', 'Sprint'],
    ['Space', 'Jump'],
    ['R', 'Reload'],
    ['T', 'Teleport to new spawn'],
  ],
  enter,
};

function enter(world, from) {
  const { app, camera, walker, collider, floors, spawn, audio, manifest } = world;

  // Coming from another game: stand on whatever is under where its view was.
  if (from) {
    const ground = collider.groundBelow(from.x, from.z, from.y, 500);
    if (ground) walker.teleport(from.x, ground.y, from.z);
    else placeAtSpawn(walker, walker.spawn);
    walker.yaw = from.yaw;
    walker.pitch = from.pitch;
  }

  // ---- UI handles (the markup is in index.html) ----
  const ui = {
    hitmarker: document.getElementById('hitmarker'),
    scoreVal: document.getElementById('scoreVal'),
  };
  let score = 0;
  const addScore = (n) => { score += n; ui.scoreVal.textContent = score; };
  addScore(0);
  let hitmarkerTimer = 0;
  const hud = {
    mag: document.getElementById('mag'),
    reserve: document.getElementById('reserve'),
    reloading: document.getElementById('reloading'),
    hit() { ui.hitmarker.style.opacity = 1; hitmarkerTimer = 0.12; },
  };

  // ---- Viewmodel layer (drawn on top, depth cleared → gun never clips walls) ----
  const vmLayer = new pc.Layer({ name: 'Viewmodel' });
  app.scene.layers.push(vmLayer);

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
  camera.addChild(vmCamera);

  // A light bound to the viewmodel layer so the gun is shaded (not just ambient).
  const vmLight = new Entity('vmLight');
  vmLight.addComponent('light', {
    type: 'directional', color: new Color(1, 0.97, 0.9), intensity: 2.2,
    castShadows: false, layers: [vmLayer.id],
  });
  vmLight.setEulerAngles(45, 20, 0);
  app.root.addChild(vmLight);

  const targets = new TargetManager(app, collider, floors.length ? floors : [spawn], addScore, { max: manifest.targets.max });

  const weapon = new Weapon(app, camera, walker, collider, {
    hud,
    layer: vmLayer.id,
    queryTargets: (o, d, maxDist) => targets.query(o, d, maxDist),
    onEvent: (event) => audio?.onWeaponEvent(event),
  });

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

  return {
    body: walker,
    weapon,
    targets,

    view() {
      return { x: walker.pos.x, y: walker.pos.y + walker.eyeHeight, z: walker.pos.z, yaw: walker.yaw, pitch: walker.pitch };
    },

    look(dx, dy) { walker.addLook(dx, dy, 0.12); },
    down(button) { if (button === pc.MOUSEBUTTON_LEFT) weapon.startFire(); },
    up(button) { if (button === pc.MOUSEBUTTON_LEFT) weapon.stopFire(); },
    press(key) {
      if (key === pc.KEY_R) weapon.reload();
      if (key === pc.KEY_T && walker.floors?.length) {
        const s = walker.floors[Math.floor(Math.random() * walker.floors.length)];
        walker.teleport(s.x, s.y + 0.15, s.z);
      }
    },
    pause() { weapon.stopFire(); },

    update(dt, live) {
      if (live) pollKeyboard();
      else { input.forward = 0; input.strafe = 0; input.jump = false; input.sprint = false; }

      walker.update(dt, input);
      // Immediately after the controller, and never before it: the jump and the
      // landing are edges walker.update() consumes as it goes past. See audio.mjs.
      audio?.update(dt, walker, input);
      // Fell out of the world: back onto the last floor stood on (see spawn.mjs).
      world.rescue.update();

      weapon.update(dt);
      targets.update(dt);

      if (hitmarkerTimer > 0) {
        hitmarkerTimer -= dt;
        if (hitmarkerTimer <= 0) ui.hitmarker.style.opacity = 0;
      }
    },

    exit() {
      weapon.destroy();
      targets.destroy();
      vmCamera.destroy();
      vmLight.destroy();
      app.scene.layers.remove(vmLayer);
      ui.hitmarker.style.opacity = 0;
    },
  };
}
