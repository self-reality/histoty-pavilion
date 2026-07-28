// Shared, engine-light world helpers used by BOTH entry points:
//   • standalone/main.mjs (engine-only build served from index.html)
//   • src/game.mjs        (PlayCanvas Editor script component)
//
// Nothing here creates a pc.Application or touches the DOM, so it is safe to
// sync to the Editor as a script asset and safe to import from the standalone
// bootstrap. Keep it that way — DOM/HUD lives in ui.mjs, app lifecycle in the
// two entry points.
import { Vec3, Color, Entity, StandardMaterial } from 'playcanvas';

// ---- Materials -------------------------------------------------------------
export function standard(r, g, b, emissive) {
  const m = new StandardMaterial();
  m.diffuse = new Color(r, g, b);
  m.useMetalness = true; m.metalness = 0; m.gloss = 0.25;
  if (emissive) m.emissive = new Color(emissive[0], emissive[1], emissive[2]);
  m.update();
  return m;
}

// ---- Ray vs sphere ---------------------------------------------------------
export function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : -1;
}

// ---- Targets ---------------------------------------------------------------
// Red dummies scattered on the floor samples. `onScore(n)` is injected so this
// stays UI-agnostic: the standalone build wires it to the DOM scoreboard, the
// Editor build to its own HUD.
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
}

// ---- Triangle extraction (world space) ------------------------------------
// Pulls a triangle soup out of a loaded/instantiated render hierarchy, already
// baked into world space, ready to feed TriangleCollider.
export function extractTriangles(rootEntity) {
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

// ---- Find walkable floor samples + a spawn --------------------------------
export function findFloors(collider) {
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

export function pickSpawn(samples, bounds) {
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
