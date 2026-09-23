const TARGET_FRAME_RATE = 30;
const CHUNK_DURATION_MS = 1_000;

export type CameraRecordingState =
  "recording" | "stopping" | "stopped" | "error";

export type CameraTake = {
  processedFile: FileSystemFileHandle;
  cleanFile: FileSystemFileHandle;
  mimeType: string;
  durationMs: number;
  hasAudio: boolean;
  partial: boolean;
  basename: string;
};

export type RecordingMime = {
  mimeType: string;
  extension: "mp4" | "webm";
};

export type StartCameraRecordingArgs = {
  processedCanvas: HTMLCanvasElement;
  cleanCanvas: HTMLCanvasElement;
  micTrack?: MediaStreamTrack | null;
  directory: FileSystemDirectoryHandle;
  basename: string;
  onError?: (error: Error) => void;
};

export type RecordingSession = {
  readonly state: CameraRecordingState;
  readonly mimeType: string;
  readonly hasAudio: boolean;
  readonly muted: boolean;
  stop(): Promise<CameraTake>;
  setMuted(muted: boolean): void;
};

export type CameraRecordingErrorCode =
  | "runtime-unavailable"
  | "invalid-input"
  | "folder-unavailable"
  | "mime-unavailable"
  | "start-failed"
  | "write-failed"
  | "device-lost";

export class CameraRecordingError extends Error {
  readonly code: CameraRecordingErrorCode;
  readonly cause?: unknown;

  constructor(
    code: CameraRecordingErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CameraRecordingError";
    this.code = code;
    this.cause = cause;
  }
}

const MP4_WITH_AUDIO = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs="avc1.4D401F,mp4a.40.2"',
  "video/mp4",
] as const;

const MP4_WITHOUT_AUDIO = [
  'video/mp4;codecs="avc1.42E01E"',
  'video/mp4;codecs="avc1.4D401F"',
  "video/mp4",
] as const;

const WEBM_WITH_AUDIO = [
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  "video/webm",
] as const;

const WEBM_WITHOUT_AUDIO = [
  'video/webm;codecs="vp9"',
  'video/webm;codecs="vp8"',
  "video/webm",
] as const;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const toError = (value: unknown, fallback: string): Error => {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === "string" ? value : fallback);
};

const isSupported = (mimeType: string): boolean => {
  try {
    return MediaRecorder.isTypeSupported(mimeType);
  } catch {
    return false;
  }
};

const candidatesFor = (hasAudio: boolean): readonly string[] => [
  ...(hasAudio ? MP4_WITH_AUDIO : MP4_WITHOUT_AUDIO),
  ...(hasAudio ? WEBM_WITH_AUDIO : WEBM_WITHOUT_AUDIO),
];

export function selectRecordingMime(hasAudio: boolean): RecordingMime {
  if (typeof MediaRecorder === "undefined") {
    throw new CameraRecordingError(
      "runtime-unavailable",
      "This browser does not provide MediaRecorder.",
    );
  }

  const mimeType = candidatesFor(hasAudio).find(isSupported);
  if (!mimeType) {
    throw new CameraRecordingError(
      "mime-unavailable",
      "This browser cannot record a supported MP4 or WebM video.",
    );
  }

  return {
    mimeType,
    extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
  };
}

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

let fileSequence = 0;

const randomSuffix = (): string => {
  const random = new Uint32Array(1);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(random);
    return random[0].toString(36).padStart(7, "0");
  }
  fileSequence = (fileSequence + 1) % 36 ** 5;
  return fileSequence.toString(36).padStart(5, "0");
};

const makeFilename = (
  basename: string,
  role: "effected" | "clean",
  extension: RecordingMime["extension"],
  date: Date,
): string =>
  `${sanitizeBasename(basename)}-${timestamp(date)}-${randomSuffix()}-${role}.${extension}`;

type OutputWriter = {
  readonly handle: FileSystemFileHandle;
  readonly hadData: () => boolean;
  enqueue(blob: Blob): void;
  drain(): Promise<void>;
  close(): Promise<void>;
  getError(): Error | undefined;
};

