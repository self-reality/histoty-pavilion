"""Process raw source assets into the ones the game actually ships.

    npm run assets:build            # process anything whose source changed
    npm run assets:build -- --force # reprocess everything
    npm run assets:build -- --dry   # report what would happen, write nothing

Marketplace downloads and photogrammetry scans arrive at whatever size the
author felt like: tent_military.glb landed here at 9.8 MB, 8.3 MB of which was
four PNGs, one of them 4.9 MB alone. Dropping those straight into a build that
ships over a public link does not scale past a couple of props, so this sits
between "asset arrives" and "asset ships":

    assets/source/statue.glb   ← what you downloaded, never modified, not in git
            ↓  this script
    assets/statue.glb          ← decimated + WebP textures, tracked, what ships

This handles models only. Pictures used to be built here too, from photographs
dropped in assets/source/pictures/ — that moved out to a standalone browser app
(`frames-for-artwork`), which does the same job without needing a 1 GB desktop
install to decode a jpg. It emits the same picture_<name>.glb; drop one straight
into assets/ and place it in Blender like any other prop.

Two rules make it safe to run at any time:

  • It never touches assets/source/. The raw file is the input, always.
  • It is content-addressed. A source whose bytes and settings are unchanged is
    skipped, so running it after moving props around costs nothing. Placement
    lives in scene.placements.json and never comes near this.

WHY WEBP AND NOT KTX2 — KTX2/Basis is the "correct" answer for texture memory,
since it stays compressed on the GPU. It also needs a WASM transcoder vendored
into lib/ and initialised at boot, and an encoder binary on the build machine,
neither of which is here. WebP is decoded by the browser itself, the engine
already understands EXT_texture_webp, and Blender exports it directly — so it
costs nothing to adopt and wins most of the download battle. Revisit KTX2 when
texture *memory* rather than download becomes the binding constraint.

A NOTE ON DECIMATION — collapsing a mesh loses surface detail that a normal map
would have carried. For marketplace props and hand-authored geometry at these
ratios that is invisible. For photogrammetry it is not: a scan decimated 20:1
without baking a normal map from the original will read as soft. Bake first, or
raise that asset's budget in assets.config.json.
"""

import hashlib
import json
import math
import os
import sys

import bpy
import numpy as np

GAME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(GAME_DIR, 'assets', 'source')
OUT_DIR = os.path.join(GAME_DIR, 'assets')
CONFIG = os.path.join(GAME_DIR, 'assets', 'assets.config.json')
CACHE = os.path.join(GAME_DIR, 'assets', '.assets.cache.json')

# Aimed at a mid-range laptop on an integrated GPU, reached over a public link.
# Per-asset overrides go in assets.config.json; see write_default_config().
DEFAULTS = {
    'maxTexture': 1024,   # px on the long edge; 2048 only for hero pieces
    'triangles': 20000,   # per asset; 0 disables decimation entirely
    'quality': 85,        # WebP quality, 0-100
    'nocolMaxSpan': 0,    # m; parts thinner than this stop colliding. 0 = off
    # '' = collide with the visual mesh. 'dissolve' keeps openings, 'hull' does
    # not — see build_collision_proxy.
    'collisionProxy': '',
    'collisionProxyAngle': 15,   # degrees; how flat two faces must be to merge
}


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return {
        'force': '--force' in argv,
        'dry': '--dry' in argv,
    }


def load_json(path, fallback):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return fallback


def write_default_config():
    """Drop a commented starting point so per-asset tuning is discoverable."""
    cfg = {
        '_doc': 'Per-asset overrides for npm run assets:build. Keys are file '
                'names in assets/source/. "triangles": 0 disables decimation. '
                '"nocolMaxSpan": metres — loose parts narrower than this across '
                'their second-widest axis (ropes, pegs, hardware) are split '
                'into a "*_nocol" object and stop colliding; 0 disables. '
                '"collisionProxy": "hull" adds a low-poly "*_col" mesh that the '
                'game collides with instead of the visual geometry; "" disables.',
        'defaults': dict(DEFAULTS),
        'assets': {},
    }
    with open(CONFIG, 'w') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    return cfg


def settings_for(cfg, name):
    s = dict(DEFAULTS)
    s.update(cfg.get('defaults', {}))
    s.update(cfg.get('assets', {}).get(name, {}))
    return s


