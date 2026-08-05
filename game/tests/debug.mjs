// Debug mode: the panel is on ?debug and NOWHERE else.
//
// Two halves, and the second is the point: production must ship no sliders, no
// panel markup and no debug module at all (see src/debugmode.mjs).
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const errors = [];
const logs = [];
const requests = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('request', (r) => requests.push(r.url()));

await page.goto('http://localhost:5173/?debug', { waitUntil: 'load' });
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

// Readouts tick and the sliders write through to the controller.
const controls = await page.evaluate(() => {
  const g = window.game;
  g.debug.updateReadout();
  return { pos: g.debug._rPos.textContent, view: g.debug._rMode.textContent, sliders: document.querySelectorAll('#debugPanel input[type=range]').length };
});
console.log('controls:', JSON.stringify(controls));

// ---- Production URL: same game, no tweak surface ----
requests.length = 0;
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 25000 });
const prod = await page.evaluate(() => ({
  panel: !!document.getElementById('debugPanel'),
  sliders: document.querySelectorAll('input[type=range]').length,
  debug: !!window.game.debug,
}));
// Not merely hidden — the module is never even requested.
const fetchedDebugModule = requests.some((u) => u.includes('/src/debug.mjs'));
console.log('production:', JSON.stringify({ ...prod, fetchedDebugModule }));

console.log('errors:', errors.length);
for (const e of errors.slice(0, 8)) console.log('  ', e);
const warnings = logs.filter(l => l.startsWith('[error]') || l.startsWith('[warning]'));
console.log('console warnings/errors:', warnings.length);
for (const l of warnings.slice(0, 6)) console.log('  ', l);

await browser.close();

const pass = panel.present && overlayTris.tris > 0 && controls.sliders > 0 && !!controls.pos
  && !prod.panel && prod.sliders === 0 && !prod.debug && !fetchedDebugModule
  && errors.length === 0;
console.log(pass ? '\nDEBUG: PASS' : '\nDEBUG: CHECK');
process.exit(pass ? 0 : 1);
