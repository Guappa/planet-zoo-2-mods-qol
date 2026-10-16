"""Builds the PZ2QoL logo scene in Blender, renders it, and saves the .blend.

Run headless:
  blender -b --factory-startup -P art/logo/build_logo.py -- [--res 2048] [--samples 512]
      [--out path.png] [--save path.blend] [--transparent]

The scene is built in "badge space" (XY plane, +Z toward the viewer) under the empty
"Logo", which is rotated so the badge faces a camera on world -Y.
"""
import math
import os
import random
import sys

import bpy
from mathutils import Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    if name in argv:
        return type(default)(argv[argv.index(name) + 1])
    return default


RES = arg("--res", 2048)
SAMPLES = arg("--samples", 512)
OUT = arg("--out", "")
SAVE = arg("--save", "")
TRANSPARENT = "--transparent" in argv

random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------------------------------------------------------- helpers

ROOT = bpy.data.objects.new("Logo", None)
scene.collection.objects.link(ROOT)


def link(obj, parent=ROOT):
    if obj.name not in scene.collection.objects:
        scene.collection.objects.link(obj)
    obj.parent = parent
    return obj


def from_ops(parent=ROOT):
    obj = bpy.context.active_object
    for c in obj.users_collection:
        c.objects.unlink(obj)
    scene.collection.objects.link(obj)
    obj.parent = parent
    return obj


def smooth(obj, angle=40):
    me = obj.data
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    try:
        me.set_sharp_from_angle(angle=math.radians(angle))
    except AttributeError:
        pass


def apply_modifiers(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)


