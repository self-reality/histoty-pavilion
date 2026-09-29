// The fly-over: a free camera. No body, no gravity, no gun.
//
// One of the games played in the world, with no more standing than any other
// (see ../README.md). It flies where you look and keeps the lens out of the
// walls with the same collider everyone else stands on, read and never
// changed. It moves the world's camera rig directly, so the walker it leaves
// behind is simply parked until a walking game picks it up again.
import * as pc from 'playcanvas';
import { closestPointOnTriangle } from '../../collision.mjs';

const _dir = new pc.Vec3();
const _step = new pc.Vec3();
const _cp = new pc.Vec3();

export default {
  id: 'flyover',
  title: 'FLY-OVER',
  sub: 'Free camera',
  body: 'flyer',
  controls: [
    ['W A S D', 'Fly where you look'],
    ['Mouse', 'Look'],
    ['Space / C', 'Up / down'],
    ['Shift', 'Fast'],
  ],
  enter,
};

// A camera, not a body. `pos` is the lens; `eyeHeight` 0 says so to whoever
// measures reach from the feet up (src/actions.mjs).
export class Flyer {
  constructor(rig, camera, collider, opts = {}) {
    this.rig = rig;               // holds position + yaw
    this.camera = camera;         // child: holds pitch, at the rig's origin
    this.collider = collider;
    this.speed = opts.speed ?? 8;           // m/s
    this.fastSpeed = opts.fastSpeed ?? 26;
    this.accel = opts.accel ?? 6;           // 1/s, how fast velocity follows the stick
    this.clearance = opts.clearance ?? 0.3; // how close the lens comes to a surface
    this.pos = new pc.Vec3();
    this.vel = new pc.Vec3();
    this.yaw = 0;
    this.pitch = 0;
    this.eyeHeight = 0;
    this.grounded = false;
    this._cand = [];              // scratch candidate triangle list
  }

  addLook(dx, dy, sensitivity) {
    this.yaw -= dx * sensitivity;
    this.pitch = Math.max(-89, Math.min(89, this.pitch - dy * sensitivity));
  }

  /** input: { forward, strafe, rise } each -1..1, and `fast`. */
  update(dt, input) {
    this.rig.setEulerAngles(0, this.yaw, 0);
    this.camera.setLocalPosition(0, 0, 0);
    this.camera.setLocalEulerAngles(this.pitch, 0, 0);

    // Along the view, pitch included: look down and W dives.
    const fwd = this.camera.forward, right = this.camera.right;
    _dir.set(
      fwd.x * input.forward + right.x * input.strafe,
      fwd.y * input.forward + right.y * input.strafe + input.rise,
      fwd.z * input.forward + right.z * input.strafe,
    );
    const len = _dir.length();
    if (len > 1) _dir.mulScalar(1 / len);
    const speed = input.fast ? this.fastSpeed : this.speed;
    const t = 1 - Math.exp(-dt * this.accel);
    this.vel.x += (_dir.x * speed - this.vel.x) * t;
    this.vel.y += (_dir.y * speed - this.vel.y) * t;
    this.vel.z += (_dir.z * speed - this.vel.z) * t;

    _step.copy(this.vel).mulScalar(dt);
    // Twice: the first contact takes the part of the move that goes into the
    // surface away, the second catches a corner the slide runs into.
    for (let i = 0; i < 2 && _step.lengthSq() > 1e-10; i++) this._sweep(_step);
    this.pos.add(_step);
    this._pushOut();
    this.rig.setPosition(this.pos.x, this.pos.y, this.pos.z);
  }

  // Off the collider's footprint there is nothing to hit, and a ray from
  // there takes the collider's slow path (see collision.mjs raycast).
  _overMap() {
    const b = this.collider.bounds;
    return this.pos.x >= b.minx && this.pos.x <= b.maxx && this.pos.z >= b.minz && this.pos.z <= b.maxz;
  }

