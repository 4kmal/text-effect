import { describe, expect, test } from "bun:test";

import {
  CAMERA_EFFECTS,
  CAMERA_PRESETS,
  LUT_LOOKS,
  createCameraEffect,
  createCameraPreset,
  parseCameraProject,
} from "../components/camera/core/model";

describe("Camera FX project model", () => {
  test("exposes the complete preset and effect catalog", () => {
    expect(CAMERA_PRESETS.map((preset) => preset.id)).toEqual([
      "clean",
      "ascii",
      "flir",
      "heat",
      "depth",
      "rgb-signal",
    ]);
    expect(CAMERA_EFFECTS.map((effect) => effect.kind)).toHaveLength(5);
    expect(LUT_LOOKS.map((look) => look.id)).toEqual([
      "neutral",
      "amber-crt",
      "teal-orange",
      "bleach",
      "cold-mono",
    ]);
  });

  test("creates editable presets without sharing effect state", () => {
    const original = createCameraPreset("ascii");
    const copy = createCameraPreset("ascii");
    expect(original.width).toBe(1920);
    expect(original.height).toBe(1080);
    expect(original.fps).toBe(30);
    expect(original.effects[0]?.kind).toBe("ascii");

    original.effects[0]!.params.cellSize = 64;
    expect(copy.effects[0]!.params.cellSize).not.toBe(64);
    expect(createCameraPreset("clean").effects).toEqual([]);
  });

  test("round trips the ordered stack, mirror, and microphone settings", () => {
    const project = createCameraPreset("rgb-signal");
    project.width = 1280;
    project.height = 720;
    project.mirror = false;
    project.micEnabled = false;
    project.effects = [
      createCameraEffect("ascii"),
      createCameraEffect("rgb-signal"),
    ];
    project.effects[0]!.enabled = false;
    const imported = parseCameraProject(JSON.stringify(project));

    expect(imported).toEqual(project);
    expect(imported.effects.map((effect) => effect.kind)).toEqual([
      "ascii",
      "rgb-signal",
    ]);
    expect(imported.mirror).toBe(false);
    expect(imported.micEnabled).toBe(false);
  });

  test("clamps imported effect parameters while preserving stack order", () => {
    const project = createCameraPreset("depth");
    const input = JSON.parse(JSON.stringify(project)) as Record<
      string,
      unknown
    >;
    input.lookStrength = 4;
    const effects = input.effects as Array<Record<string, unknown>>;
    effects[0]!.strength = 10;
    effects[0]!.params = {
      cellSize: -10,
      contrast: 99,
      threshold: -1,
      scanline: 2,
      edge: 0.25,
      channelOffset: 999,
      noise: -2,
      posterize: 3.8,
    };
    const parsed = parseCameraProject(input);
    expect(parsed.lookStrength).toBe(1);
    expect(parsed.effects[0]).toMatchObject({
      strength: 1,
      params: {
        cellSize: 2,
        contrast: 3,
        threshold: 0,
        scanline: 1,
        edge: 0.25,
        channelOffset: 48,
        noise: 0,
        posterize: 4,
      },
    });
    expect(parsed.effects[0]!.kind).toBe("depth");
  });

  test("rejects invalid versions, dimensions, and overfull stacks", () => {
    const project = createCameraPreset("clean");
    expect(() => parseCameraProject({ ...project, version: 2 })).toThrow(
      /version/,
    );
    expect(() => parseCameraProject({ ...project, width: 1000 })).toThrow(
      /16:9/,
    );
    expect(() =>
      parseCameraProject({
        ...project,
        effects: [
          createCameraEffect("ascii"),
          createCameraEffect("flir"),
          createCameraEffect("heat"),
          createCameraEffect("depth"),
          createCameraEffect("rgb-signal"),
        ],
      }),
    ).toThrow(/four/);
  });

  test("does not retain device or media fields from imported objects", () => {
    const project = createCameraPreset("clean") as unknown as Record<
      string,
      unknown
    >;
    project.deviceId = "camera-secret";
    project.video = new Blob(["not media"]);
    const parsed = parseCameraProject(project);
    expect(parsed).not.toHaveProperty("deviceId");
    expect(parsed).not.toHaveProperty("video");
  });
});
