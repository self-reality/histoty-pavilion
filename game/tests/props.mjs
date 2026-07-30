// Props are solid, and `_nocol` meshes are not.
//
//   node tests/props.mjs        # needs `npm start` running on :5173
//
// Checks the three things that can independently go wrong: the convention's
// pattern matching, whether a prop's triangles actually reach the collider, and
// whether the player is really stopped by them (a collider entry that the
// capsule resolve never consults would pass the first two and still be useless).
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.app.root.findByName('tent_01'), { timeout: 60000 });
await page.waitForTimeout(2500);   // let the prop's collision land

const r = await page.evaluate(async () => {
  const { isNonColliding } = await import('/src/world.mjs');
  const g = window.game;

  // 1) The naming convention, including the shapes glTF and Blender produce.
  const naming = [
    ['pole_nocol', true], ['pole_nocol_0', true], ['pole_nocol.001', true],
    ['Rope_NOCOL_0', true], ['tent_nocol_0_1', true],
    ['Military_tent_01_0', false], ['nocolumn_0', false],
    ['tent_nocol_pole', false], ['', false],
  ].map(([name, want]) => ({ name, want, got: isNonColliding(name) }));

  // 2) The tent's triangles reached the collider — and its `_nocol` ones did
  // not. The split is produced by tools/build_assets.py (nocolMaxSpan), so this
  // also catches an asset rebuilt without it: nocolTris would fall to zero.
  const tent = g.app.root.findByName('tent_01');
  let tentTris = 0;
  let nocolTris = 0;
  const walk = (e) => {
    if (e.render) for (const mi of e.render.meshInstances) {
      const ib = mi.mesh.indexBuffer && mi.mesh.indexBuffer[0];
      const n = ib ? ib.numIndices / 3 : 0;
      if (isNonColliding(mi.node.name)) nocolTris += n;
      else tentTris += n;
    }
    for (const c of e.children) walk(c);
  };
  walk(tent);

  // 3) Pick a floor sample near the tent to approach from. Firing at the tent
  // from an arbitrary offset is not a valid test — the level has walls, and a
  // ray that stops early may simply have hit one. Standing where the player can
  // actually walk to the tent gives a line known to be clear.
  const c = tent.getPosition();
  const floor = g.player.floors.reduce((best, f) => {
    const d = Math.hypot(f.x - c.x, f.z - c.z);
    return Math.abs(d - 8) < Math.abs(best.d - 8) ? { f, d } : best;
  }, { f: g.player.floors[0], d: Infinity }).f;

  const L = Math.hypot(floor.x - c.x, floor.z - c.z);
  const dir = { x: (c.x - floor.x) / L, y: 0, z: (c.z - floor.z) / L };
  const V = g.player.pos.constructor;
  const hit = g.collider.raycast(
    new V(floor.x, floor.y + 1.2, floor.z), new V(dir.x, dir.y, dir.z), 100);
  const hitDist = hit ? hit.dist : null;
  const hitProp = hit ? (hit.tri.prop ?? '(map)') : null;

  // 4) Walk into the tent and confirm the capsule is stopped. Drive the
  // controller directly for a fixed number of steps so this does not depend on
  // frame pacing.
  g.player.teleport(floor.x, floor.y + 0.2, floor.z);
  const startDist = Math.hypot(g.player.pos.x - c.x, g.player.pos.z - c.z);
  // Face the tent. yaw is degrees about Y; forward is -Z at yaw 0.
  g.player.yaw = Math.atan2(-(c.x - floor.x), -(c.z - floor.z)) * 180 / Math.PI;
  for (let i = 0; i < 240; i++) {
    g.player.update(1 / 60, { forward: 1, strafe: 0, jump: false, sprint: false });
  }
  const endDist = Math.hypot(g.player.pos.x - c.x, g.player.pos.z - c.z);

  // What is actually in front of the stopped player? Same reasoning as above:
  // "stopped" is only meaningful if the tent is what stopped them.
  const fwd = g.entityForward ?? null;
  const yawRad = g.player.yaw * Math.PI / 180;
  const blockDir = new V(-Math.sin(yawRad), 0, -Math.cos(yawRad));
  const eye = new V(g.player.pos.x, g.player.pos.y + 1.0, g.player.pos.z);
  const block = g.collider.raycast(eye, blockDir, 4);
  const blockedBy = block ? (block.tri.prop ?? '(map)') : null;

  return {
    naming,
    colliderTris: g.collider.tris.length,
    tentTris: Math.round(tentTris),
    nocolTris: Math.round(nocolTris),
    hitDist: hitDist === null ? null : +hitDist.toFixed(2),
    hitProp,
    approachFrom: +L.toFixed(2),
    startDist: +startDist.toFixed(2),
    endDist: +endDist.toFixed(2),
    blockedBy,
    blockDist: block ? +block.dist.toFixed(2) : null,
  };
});

await browser.close();

const namingBad = r.naming.filter((n) => n.got !== n.want);
// The map alone is 9,474 triangles; the tent must have added its own on top.
const colliderGrew = r.colliderTris >= 9474 + r.tentTris;
// The tent is the only prop placed, so the collider is exactly the map plus the
// tent's colliding half — anything more means the `_nocol` half leaked in.
const nocolExcluded = r.nocolTris > 0 && r.colliderTris === 9474 + r.tentTris;
// The ray must have been stopped BY THE TENT, not by map geometry in the way.
const rayHitTent = r.hitProp === 'tent_01' && r.hitDist < r.approachFrom - 0.5;
// Walking into it must leave the player outside it, with the tent in front.
const walkStopped = r.endDist < r.startDist && r.blockedBy === 'tent_01';

console.log(`  collider triangles   ${r.colliderTris.toLocaleString()} (map 9,474 + tent ${r.tentTris.toLocaleString()})`);
console.log(`  tent _nocol tris     ${r.nocolTris.toLocaleString()} rendered, kept out of the collider`);
console.log(`  ray at tent          hit "${r.hitProp}" at ${r.hitDist} m into a ${r.approachFrom} m approach`);
console.log(`  walked into tent     ${r.startDist} m -> ${r.endDist} m from centre`);
console.log(`  blocked by           "${r.blockedBy}" at ${r.blockDist} m`);
console.log(`  naming convention    ${r.naming.length - namingBad.length}/${r.naming.length} correct`);
for (const n of namingBad) console.log(`     WRONG "${n.name}": got ${n.got}, want ${n.want}`);
if (errs.length) console.log('  page errors:', errs.slice(0, 3));

const ok = !namingBad.length && colliderGrew && nocolExcluded && rayHitTent && walkStopped && !errs.length;
if (!ok) {
  console.log(`\n  colliderGrew=${colliderGrew} nocolExcluded=${nocolExcluded}`
    + ` rayHitTent=${rayHitTent} walkStopped=${walkStopped}`);
}
console.log(ok ? '\nPROPS: PASS' : '\nPROPS: FAIL');
process.exit(ok ? 0 : 1);
