// Touch controls: phones and tablets, laid out the way a block-building game
// on a phone lays them out.
//
//   bottom left    a D-pad: forward, back, left, right. Holding forward puts
//                  two diagonals beside it; the finger can slide from arrow to
//                  arrow without lifting. Forward tapped twice runs, until it
//                  is let go.
//   bottom right   the game's own buttons (jump, up / down, reload …): each one
//                  is a key, held while the finger is on it.
//   everywhere     drag to look. A quick tap is E — on the E hint tapped, or
//   else           else on the one E would take. A finger held still is the
//                  left mouse button, held until it lifts (the shooter fires).
//   top            pause.
//
// None of it is a second way of playing: every control is a key or a mouse
// button the game already has, so a mode reads touch with the keyboard
// (world.held, in main.mjs) and is told of presses, looks and the button
// exactly as a mouse and keyboard would tell it.
import * as pc from 'playcanvas';

const TAP_MS = 250;          // a touch shorter than this, that did not move, is a tap
const HOLD_MS = 300;         // a touch still for this long is the button held
const SLOP = 12;             // px a finger may wander and still be still
const DOUBLE_MS = 300;       // forward twice within this runs
const LOOK = 2.2;            // a px of finger is this many px of mouse

// The D-pad's cells, by grid area.
const PAD = [
  { id: 'fl', keys: [pc.KEY_W, pc.KEY_A], diag: true },
  { id: 'f', keys: [pc.KEY_W], glyph: '▲' },
  { id: 'fr', keys: [pc.KEY_W, pc.KEY_D], diag: true },
  { id: 'l', keys: [pc.KEY_A], glyph: '◀' },
  { id: 'r', keys: [pc.KEY_D], glyph: '▶' },
  { id: 'b', keys: [pc.KEY_S], glyph: '▼' },
];

/** Is this a device whose main pointer is a finger? `?touch` says yes anywhere. */
export function touchFirst() {
  if (new URLSearchParams(location.search).has('touch')) return true;
  return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
}

