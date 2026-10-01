// Actions — walk up to something, see an E, press it.
//
// WHAT a prop can be set off to do is the asset's: its script offers actions,
// each a name, a label and a start and stop for the key to call, and
// ./script.mjs calls the one that applies. What a press MEANS is the
// script's, too — this side only says a key went down. This file is the pavilion's half, the part the kit's contract
// leaves to the consumer on purpose:
//
//   who is in reach    inside the area the asset carries in its package (see
//                      ./areas.mjs) — or, when it carries none, within the
//                      action's `radius` of the prop itself, two metres by default
//   which one          of several in reach, the one nearest the middle of the
//                      view: you press E at what you are looking at
//   the hint           an E and the action's label over every prop in reach, the
//                      one the key would act on lit and the rest dimmed
//   the key            E — bound in main.mjs, which calls trigger()
//   the aim            the camera's line of sight, handed over with the key, so
//                      the script's run.aim says where on the prop you looked
//   who else sees it   an action the script offers as `shared` is the room's:
//                      the key is said to everyone there (`say`, which main.mjs
//                      points at ./net.mjs), theirs is done here (heard()), and
//                      a newcomer is told what is running (going())
//
// A shared press travels as an act — { object, action, press, age, ray }: the
// prop by its name in the scene, which is the same in every browser, the press
// as what it did where it was made ('start' or 'stop'), and how many seconds
// ago. Only an action its script marked `shared` is ever set off by an act;
// anything else another browser asks for is dropped.
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

// How many presses are kept for a prop that has not landed yet. It is one
// start and perhaps a stop; more than a handful is somebody leaning on the key.
const WAITING = 8;

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
    this.say = null;          // (act) => tell the room, when there is one to tell
    this.waiting = new Map(); // prop name -> [{ act, at }] heard before it landed
    this.setOff = new Map();  // script -> when its shared run began, until it is next stepped
    this.stepped = null;      // when scripts with a shared run going were last stepped
  }

  /** A prop has landed whose script offers actions. */
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
    // What the room did to it while it was still on its way: the same presses,
    // in order, each as much older as it has waited.
    for (const { act, at } of this.waiting.get(name) ?? []) this.apply(item, act, (performance.now() - at) / 1000);
    this.waiting.delete(name);
    return item;
  }

  // The areas the asset brought with it, and which action each offers. Placed
  // by the prop's world transform as it stands now — after its pose has settled
  // its seat offset — so the area is where the prop is.
  claim(item) {
    item.areas = [];
    const own = (item.script.manifest.areas ?? [])
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

  // Which action of this prop the player is in reach of, if any. A running
  // action whose script gave the key nothing to do while it runs is not on
  // offer until it ends.
  reach(item) {
    const found = this.inReach(item);
    return found && item.script.offers(found.action) ? found : null;
  }

  inReach(item) {
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

  /** E. Returns what it reached — `{ name, action, running }` — or null. */
  trigger() {
    const offer = this.active;
    if (!offer) return null;
    const { item, action } = offer;
    const was = !!action.run;
    const ray = { origin: this.camera.getPosition().clone(), direction: this.camera.forward.clone() };
    this.press(item, action, { ray });
    const running = !!action.run;
    if (action.shared) {
      const { origin: o, direction: d } = ray;
      this.say?.({ object: item.name, action: action.name, press: was ? 'stop' : 'start', age: 0, ray: [o.x, o.y, o.z, d.x, d.y, d.z] });
    }
    console.log(`[actions] ${item.name}: ${action.name} ${!was ? (running ? 'started' : 'started and done')
      : running ? 'asked to stop — still running' : 'stopped'}`);
    return { name: item.name, action: action.name, running };
  }

  // ---- The room -------------------------------------------------------------

  /** Someone else in the room pressed the key on a shared action. */
  heard(act) {
    if (typeof act?.object !== 'string' || typeof act.action !== 'string' || !['start', 'stop'].includes(act.press)) return;
    const item = this.items.find((i) => i.name === act.object);
    if (item) { this.apply(item, act); return; }
    // Props land after the map is walkable, and a newcomer is told what is
    // running the moment it joins: kept until the prop is there to do it.
    const kept = this.waiting.get(act.object) ?? [];
    if (kept.length < WAITING && (this.waiting.has(act.object) || this.waiting.size < 64)) {
      this.waiting.set(act.object, [...kept, { act, at: performance.now() }]);
    }
  }

  // Do here what was done there. 'start' on one already running is two people
  // pressing at once, and both have it; 'stop' on one that is not is too late.
  apply(item, act, waited = 0) {
    const action = item.script.actions.find((a) => a.name === act.action);
    if (!action?.shared) return;
    const r = Array.isArray(act.ray) && act.ray.length === 6 && act.ray.every(Number.isFinite) ? act.ray : null;
    const ray = r && { origin: r.slice(0, 3), direction: r.slice(3) };
    const age = (Number.isFinite(act.age) && act.age > 0 ? act.age : 0) + waited;
    if ((act.press === 'start') === !!action.run) return;
    this.press(item, action, act.press === 'start' ? { ray, age } : { ray });
    console.log(`[actions] ${item.name}: ${action.name} ${act.press === 'start' ? `started by someone else, ${age.toFixed(2)} s ago` : 'asked to stop by someone else'}`);
  }

  // The key, from here or from anywhere. When it sets a shared run going the
  // moment is kept: see since().
  press(item, action, options) {
    const idle = !item.script.sharing;
    item.script.trigger(action.name, options);
    if (idle && item.script.sharing) this.setOff.set(item.script, performance.now());
  }

  /**
   * How many real seconds to step a script with a shared run going, this
   * frame: since the last frame — `last` and `now` as performance.now() read
   * them — or since the run was set off, when that was later. A key lands
   * between two frames, and the dance begins at the key, not at the frame
   * before it: on a machine drawing ten frames a second that is the tenth of
   * a second two players' dancers would be apart by.
   */
  since(script, last, now) {
    const from = Math.max(this.setOff.get(script) ?? last, last);
    this.setOff.delete(script);
    this.stepped = now;
    return (now - from) / 1000;
  }

  /**
   * What a newcomer walks in on: every shared action running, and for how
   * long — as the run counts it, plus what its script has not been stepped by
   * yet: asked between two frames, or in a tab nobody is looking at, the
   * script's clock is that far behind the room's.
   */
  going() {
    const now = performance.now();
    return this.items.flatMap((item) => {
      const behind = (now - Math.max(this.setOff.get(item.script) ?? 0, this.stepped ?? now)) / 1000;
      return item.script.actions.filter((a) => a.shared && a.run)
        .map((a) => ({ object: item.name, action: a.name, press: 'start', age: a.run.api.age + behind, ray: null }));
    });
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
      const running = !!offer.action.run;
      const label = running ? (item.script.runLabel(offer.action) ?? FALLBACK_STOP) : offer.action.label;
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
