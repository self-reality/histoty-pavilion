// Falling out of the map puts you back where you fell, not at the spawn.
//
//   node tests/rescue.mjs       # needs `npm start` running on :5173
//
// The falls are real ones: the seam spots tests/seams.mjs reports, walked out
// of in 16 directions with ground-glue on, exactly as a player would. For every
// direction that drops through, the player has to come back within a couple
// of metres of the last place they stood — and be able to stand there.
//
// Two quieter things are checked alongside: a grounded frame with no floor
// under the capsule's centre (glue holding it over a crack by the rim) is not
// saved, and a spot that does not hold sends the next fall to the spawn
// instead of round the same hole forever.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.rescue, { timeout: 60000 });

const SPOTS = [
  { x: -28.34, z: -29.84 },
  { x: 36.55, z: -58.02 },
  { x: 30.29, z: -70.72 },
];

const r = await page.evaluate((SPOTS) => {
  const { player: p, collider: col, rescue } = window.game;
  const dt = 1 / 60;
  const ZERO = { forward: 0, strafe: 0, jump: false, sprint: false };
  const GO = { forward: 1, strafe: 0, jump: false, sprint: true };
  const step = (input) => { p.update(dt, input); rescue.update(); };
  const settle = (n = 30) => { for (let i = 0; i < n; i++) step(ZERO); };
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const here = () => ({ x: p.pos.x, y: p.pos.y, z: p.pos.z });

  // 1) Real falls through the seams.
  const falls = [];
  for (const s of SPOTS) {
    const gh = col.groundBelow(s.x, s.z, 40, 400);
    if (!gh) continue;
    for (let a = 0; a < 16; a++) {
      p.teleport(s.x, gh.y + 0.4, s.z);
      settle(15);
      if (!p.grounded) continue;
      p.yaw = a * 22.5; p.pitch = 0;
      let lastStood = here(), prevY = p.pos.y, rescuedAt = null;
      for (let i = 0; i < 300; i++) {
        step(GO);
        if (p.pos.y > prevY + 5) { rescuedAt = here(); break; }   // teleported up
        if (p.grounded) lastStood = here();
        prevY = p.pos.y;
      }
      if (!rescuedAt) continue;
      settle();
      falls.push({
        spot: `${s.x},${s.z}`, dir: a * 22.5,
        fromFall: +flat(rescuedAt, lastStood).toFixed(2),
        fromSpawn: +flat(rescuedAt, p.spawn).toFixed(1),
        standsAfter: p.grounded,
      });
    }
  }

  // 2) Grounded but nothing under the centre: not a save.
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
  settle();
  const before = { x: rescue.safe.x, y: rescue.safe.y, z: rescue.safe.z };
  p.pos.set(p.spawn.x, col.bounds.maxy + 10, p.spawn.z);
  p.grounded = true;
  rescue.update();
  const unsavedInAir = rescue.safe.y === before.y;

  // 3) A spot that does not hold: the second fall, with no standing in
  // between, goes to the spawn. Stood somewhere far from it first so the two
  // are told apart.
  const far = p.floors.reduce((best, f) => (flat(f, p.spawn) > flat(best, p.spawn) ? f : best));
  p.teleport(far.x, far.y + 0.15, far.z);
  settle();
  const safe = here();
  const drop = () => { p.pos.set(p.pos.x, col.bounds.miny - 30, p.pos.z); rescue.update(); return here(); };
  const first = drop();
  const second = drop();
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);

  return {
    falls, unsavedInAir,
    firstToSafe: +flat(first, safe).toFixed(2),
    secondToSpawn: +flat(second, p.spawn).toFixed(2),
    spawnToSafe: +flat(safe, p.spawn).toFixed(1),
  };
}, SPOTS);

for (const f of r.falls) {
  console.log(`spot ${f.spot} dir ${String(f.dir).padStart(5)}:  back ${f.fromFall} m from the fall`
    + ` (spawn is ${f.fromSpawn} m away), stands after: ${f.standsAfter}`);
}
console.log(`\ngrounded over nothing is not saved: ${r.unsavedInAir}`);
console.log(`spot that does not hold: first fall ${r.firstToSafe} m from it, second fall ${r.secondToSpawn} m from spawn`
  + ` (the two are ${r.spawnToSafe} m apart)`);
console.log('errors:', errors.length, errors.slice(0, 5));

await browser.close();
const pass = r.falls.length > 0
  && r.falls.every((f) => f.fromFall < 2 && f.standsAfter)
  && r.unsavedInAir
  && r.firstToSafe < 0.01 && r.secondToSpawn < 0.01 && r.spawnToSafe > 5
  && errors.length === 0;
console.log(pass ? '\nRESCUE: PASS' : '\nRESCUE: FAIL');
process.exit(pass ? 0 : 1);
