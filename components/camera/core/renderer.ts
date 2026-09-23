import {
  CAMERA_ASCII_FONT_FAMILY,
  type CameraEffect,
  type CameraEffectKind,
  type CameraFxProject,
} from "./model";

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uVideo;
uniform sampler2D uGlyphAtlas;
uniform float uGlyphCount;
uniform vec2 uSourceSize;
uniform vec2 uCanvasSize;
uniform float uTime;
uniform float uMirror;
uniform int uLook;
uniform float uLookStrength;
uniform int uEffectKinds[4];
uniform float uEffectStrength[4];
uniform vec4 uEffectParams[4];

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

float hash(vec2 value) {
  return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 sourceUv(vec2 canvasUv) {
  float sourceAspect = uSourceSize.x / max(uSourceSize.y, 1.0);
  float canvasAspect = uCanvasSize.x / max(uCanvasSize.y, 1.0);
  vec2 uv = canvasUv;
  if (sourceAspect > canvasAspect) {
    float visibleWidth = canvasAspect / sourceAspect;
    uv.x = (uv.x - 0.5) * visibleWidth + 0.5;
  } else {
    float visibleHeight = sourceAspect / canvasAspect;
    uv.y = (uv.y - 0.5) * visibleHeight + 0.5;
  }
  if (uMirror > 0.5) {
    uv.x = 1.0 - uv.x;
  }
  return clamp(uv, vec2(0.001), vec2(0.999));
}

vec3 sampleVideo(vec2 canvasUv) {
  return texture(uVideo, sourceUv(canvasUv)).rgb;
}

vec3 applyLook(vec3 color) {
  float value = luminance(color);
  vec3 looked = color;
  if (uLook == 1) {
    vec3 amber = vec3(value * 1.1, value * 0.63, value * 0.22);
    looked = mix(color, amber, 0.86);
  }
  if (uLook == 2) {
    float shadow = smoothstep(0.0, 0.72, value);
    float highlight = smoothstep(0.35, 1.0, value);
    vec3 teal = vec3(value * 0.35, value * 0.78, value * 0.92);
    vec3 orange = vec3(value * 1.14, value * 0.42, value * 0.14);
    looked = mix(mix(teal, orange, highlight), color, 0.14 + shadow * 0.08);
  }
  if (uLook == 3) {
    vec3 bleach = (color - 0.5) * 1.5 + 0.5;
    looked = mix(bleach, vec3(value), 0.28);
  }
  if (uLook == 4) {
    looked = vec3(value * 0.62, value * 0.84, value * 1.12);
  }
  return mix(color, looked, clamp(uLookStrength, 0.0, 1.0));
}

vec3 thermalPalette(float value, bool flir) {
  float t = clamp(value, 0.0, 1.0);
  if (flir) {
    vec3 deep = vec3(0.015, 0.02, 0.12);
    vec3 blue = vec3(0.05, 0.32, 0.8);
    vec3 green = vec3(0.05, 0.8, 0.56);
    vec3 yellow = vec3(1.0, 0.76, 0.08);
    vec3 red = vec3(0.95, 0.12, 0.025);
    if (t < 0.25) return mix(deep, blue, t * 4.0);
    if (t < 0.55) return mix(blue, green, (t - 0.25) / 0.3);
    if (t < 0.78) return mix(green, yellow, (t - 0.55) / 0.23);
    return mix(yellow, red, (t - 0.78) / 0.22);
  }
  vec3 black = vec3(0.005);
  vec3 violet = vec3(0.16, 0.01, 0.42);
  vec3 red = vec3(0.95, 0.035, 0.015);
  vec3 orange = vec3(1.0, 0.35, 0.02);
  vec3 white = vec3(1.0, 0.95, 0.78);
  if (t < 0.2) return mix(black, violet, t * 5.0);
  if (t < 0.48) return mix(violet, red, (t - 0.2) / 0.28);
  if (t < 0.76) return mix(red, orange, (t - 0.48) / 0.28);
  return mix(orange, white, (t - 0.76) / 0.24);
}

vec3 applyAscii(vec2 uv, vec3 base, vec4 params) {
  float columns = max(18.0, uCanvasSize.x / max(params.x, 2.0));
  float rows = max(10.0, uCanvasSize.y / max(params.x * 1.55, 2.0));
  vec2 grid = vec2(columns, rows);
  vec2 cell = floor(uv * grid);
  float value = luminance(sampleVideo((cell + 0.5) / grid));
  value = clamp((value - 0.5) * params.y + 0.5, 0.0, 1.0);
  float flicker = (hash(cell + floor(uTime * 24.0)) - 0.5) * params.z * 0.22;
  value = clamp(value + flicker, 0.0, 1.0);
  float glyphIndex = floor(clamp(value, 0.0, 0.999) * max(uGlyphCount - 1.0, 1.0));
  vec2 glyphUv = vec2(
    (glyphIndex + fract(uv.x * grid.x)) / max(uGlyphCount, 1.0),
    fract(uv.y * grid.y)
  );
  float glyphAlpha = texture(uGlyphAtlas, glyphUv).r;
  float dotGlyph = glyphAlpha * smoothstep(params.z * 0.16, 0.32 + params.z * 0.42, value);
  float line = 1.0 - params.w * 0.16 * step(0.5, fract(uv.y * uCanvasSize.y * 0.5));
  vec3 ink = vec3(1.0, 0.37, 0.07);
  vec3 ascii = mix(vec3(0.008, 0.01, 0.012), ink, dotGlyph * line);
  return mix(base, ascii, 0.82);
}

vec3 applyFlir(vec3 base, vec4 params) {
  float value = clamp((luminance(base) - params.y) * params.x + 0.5, 0.0, 1.0);
  value = floor(value * params.w) / max(params.w, 2.0);
  vec3 thermal = thermalPalette(value, true);
  float line = 1.0 - params.z * 0.12 * step(0.5, fract(vUv.y * uCanvasSize.y * 0.5));
  thermal *= line;
  return mix(base, thermal, 0.9);
}

vec3 applyHeat(vec2 uv, vec3 base, vec4 params) {
  float value = clamp((luminance(base) - params.z) * params.x + 0.5, 0.0, 1.0);
  float glow = luminance(sampleVideo(uv + vec2(0.002, 0.0))) - luminance(sampleVideo(uv - vec2(0.002, 0.0)));
  value = clamp(value + glow * params.y, 0.0, 1.0);
  vec3 thermal = thermalPalette(value, false);
  float line = 1.0 - params.w * 0.16 * step(0.5, fract(vUv.y * uCanvasSize.y * 0.5));
  thermal *= line;
  return mix(base, thermal, 0.94);
}

vec3 applyDepth(vec2 uv, vec3 base, vec4 params) {
  vec2 pixel = 1.0 / max(uCanvasSize, vec2(1.0));
  float center = luminance(sampleVideo(uv));
  float side = luminance(sampleVideo(uv + vec2(pixel.x * 2.0, 0.0)));
  float down = luminance(sampleVideo(uv + vec2(0.0, pixel.y * 2.0)));
  float edge = abs(center - side) + abs(center - down);
  float depth = clamp((center + edge * params.z) * params.y, 0.0, 1.0);
  vec3 depthColor = vec3(depth * 0.23, depth * 0.68, depth * 1.08);
  depthColor += vec3(edge * params.x * 0.8, edge * params.x * 0.22, 0.0);
  float grain = (hash(uv * uCanvasSize + floor(uTime * 20.0)) - 0.5) * params.w * 0.08;
  depthColor += grain;
  return mix(base, clamp(depthColor, 0.0, 1.0), 0.92);
}

vec3 applyRgb(vec2 uv, vec3 base, vec4 params) {
  vec2 shift = vec2(params.x / max(uCanvasSize.x, 1.0), 0.0);
  vec3 split = vec3(
    sampleVideo(uv - shift).r,
    sampleVideo(uv).g,
    sampleVideo(uv + shift).b
  );
  float signal = sin((uv.y * uCanvasSize.y + uTime * 24.0) * 3.14159) * params.y * 0.08;
  float grain = (hash(uv * uCanvasSize + floor(uTime * 30.0)) - 0.5) * params.z;
  split = clamp(split + signal + grain, 0.0, 1.0);
  float scan = 1.0 - params.y * 0.18 * step(0.5, fract(uv.y * uCanvasSize.y * 0.5));
  return mix(base, split * scan, 0.88);
}

vec3 applyEffect(int kind, vec2 uv, vec3 color, vec4 params) {
  if (kind == 1) return applyAscii(uv, color, params);
  if (kind == 2) return applyFlir(color, params);
  if (kind == 3) return applyHeat(uv, color, params);
  if (kind == 4) return applyDepth(uv, color, params);
  if (kind == 5) return applyRgb(uv, color, params);
  return color;
}

void main() {
  vec3 color = sampleVideo(vUv);
  color = applyLook(color);
  for (int index = 0; index < 4; index += 1) {
    int kind = uEffectKinds[index];
    if (kind == 0) continue;
    vec3 effectColor = applyEffect(kind, vUv, color, uEffectParams[index]);
    color = mix(color, effectColor, clamp(uEffectStrength[index], 0.0, 1.0));
  }
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

const EFFECT_CODES: Record<CameraEffectKind, number> = {
  ascii: 1,
  flir: 2,
  heat: 3,
  depth: 4,
  "rgb-signal": 5,
};

type Uniforms = {
  glyphAtlas: WebGLUniformLocation | null;
  glyphCount: WebGLUniformLocation | null;
  sourceSize: WebGLUniformLocation | null;
  canvasSize: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  mirror: WebGLUniformLocation | null;
  look: WebGLUniformLocation | null;
  lookStrength: WebGLUniformLocation | null;
  effectKinds: WebGLUniformLocation | null;
  effectStrength: WebGLUniformLocation | null;
  effectParams: WebGLUniformLocation | null;
};

const compileShader = (
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Camera FX renderer could not create a shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`Camera FX renderer shader compilation failed: ${log}`);
  }
  return shader;
};