export class Touch {
  /**
   * `on`: { look(dx, dy), tap(x, y), down(), up(), press(key), pause() } —
   * the mouse and keyboard events a mode already takes, and pausing.
   */
  constructor(on) {
    this.on = on;
    this.playing = false;
    this.sprint = false;
    this._held = new Map();         // key -> how many fingers hold it
    this._pad = null;               // { pointer, cell } of the finger on the D-pad
    this._look = null;              // { pointer, x, y, t, moved, holding, timer }
    this._buttons = new Map();      // pointer -> key of a game button
    this._lastForward = -Infinity;

    const root = this.root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <button type="button" id="touchPause" aria-label="Pause"></button>
      <div id="touchPad">${PAD.map((c) => `<div class="cell${c.diag ? ' diag' : ''}" data-cell="${c.id}">${c.glyph ?? ''}</div>`).join('')}</div>
      <div id="touchButtons"></div>`;
    document.body.append(root);
    this.padEl = root.querySelector('#touchPad');
    this.buttonsEl = root.querySelector('#touchButtons');

    root.querySelector('#touchPause').addEventListener('pointerup', (e) => {
      e.stopPropagation();
      this.on.pause();
    });
    root.addEventListener('pointerdown', (e) => this._down(e));
    root.addEventListener('pointermove', (e) => this._move(e));
    root.addEventListener('pointerup', (e) => this._up(e));
    root.addEventListener('pointercancel', (e) => this._up(e));
    // No long-press menu, no text selection, no double-tap zoom.
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Is this key held by a finger? */
  held(key) {
    if (key === pc.KEY_SHIFT && this.sprint) return true;
    return (this._held.get(key) ?? 0) > 0;
  }

  /** The game's buttons: [{ key, label }], bottom right, top to bottom (the last under the thumb). */
  setButtons(list) {
    this.buttonsEl.replaceChildren(...list.map(({ key, label }) => {
      const b = document.createElement('div');
      b.className = 'tbtn';
      b.dataset.key = key;
      b.textContent = label;
      return b;
    }));
  }

  start() {
    this.playing = true;
    document.body.classList.add('touching');
  }

  /** Everything let go: paused, or a question put on the screen. */
  stop() {
    this.playing = false;
    document.body.classList.remove('touching');
    if (this._look?.holding) this.on.up();
    if (this._look) clearTimeout(this._look.timer);
    this._look = null;
    this._pad = null;
    this._buttons.clear();
    this._held.clear();
    this.sprint = false;
    this._drawPad(null);
    for (const b of this.buttonsEl.children) b.classList.remove('on');
  }

  _hold(key, by) {
    const n = (this._held.get(key) ?? 0) + by;
    this._held.set(key, Math.max(0, n));
  }

  _cellAt(x, y) {
    const el = document.elementFromPoint(x, y)?.closest?.('#touchPad .cell');
    if (!el) return null;
    const cell = PAD.find((c) => c.id === el.dataset.cell);
    // A diagonal is only there while forward is.
    if (cell.diag && !this.padEl.classList.contains('forward')) return null;
    return cell;
  }

  _setPad(cell) {
    const was = this._pad.cell;
    if (was === cell) return;
    for (const k of was?.keys ?? []) this._hold(k, -1);
    for (const k of cell?.keys ?? []) this._hold(k, +1);
    const forward = !!cell?.keys.includes(pc.KEY_W);
    if (!forward) this.sprint = false;
    else if (!was?.keys.includes(pc.KEY_W)) {
      // Forward again soon after it was last pressed: run.
      const now = performance.now();
      if (now - this._lastForward < DOUBLE_MS) this.sprint = true;
      this._lastForward = now;
    }
    this._pad.cell = cell;
    this._drawPad(cell);
  }

  _drawPad(cell) {
    for (const el of this.padEl.children) el.classList.toggle('on', el.dataset.cell === cell?.id);
    this.padEl.classList.toggle('forward', !!cell?.keys.includes(pc.KEY_W));
    this.padEl.classList.toggle('running', this.sprint);
  }

  _down(e) {
    if (!this.playing) return;
    e.preventDefault();
    const t = e.target;
    if (t.closest('#touchPause')) return;
    if (t.closest('#touchPad')) {
      if (this._pad) return;                       // one finger steers
      this.root.setPointerCapture(e.pointerId);
      this._pad = { pointer: e.pointerId, cell: null };
      this._setPad(this._cellAt(e.clientX, e.clientY));
      return;
    }
    const btn = t.closest('.tbtn');
    if (btn) {
      const key = Number(btn.dataset.key);
      this.root.setPointerCapture(e.pointerId);
      this._buttons.set(e.pointerId, key);
      btn.classList.add('on');
      this._hold(key, +1);
      this.on.press(key);
      return;
    }
    if (this._look) return;                        // one finger looks
    this.root.setPointerCapture(e.pointerId);
    const look = this._look = { pointer: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), moved: false, holding: false };
    look.timer = setTimeout(() => {
      if (this._look !== look || look.moved) return;
      look.holding = true;
      this.on.down();
    }, HOLD_MS);
  }

  _move(e) {
    if (!this.playing) return;
    if (this._pad?.pointer === e.pointerId) {
      this._setPad(this._cellAt(e.clientX, e.clientY));
      return;
    }
    const look = this._look;
    if (look?.pointer !== e.pointerId) return;
    // Every coalesced sample, so a fast flick turns as far as the finger went.
    const dx = e.clientX - look.x, dy = e.clientY - look.y;
    look.x = e.clientX; look.y = e.clientY;
    if (!look.moved && Math.hypot(look.x - look.x0, look.y - look.y0) > SLOP) look.moved = true;
    if (look.moved || look.holding) this.on.look(dx * LOOK, dy * LOOK);
  }

  _up(e) {
    if (this._pad?.pointer === e.pointerId) {
      this._setPad(null);
      this._pad = null;
      return;
    }
    if (this._buttons.has(e.pointerId)) {
      const key = this._buttons.get(e.pointerId);
      this._buttons.delete(e.pointerId);
      this._hold(key, -1);
      if (!this.held(key)) this.buttonsEl.querySelector(`[data-key="${key}"]`)?.classList.remove('on');
      return;
    }
    const look = this._look;
    if (look?.pointer !== e.pointerId) return;
    clearTimeout(look.timer);
    this._look = null;
    if (look.holding) this.on.up();
    else if (!look.moved && e.type === 'pointerup' && performance.now() - look.t < TAP_MS + HOLD_MS) {
      this.on.tap(e.clientX, e.clientY);
    }
  }
}
