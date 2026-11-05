/**
 * Record what happens in the world to a video, frame-exact, headlessly.
 *
 *     node tools/record.mjs --shot shots/vandals.json
 *     node tools/record.mjs --view '<a Copy link from the pause screen>' \
 *         --press g-man-dance_01:dance@0 --stop 6 --out gman.mp4
 *
 * A shot is a timeline in game time, and everything on it is said, not
 * followed: where the eye is, what is pressed and when, when filming starts
 * and when it stops. Nothing is read off the world to decide when to stop — a
 * film's length, say, is measured beforehand (ffprobe) and written as `stop`.
 *
 * Time 0 is the first frame of a world that has been standing still since the
 * page loaded: the clock (src/main.mjs) is held before anything is placed, so
 * every prop lands on a stopped world and starts its clips and films on that
 * first frame — a screen's film is at its own frame 0 at time 0. From there
 * the world is stepped 1/fps at a time; each frame is read off the canvas into
 * ffmpeg. However slow a frame is to draw, the video plays at `fps`.
 *
 * Only the canvas is filmed. The pointer, the E hints, the crosshair and the
 * pause screen are page elements over it and are never in a frame.
 *
 * The sound is mixed afterwards. Held, the world logs every sound a placed
 * object starts, cuts short or turns up or down, in game time
 * (game.clock.log); the recorder lays each file at its moment, as loud as it
 * was where the camera stood and panned to its side, the way the engine would
 * have played it, and puts the mix under the pictures. A video's sound is one
 * of those sounds. The world's own voices (footsteps, the gun) are not in it:
 * a camera has neither.
 *
 * It is not a mode. A mode is a game somebody plays; this is a director
 * standing outside the world, like the tests, and the world never imports it.
 *
 * A shot file is JSON; every key is optional and a flag of the same name wins:
 *
 *   {
 *     "view":  "http://localhost:5173/?mode=flyover&at=…&look=…",
 *     "size":  "1080x1920",  "fps": 30,
 *     "start": 0,            "stop": 102.266,
 *     "press": [{ "at": 0, "prop": "box-9x16_01", "action": "unmute" }],
 *     "camera": [{ "view": "<link>" }, { "view": "<link>" }, { "at": 60, "view": "<link>" }]
 *   }
 *
 *   --shot   the shot file (shots/*.json).
 *   --view   the eye: a Copy link from the pause screen (?at=…&look=…, walking
 *            or fly-over — it is filmed from the fly-over at that lens), or
 *            {"x","y","z","yaw","pitch"} / x,y,z,yaw,pitch with y at the eye.
 *            Without it the fly-over starts where the page would put the walker.
 *   camera   (shot file only) views the camera passes through, each a link or
 *            {x,y,z,yaw,pitch}, at its `at` seconds — keys without one are
 *            spread evenly between their neighbours, the first at `start`
 *            and the last at `stop` when they have none. One smooth curve
 *            through them all (Catmull-Rom, still at its two ends: it eases
 *            out of the first and into the last); before the first key and
 *            after the last the camera stands. The first key is the view.
 *   --press  prop:action@seconds, repeatable: the action pressed as the E key
 *            would, from the camera, at that time. A press on an action that
 *            is running asks it to stop, as E does. Without @, at 0.
 *   --start  seconds of game time when filming starts (default 0). The world
 *            is stepped, unfilmed, up to it.
 *   --stop   seconds of game time when filming stops: the first moment not
 *            filmed. Required.
 *   --fps    frames per second of game time (default 30).
 *   --size   WxH of the frame (default 1280x720; 1080x1920 for Instagram).
 *   --url    the pavilion (default http://localhost:5173/, i.e. `npm start`);
 *            its own parameters (`placements`, …) are kept.
 *   --gpu    render with the machine's GPU instead of SwiftShader: much faster,
 *            but no longer the same pixels on every machine.
 *   --silent no sound track.
 *   --out    the file (default recording.mp4; for a shot, recordings/<its name>.mp4 —
 *            recordings/ is not tracked).
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
  options: {
    shot: { type: 'string' },
    view: { type: 'string' },
    press: { type: 'string', multiple: true },
    start: { type: 'string' },
    stop: { type: 'string' },
    fps: { type: 'string' },
    size: { type: 'string' },
    url: { type: 'string' },
    gpu: { type: 'boolean' },
    silent: { type: 'boolean' },
    out: { type: 'string' },
  },
});

const fail = (why) => { console.error(`record: ${why}`); process.exit(1); };

let file = {};
if (flags.shot) {
  try { file = JSON.parse(readFileSync(flags.shot, 'utf8')); } catch (err) { fail(`--shot ${flags.shot}: ${err.message}`); }
}
const pick = (key, fallback) => flags[key] ?? file[key] ?? fallback;
const fps = Number(pick('fps', 30));
const start = Number(pick('start', 0));
const stop = Number(pick('stop', NaN));
const [width, height] = String(pick('size', '1280x720')).split('x').map(Number);
const gpu = !!pick('gpu', false);
const silent = !!pick('silent', false);
const base = pick('url', 'http://localhost:5173/');
const out = pick('out', flags.shot ? join('recordings', basename(flags.shot, extname(flags.shot)) + '.mp4') : 'recording.mp4');
mkdirSync(dirname(out), { recursive: true });
if (!(fps > 0)) fail(`fps ${fps} is not a rate`);
if (!(width > 0 && height > 0)) fail(`size ${pick('size')} is not WxH`);
if (!(start >= 0)) fail(`start ${start} is not a time`);
if (!(stop > start)) fail(Number.isFinite(stop) ? `stop ${stop} is not after start ${start}` : 'no stop: say when filming stops (--stop seconds)');

function parsePress(p) {
  if (typeof p === 'string') {
    const m = /^([^:@]+):([^@]+)(?:@([\d.]+))?$/.exec(p);
    if (!m) fail(`--press ${p} is not prop:action@seconds`);
    return { prop: m[1], action: m[2], at: m[3] === undefined ? 0 : Number(m[3]) };
  }
  if (!p || typeof p.prop !== 'string' || typeof p.action !== 'string') fail(`press ${JSON.stringify(p)} needs a prop and an action`);
  return { prop: p.prop, action: p.action, at: Number(p.at ?? 0) };
}
const presses = (flags.press ?? file.press ?? []).map(parsePress);
for (const p of presses) if (!(p.at >= 0)) fail(`press ${p.prop}:${p.action} at ${p.at} is not a time`);
presses.sort((a, b) => a.at - b.at);

// A view: a pause-screen link (its `at` is the feet, `feet` says so — the
// eye is a walker's eye height up), {x,y,z,yaw,pitch} or x,y,z,yaw,pitch.
function parseView(v) {
  if (v && typeof v === 'object') return check({ ...v, feet: false });
  if (typeof v === 'string' && /^https?:/.test(v)) {
    const link = new URL(v);
    const at = (link.searchParams.get('at') ?? '').split(',').map(Number);
    const look = (link.searchParams.get('look') ?? '').split(',').map(Number);
    if (at.length !== 3 || look.length !== 2) fail(`view ${v} has no at=x,y,z and look=yaw,pitch — copy it from the pause screen`);
    return check({ x: at[0], y: at[1], z: at[2], yaw: look[0], pitch: look[1], feet: true, link });
  }
  if (typeof v === 'string') {
    try { return check({ ...JSON.parse(v), feet: false }); } catch {
      const n = v.split(',').map(Number);
      return check({ x: n[0], y: n[1], z: n[2], yaw: n[3], pitch: n[4], feet: false });
    }
  }
  fail(`view ${JSON.stringify(v)} is neither a link, {x,y,z,yaw,pitch} nor x,y,z,yaw,pitch`);
  function check(w) {
    if (!['x', 'y', 'z', 'yaw', 'pitch'].every((k) => Number.isFinite(w[k]))) {
      fail(`view ${JSON.stringify(v)} is neither a link, {x,y,z,yaw,pitch} nor x,y,z,yaw,pitch`);
    }
    return w;
  }
}

// The camera's keys, each with its time: spread evenly where none is said.
const keys = (Array.isArray(file.camera) ? file.camera : []).map((k) => ({ at: k.at === undefined ? null : Number(k.at), ...parseView(k.view) }));
if (keys.length) {
  if (keys[0].at === null) keys[0].at = start;
  if (keys.length > 1 && keys[keys.length - 1].at === null) keys[keys.length - 1].at = stop;
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].at !== null) continue;
    let j = i;
    while (keys[j].at === null) j++;
    const a = keys[i - 1].at, b = keys[j].at;
    for (let k = i; k < j; k++) keys[k].at = a + (b - a) * (k - i + 1) / (j - i + 1);
  }
  for (let i = 0; i < keys.length; i++) {
    if (!(keys[i].at >= 0) || (i && !(keys[i].at > keys[i - 1].at))) fail(`camera key ${i} at ${keys[i].at}: keys go forward in time`);
    // Each yaw the nearest turn to the one before: 350 then 10 is 20° right, not 340° left.
    if (i) keys[i].yaw = keys[i - 1].yaw + ((((keys[i].yaw - keys[i - 1].yaw) % 360) + 540) % 360 - 180);
  }
}

// The eye. A link opens the page on it; a bare view is handed to switchMode.
const page0 = new URL(base);
const asked = flags.view ?? (keys.length ? null : file.view) ?? null;
const first = keys[0] ?? (asked === null ? null : parseView(asked));
const view = first && !first.feet ? first : null;
if (first?.feet) {
  page0.searchParams.set('at', first.link.searchParams.get('at'));
  page0.searchParams.set('look', first.link.searchParams.get('look'));
}
page0.searchParams.set('mode', 'flyover');

try { await fetch(base); } catch { fail(`nothing at ${base} — run \`npm start\` first`); }

const browser = await chromium.launch({
  args: gpu
    ? ['--use-angle=metal', '--ignore-gpu-blocklist']       // as tests/perf.mjs
    : ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// Held the moment the world exists, before a single prop is placed: whatever
// lands, lands on a stopped clock and starts on frame 0.
await page.addInitScript(() => {
  const wait = setInterval(() => {
    if (!window.game?.clock) return;
    clearInterval(wait);
    window.game.clock.hold();
  }, 0);
});
await page.goto(page0.href, { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.clock?.held && window.game.mode === 'flyover', null, { timeout: 120000 });
for (const name of new Set(presses.map((p) => p.prop))) {
  await page.waitForFunction((name) => window.game.scripted.some((s) => s.label === name), name, { timeout: 120000 })
    .catch(async () => fail(`no prop "${name}" with a script — there are: `
      + (await page.evaluate(() => window.game.scripted.map((s) => s.label).join(', ')))));
}
// Every layout prop, texture and sound requested at boot has landed.
await page.waitForLoadState('networkidle');

const setup = await page.evaluate(async ({ view, presses }) => {
  const g = window.game;
  if (view) await g.switchMode('flyover', view);
  // Each leveled prop at the drawing this view wants before anything is drawn
  // (src/levels.mjs). step() waits for it too; this is a cheap guard.
  await g.levels?.settle();
  for (const p of presses) {
    const s = g.scripted.find((x) => x.label === p.prop);
    if (!s.actions.some((a) => a.name === p.action)) {
      return { error: `"${p.prop}" offers ${s.actions.map((a) => a.name).join(', ') || 'no actions'}, not "${p.action}"` };
    }
  }
  return { t0: g.clock.time, levels: g.levels?.stats() ?? null, eyeHeight: g.player.eyeHeight };
}, { view, presses });
if (setup.error) fail(setup.error);
for (const k of keys) if (k.feet) { k.y += setup.eyeHeight; k.feet = false; }

const work = mkdtempSync(join(tmpdir(), 'record-'));
const pictures = join(work, 'pictures.mp4');
const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18', '-r', String(fps), '-movflags', '+faststart',
  pictures,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const encoded = new Promise((res, rej) => ffmpeg.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`)))));

// One frame: the presses due by now, as the E key makes them (the press
// carries the camera's line of sight — src/actions.mjs), then the step (the
// first draws where the world stands), and the canvas read in the same task
// as the draw when the frame is filmed.
const frame = (dt, due, film, eye) => page.evaluate(async ({ dt, due, film, eye }) => {
  const g = window.game;
  if (eye) {
    // Where the camera is this frame: the fly-over's own body, put there as
    // a player flying it would — its update turns rig and lens to match.
    const f = g.session.flyer;
    f.pos.set(eye.x, eye.y, eye.z);
    f.yaw = eye.yaw;
    f.pitch = eye.pitch;
    f.vel.set(0, 0, 0);
  }
  const said = [];
  for (const p of due) {
    const s = g.scripted.find((x) => x.label === p.prop);
    const cam = g.camera;
    const was = !!s.actions.find((a) => a.name === p.action).run;
    s.trigger(p.action, { ray: { origin: cam.getPosition().clone(), direction: cam.forward.clone() } });
    const now = !!s.actions.find((a) => a.name === p.action).run;
    said.push(`${p.prop} ${p.action} ${was ? (now ? 'asked to stop' : 'stopped') : (now ? 'started' : 'started and done')}`);
  }
  await g.clock.step(dt);
  return { png: film ? g.app.graphicsDevice.canvas.toDataURL('image/png') : null, said, time: g.clock.time };
}, { dt, due, film, eye });

const dt = 1 / fps;
const eps = 1e-6;
// Frame n is the world at n/fps; filmed from the first at or after `start`,
// up to the last before `stop`.
const firstFrame = Math.ceil(start * fps - eps);
const last = Math.ceil(stop * fps - 1e-3) - 1;
const started = Date.now();
let pending = [...presses];
let filmT0 = null;
const pressed = [];
for (let n = 0; n <= last; n++) {
  const t = n * dt;
  const due = pending.filter((p) => p.at <= t + eps);
  pending = pending.slice(due.length);
  const film = n >= firstFrame;
  const f = await frame(n === 0 ? 0 : dt, due, film, keys.length ? cameraAt(t) : null);
  for (const s of f.said) pressed.push(`${s} at ${t.toFixed(2)} s`);
  if (n === firstFrame) filmT0 = f.time;
  if (film && !ffmpeg.stdin.write(Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'))) {
    await new Promise((res) => ffmpeg.stdin.once('drain', res));
  }
  if ((n + 1) % fps === 0) {
    const ms = (Date.now() - started) / (n + 1);
    process.stdout.write(`\r  ${t.toFixed(1)} / ${stop.toFixed(1)} s of game time, ${ms.toFixed(0)} ms a frame, `
      + `${Math.max(0, ((last - n) * ms) / 60000).toFixed(1)} min to go   `);
  }
}
ffmpeg.stdin.end();
await encoded;
const frames = last - firstFrame + 1;
const length = frames / fps;

// ---- The sound track ----------------------------------------------------------
// What was heard, and from where: the log, the camera (it stands still for the
// whole film), and each object's falloff as its sound component has it.
const heard = silent ? null : await page.evaluate(() => {
  const g = window.game;
  const cam = g.camera;
  const p = cam.getPosition();
  const r = cam.right;
  const falloff = {};
  for (const s of g.scripted) {
    const c = s.root.sound;
    if (c) falloff[s.label] = { ref: c.refDistance, max: c.maxDistance, rolloff: c.rollOffFactor };
  }
  return { log: g.clock.log, cam: [p.x, p.y, p.z], right: [r.x, r.y, r.z], falloff };
});
await browser.close();

// Each file fetched once, into the work folder: ffmpeg cannot loop, or even
// always read to the end, a file from a server that answers no ranges.
const local = new Map();
if (heard) {
  for (const url of new Set(heard.log.filter((e) => e.kind === 'sound').map((e) => e.url))) {
    const res = await fetch(url);
    if (!res.ok) { console.warn(`\n  sound ${url}: HTTP ${res.status} — left out`); continue; }
    const f = join(work, `${local.size}-${url.split('/').pop()}`);
    writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    local.set(url, f);
  }
  heard.log = heard.log.filter((e) => e.kind !== 'sound' || local.has(e.url)).map((e) => (e.url ? { ...e, url: local.get(e.url) } : e));
}
const sounds = soundTrack(heard, filmT0, length);
if (sounds.length) {
  const inputs = sounds.flatMap((v) => [...(v.loop ? ['-stream_loop', '-1'] : []), '-i', v.url]);
  const chains = sounds.map((v, i) => `[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,`
    + `atrim=${v.skip.toFixed(4)}:${(v.skip + v.length).toFixed(4)},asetpts=PTS-STARTPTS,`
    + `volume=volume='${v.volume}':eval=frame,`
    + `pan=stereo|c0=${v.left.toFixed(4)}*c0|c1=${v.right.toFixed(4)}*c1,`
    + `adelay=${Math.round(v.at * 1000)}:all=1[s${i}]`);
  const mix = `${sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${sounds.length}:normalize=0:duration=longest,`
    + `apad,atrim=0:${length.toFixed(4)}[mix]`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', pictures, ...inputs,
    '-filter_complex', [...chains, mix].join(';'), '-map', '0:v', '-map', '[mix]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out], { stdio: 'inherit' });
} else {
  copyFileSync(pictures, out);
}
rmSync(work, { recursive: true, force: true });

process.stdout.write('\n');
console.log(`${out}: ${frames} frames, ${length.toFixed(2)} s at ${fps} fps, ${width}x${height} — game time `
  + `${(firstFrame / fps).toFixed(2)} to ${((last + 1) / fps).toFixed(2)} s, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
for (const p of pressed) console.log(`  press: ${p}`);
for (const p of pending) console.warn(`  press: ${p.prop} ${p.action} at ${p.at} s never came — after the stop`);
if (sounds.length) {
  console.log(`  sound: ${sounds.map((v) => `${v.file} at ${v.at.toFixed(2)} s${v.skip ? ` from ${v.skip.toFixed(2)} s in` : ''}, `
    + `${v.length.toFixed(2)} s${v.loop ? ' looped' : ''}, gain ${Math.max(v.left, v.right).toFixed(2)}`
    + `${v.changes ? `, volume changed ${v.changes}×` : ''}`).join('; ')}`);
} else if (!silent) console.log('  sound: nothing was heard');
if (setup.levels?.props) {
  const l = setup.levels;
  console.log(`  levels: ${l.props} prop${l.props === 1 ? '' : 's'}, ${l.at.map((k, i) => `${i ? `L${i}` : 'base'} ${k}`).join(' · ')}`
    + `, ${l.fetchedMB.toFixed(1)} MB fetched, ${l.pending} pending at the first frame`);
}
if (errors.length) console.warn(`page errors:\n  ${errors.slice(0, 5).join('\n  ')}`);

/**
 * The camera at time t: a Catmull-Rom curve through the keys, each component
 * on its own (x, y, z, yaw, pitch). Its slope at a key is the line between
 * the keys either side — taken over their times, so unevenly spaced keys
 * still pass at an even pace — and nought at the first and the last, so the
 * move starts and ends at rest. Hermite between each two keys.
 */
