// HUD injection for the PlayCanvas Editor build.
//
// The standalone build gets its HUD markup + CSS straight from index.html. In an
// Editor project you don't own the launch page, so the same HUD is created here
// from code and kept in your synced repo. injectUI() is idempotent and returns a
// teardown() so Editor hot-reloads (re-parsing the script) don't stack duplicate
// overlays or event state.
//
// Returns { ui, hud, teardown }:
//   ui   — element handles matching what game.mjs / the standalone build expect
//   hud  — { mag, reserve, reloading, hit() } consumed by Weapon
//   teardown() — removes the injected DOM + <style>

const ROOT_ID = 'pc-fps-ui';
const STYLE_ID = 'pc-fps-ui-style';

const CSS = `
:root { --accent: #ffcf5a; }
#${ROOT_ID} .hidden { display: none !important; }

#${ROOT_ID} #crosshair {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 24px; height: 24px; pointer-events: none; opacity: 0.9; display: none; z-index: 10;
}
#${ROOT_ID} #crosshair::before, #${ROOT_ID} #crosshair::after {
  content: ""; position: absolute; background: rgba(255,255,255,0.85); box-shadow: 0 0 2px rgba(0,0,0,0.8);
}
#${ROOT_ID} #crosshair::before { left: 50%; top: 0; width: 2px; height: 100%; transform: translateX(-50%); }
#${ROOT_ID} #crosshair::after { top: 50%; left: 0; height: 2px; width: 100%; transform: translateY(-50%); }
#${ROOT_ID} #dot {
  position: fixed; left: 50%; top: 50%; width: 4px; height: 4px; border-radius: 50%;
  background: var(--accent); transform: translate(-50%,-50%); pointer-events: none; display: none; z-index: 11;
  box-shadow: 0 0 3px rgba(0,0,0,0.9);
}

#${ROOT_ID} #hud { position: fixed; inset: 0; pointer-events: none; z-index: 9; display: none;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: #eee; }
#${ROOT_ID} #ammo { position: fixed; right: 32px; bottom: 24px; text-align: right; text-shadow: 0 2px 6px rgba(0,0,0,0.8); }
#${ROOT_ID} #ammo .count { font-size: 44px; font-weight: 700; letter-spacing: 1px; }
#${ROOT_ID} #ammo .count .reserve { font-size: 22px; opacity: 0.6; font-weight: 500; }
#${ROOT_ID} #ammo .name { font-size: 13px; letter-spacing: 3px; opacity: 0.7; text-transform: uppercase; }
#${ROOT_ID} #score { position: fixed; left: 32px; bottom: 24px; font-size: 14px; letter-spacing: 1px;
  text-shadow: 0 2px 6px rgba(0,0,0,0.8); font-family: "Segoe UI", system-ui, sans-serif; color: #eee; }
#${ROOT_ID} #score b { color: var(--accent); font-size: 22px; }
#${ROOT_ID} #reloading { position: fixed; left: 50%; top: 58%; transform: translateX(-50%);
  font-size: 14px; letter-spacing: 3px; color: var(--accent); text-transform: uppercase;
  text-shadow: 0 2px 6px rgba(0,0,0,0.8); display: none; }
#${ROOT_ID} #hitmarker { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%) rotate(45deg);
  width: 18px; height: 18px; pointer-events: none; opacity: 0; z-index: 12; }
#${ROOT_ID} #hitmarker::before, #${ROOT_ID} #hitmarker::after { content:""; position:absolute; background:#fff; }
#${ROOT_ID} #hitmarker::before { left: 50%; top: 0; width: 2px; height: 100%; transform: translateX(-50%); }
#${ROOT_ID} #hitmarker::after { top: 50%; left: 0; height: 2px; width: 100%; transform: translateY(-50%); }

#${ROOT_ID} #overlay { position: fixed; inset: 0; z-index: 20; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center;
  background: radial-gradient(ellipse at center, rgba(12,14,18,0.72), rgba(8,9,12,0.94));
  backdrop-filter: blur(2px); font-family: "Segoe UI", system-ui, sans-serif; color: #eee; }
#${ROOT_ID} #overlay h1 { font-size: 52px; font-weight: 800; letter-spacing: 2px; margin-bottom: 6px;
  background: linear-gradient(180deg, #fff 0%, var(--accent) 120%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
#${ROOT_ID} #overlay .sub { opacity: 0.7; font-size: 15px; letter-spacing: 4px; text-transform: uppercase; margin-bottom: 36px; }
#${ROOT_ID} #overlay .play { pointer-events: auto; cursor: pointer; border: none; border-radius: 8px;
  padding: 16px 44px; font-size: 18px; font-weight: 700; letter-spacing: 1px;
  color: #1a140a; background: var(--accent); box-shadow: 0 10px 30px rgba(255,207,90,0.25);
  transition: transform 0.08s ease, box-shadow 0.2s ease; }
#${ROOT_ID} #overlay .play:hover { transform: translateY(-2px); box-shadow: 0 14px 36px rgba(255,207,90,0.4); }
#${ROOT_ID} #overlay .controls { margin-top: 40px; display: grid; grid-template-columns: auto auto; gap: 8px 18px; font-size: 14px; opacity: 0.8; }
#${ROOT_ID} #overlay .controls .k { justify-self: end; font-family: ui-monospace, monospace; background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15); border-radius: 5px; padding: 2px 9px; font-size: 12px; }
#${ROOT_ID} #overlay .controls .d { justify-self: start; }
#${ROOT_ID} #loading { margin-top: 28px; font-size: 13px; letter-spacing: 2px; opacity: 0.6; }

#${ROOT_ID} #debugPanel { position: fixed; top: 12px; right: 12px; width: 236px; z-index: 30;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: #dfe3e8;
  background: rgba(14, 17, 22, 0.86); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  backdrop-filter: blur(6px); box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  max-height: calc(100vh - 24px); overflow-y: auto; user-select: none; }
#${ROOT_ID} #debugPanel.dbg-hidden { display: none; }
#${ROOT_ID} .dbg-head { display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.1);
  position: sticky; top: 0; background: rgba(14,17,22,0.95); }
#${ROOT_ID} .dbg-title { letter-spacing: 3px; font-weight: 700; color: var(--accent); font-size: 11px; }
#${ROOT_ID} .dbg-x { background: none; border: none; color: #aab; font-size: 16px; line-height: 1; cursor: pointer; padding: 0 4px; }
#${ROOT_ID} .dbg-body { padding: 10px 12px 14px; }
#${ROOT_ID} .dbg-body.dbg-hidden { display: none; }
#${ROOT_ID} .dbg-sec { margin: 12px 0 6px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #8b93a0; }
#${ROOT_ID} .dbg-stats { display: grid; grid-template-columns: 1fr; gap: 3px; }
#${ROOT_ID} .dbg-stat { display: flex; justify-content: space-between; }
#${ROOT_ID} .dbg-k { color: #8b93a0; }
#${ROOT_ID} .dbg-v { color: #eaeef3; }
#${ROOT_ID} .dbg-seg { display: flex; gap: 4px; }
#${ROOT_ID} .dbg-segbtn { flex: 1; padding: 5px 0; font: inherit; font-size: 11px; cursor: pointer;
  color: #cdd3da; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; }
#${ROOT_ID} .dbg-segbtn.on { background: var(--accent); color: #1a140a; border-color: var(--accent); font-weight: 700; }
#${ROOT_ID} .dbg-slider { margin: 7px 0; }
#${ROOT_ID} .dbg-slabel { display: flex; justify-content: space-between; margin-bottom: 2px; color: #b9c0c9; }
#${ROOT_ID} .dbg-sval { color: var(--accent); }
#${ROOT_ID} .dbg-slider input[type=range] { width: 100%; accent-color: var(--accent); }
#${ROOT_ID} .dbg-row { display: flex; gap: 6px; margin: 6px 0; }
#${ROOT_ID} .dbg-btn { flex: 1; padding: 7px 6px; font: inherit; font-size: 11px; cursor: pointer;
  color: #eaeef3; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; }
#${ROOT_ID} .dbg-btn:hover { background: rgba(255,255,255,0.16); }
`;

