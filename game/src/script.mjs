// An asset's script — what a placed object does, run as the code it is.
//
// The REFERENCE RUNTIME of script API 1. It lives in the asset kit
// (singularity-development-kit/runtime/, with ./rig.mjs beside it) and is
// copied verbatim into every consumer that runs scripts — the pavilion's
// src/script.mjs, and the kit's own viewer, which imports it from here. Edit it
// here and copy it out (`npm run runtime:pull` in the pavilion), so an asset
// previewed in the kit does exactly what it does in the pavilion.
// PlayCanvas; it imports 'playcanvas' and ./rig.mjs and nothing else.
//
// A package is three things (section 6 of the asset kit's ASSET_CONTRACT.md):
// the OBJECT, a .glb; its MANIFEST, a .manifest.json saying what the object is
// — its clips, its rig, the pose it stands in, the volumes it carries; and its
// SCRIPT, a .script.js saying what it does. Static props have none of it and
// nothing here runs for them. A consumer hands over the manifest's URL — the
// pavilion's scene exporter writes it into the placement beside the GLB's —
// and the manifest names the script, so this side never guesses at a file.
//
// The manifest is read at boot with the layout (loadManifest) — the level is
// cut by the holes it carries before the objects that carry them have landed.
// The script is loaded with the object (loadPackage) and run once it is on
// stage: its default export is called with `object`, and everything the
// script can do is a member of that — Script API 1:
//
//   object.play(clip, opts)             a manifest clip on the rig, at rest
//   object.sound(file, opts)            an audio file of the folder, from where it stands
//   object.video(file, { material })    a video on one of its materials
//   object.canvas(material, opts)       a 2D canvas painted onto one of its materials
//   object.on('tick', fn)               fn(dt) every frame, in game time
//   object.wait(seconds)                a promise, in game time
//   object.action(options, { start, stop })   what a player standing by it can set off
//   object.open(url, { newTab })        a link out of the page
//   object.menu({ text, buttons })      a question put to the player; the button pressed
//
// Each of play / sound / video / wait / menu hands back a PLAYBACK: a promise
// with a stop(). The key on an action calls its script's `start(run)` — a RUN is
// the same five, tied to that one time the action was started, plus end() and a
// label — and the action runs until what start returned settles or the script
// ends the run. The key on a running action calls its `stop(run)`, and what
// that means is the script's to say: this side never ends a run by itself.
// A press may carry the player's view as a world-space ray, trigger(name,
// { ray }); where it first meets what the object draws is `run.aim` —
// material, uv, point and normal — so a script can act on the spot looked at.
// Ended, everything the run started stops, and what it was waiting on
// rejects, so an async start ends where it stood. Who presses the key — which
// key, from how near — is the consumer's business (the pavilion's actions.mjs,
// the viewer's buttons), not this file's: here an action is a method somebody
// calls.
//
// An action offered as `shared` is the room's rather than the player's: where
// a consumer has other people in the world, a key any of them presses is
// passed on, and each of their copies of this file is told the same —
// trigger(name, { age }) with how long ago that was. The run then starts that
// old, `run.age` says so, and a clip played `{ from: run.age }` is where it is
// for everybody else. Who the others are and how they are told is the
// consumer's (the pavilion's net.mjs); here a late start is a number.
//
// Everything a script starts runs in GAME time — the dt update() is handed —
// clips, waits, ticks, and sounds and videos too: a sound ends its length
// after it started and a video shows the frame of its own time, whatever the
// audio clock or the element did. So a consumer that holds its clock and steps
// it (a recorder) sees exactly what it would have played: it passes `held`, a
// function saying whether it is holding, and awaits ready() before drawing
// each step. It may also pass `report`, told of every sound started and cut
// short, to mix a sound track of its own afterwards.
//
// A script sees only `object`. It imports nothing and touches no engine, which
// is what lets an asset built for one pavilion run in another. And it is code
// with the page's rights, so only a script served from the page's own origin
// is run — the ones the consumer ships.
//
// The manifest's pose is how the object STANDS: applied once, here, before
// collision is baked and before the script runs. A consumer's own
// per-placement pose (the pavilion's `rigs` in scene.manifest.mjs) goes on top
// of it: the asset says what it is anywhere, the consumer says what this copy
// is here.
//
// ---- Clips are deltas on the bind pose, composed the OTHER way round ----
//
// A `rigs` pose is `rest * delta`: a hand-dialled euler triple reads as "bend
// this joint in its own axes". A clip's key is `delta * rest`: the exporter
// aims each bone in its PARENT'S frame, because that is the frame a measured
// direction lives in. Same words, opposite order, one whole bind rotation
// apart — so the two never share a line of code, and ClipPlayer.seek() is the
// mirror of `rig-preview.js` in the motion-capture tool, which is how the
// producing end checked its numbers.
import * as pc from 'playcanvas';
import { PropRig, matchNodes } from './rig.mjs';

const { Quat, Vec3, Mat4, Color, Texture, Asset } = pc;

export const MANIFEST_VERSION = 1;
export const SCRIPT_API = 1;

// One fetch per URL, shared by every placement of the asset — the same dedup
// a consumer's container cache does for the GLB.
const manifests = new Map();
const packages = new Map();

/**
 * The manifest's JSON and nothing else — no clips, no script.
 *
 * This is what startup waits for. A packaged asset's manifest carries the
 * negative spaces it cuts out of the map, and the map is cut before its
 * collision is built, so every placed asset's manifest is read before the
 * level is walkable. That is only affordable because a manifest is a few KB:
 * a dancer's clip is a few hundred, and nothing at startup needs it.
 *
 * `no-cache` rather than the placements file's `no-store`: an asset changes
 * when it is copied in again, not on every export, so a revalidated cache is
 * the right fit. The dev server answers a conditional GET with 304.
 */
export function loadManifest(url) {
  let pending = manifests.get(url);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();
      if (manifest.version !== MANIFEST_VERSION) {
        console.warn(`[manifest ${url}] version ${manifest.version}, this loader reads ${MANIFEST_VERSION}`);
      }
      for (const key of ['play', 'actions']) {
        if (manifest[key] !== undefined) {
          console.warn(`[manifest ${url}] carries \`${key}\`, which is ignored — what an object does is its script's`);
        }
      }
      return manifest;
    })();
    manifests.set(url, pending);
  }
  return pending;
}

/**
 * The script's module, loaded from its source text rather than by URL.
 *
 * Fetched like the manifest — revalidated, so a script copied in again is the
 * one that runs on the next reload, which an `import()` by URL does not
 * promise — and imported from a Blob. A script imports nothing, so there is
 * nothing for a Blob URL to fail to resolve; the `sourceURL` comment puts the
 * real file name in a stack trace.
 */
async function loadScriptModule(url) {
  if (url.origin !== location.origin) throw new Error(`${url.href} is not on this site — only a script the page's own site ships is run`);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url.pathname.split('/').pop()}: HTTP ${res.status}`);
  const source = `${await res.text()}\n//# sourceURL=${url.href}\n`;
  const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const mod = await import(blob);
    if (typeof mod.default !== 'function') throw new Error(`${url.pathname.split('/').pop()} has no default export to call`);
    return mod.default;
  } finally {
    URL.revokeObjectURL(blob);
  }
}

