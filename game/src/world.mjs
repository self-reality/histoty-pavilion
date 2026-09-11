// Shared, engine-light world helpers used by BOTH entry points:
//   • standalone/main.mjs (engine-only build served from index.html)
//   • src/game.mjs        (PlayCanvas Editor script component)
//
// Nothing here creates a pc.Application or touches the DOM, so it is safe to
// sync to the Editor as a script asset and safe to import from the standalone
// bootstrap. Keep it that way — DOM/HUD lives in ui.mjs, app lifecycle in the
// two entry points.
import { Vec3, Quat, Color, Entity, StandardMaterial } from 'playcanvas';

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

// ---- Collision opt-out convention ------------------------------------------
/**
 * Meshes carrying the `_nocol` marker are visual-only: they render and cast
 * shadows, but never enter the collider. That is how a tent's guy-ropes and
 * poles stay visible without being thin geometry you snag on.
 *
 * Authored in Blender as an object-name suffix (`pole_nocol`). The glTF importer
 * appends a primitive index on the way in — `Military_tent_01` arrives as
 * `Military_tent_01_0` — and Blender itself appends `.001` to duplicates, so the
 * match tolerates trailing numeric suffixes rather than demanding a bare ending.
 */
export const NO_COLLIDE = /_nocol(?:[._]\d+)*$/i;
export const isNonColliding = (name) => NO_COLLIDE.test(name || '');

/**
 * The mirror image: a mesh marked `_col` is collision-only. It never renders and
 * never casts a shadow — it exists so the collider can be given a cheap stand-in
 * for geometry that is far more detailed than a capsule can feel.
 *
 * Built upstream by the asset kit (`collisionProxy` in its assets.config.json),
 * which either dissolves near-flat faces or hulls each connected shell of the
 * visual mesh. A prop that has one collides with it *instead of* its visual
 * geometry — see propCollisionTriangles. The naming rule is the contract; this
 * side does not care which tool wrote the file.
 *
 * `_nocol` does not match this: the `_` before `col` is what separates them, and
 * `pole_nocol` has an `o` there. tests/props.mjs pins that both ways.
 */
export const COLLISION_PROXY = /_col(?:[._]\d+)*$/i;
export const isCollisionProxy = (name) => COLLISION_PROXY.test(name || '');

