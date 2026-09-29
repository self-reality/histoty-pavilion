/**
 * Record what happens in the world to a video, frame-exact, headlessly.
 *
 *     node tools/record.mjs --view '<copy(game.session.view()) from the fly-over>' \
 *         --prop g-man-dance_01 --action dance --out gman.mp4
 *
 * Frame the shot in the fly-over, copy the view from the console, and hand it
 * over. The recorder opens the page in headless Chromium, puts the fly-over's
 * camera at that view, holds the world's clock (src/main.mjs) and sets the
 * prop's action off the way the E key would — with the camera's line of sight
 * as the press's ray. Then it steps the world 1/fps at a time and reads each
 * frame off the canvas into ffmpeg, until the run ends (plus a tail for the
 * clip to ease out) or `--seconds` is up. However slow a frame is to draw,
 * the video plays at `--fps`: the world only moves when it is stepped.
 *
 * The sound is mixed afterwards. Held, the world logs every sound a placed
 * object starts, and every one cut short, in game time (game.clock.log); the
 * recorder lays each file at its moment, as loud as it was where the camera
 * stood and panned to its side, the way the engine would have played it, and
 * puts the mix under the pictures. A video's sound is one of those sounds.
 * The world's own voices (footsteps, the gun) are not in it: a camera has
 * neither.
 *
 * It is not a mode. A mode is a game somebody plays; this is a director
 * standing outside the world, like the tests, and the world never imports it.
 *
 *   --view   '{"x":…,"y":…,"z":…,"yaw":…,"pitch":…}' or x,y,z,yaw,pitch — the eye.
 *            Without it the fly-over starts where the page would put the walker.
 *   --prop   a placement's name (game.scripted labels). Without it nothing is
 *            set off and the world is just filmed — `--seconds` is then needed.
 *   --action which of its actions (default: the first it offers).
 *   --seconds how long; with an action, a cap (default: until the run ends).
 *   --tail   seconds filmed after the run ends (default 0.5).
 *   --fps    frames per second of game time (default 30).
 *   --size   WxH of the frame (default 1280x720).
 *   --url    the pavilion (default http://localhost:5173/, i.e. `npm start`).
 *   --gpu    render with the machine's GPU instead of SwiftShader: faster, but
 *            no longer the same pixels on every machine.
 *   --silent no sound track.
 *   --out    the file (default recording.mp4).
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    view: { type: 'string' },
    prop: { type: 'string' },
    action: { type: 'string' },
    seconds: { type: 'string' },
    tail: { type: 'string', default: '0.5' },
    fps: { type: 'string', default: '30' },
    size: { type: 'string', default: '1280x720' },
    url: { type: 'string', default: 'http://localhost:5173/' },
    gpu: { type: 'boolean', default: false },
    silent: { type: 'boolean', default: false },
    out: { type: 'string', default: 'recording.mp4' },
  },
});

const fail = (why) => { console.error(`record: ${why}`); process.exit(1); };
const fps = Number(opt.fps);
const tail = Number(opt.tail);
const cap = opt.seconds === undefined ? Infinity : Number(opt.seconds);
const [width, height] = opt.size.split('x').map(Number);
if (!(fps > 0)) fail(`--fps ${opt.fps} is not a rate`);
if (!(width > 0 && height > 0)) fail(`--size ${opt.size} is not WxH`);
if (!(cap > 0)) fail(`--seconds ${opt.seconds} is not a length`);
if (!opt.prop && cap === Infinity) fail('nothing is set off and no --seconds: how long?');

function parseView(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (['x', 'y', 'z', 'yaw', 'pitch'].every((k) => Number.isFinite(v[k]))) return v;
  } catch { /* try the short form */ }
  const n = text.split(',').map(Number);
  if (n.length === 5 && n.every(Number.isFinite)) return { x: n[0], y: n[1], z: n[2], yaw: n[3], pitch: n[4] };
  fail(`--view ${text} is neither {x,y,z,yaw,pitch} nor x,y,z,yaw,pitch`);
}
const view = parseView(opt.view);

