// The player starts where the layout says, facing where it says.
//
//   node tests/spawn.mjs        # needs `npm start` running on :5173
//
// Four things can go wrong independently: the marker not being found at all
// (wrong name, wrong file, lost in the merge), the height being taken
// literally instead of dropped onto the floor, the rotation being decoded into
// the wrong bearing — and the quiet one, a spawn that is read perfectly and
// puts you inside a wall. The last is checked the only way it can be: put the
// player there, run the controller, and see where they are standing after.
//
// The fallback is checked too, because it is what every map without a marker
// gets: no `spawn*` in the layout must leave pickSpawn() in charge rather than
// dropping the player at the origin.
//
// Then the address bar: `?at=` and `?look=` each override only their own
// layer, a two-number `at` lands on the floor, junk is ignored, and the link
// the debug panel copies reopens the page on the same pose.
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
  const { markerSpawn, pickSpawn, findFloors } = await import('/src/world.mjs');
  const { manifest } = await import('/scene.manifest.mjs');
  const { Vec3, Quat } = await import('playcanvas');
  const g = window.game;
  const col = g.collider;

  // The layout the game loaded, merged the way the loader merges it: a
  // Blender-authored marker shadows a hand-written one of the same name.
  const byName = new Map((manifest.markers ?? []).map((m) => [m.name, m]));
  const res = await fetch(manifest.placements, { cache: 'no-store' });
  if (res.ok) for (const m of (await res.json()).markers ?? []) byName.set(m.name, m);
  const authored = [...byName.values()].find((m) => /^spawn(?:[._-]|$)/i.test(m.name)) ?? null;

  const floorAt = (x, z) => {
    const top = col.bounds.maxy + 5;
    const hit = col.raycast(new Vec3(x, top, z), new Vec3(0, -1, 0), (top - col.bounds.miny) + 10);
    return hit ? hit.point.y : null;
  };

  // 1) Naming. `spawn`, `spawn_01` and Blender's `.001` duplicate are the
  // spawn; a prop that merely starts with those letters is not.
  const naming = [
    ['spawn', true], ['spawn_01', true], ['spawn.001', true], ['SPAWN_02', true],
    ['spawner_01', false], ['spawnpoint', false], ['crate_01', false], ['', false],
  ].map(([name, want]) => ({
    name, want, got: markerSpawn([{ name, pos: [0, 0, 0] }], col) !== null,
  }));

  // 2) The height is a hint: the same marker at ankle, waist and head height
  // over one spot all resolve to that spot's floor. A marker out over the void
  // keeps the height it was authored with — there is nothing better to say.
  const [mx, mz] = authored ? [authored.pos[0], authored.pos[2]] : [g.player.spawn.x, g.player.spawn.z];
  const floor = floorAt(mx, mz);
  const dropped = [0.1, 0.9, 1.7].map((dy) => markerSpawn([{ name: 'spawn_probe', pos: [mx, floor + dy, mz] }], col).y);
  const overTheVoid = markerSpawn([{ name: 'spawn_probe', pos: [col.bounds.minx - 50, 7, col.bounds.minz - 50] }], col);

  // 3) The rotation is a bearing. Player.yaw is degrees about Y with 0 looking
  // down -Z, so a marker built from that same yaw has to come back as it.
  const q = (yaw, pitch = 0) => {
    const out = new Quat().setFromEulerAngles(pitch, yaw, 0);
    return [out.x, out.y, out.z, out.w];
  };
  const wrap = (a) => ((a + 180) % 360 + 360) % 360 - 180;
  const yaws = [0, 45, 90, 180, -90].map((yaw) => ({
    yaw, got: markerSpawn([{ name: 'spawn_probe', pos: [mx, floor, mz], rot: q(yaw) }], col).yaw,
  }));
  // Tilt the marker off horizontal and the bearing must survive it; the player
  // cannot pitch their body, so the tilt is simply dropped.
  const tilted = markerSpawn([{ name: 'spawn_probe', pos: [mx, floor, mz], rot: q(90, 35) }], col).yaw;
  // Hand-written entries may carry euler degrees instead of a quaternion.
  const fromEuler = markerSpawn([{ name: 'spawn_probe', pos: [mx, floor, mz], euler: [0, 123, 0] }], col).yaw;

  // 4) No marker, no marker spawn — the caller must fall back rather than be
  // handed a point at the origin.
  const noMarkers = markerSpawn([], col);
  const otherMarkers = markerSpawn([{ name: 'painting_01', pos: [0, 0, 0] }], col);
  const fallback = pickSpawn(g.player.floors ?? findFloors(col), col.bounds);

  // 5) It is somewhere you can stand. Put the player at the spawn the game
  // actually resolved, run the controller with no input, and see where they
  // end up: a spawn in a wall slides away from where it was asked for, and one
  // in the air never grounds.
  const spawn = g.player.spawn;
  g.player.teleport(spawn.x, spawn.y, spawn.z);
  const still = { forward: 0, strafe: 0, jump: false, sprint: false };
  for (let i = 0; i < 120; i++) g.player.update(1 / 60, still);
  const rest = { x: g.player.pos.x, y: g.player.pos.y, z: g.player.pos.z, grounded: g.player.grounded };

  return {
    authored: authored && { name: authored.name, pos: authored.pos },
    spawn,
    naming,
    floor, dropped, overTheVoid,
    yaws: yaws.map((y) => ({ ...y, off: Math.abs(wrap(y.got - y.yaw)) })),
    tilted, fromEuler,
    fellBack: { noMarkers, otherMarkers, fallback },
    rest,
    drift: Math.hypot(rest.x - spawn.x, rest.z - spawn.z),
  };
});

