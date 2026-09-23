import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { IndexedPolygonMesh, MeshSelection } from "../core";

export type Vector3Tuple = [number, number, number];
export type PrimitiveKind = "box" | "sphere" | "torus" | "cylinder";

export type RuntimeFrame = {
  rotation: Vector3Tuple;
  position: Vector3Tuple;
  scale: Vector3Tuple;
  boneRotations: Record<string, Vector3Tuple>;
  /** Per-object deltas used by the V2 assembly; legacy fields remain supported. */
  objects?: Array<{
    id: string;
    position: Vector3Tuple;
    rotation: Vector3Tuple;
    scale: Vector3Tuple;
    visible?: boolean;
  }>;
  /** Per-rig pose deltas, keyed by the project rig id. */
  rigs?: Array<{
    id: string;
    boneRotations: Record<string, Vector3Tuple>;
  }>;
  glow: number;
  camera: Vector3Tuple;
  cameraTarget: Vector3Tuple;
  lightIntensity: number;
  fov: number;
  glowRadius: number;
};

export type RuntimeMaterial = {
  color: string;
  emissive: string;
  emissiveIntensity: number;
  metalness: number;
  roughness: number;
  opacity: number;
  transparent: boolean;
};

export type SceneItem = {
  id: string;
  name: string;
  type: "model" | "primitive";
  visible: boolean;
};

export type RuntimeAssetLayout = {
  kind: "legacy" | "v2" | "imported";
  objectIds: string[];
  rigIds: string[];
  bonesByRig: Record<string, string[]>;
};

/** Detect the stable authored names that identify the composite V2 asset. */
export const detectRuntimeAssetKind = (nodeNames: Iterable<string>): RuntimeAssetLayout["kind"] => {
  const names = new Set(nodeNames);
  return names.has("vitruvian-primary") && names.has("vitruvian-ghost") && names.has("vitruvian-ring")
    ? "v2"
    : "legacy";
};

/**
 * GLTFLoader usually returns a scene wrapper around authored nodes. Keep the
 * wrapper for ownership, but animate the authored assembly when it exists.
 */
export const findAuthoredAssembly = (source: THREE.Group): THREE.Object3D =>
  source.getObjectByName("vitruvian-v2-assembly") ?? source;

const V2_AUTHORED_NODE_IDS = new Set([
  "vitruvian-v2-assembly",
  "vitruvian-primary",
  "vitruvian-ghost",
  "vitruvian-ring",
]);

/** Keep authored V2 names stable for GLB animation bindings and reimport. */
export const stableRuntimeNodeName = (
  assetKind: RuntimeAssetLayout["kind"],
  id: string,
  currentName: string,
  requestedName: string,
): string => assetKind === "v2" && V2_AUTHORED_NODE_IDS.has(id) ? currentName : requestedName;

type ModelRoot = THREE.Group & { userData: { modelerId?: string } };

type SourceTransform = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

type RigRuntime = {
  id: string;
  bones: Map<string, { bone: THREE.Bone; rest: THREE.Quaternion }>;
};

const boneRotation = (rotations: Record<string, Vector3Tuple>, runtimeName: string): Vector3Tuple =>
  rotations[runtimeName] ?? rotations[runtimeName.replace(/([LR])$/, ".$1")] ?? [0, 0, 0];

const DEFAULT_FRAME: RuntimeFrame = {
  rotation: [0, 0, 0],
  position: [0, 0, 0],
  scale: [1, 1, 1],
  boneRotations: {},
  glow: 0.65,
  camera: [0, 0.25, 8.5],
  cameraTarget: [0, 0.15, 0],
  lightIntensity: 2.5,
  fov: 42,
  glowRadius: 5,
};

