import type { CameraTake } from "./recording";

export type CameraConversionOptions = {
  directory: FileSystemDirectoryHandle;
  basename?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

export type CameraConversionErrorCode =
  "invalid-input" | "unsupported" | "aborted" | "failed";

export class CameraConversionError extends Error {
  readonly code: CameraConversionErrorCode;
  readonly cause?: unknown;

  constructor(
    code: CameraConversionErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CameraConversionError";
    this.code = code;
    this.cause = cause;
  }
}

type MediabunnyModule = typeof import("mediabunny");
type StreamTargetChunk = import("mediabunny").StreamTargetChunk;
type MediabunnyConversion = Awaited<
  ReturnType<MediabunnyModule["Conversion"]["init"]>
>;

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
  deleteFile: (
    path: string,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
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
  on: (
    event: "progress",
    callback: (event: { progress: number; time: number }) => void,
  ) => void;
  off: (
    event: "progress",
    callback: (event: { progress: number; time: number }) => void,
  ) => void;
  terminate: () => void;
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new CameraConversionError(
      "aborted",
      "Camera MP4 conversion was canceled.",
    );
  }
};

const toError = (value: unknown, fallback: string): Error => {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === "string" ? value : fallback);
};

const sanitizeBasename = (value: string): string => {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return sanitized || "camera-take";
};

