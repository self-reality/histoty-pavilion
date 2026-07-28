"""Blender <-> PlayCanvas coordinate conversion. Shared by the scene tools.

Blender is Z-up right-handed; PlayCanvas is Y-up right-handed. The two worlds
are related by a single 90 degree rotation about X:

    blender_point = Rx(+90) * playcanvas_point
    playcanvas_point = Rx(-90) * blender_point

i.e. PlayCanvas (x, y, z) -> Blender (x, -z, y), and back again
     Blender (x, y, z) -> PlayCanvas (x, z, -y).

Whole transforms convert by conjugation rather than by that point formula. A
prop's anchor in Blender holds `P`; the entity transform the game applies is
`T`; the imported glTF payload sits under both. Because Blender's glTF importer
already rotates the payload by Rx(+90) on the way in, the two are related by

    P = PC2B * T * B2PC          (game manifest -> .blend, build_blend.py)
    T = B2PC * P * PC2B          (.blend -> placements, export_scene.py)

Both directions live here so they cannot drift apart.

Euler note: PlayCanvas `setEulerAngles(x, y, z)` composes as Rz*Ry*Rx, which is
exactly Blender's 'XYZ' euler order — so euler triples pass across unchanged
once the matrix conversion above has been applied. Quaternions are still the
wire format (see export_scene.py); the eulers are emitted for human review.
"""

from math import degrees, radians

from mathutils import Matrix, Euler, Quaternion

# Blender-space -> PlayCanvas-space, and its inverse.
B2PC = Matrix.Rotation(radians(-90), 4, 'X')
PC2B = Matrix.Rotation(radians(90), 4, 'X')


def pc_trs_to_matrix(pos, euler_deg=None, scale=None, quat_xyzw=None):
    """Build a PlayCanvas-space matrix from manifest-style TRS fields.

    `quat_xyzw` (PlayCanvas Quat component order) wins over `euler_deg` when
    both are present, matching the game loader's precedence.
    """
    t = Matrix.Translation(pos or (0, 0, 0))
    if quat_xyzw:
        x, y, z, w = quat_xyzw
        # Normalize: a quaternion rounded for storage is no longer exactly unit
        # length, and to_matrix() does not renormalize — the excess would come
        # back out of the next decompose() as scale (1.00001, ...) and compound
        # over build/export cycles.
        r = Quaternion((w, x, y, z)).normalized().to_matrix().to_4x4()
    else:
        ex, ey, ez = euler_deg or (0, 0, 0)
        r = Euler((radians(ex), radians(ey), radians(ez)), 'XYZ').to_matrix().to_4x4()
    sx, sy, sz = scale or (1, 1, 1)
    s = Matrix.Diagonal((sx, sy, sz, 1.0))
    return t @ r @ s


def pc_to_blender(matrix_pc):
    """PlayCanvas entity transform -> world matrix for its Blender anchor."""
    return PC2B @ matrix_pc @ B2PC


def blender_to_pc(matrix_world):
    """Blender anchor world matrix -> PlayCanvas entity transform."""
    return B2PC @ matrix_world @ PC2B


def decompose_pc(matrix_world):
    """Blender anchor -> the dict the game manifest/placements format expects."""
    loc, quat, scale = blender_to_pc(matrix_world).decompose()
    euler = quat.to_euler('XYZ')

    # 1e-5 is ~10 microns of position and ~0.001 deg of rotation: far below
    # anything visible, and coarse enough to swallow two kinds of noise —
    # matrix-decompose slop (2.999999... -> 3.0), and the ~1e-7 that a rebuild
    # picks up from Blender storing object transforms as float32. Going *finer*
    # here made rebuilds drift in the last digit every cycle.
    def r(v):
        return round(v, 5) + 0.0  # +0.0 folds -0.0 into 0.0

    return {
        'pos': [r(loc.x), r(loc.y), r(loc.z)],
        # PlayCanvas Quat component order is (x, y, z, w); mathutils is (w,x,y,z).
        'rot': [r(quat.x), r(quat.y), r(quat.z), r(quat.w)],
        'euler': [round(degrees(v), 4) + 0.0 for v in (euler.x, euler.y, euler.z)],
        'scale': [r(scale.x), r(scale.y), r(scale.z)],
    }
