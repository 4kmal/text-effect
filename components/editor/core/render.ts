import {
  FONT_FAMILIES,
  type Easing,
  type FrameValues,
  type TextFxProject,
  type TextLayer,
} from "./model";

export type RenderFrameOptions = {
  scale?: number;
  matteColor?: string;
};

const GLYPHS = "!<>/\\{}[]()=+*#@$%?ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ASCII_GLYPHS = " .,:;irsXA253hMHGS#9B&@";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const normalizedTime = (
  timeMs: number,
  startMs: number,
  endMs: number,
): number =>
  clamp(
    (finite(timeMs, startMs) - startMs) / Math.max(1, endMs - startMs),
    0,
    1,
  );

const ease = (progress: number, easing: Easing): number => {
  const t = clamp(progress, 0, 1);
  if (easing === "step") {
    return t < 1 ? 0 : 1;
  }
  if (easing === "easeInOut") {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
  return t;
};

const sanitizeValues = (values: FrameValues): FrameValues => ({
  x: finite(values.x, 0),
  y: finite(values.y, 0),
  scale: finite(values.scale, 1),
  rotation: finite(values.rotation, 0),
  opacity: finite(values.opacity, 1),
  intensity: finite(values.intensity, 0),
});

export function frameValuesAt(layer: TextLayer, timeMs: number): FrameValues {
  const base = sanitizeValues(layer);
  const keyframes = layer.keyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => Number.isFinite(keyframe.timeMs))
    .sort((a, b) => a.keyframe.timeMs - b.keyframe.timeMs || a.index - b.index);

  if (keyframes.length === 0) {
    return base;
  }

  const time = finite(timeMs, 0);
  const first = sanitizeValues(keyframes[0].keyframe);
  const last = sanitizeValues(keyframes[keyframes.length - 1].keyframe);
  if (time <= keyframes[0].keyframe.timeMs) {
    return first;
  }
  if (time >= keyframes[keyframes.length - 1].keyframe.timeMs) {
    return last;
  }

  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index];
    const to = keyframes[index + 1];
    if (time > to.keyframe.timeMs) {
      continue;
    }

    const span = Math.max(1, to.keyframe.timeMs - from.keyframe.timeMs);
    const progress = ease(
      (time - from.keyframe.timeMs) / span,
      from.keyframe.easing,
    );
    const fromValues = sanitizeValues(from.keyframe);
    const toValues = sanitizeValues(to.keyframe);
    return {
      x: fromValues.x + (toValues.x - fromValues.x) * progress,
      y: fromValues.y + (toValues.y - fromValues.y) * progress,
      scale: fromValues.scale + (toValues.scale - fromValues.scale) * progress,
      rotation:
        fromValues.rotation +
        (toValues.rotation - fromValues.rotation) * progress,
      opacity:
        fromValues.opacity + (toValues.opacity - fromValues.opacity) * progress,
      intensity:
        fromValues.intensity +
        (toValues.intensity - fromValues.intensity) * progress,
    };
  }

  return last;
}

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const noise = (seed: number, ...parts: number[]): number => {
  let value = (seed >>> 0) ^ 0x9e3779b9;
  for (const part of parts) {
    value ^= Math.floor(finite(part, 0) * 1000) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 2246822519);
    value = Math.imul(value ^ (value >>> 13), 3266489917);
  }
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
};

const colorWithAlpha = (color: string, alpha: number): string => {
  const value = clamp(alpha, 0, 1);
  if (value >= 0.999) {
    return color;
  }
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const channels = hex
      .split("")
      .map((channel) => parseInt(channel + channel, 16));
    return `rgba(${channels[0]},${channels[1]},${channels[2]},${value})`;
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const channels = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map(
      (channel) => parseInt(channel, 16),
    );
    return `rgba(${channels[0]},${channels[1]},${channels[2]},${value})`;
  }
  return color;
};

const setFont = (context: CanvasRenderingContext2D, layer: TextLayer): void => {
  const fontSize = Math.max(1, finite(layer.fontSize, 48));
  context.font = `${fontSize}px ${FONT_FAMILIES[layer.font]}`;
  context.textAlign = layer.align;
  context.textBaseline = "middle";
};

const drawLines = (
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  lineHeight: number,
): void => {
  const lines = text.split("\n");
  const top = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) =>
    context.fillText(line, x, top + index * lineHeight),
  );
};

const drawPlainText = (
  context: CanvasRenderingContext2D,
  layer: TextLayer,
  text: string,
  x: number,
  y: number,
): void => {
  setFont(context, layer);
  drawLines(context, text, x, y, Math.max(1, layer.fontSize * 1.15));
};

