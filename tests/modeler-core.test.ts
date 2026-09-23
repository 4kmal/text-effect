import { describe, expect, test } from "bun:test";

import {
  applySculptBrush,
  bevelEdges,
  createMeshEditor,
  createMeshSelection,
  createModelDraftStore,
  createVitruvianProject,
  createVitruvianV2Project,
  evaluateModelFrame,
  exportModelProjectBundle,
  extrudeFaces,
  importModelProjectBundle,
  insetFaces,
  moveVertices,
  parseModelProject,
  remeshStatic,
  type IndexedPolygonMesh,
} from "../components/modeler/core";

const triangle = (skinned = false): IndexedPolygonMesh => ({
  positions: new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  ...(skinned
    ? {
        skinIndices: new Uint16Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]),
        skinWeights: new Float32Array([0.75, 0.25, 0, 0, 0.25, 0.75, 0, 0, 1, 0, 0, 0]),
      }
    : {}),
});

describe("ModelProject v1", () => {
  test("creates the authored Vitruvian starter with a public GLB asset and full spin", () => {
    const project = createVitruvianProject();
    expect(project.version).toBe(1);
    expect(project.assets).toEqual([
      {
        id: "vitruvian",
        name: "Vitruvian figure",
        kind: "glb",
        path: "/modeler/vitruvian.glb",
      },
    ]);
    expect(project.objects).toHaveLength(1);
    expect(project.tracks[0]?.property).toBe("rotationY");
    expect(project.tracks[0]?.keyframes.map((keyframe) => keyframe.value)).toEqual([0, 90, 180, 270, 360]);
  });

  test("evaluates transforms and pose tracks without mutating the project", () => {
    const project = createVitruvianProject();
    project.tracks.push({
      id: "spine-pose",
      targetId: "vitruvian-rig",
      property: "boneRotation",
      boneName: "spine",
      keyframes: [
        { timeMs: 0, value: [0, 0, 0], easing: "linear" },
        { timeMs: 10_000, value: [0, 40, 0], easing: "linear" },
      ],
    });
    const frame = evaluateModelFrame(project, 15_000);
    expect(frame.objects[0]?.transform.rotation[1]).toBe(180);
    expect(frame.rigs[0]?.pose.spine?.rotation[1]).toBe(40);
    expect(project.objects[0]?.transform.rotation[1]).toBe(0);
    expect(project.rigs[0]?.pose.spine?.rotation[1]).toBe(0);
  });

  test("round trips the manifest and ignores media-like fields", () => {
    const project = createVitruvianProject() as unknown as Record<string, unknown>;
    project.deviceId = "should-not-persist";
    project.video = new Blob(["media"]);
    const parsed = parseModelProject(JSON.stringify(project));
    expect(parsed).toEqual(createVitruvianProject());
    expect(parsed).not.toHaveProperty("deviceId");
    expect(parsed).not.toHaveProperty("video");
    expect(() => parseModelProject({ ...project, version: 2 })).toThrow(/version/);
  });
});

describe("Vitruvian V2 starter", () => {
  test("keeps the old starter URL while assigning independent complete rigs", () => {
    const legacy = createVitruvianProject();
    const v2 = createVitruvianV2Project();
    expect(legacy.assets[0]?.path).toBe("/modeler/vitruvian.glb");
    expect(v2.assets[0]?.path).toBe("/modeler/vitruvian-v2.glb");
    expect(v2.objects.map((object) => object.id)).toEqual([
      "vitruvian-v2-assembly", "vitruvian-primary", "vitruvian-ghost", "vitruvian-ring",
    ]);
    expect(v2.rigs).toHaveLength(2);
    expect(v2.rigs[0]?.bones).toHaveLength(163);
    expect(v2.rigs[1]?.bones).toHaveLength(163);
    const primaryNames = new Set(v2.rigs[0]?.bones.map((bone) => bone.name));
    expect(v2.rigs[1]?.bones.some((bone) => primaryNames.has(bone.name))).toBe(false);
    expect(v2.tracks[0]?.targetId).toBe("vitruvian-v2-assembly");
  });

  test("poses each figure separately and reloads without changing its schema", () => {
    const v2 = createVitruvianV2Project();
    v2.tracks.push({
      id: "primary-arm-lift",
      targetId: "vitruvian-v2-primary-rig",
      property: "boneRotation",
      boneName: "primary_upperarm01.L",
      keyframes: [
        { timeMs: 0, value: [0, 0, 0], easing: "linear" },
        { timeMs: 1000, value: [0, 0, 30], easing: "linear" },
      ],
    });
    const restored = parseModelProject(JSON.stringify(v2));
    const frame = evaluateModelFrame(restored, 1000);
    expect(frame.rigs[0]?.pose["primary_upperarm01.L"]?.rotation[2]).toBe(30);
    expect(frame.rigs[1]?.pose["ghost_upperarm01.L"]?.rotation[2]).toBe(0);
    expect(restored.version).toBe(1);
    expect(v2.rigs[0]?.pose["primary_upperarm01.L"]?.rotation[2]).toBe(0);
  });
});

