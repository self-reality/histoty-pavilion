// The rooms: where people in the world find each other.
//
// A Cloudflare Worker with one Durable Object per room. It introduces the
// people in a room and carries the WebRTC handshake between them, and that is
// all it does: where anyone stands goes browser to browser, never through
// here (see ../game/src/net.mjs for the other end). So a room is busy for the
// second or two someone takes to join and asleep the rest of the time, which
// is what keeps this inside the free plan — a hibernated room keeps its
// sockets open and costs nothing.
//
//   wss://<host>/?room=<name>     join a room; `lobby` when none is named
//
// To the newcomer:  { type: 'welcome', id, peers: [id, …] }   or   { type: 'full' }
// Between two:      { to, type: 'offer' | 'answer' | 'candidate', … }  →  the same, `to` replaced by `from`
// To everyone left: { type: 'leave', id }
import { DurableObject } from 'cloudflare:workers';

// A room is a full mesh — everyone linked to everyone — so its size is what
// one browser can hold links to. More people than this is a second room.
const ROOM_SIZE = 8;
// A handshake message is a session description at most; anything larger is
// not one.
const MESSAGE_BYTES = 16 * 1024;

export class Room extends DurableObject {
  async fetch() {
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
    server.send(JSON.stringify({ type: 'welcome', id, peers }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, text) {
    const from = idOf(ws);
    if (from === null || typeof text !== 'string' || text.length > MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!['offer', 'answer', 'candidate'].includes(msg?.type)) return;
    const { to, ...rest } = msg;
    for (const peer of this.ctx.getWebSockets()) {
      if (idOf(peer) === to) peer.send(JSON.stringify({ ...rest, from }));
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
