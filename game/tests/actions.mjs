// Walk up to something, see an E, press it: the script's actions, the reach,
// and the rule for which of several props the key belongs to. (An area an
// asset carries in place of the radius is tests/package.mjs's business.)
//
//   node tests/actions.mjs        # needs `npm start` running on :5173
//
// Two dancers are placed from the test, through the same loadProp the layout
// goes through, well away from wherever the .blend has put one today — so this
// checks the runtime rather than the current scene. Clips are driven by hand
// (script.update) and reach is asked for by hand (actions.update) wherever a
// number is being measured: under software WebGL the page renders at a few
// frames a second, and a test that waits on wall-clock frames measures that.
// The one thing that IS left to the real loop is the key: the game is told the
// pointer is locked, and an E goes in through the keyboard.
import { chromium } from 'playwright';

const ASSET = './assets/g-man-dance/g-man-dance';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errs = [];
const logs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (/\[actions\]/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player && window.game.actions, { timeout: 60000 });

// ---- Stage: two dancers on the open ground by the spawn, 3 m apart ----------
const stage = await page.evaluate(async (ASSET) => {
  const g = window.game;
  const { Vec3 } = await import('playcanvas');
  // Somewhere flat and open enough to stand two dancers 3 m apart and walk 9 m
  // back from them — found, not assumed, so the test does not care where the
  // level's props or its spawn are this week. Every metre of the patch has to
  // be floor at one height: a crate or a wall top reads as a step up.
  const down = new Vec3(0, -1, 0);
  const floorAt = (x, y, z) => g.collider.raycast(new Vec3(x, y + 1.5, z), down, 4)?.point.y ?? null;
  const flat = (f) => {
    for (let dx = -1; dx <= 4; dx++) {
      for (let dz = -1; dz <= 9; dz++) {
        const y = floorAt(f.x + dx, f.y, f.z + dz);
        if (y === null || Math.abs(y - f.y) > 0.2) return false;
      }
    }
    return true;
  };
  const placed = g.app.root.findByName('g-man-dance_01')?.getPosition();
  const spot = g.player.floors.find((f) => flat(f)
    && (!placed || Math.hypot(f.x - placed.x, f.z - placed.z) > 15));
  if (!spot) throw new Error('no flat 6 x 11 m patch of floor to stage the test on');
  const at = { x: spot.x, y: spot.y, z: spot.z };
  const place = (name, dx) => g.loadProp({
    name, glb: `${ASSET}.glb`, script: `${ASSET}.script.json`,
    pos: [at.x + dx, at.y, at.z], rot: [0, 0, 0, 1], scale: [0.02461, 0.02461, 0.02461],
  });
  place('dancer_a', 0);
  place('dancer_b', 3);
  const t0 = Date.now();
  while (g.actions.items.filter((i) => /^dancer_/.test(i.name)).length < 2) {
    if (Date.now() - t0 > 60000) throw new Error('timed out waiting for the dancers');
    await new Promise((r) => setTimeout(r, 100));
  }
  // Nothing else in the scene may answer the key while this runs.
  g.actions.items = g.actions.items.filter((i) => /^dancer_/.test(i.name));
  return at;
}, ASSET);

