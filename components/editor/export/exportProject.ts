import type { TextFxProject } from "../core/model";
import { renderFrame } from "../core/render";

export type ExportFormat = "mp4" | "webm" | "gif";

export type ExportOptions = {
  format: ExportFormat;
  scale?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

export type ExportErrorCode =
  | "invalid-project"
  | "invalid-options"
  | "runtime-unavailable"
  | "native-codec-unavailable"
  | "render-failed"
  | "fallback-unavailable"
  | "fallback-failed"
  | "aborted";

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly details: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: ExportErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = "TextFxExportError";
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

type Dimensions = {
  width: number;
  height: number;
  scale: number;
};

type ProgressReporter = (progress: number) => void;

const VIDEO_FPS = 30;
const GIF_FPS = 15;
const MAX_DURATION_MS = 30_000;
const MIN_SCALE = 0.01;
const MAX_SCALE = 8;
const FALLBACK_SEGMENT_FRAMES = 90;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const reportProgress = (
  onProgress: ProgressReporter | undefined,
  value: number,
): void => {
  onProgress?.(clamp(value, 0, 1));
};

const makeAbortError = (): ExportError =>
  new ExportError("aborted", "Text FX export was canceled.");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw makeAbortError();
  }
};

const waitForPromise = async <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(makeAbortError());
    const settle = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error) => {
        settle();
        reject(error);
      },
    );
  });
};

const yieldToBrowser = (signal?: AbortSignal): Promise<void> =>
  waitForPromise(new Promise((resolve) => setTimeout(resolve, 0)), signal);

const validateProject = (
  project: TextFxProject,
  scaleOption: number | undefined,
): Dimensions => {
  if (!project || project.version !== 1) {
    throw new ExportError(
      "invalid-project",
      "Text FX export requires a version 1 project.",
    );
  }

  if (
    !Number.isFinite(project.width) ||
    !Number.isFinite(project.height) ||
    project.width <= 0 ||
    project.height <= 0
  ) {
    throw new ExportError(
      "invalid-project",
      "Text FX project dimensions must be positive numbers.",
      {
        width: project.width,
        height: project.height,
      },
    );
  }

  if (
    !Number.isFinite(project.durationMs) ||
    project.durationMs <= 0 ||
    project.durationMs > MAX_DURATION_MS
  ) {
    throw new ExportError(
      "invalid-project",
      `Text FX project duration must be between 1 and ${MAX_DURATION_MS} ms.`,
      { durationMs: project.durationMs },
    );
  }

  const scale = scaleOption ?? 1;
  if (!Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new ExportError(
      "invalid-options",
      `Export scale must be between ${MIN_SCALE} and ${MAX_SCALE}.`,
      { scale },
    );
  }

  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new ExportError(
      "invalid-project",
      "Scaled Text FX canvas dimensions are too large.",
      {
        width,
        height,
        scale,
      },
    );
  }

  const limits =
    project.width === project.height
      ? { width: 1080, height: 1080 }
      : project.width > project.height
        ? { width: 1920, height: 1080 }
        : { width: 1080, height: 1920 };
  if (width > limits.width || height > limits.height) {
    throw new ExportError(
      "invalid-options",
      `Scaled export dimensions exceed the ${limits.width}x${limits.height} ${project.width === project.height ? "square" : project.width > project.height ? "landscape" : "portrait"} limit.`,
      {
        width,
        height,
        scale,
        maxWidth: limits.width,
        maxHeight: limits.height,
      },
    );
  }

  if (
    !project.background ||
    typeof project.background.matteColor !== "string"
  ) {
    throw new ExportError(
      "invalid-project",
      "Text FX project background is incomplete.",
    );
  }

  return { width, height, scale };
};

const assertBrowserRuntime = (): void => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new ExportError(
      "runtime-unavailable",
      "Text FX export is browser-only and requires a document canvas.",
    );
  }
};

const waitForFonts = async (signal?: AbortSignal): Promise<void> => {
  if (!document.fonts) {
    return;
  }

  const families = [
    "Departure Mono Editor",
    "Geist Mono Editor",
    "Press Start 2P Editor",
  ];
  await waitForPromise(document.fonts.ready, signal);
  await waitForPromise(
    Promise.all(
      families.map((family) => document.fonts.load(`16px "${family}"`)),
    ).then(() => undefined),
    signal,
  );
};

const createCanvas = (dimensions: Dimensions): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  return canvas;
};