describe("editable indexed meshes", () => {
  test("moves selected vertices with X symmetry", () => {
    const mesh: IndexedPolygonMesh = {
      positions: new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const result = moveVertices(mesh, createMeshSelection({ vertices: [0] }), [0.25, 0.5, 0], { symmetry: true });
    expect([...result.positions.slice(0, 3)]).toEqual([-0.75, 0.5, 0]);
    expect([...result.positions.slice(3, 6)]).toEqual([0.75, 0.5, 0]);
  });

  test("keeps skin indices and interpolates weights through topology edits", () => {
    const mesh = triangle(true);
    const extruded = extrudeFaces(mesh, [0], 0.5);
    expect(extruded.indices.length).toBe(15);
    expect(extruded.skinIndices?.length).toBe(extruded.positions.length / 3 * 4);
    expect(extruded.skinWeights?.length).toBe(extruded.positions.length / 3 * 4);
    const inset = insetFaces(mesh, [0], 0.25);
    expect(inset.indices.length).toBe(15);
    expect(inset.skinWeights?.slice(-4).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(() => remeshStatic(mesh, { targetEdgeLength: 0.5 })).toThrow(/static meshes/);
  });

  test("applies sculpt brushes, bevels edges, and records undo/redo", () => {
    const mesh = triangle();
    const sculpted = applySculptBrush(mesh, {
      kind: "grab",
      center: [0, 0, 0],
      radius: 2,
      strength: 0.5,
      direction: [0, 0, 1],
      symmetry: false,
    });
    expect(sculpted.positions[2]).toBeGreaterThan(0);
    const beveled = bevelEdges(mesh, ["0:1"], 0.25);
    expect(beveled.positions.length).toBeGreaterThan(mesh.positions.length);
    const editor = createMeshEditor(mesh);
    editor.selection.vertices.add(0);
    editor.move([1, 0, 0]);
    expect(editor.history.canUndo).toBe(true);
    editor.undo();
    expect(editor.mesh.positions[0]).toBe(mesh.positions[0]);
    editor.redo();
    expect(editor.mesh.positions[0]).toBe(mesh.positions[0] + 1);
  });
});

describe("local model drafts and bundles", () => {
  test("reloads V1 and V2 drafts with their original asset URLs", async () => {
    const store = createModelDraftStore(`modeler-generations-${Date.now()}`);
    const oldDraft = await store.saveDraft("Original figure", createVitruvianProject());
    const newDraft = await store.saveDraft("V2 figures", createVitruvianV2Project());
    expect((await store.loadDraft(oldDraft.id))?.project.assets[0]?.path).toBe("/modeler/vitruvian.glb");
    const restoredV2 = (await store.loadDraft(newDraft.id))?.project;
    expect(restoredV2?.assets[0]?.path).toBe("/modeler/vitruvian-v2.glb");
    expect(restoredV2?.rigs.map((rig) => rig.id)).toEqual([
      "vitruvian-v2-primary-rig", "vitruvian-v2-ghost-rig",
    ]);
  });

  test("stores named drafts separately from binary assets", async () => {
    const store = createModelDraftStore(`modeler-test-${Date.now()}`);
    const project = createVitruvianProject();
    const saved = await store.saveDraft("Neon figure", project, {
      "vitruvian.glb": new Uint8Array([1, 2, 3]),
    });
    const loaded = await store.loadDraft(saved.id);
    expect(loaded?.project).toEqual(project);
    expect(await store.loadAsset("vitruvian.glb")).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect((await store.listDrafts()).map((draft) => draft.name)).toContain("Neon figure");
  });

  test("exports and imports one manifest-plus-assets bundle", async () => {
    const project = createVitruvianProject();
    const bytes = await exportModelProjectBundle(project, {
      "vitruvian.glb": new Uint8Array([7, 8, 9]),
    });
    const imported = await importModelProjectBundle(bytes);
    expect(imported.project).toEqual(project);
    expect([...imported.assets["vitruvian.glb"]!]).toEqual([7, 8, 9]);
  });
});
