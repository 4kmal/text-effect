import {
  createModelAbortError,
  frameCountFor,
  isModelExportAbort,
  MODEL_EXPORT_LIMITS,
  ModelExportError,
  type ModelExportCapabilities,
  type ModelExportDestination,
  type ModelExportFormat,
  type ModelExportOptions,
  type ModelExportResult,
  validateModelExportOptions,
} from "./types";
import { ModelerLocalHelperClient } from "./localHelper";

type MediabunnyModule = typeof import("mediabunny");

type FfmpegClient = {
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
};

const FALLBACK_SEGMENT_FRAMES = 90;

const clamp = (value: number): number =>
  Math.min(1, Math.max(0, value));

const reportProgress = (
  callback: ModelExportOptions["onProgress"],
  value: number,
): void => {
  callback?.(clamp(value));
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createModelAbortError();
  }
};

const yieldToBrowser = async (signal?: AbortSignal): Promise<void> => {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
};

const assertBrowserRuntime = (): void => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new ModelExportError(
      "runtime-unavailable",
      "Model export requires a browser canvas.",
    );
  }
};

const createCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const renderIntoCanvas = async (
  options: ModelExportOptions,
  timeSeconds: number,
  alpha: boolean,
  canvas: HTMLCanvasElement,
): Promise<void> => {
  throwIfAborted(options.signal);
  let rendered: HTMLCanvasElement;
  try {
    rendered = await options.renderFrame(
      timeSeconds,
      options.width,
      options.height,
      alpha,
    );
  } catch (cause) {
    if (options.signal?.aborted || isModelExportAbort(cause)) {
      throw createModelAbortError();
    }
    if (cause instanceof ModelExportError) {
      throw cause;
    }
    throw new ModelExportError(
      "render-failed",
      `The model renderer failed at ${timeSeconds.toFixed(3)} seconds.`,
      { timeSeconds },
      cause,
    );
  }

  if (
    !rendered ||
    rendered.width !== options.width ||
    rendered.height !== options.height
  ) {
    throw new ModelExportError(
      "render-failed",
      "The model renderer returned a frame with the wrong dimensions.",
      {
        expectedWidth: options.width,
        expectedHeight: options.height,
        width: rendered?.width,
        height: rendered?.height,
        timeSeconds,
      },
    );
  }

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new ModelExportError(
      "runtime-unavailable",
      "The browser could not acquire a canvas drawing context.",
    );
  }
  context.clearRect(0, 0, options.width, options.height);
  if (!alpha) {
    context.fillStyle = options.matte ?? "#000000";
    context.fillRect(0, 0, options.width, options.height);
  }
  try {
    context.drawImage(rendered, 0, 0, options.width, options.height);
  } catch (cause) {
    throw new ModelExportError(
      "render-failed",
      "The browser could not copy the model frame into the encoder canvas.",
      { timeSeconds },
      cause,
    );
  }
};

const canvasToPng = async (
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  throwIfAborted(signal);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
      } else {
        reject(
          new ModelExportError(
            "render-failed",
            "The browser could not encode a model frame as PNG.",
          ),
        );
      }
    }, "image/png");
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  throwIfAborted(signal);
  return bytes;
};

const hasAsciiAt = (
  bytes: Uint8Array,
  offset: number,
  value: string,
): boolean =>
  value.split("").every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );

const validateVideoContainer = (
  format: Exclude<ModelExportFormat, "mov" | "png-sequence">,
  bytes: Uint8Array,
): void => {
  const valid =
    format === "mp4"
      ? Array.from(
          { length: Math.min(64, Math.max(0, bytes.length - 4)) },
          (_, index) => index + 4,
        ).some((offset) => hasAsciiAt(bytes, offset, "ftyp"))
      : bytes.length >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3;
  if (!valid) {
    throw new ModelExportError(
      "fallback-failed",
      `${format.toUpperCase()} encoder returned an invalid container.`,
      { format, byteLength: bytes.byteLength },
    );
  }
};