const createProgram = (gl: WebGL2RenderingContext): WebGLProgram => {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("Camera FX renderer could not create a shader program");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown program error";
    gl.deleteProgram(program);
    throw new Error(`Camera FX renderer program linking failed: ${log}`);
  }
  return program;
};

const createUniforms = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): Uniforms => ({
  glyphAtlas: gl.getUniformLocation(program, "uGlyphAtlas"),
  glyphCount: gl.getUniformLocation(program, "uGlyphCount"),
  sourceSize: gl.getUniformLocation(program, "uSourceSize"),
  canvasSize: gl.getUniformLocation(program, "uCanvasSize"),
  time: gl.getUniformLocation(program, "uTime"),
  mirror: gl.getUniformLocation(program, "uMirror"),
  look: gl.getUniformLocation(program, "uLook"),
  lookStrength: gl.getUniformLocation(program, "uLookStrength"),
  effectKinds: gl.getUniformLocation(program, "uEffectKinds[0]"),
  effectStrength: gl.getUniformLocation(program, "uEffectStrength[0]"),
  effectParams: gl.getUniformLocation(program, "uEffectParams[0]"),
});

const lookCode = (look: CameraFxProject["look"]): number => {
  switch (look) {
    case "amber-crt":
      return 1;
    case "teal-orange":
      return 2;
    case "bleach":
      return 3;
    case "cold-mono":
      return 4;
    default:
      return 0;
  }
};

