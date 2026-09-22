// Action areas — where an asset's action is on offer, as a volume it carries.
//
// An asset's script says what a player can set the object off to do, and how
// near "near" is: a radius, two metres unless it says otherwise (see
// ./script.mjs and section 6 of the kit's ASSET_CONTRACT.md). A radius is all
// an asset can say in numbers about a room it has never seen. What it can do
// is DRAW the answer: an `_act` mesh modelled with it — the terrace a dance is
// watched from, this side of the railing a lever is worked from — shipped in
// its package and copied into its script as `areas` (the kit's pack step). That
// mesh needs no placing here: it stands where the prop stands and moves when
// the prop moves. A prop that carries an area is offered ONLY inside it; the
// radius is what a prop without one gets.
//
// An area is any closed mesh, because all it is ever asked is "is this point
// inside?" — and a point is inside a closed surface if a ray out of it crosses
// the surface an odd number of times. Convex or not, one shell or several.
import { Mat4, Vec3 } from 'playcanvas';

const TAG = 'areas';
const _p = new Vec3();

// The ray a mesh area counts crossings along, in the area's own space. Any
// direction gives the same parity; this one is chosen to be aligned with
// nothing an author would model, because a ray that runs exactly along an
// edge or through a vertex is the one case where counting goes wrong.
const RAY = (() => { const v = new Vec3(0.5377, 0.7311, 0.4203); return v.normalize(); })();

function boundsOf(points) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const v of points) {
    box[0] = Math.min(box[0], v.x); box[1] = Math.min(box[1], v.y); box[2] = Math.min(box[2], v.z);
    box[3] = Math.max(box[3], v.x); box[4] = Math.max(box[4], v.y); box[5] = Math.max(box[5], v.z);
  }
  return box;
}

// Does the ray from (ox, oy, oz) along RAY cross triangle abc? Möller–Trumbore,
// keeping only what a parity count needs: a yes or a no, ahead of the origin.
function crosses(ox, oy, oz, v, ia, ib, ic) {
  const ax = v[ia], ay = v[ia + 1], az = v[ia + 2];
  const e1x = v[ib] - ax, e1y = v[ib + 1] - ay, e1z = v[ib + 2] - az;
  const e2x = v[ic] - ax, e2y = v[ic + 1] - ay, e2z = v[ic + 2] - az;
  const px = RAY.y * e2z - RAY.z * e2y, py = RAY.z * e2x - RAY.x * e2z, pz = RAY.x * e2y - RAY.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;               // edge-on: no crossing to count
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const w = (RAY.x * qx + RAY.y * qy + RAY.z * qz) * inv;
  if (w < 0 || u + w > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 0;
}

function meshArea(entry, name, m) {
  const verts = Float64Array.from(entry.verts ?? []);
  const tris = Uint32Array.from(entry.tris ?? []);
  const count = verts.length / 3;
  if (verts.length % 3 || tris.length % 3 || tris.length < 12) {
    console.warn(`[${TAG}] ${name}: a mesh area needs \`verts\` (x,y,z,…) and at least four \`tris\` — skipped`);
    return null;
  }
  if (tris.some((i) => i >= count)) {
    console.warn(`[${TAG}] ${name}: \`tris\` points past the end of \`verts\` — skipped`);
    return null;
  }
  const inverse = new Mat4().copy(m);
  if (!inverse.invert()) {
    console.warn(`[${TAG}] ${name}: zero scale on an axis — skipped`);
    return null;
  }
  const world = [];
  for (let i = 0; i < verts.length; i += 3) world.push(m.transformPoint(new Vec3(verts[i], verts[i + 1], verts[i + 2])));
  return {
    box: boundsOf(world),
    // Inside is an odd number of crossings. It asks nothing of the mesh but
    // that it be closed — convex or not, one shell or several, wound either
    // way, mirrored or not — which is what lets an area be any shape at all.
    contains(x, y, z) {
      inverse.transformPoint(_p.set(x, y, z), _p);
      let n = 0;
      for (let t = 0; t < tris.length; t += 3) {
        if (crosses(_p.x, _p.y, _p.z, verts, tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3)) n++;
      }
      return (n & 1) === 1;
    },
  };
}

/**
 * One placement entry -> `{ name, target, action, shape, box, contains(x, y, z) }`
 * in world space, or null if it cannot be made into a volume.
 */
export function areaFrom(entry) {
  const name = entry.name ?? '(unnamed)';
  const shape = entry.shape ?? 'box';
  if (!entry.target) {
    console.warn(`[${TAG}] ${name}: no \`target\` — an area offers some placement's action, and this one names none — skipped`);
    return null;
  }
  const volume = shape === 'mesh' ? meshArea(entry, name)
    : shape === 'sphere' ? sphereArea(entry, name)
      : convexArea(entry);
  if (!volume) return null;
  const { box, contains } = volume;
  return {
    name, target: entry.target, action: entry.action ?? null, shape, box,
    contains(x, y, z) {
      if (x < box[0] || y < box[1] || z < box[2] || x > box[3] || y > box[4] || z > box[5]) return false;
      return contains(x, y, z);
    },
  };
}

/**
 * An area an ASSET carries — an `areas` entry of its script, the copy of an
 * `_act` mesh modelled with it — put where the asset stands. `matrix` is the
 * placed prop's world transform, so the area is wherever the prop is, however
 * it got there; `target` is that prop.
 */
export function areaFromAsset(entry, matrix, target) {
  const name = `${target}/${entry.name ?? '(unnamed)'}`;
  const volume = meshArea(entry, name, matrix);
  if (!volume) return null;
  const { box, contains } = volume;
  return {
    name, target, action: entry.action ?? null, box,
    contains(x, y, z) {
      if (x < box[0] || y < box[1] || z < box[2] || x > box[3] || y > box[4] || z > box[5]) return false;
      return contains(x, y, z);
    },
  };
}
