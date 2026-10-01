// The network: other people's browsers, and what they say about where they are.
//
// It fills the list in ./presence.mjs and does nothing else. The rooms server
// (../../rooms/src/index.mjs) says who is in the room and carries the WebRTC
// handshake; after that everyone is linked to everyone directly, and where
// people stand does not touch a server. Nobody is in charge and nothing is
// decided here: each browser says where it is, and the others draw a ghost
// there.
//
// Some pairs of networks refuse a direct link. To anyone it has no open link
// to — for the second a link takes to open, or for good when none can be made
// — a browser says the same things by way of the rooms server instead, less
// often (`say`, below). So two people in a room always see each other; the
// direct link only makes it smoother and free.
//
// Which server, in increasing priority:
//   1. `rooms` in scene.manifest.mjs — the published one. Not used by a page on
//      this machine: the server would turn it away, and a test should not walk
//      into the public lobby.
//   2. ?rooms=ws://localhost:8787 — another one (`npm run rooms:dev`).
//      ?rooms=off — none.
// With none the world is simply empty of other people, as it is when the
// server cannot be reached. `?room=<name>` picks the room; `lobby` otherwise.
//
// Two channels per link, the same for every game played here:
//   pos     where the author stands — binary, unordered, never resent: a late
//           position is worth nothing.
//           [u32 author][u32 seq][f32 x][f32 y][f32 z][f32 yaw]
//   events  what the author is — JSON, reliable.
//           { from, seq, type: 'hello', mode, body }
// And one message by way of the server, carrying either or both:
//   { to: [id, …], type: 'say', seq, hello?: { mode, body }, pos?: [x, y, z, yaw] }
// Every message names its author and counts up, rather than being taken as
// "from whoever this link goes to", so the same thing may arrive by two ways,
// or one day by way of someone else, with nothing here changing: a stale or
// repeated one is dropped by its number.

// How a browser reaches another, until the rooms server says otherwise: its
// welcome brings the list to use, with a relay in it when the server has one.
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const SEND_HZ = 12;
// How fast a ghost closes on the last place it was said to be: about a send
// interval, so it glides between updates instead of stepping.
const CATCH_UP = 14;
// By way of the server it is said less often and only when it has changed:
// every message through there is counted against the free plan, and someone
// standing still has nothing new to say. The ghost glides to match.
const SERVER_HZ = 5;
const SERVER_CATCH_UP = 6;
const POS_BYTES = 24;
// How long a link may take to open before it is given up on. Two networks
// that will not link directly do not always say so; some just never answer.
const LINK_SECONDS = 20;

/** The rooms server this page should use, or null. */
export function roomsUrl(authored) {
  const asked = new URLSearchParams(location.search).get('rooms');
  if (asked === 'off') return null;
  if (asked) {
    try {
      const url = new URL(asked);
      if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
    } catch { /* not a URL */ }
    console.warn(`[net] ?rooms=${asked} is not a ws:// or wss:// address — playing alone`);
    return null;
  }
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  return authored && !local ? authored : null;
}

export class Net {
  /**
   * `me()` is what this browser says about itself, or null while there is no
   * game on stage: { mode, body, pos, yaw } — `pos` the point its game keeps
   * (feet for a walker, lens for a flyer), which is what Presence.move takes.
   */
  constructor({ url, room = 'lobby', presence, me, onChange = () => {} }) {
    this.presence = presence;
    this.me = me;
    this.onChange = onChange;
    this.room = room;
    this.id = null;
    this.state = 'connecting';     // connecting | open | full | closed
    this.peers = new Set();        // everyone else in the room
    this.links = new Map();        // peer id -> { peer, pc, pos, events, chain, opened, age }
    this.ice = ICE;
    // Whether the server had a TURN relay to offer: with one, a pair of
    // networks that refuse each other is still linked, through it.
    this.relay = false;
    this.heard = new Map();        // author id -> { pos: last seq, events: last seq, at, yaw, to, slow }
    this.seq = 0;
    this.since = 0;
    this.sinceServer = 0;
    this.told = null;              // what was last said by way of the server: [x, y, z, yaw]
    this.owed = false;             // someone new is listening that way and has not heard it
    this.last = performance.now();

    const target = new URL(url);
    target.searchParams.set('room', room);
    this.ws = new WebSocket(target);
    this.ws.onmessage = (e) => this.signal(JSON.parse(e.data));
    this.ws.onclose = () => {
      // The links already made do not need the server; newcomers do, and so
      // does anyone who was only ever reached through it.
      if (this.state !== 'full') this.state = 'closed';
      for (const peer of this.viaServer()) this.forget(peer);
      this.onChange();
    };
  }

