import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.weapon, { timeout: 25000 });
await page.evaluate(() => { document.getElementById('overlay').style.display = 'none'; });

// 1) Geometry hit + ammo + recoil: face around and full-auto for a fixed number
// of engine ticks. Counting ticks rather than milliseconds is what makes this
// deterministic — under software WebGL the page renders at ~5 fps, so a
// wall-clock window can elapse without the update loop running at all, and the
// burst would silently fire zero shots.
const before = await page.evaluate(() => ({ mag: window.game.weapon.mag, reserve: window.game.weapon.reserve }));
await page.evaluate(() => { window.game.player.yaw = 0; window.game.player.pitch = -6; });
await page.evaluate(() => new Promise((resolve, reject) => {
  const g = window.game;
  let ticks = 0;
  const done = (err) => { g.app.off('update', onUpdate); clearTimeout(bail); g.weapon.stopFire(); err ? reject(err) : resolve(); };
  const onUpdate = () => { if (++ticks >= 8) done(); };
  const bail = setTimeout(() => done(new Error(`update loop stalled after ${ticks} ticks`)), 20000);
  g.app.on('update', onUpdate);
  g.weapon.startFire();
}));
const after = await page.evaluate(() => ({
  mag: window.game.weapon.mag,
  holes: window.game.weapon.holes.length,
  fx: window.game.weapon.fx.length,
  punch: +window.game.weapon.punchX.toFixed(2),
}));

// 2) Direct geometry raycast in front of the camera.
const geo = await page.evaluate(() => {
  const g = window.game;
  const o = g.camera.getPosition().clone();
  const d = g.camera.forward.clone();
  const hit = g.collider.raycast(o, d, 300);
  return hit ? { dist: +hit.dist.toFixed(2), n: hit.normal.toString() } : null;
});

// 3) Target hit: aim at a target and fire one; expect score to rise.
const tgt = await page.evaluate(() => {
  const g = window.game;
  const scoreEl = document.getElementById('scoreVal');
  const t = g.targets.list.find(t => t.alive);
  if (!t) return { ok: false, why: 'no target' };
  // Put player a few metres from the target, looking at it.
  const c = t.center;
  g.player.teleport(c.x + 4, c.y - 0.85 + 1.62, c.z); // feet so eye ~ target centre height
  // Aim: compute yaw/pitch toward target centre from camera.
  const before = +scoreEl.textContent;
  // Build direction and test the manager query directly (deterministic).
  const o = { x: c.x + 4, y: c.y, z: c.z };
  const dx = c.x - o.x, dy = c.y - o.y, dz = c.z - o.z;
  const L = Math.hypot(dx, dy, dz);
  const dir = { x: dx / L, y: dy / L, z: dz / L };
  const ov = { x: o.x, y: o.y, z: o.z };
  const q = g.targets.query(ov, dir, 100);
  if (q) { q.target.onHit(dir); }
  return { ok: !!q, dist: q ? +q.dist.toFixed(2) : null, scoreBefore: before, scoreAfter: +scoreEl.textContent };
});

console.log('ammo before:', JSON.stringify(before));
console.log('after burst:', JSON.stringify(after));
console.log('geo raycast:', JSON.stringify(geo));
console.log('target test:', JSON.stringify(tgt));
console.log('errors:', errors.length, errors.slice(0, 5));

await page.screenshot({ path: '/tmp/dust2_fire.png' });
await browser.close();

const pass = before.mag === 30 && after.mag < 30 && after.punch > 0 && errors.length === 0;
console.log(pass ? '\nFIRE: PASS' : '\nFIRE: FAIL');
process.exit(pass ? 0 : 1);
