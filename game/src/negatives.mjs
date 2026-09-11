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
// subtraction happens at load, twice over the same volumes —
//
//   carve()        the triangle soup extractTriangles() hands over, before
//                  TriangleCollider is built, so the hole is a hole to the
//                  capsule, to every raycast, to findFloors and to the overlay
//   carveRender()  the loaded meshes themselves, so it is a hole you can see
//                  through and the sun shines through it too
//
// Both read the geometry the GLB shipped, and they are kept separate rather
// than the collider being extracted from the carved meshes: collision is then
// guaranteed by its own pass instead of inheriting whatever the render side
// managed, and a mesh the render half declines to touch cannot leave an
// invisible wall standing.
//
// What a negative does not do is add. Cut a hole in a floor and there is no
// shaft under it, only a view of the level's underside — the shaft is a prop
// placed in the opening (see BLENDER_SCENE.md).
import { Mat4, Mesh, Quat, SEMANTIC_POSITION, TYPE_FLOAT32, Vec3 } from 'playcanvas';

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

// A prism inscribed in the unit circle — the same flat sides Blender's cylinder
// has, so the planes here and the mesh you booleaned against in the viewport
// enclose the same volume. Only the ring's phase can differ, which at the
// default 32 sides moves a wall by half a degree of arc.
//
// It stands on the local Y axis, and that is not a free choice: Blender's
// cylinder stands on Blender's Z, the axis conversion sends Blender Z to
// PlayCanvas Y, and an unrotated cutter therefore has to be upright here or a
// well exported from Blender arrives lying on its side. The cube next door
// hides this — it is symmetric under the same swap — which is exactly why it
// went unnoticed until a cylinder made the round trip. tests/negatives.mjs
// pins it by cutting a horizontal floor with an unrotated cylinder and
// measuring the hole: only an upright one leaves a circle.
function cylinderShape(sides) {
  const verts = [];
  for (const y of [-1, 1]) {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      verts.push(Math.cos(a), y, Math.sin(a));
    }
  }
  // The ring runs clockwise seen from +Y, so the bottom cap is the ring as it
  // stands, the top is its reverse, and the sides climb before they step round.
  const faces = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    faces.push([i, sides + i, sides + j, j]);
  }
  const ring = [...Array(sides).keys()];
  faces.push(ring);                                       // -Y cap
  faces.push(ring.map((i) => sides + i).reverse());        // +Y cap
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

  return { name, planes, min, max, box: [min.x, min.y, min.z, max.x, max.y, max.z], hits: 0 };
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
// One clipper serves both halves of the feature. A vertex here is a plain array
// of numbers whose first three are its position and whose remainder is carried
// along, interpolated at every cut — which is what lets the render side keep
// its normals and UVs while the collider side passes bare positions through the
// same code. Two implementations of a polygon split is one implementation too
// many for geometry this fiddly.

// How close to a plane still counts as on it. World metres for the collider;
// the render side scales it into each mesh's local units, where the map's own
// coordinates are 40x larger than the game's.
const ON = 1e-6;

function lerpVertex(a, b, t) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/**
 * Split a convex polygon by one plane: the part in front (outside, `n·p + d >
 * 0`) into `front`, the part behind into `back`. A polygon entirely on one side
 * is passed through by reference rather than rebuilt — the common case, and the
 * reason an untouched triangle can be recognised again afterwards.
 */
