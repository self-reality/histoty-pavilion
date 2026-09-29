// One world, several games in it: the shooter and the fly-over are modes with
// the same standing, entered and left in the same world, and everyone else in
// it is a ghost.
//
//   node tests/modes.mjs        # needs `npm start` running on :5173
//
// 1) The boundary, read from the source: nothing in the world imports a mode,
//    and no mode imports another. main.mjs reaches them only by import().
// 2) ?mode=flyover boots straight into the fly-over: no gun, no targets, no
//    viewmodel layer, its own keys on the overlay.
// 3) The fly-over keeps the lens out of a wall it flies at.
// 4) Switching in place: fly-over -> shooter lands on the floor under the
//    camera and brings the gun; shooter -> fly-over takes all of it away again.
// 5) A ghost is seen and nothing else: not in the collider, not in reach of a
//    shot, not offered to E.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium } from 'playwright';

const r = {};

// ---- 1) The boundary --------------------------------------------------------
const SRC = new URL('../src/', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.mjs') ? [p] : [];
});
const imports = (text) => [...text.matchAll(/(?:from\s+|import\s*\(\s*)(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
r.boundary = [];
for (const file of files(SRC)) {
  const rel = relative(SRC, file);
  const own = rel.startsWith('modes/') ? rel.split('/')[1] : null;
  for (const spec of imports(readFileSync(file, 'utf8'))) {
    // The one way in: main.mjs's import() of a mode by its id, at runtime.
    if (!spec.startsWith('.') || spec.includes('${')) continue;
    const target = relative(SRC, join(file, '..', spec));
    if (!target.startsWith('modes/')) continue;
    const other = target.split('/')[1];
    if (own === null) r.boundary.push(`${rel} imports ${spec} — the world may not import a mode`);
    else if (other !== own) r.boundary.push(`${rel} imports ${spec} — a mode may not import another`);
  }
}
const main = readFileSync(join(SRC, 'main.mjs'), 'utf8');
r.dynamicOnly = /import\(`\.\/modes\/\$\{id\}\/index\.mjs`\)/.test(main);

// ---- The page ---------------------------------------------------------------
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errs = [];
const requests = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('request', (q) => requests.push(q.url()));
await page.goto('http://localhost:5173/?mode=flyover', { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.mode && !document.getElementById('playBtn').disabled, { timeout: 60000 });

// ---- 2) Booted into the fly-over --------------------------------------------
r.boot = await page.evaluate(() => {
  const g = window.game;
  return {
    mode: g.mode,
    weapon: g.weapon,
    viewmodel: !!g.app.root.findByName('vmCamera') || !!g.app.root.findByName('viewmodel'),
    targets: g.app.root.find((e) => /^target\d+$/.test(e.name)).length,
    vmLayer: !!g.app.scene.layers.getLayerByName('Viewmodel'),
    title: document.getElementById('title').textContent,
    keys: [...document.querySelectorAll('#controls .k')].map((k) => k.textContent),
    picked: document.querySelector('#modes .picked')?.dataset.mode,
    reach: g.actions.player === g.session.flyer,
  };
});
// The shooter's code was never fetched: a mode loads when it is entered.
r.shooterFetched = requests.some((u) => u.includes('/src/modes/shooter/'));

// ---- 3) Flying at a wall ------------------------------------------------------
r.wall = await page.evaluate(async () => {
  const g = window.game;
  const { Vec3 } = await import('playcanvas');
  const f = g.session.flyer;
  // Face each way in turn until a wall stands 4–25 m ahead, level with the lens.
  for (let yaw = 0; yaw < 360; yaw += 15) {
    const dir = new Vec3(-Math.sin(yaw * Math.PI / 180), 0, -Math.cos(yaw * Math.PI / 180));
    const hit = g.collider.raycast(f.pos, dir, 25);
    if (!hit || hit.dist < 4) continue;
    const start = f.pos.clone();
    f.yaw = yaw; f.pitch = 0;
    for (let i = 0; i < 60 * 6; i++) f.update(1 / 60, { forward: 1, strafe: 0, rise: 0, fast: false });
    // Where it stopped, measured square to the wall it flew at — it may have
    // slid along it, which is fine, but never closer than its clearance, and
    // never through: the same wall is still there.
    const toWall = hit.normal.clone().mulScalar(-1);
    const gap = g.collider.raycast(f.pos, toWall, 5);
    const flown = new Vec3().sub2(f.pos, start).dot(dir);
    return { wallAt: +hit.dist.toFixed(2), flown: +flown.toFixed(2), gap: gap && +gap.dist.toFixed(3),
             sameWall: !!gap && gap.tri === hit.tri || !!gap && Math.abs(gap.normal.dot(hit.normal)) > 0.99,
             clearance: f.clearance };
  }
  return null;
});

// ---- 4) Switching in place ----------------------------------------------------
r.toShooter = await page.evaluate(async () => {
  const g = window.game;
  const f = g.session.flyer;
  f.pos.y += 3;                                   // in the air, over the floor
  const from = { x: f.pos.x, y: f.pos.y, z: f.pos.z };
  const ground = g.collider.groundBelow(from.x, from.z, from.y, 500);
  await g.switchMode('shooter');
  const p = g.player.pos;
  return {
    mode: g.mode,
    weapon: !!g.weapon,
    targets: g.app.root.find((e) => /^target\d+$/.test(e.name)).length,
    vmLayer: !!g.app.scene.layers.getLayerByName('Viewmodel'),
    landed: Math.hypot(p.x - from.x, p.z - from.z) < 1e-6 && Math.abs(p.y - ground.y) < 1e-6,
    reach: g.actions.player === g.player,
    url: location.search,
  };
});
r.backToFly = await page.evaluate(async () => {
  const g = window.game;
  const eye = { x: g.player.pos.x, y: g.player.pos.y + g.player.eyeHeight, z: g.player.pos.z };
  await g.switchMode('flyover');
  const f = g.session.flyer;
  return {
    mode: g.mode,
    weapon: g.weapon,
    viewmodel: !!g.app.root.findByName('vmCamera') || !!g.app.root.findByName('viewmodel'),
    targets: g.app.root.find((e) => /^target\d+$/.test(e.name)).length,
    vmLayer: !!g.app.scene.layers.getLayerByName('Viewmodel'),
    fromEye: Math.hypot(f.pos.x - eye.x, f.pos.y - eye.y, f.pos.z - eye.z) < 1e-6,
    url: location.search,
  };
});

// ---- 5) A ghost -----------------------------------------------------------------
r.ghost = await page.evaluate(async () => {
  const g = window.game;
  const { Vec3 } = await import('playcanvas');
  const { meet } = await import('/src/presence.mjs');
  await g.switchMode('shooter');
  const p = g.player.pos;
  const before = g.collider.tris.length;
  const items = g.actions.items.length;
  // What a shot straight ahead meets, before and after someone stands in it.
  const eye = new Vec3(p.x, p.y + 1.2, p.z);
  const ahead = new Vec3(0, 0, -1);
  const aim = () => JSON.stringify([g.collider.raycast(eye, ahead, 50)?.dist ?? null, g.targets.query(eye, ahead, 50)?.dist ?? null]);
  const shotBefore = aim();
  // Another shooter two metres in front, looking back.
  g.presence.join('p2', { mode: 'shooter', body: 'walker' });
  g.presence.move('p2', new Vec3(p.x, p.y, p.z - 2), 180);
  const drawn = g.app.root.findByName('ghost:p2')?.findComponents('render').length ?? 0;
  const out = {
    drawn,
    colliderUnchanged: g.collider.tris.length === before,
    shotUnchanged: aim() === shotBefore,
    offeredToE: g.actions.items.length !== items,
    meets: g.presence.meets('p2', 'flyover'),
    pairs: ['shooter', 'flyover'].flatMap((a) => ['shooter', 'flyover'].map((b) => meet(a, b))),
  };
  g.presence.leave('p2');
  out.gone = !g.app.root.findByName('ghost:p2');
  return out;
});

await browser.close();

const ok = {
  boundary: r.boundary.length === 0 && r.dynamicOnly,
  boot: r.boot.mode === 'flyover' && r.boot.weapon === null && !r.boot.viewmodel && r.boot.targets === 0
    && !r.boot.vmLayer && r.boot.title === 'FLY-OVER' && r.boot.keys.includes('Space / C') && !r.boot.keys.includes('R')
    && r.boot.picked === 'flyover' && r.boot.reach && !r.shooterFetched,
  wall: !!r.wall && r.wall.gap !== null && r.wall.gap >= r.wall.clearance * 0.9 && r.wall.gap < r.wall.clearance + 0.2
    && r.wall.sameWall && r.wall.flown > r.wall.wallAt - 1,
  toShooter: r.toShooter.mode === 'shooter' && r.toShooter.weapon && r.toShooter.targets > 0 && r.toShooter.vmLayer
    && r.toShooter.landed && r.toShooter.reach && r.toShooter.url === '',
  backToFly: r.backToFly.mode === 'flyover' && r.backToFly.weapon === null && !r.backToFly.viewmodel
    && r.backToFly.targets === 0 && !r.backToFly.vmLayer && r.backToFly.fromEye && r.backToFly.url === '?mode=flyover',
  ghost: r.ghost.drawn > 0 && r.ghost.colliderUnchanged && r.ghost.shotUnchanged && !r.ghost.offeredToE
    && r.ghost.meets === 'ghost' && r.ghost.pairs.every((m) => m === 'ghost') && r.ghost.gone,
  errors: errs.length === 0,
};
console.log(JSON.stringify(r, null, 2));
if (errs.length) console.log('page errors:', errs);
for (const [k, v] of Object.entries(ok)) console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`);
const pass = Object.values(ok).every(Boolean);
console.log(pass ? 'MODES: PASS' : 'MODES: FAIL');
process.exit(pass ? 0 : 1);
