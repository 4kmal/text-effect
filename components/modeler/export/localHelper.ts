import {
  createModelAbortError,
  frameCountFor,
  isModelExportAbort,
  ModelExportError,
  type ModelLocalRenderClient,
  type ModelLocalRenderRequest,
} from "./types";

export const MODEL_HELPER_DEFAULT_URL = "http://127.0.0.1:34871";

type HelperMessage = {
  type: string;
  id?: string;
  frame?: number;
  bytes?: number;
  message?: string;
  code?: string;
};

type LocalHelperClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  webSocket?: typeof WebSocket;
};

const clamp = (value: number): number =>
  Math.min(1, Math.max(0, value));

const abortableFetch = async (
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> => {
  if (signal?.aborted) {
    throw createModelAbortError();
  }
  try {
    return await fetchImpl(input, { ...init, signal });
  } catch (cause) {
    if (signal?.aborted) {
      throw createModelAbortError();
    }
    throw cause;
  }
};

const canvasToPng = async (
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  if (signal?.aborted) {
    throw createModelAbortError();
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
      } else {
        reject(
          new ModelExportError(
            "render-failed",
            "The browser could not encode a transparent model frame.",
          ),
        );
      }
    }, "image/png");
  });
  const buffer = await blob.arrayBuffer();
  if (signal?.aborted) {
    throw createModelAbortError();
  }
  return new Uint8Array(buffer);
};

const parseMessage = (data: unknown): HelperMessage => {
  if (typeof data !== "string") {
    throw new ModelExportError(
      "helper-failed",
      "The local model helper returned a non-text control message.",
    );
  }
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || !("type" in value)) {
      throw new Error("missing message type");
    }
    return value as HelperMessage;
  } catch (cause) {
    throw new ModelExportError(
      "helper-failed",
      "The local model helper returned invalid control data.",
      {},
      cause,
    );
  }
};

const waitForOpen = (
  socket: WebSocket,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const abort = (): void => {
      cleanup();
      reject(createModelAbortError());
    };
    const opened = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(
        new ModelExportError(
          "helper-unavailable",
          "The local model helper could not open a render session.",
        ),
      );
    };
    const cleanup = (): void => {
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      signal?.removeEventListener("abort", abort);
    };

    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
    signal?.addEventListener("abort", abort, { once: true });
  });

const waitForMessage = (
  socket: WebSocket,
  signal: AbortSignal | undefined,
  predicate: (message: HelperMessage) => boolean,
): Promise<HelperMessage> =>
  new Promise<HelperMessage>((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      let message: HelperMessage;
      try {
        message = parseMessage(event.data);
      } catch (cause) {
        cleanup();
        reject(cause);
        return;
      }

      if (message.type === "error") {
        cleanup();
        reject(
          new ModelExportError(
            "helper-failed",
            message.message ?? "The local model helper failed.",
            { helperCode: message.code },
          ),
        );
        return;
      }
      if (!predicate(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (): void => {
      cleanup();
      reject(
        new ModelExportError(
          "helper-failed",
          "The local model helper closed the render session unexpectedly.",
        ),
      );
    };
    const abort = (): void => {
      cleanup();
      reject(createModelAbortError());
    };
    const cleanup = (): void => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onError);
      signal?.removeEventListener("abort", abort);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onError);
    signal?.addEventListener("abort", abort, { once: true });
  });

const toWebSocketUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/render`;
  url.search = "";
  return url.toString();
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createModelAbortError();
  }
};

export class ModelerLocalHelperClient implements ModelLocalRenderClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocket: typeof WebSocket;

  constructor(options: LocalHelperClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? MODEL_HELPER_DEFAULT_URL).replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocket = options.webSocket ?? WebSocket;
  }

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    if (typeof window === "undefined" || typeof this.webSocket === "undefined") {
      return false;
    }

    try {
      const response = await abortableFetch(
        this.fetchImpl,
        `${this.baseUrl}/health`,
        { method: "GET" },
        signal,
      );
      return response.ok;
    } catch (cause) {
      if (isModelExportAbort(cause)) {
        throw cause;
      }
      return false;
    }
  }

  async exportProRes4444(
    request: ModelLocalRenderRequest,
  ): Promise<Blob> {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new ModelExportError(
        "runtime-unavailable",
        "MOV export requires a browser runtime.",
      );
    }
    if (typeof this.webSocket === "undefined") {
      throw new ModelExportError(
        "helper-unavailable",
        "This browser does not provide WebSocket support for the local helper.",
      );
    }

    throwIfAborted(request.signal);
    const frames = frameCountFor(request.durationSeconds, request.fps);
    const pairingResponse = await abortableFetch(
      this.fetchImpl,
      `${this.baseUrl}/pair`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      },
      request.signal,
    );
    if (!pairingResponse.ok) {
      throw new ModelExportError(
        "helper-unavailable",
        "The local model helper did not accept a pairing request.",
        { status: pairingResponse.status },
      );
    }

    const pairing = (await pairingResponse.json()) as {
      token?: string;
    };
    if (!pairing.token) {
      throw new ModelExportError(
        "helper-unavailable",
        "The local model helper returned no pairing token.",
      );
    }

    const socketUrl = new URL(toWebSocketUrl(this.baseUrl));
    socketUrl.searchParams.set("token", pairing.token);
    const socket = new this.webSocket(socketUrl.toString());
    let renderId: string | undefined;
    let completed = false;

    const cancelSession = (): void => {
      if (socket.readyState === this.webSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "cancel" }));
        } catch {
          // The close path below still cleans the helper session.
        }
      }
      socket.close();
    };

    try {
      await waitForOpen(socket, request.signal);
      socket.send(
        JSON.stringify({
          type: "start",
          width: request.width,
          height: request.height,
          fps: request.fps,
          durationSeconds: request.durationSeconds,
          frames,
          alpha: true,
        }),
      );
      const started = await waitForMessage(
        socket,
        request.signal,
        (message) => message.type === "started",
      );
      renderId = started.id;
      if (!renderId) {
        throw new ModelExportError(
          "helper-failed",
          "The local model helper returned no render id.",
        );
      }

      for (let frame = 0; frame < frames; frame += 1) {
        throwIfAborted(request.signal);
        const canvas = await request.renderFrame(
          frame / request.fps,
          request.width,
          request.height,
          true,
        );
        if (
          !canvas ||
          canvas.width !== request.width ||
          canvas.height !== request.height
        ) {
          throw new ModelExportError(
            "render-failed",
            "The model renderer returned a frame with the wrong dimensions.",
            {
              frame,
              expectedWidth: request.width,
              expectedHeight: request.height,
              width: canvas?.width,
              height: canvas?.height,
            },
          );
        }
        const bytes = await canvasToPng(canvas, request.signal);
        socket.send(JSON.stringify({ type: "frame", index: frame }));
        socket.send(bytes);
        await waitForMessage(
          socket,
          request.signal,
          (message) =>
            message.type === "frame-ready" && message.frame === frame,
        );
        request.onProgress?.(clamp(((frame + 1) / frames) * 0.85));
      }

      throwIfAborted(request.signal);
      socket.send(JSON.stringify({ type: "finish" }));
      const finished = await waitForMessage(
        socket,
        request.signal,
        (message) => message.type === "complete",
      );
      if (finished.id && finished.id !== renderId) {
        throw new ModelExportError(
          "helper-failed",
          "The local model helper completed a different render session.",
        );
      }
      completed = true;
      socket.close();

      const outputResponse = await abortableFetch(
        this.fetchImpl,
        `${this.baseUrl}/render/${encodeURIComponent(renderId)}?token=${encodeURIComponent(pairing.token)}`,
        { method: "GET" },
        request.signal,
      );
      if (!outputResponse.ok) {
        throw new ModelExportError(
          "helper-failed",
          "The local model helper could not return the completed MOV.",
          { status: outputResponse.status },
        );
      }
      const output = await outputResponse.blob();
      if (output.size === 0) {
        throw new ModelExportError(
          "helper-failed",
          "The local model helper returned an empty MOV.",
        );
      }
      request.onProgress?.(1);
      return new Blob([output], { type: "video/quicktime" });
    } catch (cause) {
      if (request.signal?.aborted || isModelExportAbort(cause)) {
        throw createModelAbortError();
      }
      if (cause instanceof ModelExportError) {
        throw cause;
      }
      throw new ModelExportError(
        "helper-failed",
        "The local model helper could not encode the MOV.",
        {},
        cause,
      );
    } finally {
      if (!completed) {
        cancelSession();
      }
      if (renderId && !completed) {
        void this.fetchImpl(
          `${this.baseUrl}/render/${encodeURIComponent(renderId)}?token=${encodeURIComponent(pairing.token)}`,
          { method: "DELETE" },
        ).catch(() => undefined);
      }
    }
  }
}

export function createModelerLocalHelperClient(
  options?: LocalHelperClientOptions,
): ModelerLocalHelperClient {
  return new ModelerLocalHelperClient(options);
}