function splitPolygon(poly, pl, eps, front, back) {
  const n = poly.length;
  const dist = new Array(n);
  let nf = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const d = pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3];
    dist[i] = d;
    if (d > eps) nf++; else if (d < -eps) nb++;
  }
  if (!nf) { back.push(poly); return; }
  if (!nb) { front.push(poly); return; }

  const f = [], b = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const di = dist[i], dj = dist[j];
    if (di >= -eps) f.push(poly[i]);
    if (di <= eps) b.push(poly[i]);
    if ((di > eps && dj < -eps) || (di < -eps && dj > eps)) {
      const cut = lerpVertex(poly[i], poly[j], di / (di - dj));
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
 * far carries on. What survives the last face is inside the volume, and that is
 * what the caller throws away.
 *
 * Banking early is what keeps the fragment count down: a doorway punched
 * through a wall quad comes out as the four pieces around the opening, not as
 * everything six clipping passes could produce.
 */
function subtractVolume(polys, planes, eps, outside) {
  let inside = polys;
  for (let k = 0; k < planes.length && inside.length; k++) {
    const next = [];
    for (const poly of inside) splitPolygon(poly, planes[k], eps, outside, next);
    inside = next;
  }
  return inside;
}

// Axis-aligned overlap of a triangle against a volume's bounds, both given as
// flat [minx, miny, minz, maxx, maxy, maxz]. The whole point of the broadphase:
// geometry nowhere near a cutter costs six comparisons.
function spanOverlaps(ax, ay, az, bx, by, bz, cx, cy, cz, box) {
  if (Math.min(ax, bx, cx) > box[3] || Math.max(ax, bx, cx) < box[0]) return false;
  if (Math.min(ay, by, cy) > box[4] || Math.max(ay, by, cy) < box[1]) return false;
  if (Math.min(az, bz, cz) > box[5] || Math.max(az, bz, cz) < box[2]) return false;
  return true;
}

// ---- The collider half -----------------------------------------------------

// Fan-triangulate a convex polygon back into the soup, inheriting everything
// the source triangle carried. The normal is inherited rather than recomputed:
// every piece is coplanar with its parent by construction, and a sliver's own
// cross product is mostly rounding error.
function fanInto(out, poly, src) {
  const v = poly.map((p) => new Vec3(p[0], p[1], p[2]));
  for (let i = 2; i < v.length; i++) {
    const a = v[0], b = v[i - 1], c = v[i];
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
    let source = null;   // built only once a volume is known to be in range
    let polys = null;
    for (const v of volumes) {
      if (!spanOverlaps(t.a.x, t.a.y, t.a.z, t.b.x, t.b.y, t.b.z, t.c.x, t.c.y, t.c.z, v.box)) continue;
      if (!source) {
        source = [[t.a.x, t.a.y, t.a.z], [t.b.x, t.b.y, t.b.z], [t.c.x, t.c.y, t.c.z]];
        polys = [source];
      }
      const kept = [];
      if (subtractVolume(polys, v.planes, ON, kept).length) v.hits++;
      polys = kept;
      if (!polys.length) break;
    }
    // Either no cutter was in range, or one was and took nothing: both mean the
    // triangle is the one that went in, so hand back that very object.
    if (!polys || (polys.length === 1 && polys[0] === source)) { out.push(t); continue; }
    for (const poly of polys) fanInto(out, poly, t);
  }
  return out;
}

// ---- The render half -------------------------------------------------------

/**
 * One world-space volume expressed in a mesh's own coordinates.
 *
 * Planes are moved rather than vertices: a plane `P` satisfying `P·(x,1) = 0`
 * for world points becomes `Mᵀ P` for local ones, which is three multiplies per
 * face against a transform per vertex — and, more to the point, it leaves the
 * normals and UVs alone. They are attributes of the surface, not of the space.
 */
function localise(volume, world, inverse) {
  const m = world.data;
  const planes = volume.planes.map((p) => {
    const o = [0, 1, 2, 3].map((i) => m[4 * i] * p[0] + m[4 * i + 1] * p[1]
      + m[4 * i + 2] * p[2] + m[4 * i + 3] * p[3]);
    const len = Math.hypot(o[0], o[1], o[2]) || 1;
    return [o[0] / len, o[1] / len, o[2] / len, o[3] / len];
  });

  // The world bounds through the inverse: conservative (an OBB's AABB), which
  // is all a broadphase has to be.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const corner = new Vec3();
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? volume.max.x : volume.min.x,
      i & 2 ? volume.max.y : volume.min.y,
      i & 4 ? volume.max.z : volume.min.z);
    inverse.transformPoint(corner, corner);
    for (let a = 0; a < 3; a++) {
      const c = a === 0 ? corner.x : a === 1 ? corner.y : corner.z;
      if (c < lo[a]) lo[a] = c;
      if (c > hi[a]) hi[a] = c;
    }
  }
  return { planes, box: [...lo, ...hi] };
}

// Every vertex stream the mesh holds, packed one vertex at a time with POSITION
// first so the clipper can read it without being told where it is. Float32 only
// — which is what the glTF loader produces for this map, and a mesh that is not
// gets left alone rather than quietly mangled.
function packVertices(mesh) {
  const vb = mesh.vertexBuffer;
  const format = vb.getFormat();
  if (format.elements.some((e) => e.dataType !== TYPE_FLOAT32)) return null;

  const elements = [...format.elements].sort(
    (a, b) => (a.name === SEMANTIC_POSITION ? -1 : 0) + (b.name === SEMANTIC_POSITION ? 1 : 0));
  const stride = elements.reduce((n, e) => n + e.numComponents, 0);
  const count = vb.getNumVertices();
  const src = new Float32Array(vb.lock());
  const verts = new Float32Array(count * stride);

  let at = 0;
  for (const e of elements) {
    const base = e.offset / 4, step = e.stride / 4;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < e.numComponents; c++) verts[i * stride + at + c] = src[base + i * step + c];
    }
    at += e.numComponents;
  }
  return { elements, stride, count, verts };
}

