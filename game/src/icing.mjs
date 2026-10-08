// The icing: small coloured balls scattered over the white ground, each sunk
// in to its middle — so a ball is a dome, and has no underside.
//
// Nothing of them is in a file. The world is ruled into squares `apart` metres
// on a side, and each square has one ball, at a spot, of a size and in a
// colour worked out from the square's two numbers and the `seed` — whole-number
// arithmetic that comes out the same in every browser. So everyone in the room
// sees the same balls in the same places with nothing said between them, and
// only the ones near enough to make out (`range`) are ever worked out at all:
// a few thousand around whoever is looking, of the twenty thousand there would
// be on the whole plane.
//
// What is ground to ice is whatever a placed prop calls `on` (the plane of
// assets/ground.glb): cover() is handed every prop as it lands and keeps the
// upward faces of that mesh. A square whose spot is over a hole, or so near
// the edge of one — or of a step — that the ball would hang over it, has none.
//
// The numbers are `icing` in scene.manifest.mjs. The balls are not solid: a
// bump under the sole.
import { Color, Entity, Mesh, MeshInstance, StandardMaterial, VertexBuffer, VertexFormat } from 'playcanvas';
import { extractTriangles } from './world.mjs';

const TILE = 4;          // squares along the side of a tile: balls are worked out, kept and shown a tile at a time
const ROUND = [10, 3];   // the dome: how many sides around, how many rings up
const LEVEL = 1e-3;      // metres: ground at two heights this close is one height

