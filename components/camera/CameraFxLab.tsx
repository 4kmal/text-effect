"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  ChevronDown,
  CircleStop,
  FolderOpen,
  GripVertical,
  Loader2,
  Mic,
  MicOff,
  MonitorDown,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Video,
  VideoOff,
  X,
  Zap,
} from "lucide-react";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createCameraEffect,
  createCameraPreset,
  parseCameraProject,
} from "@/components/camera/core/model";
import type {
  CameraEffect,
  CameraEffectKind,
  CameraPresetId,
  CameraFxProject,
} from "@/components/camera/core/model";
import { CameraRenderer } from "@/components/camera/core/renderer";
import { convertCameraTakeToMp4 } from "@/components/camera/core/conversion";
import {
  selectRecordingMime,
  startCameraRecording,
  type RecordingSession,
  type StartCameraRecordingArgs,
} from "@/components/camera/core/recording";
import type { CameraTake } from "@/components/camera/core/recording";

type CameraMode =
  "idle" | "starting" | "ready" | "recording" | "finalizing" | "error";
type Resolution = "1080p" | "720p";
type PreviewLayer = "effected" | "clean";

type CameraDraft = {
  id: string;
  name: string;
  updatedAt: string;
  project: CameraFxProject;
};

type LocalEffect = CameraEffect;

type LocalProject = CameraFxProject & {
  version: number;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  micEnabled: boolean;
  lookStrength: number;
};

type CameraDevice = MediaDeviceInfo;

type BrowserWithDirectoryPicker = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
};

const STORAGE_KEY = "rapidscreen-camera-fx-looks-v1";
const FRAME_RATE = 30;
const MAX_STACK = 4;
const MAX_TAKE_MS = 10 * 60 * 1000;

const PRESET_OPTIONS = [
  { id: "clean", label: "Clean", detail: "camera signal", glyph: "[--]" },
  {
    id: "ascii",
    label: "ASCII Terminal",
    detail: "character raster",
    glyph: "#%*",
  },
  {
    id: "flir",
    label: "FLIR Style",
    detail: "false colour heat",
    glyph: "THERM",
  },
  {
    id: "heat",
    label: "Heat Vision",
    detail: "infrared palette",
    glyph: "HOT",
  },
  {
    id: "depth",
    label: "Pseudo Depth",
    detail: "luma contour map",
    glyph: "Z-01",
  },
  {
    id: "rgb-signal",
    label: "RGB Signal",
    detail: "channel drift",
    glyph: "R/G/B",
  },
] as const;

const EFFECT_OPTIONS = [
  { id: "ascii", label: "ASCII Terminal", detail: "character raster" },
  { id: "flir", label: "FLIR Style", detail: "false colour heat" },
  { id: "heat", label: "Heat Vision", detail: "infrared palette" },
  { id: "depth", label: "Pseudo Depth", detail: "luma contour map" },
  { id: "rgb-signal", label: "RGB Signal", detail: "channel drift" },
] as const;

const LUT_OPTIONS = [
  { id: "neutral", label: "Neutral", colour: "#d8d2c7" },
  { id: "amber-crt", label: "Amber CRT", colour: "#f28a2b" },
  { id: "teal-orange", label: "Teal / Orange", colour: "#27b3a7" },
  { id: "bleach", label: "Bleach", colour: "#e9e7da" },
  { id: "cold-mono", label: "Cold Mono", colour: "#9eafbd" },
] as const;

