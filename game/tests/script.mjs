// A script is code, handed an `object`: this holds src/script.mjs to script
// API 1 — the members beyond a clip on a rig, which tests/anim.mjs and
// tests/actions.mjs already cover on the dancer.
//
//   node tests/script.mjs        # needs `npm start` running on :5173
//
// The fixture is tests/fixtures/life/: a box (life_source.mjs writes it) whose
// script plays Conway's Game of Life on a canvas painted onto its sides, and
// offers five actions — `count` waits in game time, `show` starts a looped
// sound and a looped video on its lid, `linger` asks before a second press
// ends it, `pulse` has no stop at all, and `visit` opens a link. Two copies are
// placed, through the same loadProp the layout goes through, so the test also
// sees that each copy paints its own material. Time is driven by hand
// (script.update), as in the other tests: software WebGL renders a few frames
// a second, and a test that waits on wall-clock frames measures that.
import { chromium } from 'playwright';

const ASSET = './tests/fixtures/life/life';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errs = [];
const logs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (/life_/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 60000 });

const r = await page.evaluate(async (ASSET) => {
  const g = window.game;
  const { page: nav } = await import('/src/script.mjs');
  const opened = [];
  nav.open = (url, newTab) => opened.push({ url, newTab });
  const settle = () => new Promise((res) => setTimeout(res, 0));

  const s0 = g.player.spawn;
  for (const [name, dx] of [['life_a', 3], ['life_b', 5]]) {
    g.loadProp({ name, glb: `${ASSET}.glb`, manifest: `${ASSET}.manifest.json`,
      pos: [s0.x + dx, s0.y, s0.z], rot: [0, 0, 0, 1], scale: [1, 1, 1] });
  }
  const t0 = Date.now();
  while (g.scripted.filter((x) => /^life_/.test(x.label)).length < 2) {
    if (Date.now() - t0 > 60000) throw new Error('timed out waiting for the boxes');
    await new Promise((res) => setTimeout(res, 100));
  }
  const a = g.scripted.find((x) => x.label === 'life_a');
  const b = g.scripted.find((x) => x.label === 'life_b');
  const tick = (s, seconds, step = 1 / 30) => { for (let t = 0; t < seconds - 1e-9; t += step) s.update(step); };
  const mesh = (s, material) => s.root.findComponents('render').flatMap((rc) => rc.meshInstances)
    .find((mi) => mi.material.name === material);

  // ---- 1) The canvas: on the copy's own material, and alive --------------------
  const screen = mesh(a, 'screen').material;
  const texture = screen.emissiveMap;
  const board = () => {
    const c = texture.getSource();
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let alive = 0;
    let hash = 0;
    for (let i = 0; i < px.length; i += 4) {
      const on = px[i + 1] > 128 ? 1 : 0;
      alive += on;
      hash = (hash * 31 + on) | 0;
    }
    return { alive, hash, width: c.width };
  };
  const first = board();
  tick(a, 1.05);                                   // ten generations
  const later = board();
  const canvas = {
    width: first.width, filter: texture.magFilter, first, later,
    own: screen !== mesh(b, 'screen').material && texture !== mesh(b, 'screen').material.emissiveMap,
    shared: screen === g.app.assets.find(`${ASSET}.glb`)?.resource?.materials?.[0]?.resource,
  };

  // ---- 2) wait, in game time; a run lasts as long as its promise ---------------
  const count = {};
  count.set = a.trigger('count')?.name;
  count.running = a.acting?.name ?? null;
  tick(a, 1.1);
  await settle();
  count.afterOne = a.acting?.name ?? null;
  tick(a, 1);
  await settle();
  count.afterTwo = a.acting?.name ?? null;
  // Set off, and stopped before its first wait is up: the rest never runs.
  a.trigger('count');
  tick(a, 0.5);
  a.trigger('count');
  await settle();
  count.stoppedEarly = a.acting?.name ?? null;
  tick(a, 3);
  await settle();

  // ---- 3) a looped sound and a looped video, stopped with their run ------------
  const show = {};
  a.trigger('show');
  show.running = a.acting?.name ?? null;
  const lid = mesh(a, 'lid').material;
  show.lidTexture = !!lid.emissiveMap && lid.emissiveMap !== texture;
  show.videos = a.videos.size;
  const video = [...a.videos][0]?.element;
  // Let the video decode a frame or two, and the sound be asked for.
  for (let i = 0; i < 40 && !(video?.readyState >= 2 && video.currentTime > 0); i++) {
    await new Promise((res) => setTimeout(res, 100));
    a.update(1 / 30);
  }
  show.videoPlaying = !!video && !video.paused && video.readyState >= 2;
  show.soundSlots = a.root.sound ? Object.keys(a.root.sound.slots).length : 0;
  a.trigger('show');                                // stop
  await settle();
  show.stopped = a.acting?.name ?? null;
  show.videosAfter = a.videos.size;
  show.videoPausedAfter = !!video && video.paused;
  show.soundsLeft = a.root.sound ? Object.values(a.root.sound.slots).reduce((n, s) => n + s.instances.length, 0) : 0;

  // ---- 4) open: a link out, and an action that is over as soon as it is set off -
  const visit = { set: a.trigger('visit')?.name, acting: a.acting?.name ?? null, opened };

  // ---- 5) what a press on a running action means is the script's --------------
  const action = (name) => a.actions.find((x) => x.name === name);
  const linger = {};
  a.trigger('linger');
  linger.started = { running: !!action('linger').run, label: a.runLabel(action('linger')) };
  a.trigger('linger');                               // the script asks first
  await settle();
  linger.asked = { running: !!action('linger').run, label: a.runLabel(action('linger')) };
  a.trigger('linger');                               // ...and goes when asked again
  await settle();
  linger.left = !!action('linger').run;
  const pulse = {};
  a.trigger('pulse');
  pulse.started = { running: !!action('pulse').run, offered: a.offers(action('pulse')) };
  a.trigger('pulse');                                // no stop: the key does nothing
  await settle();
  pulse.pressed = !!action('pulse').run;
  tick(a, 2.1);
  await settle();
  pulse.after = { running: !!action('pulse').run, offered: a.offers(action('pulse')) };

  return {
    canvas, count, show, visit, linger, pulse,
    warnings: { a: a.warnings, b: b.warnings },
    describe: a.describe(),
  };
}, ASSET);