// Helpers that live in the page, for every step below.
await page.evaluate((stage) => {
  const g = window.game;
  const T = window.T = { stage };
  T.item = (name) => g.actions.items.find((i) => i.name === name);
  T.stand = (x, z, yaw = 0, pitch = 0) => {
    g.player.teleport(x, stage.y, z);
    g.player.yaw = yaw; g.player.pitch = pitch;
    // The controller writes yaw/pitch onto the entities in update(); do it here
    // so a measurement taken this instant sees the camera where it was put.
    g.player.entity.setPosition(x, stage.y, z);
    g.player.entity.setEulerAngles(0, yaw, 0);
    g.camera.setLocalEulerAngles(pitch, 0, 0);
    g.actions.update(true);
    return T.offers();
  };
  // Look from where the player stands at a prop's hint anchor.
  T.lookAt = (name) => {
    const a = T.item(name).anchor;
    const e = g.camera.getPosition();
    const yaw = Math.atan2(-(a.x - e.x), -(a.z - e.z)) * 180 / Math.PI;
    return T.stand(g.player.pos.x, g.player.pos.z, yaw, 0);
  };
  T.offers = () => ({
    names: g.actions.offers.map((o) => o.item.name).sort(),
    active: g.actions.active?.item.name ?? null,
    via: g.actions.active ? (g.actions.active.area?.name ?? 'radius') : null,
  });
  T.hint = (name) => {
    const el = T.item(name).hint;
    if (!el || el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    return {
      key: el.querySelector('.key').textContent, label: el.querySelector('.label').textContent,
      lit: el.classList.contains('active'), pinned: el.classList.contains('pinned'),
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    };
  };
  T.angle = (p, q) => {
    const d = Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w);
    return Math.acos(Math.min(1, d)) * 2 * 180 / Math.PI;
  };
}, stage);

const r = {};

// ---- 1) Reach: two metres from the prop, not from its origin ----------------
r.reach = await page.evaluate(() => {
  const { stage } = T;
  const far = T.stand(stage.x, stage.z + 6);
  const near = T.stand(stage.x, stage.z + 1.5, 0);         // yaw 0 looks down -Z: at him
  const hint = T.hint('dancer_a');
  const box = T.item('dancer_a');
  // Walk away until the offer drops, and report how far from his bounds that was.
  let edge = null;
  for (let d = 1.0; d < 5; d += 0.05) {
    if (!T.stand(stage.x, stage.z + d).names.includes('dancer_a')) { edge = d - (box.max.z - stage.z); break; }
  }
  return { far, near, hint, edge, height: box.max.y - box.min.y, radius: box.script.actions[0].radius };
});

// ---- 2) The state machine, and the ease in and out of it --------------------
r.machine = await page.evaluate(async () => {
  const g = window.game;
  const { matchNodes } = await import('/src/rig.mjs');
  const { EASE_SECONDS } = await import('/src/script.mjs');
  const item = T.item('dancer_a');
  const s = item.script;
  const arm = matchNodes(item.root, 'ValveBiped.Bip01_L_UpperArm*')[0];
  const pelvis = matchNodes(item.root, 'ValveBiped.Bip01_Pelvis*')[0];
  const tick = (seconds, step = 1 / 30) => { for (let t = 0; t < seconds - 1e-9; t += step) s.update(step); };
  T.stand(T.stage.x, T.stage.z + 1.5, 0);

  const rest = arm.getLocalRotation().clone();
  const restPelvis = pelvis.getLocalPosition().clone();
  const restFromBind = T.angle(rest, s.bind.get(arm).q);      // the script's pose is on
  const before = { acting: s.acting?.name ?? null, label: T.hint('dancer_a')?.label };

  const set = g.actions.trigger();
  s.update(1 / 60);
  const firstFrame = T.angle(arm.getLocalRotation(), rest);   // eased: still near rest
  tick(EASE_SECONDS + 0.1);
  g.actions.update(true);
  const dancing = {
    acting: s.acting?.name ?? null, label: T.hint('dancer_a')?.label,
    armFromRest: T.angle(arm.getLocalRotation(), rest), time: s.acting?.player.time,
  };
  tick(3);
  const pelvisWalked = pelvis.getLocalPosition().distance(restPelvis);

  // Set off while running: it stops, and eases back to where it stood.
  const stopped = g.actions.trigger();
  const afterStop = { acting: s.acting?.name ?? null, snap: T.angle(arm.getLocalRotation(), rest) };
  tick(EASE_SECONDS + 0.1);
  const home = { arm: T.angle(arm.getLocalRotation(), rest), pelvis: pelvis.getLocalPosition().distance(restPelvis), fading: !!s.fade };

  // A one-off stops by itself, and the next press starts it from the top.
  g.actions.trigger();
  tick(s.actions[0].player.duration + 1);
  const ended = { acting: s.acting?.name ?? null };
  tick(EASE_SECONDS + 0.1);
  ended.arm = T.angle(arm.getLocalRotation(), rest);
  g.actions.trigger();
  s.update(1 / 30);
  const again = { acting: s.acting?.name ?? null, time: s.acting?.player.time };
  g.actions.trigger();
  tick(EASE_SECONDS + 0.1);

  return { restFromBind, before, set, firstFrame, dancing, pelvisWalked, stopped, afterStop, home, ended, again,
           loop: s.actions[0].player.loop, warnings: s.warnings };
});