const drawScramble = (
  context: CanvasRenderingContext2D,
  layer: TextLayer,
  values: FrameValues,
  progress: number,
  projectSeed: number,
): void => {
  setFont(context, layer);
  const intensity = clamp(Math.abs(values.intensity), 0, 1);
  const reveal = clamp(progress * (1.35 + intensity * 0.65), 0, 1);
  const characters = Array.from(layer.text);
  const widths = characters.map(
    (character) => context.measureText(character).width,
  );
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  let cursor =
    layer.align === "center"
      ? -totalWidth / 2
      : layer.align === "right"
        ? -totalWidth
        : 0;

  characters.forEach((character, index) => {
    if (character === "\n") {
      cursor = 0;
      return;
    }
    const threshold = index / Math.max(1, characters.length - 1);
    const settled = threshold <= reveal;
    const glyphIndex = Math.floor(
      noise(
        projectSeed,
        hashString(layer.id),
        index,
        Math.floor(progress * 60),
      ) * GLYPHS.length,
    );
    context.fillText(settled ? character : GLYPHS[glyphIndex], cursor, 0);
    cursor += widths[index];
  });
};

const drawTypewriter = (
  context: CanvasRenderingContext2D,
  layer: TextLayer,
  values: FrameValues,
  progress: number,
): void => {
  setFont(context, layer);
  const characters = Array.from(layer.text);
  const count = Math.floor(
    characters.length *
      clamp(progress * (1.15 + values.intensity * 0.35), 0, 1),
  );
  const visible = characters.slice(0, count).join("");
  drawLines(context, visible, 0, 0, Math.max(1, layer.fontSize * 1.15));
  if (progress < 0.99) {
    const cursorWidth = Math.max(2, layer.fontSize * 0.055);
    const cursorX = context.measureText(visible).width / 2 + cursorWidth;
    context.fillRect(
      cursorX,
      -layer.fontSize * 0.45,
      cursorWidth,
      layer.fontSize * 0.9,
    );
  }
};

type Raster = {
  width: number;
  height: number;
  cellSize: number;
  values: number[];
};

const createRasterCanvas = (
  source: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas | null => {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const ownerDocument = source.ownerDocument;
  if (ownerDocument) {
    const rasterCanvas = ownerDocument.createElement("canvas");
    rasterCanvas.width = width;
    rasterCanvas.height = height;
    return rasterCanvas;
  }

  const CanvasConstructor = source.constructor as unknown as new (
    width: number,
    height: number,
  ) => HTMLCanvasElement;
  try {
    const rasterCanvas = new CanvasConstructor(width, height);
    if (typeof rasterCanvas.getContext === "function") {
      return rasterCanvas;
    }
  } catch {
    return null;
  }
  return null;
};

const rasterizeText = (
  source: HTMLCanvasElement,
  layer: TextLayer,
  context: CanvasRenderingContext2D,
): Raster | null => {
  const padding = Math.ceil(layer.fontSize * 0.4);
  setFont(context, layer);
  const lines = layer.text.split("\n");
  const lineHeight = Math.max(1, layer.fontSize * 1.15);
  const textWidth = Math.max(
    1,
    ...lines.map((line) => context.measureText(line).width),
  );
  const textHeight = Math.max(1, lineHeight * lines.length);
  const width = Math.ceil(textWidth + padding * 2);
  const height = Math.ceil(textHeight + padding * 2);
  const cellSize = Math.max(3, Math.round(layer.fontSize / 7));
  const rasterCanvas = createRasterCanvas(source, width, height);
  if (!rasterCanvas) {
    return null;
  }
  const rasterContext = rasterCanvas.getContext("2d");
  if (!rasterContext) {
    return null;
  }
  rasterContext.clearRect(0, 0, width, height);
  rasterContext.fillStyle = "#fff";
  rasterContext.font = context.font;
  rasterContext.textAlign = "left";
  rasterContext.textBaseline = "middle";
  lines.forEach((line, index) => {
    rasterContext.fillText(
      line,
      padding,
      padding + index * lineHeight + lineHeight / 2,
    );
  });
  let imageData: ImageData;
  try {
    imageData = rasterContext.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
  const columns = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const values = new Array<number>(columns * rows).fill(0);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let alpha = 0;
      let samples = 0;
      const yStart = row * cellSize;
      const xStart = column * cellSize;
      for (let y = yStart; y < Math.min(height, yStart + cellSize); y += 1) {
        for (let x = xStart; x < Math.min(width, xStart + cellSize); x += 1) {
          alpha += imageData.data[(y * width + x) * 4 + 3];
          samples += 1;
        }
      }
      values[row * columns + column] =
        samples > 0 ? alpha / (samples * 255) : 0;
    }
  }
  return { width: columns, height: rows, cellSize, values };
};