const createOutputWriter = async (
  directory: FileSystemDirectoryHandle,
  filename: string,
  onError: (error: Error) => void,
): Promise<OutputWriter> => {
  let handle: FileSystemFileHandle;
  let writable: FileSystemWritableFileStream;
  try {
    handle = await directory.getFileHandle(filename, { create: true });
    writable = await handle.createWritable();
  } catch (cause) {
    throw new CameraRecordingError(
      "folder-unavailable",
      `Could not create ${filename} in the selected folder.`,
      cause,
    );
  }

  let chain = Promise.resolve();
  let writeError: Error | undefined;
  let closed = false;
  let hadData = false;

  const captureError = (cause: unknown): Error => {
    const error = toError(cause, `Could not write ${filename}.`);
    if (!writeError) {
      writeError = new CameraRecordingError(
        "write-failed",
        error.message,
        error,
      );
      onError(writeError);
    }
    return writeError;
  };

  const outputWriter: OutputWriter = {
    handle,
    hadData: () => hadData,
    enqueue(blob) {
      if (closed || writeError || blob.size === 0) {
        return;
      }
      hadData = true;
      chain = chain
        .then(() => writable.write(blob))
        .catch((cause) => {
          throw captureError(cause);
        });
    },
    async drain() {
      try {
        await chain;
      } catch {
        // The error is exposed through getError and the recording is marked partial.
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await chain;
      } catch {
        // The error is exposed through getError and the recording is marked partial.
      }
      try {
        await writable.close();
      } catch (cause) {
        captureError(cause);
      }
    },
    getError: () => writeError,
  };
  return outputWriter;
};

const stopTracks = (stream: MediaStream): void => {
  stream.getVideoTracks().forEach((track) => track.stop());
};

const waitForRecorderStop = (recorder: MediaRecorder): Promise<void> => {
  if (recorder.state === "inactive") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      recorder.removeEventListener("stop", finish);
      recorder.removeEventListener("error", finish);
      resolve();
    };
    recorder.addEventListener("stop", finish, { once: true });
    recorder.addEventListener("error", finish, { once: true });
    try {
      recorder.stop();
    } catch {
      finish();
    }
  });
};

type RecorderPair = {
  processed: MediaRecorder;
  clean: MediaRecorder;
  mimeType: string;
};

const createRecorderPair = (
  processedStream: MediaStream,
  cleanStream: MediaStream,
  hasAudio: boolean,
): RecorderPair => {
  if (typeof MediaRecorder === "undefined") {
    throw new CameraRecordingError(
      "runtime-unavailable",
      "This browser does not provide MediaRecorder.",
    );
  }

  let lastError: unknown;
  for (const candidate of candidatesFor(hasAudio)) {
    if (!isSupported(candidate)) {
      continue;
    }
    try {
      const processed = new MediaRecorder(processedStream, {
        mimeType: candidate,
      });
      try {
        const clean = new MediaRecorder(cleanStream, { mimeType: candidate });
        return {
          processed,
          clean,
          mimeType: processed.mimeType || candidate,
        };
      } catch (cause) {
        lastError = cause;
      }
    } catch (cause) {
      lastError = cause;
    }
  }

  throw new CameraRecordingError(
    "mime-unavailable",
    "The browser reported no usable recorder for the selected streams.",
    lastError,
  );
};

class CameraRecordingSession implements RecordingSession {
  private stateValue: CameraRecordingState = "recording";
  private mutedValue = false;
  private stopPromise: Promise<CameraTake> | undefined;
  private fatalError: Error | undefined;
  private readonly videoTracks: MediaStreamTrack[] = [];

  constructor(
    private readonly processedRecorder: MediaRecorder,
    private readonly cleanRecorder: MediaRecorder,
    private readonly processedStream: MediaStream,
    private readonly cleanStream: MediaStream,
    private readonly micTrack: MediaStreamTrack | null,
    private readonly processedWriter: OutputWriter,
    private readonly cleanWriter: OutputWriter,
    private readonly takeMetadata: Pick<
      CameraTake,
      "mimeType" | "hasAudio" | "basename"
    >,
    private readonly startedAt: number,
    private readonly onError: ((error: Error) => void) | undefined,
  ) {}