// ---- The address bar ---------------------------------------------------------
// Open the page at a pose the address names and read back where the player
// stands; the pose is a floor sample well away from the marker so a spawn that
// ignored the address would not pass by luck.
const start = await page.evaluate(() => {
  const g = window.game;
  const far = [...g.player.floors].sort((a, b) =>
    Math.hypot(b.x - g.player.spawn.x, b.z - g.player.spawn.z) - Math.hypot(a.x - g.player.spawn.x, a.z - g.player.spawn.z))[0];
  return { spawn: g.player.spawn, far };
});
const pose = { x: start.far.x, y: start.far.y + 0.15, z: start.far.z, yaw: 137, pitch: -12 };
const openAt = async (query) => {
  await page.goto(`http://localhost:5173/${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.game && window.game.collider, { timeout: 60000 });
  return page.evaluate(async () => {
    const { spawnUrl, urlSpawn } = await import('/src/spawn.mjs');
    const p = window.game.player;
    // The controller has been running since the map came up, so the feet have
    // settled onto the floor: the resolved spawn is exact, the feet are near it.
    return {
      x: p.spawn.x, y: p.spawn.y, z: p.spawn.z, yaw: p.spawn.yaw, pitch: p.spawn.pitch, name: p.spawn.name,
      feet: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      link: spawnUrl(p),
      junk: urlSpawn('?at=1,2,x&look=north', window.game.collider),
      tooSteep: urlSpawn('?look=0,400', window.game.collider).pitch,
    };
  });
};
const fmt = (v) => v.toFixed(2);
const settled = (r) => Math.hypot(r.feet.x - r.x, r.feet.z - r.z) < 0.3 && Math.abs(r.feet.y - r.y) < 0.5;
const full = await openAt(`?at=${fmt(pose.x)},${fmt(pose.y)},${fmt(pose.z)}&look=${pose.yaw},${pose.pitch}&debug`);
const planOnly = await openAt(`?at=${fmt(pose.x)},${fmt(pose.z)}`);
const lookOnly = await openAt(`?look=${pose.yaw}`);
const junk = await openAt('?at=1,2,x&look=north');
// The copied link reopens the page on the same pose, `debug` and all.
const reopened = await openAt(full.link.slice(full.link.indexOf('?')));

const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) < tol;
const samePose = (a, b, tol = 0.011) => near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.z, b.z, tol);
const urlFull = samePose(full, pose) && near(full.yaw, pose.yaw, 0.01) && near(full.pitch, pose.pitch, 0.01)
  && settled(full);
const urlPlan = near(planOnly.x, pose.x, 0.011) && near(planOnly.z, pose.z, 0.011) && near(planOnly.y, pose.y, 0.02)
  && near(planOnly.yaw, start.spawn.yaw, 1e-6) && settled(planOnly);   // bearing untouched
const urlLook = samePose(lookOnly, start.spawn) && near(lookOnly.yaw, pose.yaw, 0.01) && lookOnly.pitch === 0;
const urlJunk = samePose(junk, start.spawn) && near(junk.yaw, start.spawn.yaw, 1e-6) && junk.junk === null
  && junk.tooSteep === 89 && junk.name === start.spawn.name;
// The link is where the feet came to rest, which is where the next page's
// feet come to rest too — within a settle of each other.
const urlLink = /[?&]debug(&|$)/.test(full.link) && samePose(reopened.feet, full.feet, 0.3)
  && near(reopened.yaw, full.yaw, 0.06) && near(reopened.pitch, full.pitch, 0.06);
const namingBad = r.naming.filter((n) => n.got !== n.want);

// The marker the layout carries is the one the game started from — name and
// position both, so a spawn that merely happens to be nearby does not pass.
const usedMarker = r.authored !== null
  && r.spawn.name === r.authored.name
  && near(r.spawn.x, r.authored.pos[0], 0.01) && near(r.spawn.z, r.authored.pos[2], 0.01);
// Authored at ankle, waist or head height, the spawn lands on the same floor.
const heightIsAHint = r.floor !== null
  && r.dropped.every((y) => near(y, r.floor + 0.15, 1e-6));
const voidKeepsItsHeight = near(r.overTheVoid?.y, 7, 1e-6);
const bearings = r.yaws.every((y) => y.off < 1e-6) && Math.abs(r.tilted - 90) < 1e-6
  && Math.abs(r.fromEuler - 123) < 1e-6;
const fellBack = r.fellBack.noMarkers === null && r.fellBack.otherMarkers === null
  && r.fellBack.fallback && Number.isFinite(r.fellBack.fallback.x);
// Standing room: the capsule stayed where it was put and found the ground.
const standable = r.rest.grounded && r.drift < 0.3;

console.log(`  marker in the layout ${r.authored ? `${r.authored.name} @ ${r.authored.pos.map((v) => v.toFixed(2)).join(', ')}` : 'NONE'}`);
console.log(`  game started from    ${r.spawn.name ?? '(no marker — map centre)'} @ ${r.spawn.x.toFixed(2)}, ${r.spawn.y.toFixed(2)}, ${r.spawn.z.toFixed(2)} facing ${r.spawn.yaw?.toFixed(1) ?? '—'}°`);
console.log(`  height is a hint     floor ${r.floor?.toFixed(2)} m; authored at +0.1/+0.9/+1.7 -> ${r.dropped.map((y) => y.toFixed(2)).join(' / ')}`);
console.log(`  over the void        kept its authored ${r.overTheVoid?.y.toFixed(2)} m`);
console.log(`  bearings             ${r.yaws.map((y) => `${y.yaw}°->${y.got.toFixed(1)}`).join('  ')}; tilted ${r.tilted.toFixed(1)}°, from euler ${r.fromEuler.toFixed(1)}°`);
console.log(`  without a marker     ${r.fellBack.noMarkers === null && r.fellBack.otherMarkers === null ? 'null' : 'SOMETHING'}, pickSpawn @ ${r.fellBack.fallback.x.toFixed(2)}, ${r.fellBack.fallback.y.toFixed(2)}, ${r.fellBack.fallback.z.toFixed(2)}`);
console.log(`  standing room        rested ${r.drift.toFixed(2)} m from the spawn, grounded ${r.rest.grounded}`);
console.log(`  naming convention    ${r.naming.length - namingBad.length}/${r.naming.length} correct`);
console.log(`  ?at=x,y,z&look=y,p   ${fmt(full.x)}, ${fmt(full.y)}, ${fmt(full.z)} facing ${full.yaw.toFixed(1)}° pitched ${full.pitch.toFixed(1)}° (${full.name})`);
console.log(`  ?at=x,z              dropped to ${fmt(planOnly.y)} m (floor sample ${fmt(pose.y)}), still facing ${planOnly.yaw.toFixed(1)}°`);
console.log(`  ?look=yaw            ${lookOnly.name}: stayed at ${fmt(lookOnly.x)}, ${fmt(lookOnly.z)}, turned to ${lookOnly.yaw.toFixed(1)}°`);
console.log(`  junk in the address  ${junk.name ?? '(marker)'} @ ${fmt(junk.x)}, ${fmt(junk.z)}; pitch 400 -> ${junk.tooSteep}`);
console.log(`  copied link          ${full.link.slice(full.link.indexOf('?'))} -> reopened ${urlLink ? 'on the same pose' : 'ELSEWHERE'}`);
for (const n of namingBad) console.log(`     WRONG "${n.name}": got ${n.got}, want ${n.want}`);
if (errs.length) console.log('  page errors:', errs.slice(0, 3));

const ok = !namingBad.length && usedMarker && heightIsAHint && voidKeepsItsHeight
  && bearings && fellBack && standable && urlFull && urlPlan && urlLook && urlJunk && urlLink && !errs.length;
if (!ok) {
  console.log(`\n  usedMarker=${usedMarker} heightIsAHint=${heightIsAHint} voidKeepsItsHeight=${voidKeepsItsHeight}`
    + ` bearings=${bearings} fellBack=${fellBack} standable=${standable}`
    + ` urlFull=${urlFull} urlPlan=${urlPlan} urlLook=${urlLook} urlJunk=${urlJunk} urlLink=${urlLink}`);
}
console.log(ok ? '\nSPAWN: PASS' : '\nSPAWN: FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
