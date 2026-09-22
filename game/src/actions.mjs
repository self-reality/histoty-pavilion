// Actions — walk up to something, see an E, press it.
//
// WHAT a prop can be set off to do is the asset's: its script lists `actions`,
// each a name, a label and a clip, and ./script.mjs runs the one that is asked
// for. This file is the pavilion's half, the part the kit's contract leaves to
// the consumer on purpose:
//
//   who is in reach    inside the area the asset carries in its package (see
//                      ./areas.mjs) — or, when it carries none, within the
//                      action's `radius` of the prop itself, two metres by default
//   which one          of several in reach, the one nearest the middle of the
//                      view: you press E at what you are looking at
//   the hint           an E and the action's label over every prop in reach, the
//                      one the key would act on lit and the rest dimmed
//   the key            E — bound in main.mjs, which calls trigger()
//
// The default reach is measured from the prop's bounds, not its origin, and to
// the player's whole standing height, not their eyes. An origin is wherever the
// modeller left it — g-man's is between his shoes, 1.6 m below the camera, so
// two metres eye-to-origin would be one metre across the floor — and a tent's
// is somewhere inside the tent. "Within two metres of it" should mean of IT.
// The bounds are read live, so a dancer who has walked off his spot is reached
// where he is.
import { Mat4, Vec3 } from 'playcanvas';
import { areaFromAsset } from './areas.mjs';

// How far in from the edge of the screen a hint stops when the thing it
// belongs to is off to one side or behind you, in CSS pixels. A hint you cannot
// see is a key that works for no visible reason.
const EDGE = 56;

// Where over a prop its hint sits, as a fraction of its height: chest rather
// than crotch on a standing figure, and still on the object for anything else.
const HINT_HEIGHT = 0.7;

const FALLBACK_STOP = 'Stop';

const _to = new Vec3();
const _view = new Mat4();
const _viewProj = new Mat4();

export class Actions {
  /**
   * `layer` is the DOM element hints are added to — `#actions` in index.html,
   * which also carries their CSS. Without one (a page that never grew the
   * markup) everything still works and nothing is drawn.
   */
  constructor({ app, camera, player, layer = null }) {
    this.app = app;
    this.camera = camera;
    this.player = player;
    this.layer = layer;
    this.items = [];          // placed props whose script has actions
    this.offers = [];         // who is in reach this frame: [{ item, action, area, anchor, facing }]
    this.active = null;       // the offer E would act on, or null
  }

  /** A prop has landed whose script lists actions. */
  add(name, root, script) {
    if (!script?.actions.length) return null;
    const item = {
      name, root, script, areas: [], hint: null, shown: null,
      // Every mesh the prop draws; which of them are visible is asked each
      // frame, since a pose may hide one after this runs.
      instances: root.findComponents('render').flatMap((rc) => rc.meshInstances),
      min: new Vec3(), max: new Vec3(), anchor: new Vec3(),
    };
    this.items.push(item);
    this.claim(item);
    return item;
  }

  // The areas the asset brought with it, and which action each offers. Placed
  // by the prop's world transform as it stands now — after its pose has settled
  // its seat offset — so the area is where the prop is.
  claim(item) {
    item.areas = [];
    const own = (item.script.script.areas ?? [])
      .map((entry) => areaFromAsset(entry, item.root.getWorldTransform(), item.name)).filter(Boolean);
    for (const area of own) {
      const action = area.action ? item.script.actions.find((a) => a.name === area.action) : item.script.actions[0];
      if (!action) {
        console.warn(`[actions] ${area.name}: ${item.name} has no action named "${area.action}" `
          + `(it has ${item.script.actions.map((a) => a.name).join(', ')}) — area ignored`);
        continue;
      }
      item.areas.push({ area, action });
    }
    const first = item.script.actions[0];
    console.log(`[actions] ${item.name}: ` + (item.areas.length
      ? item.areas.map(({ area, action }) => `"${action.name}" offered inside ${area.name}`).join(', ')
      : `"${first.name}" offered within ${first.radius} m`));
  }

  // The prop's world bounds as it stands this frame, and the point its hint
  // hangs on. False if it is drawing nothing at all.
  measure(item) {
    const { min, max } = item;
    min.set(Infinity, Infinity, Infinity);
    max.set(-Infinity, -Infinity, -Infinity);
    for (const mi of item.instances) {
      if (!mi.visible) continue;                 // a `_col` proxy, or a mesh the pose hid
      const box = mi.aabb;
      const lo = box.getMin(), hi = box.getMax();
      min.x = Math.min(min.x, lo.x); min.y = Math.min(min.y, lo.y); min.z = Math.min(min.z, lo.z);
      max.x = Math.max(max.x, hi.x); max.y = Math.max(max.y, hi.y); max.z = Math.max(max.z, hi.z);
    }
    if (min.x > max.x) return false;
    item.anchor.set((min.x + max.x) / 2, min.y + (max.y - min.y) * HINT_HEIGHT, (min.z + max.z) / 2);
    return true;
  }

  // Which action of this prop the player is in reach of, if any.
  reach(item) {
    const p = this.player.pos;                   // feet
    const top = p.y + this.player.eyeHeight;
    if (item.areas.length) {
      // Any of three points up the body — soles, belt, eyes — so an area drawn
      // as a slab on the floor works as well as one drawn as a room.
      for (const { area, action } of item.areas) {
        if (area.contains(p.x, p.y + 0.05, p.z) || area.contains(p.x, (p.y + top) / 2, p.z)
          || area.contains(p.x, top, p.z)) return { action, area };
      }
      return null;
    }
    const action = item.script.actions[0];
    const { min, max } = item;
    const dx = Math.max(min.x - p.x, 0, p.x - max.x);
    const dy = Math.max(min.y - top, 0, p.y - max.y);
    const dz = Math.max(min.z - p.z, 0, p.z - max.z);
    return dx * dx + dy * dy + dz * dz <= action.radius * action.radius ? { action, area: null } : null;
  }

