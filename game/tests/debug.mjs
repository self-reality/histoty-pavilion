import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));

await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.debug, { timeout: 25000 });
await page.evaluate(() => { document.getElementById('overlay').style.display = 'none'; });

// Panel is present and visible.
const panel = await page.evaluate(() => {
  const p = document.getElementById('debugPanel');
  return { present: !!p, hidden: p.classList.contains('dbg-hidden'), buttons: p.querySelectorAll('button').length };
});
console.log('panel:', JSON.stringify(panel));

// Cycle every view mode and screenshot the collision-normals overlay.
for (const m of [0, 1, 2]) {
  await page.evaluate((mode) => window.game.debug.setMode(mode), m);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `/tmp/dust2_view_${m}.png` });
}
const overlayTris = await page.evaluate(() => {
  const ov = window.game.debug._overlay;
  let n = 0;
  for (const rc of ov.findComponents('render')) for (const mi of rc.meshInstances) n += mi.mesh.primitive[0].count / 3;
  return { enabled: ov.enabled, tris: n };
});
console.log('normals overlay:', JSON.stringify(overlayTris));
await page.evaluate(() => window.game.debug.setMode(0));

// Run the automated hole-sweep.
const sweep = await page.evaluate(() => {
  const r = window.game.debug.sweep();
  return { tested: r.tested, holes: r.holes.length, sample: r.holes.slice(0, 8) };
});
console.log('sweep:', JSON.stringify(sweep));

// Fall tracking: drop the player into the void and confirm it gets logged.
const fell = await page.evaluate(async () => {
  const g = window.game;
  g.debug.clearFalls();
  const b = g.collider.bounds;
  // Stand on ground first so lastGround is set, then yank into the void.
  g.player.teleport(g.player.spawn.x, g.player.spawn.y, g.player.spawn.z);
  g.player.grounded = true;
  g.debug.track();
  g.player.teleport(g.player.spawn.x, b.miny - 10, g.player.spawn.z);
  g.player.grounded = false;
  g.player.vel.y = -20;
  g.debug.track();
  return { falls: g.debug.falls.length, log: g.debug.logText() };
});
console.log('fall-track:', JSON.stringify(fell));

console.log('errors:', errors.length);
for (const e of errors.slice(0, 8)) console.log('  ', e);
const fallLogs = logs.filter(l => /\[\[(FALL|SWEEP|FALLLOG)/.test(l));
console.log('debug console lines:', fallLogs.length);
for (const l of fallLogs.slice(0, 6)) console.log('  ', l);

await browser.close();

const pass = panel.present && overlayTris.tris > 0 && sweep.tested > 0 && fell.falls > 0 && errors.length === 0;
console.log(pass ? '\nDEBUG: PASS' : '\nDEBUG: CHECK');
process.exit(pass ? 0 : 1);