def digest(path, settings):
    """Identity of an output: the source bytes plus the settings that shaped it."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    h.update(json.dumps(settings, sort_keys=True).encode())
    return h.hexdigest()


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def count_triangles():
    n = 0
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        n += len(mesh.loop_triangles)
    return n


def resize_textures(cap):
    """Scale any image whose long edge exceeds `cap`, preserving aspect."""
    touched = []
    for img in bpy.data.images:
        w, h = img.size
        if not w or not h:
            continue
        longest = max(w, h)
        if longest <= cap:
            continue
        scale = cap / longest
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        img.scale(nw, nh)
        touched.append((img.name, f'{w}x{h}', f'{nw}x{nh}'))
    return touched


def separate_loose(obj):
    """Explode `obj` into one object per connected shell. Returns all of them."""
    before = set(bpy.data.objects)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='LOOSE')
    bpy.ops.object.mode_set(mode='OBJECT')
    return [obj] + [o for o in bpy.data.objects if o not in before]


def join_into(objs, name):
    """Join `objs` back into one object called `name`. Returns it, or None."""
    if not objs:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    return joined


def second_span(obj):
    """Width across the object's second-widest axis, in metres.

    The second axis rather than the smallest is what separates a prop's fiddly
    bits from its body. A tent wall is thin too — 0.11 m — but it is 6 m long
    and 4 m tall, so only its *smallest* span is small. A guy-rope or a peg is
    narrow in two directions at once, and that is the thing worth measuring.

    Measured along the shell's *own* axes, found by PCA, not along the world's.
    An axis-aligned bounding box describes a diagonal object terribly: the
    tent's guy-ropes are 4.4 m long and 2 cm thick, but they run corner-to-
    corner, so their AABB is 2.5 m wide on the second axis and they read as
    solid — leaving trip-wires strung across the approach, the exact geometry
    this is meant to remove. The eigenvectors of the vertex covariance give the
    rope's own length/width/thickness instead, and 4.4 x 0.02 x 0.02 is not a
    wall by any threshold.
    """
    verts = obj.data.vertices
    if len(verts) < 3:
        return 0.0
    flat = np.empty(len(verts) * 3)
    verts.foreach_get('co', flat)
    m = np.array(obj.matrix_world)
    pts = flat.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    centred = pts - pts.mean(axis=0)
    cov = np.cov(centred.T)
    if not np.all(np.isfinite(cov)):
        return 0.0
    axes = np.linalg.eigh(cov)[1]
    proj = centred @ axes
    return float(sorted(proj.max(axis=0) - proj.min(axis=0), reverse=True)[1])


def mark_noncolliding(span):
    """Split each mesh's thin shells out into a sibling named `*_nocol`.

    Marketplace props arrive as one welded mesh: tent_military.glb is a single
    node holding 140 separate shells — fabric panels, but also 90 pegs, tent
    hardware and cross-bars. The game's collision opt-out keys off the object
    *name* (see NO_COLLIDE in src/world.mjs), so with one object there is
    nothing to name and the whole prop has to be solid — including the pegs you
    then snag on, and the ~10,000 triangles they charge the collider for.

    Splitting by hand in Blender works, but the result would live only in
    assets/source/, which is deliberately untracked and treated as the pristine
    download. Doing it here instead keeps the decision in git as one number and
    lets `--force` reproduce it on any machine.

    A size threshold rather than a hand-picked list because the two populations
    do not overlap: on the tent, the widest thin part is 0.35 m across and the
    narrowest solid one (a window pane) is 0.68 m, so 0.4 m lands in open space
    between them. Per-asset in assets.config.json, since the gap moves with the
    prop. Set nocolMaxSpan to 0 and nothing splits.
    """
    if not span:
        return 0
    parts = 0
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        base = obj.name
        shells = separate_loose(obj)
        thin = [o for o in shells if second_span(o) < span]
        solid = [o for o in shells if o not in thin]
        if not thin:
            join_into(shells, base)
            continue
        parts += len(thin)
        # Name the opt-out first: `base` is still held by one of these shells,
        # and a rename onto a taken name would silently become `base.001`.
        join_into(thin, f'{base}_nocol')
        join_into(solid, base)
    return parts


def build_collision_proxy(mode, angle, stem):
    """Add a low-poly `*_col` mesh and let the game collide with that instead.

    Collision has been reusing the visual mesh this whole time. Even with the
    `_nocol` thin parts gone the tent still charges the collider 7,338
    triangles for what a player experiences as six flat walls and a roof — the
    wrinkles in the fabric are lovely and completely wasted on a capsule.

    Two modes, and the difference between them is whether the prop has a way in.

    'dissolve' merges faces that differ by less than `angle` and does nothing
    else. It only ever *removes* geometry, so every hole in the mesh survives —
    a doorway stays a doorway. This is the default choice.

    'hull' replaces each connected shell with its convex hull. Cheaper on
    organic shapes and closed by construction, so it cannot develop the slivers
    and holes that aggressive collapse does — but a convex shell cannot hold an
    opening. It is for props you walk *around*: a boulder, a crate, a statue.

    Hulling per shell rather than per prop is what keeps a hulled prop from
    becoming a solid block, since the concavity of something like a tent lives
    *between* its panels. It does not save the doorway, though: an opening
    inside a single shell is convex-filled either way. That is not a bug to fix
    so much as what "convex" means — hence 'dissolve' being the default, and
    tests/props.mjs asserting the tent is still enterable.
    """
    if mode not in ('hull', 'dissolve'):
        return 0
    solid = [o for o in bpy.data.objects
             if o.type == 'MESH' and not o.name.lower().endswith('_nocol')]
    if not solid:
        return 0

    # Duplicate first — the visual meshes must come through untouched.
    bpy.ops.object.select_all(action='DESELECT')
    for o in solid:
        o.select_set(True)
    bpy.context.view_layer.objects.active = solid[0]
    bpy.ops.object.duplicate()
    parts = list(bpy.context.selected_objects)

    if mode == 'hull':
        shells = []
        for dup in parts:
            shells.extend(separate_loose(dup))
        parts = []
        for shell in shells:
            bpy.ops.object.select_all(action='DESELECT')
            shell.select_set(True)
            bpy.context.view_layer.objects.active = shell
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            try:
                bpy.ops.mesh.convex_hull()
            except RuntimeError as err:
                # A shell too degenerate to hull (all points collinear) has no
                # volume to collide with either. Drop it, don't ship a sliver.
                print(f'      ! hull failed on {shell.name}: {err}')
                bpy.ops.object.mode_set(mode='OBJECT')
                bpy.data.objects.remove(shell, do_unlink=True)
                continue
            bpy.ops.object.mode_set(mode='OBJECT')
            parts.append(shell)

    proxy = join_into(parts, f'{stem}_col')
    if proxy is None:
        return 0

    # Both modes finish here. For 'dissolve' this IS the simplification; for
    # 'hull' it is cleanup, since a hull still carries a face per wrinkle.
    bpy.context.view_layer.objects.active = proxy
    mod = proxy.modifiers.new(name='planar', type='DECIMATE')
    mod.decimate_type = 'DISSOLVE'
    mod.angle_limit = math.radians(angle)
    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except RuntimeError as err:
        print(f'      ! planar dissolve failed: {err}')
        proxy.modifiers.remove(mod)

    # It is never drawn, so it needs no materials and no UVs.
    proxy.data.materials.clear()
    while proxy.data.uv_layers:
        proxy.data.uv_layers.remove(proxy.data.uv_layers[0])
    proxy.data.calc_loop_triangles()
    return len(proxy.data.loop_triangles)


def count_triangles_matching(suffix):
    n = 0
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or not obj.name.endswith(suffix):
            continue
        obj.data.calc_loop_triangles()
        n += len(obj.data.loop_triangles)
    return n


def decimate(budget):
    """Collapse meshes until the asset fits `budget` triangles.

    The ratio is applied per object rather than globally so one dense mesh in a
    prop cannot survive untouched while a simple one is flattened to nothing.
    """
    total = count_triangles()
    if not budget or total <= budget:
        return total, total
    ratio = budget / total
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or not len(obj.data.polygons):
            continue
        bpy.context.view_layer.objects.active = obj
        mod = obj.modifiers.new(name='budget', type='DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except RuntimeError as err:
            print(f'      ! decimate failed on {obj.name}: {err}')
            obj.modifiers.remove(mod)
    return total, count_triangles()


def process(src_path, out_path, settings, dry):
    name = os.path.basename(src_path)
    src_mb = os.path.getsize(src_path) / 1e6
    print(f'  {name}  ({src_mb:.1f} MB)')

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=src_path)

    resized = resize_textures(settings['maxTexture'])
    for img_name, before, after in resized:
        print(f'      texture {img_name}: {before} -> {after}')

    nocol_parts = mark_noncolliding(settings['nocolMaxSpan'])

    tris_before, tris_after = decimate(settings['triangles'])
    if tris_after != tris_before:
        print(f'      triangles: {tris_before:,} -> {tris_after:,}'
              f'  (budget {settings["triangles"]:,})')
    else:
        print(f'      triangles: {tris_before:,} (under budget, untouched)')

    nocol_tris = count_triangles_matching('_nocol') if nocol_parts else 0
    if nocol_parts:
        print(f'      _nocol: {nocol_parts} parts under '
              f'{settings["nocolMaxSpan"]} m, {nocol_tris:,} tris '
              f'({nocol_tris / tris_after * 100:.0f}%) out of collision')

    # After decimation, so the collapse pass never touches the proxy — a hull
    # decimated to the asset's ratio is exactly the sliver-ridden mesh the hull
    # was chosen to avoid.
    stem = os.path.splitext(os.path.basename(out_path))[0]
    proxy_tris = build_collision_proxy(
        settings['collisionProxy'], settings['collisionProxyAngle'], stem)
    if proxy_tris:
        was = tris_after - nocol_tris
        print(f'      _col: {settings["collisionProxy"]} @ '
              f'{settings["collisionProxyAngle"]}deg -> {proxy_tris:,} tris, '
              f'replacing {was:,} ({was / proxy_tris:.0f}x cheaper)')

    if dry:
        print('      [dry] not written')
        return None

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_image_format='WEBP',
        export_image_quality=settings['quality'],
        use_selection=False,
    )
    out_mb = os.path.getsize(out_path) / 1e6
    saved = (1 - out_mb / src_mb) * 100 if src_mb else 0
    verb = 'smaller' if saved >= 0 else 'LARGER'
    print(f'      -> {os.path.basename(out_path)}  {out_mb:.1f} MB  ({abs(saved):.0f}% {verb})')
    return {'srcMB': round(src_mb, 2), 'outMB': round(out_mb, 2),
            'trisBefore': tris_before, 'trisAfter': tris_after,
            'nocolParts': nocol_parts, 'nocolTris': nocol_tris,
            'proxyTris': proxy_tris}


def main():
    args = parse_args()

    # Created eagerly so the drop-off point is discoverable without reading docs.
    if not os.path.isdir(SOURCE_DIR):
        os.makedirs(SOURCE_DIR, exist_ok=True)
        print(f'created {os.path.relpath(SOURCE_DIR, GAME_DIR)}/ — put raw assets there')

    cfg = load_json(CONFIG, None)
    if cfg is None:
        cfg = write_default_config()
        print(f'wrote {os.path.relpath(CONFIG, GAME_DIR)} (defaults)')

    cache = {} if args['force'] else load_json(CACHE, {})
    sources = sorted(f for f in os.listdir(SOURCE_DIR) if f.lower().endswith('.glb'))
    if not sources:
        print(f'nothing in {os.path.relpath(SOURCE_DIR, GAME_DIR)}/ — nothing to do '
              f'(models go there as .glb)')
        return

    print(f'\nassets:build — {len(sources)} model(s)\n')
    built, skipped = 0, 0

    jobs = [(n, os.path.join(SOURCE_DIR, n), os.path.join(OUT_DIR, n),
             settings_for(cfg, n), process) for n in sources]

    for name, src, out, settings, build in jobs:
        key = digest(src, settings)
        if cache.get(name, {}).get('digest') == key and os.path.exists(out):
            print(f'  {name}  unchanged, skipped')
            skipped += 1
            continue
        stats = build(src, out, settings, args['dry'])
        if stats is not None:
            cache[name] = {'digest': key, **stats}
            built += 1

    if not args['dry']:
        with open(CACHE, 'w') as f:
            json.dump(cache, f, indent=2)
            f.write('\n')

    print(f'\n{built} built, {skipped} unchanged')
    if built:
        print('run `node tests/perf.mjs` to check the result against the budget')


main()
