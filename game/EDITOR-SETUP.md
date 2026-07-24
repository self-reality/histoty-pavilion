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
3. **ES Modules are automatic — nothing to toggle.** The Editor treats any `.mjs`
   asset as an ESM script (registered on load); every file in `src/` is already `.mjs`,
   so they parse as modules on upload. The only requirement is a **module build of the
   engine**, i.e. Engine v2 — check Settings → Engine shows v2.x (the default for new
   projects). There is no "Scripts format" setting.
4. **Sync the code up** — see [Syncing](#syncing-code-terminal--claude-code) below. After
   the first push, open each new script once in the Editor so it gets parsed.
5. **Build the scene:**
   - Add an entity named `Player` at the origin.
   - Add a child entity `Camera` with a **Camera** component.
   - (Optional) Add a **Directional Light** or two — if you don't, `game.mjs` creates
     its own sun + fill on launch.
6. **Attach the game script:** select `Player`, add a **Script** component, add the
   `game` script. In its attributes:
   - **Map URL (embedded GLB)** → pre-filled with this repo's GitHub Pages URL. This
     is where the textured map comes from (see the note below on why). Leave it as-is.
   - **Map (GLB container)** → optional now; only used as an (untextured) fallback if
     you clear the URL. You can leave it empty.
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

## Editing the world visually (seeing the map in the Editor)

By default the map is fetched from a URL at *launch* and never exists at edit time,
so the viewport looks empty. To author the world visually — see the map and drop
props onto it — put the map into the scene yourself:

1. **Drag `de_dust2.glb` into the scene** (from the Assets panel into the viewport,
   or right-click the container → *Add To Scene*). It appears as an entity.
2. **Set its transform** so it matches the runtime map: **Scale `0.025, 0.025, 0.025`**
   and **Rotation `-90, 0, 0`**. It's now human-scale and you can navigate it.
3. **Assign it to the script:** select `Player` → the `game` script → drag this map
   entity into the **Map (authored in scene)** attribute.
4. **Choose how it renders at launch:**
   - *Keep* **Map URL** filled (default) → the textured URL map renders at runtime and
     this in-scene copy is auto-hidden at launch (they share a transform, so no
     double map). Your placed props stay. Best if the in-scene map looks untextured.
   - *Clear* **Map URL** → the in-scene map itself becomes the runtime map (renders
     with its Editor materials, collision extracted from it). Simplest scene; use it
     if the in-scene map already looks textured.
5. **Drop your asset in:** drag your GLB into the scene, position it against the
   visible map, and launch. Props authored beside the map are just scene entities —
   they render at runtime with no code needed.

> Prefer code placement instead? Position entities in `game.mjs` `_wireWorld()` using
> world coordinates — read a spot's coords from the in-game debug panel (`` ` ``).

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

> **Why the npm scripts set `PLAYCANVAS_USE_CWD_AS_TARGET=1`.** pcsync resolves the target
> folder *before* it reads `pcconfig.json`, so putting that flag in `pcconfig.json` is too
> late — you'd get `Error: could not find target directory: .`. Passing it as an env var
> (baked into the `sync:*` scripts) lands it in time. Consequence: always sync via
> `npm run sync:*` **from the `game/` folder**, not a bare `pcsync` call.

### If you ever use VS Code
The official **PlayCanvas** extension does the same sync with no config files (sign in →
"PlayCanvas: Open Project"). Optional — the CLI above is the complete workflow.

---

## Notes & known trade-offs

- **Viewmodel plumbing is code-made.** `game.mjs` always creates the `Viewmodel`
  layer + second camera + gun light. You wouldn't hand-place these, and it keeps Editor
  setup to just Player + Camera. (The layer is also registerable in Settings → Layers if
  you'd rather own it there.)
- **The map loads from a URL, not the Editor's imported asset.** When you drag a GLB
  into the Editor it splits the materials/textures into separate assets *and strips them
  out of the stored container file* — so instantiating that asset (or re-parsing its
  file URL) renders the map untextured (`defaultGlbMaterial`, no `diffuseMap`). Verified
  the hard way: the original `.glb` parses to 79/79 textured mesh instances, the Editor's
  stored copy to 0. So `game.mjs` loads the **original embedded-texture GLB** from a URL
  (the `mapUrl` attribute) through the engine's own container parser, which keeps all 34
  textures. `mapUrl` defaults to this repo's **GitHub Pages** deploy
  (`self-reality.github.io/histoty-pavilion/assets/de_dust2.glb`), which serves the
  unprocessed file with `Access-Control-Allow-Origin: *` so the Editor launch (a
  different origin) can fetch it. **Consequence:** the Pages deploy must stay live and
  the repo public for the Editor build to be textured; if you change the map, push so
  Pages redeploys (or point `mapUrl` at any host that serves the raw `.glb` with CORS).
  By default the map isn't a placed entity in the viewport — collision extraction runs on
  the instantiated render entity in `_onMapReady`. To edit the world visually, place the
  map in the scene and assign it to **Map (authored in scene)** — see
  [Editing the world visually](#editing-the-world-visually-seeing-the-map-in-the-editor).
- **HUD is injected DOM** (`src/ui.mjs`) so it stays in your synced code rather than the
  Editor's launch page. Alternative: rebuild it with PlayCanvas UI (Screen/Element)
  components — that would move HUD layout into the *scene* instead.
- **Scenes aren't in git.** The Editor is the source of truth for the scene and has its
  own branching/checkpoints. Your git repo holds code only.
- **Don't sync `standalone/main.mjs`** — it creates a second `pc.Application`. It lives
  outside `src/` precisely so it never reaches the Editor.