const getNativeCodecSupport = async (
  mediabunny: MediabunnyModule,
  format: "webm" | "mp4",
  options: ModelExportOptions,
): Promise<boolean> => {
  if (!("VideoEncoder" in globalThis)) {
    return false;
  }
  try {
    return await mediabunny.canEncodeVideo(
      format === "webm" ? "vp9" : "avc",
      {
        width: options.width,
        height: options.height,
        frameRate: options.fps,
        alpha:
          format === "webm" && (options.alpha ?? true)
            ? "keep"
            : "discard",
      },
    );
  } catch {
    return false;
  }
};

export async function checkModelExportCapabilities(
  width = 1920,
  height = 1080,
  fps = 60,
): Promise<ModelExportCapabilities> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      webm: false,
      webmAlpha: false,
      mp4: false,
      localMov: false,
    };
  }
  const base = {
    width,
    height,
    fps,
    durationSeconds: 1,
    format: "webm" as const,
    renderFrame: () => document.createElement("canvas"),
  } satisfies ModelExportOptions;
  let mediabunny: MediabunnyModule;
  try {
    mediabunny = await import("mediabunny");
  } catch {
    return {
      webm: false,
      webmAlpha: false,
      mp4: false,
      localMov: false,
    };
  }
  const webm = await getNativeCodecSupport(mediabunny, "webm", base);
  const webmAlpha = webm &&
    (await getNativeCodecSupport(mediabunny, "webm", {
      ...base,
      alpha: true,
    }));
  const mp4 = await getNativeCodecSupport(mediabunny, "mp4", {
    ...base,
    format: "mp4",
    alpha: false,
  });
  const helper = new ModelerLocalHelperClient();
  return {
    webm,
    webmAlpha,
    mp4,
    localMov: await helper.isAvailable().catch(() => false),
  };
}

const encodeNativeVideo = async (
  options: ModelExportOptions,
  format: "webm" | "mp4",
  mediabunny: MediabunnyModule,
): Promise<Blob> => {
  const transparent = format === "webm" && (options.alpha ?? true);
  const outputFormat =
    format === "webm"
      ? new mediabunny.WebMOutputFormat()
      : new mediabunny.Mp4OutputFormat();
  const target = new mediabunny.BufferTarget();
  const output = new mediabunny.Output({ format: outputFormat, target });
  const canvas = createCanvas(options.width, options.height);
  const source = new mediabunny.CanvasSource(canvas, {
    codec: format === "webm" ? "vp9" : "avc",
    quality: new mediabunny.Quality("high"),
    alpha: transparent ? "keep" : "discard",
    keyFrameInterval: 2,
  });
  const frames = frameCountFor(options.durationSeconds, options.fps);
  let sourceClosed = false;
  let outputFinalized = false;
  const cancel = (): void => {
    void output.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    throwIfAborted(options.signal);
    output.addVideoTrack(source);
    await output.start();
    for (let frame = 0; frame < frames; frame += 1) {
      const timestamp = frame / options.fps;
      await renderIntoCanvas(options, timestamp, transparent, canvas);
      await source.add(timestamp, 1 / options.fps);
      reportProgress(options.onProgress, (frame + 1) / frames);
      if (frame % 4 === 3) {
        await yieldToBrowser(options.signal);
      }
    }
    source.close();
    sourceClosed = true;
    throwIfAborted(options.signal);
    await output.finalize();
    outputFinalized = true;
    const buffer = target.buffer;
    if (!buffer) {
      throw new ModelExportError(
        "native-encode-failed",
        `${format.toUpperCase()} encoder returned no output.`,
      );
    }
    const bytes =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    validateVideoContainer(format, bytes);
    return new Blob([bytes], {
      type: format === "webm" ? "video/webm" : "video/mp4",
    });
  } catch (cause) {
    if (options.signal?.aborted || isModelExportAbort(cause)) {
      throw createModelAbortError();
    }
    if (cause instanceof ModelExportError) {
      throw cause;
    }
    throw new ModelExportError(
      "native-encode-failed",
      `${format.toUpperCase()} native encoding failed.`,
      { format },
      cause,
    );
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    if (!sourceClosed) {
      source.close();
    }
    if (!outputFinalized) {
      await output.cancel().catch(() => undefined);
    }
  }
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
  throwIfAborted(signal);
  let module: typeof import("@ffmpeg/ffmpeg");
  try {
    module = await import("@ffmpeg/ffmpeg");
  } catch (cause) {
    throw new ModelExportError(
      "fallback-unavailable",
      "The browser FFmpeg fallback is not available in this build.",
      { package: "@ffmpeg/ffmpeg" },
      cause,
    );
  }
  const ffmpeg = new module.FFmpeg() as unknown as FfmpegClient;
  try {
    await ffmpeg.load(bundledFfmpegCoreUrls(), { signal });
  } catch (cause) {
    ffmpeg.terminate();
    if (signal?.aborted) {
      throw createModelAbortError();
    }
    throw new ModelExportError(
      "fallback-unavailable",
      "The browser FFmpeg fallback could not start.",
      { package: "@ffmpeg/core" },
      cause,
    );
  }
  return ffmpeg;
};