const renderAt = (
  project: TextFxProject,
  canvas: HTMLCanvasElement,
  timeMs: number,
  dimensions: Dimensions,
  matteColor: string | undefined,
  signal?: AbortSignal,
): void => {
  throwIfAborted(signal);
  try {
    renderFrame(project, timeMs, canvas, {
      scale: dimensions.scale,
      matteColor,
    });
  } catch (cause) {
    if (signal?.aborted) {
      throw makeAbortError();
    }
    throw new ExportError(
      "render-failed",
      `Text FX renderer failed at ${Math.round(timeMs)} ms.`,
      { timeMs, width: dimensions.width, height: dimensions.height },
      cause,
    );
  }
};

const canvasToPng = (
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
): Promise<Blob> =>
  waitForPromise(
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(
          new ExportError(
            "render-failed",
            "The browser could not encode a rendered canvas frame.",
          ),
        );
      }, "image/png");
    }),
    signal,
  );

const readBlobBytes = async (
  blob: Blob,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const buffer = await waitForPromise(blob.arrayBuffer(), signal);
  return new Uint8Array(buffer);
};

const frameCountFor = (durationMs: number, fps: number): number =>
  Math.max(1, Math.ceil((durationMs / 1000) * fps));

const isTransparent = (project: TextFxProject): boolean =>
  project.background.kind === "transparent";

type MediabunnyModule = typeof import("mediabunny");

const nativeCodecFor = (format: Exclude<ExportFormat, "gif">): "avc" | "vp9" =>
  format === "mp4" ? "avc" : "vp9";

const nativeMimeFor = (format: Exclude<ExportFormat, "gif">): string =>
  format === "mp4" ? "video/mp4" : "video/webm";

const hasAsciiAt = (
  bytes: Uint8Array,
  offset: number,
  value: string,
): boolean =>
  value
    .split("")
    .every(
      (character, index) => bytes[offset + index] === character.charCodeAt(0),
    );

const validateOutputContainer = (
  format: ExportFormat,
  bytes: Uint8Array,
): void => {
  const valid =
    format === "mp4"
      ? Array.from(
          { length: Math.min(64, bytes.length - 4) },
          (_, index) => index + 4,
        ).some((offset) => hasAsciiAt(bytes, offset, "ftyp"))
      : format === "webm"
        ? bytes.length >= 4 &&
          bytes[0] === 0x1a &&
          bytes[1] === 0x45 &&
          bytes[2] === 0xdf &&
          bytes[3] === 0xa3
        : bytes.length >= 6 &&
          (hasAsciiAt(bytes, 0, "GIF87a") || hasAsciiAt(bytes, 0, "GIF89a"));

  if (!valid) {
    throw new ExportError(
      "fallback-failed",
      `${format.toUpperCase()} encoder returned bytes with an invalid ${format.toUpperCase()} container header.`,
      { format, byteLength: bytes.byteLength },
    );
  }
};

const supportsNativeCodec = async (
  mediabunny: MediabunnyModule,
  format: Exclude<ExportFormat, "gif">,
  dimensions: Dimensions,
  transparent: boolean,
): Promise<boolean> => {
  if (!("VideoEncoder" in globalThis)) {
    return false;
  }

  try {
    return await mediabunny.canEncodeVideo(nativeCodecFor(format), {
      width: dimensions.width,
      height: dimensions.height,
      frameRate: VIDEO_FPS,
      alpha: format === "webm" && transparent ? "keep" : "discard",
    });
  } catch {
    return false;
  }
};

