import { describe, expect, test } from "bun:test";

import { createVitruvianProject, createVitruvianV2Project, evaluateModelFrame } from "../components/modeler/core";
import { detectRuntimeAssetKind } from "../components/modeler/runtime/scene";

describe("modeler V2 runtime contract", () => {
  test("recognizes the composite nodes and leaves legacy scenes on the old path", () => {
    expect(detectRuntimeAssetKind(["vitruvian-primary", "vitruvian-ghost", "vitruvian-ring"])).toBe("v2");
    expect(detectRuntimeAssetKind(["vitruvian-figure", "vitruvian-ring"])).toBe("legacy");
    expect(detectRuntimeAssetKind(["Scene", "Armature", "Body"])).toBe("legacy");
  });

  test("V2 starter exposes one assembly, two independently keyed rigs, and a shared spin target", () => {
    const project = createVitruvianV2Project();
    expect(project.assets[0]?.path).toBe("/modeler/vitruvian-v2.glb");
    expect(project.objects.map((object) => object.id)).toEqual([
      "vitruvian-v2-assembly",
      "vitruvian-primary",
      "vitruvian-ghost",
      "vitruvian-ring",
    ]);
    expect(project.objects.find((object) => object.id === "vitruvian-primary")?.rigId)
      .toBe("vitruvian-v2-primary-rig");
    expect(project.objects.find((object) => object.id === "vitruvian-ghost")?.rigId)
      .toBe("vitruvian-v2-ghost-rig");
    expect(project.rigs[0]?.bones[0]?.name.startsWith("primary_")).toBe(true);
    expect(project.rigs[1]?.bones[0]?.name.startsWith("ghost_")).toBe(true);

    const frame = evaluateModelFrame(project, 15_000);
    expect(frame.objects.find((object) => object.id === "vitruvian-v2-assembly")?.transform.rotation[1]).toBe(180);
    expect(frame.rigs).toHaveLength(2);
    expect(frame.rigs[0]?.pose).not.toBe(frame.rigs[1]?.pose);
  });

  test("legacy starter keeps its original public asset and single rig contract", () => {
    const project = createVitruvianProject();
    expect(project.assets[0]?.path).toBe("/modeler/vitruvian.glb");
    expect(project.objects.map((object) => object.id)).toEqual(["vitruvian-figure"]);
    expect(project.rigs).toHaveLength(1);
  });
});
