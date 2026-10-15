// A leveled prop is drawn as its object until the view wants finer, and only
// then is the finer file fetched and drawn — under the parts its script holds,
// so the screen it paints stays painted and the collider stays as it was.
//
//   node tests/levels.mjs       # needs `npm start` running on :5173
//
// The fixture is the life box (tests/fixtures/levels/): a copy of
// tests/fixtures/life/ with `life.lod0.glb` beside it — a byte copy of the
// object, which is all a level has to be here: the same nodes, materials and
// uvs — and its manifest packed by the kit's own tools/pack.mjs with
// `--levels '[0.3]'`. tests/fixtures/levels.placements.json stands it in the
// level once. The clock is held throughout, so which level is wanted is a
// pure function of where the camera is (src/levels.mjs), with no hysteresis.
//
// 1) Far: the object, and no request for the level file yet.
// 2) Close: level 1 — the `~level1` children on, the parts' own instances
//    hidden, the collider's triangles for the prop the same as before, the
//    canvas the script paints on the level's own material, and the script
//    still painting it; the lid, unlit and painted as plain colour, wears
//    its paint at the level and back at the object.
// 3) Far again: the object.
// 4) `&levels=off`: no level file is requested, however close.
// 5) `&level=1`: level 1, however far.
// And once with the clock left to run: near the box, the level comes by itself.
// No page error and no failed request throughout.
import { chromium } from 'playwright';

const LAYOUT = './tests/fixtures/levels.placements.json';
const NAME = 'life_lv';
const FAR = { x: -43.46, y: 1.6, z: 30, yaw: 0, pitch: -2 };
const CLOSE = { x: -43.46, y: 1.2, z: -2.6, yaw: 0, pitch: -20 };

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const errs = [];
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function open(extra = '') {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  const lod = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('requestfailed', (r) => errs.push(`${r.url()} failed: ${r.failure()?.errorText}`));
  page.on('request', (r) => { if (/\.lod\d+\.glb/.test(r.url())) lod.push(r.url()); });
  await page.goto(`http://localhost:5173/?mode=flyover&placements=${encodeURIComponent(LAYOUT)}${extra}`, { waitUntil: 'load' });
  await page.waitForFunction((name) => window.game?.clock && window.game.scripted.some((s) => s.label === name), NAME, { timeout: 120000 });
  await page.waitForLoadState('networkidle');
  return { page, lod };
}

// Stand the camera at a view, held, and draw one frame from there.
const at = (page, view) => page.evaluate(async ({ view, NAME }) => {
  const g = window.game;
  g.clock.release();
  await g.switchMode('flyover', view);
  g.clock.hold();
  await g.clock.step(0);
  const s = g.scripted.find((x) => x.label === NAME);
  const p = g.levels.props.find((x) => x.name === NAME);
  const root = s.root;
  const parts = root.findComponents('render').filter((rc) => !/~level\d+$/.test(rc.entity.name) && rc.entity !== root);
  const children = root.findComponents('render').filter((rc) => /~level1$/.test(rc.entity.name));
  return {
    level: s.level,
    at: p?.at ?? null,
    size: p?.size ?? null,
    stats: g.levels.stats(),
    childrenOn: children.length > 0 && children.every((rc) => rc.entity.enabled),
    children: children.length,
    baseShown: parts.flatMap((rc) => rc.meshInstances).filter((mi) => mi.visible).length,
    collides: g.collider.tris.filter((t) => t.prop === NAME).length,
  };
}, { view, NAME });