const encodeNative = async (
  project: TextFxProject,
  format: Exclude<ExportFormat, "gif">,
  dimensions: Dimensions,
  mediabunny: MediabunnyModule,
  signal: AbortSignal | undefined,
  onProgress: ProgressReporter | undefined,
): Promise<Blob> => {
  const transparent = format === "webm" && isTransparent(project);
  const codec = nativeCodecFor(format);
  const outputFormat =
    format === "mp4"
      ? new mediabunny.Mp4OutputFormat()
      : new mediabunny.WebMOutputFormat();
  const target = new mediabunny.BufferTarget();
  const output = new mediabunny.Output({ format: outputFormat, target });
  const canvas = createCanvas(dimensions);
  const source = new mediabunny.CanvasSource(canvas, {
    codec,
    quality: new mediabunny.Quality("high"),
    alpha: transparent ? "keep" : "discard",
    keyFrameInterval: 2,
  });
  const frames = frameCountFor(project.durationMs, VIDEO_FPS);
  const matteColor =
    format === "mp4" && isTransparent(project)
      ? project.background.matteColor
      : undefined;
  let sourceClosed = false;
  let outputFinalized = false;
  const abortOutput = (): void => {
    void output.cancel().catch(() => undefined);
  };

  signal?.addEventListener("abort", abortOutput, { once: true });
  try {
    throwIfAborted(signal);
    output.addVideoTrack(source);
    await waitForPromise(output.start(), signal);
    for (let index = 0; index < frames; index += 1) {
      const timestamp = index / VIDEO_FPS;
      renderAt(
        project,
        canvas,
        timestamp * 1000,
        dimensions,
        matteColor,
        signal,
      );
      await waitForPromise(source.add(timestamp, 1 / VIDEO_FPS), signal);
      reportProgress(onProgress, (index + 1) / frames);
      if (index % 4 === 3) {
        await yieldToBrowser(signal);
      }
    }
    source.close();
    sourceClosed = true;
    throwIfAborted(signal);
    await waitForPromise(output.finalize(), signal);
    outputFinalized = true;
    const buffer = target.buffer;
    if (!buffer) {
      throw new ExportError(
        "fallback-failed",
        `${format.toUpperCase()} encoder returned no output buffer.`,
      );
    }
    const bytes =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    validateOutputContainer(format, bytes);
    reportProgress(onProgress, 1);
    return new Blob([bytes.buffer], { type: nativeMimeFor(format) });
  } catch (cause) {
    if (
      signal?.aborted ||
      (cause instanceof ExportError && cause.code === "aborted")
    ) {
      throw makeAbortError();
    }
    throw cause;
  } finally {
    signal?.removeEventListener("abort", abortOutput);
    if (!sourceClosed) {
      source.close();
    }
    if (!outputFinalized) {
      await output.cancel().catch(() => undefined);
    }
  }
};

const transparentPalette = (
  rgba: Uint8ClampedArray,
  quantize: (
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: Record<string, unknown>,
  ) => number[][],
): { palette: number[][]; format: "rgba4444"; transparentIndex: number } => {
  let palette = quantize(rgba, 256, {
    format: "rgba4444",
    oneBitAlpha: 127,
    clearAlpha: true,
  });
  let transparentIndex = palette.findIndex((color) => (color[3] ?? 255) === 0);
  if (transparentIndex === -1) {
    if (palette.length < 256) {
      palette = [...palette, [0, 0, 0, 0]];
      transparentIndex = palette.length - 1;
    } else {
      transparentIndex = palette.reduce(
        (best, color, index) =>
          (color[3] ?? 255) < (palette[best][3] ?? 255) ? index : best,
        0,
      );
    }
  }
  return { palette, format: "rgba4444", transparentIndex };
};

const encodeGif = async (
  project: TextFxProject,
  dimensions: Dimensions,
  signal: AbortSignal | undefined,
  onProgress: ProgressReporter | undefined,
): Promise<Blob> => {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const canvas = createCanvas(dimensions);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new ExportError(
      "runtime-unavailable",
      "The browser could not acquire a 2D canvas context.",
    );
  }

  const transparent = isTransparent(project);
  const frames = frameCountFor(project.durationMs, GIF_FPS);
  const gif = GIFEncoder();

  for (let index = 0; index < frames; index += 1) {
    const timestamp = (index / GIF_FPS) * 1000;
    const delay =
      (Math.round(((index + 1) * 100) / GIF_FPS) -
        Math.round((index * 100) / GIF_FPS)) *
      10;
    renderAt(project, canvas, timestamp, dimensions, undefined, signal);
    let imageData: ImageData;
    try {
      imageData = context.getImageData(
        0,
        0,
        dimensions.width,
        dimensions.height,
      );
    } catch (cause) {
      throw new ExportError(
        "render-failed",
        "The browser could not read a rendered GIF frame.",
        {},
        cause,
      );
    }

    if (transparent) {
      const { palette, format, transparentIndex } = transparentPalette(
        imageData.data,
        quantize,
      );
      const indexed = applyPalette(imageData.data, palette, format);
      gif.writeFrame(indexed, dimensions.width, dimensions.height, {
        palette,
        transparent: true,
        transparentIndex,
        delay,
        repeat: 0,
      });
    } else {
      const palette = quantize(imageData.data, 256, { format: "rgb565" });
      const indexed = applyPalette(imageData.data, palette, "rgb565");
      gif.writeFrame(indexed, dimensions.width, dimensions.height, {
        palette,
        delay,
        repeat: 0,
      });
    }

    reportProgress(onProgress, (index + 1) / frames);
    if (index % 2 === 1) {
      await yieldToBrowser(signal);
    }
  }

  throwIfAborted(signal);
  gif.finish();
  const bytes = gif.bytes();
  validateOutputContainer("gif", bytes);
  reportProgress(onProgress, 1);
  return new Blob([bytes], { type: "image/gif" });
};