// ---- Triangle extraction (world space) ------------------------------------
// Pulls a triangle soup out of a loaded/instantiated render hierarchy, already
// baked into world space, ready to feed TriangleCollider.
//
// `opts.skip(name)` drops individual meshes by node name — see isNonColliding.
export function extractTriangles(rootEntity, opts = {}) {
  const skip = opts.skip;
  const tris = [];
  const renders = rootEntity.findComponents('render');
  for (const rc of renders) {
    for (const mi of rc.meshInstances) {
      if (skip && skip(mi.node.name)) continue;
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

/**
 * The triangles a placed prop should contribute to the collider.
 *
 * A prop carrying a `_col` proxy collides with that alone; otherwise it collides
 * with its visual meshes minus any `_nocol` ones. Deciding here rather than at
 * the call site keeps the precedence in one place: a proxy is authored *because*
 * the visual mesh is the wrong thing to collide with, so it always wins, and a
 * prop that has one never pays for its wrinkles.
 *
 * `opts.collides(name)` vetoes a mesh on top of that — a rig that hid geometry
 * passes its own predicate so the removed mesh doesn't leave a solid ghost. It
 * is a separate question from visibility, which is why it is not read off
 * `mi.visible`: a `_col` proxy is invisible and collides, by design.
 */
export function propCollisionTriangles(rootEntity, opts = {}) {
  const collides = opts.collides ?? (() => true);
  const hasProxy = rootEntity.findComponents('render')
    .some((rc) => rc.meshInstances.some((mi) => isCollisionProxy(mi.node.name)));
  const base = hasProxy ? (name) => !isCollisionProxy(name) : isNonColliding;
  return extractTriangles(rootEntity, {
    skip: (name) => base(name) || !collides(name),
  });
}

/**
 * Take the `_col` proxies out of both the camera pass and the shadow pass.
 *
 * They stay in the entity hierarchy — propCollisionTriangles still has to find
 * them — so hiding is per mesh instance rather than by disabling the entity.
 */
export function hideCollisionProxies(rootEntity) {
  let hidden = 0;
  for (const rc of rootEntity.findComponents('render')) {
    for (const mi of rc.meshInstances) {
      if (!isCollisionProxy(mi.node.name)) continue;
      mi.visible = false;
      mi.castShadow = false;
      hidden++;
    }
  }
  return hidden;
}

/**
 * Stop an unlit material from collecting the scene's ambient light.
 *
 * A KHR_materials_unlit material arrives via the engine's extensionUnlit hook,
 * which moves the image into `emissive` and then sets `diffuse` to WHITE with no
 * diffuse map. `useLighting = false` drops the lights, but the ambient term is
 * still accumulated — and ambient x white diffuse is a flat constant added to
 * every pixel of the surface.
 *
 * With this level's ambient (0.55, 0.53, 0.5) that constant is ~0.24 in linear
 * light, measured straight off a ramp rendered through the material: texel 0
 * comes back as 134/255 instead of 0. Blacks lift by half, so contrast and
 * saturation both drop by about half and the surface reads as washed out — the
 * one thing an unlit picture was supposed to be immune to.
 *
 * Zeroing the diffuse multiplies that term out and leaves `emissive` — the
 * authored image — as the only thing the surface contributes. Nothing here knows
 * what a picture is: it is a property of unlit materials, so it is applied to
 * any prop that ships one. Fog is deliberately left alone; a distant picture
 * should haze with everything else.
 */
export function unlitIgnoreAmbient(rootEntity) {
  let sealed = 0;
  for (const rc of rootEntity.findComponents('render')) {
    for (const mi of rc.meshInstances) {
      const m = mi.material;
      // Materials are shared between instances of the same container, so a prop
      // placed twice would otherwise count its materials twice.
      if (m?.useLighting !== false) continue;
      if (m.diffuse.r === 0 && m.diffuse.g === 0 && m.diffuse.b === 0) continue;
      m.diffuse.set(0, 0, 0);
      m.update();
      sealed++;
    }
  }
  return sealed;
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

// ---- The authored spawn ----------------------------------------------------
// A marker is a childless Empty in the .blend — a name and a transform, no
// geometry (see BLENDER_SCENE.md). `spawn` is the first convention the game
// reads back: stand the Empty where the player should start, point its arrows
// where they should look, and the export carries both numbers to here.
const SPAWN_MARKER = /^spawn(?:[._-]|$)/i;

// How far above the marker the floor probe starts, and how far below it the
// probe will follow the ground down. Waist-high up, one storey down: an Empty
// dropped roughly into place still lands you on the floor beneath it, and one
// stood on a balcony does not spawn you in the street under it.
const PROBE_UP = 1;
const PROBE_DOWN = 4;

const _down = new Vec3(0, -1, 0);
const _fwd = new Vec3();

/**
 * Where the .blend says the player starts — { x, y, z, yaw, name } — or null
 * when the layout carries no spawn marker, which is the caller's cue to fall
 * back to pickSpawn().
 *
 * The marker's height is a hint, not the answer: it is dropped onto whatever
 * floor is under it, so the Empty can sit at eye height (where you can see it
 * in the viewport) or a few centimetres proud of the ground and the player
 * still stands on the floor. Its rotation is read as a look direction, so the
 * spawn is a pose rather than a point — which is the whole difference between
 * arriving somewhere and arriving facing the thing you came to see.
 */
export function markerSpawn(markers, collider) {
  const found = (markers ?? []).filter((m) => SPAWN_MARKER.test(m.name ?? ''));
  if (!found.length) return null;
  if (found.length > 1) {
    console.warn(`[spawn] ${found.length} spawn markers in the layout; using ${found[0].name}`);
  }
  const marker = found[0];
  const [x, y, z] = marker.pos ?? [0, 0, 0];
  const hit = collider.raycast(new Vec3(x, y + PROBE_UP, z), _down, PROBE_UP + PROBE_DOWN);
  const floor = hit && hit.normal.y > 0.6 ? hit.point.y + 0.15 : y;
  return { x, y: floor, z, yaw: markerYaw(marker), name: marker.name };
}

// Player.yaw is degrees about Y with 0 looking down -Z, so read the marker the
// same way the player is read: turn its rotation into a forward vector and
// take the compass bearing of that. A marker tilted off horizontal still gives
// the right bearing — the tilt is simply dropped, which is all a player who
// cannot roll could use anyway.
function markerYaw(marker) {
  if (marker.rot) {
    // Quaternion over euler, the same precedence a prop placement gets.
    const q = new Quat(marker.rot[0], marker.rot[1], marker.rot[2], marker.rot[3]);
    q.transformVector(Vec3.FORWARD, _fwd);
    if (_fwd.x || _fwd.z) return Math.atan2(-_fwd.x, -_fwd.z) * 180 / Math.PI;
    return 0;                                  // pointed at the sky or the floor
  }
  return marker.euler ? marker.euler[1] : 0;
}
