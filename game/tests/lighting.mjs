// Baked lighting: a tunnel is darker than the street, the sun still shines and
// shadows, props take their ambient from where they stand, and `?lighting=flat`
// is the game as it was. See src/lighting.mjs.
//
//   node tests/lighting.mjs            # the fixture bake (until the real one is named)
//   node tests/lighting.mjs --fixture  # the fixture bake, always
//   node tests/lighting.mjs --real     # the bake manifest.lighting.file names
//
// Needs `npm start` on :5173. The fixture (tests/fixtures/lighting/make.mjs,
// written to its out/ when missing) is a bake made without Blender: the map's
// lightmap 0.6 everywhere but 0.05 around TUNNEL, the probes 0.55 but 0.15
// there. The clock is held throughout and the views are the fly-over's, so a
// brightness is a pure function of where the camera is.
//
// 1) Baked, sun off: the tunnel floor reads under half the open floor.
// 2) Flat, sun off: it reads as bright — today's problem, and the switch.
// 3) Flat is today: the ambient and fill as they were, no lightmap, no SH,
//    the original map, and none of the bake's files asked for.
// 4) The sun is kept: on, shadowing, the map still lit by it, and brighter.
// 5) (real bake) The open floor is about as bright as it was flat.
// 6) Prop ambient: the life box in the tunnel takes a darker ambient than in
//    the open; its unlit lid none; moved into the open, the open's.
// 7) A level drawn carries its ambient (the levels fixture, close).
// 8) Unlit materials are untouched by either mode.
// 9) No page error, no failed request, no flat fallback in a baked run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { manifest } from '../scene.manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = 'tests/fixtures/lighting/out/fixture.lighting.json';
const real = process.argv.includes('--real') || (!process.argv.includes('--fixture') && manifest.lighting?.file);
if (!real && !fs.existsSync(path.join(HERE, '..', FIXTURE))) {
  execFileSync('node', [path.join(HERE, 'fixtures/lighting/make.mjs')], { stdio: 'inherit' });
}
const BAKE = real ? (manifest.lighting?.file ?? null) : FIXTURE;
if (!BAKE) { console.log('FAIL --real, and manifest.lighting.file names no bake'); process.exit(1); }
console.log(`bake: ${BAKE}`);

