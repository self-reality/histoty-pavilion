// Negative spaces — convex volumes subtracted from the map.
//
// Authored in Blender exactly like a prop, and exported the same way: a
// primitive placed in the NEG collection becomes one entry in
// scene.placements.json. The only difference is which field it carries, and
// which direction it works in —
//
//   { "name": "tent_01",     "glb":   "./assets/tent_military.glb", ... }  adds
//   { "name": "neg_door_01", "shape": "box",                        ... }  takes away
//
// so `pos`/`rot`/`scale` mean what they mean everywhere else and moving a
// cutter is the same one-line diff as moving a crate.
//
// The map GLB is never touched: nothing is baked, nothing is re-exported. The
// subtraction happens at load, on the triangle soup extractTriangles() hands
// over, before TriangleCollider is built — so a carved doorway is a doorway to
// the capsule, to every raycast, and to the debug normals overlay.
//
// It is not yet a doorway to the camera. The render mesh still holds its
// geometry, so a wall you can walk through still looks solid; carving the
// render side is the second half of the feature. Until then a negative is
// paired with a prop that covers the opening — which is the usual arrangement
// anyway, since a negative only ever removes (see BLENDER_SCENE.md).
import { Mat4, Quat, Vec3 } from 'playcanvas';

// ---- Unit shapes -----------------------------------------------------------
// Local-space geometry of each cutter, sized to match the Blender primitive it
// stands for: `Add > Mesh > Cube` is 2 m across (±1) and `Add > Mesh >
// Cylinder` is radius 1, depth 2. A cutter left at scale 1 in Blender is
// therefore the same volume here, and the numbers on the N-panel are the
// numbers that ship.
//
// Faces are wound counter-clockwise seen from OUTSIDE, so the cross product of
// their first two edges points out of the volume. Everything below depends on
// that: a point is inside when `n·p + d <= 0` for every face.

const BOX = {
  verts: [
    -1, -1, -1,    1, -1, -1,    1, 1, -1,   -1, 1, -1,   // z = -1
    -1, -1,  1,    1, -1,  1,    1, 1,  1,   -1, 1,  1,   // z = +1
  ],
  faces: [
    [0, 3, 2, 1], [4, 5, 6, 7],   // -Z, +Z
    [0, 1, 5, 4], [3, 7, 6, 2],   // -Y, +Y
    [0, 4, 7, 3], [1, 2, 6, 5],   // -X, +X
  ],
};

// A prism on the local Z axis, inscribed in the unit circle — the same flat
// sides Blender's cylinder has, so the planes here and the mesh you booleaned
// against in the viewport enclose the same volume. Only the ring's phase can
// differ, which at the default 32 sides moves a wall by half a degree of arc.
function cylinderShape(sides) {
  const verts = [];
  for (const z of [-1, 1]) {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      verts.push(Math.cos(a), Math.sin(a), z);
    }
  }
  const faces = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    faces.push([i, j, sides + j, sides + i]);
  }
  const ring = [...Array(sides).keys()];
  faces.push([...ring].reverse());              // -Z cap
  faces.push(ring.map((i) => sides + i));       // +Z cap
  return { verts, faces };
}

function shapeOf(entry) {
  const kind = entry.shape ?? 'box';
  if (kind === 'box') return BOX;
  if (kind === 'cylinder') return cylinderShape(Math.max(3, Math.round(entry.sides ?? 32)));
  return null;
}

// ---- Entry -> volume -------------------------------------------------------

const _e1 = new Vec3(), _e2 = new Vec3();

function matrixOf(entry) {
  const [px, py, pz] = entry.pos ?? [0, 0, 0];
  const [sx, sy, sz] = entry.scale ?? [1, 1, 1];
  const q = new Quat();
  // Blender-authored entries carry an exact quaternion; hand-written ones use
  // euler degrees. Same precedence as a prop placement — see loadProp().
  if (entry.rot) q.set(entry.rot[0], entry.rot[1], entry.rot[2], entry.rot[3]);
  else if (entry.euler) q.setFromEulerAngles(entry.euler[0], entry.euler[1], entry.euler[2]);
  return new Mat4().setTRS(new Vec3(px, py, pz), q, new Vec3(sx, sy, sz));
}

/**
 * One placement entry -> `{ name, planes, min, max }`, or null if it cannot be
 * made into a volume. Rejecting is the safe direction: a volume whose normals
 * came out inward means "everything except this box", and applying one would
 * delete the level.
 */
export function volumeFrom(entry) {
  const name = entry.name ?? '(unnamed)';
  const shape = shapeOf(entry);
  if (!shape) {
    console.warn(`[negatives] ${name}: unknown shape "${entry.shape}" — skipped`);
    return null;
  }

  const m = matrixOf(entry);
  const verts = [];
  for (let i = 0; i < shape.verts.length; i += 3) {
    const v = new Vec3(shape.verts[i], shape.verts[i + 1], shape.verts[i + 2]);
    m.transformPoint(v, v);
    verts.push(v);
  }

  const planes = [];
  for (const f of shape.faces) {
    const a = verts[f[0]];
    _e1.sub2(verts[f[1]], a);
    _e2.sub2(verts[f[2]], a);
    const n = new Vec3().cross(_e1, _e2);
    const len = n.length();
    if (len < 1e-12) {
      console.warn(`[negatives] ${name}: a face collapsed — zero scale on an axis? — skipped`);
      return null;
    }
    n.mulScalar(1 / len);
    planes.push([n.x, n.y, n.z, -n.dot(a)]);
  }

  // The volume's own centre must be inside every one of its faces. It is one
  // line and it catches the case that matters: a mirrored cutter (negative
  // scale) reverses the winding, every normal turns inward, and the volume
  // silently becomes the whole world minus the box.
  const c = new Vec3();
  for (const v of verts) c.add(v);
  c.mulScalar(1 / verts.length);
  for (const p of planes) {
    if (p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] > -1e-9) {
      console.warn(`[negatives] ${name}: normals point inward — mirrored (negative scale)? — skipped`);
      return null;
    }
  }

  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  for (const v of verts) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }

  return { name, planes, min, max, hits: 0 };
}

