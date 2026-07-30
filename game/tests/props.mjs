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

  // 5) The tent has a doorway, and the doorway has to still work. A collision
  // proxy is a simplification, and the failure mode of simplifying a building
  // is sealing the way in — which reads as success on every check above, since
  // "the player was stopped by the tent" is exactly what a bricked-up entrance
  // does. A convex hull proxy did precisely this and passed 1)-4).
  // Walk at the tent from every direction; at least one has to get inside.
  //
  // Every distance here is derived from the prop's own measured footprint, not
  // from the numbers that happened to fit when this was written. The tent is
  // authored in Blender and gets rescaled; a hardcoded "8 m out, 2 m is inside"
  // silently stops meaning anything the moment someone drags the scale handle.
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  // Measured over the geometry that actually collides. Including `_nocol` here
  // would size the probe to the guy-ropes, which splay 17 m corner to corner —
  // three times the tent — and "inside" would become a radius you reach while
  // still standing against an outside wall. That is not a hypothetical: it made
  // this check pass against the sealed hull proxy it was written to catch.
  const bounds = (e) => {
    if (e.render) for (const mi of e.render.meshInstances) {
      if (isNonColliding(mi.node.name)) continue;
      for (const k of ['x', 'y', 'z']) {
        lo[k] = Math.min(lo[k], mi.aabb.center[k] - mi.aabb.halfExtents[k]);
        hi[k] = Math.max(hi[k], mi.aabb.center[k] + mi.aabb.halfExtents[k]);
      }
    }
    for (const ch of e.children) bounds(ch);
  };
  bounds(tent);
  const halfFootprint = Math.max(hi.x - lo.x, hi.z - lo.z) / 2;
  // Pitched to sit in the middle of the gap between the two outcomes, not at the
  // edge of one: walking in reaches 0.4 m of centre, being turned away at the
  // wall leaves you at 3.84 m, and 0.4x of a 6.35 m half-footprint is 2.54 m.
  // At 0.6x it was 3.81 m — technically still failing the sealed build, by 3 cm.
  const insideR = halfFootprint * 0.4;

  // Start from every walkable sample in a ring around the prop rather than from
  // one sample per compass bearing. findFloors lays samples on a fixed grid, so
  // a bearing sweep asks "is there ground exactly there?" and quietly skips the
  // bearings where the answer is no — including, on this map, the one the door
  // faces. Using the samples themselves as the starting set has no such gaps.
  // Outside the footprint *rectangle*, not outside a circle sized by its longer
  // side. The tent is 11.6 m across and 13.9 m long, so that circle also swept
  // up a metre of open ground off each narrow end — and on this map the door
  // faces down one of them. Every sample that could actually walk in sits about
  // 0.51 m off the box, so the circle ate exactly them: the check flipped to
  // FAIL on a tent a player still strolls into (verified: 0.29 m from centre),
  // purely because someone dragged the scale from 1.37 to 1.5.
  //
  // The margin is the capsule's own radius, and that is the principled choice
  // rather than a tuned one: bestApproach is a *minimum* over starts, so extra
  // starts can only ever help a tent that opens and can never rescue one that
  // is sealed — every approach to a sealed prop stops at the wall regardless of
  // where it began. So take the smallest margin that is still legal, which is
  // the one where the capsule does not begin already intersecting the prop.
  const clear = g.player.radius;
  const starts = g.player.floors.filter((f) => {
    const d = Math.hypot(f.x - c.x, f.z - c.z);
    const outside = f.x < lo.x - clear || f.x > hi.x + clear
                 || f.z < lo.z - clear || f.z > hi.z + clear;
    return outside && d < halfFootprint * 2.5;
  });

  let bestApproach = Infinity;
  for (const s of starts) {
    const from = Math.hypot(s.x - c.x, s.z - c.z);
    const steps = Math.ceil(from * 60);   // a second of walking per metre
    g.player.teleport(s.x, s.y + 0.2, s.z);
    g.player.yaw = Math.atan2(-(c.x - s.x), -(c.z - s.z)) * 180 / Math.PI;
    for (let i = 0; i < steps; i++) {
      g.player.update(1 / 60, { forward: 1, strafe: 0, jump: false, sprint: false });
      bestApproach = Math.min(bestApproach,
        Math.hypot(g.player.pos.x - c.x, g.player.pos.z - c.z));
    }
  }

  return {
    bestApproach: +bestApproach.toFixed(2),
    insideR: +insideR.toFixed(2),
    starts: starts.length,
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
// Scaled to the prop's own footprint, so this keeps meaning the same thing
// after someone resizes the tent in Blender.
const stillEnterable = r.bestApproach < r.insideR;
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
console.log(`  doorway still open   best approach ${r.bestApproach} m from centre over ${r.starts} start points (want < ${r.insideR})`);
console.log(`  naming convention    ${r.naming.length - namingBad.length}/${r.naming.length} correct`);
for (const n of namingBad) console.log(`     WRONG "${n.name}": got ${n.got}, want ${n.want}`);
if (errs.length) console.log('  page errors:', errs.slice(0, 3));

const ok = !namingBad.length && colliderGrew && proxyIsTheCollider && proxyHidden
  && proxyCheaper && stillEnterable && rayHitTent && walkStopped && !errs.length;
if (!ok) {
  console.log(`\n  colliderGrew=${colliderGrew} proxyIsTheCollider=${proxyIsTheCollider}`
    + ` proxyHidden=${proxyHidden} proxyCheaper=${proxyCheaper}`
    + ` stillEnterable=${stillEnterable}`
    + ` rayHitTent=${rayHitTent} walkStopped=${walkStopped}`);
}
console.log(ok ? '\nPROPS: PASS' : '\nPROPS: FAIL');
process.exit(ok ? 0 : 1);