const ffmpegSegmentArgs = (
  format: "webm" | "mp4",
  transparent: boolean,
  fps: number,
  directory: string,
  frameCount: number,
  output: string,
): string[] => [
  "-framerate",
  String(fps),
  "-start_number",
  "1",
  "-i",
  `${directory}/frame-%06d.png`,
  "-frames:v",
  String(frameCount),
  "-an",
  "-c:v",
  format === "mp4" ? "libx264" : "libvpx-vp9",
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
        transparent ? "30" : "32",
        "-pix_fmt",
        transparent ? "yuva420p" : "yuv420p",
        ...(transparent ? ["-auto-alt-ref", "0"] : []),
      ]),
  "-y",
  output,
];

const encodeFallbackVideo = async (
  options: ModelExportOptions,
  format: "webm" | "mp4",
): Promise<Blob> => {
  const ffmpeg = await loadFfmpeg(options.signal);
  const transparent = format === "webm" && (options.alpha ?? true);
  const frames = frameCountFor(options.durationSeconds, options.fps);
  const segmentPaths: string[] = [];
  const token = Math.random().toString(36).slice(2, 10);
  const finalPath = `/modeler-${token}.${format}`;
  const canvas = createCanvas(options.width, options.height);
  try {
    for (
      let segmentStart = 0, segmentIndex = 0;
      segmentStart < frames;
      segmentStart += FALLBACK_SEGMENT_FRAMES, segmentIndex += 1
    ) {
      throwIfAborted(options.signal);
      const segmentEnd = Math.min(
        frames,
        segmentStart + FALLBACK_SEGMENT_FRAMES,
      );
      const segmentCount = segmentEnd - segmentStart;
      const directory = `/modeler-${token}-segment-${segmentIndex}`;
      const segmentPath = `${directory}.${format}`;
      await ffmpeg.createDir(directory);
      for (let frame = segmentStart; frame < segmentEnd; frame += 1) {
        await renderIntoCanvas(
          options,
          frame / options.fps,
          transparent,
          canvas,
        );
        const png = await canvasToPng(canvas, options.signal);
        await ffmpeg.writeFile(
          `${directory}/frame-${String(frame - segmentStart + 1).padStart(6, "0")}.png`,
          png,
          { signal: options.signal },
        );
        reportProgress(
          options.onProgress,
          ((frame + 1) / frames) * 0.7,
        );
        if (frame % 2 === 1) {
          await yieldToBrowser(options.signal);
        }
      }
      const exitCode = await ffmpeg.exec(
        ffmpegSegmentArgs(
          format,
          transparent,
          options.fps,
          directory,
          segmentCount,
          segmentPath,
        ),
        -1,
        { signal: options.signal },
      );
      if (exitCode !== 0) {
        throw new ModelExportError(
          "fallback-failed",
          `FFmpeg exited with code ${exitCode} while encoding a ${format.toUpperCase()} segment.`,
        );
      }
      for (let frame = 1; frame <= segmentCount; frame += 1) {
        await ffmpeg.deleteFile(
          `${directory}/frame-${String(frame).padStart(6, "0")}.png`,
        );
      }
      await ffmpeg.deleteDir(directory);
      segmentPaths.push(segmentPath);
    }

    throwIfAborted(options.signal);
    if (segmentPaths.length === 1) {
      await ffmpeg.rename(segmentPaths[0], finalPath);
    } else {
      const concat = segmentPaths.map((path) => `file '${path}'`).join("\n");
      await ffmpeg.writeFile(
        `/modeler-${token}-concat.txt`,
        new TextEncoder().encode(concat),
        { signal: options.signal },
      );
      const exitCode = await ffmpeg.exec(
        [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          `/modeler-${token}-concat.txt`,
          "-c",
          "copy",
          "-y",
          finalPath,
        ],
        -1,
        { signal: options.signal },
      );
      if (exitCode !== 0) {
        throw new ModelExportError(
          "fallback-failed",
          `FFmpeg exited with code ${exitCode} while joining model segments.`,
        );
      }
    }

    const output = await ffmpeg.readFile(finalPath, "binary", {
      signal: options.signal,
    });
    if (typeof output === "string" || output.byteLength === 0) {
      throw new ModelExportError(
        "fallback-failed",
        `FFmpeg returned an empty ${format.toUpperCase()} file.`,
      );
    }
    const bytes = new Uint8Array(output);
    validateVideoContainer(format, bytes);
    reportProgress(options.onProgress, 1);
    return new Blob([bytes], {
      type: format === "webm" ? "video/webm" : "video/mp4",
    });
  } catch (cause) {
    if (options.signal?.aborted || isModelExportAbort(cause)) {
      throw createModelAbortError();
    }
    if (cause instanceof ModelExportError) {
      throw cause;
    }
    throw new ModelExportError(
      "fallback-failed",
      `The browser FFmpeg fallback failed for ${format.toUpperCase()}.`,
      { format },
      cause,
    );
  } finally {
    for (const path of segmentPaths) {
      await ffmpeg.deleteFile(path).catch(() => undefined);
    }
    await ffmpeg.deleteFile(finalPath).catch(() => undefined);
    await ffmpeg.deleteFile(`/modeler-${token}-concat.txt`).catch(() => undefined);
    ffmpeg.terminate();
  }
};

