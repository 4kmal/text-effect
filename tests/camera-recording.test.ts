import { afterEach, describe, expect, test } from "bun:test";

import {
  selectRecordingMime,
  startCameraRecording,
} from "../components/camera/core/recording";

type FakeWrite = { value: string; position?: number };

class FakeTrack extends EventTarget {
  readonly kind: "audio" | "video";
  readyState: MediaStreamTrackState = "live";
  enabled = true;
  stopped = false;

  constructor(kind: "audio" | "video") {
    super();
    this.kind = kind;
  }

  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}

  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakeCanvas {
  readonly streams: FakeStream[] = [];

  captureStream(): FakeStream {
    const stream = new FakeStream([new FakeTrack("video")]);
    this.streams.push(stream);
    return stream;
  }
}

class FakeWritable {
  readonly writes: FakeWrite[] = [];
  closed = false;
  aborted = false;
  private writeCount = 0;

  constructor(private readonly failAt?: number) {}

  async write(value: Blob | FileSystemWriteChunkType): Promise<void> {
    this.writeCount += 1;
    if (this.failAt === this.writeCount) {
      throw new Error("simulated disk failure");
    }
    const blob = value instanceof Blob ? value : (value as WriteParams).data;
    const data = blob instanceof Blob ? await blob.text() : String(blob ?? "");
    const position =
      typeof value === "object" && "position" in value
        ? (value.position ?? undefined)
        : undefined;
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.writes.push({ value: data, position });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

class FakeFileHandle {
  readonly kind = "file" as const;
  readonly files: FakeWritable[] = [];

  constructor(
    readonly name: string,
    private readonly failAt?: number,
  ) {}

  async createWritable(): Promise<FakeWritable> {
    const writable = new FakeWritable(this.failAt);
    this.files.push(writable);
    return writable;
  }

  async getFile(): Promise<File> {
    return new File([], this.name, { type: "video/webm" });
  }
}

class FakeDirectory {
  readonly handles = new Map<string, FakeFileHandle>();

  constructor(private readonly failAt?: number) {}

  async getFileHandle(name: string): Promise<FakeFileHandle> {
    const handle = new FakeFileHandle(name, this.failAt);
    this.handles.set(name, handle);
    return handle;
  }
}

type RecorderChunk = { label: string; data: Blob };

class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static supported = new Set<string>();
  static rejected = new Set<string>();
  static isTypeSupported(mimeType: string): boolean {
    return FakeRecorder.supported.has(mimeType);
  }

  readonly mimeType: string;
  state: RecordingState = "inactive";
  startInterval: number | undefined;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly chunks: RecorderChunk[] = [];

  constructor(_stream: FakeStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "video/webm";
    if (FakeRecorder.rejected.has(this.mimeType)) {
      throw new Error(`constructor rejected ${this.mimeType}`);
    }
    FakeRecorder.instances.push(this);
  }

  start(interval?: number): void {
    this.startInterval = interval;
    this.state = "recording";
  }

  emitChunk(label: string): void {
    const data = new Blob([label], { type: this.mimeType });
    this.chunks.push({ label, data });
    this.ondataavailable?.({ data } as BlobEvent);
  }

  stop(): void {
    if (this.state === "inactive") {
      return;
    }
    this.emitChunk("final");
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

const originalGlobals = {
  MediaRecorder: globalThis.MediaRecorder,
  window: (globalThis as typeof globalThis & { window?: unknown }).window,
  document: (globalThis as typeof globalThis & { document?: unknown }).document,
};

const installFakeBrowser = (): void => {
  FakeRecorder.instances = [];
  FakeRecorder.rejected = new Set();
  FakeRecorder.supported = new Set([
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E01E"',
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp9"',
  ]);
  Object.assign(globalThis, {
    MediaRecorder: FakeRecorder,
    window: globalThis,
    document: {},
  });
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

describe("camera recording MIME selection", () => {
  test("prefers H.264/AAC MP4 when the browser supports it", () => {
    installFakeBrowser();
    expect(selectRecordingMime(true)).toEqual({
      mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      extension: "mp4",
    });
  });

  test("falls back to VP9/Opus WebM when MP4 is unavailable", () => {
    installFakeBrowser();
    FakeRecorder.supported = new Set(['video/webm;codecs="vp9,opus"']);
    expect(selectRecordingMime(true)).toEqual({
      mimeType: 'video/webm;codecs="vp9,opus"',
      extension: "webm",
    });
  });
});

describe("camera recording session", () => {
  test("writes processed and clean chunks in event order and finalizes both files", async () => {
    installFakeBrowser();
    const directory = new FakeDirectory();
    const mic = new FakeTrack("audio");
    const processedCanvas = new FakeCanvas();
    const cleanCanvas = new FakeCanvas();
    const session = await startCameraRecording({
      processedCanvas: processedCanvas as unknown as HTMLCanvasElement,
      cleanCanvas: cleanCanvas as unknown as HTMLCanvasElement,
      micTrack: mic as unknown as MediaStreamTrack,
      directory: directory as unknown as FileSystemDirectoryHandle,
      basename: "demo take",
    });

    expect(session.state).toBe("recording");
    expect(session.hasAudio).toBe(true);
    expect(processedCanvas.streams[0].getAudioTracks()).toHaveLength(1);
    expect(cleanCanvas.streams[0].getAudioTracks()).toHaveLength(1);

    const [processed, clean] = FakeRecorder.instances;
    expect(processed.startInterval).toBe(1_000);
    expect(clean.startInterval).toBe(1_000);
    processed.emitChunk("processed-1");
    processed.emitChunk("processed-2");
    clean.emitChunk("clean-1");
    clean.emitChunk("clean-2");

    const take = await session.stop();
    const processedHandle = directory.handles.get(take.processedFile.name);
    const cleanHandle = directory.handles.get(take.cleanFile.name);
    expect(take.mimeType).toStartWith("video/mp4");
    expect(take.partial).toBe(false);
    expect(take.hasAudio).toBe(true);
    expect(take.durationMs).toBeGreaterThanOrEqual(0);
    expect(
      processedHandle?.files[0].writes.map((write) => write.value),
    ).toEqual(["processed-1", "processed-2", "final"]);
    expect(cleanHandle?.files[0].writes.map((write) => write.value)).toEqual([
      "clean-1",
      "clean-2",
      "final",
    ]);
    expect(processedHandle?.files[0].closed).toBe(true);
    expect(cleanHandle?.files[0].closed).toBe(true);
    expect(session.state).toBe("stopped");
    expect(mic.stopped).toBe(false);
  });

  test("tries the next supported container when a recorder constructor rejects MP4", async () => {
    installFakeBrowser();
    FakeRecorder.rejected = new Set([
      'video/mp4;codecs="avc1.42E01E"',
      'video/mp4;codecs="avc1.4D401F"',
      "video/mp4",
    ]);
    const session = await startCameraRecording({
      processedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      cleanCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      directory: new FakeDirectory() as unknown as FileSystemDirectoryHandle,
      basename: "constructor-fallback",
    });
    expect(session.mimeType).toStartWith("video/webm");
    const take = await session.stop();
    expect(take.processedFile.name).toEndWith(".webm");
    expect(take.cleanFile.name).toEndWith(".webm");
  });

  test("mutes the shared microphone track with track.enabled", async () => {
    installFakeBrowser();
    const mic = new FakeTrack("audio");
    const session = await startCameraRecording({
      processedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      cleanCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      micTrack: mic as unknown as MediaStreamTrack,
      directory: new FakeDirectory() as unknown as FileSystemDirectoryHandle,
      basename: "mute",
    });
    session.setMuted(true);
    expect(session.muted).toBe(true);
    expect(mic.enabled).toBe(false);
    session.setMuted(false);
    expect(session.muted).toBe(false);
    expect(mic.enabled).toBe(true);
    await session.stop();
  });

  test("reports a writer failure, stops both recorders, and returns a partial take", async () => {
    installFakeBrowser();
    const errors: Error[] = [];
    const directory = new FakeDirectory(2);
    const session = await startCameraRecording({
      processedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      cleanCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      directory: directory as unknown as FileSystemDirectoryHandle,
      basename: "disk-error",
      onError: (error) => errors.push(error),
    });
    FakeRecorder.instances[0].emitChunk("first");
    FakeRecorder.instances[0].emitChunk("fails");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const take = await session.stop();
    expect(errors.some((error) => error.message.includes("disk failure"))).toBe(
      true,
    );
    expect(take.partial).toBe(true);
    expect(session.state).toBe("error");
    expect(
      FakeRecorder.instances.every((recorder) => recorder.state === "inactive"),
    ).toBe(true);
  });

  test("treats a camera track ending as a partial device-loss take", async () => {
    installFakeBrowser();
    const errors: Error[] = [];
    const processedCanvas = new FakeCanvas();
    const session = await startCameraRecording({
      processedCanvas: processedCanvas as unknown as HTMLCanvasElement,
      cleanCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      directory: new FakeDirectory() as unknown as FileSystemDirectoryHandle,
      basename: "device-loss",
      onError: (error) => errors.push(error),
    });
    processedCanvas.streams[0]
      .getVideoTracks()[0]
      .dispatchEvent(new Event("ended"));
    const take = await session.stop();
    expect(
      errors.some((error) => error.message.includes("camera preview ended")),
    ).toBe(true);
    expect(take.partial).toBe(true);
  });
});
