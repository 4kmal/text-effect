import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

const DEFAULT_PORT = 34871;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1920;
const MAX_PIXELS = 1920 * 1080;
const MAX_FPS = 60;
const MAX_DURATION_SECONDS = 30;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const OUTPUT_TTL_MS = 10 * 60 * 1000;

type Pairing = {
  token: string;
  origin: string;
  expiresAt: number;
  used: boolean;
};

type RenderSession = {
  id: string;
  pairing: Pairing;
  outputPath: string;
  process?: ReturnType<typeof Bun.spawn>;
  pendingFrame?: number;
  expectedFrame: number;
  frameCount: number;
  complete: boolean;
  failed: boolean;
  createdAt: number;
  expiresAt: number;
};

type SocketData = {
  pairing: Pairing;
  session?: RenderSession;
};

type StartMessage = {
  type: "start";
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  frames: number;
};

const port = Number(Bun.env.MODELER_HELPER_PORT ?? DEFAULT_PORT);
const allowedOrigins = new Set(
  (Bun.env.MODELER_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const pairings = new Map<string, Pairing>();
const sessions = new Map<string, RenderSession>();

const json = (
  body: unknown,
  status = 200,
  origin?: string,
): Response => {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (origin && allowedOrigins.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
};

const allowedOrigin = (request: Request): string | undefined => {
  const origin = request.headers.get("origin") ?? undefined;
  return origin && allowedOrigins.has(origin) ? origin : undefined;
};

const cors = (origin: string): Headers => {
  const headers = new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Accept,Content-Type",
    "cache-control": "no-store",
  });
  headers.set("vary", "Origin");
  return headers;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sendError = (
  socket: Bun.ServerWebSocket<SocketData>,
  message: string,
  code = "helper-error",
): void => {
  try {
    socket.send(JSON.stringify({ type: "error", code, message }));
  } catch {
    socket.close(1011, message.slice(0, 120));
  }
};

const isNumberInRange = (
  value: unknown,
  min: number,
  max: number,
): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

const validateStart = (message: StartMessage): string | undefined => {
  if (
    !Number.isSafeInteger(message.width) ||
    !Number.isSafeInteger(message.height) ||
    message.width <= 0 ||
    message.height <= 0 ||
    message.width > MAX_WIDTH ||
    message.height > MAX_HEIGHT ||
    message.width * message.height > MAX_PIXELS
  ) {
    return "The requested render dimensions exceed the 1080p helper limit.";
  }
  if (!isNumberInRange(message.fps, 1, MAX_FPS)) {
    return "The requested render FPS is outside the supported range.";
  }
  if (!isNumberInRange(message.durationSeconds, 0.001, MAX_DURATION_SECONDS)) {
    return "The requested render duration is outside the supported range.";
  }
  const frames = Math.max(1, Math.ceil(message.durationSeconds * message.fps));
  if (!Number.isSafeInteger(message.frames) || message.frames !== frames) {
    return "The requested frame count does not match the render duration.";
  }
  return undefined;
};

const removeOutput = async (session: RenderSession): Promise<void> => {
  if (session.process) {
    try {
      session.process.kill();
    } catch {
      // The process may have exited between the render error and cleanup.
    }
  }
  await unlink(session.outputPath).catch(() => undefined);
};

const createFfmpegProcess = (
  session: RenderSession,
  request: StartMessage,
): ReturnType<typeof Bun.spawn> => {
  const args = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-framerate",
    String(request.fps),
    "-i",
    "pipe:0",
    "-frames:v",
    String(request.frames),
    "-an",
    "-c:v",
    "prores_ks",
    "-profile:v",
    "4444",
    "-pix_fmt",
    "yuva444p10le",
    "-alpha_bits",
    "16",
    "-r",
    String(request.fps),
    "-y",
    session.outputPath,
  ];

  return Bun.spawn(args, {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
};

const parseControl = (message: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(message);
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Control message is missing its type.");
  }
  return value as Record<string, unknown>;
};

const binaryBytes = (message: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
};

const handleControl = async (
  socket: Bun.ServerWebSocket<SocketData>,
  rawMessage: string,
): Promise<void> => {
  const message = parseControl(rawMessage);
  const type = message.type;

  if (type === "start") {
    if (socket.data.session) {
      throw new Error("This pairing already has a render session.");
    }
    const request = message as unknown as StartMessage;
    const validationError = validateStart(request);
    if (validationError) {
      throw new Error(validationError);
    }

    const id = randomUUID();
    const session: RenderSession = {
      id,
      pairing: socket.data.pairing,
      outputPath: join(tmpdir(), `rapidscreen-modeler-${id}.mov`),
      expectedFrame: 0,
      frameCount: request.frames,
      complete: false,
      failed: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + OUTPUT_TTL_MS,
    };
    session.process = createFfmpegProcess(session, request);
    socket.data.session = session;
    sessions.set(id, session);
    socket.send(JSON.stringify({ type: "started", id }));
    return;
  }

  const session = socket.data.session;
  if (!session) {
    throw new Error("Start a render session before sending frames.");
  }

  if (type === "frame") {
    if (session.pendingFrame !== undefined) {
      throw new Error("The previous frame has not finished writing.");
    }
    const index = message.index;
    if (!Number.isSafeInteger(index) || index !== session.expectedFrame) {
      throw new Error(`Expected frame ${session.expectedFrame}.`);
    }
    session.pendingFrame = index;
    return;
  }

  if (type === "finish") {
    if (
      session.pendingFrame !== undefined ||
      session.expectedFrame !== session.frameCount
    ) {
      throw new Error("The render cannot finish before all frames are written.");
    }
    const stdin = session.process?.stdin;
    if (!stdin || typeof stdin === "number") {
      throw new Error("FFmpeg input stream is unavailable.");
    }
    await stdin.end();
    const exitCode = await session.process?.exited;
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode ?? "unknown"}.`);
    }
    session.complete = true;
    session.expiresAt = Date.now() + OUTPUT_TTL_MS;
    socket.send(
      JSON.stringify({
        type: "complete",
        id: session.id,
        bytes: Bun.file(session.outputPath).size,
      }),
    );
    return;
  }

  if (type === "cancel") {
    session.failed = true;
    await removeOutput(session);
    sessions.delete(session.id);
    socket.close(1000, "render canceled");
    return;
  }

  throw new Error(`Unknown helper control message: ${String(type)}.`);
};

const handleBinary = async (
  socket: Bun.ServerWebSocket<SocketData>,
  message: ArrayBuffer | ArrayBufferView,
): Promise<void> => {
  const session = socket.data.session;
  if (!session || session.pendingFrame === undefined) {
    throw new Error("A frame control message is required before frame bytes.");
  }
  const bytes = binaryBytes(message);
  if (bytes.byteLength === 0) {
    throw new Error("The frame payload is empty.");
  }
  const stdin = session.process?.stdin;
  if (!stdin || typeof stdin === "number") {
    throw new Error("FFmpeg input stream is unavailable.");
  }
  await stdin.write(bytes);
  await stdin.flush();
  const frame = session.pendingFrame;
  session.pendingFrame = undefined;
  session.expectedFrame += 1;
  socket.send(JSON.stringify({ type: "frame-ready", frame }));
};

const cleanupExpired = (): void => {
  const now = Date.now();
  pairings.forEach((pairing, token) => {
    if (pairing.expiresAt < now) {
      pairings.delete(token);
    }
  });
  sessions.forEach((session, id) => {
    if (session.expiresAt >= now) {
      return;
    }
    sessions.delete(id);
    void removeOutput(session);
  });
};

const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port,
  fetch(request, serverInstance) {
    const origin = allowedOrigin(request);
    if (request.method === "OPTIONS") {
      return origin
        ? new Response(null, { status: 204, headers: cors(origin) })
        : new Response(null, { status: 403 });
    }
    if (!origin) {
      return json({ error: "origin-not-allowed" }, 403);
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, service: "modeler-helper" }), {
        headers: { ...Object.fromEntries(cors(origin)), "content-type": "application/json" },
      });
    }

    if (url.pathname === "/pair" && request.method === "POST") {
      const token = `${randomUUID()}-${randomUUID()}`;
      const pairing: Pairing = {
        token,
        origin,
        expiresAt: Date.now() + PAIRING_TTL_MS,
        used: false,
      };
      pairings.set(token, pairing);
      return json({ token, expiresAt: pairing.expiresAt }, 200, origin);
    }

    if (url.pathname.startsWith("/render/")) {
      const id = decodeURIComponent(url.pathname.slice("/render/".length));
      const session = sessions.get(id);
      const token = url.searchParams.get("token");
      if (!session || !token || session.pairing.token !== token || session.pairing.origin !== origin) {
        return json({ error: "render-not-found" }, 404, origin);
      }
      if (request.method === "DELETE") {
        sessions.delete(id);
        void removeOutput(session);
        return json({ ok: true }, 200, origin);
      }
      if (request.method === "GET") {
        if (!session.complete || session.failed) {
          return json({ error: "render-not-ready" }, 409, origin);
        }
        session.expiresAt = Date.now() + OUTPUT_TTL_MS;
        return new Response(Bun.file(session.outputPath), {
          headers: {
            ...Object.fromEntries(cors(origin)),
            "content-type": "video/quicktime",
          },
        });
      }
    }

    if (url.pathname === "/render" && request.method === "GET") {
      const token = url.searchParams.get("token");
      const pairing = token ? pairings.get(token) : undefined;
      if (!pairing || pairing.origin !== origin || pairing.used) {
        return new Response("Pairing token is invalid.", { status: 403 });
      }
      pairing.used = true;
      if (
        serverInstance.upgrade(request, {
          data: { pairing },
        })
      ) {
        return undefined;
      }
      return new Response("WebSocket upgrade failed.", { status: 500 });
    }

    return json({ error: "not-found" }, 404, origin);
  },
  websocket: {
    open() {},
    async message(socket, message) {
      try {
        if (typeof message === "string") {
          await handleControl(socket, message);
        } else {
          await handleBinary(socket, message);
        }
      } catch (error) {
        const session = socket.data.session;
        if (session) {
          session.failed = true;
          sessions.delete(session.id);
          await removeOutput(session);
        }
        sendError(socket, errorMessage(error));
      }
    },
    close(socket) {
      const session = socket.data.session;
      if (session && !session.complete) {
        sessions.delete(session.id);
        void removeOutput(session);
      }
    },
  },
});

setInterval(cleanupExpired, 60_000);
console.log(`RapidScreen model helper listening on http://${server.hostname}:${server.port}`);
