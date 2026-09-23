import { describe, expect, test } from "bun:test";
import * as THREE from "three";

import { createVitruvianProject, createVitruvianV2Project, evaluateModelFrame } from "../components/modeler/core";
import { detectRuntimeAssetKind, findAuthoredAssembly, stableRuntimeNodeName } from "../components/modeler/runtime/scene";

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

  test("maps a GLTF scene wrapper to its authored assembly without detaching children", () => {
    const wrapper = new THREE.Group();
    wrapper.name = "Scene";
    const assembly = new THREE.Group();
    assembly.name = "vitruvian-v2-assembly";
    const primary = new THREE.Group();
    primary.name = "vitruvian-primary";
    const ghost = new THREE.Group();
    ghost.name = "vitruvian-ghost";
    const ring = new THREE.Group();
    ring.name = "vitruvian-ring";
    assembly.add(primary, ghost, ring);
    wrapper.add(assembly);

    expect(findAuthoredAssembly(wrapper)).toBe(assembly);
    expect(assembly.parent).toBe(wrapper);
    expect(assembly.children.map((child) => child.name)).toEqual([
      "vitruvian-primary",
      "vitruvian-ghost",
      "vitruvian-ring",
    ]);
    expect(wrapper.name).not.toBe(assembly.name);
    expect(new Set([wrapper.name, assembly.name, primary.name, ghost.name, ring.name]).size).toBe(5);
  });

  test("preserves V2 authored node names while allowing display labels", () => {
    expect(stableRuntimeNodeName("v2", "vitruvian-primary", "vitruvian-primary", "Primary figure"))
      .toBe("vitruvian-primary");
    expect(stableRuntimeNodeName("v2", "vitruvian-ring", "vitruvian-ring", "Electric ring"))
      .toBe("vitruvian-ring");
    expect(stableRuntimeNodeName("legacy", "vitruvian-figure", "Vitruvian figure", "Hero"))
      .toBe("Hero");
  });
});
