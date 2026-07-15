import { Vec3 } from 'playcanvas';
import { closestPointOnTriangle } from './collision.mjs';

const _sphere = new Vec3();
const _cp = new Vec3();
const _n = new Vec3();
const RAD2DEG = 180 / Math.PI;

// Ground-snap probe offsets (× radius): centre + a ring, so a hairline crack
// under the centre is still bridged by the surrounding probes.
const _PROBES = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7, 0.7], [0.7, -0.7], [-0.7, 0.7], [-0.7, -0.7],
];

/**
 * Kinematic first-person controller.
 * Player is a vertical capsule resolved against a static TriangleCollider via
 * sphere-discretised depenetration (collide-and-slide) plus explicit stair stepping.
 */
export class Player {
  constructor(rootEntity, cameraEntity, collider, opts = {}) {
    this.entity = rootEntity;     // holds yaw (rotation about Y)
    this.camera = cameraEntity;   // child: holds pitch + sits at eye height
    this.collider = collider;

    this.radius = opts.radius ?? 0.42;
    this.height = opts.height ?? 1.8;
    this.eyeHeight = opts.eyeHeight ?? 1.62;
    this.stepHeight = opts.stepHeight ?? 0.5;
    this.walkSpeed = opts.walkSpeed ?? 6.5;
    this.runSpeed = opts.runSpeed ?? 9.6;
    this.gravity = opts.gravity ?? 22;
    this.jumpSpeed = opts.jumpSpeed ?? 8.1;
    this.accel = opts.accel ?? 14;          // ground responsiveness
    this.airAccel = opts.airAccel ?? 4;
    // View smoothing: how fast the rendered eye catches up to the feet (1/s).
    // Kills the per-frame vertical jitter that depenetration / ground-snap inject
    // while walking the uneven map, without touching the physics feet position.
    // Lower = smoother but floatier over real steps; the eyeMaxLag clamp keeps the
    // worst-case trailing honest either way. 10 (τ ≈ 100 ms) leaves only ~5 mm of
    // residual eye chatter on the ripped floor vs ~7 mm at 16, ~80 % fewer visible
    // reversals — the shimmer you'd otherwise catch while moving + looking.
    this.eyeSmooth = opts.eyeSmooth ?? 10;  // τ ≈ 100 ms
    this.eyeMaxLag = opts.eyeMaxLag ?? 0.4; // never trail the feet by more than this (m)

    // Capsule sample spheres (offsets along +Y from the feet point).
    const n = 4;
    this.offY = [];
    const lo = this.radius, hi = this.height - this.radius;
    for (let i = 0; i < n; i++) this.offY.push(lo + (hi - lo) * (i / (n - 1)));
    this.r2 = this.radius * this.radius;

    this.pos = new Vec3();        // feet position (authoritative)
    this.vel = new Vec3();        // velocity (horizontal smoothed + vertical)
    this.yaw = 0;                 // degrees
    this.pitch = 0;               // degrees
    this.grounded = false;
    this.camEyeY = null;          // smoothed WORLD eye height (null → snap on first frame)
    this._airTime = 0;            // continuous seconds off the ground (coyote for the eye)

    this._cand = [];              // scratch candidate triangle list
    this.camera.setLocalPosition(0, this.eyeHeight, 0);
  }

