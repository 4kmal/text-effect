import { expect, test } from "bun:test";

import {
  CameraConversionError,
  convertCameraTakeToMp4,
} from "../components/camera/core/conversion";

const fileHandle = (name: string): FileSystemFileHandle =>
  ({
    kind: "file",
    name,
    getFile: async () => new File([], name),
  }) as unknown as FileSystemFileHandle;

const take = (mimeType: string) => ({
  processedFile: fileHandle("effected.webm"),
  cleanFile: fileHandle("clean.webm"),
  mimeType,
  durationMs: 1_000,
  hasAudio: true,
  partial: false,
  basename: "demo",
});

test("leaves an MP4 take untouched when conversion is requested twice", async () => {
  const original = take("video/mp4");
  const converted = await convertCameraTakeToMp4(original, {
    directory: {} as FileSystemDirectoryHandle,
  });
  expect(converted).toBe(original);
});

test("cancels before loading an encoder and leaves WebM sources available", async () => {
  const controller = new AbortController();
  controller.abort();
  const original = take("video/webm;codecs=vp9,opus");
  const error = await convertCameraTakeToMp4(original, {
    directory: {} as FileSystemDirectoryHandle,
    signal: controller.signal,
  }).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(CameraConversionError);
  expect((error as CameraConversionError).code).toBe("aborted");
  expect(original.processedFile.name).toBe("effected.webm");
  expect(original.cleanFile.name).toBe("clean.webm");
});

test("rejects unsupported source containers without touching the folder", async () => {
  const directory = {
    getFileHandle: async () => {
      throw new Error("should not be called");
    },
  };
  const error = await convertCameraTakeToMp4(take("video/ogg"), {
    directory: directory as unknown as FileSystemDirectoryHandle,
  }).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(CameraConversionError);
  expect((error as CameraConversionError).code).toBe("unsupported");
});
