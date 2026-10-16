"""Bake the map's light: a lightmap for the map, an ambient grid for everything else.

    npm run lighting:bake                    # full: 2048² lightmap, 1024 samples, 2×1×2 m grid
    npm run lighting:bake -- --quick         # 512², 64 samples, 4×2×4 m grid — about a minute
    npm run lighting:bake -- --out DIR       # write somewhere other than assets/
    ... --no-probes | --cpu | --samples N | --preview PNG   (a tone-mapped look at the lightmap)

What it bakes is the light the game cannot compute at runtime: the sky seen
from each point of the map (direct and bounced) and the sun's bounce. The sun's
direct light stays realtime, with its shadows. Units are PlayCanvas "ambient
units": a white face that sees the whole sky bakes exactly `sky`, which is what
scene.ambientLight adds to a face today.

Outputs (beside each other, in --out, default assets/):

    de_dust2.lit.glb        the map GLB unchanged plus a TEXCOORD_1 per primitive
    de_dust2.lightmap.png   2048² RGBM, (8a·rgb)², top row = v 0, no colour chunks
    de_dust2.probes.bin     L1 irradiance grid for props and characters (PCLG v1)
    de_dust2.lighting.json  the descriptor naming the three and the bake's facts

The scene is assembled in memory through build_blend.assemble() — the same
props, markers and cutters scene:import builds — and nothing is saved; the map
itself is built straight from the GLB, one object per glTF primitive, so a
Blender vertex index IS the glTF vertex index and UV1 maps back with no
matching. Static props (no skin, no animation, not unlit, ≥ 1 m³) stay in as
occluders; everything else is hidden from the bake.

UV1 is a seamless conformal unwrap of every primitive (each connected piece —
in practice one BSP polygon — becomes one island, so each vertex has one UV),
then Average Islands Scale and Pack Islands with a 0.003 margin (6 px at 2048).
Cycles bakes a joined copy of the map with the cutters applied, in two passes:
sky direct + indirect, then sun indirect only. No denoiser — 1024 samples.

The probes are L1 irradiance in the engine's own form E(n) = c0 + c·n, from
fixed Fibonacci rays cast through a BVH of the map and the occluders: a miss
is sky, a map hit is albedo × (lightmap + sun direct with one shadow ray), an
occluder hit albedo × (sky/2 + sun direct). A probe whose rays hit back faces
≥ 20 % of the time is inside something; it is filled from the nearest valid
cells and flagged invalid so the game weights it out.

Move a static prop or a cutter, run lighting:bake again — the same rule as
ground:build. The descriptor records the placements' md5, to tell a stale bake by.
"""

import hashlib
import json
import math
import os
import struct
import sys
import tempfile
import time
import zlib

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_blend  # noqa: E402
import negatives  # noqa: E402
from pc_axes import PC2B, pc_trs_to_matrix  # noqa: E402

GAME_DIR = build_blend.GAME_DIR

DEFAULT_SKY = [0.60, 0.62, 0.68]
DEFAULT_SUN = {'euler': [52, 28, 0], 'intensity': 2.15, 'color': [1.0, 0.96, 0.86]}

FULL = {'size': 2048, 'samples': 1024, 'cell': (2.0, 1.0, 2.0), 'rays': 128}
QUICK = {'size': 512, 'samples': 64, 'cell': (4.0, 2.0, 4.0), 'rays': 64}

# Test spots (spec §4.1), PlayCanvas world: floors the stats read the lightmap at.
SPOTS = {'openFloor': (-8.87, 0.0, -17.83), 'tunnelFloor': (6.13, -3.2, -59.83)}

# Grid points sit on whole metres, and de_dust2's floors do too (40 Source
# units), so a probe would lie exactly in a floor plane and see through it.
# The rays start this far off the grid point instead — a centimetre or two,
# nothing a 1–2 m cell can show.
PROBE_NUDGE_PC = (0.0071, 0.0173, 0.0113)


def log(msg):
    print(f'[bake] {msg}', flush=True)


def parse_args():
    args = build_blend.script_args()
    opts = dict(QUICK if '--quick' in args else FULL)
    opts['quick'] = '--quick' in args
    opts['probes'] = '--no-probes' not in args
    opts['cpu'] = '--cpu' in args
    opts['out'] = os.path.join(GAME_DIR, 'assets')
    if '--out' in args:
        opts['out'] = os.path.abspath(args[args.index('--out') + 1])
    opts['preview'] = None
    if '--preview' in args:
        opts['preview'] = os.path.abspath(args[args.index('--preview') + 1])
    if '--samples' in args:
        opts['samples'] = int(args[args.index('--samples') + 1])
    return opts


# --- the map GLB, read directly ----------------------------------------------

COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
              5125: np.uint32, 5126: np.float32}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_glb(path):
    data = open(path, 'rb').read()
    magic, version, _ = struct.unpack_from('<III', data, 0)
    if magic != 0x46546C67 or version != 2:
        raise SystemExit(f'{path}: not a glTF 2 binary')
    jlen, jtype = struct.unpack_from('<II', data, 12)
    gltf = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack_from('<II', data, 20 + jlen)
    if jtype != 0x4E4F534A or btype != 0x004E4942:
        raise SystemExit(f'{path}: unexpected chunk layout')
    binary = data[28 + jlen:28 + jlen + blen]
    return gltf, binary, data


def accessor_array(gltf, binary, index):
    acc = gltf['accessors'][index]
    view = gltf['bufferViews'][acc['bufferView']]
    dtype = np.dtype(COMPONENTS[acc['componentType']])
    width = WIDTH[acc['type']]
    start = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    stride = view.get('byteStride') or dtype.itemsize * width
    count = acc['count']
    if stride == dtype.itemsize * width:
        flat = np.frombuffer(binary, dtype, count * width, start)
        return flat.reshape(count, width) if width > 1 else flat.copy()
    rows = np.ndarray((count, width), dtype, binary, start, (stride, dtype.itemsize))
    return rows.copy()


def map_primitives(gltf):
    """Every (mesh index, primitive index, primitive) in file order."""
    return [(mi, pi, prim) for mi, mesh in enumerate(gltf['meshes'])
            for pi, prim in enumerate(mesh['primitives'])]


def map_materials(gltf, binary, tmpdir):
    """One Principled BSDF per glTF material, base colour from its embedded image."""
    images = []
    for i, img in enumerate(gltf.get('images', [])):
        view = gltf['bufferViews'][img['bufferView']]
        start = view.get('byteOffset', 0)
        ext = '.png' if img.get('mimeType') == 'image/png' else '.jpg'
        path = os.path.join(tmpdir, f'map_image_{i}{ext}')
        with open(path, 'wb') as fh:
            fh.write(binary[start:start + view['byteLength']])
        images.append(bpy.data.images.load(path))

    mats = []
    for i, src in enumerate(gltf.get('materials', [])):
        mat = bpy.data.materials.new(src.get('name') or f'map_material_{i}')
        mat.use_nodes = True
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs['Roughness'].default_value = 1.0
        bsdf.inputs['Metallic'].default_value = 0.0
        bsdf.inputs['Specular IOR Level'].default_value = 0.0
        pbr = src.get('pbrMetallicRoughness', {})
        factor = pbr.get('baseColorFactor', [1, 1, 1, 1])
        tex = pbr.get('baseColorTexture')
        mat['albedo_factor'] = factor[:3]
        if tex is not None:
            node = nodes.new('ShaderNodeTexImage')
            node.image = images[gltf['textures'][tex['index']]['source']]
            uv = nodes.new('ShaderNodeUVMap')
            uv.uv_map = 'UVMap'                  # UV0, never the lightmap layer
            links.new(uv.outputs['UV'], node.inputs['Vector'])
            if factor[:3] != [1, 1, 1]:
                mix = nodes.new('ShaderNodeMix')
                mix.data_type = 'RGBA'
                mix.blend_type = 'MULTIPLY'
                mix.inputs['Factor'].default_value = 1.0
                links.new(node.outputs['Color'], mix.inputs['A'])
                mix.inputs['B'].default_value = (*factor[:3], 1.0)
                links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
            else:
                links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
            mat['albedo_image'] = node.image.name
        else:
            bsdf.inputs['Base Color'].default_value = (*factor[:3], 1.0)
        # The bake target: unlinked, active. Its image is set per pass.
        target = nodes.new('ShaderNodeTexImage')
        target.name = 'LIGHTMAP_TARGET'
        nodes.active = target
        mats.append(mat)
    return mats


def make_map_builder(map_cfg, gltf, binary, tmpdir, record):
    """The `map_builder` for build_blend.assemble: one object per glTF primitive."""

    def builder(ref):
        mats = map_materials(gltf, binary, tmpdir)
        world = PC2B @ pc_trs_to_matrix((0, 0, 0), map_cfg.get('euler'), [map_cfg['scale']] * 3)
        objs = []
        for mi, pi, prim in map_primitives(gltf):
            if prim.get('mode', 4) != 4:
                raise SystemExit(f'mesh {mi} primitive {pi}: mode {prim.get("mode")}, triangles only')
            pos = accessor_array(gltf, binary, prim['attributes']['POSITION']).astype(np.float64)
            idx = accessor_array(gltf, binary, prim['indices']).astype(np.int64).reshape(-1, 3)
            name = f'map_{mi:02d}_{pi:02d}'
            mesh = bpy.data.meshes.new(name)
            # from_pydata keeps vertex order and every face, zero-area ones too.
            mesh.from_pydata(pos.tolist(), [], idx.tolist())
            uv0 = mesh.uv_layers.new(name='UVMap')
            if 'TEXCOORD_0' in prim['attributes']:
                tc = accessor_array(gltf, binary, prim['attributes']['TEXCOORD_0']).astype(np.float64)
                loops = np.empty(len(mesh.loops), np.int64)
                mesh.loops.foreach_get('vertex_index', loops)
                uv = tc[loops]
                uv[:, 1] = 1.0 - uv[:, 1]
                uv0.data.foreach_set('uv', uv.astype(np.float32).ravel())
            if 'material' in prim:
                mesh.materials.append(mats[prim['material']])
            obj = bpy.data.objects.new(name, mesh)
            obj.matrix_world = world
            obj['gltf_mesh'] = mi
            obj['gltf_primitive'] = pi
            ref.objects.link(obj)
            objs.append(obj)
        record['materials'] = mats
        log(f'map    {len(objs)} objects, one per glTF primitive')
        return objs

    return builder


