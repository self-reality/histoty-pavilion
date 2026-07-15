import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 25000 });

// 1) Resting jitter under the REAL game loop (rAF-driven, zero input at spawn).
const rest = await page.evaluate(async () => {
  const p = window.game.player;
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
  for (let i = 0; i < 60; i++) await new Promise(r => requestAnimationFrame(r)); // settle
  const ys = [];
  for (let i = 0; i < 120; i++) { ys.push(p.pos.y); await new Promise(r => requestAnimationFrame(r)); }
  return { spreadMm: +((Math.max(...ys) - Math.min(...ys)) * 1000).toFixed(2) };
});
console.log('rest jitter spread (mm):', rest.spreadMm);

// 2/3/4) Deterministic functional checks — step the controller synchronously
// (no rAF interleave), exactly like the hole-sweep does.
const fn = await page.evaluate(() => {
  const p = window.game.player;
  const dt = 1 / 60;
  const step = (input, n) => { for (let i = 0; i < n; i++) p.update(dt, input); };
  const ZERO = { forward: 0, strafe: 0, jump: false, sprint: false };

  // WALK: hold forward; expect real horizontal travel AND a smooth vertical
  // profile once settled onto flat floor — a big per-frame Δy in steady state is
  // the ground-glue jitter that reads as low FPS. (Measure the last 30 frames so
  // the initial descent off the spawn slope isn't counted as jitter.)
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z); p.yaw = 0;
  step(ZERO, 20);
  const w0 = { x: p.pos.x, z: p.pos.z };
  const wy = [];
  for (let i = 0; i < 60; i++) {
    p.update(dt, { forward: 1, strafe: 0, jump: false, sprint: false });
    wy.push(p.pos.y);
  }
  const walk = Math.hypot(p.pos.x - w0.x, p.pos.z - w0.z);
  let walkJitter = 0;
  for (let i = 31; i < wy.length; i++) walkJitter = Math.max(walkJitter, Math.abs(wy[i] - wy[i - 1]));

  // JUMP: from rest, one jump frame then settle; expect a real arc.
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
  step(ZERO, 20);
  const jy0 = p.pos.y; let peak = jy0;
  p.update(dt, { forward: 0, strafe: 0, jump: true, sprint: false });
  for (let i = 0; i < 45; i++) { p.update(dt, ZERO); if (p.pos.y > peak) peak = p.pos.y; }
  const jump = peak - jy0;

  // FREE-FALL: in open air the player must keep falling — the resting-hold must
  // never engage mid-air and freeze it.
  p.teleport(p.spawn.x, p.spawn.y + 40, p.spawn.z);
  const ff0 = p.pos.y; let airGroundedFrames = 0;
  for (let i = 0; i < 45; i++) { p.update(dt, ZERO); if (p.grounded) airGroundedFrames++; }
  const freefall = ff0 - p.pos.y;

  const holes = window.game.debug.sweep().holes.length;
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
  return { walk: +walk.toFixed(2), walkJitterMm: +(walkJitter * 1000).toFixed(1), jump: +jump.toFixed(2), freefall: +freefall.toFixed(2), airGroundedFrames, holes };
});
console.log('walk dist (m):', fn.walk, ' walk vertical jitter (mm):', fn.walkJitterMm, ' jump height (m):', fn.jump);
console.log('free-fall drop (m):', fn.freefall, ' spurious mid-air grounds:', fn.airGroundedFrames);
console.log('sweep holes (should be 0 on grid centers):', fn.holes);
console.log('errors:', errors.length, errors.slice(0, 5));

await browser.close();

const pass = rest.spreadMm < 15 && fn.walk > 2 && fn.walkJitterMm < 30 && fn.jump > 0.6 && fn.freefall > 3 && fn.airGroundedFrames === 0 && errors.length === 0;
console.log(pass ? '\nMOTION: PASS' : '\nMOTION: CHECK');
process.exit(pass ? 0 : 1);
