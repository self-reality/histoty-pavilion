// A cutter drawn in Blender is the same volume in the game — for every shape,
// across the axis conversion — and survives the rebuild round trip.
//
//   node tests/cutters.mjs        # needs Blender; no server, no browser
//
// tests/negatives.mjs covers what the game does with a cutter. This covers the
// half that test cannot see: that a cube somebody scaled and turned in the
// viewport, a corner they dragged in Edit Mode, an L they extruded and a Bevel
// they never applied all come out of tools/export_scene.py enclosing the space
// they enclosed on screen. Blender is Z-up and the game is Y-up, a mesh cutter
// ships vertices as well as a transform, and a sign error in either is a hole
// somewhere else that looks fine in both programs.
//
//   fixtures/cutters_scene.py -> a.blend -> export -> a.json    what is asked here
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

const tmp = mkdtempSync(join(tmpdir(), 'pavilion-cutters-'));
const at = (f) => join(tmp, f);
const blender = (...args) => execFileSync(BLENDER, ['-b', ...args], { cwd: GAME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const exportLines = (out) => out.split('\n').filter((l) => l.startsWith('[export]'));

let first, second, a, b;
try {
  blender('-P', 'tests/fixtures/cutters_scene.py', '--', at('a.blend'));
  first = exportLines(blender(at('a.blend'), '-P', 'tools/export_scene.py', '--', '--out', at('a.json')));
  a = JSON.parse(readFileSync(at('a.json'), 'utf8'));
  // The real rebuild, map and all, from the layout just written.
  blender('-P', 'tools/build_blend.py', '--', '--out', at('b.blend'), '--placements', at('a.json'));
  second = exportLines(blender(at('b.blend'), '-P', 'tools/export_scene.py', '--', '--out', at('b.json')));
  b = JSON.parse(readFileSync(at('b.json'), 'utf8'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const { collectVolumes, carve } = await import('../src/negatives.mjs');
const { Vec3 } = await import('playcanvas');
const warned = [];
const warn = console.warn;
console.warn = (...m) => warned.push(m.join(' '));
const cutters = Object.fromEntries(collectVolumes(a.negatives).map((v) => [v.name, v]));
console.warn = warn;

const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };

// ---- What the exporter made of each mesh ------------------------------------
const entry = Object.fromEntries(a.negatives.map((e) => [e.name, e]));
const shapes = Object.fromEntries(a.negatives.map((e) => [e.name, e.shape]));
console.log('exported:', a.negatives.map((e) => `${e.name} (${e.shape}${e.tris ? `, ${e.tris.length / 3} tris` : ''})`).join('\n          '));
want(JSON.stringify(shapes) === JSON.stringify({
  neg_L: 'mesh', neg_open: 'mesh', neg_plain: 'box', neg_pulled: 'mesh', neg_soft: 'mesh', neg_turned: 'box',
}), `shapes: ${JSON.stringify(shapes)}`);
want(entry.neg_plain.verts === undefined && entry.neg_turned.verts === undefined, 'a primitive shipped its vertices — only its transform should');
want(entry.neg_L.tris.length / 3 === 20, `neg_L: ${entry.neg_L.tris.length / 3} triangles, want 20`);
want(entry.neg_soft.tris.length / 3 > 12, 'the Bevel modifier did not ship: neg_soft is still a bare cube');
want(!entry.neg_stray, 'a mesh outside NEG was exported as a cutter');

const said = (re) => first.some((l) => /WARNING/.test(l) && re.test(l));
want(said(/neg_open.*not closed/), 'an open mesh went unreported');
want(said(/neg_stray.*not in the "NEG" collection/), 'a misfiled cutter went unreported');
want(first.filter((l) => /WARNING/.test(l)).length === 2, `expected exactly 2 warnings:\n  ${first.filter((l) => /WARNING/.test(l)).join('\n  ')}`);

// ---- The same volume in the game ---------------------------------------------
// A point is inside a cutter if a 2 cm triangle laid at it is cut away whole.
// Points are given where a person would read them off Blender's N-panel, and
// converted here the way tools/pc_axes.py says: Blender (x, y, z) is the
// game's (x, z, -y). Independent of the exporter on purpose.
const V = (x, y, z) => new Vec3(x, y, z);
const tri = (p, q, r) => ({ a: p, b: q, c: r, n: new Vec3(0, 1, 0) });
const area = (ts) => ts.reduce((s, t) => s + 0.5 * new Vec3().cross(new Vec3().sub2(t.b, t.a), new Vec3().sub2(t.c, t.a)).length(), 0);
const inside = (v, [x, y, z]) => {
  const [gx, gy, gz] = [x, z, -y];
  return carve([tri(V(gx - 0.01, gy, gz - 0.01), V(gx + 0.01, gy, gz - 0.01), V(gx, gy, gz + 0.01))], [v]).length === 0;
};
const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
const cases = [
  ['neg_L', [31, 31, 1], true, 'in the foot of the L'],
  ['neg_L', [33, 31, 1], true, 'in its long arm'],
  ['neg_L', [33, 34, 1], false, 'in the notch — the concave part'],
  ['neg_L', [31, 31, 2.6], false, 'above its top'],
  ['neg_plain', [-21.4, 30, 1], true, 'along the box'],
  ['neg_plain', [-20, 30.6, 1], false, 'past its narrow side'],
  ['neg_plain', [-20, 30, 2.1], false, 'above it'],
  ['neg_turned', [-30 + 1.9 * c30, 30 + 1.9 * s30, 1], true, '1.9 m along the turned box'],
  ['neg_turned', [-30 + 1.9, 30, 1], false, '1.9 m along where it would be if it were not turned'],
  ['neg_pulled', [-20 + 1.45, -30 + 0.9, 1 + 0.9], true, 'in the corner that was dragged out'],
  ['neg_pulled', [-20 + 1.45, -30 - 0.9, 1 - 0.9], false, 'as far off the corner that was not'],
  ['neg_soft', [-20 + 0.97, -10 + 0.97, 1 + 0.97], false, 'in the corner the bevel took off'],
  ['neg_soft', [-20 + 0.8, -10 + 0.8, 1 + 0.8], true, 'just inside the bevel'],
];
for (const [name, point, isIn, what] of cases) {
  const v = cutters[name];
  if (!v) { problems.push(`${name} did not load in the game`); continue; }
  const got = inside(v, point);
  console.log(`  ${got === isIn ? 'ok  ' : 'FAIL'} ${name}: ${what} -> ${got ? 'inside' : 'outside'}`);
  want(got === isIn, `${name}: ${what} came out ${got ? 'inside' : 'outside'}`);
}
{
  // What a cutter removes from a floor laid through it is its footprint: the L
  // is 4 x 5 with a 2 x 3 corner out — 14 m2 — and none of it from the notch.
  const floor = [tri(V(20, 1, -45), V(45, 1, -45), V(45, 1, -20)), tri(V(20, 1, -45), V(45, 1, -20), V(20, 1, -20))];
  const removed = area(floor) - area(carve(floor, [cutters.neg_L]));
  console.log(`  neg_L took ${removed.toFixed(4)} m2 out of a floor laid through it (its footprint is 14)`);
  want(Math.abs(removed - 14) < 1e-3, `neg_L removed ${removed} m2, want its 14 m2 footprint`);
  const notch = [tri(V(32.6, 1, -34.4), V(33.4, 1, -34.4), V(33, 1, -33.6))];
  want(carve(notch, [cutters.neg_L])[0] === notch[0], 'neg_L cut the floor inside its own notch');
}

// ---- Rebuild, re-export: nothing moves ----------------------------------------
want(JSON.stringify(a.negatives) === JSON.stringify(b.negatives), `cutters changed across build -> export:\n${
  a.negatives.map((e, i) => (JSON.stringify(e) === JSON.stringify(b.negatives[i]) ? null : `  ${e.name}`)).filter(Boolean).join('\n')}`);
want(second.some((l) => /6 negatives/.test(l)), `the rebuilt .blend exported: ${second.at(-1)}`);

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nOK — every shape of cutter means in the game what it meant in Blender, and the round trip is a no-op');