# --- occluders ---------------------------------------------------------------

def glb_flags(path):
    gltf, _, _ = read_glb(path)
    unlit = any('KHR_materials_unlit' in (m.get('extensions') or {}) for m in gltf.get('materials', []))
    return bool(gltf.get('skins')), bool(gltf.get('animations')), unlit


def is_volume(obj):
    return bool(negatives.PAYLOAD_NEG.search(obj.name) or negatives.PAYLOAD_ACT.search(obj.name))


def choose_occluders(scene_coll):
    """Static, lit, solid props stay in the bake; everything else is hidden from it."""
    occluders, hidden = [], []
    for anchor in sorted((o for o in scene_coll.objects if o.parent is None and 'glb' in o),
                         key=lambda o: o.name):
        meshes = [o for o in anchor.children_recursive if o.type == 'MESH' and not is_volume(o)]
        skins, anims, unlit = glb_flags(os.path.join(GAME_DIR, anchor['glb']))
        volume = 0.0
        if meshes:
            lo = [math.inf] * 3
            hi = [-math.inf] * 3
            for m in meshes:
                for c in m.bound_box:
                    w = m.matrix_world @ Vector(c)
                    for k in range(3):
                        lo[k] = min(lo[k], w[k])
                        hi[k] = max(hi[k], w[k])
            volume = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])
        keep = meshes and not skins and not anims and not unlit and volume >= 1.0
        for o in anchor.children_recursive:
            if not keep or is_volume(o):
                o.hide_render = True
        (occluders if keep else hidden).append(anchor.name)
        why = 'occluder' if keep else ('skinned' if skins else 'animated' if anims else
                                       'unlit' if unlit else f'{volume:.2f} m³')
        log(f'prop   {anchor.name:<40s} {why}')
    return occluders, hidden


# --- render setup ------------------------------------------------------------

def setup_cycles(scene, opts):
    scene.render.engine = 'CYCLES'
    cyc = scene.cycles
    device = 'CPU'
    if not opts['cpu']:
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            for kind in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
                try:
                    prefs.compute_device_type = kind
                except TypeError:
                    continue
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type != 'CPU']
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type != 'CPU'
                    device = 'GPU'
                    log(f'device {kind}: {", ".join(d.name for d in gpus)}')
                    break
        except Exception as err:  # noqa: BLE001 — any trouble here means CPU
            log(f'no GPU ({err})')
    if device == 'CPU':
        log('device CPU')
    cyc.device = device
    cyc.samples = opts['samples']
    cyc.use_adaptive_sampling = False
    cyc.use_denoising = False
    cyc.seed = 0
    cyc.max_bounces = 4
    cyc.diffuse_bounces = 3
    cyc.glossy_bounces = 0
    cyc.transmission_bounces = 0
    cyc.volume_bounces = 0
    cyc.transparent_max_bounces = 4
    cyc.sample_clamp_indirect = 10
    return device


def setup_world(scene, sky):
    world = bpy.data.worlds.new('bake_sky')
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (*sky, 1.0)
    bg.inputs['Strength'].default_value = 1.0
    scene.world = world
    return bg


def sun_direction(sun_cfg):
    """The direction the sun's light travels, in Blender world space."""
    d_pc = pc_trs_to_matrix(None, sun_cfg['euler']).to_3x3() @ Vector((0, -1, 0))
    return (PC2B.to_3x3() @ d_pc).normalized()


