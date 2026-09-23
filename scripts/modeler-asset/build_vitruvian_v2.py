"""Build the MPFB based RapidScreen Vitruvian V2 asset.

This builder runs inside Blender and deliberately keeps the editable source
scene separate from the exported, helper-free mesh state.  It creates two
complete MPFB humans, prefixes every bone for runtime disambiguation, and
animates a shared assembly empty for the turntable.

Example::

    blender --background --python build_vitruvian_v2.py -- \
      --public-dir public/modeler --asset-dir assets/modeler
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


FPS = 60
DURATION_SECONDS = 30
FRAME_END = FPS * DURATION_SECONDS
RING_RADIUS = 0.98
RING_TUBE = 0.008


def parse_args() -> argparse.Namespace:
    argv = list(sys.argv)
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-dir", required=True)
    parser.add_argument("--asset-dir", required=True)
    parser.add_argument("--reference-image", default="")
    return parser.parse_args(argv)


def dynamic_import(module_suffix: str, symbol: str):
    """Resolve an MPFB service through Blender's extension package name."""
    for module_name in list(sys.modules):
        if module_name.endswith(module_suffix):
            module = importlib.import_module(module_name)
            return getattr(module, symbol)
    raise RuntimeError(f"MPFB module is not loaded: {module_suffix}")


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.armatures,
    ):
        for datablock in list(collection):
            if datablock.users == 0:
                collection.remove(datablock)


def set_input(node, names, value) -> bool:
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return True
    return False


def make_material(
    name: str,
    colour: tuple[float, float, float, float],
    emission: tuple[float, float, float, float],
    emission_strength: float,
    opacity: float,
):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (*colour[:3], opacity)
    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    if hasattr(material, "blend_method"):
        material.blend_method = "BLEND" if opacity < 1 else "OPAQUE"
    if hasattr(material, "use_transparency_overlap"):
        material.use_transparency_overlap = False
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    set_input(shader, ("Base Color",), colour)
    set_input(shader, ("Metallic",), 0.28)
    set_input(shader, ("Roughness",), 0.28)
    set_input(shader, ("Emission Color", "Emission"), emission)
    set_input(shader, ("Emission Strength",), emission_strength)
    set_input(shader, ("Alpha",), opacity)
    links.new(shader.outputs.get("BSDF"), output.inputs.get("Surface"))
    material["rapidScreenOpacity"] = opacity
    material["rapidScreenMaterial"] = name
    return material


def apply_material_to_meshes(root: bpy.types.Object, material) -> None:
    root.data.materials.clear()
    root.data.materials.append(material)
    for polygon in root.data.polygons:
        polygon.use_smooth = True


def male_macro() -> dict:
    return {
        "gender": 1.0,
        "age": 0.5,
        "muscle": 0.6,
        "weight": 0.5,
        "proportions": 0.5,
        "height": 0.5,
        "cupsize": 0.5,
        "firmness": 0.5,
        "race": {"african": 0.33, "asian": 0.33, "caucasian": 0.33},
    }


def rename_rig_for_runtime(rig: bpy.types.Object, body: bpy.types.Object, prefix: str) -> dict[str, str]:
    """Prefix bones and matching vertex groups without changing hierarchy."""
    rename_map = {bone.name: f"{prefix}_{bone.name}" for bone in rig.data.bones}
    for bone in rig.data.bones:
        bone.name = rename_map[bone.name]
    for vertex_group in body.vertex_groups:
        if vertex_group.name in rename_map:
            vertex_group.name = rename_map[vertex_group.name]
    for pose_bone in rig.pose.bones:
        for constraint in pose_bone.constraints:
            if constraint.subtarget in rename_map:
                constraint.subtarget = rename_map[constraint.subtarget]
    rig["runtimeBonePrefix"] = prefix
    rig["sourceRig"] = "MPFB default"
    return rename_map