  /** How many other people are here. */
  get others() {
    return this.peers.size;
  }

  /** How many of them no direct link could be made to. */
  get indirect() {
    let n = 0;
    for (const peer of this.peers) if (!this.links.has(peer)) n++;
    return n;
  }

  // Everyone there is no open link to: said to by way of the server.
  viaServer() {
    return [...this.peers].filter((peer) => !this.links.get(peer)?.opened);
  }

  // Someone is in the room who was not known to be.
  met(peer) {
    if (this.peers.has(peer)) return;
    this.peers.add(peer);
    this.owed = true;
    this.say([peer], { hello: this.what() });
    this.onChange();
  }

  // ---- The handshake, by way of the rooms server ----
  signal(msg) {
    if (msg.type === 'welcome') {
      this.id = msg.id;
      this.state = 'open';
      if (Array.isArray(msg.ice) && msg.ice.length) this.ice = msg.ice;
      this.relay = this.ice.some((server) => server.credential);
      console.log(`[net] in room "${this.room}" as ${this.id}, ${msg.peers.length} already here`);
      // The newcomer calls everyone already here, so no two ever call each other.
      for (const peer of msg.peers) { this.met(peer); this.call(peer); }
      this.onChange();
    } else if (msg.type === 'full') {
      this.state = 'full';
      console.warn(`[net] room "${this.room}" is full — playing alone`);
      this.onChange();
    } else if (msg.type === 'leave') {
      this.forget(msg.id);
    } else if (msg.type === 'say' && msg.from != null) {
      this.met(msg.from);
      if (msg.hello && this.fresh(msg.from, 'events', msg.seq)) this.joined(msg.from, msg.hello);
      if (Array.isArray(msg.pos) && this.fresh(msg.from, 'pos', msg.seq)) {
        const [x, y, z, yaw] = msg.pos;
        this.stands(msg.from, { x, y, z, yaw }, true);
      }
    } else if (msg.from != null) {
      this.met(msg.from);
      const link = this.links.get(msg.from) ?? (msg.type === 'offer' ? this.link(msg.from) : null);
      if (!link) return;
      // One at a time and in order: a candidate that overtakes the description
      // it belongs to is refused by the browser.
      link.chain = link.chain.then(() => this.answer(link, msg)).catch((err) => {
        console.warn(`[net] handshake with ${msg.from} failed: ${err.message}`);
      });
    }
  }