// ---- 1-3) far, close, far ------------------------------------------------------
{
  // Started far from it: the spawn is a step from where the box stands.
  const { page, lod } = await open('&at=-43.46,25');
  const placed = await page.evaluate((NAME) => ({
    collides: window.game.collider.tris.filter((t) => t.prop === NAME).length,
    registered: window.game.levels.props.map((p) => p.name),
  }), NAME);
  check(placed.registered.includes(NAME), `the prop is registered with the levels (${placed.registered})`);

  const far = await at(page, FAR);
  console.log(`  far: ${JSON.stringify(far)}`);
  check(far.level === 0 && far.at === 0, `far, the object is drawn (level ${far.level}, size ${far.size?.toFixed(3)})`);
  check(lod.length === 0, `far, no level file is requested (${lod.length})`);

  // The lid is unlit (KHR_materials_unlit, in both files): sealed from the
  // ambient as placed, then painted by the script as plain colour — the
  // texture held in the very diffuse the sealing zeroes. The level has to
  // wear it the same, and the object's own copy keep it.
  const lidOf = (page, which) => page.evaluate(({ NAME, which }) => {
    const s = window.game.scripted.find((x) => x.label === NAME);
    const mis = s.root.findComponents('render')
      .filter((rc) => (which === 'level') === /~level\d+$/.test(rc.entity.name))
      .flatMap((rc) => rc.meshInstances).filter((mi) => mi.material?.name === 'lid');
    const tex = window.__lidPaint;
    return mis.map((mi) => ({
      unlit: mi.material.useLighting === false,
      diffuse: [mi.material.diffuse.r, mi.material.diffuse.g, mi.material.diffuse.b],
      painted: !!tex && mi.material.diffuseMap === tex,
    }));
  }, { NAME, which });
  const sealed = await lidOf(page, 'base');
  await page.evaluate((NAME) => {
    const s = window.game.scripted.find((x) => x.label === NAME);
    window.__lidPaint = s.makeTexture('lid paint');
    s.paint('lid', window.__lidPaint, false);
  }, NAME);
  const paintedBase = await lidOf(page, 'base');
  check(sealed.length > 0 && sealed.every((m) => m.unlit && m.diffuse.every((v) => v === 0)),
    `the unlit lid is placed sealed from the ambient (${JSON.stringify(sealed)})`);
  check(paintedBase.every((m) => m.painted && m.diffuse.every((v) => v === 1)), `painted plain, the lid wears it (${JSON.stringify(paintedBase)})`);

  const close = await at(page, CLOSE);
  console.log(`  close: ${JSON.stringify(close)}`);
  check(close.level === 1 && close.at === 1, `close, level 1 is drawn (size ${close.size?.toFixed(3)})`);
  check(lod.length === 1 && /life\.lod0\.glb$/.test(lod[0]), `close, the level file is requested once (${lod})`);
  check(close.children > 0 && close.childrenOn, `the ~level1 children are on (${close.children})`);
  check(close.baseShown === 0, `the parts' own instances are hidden (${close.baseShown} shown)`);
  check(close.collides === placed.collides && close.collides > 0, `the collider holds the prop's triangles as before (${close.collides} vs ${placed.collides})`);
  const lidLevel = await lidOf(page, 'level');
  check(lidLevel.length > 0 && JSON.stringify(lidLevel) === JSON.stringify(paintedBase),
    `the level's lid wears the paint as the object's did, not sealed over it (${JSON.stringify(lidLevel)})`);

  // The canvas: on the level's own material, and painted still.
  const screen = await page.evaluate(async (NAME) => {
    const g = window.game;
    const s = g.scripted.find((x) => x.label === NAME);
    const owned = s.surfaces.get('screen') ?? [];
    const levelled = s.root.findComponents('render').filter((rc) => /~level1$/.test(rc.entity.name))
      .flatMap((rc) => rc.meshInstances).filter((mi) => mi.material?.name === 'screen');
    const tex = (m) => m.emissiveMap ?? m.diffuseMap ?? null;
    const before = levelled.map((mi) => tex(mi.material));
    const canvas = before[0]?.getSource?.() ?? null;
    const pixels = () => canvas?.getContext?.('2d')?.getImageData(0, 0, canvas.width, canvas.height).data.join(',') ?? null;
    const was = pixels();
    for (let i = 0; i < 5; i++) await g.clock.step(0.1);
    return {
      levelled: levelled.length,
      owned: levelled.every((mi) => owned.some((o) => o.mi === mi)),
      sameTexture: before.length > 0 && before.every((t) => t && t === tex(owned[0].material)),
      painting: was !== null && was !== pixels(),
    };
  }, NAME);
  console.log(`  screen: ${JSON.stringify(screen)}`);
  check(screen.levelled > 0 && screen.owned, 'the level\'s screen material is the copy\'s own, joined to its surface');
  check(screen.sameTexture, 'the canvas the script paints is on the level\'s screen');
  check(screen.painting, 'the script goes on painting it at the level');

  const back = await at(page, FAR);
  console.log(`  far again: ${JSON.stringify(back)}`);
  check(back.level === 0 && back.baseShown > 0 && !back.childrenOn, 'far again, the object is drawn and the level children are off');
  const lidBack = await lidOf(page, 'base');
  check(JSON.stringify(lidBack) === JSON.stringify(paintedBase), `far again, the object's lid still wears its paint (${JSON.stringify(lidBack)})`);
  check(lod.length === 1, `nothing is fetched again (${lod.length})`);
  await page.close();
}

// ---- 4) ?levels=off ------------------------------------------------------------
{
  const { page, lod } = await open('&levels=off');
  const close = await page.evaluate(async ({ view, NAME }) => {
    const g = window.game;
    await g.switchMode('flyover', view);
    g.clock.hold();
    await g.clock.step(0);
    await g.clock.step(0.1);
    return { enabled: g.levels.enabled, props: g.levels.props.length, level: g.scripted.find((x) => x.label === NAME).level };
  }, { view: CLOSE, NAME });
  check(!close.enabled && close.props === 0 && close.level === 0 && lod.length === 0,
    `?levels=off: nothing registered, nothing fetched, close up (${JSON.stringify(close)}, ${lod.length} requests)`);
  await page.close();
}

// ---- 4b) played, not held ------------------------------------------------------
// The spawn is a step from the box: once the layout is in, the level is
// fetched and drawn on a frame of its own, with nobody holding the clock.
{
  const { page, lod } = await open();
  const played = await page.waitForFunction((NAME) => window.game.levels.props.find((p) => p.name === NAME)?.at === 1, NAME, { timeout: 20000 })
    .then(() => true, () => false);
  const held = await page.evaluate(() => window.game.clock.held);
  check(played && !held && lod.length === 1, `played, the level arrives by itself near the box (${played}, ${lod.length} requests)`);
  await page.close();
}

// ---- 5) ?level=1 ---------------------------------------------------------------
{
  const { page } = await open('&level=1');
  const far = await at(page, FAR);
  check(far.level === 1 && far.baseShown === 0, `?level=1: level 1 from far away (${JSON.stringify(far)})`);
  await page.close();
}

await browser.close();
check(!errs.length, `no page errors or failed requests${errs.length ? `: ${errs.join(' | ')}` : ''}`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('OK — a level is fetched when the view wants it, drawn under the parts, and the screen stays painted');
