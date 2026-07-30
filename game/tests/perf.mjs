// Perf report + budget check: what the browser is actually asked to do each frame.
//
//   node tests/perf.mjs          # needs `npm start` running on :5173
//
// It counts the real WebGL command stream (draw calls + triangles, split by
// render target, so the shadow pass is separated from the camera pass), prices
// the load-phase steps, and times the CPU-side game loop. Those numbers are
// hardware-independent, which is the point: absolute frame times measured in
// headless Chrome are dominated by its present path and are not trustworthy,
// but "how much work do we submit" is exact and is what a weak GPU chokes on.
//
// It then fails the build if the scene has grown past its budget. That is the
// whole reason this exists: cost creeps in one innocuous prop at a time, and
// nobody notices until the level is finished and slow.
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';
const [W, H] = (process.env.RES || '1920x1080').split('x').map(Number);

// The budget. Every number is a deliberate ceiling, not a measurement — raise
// one only when you have decided the cost is worth it.
const BUDGET = {
  // Target is a mid-range laptop on an integrated GPU, where draw-call
  // submission binds long before triangle throughput does.
  drawCalls: 250,
  // Generous next to today's ~82k: this catches a photogrammetry asset dropped
  // in raw, not ordinary growth.
  trianglesPerFrame: 400_000,
  // Per prop, so one heavy import can't quietly eat the whole frame budget.
  // tent_military.glb is 38.5k and sits just under this — it is the example of
  // an asset that should have been decimated, not the standard to aim for.
  propTriangles: 40_000,
  // Deliberately tight: this ships over a public link, and ~14MB of it today is
  // one tent. Hitting this ceiling is the signal to do texture compression.
  downloadMB: 20,
};

// Groups that are level or engine furniture rather than authored props.
const NOT_A_PROP = new Set(['map', 'player', 'sun', 'fill', 'vmLight', 'collisionOverlay']);