type WritableFile = {
  write(data: Blob | Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort?: (reason?: unknown) => Promise<void> | void;
};

const writeBytes = async (
  writable: WritableFile,
  bytes: Uint8Array,
): Promise<void> => {
  await writable.write(bytes);
};

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const zipHeader = (
  signature: number,
  crc: number,
  size: number,
  nameLength: number,
  offset = 0,
): Uint8Array => {
  const header = new Uint8Array(signature === 0x04034b50 ? 30 : 46);
  const view = new DataView(header.buffer);
  view.setUint32(0, signature, true);
  if (signature === 0x04034b50) {
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameLength, true);
    view.setUint16(28, 0, true);
  } else {
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, nameLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
  }
  return header;
};

const zipEnd = (
  entryCount: number,
  directorySize: number,
  directoryOffset: number,
): Uint8Array => {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, directoryOffset, true);
  return bytes;
};

const writeZipSequence = async (
  options: ModelExportOptions,
  handle: FileSystemFileHandle,
  canvas: HTMLCanvasElement,
  basename: string,
): Promise<void> => {
  const writable = (await handle.createWritable()) as unknown as WritableFile;
  const centralDirectory: Uint8Array[] = [];
  const textEncoder = new TextEncoder();
  let offset = 0;
  const frames = frameCountFor(options.durationSeconds, options.fps);
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      await renderIntoCanvas(options, frame / options.fps, true, canvas);
      const bytes = await canvasToPng(canvas, options.signal);
      const filename = `${basename}-${String(frame + 1).padStart(4, "0")}.png`;
      const name = textEncoder.encode(filename);
      const crc = crc32(bytes);
      const local = zipHeader(0x04034b50, crc, bytes.byteLength, name.byteLength);
      await writeBytes(writable, local);
      await writeBytes(writable, name);
      await writeBytes(writable, bytes);
      const central = zipHeader(
        0x02014b50,
        crc,
        bytes.byteLength,
        name.byteLength,
        offset,
      );
      const centralEntry = new Uint8Array(central.byteLength + name.byteLength);
      centralEntry.set(central, 0);
      centralEntry.set(name, central.byteLength);
      centralDirectory.push(centralEntry);
      offset += local.byteLength + name.byteLength + bytes.byteLength;
      reportProgress(options.onProgress, (frame + 1) / frames);
      if (frame % 2 === 1) {
        await yieldToBrowser(options.signal);
      }
    }
    const directoryOffset = offset;
    let directorySize = 0;
    for (let index = 0; index < centralDirectory.length; index += 1) {
      const entry = centralDirectory[index];
      await writeBytes(writable, entry);
      offset += entry.byteLength;
      directorySize += entry.byteLength;
    }
    await writeBytes(
      writable,
      zipEnd(centralDirectory.length, directorySize, directoryOffset),
    );
    await writable.close();
  } catch (cause) {
    await Promise.resolve(writable.abort?.(cause)).catch(() => undefined);
    if (options.signal?.aborted || isModelExportAbort(cause)) {
      throw createModelAbortError();
    }
    throw cause;
  }
};

