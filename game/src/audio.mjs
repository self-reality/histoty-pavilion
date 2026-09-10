// The sound bank, cast onto the game.
//
// The files are **not made here**. They arrive finished from the sibling
// `sound-design` repo — the same deal `assets/*.glb` has with the development
// kit — and are tracked in `assets/sounds/` the moment they land:
//
//     cp ../../sound-design/dist/*.ogg assets/sounds/
//     cp ../../sound-design/dist/sounds.manifest.json assets/sounds/
//
// What lives in this file is *casting*: which event plays which voice, how
// loud, and how the movement voices are timed against the controller in
// player.mjs. Re-shaping a sound is a number in that repo's config, never an
// edit here; re-timing the game's footsteps is an edit here and never there.
//
// **The bank declares itself.** `sounds.manifest.json` ships beside the audio
// and names, for every file, the logical voice it is a take of — so a fifth
// `step_walk` take is a re-copy of the directory and no edit on this side.
// Nothing below hardcodes a filename or a variant count.
//
// Two promises out of that repo's SOUND_CONTRACT.md are load-bearing here:
//
//   • **Levels are the mix.** Files are peak-normalised per category, not
//     uniformly — a footstep already sits ~9 dB under a rifle shot at gain 1.0.
//     So nothing below sets a per-sound volume. Doing so would throw away the
//     one thing the bank knows that the engine does not.
//   • **Every voice has decayed 15 dB by the interval the game retriggers it
//     at**, checked against this game's own numbers (0.1 s of fire, a 2.2 m
//     stride). That is what makes `overlap: true` layer tails instead of mud.
import { Asset } from 'playcanvas';

// Metres of ground covered per footstep. Not a human stride — it is the number
// that makes player.mjs's speeds sound right: 6.5 m/s `walkSpeed` puts a foot
// down every 0.34 s and 9.6 m/s `runSpeed` every 0.23 s, which is the cadence
// the bank was rendered and level-checked against. Quake-lineage movement
// speeds have never matched human legs, and chasing anatomical realism here
// produces a sprint that sounds like a sewing machine.
const STRIDE = 2.2;

// Horizontal speed that swaps the walk take for the run take. It sits between
// `walkSpeed` (6.5) and `runSpeed` (9.6) so the choice tracks how fast you are
// actually moving rather than whether Shift is held: sprint stays true through
// the deceleration after you release W, and the steps should slow down with
// you rather than keep pounding.
const RUN_SPEED = 8.0;

// Impact speeds, m/s. The floor gate is not optional. Walking the ripped map,
// player.mjs's resolve drops `grounded` for a stray frame at seams before
// ground-glue snaps it back — and one frame of gravity is only ~0.37 m/s,
// while a real landing is 8 m/s or more. 2.5 has a factor of twenty of
// daylight either side of it, so there is no thud every few steps on flat
// ground.
const LAND_MIN = 2.5;

// A flat jump lands at `jumpSpeed` (8.1) and stays a soft landing, which is
// what you want; 11 m/s is a ~2.75 m drop, so the heavy one means something.
const LAND_HARD = 11.0;

// Per-trigger gain jitter, dB. The ear locks onto a literally repeated
// footstep within about three of them, and this does more against that than
// doubling the take count would — for no load time. Every voice plays
// nominally this far under its file level so the jitter has room to go *up*
// as well as down (slot volume clamps at 1.0). The offset is uniform across
// the bank, so the relative mix the category ceilings encode survives it.
const JITTER_DB = 1.5;

// Weapon event -> voice. weapon.mjs emits gameplay events and knows nothing
// about a sound bank; this table is the whole coupling between the two.
//
// `ak47_reload` is one 2.30 s file sized to `weapon.reloadTime`, ending ~0.1 s
// early so the sequence reads as finished rather than cut. The bank also ships
// `ak47_clipout` / `ak47_clipin` / `ak47_boltpull` — the same three events
// split apart, at 0.00 / 0.72 / 1.52 s — for the day the reload grows stages
// with their own timers. Until then they load and go unplayed, which costs
// 28 KB and keeps the bank one thing rather than a subset of one.
const WEAPON_VOICES = {
  fire: 'ak47_fire',
  reload: 'ak47_reload',
  dryfire: 'ak47_dryfire',
};

