// The sound bank, held against the controller that triggers it.
//
// Nothing here listens to audio — it asserts that the right voice is asked for
// at the right moment, which is the half that lives in this repo. Whether the
// files themselves are usable (mono, level, decay, no click at the boundary)
// is the sound-design repo's `npm run check`, and is not re-litigated here.
//
// The two claims worth a test are the ones that are wrong by default:
//   • a landing thud must NOT fire on flat ground, where player.mjs drops
//     `grounded` for a stray frame at map seams;
//   • footsteps must be paced by distance, so their cadence tracks speed.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
         '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 25000 });
await page.waitForFunction(() => window.game.audio && window.game.audio.ready, { timeout: 25000 });
// Slots exist as soon as the manifest is read; the .ogg behind each one decodes
// separately. Wait for the whole bank to be warm before counting it.
await page.waitForFunction(
  () => window.game.audio.total > 0 && window.game.audio.loaded === window.game.audio.total,
  { timeout: 25000 });

// 1) The bank loaded, every file decoded, and the voices grouped as declared.
const bank = await page.evaluate(() => {
  const a = window.game.audio;
  const voices = {};
  let decoded = 0, missing = [];
  for (const [voice, slots] of a.voices) {
    voices[voice] = slots.length;
    for (const name of slots) {
      const slot = a.sound.slot(name);
      const asset = window.game.app.assets.find(name, 'audio');
      if (asset && asset.resource) decoded++; else missing.push(name);
      if (!slot || slot.overlap !== true) missing.push(`${name}:slot`);
    }
  }
  return { voices, decoded, missing, positional: a.sound.positional, listener: !!window.game.camera.audiolistener };
});
console.log('voices:', JSON.stringify(bank.voices));
console.log('decoded files:', bank.decoded, ' missing:', bank.missing);
console.log('positional:', bank.positional, ' listener on camera:', bank.listener);

// 2) Trigger logic. Record what play() is asked for, then drive the controller
// synchronously (no rAF interleave) exactly the way the game loop does:
// player.update() first, audio.update() straight after.
const fired = await page.evaluate(() => {
  const g = window.game;
  const p = g.player, a = g.audio;
  const log = [];
  const realPlay = a.play.bind(a);
  a.play = (voice) => { log.push(voice); return null; };

  const dt = 1 / 60;
  const ZERO = { forward: 0, strafe: 0, jump: false, sprint: false };
  const step = (input, n) => {
    for (let i = 0; i < n; i++) { p.update(dt, input); a.update(dt, p, input); }
  };
  const since = (mark) => log.slice(mark);

  // Settle on the spawn floor first, so nothing below inherits a fall.
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z); p.yaw = 0;
  step(ZERO, 40);

  // WALK: 3 s of holding W. At 6.5 m/s and a 2.2 m stride that is ~8 steps,
  // and every one of them must be the walk take, not the run take.
  let m = log.length;
  step({ forward: 1, strafe: 0, jump: false, sprint: false }, 180);
  const walk = since(m);

  // RUN: the same 3 s sprinting. 9.6 m/s over 2.2 m is ~13 steps — strictly
  // more than the walk, which is the whole point of pacing by distance.
  m = log.length;
  step({ forward: 1, strafe: 0, jump: false, sprint: true }, 180);
  const run = since(m);

  // STANDING STILL: no input, no steps. A timer-driven implementation passes
  // the two above and fails this one.
  m = log.length;
  step(ZERO, 180);
  const idle = since(m);

  // FLAT GROUND, the seam case: walk a long way and count landings. player.mjs
  // loses `grounded` for stray frames on the ripped map; none of them is a fall.
  m = log.length;
  step({ forward: 1, strafe: 0, jump: false, sprint: false }, 240);
  const flatLandings = since(m).filter((v) => v.startsWith('land')).length;

  // JUMP + LANDING: one jump frame, then settle. A flat jump lands at
  // jumpSpeed (8.1 m/s) so it must be the soft landing, not the heavy one.
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
  step(ZERO, 40);
  m = log.length;
  p.update(dt, { forward: 0, strafe: 0, jump: true, sprint: false });
  a.update(dt, p, { forward: 0, strafe: 0, jump: true, sprint: false });
  step(ZERO, 90);
  const jump = since(m);

  // BIG DROP: 12 m up. Impact well past 11 m/s, so the heavy landing.
  p.teleport(p.spawn.x, p.spawn.y + 12, p.spawn.z);
  m = log.length;
  step(ZERO, 150);
  const drop = since(m);

  // WEAPON: the events come out of weapon.mjs, so drive the weapon, not audio.
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
  step(ZERO, 20);
  const w = g.weapon;
  m = log.length;
  w.mag = 30; w.reserve = 90; w.reloading = 0; w.cooldown = 0;
  w.startFire();
  for (let i = 0; i < 60; i++) w.update(dt);   // 1 s of full-auto at 600 rpm
  w.stopFire();
  // 9, not 10: weapon.mjs's 0.1 s interval quantises to 7 frames at 60 Hz, so
  // held fire is 8.6 rounds/s on the wire. That is the cadence the bank's
  // decay rule was checked against too — this asserts one voice per round,
  // not a rate the gun does not actually have.
  const shots = since(m).filter((v) => v === 'ak47_fire').length;

  m = log.length;
  w.mag = 10; w.reloading = 0;
  w.reload();
  const reload = since(m);

  // DRY FIRE: trigger pulled mid-reload, and held down for a second. The click
  // is on the press edge only, so holding it must not machine-gun.
  m = log.length;
  w.startFire();
  for (let i = 0; i < 60; i++) w.update(dt);
  w.stopFire();
  const dry = since(m);

  a.play = realPlay;
  w.mag = 30; w.reserve = 90; w.reloading = 0; w.firing = false;
  p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);

  return {
    walkSteps: walk.filter((v) => v === 'step_walk').length,
    walkOther: walk.filter((v) => v !== 'step_walk').length,
    runSteps: run.filter((v) => v === 'step_run').length,
    runOther: run.filter((v) => v !== 'step_run').length,
    idle: idle.length,
    flatLandings,
    jump,
    drop,
    shots,
    reload,
    dry,
  };
});