def setup_sun(scene, sun_cfg):
    data = bpy.data.lights.new('bake_sun', 'SUN')
    data.energy = math.pi * sun_cfg['intensity']
    data.color = sun_cfg['color']
    data.angle = math.radians(0.5)
    sun = bpy.data.objects.new('bake_sun', data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = sun_direction(sun_cfg).to_track_quat('-Z', 'Y').to_euler()
    return sun


# --- UV1 ---------------------------------------------------------------------

def unwrap(map_objects):
    t0 = time.time()
    for obj in map_objects:
        layer = obj.data.uv_layers.new(name='lightmap')
        obj.data.uv_layers.active = layer
        obj.data.uv_layers['UVMap'].active_render = True
    bpy.ops.object.select_all(action='DESELECT')
    for obj in map_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = map_objects[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    # Not Smart UV Project: obj2gltf merged a few vertices that two non-coplanar
    # polygons share, and Smart UV splits such a vertex into two islands — UV1
    # could then not be one value per glTF vertex. A seamless conformal unwrap
    # keeps each connected piece one island (a planar piece maps exactly, up to
    # scale and rotation), so every vertex has exactly one UV.
    bpy.ops.uv.unwrap(method='CONFORMAL', fill_holes=False, correct_aspect=True, margin=0.0)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=0.003)
    bpy.ops.object.mode_set(mode='OBJECT')
    log(f'unwrap {time.time() - t0:.1f} s')


def vertex_uv1(obj):
    """UV1 per vertex of the base mesh (= per glTF vertex), checked for agreement."""
    mesh = obj.data
    n = len(mesh.loops)
    loops = np.empty(n, np.int64)
    mesh.loops.foreach_get('vertex_index', loops)
    uv = np.empty(n * 2, np.float32)
    mesh.uv_layers['lightmap'].data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2).astype(np.float64)
    out = np.zeros((len(mesh.vertices), 2))
    out[loops] = uv
    diff = np.abs(out[loops] - uv).max(axis=1)
    if n and diff.max() > 1e-6:
        bad = int(loops[int(diff.argmax())])
        raise SystemExit(f'{obj.name}: vertex {bad} has loops whose lightmap UVs disagree '
                         f'by {diff.max():.2e} — UV1 cannot be stored per vertex')
    return out


# --- baking ------------------------------------------------------------------