  get state(): CameraRecordingState {
    return this.stateValue;
  }

  get mimeType(): string {
    return this.takeMetadata.mimeType;
  }

  get hasAudio(): boolean {
    return this.takeMetadata.hasAudio;
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  setMuted(muted: boolean): void {
    this.mutedValue = muted;
    if (this.micTrack) {
      this.micTrack.enabled = !muted;
    }
  }

  reportError(error: Error): void {
    if (!this.fatalError) {
      this.fatalError = error;
      this.stateValue = "error";
      try {
        this.onError?.(error);
      } catch {
        // Consumer callbacks must not interrupt recorder finalization.
      }
    }
    if (!this.stopPromise) {
      void this.stop().catch(() => undefined);
    }
  }

  watchVideoTrack(track: MediaStreamTrack): void {
    this.videoTracks.push(track);
    track.addEventListener("ended", this.handleVideoEnded, { once: true });
  }

  async stop(): Promise<CameraTake> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<CameraTake> {
    if (this.stateValue === "recording") {
      this.stateValue = "stopping";
    }

    await Promise.all([
      waitForRecorderStop(this.processedRecorder),
      waitForRecorderStop(this.cleanRecorder),
    ]);
    await Promise.all([this.processedWriter.drain(), this.cleanWriter.drain()]);
    await Promise.all([this.processedWriter.close(), this.cleanWriter.close()]);

    this.videoTracks.forEach((track) =>
      track.removeEventListener("ended", this.handleVideoEnded),
    );
    stopTracks(this.processedStream);
    stopTracks(this.cleanStream);
    this.micTrack?.removeEventListener("ended", this.handleMicEnded);

    const partial = Boolean(
      this.fatalError ||
      this.processedWriter.getError() ||
      this.cleanWriter.getError() ||
      !this.processedWriter.hadData() ||
      !this.cleanWriter.hadData(),
    );
    if (this.stateValue !== "error") {
      this.stateValue = "stopped";
    }
    return {
      ...this.takeMetadata,
      processedFile: this.processedWriter.handle,
      cleanFile: this.cleanWriter.handle,
      durationMs: Math.max(0, Math.round(now() - this.startedAt)),
      partial,
    };
  }

  readonly handleMicEnded = (): void => {
    this.reportError(
      new CameraRecordingError(
        "device-lost",
        "The microphone ended while recording.",
      ),
    );
  };

  readonly handleVideoEnded = (): void => {
    this.reportError(
      new CameraRecordingError(
        "device-lost",
        "The camera preview ended while recording.",
      ),
    );
  };
}

const createStreams = (
  processedCanvas: HTMLCanvasElement,
  cleanCanvas: HTMLCanvasElement,
  micTrack: MediaStreamTrack | null,
): { processed: MediaStream; clean: MediaStream } => {
  if (
    typeof processedCanvas.captureStream !== "function" ||
    typeof cleanCanvas.captureStream !== "function"
  ) {
    throw new CameraRecordingError(
      "runtime-unavailable",
      "This browser cannot capture canvas video.",
    );
  }
  try {
    const processed = processedCanvas.captureStream(TARGET_FRAME_RATE);
    const clean = cleanCanvas.captureStream(TARGET_FRAME_RATE);
    if (micTrack) {
      processed.addTrack(micTrack);
      clean.addTrack(micTrack);
    }
    return { processed, clean };
  } catch (cause) {
    throw new CameraRecordingError(
      "invalid-input",
      "The camera preview canvases could not be captured.",
      cause,
    );
  }
};

export async function startCameraRecording(
  args: StartCameraRecordingArgs,
): Promise<RecordingSession> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new CameraRecordingError(
      "runtime-unavailable",
      "Camera recording must start in a browser.",
    );
  }
  if (!args?.processedCanvas || !args.cleanCanvas || !args.directory) {
    throw new CameraRecordingError(
      "invalid-input",
      "Processed canvas, clean canvas, and a destination folder are required.",
    );
  }

  const requestedMicTrack = args.micTrack ?? null;
  const hasAudio = Boolean(
    requestedMicTrack && requestedMicTrack.readyState !== "ended",
  );
  const micTrack = hasAudio ? requestedMicTrack : null;
  const preferred = selectRecordingMime(hasAudio);
  const streams = createStreams(
    args.processedCanvas,
    args.cleanCanvas,
    micTrack,
  );
  let pair: RecorderPair;
  try {
    pair = createRecorderPair(streams.processed, streams.clean, hasAudio);
  } catch (cause) {
    stopTracks(streams.processed);
    stopTracks(streams.clean);
    throw cause;
  }

  const recordingMime: RecordingMime = {
    mimeType: pair.mimeType || preferred.mimeType,
    extension: (pair.mimeType || preferred.mimeType).startsWith("video/mp4")
      ? "mp4"
      : "webm",
  };
  const stamp = new Date();
  const processedFilename = makeFilename(
    args.basename,
    "effected",
    recordingMime.extension,
    stamp,
  );
  const cleanFilename = makeFilename(
    args.basename,
    "clean",
    recordingMime.extension,
    stamp,
  );

  let processedWriter: OutputWriter;
  let cleanWriter: OutputWriter;
  let writeError: Error | undefined;
  let session: CameraRecordingSession | undefined;
  const reportWriteError = (error: Error): void => {
    writeError ??= error;
    if (session) {
      session.reportError(error);
      return;
    }
    try {
      args.onError?.(error);
    } catch {
      // Consumer callbacks must not interrupt recorder finalization.
    }
  };
  try {
    processedWriter = await createOutputWriter(
      args.directory,
      processedFilename,
      reportWriteError,
    );
    try {
      cleanWriter = await createOutputWriter(
        args.directory,
        cleanFilename,
        reportWriteError,
      );
    } catch (cause) {
      await processedWriter.close();
      stopTracks(streams.processed);
      stopTracks(streams.clean);
      throw cause;
    }
  } catch (cause) {
    stopTracks(streams.processed);
    stopTracks(streams.clean);
    throw cause;
  }

  session = new CameraRecordingSession(
    pair.processed,
    pair.clean,
    streams.processed,
    streams.clean,
    micTrack,
    processedWriter,
    cleanWriter,
    {
      mimeType: recordingMime.mimeType,
      hasAudio,
      basename: sanitizeBasename(args.basename),
    },
    now(),
    args.onError,
  );

  const bindRecorder = (
    recorder: MediaRecorder,
    writer: OutputWriter,
    role: string,
  ): void => {
    recorder.ondataavailable = (event): void => writer.enqueue(event.data);
    recorder.onerror = (event): void => {
      session.reportError(
        new CameraRecordingError(
          "write-failed",
          `${role} recorder failed while recording.`,
          event.error,
        ),
      );
    };
  };
  bindRecorder(pair.processed, processedWriter, "Effected");
  bindRecorder(pair.clean, cleanWriter, "Clean");

  streams.processed
    .getVideoTracks()
    .forEach((track) => session?.watchVideoTrack(track));
  streams.clean
    .getVideoTracks()
    .forEach((track) => session?.watchVideoTrack(track));
  if (micTrack) {
    micTrack.addEventListener("ended", session.handleMicEnded, { once: true });
  }

  try {
    pair.processed.start(CHUNK_DURATION_MS);
    pair.clean.start(CHUNK_DURATION_MS);
  } catch (cause) {
    writeError ??= toError(cause, "The browser could not start recording.");
    await Promise.all([
      waitForRecorderStop(pair.processed),
      waitForRecorderStop(pair.clean),
    ]);
    stopTracks(streams.processed);
    stopTracks(streams.clean);
    await Promise.all([processedWriter.close(), cleanWriter.close()]);
    throw new CameraRecordingError(
      "start-failed",
      "The browser could not start both camera recordings.",
      writeError,
    );
  }

  return session;
}
