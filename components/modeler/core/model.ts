import { mpfbStandardBones } from "./mpfb-rig";

export const MODEL_PROJECT_VERSION = 1 as const;

export type ModelProjectVersion = typeof MODEL_PROJECT_VERSION;
export type Vec3 = [number, number, number];
export type Easing = "linear" | "easeInOut" | "step";
export type ModelObjectType = "mesh" | "ring" | "group" | "empty";
export type ModelAssetKind = "glb" | "obj" | "mesh";
export type ModelBackgroundKind = "transparent" | "solid" | "gradient";
export type ModelTrackProperty =
  | "position"
  | "rotation"
  | "rotationY"
  | "scale"
  | "opacity"
  | "bonePosition"
  | "boneRotation"
  | "boneScale"
  | "lightIntensity"
  | "cameraPosition"
  | "cameraTarget";

export type ModelTransform = {
  position: Vec3;
  /** Euler angles in degrees. Three.js adapters can convert them to radians. */
  rotation: Vec3;
  scale: Vec3;
};

export type ModelMaterial = {
  color: string;
  emissive: string;
  emissiveIntensity: number;
  metalness: number;
  roughness: number;
  opacity: number;
  transparent: boolean;
};

export type ModelGeometry = {
  type: "torus" | "box" | "sphere" | "cylinder";
  radius?: number;
  tube?: number;
  width?: number;
  height?: number;
  depth?: number;
  segments?: number;
};

export type MeshAssetRef = {
  id: string;
  name: string;
  kind: ModelAssetKind;
  /** A bundled or public URL, used for starter assets such as the Vitruvian GLB. */
  path?: string;
  /** IndexedDB/OPFS key. Binary bytes never belong in ModelProject. */
  storageKey?: string;
};

export type ModelSceneObject = {
  id: string;
  name: string;
  type: ModelObjectType;
  assetId?: string;
  parentId?: string;
  transform: ModelTransform;
  material: ModelMaterial;
  geometry?: ModelGeometry;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  rigId?: string;
};

export type ModelBone = {
  name: string;
  parent?: string;
  rest: ModelTransform;
};

export type BonePose = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

export type ModelRig = {
  id: string;
  name: string;
  bones: ModelBone[];
  pose: Record<string, BonePose>;
};

export type AnimationValue = number | number[];

export type ModelKeyframe = {
  timeMs: number;
  value: AnimationValue;
  easing: Easing;
};

export type ModelAnimationTrack = {
  id: string;
  targetId: string;
  property: ModelTrackProperty;
  boneName?: string;
  keyframes: ModelKeyframe[];
};

export type ModelCamera = {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov: number;
  near: number;
  far: number;
};

export type ModelLightType = "ambient" | "directional" | "point";

export type ModelLight = {
  id: string;
  name: string;
  type: ModelLightType;
  color: string;
  intensity: number;
  position: Vec3;
  target: Vec3;
};

export type ModelRenderSettings = {
  background: ModelBackgroundKind;
  backgroundColor: string;
  backgroundColor2: string;
  matteColor: string;
  transparent: boolean;
  glow: boolean;
  glowIntensity: number;
  glowRadius: number;
  outputFormat: "webm" | "png-sequence" | "prores4444" | "mp4";
};

export type ModelProject = {
  version: ModelProjectVersion;
  id: string;
  name: string;
  width: number;
  height: number;
  durationMs: number;
  fps: 60;
  assets: MeshAssetRef[];
  objects: ModelSceneObject[];
  rigs: ModelRig[];
  tracks: ModelAnimationTrack[];
  camera: ModelCamera;
  lights: ModelLight[];
  render: ModelRenderSettings;
};

export type EvaluatedModelFrame = {
  timeMs: number;
  objects: ModelSceneObject[];
  rigs: ModelRig[];
  camera: ModelCamera;
  lights: ModelLight[];
};

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string =>
  typeof value === "string";

const required = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown => {
  if (!(key in record)) {
    throw new Error(`Invalid Model project: missing ${path}.${key}`);
  }
  return record[key];
};

const stringField = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): string => {
  const value = required(record, key, path);
  if (!isString(value) || value.trim().length === 0) {
    throw new Error(`Invalid Model project: ${path}.${key} must be a string`);
  }
  return value;
};