try { await fetch(opt.url); } catch { fail(`nothing at ${opt.url} — run \`npm start\` first`); }

const browser = await chromium.launch({
  args: opt.gpu
    ? ['--use-angle=metal', '--ignore-gpu-blocklist']       // as tests/perf.mjs
    : ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const url = new URL(opt.url);
url.searchParams.set('mode', 'flyover');
await page.goto(url.href, { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.clock && window.game.mode === 'flyover', null, { timeout: 120000 });
if (opt.prop) {
  await page.waitForFunction((name) => window.game.scripted.some((s) => s.label === name), opt.prop, { timeout: 120000 })
    .catch(async () => fail(`no prop "${opt.prop}" with a script — there are: `
      + (await page.evaluate(() => window.game.scripted.map((s) => s.label).join(', ')))));
}
// Every layout prop, texture and sound requested at boot has landed.
await page.waitForLoadState('networkidle');

const setup = await page.evaluate(async ({ view, prop, action }) => {
  const g = window.game;
  if (view) await g.switchMode('flyover', view);
  g.clock.hold();
  await g.clock.step(0);         // the game puts the camera at the view on its first frame
  g.clock.log.length = 0;        // film time 0 is now, whatever that frame set off
  const t0 = g.clock.time;
  if (!prop) return { action: null, t0 };
  const s = g.scripted.find((x) => x.label === prop);
  const offered = action ? s.actions.find((a) => a.name === action) : s.actions[0];
  if (!offered) return { error: `"${prop}" offers ${s.actions.map((a) => a.name).join(', ') || 'no actions'}${action ? `, not "${action}"` : ''}` };
  // As the E key does it: the press carries the line of sight (src/actions.mjs).
  const cam = g.camera;
  s.trigger(offered.name, { ray: { origin: cam.getPosition().clone(), direction: cam.forward.clone() } });
  return { action: offered.name, t0 };
}, { view, prop: opt.prop, action: opt.action });
if (setup.error) fail(setup.error);

const work = mkdtempSync(join(tmpdir(), 'record-'));
const pictures = join(work, 'pictures.mp4');
const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart',
  pictures,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const encoded = new Promise((res, rej) => ffmpeg.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`)))));

// One frame: step (the first draws where it stands), read the canvas in the
// same task as the draw, and say whether the run is still going.
const frame = (dt) => page.evaluate(async ({ dt, prop, action }) => {
  const g = window.game;
  await g.clock.step(dt);
  const png = g.app.graphicsDevice.canvas.toDataURL('image/png');
  const s = prop && g.scripted.find((x) => x.label === prop);
  const running = !!s?.actions.find((a) => a.name === action)?.run;
  return { png, running, time: g.clock.time };
}, { dt, prop: opt.prop, action: setup.action });

const dt = 1 / fps;
const started = Date.now();
let n = 0;
let endedAt = null;
for (;;) {
  const f = await frame(n === 0 ? 0 : dt);
  const t = n * dt;
  if (!ffmpeg.stdin.write(Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'))) {
    await new Promise((res) => ffmpeg.stdin.once('drain', res));
  }
  n++;
  if (setup.action && !f.running && endedAt === null) endedAt = t;
  if (t + dt > cap - 1e-9) break;
  if (endedAt !== null && t + dt > endedAt + tail - 1e-9) break;
  if (n % fps === 0) process.stdout.write(`\r  ${t.toFixed(1)} s of game time, ${((Date.now() - started) / n).toFixed(0)} ms a frame`);
}
ffmpeg.stdin.end();
await encoded;

// ---- The sound track ----------------------------------------------------------
// What was heard, and from where: the log, the camera (it stands still for the
// whole film), and each object's falloff as its sound component has it.
const heard = opt.silent ? null : await page.evaluate(() => {
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

const length = n / fps;
// Each file fetched once, into the work folder: ffmpeg cannot loop, or even
// always read to the end, a file from a server that answers no ranges.
const local = new Map();
if (heard) {
  for (const url of new Set(heard.log.filter((e) => e.kind === 'sound').map((e) => e.url))) {
    const res = await fetch(url);
    if (!res.ok) { console.warn(`  sound ${url}: HTTP ${res.status} — left out`); continue; }
    const file = join(work, `${local.size}-${url.split('/').pop()}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    local.set(url, file);
  }
  heard.log = heard.log.filter((e) => e.kind !== 'sound' || local.has(e.url)).map((e) => (e.url ? { ...e, url: local.get(e.url) } : e));
}
const sounds = soundTrack(heard, setup.t0, length);
if (sounds.length) {
  const inputs = sounds.flatMap((v) => [...(v.loop ? ['-stream_loop', '-1'] : []), '-i', v.url]);
  const chains = sounds.map((v, i) => `[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,`
    + `atrim=0:${v.length.toFixed(4)},asetpts=PTS-STARTPTS,`
    + `pan=stereo|c0=${v.left.toFixed(4)}*c0|c1=${v.right.toFixed(4)}*c1,`
    + `adelay=${Math.round(v.at * 1000)}:all=1[s${i}]`);
  const mix = `${sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${sounds.length}:normalize=0:duration=longest,`
    + `apad,atrim=0:${length.toFixed(4)}[mix]`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', pictures, ...inputs,
    '-filter_complex', [...chains, mix].join(';'), '-map', '0:v', '-map', '[mix]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', opt.out], { stdio: 'inherit' });
} else {
  copyFileSync(pictures, opt.out);
}
rmSync(work, { recursive: true, force: true });

