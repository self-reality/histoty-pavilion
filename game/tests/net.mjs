// Two browsers in one room see each other, and nothing more than that.
//
//   node tests/net.mjs     # needs `npm start` on :5173 and `npm run rooms:dev` on :8787
//   ROOMS=wss://… node tests/net.mjs     # the same against a deployed rooms server
//
// 1) No server named: a page on this machine plays alone and opens no socket,
//    with the bare URL and with ?rooms=off alike.
// 2) Two pages in one room: each draws one ghost, where the other stands.
// 3) One walks: its ghost in the other page follows.
// 4) One sets the dancer off: he dances for the other too, on the same beat.
//    Someone who walks in half-way through finds him that far in. He ends for
//    everyone by himself, and a key that stops him stops him for everyone.
// 5) One changes game: its ghost is redrawn as what it now moves as.
// 6) One leaves: its ghost goes.
// 7) Two whose networks will not link directly see each other all the same,
//    by way of the rooms server, and the overlay says that is how — and the
//    dancer is set off and stopped that way too.
// 8) The room turns the ninth away, and turns away a socket that is not from
//    the game's own pages.
import { chromium } from 'playwright';

const GAME = 'http://localhost:5173/';
const ROOMS = (process.env.ROOMS ?? 'ws://localhost:8787').replace(/\/$/, '');
const room = `test-${Date.now().toString(36)}`;
const r = {};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    // Two pages of one browser on one machine: let them name their own address.
    '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const errs = [];
async function open(query, init = null) {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  if (init) await page.addInitScript(init);
  page.on('pageerror', (e) => errs.push(e.message));
  page.heard = [];     // what it says it did because someone else pressed a key
  page.on('console', (m) => { if (/\[actions\].*someone else/.test(m.text())) page.heard.push(m.text()); });
  page.sockets = [];
  page.said = 0;       // messages sent to the rooms server
  page.on('websocket', (ws) => { page.sockets.push(ws.url()); ws.on('framesent', () => page.said++); });
  await page.goto(GAME + query, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.game?.mode && !document.getElementById('playBtn').disabled, { timeout: 60000 });
  return page;
}
// The one ghost a page draws: who, as what, and where.
const ghost = (page) => page.evaluate(() => {
  const people = [...window.game.presence.people.values()];
  if (people.length !== 1) return { count: people.length };
  const p = people[0].entity.getPosition();
  return { count: 1, id: people[0].id, mode: people[0].mode, body: people[0].body, x: p.x, y: p.y, z: p.z };
});
const feet = (page) => page.evaluate(() => { const p = window.game.session.body.pos; return { x: p.x, y: p.y, z: p.z }; });
const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// Wait until the ghost `viewer` draws stands where `target` does; how far off it ended.
async function settled(viewer, target) {
  let off = Infinity;
  for (let i = 0; i < 60 && off > 0.1; i++) {
    await viewer.waitForTimeout(250);
    off = apart(await ghost(viewer), await feet(target));
  }
  return off;
}
// The dancer the scene places, whose `dance` his script offers to the whole room.
const DANCER = 'g-man-dance_01';
const landed = (page) => page.waitForFunction((n) => window.game.actions.items.some((i) => i.name === n), DANCER, { timeout: 60000 });
// Walk up to him and press E: the same trigger() the key calls.
const press = (page) => page.evaluate((n) => {
  const g = window.game;
  const item = g.actions.items.find((i) => i.name === n);
  g.actions.measure(item);
  g.player.teleport(item.anchor.x, item.min.y, item.anchor.z + 1);
  g.actions.update(true);
  return g.actions.trigger()?.name ?? null;
}, DANCER);
const dancing = (page, on, timeout = 5000) => page.waitForFunction(([n, on]) => !!window.game.scripted.find((s) => s.label === n)?.acting === on,
  [DANCER, on], { timeout }).then(() => true, () => false);
// How far into the dance he is in this page, read as a frame steps him — after
// the game's own handler, before the frame is drawn — and when that was.
const beat = (page) => page.evaluate((n) => new Promise((done) => {
  const g = window.game;
  g.app.once('update', () => {
    const s = g.scripted.find((s) => s.label === n);
    done({ on: !!s?.acting, t: s?.clip?.time ?? null, at: Date.now() / 1000 });
  });
}), DANCER);
// How far apart two pages' dancers are, in seconds: 0 is the same beat.
const offBeat = (p, q) => (p.on && q.on ? Math.abs((p.t - p.at) - (q.t - q.at)) : Infinity);
const linked = (page, n) => page.waitForFunction((n) => window.game.net.others === n && window.game.presence.people.size === n, n, { timeout: 20000 });

// ---- 1) Alone ---------------------------------------------------------------
for (const [name, query] of [['bare', ''], ['off', '?rooms=off']]) {
  const page = await open(query);
  r[name] = { net: await page.evaluate(() => window.game.net), sockets: page.sockets.length,
    line: await page.evaluate(() => document.getElementById('people').textContent) };
  await page.context().close();
}