const numberField = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): number => {
  const value = required(record, key, path);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid Model project: ${path}.${key} must be finite`);
  }
  return value;
};

const vec3 = (value: unknown, path: string, fallback?: Vec3): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3) {
    if (fallback) return [...fallback] as Vec3;
    throw new Error(`Invalid Model project: ${path} must be a three-number array`);
  }
  if (value.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error(`Invalid Model project: ${path} must contain finite numbers`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
};

const transform = (input: unknown, path: string): ModelTransform => {
  if (!isRecord(input)) {
    throw new Error(`Invalid Model project: ${path} must be an object`);
  }
  return {
    position: vec3(required(input, "position", path), `${path}.position`),
    rotation: vec3(required(input, "rotation", path), `${path}.rotation`),
    scale: vec3(required(input, "scale", path), `${path}.scale`),
  };
};

const material = (input: unknown, path: string): ModelMaterial => {
  if (!isRecord(input)) {
    throw new Error(`Invalid Model project: ${path} must be an object`);
  }
  return {
    color: stringField(input, "color", path),
    emissive: stringField(input, "emissive", path),
    emissiveIntensity: clamp(numberField(input, "emissiveIntensity", path), 0, 20),
    metalness: clamp(numberField(input, "metalness", path), 0, 1),
    roughness: clamp(numberField(input, "roughness", path), 0, 1),
    opacity: clamp(numberField(input, "opacity", path), 0, 1),
    transparent: input.transparent === true,
  };
};

const cloneTransform = (value: ModelTransform): ModelTransform => ({
  position: [...value.position] as Vec3,
  rotation: [...value.rotation] as Vec3,
  scale: [...value.scale] as Vec3,
});

const cloneMaterial = (value: ModelMaterial): ModelMaterial => ({ ...value });

const clonePose = (value: BonePose): BonePose => ({
  position: [...value.position] as Vec3,
  rotation: [...value.rotation] as Vec3,
  scale: [...value.scale] as Vec3,
});

export const defaultTransform = (): ModelTransform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

export const defaultMaterial = (): ModelMaterial => ({
  color: "#f2f0ea",
  emissive: "#000000",
  emissiveIntensity: 0,
  metalness: 0,
  roughness: 0.65,
  opacity: 1,
  transparent: false,
});

const cloneObject = (object: ModelSceneObject): ModelSceneObject => ({
  ...object,
  transform: cloneTransform(object.transform),
  material: cloneMaterial(object.material),
  geometry: object.geometry ? { ...object.geometry } : undefined,
});

export const cloneModelProject = (project: ModelProject): ModelProject => ({
  ...project,
  assets: project.assets.map((asset) => ({ ...asset })),
  objects: project.objects.map(cloneObject),
  rigs: project.rigs.map((rig) => ({
    ...rig,
    bones: rig.bones.map((bone) => ({ ...bone, rest: cloneTransform(bone.rest) })),
    pose: Object.fromEntries(
      Object.entries(rig.pose).map(([name, pose]) => [name, clonePose(pose)]),
    ),
  })),
  tracks: project.tracks.map((track) => ({
    ...track,
    keyframes: track.keyframes.map((keyframe) => ({
      ...keyframe,
      value: Array.isArray(keyframe.value)
        ? [...keyframe.value]
        : keyframe.value,
    })),
  })),
  camera: {
    ...project.camera,
    position: [...project.camera.position] as Vec3,
    target: [...project.camera.target] as Vec3,
    up: [...project.camera.up] as Vec3,
  },
  lights: project.lights.map((light) => ({
    ...light,
    position: [...light.position] as Vec3,
    target: [...light.target] as Vec3,
  })),
  render: { ...project.render },
});

const blankCamera = (): ModelCamera => ({
  position: [0, 0.8, 9],
  target: [0, 0.8, 0],
  up: [0, 1, 0],
  fov: 42,
  near: 0.01,
  far: 100,
});

const blankRender = (): ModelRenderSettings => ({
  background: "transparent",
  backgroundColor: "#05070b",
  backgroundColor2: "#111522",
  matteColor: "#05070b",
  transparent: true,
  glow: true,
  glowIntensity: 1.8,
  glowRadius: 5,
  outputFormat: "webm",
});

export function createBlankModelProject(): ModelProject {
  return {
    version: MODEL_PROJECT_VERSION,
    id: "model-project",
    name: "Untitled model scene",
    width: 1920,
    height: 1080,
    durationMs: 30_000,
    fps: 60,
    assets: [],
    objects: [],
    rigs: [],
    tracks: [],
    camera: blankCamera(),
    lights: [],
    render: blankRender(),
  };
}

const emptyPose = (): BonePose => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

const vitruvianBones: ModelBone[] = [
  { name: "root", rest: defaultTransform() },
  { name: "spine", parent: "root", rest: defaultTransform() },
  { name: "arm-left-upper", parent: "spine", rest: defaultTransform() },
  { name: "arm-left-lower", parent: "arm-left-upper", rest: defaultTransform() },
  { name: "arm-right-upper", parent: "spine", rest: defaultTransform() },
  { name: "arm-right-lower", parent: "arm-right-upper", rest: defaultTransform() },
  { name: "arm-left-upper-2", parent: "spine", rest: defaultTransform() },
  { name: "arm-left-lower-2", parent: "arm-left-upper-2", rest: defaultTransform() },
  { name: "arm-right-upper-2", parent: "spine", rest: defaultTransform() },
  { name: "arm-right-lower-2", parent: "arm-right-upper-2", rest: defaultTransform() },
  { name: "leg-left-upper", parent: "root", rest: defaultTransform() },
  { name: "leg-left-lower", parent: "leg-left-upper", rest: defaultTransform() },
  { name: "leg-right-upper", parent: "root", rest: defaultTransform() },
  { name: "leg-right-lower", parent: "leg-right-upper", rest: defaultTransform() },
  { name: "leg-left-upper-2", parent: "root", rest: defaultTransform() },
  { name: "leg-left-lower-2", parent: "leg-left-upper-2", rest: defaultTransform() },
  { name: "leg-right-upper-2", parent: "root", rest: defaultTransform() },
  { name: "leg-right-lower-2", parent: "leg-right-upper-2", rest: defaultTransform() },
];

export function createVitruvianProject(): ModelProject {
  const project = createBlankModelProject();
  project.id = "vitruvian-project";
  project.name = "Vitruvian Signal";
  project.camera.position = [0, 0, 9];
  project.camera.target = [0, 0, 0];
  project.assets = [
    {
      id: "vitruvian",
      name: "Vitruvian figure",
      kind: "glb",
      path: "/modeler/vitruvian.glb",
    },
  ];
  const figureMaterial: ModelMaterial = {
    color: "#051126",
    emissive: "#0654a8",
    emissiveIntensity: 0.28,
    metalness: 0.38,
    roughness: 0.43,
    opacity: 1,
    transparent: false,
  };
  // The starter GLB contains the figure and the circular logo ring as one
  // authored asset. Keeping one scene object prevents a second procedural ring
  // from being layered on top when the asset is loaded by the viewport.
  project.objects = [
    {
      id: "vitruvian-figure",
      name: "Vitruvian figure + ring",
      type: "mesh",
      assetId: "vitruvian",
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [0.72, 0.72, 0.72],
      },
      material: figureMaterial,
      visible: true,
      castShadow: true,
      receiveShadow: true,
      rigId: "vitruvian-rig",
    },
  ];
  const pose: Record<string, BonePose> = {};
  vitruvianBones.forEach((bone) => {
    pose[bone.name] = emptyPose();
  });
  project.rigs = [
    {
      id: "vitruvian-rig",
      name: "Vitruvian limb rig",
      bones: vitruvianBones.map((bone) => ({
        ...bone,
        rest: cloneTransform(bone.rest),
      })),
      pose,
    },
  ];
  project.lights = [
    {
      id: "ambient-blue",
      name: "Ambient blue",
      type: "ambient",
      color: "#236dff",
      intensity: 1.3,
      position: [0, 3, 4],
      target: [0, 0, 0],
    },
    {
      id: "rim-light",
      name: "Rim light",
      type: "point",
      color: "#00aaff",
      intensity: 18,
      position: [0, 2, 4],
      target: [0, 0, 0],
    },
  ];
  const spinTimes = [0, 7500, 15000, 22500, 30000];
  project.tracks = [
    {
      id: "vitruvian-spin",
      targetId: "vitruvian-figure",
      property: "rotationY",
      keyframes: spinTimes.map((timeMs, index) => ({
        timeMs,
        value: index * 90,
        easing: "linear" as const,
      })),
    },
  ];
  return project;
}

/** A separate starter leaves existing V1 draft manifests and their asset URL intact. */
export function createVitruvianV2Project(): ModelProject {
  const project = createBlankModelProject();
  project.id = "vitruvian-v2-project";
  project.name = "Vitruvian V2";
  project.camera.position = [0, 1, 3.7];
  project.camera.target = [0, 1, 0];
  project.render.glowIntensity = 1.1;
  project.render.glowRadius = 4;
  project.assets = [{
    id: "vitruvian-v2",
    name: "Vitruvian V2 assembly",
    kind: "glb",
    path: "/modeler/vitruvian-v2.glb",
  }];

  const assemblyMaterial: ModelMaterial = {
    color: "#071c3b", emissive: "#006de4", emissiveIntensity: 0.2,
    metalness: 0.18, roughness: 0.45, opacity: 1, transparent: false,
  };
  const primaryMaterial: ModelMaterial = {
    ...assemblyMaterial,
    color: "#063c9d", emissive: "#0068e8", emissiveIntensity: 0.7,
  };
  const ghostMaterial: ModelMaterial = {
    ...assemblyMaterial,
    color: "#138aff", emissive: "#177dff", emissiveIntensity: 0.45,
    opacity: 0.32, transparent: true,
  };
  const ringMaterial: ModelMaterial = {
    ...assemblyMaterial,
    color: "#1689ff", emissive: "#238bff", emissiveIntensity: 1.3,
  };
  project.objects = [
    {
      id: "vitruvian-v2-assembly", name: "Vitruvian V2 assembly", type: "group",
      transform: defaultTransform(), material: assemblyMaterial,
      visible: true, castShadow: false, receiveShadow: false,
    },
    {
      id: "vitruvian-primary", name: "Primary figure", type: "mesh",
      assetId: "vitruvian-v2", parentId: "vitruvian-v2-assembly",
      transform: defaultTransform(), material: primaryMaterial,
      visible: true, castShadow: true, receiveShadow: true,
      rigId: "vitruvian-v2-primary-rig",
    },
    {
      id: "vitruvian-ghost", name: "Second pose", type: "mesh",
      assetId: "vitruvian-v2", parentId: "vitruvian-v2-assembly",
      transform: defaultTransform(), material: ghostMaterial,
      visible: true, castShadow: false, receiveShadow: false,
      rigId: "vitruvian-v2-ghost-rig",
    },
    {
      id: "vitruvian-ring", name: "Electric ring", type: "mesh",
      assetId: "vitruvian-v2", parentId: "vitruvian-v2-assembly",
      transform: defaultTransform(), material: ringMaterial,
      visible: true, castShadow: false, receiveShadow: false,
    },
  ];

  project.rigs = (["primary", "ghost"] as const).map((figure) => {
    const prefix = `${figure}_`;
    const bones = mpfbStandardBones.map((bone): ModelBone => ({
      name: `${prefix}${bone.name}`,
      ...(bone.parent ? { parent: `${prefix}${bone.parent}` } : {}),
      rest: defaultTransform(),
    }));
    return {
      id: `vitruvian-v2-${figure}-rig`,
      name: figure === "primary" ? "Primary figure rig" : "Second pose rig",
      bones,
      pose: Object.fromEntries(bones.map((bone) => [bone.name, emptyPose()])),
    };
  });
  project.lights = [
    {
      id: "v2-fill", name: "Blue fill", type: "ambient", color: "#6aaaff",
      intensity: 1.5, position: [0, 3, 4], target: [0, 1, 0],
    },
    {
      id: "v2-rim", name: "Electric rim", type: "point", color: "#1d86ff",
      intensity: 3, position: [0, 2, 3], target: [0, 1, 0],
    },
  ];
  project.tracks = [{
    id: "vitruvian-v2-spin",
    targetId: "vitruvian-v2-assembly",
    property: "rotationY",
    keyframes: [0, 7500, 15000, 22500, 30000].map((timeMs, index) => ({
      timeMs, value: index * 90, easing: "linear" as const,
    })),
  }];
  return project;
}

const parseAsset = (input: unknown, index: number): MeshAssetRef => {
  const path = `assets[${index}]`;
  if (!isRecord(input)) throw new Error(`Invalid Model project: ${path} must be an object`);
  const kind = input.kind;
  if (kind !== "glb" && kind !== "obj" && kind !== "mesh") {
    throw new Error(`Invalid Model project: ${path}.kind is not supported`);
  }
  const asset: MeshAssetRef = {
    id: stringField(input, "id", path),
    name: stringField(input, "name", path),
    kind,
  };
  if (input.path !== undefined) {
    if (!isString(input.path)) throw new Error(`Invalid Model project: ${path}.path must be a string`);
    asset.path = input.path;
  }
  if (input.storageKey !== undefined) {
    if (!isString(input.storageKey)) throw new Error(`Invalid Model project: ${path}.storageKey must be a string`);
    asset.storageKey = input.storageKey;
  }
  return asset;
};

const parseObject = (input: unknown, index: number): ModelSceneObject => {
  const path = `objects[${index}]`;
  if (!isRecord(input)) throw new Error(`Invalid Model project: ${path} must be an object`);
  const type = input.type;
  if (type !== "mesh" && type !== "ring" && type !== "group" && type !== "empty") {
    throw new Error(`Invalid Model project: ${path}.type is not supported`);
  }
  const object: ModelSceneObject = {
    id: stringField(input, "id", path),
    name: stringField(input, "name", path),
    type,
    transform: transform(required(input, "transform", path), `${path}.transform`),
    material: material(required(input, "material", path), `${path}.material`),
    visible: input.visible === true,
    castShadow: input.castShadow === true,
    receiveShadow: input.receiveShadow === true,
  };
  if (input.assetId !== undefined) object.assetId = stringField(input, "assetId", path);
  if (input.parentId !== undefined) object.parentId = stringField(input, "parentId", path);
  if (input.rigId !== undefined) object.rigId = stringField(input, "rigId", path);
  if (input.geometry !== undefined) {
    if (!isRecord(input.geometry) || typeof input.geometry.type !== "string") {
      throw new Error(`Invalid Model project: ${path}.geometry is invalid`);
    }
    if (input.geometry.type !== "torus" && input.geometry.type !== "box" && input.geometry.type !== "sphere" && input.geometry.type !== "cylinder") {
      throw new Error(`Invalid Model project: ${path}.geometry.type is not supported`);
    }
    object.geometry = { type: input.geometry.type };
    for (const key of ["radius", "tube", "width", "height", "depth", "segments"] as const) {
      if (input.geometry[key] !== undefined) {
        const value = input.geometry[key];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`Invalid Model project: ${path}.geometry.${key} must be finite`);
        }
        object.geometry[key] = value;
      }
    }
  }
  return object;
};

const parseBonePose = (input: unknown, path: string): BonePose => {
  if (!isRecord(input)) throw new Error(`Invalid Model project: ${path} must be an object`);
  return {
    position: vec3(required(input, "position", path), `${path}.position`),
    rotation: vec3(required(input, "rotation", path), `${path}.rotation`),
    scale: vec3(required(input, "scale", path), `${path}.scale`),
  };
};

const parseRig = (input: unknown, index: number): ModelRig => {
  const path = `rigs[${index}]`;
  if (!isRecord(input)) throw new Error(`Invalid Model project: ${path} must be an object`);
  const bonesInput = required(input, "bones", path);
  const poseInput = required(input, "pose", path);
  if (!Array.isArray(bonesInput) || !isRecord(poseInput)) {
    throw new Error(`Invalid Model project: ${path}.bones and pose are required`);
  }
  const bones = bonesInput.map((boneInput, boneIndex) => {
    const bonePath = `${path}.bones[${boneIndex}]`;
    if (!isRecord(boneInput)) throw new Error(`Invalid Model project: ${bonePath} must be an object`);
    const bone: ModelBone = {
      name: stringField(boneInput, "name", bonePath),
      rest: transform(required(boneInput, "rest", bonePath), `${bonePath}.rest`),
    };
    if (boneInput.parent !== undefined) bone.parent = stringField(boneInput, "parent", bonePath);
    return bone;
  });
  const pose: Record<string, BonePose> = {};
  for (const bone of bones) {
    pose[bone.name] = parseBonePose(poseInput[bone.name], `${path}.pose.${bone.name}`);
  }
  return {
    id: stringField(input, "id", path),
    name: stringField(input, "name", path),
    bones,
    pose,
  };
};

const parseKeyframe = (input: unknown, path: string): ModelKeyframe => {
  if (!isRecord(input)) throw new Error(`Invalid Model project: ${path} must be an object`);
  const value = input.value;
  if (typeof value !== "number" && (!Array.isArray(value) || value.some((part) => typeof part !== "number" || !Number.isFinite(part)))) {
    throw new Error(`Invalid Model project: ${path}.value must be a number or number array`);
  }
  if (input.easing !== "linear" && input.easing !== "easeInOut" && input.easing !== "step") {
    throw new Error(`Invalid Model project: ${path}.easing is not supported`);
  }
  return {
    timeMs: numberField(input, "timeMs", path),
    value: Array.isArray(value) ? [...value] as number[] : value,
    easing: input.easing,
  };
};

const parseTrack = (input: unknown, index: number, durationMs: number): ModelAnimationTrack => {
  const path = `tracks[${index}]`;
  if (!isRecord(input)) throw new Error(`Invalid Model project: ${path} must be an object`);
  const property = input.property;
  const supported: ModelTrackProperty[] = [
    "position", "rotation", "rotationY", "scale", "opacity", "bonePosition",
    "boneRotation", "boneScale", "lightIntensity", "cameraPosition", "cameraTarget",
  ];
  if (!supported.includes(property as ModelTrackProperty)) {
    throw new Error(`Invalid Model project: ${path}.property is not supported`);
  }
  const trackProperty = property as ModelTrackProperty;
  const keyframesInput = required(input, "keyframes", path);
  if (!Array.isArray(keyframesInput) || keyframesInput.length === 0) {
    throw new Error(`Invalid Model project: ${path}.keyframes must not be empty`);
  }
  const keyframes = keyframesInput.map((keyframe, keyframeIndex) => {
    const parsed = parseKeyframe(keyframe, `${path}.keyframes[${keyframeIndex}]`);
    if (parsed.timeMs < 0 || parsed.timeMs > durationMs) {
      throw new Error(`Invalid Model project: ${path}.keyframes time must be within duration`);
    }
    return parsed;
  });
  const track: ModelAnimationTrack = {
    id: stringField(input, "id", path),
    targetId: stringField(input, "targetId", path),
    property: trackProperty,
    keyframes,
  };
  if (input.boneName !== undefined) track.boneName = stringField(input, "boneName", path);
  if (trackProperty.startsWith("bone") && !track.boneName) {
    throw new Error(`Invalid Model project: ${path}.boneName is required for bone tracks`);
  }
  return track;
};

const parseCamera = (input: unknown): ModelCamera => {
  if (!isRecord(input)) throw new Error("Invalid Model project: camera must be an object");
  return {
    position: vec3(required(input, "position", "camera"), "camera.position"),
    target: vec3(required(input, "target", "camera"), "camera.target"),
    up: vec3(required(input, "up", "camera"), "camera.up"),
    fov: clamp(numberField(input, "fov", "camera"), 1, 179),
    near: Math.max(0.0001, numberField(input, "near", "camera")),
    far: Math.max(0.01, numberField(input, "far", "camera")),
  };
};

const parseLight = (input: unknown, index: number): ModelLight => {
  const path = `lights[${index}]`;
  if (!isRecord(input)) throw new Error(`Invalid Model project: ${path} must be an object`);
  const type = input.type;
  if (type !== "ambient" && type !== "directional" && type !== "point") {
    throw new Error(`Invalid Model project: ${path}.type is not supported`);
  }
  return {
    id: stringField(input, "id", path),
    name: stringField(input, "name", path),
    type,
    color: stringField(input, "color", path),
    intensity: Math.max(0, numberField(input, "intensity", path)),
    position: vec3(required(input, "position", path), `${path}.position`),
    target: vec3(required(input, "target", path), `${path}.target`),
  };
};

const parseRender = (input: unknown): ModelRenderSettings => {
  if (!isRecord(input)) throw new Error("Invalid Model project: render must be an object");
  const background = input.background;
  if (background !== "transparent" && background !== "solid" && background !== "gradient") {
    throw new Error("Invalid Model project: render.background is not supported");
  }
  const outputFormat = input.outputFormat;
  if (outputFormat !== "webm" && outputFormat !== "png-sequence" && outputFormat !== "prores4444" && outputFormat !== "mp4") {
    throw new Error("Invalid Model project: render.outputFormat is not supported");
  }
  return {
    background,
    backgroundColor: stringField(input, "backgroundColor", "render"),
    backgroundColor2: stringField(input, "backgroundColor2", "render"),
    matteColor: stringField(input, "matteColor", "render"),
    transparent: input.transparent === true,
    glow: input.glow === true,
    glowIntensity: clamp(numberField(input, "glowIntensity", "render"), 0, 20),
    glowRadius: clamp(numberField(input, "glowRadius", "render"), 0, 64),
    outputFormat,
  };
};

export function parseModelProject(raw: unknown): ModelProject {
  let input: unknown = raw;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      throw new Error("Invalid Model project: input is not valid JSON");
    }
  }
  if (!isRecord(input)) throw new Error("Invalid Model project: expected an object or JSON string");
  if (input.version !== MODEL_PROJECT_VERSION) {
    throw new Error(`Invalid Model project: unsupported version ${String(input.version)}`);
  }
  const width = numberField(input, "width", "project");
  const height = numberField(input, "height", "project");
  const durationMs = numberField(input, "durationMs", "project");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1920) {
    throw new Error("Invalid Model project: canvas must be between 1 and 1920 pixels");
  }
  if (durationMs <= 0 || durationMs > 30_000) {
    throw new Error("Invalid Model project: durationMs must be between 1 and 30000");
  }
  if (input.fps !== 60) throw new Error("Invalid Model project: fps must be 60");
  const assetsInput = required(input, "assets", "project");
  const objectsInput = required(input, "objects", "project");
  const rigsInput = required(input, "rigs", "project");
  const tracksInput = required(input, "tracks", "project");
  const lightsInput = required(input, "lights", "project");
  if (!Array.isArray(assetsInput) || !Array.isArray(objectsInput) || !Array.isArray(rigsInput) || !Array.isArray(tracksInput) || !Array.isArray(lightsInput)) {
    throw new Error("Invalid Model project: assets, objects, rigs, tracks, and lights must be arrays");
  }
  const assets = assetsInput.map(parseAsset);
  const objects = objectsInput.map(parseObject);
  const rigs = rigsInput.map(parseRig);
  const tracks = tracksInput.map((track, index) => parseTrack(track, index, durationMs));
  const lights = lightsInput.map(parseLight);
  const ids = new Set<string>();
  for (const item of [...assets, ...objects, ...rigs, ...lights]) {
    if (ids.has(item.id)) throw new Error(`Invalid Model project: duplicate id ${item.id}`);
    ids.add(item.id);
  }
  for (const object of objects) {
    if (object.assetId && !assets.some((asset) => asset.id === object.assetId)) {
      throw new Error(`Invalid Model project: object ${object.id} references missing asset ${object.assetId}`);
    }
    if (object.parentId && !objects.some((candidate) => candidate.id === object.parentId)) {
      throw new Error(`Invalid Model project: object ${object.id} references missing parent ${object.parentId}`);
    }
    if (object.rigId && !rigs.some((rig) => rig.id === object.rigId)) {
      throw new Error(`Invalid Model project: object ${object.id} references missing rig ${object.rigId}`);
    }
  }
  const validTrackTargets = new Set([
    ...objects.map((object) => object.id),
    ...rigs.map((rig) => rig.id),
    ...lights.map((light) => light.id),
    "camera",
  ]);
  for (const track of tracks) {
    if (!validTrackTargets.has(track.targetId)) {
      throw new Error(`Invalid Model project: track ${track.id} references missing target ${track.targetId}`);
    }
  }
  const project: ModelProject = {
    version: MODEL_PROJECT_VERSION,
    id: stringField(input, "id", "project"),
    name: stringField(input, "name", "project"),
    width,
    height,
    durationMs,
    fps: 60,
    assets,
    objects,
    rigs,
    tracks,
    camera: parseCamera(required(input, "camera", "project")),
    lights,
    render: parseRender(required(input, "render", "project")),
  };
  return cloneModelProject(project);
}

const keyframeValue = (value: AnimationValue): number[] =>
  Array.isArray(value) ? value.map((part) => finite(part, 0)) : [finite(value, 0)];

const easeProgress = (progress: number, easing: Easing): number => {
  const t = clamp(progress, 0, 1);
  if (easing === "step") return t < 1 ? 0 : 1;
  if (easing === "easeInOut") return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
};

const interpolateTrack = (track: ModelAnimationTrack, timeMs: number): number[] => {
  const keyframes = track.keyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .sort((a, b) => a.keyframe.timeMs - b.keyframe.timeMs || a.index - b.index)
    .map((entry) => entry.keyframe);
  const first = keyframeValue(keyframes[0]!.value);
  const last = keyframeValue(keyframes[keyframes.length - 1]!.value);
  if (timeMs <= keyframes[0]!.timeMs) return first;
  if (timeMs >= keyframes[keyframes.length - 1]!.timeMs) return last;
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index]!;
    const to = keyframes[index + 1]!;
    if (timeMs > to.timeMs) continue;
    const span = Math.max(1, to.timeMs - from.timeMs);
    const progress = easeProgress((timeMs - from.timeMs) / span, from.easing);
    const a = keyframeValue(from.value);
    const b = keyframeValue(to.value);
    const size = Math.max(a.length, b.length);
    return Array.from({ length: size }, (_, component) => {
      const av = a[component] ?? a[a.length - 1] ?? 0;
      const bv = b[component] ?? b[b.length - 1] ?? av;
      return av + (bv - av) * progress;
    });
  }
  return last;
};

const assignVec3 = (target: Vec3, values: number[]): Vec3 => [
  values[0] ?? target[0],
  values[1] ?? target[1],
  values[2] ?? target[2],
];

export function evaluateModelFrame(project: ModelProject, timeMs: number): EvaluatedModelFrame {
  const frameTime = clamp(finite(timeMs, 0), 0, project.durationMs);
  const objects = project.objects.map(cloneObject);
  const rigs = project.rigs.map((rig) => ({
    ...rig,
    bones: rig.bones.map((bone) => ({ ...bone, rest: cloneTransform(bone.rest) })),
    pose: Object.fromEntries(Object.entries(rig.pose).map(([name, value]) => [name, clonePose(value)])),
  }));
  const camera: ModelCamera = {
    ...project.camera,
    position: [...project.camera.position] as Vec3,
    target: [...project.camera.target] as Vec3,
    up: [...project.camera.up] as Vec3,
  };
  const lights = project.lights.map((light) => ({
    ...light,
    position: [...light.position] as Vec3,
    target: [...light.target] as Vec3,
  }));
  const objectMap = new Map(objects.map((object) => [object.id, object]));
  const rigMap = new Map(rigs.map((rig) => [rig.id, rig]));
  const lightMap = new Map(lights.map((light) => [light.id, light]));
  for (const track of project.tracks) {
    const values = interpolateTrack(track, frameTime);
    const object = objectMap.get(track.targetId);
    if (object) {
      switch (track.property) {
        case "position": object.transform.position = assignVec3(object.transform.position, values); break;
        case "rotation": object.transform.rotation = assignVec3(object.transform.rotation, values); break;
        case "rotationY": object.transform.rotation[1] = values[0] ?? object.transform.rotation[1]; break;
        case "scale": object.transform.scale = assignVec3(object.transform.scale, values); break;
        case "opacity": object.material.opacity = clamp(values[0] ?? object.material.opacity, 0, 1); break;
      }
    }
    const rig = rigMap.get(track.targetId);
    if (rig && track.boneName && (track.property === "bonePosition" || track.property === "boneRotation" || track.property === "boneScale")) {
      const pose = rig.pose[track.boneName];
      if (!pose) continue;
      if (track.property === "bonePosition") pose.position = assignVec3(pose.position, values);
      if (track.property === "boneRotation") pose.rotation = assignVec3(pose.rotation, values);
      if (track.property === "boneScale") pose.scale = assignVec3(pose.scale, values);
    }
    const light = lightMap.get(track.targetId);
    if (light && track.property === "lightIntensity") light.intensity = Math.max(0, values[0] ?? light.intensity);
    if (track.targetId === "camera" && track.property === "cameraPosition") camera.position = assignVec3(camera.position, values);
    if (track.targetId === "camera" && track.property === "cameraTarget") camera.target = assignVec3(camera.target, values);
  }
  return { timeMs: frameTime, objects, rigs, camera, lights };
}