def make_character(
    human_service,
    name: str,
    group_name: str,
    rig_name: str,
    prefix: str,
    material,
    depth: float,
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    body = human_service.create_human(
        mask_helpers=True,
        detailed_helpers=True,
        extra_vertex_groups=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=male_macro(),
    )
    body.name = name
    body["modelerId"] = group_name
    body["mpfbVersion"] = "2.0.17"
    apply_material_to_meshes(body, material)

    rig = human_service.add_builtin_rig(body, "default", import_weights=True)
    rig.name = rig_name
    rig.data.name = rig_name
    rename_rig_for_runtime(rig, body, prefix)

    group = bpy.data.objects.new(group_name, None)
    bpy.context.collection.objects.link(group)
    group.location = (0.0, depth, 0.0)
    group["modelerId"] = group_name
    group["rigId"] = rig_name
    group["bonePrefix"] = prefix
    rig.parent = group
    return group, body, rig


def bone_rotation(rig: bpy.types.Object, bone_name: str, degrees: tuple[float, float, float]) -> None:
    pose_bone = rig.pose.bones.get(bone_name)
    if pose_bone is None:
        raise RuntimeError(f"Expected MPFB bone is missing: {bone_name}")
    pose_bone.rotation_mode = "XYZ"
    pose_bone.rotation_euler = tuple(math.radians(value) for value in degrees)
    pose_bone.keyframe_insert(data_path="rotation_euler", frame=1)


def set_pose(rig: bpy.types.Object, prefix: str, ghost: bool) -> None:
    """Pose the standard rig in its local bone space."""
    # MPFB's default body is an A-pose. The Y rotations open or close the
    # limbs in the X/Z front plane while the small Z rotations keep the
    # silhouette readable from the review camera.
    if ghost:
        arm_angle = 88.0
        leg_angle = 70.0
        arm_z = 0.0
        leg_z = 0.0
    else:
        arm_angle = 42.0
        leg_angle = 9.0
        arm_z = 0.0
        leg_z = 0.0

    left_arm = f"{prefix}_upperarm01.L"
    right_arm = f"{prefix}_upperarm01.R"
    left_forearm = f"{prefix}_lowerarm01.L"
    right_forearm = f"{prefix}_lowerarm01.R"
    left_leg = f"{prefix}_upperleg01.L"
    right_leg = f"{prefix}_upperleg01.R"

    if ghost:
        # The MPFB rig's local Y axis changes reach while local Z lifts the
        # upper arm.  These mirrored values put the ghost hands near 10/2
        # o'clock instead of relying on an ambiguous world-space sign.
        bone_rotation(rig, left_arm, (0.0, -42.0, 60.0))
        bone_rotation(rig, right_arm, (0.0, 42.0, -60.0))
        bone_rotation(rig, left_forearm, (0.0, -10.0, 0.0))
        bone_rotation(rig, right_forearm, (0.0, 10.0, 0.0))
        bone_rotation(rig, left_leg, (0.0, -20.0, -40.0))
        bone_rotation(rig, right_leg, (0.0, 20.0, 40.0))
    else:
        bone_rotation(rig, left_arm, (0.0, -42.0, 30.0))
        bone_rotation(rig, right_arm, (0.0, 42.0, -30.0))
        bone_rotation(rig, left_forearm, (0.0, -2.0, 0.0))
        bone_rotation(rig, right_forearm, (0.0, 2.0, 0.0))
        bone_rotation(rig, left_leg, (0.0, -leg_angle, leg_z))
        bone_rotation(rig, right_leg, (0.0, leg_angle, -leg_z))


def bake_pose_as_rest(characters: list[tuple[bpy.types.Object, bpy.types.Object]]) -> None:
    """Make each authored silhouette the GLB default while keeping its rig editable.

    Blender's glTF exporter otherwise puts the frame-one pose in a separate animation
    clip and emits identical base bone rotations for both figures. Applying the pose
    as rest data gives the runtime distinct default transforms; clearing the temporary
    frame-one actions leaves only the assembly turntable animation in the export.
    """
    for body, rig in characters:
        vertex_weights = {
            vertex.index: [
                (body.vertex_groups[assignment.group].name, assignment.weight)
                for assignment in vertex.groups
                if assignment.group < len(body.vertex_groups)
            ]
            for vertex in body.data.vertices
        }
        mask_settings = [
            (
                modifier.name,
                modifier.vertex_group,
                modifier.invert_vertex_group,
                modifier.threshold,
            )
            for modifier in body.modifiers
            if modifier.type == "MASK"
        ]
        for modifier in body.modifiers:
            # Keep the original topology while capturing the armature pose;
            # the MPFB mask is restored below to hide helper vertices.
            modifier.show_viewport = modifier.type == "ARMATURE"

        # Capture the evaluated, posed mesh before changing the armature rest data.
        # MPFB's body carries shape-key/helper modifiers that cannot be applied with
        # Blender's regular modifier_apply operator, so use the evaluated mesh copy.
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated_body = depsgraph.objects[body.name]
        baked_mesh = bpy.data.meshes.new_from_object(
            evaluated_body,
            depsgraph=depsgraph,
            preserve_all_data_layers=True,
        )
        old_mesh = body.data
        for modifier in list(body.modifiers):
            body.modifiers.remove(modifier)
        body.data = baked_mesh
        if old_mesh.users == 0:
            bpy.data.meshes.remove(old_mesh)

        # new_from_object preserves the geometry and attributes but not the
        # object's deform weights. Restore every MPFB group by vertex index so
        # the standard rig remains independently poseable after the bake.
        for vertex_index, assignments in vertex_weights.items():
            if vertex_index >= len(body.data.vertices):
                continue
            for group_name, weight in assignments:
                group = body.vertex_groups.get(group_name)
                if group is not None:
                    group.add([vertex_index], weight, "REPLACE")

        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.armature_apply(selected=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        rig.animation_data_clear()
        for pose_bone in rig.pose.bones:
            pose_bone.rotation_mode = "XYZ"
            pose_bone.rotation_euler = (0.0, 0.0, 0.0)
        armature_modifier = body.modifiers.new(f"{rig.name} Armature", "ARMATURE")
        armature_modifier.object = rig
        for name, vertex_group, invert, threshold in mask_settings:
            mask_modifier = body.modifiers.new(name, "MASK")
            mask_modifier.vertex_group = vertex_group
            mask_modifier.invert_vertex_group = invert
            mask_modifier.threshold = threshold
    bpy.context.view_layer.update()


def make_ring(material) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=RING_RADIUS,
        minor_radius=RING_TUBE,
        major_segments=160,
        minor_segments=12,
        location=(0.0, 0.18, 0.86),
        rotation=(math.pi / 2, 0.0, 0.0),
    )
    ring = bpy.context.object
    ring.name = "vitruvian-ring"
    ring.data.name = "vitruvian-ring-mesh"
    ring.data.materials.append(material)
    ring["modelerId"] = "vitruvian-ring"
    ring["materialRole"] = "electric-blue-ring"
    for polygon in ring.data.polygons:
        polygon.use_smooth = True
    return ring


def make_scene_root() -> bpy.types.Object:
    root = bpy.data.objects.new("vitruvian-v2-assembly", None)
    bpy.context.collection.objects.link(root)
    root["modelerId"] = "vitruvian-v2-assembly"
    root["animation"] = "360 degree spin"
    root.rotation_mode = "XYZ"
    return root


def make_turntable(root: bpy.types.Object) -> None:
    root.rotation_euler = (0.0, 0.0, 0.0)
    for frame, degrees in (
        (1, 0.0),
        (FPS * 7 + 1, 90.0),
        (FPS * 15 + 1, 180.0),
        (FPS * 22 + 1, 270.0),
        (FRAME_END, 360.0),
    ):
        root.rotation_euler[2] = math.radians(degrees)
        root.keyframe_insert(data_path="rotation_euler", index=2, frame=frame)
    action = root.animation_data.action if root.animation_data else None
    if action:
        action.name = "Vitruvian V2 360 Spin"
        curves = list(action.fcurves) if hasattr(action, "fcurves") else [
            curve
            for layer in action.layers
            for strip in layer.strips
            for channelbag in getattr(strip, "channelbags", ())
            for curve in channelbag.fcurves
        ]
        for curve in curves:
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"


def point_camera(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def setup_scene(root: bpy.types.Object) -> tuple[bpy.types.Object, bpy.types.Scene]:
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = True
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = FRAME_END
    scene.render.image_settings.color_mode = "RGBA"
    scene.world.color = (0.001, 0.002, 0.008)

    camera_data = bpy.data.cameras.new("Vitruvian Review Camera")
    camera = bpy.data.objects.new("Vitruvian Review Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.1
    camera.location = (0.0, -7.5, 0.86)
    point_camera(camera, Vector((0.0, 0.15, 0.86)))
    scene.camera = camera

    key_data = bpy.data.lights.new("Vitruvian Blue Key", "AREA")
    key = bpy.data.objects.new("Vitruvian Blue Key", key_data)
    bpy.context.collection.objects.link(key)
    key.location = (-3.0, -4.0, 4.0)
    key_data.energy = 90.0
    key_data.color = (0.02, 0.24, 1.0)
    key_data.shape = "DISK"
    key_data.size = 4.0
    point_camera(key, Vector((0.0, 0.15, 0.86)))

    rim_data = bpy.data.lights.new("Vitruvian Rim", "AREA")
    rim = bpy.data.objects.new("Vitruvian Rim", rim_data)
    bpy.context.collection.objects.link(rim)
    rim.location = (2.8, 2.8, 3.0)
    rim_data.energy = 160.0
    rim_data.color = (0.0, 0.1, 1.0)
    rim_data.size = 3.0
    point_camera(rim, Vector((0.0, 0.15, 0.86)))

    scene.view_settings.look = "AgX - Medium High Contrast"
    return camera, scene


def render_review_views(scene: bpy.types.Scene, camera: bpy.types.Object, render_dir: Path) -> None:
    render_dir.mkdir(parents=True, exist_ok=True)
    base_location = Vector((0.0, -7.5, 0.86))
    target = Vector((0.0, 0.15, 0.86))
    for label, angle in (("front", 0), ("right", 90), ("rear", 180)):
        radians = math.radians(angle)
        orbit = Vector((math.sin(radians) * 7.5, -math.cos(radians) * 7.5, 1.15))
        camera.location = orbit
        point_camera(camera, target)
        scene.render.filepath = str(render_dir / f"vitruvian-v2-{label}.png")
        bpy.ops.render.render(write_still=True)
    camera.location = base_location
    point_camera(camera, target)


def apply_export_cleanup(bodies: list[bpy.types.Object], export_service) -> None:
    for body in bodies:
        export_service.bake_modifiers_remove_helpers(
            body,
            bake_masks=True,
            bake_subdiv=True,
            remove_helpers=True,
            also_proxy=True,
        )


def select_runtime_meshes() -> list[tuple[bpy.types.Object, bool, bool]]:
    hidden: list[tuple[bpy.types.Object, bool, bool]] = []
    for obj in bpy.context.scene.objects:
        if obj.type in {"ARMATURE", "CAMERA", "LIGHT"}:
            hidden.append((obj, obj.hide_render, obj.hide_viewport))
            obj.hide_render = True
            obj.hide_viewport = True
    return hidden


def restore_hidden(hidden: list[tuple[bpy.types.Object, bool, bool]]) -> None:
    for obj, hide_render, hide_viewport in hidden:
        obj.hide_render = hide_render
        obj.hide_viewport = hide_viewport


def export_files(public_dir: Path, asset_dir: Path, scene: bpy.types.Scene) -> tuple[Path, Path, Path]:
    public_dir.mkdir(parents=True, exist_ok=True)
    asset_dir.mkdir(parents=True, exist_ok=True)
    glb_path = public_dir / "vitruvian-v2.glb"
    obj_path = public_dir / "vitruvian-v2.obj"
    blend_path = asset_dir / "vitruvian-v2.blend"

    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_cameras=False,
        export_lights=False,
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_materials="EXPORT",
        export_apply=False,
        export_yup=True,
        export_extras=True,
        use_selection=False,
        use_visible=False,
        use_renderable=False,
    )

    hidden = select_runtime_meshes()
    try:
        scene.frame_set(1)
        bpy.ops.wm.obj_export(
            filepath=str(obj_path),
            export_materials=True,
            export_normals=True,
            export_uv=True,
        )
    finally:
        restore_hidden(hidden)

    return glb_path, obj_path, blend_path


def write_provenance(
    asset_dir: Path,
    base_mesh_path: Path,
    reference_image: str,
    glb_path: Path,
    obj_path: Path,
) -> None:
    manifest = {
        "schema": "rapidscreen.model-asset.v2",
        "assetId": "vitruvian-v2",
        "title": "Vitruvian Signal V2",
        "source": {
            "generator": "MPFB 2.0.17",
            "blender": bpy.app.version_string,
            "baseMesh": "MPFB bundled data/3dobjs/base.obj",
            "baseMeshPath": "data/3dobjs/base.obj",
            "baseMeshSha256": hashlib.sha256(base_mesh_path.read_bytes()).hexdigest(),
            "baseMeshLicense": "CC0 1.0",
            "mpfbArchiveSha256": "4f0a879d64a39bf646fbf5f53601ac678855da329d650617dca5737548239a87",
            "mpfbSourceUrl": "https://github.com/makehumancommunity/mpfb2",
            "mpfbLicenseUrl": "https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/LICENSE.CODE.md",
            "assetLicenseUrl": "https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/LICENSE.ASSETS.md",
            "referenceImage": reference_image or None,
        },
        "files": {
            "glb": "/modeler/vitruvian-v2.glb",
            "obj": "/modeler/vitruvian-v2.obj",
            "blender": "assets/modeler/vitruvian-v2.blend",
        },
        "nodes": ["vitruvian-primary", "vitruvian-ghost", "vitruvian-ring"],
        "figures": [
            {
                "node": "vitruvian-primary",
                "rig": "VitruvianPrimaryRig",
                "bonePrefix": "primary_",
                "opacity": 1.0,
                "pose": "horizontal arms and closer legs",
            },
            {
                "node": "vitruvian-ghost",
                "rig": "VitruvianGhostRig",
                "bonePrefix": "ghost_",
                "opacity": 0.24,
                "pose": "raised arms and spread legs",
                "depthOffset": 0.18,
            },
        ],
        "rig": {
            "source": "MPFB default",
            "boneCount": 163,
            "primaryPrefix": "primary_",
            "ghostPrefix": "ghost_",
            "controls": [
                "upperarm01.L", "upperarm01.R",
                "lowerarm01.L", "lowerarm01.R",
                "upperleg01.L", "upperleg01.R",
                "lowerleg01.L", "lowerleg01.R",
                "wrist.L", "wrist.R", "foot.L", "foot.R",
            ],
        },
        "animation": {
            "name": "Vitruvian V2 360 Spin",
            "fps": FPS,
            "durationSeconds": DURATION_SECONDS,
            "keyframesDegrees": [0, 90, 180, 270, 360],
            "axis": "Z in Blender, Y in exported glTF runtime",
        },
        "coordinateSystem": {
            "authoringUpAxis": "Z",
            "exportedRuntimeUpAxis": "Y",
            "front": "-Y in Blender review camera",
        },
        "hashes": {
            "glbSha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
            "objSha256": hashlib.sha256(obj_path.read_bytes()).hexdigest(),
        },
    }
    (asset_dir / "vitruvian-v2.manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    provenance = (
        "# RapidScreen Vitruvian V2 provenance\n\n"
        "The two figures are generated from MPFB 2.0.17's bundled complete base mesh and\n"
        "default weighted rig. The base assets are CC0. MPFB itself is GPL-3.0-or-later;\n"
        "the runtime bundle contains the generated model, not the MPFB source code.\n\n"
        f"- Base mesh SHA-256: `{manifest['source']['baseMeshSha256']}`\n"
        f"- MPFB archive SHA-256: `{manifest['source']['mpfbArchiveSha256']}`\n"
        f"- GLB SHA-256: `{manifest['hashes']['glbSha256']}`\n"
        f"- OBJ SHA-256: `{manifest['hashes']['objSha256']}`\n"
        f"- Reference image: `{reference_image or 'none recorded'}`\n\n"
        "Sources:\n"
        "- https://github.com/makehumancommunity/mpfb2\n"
        "- https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/LICENSE.ASSETS.md\n"
        "- https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/LICENSE.CODE.md\n"
        "- https://static.makehumancommunity.org/mpfb/docs/characters/rig.html\n"
    )
    (asset_dir / "vitruvian-v2.provenance.md").write_text(provenance, encoding="utf-8")


def main() -> None:
    args = parse_args()
    public_dir = Path(args.public_dir).resolve()
    asset_dir = Path(args.asset_dir).resolve()
    base_mesh_path = Path(
        os.environ.get(
            "MPFB_BASE_MESH",
            r"C:\Users\Admin\AppData\Roaming\Blender Foundation\Blender\5.2\extensions\user_default\mpfb\data\3dobjs\base.obj",
        )
    ).resolve()
    if not base_mesh_path.is_file():
        raise FileNotFoundError(f"MPFB base mesh not found: {base_mesh_path}")

    human_service = dynamic_import("mpfb.services.humanservice", "HumanService")
    export_service = dynamic_import("mpfb.services.exportservice", "ExportService")

    clear_scene()
    primary_material = make_material(
        "Vitruvian Primary Electric Blue",
        (0.001, 0.012, 0.22, 1.0),
        (0.0, 0.025, 0.62, 1.0),
        1.35,
        1.0,
    )
    ghost_material = make_material(
        "Vitruvian Ghost Translucent Blue",
        (0.001, 0.018, 0.14, 0.24),
        (0.0, 0.02, 0.36, 0.24),
        0.45,
        0.24,
    )
    ring_material = make_material(
        "Vitruvian Ring Electric Blue",
        (0.0, 0.03, 0.42, 1.0),
        (0.0, 0.08, 1.0, 1.0),
        2.2,
        1.0,
    )

    root = make_scene_root()
    primary_group, primary_body, primary_rig = make_character(
        human_service,
        "VitruvianPrimaryBody",
        "vitruvian-primary",
        "VitruvianPrimaryRig",
        "primary",
        primary_material,
        0.0,
    )
    ghost_group, ghost_body, ghost_rig = make_character(
        human_service,
        "VitruvianGhostBody",
        "vitruvian-ghost",
        "VitruvianGhostRig",
        "ghost",
        ghost_material,
        0.18,
    )
    primary_group.parent = root
    ghost_group.parent = root
    ring = make_ring(ring_material)
    ring.parent = root

    set_pose(primary_rig, "primary", ghost=False)
    set_pose(ghost_rig, "ghost", ghost=True)
    bake_pose_as_rest([(primary_body, primary_rig), (ghost_body, ghost_rig)])
    make_turntable(root)
    camera, scene = setup_scene(root)

    render_dir = asset_dir / "vitruvian-v2-renders"
    render_review_views(scene, camera, render_dir)
    scene.frame_set(1)

    # Save the fully editable MPFB source before helper masks are baked for export.
    glb_path, obj_path, blend_path = export_files(public_dir, asset_dir, scene)
    apply_export_cleanup([primary_body, ghost_body], export_service)
    # Re-export after applying the helper masks. The saved .blend above remains editable.
    scene.frame_set(1)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_cameras=False,
        export_lights=False,
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_materials="EXPORT",
        export_apply=False,
        export_yup=True,
        export_extras=True,
        use_selection=False,
        use_visible=False,
        use_renderable=False,
    )
    hidden = select_runtime_meshes()
    try:
        bpy.ops.wm.obj_export(
            filepath=str(obj_path),
            export_materials=True,
            export_normals=True,
            export_uv=True,
        )
    finally:
        restore_hidden(hidden)

    write_provenance(asset_dir, base_mesh_path, args.reference_image, glb_path, obj_path)
    print(f"Built {glb_path}")
    print(f"Built {obj_path}")
    print(f"Saved editable source {blend_path}")


if __name__ == "__main__":
    main()
