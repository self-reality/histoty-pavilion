// The volumes a prop CARRIES, on the Blender side — and a prop that moved house.
//
//   node tests/carried.mjs        # needs Blender; no server, no browser
//
// tests/package.mjs covers what the game does with a packaged asset. This is
// the level editor's half of the same promise — "select the object, move it,
// and everything it brought moves with it" — which comes down to three things
// the tools must do and one they must not:
//
//   - a rebuilt .blend shows a prop's `_neg` and `_act` meshes under its anchor,
//     as cages, and previews the hole a carried `_neg` will cut exactly as it
//     previews a cutter drawn in the level
//   - the export writes NONE of them: they are the asset's, the game reads them
//     from the asset's manifest, and a second copy in the layout would be a hole
//     that stays behind when the prop is moved
//   - an anchor still naming `assets/x.glb` after the asset became the package
//     `assets/x/x.glb` follows it there, and picks up the manifest beside it
//   - an anchor naming a file that is simply gone says so
//
// Skips without Blender. Never touches scene/pavilion.blend.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!existsSync(BLENDER)) {
  console.log(`SKIP — no Blender at ${BLENDER} (set BLENDER=/path/to/blender)`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'pavilion-carried-'));
const at = (f) => join(tmp, f);
const blender = (...args) => execFileSync(BLENDER, ['-b', ...args], { cwd: GAME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };

// What the rebuilt .blend holds, asked of Blender itself.
const PEEK = `
import bpy, json
out = {}
for o in bpy.data.objects:
    if o.name.startswith('well'):
        out[o.name] = {'parent': o.parent.name if o.parent else None, 'display': o.display_type,
                       'color': [round(c, 2) for c in o.color], 'selectable': not o.hide_select}
ref = bpy.data.collections.get('REF')
out['_booleans'] = sorted({m.name for o in ref.objects for m in o.modifiers if m.name.startswith('NEG_')})
print('PEEK' + json.dumps(out))
`;

try {
  // ---- 1) a prop that carries volumes, through the real rebuild and export ------
  const fixture = join(GAME, 'tests/fixtures/package.placements.json');
  const built = blender('-P', 'tools/build_blend.py', '--', '--out', at('carried.blend'), '--placements', fixture);
  writeFileSync(at('peek.py'), PEEK);
  const peek = JSON.parse(blender(at('carried.blend'), '-P', at('peek.py')).split('\n').find((l) => l.startsWith('PEEK')).slice(4));
  console.log(JSON.stringify(peek, null, 1));
  for (const name of ['well_neg', 'well_neg.001', 'well_act']) {
    want(peek[name], `${name} is not in the rebuilt .blend`);
    want(peek[name]?.display === 'WIRE', `${name} is drawn ${peek[name]?.display}, not as a cage — it hides the prop it belongs to`);
    want(peek[name]?.selectable === false, `${name} can be selected and moved on its own, away from its prop`);
    let top = name;
    while (peek[top]?.parent) top = peek[top].parent;
    want(top === 'well_01', `${name} hangs under ${top}, not under the prop's anchor — it would not move with the prop`);
  }
  want(peek.well_neg?.color[0] > 0.9 && peek.well_act?.color[1] > 0.9, 'a carried cutter is not red, or a carried area not green');
  want(peek.well?.display !== 'WIRE', 'the visible kerb was turned into a cage too');
  want(peek._booleans.includes('NEG_well_neg') && peek._booleans.includes('NEG_well_neg.001'),
    `the hole a carried cutter will cut is not previewed on the map: ${peek._booleans}`);
  want(/2 carried by props/.test(built), 'the build did not report the carried cutters');

  const exported = blender(at('carried.blend'), '-P', 'tools/export_scene.py', '--', '--out', at('carried.json'));
  const layout = JSON.parse(readFileSync(at('carried.json'), 'utf8'));
  const asked = JSON.parse(readFileSync(fixture, 'utf8'));
  want(layout.negatives.length === 0 && layout.areas === undefined,
    `the export wrote the prop's own volumes into the layout: ${layout.negatives.length} negatives, ${layout.areas?.length ?? 0} areas`);
  want(JSON.stringify(layout.props) === JSON.stringify(asked.props), `the prop did not round-trip:\n${JSON.stringify(layout.props)}`);
  want(!/WARNING/.test(exported), `the export warned:\n${exported.split('\n').filter((l) => /WARNING/.test(l)).join('\n')}`);

  // ---- 2) an asset that became a package -------------------------------------------
  blender('-P', 'tests/fixtures/moved_scene.py', '--', at('moved.blend'));
  const moved = blender(at('moved.blend'), '-P', 'tools/export_scene.py', '--', '--out', at('moved.json'));
  const props = Object.fromEntries(JSON.parse(readFileSync(at('moved.json'), 'utf8')).props.map((p) => [p.name, p]));
  want(props.dancer_01?.glb === './assets/g-man-dance/g-man-dance.glb', `the anchor did not follow its asset: ${props.dancer_01?.glb}`);
  want(props.dancer_01?.manifest === './assets/g-man-dance/g-man-dance.manifest.json', `...or did not pick up its manifest: ${props.dancer_01?.manifest}`);
  want(/moved\s+dancer_01/.test(moved), 'the export did not say the asset had moved');
  want(props.lost_01?.glb === './assets/no_such_prop.glb' && /WARNING lost_01.*not in game/.test(moved), 'a prop whose file is gone went unreported');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nOK — a prop\'s own volumes show under it as cages and preview their hole, none of them is exported, and an anchor follows its asset into a package');
