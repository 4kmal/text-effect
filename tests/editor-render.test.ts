import { describe, expect, test } from "bun:test";

import { createPreset } from "../components/editor/core/model";
import { renderFrame } from "../components/editor/core/render";

type DrawCall = ["clear" | "rect" | "text", string?, string?];

class RecordingContext {
  fillStyle = "#000000";
  globalAlpha = 1;
  font = "";
  textAlign = "left";
  textBaseline = "alphabetic";
  calls: DrawCall[] = [];
  private stack: Array<{ fillStyle: string; globalAlpha: number }> = [];

  save() {
    this.stack.push({
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
    });
  }

  restore() {
    Object.assign(this, this.stack.pop());
  }

  setTransform() {}
  scale() {}
  translate() {}
  rotate() {}
  clearRect() {
    this.calls.push(["clear"]);
  }
  fillRect() {
    this.calls.push(["rect", this.fillStyle]);
  }
  measureText(text: string) {
    return { width: text.length * 10 };
  }
  fillText(text: string) {
    this.calls.push(["text", text, this.fillStyle]);
  }
}

function recordingCanvas() {
  const context = new RecordingContext();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

describe("Text FX frame renderer", () => {
  test("draws visible layers in project order", () => {
    const project = createPreset("wave");
    project.background.kind = "solid";
    const first = {
      ...project.layers[0],
      id: "first",
      text: "A",
      color: "#ff0000",
      keyframes: [],
    };
    const second = { ...first, id: "second", text: "B", color: "#0000ff" };
    project.layers = [first, second];
    const { canvas, context } = recordingCanvas();

    renderFrame(project, 500, canvas);
    expect(context.calls.filter((call) => call[0] === "text")).toEqual([
      ["text", "A", "#ff0000"],
      ["text", "B", "#0000ff"],
    ]);

    context.calls = [];
    project.layers.reverse();
    renderFrame(project, 500, canvas);
    expect(
      context.calls.filter((call) => call[0] === "text").map((call) => call[1]),
    ).toEqual(["B", "A"]);
  });

  test("repeats the same seeded scramble frame at the same time", () => {
    const project = createPreset("scramble");
    project.layers[0].keyframes = [];
    const { canvas, context } = recordingCanvas();
    renderFrame(project, 700, canvas);
    const first = structuredClone(context.calls);
    context.calls = [];
    renderFrame(project, 700, canvas);
    expect(context.calls).toEqual(first);
  });

  test("keeps transparent frames clear unless a matte is requested", () => {
    const project = createPreset("wave");
    project.layers = [];
    const { canvas, context } = recordingCanvas();
    renderFrame(project, 0, canvas);
    expect(context.calls).toEqual([["clear"]]);

    context.calls = [];
    renderFrame(project, 0, canvas, { matteColor: "#00ff00" });
    expect(context.calls).toEqual([["clear"], ["rect", "#00ff00"]]);
  });
});