// A number in [0, 1) for square (i, j), the k-th asked of it.
function chance(i, j, k, seed) {
  let h = Math.imul(i, 0x9E3779B1) ^ Math.imul(j, 0x85EBCA77) ^ Math.imul(k, 0xC2B2AE3D) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The half of a ball that shows, a metre in radius, its middle at the origin.
function dome(device) {
  const [around, up] = ROUND;
  const pos = [];
  const idx = [];
  for (let r = 0; r < up; r++) {
    const rise = (r * Math.PI) / 2 / up;
    for (let i = 0; i < around; i++) {
      const turn = (i * 2 * Math.PI) / around;
      pos.push(Math.cos(rise) * Math.cos(turn), Math.sin(rise), Math.cos(rise) * Math.sin(turn));
    }
  }
  pos.push(0, 1, 0);
  const top = pos.length / 3 - 1;
  for (let r = 0; r < up; r++) {
    for (let i = 0; i < around; i++) {
      const a = r * around + i;
      const b = r * around + ((i + 1) % around);
      if (r === up - 1) idx.push(a, top, b);
      else idx.push(a, a + around, b + around, a, b + around, b);
    }
  }
  const mesh = new Mesh(device);
  mesh.setPositions(pos);
  mesh.setNormals(pos);
  mesh.setIndices(idx);
  mesh.update();
  return mesh;
}

export class Icing {
  constructor(app, cfg) {
    this.cfg = cfg;
    this.device = app.graphicsDevice;
    this.side = cfg.apart * TILE;     // metres along the side of a tile
    this.ground = new Map();          // tile -> the triangles of ground that may reach into it
    this.tiles = new Map();           // tile -> its balls, as [x, y, z, radius, colour, ...]
    this.shown = [];                  // the balls being drawn, the same way
    this.here = null;                 // the tile the view was in when they were last chosen

    const mesh = dome(this.device);
    this.entity = new Entity('icing');
    this.entity.addComponent('render', {
      castShadows: false,
      meshInstances: cfg.colors.map(([r, g, b]) => {
        const material = new StandardMaterial();
        material.diffuse = new Color(r, g, b);
        material.useMetalness = true;
        material.metalness = 0;
        material.gloss = 0.5;
        material.update();
        const mi = new MeshInstance(mesh, material);
        mi.visible = false;
        return mi;
      }),
    });
    app.root.addChild(this.entity);
  }

  key(ti, tj) { return `${ti},${tj}`; }

  /** A prop has landed: whatever in it is ground to ice is iced from now on. */
  cover(root) {
    const faces = extractTriangles(root, { skip: (name) => name !== this.cfg.on }).filter((t) => t.n.y > 0.999);
    if (!faces.length) return 0;
    for (const { a, b, c } of faces) {
      const tri = { ax: a.x, az: a.z, bx: b.x, bz: b.z, cx: c.x, cz: c.z, y: a.y };
      const lo = (p, q, r) => Math.floor(Math.min(p, q, r) / this.side);
      const hi = (p, q, r) => Math.floor(Math.max(p, q, r) / this.side);
      for (let ti = lo(a.x, b.x, c.x); ti <= hi(a.x, b.x, c.x); ti++) {
        for (let tj = lo(a.z, b.z, c.z); tj <= hi(a.z, b.z, c.z); tj++) {
          const k = this.key(ti, tj);
          if (!this.ground.has(k)) this.ground.set(k, []);
          this.ground.get(k).push(tri);
        }
      }
    }
    this.tiles.clear();
    this.here = null;
    return faces.length;
  }

  /** How high the ground to ice is at (x, z); null where there is none. */
  height(x, z) {
    const near = this.ground.get(this.key(Math.floor(x / this.side), Math.floor(z / this.side)));
    if (!near) return null;
    for (const t of near) {
      const d = (t.bx - t.ax) * (t.cz - t.az) - (t.bz - t.az) * (t.cx - t.ax);
      const u = ((x - t.ax) * (t.cz - t.az) - (z - t.az) * (t.cx - t.ax)) / d;
      const v = ((t.bx - t.ax) * (z - t.az) - (t.bz - t.az) * (x - t.ax)) / d;
      if (u >= 0 && v >= 0 && u + v <= 1) return t.y;
    }
    return null;
  }

  /** The ball of square (i, j): [x, y, z, radius, colour], or null if it has none. */
  ball(i, j) {
    const { seed, apart, radius, varies, colors } = this.cfg;
    const x = (i + chance(i, j, 0, seed)) * apart;
    const z = (j + chance(i, j, 1, seed)) * apart;
    const y = this.height(x, z);
    if (y === null) return null;
    const r = radius * (1 + varies * (2 * chance(i, j, 2, seed) - 1));
    for (let n = 0; n < 8; n++) {
      const beside = this.height(x + r * Math.cos((n * Math.PI) / 4), z + r * Math.sin((n * Math.PI) / 4));
      if (beside === null || Math.abs(beside - y) > LEVEL) return null;
    }
    return [x, y, z, r, Math.floor(chance(i, j, 3, seed) * colors.length)];
  }

  tile(ti, tj) {
    const k = this.key(ti, tj);
    let balls = this.tiles.get(k);
    if (!balls) {
      balls = [];
      for (let i = ti * TILE; i < (ti + 1) * TILE; i++) {
        for (let j = tj * TILE; j < (tj + 1) * TILE; j++) {
          const ball = this.ball(i, j);
          if (ball) balls.push(...ball);
        }
      }
      this.tiles.set(k, balls);
    }
    return balls;
  }

  /** Each frame, with where the view is: the balls around it are the ones drawn. */
  update(view) {
    const ti = Math.floor(view.x / this.side);
    const tj = Math.floor(view.z / this.side);
    const here = this.key(ti, tj);
    if (here === this.here) return;
    this.here = here;

    const reach = Math.ceil(this.cfg.range / this.side);
    const shown = [];
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        if (Math.hypot(di, dj) * this.side > this.cfg.range) continue;
        for (const n of this.tile(ti + di, tj + dj)) shown.push(n);
      }
    }
    this.shown = shown;

    const format = VertexFormat.getDefaultInstancingFormat(this.device);
    this.entity.render.meshInstances.forEach((mi, colour) => {
      const at = [];
      for (let n = 0; n < shown.length; n += 5) {
        if (shown[n + 4] !== colour) continue;
        const r = shown[n + 3];
        at.push(r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, shown[n], shown[n + 1], shown[n + 2], 1);
      }
      mi.instancingData?.vertexBuffer?.destroy();
      mi.visible = at.length > 0;
      if (!at.length) return mi.setInstancing(null);
      mi.setInstancing(new VertexBuffer(this.device, format, at.length / 16, { data: new Float32Array(at) }));
    });
  }

  /** The balls being drawn, for a test or the console: [{ x, y, z, radius, colour }]. */
  balls() {
    const out = [];
    for (let n = 0; n < this.shown.length; n += 5) {
      const [x, y, z, radius, colour] = this.shown.slice(n, n + 5);
      out.push({ x, y, z, radius, colour });
    }
    return out;
  }
}
