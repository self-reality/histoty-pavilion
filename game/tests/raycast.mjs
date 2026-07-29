// Proves the grid broadphase in TriangleCollider.raycast returns exactly what a
// sweep of every triangle returns.
//
//   node tests/raycast.mjs      # needs `npm start` running on :5173
//
// The reference sweep uses the same rayTriangle primitive the collider uses, so
// this isolates the one thing that changed: a mismatch can only mean the grid
// walk dropped a candidate or stopped early. Rays are aimed both from inside the
// level (the in-game case) and straight down (what findFloors does).
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.collider, { timeout: 60000 });

const result = await page.evaluate(async () => {
  const { rayTriangle } = await import('/src/collision.mjs');
  const pc = await import('playcanvas');
  const col = window.game.collider;
  const b = col.bounds;

  // Reference: every triangle, nearest hit wins.
  const brute = (o, d, maxDist) => {
    let best = maxDist, hit = null;
    for (let i = 0; i < col.tris.length; i++) {
      const t = col.tris[i];
      const dist = rayTriangle(o, d, t.a, t.b, t.c);
      if (dist > 0 && dist < best) { best = dist; hit = t; }
    }
    return hit ? best : null;
  };

  // Deterministic PRNG so a failure is reproducible.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const cases = [];
  // Random rays from inside the level, in every direction.
  for (let i = 0; i < 400; i++) {
    const o = new pc.Vec3(
      b.minx + rnd() * (b.maxx - b.minx),
      b.miny + rnd() * (b.maxy - b.miny),
      b.minz + rnd() * (b.maxz - b.minz));
    const d = new pc.Vec3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (d.length() < 1e-6) continue;
    d.normalize();
    cases.push([o, d, 300]);
  }
  // Straight down from above — the findFloors pattern (degenerate XZ direction).
  for (let i = 0; i < 200; i++) {
    const o = new pc.Vec3(
      b.minx + rnd() * (b.maxx - b.minx), b.maxy + 5,
      b.minz + rnd() * (b.maxz - b.minz));
    cases.push([o, new pc.Vec3(0, -1, 0), (b.maxy + 5 - b.miny) + 10]);
  }
  // Near-horizontal rays, which stress the DDA's cell stepping hardest.
  for (let i = 0; i < 200; i++) {
    const o = new pc.Vec3(
      b.minx + rnd() * (b.maxx - b.minx),
      b.miny + rnd() * (b.maxy - b.miny),
      b.minz + rnd() * (b.maxz - b.minz));
    const d = new pc.Vec3(rnd() * 2 - 1, (rnd() - 0.5) * 0.02, rnd() * 2 - 1);
    if (Math.hypot(d.x, d.z) < 1e-6) continue;
    d.normalize();
    cases.push([o, d, 300]);
  }
  // An origin outside the grid footprint — must fall back, not silently miss.
  for (let i = 0; i < 50; i++) {
    const o = new pc.Vec3(b.minx - 50 - rnd() * 20, b.miny + rnd() * (b.maxy - b.miny),
      b.minz + rnd() * (b.maxz - b.minz));
    const d = new pc.Vec3(1, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4);
    d.normalize();
    cases.push([o, d, 500]);
  }

  const mismatches = [];
  let hits = 0, gridMs = 0, bruteMs = 0;
  for (const [o, d, maxDist] of cases) {
    let t = performance.now();
    const g = col.raycast(o, d, maxDist);
    gridMs += performance.now() - t;
    t = performance.now();
    const ref = brute(o, d, maxDist);
    bruteMs += performance.now() - t;

    const gd = g ? g.dist : null;
    if (ref !== null) hits++;
    const agree = (gd === null && ref === null) || (gd !== null && ref !== null && Math.abs(gd - ref) < 1e-4);
    if (!agree && mismatches.length < 10) {
      mismatches.push({ o: [+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2)],
        d: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)], grid: gd, brute: ref });
    }
  }
  return {
    cases: cases.length, hits, mismatches,
    gridMsPerRay: +(gridMs / cases.length).toFixed(4),
    bruteMsPerRay: +(bruteMs / cases.length).toFixed(4),
    tris: col.tris.length,
  };
});

await browser.close();

console.log(`  rays cast          ${result.cases} (${result.hits} hit geometry) against ${result.tris.toLocaleString()} triangles`);
console.log(`  grid broadphase    ${result.gridMsPerRay} ms/ray`);
console.log(`  full sweep         ${result.bruteMsPerRay} ms/ray`);
console.log(`  speedup            ${(result.bruteMsPerRay / result.gridMsPerRay).toFixed(1)}x`);
if (result.mismatches.length) {
  console.log(`\n  MISMATCHES (${result.mismatches.length} shown):`);
  for (const m of result.mismatches) console.log('   ', JSON.stringify(m));
}
if (errs.length) console.log('\n  PAGE ERRORS:', errs);

const ok = result.mismatches.length === 0 && errs.length === 0 && result.hits > 0;
console.log(ok ? '\nRAYCAST: PASS' : '\nRAYCAST: FAIL');
process.exit(ok ? 0 : 1);
