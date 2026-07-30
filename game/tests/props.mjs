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
  const { isNonColliding, isCollisionProxy } = await import('/src/world.mjs');
  const g = window.game;

  // 1) The naming conventions, including the shapes glTF and Blender produce.
  // The two must not shadow each other: `_nocol` ends in "col", so a sloppy
  // proxy pattern would classify every opted-out mesh as a collision proxy and
  // collide with exactly the geometry meant to be skipped.
  const naming = [
    ['pole_nocol', true], ['pole_nocol_0', true], ['pole_nocol.001', true],
    ['Rope_NOCOL_0', true], ['tent_nocol_0_1', true],
    ['Military_tent_01_0', false], ['nocolumn_0', false],
    ['tent_nocol_pole', false], ['', false],
  ].map(([name, want]) => ({ name, want, got: isNonColliding(name), fn: 'isNonColliding' }))
    .concat([
      ['tent_col', true], ['tent_col_0', true], ['tent_col.001', true],
      ['TENT_COL_0', true],
      ['pole_nocol', false], ['pole_nocol_0', false], ['protocol_0', false],
      ['Military_tent_01_0', false], ['', false],
    ].map(([name, want]) => ({ name, want, got: isCollisionProxy(name), fn: 'isCollisionProxy' })));

  // 2) What the tent contributes, split three ways. The proxy is built by
  // tools/build_assets.py (collisionProxy), so a rebuild without it shows up
  // here as proxyTris falling to zero rather than as a silent cost increase.
  const tent = g.app.root.findByName('tent_01');
  let visibleTris = 0;
  let nocolTris = 0;
  let proxyTris = 0;
  let proxyVisible = 0;
  const walk = (e) => {
    if (e.render) for (const mi of e.render.meshInstances) {
      const ib = mi.mesh.indexBuffer && mi.mesh.indexBuffer[0];
      const n = ib ? ib.numIndices / 3 : 0;
      if (isCollisionProxy(mi.node.name)) {
        proxyTris += n;
        if (mi.visible || mi.castShadow) proxyVisible++;
      } else if (isNonColliding(mi.node.name)) nocolTris += n;
      else visibleTris += n;
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
  const yawRad = g.player.yaw * Math.PI / 180;
  const blockDir = new V(-Math.sin(yawRad), 0, -Math.cos(yawRad));

  // Measure at the point of *closest approach*, not on whichever frame the loop
  // happens to end on. The tent's walls are an A-frame: a capsule pressed into
  // one rides up the slope, goes airborne, and slides back down and outward. So
  // the final frame samples a random phase of that bounce and can sit a metre
  // further out than the player ever actually got — which reads as "the tent
  // did not stop them" when the truth is the opposite. Closest approach is the
  // frame where the claim is meaningful: this is as far in as the tent let them.
  let minDist = Infinity;
  let blockedBy = null;
  let blockDist = null;
  for (let i = 0; i < 240; i++) {
    g.player.update(1 / 60, { forward: 1, strafe: 0, jump: false, sprint: false });
    const d = Math.hypot(g.player.pos.x - c.x, g.player.pos.z - c.z);
    if (d >= minDist) continue;
    minDist = d;
    const eye = new V(g.player.pos.x, g.player.pos.y + 1.0, g.player.pos.z);
    const block = g.collider.raycast(eye, blockDir, 4);
    blockedBy = block ? (block.tri.prop ?? '(map)') : null;
    blockDist = block ? block.dist : null;
  }
  const endDist = Math.hypot(g.player.pos.x - c.x, g.player.pos.z - c.z);

  return {
    naming,
    colliderTris: g.collider.tris.length,
    visibleTris: Math.round(visibleTris),
    nocolTris: Math.round(nocolTris),
    proxyTris: Math.round(proxyTris),
    proxyVisible,
    hitDist: hitDist === null ? null : +hitDist.toFixed(2),
    hitProp,
    approachFrom: +L.toFixed(2),
    startDist: +startDist.toFixed(2),
    endDist: +endDist.toFixed(2),
    minDist: +minDist.toFixed(2),
    blockedBy,
    blockDist: blockDist === null ? null : +blockDist.toFixed(2),
  };
});

await browser.close();

const namingBad = r.naming.filter((n) => n.got !== n.want);
// The map alone is 9,474 triangles; the tent must have added its own on top.
const colliderGrew = r.colliderTris > 9474;
// The tent is the only prop placed, so the collider is exactly the map plus the
// proxy — anything more means visual geometry leaked into it, which is the whole
// cost the proxy exists to avoid.
const proxyIsTheCollider = r.proxyTris > 0 && r.colliderTris === 9474 + r.proxyTris;
// And the proxy must cost the frame nothing: never drawn, never a shadow caster.
const proxyHidden = r.proxyVisible === 0;
// It is only worth the machinery if it is materially cheaper than the mesh.
const proxyCheaper = r.proxyTris < r.visibleTris / 2;
// The ray must have been stopped BY THE TENT, not by map geometry in the way.
const rayHitTent = r.hitProp === 'tent_01' && r.hitDist < r.approachFrom - 0.5;
// Walking into it must leave the player outside it, with the tent in front at
// the moment they got as close as they were going to get.
const walkStopped = r.minDist < r.startDist && r.blockedBy === 'tent_01';

console.log(`  collider triangles   ${r.colliderTris.toLocaleString()} (map 9,474 + tent proxy ${r.proxyTris.toLocaleString()})`);
console.log(`  tent geometry        ${r.visibleTris.toLocaleString()} drawn + ${r.nocolTris.toLocaleString()} _nocol, none of it collided`);
console.log(`  proxy drawn/casting  ${r.proxyVisible} instances (want 0)`);
console.log(`  ray at tent          hit "${r.hitProp}" at ${r.hitDist} m into a ${r.approachFrom} m approach`);
console.log(`  walked into tent     ${r.startDist} m -> closest ${r.minDist} m from centre (rested at ${r.endDist} m)`);
console.log(`  blocked by           "${r.blockedBy}" at ${r.blockDist} m when closest`);
console.log(`  naming convention    ${r.naming.length - namingBad.length}/${r.naming.length} correct`);
for (const n of namingBad) console.log(`     WRONG "${n.name}": got ${n.got}, want ${n.want}`);
if (errs.length) console.log('  page errors:', errs.slice(0, 3));

const ok = !namingBad.length && colliderGrew && proxyIsTheCollider && proxyHidden
  && proxyCheaper && rayHitTent && walkStopped && !errs.length;
if (!ok) {
  console.log(`\n  colliderGrew=${colliderGrew} proxyIsTheCollider=${proxyIsTheCollider}`
    + ` proxyHidden=${proxyHidden} proxyCheaper=${proxyCheaper}`
    + ` rayHitTent=${rayHitTent} walkStopped=${walkStopped}`);
}
console.log(ok ? '\nPROPS: PASS' : '\nPROPS: FAIL');
process.exit(ok ? 0 : 1);
