"""Validate the exported Vitruvian V2 bundle in Blender.

The validator checks the binary GLB metadata directly, then imports the GLB back
into Blender and exercises both skins.  It writes a small JSON report beside the
editable source so asset changes have evidence that can be reviewed without
opening Blender.

Example::

    blender --background --python validate_vitruvian_v2.py -- \
      --glb public/modeler/vitruvian-v2.glb \
      --obj public/modeler/vitruvian-v2.obj \
      --report assets/modeler/vitruvian-v2-validation.json
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector


EXPECTED_NODES = {"vitruvian-primary", "vitruvian-ghost", "vitruvian-ring"}
EXPECTED_RIGS = {
    "VitruvianPrimaryRig": "primary_",
    "VitruvianGhostRig": "ghost_",
}
EXPECTED_BODIES = {"VitruvianPrimaryBody", "VitruvianGhostBody"}


def parse_args() -> argparse.Namespace:
    argv = list(sys.argv)
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", required=True)
    parser.add_argument("--obj", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args(argv)


def read_glb_json(path: Path) -> dict:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"not a GLB file: {path}")
    json_length = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20 : 20 + json_length].decode("utf-8"))


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials):
        for datablock in list(collection):
            if datablock.users == 0:
                collection.remove(datablock)


def world_bounds(obj: bpy.types.Object) -> dict[str, list[float]]:
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = [min(point[index] for point in corners) for index in range(3)]
    maximum = [max(point[index] for point in corners) for index in range(3)]
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
        "size": [round(maximum[index] - minimum[index], 6) for index in range(3)],
    }


def evaluated_world_bounds(obj: bpy.types.Object) -> dict[str, list[float]]:
    """Return bounds after armature evaluation, including pose changes."""
    if obj.type != "MESH":
        return world_bounds(obj)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        points = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
        minimum = [min(point[index] for point in points) for index in range(3)]
        maximum = [max(point[index] for point in points) for index in range(3)]
    finally:
        evaluated.to_mesh_clear()
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
        "size": [round(maximum[index] - minimum[index], 6) for index in range(3)],
    }


def spin_samples(root: bpy.types.Object) -> dict:
    action = root.animation_data.action if root.animation_data else None
    if action is None:
        return {
            "frames": [],
            "signedAnglesDegrees": [],
            "reachesHalfTurn": False,
            "reachesThreeQuarterTurn": False,
            "reachesFullTurn": False,
            "returnsToStart": False,
        }
    start, end = action.frame_range
    frames = [
        start,
        start + (end - start) * 0.25,
        start + (end - start) * 0.5,
        start + (end - start) * 0.75,
        end,
    ]
    quaternions = []
    for frame in frames:
        bpy.context.scene.frame_set(round(frame))
        quaternions.append(root.rotation_quaternion.copy().normalized())
    start_quaternion = quaternions[0]
    dominant_axis = max(range(1, 4), key=lambda index: max(abs(q[index]) for q in quaternions))
    raw_angles = [math.degrees(2.0 * math.atan2(q[dominant_axis], q.w)) for q in quaternions]
    signed_angles = [raw_angles[0]]
    for raw_angle in raw_angles[1:]:
        angle = raw_angle
        while angle - signed_angles[-1] > 180.0:
            angle -= 360.0
        while angle - signed_angles[-1] < -180.0:
            angle += 360.0
        signed_angles.append(angle)
    shortest_angles = []
    for quaternion in quaternions:
        dot = max(-1.0, min(1.0, abs(start_quaternion.dot(quaternion))))
        shortest_angles.append(round(math.degrees(2.0 * math.acos(dot)), 3))
    return {
        "frames": [round(frame, 3) for frame in frames],
        "dominantAxis": dominant_axis - 1,
        "signedAnglesDegrees": [round(angle, 3) for angle in signed_angles],
        "shortestAnglesDegrees": shortest_angles,
        "reachesHalfTurn": 150.0 <= signed_angles[2] <= 210.0,
        "reachesThreeQuarterTurn": 225.0 <= signed_angles[3] <= 315.0,
        "reachesFullTurn": 315.0 <= signed_angles[4] <= 405.0,
        "returnsToStart": shortest_angles[-1] <= 2.0,
    }


def display_path(path: Path) -> str:
    try:
        return path.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.name


def obj_counts(path: Path) -> dict[str, int | bool]:
    vertices = faces = 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("v "):
            vertices += 1
        elif line.startswith("f "):
            faces += 1
    mtl_path = path.with_suffix(".mtl")
    return {
        "vertices": vertices,
        "faces": faces,
        "materialLibraryPresent": mtl_path.is_file(),
    }


def json_checks(glb: dict) -> dict:
    nodes = glb.get("nodes", [])
    node_names = [node.get("name") for node in nodes]
    node_by_name = {node.get("name"): node for node in nodes}
    skin_checks = []
    for skin in glb.get("skins", []):
        joints = skin.get("joints", [])
        names = [node_names[index] for index in joints]
        prefix = "ghost_" if any(name.startswith("ghost_") for name in names) else "primary_"
        skin_checks.append(
            {
                "name": skin.get("name"),
                "jointCount": len(joints),
                "prefix": prefix,
                "allPrefixed": all(name.startswith(prefix) for name in names),
            }
        )
    material_checks = []
    for material in glb.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        factor = pbr.get("baseColorFactor", [1, 1, 1, 1])
        material_checks.append(
            {
                "name": material.get("name"),
                "alphaMode": material.get("alphaMode", "OPAQUE"),
                "alpha": factor[3],
            }
        )
    animation_checks = []
    accessors = glb.get("accessors", [])
    for animation in glb.get("animations", []):
        ranges = []
        for sampler in animation.get("samplers", []):
            accessor = accessors[sampler["input"]]
            minimum = accessor.get("min", [None])[0]
            maximum = accessor.get("max", [None])[0]
            ranges.append([minimum, maximum])
        animation_checks.append(
            {
                "name": animation.get("name"),
                "channelCount": len(animation.get("channels", [])),
                "timeRange": [
                    min(item[0] for item in ranges if item[0] is not None),
                    max(item[1] for item in ranges if item[1] is not None),
                ]
                if ranges
                else None,
            }
        )
    return {
        "nodeNamesPresent": sorted(EXPECTED_NODES & set(node_names)),
        "nodeNamesExact": EXPECTED_NODES.issubset(set(node_names)),
        "defaultPoseDistinct": {
            "upperarm": node_by_name.get("primary_upperarm01.L", {}).get("rotation")
            != node_by_name.get("ghost_upperarm01.L", {}).get("rotation"),
            "upperleg": node_by_name.get("primary_upperleg01.L", {}).get("rotation")
            != node_by_name.get("ghost_upperleg01.L", {}).get("rotation"),
        },
        "skins": skin_checks,
        "materials": material_checks,
        "animations": animation_checks,
    }


def imported_checks() -> dict:
    objects = {obj.name: obj for obj in bpy.context.scene.objects}
    missing = sorted((EXPECTED_BODIES | set(EXPECTED_RIGS) | EXPECTED_NODES) - set(objects))
    rigs = []
    for rig_name, prefix in EXPECTED_RIGS.items():
        rig = objects.get(rig_name)
        if rig is None or rig.type != "ARMATURE":
            rigs.append({"name": rig_name, "boneCount": 0, "prefix": prefix, "allPrefixed": False})
            continue
        bone_names = [bone.name for bone in rig.data.bones]
        rigs.append(
            {
                "name": rig_name,
                "boneCount": len(bone_names),
                "prefix": prefix,
                "allPrefixed": all(name.startswith(prefix) for name in bone_names),
            }
        )

    bodies = {}
    for body_name in EXPECTED_BODIES:
        body = objects.get(body_name)
        if body is None:
            continue
        bodies[body_name] = {
            "bounds": evaluated_world_bounds(body),
            "vertexCount": len(body.data.vertices),
            "material": body.data.materials[0].name if body.data.materials else None,
            "hasArmatureModifier": any(modifier.type == "ARMATURE" for modifier in body.modifiers),
            "vertexGroupCount": len(body.vertex_groups),
            "expectedBoneGroupCount": sum(
                group.name.startswith("primary_" if "Primary" in body_name else "ghost_")
                for group in body.vertex_groups
            ),
        }

    root = objects.get("vitruvian-v2-assembly")
    action_name = (
        root.animation_data.action.name
        if root is not None and root.animation_data and root.animation_data.action
        else None
    )
    poseability = {}
    for rig_name, body_name, prefix in (
        ("VitruvianPrimaryRig", "VitruvianPrimaryBody", "primary_"),
        ("VitruvianGhostRig", "VitruvianGhostBody", "ghost_"),
    ):
        rig = objects.get(rig_name)
        body = objects.get(body_name)
        if rig is None or body is None:
            continue
        before = evaluated_world_bounds(body)
        test_bone = rig.pose.bones.get(f"{prefix}upperarm01.L")
        if test_bone is None:
            continue
        test_bone.rotation_mode = "XYZ"
        test_bone.rotation_euler[1] = 0.35
        bpy.context.view_layer.update()
        after = evaluated_world_bounds(body)
        poseability[rig_name] = {
            "bone": test_bone.name,
            "boundsChanged": before != after,
            "before": before,
            "after": after,
        }
        test_bone.rotation_euler[1] = 0.0
        bpy.context.view_layer.update()

    materials = []
    for material in bpy.data.materials:
        if material.name.startswith("Vitruvian"):
            materials.append(
                {
                    "name": material.name,
                    "surfaceRenderMethod": getattr(material, "surface_render_method", None),
                    "opacityProperty": material.get("rapidScreenOpacity"),
                    "diffuseAlpha": material.diffuse_color[3],
                }
            )

    ring = objects.get("vitruvian-ring")
    ring_bounds = world_bounds(ring) if ring is not None else None
    return {
        "missingObjects": missing,
        "rigs": rigs,
        "bodies": bodies,
        "ringBounds": ring_bounds,
        "rootAction": action_name,
        "spinSamples": spin_samples(root) if root is not None else {},
        "materials": materials,
        "poseability": poseability,
        # The ghost pose is intentionally wider than it is tall, so use the
        # depth axis and a minimum height rather than requiring z > x.
        "headUp": all(
            body["bounds"]["size"][2] > 1.0
            and body["bounds"]["size"][2] > body["bounds"]["size"][1] * 2.0
            for body in bodies.values()
        ),
    }


def main() -> None:
    args = parse_args()
    glb_path = Path(args.glb).resolve()
    obj_path = Path(args.obj).resolve()
    report_path = Path(args.report).resolve()
    glb = read_glb_json(glb_path)
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    bpy.context.view_layer.update()
    report = {
        "asset": "vitruvian-v2",
        "glb": display_path(glb_path),
        "obj": display_path(obj_path),
        "json": json_checks(glb),
        "objCounts": obj_counts(obj_path),
        "reimport": imported_checks(),
    }
    json_result = report["json"]
    reimport = report["reimport"]
    failures: list[str] = []
    if not json_result["nodeNamesExact"]:
        failures.append("required GLB nodes are missing")
    if not all(json_result["defaultPoseDistinct"].values()):
        failures.append("primary and ghost default bone rotations are not distinct")
    if len(json_result["skins"]) != 2 or any(
        skin["jointCount"] != 163 or not skin["allPrefixed"] for skin in json_result["skins"]
    ):
        failures.append("GLB skins do not contain two prefixed 163 bone rigs")
    ghost_material = next(
        (material for material in json_result["materials"] if "Ghost" in material["name"]),
        None,
    )
    if (
        ghost_material is None
        or ghost_material["alphaMode"] != "BLEND"
        or not 0.15 <= ghost_material["alpha"] <= 0.35
    ):
        failures.append("ghost material is not a blended translucent GLB material")
    if len(json_result["animations"]) != 1 or json_result["animations"][0]["timeRange"][1] < 29.99:
        failures.append("GLB does not contain a 30 second spin animation")
    if not all(
        reimport["spinSamples"].get(key)
        for key in ("reachesHalfTurn", "reachesThreeQuarterTurn", "reachesFullTurn", "returnsToStart")
    ):
        failures.append("reimported spin does not sample a forward half, three-quarter and full turn")
    if not report["objCounts"]["materialLibraryPresent"]:
        failures.append("OBJ companion MTL is missing")
    if reimport["missingObjects"] or reimport["rootAction"] != "Vitruvian V2 360 Spin":
        failures.append("reimported GLB is missing the assembly or spin action")
    if any(
        rig["boneCount"] != 163 or not rig["allPrefixed"] for rig in reimport["rigs"]
    ):
        failures.append("reimported rigs do not contain 163 prefixed bones")
    if any(
        not body["hasArmatureModifier"] or body["expectedBoneGroupCount"] < 163
        for body in reimport["bodies"].values()
    ):
        failures.append("reimported body weights or armature modifiers are missing")
    if any(not item["boundsChanged"] for item in reimport["poseability"].values()):
        failures.append("reimported rig poseability did not change mesh bounds")
    if not reimport["headUp"]:
        failures.append("reimported model is not head-up in Blender coordinates")
    report["passed"] = not failures
    report["failures"] = failures
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
