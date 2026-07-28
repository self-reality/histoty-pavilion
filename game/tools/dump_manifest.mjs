// Print scene.manifest.mjs as JSON on stdout.
//
// The manifest is an ES module so the browser can import it with zero build
// step, but the Blender tools are Python and cannot read it. This is the
// bridge: `node tools/dump_manifest.mjs` — used by tools/build_blend.py.
import { manifest } from '../scene.manifest.mjs';

process.stdout.write(JSON.stringify(manifest, null, 2));