function cameraAt(t) {
  const n = keys.length;
  const parts = ['x', 'y', 'z', 'yaw', 'pitch'];
  if (n === 1 || t <= keys[0].at) return Object.fromEntries(parts.map((p) => [p, keys[0][p]]));
  if (t >= keys[n - 1].at) return Object.fromEntries(parts.map((p) => [p, keys[n - 1][p]]));
  let i = 0;
  while (t > keys[i + 1].at) i++;
  const a = keys[i], b = keys[i + 1];
  const h = b.at - a.at;
  const s = (t - a.at) / h;
  const slope = (k, p) => (k === 0 || k === n - 1 ? 0 : (keys[k + 1][p] - keys[k - 1][p]) / (keys[k + 1].at - keys[k - 1].at));
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return Object.fromEntries(parts.map((p) => [p, h00 * a[p] + h10 * h * slope(i, p) + h01 * b[p] + h11 * h * slope(i + 1, p)]));
}

/**
 * The log as the mixer needs it: each sound's file, when in the film it
 * starts, how far into the file (when it began before filming did), how long
 * it sounds (to its end, its cut, or the film's end), its volume over that
 * time as the log has it, and its left and right gains where the camera
 * stood — the engine's own inverse falloff and an equal-power pan, the same
 * model the positional sound component plays through. A sound with a `reach`
 * says its own falloff in the log: linear, silent past `max`.
 */