const drawAscii = (
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  layer: TextLayer,
  values: FrameValues,
  elapsedMs: number,
  projectSeed: number,
): void => {
  const raster = rasterizeText(source, layer, context);
  if (!raster) {
    drawPlainText(context, layer, layer.text, 0, 0);
    return;
  }
  const intensity = clamp(Math.abs(values.intensity), 0, 1);
  const spacing = raster.cellSize * 0.92;
  const width = (raster.width - 1) * spacing;
  const height = (raster.height - 1) * spacing;
  const xOffset =
    layer.align === "center"
      ? -width / 2
      : layer.align === "right"
        ? -width
        : 0;
  const yOffset = -height / 2;
  const fontSize = Math.max(8, raster.cellSize * 1.16);
  const baseAlpha = context.globalAlpha;
  const timeBucket = Math.floor(Math.max(0, elapsedMs) / 80);
  context.font = `${fontSize}px ${FONT_FAMILIES[layer.font]}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let row = 0; row < raster.height; row += 1) {
    for (let column = 0; column < raster.width; column += 1) {
      const alpha = raster.values[row * raster.width + column];
      if (alpha < 0.08) {
        continue;
      }
      const flicker = noise(
        projectSeed,
        hashString(layer.id),
        row,
        column,
        timeBucket,
        Math.floor(values.intensity * 80),
      );
      const baseGlyphIndex = Math.min(
        ASCII_GLYPHS.length - 1,
        Math.floor(
          clamp(alpha * (0.72 + intensity * 0.45) + flicker * 0.12, 0, 1) *
            ASCII_GLYPHS.length,
        ),
      );
      const glyphIndex = Math.max(
        0,
        baseGlyphIndex - Math.floor(flicker * (1 + intensity * 2)),
      );
      context.globalAlpha =
        baseAlpha * clamp(0.35 + alpha * (0.58 + flicker * 0.16), 0, 1);
      context.fillText(
        ASCII_GLYPHS[glyphIndex],
        xOffset + column * spacing,
        yOffset + row * spacing,
      );
    }
  }
  context.globalAlpha = baseAlpha;
};

const drawLed = (
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  layer: TextLayer,
  values: FrameValues,
  elapsedMs: number,
  projectSeed: number,
): void => {
  const raster = rasterizeText(source, layer, context);
  if (!raster) {
    drawPlainText(context, layer, layer.text, 0, 0);
    return;
  }
  const spacing = raster.cellSize * 0.96;
  const width = raster.width * spacing;
  const height = raster.height * spacing;
  const scroll =
    ((elapsedMs / 1000) * (90 + Math.abs(values.intensity) * 130)) %
    Math.max(1, width + 220);
  const xStart = -width / 2 - scroll + 100;
  const yStart = -height / 2;
  const radius = Math.max(1, raster.cellSize * 0.18);
  const baseAlpha = context.globalAlpha;
  context.fillStyle = layer.color;
  for (let row = 0; row < raster.height; row += 1) {
    for (let column = -2; column < raster.width + 4; column += 1) {
      const sourceColumn =
        ((column % raster.width) + raster.width) % raster.width;
      const alpha = raster.values[row * raster.width + sourceColumn];
      const x = xStart + column * spacing;
      const y = yStart + row * spacing;
      const ambient =
        0.08 +
        noise(projectSeed, row, column, Math.floor(elapsedMs / 80)) * 0.08;
      context.globalAlpha =
        baseAlpha * (alpha > 0.08 ? 0.36 + alpha * 0.64 : ambient);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.globalAlpha = baseAlpha;
};

const drawWave = (
  context: CanvasRenderingContext2D,
  layer: TextLayer,
  values: FrameValues,
  elapsedMs: number,
): void => {
  setFont(context, layer);
  const characters = Array.from(layer.text);
  const widths = characters.map(
    (character) => context.measureText(character).width,
  );
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  let cursor =
    layer.align === "center"
      ? -totalWidth / 2
      : layer.align === "right"
        ? -totalWidth
        : 0;
  const amplitude =
    layer.fontSize * (0.12 + clamp(Math.abs(values.intensity), 0, 1) * 0.42);
  const frequency = 0.007 + clamp(Math.abs(values.intensity), 0, 1) * 0.005;
  const phase =
    elapsedMs * (0.004 + clamp(Math.abs(values.intensity), 0, 1) * 0.004);
  characters.forEach((character, index) => {
    const x = cursor + widths[index] / 2;
    const y = Math.sin(phase + index * frequency * 150) * amplitude;
    context.save();
    context.translate(x, y);
    context.rotate(Math.sin(phase + index * 0.65) * 0.08 * values.intensity);
    context.fillText(character, 0, 0);
    context.restore();
    cursor += widths[index];
  });
};

const drawGlitch = (
  context: CanvasRenderingContext2D,
  layer: TextLayer,
  values: FrameValues,
  elapsedMs: number,
  projectSeed: number,
): void => {
  setFont(context, layer);
  const intensity = clamp(Math.abs(values.intensity), 0, 1);
  const frame = Math.floor(elapsedMs / 70);
  const textWidth = context.measureText(layer.text).width;
  const x =
    layer.align === "center" ? 0 : layer.align === "right" ? -textWidth : 0;
  const channelOffset = 2 + intensity * 8;
  const baseAlpha = context.globalAlpha;
  context.save();
  context.globalCompositeOperation = "screen";
  context.fillStyle = "#ff304f";
  context.globalAlpha = baseAlpha * 0.72;
  context.fillText(layer.text, x - channelOffset, 0);
  context.fillStyle = "#32d7ff";
  context.fillText(layer.text, x + channelOffset, 0);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = baseAlpha;
  context.fillStyle = layer.color;
  context.fillText(layer.text, x, 0);
  const bars = Math.max(2, Math.ceil(2 + intensity * 7));
  for (let index = 0; index < bars; index += 1) {
    if (noise(projectSeed, frame, index, hashString(layer.id)) > 0.72) {
      continue;
    }
    const barY =
      (noise(projectSeed, frame, index, 31) - 0.5) * layer.fontSize * 1.45;
    const barHeight =
      1 + noise(projectSeed, frame, index, 47) * layer.fontSize * 0.08;
    const barX = (noise(projectSeed, frame, index, 67) - 0.5) * textWidth;
    const barWidth =
      20 + noise(projectSeed, frame, index, 83) * Math.max(40, textWidth * 0.7);
    context.globalAlpha =
      baseAlpha * (0.2 + noise(projectSeed, frame, index, 101) * 0.55);
    context.fillStyle = index % 2 === 0 ? "#ff304f" : "#32d7ff";
    context.fillRect(barX, barY, barWidth, barHeight);
  }
  context.globalAlpha = baseAlpha;
  context.restore();
};

const drawLayer = (
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  project: TextFxProject,
  layer: TextLayer,
  timeMs: number,
): void => {
  const values = frameValuesAt(layer, timeMs);
  const elapsedMs = timeMs - layer.startMs;
  const progress = normalizedTime(timeMs, layer.startMs, layer.endMs);
  const opacity = clamp(values.opacity, 0, 1);
  if (opacity <= 0 || values.scale === 0) {
    return;
  }
  context.save();
  context.globalAlpha = opacity;
  context.translate(values.x, values.y);
  context.rotate((values.rotation * Math.PI) / 180);
  context.scale(values.scale, values.scale);
  context.fillStyle = layer.color;
  setFont(context, layer);
  switch (layer.effect) {
    case "scramble":
      drawScramble(context, layer, values, progress, project.seed);
      break;
    case "typewriter":
      drawTypewriter(context, layer, values, progress);
      break;
    case "ascii":
      drawAscii(context, source, layer, values, elapsedMs, project.seed);
      break;
    case "led":
      drawLed(context, source, layer, values, elapsedMs, project.seed);
      break;
    case "wave":
      drawWave(context, layer, values, elapsedMs);
      break;
    case "glitch":
      drawGlitch(context, layer, values, elapsedMs, project.seed);
      break;
  }
  context.restore();
};

const renderBackground = (
  context: CanvasRenderingContext2D,
  project: TextFxProject,
  matteColor?: string,
  scale = 1,
): void => {
  const { width, height, background } = project;
  context.save();
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  if (background.kind === "transparent") {
    if (matteColor) {
      context.fillStyle = matteColor;
      context.fillRect(0, 0, width, height);
    }
    context.restore();
    return;
  }
  if (background.kind === "gradient") {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, background.color);
    gradient.addColorStop(1, background.color2);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.restore();
    return;
  }
  context.fillStyle = background.color;
  context.fillRect(0, 0, width, height);
  if (background.kind === "pattern") {
    const patternSize = 28;
    context.strokeStyle = colorWithAlpha(background.color2, 0.35);
    context.lineWidth = 1;
    for (let x = 0; x < width; x += patternSize) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let y = 0; y < height; y += patternSize) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
  }
  context.restore();
};

export function renderFrame(
  project: TextFxProject,
  timeMs: number,
  canvas: HTMLCanvasElement,
  options: RenderFrameOptions = {},
): void {
  if (!canvas) {
    throw new Error("Text FX renderer requires a canvas element");
  }
  const scale = clamp(finite(options.scale ?? 1, 1), 0.01, 8);
  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Text FX renderer could not acquire a 2D canvas context");
  }
  renderBackground(context, project, options.matteColor, scale);
  context.save();
  context.scale(scale, scale);
  const frameTime = clamp(finite(timeMs, 0), 0, project.durationMs);
  project.layers.forEach((layer) => {
    if (
      !layer.visible ||
      frameTime < layer.startMs ||
      frameTime > layer.endMs
    ) {
      return;
    }
    drawLayer(context, canvas, project, layer, frameTime);
  });
  context.restore();
}
