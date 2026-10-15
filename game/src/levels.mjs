// Levels of detail, loaded when they are wanted.
//
// A leveled asset ships as a package whose object is its coarsest drawing —
// the statue, with all its collision — and, beside it, finer drawings of the
// same thing: `<stem>.lod1.glb`, `<stem>.lod0.glb`, …, listed coarse to fine in
// its manifest's `levels` (the kit's ASSET_CONTRACT.md, section 6). Only the
// object is loaded at start. This module watches how big each leveled prop is
// on screen and, once the layout has landed, fetches the finer files the view
// wants — biggest on screen first, two at a time — and draws the prop from
// them with its script's relevel() (./script.mjs, the kit's runtime): a child
// under each part drawing that part from the level file, the part's own
// instances hidden. No entity anything holds is replaced, so turns, spawned
// copies, painted screens, the E key's reach and the collider baked from the
// object all hold. Collision is never touched again.
//
// Level index everywhere here: 0 is the object as shipped, n is the
// manifest's levels[n - 1].
//
// How big is "big on screen": the prop's bounding sphere, seen from the
// camera, as a fraction of the viewport's height — 1 fills it top to bottom,
// whatever the window's size. A level is wanted once that fraction reaches
// its entry's `screen` (times BIAS). Coming back down, a level is kept until
// the fraction falls below 0.8 of its threshold, so standing at the boundary
// does not flicker between two. A held clock (tools/record.mjs) has no such
// memory: there the level is a pure function of the camera, so the same shot
// is the same pixels however it was reached.
//
// The address bar can say otherwise: `?levels=off` leaves every prop as
// shipped and requests no level file at all; `?level=2` draws every leveled
// prop at that level (clamped to what each has), near or far — for tests,
// screenshots and the worst case tests/perf.mjs measures.
//
// Memory, v1: nothing is ever unloaded. Going down to the object disables the
// level children, which stay built, and an upload once paid is not paid again.
// stats() says how many megabytes that has come to.
import { BoundingBox, Vec3 } from 'playcanvas';

/** One place to tune every threshold at once: a level is wanted at `screen` × BIAS. */
export const BIAS = 1;
/** How far under its threshold a level drawn is kept, as a fraction of it. */
const KEEP = 0.8;
/** Selection runs every this many frames while played (every frame while held). */
const EVERY = 6;
/** At most this many level files download at once. */
const AT_ONCE = 2;

export class Levels {
  /**
   * `camera` is the camera entity. `loadContainer(url)` is main.mjs's one
   * container per URL, so two copies of an asset share one download.
   * `propTurn()` is main.mjs's one-a-frame queue: a level drawn for the first
   * time uploads its textures and links its shaders, and that is a prop's
   * first draw over again. `prepare(resource)` is what main.mjs does to a
   * container's materials before a prop is placed from it, done to a level
   * file's once, before anything draws from it — before relevel() copies a
   * material a script owns and paints the copy, as placeProp's order has it.
   * `after(root, name)` is what main.mjs does to a prop's materials once it is
   * on stage, done again to the level's, and the E key told the prop's
   * instances changed. `drained()` says the layout has
   * landed: nothing is fetched before, so the levels never queue in front of
   * an object still on its way.
   */
  constructor({ app, camera, loadContainer, propTurn, clock, prepare = () => {}, after = () => {}, drained = () => true }) {
    this.app = app;
    this.camera = camera;
    this.loadContainer = loadContainer;
    this.propTurn = propTurn;
    this.clock = clock;
    this.prepare = prepare;
    this.after = after;
    this.drained = drained;
    const query = new URLSearchParams(location.search);
    this.enabled = query.get('levels') !== 'off';
    const forced = query.get('level');
    this.forced = forced !== null && forced !== '' && Number.isFinite(Number(forced)) ? Math.max(0, Math.floor(Number(forced))) : null;
    this.props = [];
    this.files = new Map();   // level file URL -> { asset, bytes, state: 'loading' | 'loaded' | 'failed', landed: Promise }
    this.loading = 0;         // files downloading now
    this.turning = null;      // the one first draw Levels has waiting on a propTurn, or null
    this.frame = 0;
    this.camPos = new Vec3();
  }

