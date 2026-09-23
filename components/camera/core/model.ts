export type CameraPresetId =
  "clean" | "ascii" | "flir" | "heat" | "depth" | "rgb-signal";

export type CameraEffectKind =
  "ascii" | "flir" | "heat" | "depth" | "rgb-signal";

export type LutLookId =
  "neutral" | "amber-crt" | "teal-orange" | "bleach" | "cold-mono";

export type CameraEffectParams = {
  cellSize: number;
  contrast: number;
  threshold: number;
  scanline: number;
  edge: number;
  channelOffset: number;
  noise: number;
  posterize: number;
};

export type CameraEffect = {
  id: string;
  kind: CameraEffectKind;
  enabled: boolean;
  strength: number;
  params: CameraEffectParams;
};

export type CameraFxProject = {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: 30;
  mirror: boolean;
  micEnabled: boolean;
  look: LutLookId;
  lookStrength: number;
  effects: CameraEffect[];
};

export const CAMERA_ASCII_FONT_FAMILY =
  "'Departure Mono Editor', 'Courier New', monospace";

export type CameraEffectDefinition = {
  kind: CameraEffectKind;
  label: string;
  description: string;
};

export type CameraPresetDefinition = {
  id: CameraPresetId;
  label: string;
  description: string;
  look: LutLookId;
};

export const CAMERA_EFFECTS: readonly CameraEffectDefinition[] = [
  {
    kind: "ascii",
    label: "ASCII Terminal",
    description: "Quantize the camera into a responsive character grid.",
  },
  {
    kind: "flir",
    label: "FLIR Style",
    description: "Apply a cool thermal-camera inspired colour map.",
  },
  {
    kind: "heat",
    label: "Heat Vision",
    description: "Map luminance to a high contrast infrared palette.",
  },
  {
    kind: "depth",
    label: "Pseudo Depth",
    description: "Estimate depth from luminance and local contours.",
  },
  {
    kind: "rgb-signal",
    label: "RGB Signal",
    description: "Split colour channels with scan lines and signal noise.",
  },
];

export const LUT_LOOKS: readonly {
  id: LutLookId;
  label: string;
  description: string;
}[] = [
  {
    id: "neutral",
    label: "Neutral",
    description: "The ungraded camera colour.",
  },
  {
    id: "amber-crt",
    label: "Amber CRT",
    description: "Warm monochrome with an old terminal tint.",
  },
  {
    id: "teal-orange",
    label: "Teal / Orange",
    description: "A cinematic split between cool shadows and warm highlights.",
  },
  {
    id: "bleach",
    label: "Bleach",
    description: "Hard contrast with a muted colour response.",
  },
  {
    id: "cold-mono",
    label: "Cold Mono",
    description: "A blue monochrome signal treatment.",
  },
];

export const CAMERA_PRESETS: readonly CameraPresetDefinition[] = [
  {
    id: "clean",
    label: "Clean",
    description: "A direct camera preview with no effect stack.",
    look: "neutral",
  },
  {
    id: "ascii",
    label: "ASCII Terminal",
    description: "A dense amber character raster for terminal style portraits.",
    look: "amber-crt",
  },
  {
    id: "flir",
    label: "FLIR Style",
    description: "A cool false-colour thermal camera look.",
    look: "cold-mono",
  },
  {
    id: "heat",
    label: "Heat Vision",
    description: "A high energy infrared palette with hot highlights.",
    look: "neutral",
  },
  {
    id: "depth",
    label: "Pseudo Depth",
    description: "A stylized depth estimate made from image contours.",
    look: "cold-mono",
  },
  {
    id: "rgb-signal",
    label: "RGB Signal",
    description: "A noisy channel split with analog scan lines.",
    look: "teal-orange",
  },
];

const EFFECT_KINDS = CAMERA_EFFECTS.map((effect) => effect.kind);
const LOOK_IDS = LUT_LOOKS.map((look) => look.id);
const PRESET_IDS = CAMERA_PRESETS.map((preset) => preset.id);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isOneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && values.includes(value as T);

const defaultParams = (kind: CameraEffectKind): CameraEffectParams => {
  switch (kind) {
    case "ascii":
      return {
        cellSize: 9,
        contrast: 1.2,
        threshold: 0.16,
        scanline: 0.25,
        edge: 0,
        channelOffset: 0,
        noise: 0.12,
        posterize: 8,
      };
    case "flir":
      return {
        cellSize: 9,
        contrast: 1.15,
        threshold: 0.05,
        scanline: 0.16,
        edge: 0,
        channelOffset: 0,
        noise: 0.08,
        posterize: 10,
      };
    case "heat":
      return {
        cellSize: 9,
        contrast: 1.28,
        threshold: 0.08,
        scanline: 0.12,
        edge: 0.2,
        channelOffset: 0,
        noise: 0.06,
        posterize: 12,
      };
    case "depth":
      return {
        cellSize: 9,
        contrast: 1.1,
        threshold: 0.04,
        scanline: 0,
        edge: 0.75,
        channelOffset: 0,
        noise: 0.08,
        posterize: 9,
      };
    case "rgb-signal":
      return {
        cellSize: 9,
        contrast: 1.05,
        threshold: 0,
        scanline: 0.45,
        edge: 0,
        channelOffset: 7,
        noise: 0.25,
        posterize: 12,
      };
  }
};

