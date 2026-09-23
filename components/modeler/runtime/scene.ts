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

type ModelRoot = THREE.Group & { userData: { modelerId?: string } };

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
  private readonly boneRest = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly items = new Map<string, THREE.Object3D>();
  private selectionGuide: THREE.Group | null = null;
  private selectionTarget: THREE.Mesh | null = null;
  private baseAsset: ModelRoot | null = null;
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

  async loadDefault(): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync("/modeler/vitruvian.glb");
      this.replaceBase(gltf.scene);
    } catch (error) {
      this.replaceBase(makeFallback());
      throw new Error("The Vitruvian asset could not be loaded. A temporary preview is shown.", { cause: error });
    }
  }

  async loadGlb(file: File | Blob, name = "Imported model"): Promise<void> {
    const data = await file.arrayBuffer();
    const gltf = await this.loader.parseAsync(data, "");
    gltf.scene.name = name;
    this.replaceBase(gltf.scene);
  }

  clearBase(): void {
    this.replaceBase(new THREE.Group());
    this.baseAsset!.name = "Empty scene";
  }

  private replaceBase(source: THREE.Group): void {
    this.clearSelection();
    if (this.baseAsset) {
      this.model.remove(this.baseAsset);
      this.items.delete("vitruvian-figure");
      this.items.delete("vitruvian-ring");
      this.baseAsset.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
    }
    const group = source as ModelRoot;
    group.name ||= "Vitruvian figure";
    group.userData.modelerId = "vitruvian-figure";
    this.baseAsset = group;
    this.model.add(group);
    this.items.set("vitruvian-figure", group);
    const ring = group.getObjectByName("vitruvian-ring");
    if (ring) {
      ring.userData.modelerId = "vitruvian-ring";
      this.items.set("vitruvian-ring", ring);
    }
    this.boneRest.clear();
    let meshIndex = 0;
    group.traverse((object) => {
      if (object instanceof THREE.Bone) this.boneRest.set(object, object.quaternion.clone());
      if (object instanceof THREE.Mesh) {
        meshIndex += 1;
        object.name ||= "Mesh " + meshIndex;
        object.castShadow = false;
        object.frustumCulled = false;
      }
    });
  }

  getSceneItems(): SceneItem[] {
    return Array.from(this.items, ([id, object]) => ({
      id,
      name: object.name || id,
      type: id === "vitruvian-figure" || id === "vitruvian-ring" ? "model" : "primitive",
      visible: object.visible,
    }));
  }

  getBones(): string[] {
    return Array.from(this.boneRest.keys()).map((bone) => bone.name).filter(Boolean);
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
  }

  removeItem(id: string): void {
    if (id === "vitruvian-figure" || id === "vitruvian-ring") return;
    const item = this.items.get(id);
    if (!item) return;
    if (this.selectionTarget && item.getObjectById(this.selectionTarget.id)) this.clearSelection();
    this.model.remove(item);
    this.items.delete(id);
    item.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }

  setItem(id: string, values: { name?: string; visible?: boolean; position?: Vector3Tuple; rotation?: Vector3Tuple; scale?: Vector3Tuple; material?: RuntimeMaterial }): void {
    const item = this.items.get(id);
    if (!item) return;
    if (values.name !== undefined) item.name = values.name;
    if (values.visible !== undefined) item.visible = values.visible;
    if (values.position) item.position.set(...values.position);
    if (values.rotation) item.rotation.set(...values.rotation.map((value) => THREE.MathUtils.degToRad(value)) as Vector3Tuple);
    if (values.scale) item.scale.set(...values.scale);
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

  renderFrame(frame: RuntimeFrame, width: number, height: number, transparent = true, matte = "#080a0d", showGuides = true): HTMLCanvasElement {
    if (this.disposed) throw new Error("The 3D renderer has been closed.");
    const value = { ...DEFAULT_FRAME, ...frame };
    const figure = this.baseAsset;
    if (figure) {
      figure.position.set(...value.position);
      figure.rotation.set(...value.rotation.map(THREE.MathUtils.degToRad) as Vector3Tuple);
      figure.scale.set(...value.scale);
    }
    this.applyingFrame = true;
    this.camera.position.set(...value.camera);
    this.camera.fov = value.fov;
    this.controls.target.set(...value.cameraTarget);
    this.controls.update();
    this.applyingFrame = false;
    for (const [bone, rest] of this.boneRest) {
      const angles = value.boneRotations[bone.name] ?? [0, 0, 0];
      const posed = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(angles[0]),
        THREE.MathUtils.degToRad(angles[1]),
        THREE.MathUtils.degToRad(angles[2]),
      ));
      bone.quaternion.copy(rest).multiply(posed);
    }
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
    const rootRotation: number[] = [];
    const rootPosition: number[] = [];
    const rootScale: number[] = [];
    const boneValues = new Map<THREE.Bone, number[]>();
    for (const bone of this.boneRest.keys()) boneValues.set(bone, []);
    for (let index = 0; index < count; index += 1) {
      const timeMs = index === count - 1 ? durationMs : Math.min(durationMs, index * 1000 / fps);
      const frame = sample(timeMs);
      times.push(timeMs / 1000);
      const root = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(frame.rotation[0]),
        THREE.MathUtils.degToRad(frame.rotation[1]),
        THREE.MathUtils.degToRad(frame.rotation[2]),
      ));
      rootRotation.push(root.x, root.y, root.z, root.w);
      rootPosition.push(...frame.position);
      rootScale.push(...frame.scale);
      for (const [bone, rest] of this.boneRest) {
        const degrees = frame.boneRotations[bone.name] ?? [0, 0, 0];
        const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(degrees[0]),
          THREE.MathUtils.degToRad(degrees[1]),
          THREE.MathUtils.degToRad(degrees[2]),
        ));
        const pose = rest.clone().multiply(delta);
        boneValues.get(bone)!.push(pose.x, pose.y, pose.z, pose.w);
      }
    }
    const tracks: THREE.KeyframeTrack[] = [
      new THREE.QuaternionKeyframeTrack(`${this.baseAsset?.name ?? "Vitruvian figure"}.quaternion`, times, rootRotation),
      new THREE.VectorKeyframeTrack(`${this.baseAsset?.name ?? "Vitruvian figure"}.position`, times, rootPosition),
      new THREE.VectorKeyframeTrack(`${this.baseAsset?.name ?? "Vitruvian figure"}.scale`, times, rootScale),
    ];
    for (const [bone, values] of boneValues) {
      if (bone.name) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
    }
    return new THREE.AnimationClip("RapidScreen motion", durationMs / 1000, tracks);
  }

  exportObj(filename: string): void {
    const exporter = new OBJExporter();
    const data = exporter.parse(this.model);
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