// Spec §4.1: PlayCanvas world, floor heights measured off the map.
const TUNNEL = [6.13, -3.2, -59.83];
const OPEN = [-8.87, 0.0, -17.83];
const DOWN = (p) => ({ x: p[0], y: p[1] + 1.6, z: p[2], yaw: 0, pitch: -70 });
const LIT_FILES = /\.lightmap\.png|\.probes\.bin|\.lit\.glb/;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  const errs = [], warns = [], requests = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('requestfailed', (r) => errs.push(`${r.url()} failed: ${r.failure()?.errorText}`));
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => {
    if (m.type() === 'warning' && /\[lighting\]|chunk/i.test(m.text())) warns.push(m.text());
    if (/\[lighting\]/.test(m.text())) console.log(`  console: ${m.text()}`);
  });
  await page.goto(`http://localhost:5173/?mode=flyover${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.game?.clock && !document.getElementById('playBtn').disabled, null, { timeout: 120000 });
  await page.waitForLoadState('networkidle');
  // The fixture's numbers are the bake's own: the manifest's contrast and
  // saturation (calibrated on the real bake) would lift its tunnel off them.
  if (!real) await page.evaluate(() => { window.game.lighting?.set('contrast', 1); window.game.lighting?.set('saturation', 1); });
  return { page, errs, warns, requests };
}

// Stand the camera at a view, held, draw one frame, and read the canvas's
// centre quarter back as mean linear-ish luminance (0..255, as shown).
const shoot = (page, view, { sun = true } = {}) => page.evaluate(async ({ view, sun }) => {
  const g = window.game;
  g.clock.release();
  await g.switchMode('flyover', view);
  g.clock.hold();
  g.app.root.findByName('sun').enabled = sun;
  await g.clock.step(0);
  const src = g.app.graphicsDevice.canvas;
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
  const w = c.width >> 1, h = c.height >> 1;
  const d = ctx.getImageData(w >> 1, h >> 1, w, h).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  g.app.root.findByName('sun').enabled = true;
  return s / (d.length / 4);
}, { view, sun });

// What the map, the lights and the unlit materials are, read off the scene.
const facts = (page) => page.evaluate(() => {
  const g = window.game;
  const map = g.app.root.findByName('map');
  const mapMis = map.findComponents('render').flatMap((rc) => rc.meshInstances);
  const sun = g.app.root.findByName('sun'), fill = g.app.root.findByName('fill');
  const a = g.app.scene.ambientLight;
  const all = g.app.root.findComponents('render').flatMap((rc) => rc.meshInstances);
  const notMap = all.filter((mi) => !mapMis.includes(mi));
  const unlit = notMap.filter((mi) => mi.material?.useLighting === false);
  return {
    container: g.app.assets.find('de_dust2', 'container')?.file?.url ?? null,
    ambient: [a.r, a.g, a.b],
    fill: { enabled: fill.enabled, intensity: fill.light.intensity },
    sun: { enabled: sun.enabled && sun.light.enabled, shadows: sun.light.castShadows },
    mapLightMapped: mapMis.filter((mi) => mi.material.lightMap).length,
    mapMis: mapMis.length,
    mapDynamic: mapMis.filter((mi) => mi.mask & 1).length,   // MASK_AFFECT_DYNAMIC
    propSH: notMap.filter((mi) => mi.material?.ambientSH).length,
    propParam: notMap.filter((mi) => mi.parameters['ambientSH[0]']).length,
    unlit: unlit.length,
    unlitTouched: unlit.filter((mi) => mi.material.lightMap || mi.material.ambientSH || mi.parameters['ambientSH[0]']
      || mi.material.diffuse.r || mi.material.diffuse.g || mi.material.diffuse.b).map((mi) => mi.material.name),
    lighting: g.lighting?.settings ?? null,
    baked: g.lighting?.baked ?? null,
  };
});

const results = {};

// ---- baked ---------------------------------------------------------------------
{
  const { page, errs, warns, requests } = await open(`&lighting=${encodeURIComponent(BAKE)}`);
  const f = await facts(page);
  check(f.baked === true, `the bake is applied (${JSON.stringify(f.lighting)})`);
  check(/\.lit\.glb$/.test(f.container ?? ''), `the map is the lit copy (${f.container})`);
  check(f.mapLightMapped === f.mapMis && f.mapMis > 0, `every map instance has the lightmap (${f.mapLightMapped}/${f.mapMis})`);
  check(!f.fill.enabled, 'the fill is off');

  // 1) and 4)
  const tunnel = await shoot(page, DOWN(TUNNEL), { sun: false });
  const open_ = await shoot(page, DOWN(OPEN), { sun: false });
  const openSun = await shoot(page, DOWN(OPEN), { sun: true });
  results.baked = { tunnel, open: open_, openSun };
  console.log(`  baked, sun off: tunnel ${tunnel.toFixed(1)}, open ${open_.toFixed(1)}, ratio ${(tunnel / open_).toFixed(3)}; open with sun ${openSun.toFixed(1)}`);
  check(tunnel / open_ < 0.5, `baked: the tunnel reads under half the open (${(tunnel / open_).toFixed(3)})`);
  check(f.sun.enabled && f.sun.shadows, 'baked: the sun is on and casts shadows');
  check(f.mapDynamic === f.mapMis, `baked: the map still takes the sun (MASK_AFFECT_DYNAMIC on ${f.mapDynamic}/${f.mapMis})`);
  check(openSun > open_ + 1, `baked: the open floor is brighter with the sun (${openSun.toFixed(1)} > ${open_.toFixed(1)})`);

  // 6) the life box, twice: in the tunnel and in the open, a metre up.
  const prop = await page.evaluate(async ({ TUNNEL, OPEN }) => {
    const g = window.game;
    // The levels fixture's copy of the box: its lid is KHR_materials_unlit.
    // Watched from far off, so its level stays unfetched and only the object is drawn.
    g.clock.release();
    await g.switchMode('flyover', { x: -1, y: 60, z: -40, yaw: 0, pitch: -10 });
    const place = (name, p) => g.loadProp({ name, glb: './tests/fixtures/levels/life.glb', manifest: './tests/fixtures/levels/life.manifest.json',
      pos: [p[0], p[1] + 1, p[2]], rot: [0, 0, 0, 1], scale: [1, 1, 1] });
    place('lt_tunnel', TUNNEL); place('lt_open', OPEN);
    for (let i = 0; i < 600 && ['lt_tunnel', 'lt_open'].some((n) => !g.scripted.some((s) => s.label === n)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    g.clock.hold();
    await g.clock.step(0);
    const read = (name) => {
      const root = g.scripted.find((s) => s.label === name).root;
      const mis = root.findComponents('render').flatMap((rc) => rc.meshInstances);
      const lit = mis.filter((mi) => mi.material.useLighting !== false);
      const unlit = mis.filter((mi) => mi.material.useLighting === false);
      return {
        lit: lit.length,
        stamped: lit.filter((mi) => mi.material.ambientSH && mi.parameters['ambientSH[0]']).length,
        c0: lit.map((mi) => Array.from(mi.parameters['ambientSH[0]']?.data ?? []).slice(0, 3)),
        unlit: unlit.length,
        unlitClean: unlit.every((mi) => !mi.material.ambientSH && !mi.parameters['ambientSH[0]']),
      };
    };
    const before = { tunnel: read('lt_tunnel'), open: read('lt_open') };
    // Into the open, beside the other one's spot (its own stamp, same probes).
    const root = g.scripted.find((s) => s.label === 'lt_tunnel').root;
    root.setPosition(OPEN[0], OPEN[1] + 1, OPEN[2]);
    await g.clock.step(0);
    return { ...before, moved: read('lt_tunnel') };
  }, { TUNNEL, OPEN });
  const c0 = (r) => lum(...(r.c0[0] ?? [NaN, NaN, NaN]));
  console.log(`  prop c0: tunnel ${c0(prop.tunnel).toFixed(3)}, open ${c0(prop.open).toFixed(3)}, moved ${c0(prop.moved).toFixed(3)}`);
  results.prop = { tunnel: c0(prop.tunnel), open: c0(prop.open) };
  check(prop.tunnel.lit > 0 && prop.tunnel.stamped === prop.tunnel.lit && prop.open.stamped === prop.open.lit,
    `every lit instance of both boxes is stamped (${prop.tunnel.stamped}/${prop.tunnel.lit}, ${prop.open.stamped}/${prop.open.lit})`);
  check(c0(prop.tunnel) < 0.5 * c0(prop.open), `the box in the tunnel takes under half the open's ambient (${(c0(prop.tunnel) / c0(prop.open)).toFixed(3)})`);
  check(prop.tunnel.unlit > 0 && prop.tunnel.unlitClean && prop.open.unlitClean, `the unlit lid has no SH and no stamp (${prop.tunnel.unlit} unlit)`);
  check(JSON.stringify(prop.moved.c0) === JSON.stringify(prop.open.c0), `moved into the open, the box takes the open's ambient in one frame (${JSON.stringify(prop.moved.c0[0])})`);

  // 8) unlit
  const f2 = await facts(page);
  check(f2.unlit > 0 && f2.unlitTouched.length === 0, `baked: ${f2.unlit} unlit instances untouched (${f2.unlitTouched})`);

  // Determinism of sample(): pure.
  const pure = await page.evaluate(() => {
    const l = window.game.lighting, a = new Float32Array(27), b = new Float32Array(27);
    l.sample(1.5, 0.3, -20, a); l.sample(40, 9, 30, b); l.sample(1.5, 0.3, -20, b);
    return Array.from(a).join() === Array.from(b).join();
  });
  check(pure, 'sample() is a pure function of the point');

  // The debug toggle: flat, then baked again.
  const toggled = await page.evaluate(async () => {
    const g = window.game, l = g.lighting;
    l.setMode('flat');
    await g.clock.step(0);
    const map = g.app.root.findByName('map').findComponents('render').flatMap((rc) => rc.meshInstances);
    const flat = { lm: map.filter((mi) => mi.material.lightMap).length, fill: g.app.root.findByName('fill').enabled,
      sh: g.app.root.findComponents('render').flatMap((rc) => rc.meshInstances).filter((mi) => mi.material?.ambientSH).length };
    l.setMode('baked');
    await g.clock.step(0);
    return { flat, back: map.filter((mi) => mi.material.lightMap).length, total: map.length };
  });
  check(toggled.flat.lm === 0 && toggled.flat.fill && toggled.flat.sh === 0 && toggled.back === toggled.total,
    `setMode flips flat and back (${JSON.stringify(toggled)})`);

  check(errs.length === 0, `baked: no page error or failed request (${errs.slice(0, 3)})`);
  check(warns.length === 0, `baked: no [lighting] or chunk warning (${warns.slice(0, 3)})`);
  check(requests.some((u) => /\.lightmap\.png/.test(u)) && requests.some((u) => /\.probes\.bin/.test(u)), 'baked: the lightmap and probes were fetched');
  await page.close();
}

