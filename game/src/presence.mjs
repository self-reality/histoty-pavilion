// Everyone else in the world, whatever they are playing.
//
// There is one world and several games in it at once (see src/modes/). The
// people in it are listed here by id, each with the mode they are in and
// where they stand. What that pair of modes does when they meet is decided in
// one place, meet() below. Today every answer is 'ghost': you see them,
// half-transparent, and nothing else. They are not in the collider, so you
// walk (and drive, and fly) through them; they are not targets, so a shot
// passes through them; and they are not props, so E never offers them.
//
// The list is filled by ./net.mjs, from what other people's browsers say, with
// join() / move() / leave(). A meeting that should do more than ghost — a car
// that knocks a soldier over — is promoted in meet(), one pair at a time.
import { Entity, Color, StandardMaterial, BLEND_NORMAL } from 'playcanvas';

/**
 * How someone in mode `a` meets someone in mode `b`. Symmetric.
 * 'ghost' — seen, and nothing else.
 */
export function meet(a, b) {
  return 'ghost';
}

// What a ghost looks like follows from how it moves, not what game it plays:
// anyone on foot is a figure, anyone flying is a small camera. The joiner
// says which (`body`), so the world never has to know the mode itself.
const SHAPES = {
  walker(root, mat) {
    part(root, 'capsule', mat, [0, 0.9, 0], [0.6, 0.9, 0.6]);
    part(root, 'sphere', mat, [0, 1.62, 0.18], [0.12, 0.12, 0.12]);   // the eyes' side
  },
  flyer(root, mat) {
    part(root, 'box', mat, [0, 0, 0], [0.34, 0.24, 0.4]);
    part(root, 'cone', mat, [0, 0, 0.3], [0.26, 0.24, 0.26], [90, 0, 0]);  // the lens
  },
};

function part(root, type, material, [x, y, z], [sx, sy, sz], [rx, ry, rz] = [0, 0, 0]) {
  const e = new Entity(type);
  e.addComponent('render', { type, material, castShadows: false, receiveShadows: false });
  e.setLocalPosition(x, y, z);
  e.setLocalScale(sx, sy, sz);
  e.setLocalEulerAngles(rx, ry, rz);
  root.addChild(e);
}

function ghostMaterial() {
  const m = new StandardMaterial();
  m.diffuse = new Color(0.75, 0.85, 1);
  m.emissive = new Color(0.25, 0.32, 0.45);
  m.opacity = 0.35;
  m.blendType = BLEND_NORMAL;
  m.depthWrite = false;
  m.update();
  return m;
}

export class Presence {
  constructor(app) {
    this.app = app;
    this.people = new Map();      // id -> { id, mode, body, entity }
    this.mat = ghostMaterial();
  }

  /** Someone came into the world: `mode` they play, `body` they move as ('walker' | 'flyer'). */
  join(id, { mode, body = 'walker' }) {
    this.leave(id);
    const entity = new Entity(`ghost:${id}`);
    (SHAPES[body] ?? SHAPES.walker)(entity, this.mat);
    this.app.root.addChild(entity);
    const person = { id, mode, body, entity };
    this.people.set(id, person);
    return person;
  }

  /**
   * Where they are now: `pos` is the feet for a walker, the lens for a flyer —
   * the same point their own game keeps — and `yaw` in degrees.
   */
  move(id, pos, yaw = 0) {
    const person = this.people.get(id);
    if (!person) return;
    person.entity.setPosition(pos.x, pos.y, pos.z);
    // The shapes face +Z; a view with yaw 0 looks down -Z.
    person.entity.setEulerAngles(0, yaw + 180, 0);
  }

  leave(id) {
    const person = this.people.get(id);
    if (!person) return;
    person.entity.destroy();
    this.people.delete(id);
  }

  /** How this person meets someone playing `mode`. */
  meets(id, mode) {
    const person = this.people.get(id);
    return person ? meet(person.mode, mode) : null;
  }
}
