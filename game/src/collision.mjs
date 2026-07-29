import { Vec3 } from 'playcanvas';

// Scratch vectors reused across the hot paths to avoid per-frame allocation.
const _ab = new Vec3(), _ac = new Vec3(), _ap = new Vec3(), _bp = new Vec3(), _cp = new Vec3();
const _e1 = new Vec3(), _e2 = new Vec3(), _h = new Vec3(), _s = new Vec3(), _q = new Vec3();
const _probeOrig = new Vec3(), _DOWN = new Vec3(0, -1, 0);

/**
 * Closest point on triangle (a,b,c) to point p. Writes result into `out`.
 * Christer Ericson, Real-Time Collision Detection.
 */
export function closestPointOnTriangle(p, a, b, c, out) {
  _ab.sub2(b, a);
  _ac.sub2(c, a);
  _ap.sub2(p, a);
  const d1 = _ab.dot(_ap);
  const d2 = _ac.dot(_ap);
  if (d1 <= 0 && d2 <= 0) { out.copy(a); return out; }

  _bp.sub2(p, b);
  const d3 = _ab.dot(_bp);
  const d4 = _ac.dot(_bp);
  if (d3 >= 0 && d4 <= d3) { out.copy(b); return out; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.copy(a).add(_ab.mulScalar(v));
    return out;
  }

  _cp.sub2(p, c);
  const d5 = _ab.dot(_cp);
  const d6 = _ac.dot(_cp);
  if (d6 >= 0 && d5 <= d6) { out.copy(c); return out; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.copy(a).add(_ac.mulScalar(w));
    return out;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    // out = b + w*(c - b)
    out.sub2(c, b).mulScalar(w).add(b);
    return out;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  // out = a + ab*v + ac*w
  out.copy(a);
  _ab.mulScalar(v); out.add(_ab);
  _ac.mulScalar(w); out.add(_ac);
  return out;
}

const EPS = 1e-7;

/**
 * Möller–Trumbore ray/triangle. Returns t (distance) along `dir` (unit) or -1.
 * Double-sided so we hit interior walls regardless of winding.
 *
 * Exported for tests/raycast.mjs, which checks the grid broadphase against a
 * sweep of every triangle using this same primitive — so a mismatch can only
 * mean the broadphase dropped a candidate.
 */
export function rayTriangle(orig, dir, a, b, c) {
  _e1.sub2(b, a);
  _e2.sub2(c, a);
  _h.cross(dir, _e2);
  const det = _e1.dot(_h);
  if (det > -EPS && det < EPS) return -1; // parallel
  const invDet = 1 / det;
  _s.sub2(orig, a);
  const u = invDet * _s.dot(_h);
  if (u < 0 || u > 1) return -1;
  _q.cross(_s, _e1);
  const v = invDet * dir.dot(_q);
  if (v < 0 || u + v > 1) return -1;
  const t = invDet * _e2.dot(_q);
  return t > EPS ? t : -1;
}

/**
 * Static triangle-soup collider with a uniform XZ grid broadphase.
 * Triangles are stored in world space.
 */
export class TriangleCollider {
  constructor(triangles, cellSize = 2.0) {
    this.tris = triangles; // [{ a,b,c: Vec3, n: Vec3, minx,miny,minz,maxx,maxy,maxz }]
    this.cell = cellSize;
    this._stamp = 0;

    let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
    let miny = Infinity, maxy = -Infinity;
    for (const t of triangles) {
      t.minx = Math.min(t.a.x, t.b.x, t.c.x);
      t.maxx = Math.max(t.a.x, t.b.x, t.c.x);
      t.miny = Math.min(t.a.y, t.b.y, t.c.y);
      t.maxy = Math.max(t.a.y, t.b.y, t.c.y);
      t.minz = Math.min(t.a.z, t.b.z, t.c.z);
      t.maxz = Math.max(t.a.z, t.b.z, t.c.z);
      t._stamp = 0;
      minx = Math.min(minx, t.minx); maxx = Math.max(maxx, t.maxx);
      minz = Math.min(minz, t.minz); maxz = Math.max(maxz, t.maxz);
      miny = Math.min(miny, t.miny); maxy = Math.max(maxy, t.maxy);
    }
    this.bounds = { minx, minz, maxx, maxz, miny, maxy };
    this.cols = Math.max(1, Math.ceil((maxx - minx) / this.cell) + 1);
    this.rows = Math.max(1, Math.ceil((maxz - minz) / this.cell) + 1);
    this.grid = new Array(this.cols * this.rows);

    for (const t of triangles) {
      const ix0 = this._cx(t.minx), ix1 = this._cx(t.maxx);
      const iz0 = this._cz(t.minz), iz1 = this._cz(t.maxz);
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = iz * this.cols + ix;
          (this.grid[k] || (this.grid[k] = [])).push(t);
        }
      }
    }
  }

  _cx(x) { return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.bounds.minx) / this.cell))); }
  _cz(z) { return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.bounds.minz) / this.cell))); }

  /**
   * Collect unique candidate triangles overlapping the XZ AABB into `out` (cleared first).
   */
  query(minx, minz, maxx, maxz, out) {
    out.length = 0;
    const stamp = ++this._stamp;
    const ix0 = this._cx(minx), ix1 = this._cx(maxx);
    const iz0 = this._cz(minz), iz1 = this._cz(maxz);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const bucket = this.grid[iz * this.cols + ix];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const t = bucket[i];
          if (t._stamp !== stamp) { t._stamp = stamp; out.push(t); }
        }
      }
    }
    return out;
  }

  /**
   * Highest surface directly below (x, z), searching straight down from `topY`
   * for up to `maxDist`. Grid-accelerated (only the triangles in that XZ cell),
   * so it's cheap enough to call several times per frame for ground-snapping.
   * Returns { y, ny } (ny = surface normal.y) or null.
   */
  groundBelow(x, z, topY, maxDist) {
    const cand = this._probeCand || (this._probeCand = []);
    this.query(x, z, x, z, cand);
    _probeOrig.set(x, topY, z);
    let best = maxDist, ny = 0, found = false;
    for (let i = 0; i < cand.length; i++) {
      const t = cand[i];
      const d = rayTriangle(_probeOrig, _DOWN, t.a, t.b, t.c);
      if (d > 0 && d < best) { best = d; ny = t.n.y; found = true; }
    }
    return found ? { y: topY - best, ny } : null;
  }

  /**
   * Raycast (shooting, spawn probes, floor sampling).
   *
   * Walks the same XZ grid the capsule resolve uses — Amanatides & Woo's DDA —
   * instead of sweeping every triangle. Cells are visited in order of increasing
   * distance, so the walk can stop as soon as the next cell begins beyond the
   * best hit so far: a triangle not yet tested has its whole XZ footprint in
   * cells further along the ray (bucketing is by AABB overlap, so a triangle
   * reaching back into an earlier cell would already have been tested there),
   * and therefore cannot be closer.
   *
   * Returns { point: Vec3, normal: Vec3, dist, tri } or null.
   */
  raycast(origin, dir, maxDist = 1e6) {
    const b = this.bounds, cs = this.cell;
    const stamp = ++this._stamp;
    let best = maxDist, hit = null;

    const sweep = (bucket) => {
      if (!bucket) return;
      for (let i = 0; i < bucket.length; i++) {
        const t = bucket[i];
        if (t._stamp === stamp) continue;   // spans several cells — test it once
        t._stamp = stamp;
        const d = rayTriangle(origin, dir, t.a, t.b, t.c);
        if (d > 0 && d < best) { best = d; hit = t; }
      }
    };

    if (origin.x < b.minx || origin.x > b.maxx || origin.z < b.minz || origin.z > b.maxz) {
      // Origin sits off the grid's XZ footprint, so there is no cell to start
      // the walk from. Nothing in game does this (the camera and every probe
      // start inside the level), so take the honestly slow path rather than a
      // subtly wrong fast one.
      sweep(this.tris);
    } else {
      let ix = this._cx(origin.x), iz = this._cz(origin.z);
      const dx = dir.x, dz = dir.z;
      if (Math.abs(dx) < 1e-12 && Math.abs(dz) < 1e-12) {
        sweep(this.grid[iz * this.cols + ix]);   // straight up/down — one column
      } else {
        const stepX = dx >= 0 ? 1 : -1, stepZ = dz >= 0 ? 1 : -1;
        // Distance along the ray to the next cell boundary on each axis, then
        // the constant distance between successive boundaries.
        const bx = b.minx + (ix + (dx >= 0 ? 1 : 0)) * cs;
        const bz = b.minz + (iz + (dz >= 0 ? 1 : 0)) * cs;
        let tMaxX = dx !== 0 ? (bx - origin.x) / dx : Infinity;
        let tMaxZ = dz !== 0 ? (bz - origin.z) / dz : Infinity;
        const tDeltaX = dx !== 0 ? Math.abs(cs / dx) : Infinity;
        const tDeltaZ = dz !== 0 ? Math.abs(cs / dz) : Infinity;
        for (;;) {
          sweep(this.grid[iz * this.cols + ix]);
          const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
          if (tNext >= best) break;          // `best` starts at maxDist, so this
                                             // ends the walk at range too
          if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDeltaX; }
          else { iz += stepZ; tMaxZ += tDeltaZ; }
          if (ix < 0 || ix >= this.cols || iz < 0 || iz >= this.rows) break;
        }
      }
    }

    if (!hit) return null;
    const point = new Vec3().copy(dir).mulScalar(best).add(origin);
    const normal = new Vec3().copy(hit.n);
    if (normal.dot(dir) > 0) normal.mulScalar(-1); // face the ray
    return { point, normal, dist: best, tri: hit };
  }
}