// ---- 3) Two in reach: the one you are looking at ----------------------------
r.two = await page.evaluate(() => {
  const g = window.game;
  const { stage } = T;
  T.stand(stage.x + 1.5, stage.z + 1.6);
  const atA = T.lookAt('dancer_a');
  const hintsA = { a: T.hint('dancer_a'), b: T.hint('dancer_b') };
  const atB = T.lookAt('dancer_b');
  const hintsB = { a: T.hint('dancer_a'), b: T.hint('dancer_b') };
  const set = g.actions.trigger();
  const acting = { a: T.item('dancer_a').script.acting?.name ?? null, b: T.item('dancer_b').script.acting?.name ?? null };
  g.actions.trigger();
  // Turn your back on both: the hints slide to the edge rather than vanishing.
  const away = T.stand(stage.x + 1.5, stage.z + 1.6, 180);
  const hintsAway = { a: T.hint('dancer_a'), b: T.hint('dancer_b') };
  // Paused: reach is still worked out, nothing is drawn.
  g.actions.update(false);
  const paused = { a: T.hint('dancer_a'), b: T.hint('dancer_b'), offers: T.offers().names };
  return { atA, hintsA, atB, hintsB, set, acting, away, hintsAway, paused };
});

// ---- 4) The key itself, through the real loop --------------------------------
r.key = await page.evaluate(() => { T.stand(T.stage.x, T.stage.z + 1.5, 0); return T.offers(); });
// Headless Chromium refuses a real pointer lock ("root document is not valid"),
// so the page is told it has one: the game reads document.pointerLockElement
// and listens for pointerlockchange, and from there on every line it runs is
// the line a player's E runs — the engine's keyboard, the handler in main.mjs,
// the repeat guard.
const locked = await page.evaluate(() => {
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('app') });
  document.dispatchEvent(new Event('pointerlockchange'));
  return document.getElementById('overlay').classList.contains('hidden');
});
if (locked) {
  await page.evaluate(() => T.stand(T.stage.x, T.stage.z + 1.5, 0));
  await page.keyboard.press('e');
  await page.waitForFunction(() => T.item('dancer_a').script.acting, { timeout: 20000 }).catch(() => {});
  r.pressed = await page.evaluate(() => ({
    acting: T.item('dancer_a').script.acting?.name ?? null,
    hint: T.hint('dancer_a'),
  }));
  // A second press stops him. Then hold the key: one keydown and five repeats
  // is one press, so he ends up dancing — six presses would leave him stopped.
  await page.keyboard.press('e');
  r.pressedAgain = await page.evaluate(() => T.item('dancer_a').script.acting?.name ?? null);
  await page.keyboard.down('e');
  for (let i = 0; i < 5; i++) await page.keyboard.down('e');     // auto-repeat: keydown with repeat = true
  await page.keyboard.up('e');
  r.held = await page.evaluate(() => T.item('dancer_a').script.acting?.name ?? null);
}

await browser.close();

console.log(JSON.stringify(r, null, 2));
for (const l of logs) console.log('  ' + l);

const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };
if (errs.length) problems.push(`page errors: ${errs.join(' | ')}`);