// ---- flat ----------------------------------------------------------------------
{
  const { page, errs, requests } = await open('&lighting=flat');
  const f = await facts(page);
  const tunnel = await shoot(page, DOWN(TUNNEL), { sun: false });
  const open_ = await shoot(page, DOWN(OPEN), { sun: false });
  results.flat = { tunnel, open: open_ };
  console.log(`  flat, sun off: tunnel ${tunnel.toFixed(1)}, open ${open_.toFixed(1)}, ratio ${(tunnel / open_).toFixed(3)}`);
  check(tunnel / open_ > 0.8, `flat: the tunnel reads as bright as the open (${(tunnel / open_).toFixed(3)}) — the problem the bake fixes`);
  // 3) Today's numbers (main.mjs since bd5f1a5).
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  check(near(f.ambient, [0.68, 0.656, 0.618]), `flat: scene ambient as today (${f.ambient.map((v) => v.toFixed(3))})`);
  check(f.fill.enabled && Math.abs(f.fill.intensity - 0.75) < 1e-6, `flat: the fill is on at 0.75 (${JSON.stringify(f.fill)})`);
  check(f.mapLightMapped === 0 && f.propSH === 0 && f.propParam === 0, `flat: no lightmap, no SH, no stamp (${f.mapLightMapped}, ${f.propSH}, ${f.propParam})`);
  check(f.container === manifest.map.glb, `flat: the map is ${manifest.map.glb} (${f.container})`);
  check(!requests.some((u) => LIT_FILES.test(u) || /\.lighting\.json/.test(u)), 'flat: none of the bake\'s files is asked for');
  check(f.unlit > 0 && f.unlitTouched.length === 0, `flat: ${f.unlit} unlit instances untouched`);
  check(f.baked === false, 'flat: game.lighting says flat');
  check(errs.length === 0, `flat: no page error or failed request (${errs.slice(0, 3)})`);
  await page.close();
}

