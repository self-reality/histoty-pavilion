// Negative spaces carve the map, and they carve only where they are.
//
//   node tests/negatives.mjs    # needs `npm start` running on :5173
//
// Four things can go wrong independently of each other: the clipping maths, the
// carve reaching the collider the player actually consults, a cutter that
// should have been refused being applied anyway, and — the quiet one — a cutter
// taking geometry with it that is nowhere near the hole. The last is checked by
// identity: a triangle the carve did not touch must come out of it as the same
// object, not as an equal copy.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.collider, { timeout: 60000 });

const r = await page.evaluate(async () => {
  const { volumeFrom, collectVolumes, carve } = await import('/src/negatives.mjs');
  const { TriangleCollider } = await import('/src/collision.mjs');
  const { Vec3, Mat4 } = await import('playcanvas');
  const g = window.game;

  const V = (x, y, z) => new Vec3(x, y, z);
  const tri = (a, b, c) => ({ a, b, c, n: new Vec3().cross(new Vec3().sub2(b, a), new Vec3().sub2(c, a)).normalize() });
  const area = (ts) => ts.reduce((s, t) =>
    s + 0.5 * new Vec3().cross(new Vec3().sub2(t.b, t.a), new Vec3().sub2(t.c, t.a)).length(), 0);
  const inside = (v, p) => v.planes.every((pl) => pl[0] * p.x + pl[1] * p.y + pl[2] * p.z + pl[3] < -1e-6);

  // 1) A 6 x 3 m wall with a 1 x 2 m doorway in it. Area is the honest measure:
  // triangle counts move around with how the pieces happen to be fanned, but
  // the surface either went away or it did not.
  const wall = [tri(V(-3, 0, 0), V(3, 0, 0), V(3, 3, 0)), tri(V(-3, 0, 0), V(3, 3, 0), V(-3, 3, 0))];
  const door = collectVolumes([{ name: 'neg_door', shape: 'box', pos: [0, 1, 0], scale: [0.5, 1, 0.5] }]);
  const carved = carve(wall, door);
  const wallArea = { before: area(wall), after: area(carved), want: 18 - 1 * 2 };
  const leftInside = carved.flatMap((t) => [t.a, t.b, t.c]).filter((p) => inside(door[0], p)).length;

  // A cylinder is the prism Blender draws, not the circle it stands for — so
  // the hole it leaves in a 10 x 10 floor is the inscribed polygon's, and that
  // is the number the viewport's boolean agrees with.
  const floor = [tri(V(-5, 0, -5), V(5, 0, -5), V(5, 0, 5)), tri(V(-5, 0, -5), V(5, 0, 5), V(-5, 0, 5))];
  const sides = 64;
  const well = collectVolumes([{ name: 'neg_well', shape: 'cylinder', sides, pos: [0, 0, 0], euler: [90, 0, 0] }]);
  const wellArea = { after: area(carve(floor, well)), want: 100 - sides * 0.5 * Math.sin(2 * Math.PI / sides) };

  // 2) The refusals. A mirrored cutter is the dangerous one: its faces turn
  // inward, so it means "everywhere except here" and would eat the level.
  const refused = {
    mirrored: collectVolumes([{ name: 'x', shape: 'box', pos: [0, 0, 0], scale: [-1, 1, 1] }]).length,
    unknown: collectVolumes([{ name: 'x', shape: 'sphere', pos: [0, 0, 0] }]).length,
    flat: collectVolumes([{ name: 'x', shape: 'box', pos: [0, 0, 0], scale: [1, 0, 1] }]).length,
    good: collectVolumes([{ name: 'x', shape: 'box', pos: [0, 0, 0] }]).length,
  };

  // 3) Against the real map: find a wall the player can see from the spawn, put
  // a doorway in it, and ask the collider the same question before and after.
  const eye = V(g.player.spawn.x, g.player.spawn.y + 1.0, g.player.spawn.z);
  let hit = null, dir = null;
  for (let deg = 0; deg < 360 && !hit; deg += 3) {
    const a = deg * Math.PI / 180;
    const d = V(Math.cos(a), 0, Math.sin(a));
    const h = g.collider.raycast(eye, d, 20);
    // A map wall: steep enough to be a wall, far enough to stand back from, and
    // not a prop (props are tagged; the map's triangles are not).
    if (h && h.dist > 3 && !h.tri.prop && Math.abs(h.normal.y) < 0.3) { hit = h; dir = d; }
  }
  if (!hit) return { noWall: true };

  const n = V(hit.normal.x, 0, hit.normal.z).normalize();
  const up = V(0, 1, 0);
  const tangent = new Vec3().cross(up, n).normalize();
  const basis = new Mat4();
  basis.data.set([tangent.x, tangent.y, tangent.z, 0, up.x, up.y, up.z, 0, n.x, n.y, n.z, 0, 0, 0, 0, 1]);
  const e = basis.getEulerAngles();
  const entry = {
    name: 'neg_test_door', shape: 'box',
    pos: [hit.point.x, hit.point.y, hit.point.z],
    euler: [e.x, e.y, e.z],
    scale: [0.6, 1.1, 0.5],           // 1.2 m wide, 2.2 m tall, 1 m through
  };
  const volume = volumeFrom(entry);

  const before = g.collider.tris;
  const after = carve(before, [volume]);
  const rebuilt = new TriangleCollider(after, 2.0);

  // `n` faces the ray the collider was given, so it points back at the eye:
  // stand off along it, then shoot straight down it into the wall.
  const from = new Vec3().copy(hit.point).add(new Vec3().copy(n).mulScalar(3));
  const at = new Vec3().copy(n).mulScalar(-1);
  const aside = new Vec3().copy(from).add(new Vec3().copy(tangent).mulScalar(2.5));
  const shot = (col, o) => { const h = col.raycast(o, at, 8); return h ? +h.dist.toFixed(2) : null; };

  // 4) Locality, by identity: everything the carve did not touch is the very
  // same triangle object, so "the doorway cost 30 triangles" is a claim about
  // 30 triangles and not about the other nine thousand.
  const was = new Set(before);
  const untouched = after.filter((t) => was.has(t)).length;

  return {
    wallArea, leftInside, wellArea, refused,
    mapTris: { before: before.length, after: after.length, untouched, hits: volume.hits },
    doorway: { before: shot(g.collider, from), after: shot(rebuilt, from) },
    control: { before: shot(g.collider, aside), after: shot(rebuilt, aside) },
    stillInside: after.flatMap((t) => [t.a, t.b, t.c]).filter((p) => inside(volume, p)).length,
    wired: Array.isArray(g.negatives),
  };
});