const timestamp = (date: Date): string => {
  const pad = (value: number, size = 2): string =>
    String(value).padStart(size, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}`;
};

let conversionSequence = 0;

const randomSuffix = (): string => {
  const random = new Uint32Array(1);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(random);
    return random[0].toString(36).padStart(7, "0");
  }
  conversionSequence = (conversionSequence + 1) % 36 ** 5;
  return conversionSequence.toString(36).padStart(5, "0");
};

const outputFilename = (
  basename: string,
  role: "effected" | "clean",
  date: Date,
): string =>
  `${sanitizeBasename(basename)}-${timestamp(date)}-${randomSuffix()}-${role}.mp4`;

const openOutput = async (
  directory: FileSystemDirectoryHandle,
  filename: string,
): Promise<{
  handle: FileSystemFileHandle;
  writable: FileSystemWritableFileStream;
}> => {
  try {
    const handle = await directory.getFileHandle(filename, { create: true });
    return { handle, writable: await handle.createWritable() };
  } catch (cause) {
    throw new CameraConversionError(
      "failed",
      `Could not create the MP4 output ${filename}.`,
      cause,
    );
  }
};

const closeAfterFailure = async (
  writable: FileSystemWritableFileStream | undefined,
  cause: unknown,
): Promise<void> => {
  if (!writable) {
    return;
  }
  try {
    await writable.abort(cause);
  } catch {
    try {
      await writable.close();
    } catch {
      // Preserve the native source even when a partial output cannot be closed.
    }
  }
};

const writeBlobToFile = async (
  directory: FileSystemDirectoryHandle,
  filename: string,
  data: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<FileSystemFileHandle> => {
  throwIfAborted(signal);
  const output = await openOutput(directory, filename);
  try {
    const fileBytes = new Uint8Array(data.byteLength);
    fileBytes.set(data);
    await output.writable.write(new Blob([fileBytes.buffer as ArrayBuffer]));
    throwIfAborted(signal);
    await output.writable.close();
    return output.handle;
  } catch (cause) {
    await closeAfterFailure(output.writable, cause);
    if (signal?.aborted) {
      throw new CameraConversionError(
        "aborted",
        "Camera MP4 conversion was canceled.",
        cause,
      );
    }
    throw new CameraConversionError(
      "failed",
      `Could not write ${filename}.`,
      cause,
    );
  }
};

const createMediabunnyTarget = (
  mediabunny: MediabunnyModule,
  writable: FileSystemWritableFileStream,
): InstanceType<MediabunnyModule["StreamTarget"]> => {
  let closed = false;
  const stream = new WritableStream<StreamTargetChunk>({
    write: (chunk) =>
      writable.write({
        type: "write",
        data: new Uint8Array(chunk.data),
        position: chunk.position,
      }),
    close: async () => {
      if (!closed) {
        closed = true;
        await writable.close();
      }
    },
    abort: async (reason) => {
      if (!closed) {
        closed = true;
        await closeAfterFailure(writable, reason);
      }
    },
  });
  return new mediabunny.StreamTarget(stream, { chunked: false });
};

const convertWithMediabunny = async (
  mediabunny: MediabunnyModule,
  sourceHandle: FileSystemFileHandle,
  directory: FileSystemDirectoryHandle,
  filename: string,
  signal: AbortSignal | undefined,
  onProgress: (progress: number) => void,
): Promise<FileSystemFileHandle> => {
  throwIfAborted(signal);
  const sourceFile = await sourceHandle.getFile();
  const input = new mediabunny.Input({
    source: new mediabunny.BlobSource(sourceFile),
    formats: mediabunny.ALL_FORMATS,
  });
  const output = await openOutput(directory, filename);
  let conversion: MediabunnyConversion | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new CameraConversionError(
        "unsupported",
        `The source ${sourceHandle.name} does not contain a video track.`,
      );
    }
    const width = await videoTrack.getDisplayWidth();
    const height = await videoTrack.getDisplayHeight();
    const audioTrack = await input.getPrimaryAudioTrack();
    const canEncodeVideo = await mediabunny.canEncodeVideo("avc", {
      width,
      height,
      frameRate: 30,
    });
    const canEncodeAudio = audioTrack
      ? await mediabunny.canEncodeAudio("aac", {
          numberOfChannels: await audioTrack.getNumberOfChannels(),
          sampleRate: await audioTrack.getSampleRate(),
        })
      : true;
    if (!canEncodeVideo || !canEncodeAudio) {
      throw new CameraConversionError(
        "unsupported",
        "This browser cannot encode the WebM take as H.264/AAC MP4 with WebCodecs.",
      );
    }

    const target = createMediabunnyTarget(mediabunny, output.writable);
    const outputFile = new mediabunny.Output({
      format: new mediabunny.Mp4OutputFormat(),
      target,
    });
    conversion = await mediabunny.Conversion.init({
      input,
      output: outputFile,
      tracks: "primary",
      video: {
        codec: "avc",
        frameRate: 30,
        quality: new mediabunny.Quality("high"),
        forceTranscode: true,
      },
      audio: audioTrack
        ? {
            codec: "aac",
            quality: new mediabunny.Quality("high"),
            forceTranscode: true,
          }
        : undefined,
      copy: false,
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new CameraConversionError(
        "unsupported",
        "Mediabunny could not configure a valid MP4 conversion.",
      );
    }
    conversion.onProgress = (progress) => onProgress(clamp(progress));
    abortHandler = () => {
      void conversion?.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    throwIfAborted(signal);
    await conversion.execute();
    throwIfAborted(signal);
    return output.handle;
  } catch (cause) {
    if (signal?.aborted) {
      throw new CameraConversionError(
        "aborted",
        "Camera MP4 conversion was canceled.",
        cause,
      );
    }
    if (cause instanceof CameraConversionError) {
      throw cause;
    }
    throw new CameraConversionError(
      "failed",
      `Mediabunny could not convert ${sourceHandle.name} to MP4.`,
      cause,
    );
  } finally {
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
    }
    input.dispose();
    if (conversion?.state !== "done") {
      await conversion?.cancel().catch(() => undefined);
      await closeAfterFailure(
        output.writable,
        "Mediabunny conversion did not finish.",
      );
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

const loadFfmpeg = async (
  signal: AbortSignal | undefined,
): Promise<FfmpegClient> => {
  throwIfAborted(signal);
  let ffmpegModule: typeof import("@ffmpeg/ffmpeg");
  try {
    ffmpegModule = await import("@ffmpeg/ffmpeg");
  } catch (cause) {
    throw new CameraConversionError(
      "failed",
      "The browser fallback encoder could not be loaded.",
      cause,
    );
  }
  const ffmpeg = new ffmpegModule.FFmpeg() as unknown as FfmpegClient;
  try {
    await ffmpeg.load(bundledFfmpegCoreUrls(), { signal });
    return ffmpeg;
  } catch (cause) {
    ffmpeg.terminate();
    if (signal?.aborted) {
      throw new CameraConversionError(
        "aborted",
        "Camera MP4 conversion was canceled.",
        cause,
      );
    }
    throw new CameraConversionError(
      "failed",
      "The browser fallback encoder could not start.",
      cause,
    );
  }
};

const convertWithFfmpeg = async (
  ffmpeg: FfmpegClient,
  sourceHandle: FileSystemFileHandle,
  directory: FileSystemDirectoryHandle,
  filename: string,
  hasAudio: boolean,
  signal: AbortSignal | undefined,
  onProgress: (progress: number) => void,
): Promise<FileSystemFileHandle> => {
  throwIfAborted(signal);
  const sourceFile = await sourceHandle.getFile();
  const sourceBytes = new Uint8Array(await sourceFile.arrayBuffer());
  const inputPath = "/camera-input.webm";
  const outputPath = "/camera-output.mp4";
  await ffmpeg.writeFile(inputPath, sourceBytes, { signal });
  const progressHandler = (event: { progress: number; time: number }): void =>
    onProgress(clamp(event.progress));
  ffmpeg.on("progress", progressHandler);
  try {
    const args = [
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      ...(hasAudio ? ["-map", "0:a:0?", "-c:a", "aac"] : ["-an"]),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ];
    const exitCode = await ffmpeg.exec(args, -1, { signal });
    if (signal?.aborted) {
      throw new CameraConversionError(
        "aborted",
        "Camera MP4 conversion was canceled.",
      );
    }
    if (exitCode !== 0) {
      throw new CameraConversionError(
        "failed",
        `FFmpeg exited with code ${exitCode} while converting ${sourceHandle.name}.`,
      );
    }
    const output = await ffmpeg.readFile(outputPath, "binary", { signal });
    if (typeof output === "string" || output.byteLength === 0) {
      throw new CameraConversionError(
        "failed",
        `FFmpeg returned an empty MP4 for ${sourceHandle.name}.`,
      );
    }
    return writeBlobToFile(directory, filename, output, signal);
  } catch (cause) {
    if (
      signal?.aborted ||
      (cause instanceof CameraConversionError && cause.code === "aborted")
    ) {
      throw new CameraConversionError(
        "aborted",
        "Camera MP4 conversion was canceled.",
        cause,
      );
    }
    if (cause instanceof CameraConversionError) {
      throw cause;
    }
    throw new CameraConversionError(
      "failed",
      `FFmpeg could not convert ${sourceHandle.name} to MP4.`,
      cause,
    );
  } finally {
    ffmpeg.off("progress", progressHandler);
    await ffmpeg.deleteFile(inputPath).catch(() => undefined);
    await ffmpeg.deleteFile(outputPath).catch(() => undefined);
  }
};

export async function convertCameraTakeToMp4(
  take: CameraTake,
  options: CameraConversionOptions,
): Promise<CameraTake> {
  if (!take?.processedFile || !take.cleanFile || !options?.directory) {
    throw new CameraConversionError(
      "invalid-input",
      "A camera take and destination folder are required for MP4 conversion.",
    );
  }
  if (take.mimeType.startsWith("video/mp4")) {
    return take;
  }
  if (!take.mimeType.startsWith("video/webm")) {
    throw new CameraConversionError(
      "unsupported",
      `Cannot convert ${take.mimeType || "this recording"} to MP4.`,
    );
  }
  throwIfAborted(options.signal);

  const base = sanitizeBasename(options.basename ?? take.basename);
  const stamp = new Date();
  const targets = [
    { role: "effected" as const, source: take.processedFile },
    { role: "clean" as const, source: take.cleanFile },
  ];
  let mediabunny: MediabunnyModule | undefined;
  try {
    mediabunny = await import("mediabunny");
  } catch {
    mediabunny = undefined;
  }

  let ffmpegPromise: Promise<FfmpegClient> | undefined;
  const getFfmpeg = (): Promise<FfmpegClient> => {
    ffmpegPromise ??= loadFfmpeg(options.signal);
    return ffmpegPromise;
  };
  const converted: FileSystemFileHandle[] = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      throwIfAborted(options.signal);
      const filename = outputFilename(base, target.role, stamp);
      const reportProgress = (innerProgress: number): void => {
        options.onProgress?.(
          clamp((index + clamp(innerProgress)) / targets.length),
        );
      };
      let output: FileSystemFileHandle | undefined;
      if (mediabunny) {
        try {
          output = await convertWithMediabunny(
            mediabunny,
            target.source,
            options.directory,
            filename,
            options.signal,
            reportProgress,
          );
        } catch (cause) {
          if (
            cause instanceof CameraConversionError &&
            cause.code === "aborted"
          ) {
            throw cause;
          }
        }
      }
      if (!output) {
        const ffmpeg = await getFfmpeg();
        output = await convertWithFfmpeg(
          ffmpeg,
          target.source,
          options.directory,
          filename,
          take.hasAudio,
          options.signal,
          reportProgress,
        );
      }
      converted.push(output);
      reportProgress(1);
    }
    options.onProgress?.(1);
    return {
      ...take,
      processedFile: converted[0],
      cleanFile: converted[1],
      mimeType: "video/mp4",
    };
  } catch (cause) {
    if (cause instanceof CameraConversionError) {
      throw cause;
    }
    if (options.signal?.aborted) {
      throw new CameraConversionError(
        "aborted",
        "Camera MP4 conversion was canceled.",
        cause,
      );
    }
    throw new CameraConversionError(
      "failed",
      "Camera MP4 conversion failed; the original WebM take is still available.",
      cause,
    );
  } finally {
    if (ffmpegPromise) {
      const ffmpeg = await ffmpegPromise.catch(() => undefined);
      ffmpeg?.terminate();
    }
  }
}
