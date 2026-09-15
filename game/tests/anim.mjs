// An animated asset does what its script says: the clip ticks, the head skin
// follows the spine, the pelvis walks, and the prop never joins the collider.
//
//   node tests/anim.mjs        # needs `npm start` running on :5173
//
// The asset is placed from the test through the same loadProp the layout goes
// through, so this checks the runtime without depending on where — or whether
// — the .blend has put a dancer today. A second, scriptless copy of the same
// object stands beside it as the bind-pose reference the measurements are
// read against.
import { chromium } from 'playwright';

const ASSET = './assets/g-man-dance/g-man-dance';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errs = [];
const logs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (/g-man-dance_/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 60000 });

const r = await page.evaluate(async (ASSET) => {
  const g = window.game;
  const { matchNodes } = await import('/src/rig.mjs');
  const s0 = g.player.spawn;
  const place = (name, script) => g.loadProp({
    name, glb: `${ASSET}.glb`, ...(script ? { script: `${ASSET}.script.json` } : { solid: false }),
    pos: [s0.x + 3, s0.y, s0.z], rot: [0, 0, 0, 1], scale: [0.02978, 0.02978, 0.02978],
  });
  place('g-man-dance_test', true);
  place('g-man-dance_ref', false);
  const until = (f, ms = 60000) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      if (f()) return res();
      if (Date.now() - t0 > ms) return rej(new Error('timed out waiting for the props'));
      setTimeout(poll, 100);
    })();
  });
  await until(() => g.app.root.findByName('g-man-dance_ref') && g.scripted.some((s) => s.label === 'g-man-dance_test'));

  const root = g.app.root.findByName('g-man-dance_test');
  const ref = g.app.root.findByName('g-man-dance_ref');
  const s = g.scripted.find((x) => x.label === 'g-man-dance_test');
  const depth = (n) => { let d = 0; for (let p = n.parent; p; p = p.parent) d++; return d; };
  const shallowest = (list) => list.reduce((a, b) => (!a || depth(b) < depth(a) ? b : a), null);
  const find = (r, pattern) => shallowest(matchNodes(r, pattern));
  const nodes = (r) => ({
    thigh: find(r, 'ValveBiped.Bip01_L_Thigh*'),
    spine4: find(r, 'ValveBiped.Bip01_Spine4*'),
    pelvis: find(r, 'ValveBiped.Bip01_Pelvis*'),
    head: find(r, 'gman_high_ARM.001'),
  });
  const t = nodes(root);
  const b = nodes(ref);
  ref.syncHierarchy();
  root.syncHierarchy();

  // 1) Structure: what the script asked for happened.
  const attached = s.attached.map((a) => `${a.node} -> ${a.to}`);
  const headParent = t.head.parent.name;

  // 2) The head skin rides the spine rigidly: its distance to Spine4 is the
  //    bind distance (the reparent did not move it) and stays so as the
  //    torso bends (it is attached, not left behind).
  const dist = (n) => n.head.getPosition().distance(n.spine4.getPosition());
  const bindDist = dist(b);
  const distAt0 = dist(t);
  const snap = () => ({
    time: s.player.time,
    thigh: t.thigh.getLocalRotation().clone(),
    pelvis: t.pelvis.getLocalPosition().clone(),
    headDist: dist(t),
  });
  const a0 = snap();
  // Drive the clip by hand: deterministic, no frame pacing.
  for (let i = 0; i < 90; i++) s.update(1 / 30);          // 3 s in
  root.syncHierarchy();
  const a1 = snap();
  const angle = (p, q) => {
    const d = Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w);
    return Math.acos(Math.min(1, d)) * 2 * 180 / Math.PI;
  };

  // 3) Collision: nothing in the collider is tagged with the dancer's name.
  const solidTris = g.collider.tris.filter((tri) => tri.prop === 'g-man-dance_test').length;

  // 4) Looping/holding as the script says, past the end of the clip.
  const before = s.player.loop;
  for (let i = 0; i < 30 * 30; i++) s.update(1 / 30);      // 30 s more, past 22.6 s
  const timeAfter = s.player.time;

  return {
    warnings: s.warnings,
    played: s.player.name,
    duration: s.player.duration,
    loop: before,
    nodes: s.player.count,
    missing: s.player.missing,
    rootMotion: !!s.player.root,
    attached,
    headParent,
    bindDist, distAt0, distAt3: a1.headDist,
    time0: a0.time, time3: a1.time,
    thighTurned: angle(a0.thigh, a1.thigh),
    pelvisMoved: a0.pelvis.distance(a1.pelvis),
    solidTris,
    timeAfter,
  };
}, ASSET);

await browser.close();

console.log(JSON.stringify(r, null, 2));
for (const l of logs) console.log('  ' + l);

const problems = [];
if (errs.length) problems.push(`page errors: ${errs.join(' | ')}`);
if (r.warnings.length) problems.push(`script warnings: ${r.warnings.join(' | ')}`);
if (r.played !== 'keep_it_gangsta_3') problems.push(`played ${r.played}`);
if (r.missing.length) problems.push(`unmatched patterns: ${r.missing.join(', ')}`);
if (r.nodes < 13) problems.push(`only ${r.nodes} nodes driven`);
if (!r.rootMotion) problems.push('no root motion track');
if (r.attached.join() !== 'gman_high_ARM.001 -> ValveBiped.Bip01_Spine4_gman_high_ARM') problems.push(`attached: ${r.attached.join()}`);
if (r.headParent !== 'ValveBiped.Bip01_Spine4_gman_high_ARM') problems.push(`head armature under ${r.headParent}`);
const tol = r.bindDist * 0.01;
if (Math.abs(r.distAt0 - r.bindDist) > tol) problems.push(`reparent moved the head: ${r.distAt0} vs bind ${r.bindDist}`);
if (Math.abs(r.distAt3 - r.bindDist) > tol) problems.push(`head left behind by the spine: ${r.distAt3} vs bind ${r.bindDist}`);
// Relative to the first snapshot: the engine's own loop may already have ticked a frame.
if (Math.abs((r.time3 - r.time0) - 3) > 1e-3) problems.push(`clock advanced ${r.time3 - r.time0} s over 3 s of ticks`);
if (r.thighTurned < 1) problems.push(`thigh turned only ${r.thighTurned}° in 3 s`);
if (r.pelvisMoved <= 0) problems.push('pelvis never moved (walk mode)');
if (r.solidTris) problems.push(`${r.solidTris} collision triangles from a solid: false asset`);
if (r.loop ? r.timeAfter >= r.duration : Math.abs(r.timeAfter - r.duration) > 1e-3) {
  problems.push(`after the clip ended the clock reads ${r.timeAfter} (loop: ${r.loop}, duration ${r.duration})`);
}

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nOK — the dancer plays, the head follows the spine, nothing collides');