const browser = await chromium.launch({
  headless: true,
  // Real GPU (Metal on macOS) rather than SwiftShader, so shader compilation
  // and texture upload behave like a user's machine.
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

// Count the real WebGL command stream.
await page.addInitScript(() => {
  window.__gl = { calls: 0, tris: 0, blits: 0 };
  const p = WebGL2RenderingContext.prototype;
  const de = p.drawElements, da = p.drawArrays, bl = p.blitFramebuffer;
  const tally = (n) => { window.__gl.calls++; window.__gl.tris += n; };
  p.drawElements = function (m, c, ...r) { tally(c / 3); return de.call(this, m, c, ...r); };
  p.drawArrays = function (m, f, c, ...r) { tally(c / 3); return da.call(this, m, f, c, ...r); };
  p.blitFramebuffer = function (...a) { window.__gl.blits++; return bl.apply(this, a); };
});

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => {
  const b = document.getElementById('playBtn');
  return b && !b.disabled;
}, { timeout: 60000 });
const playableMs = Date.now() - t0;
await page.waitForFunction(() => window.game && window.game.player, { timeout: 60000 });

// Park at spawn looking into the level, then let the props land and the shaders
// compile before anything is counted.
await page.evaluate(() => {
  document.getElementById('overlay').style.display = 'none';
  const g = window.game;
  g.player.teleport(g.player.spawn.x, g.player.spawn.y, g.player.spawn.z);
  g.player.yaw = 40;
  g.player.update(1 / 60, { forward: 0, strafe: 0, jump: false, sprint: false });
});
await page.waitForTimeout(6000);

// Split the frame by A/B rather than by guessing at framebuffer ids: count a
// full frame, then count one with the sun's shadow pass switched off. The
// difference IS the shadow pass.
const frame = await page.evaluate(async () => {
  const app = window.game.app;
  const n = 20;
  const count = () => {
    window.__gl.calls = 0; window.__gl.tris = 0; window.__gl.blits = 0;
    for (let i = 0; i < n; i++) app.render();
    app.graphicsDevice.gl.finish();
    return { calls: Math.round(window.__gl.calls / n), tris: Math.round(window.__gl.tris / n), blits: window.__gl.blits / n };
  };
  const sun = app.root.findByName('sun').light;
  const total = count();
  sun.castShadows = false;
  await new Promise((r) => setTimeout(r, 400));
  const noShadow = count();
  sun.castShadows = true;
  await new Promise((r) => setTimeout(r, 400));
  return {
    total,
    cameraPasses: noShadow,
    shadowPass: { calls: total.calls - noShadow.calls, tris: total.tris - noShadow.tris },
  };
});

const cpu = await page.evaluate(() => {
  const g = window.game;
  const med = (fn, n) => {
    const runs = [];
    for (let r = 0; r < 9; r++) { const t = performance.now(); for (let i = 0; i < n; i++) fn(); runs.push((performance.now() - t) / n); }
    runs.sort((a, b) => a - b);
    return +runs[4].toFixed(3);
  };
  const inp = { forward: 1, strafe: 0, jump: false, sprint: false };
  const o = g.camera.getPosition().clone(), d = g.camera.forward.clone();
  return {
    appUpdateMs: med(() => g.app.update(1 / 60), 50),
    playerUpdateMs: med(() => g.player.update(1 / 60, inp), 200),
    hitscanRaycastMs: med(() => g.collider.raycast(o, d, 300), 50),
  };
});

const load = await page.evaluate(async () => {
  const world = await import('/src/world.mjs');
  const col = await import('/src/collision.mjs');
  const mapRoot = window.game.app.root.findByName('map').children[0];
  const ms = (fn) => { const t = performance.now(); const v = fn(); return [+(performance.now() - t).toFixed(0), v]; };
  const [extractMs, tris] = ms(() => world.extractTriangles(mapRoot));
  const [buildMs, collider] = ms(() => new col.TriangleCollider(tris, 2.0));
  const [findFloorsMs, floors] = ms(() => world.findFloors(collider));
  return { extractMs, buildMs, findFloorsMs, colliderTris: tris.length, floorSamples: floors.length };
});

const scene = await page.evaluate(() => {
  const g = window.game;
  const rows = [];
  for (const c of g.app.root.children) {
    let mi = 0, casters = 0, tris = 0;
    const walk = (e) => {
      // Invisible instances (a `_col` collision proxy) are never submitted, so
      // counting them here would charge the frame budget for geometry the GPU
      // never sees — and the budget exists to track what the frame costs.
      if (e.render) for (const m of e.render.meshInstances) {
        if (!m.visible) continue;
        mi++; if (m.castShadow) casters++;
        const ib = m.mesh.indexBuffer && m.mesh.indexBuffer[0];
        tris += ib ? ib.numIndices / 3 : 0;
      }
      for (const x of e.children) walk(x);
    };
    walk(c);
    if (mi) rows.push({ group: c.name, meshInstances: mi, shadowCasters: casters, tris: Math.round(tris), enabled: c.enabled });
  }
  return rows.sort((a, b) => b.meshInstances - a.meshInstances);
});

const net = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter((r) => r.transferSize > 50000)
  .map((r) => ({ file: r.name.split('/').pop(), kb: Math.round(r.transferSize / 1024) }))
  .sort((a, b) => b.kb - a.kb));

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n  RESOLUTION            ${W}x${H} @ maxPixelRatio ${await page.evaluate(() => window.game.app.graphicsDevice.maxPixelRatio)}`);
console.log(`  TIME TO PLAYABLE      ${playableMs} ms (warm cache)`);
console.log(`\n  PER FRAME`);
for (const [k, v] of [['total', frame.total], ['  camera passes', frame.cameraPasses], ['  shadow map', frame.shadowPass]]) {
  console.log(`    ${pad(k, 22)} ${pad(v.calls + ' draw calls', 16)} ${v.tris.toLocaleString()} triangles`);
}
console.log(`    ${pad('fullscreen blits', 22)} ${frame.total.blits}`);
console.log(`\n  CPU PER FRAME`);
for (const [k, v] of Object.entries(cpu)) console.log(`    ${pad(k, 22)} ${v} ms`);
console.log(`\n  LOAD PHASE`);
for (const [k, v] of Object.entries(load)) console.log(`    ${pad(k, 22)} ${v}${k.endsWith('Ms') ? ' ms' : ''}`);
console.log(`\n  SCENE`);
for (const r of scene) {
  console.log(`    ${pad(r.group, 22)} ${pad(r.meshInstances + ' meshes', 14)} ${pad(r.shadowCasters + ' casters', 13)} ${pad(r.tris.toLocaleString() + ' tris', 14)}${r.enabled ? '' : ' (disabled)'}`);
}
const downloadMB = net.reduce((a, r) => a + r.kb, 0) / 1024;
console.log(`\n  DOWNLOAD`);
for (const r of net) console.log(`    ${pad(r.file, 22)} ${r.kb} KB`);
console.log(`    ${pad('total', 22)} ${downloadMB.toFixed(1)} MB`);
// `npm start` is python's http.server, which does not compress. A real host
// with gzip/brotli sends roughly half this — the engine alone goes 3.4 -> 0.5 MB.
// The budget is deliberately measured against these uncompressed bytes so it
// stays a property of the assets rather than of whoever is serving them.
console.log(`    ${pad('', 22)} (uncompressed — a host with brotli sends ~half)`);
if (errs.length) console.log('\n  PAGE ERRORS:', errs);

// ---- Budget ---------------------------------------------------------------
const checks = [
  ['draw calls / frame', frame.total.calls, BUDGET.drawCalls],
  ['triangles / frame', frame.total.tris, BUDGET.trianglesPerFrame],
  ['download', +downloadMB.toFixed(1), BUDGET.downloadMB, 'MB'],
];
for (const r of scene) {
  if (!NOT_A_PROP.has(r.group) && !/^target\d+$/.test(r.group)) {
    checks.push([`prop "${r.group}" triangles`, r.tris, BUDGET.propTriangles]);
  }
}

console.log(`\n  BUDGET`);
const over = [];
for (const [name, actual, cap, unit = ''] of checks) {
  const bad = actual > cap;
  if (bad) over.push(name);
  const bar = `${actual.toLocaleString()}${unit} / ${cap.toLocaleString()}${unit}`;
  console.log(`    ${bad ? 'OVER' : ' ok '}  ${pad(name, 28)} ${bar}  (${Math.round((actual / cap) * 100)}%)`);
}

if (over.length || errs.length) {
  console.log(`\nPERF: FAIL — over budget: ${over.join(', ') || 'none'}${errs.length ? `; ${errs.length} page error(s)` : ''}\n`);
} else {
  console.log('\nPERF: PASS\n');
}

await browser.close();
process.exit(over.length || errs.length ? 1 : 0);