// ---- the default address, while the manifest names no bake: flat, quietly ----------
if (!manifest.lighting?.file) {
  const { page, errs, requests } = await open('');
  const f = await facts(page);
  check(f.baked === false && f.container === manifest.map.glb, 'default with no bake named: flat, the original map');
  check(!requests.some((u) => LIT_FILES.test(u) || /\.lighting\.json/.test(u)), 'default: none of the bake\'s files is asked for');
  check(errs.length === 0, `default: no page error or failed request (${errs.slice(0, 3)})`);
  await page.close();
}

// 5) balance, real bake only
if (real) {
  const r = results.baked.open / results.flat.open;
  check(r > 0.85 && r < 1.15, `balance: baked open within 15% of flat open (${r.toFixed(3)})`);

  // An instance takes one probe sample, at its box's centre. For the ground
  // (hundreds of metres across) that one point lights it all: if a new layout
  // or bake puts it in a tunnel or the rock, the whole ground goes dim. Every
  // instance over 20 m must read at least half the open floor's ambient.
  const { page, errs } = await open(`&lighting=${encodeURIComponent(BAKE)}`);
  const big = await page.evaluate(async ({ OPEN }) => {
    const g = window.game;
    g.clock.hold();
    await g.clock.step(0);
    const l = (a) => 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    const open = l(g.lighting.sample(OPEN[0], OPEN[1] + 1, OPEN[2], new Float32Array(27)));
    return g.app.root.findComponents('render').flatMap((rc) => rc.meshInstances)
      .filter((mi) => mi.parameters['ambientSH[0]'] && Math.max(mi.aabb.halfExtents.x, mi.aabb.halfExtents.z) > 10)
      .map((mi) => ({ name: mi.node.name, ratio: +(l(mi.parameters['ambientSH[0]'].data) / open).toFixed(3) }));
  }, { OPEN });
  check(big.length > 0 && big.every((b) => b.ratio >= 0.5), `large instances read open air (${JSON.stringify(big)})`);
  check(errs.length === 0, `large: no page error or failed request (${errs.slice(0, 3)})`);
  await page.close();
}