  /**
   * Once a frame. `showing` is whether hints belong on screen at all — not
   * while the pause overlay is up. Works out who is in reach and which of them
   * E would act on either way, so trigger() never reads a stale answer.
   */
  update(showing = true) {
    const eye = this.camera.getPosition();
    const forward = this.camera.forward;
    this.offers = [];
    for (const item of this.items) {
      if (!this.measure(item)) continue;
      const reached = this.reach(item);
      if (!reached) continue;
      _to.sub2(item.anchor, eye).normalize();
      this.offers.push({ item, ...reached, anchor: item.anchor, facing: _to.dot(forward) });
    }
    // Of several, the one nearest the middle of the view. One alone is it,
    // wherever you are looking: the E is on screen, so the E works.
    this.active = this.offers.reduce((best, o) => (!best || o.facing > best.facing ? o : best), null);
    this.draw(showing);
  }

  /** E. Returns what was set off — `{ name, action, running }` — or null. */
  trigger() {
    const offer = this.active;
    if (!offer) return null;
    const { item, action } = offer;
    item.script.trigger(action.name);
    const running = item.script.acting === action;
    console.log(`[actions] ${item.name}: ${action.name} ${running ? 'set off' : 'stopped'}`);
    return { name: item.name, action: action.name, running };
  }

  // ---- The hints ------------------------------------------------------------

  draw(showing) {
    if (!this.layer) return;
    const offered = new Map(showing ? this.offers.map((o) => [o.item, o]) : []);
    for (const item of this.items) {
      const offer = offered.get(item);
      if (!offer) {
        if (item.hint && item.shown) { item.hint.style.display = 'none'; item.shown = null; }
        continue;
      }
      const hint = item.hint ?? (item.hint = this.makeHint());
      const running = item.script.acting === offer.action;
      const label = running ? (offer.action.stop ?? FALLBACK_STOP) : offer.action.label;
      const lit = offer === this.active;
      const [x, y, pinned, flipped] = this.place(offer.anchor);
      // Written only when it changes: this runs every frame and the DOM is not free.
      const shown = item.shown ?? (item.shown = {});
      if (shown.label !== label) { hint.lastChild.textContent = label; shown.label = label; }
      if (shown.lit !== lit) { hint.classList.toggle('active', lit); shown.lit = lit; }
      if (shown.pinned !== pinned) { hint.classList.toggle('pinned', pinned); shown.pinned = pinned; }
      if (shown.flipped !== flipped) { hint.classList.toggle('flipped', flipped); shown.flipped = flipped; }
      if (shown.x !== x || shown.y !== y) {
        // The KEY sits on the point, not the middle of key-plus-label: the E is
        // the thing being pointed with, and the word trails off to one side.
        hint.style.transform = `translate(${x}px, ${y}px)`;
        shown.x = x; shown.y = y;
      }
      if (!shown.on) { hint.style.display = ''; shown.on = true; }
    }
  }

  makeHint() {
    const hint = document.createElement('div');
    hint.className = 'action-hint';
    hint.style.display = 'none';
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = 'E';
    const label = document.createElement('span');
    label.className = 'label';
    hint.append(key, label);
    this.layer.append(hint);
    return hint;
  }

  // Where on screen a world point's hint goes, in CSS pixels: on the point
  // when it is in view, slid to the nearest edge when it is off to a side or
  // behind. Behind the camera the projection comes out mirrored through the
  // centre — the divide is by a negative w — so it is mirrored back first.
  //
  // Projected here rather than through camera.worldToScreen(), which reads a
  // view matrix the engine refreshes at render time: this runs in the update
  // before that, after the player has moved, and a hint placed with last
  // frame's camera swims against the thing it is pinned to as you turn.
  place(point) {
    const rect = this.app.graphicsDevice.clientRect;
    const w = rect.width, h = rect.height;
    _view.copy(this.camera.getWorldTransform()).invert();
    const d = _viewProj.mul2(this.camera.camera.projectionMatrix, _view).data;
    const cw = point.x * d[3] + point.y * d[7] + point.z * d[11] + d[15];
    const behind = cw <= 0;
    const iw = 1 / (Math.abs(cw) < 1e-6 ? 1e-6 : cw);
    let dx = (point.x * d[0] + point.y * d[4] + point.z * d[8] + d[12]) * iw * w / 2;
    let dy = -(point.x * d[1] + point.y * d[5] + point.z * d[9] + d[13]) * iw * h / 2;
    if (behind) { dx = -dx; dy = -dy; }
    const hw = Math.max(w / 2 - EDGE, 1), hh = Math.max(h / 2 - EDGE, 1);
    const pinned = behind || Math.abs(dx) > hw || Math.abs(dy) > hh;
    if (pinned) {
      if (!dx && !dy) dy = 1;
      const k = Math.min(hw / Math.max(Math.abs(dx), 1e-6), hh / Math.max(Math.abs(dy), 1e-6));
      dx *= k; dy *= k;
    }
    // Against the right-hand edge the label would run off the screen, so it
    // goes to the left of its key instead.
    return [Math.round(w / 2 + dx), Math.round(h / 2 + dy), pinned, pinned && dx > 0];
  }
}