const effectUniforms = (
  effects: CameraEffect[],
): {
  kinds: Int32Array;
  strengths: Float32Array;
  params: Float32Array;
} => {
  const kinds = new Int32Array(4);
  const strengths = new Float32Array(4);
  const params = new Float32Array(16);
  effects.slice(0, 4).forEach((effect, index) => {
    kinds[index] = effect.enabled ? EFFECT_CODES[effect.kind] : 0;
    strengths[index] = effect.enabled ? effect.strength : 0;
    params.set(
      [
        effect.params.cellSize,
        effect.params.contrast,
        effect.params.threshold,
        effect.params.scanline,
      ],
      index * 4,
    );
    if (effect.kind === "depth") {
      params[index * 4 + 0] = effect.params.edge;
      params[index * 4 + 1] = effect.params.contrast;
      params[index * 4 + 2] = effect.params.threshold;
      params[index * 4 + 3] = effect.params.noise;
    } else if (effect.kind === "rgb-signal") {
      params[index * 4 + 0] = effect.params.channelOffset;
      params[index * 4 + 1] = effect.params.scanline;
      params[index * 4 + 2] = effect.params.noise;
    } else if (effect.kind === "flir") {
      params[index * 4 + 0] = effect.params.contrast;
      params[index * 4 + 1] = effect.params.threshold;
      params[index * 4 + 2] = effect.params.scanline;
      params[index * 4 + 3] = effect.params.posterize;
    } else if (effect.kind === "heat") {
      params[index * 4 + 0] = effect.params.contrast;
      params[index * 4 + 1] = effect.params.edge;
      params[index * 4 + 2] = effect.params.threshold;
      params[index * 4 + 3] = effect.params.scanline;
    }
  });
  return { kinds, strengths, params };
};

const sourceSize = (
  video: HTMLVideoElement,
  project: CameraFxProject,
): [number, number] => [
  video.videoWidth > 0 ? video.videoWidth : project.width,
  video.videoHeight > 0 ? video.videoHeight : project.height,
];

const drawCleanFrame = (
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  mirror: boolean,
): void => {
  context.save();
  context.clearRect(0, 0, width, height);
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    context.restore();
    return;
  }
  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  const drawX = (width - drawWidth) / 2;
  const drawY = (height - drawHeight) / 2;
  if (mirror) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, drawX, drawY, drawWidth, drawHeight);
  context.restore();
};