def to_mesh_object(src, name):
    """Evaluated mesh of a text/metaball object as a new mesh object."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(src.evaluated_get(dg))
    obj = bpy.data.objects.new(name, me)
    bpy.data.objects.remove(src)
    return obj


def mesh_object(name, verts, faces, uvs=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    if uvs:
        layer = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for li in poly.loop_indices:
                layer.data[li].uv = uvs[me.loops[li].vertex_index]
    me.update()
    return bpy.data.objects.new(name, me)


def set_mat(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


# ---------------------------------------------------------------- materials

def new_material(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    return m, nt, out


def principled(name, color, metallic=0.0, rough=0.5, **inputs):
    m, nt, out = new_material(name)
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.location = (200, 0)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    for k, v in inputs.items():
        b.inputs[k].default_value = v
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    return m, nt, b


def add_roughness_noise(nt, bsdf, lo, hi, scale=18.0):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = 6
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["To Min"].default_value = lo
    mr.inputs["To Max"].default_value = hi
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    nt.links.new(nz.outputs["Fac"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], bsdf.inputs["Roughness"])


GOLD_COLOR = (1.0, 0.70, 0.30)

MAT_GOLD, nt, b = principled("Gold polished", GOLD_COLOR, 1.0, 0.16)
add_roughness_noise(nt, b, 0.12, 0.22)

# Rim gold: coin reeding on the outer wall (angle stripes masked by the wall normal).
MAT_RIM, nt, b = principled("Gold rim", (1.0, 0.72, 0.34), 1.0, 0.13)
add_roughness_noise(nt, b, 0.10, 0.16, 70)
tc = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
at = nt.nodes.new("ShaderNodeMath"); at.operation = "ARCTAN2"
mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = 120
sn = nt.nodes.new("ShaderNodeMath"); sn.operation = "SINE"
geo = nt.nodes.new("ShaderNodeNewGeometry")
nsep = nt.nodes.new("ShaderNodeSeparateXYZ")
nabs = nt.nodes.new("ShaderNodeMath"); nabs.operation = "ABSOLUTE"
wall = nt.nodes.new("ShaderNodeMath"); wall.operation = "LESS_THAN"; wall.inputs[1].default_value = 0.3
mask = nt.nodes.new("ShaderNodeMath"); mask.operation = "MULTIPLY"
bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.15
bump.inputs["Distance"].default_value = 0.004
nt.links.new(tc.outputs["Object"], sep.inputs[0])
nt.links.new(sep.outputs["Y"], at.inputs[0]); nt.links.new(sep.outputs["X"], at.inputs[1])
nt.links.new(at.outputs[0], mul.inputs[0]); nt.links.new(mul.outputs[0], sn.inputs[0])
nt.links.new(geo.outputs["Normal"], nsep.inputs[0])
nt.links.new(nsep.outputs["Y"], nabs.inputs[0])  # badge-space Z is world -Y after the Logo rotation
nt.links.new(nabs.outputs[0], wall.inputs[0])
nt.links.new(sn.outputs[0], mask.inputs[0]); nt.links.new(wall.outputs[0], mask.inputs[1])
nt.links.new(mask.outputs[0], bump.inputs["Height"])
nt.links.new(bump.outputs[0], b.inputs["Normal"])

# Enamel: deep jungle teal under a clear coat, with an engraved sunburst.
MAT_ENAMEL, nt, b = principled("Enamel", (0.01, 0.13, 0.11), 0.0, 0.32,
                               **{"Coat Weight": 1.0, "Coat Roughness": 0.08})
tc = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
at = nt.nodes.new("ShaderNodeMath"); at.operation = "ARCTAN2"
mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = 36
sn = nt.nodes.new("ShaderNodeMath"); sn.operation = "SINE"
ln = nt.nodes.new("ShaderNodeVectorMath"); ln.operation = "LENGTH"
bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.25
bump.inputs["Distance"].default_value = 0.003
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.012, 0.13, 0.105, 1)
ramp.color_ramp.elements[1].color = (0.002, 0.03, 0.032, 1)
nt.links.new(tc.outputs["Object"], sep.inputs[0])
nt.links.new(sep.outputs["Y"], at.inputs[0]); nt.links.new(sep.outputs["X"], at.inputs[1])
nt.links.new(at.outputs[0], mul.inputs[0]); nt.links.new(mul.outputs[0], sn.inputs[0])
nt.links.new(sn.outputs[0], bump.inputs["Height"])
nt.links.new(bump.outputs[0], b.inputs["Normal"])
nt.links.new(tc.outputs["Object"], ln.inputs[0])
nt.links.new(ln.outputs["Value"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])

MAT_GLASS, _, _ = principled("Lens glass", (0.97, 0.99, 1.0), 0.0, 0.0,
                             **{"Transmission Weight": 1.0, "IOR": 1.3,
                                "Specular IOR Level": 0.2})
MAT_CHROME, nt, b = principled("Chrome", (0.92, 0.93, 0.95), 1.0, 0.08)

# Walnut grip: stretched noise rings along the handle axis.
MAT_WOOD, nt, b = principled("Walnut", (0.08, 0.035, 0.015), 0.0, 0.35,
                             **{"Coat Weight": 0.8, "Coat Roughness": 0.08})
tc = nt.nodes.new("ShaderNodeTexCoord")
mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (2, 30, 30)
wv = nt.nodes.new("ShaderNodeTexWave"); wv.inputs["Scale"].default_value = 3
wv.inputs["Distortion"].default_value = 6; wv.inputs["Detail"].default_value = 4
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.03, 0.012, 0.005, 1)
ramp.color_ramp.elements[1].color = (0.16, 0.075, 0.03, 1)
nt.links.new(tc.outputs["Object"], mp.inputs[0]); nt.links.new(mp.outputs[0], wv.inputs[0])
nt.links.new(wv.outputs["Fac"], ramp.inputs["Fac"]); nt.links.new(ramp.outputs[0], b.inputs["Base Color"])

MAT_RIBBON, nt, b = principled("Ribbon satin", (0.34, 0.005, 0.01), 0.0, 0.42,
                               **{"Specular IOR Level": 0.12})
MAT_RIBBON_BACK, _, _ = principled("Ribbon satin back", (0.1, 0.003, 0.006), 0.0, 0.45)
MAT_SUB_GOLD, _, _ = principled("Subtitle gold", (1.0, 0.82, 0.45), 1.0, 0.35)
MAT_TEXT, nt, b = principled("Text ivory", (0.93, 0.85, 0.66), 0.0, 0.25,
                             **{"Coat Weight": 1.0, "Coat Roughness": 0.05})

GEM_COLORS = {  # the mod's gene-score colours, left to right: >=80, >=60, >=40, below
    "green": (0.02, 0.75, 0.22),
    "blue": (0.03, 0.35, 0.95),
    "amber": (1.0, 0.62, 0.0),
    "red": (0.9, 0.03, 0.03),
}
GEM_MATS, GEM_FOILS = {}, {}
for gname, col in GEM_COLORS.items():
    GEM_FOILS[gname], _, _ = principled(f"Gem foil {gname}", col, 1.0, 0.2)
    GEM_MATS[gname], _, _ = principled(f"Gem {gname}", col, 0.0, 0.0,
                                       **{"Transmission Weight": 1.0, "IOR": 1.62,
                                          "Emission Color": (*col, 1), "Emission Strength": 0.4})

# Leaves: two-tone green with a pale midrib and side veins, part translucent.
MAT_LEAF, nt, _ = new_material("Leaf")
out = nt.nodes["Material Output"]
pb = nt.nodes.new("ShaderNodeBsdfPrincipled")
pb.inputs["Roughness"].default_value = 0.6
pb.inputs["Coat Weight"].default_value = 0.0
pb.inputs["Specular IOR Level"].default_value = 0.3
tl = nt.nodes.new("ShaderNodeBsdfTranslucent")
mix = nt.nodes.new("ShaderNodeMixShader"); mix.inputs[0].default_value = 0.15
uv = nt.nodes.new("ShaderNodeUVMap")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
cen = nt.nodes.new("ShaderNodeMath"); cen.operation = "SUBTRACT"; cen.inputs[1].default_value = 0.5
ab = nt.nodes.new("ShaderNodeMath"); ab.operation = "ABSOLUTE"
rib = nt.nodes.new("ShaderNodeMapRange")  # 1 on the midrib, 0 elsewhere
rib.inputs["From Min"].default_value = 0.012; rib.inputs["From Max"].default_value = 0.0
vk = nt.nodes.new("ShaderNodeMath"); vk.operation = "MULTIPLY"; vk.inputs[1].default_value = 0.9
vs = nt.nodes.new("ShaderNodeMath"); vs.operation = "ADD"
vf = nt.nodes.new("ShaderNodeMath"); vf.operation = "MULTIPLY"; vf.inputs[1].default_value = 85
vsin = nt.nodes.new("ShaderNodeMath"); vsin.operation = "SINE"
vpow = nt.nodes.new("ShaderNodeMapRange")
vpow.inputs["From Min"].default_value = 0.85; vpow.inputs["From Max"].default_value = 1.0
veins = nt.nodes.new("ShaderNodeMath"); veins.operation = "MAXIMUM"
nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 6
base = nt.nodes.new("ShaderNodeValToRGB")
base.color_ramp.elements[0].color = (0.006, 0.04, 0.008, 1)
base.color_ramp.elements[1].color = (0.05, 0.19, 0.03, 1)
vc = nt.nodes.new("ShaderNodeMix"); vc.data_type = "RGBA"
vc.inputs["B"].default_value = (0.25, 0.42, 0.1, 1)
vmul = nt.nodes.new("ShaderNodeMath"); vmul.operation = "MULTIPLY"; vmul.inputs[1].default_value = 0.06
bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.15
bump.inputs["Distance"].default_value = 0.003
oi = nt.nodes.new("ShaderNodeObjectInfo")  # per-leaf variation in hue and brightness
hue = nt.nodes.new("ShaderNodeMapRange"); hue.inputs["To Min"].default_value = 0.47
hue.inputs["To Max"].default_value = 0.54
val = nt.nodes.new("ShaderNodeMapRange"); val.inputs["To Min"].default_value = 0.65
val.inputs["To Max"].default_value = 1.15
hsv = nt.nodes.new("ShaderNodeHueSaturation")
nt.links.new(oi.outputs["Random"], hue.inputs["Value"]); nt.links.new(hue.outputs[0], hsv.inputs["Hue"])
nt.links.new(oi.outputs["Random"], val.inputs["Value"]); nt.links.new(val.outputs[0], hsv.inputs["Value"])
nt.links.new(uv.outputs["UV"], sep.inputs[0])
nt.links.new(sep.outputs["Y"], cen.inputs[0]); nt.links.new(cen.outputs[0], ab.inputs[0])
nt.links.new(ab.outputs[0], rib.inputs["Value"])
vcurve = nt.nodes.new("ShaderNodeMath"); vcurve.operation = "POWER"  # side veins curve toward the tip
vcurve.inputs[1].default_value = 0.6
nt.links.new(ab.outputs[0], vcurve.inputs[0]); nt.links.new(vcurve.outputs[0], vk.inputs[0])
nt.links.new(vk.outputs[0], vs.inputs[0])
nt.links.new(sep.outputs["X"], vs.inputs[1]); nt.links.new(vs.outputs[0], vf.inputs[0])
nt.links.new(vf.outputs[0], vsin.inputs[0]); nt.links.new(vsin.outputs[0], vpow.inputs["Value"])
nt.links.new(rib.outputs["Result"], veins.inputs[0]); nt.links.new(vpow.outputs["Result"], veins.inputs[1])
nt.links.new(uv.outputs["UV"], nz.inputs["Vector"]); nt.links.new(nz.outputs["Fac"], base.inputs["Fac"])
nt.links.new(veins.outputs[0], vmul.inputs[0])
nt.links.new(vmul.outputs[0], vc.inputs["Factor"])
nt.links.new(base.outputs[0], vc.inputs["A"])
nt.links.new(vc.outputs["Result"], hsv.inputs["Color"])
nt.links.new(hsv.outputs[0], pb.inputs["Base Color"])
nt.links.new(hsv.outputs[0], tl.inputs["Color"])
nt.links.new(veins.outputs[0], bump.inputs["Height"])
nt.links.new(bump.outputs[0], pb.inputs["Normal"])
nt.links.new(pb.outputs[0], mix.inputs[1]); nt.links.new(tl.outputs[0], mix.inputs[2])
nt.links.new(mix.outputs[0], out.inputs["Surface"])

# ---------------------------------------------------------------- medallion

RIM_R, FACE_R, RIM_TOP, FACE_Z = 1.0, 0.82, 0.1, 0.06

bpy.ops.mesh.primitive_cylinder_add(vertices=256, radius=RIM_R, depth=0.2)
body = from_ops(); body.name = "Medallion body"
bpy.ops.mesh.primitive_cylinder_add(vertices=256, radius=FACE_R, depth=0.2, location=(0, 0, 0.14))
cutter = bpy.context.active_object
boolean = body.modifiers.new("Recess", "BOOLEAN")
boolean.operation = "DIFFERENCE"; boolean.object = cutter; boolean.solver = "EXACT"
bev = body.modifiers.new("Bevel", "BEVEL")
bev.width = 0.05; bev.segments = 8; bev.limit_method = "ANGLE"
apply_modifiers(body)
bpy.data.objects.remove(cutter)
smooth(body)
set_mat(body, MAT_RIM)

bpy.ops.mesh.primitive_cylinder_add(vertices=256, radius=FACE_R - 0.002, depth=0.02,
                                    location=(0, 0, FACE_Z - 0.01))
face = from_ops(); face.name = "Enamel"
set_mat(face, MAT_ENAMEL)

bpy.ops.mesh.primitive_torus_add(major_radius=FACE_R - 0.004, minor_radius=0.02,
                                 major_segments=256, minor_segments=24, location=(0, 0, FACE_Z))
bead = from_ops(); bead.name = "Inner bead"; smooth(bead, 180)
set_mat(bead, MAT_GOLD)

# Score gems along the top of the rim.
GEM_R, GEM_RING = 0.075, (RIM_R + FACE_R) / 2 + 0.002
for i, gname in enumerate(GEM_COLORS):
    ang = math.radians(126 - i * 24)
    p = (GEM_RING * math.cos(ang), GEM_RING * math.sin(ang), RIM_TOP)
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=GEM_R, depth=0.01,
                                        location=(p[0], p[1], RIM_TOP + 0.002))
    o = from_ops(); o.name = f"Gem backing {gname}"; set_mat(o, GEM_FOILS[gname])
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=GEM_R,
                                         location=(p[0], p[1], RIM_TOP + 0.004))
    o = from_ops(); o.name = f"Gem {gname}"; o.scale = (1, 1, 0.62); smooth(o, 180)
    set_mat(o, GEM_MATS[gname])
    bpy.ops.mesh.primitive_torus_add(major_radius=GEM_R + 0.004, minor_radius=0.011,
                                     major_segments=96, minor_segments=16,
                                     location=(p[0], p[1], RIM_TOP + 0.006))
    o = from_ops(); o.name = f"Gem bezel {gname}"; smooth(o, 180); set_mat(o, MAT_GOLD)

# ---------------------------------------------------------------- paw print (domed reliefs)

PAW_OFFSET, PAW_SCALE = (-0.07, -0.03), 0.86


def dome(name, cx, cy, outline, height, rings=28, segs=160, exp=5):
    """Relief with a flat-topped dome profile over a star-shaped outline r(theta)."""
    verts, faces = [(0, 0, height)], []
    for i in range(1, rings + 1):
        rho = i / rings
        z = height * max(0.0, 1 - rho ** exp) ** 0.5 - 0.006 * (i == rings)
        for j in range(segs):
            th = 2 * math.pi * j / segs
            r = outline(th) * rho
            verts.append((r * math.cos(th), r * math.sin(th), z))
    for j in range(segs):
        faces.append((0, 1 + j, 1 + (j + 1) % segs))
    for i in range(rings - 1):
        a, b = 1 + i * segs, 1 + (i + 1) * segs
        for j in range(segs):
            k = (j + 1) % segs
            faces.append((a + j, b + j, b + k, a + k))
    s = PAW_SCALE
    verts = [((x + cx) * s + PAW_OFFSET[0], (y + cy) * s + PAW_OFFSET[1], z * s + FACE_Z - 0.004)
             for (x, y, z) in verts]
    o = link(mesh_object(name, verts, faces))
    smooth(o, 180)
    set_mat(o, MAT_GOLD)
    return o


def union_of_circles(circles, soften=6):
    def raw(th):
        ux, uy = math.cos(th), math.sin(th)
        best = 0.0
        for (x, y, r) in circles:
            b = ux * x + uy * y
            best = max(best, b + math.sqrt(max(0.0, b * b - (x * x + y * y) + r * r)))
        return best

    def soft(th):  # average a few neighbours to round the creases between lobes
        return sum(raw(th + (k - soften // 2) * 0.03) for k in range(soften)) / soften
    return soft


def smooth_outline(points, steps=24):
    """Closed Catmull-Rom curve through points, as r(theta) around the origin."""
    n, dense = len(points), []
    for i in range(n):
        p0, p1, p2, p3 = (Vector(points[(i + k) % n]) for k in (-1, 0, 1, 2))
        for s in range(steps):
            t = s / steps
            dense.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                                + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    polar = sorted((math.atan2(p.y, p.x) % (2 * math.pi), p.length) for p in dense)
    polar = [(a - 2 * math.pi, r) for a, r in polar[-2:]] + polar + \
            [(a + 2 * math.pi, r) for a, r in polar[:2]]

    def f(th):
        th %= 2 * math.pi
        for (a0, r0), (a1, r1) in zip(polar, polar[1:]):
            if a0 <= th <= a1:
                return r0 + (r1 - r0) * (th - a0) / max(a1 - a0, 1e-9)
        return polar[0][1]
    return f


def ellipse(a, b, rot):
    def f(th):
        t = th - rot
        return a * b / math.sqrt((b * math.cos(t)) ** 2 + (a * math.sin(t)) ** 2)
    return f


dome("Paw pad", 0, -0.215,
     smooth_outline([(x * 1.12, y * 1.12) for (x, y) in [
                     (0, 0.17), (0.1, 0.15), (0.18, 0.08), (0.255, -0.03), (0.29, -0.12),
                     (0.24, -0.19), (0.13, -0.218), (0, -0.226),
                     (-0.13, -0.218), (-0.24, -0.19), (-0.29, -0.12),
                     (-0.255, -0.03), (-0.18, 0.08), (-0.1, 0.15)]]), 0.08)
for k, (x, y, rot) in enumerate([(-0.375, 0.075, 30), (-0.165, 0.275, 9), (0.165, 0.275, -9),
                                 (0.375, 0.075, -30)]):
    dome(f"Paw toe {k + 1}", x, y, ellipse(0.118, 0.148, math.radians(90 + rot)), 0.068, exp=3)
# ---------------------------------------------------------------- magnifying glass

MAG = bpy.data.objects.new("Magnifier", None)
link(MAG)
LENS_R = 0.33
bpy.ops.mesh.primitive_torus_add(major_radius=LENS_R + 0.012, minor_radius=0.034,
                                 major_segments=192, minor_segments=32)
o = from_ops(MAG); o.name = "Lens ring"; o.scale = (1, 1, 1.25); smooth(o, 180); set_mat(o, MAT_CHROME)
bpy.ops.mesh.primitive_uv_sphere_add(segments=128, ring_count=64, radius=LENS_R + 0.01)
o = from_ops(MAG); o.name = "Lens"; o.scale = (1, 1, 0.07); smooth(o, 180); set_mat(o, MAT_GLASS)
o.visible_shadow = False  # no refracted ghost of the lens on the enamel


def x_cylinder(name, x0, x1, r, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=r, depth=x1 - x0,
                                        location=((x0 + x1) / 2, 0, 0),
                                        rotation=(0, math.radians(90), 0))
    o = from_ops(MAG); o.name = name
    if bevel:
        m = o.modifiers.new("Bevel", "BEVEL"); m.width = bevel; m.segments = 6
        m.limit_method = "ANGLE"
        apply_modifiers(o)
    smooth(o)
    set_mat(o, mat)
    return o


x_cylinder("Lens neck", LENS_R + 0.03, LENS_R + 0.17, 0.026, MAT_CHROME, 0.006)
x_cylinder("Ferrule", LENS_R + 0.15, LENS_R + 0.23, 0.05, MAT_GOLD, 0.012)
x_cylinder("Grip", LENS_R + 0.22, LENS_R + 0.70, 0.058, MAT_WOOD, 0.03).visible_glossy = False  # no brown smear in the rim
x_cylinder("End cap", LENS_R + 0.69, LENS_R + 0.74, 0.05, MAT_GOLD, 0.018)

MAG.location = (0.27, 0.04, 0.22)
MAG.scale = (0.72, 0.72, 0.72)
MAG.rotation_euler = (math.radians(-16), math.radians(-10), math.radians(-27))

# ---------------------------------------------------------------- ribbon banner

RIB_R, RIB_ZC, RIB_YC, RIB_ARCH = 2.3, 0.42, -0.8, 0.13
RIB_HALF_W, RIB_HALF_H = 1.32, 0.25


def wrap(x, y, d=0.0):
    a = x / RIB_R
    return ((RIB_R + d) * math.sin(a),
            y + RIB_ARCH * (x / RIB_HALF_W) ** 2,
            RIB_ZC - RIB_R + (RIB_R + d) * math.cos(a))


def grid(name, x0, x1, y0, y1, nx, ny, d=0.0, yshift=0.0):
    verts, faces = [], []
    for i in range(nx + 1):
        x = x0 + (x1 - x0) * i / nx
        for j in range(ny + 1):
            y = y0 + (y1 - y0) * j / ny
            verts.append(wrap(x, y + yshift, d))
    for i in range(nx):
        for j in range(ny):
            a = i * (ny + 1) + j
            faces.append((a, a + ny + 1, a + ny + 2, a + 1))
    return mesh_object(name, verts, faces)


band = link(grid("Ribbon", -RIB_HALF_W, RIB_HALF_W, RIB_YC - RIB_HALF_H, RIB_YC + RIB_HALF_H, 160, 4))
sol = band.modifiers.new("Thickness", "SOLIDIFY"); sol.thickness = 0.025
bev = band.modifiers.new("Bevel", "BEVEL"); bev.width = 0.006; bev.segments = 3; bev.limit_method = "ANGLE"
apply_modifiers(band); smooth(band, 50); set_mat(band, MAT_RIBBON)


def tail(sign):
    """Notched tail behind one end of the band, dropped a little and pushed back."""
    x_in, x_notch, x_out = 1.12, 1.62, 1.8
    h = RIB_HALF_H * 0.9
    drop, d = -0.15, -0.14
    verts, faces = [], []
    n = 24
    for i in range(n + 1):
        x = x_in + (x_notch - x_in) * i / n
        for y in (-h, 0, h):
            verts.append(wrap(sign * x, RIB_YC + drop + y, d))
    for i in range(n):
        a = i * 3
        faces += [(a, a + 3, a + 4, a + 1), (a + 1, a + 4, a + 5, a + 2)]
    last = n * 3
    verts.append(wrap(sign * x_out, RIB_YC + drop - h - 0.03, d))
    verts.append(wrap(sign * x_out, RIB_YC + drop + h + 0.03, d))
    faces += [(last, len(verts) - 2, last + 1), (last + 1, len(verts) - 1, last + 2)]
    if sign < 0:
        faces = [tuple(reversed(f)) for f in faces]
    o = link(mesh_object(f"Ribbon tail {'R' if sign > 0 else 'L'}", verts, faces))
    s = o.modifiers.new("Thickness", "SOLIDIFY"); s.thickness = 0.022
    apply_modifiers(o); smooth(o, 50); set_mat(o, MAT_RIBBON_BACK)
    # Fold: a dark triangle joining the band's end to the tail.
    xe = sign * (RIB_HALF_W - 0.005)
    fv = [wrap(xe, RIB_YC - RIB_HALF_H, -0.02), wrap(xe, RIB_YC + RIB_HALF_H * 0.4, -0.02),
          wrap(sign * x_in, RIB_YC + drop - h, d + 0.01)]
    f = link(mesh_object(f"Ribbon fold {'R' if sign > 0 else 'L'}", fv, [(0, 1, 2)]))
    s = f.modifiers.new("Thickness", "SOLIDIFY"); s.thickness = 0.02
    apply_modifiers(f); set_mat(f, MAT_RIBBON_BACK)


tail(1)
tail(-1)


def piping(name, y):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 0.013
    cu.bevel_resolution = 6
    sp = cu.splines.new("POLY")
    n = 160
    sp.points.add(n)
    for i in range(n + 1):
        x = -RIB_HALF_W + 2 * RIB_HALF_W * i / n
        sp.points[i].co = (*wrap(x, y, 0.004), 1)
    o = link(bpy.data.objects.new(name, cu))
    o.data.materials.append(MAT_GOLD)


piping("Ribbon piping top", RIB_YC + RIB_HALF_H - 0.03)
piping("Ribbon piping bottom", RIB_YC - RIB_HALF_H + 0.03)

# ---------------------------------------------------------------- text


def text_mesh(name, body, font_file, width, extrude, bevel, spacing=1.0):
    font = bpy.data.fonts.load(os.path.join(ASSETS, font_file), check_existing=True)
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.font = font
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = extrude
    cu.bevel_depth = bevel
    cu.bevel_resolution = 4
    cu.space_character = spacing
    cu.resolution_u = 24
    tmp = bpy.data.objects.new(name, cu)
    scene.collection.objects.link(tmp)
    bpy.context.view_layer.update()
    o = to_mesh_object(tmp, name)
    xs = [v.co.x for v in o.data.vertices]
    k = width / (max(xs) - min(xs))
    cx = (max(xs) + min(xs)) / 2
    ys = [v.co.y for v in o.data.vertices]
    cy = (max(ys) + min(ys)) / 2
    zmin = min(v.co.z for v in o.data.vertices)
    for v in o.data.vertices:
        v.co = ((v.co.x - cx) * k, (v.co.y - cy) * k, (v.co.z - zmin) * k)
    return o


title = text_mesh("Title", "PZ2 QoL", "LilitaOne-Regular.ttf", 1.3, 0.05, 0.012)
for v in title.data.vertices:
    v.co = wrap(v.co.x, v.co.y + RIB_YC + 0.02, v.co.z)
link(title); smooth(title, 35); set_mat(title, MAT_TEXT)

subtitle = text_mesh("Subtitle", "THE CURATOR’S TOOLKIT", "BarlowCondensed-ExtraBold.ttf",
                     2.7, 0.06, 0.008, spacing=1.02)
for v in subtitle.data.vertices:
    v.co = (v.co.x, v.co.y - 1.3, v.co.z + 0.18)
link(subtitle); smooth(subtitle, 35); set_mat(subtitle, MAT_SUB_GOLD)

MAT_PLAQUE, _, _ = principled("Plaque enamel", (0.004, 0.045, 0.04), 0.0, 0.3,
                              **{"Coat Weight": 1.0, "Coat Roughness": 0.3})


def rounded_box(name, w, h, d, z, radius, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -1.3, z))
    o = from_ops(); o.name = name
    o.data.transform(__import__("mathutils").Matrix.Diagonal((w, h, d, 1)))
    m = o.modifiers.new("Bevel", "BEVEL"); m.width = radius; m.segments = 10
    m.limit_method = "NONE"
    apply_modifiers(o); smooth(o, 50); set_mat(o, mat)
    return o


rounded_box("Plaque", 2.9, 0.32, 0.05, 0.155, 0.024, MAT_PLAQUE)
rounded_box("Plaque border", 2.98, 0.4, 0.05, 0.14, 0.024, MAT_RIM)

# ---------------------------------------------------------------- leaves

LEAVES = bpy.data.objects.new("Leaves", None)
link(LEAVES)


def leaf(name, length, width, fold, droop, nu=48, nv=10):
    verts, uvs, faces = [], [], []
    for i in range(nu + 1):
        t = i / nu
        w = width * math.sin(math.pi * t ** 0.72) ** 0.85
        for j in range(nv + 1):
            v = -1 + 2 * j / nv
            x = t * length
            y = v * w
            z = abs(v) * w * fold - droop * t * t + 0.03 * math.sin(v * 3 + t * 9) * t
            verts.append((x, y, z))
            uvs.append((t, 0.5 + 0.5 * v * (w / width)))
    for i in range(nu):
        for j in range(nv):
            a = i * (nv + 1) + j
            faces.append((a, a + nv + 1, a + nv + 2, a + 1))
    o = link(mesh_object(name, verts, faces, uvs), LEAVES)
    s = o.modifiers.new("Thickness", "SOLIDIFY"); s.thickness = 0.006
    smooth(o, 180)
    set_mat(o, MAT_LEAF)
    return o


# (angle deg, length, width, depth z, roll, pitch)
LEAF_SPECS = [
    (28, 2.2, 0.36, -0.35, 15, 12), (62, 2.0, 0.38, -0.5, -20, 18),
    (118, 2.0, 0.38, -0.48, 20, 18), (158, 2.05, 0.36, -0.33, -15, 12),
    (8, 1.5, 0.34, -0.7, 30, 22), (172, 1.5, 0.34, -0.68, -30, 22),
    (-18, 1.8, 0.34, -0.45, 10, 10), (198, 1.8, 0.34, -0.42, -10, 10),
    (90, 1.7, 0.36, -0.75, 0, 26), (42, 1.6, 0.3, -0.9, 25, 28), (138, 1.6, 0.3, -0.9, -25, 28),
]
for k, (ang, L, W, z, roll, pitch) in enumerate(LEAF_SPECS):
    o = leaf(f"Leaf {k:02d}", L, W, fold=0.6, droop=0.25 * L)
    o.location = (0.15 * math.cos(math.radians(ang)), 0.15 * math.sin(math.radians(ang)) + 0.05, z)
    o.rotation_euler = (math.radians(roll), math.radians(pitch), math.radians(ang))

# ---------------------------------------------------------------- placement, camera, lights

ROOT.rotation_euler = (math.radians(90), 0, 0)
ROOT.location = (0, 0, 0.12)

cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 85
cam_data.sensor_fit = "VERTICAL"  # same framing height for square and 16:9 renders
cam_data.sensor_height = 36
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = 2.2
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
cam.location = (arg("--cam-x", -0.82), arg("--cam-dist", -8.8), arg("--cam-z", -0.86))
target = bpy.data.objects.new("Camera target", None)
scene.collection.objects.link(target)
target.location = (0, 0, 0.0)
tr = cam.constraints.new("TRACK_TO"); tr.target = target
tr.track_axis = "TRACK_NEGATIVE_Z"; tr.up_axis = "UP_Y"
cam_data.dof.focus_distance = (Vector(target.location) - Vector(cam.location)).length - 0.4
scene.camera = cam


def area(name, loc, size, energy, color, size_y=None):
    ld = bpy.data.lights.new(name, "AREA")
    ld.energy = energy
    ld.color = color
    if size_y:
        ld.shape = "RECTANGLE"; ld.size = size; ld.size_y = size_y
    else:
        ld.size = size
    o = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(o)
    o.location = loc
    c = o.constraints.new("TRACK_TO"); c.target = target
    c.track_axis = "TRACK_NEGATIVE_Z"; c.up_axis = "UP_Y"
    return o


area("Key", (-4.5, -5.5, 5.0), 4.0, 3200, (1.0, 0.9, 0.78))
area("Fill", (5.5, -4.5, 0.5), 5.0, 600, (0.8, 0.9, 1.0))
area("Back", (1.5, 5.0, 4.5), 3.0, 2500, (1.0, 0.85, 0.6))
area("Top strip", (0.0, -3.5, 5.5), 7.0, 1200, (1.0, 0.97, 0.92), size_y=1.0)

# World: rainforest HDRI. Camera rays get a jittered lookup, which converges to a soft blur,
# and are dimmed so the badge stands out.
world = bpy.data.worlds.new("Rainforest")
scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
nt = world.node_tree
nt.nodes.clear()
wout = nt.nodes.new("ShaderNodeOutputWorld")
tc = nt.nodes.new("ShaderNodeTexCoord")
wn = nt.nodes.new("ShaderNodeTexWhiteNoise"); wn.noise_dimensions = "3D"
sub = nt.nodes.new("ShaderNodeVectorMath"); sub.operation = "SUBTRACT"
sub.inputs[1].default_value = (0.5, 0.5, 0.5)
scl = nt.nodes.new("ShaderNodeVectorMath"); scl.operation = "SCALE"
scl.inputs["Scale"].default_value = arg("--blur", 0.05)
add = nt.nodes.new("ShaderNodeVectorMath"); add.operation = "ADD"
lp = nt.nodes.new("ShaderNodeLightPath")
vmix = nt.nodes.new("ShaderNodeMix"); vmix.data_type = "VECTOR"
mp = nt.nodes.new("ShaderNodeMapping")
mp.inputs["Rotation"].default_value = (math.radians(arg("--hdri-tilt", 0.0)), 0, math.radians(arg("--hdri-rot", 0.0)))
env = nt.nodes.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(os.path.join(ASSETS, "rainforest_trail_4k.hdr"), check_existing=True)
smix = nt.nodes.new("ShaderNodeMix"); smix.data_type = "FLOAT"
smix.inputs["A"].default_value = 0.9
smix.inputs["B"].default_value = arg("--bg", 0.6)
vsep = nt.nodes.new("ShaderNodeSeparateXYZ")  # vignette: falls off away from the view axis (+Y)
vpow = nt.nodes.new("ShaderNodeMath"); vpow.operation = "POWER"
vpow.inputs[1].default_value = arg("--vignette", 16.0)
vmul = nt.nodes.new("ShaderNodeMath"); vmul.operation = "MULTIPLY"
vmul.inputs[1].default_value = arg("--bg", 0.5)
nt.links.new(tc.outputs["Generated"], vsep.inputs[0])
nt.links.new(vsep.outputs["Y"], vpow.inputs[0])
nt.links.new(vpow.outputs[0], vmul.inputs[0])
nt.links.new(vmul.outputs[0], smix.inputs["B"])
bg = nt.nodes.new("ShaderNodeBackground")
nt.links.new(tc.outputs["Generated"], wn.inputs["Vector"])
nt.links.new(wn.outputs["Color"], sub.inputs[0])
nt.links.new(sub.outputs[0], scl.inputs[0])
nt.links.new(tc.outputs["Generated"], add.inputs[0]); nt.links.new(scl.outputs[0], add.inputs[1])
blur_rays = nt.nodes.new("ShaderNodeMath"); blur_rays.operation = "MAXIMUM"  # reflections see the blurred backdrop too
nt.links.new(lp.outputs["Is Camera Ray"], blur_rays.inputs[0])
nt.links.new(lp.outputs["Is Glossy Ray"], blur_rays.inputs[1])
nt.links.new(blur_rays.outputs[0], vmix.inputs["Factor"])
nt.links.new(tc.outputs["Generated"], vmix.inputs["A"]); nt.links.new(add.outputs[0], vmix.inputs["B"])
nt.links.new(vmix.outputs["Result"], mp.inputs["Vector"])
nt.links.new(mp.outputs[0], env.inputs["Vector"])
nt.links.new(lp.outputs["Is Camera Ray"], smix.inputs["Factor"])
nt.links.new(env.outputs["Color"], bg.inputs["Color"])
nt.links.new(smix.outputs["Result"], bg.inputs["Strength"])
nt.links.new(bg.outputs[0], wout.inputs["Surface"])

# ---------------------------------------------------------------- render settings

scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
for dev_type in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = dev_type
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == dev_type]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == dev_type
            scene.cycles.device = "GPU"
            break
    except Exception:
        continue
scene.cycles.samples = SAMPLES
scene.cycles.use_adaptive_sampling = True
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 16
scene.cycles.transmission_bounces = 16
scene.cycles.glossy_bounces = 8
scene.cycles.caustics_reflective = False
scene.cycles.caustics_refractive = False
scene.cycles.blur_glossy = 0.5
scene.render.resolution_x = arg("--width", RES)
scene.render.resolution_y = RES
scene.render.resolution_percentage = 100
scene.render.film_transparent = TRANSPARENT
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA" if TRANSPARENT else "RGB"
scene.render.image_settings.color_depth = "16" if TRANSPARENT else "8"
scene.view_settings.view_transform = "AgX"
for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
    try:
        scene.view_settings.look = look
        break
    except TypeError:
        continue
scene.view_settings.exposure = arg("--exposure", -0.9)

if TRANSPARENT:
    LEAVES.hide_render = True
    for o in LEAVES.children:
        o.hide_render = True

if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(SAVE), relative_remap=True, compress=True)
if OUT:
    scene.render.filepath = os.path.abspath(OUT)
    bpy.ops.render.render(write_still=True)