const parseParams = (
  kind: CameraEffectKind,
  input: unknown,
): CameraEffectParams => {
  const defaults = defaultParams(kind);
  const record = isRecord(input) ? input : {};
  return {
    cellSize: clamp(finite(record.cellSize, defaults.cellSize), 2, 64),
    contrast: clamp(finite(record.contrast, defaults.contrast), 0, 3),
    threshold: clamp(finite(record.threshold, defaults.threshold), 0, 1),
    scanline: clamp(finite(record.scanline, defaults.scanline), 0, 1),
    edge: clamp(finite(record.edge, defaults.edge), 0, 1),
    channelOffset: clamp(
      finite(record.channelOffset, defaults.channelOffset),
      0,
      48,
    ),
    noise: clamp(finite(record.noise, defaults.noise), 0, 1),
    posterize: clamp(
      Math.round(finite(record.posterize, defaults.posterize)),
      2,
      32,
    ),
  };
};

const projectDimensionsAreValid = (width: number, height: number): boolean => {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 320 ||
    height < 180 ||
    width > 1920 ||
    height > 1080
  ) {
    return false;
  }
  return Math.abs(width / height - 16 / 9) < 0.002;
};

const parseEffect = (input: unknown, index: number): CameraEffect => {
  if (!isRecord(input)) {
    throw new Error(
      `Invalid Camera FX project: effects[${index}] must be an object`,
    );
  }
  const id = input.id;
  const kind = input.kind;
  if (!isString(id) || id.trim().length === 0) {
    throw new Error(
      `Invalid Camera FX project: effects[${index}].id is required`,
    );
  }
  if (!isOneOf(EFFECT_KINDS, kind)) {
    throw new Error(
      `Invalid Camera FX project: effects[${index}].kind is not supported`,
    );
  }
  if (typeof input.enabled !== "boolean") {
    throw new Error(
      `Invalid Camera FX project: effects[${index}].enabled must be a boolean`,
    );
  }
  return {
    id,
    kind,
    enabled: input.enabled,
    strength: clamp(finite(input.strength, 1), 0, 1),
    params: parseParams(kind, input.params),
  };
};

const cloneProject = (project: CameraFxProject): CameraFxProject => ({
  ...project,
  effects: project.effects.map((effect) => ({
    ...effect,
    params: { ...effect.params },
  })),
});

export function createCameraEffect(kind: CameraEffectKind): CameraEffect {
  if (!isOneOf(EFFECT_KINDS, kind)) {
    throw new Error(`Unknown Camera FX effect: ${String(kind)}`);
  }
  return {
    id: `effect-${kind}`,
    kind,
    enabled: true,
    strength: 1,
    params: defaultParams(kind),
  };
}

export function createBlankCameraProject(): CameraFxProject {
  return {
    version: 1,
    id: "camera-project",
    name: "Untitled camera look",
    width: 1920,
    height: 1080,
    fps: 30,
    mirror: true,
    micEnabled: true,
    look: "neutral",
    lookStrength: 1,
    effects: [],
  };
}

export function createCameraPreset(id: CameraPresetId): CameraFxProject {
  if (!isOneOf(PRESET_IDS, id)) {
    throw new Error(`Unknown Camera FX preset: ${String(id)}`);
  }
  const definition = CAMERA_PRESETS.find((preset) => preset.id === id);
  if (!definition) {
    throw new Error(`Unknown Camera FX preset: ${String(id)}`);
  }
  const project = createBlankCameraProject();
  project.id = `camera-preset-${id}`;
  project.name = definition.label;
  project.look = definition.look;
  if (id !== "clean") {
    project.effects = [createCameraEffect(id)];
  }
  return project;
}

export function parseCameraProject(raw: unknown): CameraFxProject {
  let input: unknown = raw;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      throw new Error("Invalid Camera FX project: input is not valid JSON");
    }
  }
  if (!isRecord(input)) {
    throw new Error(
      "Invalid Camera FX project: expected a project object or JSON string",
    );
  }
  if (input.version !== 1) {
    throw new Error(
      `Invalid Camera FX project: unsupported version ${String(input.version)}`,
    );
  }
  if (!isString(input.id) || !isString(input.name)) {
    throw new Error("Invalid Camera FX project: id and name must be strings");
  }
  const width = finite(input.width, NaN);
  const height = finite(input.height, NaN);
  if (!projectDimensionsAreValid(width, height)) {
    throw new Error(
      "Invalid Camera FX project: canvas must be a 16:9 size up to 1920x1080",
    );
  }
  if (input.fps !== 30) {
    throw new Error("Invalid Camera FX project: fps must be 30");
  }
  if (
    typeof input.mirror !== "boolean" ||
    typeof input.micEnabled !== "boolean"
  ) {
    throw new Error(
      "Invalid Camera FX project: mirror and micEnabled must be booleans",
    );
  }
  if (!isOneOf(LOOK_IDS, input.look)) {
    throw new Error("Invalid Camera FX project: look is not supported");
  }
  if (!Array.isArray(input.effects) || input.effects.length > 4) {
    throw new Error(
      "Invalid Camera FX project: effects must contain at most four entries",
    );
  }
  const effects = input.effects.map(parseEffect);
  if (effects.filter((effect) => effect.enabled).length > 4) {
    throw new Error(
      "Invalid Camera FX project: at most four effects may be enabled",
    );
  }
  return cloneProject({
    version: 1,
    id: input.id,
    name: input.name,
    width,
    height,
    fps: 30,
    mirror: input.mirror,
    micEnabled: input.micEnabled,
    look: input.look,
    lookStrength: clamp(finite(input.lookStrength, 1), 0, 1),
    effects,
  });
}