const writePngSequenceToDirectory = async (
  options: ModelExportOptions,
  directory: FileSystemDirectoryHandle,
  canvas: HTMLCanvasElement,
  basename: string,
): Promise<FileSystemFileHandle[]> => {
  const files: FileSystemFileHandle[] = [];
  const frames = frameCountFor(options.durationSeconds, options.fps);
  for (let frame = 0; frame < frames; frame += 1) {
    throwIfAborted(options.signal);
    await renderIntoCanvas(options, frame / options.fps, true, canvas);
    const bytes = await canvasToPng(canvas, options.signal);
    const filename = `${basename}-${String(frame + 1).padStart(4, "0")}.png`;
    const file = await directory.getFileHandle(filename, { create: true });
    const writable = (await file.createWritable()) as unknown as WritableFile;
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (cause) {
      await Promise.resolve(writable.abort?.(cause)).catch(() => undefined);
      throw cause;
    }
    files.push(file);
    reportProgress(options.onProgress, (frame + 1) / frames);
    if (frame % 2 === 1) {
      await yieldToBrowser(options.signal);
    }
  }
  return files;
};

const getSaveFilePicker = (): ((options?: unknown) => Promise<FileSystemFileHandle>) | undefined => {
  const globalWithPicker = globalThis as typeof globalThis & {
    showSaveFilePicker?: (
      options?: unknown,
    ) => Promise<FileSystemFileHandle>;
  };
  return globalWithPicker.showSaveFilePicker;
};

const basenameFor = (value: string | undefined): string => {
  const cleaned = (value ?? "vitruvian-spin")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "vitruvian-spin";
};

const exportPngSequence = async (
  options: ModelExportOptions,
): Promise<ModelExportResult> => {
  const canvas = createCanvas(options.width, options.height);
  const basename = basenameFor(options.basename);
  const destination: ModelExportDestination = options.destination ?? {};
  if (destination.directory) {
    const files = await writePngSequenceToDirectory(
      options,
      destination.directory,
      canvas,
      basename,
    );
    return {
      format: options.format,
      width: options.width,
      height: options.height,
      fps: options.fps,
      durationSeconds: options.durationSeconds,
      frameCount: files.length,
      mimeType: "image/png",
      files,
    };
  }

  let archive = destination.archive;
  if (!archive) {
    const picker = getSaveFilePicker();
    if (!picker) {
      throw new ModelExportError(
        "destination-required",
        "PNG sequence export requires a folder or a browser save-file picker.",
      );
    }
    archive = await picker({
      suggestedName: `${basename}.zip`,
      types: [
        {
          description: "PNG frame archive",
          accept: { "application/zip": [".zip"] },
        },
      ],
    });
  }
  await writeZipSequence(options, archive, canvas, basename);
  return {
    format: options.format,
    width: options.width,
    height: options.height,
    fps: options.fps,
    durationSeconds: options.durationSeconds,
    frameCount: frameCountFor(options.durationSeconds, options.fps),
    mimeType: "application/zip",
    archive,
  };
};

