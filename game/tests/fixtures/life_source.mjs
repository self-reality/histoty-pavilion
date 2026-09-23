// Writes tests/fixtures/life/life.glb — the object tests/script.mjs puts a
// script on: a one-metre box standing on the ground, its four sides one
// material named `screen` and its top another named `lid`, UV'd 0..1 on every
// face so a picture painted on either fills it.
//
//   node tests/fixtures/life_source.mjs
//
// Built here rather than by the asset kit because there is nothing to build:
// twenty-four corners and two materials, written the way an exporter writes
// them. The kit's `npm run check` holds the result like any other package.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('./life/life.glb', import.meta.url));

// Each face: four corners (counter-clockwise seen from outside), its normal.
const faces = {
  screen: [
    [[[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]], [0, 0, 1]],
    [[[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]], [0, 0, -1]],
    [[[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]], [1, 0, 0]],
    [[[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]], [-1, 0, 0]],
  ],
  lid: [
    [[[-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]], [0, 1, 0]],
  ],
};
// glTF's UV origin is the image's top-left: v runs down.
const uv = [[0, 1], [1, 1], [1, 0], [0, 0]];

const chunks = [];
let offset = 0;
const views = [];
const accessors = [];
const push = (typed, target, accessor) => {
  const bytes = new Uint8Array(typed.buffer.slice(0));
  views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
  accessors.push({ bufferView: views.length - 1, ...accessor });
  chunks.push(bytes);
  offset += bytes.byteLength;
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
  return accessors.length - 1;
};

const primitives = Object.entries(faces).map(([, list], material) => {
  const pos = [], nrm = [], tex = [], idx = [];
  for (const [corners, n] of list) {
    const at = pos.length / 3;
    corners.forEach((c, i) => { pos.push(...c); nrm.push(...n); tex.push(...uv[i]); });
    idx.push(at, at + 1, at + 2, at, at + 2, at + 3);
  }
  const min = [0, 1, 2].map((a) => Math.min(...pos.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map((a) => Math.max(...pos.filter((_, i) => i % 3 === a)));
  return {
    attributes: {
      POSITION: push(new Float32Array(pos), 34962, { componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }),
      NORMAL: push(new Float32Array(nrm), 34962, { componentType: 5126, count: nrm.length / 3, type: 'VEC3' }),
      TEXCOORD_0: push(new Float32Array(tex), 34962, { componentType: 5126, count: tex.length / 2, type: 'VEC2' }),
    },
    indices: push(new Uint16Array(idx), 34963, { componentType: 5123, count: idx.length, type: 'SCALAR' }),
    material,
  };
});

const bin = new Uint8Array(offset);
let at = 0;
for (const c of chunks) { bin.set(c, at); at += c.byteLength; }

const json = {
  asset: { version: '2.0', generator: 'tests/fixtures/life_source.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'life_root', children: [1] }, { name: 'life', mesh: 0 }],
  meshes: [{ name: 'life', primitives }],
  materials: Object.keys(faces).map((name) => ({
    name, pbrMetallicRoughness: { baseColorFactor: [0.2, 0.2, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.8 },
  })),
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: bin.byteLength }],
};

let text = JSON.stringify(json);
text += ' '.repeat((4 - (text.length % 4)) % 4);
const head = new TextEncoder().encode(text);
const glb = new Uint8Array(12 + 8 + head.byteLength + 8 + bin.byteLength);
const dv = new DataView(glb.buffer);
dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.byteLength, true);
dv.setUint32(12, head.byteLength, true); dv.setUint32(16, 0x4e4f534a, true);
glb.set(head, 20);
dv.setUint32(20 + head.byteLength, bin.byteLength, true); dv.setUint32(24 + head.byteLength, 0x004e4942, true);
glb.set(bin, 28 + head.byteLength);
writeFileSync(out, glb);
console.log(`${out}  ${glb.byteLength} bytes`);
