// The shooter's targets: red dummies scattered on the floor samples.
//
// Game content, not world: they exist while the shooter is being played and
// are gone when it is left (see ./index.mjs).
import { Vec3, Entity } from 'playcanvas';
import { standard, raySphere } from '../../world.mjs';

// `onScore(n)` is injected so this stays UI-agnostic: the mode wires it to
// the DOM scoreboard.
export class TargetManager {
  constructor(app, collider, spots, onScore = () => {}, opts = {}) {
    this.app = app;
    this.collider = collider;
    this.spots = spots;
    this.onScore = onScore;
    this.list = [];
    this.bodyMat = standard(0.85, 0.12, 0.1, [0.45, 0.04, 0.03]);
    this.headMat = standard(0.95, 0.8, 0.2, [0.5, 0.4, 0.05]);
    this.count = Math.min(opts.max ?? 10, spots.length);
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
    this.onScore(100);
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

  // Leaving the shooter takes its dummies with it.
  destroy() {
    for (const t of this.list) t.entity.destroy();
    this.list = [];
  }
}