const RESOLUTION_OPTIONS: Array<{
  id: Resolution;
  width: number;
  height: number;
}> = [
  { id: "1080p", width: 1920, height: 1080 },
  { id: "720p", width: 1280, height: 720 },
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const readNumber = (value: unknown, fallback: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const makeId = (prefix: string) => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
};

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

const effectLabel = (kind: string) =>
  EFFECT_OPTIONS.find((option) => option.id === kind)?.label ??
  kind.toUpperCase();

const normalizeEffect = (value: unknown, index: number): LocalEffect => {
  const source = asRecord(value);
  const kind = String(
    source.kind ?? source.type ?? "ascii",
  ) as CameraEffectKind;
  const params = asRecord(source.params);
  const cellSize = clamp(readNumber(params.cellSize, 9), 2, 64);
  const contrast = clamp(readNumber(params.contrast, 1.2), 0, 3);
  const threshold = clamp(readNumber(params.threshold, 0.48), 0, 1);
  const scanline = clamp(readNumber(params.scanline, 0.28), 0, 1);
  const edge = clamp(readNumber(params.edge, 0), 0, 1);
  const channelOffset = clamp(readNumber(params.channelOffset, 0), 0, 48);
  const noise = clamp(readNumber(params.noise, 0.12), 0, 1);
  const posterize = clamp(Math.round(readNumber(params.posterize, 8)), 2, 32);
  return {
    ...source,
    id: String(source.id ?? makeId(`effect-${index + 1}`)),
    kind,
    enabled: source.enabled !== false,
    strength: clamp(readNumber(source.strength, 0.72), 0, 1),
    params: {
      ...params,
      cellSize,
      contrast,
      threshold,
      scanline,
      edge,
      channelOffset,
      noise,
      posterize,
    },
  } as LocalEffect;
};

const normalizeProject = (value: unknown): LocalProject => {
  const source = asRecord(value);
  const sourceProject = asRecord(source.project ?? value);
  const effects = Array.isArray(sourceProject.effects)
    ? sourceProject.effects.map(normalizeEffect)
    : [];
  return {
    ...sourceProject,
    version: readNumber(sourceProject.version, 1),
    width: readNumber(sourceProject.width, 1920),
    height: readNumber(sourceProject.height, 1080),
    fps: readNumber(sourceProject.fps, FRAME_RATE),
    mirror: sourceProject.mirror !== false,
    micEnabled: sourceProject.micEnabled !== false,
    look: String(sourceProject.look ?? "neutral") as CameraFxProject["look"],
    lookStrength: clamp(readNumber(sourceProject.lookStrength, 1), 0, 1),
    effects,
  } as LocalProject;
};

const projectForPreset = (id: CameraPresetId): LocalProject =>
  normalizeProject(createCameraPreset(id));

const effectForKind = (kind: CameraEffectKind): LocalEffect => ({
  ...createCameraEffect(kind),
  id: makeId("effect"),
});

const persistedProject = (project: LocalProject): CameraFxProject => {
  return {
    version: 1,
    id: String(project.id ?? "camera-project"),
    name: String(project.name ?? "Untitled camera look"),
    width: project.width,
    height: project.height,
    fps: 30,
    mirror: project.mirror,
    micEnabled: project.micEnabled,
    look: project.look,
    lookStrength: project.lookStrength,
    effects: project.effects.slice(0, MAX_STACK).map((effect) => {
      const params = asRecord(effect.params);
      return {
        id: effect.id,
        kind: effect.kind,
        enabled: effect.enabled,
        strength: clamp(effect.strength, 0, 1),
        params: {
          cellSize: clamp(readNumber(params.cellSize, 9), 2, 64),
          contrast: clamp(readNumber(params.contrast, 1.2), 0, 3),
          threshold: clamp(readNumber(params.threshold, 0.1), 0, 1),
          scanline: clamp(readNumber(params.scanline, 0.2), 0, 1),
          edge: clamp(readNumber(params.edge, 0), 0, 1),
          channelOffset: clamp(readNumber(params.channelOffset, 0), 0, 48),
          noise: clamp(readNumber(params.noise, 0.1), 0, 1),
          posterize: clamp(Math.round(readNumber(params.posterize, 8)), 2, 32),
        },
      };
    }),
  } as CameraFxProject;
};

const serializedDrafts = (drafts: CameraDraft[]) =>
  JSON.stringify(
    drafts.map((draft) => ({
      id: draft.id,
      name: draft.name,
      updatedAt: draft.updatedAt,
      project: persistedProject(normalizeProject(draft.project)),
    })),
  );

const formatDuration = (milliseconds: number) => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
};

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "--";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export default function CameraFxLab() {
  const [project, setProject] = useState<LocalProject>(() =>
    projectForPreset("ascii"),
  );
  const [activePreset, setActivePreset] = useState("ascii");
  const [activeEffectId, setActiveEffectId] = useState<string | null>(null);
  const [previewLayer, setPreviewLayer] = useState<PreviewLayer>("effected");
  const [cameraMode, setCameraMode] = useState<CameraMode>("idle");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([]);
  const [microphones, setMicrophones] = useState<CameraDevice[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [audioDenied, setAudioDenied] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [fps, setFps] = useState(0);
  const [statusMessage, setStatusMessage] = useState(
    "Choose Start Camera to request access.",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [fontsReady, setFontsReady] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [toast, setToast] = useState("");
  const [draftName, setDraftName] = useState("Untitled look");
  const [drafts, setDrafts] = useState<CameraDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [showDrafts, setShowDrafts] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastTake, setLastTake] = useState<CameraTake | null>(null);
  const [takeUrls, setTakeUrls] = useState<{ effected: string; clean: string }>(
    {
      effected: "",
      clean: "",
    },
  );
  const [takeBytes, setTakeBytes] = useState(0);
  const [conversionState, setConversionState] = useState<
    "idle" | "converting" | "done" | "error"
  >("idle");
  const [conversionProgress, setConversionProgress] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const processedCanvasRef = useRef<HTMLCanvasElement>(null);
  const cleanCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const rendererRef = useRef<CameraRenderer | null>(null);
  const renderingRef = useRef(false);
  const renderGenerationRef = useRef(0);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const projectRef = useRef(project);
  const folderHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const recordingSessionRef = useRef<RecordingSession | null>(null);
  const restartPendingRef = useRef(false);
  const recordingStartedRef = useRef(0);
  const fpsFramesRef = useRef(0);
  const fpsWindowStartRef = useRef(0);
  const fpsIntervalRef = useRef<number | null>(null);
  const conversionAbortRef = useRef<AbortController | null>(null);

  const effects = project.effects ?? [];
  const activeEffect =
    effects.find((effect) => effect.id === activeEffectId) ??
    effects[0] ??
    null;
  const activeEffectIndex = activeEffect
    ? effects.findIndex((effect) => effect.id === activeEffect.id)
    : -1;
  const isRecording = cameraMode === "recording" || cameraMode === "finalizing";
  const resolutionDetails =
    RESOLUTION_OPTIONS.find((option) => option.id === resolution) ??
    RESOLUTION_OPTIONS[0];
  const nativeMime = useMemo(() => {
    if (!browserReady) return "video/webm;codecs=vp9,opus";
    try {
      return selectRecordingMime(Boolean(micEnabled && micStreamRef.current))
        .mimeType;
    } catch {
      return "video/webm;codecs=vp9,opus";
    }
  }, [browserReady, micEnabled, cameraMode]);

  useEffect(() => {
    setBrowserReady(true);
  }, []);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await Promise.all([
        document.fonts.load('16px "Departure Mono Editor"'),
        document.fonts.load('16px "Departure Mono Camera"'),
        document.fonts.load('16px "Press Start 2P Editor"'),
      ]);
      if (mounted) setFontsReady(true);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (
      !activeEffectId ||
      effects.some((effect) => effect.id === activeEffectId)
    )
      return;
    setActiveEffectId(effects[0]?.id ?? null);
  }, [activeEffectId, effects]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) return;
      const restored = value
        .map((item) => {
          const source = asRecord(item);
          try {
            return {
              id: String(source.id ?? makeId("look")),
              name: String(source.name ?? "Untitled look"),
              updatedAt: String(source.updatedAt ?? new Date().toISOString()),
              project: normalizeProject(parseCameraProject(source.project)),
            } satisfies CameraDraft;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as CameraDraft[];
      if (restored.length > 0) {
        setDrafts(restored);
        setProject(normalizeProject(restored[0].project));
        setResolution(restored[0].project.width >= 1920 ? "1080p" : "720p");
        setMicEnabled(restored[0].project.micEnabled);
        setDraftName(restored[0].name);
        setActiveDraftId(restored[0].id);
        setActivePreset("custom");
        setActiveEffectId(restored[0].project.effects[0]?.id ?? null);
      }
    } catch {
      // Local drafts are optional; the live camera still works when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializedDrafts(drafts));
    } catch {
      // Keep editing in memory if browser storage is full or disabled.
    }
  }, [drafts]);

  useEffect(() => {
    if (!activeDraftId) return;
    const timer = window.setTimeout(() => {
      setDrafts((current) =>
        current.map((draft) =>
          draft.id === activeDraftId
            ? {
                ...draft,
                name: draftName.trim() || draft.name,
                updatedAt: new Date().toISOString(),
                project: persistedProject(project),
              }
            : draft,
        ),
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeDraftId, draftName, project]);

  useEffect(() => {
    let disposed = false;
    let createdUrls: string[] = [];
    if (!lastTake) {
      setTakeUrls({ effected: "", clean: "" });
      setTakeBytes(0);
      return () => undefined;
    }
    void Promise.all([
      lastTake.processedFile.getFile(),
      lastTake.cleanFile.getFile(),
    ])
      .then(([processedFile, cleanFile]) => {
        if (disposed) return;
        createdUrls = [
          URL.createObjectURL(processedFile),
          URL.createObjectURL(cleanFile),
        ];
        setTakeBytes(processedFile.size + cleanFile.size);
        setTakeUrls({ effected: createdUrls[0], clean: createdUrls[1] });
      })
      .catch((error: unknown) => {
        if (!disposed)
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Saved files could not be previewed.",
          );
      });
    return () => {
      disposed = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [lastTake]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(
      () => setToast((current) => (current === message ? "" : current)),
      2600,
    );
  }, []);

  const updateProject = useCallback((mutator: (next: LocalProject) => void) => {
    setProject((current) => {
      const next = clone(current);
      mutator(next);
      return next;
    });
  }, []);

  const setCanvasDimensions = useCallback((width: number, height: number) => {
    for (const canvas of [processedCanvasRef.current, cleanCanvasRef.current]) {
      if (!canvas) continue;
      canvas.width = width;
      canvas.height = height;
    }
  }, []);

  const disposeRenderer = useCallback(() => {
    renderingRef.current = false;
    renderGenerationRef.current += 1;
    if (
      videoFrameCallbackRef.current !== null &&
      videoRef.current?.cancelVideoFrameCallback
    ) {
      videoRef.current.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
    }
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (fpsIntervalRef.current !== null) {
      window.clearInterval(fpsIntervalRef.current);
      fpsIntervalRef.current = null;
    }
    rendererRef.current?.dispose();
    rendererRef.current = null;
  }, []);

  const stopStreams = useCallback(() => {
    disposeRenderer();
    for (const stream of [videoStreamRef.current, micStreamRef.current]) {
      stream?.getTracks().forEach((track) => track.stop());
    }
    videoStreamRef.current = null;
    micStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [disposeRenderer]);

  const renderLoop = useCallback(() => {
    const video = videoRef.current;
    const renderer = rendererRef.current;
    if (!video || !renderer || renderingRef.current === false) return;
    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;
    const frame = (timestamp: number) => {
      if (!renderingRef.current || renderGenerationRef.current !== generation)
        return;
      const currentVideo = videoRef.current;
      const currentRenderer = rendererRef.current;
      if (currentVideo && currentRenderer && currentVideo.readyState >= 2) {
        try {
          currentRenderer.render(currentVideo, projectRef.current, timestamp);
          fpsFramesRef.current += 1;
        } catch (error) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "The camera renderer stopped.",
          );
        }
      }
      if (!renderingRef.current) return;
      if (typeof currentVideo?.requestVideoFrameCallback === "function") {
        videoFrameCallbackRef.current = currentVideo.requestVideoFrameCallback(
          (now) => frame(now),
        );
      } else {
        animationFrameRef.current = requestAnimationFrame(frame);
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      videoFrameCallbackRef.current = video.requestVideoFrameCallback((now) =>
        frame(now),
      );
    } else {
      animationFrameRef.current = requestAnimationFrame(frame);
    }
    fpsWindowStartRef.current = performance.now();
    fpsFramesRef.current = 0;
    fpsIntervalRef.current = window.setInterval(() => {
      const elapsed = performance.now() - fpsWindowStartRef.current;
      setFps(
        elapsed > 0 ? Math.round((fpsFramesRef.current * 1000) / elapsed) : 0,
      );
      fpsFramesRef.current = 0;
      fpsWindowStartRef.current = performance.now();
    }, 1000);
  }, []);

  const setupRenderer = useCallback(() => {
    const processedCanvas = processedCanvasRef.current;
    const cleanCanvas = cleanCanvasRef.current;
    if (!processedCanvas || !cleanCanvas) return false;
    setCanvasDimensions(projectRef.current.width, projectRef.current.height);
    rendererRef.current?.dispose();
    try {
      rendererRef.current = new CameraRenderer(processedCanvas, cleanCanvas);
      renderingRef.current = true;
      renderLoop();
      return true;
    } catch (error) {
      rendererRef.current = null;
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "WebGL2 is unavailable for the camera lab.",
      );
      return false;
    }
  }, [renderLoop, setCanvasDimensions]);

  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setCameraDevices(devices.filter((device) => device.kind === "videoinput"));
    setMicrophones(devices.filter((device) => device.kind === "audioinput"));
  }, []);

  const requestMicrophone = useCallback(async (): Promise<boolean> => {
    if (!micEnabled) return false;
    try {
      const constraints: MediaStreamConstraints = {
        video: false,
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = stream;
      setAudioDenied(false);
      setStatusMessage(
        "Camera and microphone ready. Choose a folder to record.",
      );
      return true;
    } catch {
      setAudioDenied(true);
      setMicEnabled(false);
      updateProject((next) => {
        next.micEnabled = false;
      });
      setStatusMessage(
        "Camera ready. Microphone permission was denied; video-only recording is available.",
      );
      return false;
    }
  }, [micEnabled, microphoneId, updateProject]);

  const startCamera = useCallback(async () => {
    if (cameraMode === "starting" || isRecording) return;
    if (!fontsReady) {
      setStatusMessage(
        "Loading the local camera font before opening the renderer…",
      );
      return;
    }
    setCameraMode("starting");
    setErrorMessage("");
    setStatusMessage("Requesting camera permission…");
    try {
      const requested =
        resolution === "1080p" ? RESOLUTION_OPTIONS[0] : RESOLUTION_OPTIONS[1];
      let resolutionFallback = false;
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: requested.width },
        height: { ideal: requested.height },
        frameRate: { ideal: FRAME_RATE, max: FRAME_RATE },
      };
      if (cameraId) videoConstraints.deviceId = { exact: cameraId };
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
      videoStreamRef.current?.getTracks().forEach((track) => track.stop());
      videoStreamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera preview is not ready.");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      const settings = stream.getVideoTracks()[0]?.getSettings();
      if (resolution === "1080p" && Number(settings?.width ?? 0) < 1920) {
        resolutionFallback = true;
        setResolution("720p");
        updateProject((next) => {
          next.width = 1280;
          next.height = 720;
        });
        projectRef.current = {
          ...projectRef.current,
          width: 1280,
          height: 720,
        };
        setStatusMessage(
          "Camera supplied 720p, so the lab switched the canvas to 1280 × 720.",
        );
      }
      await enumerateDevices();
      const microphoneGranted = await requestMicrophone();
      if (!setupRenderer())
        throw new Error("Could not initialize the WebGL2 camera renderer.");
      setCameraMode("ready");
      if (resolutionFallback) {
        setStatusMessage(
          microphoneGranted
            ? "Camera supplied 720p, so the lab switched the canvas to 1280 × 720. Choose a folder to record."
            : "Camera supplied 720p and microphone access was denied. Video-only recording is available.",
        );
      } else if (microphoneGranted) {
        setStatusMessage(
          "Camera and microphone ready. Choose a folder to record.",
        );
      }
    } catch (error) {
      stopStreams();
      setCameraMode("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Camera permission or setup failed.",
      );
      setStatusMessage(
        "Camera unavailable. Check browser permission and try again.",
      );
    }
  }, [
    cameraId,
    cameraMode,
    enumerateDevices,
    fontsReady,
    isRecording,
    requestMicrophone,
    resolution,
    setupRenderer,
    stopStreams,
    updateProject,
  ]);

  useEffect(() => {
    if (!restartPendingRef.current || cameraMode !== "idle") return;
    restartPendingRef.current = false;
    void startCamera();
  }, [cameraMode, startCamera]);

  const stopCamera = useCallback(() => {
    if (isRecording) return;
    restartPendingRef.current = false;
    stopStreams();
    setCameraMode("idle");
    setFps(0);
    setStatusMessage(
      "Camera stopped. Choose Start Camera to request access again.",
    );
  }, [isRecording, stopStreams]);

  const applyPreset = useCallback(
    (id: CameraPresetId) => {
      const preset = projectForPreset(id);
      const next: LocalProject = {
        ...preset,
        width: project.width,
        height: project.height,
        mirror: project.mirror,
        micEnabled: project.micEnabled,
      };
      setProject(next);
      setActivePreset(id);
      setActiveEffectId(next.effects[0]?.id ?? null);
      setDraftName(
        `${PRESET_OPTIONS.find((preset) => preset.id === id)?.label ?? "Custom"} look`,
      );
      notify(
        `${PRESET_OPTIONS.find((preset) => preset.id === id)?.label ?? "Preset"} loaded`,
      );
    },
    [notify, project],
  );

  const updateEffect = useCallback(
    (
      id: string,
      patch: Partial<LocalEffect>,
      paramsPatch: Partial<LocalEffect["params"]> = {},
    ) => {
      updateProject((next) => {
        next.effects = next.effects.map((effect) =>
          effect.id === id
            ? normalizeEffect(
                {
                  ...effect,
                  ...patch,
                  params: { ...effect.params, ...paramsPatch },
                },
                0,
              )
            : effect,
        );
      });
      setActivePreset("custom");
    },
    [updateProject],
  );

  const addEffect = useCallback(
    (kind: CameraEffectKind) => {
      if (effects.length >= MAX_STACK) {
        notify("The live stack is limited to four effects.");
        return;
      }
      const nextEffect = effectForKind(kind);
      updateProject((next) => {
        next.effects = [...next.effects, nextEffect];
      });
      setActiveEffectId(nextEffect.id);
      setActivePreset("custom");
    },
    [effects.length, notify, updateProject],
  );

  const removeEffect = useCallback(
    (id: string) => {
      updateProject((next) => {
        next.effects = next.effects.filter((effect) => effect.id !== id);
      });
      setActiveEffectId((current) => (current === id ? null : current));
      setActivePreset("custom");
    },
    [updateProject],
  );

  const moveEffect = useCallback(
    (id: string, direction: -1 | 1) => {
      updateProject((next) => {
        const index = next.effects.findIndex((effect) => effect.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= next.effects.length) return;
        const reordered = [...next.effects];
        const [moved] = reordered.splice(index, 1);
        reordered.splice(target, 0, moved);
        next.effects = reordered;
      });
      setActivePreset("custom");
    },
    [updateProject],
  );

  const toggleEffect = useCallback(
    (effect: LocalEffect) => {
      const enabledCount = effects.filter((item) => item.enabled).length;
      if (!effect.enabled && enabledCount >= MAX_STACK) {
        notify("The live stack is limited to four enabled effects.");
        return;
      }
      updateEffect(effect.id, { enabled: !effect.enabled });
    },
    [effects, notify, updateEffect],
  );

  const chooseFolder = useCallback(async () => {
    const picker = (window as BrowserWithDirectoryPicker).showDirectoryPicker;
    if (!picker) {
      setErrorMessage(
        "Choose folder is available in Chrome and Edge on localhost or HTTPS.",
      );
      return;
    }
    try {
      const handle = await picker({ mode: "readwrite" });
      folderHandleRef.current = handle;
      setFolderName(handle.name);
      setStatusMessage(`Recording destination: ${handle.name}`);
      notify(`Saving takes to ${handle.name}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not choose a recording folder.",
      );
    }
  }, [notify]);

  const stopRecording = useCallback(async () => {
    const session = recordingSessionRef.current;
    if (!session || cameraMode !== "recording") return;
    setCameraMode("finalizing");
    setStatusMessage("Finalizing effected and clean files…");
    setElapsedMs(performance.now() - recordingStartedRef.current);
    try {
      const result = await session.stop();
      setLastTake(result);
      setStatusMessage(
        "Take saved. Both files are ready for another video editor.",
      );
      setCameraMode("ready");
    } catch (error) {
      setCameraMode("ready");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The take could not be finalized.",
      );
      setStatusMessage(
        "Recording stopped with an error. Any completed file remains in the chosen folder.",
      );
    } finally {
      recordingSessionRef.current = null;
    }
  }, [cameraMode]);

  const startRecording = useCallback(async () => {
    if (cameraMode !== "ready" || !videoStreamRef.current) return;
    if (!folderHandleRef.current) {
      setErrorMessage(
        "Choose a folder before recording so clean and effected files can be written locally.",
      );
      return;
    }
    const directory = folderHandleRef.current;
    const processedCanvas = processedCanvasRef.current;
    const cleanCanvas = cleanCanvasRef.current;
    if (!processedCanvas || !cleanCanvas) return;
    setErrorMessage("");
    const micTrack = micEnabled
      ? micStreamRef.current?.getAudioTracks()[0]
      : undefined;
    try {
      const args: StartCameraRecordingArgs = {
        processedCanvas,
        cleanCanvas,
        micTrack: micTrack ?? null,
        directory,
        basename: `rapidscreen-camera-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        onError: (error) => {
          setErrorMessage(error.message);
          setStatusMessage(
            "Recording encountered an error. Finalizing usable files…",
          );
          setCameraMode("finalizing");
          const activeSession = recordingSessionRef.current;
          if (activeSession) {
            void activeSession
              .stop()
              .then((take) => {
                setLastTake(take);
                setCameraMode("ready");
                setStatusMessage(
                  "Recording stopped after an error. Any completed file remains in the chosen folder.",
                );
              })
              .catch(() => setCameraMode("ready"));
          } else setCameraMode("ready");
        },
      };
      const session = await startCameraRecording(args);
      recordingSessionRef.current = session;
      recordingStartedRef.current = performance.now();
      setElapsedMs(0);
      setCameraMode("recording");
      setStatusMessage(
        `Recording ${nativeMime.includes("mp4") ? "MP4" : "WebM"} clean + effected takes…`,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not start the camera recording.",
      );
    }
  }, [cameraMode, micEnabled, nativeMime, project]);

  const toggleMute = useCallback(() => {
    const nextMuted = !micEnabled;
    setMicEnabled(nextMuted);
    updateProject((next) => {
      next.micEnabled = nextMuted;
    });
    const session = recordingSessionRef.current;
    session?.setMuted(!nextMuted);
    if (nextMuted) {
      micStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      setStatusMessage(
        "Microphone muted. The current take remains video-only until unmuted.",
      );
    } else {
      micStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      setStatusMessage("Microphone enabled for the next recording chunk.");
    }
  }, [micEnabled, updateProject]);

  const saveLook = useCallback(() => {
    const name = draftName.trim() || "Untitled look";
    const draft: CameraDraft = {
      id: makeId("look"),
      name,
      updatedAt: new Date().toISOString(),
      project: persistedProject(project),
    };
    setDrafts((current) =>
      [draft, ...current.filter((item) => item.name !== name)].slice(0, 24),
    );
    setActiveDraftId(draft.id);
    setActivePreset("custom");
    notify(`Saved ${name}`);
  }, [draftName, notify, project]);

  const loadLook = useCallback(
    (draft: CameraDraft) => {
      const loaded = normalizeProject(parseCameraProject(draft.project));
      const keepCaptureSettings =
        cameraMode !== "idle" && cameraMode !== "error";
      const next: LocalProject = keepCaptureSettings
        ? {
            ...loaded,
            width: project.width,
            height: project.height,
            mirror: project.mirror,
            micEnabled: project.micEnabled,
          }
        : loaded;
      setProject(next);
      if (!keepCaptureSettings) {
        setResolution(next.width >= 1920 ? "1080p" : "720p");
        setMicEnabled(next.micEnabled);
      }
      setDraftName(draft.name);
      setActiveDraftId(draft.id);
      setActivePreset("custom");
      setActiveEffectId(next.effects[0]?.id ?? null);
      setShowDrafts(false);
      notify(`Loaded ${draft.name}`);
    },
    [cameraMode, notify, project],
  );

  const deleteLook = useCallback((id: string) => {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
    setActiveDraftId((current) => (current === id ? null : current));
  }, []);

  const convertTake = useCallback(async () => {
    if (!lastTake || !folderHandleRef.current) return;
    const directory = folderHandleRef.current;
    const controller = new AbortController();
    conversionAbortRef.current = controller;
    setConversionState("converting");
    setConversionProgress(0);
    try {
      const converted = await convertCameraTakeToMp4(lastTake, {
        directory,
        basename: lastTake.basename,
        signal: controller.signal,
        onProgress: (value) => setConversionProgress(clamp(value, 0, 1)),
      });
      setLastTake(converted);
      setConversionState("done");
      notify("MP4 copies saved beside the native takes.");
    } catch (error) {
      setConversionState(controller.signal.aborted ? "idle" : "error");
      if (!controller.signal.aborted)
        setErrorMessage(
          error instanceof Error ? error.message : "MP4 conversion failed.",
        );
    } finally {
      conversionAbortRef.current = null;
    }
  }, [lastTake, notify]);

  useEffect(() => {
    if (cameraMode !== "recording") return;
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - recordingStartedRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_TAKE_MS) {
        setStatusMessage("10 minute maximum reached. Finalizing both files…");
        void stopRecording();
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [cameraMode, stopRecording]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!isRecording) return;
      event.preventDefault();
      event.returnValue = "A recording is still in progress.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isRecording]);

  useEffect(
    () => () => {
      conversionAbortRef.current?.abort();
      void recordingSessionRef.current?.stop();
      stopStreams();
    },
    [stopStreams],
  );

  const onResolutionChange = (nextResolution: Resolution) => {
    if (isRecording || cameraMode === "starting") return;
    setResolution(nextResolution);
    const option =
      RESOLUTION_OPTIONS.find((item) => item.id === nextResolution) ??
      RESOLUTION_OPTIONS[0];
    updateProject((next) => {
      next.width = option.width;
      next.height = option.height;
    });
    if (cameraMode === "ready") {
      restartPendingRef.current = true;
      stopStreams();
      setCameraMode("idle");
      setStatusMessage("Applying the new capture size…");
    }
  };

  const onCameraChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setCameraId(event.target.value);
    if (cameraMode === "ready") {
      restartPendingRef.current = true;
      stopStreams();
      setCameraMode("idle");
      setStatusMessage("Applying the selected camera…");
    }
  };
  const onMicrophoneChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setMicrophoneId(event.target.value);
    if (cameraMode === "ready") {
      restartPendingRef.current = true;
      stopStreams();
      setCameraMode("idle");
      setStatusMessage("Applying the selected microphone…");
    }
  };

  return (
    <main className="camera-lab" aria-label="RapidScreen Camera FX Lab">
      <header className="camera-topbar">
        <div className="camera-brand">
          <span className="camera-brand-mark">R</span>
          <span className="camera-brand-name">RAPIDSCREEN</span>
          <span className="camera-brand-product">/ CAMERA FX LAB</span>
        </div>
        <div className="camera-topbar-center">
          <span
            className={`camera-state-dot is-${cameraMode}`}
            aria-hidden="true"
          />
          <span>
            {cameraMode === "recording"
              ? "RECORDING"
              : cameraMode === "finalizing"
                ? "FINALIZING"
                : cameraMode.toUpperCase()}
          </span>
          <span className="camera-topbar-divider" />
          <span>
            {resolutionDetails.width} × {resolutionDetails.height}
          </span>
          <span className="camera-topbar-divider" />
          <span>{FRAME_RATE} FPS</span>
        </div>
        <div className="camera-topbar-actions">
          <button
            type="button"
            className="camera-quiet-button"
            onClick={() => setShowDrafts((open) => !open)}
            aria-expanded={showDrafts}
          >
            <Save size={13} />
            <span>LOOKS</span>
            <ChevronDown size={12} />
          </button>
          <label className="camera-look-name">
            <span className="sr-only">Look name</span>
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              aria-label="Look name"
            />
          </label>
          <button
            type="button"
            className="camera-primary-button camera-save-button"
            onClick={saveLook}
          >
            <Save size={13} /> SAVE LOOK
          </button>
        </div>
        {showDrafts && (
          <div
            className="camera-drafts-popover"
            role="dialog"
            aria-label="Saved camera looks"
          >
            <div className="camera-popover-heading">
              <span>SAVED LOOKS</span>
              <button
                type="button"
                onClick={() => setShowDrafts(false)}
                aria-label="Close looks"
              >
                <X size={13} />
              </button>
            </div>
            {drafts.length === 0 ? (
              <p className="camera-empty-copy">No local looks yet.</p>
            ) : (
              drafts.map((draft) => (
                <div className="camera-draft-row" key={draft.id}>
                  <button
                    type="button"
                    onClick={() => loadLook(draft)}
                    className="camera-draft-load"
                  >
                    <strong>{draft.name}</strong>
                    <small>{new Date(draft.updatedAt).toLocaleString()}</small>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteLook(draft.id)}
                    className="camera-draft-delete"
                    aria-label={`Delete ${draft.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </header>

      <section className="camera-studio-grid">
        <aside className="camera-panel camera-panel-left">
          <div className="camera-panel-heading">
            <span>PRESETS</span>
            <span className="camera-count">
              {PRESET_OPTIONS.length.toString().padStart(2, "0")}
            </span>
          </div>
          <div className="camera-preset-list">
            {PRESET_OPTIONS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className={`camera-preset-card ${activePreset === preset.id ? "is-active" : ""}`}
                onClick={() => applyPreset(preset.id)}
              >
                <span className="camera-preset-glyph">{preset.glyph}</span>
                <span className="camera-preset-copy">
                  <strong>{preset.label}</strong>
                  <small>{preset.detail}</small>
                </span>
                {activePreset === preset.id && (
                  <Check size={13} className="camera-preset-check" />
                )}
              </button>
            ))}
          </div>

          <div className="camera-stack-heading">
            <span>EFFECT STACK</span>
            <span className="camera-count">
              {effects.length.toString().padStart(2, "0")} / {MAX_STACK}
            </span>
          </div>
          <div className="camera-effect-list">
            {effects.map((effect, index) => (
              <div
                key={effect.id}
                className={`camera-effect-row ${activeEffect?.id === effect.id ? "is-selected" : ""} ${effect.enabled ? "" : "is-disabled"}`}
              >
                <button
                  type="button"
                  className="camera-effect-select"
                  onClick={() => setActiveEffectId(effect.id)}
                  aria-label={`Edit ${effectLabel(effect.kind)} effect`}
                >
                  <GripVertical size={13} className="camera-grip" />
                  <span className="camera-effect-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="camera-effect-copy">
                    <strong>{effectLabel(effect.kind)}</strong>
                    <small>{effect.enabled ? "ACTIVE" : "BYPASSED"}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`camera-effect-toggle ${effect.enabled ? "is-on" : ""}`}
                  onClick={() => toggleEffect(effect)}
                  aria-pressed={effect.enabled}
                  aria-label={`${effect.enabled ? "Disable" : "Enable"} ${effectLabel(effect.kind)}`}
                >
                  <span />
                </button>
              </div>
            ))}
          </div>
          <div className="camera-add-effect-control">
            <span className="camera-field-label">ADD EFFECT</span>
            <div className="camera-effect-add-row">
              <select
                aria-label="Add effect"
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value) {
                    addEffect(event.target.value as CameraEffectKind);
                    event.target.value = "";
                  }
                }}
                disabled={effects.length >= MAX_STACK}
              >
                <option value="">Choose…</option>
                {EFFECT_OPTIONS.map((option) => (
                  <option value={option.id} key={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="camera-icon-button"
                onClick={() => addEffect("ascii")}
                disabled={effects.length >= MAX_STACK}
                aria-label="Add ASCII effect"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
          <div className="camera-left-footer">
            <span>
              <Zap size={12} /> GPU PIPELINE
            </span>
            <span>WEBGL2</span>
          </div>
        </aside>

        <section className="camera-stage" aria-label="Camera preview">
          <div className="camera-stage-toolbar">
            <div className="camera-toolbar-group">
              <span className="camera-toolbar-kicker">LIVE VIEW</span>
              <span className="camera-toolbar-divider" />
              <span className="camera-toolbar-meta">
                {project.mirror ? "MIRRORED" : "DIRECT"}
              </span>
            </div>
            <div className="camera-toolbar-group camera-toolbar-right">
              <button
                type="button"
                className={`camera-view-toggle ${previewLayer === "effected" ? "is-active" : ""}`}
                onClick={() => setPreviewLayer("effected")}
              >
                <MonitorDown size={13} /> EFFECTED
              </button>
              <button
                type="button"
                className={`camera-view-toggle ${previewLayer === "clean" ? "is-active" : ""}`}
                onClick={() => setPreviewLayer("clean")}
              >
                <Video size={13} /> CLEAN
              </button>
              <span className="camera-fps-readout">
                <span className={fps > 0 && fps < 24 ? "is-warning" : ""}>
                  {fps || "--"}
                </span>{" "}
                FPS
              </span>
            </div>
          </div>
          <div className="camera-stage-preview">
            <div className="camera-preview-frame" data-resolution={resolution}>
              <video
                ref={videoRef}
                className="camera-source-video"
                aria-hidden="true"
                muted
                playsInline
              />
              <canvas
                ref={processedCanvasRef}
                className={`camera-preview-canvas ${previewLayer === "effected" ? "is-visible" : "is-hidden"}`}
                aria-label="Effected camera preview"
              />
              <canvas
                ref={cleanCanvasRef}
                className={`camera-preview-canvas ${previewLayer === "clean" ? "is-visible" : "is-hidden"}`}
                aria-label="Clean camera preview"
              />
              {cameraMode === "idle" || cameraMode === "error" ? (
                <div className="camera-preview-empty">
                  <Camera size={28} />
                  <strong>CAMERA INPUT OFFLINE</strong>
                  <span>
                    {fontsReady
                      ? "Start Camera to request local device access."
                      : "Loading local camera fonts…"}
                  </span>
                  <button
                    type="button"
                    className="camera-primary-button"
                    onClick={startCamera}
                    disabled={!fontsReady}
                  >
                    <Camera size={14} />{" "}
                    {fontsReady ? "START CAMERA" : "LOADING FONTS"}
                  </button>
                </div>
              ) : cameraMode === "starting" ? (
                <div className="camera-preview-empty">
                  <Loader2 size={26} className="camera-spin" />
                  <strong>OPENING DEVICE</strong>
                  <span>Waiting for camera permission…</span>
                </div>
              ) : null}
              <span className="camera-frame-corner camera-frame-corner-tl">
                {project.mirror ? "MIRROR // ON" : "MIRROR // OFF"}
              </span>
              <span className="camera-frame-corner camera-frame-corner-tr">
                {resolutionDetails.width}×{resolutionDetails.height}
              </span>
              <span className="camera-frame-corner camera-frame-corner-bl">
                {activePreset === "custom"
                  ? "CUSTOM LOOK"
                  : activePreset.toUpperCase()}
              </span>
              <span className="camera-frame-corner camera-frame-corner-br">
                {isRecording ? "● REC" : "READY"}
              </span>
            </div>
            {fps > 0 && fps < 24 && cameraMode === "ready" && (
              <div className="camera-performance-note">
                <AlertTriangle size={13} /> Preview is below 24 FPS. 720p is
                recommended for a smoother take.
              </div>
            )}
          </div>
          <div className="camera-preview-status">
            <span>
              <span className={`camera-status-light is-${cameraMode}`} />
              {statusMessage}
            </span>
            <span className="camera-timecode">
              {formatDuration(elapsedMs)} / 10:00 MAX
            </span>
          </div>
        </section>

        <aside className="camera-panel camera-panel-right">
          <div className="camera-panel-heading">
            <span>INSPECTOR</span>
            <Settings2 size={13} />
          </div>
          {activeEffect ? (
            <>
              <div className="camera-inspector-section camera-inspector-effect-heading">
                <div>
                  <span className="camera-field-label">SELECTED EFFECT</span>
                  <strong>{effectLabel(activeEffect.kind)}</strong>
                </div>
                <button
                  type="button"
                  className="camera-icon-button is-danger"
                  onClick={() => removeEffect(activeEffect.id)}
                  aria-label="Remove selected effect"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="camera-inspector-section">
                <label className="camera-range-field">
                  <span>
                    <span>STRENGTH</span>
                    <output>{Math.round(activeEffect.strength * 100)}%</output>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={activeEffect.strength}
                    onChange={(event) =>
                      updateEffect(activeEffect.id, {
                        strength: Number(event.target.value),
                      })
                    }
                  />
                </label>
                {activeEffect.kind === "ascii" && (
                  <>
                    <label className="camera-range-field">
                      <span>
                        <span>CELL SIZE</span>
                        <output>
                          {Math.round(activeEffect.params.cellSize)} PX
                        </output>
                      </span>
                      <input
                        type="range"
                        min="2"
                        max="64"
                        step="1"
                        value={activeEffect.params.cellSize}
                        onChange={(event) =>
                          updateEffect(
                            activeEffect.id,
                            {},
                            { cellSize: Number(event.target.value) },
                          )
                        }
                      />
                    </label>
                    <label className="camera-range-field">
                      <span>
                        <span>CONTRAST</span>
                        <output>
                          {activeEffect.params.contrast.toFixed(2)}
                        </output>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="3"
                        step="0.01"
                        value={activeEffect.params.contrast}
                        onChange={(event) =>
                          updateEffect(
                            activeEffect.id,
                            {},
                            { contrast: Number(event.target.value) },
                          )
                        }
                      />
                    </label>
                    <label className="camera-range-field">
                      <span>
                        <span>SCANLINE</span>
                        <output>
                          {Math.round(activeEffect.params.scanline * 100)}%
                        </output>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={activeEffect.params.scanline}
                        onChange={(event) =>
                          updateEffect(
                            activeEffect.id,
                            {},
                            { scanline: Number(event.target.value) },
                          )
                        }
                      />
                    </label>
                  </>
                )}
                {(activeEffect.kind === "flir" ||
                  activeEffect.kind === "heat") && (
                  <label className="camera-range-field">
                    <span>
                      <span>THRESHOLD</span>
                      <output>
                        {Math.round(activeEffect.params.threshold * 100)}%
                      </output>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={activeEffect.params.threshold}
                      onChange={(event) =>
                        updateEffect(
                          activeEffect.id,
                          {},
                          { threshold: Number(event.target.value) },
                        )
                      }
                    />
                  </label>
                )}
                {activeEffect.kind === "depth" && (
                  <label className="camera-range-field">
                    <span>
                      <span>EDGE MIX</span>
                      <output>
                        {Math.round(activeEffect.params.edge * 100)}%
                      </output>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={activeEffect.params.edge}
                      onChange={(event) =>
                        updateEffect(
                          activeEffect.id,
                          {},
                          { edge: Number(event.target.value) },
                        )
                      }
                    />
                  </label>
                )}
                {activeEffect.kind === "rgb-signal" && (
                  <>
                    <label className="camera-range-field">
                      <span>
                        <span>CHANNEL OFFSET</span>
                        <output>
                          {Math.round(activeEffect.params.channelOffset)} PX
                        </output>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="48"
                        step="1"
                        value={activeEffect.params.channelOffset}
                        onChange={(event) =>
                          updateEffect(
                            activeEffect.id,
                            {},
                            { channelOffset: Number(event.target.value) },
                          )
                        }
                      />
                    </label>
                    <label className="camera-range-field">
                      <span>
                        <span>NOISE</span>
                        <output>
                          {Math.round(activeEffect.params.noise * 100)}%
                        </output>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={activeEffect.params.noise}
                        onChange={(event) =>
                          updateEffect(
                            activeEffect.id,
                            {},
                            { noise: Number(event.target.value) },
                          )
                        }
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="camera-inspector-section camera-reorder-actions">
                <button
                  type="button"
                  className="camera-quiet-button"
                  disabled={activeEffectIndex <= 0}
                  onClick={() => moveEffect(activeEffect.id, -1)}
                >
                  <ArrowUp size={13} /> MOVE UP
                </button>
                <button
                  type="button"
                  className="camera-quiet-button"
                  disabled={
                    activeEffectIndex < 0 ||
                    activeEffectIndex >= effects.length - 1
                  }
                  onClick={() => moveEffect(activeEffect.id, 1)}
                >
                  <ArrowDown size={13} /> MOVE DOWN
                </button>
              </div>
            </>
          ) : (
            <div className="camera-empty-inspector">
              <SlidersHorizontal size={17} />
              <span>Add an effect to inspect its controls.</span>
            </div>
          )}

          <div className="camera-inspector-section">
            <div className="camera-section-heading">
              <span>COLOUR LOOK</span>
              <span className="camera-count">LUT</span>
            </div>
            <label className="camera-range-field">
              <span>
                <span>LOOK STRENGTH</span>
                <output>{Math.round(project.lookStrength * 100)}%</output>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={project.lookStrength}
                onChange={(event) =>
                  updateProject((next) => {
                    next.lookStrength = Number(event.target.value);
                  })
                }
              />
            </label>
            <div className="camera-lut-grid">
              {LUT_OPTIONS.map((look) => (
                <button
                  type="button"
                  key={look.id}
                  className={`camera-lut-chip ${project.look === look.id ? "is-active" : ""}`}
                  onClick={() =>
                    updateProject((next) => {
                      next.look = look.id;
                    })
                  }
                >
                  <span style={{ backgroundColor: look.colour }} />
                  {look.label}
                </button>
              ))}
            </div>
          </div>
          <div className="camera-inspector-section camera-style-note">
            <AlertTriangle size={13} />
            <span>
              FLIR and depth are visual styles. A normal webcam does not measure
              temperature or true distance.
            </span>
          </div>
        </aside>
      </section>

      <section
        className="camera-control-dock"
        aria-label="Camera and recording controls"
      >
        <div className="camera-control-group camera-device-group">
          <label className="camera-field camera-field-device">
            <span className="camera-field-label">CAMERA</span>
            <select
              value={cameraId}
              onChange={onCameraChange}
              disabled={isRecording || cameraMode === "starting"}
            >
              <option value="">Default camera</option>
              {cameraDevices.map((device) => (
                <option value={device.deviceId} key={device.deviceId}>
                  {device.label || `Camera ${device.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="camera-field camera-field-device">
            <span className="camera-field-label">MICROPHONE</span>
            <select
              value={microphoneId}
              onChange={onMicrophoneChange}
              disabled={isRecording || cameraMode === "starting" || !micEnabled}
            >
              <option value="">Default microphone</option>
              {microphones.map((device) => (
                <option value={device.deviceId} key={device.deviceId}>
                  {device.label || `Mic ${device.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="camera-control-group camera-capture-group">
          <div
            className="camera-resolution-toggle"
            role="group"
            aria-label="Capture resolution"
          >
            {RESOLUTION_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={resolution === option.id ? "is-active" : ""}
                disabled={isRecording || cameraMode === "starting"}
                onClick={() => onResolutionChange(option.id)}
              >
                {option.id}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`camera-toggle-button ${project.mirror ? "is-active" : ""}`}
            onClick={() =>
              updateProject((next) => {
                next.mirror = !next.mirror;
              })
            }
            disabled={isRecording}
          >
            <RotateCcw size={13} /> MIRROR
          </button>
          <button
            type="button"
            className={`camera-toggle-button ${micEnabled ? "is-active" : ""}`}
            onClick={toggleMute}
            disabled={cameraMode === "idle" || cameraMode === "starting"}
          >
            {micEnabled ? <Mic size={13} /> : <MicOff size={13} />}{" "}
            {micEnabled ? "MIC ON" : "MIC MUTED"}
          </button>
        </div>
        <div className="camera-control-group camera-record-group">
          <div
            className="camera-format-status"
            aria-label={`Native output ${nativeMime.includes("mp4") ? "MP4" : "WebM"}`}
          >
            <span className="camera-field-label">OUTPUT</span>
            <strong>
              {nativeMime.includes("mp4") ? "MP4 / H.264" : "WEBM / VP9"}
            </strong>
          </div>
          <div className="camera-folder-status">
            <FolderOpen size={14} />
            <span>{folderName || "NO FOLDER SELECTED"}</span>
          </div>
          <button
            type="button"
            className="camera-quiet-button"
            onClick={chooseFolder}
            disabled={isRecording}
          >
            <FolderOpen size={13} /> CHOOSE FOLDER
          </button>
          {cameraMode === "idle" || cameraMode === "error" ? (
            <button
              type="button"
              className="camera-primary-button"
              onClick={startCamera}
              disabled={!fontsReady}
            >
              <Camera size={14} />{" "}
              {fontsReady ? "START CAMERA" : "LOADING FONTS"}
            </button>
          ) : (
            <button
              type="button"
              className="camera-quiet-button"
              onClick={stopCamera}
              disabled={isRecording || cameraMode === "starting"}
            >
              <VideoOff size={13} /> STOP CAMERA
            </button>
          )}
          {cameraMode === "recording" ? (
            <button
              type="button"
              className="camera-record-button is-recording"
              onClick={() => void stopRecording()}
            >
              <CircleStop size={15} /> STOP & SAVE{" "}
              <span>{formatDuration(elapsedMs)}</span>
            </button>
          ) : (
            <button
              type="button"
              className="camera-record-button"
              onClick={() => void startRecording()}
              disabled={cameraMode !== "ready" || !folderName}
            >
              <span className="camera-record-dot" /> RECORD
            </button>
          )}
        </div>
      </section>

      {(errorMessage || audioDenied) && (
        <div className="camera-alert-bar" role="status">
          <AlertTriangle size={14} />
          <span>
            {errorMessage ||
              "Microphone access was denied. You can continue with video-only recording."}
          </span>
          <button
            type="button"
            onClick={() => {
              setErrorMessage("");
              setAudioDenied(false);
            }}
            aria-label="Dismiss alert"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {lastTake && (
        <section className="camera-take-result" aria-label="Latest camera take">
          <div className="camera-take-heading">
            <div>
              <span className="camera-field-label">LATEST TAKE</span>
              <strong>
                {formatBytes(takeBytes)} ·{" "}
                {lastTake.mimeType.startsWith("video/mp4") ? "MP4" : "WEBM"}
                {lastTake.hasAudio ? " + AUDIO" : " · VIDEO ONLY"}
              </strong>
            </div>
            <div className="camera-take-actions">
              {!lastTake.mimeType.startsWith("video/mp4") && (
                <>
                  {conversionState === "converting" ? (
                    <button
                      type="button"
                      className="camera-quiet-button"
                      onClick={() => conversionAbortRef.current?.abort()}
                    >
                      <Loader2 size={13} className="camera-spin" /> CANCEL{" "}
                      {Math.round(conversionProgress * 100)}%
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="camera-quiet-button"
                      onClick={() => void convertTake()}
                    >
                      <RefreshCw size={13} /> CONVERT MP4
                    </button>
                  )}
                </>
              )}
              {conversionState === "done" && (
                <span className="camera-success-label">
                  <Check size={13} /> MP4 READY
                </span>
              )}
            </div>
          </div>
          <div className="camera-take-videos">
            {takeUrls.effected && (
              <label>
                <span>EFFECTED</span>
                <video src={takeUrls.effected} controls playsInline />
              </label>
            )}
            {takeUrls.clean && (
              <label>
                <span>CLEAN</span>
                <video src={takeUrls.clean} controls playsInline />
              </label>
            )}
          </div>
        </section>
      )}

      {toast && (
        <div className="camera-toast" role="status">
          <Check size={13} /> {toast}
        </div>
      )}
    </main>
  );
}