function buildMesh(device, elements, stride, packed, indices) {
  const mesh = new Mesh(device);
  const count = packed.length / stride;
  let at = 0;
  for (const e of elements) {
    const n = e.numComponents;
    const data = new Float32Array(count * n);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < n; c++) data[i * n + c] = packed[i * stride + at + c];
    }
    // setPositions rather than setVertexStream for the one stream that decides
    // the bounding box, or the mesh keeps the bounds of the shape it replaced.
    if (e.name === SEMANTIC_POSITION) mesh.setPositions(data, n);
    else mesh.setVertexStream(e.name, data, n);
    at += n;
  }
  mesh.setIndices(indices);
  mesh.update();
  return mesh;
}

/**
 * Carve one mesh instance, returning a replacement Mesh or null if the cutters
 * left it alone.
 *
 * Vertices the carve did not touch are copied once and re-indexed, so a wall
 * with a doorway in it keeps the vertex buffer it had plus the handful the
 * opening needed — not a fresh copy of every corner in the level.
 */
function carveMesh(instance, volumes, device) {
  const mesh = instance.mesh;
  if (!mesh || !mesh.vertexBuffer) return null;

  const world = instance.node.getWorldTransform();
  const bounds = instance.aabb;
  const near = volumes.filter((v) => {
    const lo = bounds.getMin(), hi = bounds.getMax();
    return v.min.x <= hi.x && v.max.x >= lo.x && v.min.y <= hi.y
      && v.max.y >= lo.y && v.min.z <= hi.z && v.max.z >= lo.z;
  });
  if (!near.length) return null;

  const packed = packVertices(mesh);
  if (!packed) return null;                       // not float32 — leave it be
  const { elements, stride, count, verts } = packed;

  const indices = [];
  mesh.getIndices(indices);
  if (!indices.length) return null;

  const inverse = new Mat4().copy(world).invert();
  const local = near.map((v) => localise(v, world, inverse));
  // ON is world metres; local coordinates are not. The map lives at 0.025, so
  // a micron out there is forty microns in here.
  const scale = world.getScale();
  const eps = ON / Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-9);

  const out = [];
  const idx = [];
  const remap = new Int32Array(count).fill(-1);
  const keep = (i) => {
    if (remap[i] < 0) {
      remap[i] = out.length / stride;
      for (let c = 0; c < stride; c++) out.push(verts[i * stride + c]);
    }
    return remap[i];
  };
  const add = (v) => {
    const n = out.length / stride;
    for (let c = 0; c < stride; c++) out.push(v[c]);
    return n;
  };
  const vertexAt = (i) => Array.from(verts.subarray(i * stride, i * stride + stride));

  let cut = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const p0 = i0 * stride, p1 = i1 * stride, p2 = i2 * stride;

    let source = null, polys = null;
    for (const v of local) {
      if (!spanOverlaps(verts[p0], verts[p0 + 1], verts[p0 + 2],
        verts[p1], verts[p1 + 1], verts[p1 + 2],
        verts[p2], verts[p2 + 1], verts[p2 + 2], v.box)) continue;
      if (!source) {
        source = [vertexAt(i0), vertexAt(i1), vertexAt(i2)];
        polys = [source];
      }
      const kept = [];
      subtractVolume(polys, v.planes, eps, kept);
      polys = kept;
      if (!polys.length) break;
    }

    if (!polys || (polys.length === 1 && polys[0] === source)) {
      idx.push(keep(i0), keep(i1), keep(i2));
      continue;
    }
    cut++;
    for (const poly of polys) {
      const ids = poly.map(add);
      for (let i = 2; i < ids.length; i++) idx.push(ids[0], ids[i - 1], ids[i]);
    }
  }
  if (!cut) return null;
  return buildMesh(device, elements, stride, out, idx);
}

/**
 * Carve a loaded render hierarchy in place, so the holes are visible as well as
 * walkable.
 *
 * The mesh is swapped on the instance rather than the instance replaced on the
 * component: a render component's meshInstances setter destroys what was there,
 * and what was there is carrying the material atmosphere.js already adopted,
 * the node, the layers and the shadow flags. Only the geometry changed.
 *
 * Nothing is written back to the container asset, so the GLB in memory stays
 * the GLB on disk and a second instantiation of it comes up uncarved.
 */
export function carveRender(rootEntity, volumes, device) {
  const stats = { meshes: 0, before: 0, after: 0 };
  if (!volumes || !volumes.length) return stats;

  for (const rc of rootEntity.findComponents('render')) {
    for (const instance of rc.meshInstances) {
      const before = instance.mesh?.primitive?.[0]?.count ?? 0;
      const carved = carveMesh(instance, volumes, device);
      if (!carved) continue;
      instance.mesh = carved;
      stats.meshes++;
      stats.before += before / 3;
      stats.after += (carved.primitive[0].count ?? 0) / 3;
    }
  }
  return stats;
}
