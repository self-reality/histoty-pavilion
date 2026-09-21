// An asset is a package: it brings its own hole, its own place to stand, its
// own collision and its own script, and all of them are where the asset is.
//
//   node tests/package.mjs      # needs `npm start` running on :5173
//
// The fixture is a well built by the asset kit's real pipeline
// (tests/fixtures/well/ — see the kit's test/fixtures/well_source.py for what
// was modelled): a kerb with a `_col` proxy, a ball on top, a shaft (`well_neg`)
// and a channel (`well_neg.001`) to cut out of the ground, and an L-shaped
// place to stand (`well_act`). Its script had an action added by hand — E spins
// the ball — which the kit's pack step kept.
//
// It is stood in the level by a layout of its own, named in the address bar,
// because a hole can only be cut at boot. And it is stood there TURNED a
// quarter about Y, so every check below is also a check that the volumes went
// where the asset went rather than where they were modelled. Where that is, is
// asked of the engine — the placed entity's world transform — not worked out
// again the way the game worked it out.
//
// It also pins the rule that a cutter cuts the MAP and only the map: the well's
// own kerb sits exactly on top of its own shaft, and comes through whole.
import { chromium } from 'playwright';

const LAYOUT = './tests/fixtures/package.placements.json';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errs = [];
const logs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (/\[negatives\]|\[actions\]|\[prop well_01\]|\[scene\]/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
await page.goto(`http://localhost:5173/?placements=${encodeURIComponent(LAYOUT)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.actions?.items.some((i) => i.name === 'well_01'), { timeout: 60000 });

const r = await page.evaluate(async () => {
  const g = window.game;
  const { Vec3 } = await import('playcanvas');
  const { matchNodes } = await import('/src/rig.mjs');
  const root = g.app.root.findByName('well_01');
  root.syncHierarchy();
  // A point in the asset's own space (glTF: y up), in the world.
  const world = (x, y, z) => root.getWorldTransform().transformPoint(new Vec3(x, y, z));
  const down = new Vec3(0, -1, 0);
  const floorUnder = (p) => g.collider.raycast(new Vec3(p.x, p.y + 1, p.z), down, 3)?.point.y ?? null;

  // ---- 1) the hole is where the well is -------------------------------------
  // The channel runs from 0.5 to 3.5 m off the well along the asset's -Z, 0.6 m
  // wide, from the ground down half a metre.
  const ground = {
    inChannel: floorUnder(world(0, 0, -2)),
    besideIt: floorUnder(world(1, 0, -2)),
    pastItsEnd: floorUnder(world(0, 0, -4)),
    // where the channel WOULD be had it been cut where it was modelled, unturned
    whereModelled: floorUnder(new Vec3(root.getPosition().x, 0, root.getPosition().z - 2)),
  };
  const cut = g.negatives.map((v) => ({ name: v.name, hits: v.hits }));

  // ---- 2) the volumes are neither seen nor felt --------------------------------
  const meshes = root.findComponents('render').flatMap((rc) => rc.meshInstances)
    .map((mi) => ({ name: mi.node.name, visible: mi.visible, shadow: mi.castShadow }));
  const own = g.collider.tris.filter((t) => t.prop === 'well_01');
  const lowest = Math.min(...own.flatMap((t) => [t.a.y, t.b.y, t.c.y]));
  const widest = Math.max(...own.flatMap((t) => [t.a, t.b, t.c]).map((p) => Math.hypot(p.x - root.getPosition().x, p.z - root.getPosition().z)));

  // ---- 2b) a cutter cuts the MAP, and nothing else -------------------------------
  // The well is the sharpest test of that there is: the bottom of its own kerb —
  // and of the kerb's collision proxy — lies exactly in the top face of its own
  // shaft, inside the shaft's radius. Anything that carved props would take a
  // 0.7 m disc out of both. So: what the prop gave the collider is what a fresh
  // read of the prop gives now, triangle for triangle and square metre for square
  // metre, and what it draws is what an untouched second copy of its GLB draws.
  const { propCollisionTriangles } = await import('/src/world.mjs');
  const areaOf = (ts) => ts.reduce((sum, t) => sum + 0.5 * new Vec3().cross(new Vec3().sub2(t.b, t.a), new Vec3().sub2(t.c, t.a)).length(), 0);
  const fresh = propCollisionTriangles(root);
  const drawnTris = (entity) => Object.fromEntries(entity.findComponents('render').flatMap((rc) => rc.meshInstances)
    .map((mi) => [mi.node.name, mi.mesh.primitive[0].count / 3]));
  const container = g.app.assets.find('./tests/fixtures/well/well.glb', 'container');
  const untouched = container.resource.instantiateRenderEntity();
  const intact = {
    collides: own.length, shouldCollide: fresh.length,
    area: areaOf(own), shouldBe: areaOf(fresh),
    drawn: drawnTris(root), shouldDraw: drawnTris(untouched),
  };
  untouched.destroy();

  // ---- 3) the area is where the well is, and it replaces the radius -------------
  const item = g.actions.items.find((i) => i.name === 'well_01');
  g.actions.items = [item];
  const stand = (p) => {
    g.player.teleport(p.x, 0, p.z);
    g.player.entity.setPosition(p.x, 0, p.z);
    g.actions.update(true);
    const o = g.actions.active;
    return o ? { name: o.item.name, action: o.action.name, via: o.area?.name ?? 'radius' } : null;
  };
  // The L: its corner is at asset (-2, -2 .. ) — see the fixture. In asset space
  // (x, z): the corner block around (-1.5, 1.5), arms out to (+1, 1.5) and (-1.5, -1.5),
  // and the notch around (1, -1).
  const reach = {
    corner: stand(world(-1.5, 0, 1.5)),
    arm: stand(world(1, 0, 1.5)),
    otherArm: stand(world(-1.5, 0, -1.5)),
    notch: stand(world(1.6, 0, -1.6)),          // 1.2 m from the kerb: inside any 2 m radius, outside the L
    far: stand(world(8, 0, 8)),
  };
  // The level draws its own for this copy: that one wins, and the asset's is set aside.
  g.actions.setAreas([{ name: 'act_level', target: 'well_01', shape: 'box', pos: [root.getPosition().x + 8, 1, root.getPosition().z + 8], scale: [1, 1, 1] }]);
  g.actions.items = [item];
  const levelWins = { inLevelArea: stand(world(0, 0, 0).add(new Vec3(8, 0, 8))), inOwnArea: stand(world(-1.5, 0, 1.5)) };
  g.actions.setAreas([]);
  g.actions.items = [item];

  // ---- 4) E sets its action off: a looped one is a switch -----------------------
  const s = item.script;
  const ball = matchNodes(root, 'well_ball*')[0];
  const angle = (p, q) => Math.acos(Math.min(1, Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w))) * 2 * 180 / Math.PI;
  const rest = ball.getLocalRotation().clone();
  stand(world(-1.5, 0, 1.5));
  const on = g.actions.trigger();
  for (let i = 0; i < 45; i++) s.update(1 / 30);              // 1.5 s: three quarters of a turn
  const turned = angle(ball.getLocalRotation(), rest);
  for (let i = 0; i < 300; i++) s.update(1 / 30);             // 10 s more: still going
  const stillOn = s.acting?.name ?? null;
  const off = g.actions.trigger();
  for (let i = 0; i < 20; i++) s.update(1 / 30);
  const home = angle(ball.getLocalRotation(), rest);

  return { ground, cut, meshes, lowest, widest, collides: own.length, intact, reach, levelWins, on, turned, stillOn, off, home, warnings: s.warnings };
});

await browser.close();
console.log(JSON.stringify(r, null, 2));
for (const l of logs) console.log('  ' + l);

const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };
if (errs.length) problems.push(`page errors: ${errs.join(' | ')}`);
want(!r.warnings.length, `script warnings: ${r.warnings.join(' | ')}`);
// 1
want(r.ground.inChannel === null || r.ground.inChannel < -0.4, `the ground is still there in the channel (y = ${r.ground.inChannel})`);
want(Math.abs(r.ground.besideIt) < 0.05, `the ground beside the channel is at ${r.ground.besideIt}`);
want(Math.abs(r.ground.pastItsEnd) < 0.05, `the ground past the channel's end is at ${r.ground.pastItsEnd}`);
want(Math.abs(r.ground.whereModelled) < 0.05, `the hole was cut where it was modelled, not where the well was turned to (y = ${r.ground.whereModelled})`);
for (const name of ['well_01/well_neg', 'well_01/well_neg.001']) {
  want(r.cut.find((v) => v.name === name)?.hits > 0, `${name} cut nothing: ${JSON.stringify(r.cut)}`);
}
// 2
for (const m of r.meshes.filter((x) => /_(neg|act)/.test(x.name))) want(!m.visible && !m.shadow, `${m.name} is drawn`);
want(r.meshes.filter((x) => /_(neg|act)/.test(x.name)).length === 3, `volume meshes in the GLB: ${r.meshes.map((m) => m.name)}`);
want(r.meshes.find((x) => x.name.startsWith('well_ball'))?.visible, 'the ball is not drawn');
want(r.collides > 0 && r.lowest > -0.01, `the prop collides down to y = ${r.lowest} — the shaft joined the collider`);
want(r.widest < 1.2, `the prop collides ${r.widest} m out from its centre — the area or the channel joined the collider`);
// 2b
want(r.intact.collides === r.intact.shouldCollide && Math.abs(r.intact.area - r.intact.shouldBe) < 1e-6,
  `a cutter cut the PROP's collision: ${r.intact.collides} triangles / ${r.intact.area.toFixed(3)} m2, `
  + `a fresh read gives ${r.intact.shouldCollide} / ${r.intact.shouldBe.toFixed(3)}`);
want(JSON.stringify(r.intact.drawn) === JSON.stringify(r.intact.shouldDraw),
  `a cutter cut the PROP's meshes: ${JSON.stringify(r.intact.drawn)} vs an untouched copy ${JSON.stringify(r.intact.shouldDraw)}`);
// 3
const viaOwn = (o) => o?.name === 'well_01' && o.action === 'spin' && o.via === 'well_01/well_act';
want(viaOwn(r.reach.corner) && viaOwn(r.reach.arm) && viaOwn(r.reach.otherArm), `inside the L: ${JSON.stringify(r.reach)}`);
want(r.reach.notch === null, `offered in the notch — the asset's area did not replace the radius: ${JSON.stringify(r.reach.notch)}`);
want(r.reach.far === null, 'offered from 11 m away');
want(r.levelWins.inLevelArea?.via === 'act_level' && r.levelWins.inOwnArea === null, `a level area did not replace the asset's: ${JSON.stringify(r.levelWins)}`);
// 4
want(r.on?.running === true && r.turned > 60, `E did not spin the ball: ${JSON.stringify([r.on, r.turned])}`);
want(r.stillOn === 'spin', `a looped action stopped by itself (${r.stillOn})`);
want(r.off?.running === false && r.home < 0.5, `a second E did not bring it home: ${JSON.stringify([r.off, r.home])}`);

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nOK — the well brought its hole, its place to stand, its collision and its action, and put them where it stood');