  teleport(x, y, z) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.grounded = false;
    this._airTime = 0;
    this.camEyeY = y + this.eyeHeight;  // snap the view — no glide after teleport/respawn
  }

  /** Live-tweak the capsule radius (recomputes sample-sphere offsets). */
  setRadius(r) {
    this.radius = r;
    this.r2 = r * r;
    const n = this.offY.length;
    const lo = r, hi = this.height - r;
    for (let i = 0; i < n; i++) this.offY[i] = lo + (hi - lo) * (i / (n - 1));
  }

  addLook(dx, dy, sensitivity) {
    this.yaw -= dx * sensitivity;
    this.pitch -= dy * sensitivity;
    if (this.pitch > 89) this.pitch = 89;
    if (this.pitch < -89) this.pitch = -89;
  }

  /** Resolve capsule out of nearby geometry. Returns the strongest up/down contact y. */
  _depenetrate(pos, iters = 5) {
    let groundY = 0, ceilY = 0, hit = false;
    const r = this.radius, r2 = this.r2;
    for (let it = 0; it < iters; it++) {
      this.collider.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, this._cand);
      const cand = this._cand;
      let moved = false;
      for (let si = 0; si < this.offY.length; si++) {
        const cy = pos.y + this.offY[si];
        for (let ti = 0; ti < cand.length; ti++) {
          const t = cand[ti];
          // cheap AABB reject: sphere vs tri bounds on all three axes. A tri whose
          // y-range can't reach [cy±r] can't have a closest point within r, so the
          // skip is exact — it changes nothing, just avoids the closest-point test.
          if (pos.x + r < t.minx || pos.x - r > t.maxx) continue;
          if (pos.z + r < t.minz || pos.z - r > t.maxz) continue;
          if (cy + r < t.miny || cy - r > t.maxy) continue;
          _sphere.set(pos.x, cy, pos.z);
          closestPointOnTriangle(_sphere, t.a, t.b, t.c, _cp);
          const dx = _sphere.x - _cp.x, dy = _sphere.y - _cp.y, dz = _sphere.z - _cp.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2 - 1e-9) {
            const d = Math.sqrt(d2);
            if (d > 1e-6) _n.set(dx / d, dy / d, dz / d);
            else _n.copy(t.n);
            const push = r - d;
            pos.x += _n.x * push;
            pos.y += _n.y * push;
            pos.z += _n.z * push;
            moved = true; hit = true;
            if (_n.y > groundY) groundY = _n.y;
            if (_n.y < ceilY) ceilY = _n.y;
          }
        }
      }
      if (!moved) break;
    }
    return { hit, groundY, ceilY };
  }

  _moveHorizontal(pos, dx, dz) {
    pos.x += dx; pos.z += dz;
    this._depenetrate(pos, 5);
  }

  /**
   * Ground-glue: probe straight down from several points under the capsule and
   * snap the feet onto the highest floor found within step height. This keeps a
   * moving capsule stuck to the floor across hairline seams / gaps in the ripped
   * map (where the sphere depenetration alone lets it slip through) and follows
   * small steps down. A real drop taller than a step finds no floor → no snap.
   */
  _groundSnap() {
    const r = this.radius;
    const topY = this.pos.y + r;                    // start rays inside the capsule bottom
    const maxDist = r + this.stepHeight + 0.05;
    let bestY = -Infinity;
    for (let i = 0; i < _PROBES.length; i++) {
      const hit = this.collider.groundBelow(
        this.pos.x + _PROBES[i][0] * r, this.pos.z + _PROBES[i][1] * r, topY, maxDist);
      if (hit && Math.abs(hit.ny) > 0.5 && hit.y > bestY) bestY = hit.y;
    }
    if (bestY === -Infinity) return false;
    // Follow floor down to a full step below the feet, but only nudge *up* a hair
    // (recover a one-frame dip) — a bigger up-snap would pop the camera at slope
    // and geometry junctions.
    if (bestY >= this.pos.y - this.stepHeight && bestY <= this.pos.y + 0.06) {
      this.pos.y = bestY;
      return true;
    }
    return false;
  }

  /**
   * Land the lifted capsule onto the highest step within reach: probe straight
   * down under the capsule (the same ring as ground-snap) and drop the feet onto
   * the tallest floor-like surface that is no more than `maxUp` above the feet we
   * started the step from (`baseY`). Unlike teleport-down-then-depenetrate, this
   * can't overshoot and shove the capsule *under* a step, so the climbable height
   * follows `stepHeight` (instead of being capped near the capsule radius); and
   * the `baseY + maxUp` ceiling keeps it an honest limit (the rounded capsule
   * bottom would otherwise clear steps ~radius taller than the slider says).
   * Returns true if it found footing.
   */
  _dropToStep(pos, baseY, maxUp) {
    const r = this.radius;
    const topY = pos.y + r;                 // start rays inside the capsule bottom
    const maxDist = r + maxUp + 0.06;
    const ceil = baseY + maxUp + 1e-3;      // never mount a step taller than the climb height
    let bestY = -Infinity;
    for (let i = 0; i < _PROBES.length; i++) {
      const hit = this.collider.groundBelow(
        pos.x + _PROBES[i][0] * r, pos.z + _PROBES[i][1] * r, topY, maxDist);
      if (hit && Math.abs(hit.ny) > 0.5 && hit.y <= ceil && hit.y > bestY) bestY = hit.y;
    }
    if (bestY === -Infinity) return false;
    pos.y = bestY;
    this._depenetrate(pos, 5);              // resolve horizontally against the riser
    return true;
  }

  _horizontalWithStep(startX, startZ, dx, dz) {
    // Flat slide at current height.
    const flat = new Vec3(startX, this.pos.y, startZ);
    this._moveHorizontal(flat, dx, dz);
    if (!this.grounded) { this.pos.x = flat.x; this.pos.y = flat.y; this.pos.z = flat.z; return; }

    // Stepped attempt: lift, slide, drop back down onto the step.
    const stepped = new Vec3(startX, this.pos.y + this.stepHeight, startZ);
    this._depenetrate(stepped, 3);
    this._moveHorizontal(stepped, dx, dz);
    const landed = this._dropToStep(stepped, this.pos.y, this.stepHeight);

    const flatProg = (flat.x - startX) ** 2 + (flat.z - startZ) ** 2;
    const stepProg = (stepped.x - startX) ** 2 + (stepped.z - startZ) ** 2;
    if (landed && stepProg > flatProg + 1e-4) {
      this.pos.copy(stepped);
    } else {
      this.pos.copy(flat);
    }
  }

  update(dt, input) {
    // Orient root by yaw so .forward/.right reflect look direction (horizontal only).
    this.entity.setEulerAngles(0, this.yaw, 0);
    const fwd = this.entity.forward;
    const right = this.entity.right;

    // Desired horizontal direction from input.
    let wx = fwd.x * input.forward + right.x * input.strafe;
    let wz = fwd.z * input.forward + right.z * input.strafe;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; } else { wx = 0; wz = 0; }
    const speed = input.sprint ? this.runSpeed : this.walkSpeed;
    const targetVx = wx * speed, targetVz = wz * speed;

    // Smooth horizontal velocity toward target (ground vs air control).
    const a = (this.grounded ? this.accel : this.airAccel) * dt;
    const k = a > 1 ? 1 : a;
    this.vel.x += (targetVx - this.vel.x) * k;
    this.vel.z += (targetVz - this.vel.z) * k;

    // Gravity + jump.
    this.vel.y -= this.gravity * dt;
    const wasGrounded = this.grounded;
    const doJump = input.jump && wasGrounded;
    if (doJump) { this.vel.y = this.jumpSpeed; this.grounded = false; }

    // Standing still on static ground, the per-frame gravity dip + depenetration
    // push-back make the feet (and camera) oscillate by a few cm. Detect that
    // resting state and hold the feet exactly put — no visible bob. Any real
    // motion (walking, jumping, falling) drops back to the full resolve below.
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    const restingStill = wasGrounded && !doJump && horizSpeed < 0.15 && this.vel.y <= 0 && this.vel.y > -2;

    // Horizontal move (with stair stepping when grounded).
    const startY = this.pos.y;
    const sx = this.pos.x, sz = this.pos.z;
    this._horizontalWithStep(sx, sz, this.vel.x * dt, this.vel.z * dt);

    if (restingStill) {
      this.pos.y = startY;   // keep the standing height rock-steady
      this.vel.y = 0;
      this.grounded = true;
    } else {
      // Vertical move.
      this.pos.y += this.vel.y * dt;
      const vres = this._depenetrate(this.pos, 5);
      if (vres.groundY > 0.5 && this.vel.y <= 0) {
        this.grounded = true; this.vel.y = 0;
      } else if (vres.ceilY < -0.5 && this.vel.y > 0) {
        this.vel.y = 0; this.grounded = false;
      } else {
        this.grounded = false;
      }

      // Ground-glue: a rescue for when the normal resolve *lost* the ground this
      // frame — a hairline seam/gap or a small step the capsule would otherwise
      // slip through. Probe down and snap onto any floor within step height. It
      // only fires on the frames you'd fall (not every frame), so it can't jitter
      // solid ground; a real drop taller than a step finds nothing and you fall.
      if (wasGrounded && !doJump && !this.grounded && this.vel.y <= 0) {
        if (this._groundSnap()) { this.grounded = true; this.vel.y = 0; }
      }
    }

    // Commit the feet transform (authoritative — collision & anti-fall use this).
    this.entity.setPosition(this.pos.x, this.pos.y, this.pos.z);

    // Smooth the *rendered* eye height so the small vertical corrections the
    // anti-fall resolve makes each frame (depenetration push-back, ground-snap
    // ring-max, step pick) don't reach the camera as shake. The feet themselves
    // are untouched, so nothing about collision or the anti-fall behaviour
    // changes — this is a view-only low-pass on the eye's world Y.
    // Track continuous air time. Walking the ripped map, the resolve drops
    // `grounded` for a stray frame or two (a seam the depenetration misses, then
    // ground-snap rescues) — that is collision noise, not real air, and it lands on
    // exactly the frames with the biggest feet correction. Gating the smoother on
    // `grounded` alone let those pops through raw (the eye snapped to the feet),
    // which read as jitter while moving + looking. So keep smoothing through brief
    // ground loss (coyote) and switch to exact tracking only for genuine air: a
    // jump, a clear upward launch, or a sustained fall.
    if (this.grounded) this._airTime = 0;
    else this._airTime += dt;
    const realAir = doJump || this.vel.y > 0.5 || this._airTime > 0.12;

    const targetEyeY = this.pos.y + this.eyeHeight;
    if (this.camEyeY === null) this.camEyeY = targetEyeY;
    if (!realAir) {
      // Grounded (incl. one-frame seam drops): ease toward the feet. Frame-rate
      // independent, and clamp the trailing distance so real step-ups / slopes stay
      // responsive (no float).
      const t = 1 - Math.exp(-dt * this.eyeSmooth);
      this.camEyeY += (targetEyeY - this.camEyeY) * t;
      const lag = targetEyeY - this.camEyeY;
      if (lag > this.eyeMaxLag) this.camEyeY = targetEyeY - this.eyeMaxLag;
      else if (lag < -this.eyeMaxLag) this.camEyeY = targetEyeY + this.eyeMaxLag;
    } else {
      // Airborne (jumping/falling): gravity integrates smoothly already, so track
      // the feet exactly — keeps the jump crisp and avoids a snap on landing.
      this.camEyeY = targetEyeY;
    }
    this.camera.setLocalPosition(0, this.camEyeY - this.pos.y, 0);
    this.camera.setLocalEulerAngles(this.pitch, 0, 0);
  }
}
