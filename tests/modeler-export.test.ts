import { afterEach, describe, expect, test } from "bun:test";

import {
  exportModel,
  frameCountFor,
  ModelExportError,
  validateModelExportOptions,
} from "../components/modeler/export";

class FakeContext {
  fillStyle = "";
  clearCount = 0;
  drawCount = 0;

  clearRect(): void {
    this.clearCount += 1;
  }

  fillRect(): void {}

  drawImage(): void {
    this.drawCount += 1;
  }
}

class FakeCanvas {
  readonly context = new FakeContext();
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(): FakeContext {
    return this.context;
  }

  toBlob(callback: BlobCallback): void {
    callback(new Blob(["png-frame"], { type: "image/png" }));
  }
}

class FakeWritable {
  readonly chunks: Uint8Array[] = [];
  closed = false;
  aborted = false;

  async write(value: Blob | Uint8Array): Promise<void> {
    const bytes =
      value instanceof Blob
        ? new Uint8Array(await value.arrayBuffer())
        : new Uint8Array(value);
    this.chunks.push(bytes);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

class FakeFile {
  readonly kind = "file" as const;
  readonly writable = new FakeWritable();

  constructor(readonly name: string) {}

  async createWritable(): Promise<FakeWritable> {
    return this.writable;
  }
}

class FakeDirectory {
  readonly files = new Map<string, FakeFile>();

  async getFileHandle(name: string): Promise<FakeFile> {
    const file = new FakeFile(name);
    this.files.set(name, file);
    return file;
  }
}

const originalDocument = (globalThis as typeof globalThis & {
  document?: unknown;
}).document;
const originalWindow = (globalThis as typeof globalThis & {
  window?: unknown;
}).window;

const installFakeBrowser = (width: number, height: number): void => {
  Object.assign(globalThis, {
    window: globalThis,
    document: {
      createElement: () => new FakeCanvas(width, height),
    },
  });
};

afterEach(() => {
  Object.assign(globalThis, {
    document: originalDocument,
    window: originalWindow,
  });
});

describe("model export validation", () => {
  test("plans the full 1080p 60 fps 30 second render without buffering frames", () => {
    expect(frameCountFor(30, 60)).toBe(1800);
    expect(
      validateModelExportOptions({
        format: "webm",
        width: 1920,
        height: 1080,
        fps: 60,
        durationSeconds: 30,
        renderFrame: () => new FakeCanvas(1920, 1080) as unknown as HTMLCanvasElement,
      }).durationSeconds,
    ).toBe(30);
  });

  test("rejects dimensions and durations outside the studio contract", () => {
    expect(() =>
      validateModelExportOptions({
        format: "mp4",
        width: 1920,
        height: 1081,
        fps: 60,
        durationSeconds: 30,
        renderFrame: () => new FakeCanvas(1920, 1081) as unknown as HTMLCanvasElement,
      }),
    ).toThrow(ModelExportError);
    expect(() =>
      validateModelExportOptions({
        format: "mp4",
        width: 1920,
        height: 1080,
        fps: 60,
        durationSeconds: 30.1,
        renderFrame: () => new FakeCanvas(1920, 1080) as unknown as HTMLCanvasElement,
      }),
    ).toThrow(ModelExportError);
  });
});

describe("model PNG sequence export", () => {
  test("writes each frame directly to the chosen folder", async () => {
    installFakeBrowser(320, 180);
    const directory = new FakeDirectory();
    const alphaValues: boolean[] = [];
    const progress: number[] = [];
    const result = await exportModel({
      format: "png-sequence",
      width: 320,
      height: 180,
      fps: 10,
      durationSeconds: 0.3,
      destination: { directory: directory as unknown as FileSystemDirectoryHandle },
      renderFrame: (_time, _width, _height, alpha) => {
        alphaValues.push(alpha);
        return new FakeCanvas(320, 180) as unknown as HTMLCanvasElement;
      },
      onProgress: (value) => progress.push(value),
    });

    expect(result.frameCount).toBe(3);
    expect(directory.files.size).toBe(3);
    expect(Array.from(directory.files.keys())).toEqual([
      "vitruvian-spin-0001.png",
      "vitruvian-spin-0002.png",
      "vitruvian-spin-0003.png",
    ]);
    expect(alphaValues).toEqual([true, true, true]);
    expect(progress.at(-1)).toBe(1);
    expect(directory.files.get("vitruvian-spin-0001.png")?.writable.closed).toBe(
      true,
    );
  });

  test("stops between frames and leaves already-written files usable", async () => {
    installFakeBrowser(320, 180);
    const directory = new FakeDirectory();
    const controller = new AbortController();
    let renderedFrames = 0;

    await expect(
      exportModel({
        format: "png-sequence",
        width: 320,
        height: 180,
        fps: 10,
        durationSeconds: 0.5,
        destination: { directory: directory as unknown as FileSystemDirectoryHandle },
        signal: controller.signal,
        renderFrame: () => {
          renderedFrames += 1;
          if (renderedFrames === 2) {
            controller.abort();
          }
          return new FakeCanvas(320, 180) as unknown as HTMLCanvasElement;
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });

    expect(renderedFrames).toBe(2);
    expect(directory.files.size).toBe(1);
    expect(directory.files.get("vitruvian-spin-0001.png")?.writable.closed).toBe(
      true,
    );
  });

  test("streams a ZIP archive when a file destination is supplied", async () => {
    installFakeBrowser(160, 90);
    const archive = new FakeFile("turntable.zip");
    const result = await exportModel({
      format: "png-sequence",
      width: 160,
      height: 90,
      fps: 10,
      durationSeconds: 0.2,
      destination: { archive: archive as unknown as FileSystemFileHandle },
      renderFrame: () => new FakeCanvas(160, 90) as unknown as HTMLCanvasElement,
    });

    const bytes = new Uint8Array(
      archive.writable.chunks.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      ),
    );
    let offset = 0;
    for (const chunk of archive.writable.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(result.archive).toBe(archive as unknown as FileSystemFileHandle);
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(bytes.slice(-22, -18)).toEqual(new Uint8Array([0x50, 0x4b, 0x05, 0x06]));
    expect(archive.writable.closed).toBe(true);
  });
});