/**
 * Read the bank's own manifest and register one audio asset per shipped file.
 * Returns voice name -> [Asset], e.g. `step_walk -> [4 assets]`.
 */
async function loadBank(app, dir, assets) {
  const res = await fetch(`${dir}sounds.manifest.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const voices = new Map();
  for (const [stem, entry] of Object.entries(data.sounds ?? {})) {
    // Each entry lists its .wav master and its .ogg. Only the .ogg ships (176 KB
    // for the bank against 845 KB), so an entry without one is a master we were
    // not given and cannot play.
    const file = (entry.files ?? []).find((f) => f.endsWith('.ogg'));
    if (!file) continue;

    const asset = new Asset(`sound:${stem}`, 'audio', { url: dir + file });
    asset.on('error', (err) => console.error(`[sound] ${file} failed to load:`, err));
    app.assets.add(asset);
    app.assets.load(asset);
    assets.push(asset);

    const voice = entry.sound ?? stem;
    if (!voices.has(voice)) voices.set(voice, []);
    voices.get(voice).push(asset);
  }
  return voices;
}

/**
 * Loads the bank and plays it. One instance per game; both builds make theirs
 * next to the Weapon (see standalone/main.mjs and src/game.mjs).
 */
export class SoundBank {
  constructor(app, cameraEntity, opts = {}) {
    this.app = app;
    this.entity = cameraEntity;
    this.dir = opts.dir ?? './assets/sounds/';
    this.volume = opts.volume ?? 1;

    this.voices = new Map();   // voice name -> [slot name]
    this.ready = false;
    this._assets = [];
    this._destroyed = false;

    // The listener belongs on the camera, not the player root: weapon.mjs
    // applies recoil punch to the camera's local euler angles, and the world
    // should swing with the view. Nothing in this bank is positional, so it
    // buys nothing today — it is here so the first sound belonging to somebody
    // other than the player has an ear to be placed against.
    //
    // 'audiolistener', not 'listener': that is the component system's id, and
    // addComponent with a name no system claims is a console.error and a null,
    // not a throw. It would have gone unnoticed until the first positional
    // sound played in mono, which is why tests/sound.mjs asserts it is here.
    this._madeListener = !cameraEntity.audiolistener;
    if (this._madeListener) cameraEntity.addComponent('audiolistener');

    // Every sound in the bank is one the PLAYER makes, so none of it is
    // positional: a point source at zero distance from the listener is a
    // division waiting to happen, and it buys nothing — you cannot pan your own
    // boots. Forced rather than merely defaulted, because a positional
    // component here would put the player's own footsteps in 3D space at the
    // camera, which is the exact bug this avoids.
    this._madeSound = !cameraEntity.sound;
    this.sound = cameraEntity.sound ?? cameraEntity.addComponent('sound');
    this.sound.positional = false;

    this._stride = 0;          // metres since the last footstep
    this._wasGrounded = true;  // end-of-last-frame player state; see update()
    this._prevVelY = 0;

    this._load();
  }

  async _load() {
    let voices;
    try {
      voices = await loadBank(this.app, this.dir, this._assets);
    } catch (err) {
      // Not fatal. The game is perfectly playable silent, and a missing bank
      // should read as "nobody has copied the files in yet" rather than as a
      // broken build — the same call scene.placements.json makes.
      console.warn(`[sound] no bank at ${this.dir}:`, err.message);
      return;
    }
    if (this._destroyed) return;   // hot-reload tore us down mid-fetch

    let files = 0;
    for (const [voice, assets] of voices) {
      const slots = [];
      for (const asset of assets) {
        // `overlap` so a held trigger layers tails instead of retriggering one
        // voice and cutting itself off — the bank's 15 dB decay rule is what
        // makes that read as continuous fire rather than as porridge.
        this.sound.addSlot(asset.name, { asset, overlap: true, autoPlay: false });
        slots.push(asset.name);
        files++;
      }
      this.voices.set(voice, slots);
    }
    this.ready = true;
    console.log(`[sound] bank ready — ${this.voices.size} voices, ${files} files`);
  }

  /**
   * How many of the bank's files have decoded, against how many there are.
   *
   * Not the same thing as `ready`, and deliberately not what `play()` waits
   * on: a slot whose asset is still decoding starts the moment it lands, so
   * the bank is usable before this fills up. In practice it always does fill
   * up first — 176 KB decodes while the map is still building collision, and
   * the player cannot take a step until they click Play. It is here as an
   * honest "is the bank warm" signal for the console and for tests/sound.mjs.
   */
  get loaded() { return this._assets.reduce((n, a) => n + (a.resource ? 1 : 0), 0); }

  get total() { return this._assets.length; }

  /**
   * Play one voice, picking a take at random and jittering the gain.
   * Unknown or not-yet-loaded voices are a silent no-op, so call sites never
   * have to check `ready`.
   */
  play(voice) {
    const slots = this.voices.get(voice);
    if (!slots) return null;
    const slot = this.sound.slot(slots.length === 1 ? slots[0] : slots[(Math.random() * slots.length) | 0]);
    if (!slot) return null;
    // Uniform in dB, because that is what the ear hears as even. Landing in
    // [-2 × JITTER_DB, 0] keeps the loudest trigger at the file's own level
    // rather than clipping against the slot's 1.0 ceiling. The slot is
    // `overlap`, so this only reaches the instance we are about to start —
    // tails already ringing keep the gain they were struck at.
    const gainDb = (Math.random() - 1) * 2 * JITTER_DB;   // [-3, 0] dB → -1.5 ± 1.5
    slot.volume = Math.min(1, this.volume * 10 ** (gainDb / 20));
    return slot.play();
  }

  /** Bind as the Weapon's `onEvent` — see WEAPON_VOICES. */
  onWeaponEvent(event) {
    const voice = WEAPON_VOICES[event];
    if (voice) this.play(voice);
  }

  /**
   * Movement voices. Call once per frame, immediately after `player.update()`.
   *
   * Jump and landing are both *edges*, and `player.update()` eats them on its
   * way past: it zeroes `vel.y` the frame the feet touch down and clears its
   * own air timer, so by the time we get here the fall has no measurable
   * speed left. What we read instead is the state recorded at the end of the
   * previous frame — which is the same reading, because nothing between the
   * two calls touches `vel.y` or `grounded` except `teleport()`, and teleport
   * zeroes both and so can never manufacture a landing.
   *
   * Keeping that memory in here, rather than asking each caller to sample the
   * player before updating it, means the ordering cannot be got wrong from
   * outside — there is only one call, and it goes after.
   */
  update(dt, player, input) {
    const wasGrounded = this._wasGrounded;
    const fallSpeed = -this._prevVelY;
    this._wasGrounded = player.grounded;
    this._prevVelY = player.vel.y;
    if (!this.ready) return;

    // Exactly the condition player.mjs uses internally for `doJump`, so this
    // cannot disagree with the physics about whether you left the ground.
    if (input.jump && wasGrounded) this.play('jump');

    if (!wasGrounded && player.grounded && fallSpeed > LAND_MIN) {
      this.play(fallSpeed > LAND_HARD ? 'land_hard' : 'land');
    }

    // Footsteps off distance travelled, not a timer: a timer keeps stepping
    // while you decelerate into a wall, and its cadence drifts with framerate.
    // Distance also gets the acceleration ramp for free — starting from rest,
    // the first step lands later because you covered the ground later.
    const hspeed = Math.hypot(player.vel.x, player.vel.z);
    if (player.grounded) {
      this._stride += hspeed * dt;
      if (this._stride >= STRIDE) {
        this._stride = 0;
        this.play(hspeed > RUN_SPEED ? 'step_run' : 'step_walk');
      }
    } else {
      this._stride = 0;   // land on a clean footfall rather than mid-stride
    }
  }

  /** Hot-reload / teardown: give back everything this instance added. */
  destroy() {
    this._destroyed = true;
    this.ready = false;
    for (const slots of this.voices.values()) {
      for (const name of slots) this.sound?.removeSlot(name);
    }
    this.voices.clear();
    for (const asset of this._assets) {
      try { this.app.assets.remove(asset); asset.unload(); } catch (err) { /* ignore */ }
    }
    this._assets = [];
    if (this._madeSound) this.entity.removeComponent('sound');
    if (this._madeListener) this.entity.removeComponent('audiolistener');
    this.sound = null;
  }
}