await browser.close();

console.log(JSON.stringify(r, null, 2));
for (const l of logs) console.log('  ' + l);

const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };
if (errs.length) problems.push(`page errors: ${errs.join(' | ')}`);
want(!r.warnings.a.length && !r.warnings.b.length, `script warnings: ${JSON.stringify(r.warnings)}`);
// 1
want(r.canvas.width === 32, `the screen's texture is ${r.canvas.width} wide, not the 32 the script asked for`);
want(r.canvas.filter === 0, `smooth: false did not give nearest filtering (${r.canvas.filter})`);
want(r.canvas.first.alive > 5 && r.canvas.later.alive > 0, `the board is empty: ${JSON.stringify([r.canvas.first, r.canvas.later])}`);
want(r.canvas.first.hash !== r.canvas.later.hash, 'a second of ticks did not change the board — tick or update() is not reaching the texture');
want(r.canvas.own, 'two copies share one screen — a canvas must paint the copy\'s own material');
want(!r.canvas.shared, 'the canvas was painted onto the container\'s material, which every copy shares');
// 2
want(r.count.set === 'count' && r.count.running === 'count', `count did not start: ${JSON.stringify(r.count)}`);
want(r.count.afterOne === 'count', `count ended after its first wait: ${r.count.afterOne}`);
want(r.count.afterTwo === null, `count still running after both waits: ${r.count.afterTwo}`);
want(r.count.stoppedEarly === null, `a second press did not stop count: ${r.count.stoppedEarly}`);
const ones = logs.filter((l) => /one, at generation/.test(l)).length;
const twos = logs.filter((l) => /\btwo\b/.test(l)).length;
want(ones === 1 && twos === 1, `count logged "one" ${ones} time(s) and "two" ${twos} — a stopped run carried on past its await`);
// 3
want(r.show.running === 'show', `show did not start: ${JSON.stringify(r.show)}`);
want(r.show.lidTexture && r.show.videos === 1, `the video is not on the lid: ${JSON.stringify(r.show)}`);
want(r.show.videoPlaying, 'the video never played');
want(r.show.soundSlots === 1, `the sound was not asked for: ${r.show.soundSlots} slot(s)`);
want(r.show.stopped === null && r.show.videosAfter === 0 && r.show.videoPausedAfter && r.show.soundsLeft === 0,
  `stopping show left something running: ${JSON.stringify(r.show)}`);
want(!logs.some((l) => /the film ended/.test(l)), 'a stopped run went on past the await it was on');
// 4
want(r.visit.set === 'visit' && r.visit.acting === null, `visit is still running: ${JSON.stringify(r.visit)}`);
want(r.visit.opened.length === 1 && r.visit.opened[0].url === 'https://example.org/life' && r.visit.opened[0].newTab === true,
  `open asked for ${JSON.stringify(r.visit.opened)}`);

// 5
want(r.linger.started.running && r.linger.started.label === 'Leave', `linger did not start: ${JSON.stringify(r.linger)}`);
want(r.linger.asked.running && r.linger.asked.label === 'Really leave?', `the first press on linger was not the script's to decide: ${JSON.stringify(r.linger.asked)}`);
want(!r.linger.left, 'the second press on linger did not end it');
want(r.pulse.started.running && !r.pulse.started.offered, `pulse, running without a stop, is still on offer: ${JSON.stringify(r.pulse.started)}`);
want(r.pulse.pressed, 'a press on pulse, which has no stop, ended it anyway — only the script may');
want(!r.pulse.after.running && r.pulse.after.offered, `pulse did not run its course and come back on offer: ${JSON.stringify(r.pulse.after)}`);

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nOK — a canvas, a tick, a wait, a sound, a video and a link, and a second press that means what the script says');