/**
 * Fetch a package: its manifest, every clip the manifest lists, and its script.
 * Resolves to { url, manifest, clips, setup } — `clips` a Map by name, `setup`
 * the script's default export or null — or rejects with why.
 *
 * Every clip is fetched up front rather than when a script first plays it: a
 * dance that starts a round trip late is a dance that ignored you, the clips
 * are a few hundred KB beside a GLB of a megabyte, and which of them a script
 * plays is only known by running it.
 */
export function loadPackage(url) {
  let pending = packages.get(url);
  if (!pending) {
    pending = (async () => {
      const manifest = await loadManifest(url);
      // Relative to the manifest, not the page: the folder is the unit that moves.
      const base = new URL(url, location.href);
      const clips = new Map();
      const script = manifest.script ? loadScriptModule(new URL(manifest.script, base)) : Promise.resolve(null);
      await Promise.all((manifest.clips ?? []).map(async (entry) => {
        const r = await fetch(new URL(entry.file, base), { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${entry.file}: HTTP ${r.status}`);
        clips.set(entry.name, await r.json());
      }));
      return { url: base.href, manifest, clips, setup: await script };
    })();
    packages.set(url, pending);
  }
  return pending;
}

function isUnder(node, ancestor) {
  for (let n = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

function depthOf(node) {
  let d = 0;
  for (let n = node.parent; n; n = n.parent) d++;
  return d;
}

/** The shallowest of several matches — one skeleton's worth of a shared name. */
function shallowest(nodes) {
  return nodes.reduce((best, n) => (!best || depthOf(n) < depthOf(best) ? n : best), null);
}

/** First index whose time is greater than t, by bisection. */
function upperBound(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] > t) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/**
 * Read the character's own axes off the bind pose.
 *
 * A clip's pelvis track is in the character's terms — x to their right, y up,
 * z behind — and which way those run in the model is the model's business,
 * not a convention to assume: g-man is +Y up facing +Z, so his right is -X.
 * Read from the pelvis, the neck (or the top of the spine) and the two thighs,
 * exactly as `rig_axes` in the exporter and `readAxes` in its preview do.
 * World space, so they carry the placement's rotation — which is right, since
 * they are turned back through the pelvis's parent's world rotation on use.
 */
function readAxes(root, rootBone, rig) {
  const find = (pattern) => (pattern
    ? matchNodes(root, pattern).filter((n) => isUnder(n, rootBone))[0] ?? null
    : null);
  const top = find(rig?.neck) || find(rig?.spine);
  const left = find(rig?.left_thigh);
  const right = find(rig?.right_thigh);
  if (!top || !left || !right) return null;
  const hips = rootBone.getPosition().clone();
  const axisRight = new Vec3().sub2(right.getPosition(), left.getPosition()).normalize();
  const up = new Vec3().sub2(top.getPosition(), hips);
  up.sub(new Vec3().copy(axisRight).mulScalar(up.dot(axisRight))).normalize();  // the hip line is the reliable one
  const back = new Vec3().cross(axisRight, up).normalize();
  return { right: axisRight, up, back };
}

const _qa = new Quat();
const _qb = new Quat();
const _delta = new Quat();
const _posed = new Quat();
const _inv = new Quat();
const _v = new Vec3();
const _tmp = new Vec3();

/**
 * ClipPlayer — one clip ticking on one placed prop.
 *
 * Every pattern in the clip poses EVERY node it hits, and the exporter counts
 * on that: `Spine*` is four bones on g-man, `Neck1*` three, and the delta it
 * writes for a chain has already been divided by the chain's length. Keys are
 * slerped between the two neighbouring times on one shared `times` array, and
 * each result is composed onto the node's captured bind rotation.
 */
export class ClipPlayer {
  /**
   * `play` is how the script asked for it — `{ loop, speed, from }`, from
   * object.play at rest or from a run's play: `from` is how many seconds into
   * the clip it starts, for a run joined late. The rig and the bind pose are
   * the manifest's either way.
   */
  constructor(root, clip, manifest, bind, label = '', play = {}) {
    this.label = label;
    this.name = clip.name;
    this.times = Float32Array.from(clip.times ?? []);
    this.duration = clip.duration ?? (this.times.length ? this.times[this.times.length - 1] : 0);
    this.loop = play.loop ?? clip.loop ?? true;
    this.speed = play.speed ?? 1;
    this.time = Math.max(0, Number(play.from) || 0);
    this.tracks = [];     // [{ pattern, nodes, rest: Quat[], q: Float32Array }]
    this.missing = [];    // patterns that matched nothing: a re-export renamed a joint

    for (const [pattern, track] of Object.entries(clip.bones ?? {})) {
      const nodes = matchNodes(root, pattern);
      if (!nodes.length) { this.missing.push(pattern); continue; }
      this.tracks.push({ pattern, nodes, rest: nodes.map((n) => bind.get(n).q), q: Float32Array.from(track.q) });
    }

    // Root motion: where the feet put the pelvis. The pelvis is the shallowest
    // match of the rig's root pattern — a second skeleton may echo the name —
    // and the track is turned through the character's axes on every seek.
    this.root = null;
    if (clip.root?.t) {
      const rootBone = shallowest(matchNodes(root, manifest.rig?.root ?? clip.root.bone));
      const pelvis = rootBone && shallowest(matchNodes(root, clip.root.bone).filter((n) => isUnder(n, rootBone)));
      const axes = rootBone && readAxes(root, rootBone, manifest.rig);
      if (pelvis && axes) {
        this.root = { node: pelvis, rest: bind.get(pelvis).p, t: Float32Array.from(clip.root.t), axes };
        // A walk turns the pelvis too: its delta composes onto the bind rotation like any bone's.
        if (clip.root.q) {
          this.tracks.push({ pattern: clip.root.bone, nodes: [pelvis], rest: [bind.get(pelvis).q], q: Float32Array.from(clip.root.q) });
        }
      } else {
        this.missing.push(`${clip.root.bone} (root motion: ${!rootBone ? 'no pelvis' : !pelvis ? 'no pelvis under the root' : 'no axes — rig.neck/spine and the thighs'})`);
      }
    }
    // Every node this clip writes to, the pelvis it walks included. Nothing is
    // posed here: binding a clip and playing it are separate — the ease into
    // it is PropScript's, and it poses from the clip's first update().
    this.nodes = new Set(this.root ? [this.root.node] : []);
    for (const track of this.tracks) for (const node of track.nodes) this.nodes.add(node);
  }

  /** Nodes actually driven — what the placement log reports. */
  get count() { return this.tracks.reduce((n, t) => n + t.nodes.length, 0); }

  /** A one-off that has played through. A looped clip never has. */
  get ended() { return !this.loop && this.time >= this.duration; }

  /** Back to the first key, for the next time somebody sets it off. */
  rewind() { this.time = 0; }

  update(dt) {
    if (!this.times.length) return;
    let t = this.time + dt * this.speed;
    if (this.loop && this.duration > 0) t = ((t % this.duration) + this.duration) % this.duration;
    else t = Math.min(Math.max(t, 0), this.duration);
    this.time = t;
    this.seek(t);
  }

  /** Pose the prop at `t` seconds into the clip. Outside it, the nearest key holds. */
  seek(t) {
    const times = this.times;
    if (!times.length) return;
    let hi = 0;
    let lo = 0;
    if (times.length > 1) {
      hi = Math.min(Math.max(upperBound(times, t), 1), times.length - 1);
      lo = hi - 1;
    }
    const span = times[hi] - times[lo];
    const f = span > 0 ? Math.min(Math.max((t - times[lo]) / span, 0), 1) : 0;

    for (const track of this.tracks) {
      const q = track.q;
      _qa.set(q[lo * 4], q[lo * 4 + 1], q[lo * 4 + 2], q[lo * 4 + 3]);
      _qb.set(q[hi * 4], q[hi * 4 + 1], q[hi * 4 + 2], q[hi * 4 + 3]);
      _delta.slerp(_qa, _qb, f);
      track.nodes.forEach((node, i) => {
        _posed.mul2(_delta, track.rest[i]);        // delta * rest: the parent's frame
        node.setLocalRotation(_posed);
      });
    }

    if (this.root) {
      const { node, rest, t: tt, axes } = this.root;
      const x = tt[lo * 3] + (tt[hi * 3] - tt[lo * 3]) * f;
      const y = tt[lo * 3 + 1] + (tt[hi * 3 + 1] - tt[lo * 3 + 1]) * f;
      const z = tt[lo * 3 + 2] + (tt[hi * 3 + 2] - tt[lo * 3 + 2]) * f;
      _v.set(0, 0, 0)
        .add(_tmp.copy(axes.right).mulScalar(x))
        .add(_tmp.copy(axes.up).mulScalar(y))
        .add(_tmp.copy(axes.back).mulScalar(z));
      // The model decides where those point; the parent's frame is where the
      // pelvis's translation lives. Model units, so scale never enters.
      const parent = node.parent;
      if (parent) {
        _inv.copy(parent.getRotation()).invert();
        _inv.transformVector(_v, _v);
      }
      node.setLocalPosition(rest.x + _v.x, rest.y + _v.y, rest.z + _v.z);
    }
  }
}

// How long a prop takes to ease out of what it was doing and into what it does
// next. The contract leaves this to the consumer: long enough that the last key
// of a dance does not snap into the pose the dancer stands in, short enough
// that pressing the key still feels like it did something.
export const EASE_SECONDS = 0.35;

// Metres from the object within which an action is offered when neither the
// action nor the scene says otherwise — the contract's default.
export const DEFAULT_ACTION_RADIUS = 2;

// How far a script's sound carries, in metres: full volume within REF, fading
// with distance, silent past MAX. The consumer's call, not the asset's — an
// asset cannot know how big the room it stands in is.
const SOUND_REF = 2;
const SOUND_MAX = 40;

// A played video is kept on its game time by its rate, up to this much faster
// or slower; further off than VIDEO_SEEK seconds it is seeked (a seek stalls).
const VIDEO_NUDGE = 0.1;
const VIDEO_SEEK = 0.3;
// How far past its time a held video of unknown fps is seeked, and how near
// its end at most — see showFrame().
const FRAME_EPSILON = 0.002;
// What each video file a package may carry is, for canPlayType.
const VIDEO_TYPES = { webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4', ogv: 'video/ogg', mov: 'video/quicktime' };

const NO_NODES = new Set();

/**
 * What a pending playback rejects with when the run that started it is
 * stopped. A consumer swallows it (the contract, rule 2), so a script that
 * awaits a clip needs no try/catch to be cut short.
 */
export class Stopped extends Error {
  constructor(what = 'stopped') { super(what); this.name = 'AbortError'; }
}

/**
 * Where the browser goes when a script opens a link — one place, so a test
 * can see what a script asked for without leaving the page.
 *
 * And what a script's menu looks like, which is the consumer's: it puts its
 * own in here (`page.menu = …`, as the pavilion does with its pause screen).
 * The one below is the plain one, for a consumer that has no menus of its own
 * — the kit's viewer. Either way: show `text` and a button per word, call
 * `answer(word)` once with the one pressed or `answer(null)` if the player
 * left without pressing any, and return a function that takes the menu down.
 */
export const page = {
  open(url, newTab) {
    document.exitPointerLock?.();
    if (newTab) window.open(url, '_blank', 'noopener');
    else location.assign(url);
  },
  menu({ text, buttons }, answer) {
    document.exitPointerLock?.();
    const box = document.createElement('dialog');
    box.style.cssText = 'max-width: 420px; padding: 24px; border: 1px solid #555; border-radius: 8px; '
      + 'background: #15171c; color: #eee; font: 15px/1.5 system-ui, sans-serif; text-align: center;';
    const line = document.createElement('p');
    line.textContent = text;
    line.style.margin = '0 0 18px';
    box.append(line);
    const close = () => box.remove();
    for (const word of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = word;
      b.style.cssText = 'margin: 0 6px; padding: 8px 20px; font: inherit; cursor: pointer;';
      b.addEventListener('click', () => { close(); answer(word); });
      box.append(b);
    }
    box.addEventListener('cancel', () => { close(); answer(null); });   // Esc
    document.body.append(box);
    box.showModal();
    return close;
  },
};

// The menu on screen, of every object's: there is one player to ask.
let asked = null;

/**
 * A playback: a promise with a stop(). `halt` is what stopping means for the
 * thing it plays — a clip eases out, a sound falls silent, a timer is dropped —
 * and it runs at most once, however the playback ends.
 */
function makePlayback(halt = () => {}) {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Handled from birth: a looped sound nobody awaits must not surface as an
  // unhandled rejection when its run is stopped.
  promise.catch(() => {});
  let settled = false;
  const finish = (ok, value, halting = true) => {
    if (settled) return false;
    settled = true;
    if (halting) {
      try { halt(); } catch (err) { console.warn('[script] stopping a playback threw:', err); }
    }
    if (ok) resolve(value); else reject(value);
    return true;
  };
  return Object.assign(promise, {
    stop() { finish(true); },
    // For the runtime, never the script: ended by itself — `halting` false
    // when what it played should stay as it ended, a one-off holding its last
    // key — or cut short by the run that started it. `value` is what the
    // script's await gets: a menu's answer.
    end(halting = true, value = undefined) { return finish(true, value, halting); },
    cancel(reason = new Stopped()) { return finish(false, reason); },
    get settled() { return settled; },
  });
}

/**
 * PropScript — one placed object: its manifest applied, its script running.
 *
 * Order matters and is fixed here: capture every node's bind transform first,
 * then hang what the manifest says where (measured against that bind), then
 * the manifest's pose. The script runs later, in start(), once the placement
 * has put its own pose on top and collision has been baked — so nothing a
 * script plays can end up frozen into the collider.
 */
export class PropScript {
  constructor(root, { url, manifest, clips, setup }, label = '', { app = null, held = null, report = null } = {}) {
    this.root = root;
    this.url = url;
    this.label = label;
    this.manifest = manifest;
    this.clips = clips ?? new Map();
    this.setup = setup ?? null;
    this.app = app;
    // Is the consumer's clock held — the world moved only by steps, each
    // awaiting ready() before it is drawn? Then a video stands paused and is
    // seeked to its game time, instead of playing on the browser's clock.
    this.held = typeof held === 'function' ? held : () => false;
    // Told of every sound this object starts, and of any cut short — see voice().
    this.report = typeof report === 'function' ? report : null;
    this.warnings = [];
    this.attached = [];   // [{ node, to }] as actually done

    // Bind pose, before anything moves: what every delta is a delta on.
    this.bind = new Map();
    const walk = (e) => {
      this.bind.set(e, { q: e.getLocalRotation().clone(), p: e.getLocalPosition().clone() });
      for (const c of e.children) walk(c);
    };
    walk(root);

    for (const entry of manifest.rig?.attach ?? []) this.attach(entry?.node, entry?.to);

    const posed = ['pose', 'hide', 'offset', 'move'].some((k) => manifest[k] !== undefined);
    this.rig = posed ? new PropRig(root, manifest, label) : null;
    if (this.rig?.missing.length) this.warnings.push(`no node matched: ${this.rig.missing.join(', ')}`);

    this.time = 0;          // game seconds since the script started
    this.player = null;     // the clip it plays at rest — object.play
    this.resting = null;    // ...and that clip's playback
    this.clip = null;       // the clip a run plays instead — run.play
    this.clipping = null;   // ...and its playback
    this.rest = null;       // Map(node -> { q, p }): where a run's bones go back to
    this.fade = null;       // { from: Map(node -> { q, p }), t } while easing between the two
    this.actions = [];      // [{ name, label, stop, radius, shared, onStart, onStop, run }]
    this.running = [];      // the actions with a run going, oldest first — action.run is the run
    this.ticks = [];        // object.on('tick') handlers
    this.timers = [];       // [{ at, playback }] for wait()
    this.videos = new Set();  // { element, texture, t, … } — each playing video, in game time
    this.voices = new Set();  // { start, duration, loop, … } — each sound playing, in game time
    this.pending = new Set(); // sound loads a stepped frame waits for
    this.voiceCount = 0;    // ids for report()
    this.sounds = [];       // how many a script started — for the placement log
    this.surfaces = new Map();  // material name -> [{ mi, material }] this copy owns
    this.started = false;
    this.object = this.makeObject();
  }

  /**
   * Hang `nodeName` off `hostName`, keeping its bind world transform.
   *
   * g-man's head is a second skeleton whose armature is a SIBLING of the
   * body's, not a child of its spine — bend the body and the head stays where
   * it was. The producer measured that and wrote it down; this does what it
   * says, by exact name, and nothing more. The new local transform is read
   * against the host's BIND world transform, never a pose it may be in.
   */
  attach(nodeName, hostName) {
    const node = matchNodes(this.root, nodeName ?? '')[0];
    const host = matchNodes(this.root, hostName ?? '')[0];
    if (!node || !host) {
      this.warnings.push(`attach: no node matched ${!node ? nodeName : hostName}`);
      return;
    }
    if (node === host || isUnder(host, node)) {
      this.warnings.push(`attach: ${hostName} is inside ${nodeName} — refusing the loop`);
      return;
    }
    const local = new Mat4().copy(host.getWorldTransform()).invert();
    local.mul(node.getWorldTransform());
    const pos = local.getTranslation(new Vec3());
    const scale = local.getScale(new Vec3());
    const rot = new Quat().setFromMat4(local);
    node.reparent(host);
    node.setLocalPosition(pos);
    node.setLocalRotation(rot);
    node.setLocalScale(scale);
    // Its bind is now the one it has under the host, so a clip that ever
    // touched it (none does today) would compose onto the right thing.
    this.bind.set(node, { q: rot.clone(), p: pos.clone() });
    this.attached.push({ node: node.name, to: host.name });
  }

  /** The asset's own answer, or undefined when it does not say. */
  get solid() { return this.manifest.solid; }

  /** A mesh the manifest's pose hid is gone from collision too. */
  collides(name) { return this.rig ? this.rig.collides(name) : true; }

  /** Run the script: call its default export with the object. Once. */
  start() {
    if (this.started) return;
    this.started = true;
    if (!this.setup) return;
    try {
      const out = this.setup(this.object);
      if (out && typeof out.then === 'function') out.then(null, (err) => this.fail('setup', err));
    } catch (err) {
      this.fail('setup', err);
    }
    // What is on offer is read once, as the object is placed.
    this.offered = true;
  }

  fail(where, err) {
    if (err instanceof Stopped) return;
    const line = `${where} threw: ${err?.message ?? err}`;
    this.warnings.push(line);
    console.error(`[script ${this.label}] ${line}`, err);
  }

  warn(line) {
    this.warnings.push(line);
    console.warn(`[script ${this.label}] ${line}`);
  }

  // ---- The object, as the script sees it --------------------------------------

  makeObject() {
    const self = this;
    return Object.freeze({
      api: SCRIPT_API,
      name: this.label,
      play: (clip, opts) => self.playClip(clip, opts, null),
      sound: (file, opts) => self.playSound(file, opts, null),
      video: (file, opts) => self.playVideo(file, opts, null),
      canvas: (material, opts) => self.canvas(material, opts),
      wait: (seconds) => self.wait(seconds, null),
      on(event, fn) {
        if (event !== 'tick') { self.warn(`on("${event}"): script API ${SCRIPT_API} has only "tick"`); return; }
        if (typeof fn === 'function') self.ticks.push(fn);
      },
      action: (options, handlers) => self.offer(options, handlers),
      open(url, { newTab = false } = {}) {
        if (!/^https?:\/\//i.test(String(url))) { self.warn(`open: ${url} is not an http(s) address`); return; }
        console.log(`[script ${self.label}] opening ${url}${newTab ? ' in a new tab' : ''}`);
        page.open(String(url), !!newTab);
      },
      menu: (spec) => self.menu(spec, null),
      log: (...args) => console.log(`[script ${self.label}]`, ...args),
    });
  }

  // What a run hands its action: the same members, each playback tied to it.
  makeRun(action, aim = null, age = 0) {
    const self = this;
    const live = new Set();
    const tie = (playback) => {
      if (run.over) playback.cancel();
      else { live.add(playback); playback.then(() => live.delete(playback), () => live.delete(playback)); }
      return playback;
    };
    const run = {
      action,
      over: false,
      label: action.stop,
      aim,
      // When it started, on this object's clock: before now, for a run that
      // somebody else started and this copy heard of late.
      began: this.time - Math.max(0, Number(age) || 0),
      api: Object.freeze({
        action: action.name,
        get age() { return self.time - run.began; },
        get aim() { return run.aim; },
        get ended() { return run.over; },
        get label() { return run.label; },
        set label(word) { run.label = word == null ? null : String(word); },
        end: () => self.finish(run),
        play: (clip, opts) => tie(self.playClip(clip, opts, run)),
        sound: (file, opts) => tie(self.playSound(file, opts, run)),
        video: (file, opts) => tie(self.playVideo(file, opts, run)),
        wait: (seconds) => tie(self.wait(seconds, run)),
        menu: (spec) => tie(self.menu(spec, run)),
      }),
      // Rule 3: what a run started stops with it, however it ends.
      end() {
        run.over = true;
        for (const playback of [...live]) playback.cancel();
        live.clear();
      },
    };
    return run;
  }

  // ---- Actions ----------------------------------------------------------------

  offer(options, handlers) {
    const name = options?.name;
    if (typeof name !== 'string' || !name) { this.warn('action: no name — dropped'); return; }
    if (this.actions.some((a) => a.name === name)) { this.warn(`action ${name}: offered twice — the second dropped`); return; }
    if (typeof handlers?.start !== 'function') { this.warn(`action ${name}: no \`{ start }\` for the key to call — dropped`); return; }
    if (handlers.stop !== undefined && typeof handlers.stop !== 'function') {
      this.warn(`action ${name}: \`stop\` is not a function — the key is not offered while it runs`);
    }
    if (this.offered) this.warn(`action ${name}: offered after the object was placed — nothing offers it`);
    this.actions.push({
      name,
      label: options.label ?? name,
      stop: options.stop ?? null,         // the word while it runs, not the handler
      radius: options.radius > 0 ? options.radius : DEFAULT_ACTION_RADIUS,
      shared: options.shared === true,    // the room's: a press anywhere is a press everywhere
      onStart: handlers.start,
      onStop: typeof handlers.stop === 'function' ? handlers.stop : null,
      run: null,
    });
  }

  /** The action started most recently and still running, or null. */
  get acting() { return this.running[this.running.length - 1] ?? null; }

  /** Is a shared action running — is this object, for now, on the room's time rather than its own? */
  get sharing() { return this.running.some((a) => a.shared); }

  /** Is the key on offer for this action right now? Not while it runs with no `stop` to call. */
  offers(action) { return !action.run || !!action.onStop; }

  /**
   * The key, on an action — the first one the script offers, unless named.
   *
   * The contract's rules, and the only place they live: not running, the key
   * calls the script's start(run); running, its stop(run), and whatever that
   * does is the script's decision. A run ends when what start returned
   * settles or the script ends it — never because of the key alone. Returns
   * the action, or null if the script offers none by that name.
   *
   * `ray` is the player's view at the press, `{ origin, direction }` in world
   * space (Vec3s or [x, y, z]): what it hits becomes `run.aim`, on the press
   * that starts a run and on every press that asks it to stop. Without one,
   * `run.aim` is null — a consumer that has no view to give says so.
   *
   * `age` is how many seconds ago the press that starts the run was made, when
   * it was made somewhere else: someone in the room set off a shared action,
   * and this copy is told of it now. The run starts that old — `run.age` — so
   * the script can pick up where everybody else already is. It means nothing
   * on a press that asks a running action to stop.
   */
  trigger(name, { ray = null, age = 0 } = {}) {
    const action = name ? this.actions.find((a) => a.name === name) : this.actions[0];
    if (!action) return null;
    const aim = this.aimAt(ray);
    if (action.run) {
      action.run.aim = aim;
      if (action.onStop) {
        try { action.onStop(action.run.api); } catch (err) { this.fail(`action ${action.name}: stop`, err); }
      }
      return action;
    }
    const run = this.makeRun(action, aim, age);
    action.run = run;
    this.running.push(action);
    let out;
    try {
      out = action.onStart(run.api);
    } catch (err) {
      this.fail(`action ${action.name}: start`, err);
      this.finish(run);
      return action;
    }
    if (out && typeof out.then === 'function') {
      out.then(() => this.finish(run), (err) => { this.fail(`action ${action.name}: start`, err); this.finish(run); });
    } else {
      this.finish(run);
    }
    return action;
  }

  /**
   * Where a world-space ray first meets what this object draws, in the
   * object's own space: `{ material, uv, point, normal }`, or null on a miss.
   *
   * On the CPU, against each mesh's own vertices, and only on a key press —
   * the engine's picking works in screen space and gives no uv. What is not
   * drawn is not aimed at: a hidden `_col` stand-in never catches the ray in
   * front of the surface it stands in for. A skinned mesh is tested in its
   * bind pose. `uv` is the file's, glTF's (0, 0) the top-left of an image on
   * that material, so on a canvas it is x = u * width, y = v * height. The
   * normal is the face's, turned to face the viewer.
   */
  aimAt(ray) {
    if (!ray?.origin || !ray?.direction) return null;
    const origin = toVec3(ray.origin);
    const direction = toVec3(ray.direction);
    if (!direction.lengthSq()) return null;
    const toLocal = new Mat4();
    const o = new Vec3();
    const d = new Vec3();
    let best = null;
    for (const rc of this.root.findComponents('render')) {
      if (!rc.enabled || !rc.entity.enabled) continue;
      for (const mi of rc.meshInstances) {
        if (!mi.visible) continue;
        const geometry = geometryOf(mi.mesh);
        if (!geometry) continue;
        toLocal.copy(mi.node.getWorldTransform()).invert();
        toLocal.transformPoint(origin, o);
        // Not normalised, so t along it is t along the world ray: one scale for every mesh.
        toLocal.transformVector(direction, d);
        const hit = intersect(geometry, o, d, best ? best.t : Infinity);
        if (hit) best = { ...hit, mi, geometry };
      }
    }
    if (!best) return null;

    const { mi, geometry: { pos, uv }, t, a, b, c, u, v } = best;
    // The world hit, then into the object's space: the root's inverse.
    const toObject = new Mat4().copy(this.root.getWorldTransform()).invert();
    const point = toObject.transformPoint(new Vec3().copy(direction).mulScalar(t).add(origin));
    const view = toObject.transformVector(direction);
    // Mesh space to the object's. An affine map carries edges to edges, so
    // their cross is the face's normal there.
    const meshToObject = new Mat4().mul2(toObject, mi.node.getWorldTransform());
    const corner = (i) => new Vec3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const pa = corner(a);
    const e1 = meshToObject.transformVector(corner(b).sub(pa));
    const e2 = meshToObject.transformVector(corner(c).sub(pa));
    const normal = new Vec3().cross(e1, e2).normalize();
    if (normal.dot(view) > 0) normal.mulScalar(-1);
    const w = 1 - u - v;
    const at = (i, k) => uv[i * 2 + k];
    return {
      material: mi.material?.name ?? null,
      uv: uv ? [w * at(a, 0) + u * at(b, 0) + v * at(c, 0), w * at(a, 1) + u * at(b, 1) + v * at(c, 1)] : null,
      point: [point.x, point.y, point.z],
      normal: [normal.x, normal.y, normal.z],
    };
  }

  /** Label for the key while an action runs: the script's word, if it has one. */
  runLabel(action) { return action.run?.label ?? null; }

  finish(run) {
    if (run.over) return;
    const { action } = run;
    if (action.run === run) action.run = null;
    this.running = this.running.filter((a) => a !== action);
    run.end();
  }

  // ---- Clips on the rig -------------------------------------------------------

  /**
   * Play a manifest clip. Without a run it is what the object does at rest,
   * replacing whatever it did before; with one it takes the rig over from
   * that until the run lets go. Either way the bones ease from wherever they
   * are into it.
   */
  playClip(name, opts = {}, run) {
    const clip = this.clips.get(name);
    if (!clip) {
      this.warn(`play: ${name} is not one of the manifest's clips`);
      const nothing = makePlayback();
      nothing.end();
      return nothing;
    }
    const player = new ClipPlayer(this.root, clip, this.manifest, this.bind, this.label, opts ?? {});
    if (player.missing.length) this.warn(`clip ${clip.name}: no node matched ${player.missing.join(', ')}`);

    if (!run) {
      const before = this.player;
      const playback = makePlayback(() => {
        if (this.player !== player) return;
        if (!this.clip) this.ease(player.nodes, NO_NODES);
        this.player = null;
        this.resting = null;
      });
      this.resting?.end();
      if (!this.clip) this.ease(before?.nodes ?? NO_NODES, player.nodes);
      this.player = player;
      this.resting = playback;
      return playback;
    }

    // Where the run's bones go back to is wherever they are now — bind, the
    // manifest's pose, a `rigs` entry on top, a slider dragged since —
    // provided now is rest, and not the tail of an earlier run easing out.
    if (!this.rest || (!this.clip && !this.fade)) this.rest = new Map();
    for (const node of player.nodes) {
      if (!this.rest.has(node)) this.rest.set(node, { q: node.getLocalRotation().clone(), p: node.getLocalPosition().clone() });
    }
    this.ease((this.clip ?? this.player)?.nodes ?? NO_NODES, player.nodes);
    const playback = makePlayback(() => {
      if (this.clip !== player) return;
      this.ease(player.nodes, this.player?.nodes ?? NO_NODES);
      this.clip = null;
      this.clipping = null;
    });
    // A second clip in the same run replaces the first, which has not ended —
    // it was handed over, so it resolves rather than rejecting.
    if (this.clipping) { const was = this.clipping; this.clipping = null; this.clip = null; was.end(); }
    this.clip = player;
    this.clipping = playback;
    return playback;
  }

  // Start easing every node either side drives, from wherever it is this
  // instant — which, part-way through an earlier ease, is already a blend, so
  // pressing the key twice in a hurry never snaps.
  ease(leaving, arriving) {
    const from = new Map(this.fade?.from ?? []);
    for (const nodes of [leaving, arriving]) {
      for (const node of nodes) from.set(node, { q: node.getLocalRotation().clone(), p: node.getLocalPosition().clone() });
    }
    this.fade = from.size ? { from, t: 0 } : null;
  }

  // ---- Sound, video, canvas ---------------------------------------------------

  /** A file of the asset's folder, as a URL. */
  fileUrl(file) { return new URL(file, this.url).href; }

  playSound(file, { loop = false, volume = 1 } = {}, run) {
    if (!this.app) { this.warn(`sound ${file}: no app to play it through`); return makePlayback(); }
    this.sounds.push(file);
    return this.voice(file, { loop, volume });
  }

  /**
   * A file of the folder, sounding from where the object stands.
   *
   * It ends in GAME time — its length after it was started — whatever the
   * audio clock does, like a clip and a wait: a script that awaits a sound
   * and then dances dances at the same moment played or stepped. What is
   * heard is the engine's; when it ends is this. A sound whose length is
   * never learned ends when the engine says.
   *
   * `report`, when the consumer gave one, is told `{ kind: 'sound', id,
   * object, file, url, loop, volume, pos }` as it starts, and `{ kind:
   * 'stop', id }` if it is cut short: what a recorder needs to mix the
   * sound track afterwards. The consumer stamps its own time on each.
   */
  voice(file, { loop = false, volume = 1 } = {}) {
    const url = this.fileUrl(file);
    let known = soundAssets.get(url);
    if (!known) {
      const asset = new Asset(`script-sound:${url}`, 'audio', { url });
      known = {
        asset,
        landed: new Promise((res) => {
          asset.ready(() => res(true));
          asset.on('error', (err) => { this.warn(`sound ${file} failed to load: ${err}`); res(false); });
        }),
      };
      this.app.assets.add(asset);
      this.app.assets.load(asset);
      soundAssets.set(url, known);
    }
    const { asset, landed } = known;
    // One positional sound component per object, a slot per file. The listener
    // is the consumer's, on its camera; the entity's position is where it plays from.
    const sound = this.root.sound ?? this.root.addComponent('sound', {
      positional: true, refDistance: SOUND_REF, maxDistance: SOUND_MAX, rollOffFactor: 1, distanceModel: 'inverse',
    });
    if (!sound.slot(url)) sound.addSlot(url, { asset, overlap: true, autoPlay: false, loop: false });
    volume = Math.max(0, Math.min(1, volume));
    const id = ++this.voiceCount;
    const voice = { start: this.time, duration: null, loop: !!loop, done: false, playback: null };
    let instance = null;
    const playback = makePlayback(() => {
      this.voices.delete(voice);
      // Run out in game time: the tail the audio clock still owes is let play.
      if (voice.done) return;
      instance?.stop();
      this.report?.({ kind: 'stop', id });
    });
    voice.playback = playback;
    const p = this.root.getPosition();
    this.report?.({ kind: 'sound', id, object: this.label, file, url, loop: !!loop, volume, pos: [p.x, p.y, p.z] });
    this.voices.add(voice);
    const loading = landed.then((ok) => {
      if (playback.settled) return;
      if (!ok) { voice.done = true; playback.end(); return; }
      voice.duration = asset.resource?.duration > 0 ? asset.resource.duration : null;
      instance = sound.slot(url).play();
      if (!instance) { voice.done = true; playback.end(); return; }
      instance.loop = !!loop;
      instance.volume = volume;
      if (voice.duration === null) instance.on('end', () => { voice.done = true; playback.end(); });
    });
    this.pending.add(loading);
    loading.then(() => this.pending.delete(loading));
    return playback;
  }

  /**
   * The mesh instances drawing a material of this object, with a copy of the
   * material this placement owns: a second copy of the asset shows its own
   * picture, not this one's.
   */
  surface(name) {
    let owned = this.surfaces.get(name);
    if (owned) return owned;
    const instances = this.root.findComponents('render').flatMap((rc) => rc.meshInstances)
      .filter((mi) => mi.material?.name === name);
    if (!instances.length) return null;
    const copies = new Map();
    owned = instances.map((mi) => {
      let material = copies.get(mi.material);
      if (!material) { material = mi.material.clone(); material.name = name; copies.set(mi.material, material); }
      mi.material = material;
      return { mi, material };
    });
    this.surfaces.set(name, owned);
    return owned;
  }

  /** Has the object a material by this name? Says so when it has not. */
  paintable(name) {
    if (this.surface(name)) return true;
    const have = [...new Set(this.root.findComponents('render').flatMap((rc) => rc.meshInstances).map((mi) => mi.material?.name))];
    this.warn(`no material named ${JSON.stringify(name)} to paint (the object has ${have.map((n) => JSON.stringify(n)).join(', ')})`);
    return false;
  }

  // Put a texture on a material: emitted like a screen (`glow`), or lit like paint.
  paint(name, texture, glow) {
    if (!this.paintable(name)) return false;
    const owned = this.surface(name);
    for (const material of new Set(owned.map((o) => o.material))) {
      if (glow) {
        material.emissiveMap = texture;
        material.emissive = new Color(1, 1, 1);
        material.diffuseMap = null;
        material.diffuse = new Color(0, 0, 0);
      } else {
        material.diffuseMap = texture;
        material.diffuse = new Color(1, 1, 1);
      }
      material.update();
    }
    return true;
  }

  makeTexture(name, { width = 4, height = 4, smooth = true } = {}) {
    const filter = smooth ? pc.FILTER_LINEAR : pc.FILTER_NEAREST;
    return new Texture(this.app.graphicsDevice, {
      name, width, height, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
      minFilter: filter, magFilter: filter, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
  }

  /**
   * A video of the folder on one of the object's materials, in GAME time.
   *
   * Each video keeps its own time, advanced by update() like a clip's; the
   * element is how its pictures are decoded, not what decides which one is
   * shown. Played, the element plays and is kept on that time — nudged by its
   * rate, seeked only when far off — and its picture uploaded when it has a
   * new one. Held (see `held`), it stands paused and ready() seeks it to the
   * frame of that time before the step is drawn: frame-exact, however slowly.
   *
   * Nothing of it is fetched before it is played, and until it has a picture
   * the material shows what it showed before — the object's own surface, or
   * whatever the script painted there to say it is loading. The video takes
   * the material with its first frame, and its time and its sound start
   * then. The playback says how far along it is: `shown`, a promise of true
   * once the first frame is up (false if it ended first), and `progress`,
   * how much of the file is in, 0 to 1.
   *
   * The manifest's `videos` index says what the kit prepared for the file:
   * `alt` files for browsers that cannot play it, its `duration`, and its
   * sound as a file of its own, `audio`. Unmuted, that sound is a voice() —
   * from where the object stands, in game time, reported — rather than the
   * element's flat track. A video the index does not list plays as it is,
   * its own track and all.
   */
  playVideo(file, { material, loop = false, muted = true, glow = true, smooth = true } = {}, run) {
    if (!this.app) { this.warn(`video ${file}: no app to play it through`); return makePlayback(); }
    const listed = (Array.isArray(this.manifest.videos) ? this.manifest.videos : []).find((v) => v?.file === file) ?? null;
    const element = document.createElement('video');
    element.crossOrigin = 'anonymous';
    element.loop = !!loop;
    element.muted = !!listed || muted !== false;
    element.playsInline = true;
    element.preload = 'auto';
    const sources = [file, ...(Array.isArray(listed?.alt) ? listed.alt : [])];
    const playable = sources.find((f) => element.canPlayType(VIDEO_TYPES[f.split('.').pop().toLowerCase()] ?? '') !== '');
    if (!playable) this.warn(`video ${file}: this browser can play none of ${sources.join(', ')} — trying ${file}`);
    element.src = this.fileUrl(playable ?? file);
    const texture = this.makeTexture(`${this.label}/${file}`, { smooth });
    texture.setSource(element);
    let shownAs;
    const video = {
      file, element, texture, material, glow, t: 0, loop: !!loop,
      duration: listed?.duration > 0 ? listed.duration : null,
      fps: listed?.fps > 0 ? listed.fps : null,
      audio: listed?.audio && muted === false ? listed.audio : null,
      begun: false,         // has it a picture yet — see begin()
      shown: new Promise((res) => { shownAs = res; }),
      playing: false, fresh: true, watched: false, done: false, voice: null, playback: null,
      whole: null,          // the file fetched into memory, when it had to be — see seekable()
      wholeIn: false,
    };
    video.show = shownAs;
    const playback = makePlayback(() => {
      this.videos.delete(video);
      video.show(false);
      if (!video.done) video.voice?.stop();
      element.pause();
      element.removeAttribute('src');
      element.load();
      video.whole?.then((url) => url && URL.revokeObjectURL(url));
    });
    video.playback = playback;
    Object.defineProperty(playback, 'shown', { value: video.shown });
    Object.defineProperty(playback, 'progress', { get: () => this.videoProgress(video) });
    if (!this.paintable(material)) { playback.end(); return playback; }
    element.addEventListener('loadedmetadata', () => {
      if (video.duration === null && Number.isFinite(element.duration)) video.duration = element.duration;
    });
    // Ended by its game time; by the element only while its length is unknown.
    element.addEventListener('ended', () => { if (video.duration === null) playback.end(); });
    element.addEventListener('error', () => { if (!playback.settled) { this.warn(`video ${file} failed to play`); playback.end(); } });
    if (typeof element.requestVideoFrameCallback === 'function') {
      video.watched = true;
      const onFrame = () => { video.fresh = true; if (!playback.settled) element.requestVideoFrameCallback(onFrame); };
      element.requestVideoFrameCallback(onFrame);
    }
    this.videos.add(video);
    return playback;
  }

  /** Its first frame is in: it takes its material, and its time and its sound start. */
  begin(video) {
    video.begun = true;
    video.t = 0;
    video.texture.upload();
    video.fresh = false;
    this.paint(video.material, video.texture, video.glow);
    if (video.audio) video.voice = this.voice(video.audio, { loop: video.loop });
    video.show(true);
  }

  /** How much of a video's file is in, 0 to 1. */
  videoProgress(video) {
    const el = video.element;
    if (video.wholeIn) return 1;
    const d = el.duration;
    if (!(d > 0) || !el.buffered?.length) return 0;
    return Math.min(1, el.buffered.end(el.buffered.length - 1) / d);
  }

  playElement(video) {
    video.playing = true;
    video.element.play().catch((err) => {
      video.playing = false;
      if (!video.playback.settled && err?.name !== 'AbortError') this.warn(`video ${video.file}: ${err.message}`);
    });
  }

  /** Where a video is in its own file: its game time, wrapped when it loops. */
  videoTime(video) {
    const d = video.duration;
    if (!(d > 0)) return video.t;
    return video.loop ? video.t % d : Math.min(video.t, d);
  }

  /** Each video's game time: ended, kept to while played, left to ready() while held. */
  updateVideos(dt) {
    const held = this.held();
    for (const video of [...this.videos]) {
      const el = video.element;
      if (!video.begun) {
        // Held, ready() begins it at the frame it lands on. Played, the first
        // frame that is in does.
        if (held || el.readyState < 2) continue;
        this.begin(video);
        this.playElement(video);
        continue;
      }
      video.t += dt;
      const d = video.duration;
      // Run out: the texture keeps the last frame it was given, and its sound
      // runs out in its own time.
      if (d > 0 && !video.loop && video.t >= d) { video.done = true; video.playback.end(); continue; }
      if (held) {
        if (video.playing) { el.pause(); video.playing = false; }
        continue;
      }
      if (!video.playing) {
        if (el.readyState >= 1) el.currentTime = this.videoTime(video);
        this.playElement(video);
      }
      if (el.readyState >= 1 && d > 0) {
        let drift = this.videoTime(video) - el.currentTime;
        if (video.loop && Math.abs(drift) > d / 2) drift -= Math.sign(drift) * d;
        if (Math.abs(drift) > VIDEO_SEEK) el.currentTime = this.videoTime(video);
        else el.playbackRate = 1 + Math.max(-VIDEO_NUDGE, Math.min(VIDEO_NUDGE, drift));
      }
      if (el.readyState >= 2 && (video.fresh || !video.watched)) {
        video.texture.upload();
        video.fresh = false;
      }
    }
  }

  /** Held: the element seeked to the frame of its game time, and that frame uploaded. */
  async showFrame(video) {
    const el = video.element;
    const once = (...events) => new Promise((res) => {
      const done = () => { for (const e of events) el.removeEventListener(e, done); res(); };
      for (const e of events) el.addEventListener(e, done);
    });
    if (el.readyState < 1) await once('loadedmetadata', 'error');
    if (video.playback.settled || el.readyState < 1) return;
    await this.seekable(video, once);
    if (video.playback.settled || el.readyState < 1) return;
    // The middle of the frame its time falls in. Not the time itself: a file
    // keeps its timestamps rounded (WebM to the millisecond, so frame 2 of 30
    // starts at 0.067, not 0.0667), and a time on a frame's start would land
    // on the frame before. Without an fps, just past the time, past the rounding.
    const time = this.videoTime(video);
    const target = Math.min(video.fps > 0 ? (Math.floor(time * video.fps + 1e-6) + 0.5) / video.fps : time + FRAME_EPSILON,
      el.duration - FRAME_EPSILON);
    if (Math.abs(el.currentTime - target) > 1e-4 || el.readyState < 2) {
      const seeked = once('seeked', 'error');
      el.currentTime = target;
      await seeked;
      if (el.readyState < 2) await once('loadeddata', 'error');
    }
    if (video.playback.settled || el.readyState < 2) return;
    if (video.begun) video.texture.upload();
    else this.begin(video);
  }

  /**
   * Make sure a video can be seeked. A server that does not answer ranges —
   * python's http.server, which is how both repos are served in development —
   * leaves nothing seekable, and a seek then silently stays where it was. So
   * the file is fetched whole, once, and played from memory: always seekable.
   */
  async seekable(video, once) {
    const el = video.element;
    const s = el.seekable;
    if (s.length && s.end(s.length - 1) >= el.duration - 0.05) return;
    if (!video.whole) {
      video.whole = fetch(el.currentSrc || el.src)
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then(async (blob) => {
          const url = URL.createObjectURL(blob);
          if (video.playback.settled) { URL.revokeObjectURL(url); return null; }
          const loaded = once('loadedmetadata', 'error');
          el.src = url;
          await loaded;
          video.wholeIn = true;
          return url;
        })
        .catch((err) => { this.warn(`video ${video.file}: cannot be seeked (${err.message}) — it plays unstepped`); return null; });
    }
    await video.whole;
  }

  /**
   * What a held consumer awaits before it draws a step: every sound this
   * object asked for loaded (its length is when it ends), every video on the
   * frame of its game time. Resolves at once when there is nothing to wait for.
   */
  ready() {
    const waits = [...this.pending];
    if (this.held()) for (const video of this.videos) waits.push(this.showFrame(video));
    return waits.length ? Promise.all(waits) : Promise.resolve();
  }

  canvas(material, { width = 256, height = 256, smooth = true, glow = true } = {}) {
    const element = document.createElement('canvas');
    element.width = width;
    element.height = height;
    const context = element.getContext('2d');
    const texture = this.app ? this.makeTexture(`${this.label}/${material}`, { width, height, smooth }) : null;
    texture?.setSource(element);
    if (texture) this.paint(material, texture, glow);
    return { canvas: element, context, width, height, update() { texture?.upload(); } };
  }

  // ---- Menus ------------------------------------------------------------------

  /**
   * Put a question to the player. The words are the script's, the menu is the
   * consumer's (`page.menu`). The playback resolves with the word of the
   * button pressed, or null: left unanswered, taken down by the script, or
   * pushed out by the next one — there is one player and so one menu.
   */
  menu(spec, run) {
    const text = String(spec?.text ?? '');
    const buttons = (Array.isArray(spec?.buttons) ? spec.buttons : []).map(String).filter(Boolean);
    if (!buttons.length) buttons.push('OK');
    asked?.end(true, null);
    let close = null;
    const playback = makePlayback(() => { if (asked === playback) asked = null; close?.(); });
    playback.stop = () => { playback.end(true, null); };
    asked = playback;
    console.log(`[script ${this.label}] asks: ${text} [${buttons.join(' / ')}]`);
    try {
      // Answered, the consumer has already taken it down: nothing to halt.
      close = page.menu({ text, buttons }, (word) => {
        close = null;
        playback.end(true, buttons.includes(word) ? word : null);
      });
    } catch (err) {
      this.fail('menu', err);
      playback.end(true, null);
    }
    return playback;
  }

  // ---- Time -------------------------------------------------------------------

  wait(seconds, run) {
    const timer = { at: this.time + Math.max(0, Number(seconds) || 0), playback: null };
    timer.playback = makePlayback(() => { this.timers = this.timers.filter((t) => t !== timer); });
    this.timers.push(timer);
    return timer.playback;
  }

  update(dt) {
    this.time += dt;
    (this.clip ?? this.player)?.update(dt);
    // The last key has been posed this frame; ease away from it, not from the one before.
    if (this.clip?.ended) this.clipping?.end();
    if (this.player?.ended && this.resting) {
      // A one-off at rest holds its last key: it has ended, and stays posed.
      const done = this.resting;
      this.resting = null;
      done.end(false);
    }
    for (const timer of this.timers.filter((t) => t.at <= this.time)) timer.playback.end();
    for (const fn of this.ticks) {
      try { fn(dt); } catch (err) {
        this.fail('tick', err);
        this.ticks = this.ticks.filter((f) => f !== fn);   // once, not every frame from now on
      }
    }
    for (const voice of [...this.voices]) {
      if (!voice.loop && voice.duration !== null && this.time - voice.start >= voice.duration) {
        voice.done = true;
        voice.playback.end();
      }
    }
    this.updateVideos(dt);
    this.easeStep(dt);
  }

  easeStep(dt) {
    if (!this.fade) return;
    const fade = this.fade;
    fade.t += dt;
    const x = Math.min(fade.t / EASE_SECONDS, 1);
    const f = x * x * (3 - 2 * x);
    // What a node is easing TOWARDS: what the clip now playing just wrote to
    // it, or — for a bone nothing drives any more — where it rests.
    const driven = (this.clip ?? this.player)?.nodes ?? NO_NODES;
    for (const [node, was] of fade.from) {
      const to = driven.has(node)
        ? { q: node.getLocalRotation(), p: node.getLocalPosition() }
        : this.rest?.get(node) ?? this.bind.get(node);
      _posed.slerp(was.q, to.q, f);
      _v.lerp(was.p, to.p, f);
      node.setLocalRotation(_posed);
      node.setLocalPosition(_v);
    }
    if (x >= 1) this.fade = null;
  }

  /** One line for the placement log. */
  describe() {
    const parts = [];
    if (this.player) {
      const p = this.player;
      parts.push(`playing ${p.name} ${p.duration.toFixed(1)} s${p.loop ? ' looped' : ' once'}`
        + `${p.speed !== 1 ? ` at ${p.speed}x` : ''} on ${p.count} nodes${p.root ? ' + root motion' : ''}`);
    }
    if (this.rig) parts.push(`${this.rig.count} bones posed`);
    for (const a of this.actions) parts.push(`offers ${a.name} "${a.label}"${a.shared ? ' to the room' : ''}`);
    if (this.ticks.length) parts.push(`${this.ticks.length} tick handler${this.ticks.length > 1 ? 's' : ''}`);
    if (this.surfaces.size) parts.push(`paints ${[...this.surfaces.keys()].join(', ')}`);
    if (this.sounds.length) parts.push(`${this.sounds.length} sound${this.sounds.length > 1 ? 's' : ''}`);
    for (const a of this.attached) parts.push(`${a.node} hung off ${a.to}`);
    if (!this.setup && this.manifest.script) parts.push('script failed to load');
    return parts.join(', ') || 'nothing to do';
  }
}

// One audio asset per URL, however many objects play it: { asset, landed }.
const soundAssets = new Map();

const toVec3 = (v) => (Array.isArray(v) ? new Vec3(v[0], v[1], v[2]) : new Vec3(v.x, v.y, v.z));

// A mesh's positions, first uv set and triangle indices, read back once and
// kept: what aimAt() casts against. Null for anything that is not triangles.
const geometries = new WeakMap();
function geometryOf(mesh) {
  if (!mesh) return null;
  if (geometries.has(mesh)) return geometries.get(mesh);
  let geometry = null;
  const primitive = mesh.primitive?.[0];
  if (primitive?.type === pc.PRIMITIVE_TRIANGLES) {
    const pos = [];
    if (mesh.getPositions(pos)) {
      const uv = [];
      const all = [];
      const indexed = mesh.getIndices(all) > 0;
      const idx = indexed ? all.slice(primitive.base, primitive.base + primitive.count)
        : Array.from({ length: primitive.count }, (_, i) => primitive.base + i);
      geometry = { pos, uv: mesh.getUvs(0, uv) ? uv : null, idx };
    }
  }
  geometries.set(mesh, geometry);
  return geometry;
}

// Möller–Trumbore over every triangle, both faces: the nearest hit closer than
// `far`, as { t, a, b, c, u, v } — its corners' indices and barycentrics.
function intersect({ pos, idx }, o, d, far) {
  let best = null;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = o.x - pos[a], sy = o.y - pos[a + 1], sz = o.z - pos[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t <= 0 || t >= far) continue;
    far = t;
    best = { t, a: idx[i], b: idx[i + 1], c: idx[i + 2], u, v };
  }
  return best;
}