type FfmpegClient = {
  loaded: boolean;
  load: (
    config?: Record<string, string>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  writeFile: (
    path: string,
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  createDir: (path: string) => Promise<unknown>;
  deleteFile: (path: string) => Promise<unknown>;
  deleteDir: (path: string) => Promise<unknown>;
  rename: (oldPath: string, newPath: string) => Promise<unknown>;
  readFile: (
    path: string,
    encoding?: "binary" | "utf8",
    options?: { signal?: AbortSignal },
  ) => Promise<Uint8Array | string>;
  exec: (
    args: string[],
    timeout?: number,
    options?: { signal?: AbortSignal },
  ) => Promise<number>;
  terminate: () => void;
  on(
    event: "progress",
    callback: (event: { progress: number; time: number }) => void,
  ): void;
  on(
    event: "log",
    callback: (event: { type: string; message: string }) => void,
  ): void;
  off(
    event: "progress",
    callback: (event: { progress: number; time: number }) => void,
  ): void;
  off(
    event: "log",
    callback: (event: { type: string; message: string }) => void,
  ): void;
};

const bundledFfmpegCoreUrls = (): { coreURL: string; wasmURL: string } => ({
  coreURL: new URL(
    "../../../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js",
    import.meta.url,
  ).toString(),
  wasmURL: new URL(
    "../../../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm",
    import.meta.url,
  ).toString(),
});

const loadFfmpeg = async (signal?: AbortSignal): Promise<FfmpegClient> => {
  let ffmpegModule: typeof import("@ffmpeg/ffmpeg");
  try {
    ffmpegModule = await import("@ffmpeg/ffmpeg");
  } catch (cause) {
    throw new ExportError(
      "fallback-unavailable",
      "The browser fallback encoder is not available in this build.",
      { package: "@ffmpeg/ffmpeg" },
      cause,
    );
  }

  const ffmpeg = new ffmpegModule.FFmpeg() as unknown as FfmpegClient;
  try {
    await ffmpeg.load(bundledFfmpegCoreUrls(), { signal });
  } catch (cause) {
    ffmpeg.terminate();
    if (signal?.aborted) {
      throw makeAbortError();
    }
    throw new ExportError(
      "fallback-unavailable",
      "The bundled FFmpeg core could not be loaded. Check that the editor assets are served.",
      { package: "@ffmpeg/core", core: bundledFfmpegCoreUrls() },
      cause,
    );
  }
  return ffmpeg;
};

const ffmpegError = (
  format: Exclude<ExportFormat, "gif">,
  cause: unknown,
  logs: string[] = [],
  transparent = false,
): ExportError =>
  new ExportError(
    "fallback-failed",
    format === "webm" && transparent
      ? "FFmpeg could not produce a valid transparent WEBM export. The bundled VP9 alpha encoder is unavailable or failed for this project."
      : `FFmpeg could not produce a valid ${format.toUpperCase()} export.`,
    {
      format,
      codec:
        format === "mp4" ? "libx264" : transparent ? "libvpx-vp9" : "libvpx",
      alpha: format === "webm" ? (transparent ? "keep" : "discard") : undefined,
      cause: cause instanceof Error ? cause.message : String(cause),
      logs: logs.slice(-20),
    },
    cause,
  );

const encodeFallback = async (
  project: TextFxProject,
  format: Exclude<ExportFormat, "gif">,
  dimensions: Dimensions,
  signal: AbortSignal | undefined,
  onProgress: ProgressReporter | undefined,
  nativeCause?: unknown,
): Promise<Blob> => {
  const ffmpeg = await loadFfmpeg(signal);
  const canvas = createCanvas(dimensions);
  const frames = frameCountFor(project.durationMs, VIDEO_FPS);
  const matteColor =
    format === "mp4" && isTransparent(project)
      ? project.background.matteColor
      : undefined;
  const extension = format === "mp4" ? "mp4" : "webm";
  const outputPath = `/text-fx-final.${extension}`;
  const segmentPaths: string[] = [];
  const ffmpegLogs: string[] = [];
  const makeFfmpegError = (cause: unknown): ExportError =>
    ffmpegError(format, cause, ffmpegLogs, isTransparent(project));
  const logListener = (event: { type: string; message: string }): void => {
    ffmpegLogs.push(event.message);
    if (ffmpegLogs.length > 40) {
      ffmpegLogs.shift();
    }
  };
  let progressListener:
    ((event: { progress: number; time: number }) => void) | undefined;

  try {
    ffmpeg.on("log", logListener);
    for (
      let segmentStart = 0, segmentIndex = 0;
      segmentStart < frames;
      segmentStart += FALLBACK_SEGMENT_FRAMES, segmentIndex += 1
    ) {
      throwIfAborted(signal);
      const segmentEnd = Math.min(
        frames,
        segmentStart + FALLBACK_SEGMENT_FRAMES,
      );
      const segmentDir = `/text-fx-segment-${segmentIndex}`;
      const segmentPath = `${segmentDir}.${extension}`;
      await ffmpeg.createDir(segmentDir);

      for (let frame = segmentStart; frame < segmentEnd; frame += 1) {
        const frameInSegment = frame - segmentStart + 1;
        renderAt(
          project,
          canvas,
          (frame / VIDEO_FPS) * 1000,
          dimensions,
          matteColor,
          signal,
        );
        const png = await canvasToPng(canvas, signal);
        const framePath = `${segmentDir}/frame-${String(frameInSegment).padStart(6, "0")}.png`;
        await ffmpeg.writeFile(framePath, await readBlobBytes(png, signal), {
          signal,
        });
        reportProgress(onProgress, 0.05 + ((frame + 1) / frames) * 0.65);
        if (frame % 2 === 1) {
          await yieldToBrowser(signal);
        }
      }

      const encodeArgs = [
        "-framerate",
        String(VIDEO_FPS),
        "-start_number",
        "1",
        "-i",
        `${segmentDir}/frame-%06d.png`,
        "-an",
        "-c:v",
        format === "mp4"
          ? "libx264"
          : isTransparent(project)
            ? "libvpx-vp9"
            : "libvpx",
        ...(format === "mp4"
          ? ["-pix_fmt", "yuv420p", "-movflags", "+faststart"]
          : [
              "-deadline",
              "good",
              "-cpu-used",
              "4",
              "-b:v",
              "0",
              "-crf",
              isTransparent(project) ? "30" : "32",
              "-pix_fmt",
              isTransparent(project) ? "yuva420p" : "yuv420p",
              ...(isTransparent(project) ? ["-auto-alt-ref", "0"] : []),
            ]),
        "-f",
        format,
        "-y",
        segmentPath,
      ];
      progressListener = (event) => {
        const segmentProgress = clamp(event.progress, 0, 1);
        const encodedFrames =
          segmentStart +
          Math.round(segmentProgress * (segmentEnd - segmentStart));
        reportProgress(onProgress, 0.05 + (encodedFrames / frames) * 0.65);
      };
      ffmpeg.on("progress", progressListener);
      try {
        const exitCode = await ffmpeg.exec(encodeArgs, -1, { signal });
        if (exitCode !== 0) {
          throw makeFfmpegError(
            new Error(`FFmpeg exited with code ${exitCode}.`),
          );
        }
      } catch (cause) {
        if (signal?.aborted) {
          throw makeAbortError();
        }
        if (cause instanceof ExportError && cause.code === "fallback-failed") {
          throw cause;
        }
        throw makeFfmpegError(cause);
      } finally {
        ffmpeg.off("progress", progressListener);
        progressListener = undefined;
      }

      for (let frame = segmentStart; frame < segmentEnd; frame += 1) {
        const frameInSegment = frame - segmentStart + 1;
        await ffmpeg.deleteFile(
          `${segmentDir}/frame-${String(frameInSegment).padStart(6, "0")}.png`,
        );
      }
      await ffmpeg.deleteDir(segmentDir);
      segmentPaths.push(segmentPath);
    }

    throwIfAborted(signal);
    if (segmentPaths.length === 1) {
      await ffmpeg.rename(segmentPaths[0], outputPath);
    } else {
      const concat = segmentPaths.map((path) => `file '${path}'`).join("\n");
      await ffmpeg.writeFile(
        "/text-fx-concat.txt",
        new TextEncoder().encode(concat),
        { signal },
      );
      const concatListener = (event: {
        progress: number;
        time: number;
      }): void =>
        reportProgress(onProgress, 0.7 + clamp(event.progress, 0, 1) * 0.25);
      ffmpeg.on("progress", concatListener);
      try {
        const exitCode = await ffmpeg.exec(
          [
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "/text-fx-concat.txt",
            "-c",
            "copy",
            "-y",
            outputPath,
          ],
          -1,
          { signal },
        );
        if (exitCode !== 0) {
          throw makeFfmpegError(
            new Error(`FFmpeg exited with code ${exitCode}.`),
          );
        }
      } catch (cause) {
        if (signal?.aborted) {
          throw makeAbortError();
        }
        if (cause instanceof ExportError && cause.code === "fallback-failed") {
          throw cause;
        }
        throw makeFfmpegError(cause);
      } finally {
        ffmpeg.off("progress", concatListener);
      }
    }

    const output = await ffmpeg.readFile(outputPath, "binary", { signal });
    if (typeof output === "string" || output.byteLength === 0) {
      throw makeFfmpegError(new Error("FFmpeg returned an empty output file."));
    }
    const outputCopy = new Uint8Array(output.byteLength);
    outputCopy.set(output);
    validateOutputContainer(format, outputCopy);
    reportProgress(onProgress, 1);
    return new Blob([outputCopy.buffer], { type: nativeMimeFor(format) });
  } catch (cause) {
    if (
      signal?.aborted ||
      (cause instanceof ExportError && cause.code === "aborted")
    ) {
      throw makeAbortError();
    }
    if (cause instanceof ExportError) {
      if (nativeCause !== undefined) {
        cause.details.nativeCodecError =
          nativeCause instanceof Error
            ? nativeCause.message
            : String(nativeCause);
      }
      throw cause;
    }
    throw makeFfmpegError(cause);
  } finally {
    if (progressListener) {
      ffmpeg.off("progress", progressListener);
    }
    ffmpeg.off("log", logListener);
    ffmpeg.terminate();
  }
};

export async function exportProject(
  project: TextFxProject,
  options: ExportOptions,
): Promise<Blob> {
  assertBrowserRuntime();
  if (!options || !["mp4", "webm", "gif"].includes(options.format)) {
    throw new ExportError(
      "invalid-options",
      "Text FX export format must be mp4, webm, or gif.",
      {
        format: options?.format,
      },
    );
  }
  const dimensions = validateProject(project, options.scale);
  throwIfAborted(options.signal);
  reportProgress(options.onProgress, 0);
  await waitForFonts(options.signal);

  if (options.format === "gif") {
    return encodeGif(project, dimensions, options.signal, options.onProgress);
  }

  const transparent = isTransparent(project);
  let mediabunny: MediabunnyModule | undefined;
  let nativeCause: unknown;
  try {
    mediabunny = await import("mediabunny");
    const nativeSupported = await supportsNativeCodec(
      mediabunny,
      options.format,
      dimensions,
      transparent,
    );
    if (nativeSupported) {
      try {
        return await encodeNative(
          project,
          options.format,
          dimensions,
          mediabunny,
          options.signal,
          options.onProgress,
        );
      } catch (cause) {
        if (
          options.signal?.aborted ||
          (cause instanceof ExportError && cause.code === "aborted")
        ) {
          throw makeAbortError();
        }
        if (
          cause instanceof ExportError &&
          ["invalid-project", "invalid-options", "render-failed"].includes(
            cause.code,
          )
        ) {
          throw cause;
        }
        nativeCause = cause;
      }
    } else {
      nativeCause = new ExportError(
        "native-codec-unavailable",
        `${options.format.toUpperCase()} native codec is unavailable at ${dimensions.width}x${dimensions.height}.`,
        {
          format: options.format,
          codec: nativeCodecFor(options.format),
          width: dimensions.width,
          height: dimensions.height,
          transparent,
        },
      );
    }
  } catch (cause) {
    if (options.signal?.aborted) {
      throw makeAbortError();
    }
    nativeCause = cause;
  }

  return encodeFallback(
    project,
    options.format,
    dimensions,
    options.signal,
    options.onProgress,
    nativeCause,
  );
}
