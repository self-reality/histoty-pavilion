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
 *   --out    the file (default recording.mp4).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
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
  if (!prop) return { action: null };
  const s = g.scripted.find((x) => x.label === prop);
  const offered = action ? s.actions.find((a) => a.name === action) : s.actions[0];
  if (!offered) return { error: `"${prop}" offers ${s.actions.map((a) => a.name).join(', ') || 'no actions'}${action ? `, not "${action}"` : ''}` };
  // As the E key does it: the press carries the line of sight (src/actions.mjs).
  const cam = g.camera;
  s.trigger(offered.name, { ray: { origin: cam.getPosition().clone(), direction: cam.forward.clone() } });
  return { action: offered.name };
}, { view, prop: opt.prop, action: opt.action });
if (setup.error) fail(setup.error);

const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart',
  opt.out,
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
await browser.close();

process.stdout.write('\n');
console.log(`${opt.out}: ${n} frames, ${(n / fps).toFixed(2)} s at ${fps} fps, ${width}x${height}`
  + (setup.action ? ` — ${opt.prop} ${setup.action}${endedAt === null ? ' (still running at the cap)' : ` ended at ${endedAt.toFixed(2)} s`}` : '')
  + `, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
if (errors.length) console.warn(`page errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