if (r.noWall) { console.log('NEGATIVES: FAIL — no map wall visible from the spawn to test against'); process.exit(1); }

const near = (a, b, tol) => Math.abs(a - b) < tol;
const wallCarved = near(r.wallArea.after, r.wallArea.want, 1e-6) && r.leftInside === 0;
const wellCarved = near(r.wellArea.after, r.wellArea.want, 1e-4);
// Refusing is the safe direction, so all three bad cutters must be dropped and
// the good one must still get through — a guard that refuses everything passes
// the first half on its own.
const guarded = r.refused.mirrored === 0 && r.refused.unknown === 0 && r.refused.flat === 0 && r.refused.good === 1;
// The wall stopped the ray before and does not now, and the same wall 2.5 m to
// the side still stops it at the same range: a hole, not a demolished wall.
const doorOpened = r.doorway.before !== null && r.doorway.after === null;
const wallStands = r.control.before !== null && near(r.control.after, r.control.before, 0.01);
const local = r.mapTris.untouched > r.mapTris.before - 100 && r.mapTris.hits > 0;
const nothingInside = r.stillInside === 0;

console.log(`  synthetic wall       ${r.wallArea.before} -> ${r.wallArea.after} m2 (want ${r.wallArea.want}), ${r.leftInside} vertices left inside`);
console.log(`  cylinder in a floor  ${r.wellArea.after.toFixed(4)} m2 (want the inscribed prism's ${r.wellArea.want.toFixed(4)})`);
console.log(`  cutters refused      mirrored=${!r.refused.mirrored} unknown-shape=${!r.refused.unknown} zero-scale=${!r.refused.flat} (a good one still builds: ${!!r.refused.good})`);
console.log(`  map soup             ${r.mapTris.before.toLocaleString()} -> ${r.mapTris.after.toLocaleString()} tris, ${r.mapTris.untouched.toLocaleString()} of them the same objects; the cutter took ${r.mapTris.hits}`);
console.log(`  ray at the doorway   ${r.doorway.before} m before, ${r.doorway.after === null ? 'no hit' : r.doorway.after + ' m'} after`);
console.log(`  ray 2.5 m aside      ${r.control.before} m before, ${r.control.after} m after`);
console.log(`  loader wired         window.game.negatives is ${r.wired ? 'an array' : 'MISSING'}`);
if (errs.length) console.log('  page errors:', errs.slice(0, 3));

const ok = wallCarved && wellCarved && guarded && doorOpened && wallStands && local && nothingInside && r.wired && !errs.length;
if (!ok) {
  console.log(`\n  wallCarved=${wallCarved} wellCarved=${wellCarved} guarded=${guarded} doorOpened=${doorOpened}`
    + ` wallStands=${wallStands} local=${local} nothingInside=${nothingInside} wired=${r.wired}`);
}
console.log(ok ? '\nNEGATIVES: PASS' : '\nNEGATIVES: FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