// 1
want(r.reach.far.names.length === 0, `offered from 6 m away: ${r.reach.far.names}`);
want(r.reach.near.active === 'dancer_a' && r.reach.near.via === 'radius', `not offered from 1.5 m: ${JSON.stringify(r.reach.near)}`);
want(r.reach.hint?.key === 'E' && r.reach.hint?.label === 'Dance', `hint reads ${JSON.stringify(r.reach.hint)}`);
want(r.reach.hint?.lit, 'the only hint in reach is not lit');
want(r.reach.hint?.onScreen && !r.reach.hint?.pinned, `hint not over the dancer: ${JSON.stringify(r.reach.hint)}`);
want(r.reach.height > 1.5 && r.reach.height < 2.1, `dancer's bounds are ${r.reach.height} m tall`);
want(Math.abs(r.reach.edge - r.reach.radius) < 0.1, `reach ends ${r.reach.edge} m from his bounds, radius ${r.reach.radius}`);
// 2
const m = r.machine;
want(!m.warnings.length, `script warnings: ${m.warnings.join(' | ')}`);
want(m.restFromBind > 20, `at rest the arm is ${m.restFromBind}° off bind — the script's pose is not on`);
want(m.before.acting === null && m.before.label === 'Dance', `before: ${JSON.stringify(m.before)}`);
want(m.set?.running === true && m.set?.action === 'dance', `trigger returned ${JSON.stringify(m.set)}`);
want(m.firstFrame < 5, `the arm snapped ${m.firstFrame}° on the first frame — no ease`);
want(m.dancing.acting === 'dance' && m.dancing.label === 'Stop', `dancing: ${JSON.stringify(m.dancing)}`);
want(m.dancing.armFromRest > 10, `0.45 s in the arm is ${m.dancing.armFromRest}° from rest — not dancing`);
want(m.pelvisWalked > 0, 'the pelvis never moved');
want(m.stopped?.running === false && m.afterStop.acting === null, `second press: ${JSON.stringify(m.stopped)}`);
want(m.afterStop.snap > 5, `stopping snapped straight to rest (${m.afterStop.snap}°)`);
want(m.home.arm < 0.1 && m.home.pelvis < 1e-3 && !m.home.fading, `did not come home: ${JSON.stringify(m.home)}`);
want(m.loop === false && m.ended.acting === null && m.ended.arm < 0.1, `a one-off did not end by itself: ${JSON.stringify(m.ended)}`);
want(m.again.acting === 'dance' && m.again.time < 0.1, `did not restart from the top: ${JSON.stringify(m.again)}`);
// 3
const t = r.two;
const same = (got, exp) => JSON.stringify(got) === JSON.stringify(exp);
want(same(t.atA.names, ['dancer_a', 'dancer_b']), `between the two, in reach of: ${t.atA.names}`);
want(t.atA.active === 'dancer_a' && t.hintsA.a?.lit && t.hintsA.b && !t.hintsA.b.lit, `looking at a: ${JSON.stringify([t.atA, t.hintsA])}`);
want(t.atB.active === 'dancer_b' && t.hintsB.b?.lit && t.hintsB.a && !t.hintsB.a.lit, `looking at b: ${JSON.stringify([t.atB, t.hintsB])}`);
want(t.set?.name === 'dancer_b' && t.acting.b === 'dance' && t.acting.a === null, `E went to ${JSON.stringify([t.set, t.acting])}`);
want(t.hintsAway.a?.pinned && t.hintsAway.b?.pinned && t.hintsAway.a.onScreen && t.hintsAway.b.onScreen,
  `with your back turned: ${JSON.stringify(t.hintsAway)}`);
want([t.hintsAway.a, t.hintsAway.b].filter((h) => h?.lit).length === 1, 'not exactly one hint lit with your back turned');
want(t.paused.a === null && t.paused.b === null && t.paused.offers.length === 2, `paused: ${JSON.stringify(t.paused)}`);
// 4
want(locked, 'the game did not start on pointerlockchange — the keyboard path went untested');
if (locked) {
  want(r.pressed.acting === 'dance', `E on the keyboard set off ${r.pressed.acting}`);
  want(r.pressedAgain === null, `a second E left him ${r.pressedAgain}`);
  want(r.held === 'dance', `a held E left him ${r.held ?? 'stopped'} — key repeat is toggling`);
}

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nOK — in reach shows an E, E sets it off and stops it, and the key goes to what you look at');
