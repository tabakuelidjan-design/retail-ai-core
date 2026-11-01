"""Nordla Création — moteur de plateau 3D (local, 0 €). Construit la scène décrite par un STAGE validé (contrat
stage-contract.js) : aucune position n'est écrite à la main, tout découle du vocabulaire fermé choisi par le Brain.
Le produit n'est JAMAIS rendu : une forme de substitution invisible porte ses ombres, une carte portant la vraie photo
porte son reflet ; la photo réelle est composée ensuite (compose_stage.py).
Usage : blender-python render_stage.py -- <stage.json> <examen.json> <produit_rgba.png> <largeur> <hauteur> <échantillons> <sortie.png>
"""
import json, math, sys
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

a = sys.argv[sys.argv.index('--') + 1:]
STAGE = json.load(open(a[0])); EXAM = json.load(open(a[1])); PRODUCT = a[2]
RES = (int(a[3]), int(a[4])); SAMPLES = int(a[5]); OUT = a[6]
H = 2.6
ASPECT = EXAM['aspect_w_over_h']; W = H * ASPECT
FONT = '/usr/share/fonts/opentype/inter/InterDisplay-Black.otf'

def srgb(hexs):
    h = hexs.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)
TONE = {'DEEP_BLACK': (0.0035, 0.0035, 0.004), 'CHARCOAL': (0.018, 0.018, 0.02), 'BRAND_NAVY': srgb('#0F2A52'), 'BRAND_TERRACOTTA': srgb('#C56E54'),
        'COOL_GREY': (0.16, 0.17, 0.18), 'WHITE': (0.78, 0.78, 0.78)}
MATERIAL = {'MATTE_BLACK': ((0.009, 0.009, 0.01), 0.45, 0.5, 0), 'BRAND_NAVY': (srgb('#0F2A52'), 0.5, 0.4, 0), 'BRAND_TERRACOTTA': (srgb('#C56E54'), 0.6, 0.35, 0),
            'CONCRETE': ((0.16, 0.16, 0.16), 0.9, 0.2, 0), 'BRUSHED_STEEL': ((0.55, 0.56, 0.58), 0.28, 0.5, 1), 'FROSTED_GLASS': ((0.9, 0.92, 0.95), 0.35, 0.5, 0),
            'PAPER_WHITE': ((0.8, 0.8, 0.79), 0.75, 0.3, 0)}
ROUGH = {'MATTE': 0.85, 'SATIN': 0.32, 'MIRROR': 0.06}
LEVEL = {'LOW': 0.35, 'MEDIUM': 1.0, 'HIGH': 2.2}
SIZE = {'LOW': 0.35, 'MEDIUM': 0.7, 'HIGH': 1.1}
TEMP = {'COOL': (0.82, 0.9, 1.0), 'NEUTRAL': (1, 1, 1), 'WARM': (1.0, 0.86, 0.72)}

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = RES
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
tone = TONE[STAGE['backdrop_tone']]
world.node_tree.nodes['Background'].inputs['Color'].default_value = (*[c * 0.25 for c in tone], 1)

def principled(name, color, rough, spec=0.5, metal=0, transmission=0):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if 'Specular IOR Level' in b.inputs: b.inputs['Specular IOR Level'].default_value = spec
    if transmission and 'Transmission Weight' in b.inputs: b.inputs['Transmission Weight'].default_value = transmission
    return m

