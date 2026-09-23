export type ModelExportFormat = "webm" | "mp4" | "mov" | "png-sequence";

export type ModelFrameRenderer = (
  timeSeconds: number,
  width: number,
  height: number,
  alpha: boolean,
) => HTMLCanvasElement | Promise<HTMLCanvasElement>;

export type ModelExportDestination = {
  directory?: FileSystemDirectoryHandle;
  archive?: FileSystemFileHandle;
};

export type ModelExportOptions = {
  format: ModelExportFormat;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** Background used when an opaque MP4 frame is requested. */
  matte?: string;
  /** Defaults to true for WebM, MOV and PNG sequences. */
  alpha?: boolean;
  basename?: string;
  renderFrame: ModelFrameRenderer;
  destination?: ModelExportDestination;
  helper?: ModelLocalRenderClient;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

export type ModelExportResult = {
  format: ModelExportFormat;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  frameCount: number;
  mimeType: string;
  blob?: Blob;
  files?: FileSystemFileHandle[];
  archive?: FileSystemFileHandle;
};

export type ModelExportCapabilities = {
  webm: boolean;
  webmAlpha: boolean;
  mp4: boolean;
  localMov: boolean;
};

export type ModelLocalRenderRequest = {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  renderFrame: ModelFrameRenderer;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

export type ModelLocalRenderClient = {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  exportProRes4444(
    request: ModelLocalRenderRequest,
  ): Promise<Blob>;
};

export type ModelExportErrorCode =
  | "invalid-options"
  | "runtime-unavailable"
  | "native-codec-unavailable"
  | "native-encode-failed"
  | "fallback-unavailable"
  | "fallback-failed"
  | "render-failed"
  | "destination-required"
  | "helper-unavailable"
  | "helper-failed"
  | "aborted";

export class ModelExportError extends Error {
  readonly code: ModelExportErrorCode;
  readonly details: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: ModelExportErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = "ModelExportError";
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

export const MODEL_EXPORT_LIMITS = {
  maxWidth: 1920,
  maxHeight: 1920,
  maxPixels: 1920 * 1080,
  maxFps: 60,
  maxDurationSeconds: 30,
} as const;

export function frameCountFor(
  durationSeconds: number,
  fps: number,
): number {
  return Math.max(1, Math.ceil(durationSeconds * fps));
}

export function createModelAbortError(): ModelExportError {
  return new ModelExportError("aborted", "Model export was canceled.");
}

export function isModelExportAbort(error: unknown): boolean {
  return (
    error instanceof ModelExportError && error.code === "aborted"
  ) ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError");
}

export function validateModelExportOptions(
  options: ModelExportOptions,
): ModelExportOptions {
  if (!options || typeof options !== "object") {
    throw new ModelExportError(
      "invalid-options",
      "Model export options are required.",
    );
  }

  const validFormats: readonly ModelExportFormat[] = [
    "webm",
    "mp4",
    "mov",
    "png-sequence",
  ];
  if (!validFormats.includes(options.format)) {
    throw new ModelExportError(
      "invalid-options",
      "Model export format must be WebM, MP4, MOV or PNG sequence.",
      { format: options.format },
    );
  }

  const dimensions = [options.width, options.height];
  if (
    dimensions.some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    options.width > MODEL_EXPORT_LIMITS.maxWidth ||
    options.height > MODEL_EXPORT_LIMITS.maxHeight ||
    options.width * options.height > MODEL_EXPORT_LIMITS.maxPixels
  ) {
    throw new ModelExportError(
      "invalid-options",
      "Model export dimensions must fit within the 1080p frame limit.",
      {
        width: options.width,
        height: options.height,
        maxWidth: MODEL_EXPORT_LIMITS.maxWidth,
        maxHeight: MODEL_EXPORT_LIMITS.maxHeight,
      },
    );
  }

  if (
    !Number.isFinite(options.fps) ||
    options.fps <= 0 ||
    options.fps > MODEL_EXPORT_LIMITS.maxFps
  ) {
    throw new ModelExportError(
      "invalid-options",
      `Model export FPS must be between 1 and ${MODEL_EXPORT_LIMITS.maxFps}.`,
      { fps: options.fps },
    );
  }

  if (
    !Number.isFinite(options.durationSeconds) ||
    options.durationSeconds <= 0 ||
    options.durationSeconds > MODEL_EXPORT_LIMITS.maxDurationSeconds
  ) {
    throw new ModelExportError(
      "invalid-options",
      `Model export duration must be between 0 and ${MODEL_EXPORT_LIMITS.maxDurationSeconds} seconds.`,
      { durationSeconds: options.durationSeconds },
    );
  }

  if (typeof options.renderFrame !== "function") {
    throw new ModelExportError(
      "invalid-options",
      "Model export requires a renderFrame callback.",
    );
  }

  return options;
}
