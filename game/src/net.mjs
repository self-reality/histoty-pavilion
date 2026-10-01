// The network: other people's browsers, and what they say about where they are.
//
// It fills the list in ./presence.mjs and does nothing else. The rooms server
// (../../rooms/src/index.mjs) says who is in the room and carries the WebRTC
// handshake; after that everyone is linked to everyone directly, and where
// people stand never touches a server. Nobody is in charge and nothing is
// decided here: each browser says where it is, and the others draw a ghost
// there.
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
// Every message names its author and counts up, rather than being taken as
// "from whoever this link goes to", so that a message may one day arrive by
// way of someone else (one person feeding many) with nothing here changing:
// a stale or repeated one is dropped by its number.

// How a browser reaches another, until the rooms server says otherwise: its
// welcome brings the list to use, with a relay in it when the server has one.
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const SEND_HZ = 12;
// How fast a ghost closes on the last place it was said to be: about a send
// interval, so it glides between updates instead of stepping.
const CATCH_UP = 14;
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
    this.links = new Map();        // peer id -> { peer, pc, pos, events, chain, opened, age }
    // In the room, and no link to them could be made: there is no relay yet for
    // two networks that refuse each other. Said on the overlay, because from
    // the inside it looks exactly like an empty room.
    this.lost = new Set();
    this.ice = ICE;
    // Whether the server had a relay to offer, for the overlay: without one, a
    // pair of networks that refuse each other cannot be linked at all.
    this.relay = false;
    this.heard = new Map();        // author id -> { pos: last seq, events: last seq, at, yaw }
    this.seq = 0;
    this.since = 0;
    this.last = performance.now();

    const target = new URL(url);
    target.searchParams.set('room', room);
    this.ws = new WebSocket(target);
    this.ws.onmessage = (e) => this.signal(JSON.parse(e.data));
    this.ws.onclose = () => {
      // The links already made do not need the server; only newcomers do.
      if (this.state !== 'full') this.state = 'closed';
      this.onChange();
    };
  }

  /** How many other people are linked. */
  get others() {
    let n = 0;
    for (const link of this.links.values()) if (link.opened) n++;
    return n;
  }

  /** How many are still being linked to. */
  get linking() {
    return this.links.size - this.others;
  }

  // ---- The handshake, by way of the rooms server ----
  signal(msg) {
    if (msg.type === 'welcome') {
      this.id = msg.id;
      this.state = 'open';
      if (Array.isArray(msg.ice) && msg.ice.length) this.ice = msg.ice;
      this.relay = this.ice.some((server) => server.credential);
      console.log(`[net] in room "${this.room}" as ${this.id}, ${msg.peers.length} already here`
        + (this.relay ? '' : ' (no relay: networks that block direct links will not connect)'));
      // The newcomer calls everyone already here, so no two ever call each other.
      for (const peer of msg.peers) this.call(peer);
      this.onChange();
    } else if (msg.type === 'full') {
      this.state = 'full';
      console.warn(`[net] room "${this.room}" is full — playing alone`);
      this.onChange();
    } else if (msg.type === 'leave') {
      this.drop(msg.id);
      if (this.lost.delete(msg.id)) this.onChange();
    } else if (msg.from != null) {
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

  drop(peer) {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    link.pc.close();
    if (!link.opened) {
      this.lost.add(peer);
      console.warn(`[net] no direct link to ${peer} could be made — a network between you is blocking it`);
    }
    // Today a link's far end is the only author heard over it. When messages
    // are passed on, leaving becomes an event of its own.
    this.heard.delete(peer);
    this.presence.leave(peer);
    this.onChange();
  }

  // ---- What is said over the links ----
  /** Say what this browser is: on a new link, and again when its game changes. */
  hello(only = null) {
    const me = this.me();
    if (!me || this.id === null) return;
    const text = JSON.stringify({ from: this.id, seq: ++this.seq, type: 'hello', mode: me.mode, body: me.body });
    for (const link of only ? [only] : this.links.values()) {
      if (link.events.readyState === 'open') link.events.send(text);
    }
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
    if (msg.type === 'hello') {
      // Joining again is how a change of game is shown: the ghost is redrawn
      // as whatever it now moves as. Where it stood is kept.
      this.presence.join(msg.from, { mode: String(msg.mode), body: String(msg.body) });
      const heard = this.heard.get(msg.from);
      if (heard.at) this.presence.move(msg.from, heard.at, heard.yaw);
    }
  }

  position(data) {
    if (data.byteLength !== POS_BYTES) return;
    const v = new DataView(data);
    const author = v.getUint32(0);
    if (!this.fresh(author, 'pos', v.getUint32(4))) return;
    const said = { x: v.getFloat32(8), y: v.getFloat32(12), z: v.getFloat32(16), yaw: v.getFloat32(20) };
    if (![said.x, said.y, said.z, said.yaw].every(Number.isFinite)) return;
    const heard = this.heard.get(author);
    heard.to = said;
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

    for (const link of [...this.links.values()]) {
      if (!link.opened && (link.age += dt) > LINK_SECONDS) this.drop(link.peer);
    }

    const k = 1 - Math.exp(-CATCH_UP * dt);
    for (const [author, heard] of this.heard) {
      if (!heard.to) continue;
      heard.at.x += (heard.to.x - heard.at.x) * k;
      heard.at.y += (heard.to.y - heard.at.y) * k;
      heard.at.z += (heard.to.z - heard.at.z) * k;
      // The short way round: 350° to 10° is 20°, not 340°.
      heard.yaw += ((((heard.to.yaw - heard.yaw) % 360) + 540) % 360 - 180) * k;
      this.presence.move(author, heard.at, heard.yaw);
    }
  }
}
