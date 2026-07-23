# PlayCanvas Editor compatibility

This project now runs **two ways** from one shared codebase:

| Build | Entry point | How you run it | Purpose |
|-------|-------------|----------------|---------|
| **Standalone** (engine-only) | `standalone/main.mjs` → `index.html` | `npm start`, open `localhost:5173` | Instant local run, Playwright tests |
| **Editor** (cloud) | `src/game.mjs` (a `Script`) | Launch from the PlayCanvas Editor | Edit the scene visually, code stays local |

The two share all the real logic — `collision`, `player`, `weapon`, `debug`, and
`world.mjs` (targets, floor/spawn finding, triangle extraction). Only the glue
differs: `standalone/main.mjs` creates its own `pc.Application`; `src/game.mjs` lets
the Editor own the app and attaches as a script component.

**The synced folder is `game/src/`.** Every `.mjs` there is a script asset in your
Editor project. `standalone/`, `index.html`, `lib/`, `assets/`, `tests/` never sync.

---

## One-time cloud setup

1. **Create a project** at [playcanvas.com](https://playcanvas.com) (blank).
2. **Upload the map:** drag `game/assets/de_dust2.glb` into the Editor's Assets panel.
   It becomes a **container** asset.
3. **Enable ES Modules scripts:** Settings → Scripts → set the scripts format to
   **ESM** (so `src/*.mjs` parse as modules).
4. **Sync the code up** — see [Syncing](#syncing-code-terminal--claude-code) below. After
   the first push, open each new script once in the Editor so it gets parsed.
5. **Build the scene:**
   - Add an entity named `Player` at the origin.
   - Add a child entity `Camera` with a **Camera** component.
   - (Optional) Add a **Directional Light** or two — if you don't, `game.mjs` creates
     its own sun + fill on launch.
6. **Attach the game script:** select `Player`, add a **Script** component, add the
   `game` script. In its attributes:
   - **Map (GLB container)** → the `de_dust2` asset from step 2.
   - **Camera** → the `Camera` child (or leave empty; it'll find/create one).
   - `mapScale` (0.025) and `mapRotationX` (-90) are pre-filled defaults.
7. **Launch** (▶). You should get the start overlay → click **Play** to lock the mouse.

---

## Ongoing workflow — what you asked for

- **Scenes** live in the Editor (cloud). Move the camera, tweak lights, drop in new
  entities — all visual, all saved server-side. `game.mjs` respects what you author:
  authored directional lights and camera win; it only fills in defaults when absent.
- **Code** lives here in `game/src/`. Edit in your editor, it syncs up automatically.
  Nothing about the scene comes down into git — that's the intended split.
- **Initial game state from code:** position or spawn objects in `game.mjs`
  (`initialize()` / `_onMapReady`) or add helper scripts. Editor-placed entities can be
  grabbed with `this.app.root.findByName('...')` and repositioned. Decide per object
  whether the **Editor** or **code** owns its transform, so you don't get two sources
  of truth.

---

## Syncing code (terminal / Claude Code)

No VS Code required. `playcanvas-sync` (`pcsync`) is **already installed** (devDependency)
and `pcconfig.json` is **already created** (gitignored). Two steps to go live:

1. **Fill in `pcconfig.json`** — your API key + project/branch IDs. Do this yourself so the
   key never lands in chat or git:
   ```bash
   $EDITOR game/pcconfig.json       # or run the interactive wizard: npx pcsync init
   ```
   - **API key** → `playcanvas.com/<username>/account`
   - **Project + branch IDs** → run in the Editor's browser console:
     ```js
     copy({ PLAYCANVAS_BRANCH_ID: config.self.branch.id, PLAYCANVAS_PROJECT_ID: config.project.id })
     ```
2. **Start the watcher:**
   ```bash
   cd game && npm run sync:watch    # watches game/src → pushes to the Editor on save
   ```

**Daily loop:** edit `src/*.mjs` here → `pcsync` pushes on save → relaunch in the Editor.
On-demand instead of `watch`: `npm run sync:push` / `sync:pull` / `sync:diff`. The watcher
is a long-running process — fine to run it as a background task while you keep editing.

`PLAYCANVAS_TARGET_SUBDIR: "src"` limits the sync to `game/src`, so nothing else — including
`pcconfig.json` itself — is ever pushed.

### If you ever use VS Code
The official **PlayCanvas** extension does the same sync with no config files (sign in →
"PlayCanvas: Open Project"). Optional — the CLI above is the complete workflow.

---

## Notes & known trade-offs

- **Viewmodel plumbing is code-made.** `game.mjs` always creates the `Viewmodel`
  layer + second camera + gun light. You wouldn't hand-place these, and it keeps Editor
  setup to just Player + Camera. (The layer is also registerable in Settings → Layers if
  you'd rather own it there.)
- **The map is instantiated from the asset in code** (so collision extraction runs on
  the transformed render entity). It won't appear as a placed entity in the viewport
  yet. To make it visually placeable later, drop the GLB into the scene as an entity and
  point the collision extraction at it instead of instantiating in `_onMapReady`.
- **HUD is injected DOM** (`src/ui.mjs`) so it stays in your synced code rather than the
  Editor's launch page. Alternative: rebuild it with PlayCanvas UI (Screen/Element)
  components — that would move HUD layout into the *scene* instead.
- **Scenes aren't in git.** The Editor is the source of truth for the scene and has its
  own branching/checkpoints. Your git repo holds code only.
- **Don't sync `standalone/main.mjs`** — it creates a second `pc.Application`. It lives
  outside `src/` precisely so it never reaches the Editor.