// ---- 2) Two in a room -------------------------------------------------------
const q = `?rooms=${ROOMS}&room=${room}`;
const a = await open(q);
await a.waitForFunction(() => window.game.net.state === 'open');
r.first = { others: await a.evaluate(() => window.game.net.others),
  // The server says how to reach people; with no TURN key set, by STUN alone.
  ice: await a.evaluate(() => window.game.net.ice), relay: await a.evaluate(() => window.game.net.relay), line: await a.evaluate(() => document.getElementById('people').textContent) };
// Somewhere the two will not be standing on the same spot.
await a.evaluate(() => { const g = window.game, p = g.player.pos; g.player.teleport(p.x + 2, p.y, p.z); });
const b = await open(q);
await Promise.all([linked(a, 1), linked(b, 1)]);
r.seen = {
  aSeesB: await settled(a, b),
  bSeesA: await settled(b, a),
  feet: [await feet(a), await feet(b)],
  aGhost: await ghost(a), bGhost: await ghost(b),
  ids: [await a.evaluate(() => window.game.net.id), await b.evaluate(() => window.game.net.id)],
  line: await a.evaluate(() => document.getElementById('people').textContent),
};

// ---- 3) One walks -----------------------------------------------------------
const before = await ghost(b);
await a.evaluate(() => { const g = window.game, p = g.player.pos; g.player.teleport(p.x, p.y, p.z + 3); });
r.walk = { off: await settled(b, a), moved: apart(before, await ghost(b)) };

// ---- 4) One sets the dancer off -----------------------------------------------
// Someone who will walk in half-way through. A page takes longer to load here
// than the dance lasts, so it is loaded now and kept at the door: its socket
// to the rooms server is not opened until it is let in. And its dancer is
// taken off the stage again, as if he were still on his way.
const late = await open(q, () => {
  const Real = window.WebSocket;
  window.WebSocket = function (url) {
    let real = null;
    const ws = { onmessage: null, onclose: null, get readyState() { return real ? real.readyState : 0; }, send: (text) => real.send(text) };
    window.letIn = () => {
      real = new Real(url);
      real.onmessage = (e) => ws.onmessage?.(e);
      real.onclose = (e) => ws.onclose?.(e);
    };
    return ws;
  };
  window.WebSocket.OPEN = Real.OPEN;
});
await Promise.all([landed(a), landed(b), landed(late)]);
await late.evaluate((n) => {
  const g = window.game;
  window.dancer = g.actions.items.find((i) => i.name === n);
  g.actions.items = g.actions.items.filter((i) => i !== window.dancer);
}, DANCER);
r.dance = { pressed: await press(a), seen: await dancing(b, true) };
r.dance.together = offBeat(await beat(a), await beat(b));
// In they come: told at the door what is running, which waits for the dancer
// to land, and then he starts as far in as he is for everyone else by then.
await a.waitForTimeout(2000);
await late.evaluate(() => window.letIn());
r.dance.late = { told: await late.waitForFunction((n) => window.game.actions.waiting.has(n), DANCER, { timeout: 10000 }).then(() => true, () => false) };
await late.waitForTimeout(1000);
await late.evaluate(() => { const d = window.dancer; window.game.actions.add(d.name, d.root, d.script); });
r.dance.late.seen = await dancing(late, true);
const lateBeat = await beat(late);
r.dance.late.off = offBeat(await beat(a), lateBeat);
r.dance.late.at = lateBeat.t;
r.dance.late.said = late.heard;
await late.context().close();
await Promise.all([linked(a, 1), linked(b, 1)]);
// Nobody says he has finished: each page's own run ends when the clip does.
r.dance.ended = [await dancing(a, false, 40000), await dancing(b, false, 5000)];
// The other one starts him, and stops him, for both.
r.dance.again = { pressed: await press(b), seen: await dancing(a, true) };
r.dance.again.at = (await beat(a)).t;
await press(b);
r.dance.again.stopped = [await dancing(b, false, 1000), await dancing(a, false)];

// ---- 5) One changes game ----------------------------------------------------
await a.evaluate(() => window.game.switchMode('flyover'));
await b.waitForFunction(() => [...window.game.presence.people.values()][0]?.body === 'flyer', null, { timeout: 5000 });
r.mode = { off: await settled(b, a), ghost: await ghost(b) };

// ---- 6) One leaves ----------------------------------------------------------
await a.context().close();
await linked(b, 0);
r.left = { ghosts: (await ghost(b)).count, line: await b.evaluate(() => document.getElementById('people').textContent) };