# --- produit : socle éventuel, forme de substitution, carte de reflet
plinth = next((p for p in STAGE['props'] if p['shape'] == 'PLINTH'), None)
z0 = SIZE[plinth['scale']] * 0.5 * H if plinth else 0.0
cylinder_like = ASPECT < 0.55
if cylinder_like:
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=W / 2, depth=H * 0.95, location=(0, 0, z0 + H * 0.95 / 2))
else:
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, z0 + H / 2)); bpy.context.object.scale = (W, W * 0.12, H)
proxy = bpy.context.object; proxy.data.materials.append(principled('proxy', (0.02, 0.02, 0.02), 0.5))
proxy.visible_camera = False; proxy.visible_glossy = False
front_y = -(W / 2 if cylinder_like else W * 0.06)
img = bpy.data.images.load(PRODUCT)
cm = bpy.data.materials.new('carte'); cm.use_nodes = True; nt = cm.node_tree
tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
em = nt.nodes.new('ShaderNodeEmission'); em.inputs['Strength'].default_value = 0.35
tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mx = nt.nodes.new('ShaderNodeMixShader')
nt.links.new(tex.outputs['Color'], em.inputs['Color']); nt.links.new(tex.outputs['Alpha'], mx.inputs['Fac'])
nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(em.outputs[0], mx.inputs[2]); nt.links.new(mx.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
bb = EXAM['bbox']; sw, sh = EXAM['source']['width'], EXAM['source']['height']
k = H / bb['h']
cx_img = bb['x'] + bb['w'] / 2
bpy.ops.mesh.primitive_plane_add(size=1, location=((sw / 2 - cx_img) * k, front_y - 0.002, z0 - (sh - (bb['y'] + bb['h'])) * k + sh * k / 2), rotation=(math.radians(90), 0, 0))
card = bpy.context.object; card.scale = (sw * k, sh * k, 1); card.data.materials.append(cm)
card.visible_camera = False; card.visible_shadow = False; card.visible_diffuse = False

# --- décor
floor_m = principled('sol', tuple(c * 0.7 for c in tone), ROUGH[STAGE['floor_finish']], 0.5)
if STAGE['backdrop'] == 'SEAMLESS_SWEEP':
    import bmesh
    prof = [(y, 0.0) for y in (-40, -10, 0, 1.5 * H)]
    R0 = 1.6 * H
    for i in range(1, 17):
        t = math.radians(90 * i / 16); prof.append((1.5 * H + R0 * math.sin(t), R0 * (1 - math.cos(t))))
    prof += [(1.5 * H + R0, 30.0)]
    me = bpy.data.meshes.new('cyclo'); bm = bmesh.new()
    rows = [[bm.verts.new((x, y, z)) for (y, z) in prof] for x in (-60, 60)]
    for i in range(len(prof) - 1): bm.faces.new((rows[0][i], rows[1][i], rows[1][i + 1], rows[0][i + 1]))
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('cyclo', me); bpy.context.collection.objects.link(ob)
    for p in ob.data.polygons: p.use_smooth = True
    sweep = principled('cyclo', tone, 0.75, 0.3); ob.data.materials.append(sweep)
    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, 0.0005)); bpy.context.object.data.materials.append(floor_m)
    bpy.context.object.scale = (1, 1, 1); bpy.context.object.location.y = -30
else:
    bpy.ops.mesh.primitive_plane_add(size=160, location=(0, 0, 0)); bpy.context.object.data.materials.append(floor_m)
    if STAGE['backdrop'] == 'WALL_AND_FLOOR':
        bpy.ops.mesh.primitive_plane_add(size=160, location=(0, 2.2 * H, 30), rotation=(math.radians(90), 0, 0))
        bpy.context.object.data.materials.append(principled('mur', tone, 0.85, 0.2))

# --- accessoires
def place(p, size):
    off = W / 2 + 0.25 * H + size * 0.45
    return {'BEHIND': (0, 0.9 * H + size * 0.3, 0), 'BESIDE_LEFT': (-off, 0.15 * H, 0), 'BESIDE_RIGHT': (off, 0.15 * H, 0),
            'FOREGROUND_LEFT': (-(W / 2 + 0.3 * H + size * 0.3), -0.85 * H, 0), 'FOREGROUND_RIGHT': (W / 2 + 0.3 * H + size * 0.3, -0.85 * H, 0), 'BENEATH': (0, 0, 0)}[p['placement']]
foreground = []
for i, p in enumerate(STAGE['props']):
    size = SIZE[p['scale']] * H
    col, rough, spec, metal = MATERIAL[p['material']]
    mat = principled(f'm{i}', col, rough, spec, metal, transmission=0.6 if p['material'] == 'FROSTED_GLASS' else 0)
    x, y, _ = place(p, size)
    s = p['shape']
    if s == 'PLINTH':
        ph = size * 0.5; bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=max(W * 0.9, 0.5 * H * 0.6), depth=ph, location=(0, 0, ph / 2))
    elif s == 'BLOCK':
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, size / 2)); bpy.context.object.scale = (size * 0.7, size * 0.7, size)
    elif s == 'CYLINDER':
        bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=size * 0.28, depth=size, location=(x, y, size / 2))
    elif s == 'SPHERE':
        bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=size * 0.4, location=(x, y, size * 0.4))
    elif s == 'PANEL':
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y + 0.2 * H, size * 0.7)); bpy.context.object.scale = (size * 0.9, 0.05 * H, size * 1.4)
    elif s == 'ARCH':
        bpy.ops.mesh.primitive_torus_add(major_radius=size * 0.5, minor_radius=size * 0.09, location=(x, y + 0.2 * H, 0), rotation=(math.radians(90), 0, 0))
    elif s == 'EXTRUDED_WORD':
        cu = bpy.data.curves.new(f'w{i}', 'FONT'); cu.body = p['word']; cu.font = bpy.data.fonts.load(FONT); cu.align_x = 'CENTER'; cu.extrude = 0.12 * H; cu.bevel_depth = 0.01 * H
        ob = bpy.data.objects.new(f'w{i}', cu); bpy.context.collection.objects.link(ob)
        ob.rotation_euler = (math.radians(90), 0, 0); ob.scale = (size * 1.35,) * 3
        bpy.context.view_layer.update()
        ob.location = (x, y + 0.25 * H, 0); bpy.context.view_layer.update()
        zmin = min((ob.matrix_world @ Vector(c)).z for c in ob.bound_box); ob.location.z -= zmin
        bpy.context.view_layer.objects.active = ob
    o = bpy.context.object if s != 'EXTRUDED_WORD' else ob
    o.data.materials.append(mat)
    if p['placement'].startswith('FOREGROUND'): foreground.append(o)

