# Recording gameplay to video — the plan

Status: **plan, nothing built yet** (2026-09-29). Spans this repo and the asset
kit (`../../singularity-development-kit`).

The goal: frame a shot in the fly-over, then from the terminal render a
frame-exact video of what happens there — e.g. the g-man dancing, his `dance`
set off by the recorder — headlessly, at any fps, with the sound mixed on
afterwards.

```
1. In the fly-over:  copy(game.session.view())          → {x,y,z,yaw,pitch}
2. In the terminal:  node tools/record.mjs --view '{…}' --prop g-man-dance \
                       --action dance --fps 30 --out gman.mp4
3. The recorder:     headless Chromium → ?mode=flyover&view=… → s.trigger('dance')
                     → step 1/30 s, capture, repeat until the run ends
                     → frames + event log → ffmpeg → gman.mp4
```

## The one idea: time is a value the world is given

Today the frame timer decides time: `app.on('update', dt)` in `src/main.mjs`
advances everything by the real `dt` (clamped to 0.05). The recorder needs
time it can hand over itself; multiplayer will need shared, timestamped time
("the dance started at T"); a demo replay needs the log's times. All three are
the same change: **one world clock, owned by `main.mjs`, that the loop reads**.
A live client feeds it real time, the recorder feeds it `t₀ + n/fps`, a replay
feeds it a log. Never a second, recorder-only way for time to move.

The recorder is **not a mode**. A mode is a game somebody plays (keys, a body,
a ghost); the recorder is a director outside the world, like the tests. It
lives in `tools/`, drives `window.game`, and is never imported by the world.

## Pavilion

1. **World clock + `game.step(dt)`.** Pull the loop body (session update,
   scripts, actions) out of the `update` handler into one function. Live: the
   handler calls it with the clamped real `dt`, exactly as now. Stepped:
   `game.clock.hold()` stops the engine's own loop; `await game.step(dt)` runs
   the body once, waits for whatever the frame depends on (video seeks, see
   below), and renders. Async from the start.
2. **Start at a given view.** `switchMode(id, from)` takes an optional view,
   and `?view=x,y,z,yaw,pitch` feeds it at boot — so a shared link opens the
   same shot, and the recorder needs nothing else to place the camera.
3. **Event log.** While recording, the runtime reports what it starts instead
   of relying on WebAudio: `{ t, kind: 'sound' | 'video-audio', file, offset,
   pos, volume }` in game time. (A runtime hook — see the kit, step 4.) The
   same log is the future demo file.
4. **`tools/record.mjs`.** Playwright + swiftshader like `tests/_shot.mjs`.
   Opens `?mode=flyover&view=…`, waits for the prop's script (`game.scripted`),
   triggers the action, holds the clock, then loops `step(1/fps)` → capture the
   canvas → until the run ends or `--seconds` is up. Frames go straight to an
   `ffmpeg` pipe (image2pipe), not to disk. Capture: `page.screenshot` clipped
   to the canvas first; canvas `readPixels` if that proves too slow.
5. **The mix.** After capture: each logged sound placed at its `t`
   (`adelay`), volume by distance to the camera with the runtime's own falloff
   (`SOUND_REF`, `SOUND_MAX`, inverse), optional pan from the camera's yaw;
   `amix`; muxed under the frames.
6. **Test.** `tests/record.mjs`: record 1 s of the dancer at 10 fps twice and
   check the frames are byte-identical; check the dancer's pose at frame n
   matches the clip at n/fps.

## Kit

Everything here is shared by the kit's viewer, which runs the same runtime.

1. **Contract: videos ship prepared.** A `videos` index in the manifest, like
   `clips`, keyed by the file a script names — the Script API does not change,
   `object.video('screen.webm', { material })` still names a file:

   ```json
   "videos": [{ "file": "screen.webm", "alt": ["screen.mp4"], "audio": "screen.audio.ogg",
                "fps": 25, "duration": 12.0, "width": 1024, "height": 576, "sha256": "…" }]
   ```

   Rules: every video a manifest lists is in the folder and matches its hash;
   `audio`, when present, is in the folder; the picture has no audio track of
   its own (it is always played muted — its sound is `audio`).
2. **A video build step** (ffmpeg, in pack or its own `npm run video`): from a
   raw source in `source/`, write
   - `*.webm` VP9 — plays in Playwright's bundled Chromium (no H.264 there);
   - `*.mp4` H.264 as `alt`, for browsers weak on WebM;
   - keyframe interval ≤ 1 s, so a stepped seek decodes little;
   - scaled to what the material shows, not the source's size — the upload
     each frame is the video's real cost (see *Frame rate* below);
   - the soundtrack split into `audio`, in the sound bank's format;
   - the manifest entry, measured with ffprobe.
3. **Runtime: video in game time** (`runtime/script.mjs`, then
   `npm run runtime:pull` here). Each video keeps `t += dt` like a clip.
   - Picks the first of `file`/`alt` the browser can play.
   - Live: the element plays muted; drift from `t` is corrected by nudging
     `playbackRate`, and only seeked when it is far off (a seek stalls).
     The `audio` file starts through the same path as `object.sound`, so a
     screen's sound comes from where the screen is.
   - Uploads the texture only when the element has a new frame
     (`requestVideoFrameCallback`), not every game frame as now.
   - Stepped: the element stays paused; each step seeks to `t + ½ frame`
     (mid-frame, so rounding never lands on the frame before) and the step
     awaits `seeked` before the render.
4. **Runtime: a report hook.** The consumer may hand the runtime a
   `report(event)` function; `playSound` and the video audio call it with
   `{ t, kind, file, offset, pos, volume }`. The runtime stays engine-agnostic
   about what is done with it.
5. **Fallback for short loops**, only if seeking proves unreliable: the build
   bakes a frame sheet and the runtime shows `floor(t·fps)` itself, no
   `<video>`. Fine for a 10 s loop on a small screen, too big for a film; an
   option in the manifest entry, not the default.

## Frame rate

The live game pays nothing for the stepped clock: it is a number the loop
reads, and holding it happens only in the recorder. The video work is a net
win live — uploading only on new frames (25/s instead of 60/s) and at the
material's size instead of the source's are the two things that cost frame
rate today. Drift correction by `playbackRate` is free; seeking is reserved
for large drift. The separate audio file is one more sound source.

The recorder itself is slow (swiftshader, a seek and a screenshot per frame),
and that is fine: the output's fps is what `--fps` says, however long each
frame took.

## Order

1. Pavilion: world clock + `step`, `?view=`, `tools/record.mjs` with capture
   only (silent). The dancer can be recorded after this step.
2. Kit: report hook in the runtime; pavilion: the log and the mix. Sound.
3. Kit: `videos` contract, build step, video in game time; pull the runtime.
   Screens record frame-exact.
4. Later: the log written by a live session as a demo file, rendered by the
   recorder.

## Open

- Where built videos live: `scripts/<name>/` is tracked in git, and videos
  are large. Git LFS, or build into the package only (`source/` is the raw).
- Audio format of `audio` — whatever the sound bank settles on.