  /**
   * A prop has landed, its script started. Registered only when it has levels
   * and nothing about it a level could not follow — a clip or a pose drives
   * the object's own nodes, and a skinned mesh deforms its own instances; a
   * level child would stand still beside them. Those are drawn as shipped.
   */
  add({ name, root, script, loaded }) {
    const manifest = loaded?.manifest;
    const levels = manifest?.levels;
    if (!this.enabled || !Array.isArray(levels) || !levels.length || typeof script?.relevel !== 'function') return null;
    const animated = ['clips', 'skeleton', 'rig', 'pose', 'hide', 'offset', 'move'].filter((k) => manifest[k] !== undefined);
    const instances = root.findComponents('render').flatMap((rc) => rc.meshInstances);
    if (animated.length || instances.some((mi) => mi.skinInstance)) {
      console.warn(`[levels ${name}] drawn as shipped: levels are not followed on a prop that `
        + (animated.length ? `carries ${animated.join(', ')}` : 'has a skinned mesh'));
      return null;
    }
    // The bounding sphere, once: around what the object draws (its collision
    // proxies and volumes are hidden by now), in the world. A placed prop does
    // not move, and one that turns turns about its own origin, inside it.
    const box = new BoundingBox();
    let first = true;
    for (const mi of instances) {
      if (!mi.visible) continue;
      if (first) box.copy(mi.aabb); else box.add(mi.aabb);
      first = false;
    }
    if (first) return null;
    const prop = {
      name, root, script,
      levels: levels.map((entry) => ({
        url: new URL(entry.file, loaded.url).href,
        screen: Number(entry.screen) || Infinity,
        bytes: Number(entry.bytes) || 0,
      })),
      centre: box.center.clone(),
      radius: box.halfExtents.length(),
      size: 0,              // on-screen diameter / viewport height, last measured
      want: 0,              // the level the view asks for
      at: 0,                // the level drawn
      built: new Set([0]),  // levels already drawn once on this prop: a switch back to one is free
      warned: false,
    };
    this.props.push(prop);
    this.select(prop, this.clock.held);
    return prop;
  }

  /** Every frame, after the game has put the camera where it is this frame. */
  update() {
    if (!this.props.length) return;
    const held = this.clock.held;
    if (!held && (this.frame++ % EVERY) !== 0) return;
    for (const p of this.props) this.select(p, held);
    this.apply();
  }

  /**
   * Which level the view wants of one prop. `pure`: no hysteresis — the answer
   * depends on the camera alone.
   */
  select(p, pure) {
    const cam = this.camera.camera;
    this.camPos.copy(this.camera.getPosition());
    const d = this.camPos.distance(p.centre);
    const device = this.app.graphicsDevice;
    const aspect = device.width / device.height || 1;
    const half = cam.fov * Math.PI / 360;
    // PlayCanvas's fov is vertical unless the camera says it is horizontal.
    const tanV = cam.horizontalFov ? Math.tan(half) / aspect : Math.tan(half);
    p.size = d <= p.radius ? Infinity : p.radius / (d * tanV);
    if (this.forced !== null) { p.want = Math.min(this.forced, p.levels.length); return; }
    let want = 0;
    for (let n = 1; n <= p.levels.length; n++) if (p.size >= p.levels[n - 1].screen * BIAS) want = n;
    if (!pure && want < p.at && p.size >= p.levels[p.at - 1].screen * BIAS * KEEP) want = p.at;
    p.want = want;
  }

