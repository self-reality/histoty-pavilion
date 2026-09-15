// An asset's script — what a placed object does, read from the file beside its GLB.
//
// A prop is two things: an OBJECT, the .glb, and its SCRIPT, a .script.json that
// says what the object does. Static props have no script and nothing here runs
// for them. An animated one ships as a folder — `assets/<name>/<name>.glb` and
// `assets/<name>/<name>.script.json`, plus the clips the script lists — built by
// a producer that knows the rig (today the motion-capture tool; see
// ANIMATED_PROPS.md), and the scene exporter writes the script's path into the
// placement beside the GLB's, so this side never guesses at a file.
//
// The script is DATA, never code, and its vocabulary is the whole contract:
//
//   pose / hide / offset / move    what a `rigs` entry in scene.manifest.mjs
//                                  says, applied once — see PropRig in rig.mjs
//   rig.attach                     what to hang where before a clip can play
//   clips + play                   which clip, looped or not, at what speed
//   solid                          the asset's own answer to "can you walk into it"
//
// The manifest's `rigs` entry for a placement is applied on top of the script's
// own pose, the way placements shadow hand-written props: the asset says what
// it does anywhere, the pavilion says what this copy does here.
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

const { Quat, Vec3, Mat4 } = pc;

export const SCRIPT_VERSION = 1;

// One fetch per script URL, shared by every placement of the asset — the same
// dedup the container cache in standalone/main.mjs does for the GLB.
const loaded = new Map();

/**
 * Fetch a script and the clip it plays. Resolves to { url, script, clip } —
 * `clip` null when the script plays nothing — or rejects with why.
 *
 * `no-cache` rather than the placements file's `no-store`: an asset changes
 * when it is copied in again, not on every export, so a revalidated cache is
 * the right fit. The dev server answers a conditional GET with 304.
 */
export function loadScript(url) {
  let pending = loaded.get(url);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const script = await res.json();
      if (script.version !== SCRIPT_VERSION) {
        console.warn(`[script ${url}] version ${script.version}, this loader reads ${SCRIPT_VERSION}`);
      }
      let clip = null;
      const name = script.play?.clip;
      if (name) {
        const entry = (script.clips ?? []).find((c) => c.name === name);
        if (!entry) throw new Error(`play.clip "${name}" is not one of the script's clips`);
        // Relative to the script, not the page: the folder is the unit that moves.
        const clipUrl = new URL(entry.file, new URL(url, location.href));
        const r = await fetch(clipUrl, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${entry.file}: HTTP ${r.status}`);
        clip = await r.json();
      }
      return { url, script, clip };
    })();
    loaded.set(url, pending);
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
  constructor(root, clip, script, bind, label = '') {
    this.label = label;
    this.name = clip.name;
    this.times = Float32Array.from(clip.times ?? []);
    this.duration = clip.duration ?? (this.times.length ? this.times[this.times.length - 1] : 0);
    const play = script.play ?? {};
    this.loop = play.loop ?? clip.loop ?? true;
    this.speed = play.speed ?? 1;
    this.time = 0;
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
      const rootBone = shallowest(matchNodes(root, script.rig?.root ?? clip.root.bone));
      const pelvis = rootBone && shallowest(matchNodes(root, clip.root.bone).filter((n) => isUnder(n, rootBone)));
      const axes = rootBone && readAxes(root, rootBone, script.rig);
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
    this.seek(0);
  }

  /** Nodes actually driven — what the placement log reports. */
  get count() { return this.tracks.reduce((n, t) => n + t.nodes.length, 0); }

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

/**
 * PropScript — one placed prop, doing what its script says.
 *
 * Order matters and is fixed here: capture every node's bind transform first,
 * then hang what the script says where (measured against that bind), then the
 * script's own pose, then the clip — which composes onto the captured bind, so
 * a pose on a bone the clip also drives is simply overwritten every frame.
 */
export class PropScript {
  constructor(root, { url, script, clip }, label = '') {
    this.root = root;
    this.url = url;
    this.label = label;
    this.script = script;
    this.warnings = [];
    this.attached = [];   // [{ node, to }] as actually done

    // Bind pose, before anything moves: what every delta is a delta on.
    this.bind = new Map();
    const walk = (e) => {
      this.bind.set(e, { q: e.getLocalRotation().clone(), p: e.getLocalPosition().clone() });
      for (const c of e.children) walk(c);
    };
    walk(root);

    for (const entry of script.rig?.attach ?? []) this.attach(entry?.node, entry?.to);

    const posed = ['pose', 'hide', 'offset', 'move'].some((k) => script[k] !== undefined);
    this.rig = posed ? new PropRig(root, script, label) : null;
    if (this.rig?.missing.length) this.warnings.push(`no node matched: ${this.rig.missing.join(', ')}`);

    this.player = clip ? new ClipPlayer(root, clip, script, this.bind, label) : null;
    if (this.player?.missing.length) this.warnings.push(`clip ${clip.name}: no node matched ${this.player.missing.join(', ')}`);
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
  get solid() { return this.script.solid; }

  /** A mesh the script's pose hid is gone from collision too. */
  collides(name) { return this.rig ? this.rig.collides(name) : true; }

  update(dt) { this.player?.update(dt); }

  /** One line for the placement log. */
  describe() {
    const parts = [];
    if (this.player) {
      const p = this.player;
      parts.push(`playing ${p.name} ${p.duration.toFixed(1)} s${p.loop ? ' looped' : ' once'}`
        + `${p.speed !== 1 ? ` at ${p.speed}x` : ''} on ${p.count} nodes${p.root ? ' + root motion' : ''}`);
    }
    if (this.rig) parts.push(`${this.rig.count} bones posed`);
    for (const a of this.attached) parts.push(`${a.node} hung off ${a.to}`);
    return parts.join(', ') || 'nothing to do';
  }
}
