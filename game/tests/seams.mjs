import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 25000 });

// XZ of the reported falls; the real floor height is found at runtime.
const SPOTS = [
  { x: -28.34, z: -29.84 },
  { x: 36.55, z: -58.02 },
  { x: 30.29, z: -70.72 },
];

const res = await page.evaluate((SPOTS) => {
  const p = window.game.player, col = window.game.collider;
  const dt = 1 / 60;
  const RAD2DEG = 180 / Math.PI;
  const ZERO = { forward: 0, strafe: 0, jump: false, sprint: false };
  const GO = { forward: 1, strafe: 0, jump: false, sprint: true };
  const orig = p._groundSnap.bind(p);

  // Stand on the real floor at the spot, then walk outward in 16 directions.
  // Count directions where the capsule drops through / off (fell) and can't
  // recover. Real floor = highest surface found from above at that XZ.
  const testSpot = (s, glueOn) => {
    p._groundSnap = glueOn ? orig : () => false;
    const gh = col.groundBelow(s.x, s.z, 40, 400);
    if (!gh) return { floorY: null, dirs: 0, fell: 0 };
    const floorY = gh.y;
    let dirs = 0, fell = 0;
    for (let a = 0; a < 16; a++) {
      const ang = a * Math.PI / 8;
      p.teleport(s.x, floorY + 0.4, s.z); p.vel.set(0, 0, 0);
      for (let i = 0; i < 15; i++) p.update(dt, ZERO);          // settle on real floor
      if (!p.grounded) continue;                                 // couldn't stand — skip
      dirs++;
      p.yaw = ang * RAD2DEG; p.pitch = 0;
      let thisFell = false;
      for (let i = 0; i < 55; i++) {
        p.update(dt, GO);
        if (p.pos.y < floorY - 3) { thisFell = true; break; }    // fell well below the floor
      }
      if (thisFell) fell++;
    }
    return { floorY: +floorY.toFixed(2), dirs, fell };
  };

  const out = SPOTS.map((s) => ({
    spot: `${s.x},${s.z}`,
    off: testSpot(s, false),
    on: testSpot(s, true),
  }));
  p._groundSnap = orig;
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
  return out;
}, SPOTS);

let offTotal = 0, onTotal = 0;
for (const r of res) {
  offTotal += r.off.fell; onTotal += r.on.fell;
  console.log(`spot ${r.spot}  (floorY ${r.on.floorY}):  glue OFF ${r.off.fell}/${r.off.dirs} dirs fell   ->   glue ON ${r.on.fell}/${r.on.dirs} dirs fell`);
}
console.log(`\nTOTAL directions that fell:  glue OFF ${offTotal}   ->   glue ON ${onTotal}`);
console.log('errors:', errors.length, errors.slice(0, 5));

await browser.close();
const pass = onTotal < offTotal && errors.length === 0;   // glue must reduce falls
console.log(pass ? '\nSEAMS: PASS (glue reduces the falls)' : '\nSEAMS: CHECK');
process.exit(pass ? 0 : 1);
