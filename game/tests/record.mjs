// The world's clock can be held and stepped, and a stepped world films the
// same every time, however slowly its frames are drawn.
//
//   node tests/record.mjs        # needs `npm start` running on :5173
//
// 1) Held, the world stands still: real time passes and nothing moves.
// 2) Stepped: the dancer's clip is exactly n steps of dt in, and the world's
//    clock says the same.
// 3) Frame-exact: the same shot filmed twice, the second time with a pause
//    between frames, gives the same pictures.
// 4) Released, the world moves on its own again.
// 5) tools/record.mjs end to end: a short film of the dance, as many frames as
//    asked, and a second switchMode to the same game at a view is honoured.
//    The dancer makes no sound, so the film has no sound track.
// 6) ...and of a box that beeps and shows a film on its lid (the life fixture,
//    stood in front of the camera by tests/fixtures/record.placements.json):
//    the beep is logged in game time and mixed under the pictures, as long as
//    they are; --silent leaves it out.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PROP = 'g-man-dance_01';
const VIEW = { x: -43.46, y: 1.5, z: -1.3, yaw: 0, pitch: -8 };
const FPS = 10;
const FRAMES = 8;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const errs = [];

async function open() {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:5173/?mode=flyover', { waitUntil: 'load' });
  await page.waitForFunction((name) => window.game?.clock && window.game.scripted.some((s) => s.label === name), PROP, { timeout: 120000 });
  await page.waitForLoadState('networkidle');
  await page.evaluate(async (view) => { await window.game.switchMode('flyover', view); }, VIEW);
  return page;
}

// Film FRAMES frames of the dance; `pause` ms of real time between them.
const film = (page, pause) => page.evaluate(async ({ PROP, FPS, FRAMES, pause }) => {
  const g = window.game;
  const s = g.scripted.find((x) => x.label === PROP);
  g.clock.hold();
  await g.clock.step(0);
  const t0 = g.clock.time;
  s.trigger('dance');
  const frames = [];
  const clipTimes = [];
  for (let n = 0; n < FRAMES; n++) {
    await g.clock.step(n === 0 ? 0 : 1 / FPS);
    frames.push(g.app.graphicsDevice.canvas.toDataURL('image/png'));
    clipTimes.push(s.clip?.time ?? null);
    if (pause) await new Promise((res) => setTimeout(res, pause));
  }
  return { frames, clipTimes, clock: g.clock.time - t0 };
}, { PROP, FPS, FRAMES, pause });

const streams = (file) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const r = {};

// ---- 1) Held --------------------------------------------------------------------
const a = await open();
r.held = await a.evaluate(async () => {
  const g = window.game;
  g.clock.hold();
  const t = g.clock.time;
  const frame = g.app.frame;
  await new Promise((res) => setTimeout(res, 500));
  return { clockMoved: g.clock.time !== t, framesRan: g.app.frame - frame };
});

// ---- 2, 3) Stepped, twice --------------------------------------------------------
const first = await film(a, 0);
const b = await open();
const second = await film(b, 150);
const dt = 1 / FPS;
r.clip = first.clipTimes.map((t) => (t === null ? null : +t.toFixed(6)));
r.clipExact = first.clipTimes.every((t, n) => t !== null && Math.abs(t - n * dt) < 1e-6);
r.clock = +first.clock.toFixed(6);
r.first = first.frames.map(hash);
r.second = second.frames.map(hash);
r.moves = new Set(r.first).size > 1;
r.same = r.first.every((h, i) => h === r.second[i]);

// ---- 4) Released -----------------------------------------------------------------
r.released = await a.evaluate(async () => {
  const g = window.game;
  const t = g.clock.time;
  g.clock.release();
  await new Promise((res) => setTimeout(res, 500));
  return { moved: g.clock.time > t, held: g.clock.held };
});
await browser.close();

// ---- 5) The tool -----------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'record-'));
const out = join(dir, 'dance.mp4');
try {
  execFileSync('node', ['tools/record.mjs', `--view=${Object.values(VIEW).join(',')}`, '--prop', PROP, '--action', 'dance',
    '--seconds', '0.5', '--fps', String(FPS), '--size', '320x180', '--out', out], { stdio: 'inherit' });
  const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate', '-of', 'json', out], { encoding: 'utf8' });
  r.tool = JSON.parse(probe).streams[0];
  r.tool.audio = streams(out).includes('audio');

  const beep = join(dir, 'beep.mp4');
  const silent = join(dir, 'silent.mp4');
  const life = ['tools/record.mjs', '--url', 'http://localhost:5173/?placements=./tests/fixtures/record.placements.json',
    '--view=-43.46,1.8,-1.8,0,-25', '--prop', 'life_rec', '--action', 'show', '--seconds', '0.5', '--fps', String(FPS), '--size', '320x180'];
  const said = execFileSync('node', [...life, '--out', beep], { encoding: 'utf8' });
  process.stdout.write(said);
  execFileSync('node', [...life, '--silent', '--out', silent], { stdio: 'inherit' });
  const length = (type) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', `${type[0]}:0`, '-show_entries', 'stream=duration',
    '-of', 'csv=p=0', beep], { encoding: 'utf8' }));
  r.sound = {
    logged: /sound: beep\.ogg at 0\.00 s/.test(said),
    video: length('video'), audio: length('audio'),
    max: Number((execFileSync('sh', ['-c', `ffmpeg -i "${beep}" -af volumedetect -f null - 2>&1 | grep max_volume`], { encoding: 'utf8' }).match(/(-?[\d.]+) dB/) ?? [])[1]),
    silent: streams(silent),
  };
} catch (err) {
  r.tool = { error: err.message };
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const ok = {
  sound: r.sound?.logged && Math.abs(r.sound.audio - r.sound.video) < 0.05 && r.sound.max > -40 && !r.sound.silent.includes('audio'),
  held: !r.held.clockMoved && r.held.framesRan === 0,
  stepped: r.clipExact && Math.abs(r.clock - (FRAMES - 1) * dt) < 1e-6,
  frameExact: r.moves && r.same,
  released: r.released.moved && !r.released.held,
  tool: !r.tool.audio && Number(r.tool.nb_read_frames) === 5 && r.tool.width === 320 && r.tool.height === 180 && r.tool.r_frame_rate === `${FPS}/1`,
  errors: errs.length === 0,
};
console.log(JSON.stringify(r, null, 2));
if (errs.length) console.log('page errors:', errs);
for (const [k, v] of Object.entries(ok)) console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`);
const pass = Object.values(ok).every(Boolean);
console.log(pass ? 'RECORD: PASS' : 'RECORD: FAIL');
process.exit(pass ? 0 : 1);