process.stdout.write('\n');
console.log(`${opt.out}: ${n} frames, ${(n / fps).toFixed(2)} s at ${fps} fps, ${width}x${height}`
  + (setup.action ? ` — ${opt.prop} ${setup.action}${endedAt === null ? ' (still running at the cap)' : ` ended at ${endedAt.toFixed(2)} s`}` : '')
  + `, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
if (sounds.length) {
  console.log(`  sound: ${sounds.map((v) => `${v.file} at ${v.at.toFixed(2)} s, ${v.length.toFixed(2)} s${v.loop ? ' looped' : ''}, `
    + `gain ${Math.max(v.left, v.right).toFixed(2)}`).join('; ')}`);
} else if (!opt.silent) console.log('  sound: nothing was heard');
if (errors.length) console.warn(`page errors:\n  ${errors.slice(0, 5).join('\n  ')}`);

/**
 * The log as the mixer needs it: each sound's file, when in the film it
 * starts, how long it sounds (to its end, its cut, or the film's end), and
 * its left and right gains where the camera stood — the engine's own
 * inverse falloff and an equal-power pan, the same model the positional
 * sound component plays through.
 */
function soundTrack(heard, t0, length) {
  if (!heard) return [];
  const cut = new Map(heard.log.filter((e) => e.kind === 'stop').map((e) => [e.id, e.t - t0]));
  const out = [];
  for (const e of heard.log) {
    if (e.kind !== 'sound') continue;
    const at = Math.max(0, e.t - t0);
    if (at >= length) continue;
    const full = e.loop ? Infinity : probeLength(e.url);
    const until = Math.min(length, cut.get(e.id) ?? Infinity, at + full);
    if (!(until > at)) continue;
    const d = Math.hypot(e.pos[0] - heard.cam[0], e.pos[1] - heard.cam[1], e.pos[2] - heard.cam[2]);
    const { ref = 2, max = 40, rolloff = 1 } = heard.falloff[e.object] ?? {};
    const clamped = Math.min(Math.max(d, ref), max);
    const gain = e.volume * ref / (ref + rolloff * (clamped - ref));
    // Equal power across the camera's right: dead ahead is 0.707 a side.
    const side = d > 1e-6
      ? ((e.pos[0] - heard.cam[0]) * heard.right[0] + (e.pos[1] - heard.cam[1]) * heard.right[1] + (e.pos[2] - heard.cam[2]) * heard.right[2]) / d
      : 0;
    const angle = (side + 1) * Math.PI / 4;
    out.push({ file: e.file, url: e.url, loop: e.loop, at, length: until - at, left: gain * Math.cos(angle), right: gain * Math.sin(angle) });
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