const makeFallback = (): THREE.Group => {
  const group = new THREE.Group();
  group.name = "Vitruvian figure";
  const material = new THREE.MeshStandardMaterial({
    color: 0x1b66cd,
    emissive: 0x1166e8,
    emissiveIntensity: 0.35,
    metalness: 0.28,
    roughness: 0.38,
  });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.58, 1.5, 8, 20), material);
  torso.scale.set(1.2, 1, 0.62);
  group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 24, 16), material);
  head.position.y = 1.6;
  group.add(head);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.6, 0.015, 8, 160),
    new THREE.MeshBasicMaterial({ color: 0x258eff }),
  );
  group.add(ring);
  return group;
};

const download = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

export function serializeStaticObj(root: THREE.Object3D): string {
  root.updateMatrixWorld(true);
  const baked = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const vertex = new THREE.Vector3();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry.clone();
    const position = geometry.getAttribute("position");
    if (!position) {
      geometry.dispose();
      return;
    }
    for (let index = 0; index < position.count; index += 1) {
      object.getVertexPosition(index, vertex).applyMatrix4(object.matrixWorld);
      position.setXYZ(index, vertex.x, vertex.y, vertex.z);
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, object.material);
    mesh.name = object.name;
    baked.add(mesh);
    geometries.push(geometry);
  });
  try {
    return new OBJExporter().parse(baked);
  } finally {
    geometries.forEach((geometry) => geometry.dispose());
  }
}