# --- lumière
zc = z0 + H / 2; R = 3.0 * H
def area(name, loc, sx, sy, energy, color, spread=None):
    l = bpy.data.lights.new(name, 'AREA'); l.shape = 'RECTANGLE'; l.size = sx; l.size_y = sy; l.energy = energy; l.color = color
    if spread is not None: l.spread = math.radians(spread)
    o = bpy.data.objects.new(name, l); o.location = loc; bpy.context.collection.objects.link(o); return o
def aim(o, t):
    d = Vector(t) - o.location; o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
POS = {'LEFT': (-R, -0.6 * R, zc + 0.3 * H), 'RIGHT': (R, -0.6 * R, zc + 0.3 * H), 'FRONT': (0, -R, zc + 0.5 * H), 'BACK': (0, R, zc + 0.4 * H), 'TOP': (0, -0.2 * R, zc + 2.2 * H)}
scale_e = (R / 7.8) ** 2
slit_z = None
for i, L in enumerate([STAGE['key_light'], *STAGE['accent_lights']]):
    e = LEVEL[L['intensity']] * scale_e; col = TEMP[L['temperature']]; pos = POS[L['side']]
    kind = L['kind']
    if kind == 'SOFTBOX': o = area(f'l{i}', pos, 1.2 * H, 1.2 * H, 420 * e, col); aim(o, (0, 0, zc))
    elif kind == 'STRIP': o = area(f'l{i}', pos, 0.35 * H, 2.4 * H, 330 * e, col); aim(o, (0, 0, zc))
    elif kind == 'RIM':
        side = -1 if L['side'] == 'LEFT' else 1
        o = area(f'l{i}', (side * 0.9 * R, 0.7 * R, zc), 0.3 * H, 2.2 * H, 170 * e, col); aim(o, (side * W * 0.3, 0, zc))
    elif kind == 'SPOT':
        l = bpy.data.lights.new(f'l{i}', 'SPOT'); l.energy = 2600 * e; l.spot_size = math.radians(28); l.spot_blend = 0.35; l.color = col; l.shadow_soft_size = 0.05 * H
        o = bpy.data.objects.new(f'l{i}', l); o.location = pos; bpy.context.collection.objects.link(o); aim(o, (0, 0, zc))
    elif kind == 'SLIT_SHEET':
        slit_z = zc; side = {'LEFT': (-3.5 * R, 0), 'RIGHT': (3.5 * R, 0)}.get(L['side'], (0, -3.5 * R))
        o = area(f'l{i}', (side[0], side[1], slit_z), 6 * H, 0.018 * H, 1500 * e * (3.5 ** 2) / 1.0 / 12, col, spread=0.5)
        aim(o, (0, 0 if side[1] == 0 else 2 * H, slit_z))

# --- caméra
cam_d = bpy.data.cameras.new('cam'); cam_d.lens = {'WIDE': 50, 'MEDIUM': 85, 'CLOSE': 85}[STAGE['camera']['framing']]
portrait = RES[1] >= RES[0]
cam_d.sensor_fit = 'VERTICAL' if portrait else 'HORIZONTAL'; cam_d.sensor_width = 36; cam_d.sensor_height = 36 * RES[1] / RES[0] if portrait else 36 * RES[1] / RES[0]
vfov = 2 * math.atan((cam_d.sensor_height / 2) / cam_d.lens)
share = {'WIDE': 0.36, 'MEDIUM': 0.55, 'CLOSE': 0.70}[STAGE['camera']['framing']]
D = ((H + z0 * 0.5) / share) / (2 * math.tan(vfov / 2))
cz = {'LOW': z0 + 0.25 * H, 'PRODUCT_CENTER': z0 + 0.5 * H, 'HIGH': z0 + 1.35 * H}[STAGE['camera']['height']]
if slit_z is not None: cz = slit_z  # une nappe de lumière ne reste une ligne que vue à sa hauteur
frame_w = 2 * D * math.tan(vfov / 2) * RES[0] / RES[1]
shift = {'LEFT_THIRD': frame_w / 6, 'CENTER': 0.0, 'RIGHT_THIRD': -frame_w / 6}[STAGE['camera']['product_position']]
cam = bpy.data.objects.new('cam', cam_d); bpy.context.collection.objects.link(cam); sc.camera = cam
cam.location = (shift, -D, cz); aim(cam, (shift, 0, z0 + 0.48 * H if slit_z is None else cz - 0.001))
bpy.context.view_layer.update()