def bake_object(map_objects, collection):
    """The map as ONE object, cutters applied, for Cycles to bake.

    Cycles bakes a multi-object selection one object at a time, syncing the
    whole scene for each — 79 syncs for 79 primitives, which is most of a quick
    bake. Baking a joined copy syncs once. The copy carries both UV layers and
    the materials; the per-primitive originals (which the UV1 is read from) are
    hidden from render so the map is not there twice.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    parts = []
    for obj in map_objects:
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True,
                                               depsgraph=dg)
        part = bpy.data.objects.new(obj.name + '_bake', mesh)
        part.matrix_world = obj.matrix_world
        collection.objects.link(part)
        parts.append(part)
        obj.hide_render = True
    bpy.ops.object.select_all(action='DESELECT')
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = 'map_bake'
    joined.data.uv_layers.active = joined.data.uv_layers['lightmap']
    joined.data.uv_layers['UVMap'].active_render = True
    return joined


def bake_pass(name, map_objects, mats, size, filters):
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    for mat in mats:
        mat.node_tree.nodes['LIGHTMAP_TARGET'].image = img
        mat.node_tree.nodes.active = mat.node_tree.nodes['LIGHTMAP_TARGET']
    bpy.ops.object.select_all(action='DESELECT')
    for obj in map_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = map_objects[0]
    t0 = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter=filters, use_clear=True, margin=8,
                        margin_type='EXTEND', target='IMAGE_TEXTURES', uv_layer='lightmap')
    px = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(px)
    log(f'pass   {name} {sorted(filters)}  {time.time() - t0:.1f} s')
    return px.reshape(size, size, 4)[:, :, :3].astype(np.float64)


# --- outputs -----------------------------------------------------------------

def png_bytes(rgba):
    """8-bit RGBA PNG, Sub-filtered, with no gAMA/sRGB/iCCP — browsers take it as data."""
    h, w, _ = rgba.shape
    rows = rgba.astype(np.uint8)
    sub = rows.copy()
    sub[:, 1:, :] = rows[:, 1:, :] - rows[:, :-1, :]        # uint8 wraps, as PNG wants
    raw = np.concatenate([np.ones((h, 1), np.uint8), sub.reshape(h, w * 4)], axis=1)

    def chunk(kind, body):
        return (struct.pack('>I', len(body)) + kind + body +
                struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF))

    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw.tobytes(), 9)) +
            chunk(b'IEND', b''))


def rgbm(lm):
    """Linear irradiance (Blender rows, bottom first) -> RGBM rows, top first."""
    s = np.sqrt(np.maximum(lm, 0.0))
    clipped = int((lm.max(axis=2) > 64.0).sum())
    a = np.clip(np.ceil(s.max(axis=2) / 8.0 * 255.0), 1, 255) / 255.0
    rgb = np.clip(np.round(s / (8.0 * a[:, :, None]) * 255.0), 0, 255)
    out = np.concatenate([rgb, np.round(a * 255.0)[:, :, None]], axis=2)
    return np.flipud(out).astype(np.uint8), clipped


def write_lit_glb(path, gltf, binary, uv1_per_prim, source_md5):
    gltf = json.loads(json.dumps(gltf))
    blob = bytearray(binary)
    for (mi, pi, _), uv in zip(map_primitives(gltf), uv1_per_prim):
        prim = gltf['meshes'][mi]['primitives'][pi]
        count = gltf['accessors'][prim['attributes']['POSITION']]['count']
        if len(uv) != count:
            raise SystemExit(f'mesh {mi} primitive {pi}: {len(uv)} UV1 values for {count} vertices')
        tc = np.empty((count, 2), np.float32)
        tc[:, 0] = uv[:, 0]
        tc[:, 1] = 1.0 - uv[:, 1]
        while len(blob) % 4:
            blob.append(0)
        gltf['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob),
                                    'byteLength': tc.nbytes, 'target': 34962})
        blob += tc.tobytes()
        gltf['accessors'].append({'bufferView': len(gltf['bufferViews']) - 1,
                                  'componentType': 5126, 'type': 'VEC2', 'count': count,
                                  'min': [float(v) for v in tc.min(axis=0)] if count else [0, 0],
                                  'max': [float(v) for v in tc.max(axis=0)] if count else [0, 0]})
        prim['attributes']['TEXCOORD_1'] = len(gltf['accessors']) - 1
    while len(blob) % 4:
        blob.append(0)
    gltf['buffers'][0]['byteLength'] = len(blob)
    gltf['asset'].setdefault('extras', {})['lighting'] = {'source': 'de_dust2.glb', 'md5': source_md5}
    text = json.dumps(gltf, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(blob)))
        fh.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
        fh.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


# --- probes ------------------------------------------------------------------

def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


_image_means = {}


def image_mean(img):
    if img.name not in _image_means:
        w, h = img.size
        if not w or not h:
            _image_means[img.name] = np.ones(3)
        else:
            px = np.empty(w * h * img.channels, np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(-1, img.channels)[:, :3].astype(np.float64)
            if not img.is_float and img.colorspace_settings.name.lower().startswith('srgb'):
                px = srgb_to_linear(px)
            _image_means[img.name] = px.mean(axis=0)
    return _image_means[img.name]


def upstream_image(node, depth=0):
    if node.type == 'TEX_IMAGE' and node.image:
        return node.image
    if depth > 6:
        return None
    for sock in node.inputs:
        for link in sock.links:
            found = upstream_image(link.from_node, depth + 1)
            if found:
                return found
    return None


def material_albedo(mat):
    """The mean base colour of a material — what its bounce is tinted by."""
    if mat is None or not mat.use_nodes:
        return np.full(3, 0.5)
    if 'albedo_factor' in mat:
        a = np.array(mat['albedo_factor'], np.float64)
        if 'albedo_image' in mat:
            a = a * image_mean(bpy.data.images[mat['albedo_image']])
        return a
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        return np.full(3, 0.5)
    sock = bsdf.inputs['Base Color']
    if sock.links:
        img = upstream_image(sock.links[0].from_node)
        if img:
            return image_mean(img)
    return np.array(sock.default_value[:3], np.float64)


def gather_triangles(objs, depsgraph, want_uv):
    """World-space triangles of the evaluated meshes, with per-triangle albedo (+UV1)."""
    verts, tris, albedo, uvs = [], [], [], []
    base = 0
    for obj in objs:
        ev = obj.evaluated_get(depsgraph)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        nv, nt = len(me.vertices), len(me.loop_triangles)
        if nt:
            co = np.empty(nv * 3, np.float32)
            me.vertices.foreach_get('co', co)
            co = co.reshape(-1, 3).astype(np.float64)
            m = np.array(ev.matrix_world)
            co = co @ m[:3, :3].T + m[:3, 3]
            tv = np.empty(nt * 3, np.int64)
            me.loop_triangles.foreach_get('vertices', tv)
            mi = np.empty(nt, np.int64)
            me.loop_triangles.foreach_get('material_index', mi)
            mat_alb = [material_albedo(s.material) for s in ev.material_slots] or [np.full(3, 0.5)]
            table = np.array(mat_alb)
            albedo.append(table[np.clip(mi, 0, len(table) - 1)])
            verts.append(co)
            tris.append(tv.reshape(-1, 3) + base)
            base += nv
            if want_uv:
                tl = np.empty(nt * 3, np.int64)
                me.loop_triangles.foreach_get('loops', tl)
                uv = np.empty(len(me.loops) * 2, np.float32)
                me.uv_layers['lightmap'].data.foreach_get('uv', uv)
                uvs.append(uv.reshape(-1, 2).astype(np.float64)[tl].reshape(-1, 3, 2))
        ev.to_mesh_clear()
    if not tris:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 3)), np.zeros((0, 3, 2))
    return (np.concatenate(verts), np.concatenate(tris), np.concatenate(albedo),
            np.concatenate(uvs) if want_uv else None)


def fibonacci_sphere(n):
    i = np.arange(n) + 0.5
    z = 1.0 - 2.0 * i / n
    r = np.sqrt(1.0 - z * z)
    phi = i * math.pi * (3.0 - math.sqrt(5.0))
    return np.stack([r * np.cos(phi), r * np.sin(phi), z], axis=1)


def bilinear(lm, uv):
    """Sample the float lightmap (rows bottom first, as Blender stores it) at uv."""
    h, w, _ = lm.shape
    x = np.clip(uv[:, 0] * w - 0.5, 0, w - 1)
    y = np.clip(uv[:, 1] * h - 0.5, 0, h - 1)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    return ((lm[y0, x0] * (1 - fx) + lm[y0, x1] * fx) * (1 - fy) +
            (lm[y1, x0] * (1 - fx) + lm[y1, x1] * fx) * fy)


class Scene:
    """The BVH and per-triangle data the probes and stats shade hits with."""

    def __init__(self, map_objects, occluder_objects, lm, sky, sun_cfg):
        dg = bpy.context.evaluated_depsgraph_get()
        mv, mt, ma, muv = gather_triangles(map_objects, dg, True)
        ov, ot, oa, _ = gather_triangles(occluder_objects, dg, False)
        self.verts = np.concatenate([mv, ov])
        self.tris = np.concatenate([mt, ot + len(mv)])
        self.albedo = np.concatenate([ma, oa])
        self.uv = muv
        self.n_map = len(mt)
        self.bvh = BVHTree.FromPolygons(self.verts.tolist(), self.tris.tolist(), all_triangles=True)
        self.lm = lm
        self.sky = np.array(sky, np.float64)
        self.sun_d = np.array(sun_direction(sun_cfg))
        self.to_sun = Vector(-self.sun_d)
        self.sun_rgb = sun_cfg['intensity'] * np.array(sun_cfg['color'], np.float64)
        log(f'bvh    {self.n_map} map + {len(ot)} occluder triangles')

    def uv1_at(self, tri, loc):
        """Barycentric UV1 of map triangles `tri` at points `loc`."""
        p = self.verts[self.tris[tri]]                     # (n, 3, 3)
        v0, v1, v2 = p[:, 1] - p[:, 0], p[:, 2] - p[:, 0], loc - p[:, 0]
        d00 = (v0 * v0).sum(1)
        d01 = (v0 * v1).sum(1)
        d11 = (v1 * v1).sum(1)
        d20 = (v2 * v0).sum(1)
        d21 = (v2 * v1).sum(1)
        den = d00 * d11 - d01 * d01
        den = np.where(np.abs(den) < 1e-30, 1.0, den)
        b1 = (d11 * d20 - d01 * d21) / den
        b2 = (d00 * d21 - d01 * d20) / den
        b0 = 1.0 - b1 - b2
        uv = self.uv[tri]
        return uv[:, 0] * b0[:, None] + uv[:, 1] * b1[:, None] + uv[:, 2] * b2[:, None]

    def lm_at(self, tri, loc):
        return bilinear(self.lm, self.uv1_at(tri, loc))

    def sun_direct(self, locs, normals):
        """intensity·colour·max(0, n·L)·visible, one shadow ray each."""
        cos = np.maximum(0.0, normals @ (-self.sun_d))
        vis = np.zeros(len(locs))
        for k in np.nonzero(cos > 0)[0]:
            o = Vector(locs[k] + normals[k] * 0.01)
            vis[k] = 0.0 if self.bvh.ray_cast(o, self.to_sun)[0] is not None else 1.0
        return (cos * vis)[:, None] * self.sun_rgb

    def floor_lm(self, p_pc):
        """The lightmap value on the map floor under a PlayCanvas point (stats)."""
        o = PC2B @ Vector((p_pc[0], p_pc[1] + 0.5, p_pc[2]))
        loc, _, idx, _ = self.bvh.ray_cast(o, Vector((0, 0, -1)), 2.0)
        if loc is None or idx >= self.n_map:
            return [0.0, 0.0, 0.0]
        return [round(float(v), 4) for v in self.lm_at(np.array([idx]), np.array([loc]))[0]]


def bake_probes(sc, origin, cell, dims, n_rays):
    t0 = time.time()
    nx, ny, nz = dims
    dirs = fibonacci_sphere(n_rays)
    dir_vecs = [Vector(d) for d in dirs]
    count = nx * ny * nz
    coeffs = np.zeros((count, 4, 3))
    valid = np.zeros(count, np.uint8)
    for i in range(count):
        x, rem = i % nx, i // nx
        y, z = rem % ny, rem // ny
        p_pc = (origin[0] + x * cell[0] + PROBE_NUDGE_PC[0],
                origin[1] + y * cell[1] + PROBE_NUDGE_PC[1],
                origin[2] + z * cell[2] + PROBE_NUDGE_PC[2])
        o = PC2B @ Vector(p_pc)
        hit_k, hit_loc, hit_n, hit_i = [], [], [], []
        back = 0
        for k, d in enumerate(dir_vecs):
            loc, nrm, idx, _ = sc.bvh.ray_cast(o, d)
            if loc is None:
                continue
            n = np.array(nrm)
            if n @ dirs[k] > 0:
                back += 1
                n = -n                       # face the ray: the map is drawn two-sided
            hit_k.append(k)
            hit_loc.append(loc)
            hit_n.append(n)
            hit_i.append(idx)
        radiance = np.tile(sc.sky, (n_rays, 1))
        if hit_k:
            hk = np.array(hit_k)
            hl = np.array(hit_loc, np.float64)
            hn = np.array(hit_n)
            hi = np.array(hit_i)
            sun = sc.sun_direct(hl, hn)
            on_map = hi < sc.n_map
            light = np.empty((len(hk), 3))
            light[~on_map] = 0.5 * sc.sky + sun[~on_map]
            if on_map.any():
                light[on_map] = sc.lm_at(hi[on_map], hl[on_map]) + sun[on_map]
            radiance[hk] = sc.albedo[hi] * light
        c0 = radiance.mean(axis=0)
        c1 = 2.0 * (dirs.T @ radiance) / n_rays                # Blender axes, rows x y z
        # Blender (x, y, z) -> PlayCanvas (x, z, -y)
        coeffs[i] = [c0, c1[0], c1[2], -c1[1]]
        valid[i] = 1 if back / n_rays < 0.2 else 0
        if i and i % 5000 == 0:
            log(f'probes {i}/{count}  {time.time() - t0:.0f} s')

    # Fill each invalid cell from the nearest ring of valid ones, up to 3 steps out.
    filled = coeffs.copy()
    invalid = np.nonzero(valid == 0)[0]
    for i in invalid:
        x, rem = i % nx, i // nx
        y, z = rem % ny, rem // ny
        seen = {(x, y, z)}
        ring = [(x, y, z)]
        found = []
        for _ in range(3):
            nxt = []
            for (a, b, c) in ring:
                for da, db, dc in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                    q = (a + da, b + db, c + dc)
                    if q in seen or not (0 <= q[0] < nx and 0 <= q[1] < ny and 0 <= q[2] < nz):
                        continue
                    seen.add(q)
                    nxt.append(q)
                    j = q[0] + nx * (q[1] + ny * q[2])
                    if valid[j]:
                        found.append(j)
            if found:
                break
            ring = nxt
        if found:
            filled[i] = coeffs[found].mean(axis=0)
        else:
            filled[i] = 0.0
            filled[i, 0] = sc.sky
    log(f'probes {count} in {time.time() - t0:.0f} s, {len(invalid)} invalid filled')
    return filled, valid, len(invalid)


def write_probes(path, origin, cell, dims, coeffs, valid):
    nx, ny, nz = dims
    head = (b'PCLG' + struct.pack('<IIII', 1, nx, ny, nz) +
            struct.pack('<fff', *origin) + struct.pack('<fff', *cell) + struct.pack('<I', 0))
    body = coeffs.reshape(-1, 12).astype('<f2').tobytes()
    with open(path, 'wb') as fh:
        fh.write(head + body + valid.astype(np.uint8).tobytes())


def grid_for(map_pc_min, map_pc_max, cell):
    # The tolerance keeps float slop (-64.0000004) from adding a row of cells.
    origin = [float(math.floor(v + 1e-3)) for v in map_pc_min]
    dims = [int(math.ceil((hi - o) / c - 1e-3)) + 1 for o, hi, c in zip(origin, map_pc_max, cell)]
    return origin, dims


def map_bounds_pc(map_cfg, gltf, binary):
    m = np.array(pc_trs_to_matrix((0, 0, 0), map_cfg.get('euler'), [map_cfg['scale']] * 3))
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for _, _, prim in map_primitives(gltf):
        p = accessor_array(gltf, binary, prim['attributes']['POSITION']).astype(np.float64)
        w = p @ m[:3, :3].T + m[:3, 3]
        lo = np.minimum(lo, w.min(axis=0))
        hi = np.maximum(hi, w.max(axis=0))
    return lo, hi


def preview(path, lm):
    """A look at the lightmap for people: Reinhard, sRGB, top row = v 0."""
    v = lm / (1.0 + lm)
    v = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(np.maximum(v, 0), 1 / 2.4) - 0.055)
    rgb = np.clip(np.round(v * 255), 0, 255)
    rgba = np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255.0)], axis=2)
    with open(path, 'wb') as fh:
        fh.write(png_bytes(np.flipud(rgba)))


# --- main --------------------------------------------------------------------

def md5(path):
    return hashlib.md5(open(path, 'rb').read()).hexdigest()


def main():
    t_start = time.time()
    opts = parse_args()
    os.makedirs(opts['out'], exist_ok=True)
    manifest = build_blend.read_manifest()
    placements = build_blend.read_placements(manifest)
    map_cfg = manifest['map']
    map_path = os.path.join(GAME_DIR, map_cfg['glb'])
    gltf, binary, _ = read_glb(map_path)
    light_cfg = manifest.get('lighting') or {}
    sky = list((light_cfg.get('bake') or {}).get('sky') or DEFAULT_SKY)
    sun_cfg = dict(DEFAULT_SUN)
    sun_cfg.update({k: v for k, v in (manifest.get('sun') or {}).items() if k in DEFAULT_SUN})
    log(f'{"quick" if opts["quick"] else "full"}: {opts["size"]}², {opts["samples"]} samples, '
        f'sky {sky}, sun {sun_cfg}')

    tmpdir = tempfile.mkdtemp(prefix='bake_light_')
    record = {}
    t0 = time.time()
    built = build_blend.assemble(manifest, placements,
                                 make_map_builder(map_cfg, gltf, binary, tmpdir, record))
    map_objects = built['map_objects']
    for obj in built['neg'].objects:
        obj.hide_render = True
    occluders, _ = choose_occluders(built['scene'])
    log(f'occluders {", ".join(occluders) or "none"}')
    log(f'assemble {time.time() - t0:.1f} s')

    scene = bpy.context.scene
    unwrap(map_objects)
    uv1 = [vertex_uv1(obj) for obj in map_objects]
    uv_all = np.concatenate(uv1)
    log(f'uv1    {len(uv_all)} vertices, range u {uv_all[:, 0].min():.4f}..{uv_all[:, 0].max():.4f} '
        f'v {uv_all[:, 1].min():.4f}..{uv_all[:, 1].max():.4f}')

    device = setup_cycles(scene, opts)
    bg = setup_world(scene, sky)
    sun = setup_sun(scene, sun_cfg)
    mats = record['materials']

    baked = bake_object(map_objects, built['ref'])
    sun.hide_render = True
    lm_a = bake_pass('LM_A', [baked], mats, opts['size'], {'DIRECT', 'INDIRECT'})
    sun.hide_render = False
    bg.inputs['Strength'].default_value = 0.0
    lm_b = bake_pass('LM_B', [baked], mats, opts['size'], {'INDIRECT'})
    bg.inputs['Strength'].default_value = 1.0
    lm = lm_a + lm_b
    lum = lm @ np.array([0.2126, 0.7152, 0.0722])
    log(f'lightmap mean {lum.mean():.3f}  p50 {np.percentile(lum, 50):.3f}  '
        f'p99 {np.percentile(lum, 99):.3f}  max {lum.max():.3f}')

    names = {'glb': 'de_dust2.lit.glb', 'lightmap': 'de_dust2.lightmap.png',
             'probes': 'de_dust2.probes.bin', 'json': 'de_dust2.lighting.json'}
    encoded, clipped = rgbm(lm)
    with open(os.path.join(opts['out'], names['lightmap']), 'wb') as fh:
        fh.write(png_bytes(encoded))
    write_lit_glb(os.path.join(opts['out'], names['glb']), gltf, binary, uv1, md5(map_path))
    if opts['preview']:
        preview(opts['preview'], lm)

    occluder_objs = [o for name in occluders for o in bpy.data.objects[name].children_recursive
                     if o.type == 'MESH' and not o.hide_render]
    sc = Scene([baked], occluder_objs, lm, sky, sun_cfg)
    stats = {'seconds': 0, 'clipped': clipped, 'probesInvalid': 0,
             'openFloor': sc.floor_lm(SPOTS['openFloor']),
             'tunnelFloor': sc.floor_lm(SPOTS['tunnelFloor'])}
    log(f'floor  open {stats["openFloor"]}  tunnel {stats["tunnelFloor"]}')

    descriptor = {'version': 1, 'glb': names['glb'], 'lightmap': names['lightmap']}
    if opts['probes']:
        lo, hi = map_bounds_pc(map_cfg, gltf, binary)
        origin, dims = grid_for(lo, hi, opts['cell'])
        log(f'grid   origin {origin} cell {list(opts["cell"])} dims {dims} '
            f'({dims[0] * dims[1] * dims[2]} probes × {opts["rays"]} rays)')
        coeffs, valid, invalid = bake_probes(sc, origin, opts['cell'], dims, opts['rays'])
        write_probes(os.path.join(opts['out'], names['probes']), origin, opts['cell'], dims,
                     coeffs, valid)
        stats['probesInvalid'] = invalid
        descriptor['probes'] = names['probes']

    placements_path = os.path.join(GAME_DIR, manifest.get('placements') or '')
    stats['seconds'] = round(time.time() - t_start)
    descriptor.update({
        'lightmapSize': opts['size'], 'encoding': 'rgbm',
        'sky': sky,
        'sun': {'euler': sun_cfg['euler'], 'intensity': sun_cfg['intensity'], 'color': sun_cfg['color']},
        'samples': opts['samples'], 'occluders': occluders,
        'source': {'map': os.path.basename(map_cfg['glb']), 'md5': md5(map_path),
                   'placementsMd5': md5(placements_path) if os.path.isfile(placements_path) else None},
        'stats': stats,
    })
    with open(os.path.join(opts['out'], names['json']), 'w') as fh:
        json.dump(descriptor, fh, indent=2)
        fh.write('\n')
    written = [names[k] for k in ('glb', 'lightmap', 'probes', 'json') if k != 'probes' or opts['probes']]
    log(f'wrote  {", ".join(written)} in {opts["out"]}  ({stats["seconds"]} s, '
        f'{clipped} texels clipped)')


if __name__ == '__main__':
    main()