function soundTrack(heard, t0, length) {
  if (!heard) return [];
  const cut = new Map(heard.log.filter((e) => e.kind === 'stop').map((e) => [e.id, e.t - t0]));
  const turned = new Map();
  for (const e of heard.log) {
    if (e.kind !== 'volume') continue;
    if (!turned.has(e.id)) turned.set(e.id, []);
    turned.get(e.id).push({ t: e.t - t0, volume: e.volume });
  }
  const out = [];
  for (const e of heard.log) {
    if (e.kind !== 'sound') continue;
    const began = e.t - t0;                 // in film time; negative: before filming
    const at = Math.max(0, began);
    if (at >= length) continue;
    const full = probeLength(e.url);
    let skip = at - began;
    if (!e.loop && skip >= full) continue;  // over before filming started
    if (e.loop && full > 0 && Number.isFinite(full)) skip %= full;
    const until = Math.min(length, cut.get(e.id) ?? Infinity, e.loop ? Infinity : began + full);
    if (!(until > at)) continue;
    // Its volume from `at` on: what it was then, and each change after, on
    // the trimmed stream's own clock (0 at `at`).
    let now = e.volume;
    const later = [];
    for (const c of turned.get(e.id) ?? []) {
      if (c.t <= at) now = c.volume;
      else if (c.t < until) later.push({ t: c.t - at, volume: c.volume });
    }
    // if(lt(t,t1), v0, if(lt(t,t2), v1, … vk)), built from the last change back.
    let volume = String(later.length ? later[later.length - 1].volume : now);
    for (let i = later.length - 1; i >= 0; i--) {
      volume = `if(lt(t,${later[i].t.toFixed(4)}),${i === 0 ? now : later[i - 1].volume},${volume})`;
    }
    if (now === 0 && later.every((c) => c.volume === 0)) continue;   // never heard
    const d = Math.hypot(e.pos[0] - heard.cam[0], e.pos[1] - heard.cam[1], e.pos[2] - heard.cam[2]);
    const { model = 'inverse', ref = 2, max = 40, rolloff = 1 } = e.falloff ?? heard.falloff[e.object] ?? {};
    const clamped = Math.min(Math.max(d, ref), max);
    const gain = model === 'linear'
      ? 1 - rolloff * (clamped - ref) / (max - ref)
      : ref / (ref + rolloff * (clamped - ref));
    // Equal power across the camera's right: dead ahead is 0.707 a side.
    const side = d > 1e-6
      ? ((e.pos[0] - heard.cam[0]) * heard.right[0] + (e.pos[1] - heard.cam[1]) * heard.right[1] + (e.pos[2] - heard.cam[2]) * heard.right[2]) / d
      : 0;
    const angle = (side + 1) * Math.PI / 4;
    out.push({ file: e.file, url: e.url, loop: e.loop, at, skip, length: until - at, volume, changes: later.length,
      left: gain * Math.cos(angle), right: gain * Math.sin(angle) });
  }
  return out;
}

function probeLength(url) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url], { encoding: 'utf8' })) || Infinity;
  } catch {
    return Infinity;
  }
}