def proj(p):
    v = world_to_camera_view(sc, cam, Vector(p)); return [v.x * RES[0], (1 - v.y) * RES[1]]
info = {'bottom_front': proj((0, front_y, z0)), 'top_front': proj((0, front_y, z0 + H)),
        'left_mid': proj((-W / 2, front_y, z0 + H / 2)), 'right_mid': proj((W / 2, front_y, z0 + H / 2)),
        'slit_y': proj((0, front_y, slit_z))[1] if slit_z is not None else None,
        'foreground_props': len(foreground), 'resolution': list(RES)}
# --- what Blender was REALLY asked to do: an inventory of the scene as built, for the owner's trace (no claim beyond this list)
def _inventory():
    objs = [o for o in bpy.data.objects]
    mats = {}
    for m in bpy.data.materials:
        if not m.use_nodes: continue
        b = m.node_tree.nodes.get('Principled BSDF')
        mats[m.name] = {'node_types': sorted({n.bl_idname for n in m.node_tree.nodes}),
                        **({'base_color': [round(c, 3) for c in b.inputs['Base Color'].default_value[:3]], 'roughness': round(b.inputs['Roughness'].default_value, 3), 'metallic': round(b.inputs['Metallic'].default_value, 3)} if b else {})}
    return {
        'engine': sc.render.engine, 'device': sc.cycles.device, 'samples': sc.cycles.samples, 'denoising': bool(sc.cycles.use_denoising),
        'resolution': list(RES), 'camera': {'lens_mm': cam_d.lens, 'type': cam_d.type, 'depth_of_field': bool(cam_d.dof.use_dof)},
        'objects_by_type': {t: sum(1 for o in objs if o.type == t) for t in sorted({o.type for o in objs})},
        'meshes': sorted(o.name for o in objs if o.type == 'MESH'),
        'text_objects': [o.data.body for o in objs if o.type == 'FONT'],
        'lights': [{'name': o.name, 'type': o.data.type, 'energy': round(o.data.energy, 1), 'color': [round(c, 3) for c in o.data.color]} for o in objs if o.type == 'LIGHT'],
        'materials': mats,
        'world': {'uses_nodes': bool(sc.world and sc.world.use_nodes)} if sc.world else None,
        'not_used': [f for f, used in [('volumetrics / fog', any(n.bl_idname.startswith('ShaderNodeVolume') for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes)), ('image textures other than the reflection card', sum(1 for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes if n.bl_idname == 'ShaderNodeTexImage') > 1), ('HDRI environment', bool(sc.world and sc.world.use_nodes and any(n.bl_idname == 'ShaderNodeTexEnvironment' for n in sc.world.node_tree.nodes))), ('depth of field', bool(cam_d.dof.use_dof)), ('modifiers', any(o.modifiers for o in objs)), ('particles', any(o.particle_systems for o in objs if hasattr(o, 'particle_systems'))), ('animation', bool(sc.frame_end > sc.frame_start and any(o.animation_data for o in objs)))] if not used],
    }
info['blender_capabilities_used'] = _inventory()
sc.render.filepath = OUT
bpy.ops.render.render(write_still=True)
# passe de masque : ce qui est DEVANT le produit (accessoires de premier plan), pour la composition
if foreground:
    for o in bpy.data.objects:
        if o.type == 'MESH' and o not in foreground: o.hide_render = True
    sc.render.film_transparent = True; sc.cycles.samples = 8; sc.cycles.use_denoising = False
    sc.render.filepath = OUT.replace('.png', '_avant.png'); bpy.ops.render.render(write_still=True)
    info['foreground_mask'] = sc.render.filepath
json.dump(info, open(OUT + '.json', 'w'))
print('RENDER_INFO', json.dumps(info))
