"""Build the RapidScreen Vitruvian modeler starter asset.

The script is intentionally self-contained so the asset can be rebuilt from the
CC0 MakeHuman base mesh without checking a Blender installation into the web
application. It creates a real mesh scene, an armature with independent extra
limb bones, a neon ring, a turntable action, a GLB, a static OBJ, and a Blender
source file.

Run with Blender's background Python:

    blender --background --python build_vitruvian.py -- \
      --base-obj C:/path/to/base.obj \
      --public-dir public/modeler \
      --asset-dir assets/modeler
"""

from __future__ import annotations

import argparse
import bmesh
import hashlib
import json
import math
import os
import shutil
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector


FPS = 60
SPIN_SECONDS = 4
MODEL_HEIGHT = 6.0


def parse_args() -> argparse.Namespace:
    argv = list(os.sys.argv)
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-obj", required=True)
    parser.add_argument("--public-dir", required=True)
    parser.add_argument("--asset-dir", required=True)
    parser.add_argument("--reference-image", default="")
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights, bpy.data.armatures):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def set_socket(node, names, value) -> bool:
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return True
    return False


def neon_material(name: str, colour: tuple[float, float, float, float], strength: float = 5.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = colour
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    set_socket(shader, ("Base Color",), colour)
    set_socket(shader, ("Metallic",), 0.32)
    set_socket(shader, ("Roughness",), 0.25)
    set_socket(shader, ("Emission Color", "Emission"), colour)
    set_socket(shader, ("Emission Strength",), strength)
    links.new(shader.outputs.get("BSDF"), output.inputs.get("Surface"))
    return material


def dark_material(name: str):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (0.003, 0.006, 0.016, 1)
    shader = material.node_tree.nodes.get("Principled BSDF")
    if shader:
        set_socket(shader, ("Base Color",), (0.003, 0.006, 0.016, 1))
        set_socket(shader, ("Roughness",), 0.5)
        set_socket(shader, ("Metallic",), 0.1)
    return material


def apply_material(obj: bpy.types.Object, material) -> None:
    if obj.type == "MESH":
        obj.data.materials.clear()
        obj.data.materials.append(material)


def smooth_mesh(obj: bpy.types.Object) -> None:
    if obj.type != "MESH":
        return
    for polygon in obj.data.polygons:
        polygon.use_smooth = True


def import_makehuman(base_obj: str) -> bpy.types.Object:
    bpy.ops.wm.obj_import(filepath=str(Path(base_obj).resolve()), use_split_objects=False)
    imported = bpy.context.selected_objects
    if not imported:
        raise RuntimeError(f"MakeHuman OBJ import produced no object: {base_obj}")
    body = imported[0]
    body.name = "MakeHumanBody"
    # Blender's OBJ importer preserves the MakeHuman file's X=90 degree axis
    # correction. Bake it, then turn the source Z-up pose into the studio's Y-up
    # pose before measuring height.
    body.update_from_editmode()
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    body.rotation_euler = (math.radians(-90), 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    uniform_scale = MODEL_HEIGHT / body.dimensions.y
    body.scale = (uniform_scale, uniform_scale, uniform_scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    # The source's positive vertical coordinates point toward the feet. Flip
    # the baked mesh so the modeler opens with a conventional head-up pose.
    body.scale.y = -1
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    body.location.y -= body.dimensions.y * 0.02
    return body


def trim_body_to_pelvis(body: bpy.types.Object, pelvis_y: float = -0.92) -> None:
    """Keep the licensed base's head, torso, shoulders, and source arms.

    The MakeHuman base is intentionally retained as the anatomy source, but its
    tightly closed leg volume reads as one robe under the neon material. The
    lower source vertices are removed at the pelvis and replaced by four
    separately rigged authored legs, leaving readable negative space between
    each pair. MakeHuman's baked source pose is head-up toward negative Y in
    this Blender scene, so the lower-body side of the cut is positive Y.
    """
    mesh = bmesh.new()
    mesh.from_mesh(body.data)
    for vertex in list(mesh.verts):
        if vertex.co.y > pelvis_y:
            mesh.verts.remove(vertex)
    mesh.to_mesh(body.data)
    mesh.free()
    body.data.update()


def lift_source_arms(body: bpy.types.Object) -> None:
    """Raise the licensed source arms into the second Vitruvian pose.

    The MakeHuman base has its arms sloping down from the shoulders. Rotating
    only the arm-side vertices around each shoulder preserves the torso and
    face while giving the source pair a readable upward diagonal silhouette.
    Their exact rest bones are authored to this pose below.
    """
    for vertex in body.data.vertices:
        if abs(vertex.co.x) <= 0.62:
            continue
        side = 1 if vertex.co.x >= 0 else -1
        pivot = Vector((0.38 * side, -1.95, 0.0))
        rotation = Quaternion((0, 0, 1), math.radians(-78 * side))
        vertex.co = pivot + rotation @ (vertex.co - pivot)
    body.data.update()


def mark_rig_bone(obj: bpy.types.Object, bone_name: str) -> bpy.types.Object:
    obj["rigBone"] = bone_name
    return obj


def create_pelvis(material) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=(0, -0.87, 0.02))
    pelvis = bpy.context.object
    pelvis.name = "pelvis"
    pelvis.scale = (0.82, 0.50, 0.56)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    apply_material(pelvis, material)
    smooth_mesh(pelvis)
    return mark_rig_bone(pelvis, "root")


def create_core_legs(material) -> list[bpy.types.Object]:
    """Create the original leg pair as independent thigh, shin, and foot meshes."""
    legs: list[bpy.types.Object] = []
    for side, sign in (("left", 1), ("right", -1)):
        hip = Vector((0.30 * sign, -0.86, 0.04))
        knee = Vector((0.39 * sign, 0.25, 0.08))
        ankle = Vector((0.43 * sign, 1.42, 0.12))
        thigh = create_limb_mesh(f"leg-{side}-upper", [tuple(hip), tuple(knee)], [0.30, 0.22], material)
        shin = create_limb_mesh(f"leg-{side}-lower", [tuple(knee), tuple(ankle)], [0.22, 0.13], material)
        legs.extend([mark_rig_bone(thigh, f"leg-{side}-upper"), mark_rig_bone(shin, f"leg-{side}-lower")])
        direction = Vector((0.25 * sign, 0.02, 0.10)).normalized()
        feet = create_foot_detail(f"leg-{side}-foot", tuple(ankle), tuple(direction), material)
        legs.extend(mark_rig_bone(foot, f"leg-{side}-lower") for foot in feet)
    return legs


def create_limb_mesh(name: str, points: list[tuple[float, float, float]], radii: list[float], material) -> bpy.types.Object:
    """Create a rounded, tapered organic mesh along a hand-authored path."""
    sides = 20
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    vectors = [Vector(point) for point in points]
    for index, point in enumerate(vectors):
        tangent = (vectors[min(index + 1, len(vectors) - 1)] - vectors[max(index - 1, 0)]).normalized()
        reference = Vector((0, 0, 1)) if abs(tangent.z) < 0.9 else Vector((1, 0, 0))
        side = tangent.cross(reference).normalized()
        up = tangent.cross(side).normalized()
        radius = radii[index]
        for ring_index in range(sides):
            angle = (ring_index / sides) * math.tau
            offset = side * math.cos(angle) * radius + up * math.sin(angle) * radius * 0.88
            verts.append(tuple(point + offset))
    for ring in range(len(points) - 1):
        for side_index in range(sides):
            next_side = (side_index + 1) % sides
            a = ring * sides + side_index
            b = ring * sides + next_side
            c = (ring + 1) * sides + next_side
            d = (ring + 1) * sides + side_index
            faces.append((a, b, c, d))
    start = len(verts)
    verts.append(tuple(vectors[0]))
    end = len(verts)
    verts.append(tuple(vectors[-1]))
    for side_index in range(sides):
        next_side = (side_index + 1) % sides
        faces.append((start, next_side, side_index))
        last = (len(points) - 1) * sides
        faces.append((end, last + side_index, last + next_side))
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    # Keep mesh node names distinct from the armature bones. Blender's glTF
    # exporter otherwise suffixes the duplicate bone names (for example
    # `arm-left-upper-2_1`), which makes the modeler's pose controls brittle.
    obj = bpy.data.objects.new(f"mesh-{name}", mesh)
    bpy.context.collection.objects.link(obj)
    apply_material(obj, material)
    smooth_mesh(obj)
    bevel = obj.modifiers.new("Sculpted edge softness", "BEVEL")
    bevel.width = 0.025
    bevel.segments = 2
    return obj


def create_hand_detail(name: str, wrist: tuple[float, float, float], direction: tuple[float, float, float], material) -> list[bpy.types.Object]:
    wrist_v = Vector(wrist)
    direction_v = Vector(direction).normalized()
    palm = create_limb_mesh(
        f"{name}Palm",
        [tuple(wrist_v), tuple(wrist_v + direction_v * 0.28), tuple(wrist_v + direction_v * 0.52)],
        [0.18, 0.22, 0.16],
        material,
    )
    objects = [palm]
    side = Vector((-direction_v.y, direction_v.x, 0)).normalized()
    if side.length < 0.1:
        side = Vector((0, 1, 0))
    for finger in range(5):
        spread = side * ((finger - 2) * 0.055)
        start = wrist_v + direction_v * 0.46 + spread
        end = start + direction_v * (0.22 + (0.04 if finger == 1 else 0.0))
        objects.append(create_limb_mesh(f"{name}Finger{finger + 1}", [tuple(start), tuple(end)], [0.055, 0.025], material))
    return objects


def create_foot_detail(name: str, ankle: tuple[float, float, float], direction: tuple[float, float, float], material) -> list[bpy.types.Object]:
    ankle_v = Vector(ankle)
    direction_v = Vector(direction).normalized()
    sole = create_limb_mesh(
        f"{name}-sole",
        [tuple(ankle_v), tuple(ankle_v + direction_v * 0.22), tuple(ankle_v + direction_v * 0.48)],
        [0.14, 0.20, 0.14],
        material,
    )
    objects = [sole]
    side = Vector((-direction_v.y, direction_v.x, 0)).normalized()
    if side.length < 0.1:
        side = Vector((0, 1, 0))
    for toe in range(4):
        spread = side * ((toe - 1.5) * 0.045)
        start = ankle_v + direction_v * 0.43 + spread
        end = start + direction_v * (0.15 - (0.02 if toe == 0 else 0.0))
        objects.append(create_limb_mesh(f"{name}-toe-{toe + 1}", [tuple(start), tuple(end)], [0.045, 0.018], material))
    return objects


def create_extra_limbs(material) -> tuple[list[bpy.types.Object], dict[str, tuple[Vector, Vector]]]:
    limb_specs = {
        # Second arm pair: broad and horizontal, leaving the MakeHuman source
        # pair as the raised diagonal pose.
        "arm-left-upper-2": [(0.33, -1.78, 0.03), (0.92, -1.79, 0.05), (1.55, -1.77, 0.07), (2.18, -1.70, 0.10), (2.62, -1.60, 0.12)],
        "arm-right-upper-2": [(-0.33, -1.78, 0.03), (-0.92, -1.79, 0.05), (-1.55, -1.77, 0.07), (-2.18, -1.70, 0.10), (-2.62, -1.60, 0.12)],
        # Second leg pair: begins at the pelvis and fans outward, with a clear
        # channel between it and the vertical core legs.
        "leg-left-upper-2": [(0.33, -0.84, 0.00), (0.78, -0.22, 0.04), (1.18, 0.46, 0.08), (1.72, 0.92, 0.12), (2.18, 1.16, 0.15)],
        "leg-right-upper-2": [(-0.33, -0.84, 0.00), (-0.78, -0.22, 0.04), (-1.18, 0.46, 0.08), (-1.72, 0.92, 0.12), (-2.18, 1.16, 0.15)],
    }
    limbs: list[bpy.types.Object] = []
    bones: dict[str, tuple[Vector, Vector]] = {}
    for name, raw_points in limb_specs.items():
        points = [tuple(point) for point in raw_points]
        radii = [0.24, 0.22, 0.16, 0.12, 0.09]
        limb = create_limb_mesh(name, points, radii, material)
        limbs.append(mark_rig_bone(limb, name))
        bones[name] = (Vector(points[0]), Vector(points[2]))
        lower_name = name.replace("-upper-2", "-lower-2")
        bones[lower_name] = (Vector(points[2]), Vector(points[-1]))
        if name.startswith("arm-"):
            direction = (Vector(points[-1]) - Vector(points[-2])).normalized()
            hand_objects = create_hand_detail(name, points[-1], tuple(direction), material)
            limbs.extend(mark_rig_bone(hand, name) for hand in hand_objects)
        else:
            direction = (Vector(points[-1]) - Vector(points[-2])).normalized()
            foot_objects = create_foot_detail(name.replace("-upper-2", "-foot-2"), points[-1], tuple(direction), material)
            limbs.extend(mark_rig_bone(foot, name) for foot in foot_objects)
    return limbs, bones


def make_ring(material) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(major_radius=3.62, minor_radius=0.032, major_segments=128, minor_segments=12, location=(0, 0, 0))
    ring = bpy.context.object
    ring.name = "vitruvian-ring"
    apply_material(ring, material)
    smooth_mesh(ring)
    return ring


def create_armature(body: bpy.types.Object, limb_objects: list[bpy.types.Object], bone_specs: dict[str, tuple[Vector, Vector]]):
    armature_data = bpy.data.armatures.new("VitruvianRig")
    rig = bpy.data.objects.new("VitruvianRig", armature_data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    root = armature_data.edit_bones.new("root")
    root.head = (0, 0, 0)
    root.tail = (0, 1.0, 0)
    spine = armature_data.edit_bones.new("spine")
    spine.head = (0, -0.90, 0)
    spine.tail = (0, -1.95, 0)
    spine.parent = root
    spine.use_connect = False
    for name, (head, tail) in bone_specs.items():
        bone = armature_data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        bone.parent = root
        bone.use_connect = False
    # Base limb controls let the source MakeHuman body be posed alongside the
    # authored second pair. Each pair has an upper and lower control.
    for name, head, tail in (
        ("arm-left-upper", (0.38, -1.95, 0), (0.92, -2.35, 0)),
        ("arm-left-lower", (0.92, -2.35, 0), (1.45, -2.80, 0)),
        ("arm-right-upper", (-0.38, -1.95, 0), (-0.92, -2.35, 0)),
        ("arm-right-lower", (-0.92, -2.35, 0), (-1.45, -2.80, 0)),
        ("leg-left-upper", (0.30, -0.86, 0), (0.39, 0.25, 0)),
        ("leg-left-lower", (0.39, 0.25, 0), (0.43, 1.42, 0)),
        ("leg-right-upper", (-0.30, -0.86, 0), (-0.39, 0.25, 0)),
        ("leg-right-lower", (-0.39, 0.25, 0), (-0.43, 1.42, 0)),
    ):
        bone = armature_data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        bone.parent = root
        bone.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    for obj in [body, *limb_objects]:
        modifier = obj.modifiers.new("Vitruvian skin", "ARMATURE")
        modifier.object = rig
        # glTF skin export expects the armature to be the direct parent of the
        # skinned mesh. The rig itself remains under the animated asset root.
        obj.parent = rig
        if obj is body:
            groups = {bone.name: obj.vertex_groups.new(name=bone.name) for bone in armature_data.bones}
            # Keep the recognizable MakeHuman torso and head on the root, and
            # bind the source diagonal arms to their matching upper/lower
            # controls. The authored second pair and legs are independent
            # meshes below.
            for vertex in obj.data.vertices:
                co = vertex.co
                side = "left" if co.x >= 0 else "right"
                if abs(co.x) > 1.02:
                    groups[f"arm-{side}-lower"].add([vertex.index], 1.0, "REPLACE")
                elif abs(co.x) > 0.62:
                    groups[f"arm-{side}-upper"].add([vertex.index], 1.0, "REPLACE")
                else:
                    groups["root"].add([vertex.index], 1.0, "REPLACE")
        else:
            # Each added limb object is independently controllable. Fingers and
            # palm objects are bound to their parent limb control as a whole.
            bone_name = obj.get("rigBone") or next((name for name in bone_specs if obj.name.startswith(name)), None)
            if bone_name is None:
                bone_name = "root"
            group = obj.vertex_groups.new(name=bone_name)
            group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    return rig


def create_turntable(root: bpy.types.Object) -> None:
    root.rotation_mode = "XYZ"
    root.rotation_euler = (0, 0, 0)
    root.keyframe_insert(data_path="rotation_euler", index=1, frame=1)
    for frame, angle in ((FPS, 90), (FPS * 2, 180), (FPS * 3, 270), (FPS * SPIN_SECONDS, 360)):
        root.rotation_euler[1] = math.radians(angle)
        root.keyframe_insert(data_path="rotation_euler", index=1, frame=frame)
    if root.animation_data and root.animation_data.action:
        root.animation_data.action.name = "Vitruvian 360 Spin"
        for curve in root.animation_data.action.fcurves:
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"


def point_camera(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()


def setup_scene(root: bpy.types.Object) -> tuple[bpy.types.Object, bpy.types.Object]:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = FPS * SPIN_SECONDS
    scene.world.color = (0.001, 0.002, 0.006)
    world_nodes = scene.world.node_tree.nodes
    bg = world_nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.001, 0.002, 0.007, 1)
        bg.inputs["Strength"].default_value = 0.03
    root.name = "VitruvianAsset"
    camera_data = bpy.data.cameras.new("TurntableCamera")
    camera = bpy.data.objects.new("TurntableCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0, 0.2, 12.2)
    camera.data.lens = 52
    point_camera(camera, Vector((0, -0.05, 0)))
    scene.camera = camera
    key_data = bpy.data.lights.new("BlueKey", type="AREA")
    key_data.energy = 950
    key_data.color = (0.04, 0.25, 1.0)
    key_data.shape = "DISK"
    key_data.size = 5
    key = bpy.data.objects.new("BlueKey", key_data)
    key.location = (4, 4, 5)
    point_camera(key, Vector((0, 0, 0)))
    bpy.context.collection.objects.link(key)
    fill_data = bpy.data.lights.new("CyanFill", type="AREA")
    fill_data.energy = 500
    fill_data.color = (0.0, 0.7, 1.0)
    fill_data.size = 4
    fill = bpy.data.objects.new("CyanFill", fill_data)
    fill.location = (-4, 0, 2)
    point_camera(fill, Vector((0, 0, 0)))
    bpy.context.collection.objects.link(fill)
    return camera, scene


def save_render(scene: bpy.types.Scene, render_dir: Path, label: str, angle: int, root: bpy.types.Object, camera: bpy.types.Object):
    # Review views orbit the production camera. Keeping the asset at rest here
    # makes the side and rear renders prove actual depth instead of conflating
    # camera review with the authored turntable animation.
    radians = math.radians(angle)
    root.rotation_euler[1] = 0
    orbit = Quaternion((0, 1, 0), radians)
    base_location = Vector((0, 0.2, 12.2))
    base_rotation = (Vector((0, 0, 0)) - base_location).to_track_quat("-Z", "Y")
    camera.location = orbit @ base_location
    camera.rotation_mode = "QUATERNION"
    camera.rotation_quaternion = orbit @ base_rotation
    scene.render.filepath = str(render_dir / f"vitruvian-{label}.png")
    bpy.ops.render.render(write_still=True)


def export_files(public_dir: Path, asset_dir: Path, root: bpy.types.Object, rig: bpy.types.Object, scene: bpy.types.Scene):
    public_dir.mkdir(parents=True, exist_ok=True)
    asset_dir.mkdir(parents=True, exist_ok=True)
    glb_path = public_dir / "vitruvian.glb"
    obj_path = public_dir / "vitruvian.obj"
    blend_path = asset_dir / "vitruvian-neon.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    # Blender authoring uses the source's Y-up review orientation, while the
    # glTF exporter converts mesh data from Blender's native Z-up convention.
    # Apply the inverse conversion on the exported asset root so Three.js sees
    # the figure upright (Y height, X width, Z depth). The editable .blend was
    # saved immediately above and remains in the review orientation.
    root.rotation_mode = "XYZ"
    root.rotation_euler.x = math.radians(90)
    shutil.copyfile(blend_path, asset_dir / "vitruvian.blend")
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_materials="EXPORT",
        export_apply=False,
        export_yup=True,
    )
    # Keep the descriptive alias for older local drafts while the modeler core
    # uses the stable `/modeler/vitruvian.glb` URL.
    shutil.copyfile(glb_path, public_dir / "vitruvian-neon.glb")
    # Export the renderable mesh set without the armature and lights for simple
    # static import in editors that only consume OBJ.
    hidden = []
    for obj in list(bpy.context.scene.objects):
        if obj.type in {"ARMATURE", "CAMERA", "LIGHT"}:
            hidden.append((obj, obj.hide_render, obj.hide_viewport))
            obj.hide_render = True
            obj.hide_viewport = True
    bpy.ops.wm.obj_export(filepath=str(obj_path), export_materials=False, export_normals=True, export_uv=True)
    shutil.copyfile(obj_path, public_dir / "vitruvian-neon.obj")
    for obj, hide_render, hide_viewport in hidden:
        obj.hide_render = hide_render
        obj.hide_viewport = hide_viewport
    # Keep the editable source current after the export operators.
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    shutil.copyfile(blend_path, asset_dir / "vitruvian.blend")


def write_manifest(public_dir: Path, asset_dir: Path, base_obj: Path, reference: str, root: bpy.types.Object, rig: bpy.types.Object):
    manifest = {
        "schema": "rapidscreen.model-project.v1",
        "assetId": "vitruvian-neon",
        "title": "Vitruvian Neon / literal multi-limb figure",
        "source": {
            "base": "MakeHuman Community base mesh",
            "license": "CC0 1.0",
            "sourceUrl": "https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/3dobjs/base.obj",
            "sourceFileSha256": hashlib.sha256(base_obj.read_bytes()).hexdigest(),
            "referenceImage": "kept outside deployed public assets",
        },
        "files": {
            "glb": "/modeler/vitruvian.glb",
            "obj": "/modeler/vitruvian.obj",
            "blender": "assets/modeler/vitruvian.blend",
        },
        "rig": {
            "name": rig.name,
            "root": "root",
            "poseableControls": [
                "spine",
                "arm-left-upper", "arm-left-lower", "arm-right-upper", "arm-right-lower",
                "arm-left-upper-2", "arm-left-lower-2", "arm-right-upper-2", "arm-right-lower-2",
                "leg-left-upper", "leg-left-lower", "leg-right-upper", "leg-right-lower",
                "leg-left-upper-2", "leg-left-lower-2", "leg-right-upper-2", "leg-right-lower-2",
            ],
        },
        "animation": {
            "name": "Vitruvian 360 Spin",
            "fps": FPS,
            "durationSeconds": SPIN_SECONDS,
            "keyframesDegrees": [0, 90, 180, 270, 360],
        },
        "materials": ["Electric Blue Emission", "Deep Space Backdrop"],
        "referenceImage": "supplied frontal image used locally during authoring; excluded from deployed assets",
    }
    (asset_dir / "vitruvian-neon.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def write_provenance(asset_dir: Path, base_obj: Path, reference: str):
    digest = hashlib.sha256(base_obj.read_bytes()).hexdigest()
    text = f"""# RapidScreen Vitruvian Neon provenance

## Mesh source

- Base mesh: MakeHuman Community `base.obj`
- Source URL: https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/3dobjs/base.obj
- License: CC0 1.0 Universal (the MakeHuman repository's `LICENSE.ASSETS.md` applies to the base asset)
- Source SHA-256: `{digest}`
- Build date (UTC): generated by `scripts/modeler-asset/build_vitruvian.py`

The base mesh is reshaped into a stylized literal multi-limb figure. The extra
limbs, ring, materials, rig and animation are authored for RapidScreen. The
supplied frontal reference is used only during local authoring and is not copied
into `public/modeler` or included in the project bundle.

## Deliverables

- `public/modeler/vitruvian.glb`: rigged, animated GLB for Three.js and 3D tools
- `public/modeler/vitruvian.obj`: static mesh interchange fallback
- `assets/modeler/vitruvian.blend`: editable Blender source
"""
    (asset_dir / "provenance.md").write_text(text, encoding="utf-8")


def main() -> None:
    args = parse_args()
    base_obj = Path(args.base_obj).resolve()
    public_dir = Path(args.public_dir).resolve()
    asset_dir = Path(args.asset_dir).resolve()
    if not base_obj.is_file():
        raise FileNotFoundError(base_obj)
    clear_scene()
    body_material = neon_material("Electric Blue Emission", (0.003, 0.035, 0.55, 1), 1.55)
    ring_material = neon_material("Ring Electric Blue", (0.005, 0.12, 0.95, 1), 4.5)
    body = import_makehuman(str(base_obj))
    trim_body_to_pelvis(body)
    lift_source_arms(body)
    apply_material(body, body_material)
    smooth_mesh(body)
    pelvis = create_pelvis(body_material)
    core_legs = create_core_legs(body_material)
    extra_limbs, bone_specs = create_extra_limbs(body_material)
    ring = make_ring(ring_material)
    root = bpy.data.objects.new("VitruvianAsset", None)
    bpy.context.collection.objects.link(root)
    body.parent = root
    limb_objects = [pelvis, *core_legs, *extra_limbs]
    for obj in limb_objects:
        obj.parent = root
    ring.parent = root
    rig = create_armature(body, limb_objects, bone_specs)
    rig.parent = root
    camera, scene = setup_scene(root)
    create_turntable(root)
    render_dir = asset_dir / "renders"
    render_dir.mkdir(parents=True, exist_ok=True)
    for label, angle in (("front", 0), ("right", 90), ("back", 180), ("left", 270)):
        save_render(scene, render_dir, label, angle, root, camera)
    root.rotation_euler[1] = 0
    export_files(public_dir, asset_dir, root, rig, scene)
    write_manifest(public_dir, asset_dir, base_obj, args.reference_image, root, rig)
    write_provenance(asset_dir, base_obj, args.reference_image)
    print(f"Built {public_dir / 'vitruvian-neon.glb'}")
    print(f"Source {asset_dir / 'vitruvian-neon.blend'}")


if __name__ == "__main__":
    main()
