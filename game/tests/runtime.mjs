// The script runtime is the asset kit's: src/script.mjs and src/rig.mjs are
// copies of its runtime/, so an asset previewed in the kit's viewer does here
// exactly what it did there. This fails when the copies have drifted.
//
//   node tests/runtime.mjs      # no server; needs the kit beside this repo
//   npm run runtime:pull        # the fix: copy the kit's runtime in
//
// Edit the runtime in the kit, never here — a change made here is overwritten
// by the next pull, and the kit's viewer would not have it meanwhile.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const KIT = process.env.KIT ?? join(GAME, '../../singularity-development-kit');
if (!existsSync(join(KIT, 'runtime'))) {
  console.log(`skipped — no kit runtime at ${KIT}/runtime (set KIT=)`);
  process.exit(0);
}
const drifted = ['script.mjs', 'rig.mjs'].filter((f) =>
  !readFileSync(join(GAME, 'src', f)).equals(readFileSync(join(KIT, 'runtime', f))));
if (drifted.length) {
  console.log(`FAIL — src/${drifted.join(', src/')} differ from the kit's runtime/. Edit there, then \`npm run runtime:pull\`.`);
  process.exit(1);
}
console.log('OK — src/script.mjs and src/rig.mjs are the kit\'s runtime');