  send(to, msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ to, ...msg }));
  }

  // The same things the links carry, by way of the server, to those it names.
  say(to, what) {
    if (to.length && this.id !== null) this.send(to, { type: 'say', seq: ++this.seq, ...what });
  }

  // What this browser is, as a hello says it.
  what() {
    const me = this.me();
    return me ? { mode: me.mode, body: me.body } : undefined;
  }

  link(peer) {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    // Agreed in advance by number, so neither side waits to be told of them.
    const pos = pc.createDataChannel('pos', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const events = pc.createDataChannel('events', { negotiated: true, id: 1 });
    pos.binaryType = 'arraybuffer';
    const link = { peer, pc, pos, events, chain: Promise.resolve(), opened: false, age: 0 };
    this.links.set(peer, link);

    pc.onicecandidate = (e) => { if (e.candidate) this.send(peer, { type: 'candidate', candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.drop(peer);
    };
    events.onopen = () => { link.opened = true; this.hello(link); this.onChange(); };
    events.onmessage = (e) => this.event(JSON.parse(e.data));
    events.onclose = () => this.drop(peer);
    pos.onmessage = (e) => this.position(e.data);
    this.onChange();
    return link;
  }

  call(peer) {
    const link = this.link(peer);
    link.chain = link.chain.then(async () => {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      this.send(peer, { type: 'offer', sdp: link.pc.localDescription.sdp });
    });
  }

  async answer(link, msg) {
    const { pc } = link;
    if (msg.type === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      this.send(link.peer, { type: 'answer', sdp: pc.localDescription.sdp });
    } else if (msg.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.type === 'candidate') {
      await pc.addIceCandidate(msg.candidate);
    }
  }

  // The link to someone is gone, or never came. They are still in the room
  // until the server says they left, and are reached through it from here on —
  // unless the server is gone too, and then there is no way left.
  drop(peer) {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    link.pc.close();
    if (this.ws.readyState !== WebSocket.OPEN) { this.forget(peer); return; }
    if (!link.opened) console.warn(`[net] no direct link to ${peer} could be made — reaching them by way of the server`);
    this.owed = true;
    this.onChange();
  }

  // Someone left the room.
  forget(peer) {
    if (!this.peers.delete(peer)) return;
    const link = this.links.get(peer);
    this.links.delete(peer);
    link?.pc.close();
    this.heard.delete(peer);
    this.presence.leave(peer);
    this.onChange();
  }

  // ---- What is said over the links ----
  /** Say what this browser is: on a new link, and again when its game changes. */
  hello(only = null) {
    const what = this.what();
    if (!what || this.id === null) return;
    const text = JSON.stringify({ from: this.id, seq: ++this.seq, type: 'hello', ...what });
    for (const link of only ? [only] : this.links.values()) {
      if (link.events.readyState === 'open') link.events.send(text);
    }
    if (!only) this.say(this.viaServer(), { hello: what });
  }

  // Newer than the last one heard from this author on this channel?
  fresh(author, channel, seq) {
    if (author === this.id) return false;
    let heard = this.heard.get(author);
    if (!heard) this.heard.set(author, heard = { pos: 0, events: 0, at: null, yaw: 0 });
    if (seq <= heard[channel]) return false;
    heard[channel] = seq;
    return true;
  }

  event(msg) {
    if (!this.fresh(msg.from, 'events', msg.seq)) return;
    if (msg.type === 'hello') this.joined(msg.from, msg);
  }

  // Joining again is how a change of game is shown: the ghost is redrawn as
  // whatever it now moves as. Where it stood is kept.
  joined(author, { mode, body }) {
    this.presence.join(author, { mode: String(mode), body: String(body) });
    const heard = this.heard.get(author);
    if (heard.at) this.presence.move(author, heard.at, heard.yaw);
  }

  position(data) {
    if (data.byteLength !== POS_BYTES) return;
    const v = new DataView(data);
    const author = v.getUint32(0);
    if (!this.fresh(author, 'pos', v.getUint32(4))) return;
    this.stands(author, { x: v.getFloat32(8), y: v.getFloat32(12), z: v.getFloat32(16), yaw: v.getFloat32(20) }, false);
  }

  // Where an author says it is. `slow`: heard by way of the server.
  stands(author, said, slow) {
    if (![said.x, said.y, said.z, said.yaw].every(Number.isFinite)) return;
    const heard = this.heard.get(author);
    heard.to = said;
    heard.slow = slow;
    // The first one is where they are; from then on it is where to glide to.
    if (!heard.at) { heard.at = { x: said.x, y: said.y, z: said.z }; heard.yaw = said.yaw; }
  }

  /**
   * Once a frame: say where this browser is, and move the ghosts. On the wall
   * clock, not the world's: the engine caps a slow frame's dt, and a slow frame
   * is not a slow network.
   */
  update() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 1);
    this.last = now;
    this.since += dt;
    if (this.since >= 1 / SEND_HZ && this.id !== null) {
      this.since = 0;
      const me = this.me();
      if (me) {
        const v = new DataView(new ArrayBuffer(POS_BYTES));
        v.setUint32(0, this.id);
        v.setUint32(4, ++this.seq);
        v.setFloat32(8, me.pos.x); v.setFloat32(12, me.pos.y); v.setFloat32(16, me.pos.z);
        v.setFloat32(20, me.yaw);
        for (const link of this.links.values()) {
          if (link.pos.readyState === 'open') link.pos.send(v.buffer);
        }
      }
    }

    this.sinceServer += dt;
    if (this.sinceServer >= 1 / SERVER_HZ) {
      this.sinceServer = 0;
      const me = this.me();
      const to = this.viaServer();
      if (me && to.length) {
        const now = [me.pos.x, me.pos.y, me.pos.z, me.yaw].map((n) => Math.round(n * 100) / 100);
        if (this.owed || !this.told || now.some((n, i) => n !== this.told[i])) {
          this.say(to, { pos: now });
          this.told = now;
          this.owed = false;
        }
      }
    }

    for (const link of [...this.links.values()]) {
      if (!link.opened && (link.age += dt) > LINK_SECONDS) this.drop(link.peer);
    }

    for (const [author, heard] of this.heard) {
      if (!heard.to) continue;
      const k = 1 - Math.exp(-(heard.slow ? SERVER_CATCH_UP : CATCH_UP) * dt);
      heard.at.x += (heard.to.x - heard.at.x) * k;
      heard.at.y += (heard.to.y - heard.at.y) * k;
      heard.at.z += (heard.to.z - heard.at.z) * k;
      // The short way round: 350° to 10° is 20°, not 340°.
      heard.yaw += ((((heard.to.yaw - heard.yaw) % 360) + 540) % 360 - 180) * k;
      this.presence.move(author, heard.at, heard.yaw);
    }
  }
}