/** Every entry that made it into a usable volume, in order. */
export function collectVolumes(entries) {
  const out = [];
  for (const entry of entries ?? []) {
    const volume = volumeFrom(entry);
    if (volume) out.push(volume);
  }
  return out;
}

// ---- Clipping --------------------------------------------------------------
// A point within ON of a plane counts as on it. Metres, so this is a micron —
// small enough never to move a wall, large enough that a vertex lying exactly
// in a cutter's face does not produce a zero-area sliver on both sides of it.
const ON = 1e-6;

/**
 * Split a convex polygon by one plane: the part in front (outside, `n·p + d >
 * 0`) into `front`, the part behind into `back`. A polygon entirely on one
 * side is passed through untouched rather than rebuilt, which is the common
 * case by far.
 */
function splitPolygon(poly, pl, front, back) {
  const n = poly.length;
  const dist = new Array(n);
  let nf = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const d = pl[0] * p.x + pl[1] * p.y + pl[2] * p.z + pl[3];
    dist[i] = d;
    if (d > ON) nf++; else if (d < -ON) nb++;
  }
  if (!nf) { back.push(poly); return; }
  if (!nb) { front.push(poly); return; }

  const f = [], b = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const di = dist[i], dj = dist[j];
    if (di >= -ON) f.push(poly[i]);
    if (di <= ON) b.push(poly[i]);
    if ((di > ON && dj < -ON) || (di < -ON && dj > ON)) {
      const cut = new Vec3().lerp(poly[i], poly[j], di / (di - dj));
      f.push(cut); b.push(cut);
    }
  }
  if (f.length >= 3) front.push(f);
  if (b.length >= 3) back.push(b);
}

/**
 * Subtract one volume from a set of convex polygons.
 *
 * Plane by plane: whatever falls in front of a face is outside the volume for
 * good — no later face can put it back — so it is banked immediately into
 * `outside` and never touched again. Only the part still behind every face so
 * far carries on. What survives the last face is inside the volume, and that
 * is what the caller throws away.
 *
 * Banking early is what keeps the fragment count down: a doorway punched
 * through a wall quad comes out as the four pieces around the opening, not as
 * every piece six clipping passes could produce.
 */
function subtractVolume(polys, planes, outside) {
  let inside = polys;
  for (let k = 0; k < planes.length && inside.length; k++) {
    const next = [];
    for (const poly of inside) splitPolygon(poly, planes[k], outside, next);
    inside = next;
  }
  return inside;
}

// Triangle AABB vs volume AABB. The whole point of the broadphase: a map
// triangle nowhere near a cutter costs six comparisons and is passed through
// by reference, so carving stays proportional to what the cutters touch.
function overlaps(t, v) {
  const { a, b, c } = t;
  if (Math.min(a.x, b.x, c.x) > v.max.x || Math.max(a.x, b.x, c.x) < v.min.x) return false;
  if (Math.min(a.y, b.y, c.y) > v.max.y || Math.max(a.y, b.y, c.y) < v.min.y) return false;
  if (Math.min(a.z, b.z, c.z) > v.max.z || Math.max(a.z, b.z, c.z) < v.min.z) return false;
  return true;
}

// Fan-triangulate a convex polygon back into the soup, inheriting everything
// the source triangle carried. The normal is inherited rather than recomputed:
// every piece is coplanar with its parent by construction, and a sliver's own
// cross product is mostly rounding error.
function fanInto(out, poly, src) {
  for (let i = 2; i < poly.length; i++) {
    const a = poly[0], b = poly[i - 1], c = poly[i];
    _e1.sub2(b, a);
    _e2.sub2(c, a);
    if (_e1.cross(_e1, _e2).length() < 1e-9) continue;   // zero-area sliver
    out.push({ ...src, a, b, c });
  }
}

/**
 * Subtract every volume from a triangle soup, returning a new soup.
 *
 * Triangles no cutter reaches come through by reference, so with no negatives
 * authored this is the identity and costs one array copy. Each volume counts
 * the source triangles it actually removed material from into `volume.hits`,
 * which is how a cutter placed somewhere with no geometry in it — a typo, or a
 * prop that has since moved — announces itself instead of silently doing
 * nothing.
 */
export function carve(tris, volumes) {
  if (!volumes || !volumes.length) return tris;
  for (const v of volumes) v.hits = 0;

  const out = [];
  for (const t of tris) {
    let polys = null;   // built only once a volume is known to be in range
    for (const v of volumes) {
      if (!overlaps(t, v)) continue;
      polys = polys ?? [[t.a, t.b, t.c]];
      const kept = [];
      if (subtractVolume(polys, v.planes, kept).length) v.hits++;
      polys = kept;
      if (!polys.length) break;
    }
    if (!polys) { out.push(t); continue; }
    for (const poly of polys) fanInto(out, poly, t);
  }
  return out;
}
