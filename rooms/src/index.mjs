// The rooms: where people in the world find each other.
//
// A Cloudflare Worker with one Durable Object per room. It introduces the
// people in a room and carries the WebRTC handshake between them; where
// anyone stands then goes browser to browser (see ../game/src/net.mjs for the
// other end). So a room is busy for the second or two someone takes to join
// and asleep the rest of the time, which is what keeps this inside the free
// plan — a hibernated room keeps its sockets open and costs nothing. The one
// thing it carries besides is `say`, below, for a pair that cannot link.
//
//   wss://<host>/?room=<name>     join a room; `lobby` when none is named
//
// To the newcomer:  { type: 'welcome', id, peers: [id, …], ice: [server, …] }   or   { type: 'full' }
// Between two:      { to, type: 'offer' | 'answer' | 'candidate', … }  →  the same, `to` replaced by `from`
// To several:       { to: [id, …], type: 'say', … }                   →  the same to each, likewise
//
// `say` is for a pair whose networks refuse a direct link: what they would
// have told each other over it goes through here instead (net.mjs says what,
// and how sparingly). It is the one thing that keeps a room awake.
// To everyone left: { type: 'leave', id }
//
// `ice` is how the newcomer's browser is to reach the others: always a STUN
// server, which tells it its own public address and is enough for most pairs
// of networks, and — when this Worker has been given a TURN key — a relay for
// the pairs that refuse each other outright. The key is two secrets, set once:
//   wrangler secret put TURN_KEY_ID          --config ../rooms/wrangler.jsonc
//   wrangler secret put TURN_KEY_API_TOKEN   --config ../rooms/wrangler.jsonc
// from the Cloudflare dashboard (Realtime → TURN Server → Create). It never
// leaves here: a browser is handed a credential made from it that expires.
import { DurableObject } from 'cloudflare:workers';

// A room is a full mesh — everyone linked to everyone — so its size is what
// one browser can hold links to. More people than this is a second room.
const ROOM_SIZE = 8;
// A handshake message is a session description at most; anything larger is
// not one.
const MESSAGE_BYTES = 16 * 1024;
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];
// How long a relay credential lasts: longer than anyone stays in a room. A
// link already made keeps working past it; only making a new one needs it.
const TURN_SECONDS = 24 * 60 * 60;

// The servers a newcomer is told to use. Anything wrong with the relay — no
// key, a refused key, Cloudflare not answering — leaves STUN alone, which is
// the game as it was before there was a relay, not a failure to join.
async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_SECONDS }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { iceServers: given } = await res.json();
    const servers = (Array.isArray(given) ? given : [given]).map((server) => ({
      ...server,
      // Port 53 is offered for networks that allow nothing else, and browsers
      // refuse to use it: left in, each link waits for it to time out.
      urls: [].concat(server.urls).filter((url) => !/:53(\?|$)/.test(url)),
    })).filter((server) => server.urls.length);
    if (!servers.some((server) => server.credential)) throw new Error('no relay in the answer');
    return servers;
  } catch (err) {
    console.error(`[rooms] no relay credential (${err.message}) — STUN only`);
    return STUN;
  }
}

export class Room extends DurableObject {
  async fetch() {
    // Asked for before the room is looked at: while this waits, someone else
    // may join, and who is here must be read and added to in one breath.
    const ice = await iceServers(this.env);
    const others = this.ctx.getWebSockets();
    const { 0: client, 1: server } = new WebSocketPair();
    // The hibernating accept: the object may be put to sleep with the socket
    // still open, and is woken by the next message on it.
    this.ctx.acceptWebSocket(server);
    if (others.length >= ROOM_SIZE) {
      server.send(JSON.stringify({ type: 'full' }));
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const peers = others.map(idOf).filter((id) => id !== null);
    // Four bytes, because the id rides in every position packet (net.mjs).
    // Kept on the socket rather than in a field: fields do not survive a sleep.
    let id;
    do { id = crypto.getRandomValues(new Uint32Array(1))[0]; } while (id === 0 || peers.includes(id));
    server.serializeAttachment({ id });
    server.send(JSON.stringify({ type: 'welcome', id, peers, ice }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, text) {
    const from = idOf(ws);
    if (from === null || typeof text !== 'string' || text.length > MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!['offer', 'answer', 'candidate', 'say'].includes(msg?.type)) return;
    const { to, ...rest } = msg;
    const targets = [].concat(to).slice(0, ROOM_SIZE);
    const passed = JSON.stringify({ ...rest, from });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws && targets.includes(idOf(peer))) peer.send(passed);
    }
  }

  webSocketClose(ws, code, reason) {
    this.left(ws);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const id = idOf(ws);
    if (id === null) return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try { peer.send(JSON.stringify({ type: 'leave', id })); } catch { /* going too */ }
    }
  }
}

// Null for a socket that was turned away at the door: it has no id and is in
// nobody's list.
function idOf(ws) {
  return ws.deserializeAttachment()?.id ?? null;
}

export default {
  fetch(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('The rooms: connect with a WebSocket, ?room=<name>.\n', { status: 426 });
    }
    // Only the game's own pages may spend the quota. ORIGINS is a
    // comma-separated list in wrangler.jsonc; a page on this machine is always
    // let in when ORIGINS names `localhost`, whatever port it is served on.
    const origin = request.headers.get('Origin') ?? '';
    const allowed = (env.ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!allowed.includes(origin) && !(local && allowed.includes('localhost'))) {
      return new Response('Not from here.\n', { status: 403 });
    }
    const room = (new URL(request.url).searchParams.get('room') ?? 'lobby').slice(0, 64);
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};
