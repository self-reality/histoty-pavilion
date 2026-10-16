// A bake made without Blender, for tests/lighting.mjs: the three files a
// lighting descriptor names, in the bake's frozen formats, with values simple
// enough to check by eye. Written to ./out/ (gitignored); the test runs this
// when out/ is missing.
//
//   node tests/fixtures/lighting/make.mjs
//
// • fixture.lit.glb      — assets/de_dust2.glb plus a TEXCOORD_1 per primitive:
//                          a top-down projection of the map, u along Source x,
//                          v along Source y.
// • fixture.lightmap.png — 128², RGBM: 0.6 everywhere, 0.05 within 12 m of the
//                          TUNNEL spot (0.05: the tunnel's floor texture is
//                          brighter than the street's, and the screen's
//                          gamma halves a ratio). The spot is off-centre in v, so a flipped
//                          image lights the tunnel and the test sees it.
// • fixture.probes.bin   — 4 m cells: c0 0.15 within 12 m of TUNNEL (xz) below
//                          y 2, else 0.55; no L1. One block is invalid, to take
//                          the fill path.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(HERE, 'out');
const SCALE = 0.025;                        // manifest.map.scale
const TUNNEL = [6.13, -3.2, -59.83];        // PlayCanvas world (spec §4.1)
const DARK = 12;                            // metres around TUNNEL, in xz

fs.mkdirSync(OUT, { recursive: true });

// ---- the lit GLB ----------------------------------------------------------------
const glb = fs.readFileSync(path.join(ROOT, 'assets/de_dust2.glb'));
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const binHead = 20 + jsonLen;
const binLen = glb.readUInt32LE(binHead);
const bin = glb.subarray(binHead + 8, binHead + 8 + binLen);

let min = [Infinity, Infinity], max = [-Infinity, -Infinity];
const prims = gltf.meshes.flatMap((m) => m.primitives);
for (const p of prims) {
  const a = gltf.accessors[p.attributes.POSITION];
  for (let i = 0; i < 2; i++) { min[i] = Math.min(min[i], a.min[i]); max[i] = Math.max(max[i], a.max[i]); }
}
const size = [max[0] - min[0], max[1] - min[1]];

function positions(accessor) {
  const a = gltf.accessors[accessor];
  const view = gltf.bufferViews[a.bufferView];
  const stride = view.byteStride || 12;
  const base = (view.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < 3; k++) out[3 * i + k] = bin.readFloatLE(base + i * stride + 4 * k);
  }
  return out;
}

const extra = [];
let offset = binLen + ((4 - (binLen % 4)) % 4);
for (const p of prims) {
  const pos = positions(p.attributes.POSITION);
  const n = pos.length / 3;
  const uv = new Float32Array(2 * n);
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    uv[2 * i] = (pos[3 * i] - min[0]) / size[0];
    uv[2 * i + 1] = (pos[3 * i + 1] - min[1]) / size[1];
    for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], uv[2 * i + k]); hi[k] = Math.max(hi[k], uv[2 * i + k]); }
  }
  const bytes = Buffer.from(uv.buffer);
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
  gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType: 5126, type: 'VEC2', count: n, min: lo, max: hi });
  p.attributes.TEXCOORD_1 = gltf.accessors.length - 1;
  extra.push({ offset, bytes });
  offset += bytes.length;                 // float32 pairs keep 4-byte alignment
}
const newBin = Buffer.alloc(offset + ((4 - (offset % 4)) % 4));
bin.copy(newBin, 0);
for (const e of extra) e.bytes.copy(newBin, e.offset);
gltf.buffers[0].byteLength = newBin.length;
gltf.asset.extras = { ...(gltf.asset.extras ?? {}), lighting: { source: 'de_dust2.glb', fixture: true } };
let json = Buffer.from(JSON.stringify(gltf), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4);
head.writeUInt32LE(12 + 8 + json.length + 8 + newBin.length, 8);
const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return [h, data]; };
fs.writeFileSync(path.join(OUT, 'fixture.lit.glb'),
  Buffer.concat([head, ...chunk(0x4e4f534a, json), ...chunk(0x004e4942, newBin)]));

