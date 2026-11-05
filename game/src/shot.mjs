/**
 * A shot: a timeline in game time, said in a JSON file (shots/*.json) —
 * where the eye is and how it moves, what is pressed and when, when filming
 * starts and stops. Nothing on it is read off the world.
 *
 *   {
 *     "size":  "1080x1920",  "fps": 30,
 *     "start": 0,            "stop": 111,
 *     "press": [{ "at": 0, "prop": "box-9x16_01", "action": "unmute" }],
 *     "camera": [{ "view": "<link>" }, { "view": "<link>" }, { "at": 60, "view": "<link>" }]
 *   }
 *
 * `view` (one link) stands for a camera of one key. A link is the pause
 * screen's Copy link (?at=…&look=…); a view may also be {x,y,z,yaw,pitch}
 * with y at the eye.
 *
 * Two things play a shot and both read it here, so they cannot disagree on
 * where the camera is: tools/record.mjs, which steps the world and films it,
 * and the page itself on ?shot=<file> (src/main.mjs), which plays it live as
 * a preview. No engine in this file: Node imports it as it is.
 */

/** A view: `feet` when its y is a walker's feet (a link's `at`), not the eye. */
export function parseView(v) {
  const bad = () => new Error(`view ${JSON.stringify(v)} is neither a link, {x,y,z,yaw,pitch} nor x,y,z,yaw,pitch`);
  let w;
  if (v && typeof v === 'object') w = { ...v, feet: false };
  else if (typeof v === 'string' && /^https?:|^[?]/.test(v)) {
    const params = new URL(v, 'http://localhost/').searchParams;
    const at = (params.get('at') ?? '').split(',').map(Number);
    const look = (params.get('look') ?? '').split(',').map(Number);
    if (at.length !== 3 || look.length !== 2) throw new Error(`view ${v} has no at=x,y,z and look=yaw,pitch — copy it from the pause screen`);
    w = { x: at[0], y: at[1], z: at[2], yaw: look[0], pitch: look[1], feet: true };
  } else if (typeof v === 'string') {
    try { w = { ...JSON.parse(v), feet: false }; } catch {
      const n = v.split(',').map(Number);
      w = { x: n[0], y: n[1], z: n[2], yaw: n[3], pitch: n[4], feet: false };
    }
  } else throw bad();
  if (!['x', 'y', 'z', 'yaw', 'pitch'].every((k) => Number.isFinite(w[k]))) throw bad();
  return { x: w.x, y: w.y, z: w.z, yaw: w.yaw, pitch: w.pitch, feet: w.feet };
}

/**
 * The shot as both players need it, checked. Throws on anything it cannot
 * play. Camera keys without an `at` are spread evenly between their
 * neighbours — the first at `start`, the last at `stop` when they have none —
 * and each yaw is taken the short way round from the one before.
 */
export function parseShot(raw) {
  const fps = Number(raw.fps ?? 30);
  const start = Number(raw.start ?? 0);
  const stop = Number(raw.stop);
  const [width, height] = String(raw.size ?? '1280x720').split('x').map(Number);
  if (!(fps > 0)) throw new Error(`fps ${raw.fps} is not a rate`);
  if (!(width > 0 && height > 0)) throw new Error(`size ${raw.size} is not WxH`);
  if (!(start >= 0)) throw new Error(`start ${raw.start} is not a time`);
  if (!(stop > start)) throw new Error(Number.isFinite(stop) ? `stop ${stop} is not after start ${start}` : 'no stop: say when the shot ends');

  const presses = (raw.press ?? []).map((p) => {
    if (!p || typeof p.prop !== 'string' || typeof p.action !== 'string') throw new Error(`press ${JSON.stringify(p)} needs a prop and an action`);
    const at = Number(p.at ?? 0);
    if (!(at >= 0)) throw new Error(`press ${p.prop}:${p.action} at ${p.at} is not a time`);
    return { prop: p.prop, action: p.action, at };
  }).sort((a, b) => a.at - b.at);

  const given = Array.isArray(raw.camera) ? raw.camera : raw.view != null ? [{ view: raw.view }] : [];
  const keys = given.map((k) => ({ at: k.at === undefined ? null : Number(k.at), ...parseView(k.view) }));
  if (keys.length) {
    if (keys[0].at === null) keys[0].at = start;
    if (keys.length > 1 && keys[keys.length - 1].at === null) keys[keys.length - 1].at = stop;
    for (let i = 1; i < keys.length; i++) {
      if (keys[i].at !== null) continue;
      let j = i;
      while (keys[j].at === null) j++;
      const a = keys[i - 1].at, b = keys[j].at;
      for (let k = i; k < j; k++) keys[k].at = a + (b - a) * (k - i + 1) / (j - i + 1);
    }
    for (let i = 0; i < keys.length; i++) {
      if (!(keys[i].at >= 0) || (i && !(keys[i].at > keys[i - 1].at))) throw new Error(`camera key ${i} at ${keys[i].at}: keys go forward in time`);
      // 350 then 10 is 20° right, not 340° left.
      if (i) keys[i].yaw = keys[i - 1].yaw + ((((keys[i].yaw - keys[i - 1].yaw) % 360) + 540) % 360 - 180);
    }
  }
  return { fps, start, stop, width, height, presses, keys };
}

/** The keys with every y at the eye: a link's feet raised by the walker's eye height. */
export function atEye(keys, eyeHeight) {
  return keys.map((k) => (k.feet ? { ...k, y: k.y + eyeHeight, feet: false } : k));
}

/**
 * The camera at time t: a Catmull-Rom curve through the keys, each of
 * x, y, z, yaw and pitch on its own. Its slope at a key is the line between
 * the keys either side, taken over their times, so unevenly spaced keys still
 * pass at an even pace; nought at the first and the last, so the move starts
 * and ends at rest. Hermite between each two keys. Before the first key and
 * after the last the camera stands. Null without keys.
 */
export function cameraAt(keys, t) {
  const n = keys.length;
  if (!n) return null;
  const parts = ['x', 'y', 'z', 'yaw', 'pitch'];
  if (n === 1 || t <= keys[0].at) return Object.fromEntries(parts.map((p) => [p, keys[0][p]]));
  if (t >= keys[n - 1].at) return Object.fromEntries(parts.map((p) => [p, keys[n - 1][p]]));
  let i = 0;
  while (t > keys[i + 1].at) i++;
  const a = keys[i], b = keys[i + 1];
  const h = b.at - a.at;
  const s = (t - a.at) / h;
  const slope = (k, p) => (k === 0 || k === n - 1 ? 0 : (keys[k + 1][p] - keys[k - 1][p]) / (keys[k + 1].at - keys[k - 1].at));
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return Object.fromEntries(parts.map((p) => [p, h00 * a[p] + h10 * h * slope(i, p) + h01 * b[p] + h11 * h * slope(i + 1, p)]));
}
