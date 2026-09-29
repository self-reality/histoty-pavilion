# Modes: the games played in the world

There is one world: the map, its collision, the placed packages and their
scripts, the sound bank, the E key, and the people in it. Everything outside
this folder belongs to it. A **mode** is one game played in that world, and
this folder holds one folder per mode:

| id | what | moves as |
| --- | --- | --- |
| `shooter` | on foot, an AK, dummies to score on | `walker` |
| `flyover` | a free camera | `flyer` |

No mode is the base game with the others added on. The shooter is the one a
bare URL opens (`?mode=flyover` opens the other), and that is all being first
means. The overlay lists them all, and picking one while paused switches to it
in place, from where you are.

## The rules

- **The world never imports a mode.** `src/main.mjs` reaches one only through
  `import()` of `./modes/<id>/index.mjs` when it is entered, so a mode nobody
  plays is never downloaded. **A mode never imports another.** A mode may
  import any world module (`player.mjs`, `collision.mjs`, `spawn.mjs`, …).
  `tests/modes.mjs` checks all three rules by reading the source.
- **A mode reads the world and does not change it.** The collider is shared
  and nobody writes to it after load. Whatever a mode puts on stage (a gun,
  targets, bullet holes, a layer), it takes away again in `exit()`.
- **No zones.** A mode is not tied to a part of the map. Everyone can go
  anywhere.
- **Everyone else is a ghost** (`src/presence.mjs`): seen, never collided
  with, never shot, never offered to E. What any two modes do when they meet
  is decided in one place, `meet(a, b)`, which returns `'ghost'` for every
  pair today.

## The shape of a mode

`index.mjs` default-exports:

```js
export default {
  id: 'flyover',                 // same as the folder
  title: 'FLY-OVER',             // the overlay's heading
  sub: 'Free camera',
  body: 'flyer',                 // how its ghost is drawn to others: 'walker' | 'flyer'
  controls: [['Space / C', 'Up / down'], …],   // its keys; E and Esc are the world's
  enter(world, from) { return session; },
};
```

`enter(world, from)` puts the game on stage. `from` is the last game's view,
`{ x, y, z, yaw, pitch }` with the position at the eye, or `null` on the first
entry. `world` holds:

| | |
| --- | --- |
| `app`, `manifest` | the engine and the scene manifest |
| `collider`, `floors`, `spawn` | the shared collision, the floor samples, where people start |
| `camera`, `rig` | the one view: the camera entity and the root it hangs from |
| `walker`, `rescue` | the walking body and its fall rescue, for any game on foot |
| `audio`, `actions`, `presence` | the sound bank, the E key, everyone else |

The session it returns:

| | |
| --- | --- |
| `body` | whatever E measures reach from: `pos` and `eyeHeight` |
| `view()` | the eye and bearing, handed to the next game as its `from` |
| `update(dt, live)` | once a frame; `live` is false while paused |
| `look(dx, dy)`, `down(b)`, `up(b)`, `press(key)` | mouse and keys, only while playing (all optional) |
| `pause()` | the pointer was released (optional) |
| `exit()` | take everything of its own off stage |

A new mode is a folder here and an entry in `MODE_NAMES` in `src/main.mjs`.