// ---- the lightmap ---------------------------------------------------------------
// Texel (i, j): u = (i + .5) / W, v = (j + .5) / W, row 0 the top (glTF v = 0).
// Source (x, y) -> PlayCanvas (x, z) = (x, -y) * SCALE.
const W = 128;
const nearTunnel = (x, z) => Math.hypot(x - TUNNEL[0], z - TUNNEL[2]) < DARK;
const rgbm = (v) => {
  const s = Math.sqrt(Math.max(v, 0));
  const a = Math.min(Math.max(Math.ceil((s / 8) * 255), 1), 255) / 255;
  const c = Math.round((s / (8 * a)) * 255);
  return [c, c, c, Math.round(a * 255)];
};
const raw = Buffer.alloc(W * (1 + 4 * W));
for (let j = 0; j < W; j++) {
  raw[j * (1 + 4 * W)] = 0;               // filter: none
  for (let i = 0; i < W; i++) {
    const sx = min[0] + ((i + 0.5) / W) * size[0];
    const sy = min[1] + ((j + 0.5) / W) * size[1];
    const px = rgbm(nearTunnel(sx * SCALE, -sy * SCALE) ? 0.05 : 0.6);
    for (let k = 0; k < 4; k++) raw[j * (1 + 4 * W) + 1 + 4 * i + k] = px[k];
  }
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const pngChunk = (type, data) => {
  const t = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
  return Buffer.concat([len, t, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA, no colour chunks
fs.writeFileSync(path.join(OUT, 'fixture.lightmap.png'), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
]));

// ---- the probes -----------------------------------------------------------------
const origin = [-64, -5, -95], cell = [4, 4, 4];
const n = [29, 5, 35];
const N = n[0] * n[1] * n[2];
const f2h = (v) => {
  const f = new Float32Array([v]), u = new Uint32Array(f.buffer)[0];
  const s = (u >>> 16) & 0x8000, e = ((u >>> 23) & 0xff) - 127 + 15, m = u & 0x7fffff;
  if (e <= 0) return s;
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | Math.round(m / 8192);
};
const probes = Buffer.alloc(48 + 25 * N);
probes.write('PCLG', 0, 'ascii');
probes.writeUInt32LE(1, 4);
n.forEach((v, k) => probes.writeUInt32LE(v, 8 + 4 * k));
origin.forEach((v, k) => probes.writeFloatLE(v, 20 + 4 * k));
cell.forEach((v, k) => probes.writeFloatLE(v, 32 + 4 * k));
probes.writeUInt32LE(0, 44);
for (let z = 0; z < n[2]; z++) for (let y = 0; y < n[1]; y++) for (let x = 0; x < n[0]; x++) {
  const i = x + n[0] * (y + n[1] * z);
  const p = [origin[0] + x * cell[0], origin[1] + y * cell[1], origin[2] + z * cell[2]];
  const c0 = nearTunnel(p[0], p[2]) && p[1] < 2 ? 0.15 : 0.55;
  for (let k = 0; k < 12; k++) probes.writeUInt16LE(f2h(k < 3 ? c0 : 0), 48 + 2 * (12 * i + k));
  // The invalid block: a corner of the grid nobody stands in, its value filled.
  probes[48 + 24 * N + i] = x < 3 && z < 3 ? 0 : 1;
}
fs.writeFileSync(path.join(OUT, 'fixture.probes.bin'), probes);

// ---- the descriptor -------------------------------------------------------------
fs.writeFileSync(path.join(OUT, 'fixture.lighting.json'), JSON.stringify({
  version: 1,
  glb: 'fixture.lit.glb', lightmap: 'fixture.lightmap.png', probes: 'fixture.probes.bin',
  lightmapSize: W, encoding: 'rgbm',
  sky: [0.6, 0.62, 0.68],
  sun: { euler: [52, 28, 0], intensity: 2.15, color: [1, 0.96, 0.86] },
  samples: 0, occluders: [],
  source: { map: 'de_dust2.glb', md5: null, placementsMd5: null },
  stats: { seconds: 0, clipped: 0, probesInvalid: 9 * n[1], openFloor: [0.6, 0.6, 0.6], tunnelFloor: [0.05, 0.05, 0.05] },
}, null, 2) + '\n');

console.log(`[fixture] ${path.relative(ROOT, OUT)}: lit glb (${prims.length} primitives), ${W}² lightmap, probes ${n.join('×')}`);
