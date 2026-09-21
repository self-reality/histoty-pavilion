// An action area drawn in Blender is the same volume in the game — for every
// shape, across the axis conversion — and survives the rebuild round trip.
//
//   node tests/areas.mjs          # needs Blender; no server, no browser
//
// tests/actions.mjs covers what the game does with an area. This covers the
// half that test cannot see: that a cube somebody scaled and turned in the
// viewport, a sphere they squashed, a corner they dragged in Edit Mode and a
// Bevel they never applied all come out of tools/export_scene.py enclosing the
// space they enclosed on screen. Blender is Z-up and the game is Y-up, a mesh
// area ships vertices as well as a transform, and a sign error in either is a
// volume that is somewhere else and looks fine in both programs.
//
//   fixtures/areas_scene.py -> a.blend -> export -> a.json      what is asked here
//   a.json -> build_blend.py -> b.blend -> export -> b.json     must equal a.json
//
// Skips, rather than fails, where there is no Blender — the same terms the
// kit's golden test runs on. Nothing here touches scene/pavilion.blend.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!existsSync(BLENDER)) {
  console.log(`SKIP — no Blender at ${BLENDER} (set BLENDER=/path/to/blender)`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'pavilion-areas-'));
const at = (f) => join(tmp, f);
const blender = (...args) => execFileSync(BLENDER, ['-b', ...args], { cwd: GAME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const exportLines = (out) => out.split('\n').filter((l) => l.startsWith('[export]'));

let first, second, a, b;
try {
  blender('-P', 'tests/fixtures/areas_scene.py', '--', at('a.blend'));
  first = exportLines(blender(at('a.blend'), '-P', 'tools/export_scene.py', '--', '--out', at('a.json')));
  a = JSON.parse(readFileSync(at('a.json'), 'utf8'));
  // The real rebuild, map and all, from the layout just written.
  blender('-P', 'tools/build_blend.py', '--', '--out', at('b.blend'), '--placements', at('a.json'));
  second = exportLines(blender(at('b.blend'), '-P', 'tools/export_scene.py', '--', '--out', at('b.json')));
  b = JSON.parse(readFileSync(at('b.json'), 'utf8'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const { collectAreas } = await import('../src/areas.mjs');
const warned = [];
const warn = console.warn;
console.warn = (...m) => warned.push(m.join(' '));
const areas = Object.fromEntries(collectAreas(a.areas).map((area) => [area.name, area]));
console.warn = warn;

const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };

// ---- What the exporter made of each mesh ------------------------------------
const entry = Object.fromEntries(a.areas.map((e) => [e.name, e]));
const shapes = Object.fromEntries(a.areas.map((e) => [e.name, e.shape]));
console.log('exported:', a.areas.map((e) => `${e.name} (${e.shape}${e.tris ? `, ${e.tris.length / 3} tris` : ''}) -> ${e.target}`).join('\n          '));
want(JSON.stringify(shapes) === JSON.stringify({
  act_L: 'mesh', act_bubble: 'sphere', 'act_g-man-dance_01': 'box', 'act_g-man-dance_01.001': 'cylinder',
  act_nobody: 'mesh', act_pulled: 'mesh', act_soft: 'mesh',
}), `shapes: ${JSON.stringify(shapes)}`);
want(entry['act_g-man-dance_01'].verts === undefined && entry.act_bubble.verts === undefined,
  'a primitive shipped its vertices — only its transform should');
want(entry['act_g-man-dance_01.001'].sides === 24, `cylinder sides: ${entry['act_g-man-dance_01.001'].sides}`);
want(entry['act_g-man-dance_01.001'].target === 'g-man-dance_01', 'a Shift-D duplicate lost its target to the .001');
want(entry.act_bubble.target === 'g-man-dance_01' && entry.act_bubble.action === 'dance', '`target`/`action` custom properties did not ship');
want(entry.act_bubble.extras === undefined, `target/action leaked into extras: ${JSON.stringify(entry.act_bubble.extras)}`);
want(entry.act_soft.tris.length / 3 > 12, 'the Bevel modifier did not ship: act_soft is still a bare cube');
want(!entry.act_stray, 'a mesh outside ACT was exported as an area');

const said = (re) => first.some((l) => /WARNING/.test(l) && re.test(l));
want(said(/act_nobody.*not closed/), 'an open mesh went unreported');
want(said(/act_nobody.*no prop in the layout/), 'an area aimed at no prop went unreported');
want(said(/act_stray.*not in the "ACT" collection/), 'a misfiled area went unreported');
want(first.filter((l) => /WARNING/.test(l)).length === 3, `expected exactly 3 warnings:\n  ${first.filter((l) => /WARNING/.test(l)).join('\n  ')}`);

// ---- The same volume in the game ---------------------------------------------
// Points are given where a person would read them off Blender's N-panel, and
// converted here the way tools/pc_axes.py says: Blender (x, y, z) is the
// game's (x, z, -y). Independent of the exporter on purpose.
const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
const cases = [
  ['act_L', [11, 11, 1], true, 'in the foot of the L'],
  ['act_L', [13, 11, 1], true, 'in its long arm'],
  ['act_L', [13, 14, 1], false, 'in the notch — the concave part'],
  ['act_L', [11, 11, 2.6], false, 'above its ceiling'],
  ['act_g-man-dance_01', [3 + 1.9 * c30, 2 + 1.9 * s30, 1], true, '1.9 m along the turned box'],
  ['act_g-man-dance_01', [3, 2 + 1.9, 1], false, '1.9 m along where it would be if it were not turned'],
  ['act_g-man-dance_01.001', [8 + 2.9, 2, 1], true, 'inside the 3 m cylinder'],
  ['act_g-man-dance_01.001', [8, 2, 2.1], false, 'above the cylinder — it must stand up, not lie down'],
  ['act_bubble', [-4 + 1.9, 0, 1], true, 'inside the ellipsoid along a wide axis'],
  ['act_bubble', [-4, 0, 1 + 1.3], false, 'above its squashed top'],
  ['act_pulled', [0.95 + 0.5, -6 + 0.9, 1 + 0.9], true, 'in the corner that was dragged out'],
  ['act_pulled', [0.95 + 0.5, -6 - 0.9, 1 - 0.9], false, 'as far off the corner that was not'],
  ['act_soft', [-8 + 0.97, 8 + 0.97, 1 + 0.97], false, 'in the corner the bevel took off'],
  ['act_soft', [-8 + 0.8, 8 + 0.8, 1 + 0.8], true, 'just inside the bevel'],
];
for (const [name, [x, y, z], inside, what] of cases) {
  const area = areas[name];
  if (!area) { problems.push(`${name} did not load in the game`); continue; }
  const got = area.contains(x, z, -y);
  console.log(`  ${got === inside ? 'ok  ' : 'FAIL'} ${name}: ${what} -> ${got ? 'inside' : 'outside'}`);
  want(got === inside, `${name}: ${what} came out ${got ? 'inside' : 'outside'}`);
}

// ---- Rebuild, re-export: nothing moves ----------------------------------------
want(JSON.stringify(a.areas) === JSON.stringify(b.areas), `areas changed across build -> export:\n${
  a.areas.map((e, i) => (JSON.stringify(e) === JSON.stringify(b.areas[i]) ? null : `  ${e.name}`)).filter(Boolean).join('\n')}`);
want(second.some((l) => /7 areas/.test(l)), `the rebuilt .blend exported: ${second.at(-1)}`);

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nOK — every shape means in the game what it meant in Blender, and the round trip is a no-op');