  // The move as a ray, so a fast one can never step through a thin wall
  // between two frames: shorten `step` to stop short of what it would hit,
  // and turn the rest of it into a slide along that surface.
  _sweep(step) {
    if (!this._overMap()) return;
    const dist = step.length();
    _dir.copy(step).mulScalar(1 / dist);
    const hit = this.collider.raycast(this.pos, _dir, dist + this.clearance);
    if (!hit) return;
    const n = hit.normal;                       // faces the ray
    const along = _dir.dot(n);
    const free = Math.max(0, hit.dist - this.clearance);
    const rest = dist - free;
    step.copy(_dir).mulScalar(free);
    step.x += (_dir.x - n.x * along) * rest;
    step.y += (_dir.y - n.y * along) * rest;
    step.z += (_dir.z - n.z * along) * rest;
    const into = this.vel.dot(n);
    if (into < 0) this.vel.x -= n.x * into, this.vel.y -= n.y * into, this.vel.z -= n.z * into;
  }

  // The lens as a sphere of `clearance`, pushed out of anything it overlaps.
  // The ray keeps it from passing through; this keeps the gap square to the
  // surface, which a ray sliding almost parallel to a wall does not see.
  _pushOut() {
    if (!this._overMap()) return;
    const r = this.clearance, p = this.pos;
    for (let it = 0; it < 3; it++) {
      const cand = this.collider.query(p.x - r, p.z - r, p.x + r, p.z + r, this._cand);
      let moved = false;
      for (const t of cand) {
        if (p.y + r < t.miny || p.y - r > t.maxy) continue;
        closestPointOnTriangle(p, t.a, t.b, t.c, _cp);
        const dx = p.x - _cp.x, dy = p.y - _cp.y, dz = p.z - _cp.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= r || d < 1e-6) continue;
        const push = (r - d) / d;
        p.x += dx * push; p.y += dy * push; p.z += dz * push;
        moved = true;
      }
      if (!moved) break;
    }
  }
}

function enter(world, from) {
  const { app, rig, camera, collider, walker } = world;
  const flyer = new Flyer(rig, camera, collider);

  // Take off from wherever the last view was: the previous game's, or the
  // walker standing on the spawn.
  const v = from ?? { x: walker.pos.x, y: walker.pos.y + walker.eyeHeight, z: walker.pos.z, yaw: walker.yaw, pitch: walker.pitch };
  flyer.pos.set(v.x, v.y, v.z);
  flyer.yaw = v.yaw;
  flyer.pitch = v.pitch;

  const input = { forward: 0, strafe: 0, rise: 0, fast: false };

  function pollKeyboard() {
    const k = app.keyboard;
    input.forward = (k.isPressed(pc.KEY_W) || k.isPressed(pc.KEY_UP) ? 1 : 0) - (k.isPressed(pc.KEY_S) || k.isPressed(pc.KEY_DOWN) ? 1 : 0);
    input.strafe = (k.isPressed(pc.KEY_D) || k.isPressed(pc.KEY_RIGHT) ? 1 : 0) - (k.isPressed(pc.KEY_A) || k.isPressed(pc.KEY_LEFT) ? 1 : 0);
    input.rise = (k.isPressed(pc.KEY_SPACE) ? 1 : 0) - (k.isPressed(pc.KEY_C) ? 1 : 0);
    input.fast = k.isPressed(pc.KEY_SHIFT);
  }

  return {
    body: flyer,
    flyer,

    view() { return { x: flyer.pos.x, y: flyer.pos.y, z: flyer.pos.z, yaw: flyer.yaw, pitch: flyer.pitch }; },

    look(dx, dy) { flyer.addLook(dx, dy, 0.12); },

    update(dt, live) {
      if (live) pollKeyboard();
      else { input.forward = 0; input.strafe = 0; input.rise = 0; input.fast = false; }
      flyer.update(dt, input);
    },

    exit() { /* nothing of its own on stage: the rig goes back to whoever enters next */ },
  };
}