  /**
   * Move every prop toward what it wants: a level already built on it, or the
   * object, drawn at once; one whose file has landed, drawn on a prop turn,
   * one prop at a time; the rest fetched, biggest on screen first.
   */
  apply() {
    const fetches = [];
    let first = null;
    for (const p of this.props) {
      if (p.want === p.at) continue;
      if (p.built.has(p.want)) { this.draw(p, p.want); continue; }
      const file = this.fileOf(p, p.want);
      if (!file || file.state === 'loading') {
        if (!file) fetches.push(p);
        continue;
      }
      if (file.state === 'failed') continue;           // stays at what it shows
      if (!first || p.size > first.size) first = p;
    }
    if (first && !this.turning) {
      const p = first;
      const n = p.want;
      this.turning = this.propTurn().then(() => {
        this.turning = null;
        // The view may have moved on while the turn came round.
        if (p.want === n && p.at !== n) this.draw(p, n);
        this.apply();
      });
    }
    if (!this.clock.held && !this.drained()) return;
    // The finest level wanted is fetched directly: the ones between are not
    // fetched first on the way up.
    fetches.sort((a, b) => b.size - a.size);
    for (const p of fetches) {
      if (this.loading >= AT_ONCE) break;
      if (!this.fileOf(p, p.want)) this.fetch(p.levels[p.want - 1]);
    }
  }

  /** The level file a prop's level n is drawn from, if it has been asked for. */
  fileOf(p, n) {
    return n > 0 ? this.files.get(p.levels[n - 1].url) ?? null : null;
  }

  fetch(entry) {
    const asset = this.loadContainer(entry.url);
    const file = { asset, bytes: entry.bytes, state: 'loading', landed: null };
    this.files.set(entry.url, file);
    this.loading++;
    file.landed = new Promise((resolve) => {
      const done = (ok) => {
        if (file.state !== 'loading') return;
        file.state = ok ? 'loaded' : 'failed';
        this.loading--;
        // loadContainer has already said why on the console; the props that
        // wanted it stay at what they show, and the URL is not asked for again.
        resolve(ok);
        this.apply();
      };
      asset.once('error', () => done(false));
      asset.ready(() => done(true));
    });
  }

  /** Draw one prop at level n — its script's relevel(), then the materials and the E key told. */
  draw(p, n) {
    const file = n > 0 ? this.fileOf(p, n) : null;
    const resource = file?.asset.resource ?? null;
    if (resource && !file.prepared) { file.prepared = true; this.prepare(resource); }
    const { missing } = p.script.relevel(n, resource);
    p.built.add(n);
    p.at = n;
    if (missing.length && !p.warned) {
      p.warned = true;
      console.warn(`[levels ${p.name}] level ${n} has no ${missing.join(', ')} — drawn as shipped there`);
    }
    this.after(p.root, p.name);
  }

  /**
   * Resolves once every prop is drawn at what the view wants of it, or at the
   * nearest it can be — a file that failed is not waited for. What a held
   * clock awaits before it draws a frame, so a recorded frame is never filmed
   * half way through a level arriving.
   */
  async ready() {
    for (;;) {
      this.apply();
      const waits = [...this.files.values()].filter((f) => f.state === 'loading').map((f) => f.landed);
      if (this.turning) waits.push(this.turning);
      if (!waits.length) return;
      await Promise.all(waits);
    }
  }

  /** Select now from where the camera is, with no memory of the last answer, and wait until it is drawn. */
  async settle() {
    for (const p of this.props) this.select(p, true);
    await this.ready();
  }

  /** How many props at each level, what has been downloaded for them, and how many are not yet at the level wanted. */
  stats() {
    const top = Math.max(0, ...this.props.map((p) => p.levels.length));
    const at = new Array(top + 1).fill(0);
    for (const p of this.props) at[p.at]++;
    let bytes = 0;
    for (const f of this.files.values()) if (f.state === 'loaded') bytes += f.bytes;
    const pending = this.props.filter((p) => p.want !== p.at && this.fileOf(p, p.want)?.state !== 'failed').length;
    return { props: this.props.length, at, fetchedMB: bytes / 1e6, pending };
  }
}
