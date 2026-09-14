// Where the player starts, and the address that says so.
//
// The spawn is resolved in layers, each one overriding the last:
//
//   1. the map's middle          pickSpawn()   — every map gets this
//   2. the layout's `spawn*`     markerSpawn() — authored in the .blend
//   3. the page's own address    urlSpawn()    — typed, pasted or copied
//
// The address names only what it wants to change, so `?look=180` turns the
// authored spawn round without moving it and `?at=12,-4` walks it somewhere
// else without touching the bearing:
//
//   ?at=x,y,z        feet position in metres, taken literally
//   ?at=x,z          a place on the ground plan, dropped onto the floor there
//   ?look=yaw        compass bearing in degrees; 0 looks down -Z, 90 down -X
//   ?look=yaw,pitch  ...and the tilt of the view, + up, - down, within ±89
//
// Numbers that do not parse leave their layer alone rather than sending the
// player to the origin. spawnUrl() writes the same form back out, so a place
// found on foot can be handed to someone as a link that opens on it.
import { Vec3 } from 'playcanvas';
import { pickSpawn, markerSpawn } from './world.mjs';

const PITCH_LIMIT = 89;      // Player.addLook clamps to the same
const _down = new Vec3(0, -1, 0);

/**
 * The spawn the page should start from — { x, y, z, yaw, pitch, name } —
 * given the layout's markers, the floor samples the map yielded and the
 * page's query string (`location.search` by default).
 */
export function resolveSpawn({ markers, floors, collider, search = location.search }) {
  const base = markerSpawn(markers, collider) ?? pickSpawn(floors, collider.bounds);
  const spawn = { yaw: 0, pitch: 0, ...base };
  const url = urlSpawn(search, collider);
  if (!url) return spawn;
  return { ...spawn, ...url, name: `url over ${base.name ?? 'map centre'}` };
}

/**
 * What the address asks for, as the subset of { x, y, z, yaw, pitch } it
 * names, or null when it names nothing. A two-number `at` is dropped onto the
 * floor under it; the collider is only needed for that.
 */
export function urlSpawn(search, collider) {
  const params = new URLSearchParams(search);
  const out = {};

  const at = numbers(params.get('at'));
  if (at.length === 3) {
    [out.x, out.y, out.z] = at;
  } else if (at.length === 2) {
    [out.x, out.z] = at;
    const y = floorUnder(collider, out.x, out.z);
    if (y !== null) out.y = y;
  }

  const look = numbers(params.get('look'));
  if (look.length >= 1) out.yaw = look[0];
  if (look.length >= 2) out.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, look[1]));

  return Object.keys(out).length ? out : null;
}

/** Put the player at a spawn: feet on the point, view along its bearing. */
export function placeAtSpawn(player, spawn) {
  player.teleport(spawn.x, spawn.y, spawn.z);
  if (spawn.yaw !== undefined) player.yaw = spawn.yaw;
  if (spawn.pitch !== undefined) player.pitch = spawn.pitch;
}

/**
 * Falling out of the map puts you back on the last floor you stood on, not at
 * the spawn a long walk away. The "save" is simply every grounded frame whose
 * centre has floor under it — no timer, so it is never seconds stale and never
 * a point in mid-jump. The centre check matters: ground-glue can hold the
 * capsule over a crack by its rim, and that is exactly the spot you fall from.
 *
 * If the spot you are put back on does not hold — you fall again without
 * standing anywhere in between — the next fall goes to the spawn instead, so
 * a bad spot can never become a loop.
 */
export class FallRescue {
  constructor(player, collider, { depth = 20 } = {}) {
    this.player = player;
    this.collider = collider;
    this.depth = depth;           // metres below the lowest triangle that count as out
    this.safe = new Vec3();
    this.hasSafe = false;
    this.used = false;            // put back here already, and not stood since
  }

  update() {
    const p = this.player;
    if (p.grounded) {
      const r = p.radius;
      const hit = this.collider.groundBelow(p.pos.x, p.pos.z, p.pos.y + r, r + 0.25);
      if (hit && Math.abs(hit.ny) > 0.5) {
        this.safe.copy(p.pos);
        this.hasSafe = true;
        this.used = false;
      }
    }
    if (p.pos.y >= this.collider.bounds.miny - this.depth) return;
    if (this.hasSafe && !this.used) {
      p.teleport(this.safe.x, this.safe.y, this.safe.z);   // keeps the view where it was
      this.used = true;
    } else if (p.spawn) {
      placeAtSpawn(p, p.spawn);
    }
  }
}

/**
 * The address that opens the page where the player stands now, looking the
 * way they look. Every other parameter (`debug`, the Editor's) is kept.
 */
export function spawnUrl(player, href = location.href) {
  const url = new URL(href);
  const params = new URLSearchParams(url.search);
  params.set('at', [player.pos.x, player.pos.y, player.pos.z].map((v) => v.toFixed(2)).join(','));
  params.set('look', [player.yaw, player.pitch].map((v) => wrap(v).toFixed(1)).join(','));
  // Written by hand rather than by URLSearchParams, which would turn `debug`
  // into `debug=` and every comma into %2C. Both still parse; neither reads.
  url.search = '?' + [...params].map(([k, v]) => v === '' ? k : `${k}=${v}`).join('&');
  return url.toString();
}

// "1.5,-2,3" -> [1.5, -2, 3]; anything that is not all finite numbers -> [].
function numbers(text) {
  if (!text) return [];
  const parts = text.split(',').map((s) => s.trim());
  const nums = parts.map(Number);
  return parts.every((s) => s !== '') && nums.every(Number.isFinite) ? nums : [];
}

// Standing height on the walkable floor under (x, z), probing from above the
// map down through it; null over the void.
function floorUnder(collider, x, z) {
  const b = collider.bounds;
  const top = b.maxy + 5;
  const hit = collider.raycast(new Vec3(x, top, z), _down, (top - b.miny) + 10);
  return hit && hit.normal.y > 0.6 ? hit.point.y + 0.15 : null;
}

function wrap(deg) {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}
