import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const errors = [];
const logs = [];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage();
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', (r) => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

// WebGL availability
const webgl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return gl ? (gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(gl.RENDERER)) : 'NONE';
});
console.log('WebGL:', webgl);

// Wait for the game to reach a ready or error state.
let state = 'timeout';
try {
  await page.waitForFunction(() => {
    const btn = document.getElementById('playBtn');
    const load = document.getElementById('loading');
    return (btn && !btn.disabled) || (load && /Failed/i.test(load.textContent));
  }, { timeout: 25000 });
  state = 'resolved';
} catch (e) { state = 'timeout'; }

const loading = await page.$eval('#loading', el => el.textContent).catch(() => '(n/a)');
const btnText = await page.$eval('#playBtn', el => el.textContent).catch(() => '(n/a)');
const btnDisabled = await page.$eval('#playBtn', el => el.disabled).catch(() => true);

await page.screenshot({ path: '/tmp/dust2_smoke.png' });

// Reveal the rendered scene (camera renders at spawn even before pointer-lock).
await page.evaluate(() => {
  document.getElementById('overlay').style.display = 'none';
});
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/dust2_scene.png' });
const centerPx = await page.evaluate(() => {
  // sample a few pixels from the webgl canvas via a 2d copy
  const src = document.getElementById('app');
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
  const pts = {};
  for (const [name, fx, fy] of [['center',0.5,0.6],['low',0.5,0.85],['left',0.2,0.6],['right',0.8,0.6]]) {
    const d = ctx.getImageData(Math.floor(c.width*fx), Math.floor(c.height*fy), 1, 1).data;
    pts[name] = `rgb(${d[0]},${d[1]},${d[2]})`;
  }
  return pts;
});
console.log('--- scene pixels:', JSON.stringify(centerPx));

console.log('--- STATE:', state);
console.log('--- loading text:', JSON.stringify(loading));
console.log('--- playBtn:', JSON.stringify(btnText), 'disabled=', btnDisabled);
console.log('--- console logs (' + logs.length + '):');
for (const l of logs.slice(0, 40)) console.log('   ', l);
console.log('--- errors (' + errors.length + '):');
for (const e of errors) console.log('   ', e);

await browser.close();

const ok = btnDisabled === false && errors.length === 0;
console.log(ok ? '\nSMOKE: PASS' : '\nSMOKE: FAIL');
process.exit(ok ? 0 : 1);