// ---- 7) levels carry the ambient ---------------------------------------------------
{
  const { page, errs } = await open(`&placements=${encodeURIComponent('./tests/fixtures/levels.placements.json')}&lighting=${encodeURIComponent(BAKE)}`);
  await page.waitForFunction(() => window.game.scripted.some((s) => s.label === 'life_lv'), null, { timeout: 60000 });
  const lv = await page.evaluate(async () => {
    const g = window.game;
    g.clock.release();
    await g.switchMode('flyover', { x: -43.46, y: 1.2, z: -2.6, yaw: 0, pitch: -20 });
    g.clock.hold();
    await g.clock.step(0);
    const s = g.scripted.find((x) => x.label === 'life_lv');
    const mis = s.root.findComponents('render').filter((rc) => /~level1$/.test(rc.entity.name)).flatMap((rc) => rc.meshInstances)
      .filter((mi) => mi.material.useLighting !== false);
    const out = new Float32Array(27);
    return {
      level: s.level,
      count: mis.length,
      ok: mis.filter((mi) => {
        const p = mi.parameters['ambientSH[0]']?.data;
        if (!p) return false;
        const c = mi.aabb.center;
        g.lighting.sample(c.x, c.y, c.z, out);
        return Array.from(out).every((v, i) => Math.abs(v - p[i]) < 1e-6);
      }).length,
    };
  });
  check(lv.level === 1 && lv.count > 0 && lv.ok === lv.count, `level 1's lit instances carry their own probe sample (${lv.ok}/${lv.count}, level ${lv.level})`);
  check(errs.length === 0, `levels: no page error or failed request (${errs.slice(0, 3)})`);
  await page.close();
}

// 10) The numbers INTEGRATE calibrates from.
console.log(`\nratios: ${JSON.stringify({
  bakedTunnelOverOpen: +(results.baked.tunnel / results.baked.open).toFixed(3),
  flatTunnelOverOpen: +(results.flat.tunnel / results.flat.open).toFixed(3),
  bakedOpenOverFlatOpen: +(results.baked.open / results.flat.open).toFixed(3),
  propTunnelC0: +results.prop.tunnel.toFixed(4),
  propOpenC0: +results.prop.open.toFixed(4),
})}`);

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