export class ModelerScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 100);
  readonly output = document.createElement("canvas");
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly context: CanvasRenderingContext2D;
  private readonly picker = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly model = new THREE.Group();
  private readonly ambient = new THREE.AmbientLight(0x709de3, 1.7);
  private readonly key = new THREE.DirectionalLight(0x9dcfff, 2.5);
  private readonly rim = new THREE.DirectionalLight(0x1472ff, 3.5);
  private readonly loader = new GLTFLoader();
  /** Legacy aggregate bone map kept for old projects and imported assets. */
  private readonly boneRest = new Map<THREE.Bone, THREE.Quaternion>();
  /** V2 keeps the two armatures separate so pose tracks cannot cross-bind. */
  private readonly rigRuntimes = new Map<string, RigRuntime>();
  private readonly items = new Map<string, THREE.Object3D>();
  private readonly authoredTransforms = new Map<string, SourceTransform>();
  private selectionGuide: THREE.Group | null = null;
  private selectionTarget: THREE.Mesh | null = null;
  private baseAsset: ModelRoot | null = null;
  private assetKind: RuntimeAssetLayout["kind"] = "legacy";
  private assetPath = "/modeler/vitruvian.glb";
  private protectedItemIds = new Set<string>();
  private renderedWidth = 0;
  private renderedHeight = 0;
  private disposed = false;
  private applyingFrame = false;
  onCameraChange?: (position: Vector3Tuple, target: Vector3Tuple) => void;

  constructor(private readonly host: HTMLElement) {
    this.output.className = "modeler-canvas";
    this.output.setAttribute("aria-label", "3D model preview");
    const context = this.output.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas 2D is unavailable.");
    this.context = context;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45;
    this.renderer.domElement.className = "modeler-webgl-source";
    this.host.append(this.renderer.domElement, this.output);

    this.camera.position.set(...DEFAULT_FRAME.camera);
    this.controls = new OrbitControls(this.camera, this.output);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(...DEFAULT_FRAME.cameraTarget);
    this.controls.minDistance = 3;
    this.controls.maxDistance = 18;
    this.controls.update();
    this.controls.addEventListener("change", () => {
      if (!this.applyingFrame) {
        this.onCameraChange?.(
          this.camera.position.toArray() as Vector3Tuple,
          this.controls.target.toArray() as Vector3Tuple,
        );
      }
    });

    this.key.position.set(-3, 5, 6);
    this.rim.position.set(2, 1, -4);
    this.scene.add(this.ambient, this.key, this.rim, this.model);
    this.model.name = "Model";
  }

  async loadDefault(assetPath = "/modeler/vitruvian-v2.glb"): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync(assetPath);
      this.replaceBase(gltf.scene, assetPath);
    } catch (error) {
      this.replaceBase(makeFallback());
      throw new Error(`The Vitruvian asset could not be loaded from ${assetPath}. A temporary preview is shown.`, { cause: error });
    }
  }

  async loadGlb(file: File | Blob, name = "Imported model"): Promise<void> {
    const data = await file.arrayBuffer();
    const gltf = await this.loader.parseAsync(data, "");
    gltf.scene.name = name;
    this.replaceBase(gltf.scene, "local-import");
  }

  clearBase(): void {
    this.replaceBase(new THREE.Group());
    this.baseAsset!.name = "Empty scene";
  }

  private replaceBase(source: THREE.Group, assetPath = "local-import"): void {
    this.clearSelection();
    if (this.baseAsset) {
      this.model.remove(this.baseAsset);
      this.baseAsset.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
    }
    this.items.clear();
    this.authoredTransforms.clear();
    this.boneRest.clear();
    this.rigRuntimes.clear();
    this.protectedItemIds.clear();
    this.assetPath = assetPath;
    const group = source as ModelRoot;
    const nodeNames: string[] = [];
    group.traverse((object) => nodeNames.push(object.name));
    this.assetKind = assetPath === "/modeler/vitruvian-v2.glb"
      || detectRuntimeAssetKind(nodeNames) === "v2" ? "v2" : assetPath === "local-import" ? "imported" : "legacy";
    this.baseAsset = group;
    this.model.add(group);
    if (this.assetKind === "v2") {
      const assembly = findAuthoredAssembly(group);
      if (assembly === group) assembly.name = "vitruvian-v2-assembly";
      this.registerItem("vitruvian-v2-assembly", assembly);
      this.registerNamedItem(group, "vitruvian-primary");
      this.registerNamedItem(group, "vitruvian-ghost");
      this.registerNamedItem(group, "vitruvian-ring");
      this.protectedItemIds.add("vitruvian-v2-assembly");
      this.protectedItemIds.add("vitruvian-primary");
      this.protectedItemIds.add("vitruvian-ghost");
      this.protectedItemIds.add("vitruvian-ring");
      this.registerRig("vitruvian-v2-primary-rig", group.getObjectByName("vitruvian-primary"));
      this.registerRig("vitruvian-v2-ghost-rig", group.getObjectByName("vitruvian-ghost"));
    } else {
      group.name ||= "Vitruvian figure";
      group.userData.modelerId = "vitruvian-figure";
      this.registerItem("vitruvian-figure", group);
      this.protectedItemIds.add("vitruvian-figure");
      const ring = group.getObjectByName("vitruvian-ring");
      if (ring) {
        ring.userData.modelerId = "vitruvian-ring";
        this.registerItem("vitruvian-ring", ring);
        this.protectedItemIds.add("vitruvian-ring");
      }
      this.registerRig("legacy-rig", group);
    }
    let meshIndex = 0;
    const meshNames = new Set<string>();
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        meshIndex += 1;
        const originalName = object.name || "Mesh " + meshIndex;
        let meshName = originalName;
        let suffix = 2;
        while (meshNames.has(meshName)) meshName = `${originalName} ${suffix++}`;
        object.name = meshName;
        meshNames.add(meshName);
        object.castShadow = false;
        object.frustumCulled = false;
      }
    });
  }

  private registerItem(id: string, object: THREE.Object3D): void {
    object.userData.modelerId = id;
    this.items.set(id, object);
    this.authoredTransforms.set(id, {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    });
  }

  private registerNamedItem(group: THREE.Group, name: string): void {
    const object = group.getObjectByName(name);
    if (!object) return;
    this.registerItem(name, object);
  }

  private registerRig(id: string, target: THREE.Object3D | undefined): void {
    if (!target) return;
    const bones = new Map<string, { bone: THREE.Bone; rest: THREE.Quaternion }>();
    const addBone = (bone: THREE.Bone): void => {
      if (!bone.name || bones.has(bone.name)) return;
      const rest = bone.quaternion.clone();
      bones.set(bone.name, { bone, rest });
      this.boneRest.set(bone, rest.clone());
    };
    target.traverse((object) => {
      if (object instanceof THREE.Bone) addBone(object);
      if (object instanceof THREE.SkinnedMesh) object.skeleton.bones.forEach(addBone);
    });
    if (!bones.size && target instanceof THREE.SkinnedMesh) target.skeleton.bones.forEach(addBone);
    if (bones.size) this.rigRuntimes.set(id, { id, bones });
  }

  getSceneItems(): SceneItem[] {
    return Array.from(this.items, ([id, object]) => ({
      id,
      name: String(object.userData.modelerLabel ?? object.name ?? id),
      type: this.protectedItemIds.has(id) ? "model" : "primitive",
      visible: object.visible,
    }));
  }

  getBones(): string[] {
    return Array.from(this.boneRest.keys()).map((bone) => bone.name).filter(Boolean);
  }

  getAssetLayout(): RuntimeAssetLayout {
    return {
      kind: this.assetKind,
      objectIds: Array.from(this.items.keys()),
      rigIds: Array.from(this.rigRuntimes.keys()),
      bonesByRig: Object.fromEntries(Array.from(this.rigRuntimes, ([id, rig]) => [id, Array.from(rig.bones.keys())])),
    };
  }

  getMeshes(): string[] {
    const names: string[] = [];
    this.model.traverse((object) => {
      if (object instanceof THREE.Mesh) names.push(object.name || `Mesh ${names.length + 1}`);
    });
    return names;
  }

  getMesh(name: string): THREE.Mesh | null {
    let found: THREE.Mesh | null = null;
    this.model.traverse((object) => {
      if (!found && object instanceof THREE.Mesh && object.name === name) found = object;
    });
    return found;
  }

  localPoint(meshName: string, worldPoint: Vector3Tuple): Vector3Tuple {
    const mesh = this.getMesh(meshName);
    if (!mesh) throw new Error("The selected mesh is no longer in the scene.");
    return mesh.worldToLocal(new THREE.Vector3(...worldPoint)).toArray() as Vector3Tuple;
  }

  showSelection(meshName: string, data: IndexedPolygonMesh, selection: MeshSelection): void {
    this.clearSelection();
    const target = this.getMesh(meshName);
    if (!target) return;
    const group = new THREE.Group();
    group.name = "Selection guide";
    group.matrixAutoUpdate = false;
    const pointAt = (index: number): Vector3Tuple => [
      data.positions[index * 3] ?? 0,
      data.positions[index * 3 + 1] ?? 0,
      data.positions[index * 3 + 2] ?? 0,
    ];
    const facePositions: number[] = [];
    for (const face of selection.faces) {
      const start = face * 3;
      for (let offset = 0; offset < 3; offset += 1) {
        facePositions.push(...pointAt(data.indices[start + offset] ?? 0));
      }
    }
    if (facePositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(facePositions, 3));
      group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0xff722e, transparent: true, opacity: 0.48, side: THREE.DoubleSide, depthTest: false,
      })));
    }
    const edgePositions: number[] = [];
    for (const key of selection.edges) {
      const pair = key.split(":").map(Number);
      if (pair.length !== 2 || pair.some((value) => !Number.isInteger(value))) continue;
      edgePositions.push(...pointAt(pair[0]!), ...pointAt(pair[1]!));
    }
    if (edgePositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
      group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        color: 0xff8b4d, depthTest: false,
      })));
    }
    const vertexPositions: number[] = [];
    for (const index of selection.vertices) vertexPositions.push(...pointAt(index));
    if (vertexPositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertexPositions, 3));
      group.add(new THREE.Points(geometry, new THREE.PointsMaterial({
        color: 0xff8b4d, size: 9, sizeAttenuation: false, depthTest: false,
      })));
    }
    this.scene.add(group);
    this.selectionGuide = group;
    this.selectionTarget = target;
  }

  clearSelection(): void {
    if (!this.selectionGuide) return;
    this.scene.remove(this.selectionGuide);
    this.selectionGuide.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.selectionGuide = null;
    this.selectionTarget = null;
  }

  addPrimitive(id: string, kind: PrimitiveKind): void {
    const geometry: THREE.BufferGeometry =
      kind === "box" ? new THREE.BoxGeometry(0.9, 0.9, 0.9, 8, 8, 8) :
      kind === "sphere" ? new THREE.SphereGeometry(0.6, 32, 20) :
      kind === "cylinder" ? new THREE.CylinderGeometry(0.5, 0.5, 1.2, 32, 8) :
      new THREE.TorusGeometry(0.7, 0.16, 12, 48);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0x2c8bff,
      metalness: 0.38,
      roughness: 0.35,
      emissive: 0x0a2764,
    }));
    mesh.name = kind[0].toUpperCase() + kind.slice(1);
    const group = new THREE.Group() as ModelRoot;
    group.userData.modelerId = id;
    group.name = mesh.name;
    group.position.set(0, 0, 0.8);
    group.add(mesh);
    this.model.add(group);
    this.items.set(id, group);
    this.authoredTransforms.set(id, {
      position: group.position.clone(),
      quaternion: group.quaternion.clone(),
      scale: group.scale.clone(),
    });
  }

  removeItem(id: string): void {
    if (this.protectedItemIds.has(id)) return;
    const item = this.items.get(id);
    if (!item) return;
    if (this.selectionTarget && item.getObjectById(this.selectionTarget.id)) this.clearSelection();
    this.model.remove(item);
    this.items.delete(id);
    this.authoredTransforms.delete(id);
    item.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }

  setItem(id: string, values: { name?: string; visible?: boolean; position?: Vector3Tuple; rotation?: Vector3Tuple; scale?: Vector3Tuple; material?: RuntimeMaterial }): void {
    const item = this.items.get(id);
    if (!item) return;
    if (values.name !== undefined) {
      const stableName = stableRuntimeNodeName(this.assetKind, id, item.name, values.name);
      if (stableName === item.name && this.assetKind === "v2" && V2_AUTHORED_NODE_IDS.has(id)) {
        item.userData.modelerLabel = values.name;
      } else {
        item.name = stableName;
      }
    }
    if (values.visible !== undefined) item.visible = values.visible;
    const authored = this.authoredTransforms.get(id);
    if (values.position) {
      const position = authored?.position.clone() ?? new THREE.Vector3();
      item.position.copy(position.add(new THREE.Vector3(...values.position)));
    }
    if (values.rotation) {
      const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(values.rotation[0]),
        THREE.MathUtils.degToRad(values.rotation[1]),
        THREE.MathUtils.degToRad(values.rotation[2]),
      ));
      item.quaternion.copy(authored?.quaternion ?? new THREE.Quaternion()).multiply(delta);
    }
    if (values.scale) {
      const scale = authored?.scale.clone() ?? new THREE.Vector3(1, 1, 1);
      item.scale.copy(scale.multiply(new THREE.Vector3(...values.scale)));
    }
    if (values.material) {
      const settings = values.material;
      item.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          material.color.set(settings.color);
          material.emissive.set(settings.emissive);
          material.emissiveIntensity = settings.emissiveIntensity;
          material.metalness = settings.metalness;
          material.roughness = settings.roughness;
          material.opacity = settings.opacity;
          const transparent = settings.transparent || settings.opacity < 1;
          if (material.transparent !== transparent) {
            material.transparent = transparent;
            material.needsUpdate = true;
          }
        }
      });
    }
  }

  pick(clientX: number, clientY: number): { id: string; meshName: string; faceIndex: number | null; point: Vector3Tuple } | null {
    const bounds = this.output.getBoundingClientRect();
    this.pointer.set(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.picker.setFromCamera(this.pointer, this.camera);
    const hit = this.picker.intersectObject(this.model, true)[0];
    if (!hit) return null;
    let object: THREE.Object3D | null = hit.object;
    while (object && !object.userData.modelerId) object = object.parent;
    return {
      id: String(object?.userData.modelerId ?? "vitruvian-figure"),
      meshName: hit.object.name,
      faceIndex: hit.faceIndex ?? null,
      point: hit.point.toArray() as Vector3Tuple,
    };
  }

  private applyRuntimeFrame(frame: RuntimeFrame): void {
    const value = { ...DEFAULT_FRAME, ...frame };
    const objectFrames = value.objects ?? [{
      id: this.assetKind === "v2" ? "vitruvian-v2-assembly" : "vitruvian-figure",
      position: value.position,
      rotation: value.rotation,
      scale: value.scale,
    }];
    for (const object of objectFrames) {
      this.setItem(object.id, {
        position: object.position,
        rotation: object.rotation,
        scale: object.scale,
        visible: object.visible,
      });
    }
    const rigFrames = new Map((value.rigs ?? []).map((rig) => [rig.id, rig.boneRotations]));
    for (const [rigId, rig] of this.rigRuntimes) {
      const rotations = rigFrames.get(rigId) ?? (rigId === "legacy-rig" ? value.boneRotations : undefined) ?? {};
      for (const [name, runtimeBone] of rig.bones) {
        const angles = boneRotation(rotations, name);
        const posed = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(angles[0]),
          THREE.MathUtils.degToRad(angles[1]),
          THREE.MathUtils.degToRad(angles[2]),
        ));
        runtimeBone.bone.quaternion.copy(runtimeBone.rest).multiply(posed);
      }
    }
  }

  renderFrame(frame: RuntimeFrame, width: number, height: number, transparent = true, matte = "#080a0d", showGuides = true): HTMLCanvasElement {
    if (this.disposed) throw new Error("The 3D renderer has been closed.");
    const value = { ...DEFAULT_FRAME, ...frame };
    this.applyRuntimeFrame(value);
    this.applyingFrame = true;
    this.camera.position.set(...value.camera);
    this.camera.fov = value.fov;
    this.controls.target.set(...value.cameraTarget);
    this.controls.update();
    this.applyingFrame = false;
    this.key.intensity = value.lightIntensity;
    if (this.selectionGuide && this.selectionTarget) {
      this.model.updateMatrixWorld(true);
      this.selectionGuide.matrix.copy(this.selectionTarget.matrixWorld);
      this.selectionGuide.visible = showGuides;
    }
    if (this.renderedWidth !== width || this.renderedHeight !== height) {
      this.renderer.setSize(width, height, false);
      this.renderedWidth = width;
      this.renderedHeight = height;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    if (this.output.width !== width || this.output.height !== height) {
      this.output.width = width;
      this.output.height = height;
    }
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    if (!transparent) {
      ctx.fillStyle = matte;
      ctx.fillRect(0, 0, width, height);
    }
    const glow = Math.max(0, Math.min(2, value.glow));
    if (glow > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.9, glow * 0.7);
      ctx.filter = `blur(${Math.max(2, value.glowRadius * width / 960)}px) brightness(1.8)`;
      ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
      ctx.restore();
    }
    ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
    return this.output;
  }

  fitPreview(frame: RuntimeFrame, transparent = true, matte = "#080a0d"): HTMLCanvasElement {
    const bounds = this.host.getBoundingClientRect();
    const width = Math.max(64, Math.floor(bounds.width));
    const height = Math.max(64, Math.floor(bounds.height));
    return this.renderFrame(frame, width, height, transparent, matte);
  }

  async exportGlb(filename: string, animations: THREE.AnimationClip[] = []): Promise<void> {
    const exporter = new GLTFExporter();
    const data = await exporter.parseAsync(this.model, { binary: true, animations, onlyVisible: false });
    if (!(data instanceof ArrayBuffer)) throw new Error("GLB export returned an unexpected format.");
    download(new Blob([data], { type: "model/gltf-binary" }), filename);
  }

  createAssetClip(durationMs: number, sample: (timeMs: number) => RuntimeFrame): THREE.AnimationClip {
    const fps = 60;
    const count = Math.max(2, Math.ceil(durationMs / 1000 * fps) + 1);
    const times: number[] = [];
    const objectValues = new Map<string, { rotations: number[]; positions: number[]; scales: number[] }>();
    for (const id of this.items.keys()) objectValues.set(id, { rotations: [], positions: [], scales: [] });
    const boneValues = new Map<string, number[]>();
    for (const rig of this.rigRuntimes.values()) {
      for (const [name] of rig.bones) boneValues.set(`${rig.id}:${name}`, []);
    }
    for (let index = 0; index < count; index += 1) {
      const timeMs = index === count - 1 ? durationMs : Math.min(durationMs, index * 1000 / fps);
      const frame = sample(timeMs);
      times.push(timeMs / 1000);
      const objects = frame.objects ?? [{
        id: this.assetKind === "v2" ? "vitruvian-v2-assembly" : "vitruvian-figure",
        position: frame.position,
        rotation: frame.rotation,
        scale: frame.scale,
      }];
      for (const object of objects) {
        const item = this.items.get(object.id);
        const values = objectValues.get(object.id);
        if (!item || !values) continue;
        const authored = this.authoredTransforms.get(object.id);
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(object.rotation[0]),
          THREE.MathUtils.degToRad(object.rotation[1]),
          THREE.MathUtils.degToRad(object.rotation[2]),
        ));
        const quaternion = (authored?.quaternion.clone() ?? new THREE.Quaternion()).multiply(rotation);
        const position = (authored?.position.clone() ?? new THREE.Vector3()).add(new THREE.Vector3(...object.position));
        const scale = (authored?.scale.clone() ?? new THREE.Vector3(1, 1, 1)).multiply(new THREE.Vector3(...object.scale));
        values.rotations.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        values.positions.push(position.x, position.y, position.z);
        values.scales.push(scale.x, scale.y, scale.z);
      }
      const rigFrames = new Map((frame.rigs ?? []).map((rig) => [rig.id, rig.boneRotations]));
      for (const [rigId, rig] of this.rigRuntimes) {
        const rotations = rigFrames.get(rigId) ?? (rigId === "legacy-rig" ? frame.boneRotations : undefined) ?? {};
        for (const [name, runtimeBone] of rig.bones) {
          const degrees = boneRotation(rotations, name);
          const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(degrees[0]),
            THREE.MathUtils.degToRad(degrees[1]),
            THREE.MathUtils.degToRad(degrees[2]),
          ));
          const pose = runtimeBone.rest.clone().multiply(delta);
          boneValues.get(`${rigId}:${name}`)!.push(pose.x, pose.y, pose.z, pose.w);
        }
      }
    }
    const tracks: THREE.KeyframeTrack[] = [];
    for (const [id, values] of objectValues) {
      const object = this.items.get(id);
      if (!object || !values.rotations.length) continue;
      const path = object.name || id;
      tracks.push(new THREE.QuaternionKeyframeTrack(`${path}.quaternion`, times, values.rotations));
      tracks.push(new THREE.VectorKeyframeTrack(`${path}.position`, times, values.positions));
      tracks.push(new THREE.VectorKeyframeTrack(`${path}.scale`, times, values.scales));
    }
    for (const [key, values] of boneValues) {
      const [rigId, ...nameParts] = key.split(":");
      const name = nameParts.join(":");
      const bone = this.rigRuntimes.get(rigId)?.bones.get(name)?.bone;
      if (bone?.name && values.length) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
    }
    this.applyRuntimeFrame(sample(0));
    return new THREE.AnimationClip("RapidScreen motion", durationMs / 1000, tracks);
  }

  exportObj(filename: string): void {
    const data = serializeStaticObj(this.model);
    download(new Blob([data], { type: "text/plain" }), filename);
  }

  async snapshotGlb(): Promise<Blob> {
    const exporter = new GLTFExporter();
    const data = await exporter.parseAsync(this.model, { binary: true, onlyVisible: false });
    if (!(data instanceof ArrayBuffer)) throw new Error("GLB snapshot failed.");
    return new Blob([data], { type: "model/gltf-binary" });
  }

  dispose(): void {
    this.disposed = true;
    this.clearSelection();
    this.controls.dispose();
    this.renderer.dispose();
    this.output.remove();
    this.renderer.domElement.remove();
  }
}