const ASCII_GLYPHS = " .:-=+*#%@";

type GlyphAtlasSource = HTMLCanvasElement | OffscreenCanvas;

const createGlyphAtlas = (
  canvas: HTMLCanvasElement,
): GlyphAtlasSource | null => {
  const size = 64;
  const atlasWidth = size * ASCII_GLYPHS.length;
  const ownerDocument = canvas.ownerDocument;
  const atlas = ownerDocument
    ? ownerDocument.createElement("canvas")
    : typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(atlasWidth, size)
      : null;
  if (!atlas) {
    return null;
  }
  atlas.width = atlasWidth;
  atlas.height = size;
  const context = atlas.getContext("2d");
  if (!context) {
    return null;
  }
  context.clearRect(0, 0, atlasWidth, size);
  context.fillStyle = "#fff";
  context.font = `bold ${Math.round(size * 0.8)}px ${CAMERA_ASCII_FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let index = 0; index < ASCII_GLYPHS.length; index += 1) {
    context.fillText(ASCII_GLYPHS[index]!, index * size + size / 2, size / 2);
  }
  return atlas;
};

export class CameraRenderer {
  private readonly processedCanvas: HTMLCanvasElement;
  private readonly cleanCanvas: HTMLCanvasElement;
  private readonly cleanContext: CanvasRenderingContext2D;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Uniforms;
  private readonly texture: WebGLTexture;
  private readonly glyphTexture: WebGLTexture;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;
  private disposed = false;

  constructor(
    processedCanvas: HTMLCanvasElement,
    cleanCanvas: HTMLCanvasElement,
  ) {
    const cleanContext = cleanCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (!cleanContext) {
      throw new Error(
        "Camera FX renderer could not acquire a clean canvas context",
      );
    }
    const gl = processedCanvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("Camera FX requires WebGL2 support");
    }
    const program = createProgram(gl);
    const texture = gl.createTexture();
    const glyphTexture = gl.createTexture();
    const vertexArray = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    if (!texture || !glyphTexture || !vertexArray || !vertexBuffer) {
      gl.deleteProgram(program);
      throw new Error("Camera FX renderer could not allocate WebGL resources");
    }

    this.processedCanvas = processedCanvas;
    this.cleanCanvas = cleanCanvas;
    this.cleanContext = cleanContext;
    this.gl = gl;
    this.program = program;
    this.uniforms = createUniforms(gl, program);
    this.texture = texture;
    this.glyphTexture = glyphTexture;
    this.vertexArray = vertexArray;
    this.vertexBuffer = vertexBuffer;

    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const glyphAtlas = createGlyphAtlas(processedCanvas);
    if (glyphAtlas) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        glyphAtlas,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255]),
      );
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uVideo"), 0);
    gl.uniform1i(this.uniforms.glyphAtlas, 1);
    gl.uniform1f(
      this.uniforms.glyphCount,
      glyphAtlas ? ASCII_GLYPHS.length : 1,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(
    video: HTMLVideoElement,
    project: CameraFxProject,
    timeMs: number,
  ): void {
    if (this.disposed) {
      return;
    }
    const width = Math.max(1, Math.round(project.width));
    const height = Math.max(1, Math.round(project.height));
    if (this.processedCanvas.width !== width)
      this.processedCanvas.width = width;
    if (this.processedCanvas.height !== height)
      this.processedCanvas.height = height;
    if (this.cleanCanvas.width !== width) this.cleanCanvas.width = width;
    if (this.cleanCanvas.height !== height) this.cleanCanvas.height = height;

    drawCleanFrame(this.cleanContext, video, width, height, project.mirror);

    const gl = this.gl;
    const [videoWidth, videoHeight] = sourceSize(video, project);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video,
      );
    }
    gl.uniform2f(this.uniforms.sourceSize, videoWidth, videoHeight);
    gl.uniform2f(this.uniforms.canvasSize, width, height);
    gl.uniform1f(this.uniforms.time, Math.max(0, timeMs) / 1000);
    gl.uniform1f(this.uniforms.mirror, project.mirror ? 1 : 0);
    gl.uniform1i(this.uniforms.look, lookCode(project.look));
    gl.uniform1f(this.uniforms.lookStrength, project.lookStrength);
    const values = effectUniforms(project.effects);
    gl.uniform1iv(this.uniforms.effectKinds, values.kinds);
    gl.uniform1fv(this.uniforms.effectStrength, values.strengths);
    gl.uniform4fv(this.uniforms.effectParams, values.params);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteTexture(this.glyphTexture);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteProgram(this.program);
  }
}