const resultForVideo = (
  options: ModelExportOptions,
  blob: Blob,
): ModelExportResult => ({
  format: options.format,
  width: options.width,
  height: options.height,
  fps: options.fps,
  durationSeconds: options.durationSeconds,
  frameCount: frameCountFor(options.durationSeconds, options.fps),
  mimeType: blob.type,
  blob,
});

export async function exportModel(
  options: ModelExportOptions,
): Promise<ModelExportResult> {
  assertBrowserRuntime();
  validateModelExportOptions(options);
  throwIfAborted(options.signal);
  reportProgress(options.onProgress, 0);

  if (options.format === "png-sequence") {
    return exportPngSequence(options);
  }

  if (options.format === "mov") {
    const helper = options.helper ?? new ModelerLocalHelperClient();
    if (!(await helper.isAvailable(options.signal))) {
      throw new ModelExportError(
        "helper-unavailable",
        "Start the local model helper before exporting a ProRes MOV.",
      );
    }
    try {
      const blob = await helper.exportProRes4444({
        width: options.width,
        height: options.height,
        fps: options.fps,
        durationSeconds: options.durationSeconds,
        renderFrame: options.renderFrame,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      return resultForVideo(options, blob);
    } catch (cause) {
      if (options.signal?.aborted || isModelExportAbort(cause)) {
        throw createModelAbortError();
      }
      if (cause instanceof ModelExportError) {
        throw cause;
      }
      throw new ModelExportError(
        "helper-failed",
        "The local helper failed to export ProRes MOV.",
        {},
        cause,
      );
    }
  }

  const format = options.format;
  let nativeCause: unknown;
  try {
    const mediabunny = await import("mediabunny");
    if (await getNativeCodecSupport(mediabunny, format, options)) {
      try {
        return resultForVideo(
          options,
          await encodeNativeVideo(options, format, mediabunny),
        );
      } catch (cause) {
        if (options.signal?.aborted || isModelExportAbort(cause)) {
          throw createModelAbortError();
        }
        if (
          cause instanceof ModelExportError &&
          ["invalid-options", "render-failed", "runtime-unavailable"].includes(
            cause.code,
          )
        ) {
          throw cause;
        }
        nativeCause = cause;
      }
    } else {
      nativeCause = new ModelExportError(
        "native-codec-unavailable",
        `${format.toUpperCase()} native codec is unavailable at ${options.width}x${options.height}.`,
        { format, width: options.width, height: options.height },
      );
    }
  } catch (cause) {
    if (options.signal?.aborted || isModelExportAbort(cause)) {
      throw createModelAbortError();
    }
    if (cause instanceof ModelExportError && cause.code === "render-failed") {
      throw cause;
    }
    nativeCause = cause;
  }

  try {
    return resultForVideo(
      options,
      await encodeFallbackVideo(options, format),
    );
  } catch (cause) {
    if (options.signal?.aborted || isModelExportAbort(cause)) {
      throw createModelAbortError();
    }
    if (cause instanceof ModelExportError) {
      if (nativeCause !== undefined) {
        cause.details.nativeCodecError =
          nativeCause instanceof Error ? nativeCause.message : String(nativeCause);
      }
      throw cause;
    }
    throw new ModelExportError(
      "fallback-failed",
      `${format.toUpperCase()} export failed after the native path was unavailable.`,
      {
        nativeCause:
          nativeCause instanceof Error ? nativeCause.message : String(nativeCause),
      },
      cause,
    );
  }
}

export { MODEL_EXPORT_LIMITS };