console.log('walk 3s:', fired.walkSteps, 'step_walk (+', fired.walkOther, 'other) ',
            ' run 3s:', fired.runSteps, 'step_run (+', fired.runOther, 'other)');
console.log('idle 3s:', fired.idle, 'sounds   flat-ground landings over 4s:', fired.flatLandings);
console.log('jump:', JSON.stringify(fired.jump), '  12 m drop:', JSON.stringify(fired.drop));
console.log('1s full-auto:', fired.shots, 'shots   reload:', JSON.stringify(fired.reload),
            '  dryfire (held 1s):', JSON.stringify(fired.dry));
// 3) Real playback, past the recorder. Section 2 replaced play() to count
// calls, so it cannot see whether a call actually starts anything: this plays
// every voice for real once and checks each hands back a live instance with a
// decoded buffer behind it and a gain inside the jitter window.
const played = await page.evaluate(() => {
  const a = window.game.audio;
  const out = { voices: {}, unknown: a.play('no_such_voice') };
  for (const voice of a.voices.keys()) {
    const inst = a.play(voice);
    out.voices[voice] = inst ? { buffer: !!inst.sound, volume: +inst.volume.toFixed(3) } : null;
  }
  return out;
});
const silent = Object.entries(played.voices).filter(([, v]) => !v || !v.buffer).map(([k]) => k);
const gains = Object.values(played.voices).map((v) => v && v.volume);
console.log('played:', Object.keys(played.voices).length, 'voices   silent:', silent);
console.log('gains:', gains.join(' '), ' unknown voice ->', played.unknown);

console.log('errors:', errors.length, errors.slice(0, 5));

await browser.close();

const pass =
  // The bank is all there: 11 voices, 21 files, every one decoded.
  Object.keys(bank.voices).length === 11 &&
  bank.decoded === 21 &&
  bank.missing.length === 0 &&
  bank.positional === false && bank.listener &&
  // Footsteps: paced by distance, silent at rest, and the run outpaces the walk.
  fired.walkSteps >= 6 && fired.walkSteps <= 10 && fired.walkOther === 0 &&
  fired.runSteps >= 11 && fired.runSteps <= 16 && fired.runOther === 0 &&
  fired.runSteps > fired.walkSteps &&
  fired.idle === 0 &&
  // No phantom thud on flat ground.
  fired.flatLandings === 0 &&
  // Both edges, and the right weight of landing on each.
  fired.jump[0] === 'jump' && fired.jump.includes('land') && !fired.jump.includes('land_hard') &&
  fired.drop.length === 1 && fired.drop[0] === 'land_hard' &&
  // 600 rpm for a second, one reload, one click per trigger press.
  fired.shots >= 9 && fired.shots <= 10 &&
  fired.reload.length === 1 && fired.reload[0] === 'ak47_reload' &&
  fired.dry.length === 1 && fired.dry[0] === 'ak47_dryfire' &&
  // Every voice really starts, and the gain jitter stays in [-3, 0] dB — the
  // window that keeps the loudest trigger at the file's own level instead of
  // clipping against the slot's 1.0 ceiling.
  silent.length === 0 &&
  gains.every((g) => g >= 0.707 && g <= 1.0) &&
  played.unknown === null &&
  errors.length === 0;

console.log(pass ? '\nSOUND: PASS' : '\nSOUND: CHECK');
process.exit(pass ? 0 : 1);