const HTML = `
<div id="crosshair"></div>
<div id="dot"></div>
<div id="hitmarker"></div>
<div id="hud">
  <div id="score">SCORE <b id="scoreVal">0</b></div>
  <div id="reloading">Reloading…</div>
  <div id="ammo">
    <div class="count"><span id="mag">30</span><span class="reserve"> / <span id="reserve">90</span></span></div>
    <div class="name">AK · de_dust2</div>
  </div>
</div>
<div id="debugPanel" class="dbg-hidden"></div>
<div id="overlay">
  <h1>DE_DUST2</h1>
  <div class="sub">PlayCanvas · First-Person Shooter</div>
  <button class="play" id="playBtn" disabled>Loading…</button>
  <div class="controls">
    <span class="k">W A S D</span><span class="d">Move</span>
    <span class="k">Mouse</span><span class="d">Look</span>
    <span class="k">L-Click</span><span class="d">Shoot</span>
    <span class="k">Shift</span><span class="d">Sprint</span>
    <span class="k">Space</span><span class="d">Jump</span>
    <span class="k">R</span><span class="d">Reload</span>
    <span class="k">T</span><span class="d">Teleport to new spawn</span>
    <span class="k">\`</span><span class="d">Debug panel</span>
    <span class="k">V</span><span class="d">Cycle view (textured / wire / normals)</span>
    <span class="k">Esc</span><span class="d">Release mouse</span>
  </div>
  <div id="loading">Preparing map…</div>
</div>
`;

export function injectUI() {
  // Idempotent: clear any prior injection (hot-reload) before rebuilding.
  teardownUI();

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = HTML;
  document.body.appendChild(root);

  const $ = (id) => root.querySelector('#' + id);
  const ui = {
    root,
    overlay: $('overlay'),
    playBtn: $('playBtn'),
    loading: $('loading'),
    crosshair: $('crosshair'),
    dot: $('dot'),
    hud: $('hud'),
    hitmarker: $('hitmarker'),
    scoreVal: $('scoreVal'),
  };

  let hitmarkerTimer = 0;
  const hud = {
    mag: $('mag'),
    reserve: $('reserve'),
    reloading: $('reloading'),
    hit() { ui.hitmarker.style.opacity = 1; hitmarkerTimer = 0.12; },
    // Called each frame from the game loop to fade the hitmarker out.
    tick(dt) {
      if (hitmarkerTimer > 0) {
        hitmarkerTimer -= dt;
        if (hitmarkerTimer <= 0) ui.hitmarker.style.opacity = 0;
      }
    },
  };

  return { ui, hud, teardown: teardownUI };
}

export function teardownUI() {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}