// ---- 7) Networks that refuse each other ---------------------------------------
// Relay-only with no relay to use: the handshake goes through and no route is
// ever found, which is what two unfriendly networks look like from inside.
const c = await open(q, () => {
  const Real = window.RTCPeerConnection;
  window.RTCPeerConnection = function (config) { return new Real({ ...config, iceTransportPolicy: 'relay' }); };
});
const line = () => document.getElementById('people').textContent;
// Seen at once, long before the link is given up on.
await Promise.all([linked(b, 1), linked(c, 1)]);
r.blocked = { early: [await settled(b, c), await settled(c, b)], linkStillTried: await b.evaluate(() => window.game.net.links.size) };
await Promise.all([b, c].map((p) => p.waitForFunction(() => window.game.net.indirect === 1, null, { timeout: 60000 })));
r.blocked.b = await b.evaluate(line);
r.blocked.c = await c.evaluate(line);
// The dancer, set off and stopped by way of the server.
await landed(c);
r.blocked.dance = { pressed: await press(c), seen: await dancing(b, true) };
await press(c);
r.blocked.dance.stopped = await dancing(b, false);
// Followed that way too, and redrawn on a change of game.
await c.evaluate(() => { const g = window.game, p = g.player.pos; g.player.teleport(p.x, p.y, p.z + 3); });
r.blocked.walk = await settled(b, c);
await c.evaluate(() => window.game.switchMode('flyover'));
await b.waitForFunction(() => [...window.game.presence.people.values()][0]?.body === 'flyer', null, { timeout: 10000 });
r.blocked.mode = (await ghost(b)).body;
// Standing still says nothing: every message through the server is counted.
await b.waitForTimeout(1000);
const said = b.said;
await b.waitForTimeout(3000);
r.blocked.idle = b.said - said;
await c.context().close();
await linked(b, 0);
r.blocked.after = await b.evaluate(line);

// ---- 8) The door ------------------------------------------------------------
r.door = await b.evaluate(async ([rooms, room]) => {
  const knock = () => new Promise((done) => {
    const ws = new WebSocket(`${rooms}/?room=${room}-full`);
    ws.onmessage = (e) => done(JSON.parse(e.data).type);
    ws.onerror = () => done('error');
  });
  const answers = [];
  for (let i = 0; i < 9; i++) answers.push(await knock());
  return answers;
}, [ROOMS, room]);
// Node sends no Origin, so it is not one of the game's pages.
r.stranger = await new Promise((done) => {
  const ws = new WebSocket(`${ROOMS}/?room=${room}`);
  ws.onopen = () => done('let in');
  ws.onerror = () => done('refused');
});

await browser.close();

const ok = {
  alone: r.bare.net === null && r.bare.sockets === 0 && r.bare.line === ''
    && r.off.net === null && r.off.sockets === 0,
  first: r.first.others === 0 && /nobody else/.test(r.first.line)
    && /^stun:/.test([].concat(r.first.ice[0]?.urls)[0]) && (process.env.ROOMS ? true : r.first.relay === false),
  seen: r.seen.aSeesB < 0.1 && r.seen.bSeesA < 0.1
    && r.seen.aGhost.id === r.seen.ids[1] && r.seen.bGhost.id === r.seen.ids[0]
    && r.seen.bGhost.mode === 'shooter' && r.seen.bGhost.body === 'walker' && /1 other here/.test(r.seen.line),
  walk: r.walk.moved > 2.5 && r.walk.off < 0.1,
  dance: r.dance.pressed === DANCER && r.dance.seen && r.dance.together < 0.5
    && r.dance.late.told && r.dance.late.seen && r.dance.late.off < 0.5 && r.dance.late.at > 3 && r.dance.late.said.length === 1
    && r.dance.ended.every(Boolean)
    && r.dance.again.pressed === DANCER && r.dance.again.seen && r.dance.again.at < 10 && r.dance.again.stopped.every(Boolean),
  mode: r.mode.ghost.mode === 'flyover' && r.mode.ghost.body === 'flyer' && r.mode.off < 0.1,
  left: r.left.ghosts === 0 && /nobody else/.test(r.left.line),
  blocked: r.blocked.early.every((off) => off < 0.1) && r.blocked.linkStillTried === 1
    && /1 other here \(1 by way of the server\)/.test(r.blocked.b) && /1 other here \(1 by way of the server\)/.test(r.blocked.c)
    && r.blocked.dance.pressed === DANCER && r.blocked.dance.seen && r.blocked.dance.stopped
    && r.blocked.walk < 0.1 && r.blocked.mode === 'flyer' && r.blocked.idle === 0 && /nobody else/.test(r.blocked.after),
  door: r.door.slice(0, 8).every((t) => t === 'welcome') && r.door[8] === 'full' && r.stranger === 'refused',
  errors: errs.length === 0,
};
console.log(JSON.stringify(r, null, 2));
if (errs.length) console.log('page errors:', errs);
for (const [k, v] of Object.entries(ok)) console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`);
const pass = Object.values(ok).every(Boolean);
console.log(pass ? 'NET: PASS' : 'NET: FAIL');
process.exit(pass ? 0 : 1);
