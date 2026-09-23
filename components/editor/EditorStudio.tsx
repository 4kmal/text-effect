"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  Diamond,
  Download,
  Eye,
  EyeOff,
  FileDown,
  FilePlus2,
  GripVertical,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Plus,
  Redo2,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createPreset,
  FONT_FAMILIES,
  parseProject,
  PRESETS,
} from "@/components/editor/core/model";
import type {
  EffectKind,
  FontId,
  Keyframe,
  TextFxProject,
  TextLayer,
} from "@/components/editor/core/model";
import { renderFrame } from "@/components/editor/core/render";
import {
  exportProject,
  type ExportFormat,
} from "@/components/editor/export/exportProject";

type UiProject = TextFxProject;
type UiLayer = TextLayer;
type UiKeyframe = Keyframe;

type Draft = {
  id: string;
  name: string;
  updatedAt: string;
  project: TextFxProject;
};

type BackgroundKind = "solid" | "gradient" | "pattern" | "transparent";
type KeyProperty = "x" | "y" | "scale" | "rotation" | "opacity" | "intensity";
type DimensionPreset = "wide" | "portrait" | "square";

type DragState = {
  layerId: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  scale: number;
};

type KeyframeDragState = {
  layerId: string;
  index: number;
  left: number;
  width: number;
};

const STORAGE_KEY = "rapidscreen-textfx-drafts-v1";
const MAX_HISTORY = 50;
const EFFECTS: Array<{ id: EffectKind; label: string; hint: string }> = [
  { id: "scramble" as EffectKind, label: "Scramble", hint: "signal resolve" },
  {
    id: "typewriter" as EffectKind,
    label: "Typewriter",
    hint: "character reveal",
  },
  {
    id: "ascii" as EffectKind,
    label: "ASCII raster",
    hint: "scanline texture",
  },
  { id: "led" as EffectKind, label: "LED marquee", hint: "continuous scroll" },
  { id: "wave" as EffectKind, label: "Wave", hint: "soft modulation" },
  { id: "glitch" as EffectKind, label: "RGB glitch", hint: "channel split" },
];

const PRESET_OPTIONS = PRESETS;

const FONT_LABELS: Record<FontId, string> = {
  departure: "Departure Mono",
  geist: "Geist Mono",
  "press-start": "Press Start 2P",
};

const FONT_OPTIONS = (Object.keys(FONT_FAMILIES) as FontId[]).map((id) => ({
  id,
  label: FONT_LABELS[id],
}));

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const makeId = (prefix: string) => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
};

const getLayers = (project: UiProject | null): UiLayer[] =>
  project?.layers ?? [];

const getLayerId = (layer: UiLayer | null | undefined) => layer?.id ?? "";

const getCanvasSize = (project: UiProject | null) => ({
  width: Math.max(1, project?.width ?? 1280),
  height: Math.max(1, project?.height ?? 720),
});

const setCanvasSize = (project: UiProject, width: number, height: number) => {
  project.width = width;
  project.height = height;
};

const getDuration = (project: UiProject | null) => {
  return Math.min(30000, Math.max(500, project?.durationMs ?? 6000));
};

const setDuration = (project: UiProject, durationMs: number) => {
  project.durationMs = durationMs;
  project.layers = project.layers.map((layer) => {
    const startMs = Math.min(
      Math.max(0, layer.startMs),
      Math.max(0, durationMs - 1),
    );
    const endMs = Math.min(durationMs, Math.max(startMs + 1, layer.endMs));
    return {
      ...layer,
      startMs,
      endMs,
      keyframes: layer.keyframes.map((keyframe) => ({
        ...keyframe,
        timeMs: Math.min(durationMs, Math.max(0, keyframe.timeMs)),
      })),
    };
  });
};

const setLayerTiming = (
  layer: UiLayer,
  field: "startMs" | "endMs",
  value: number,
  durationMs: number,
) => {
  if (field === "startMs") {
    layer.startMs = Math.min(
      Math.max(0, Math.round(value)),
      Math.max(0, layer.endMs - 1),
    );
  } else {
    layer.endMs = Math.min(
      durationMs,
      Math.max(layer.startMs + 1, Math.round(value)),
    );
  }
};

const getBackground = (project: UiProject | null) => {
  const source = project?.background;
  const kind = source?.kind ?? "solid";
  return {
    type: kind,
    color: source?.color ?? "#0a0c0e",
    color2: source?.color2 ?? "#1b2328",
  };
};

const setBackground = (
  project: UiProject,
  value: { type: BackgroundKind; color: string; color2: string },
) => {
  project.background = {
    ...project.background,
    kind: value.type,
    color: value.color,
    color2: value.color2,
  };
};

const getKeyframes = (layer: UiLayer): UiKeyframe[] => layer.keyframes;

const getKeyframeTime = (keyframe: UiKeyframe) => keyframe.timeMs;

const setKeyframeTime = (keyframe: UiKeyframe, timeMs: number) => {
  keyframe.timeMs = Math.round(timeMs);
};

const getLayerValue = (layer: UiLayer, property: KeyProperty) => {
  const defaults: Record<KeyProperty, number> = {
    x: 960,
    y: 540,
    scale: 1,
    rotation: 0,
    opacity: 1,
    intensity: 0.65,
  };
  const value = Number(layer[property]);
  return Number.isFinite(value) ? value : defaults[property];
};

const makeLayer = (
  project: UiProject,
  effect: EffectKind = "scramble",
  index = 0,
): UiLayer => ({
  id: makeId("layer"),
  name: `${effect === "scramble" ? "Signal" : effect} layer ${index + 1}`,
  text: effect === "led" ? "RAPIDSCREEN / TEXT FX LAB" : "MAKE IT MOVE",
  effect,
  font: FONT_OPTIONS[0]?.id ?? "departure",
  fontSize: effect === "ascii" ? 42 : 96,
  color: effect === "glitch" ? "#ff4f28" : "#f26622",
  startMs: 0,
  endMs: project.durationMs,
  visible: true,
  x: project.width / 2,
  y: project.height / 2,
  scale: 1,
  rotation: 0,
  opacity: 1,
  intensity: 0.65,
  align: "center",
  keyframes: [],
});

const projectFromPreset = (id: string) => {
  return createPreset(id as EffectKind);
};

const formatTime = (milliseconds: number) => {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${seconds.toFixed(2).padStart(5, "0")}s`;
};

const formatDimension = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);

const downloadBlob = (blob: Blob, filename: string) => {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
};

export default function EditorStudio() {
  const [project, setProject] = useState<UiProject | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<KeyProperty>("x");
  const [selectedKeyframe, setSelectedKeyframe] = useState<{
    layerId: string;
    index: number;
  } | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("Untitled sequence");
  const [historyPast, setHistoryPast] = useState<UiProject[]>([]);
  const [historyFuture, setHistoryFuture] = useState<UiProject[]>([]);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("webm");
  const [exportScale, setExportScale] = useState(1);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState<
    "idle" | "exporting" | "done" | "error"
  >("idle");
  const [exportError, setExportError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [showDrafts, setShowDrafts] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [keyframeDrag, setKeyframeDrag] = useState<KeyframeDragState | null>(
    null,
  );
  const [toast, setToast] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<number | null>(null);

  const durationMs = getDuration(project);
  const layers = getLayers(project);
  const activeLayer =
    layers.find((layer) => getLayerId(layer) === activeLayerId) ??
    layers[0] ??
    null;
  const canvasSize = getCanvasSize(project);
  const background = getBackground(project);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(
      () => setToast((current) => (current === message ? "" : current)),
      2200,
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    const initialize = async () => {
      if (typeof document !== "undefined" && document.fonts?.ready) {
        await document.fonts.ready;
        await Promise.all(
          ["Departure Mono", "Geist Mono", "Press Start 2P"].map((font) =>
            document.fonts.load(`16px "${font}"`).catch(() => undefined),
          ),
        );
      }
      if (!mounted) return;
      setFontsReady(true);
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const stored = JSON.parse(raw) as unknown;
          if (Array.isArray(stored)) {
            const restored = stored
              .map((draft) => {
                if (!draft || typeof draft !== "object" || Array.isArray(draft))
                  return null;
                const item = draft as {
                  id?: unknown;
                  name?: unknown;
                  updatedAt?: unknown;
                  project?: unknown;
                };
                try {
                  const parsed = parseProject(item.project) as TextFxProject;
                  return {
                    id: String(item.id ?? makeId("draft")),
                    name: String(item.name ?? "Untitled sequence"),
                    updatedAt: String(
                      item.updatedAt ?? new Date().toISOString(),
                    ),
                    project: parsed,
                  } satisfies Draft;
                } catch {
                  return null;
                }
              })
              .filter(Boolean) as Draft[];
            if (restored.length > 0) {
              setDrafts(restored);
              const latest = restored[0];
              setActiveDraftId(latest.id);
              setDraftName(latest.name);
              setProject(latest.project);
              setActiveLayerId(latest.project.layers[0]?.id ?? null);
              return;
            }
          }
        }
      } catch {
        // Browser storage can be disabled; the editor still works in-memory.
      }
      const initial = projectFromPreset("scramble");
      setProject(initial);
      setActiveLayerId(initial.layers[0]?.id ?? null);
    };
    void initialize();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!project || !activeLayerId) return;
    if (!layers.some((layer) => getLayerId(layer) === activeLayerId)) {
      setActiveLayerId(layers[0]?.id ?? null);
    }
  }, [activeLayerId, layers, project]);

  const recordHistory = useCallback(() => {
    if (!project) return;
    setHistoryPast((past) => [...past, clone(project)].slice(-MAX_HISTORY));
    setHistoryFuture([]);
  }, [project]);

  const mutateProject = useCallback(
    (
      mutator: (draft: UiProject) => void,
      options: { history?: boolean } = {},
    ) => {
      setProject((current) => {
        if (!current) return current;
        if (options.history !== false) {
          setHistoryPast((past) =>
            [...past, clone(current)].slice(-MAX_HISTORY),
          );
          setHistoryFuture([]);
        }
        const next = clone(current);
        mutator(next);
        return next;
      });
    },
    [],
  );

  const undo = useCallback(() => {
    const previous = historyPast[historyPast.length - 1];
    if (!project || !previous) return;
    setHistoryPast((past) => past.slice(0, -1));
    setHistoryFuture((future) =>
      [clone(project), ...future].slice(0, MAX_HISTORY),
    );
    setProject(clone(previous));
  }, [historyPast, project]);

  const redo = useCallback(() => {
    const next = historyFuture[0];
    if (!project || !next) return;
    setHistoryFuture((future) => future.slice(1));
    setHistoryPast((past) => [...past, clone(project)].slice(-MAX_HISTORY));
    setProject(clone(next));
  }, [historyFuture, project]);

  useEffect(() => {
    if (!project || !fontsReady) return;
    if (pendingSaveRef.current) window.clearTimeout(pendingSaveRef.current);
    pendingSaveRef.current = window.setTimeout(() => {
      const nextDraft: Draft = {
        id: activeDraftId ?? makeId("draft"),
        name: draftName.trim() || "Untitled sequence",
        updatedAt: new Date().toISOString(),
        project: clone(project),
      };
      setActiveDraftId(nextDraft.id);
      setDrafts((current) => {
        const without = current.filter((draft) => draft.id !== nextDraft.id);
        const next = [nextDraft, ...without].slice(0, 12);
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Keep the current project usable if quota or privacy mode blocks storage.
        }
        return next;
      });
    }, 500);
    return () => {
      if (pendingSaveRef.current) window.clearTimeout(pendingSaveRef.current);
    };
  }, [activeDraftId, draftName, fontsReady, project]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !project || !fontsReady) return;
    const { width, height } = getCanvasSize(project);
    canvas.width = width;
    canvas.height = height;
    const frame = window.requestAnimationFrame(() => {
      try {
        renderFrame(project, currentTimeMs, canvas, { scale: 1 });
        setRenderError("");
      } catch (error) {
        const context = canvas.getContext("2d");
        context?.clearRect(0, 0, canvas.width, canvas.height);
        setRenderError(
          error instanceof Error ? error.message : "Preview render failed",
        );
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentTimeMs, fontsReady, project]);

  useEffect(() => {
    if (!isPlaying) {
      lastFrameRef.current = null;
      return;
    }
    let animationFrame = 0;
    const tick = (now: number) => {
      if (lastFrameRef.current === null) lastFrameRef.current = now;
      const elapsed = now - lastFrameRef.current;
      lastFrameRef.current = now;
      setCurrentTimeMs((time) => (time + elapsed) % durationMs);
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [durationMs, isPlaying]);

  const updateLayer = useCallback(
    (
      layerId: string,
      updater: (layer: UiLayer) => void,
      options?: { history?: boolean },
    ) => {
      mutateProject((draft) => {
        const match = getLayers(draft).find(
          (layer) => getLayerId(layer) === layerId,
        );
        if (match) updater(match);
      }, options);
    },
    [mutateProject],
  );

  const upsertKeyframe = useCallback(
    (
      layer: UiLayer,
      timeMs: number,
      property?: KeyProperty,
      value?: number,
    ) => {
      const keyframes = getKeyframes(layer);
      const rounded = Math.max(0, Math.min(durationMs, Math.round(timeMs)));
      let keyframe = keyframes.find(
        (candidate) => Math.abs(getKeyframeTime(candidate) - rounded) < 45,
      );
      if (!keyframe) {
        keyframe = {
          id: makeId("key"),
          timeMs: rounded,
          easing: "easeInOut",
          x: getLayerValue(layer, "x"),
          y: getLayerValue(layer, "y"),
          scale: getLayerValue(layer, "scale"),
          rotation: getLayerValue(layer, "rotation"),
          opacity: getLayerValue(layer, "opacity"),
          intensity: getLayerValue(layer, "intensity"),
        } as UiKeyframe;
        keyframes.push(keyframe);
      }
      setKeyframeTime(keyframe, rounded);
      if (property)
        keyframe[property] = value ?? getLayerValue(layer, property);
      keyframes.sort((a, b) => getKeyframeTime(a) - getKeyframeTime(b));
      layer.keyframes = keyframes;
      return keyframes.indexOf(keyframe);
    },
    [durationMs],
  );

  const addKeyframe = (layerId: string, property?: KeyProperty) => {
    const time = currentTimeMs;
    recordHistory();
    updateLayer(
      layerId,
      (layer) => {
        const value = property ? getLayerValue(layer, property) : undefined;
        upsertKeyframe(layer, time, property, value);
      },
      { history: false },
    );
    notify(
      property ? `${property} keyframe added` : "Transform keyframe added",
    );
  };

  const updateKeyedValue = (
    layerId: string,
    property: KeyProperty,
    value: number,
    history = true,
  ) => {
    updateLayer(
      layerId,
      (layer) => {
        const keyframes = getKeyframes(layer);
        const current = keyframes.find(
          (keyframe) =>
            Math.abs(getKeyframeTime(keyframe) - currentTimeMs) < 45,
        );
        if (current) {
          current[property] = value;
        } else if (keyframes.length > 0) {
          upsertKeyframe(layer, currentTimeMs, property, value);
        } else {
          layer[property] = value;
        }
      },
      { history },
    );
  };

  const handleCanvasPointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (
      !activeLayer ||
      !canvasFrameRef.current ||
      activeLayer.visible === false
    )
      return;
    const rect = event.currentTarget.getBoundingClientRect();
    recordHistory();
    setDragState({
      layerId: getLayerId(activeLayer),
      startX: event.clientX,
      startY: event.clientY,
      originX: getLayerValue(activeLayer, "x"),
      originY: getLayerValue(activeLayer, "y"),
      scale: rect.width / Math.max(1, canvasSize.width),
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (!dragState) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx =
      ((event.clientX - dragState.startX) / Math.max(1, rect.width)) *
      canvasSize.width;
    const dy =
      ((event.clientY - dragState.startY) / Math.max(1, rect.height)) *
      canvasSize.height;
    updateKeyedValue(
      dragState.layerId,
      "x",
      Math.min(canvasSize.width, Math.max(0, dragState.originX + dx)),
      false,
    );
    updateKeyedValue(
      dragState.layerId,
      "y",
      Math.min(canvasSize.height, Math.max(0, dragState.originY + dy)),
      false,
    );
  };

  const handleCanvasPointerUp = () => setDragState(null);

  const scrub = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setCurrentTimeMs(Math.round(ratio * durationMs));
  };

  const handleTimelinePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if ((event.target as HTMLElement).closest(".fx-keyframe-dot")) return;
    scrub(event.clientX, event.currentTarget);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleKeyframePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    layerId: string,
    index: number,
  ) => {
    const track = event.currentTarget.parentElement;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    recordHistory();
    setSelectedKeyframe({ layerId, index });
    setKeyframeDrag({ layerId, index, left: rect.left, width: rect.width });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  };

  const handleKeyframePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!keyframeDrag) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - keyframeDrag.left) / keyframeDrag.width),
    );
    const nextTime = Math.round(ratio * durationMs);
    mutateProject(
      (draft) => {
        const layer = getLayers(draft).find(
          (item) => getLayerId(item) === keyframeDrag.layerId,
        );
        const keyframe = layer && getKeyframes(layer)[keyframeDrag.index];
        if (keyframe) setKeyframeTime(keyframe, nextTime);
      },
      { history: false },
    );
    setCurrentTimeMs(nextTime);
  };

  const handleKeyframePointerUp = () => setKeyframeDrag(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input, textarea, select"))
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        redo();
      } else if (event.key === " ") {
        event.preventDefault();
        setIsPlaying((playing) => !playing);
      } else if (event.key === "ArrowLeft") {
        setCurrentTimeMs((time) => Math.max(0, time - 100));
      } else if (event.key === "ArrowRight") {
        setCurrentTimeMs((time) => Math.min(durationMs, time + 100));
      } else if (event.key === "Delete" && selectedKeyframe && project) {
        recordHistory();
        mutateProject(
          (draft) => {
            const layer = getLayers(draft).find(
              (item) => getLayerId(item) === selectedKeyframe.layerId,
            );
            if (layer)
              layer.keyframes = getKeyframes(layer).filter(
                (_, index) => index !== selectedKeyframe.index,
              );
          },
          { history: false },
        );
        setSelectedKeyframe(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    durationMs,
    mutateProject,
    project,
    recordHistory,
    redo,
    selectedKeyframe,
    undo,
  ]);

  const selectPreset = (id: string) => {
    const next = projectFromPreset(id);
    recordHistory();
    setProject(next);
    setCurrentTimeMs(0);
    setActiveLayerId(next.layers[0]?.id ?? null);
    setSelectedKeyframe(null);
    notify("Preset loaded");
  };

  const addLayer = () => {
    if (!project) return;
    const next = makeLayer(project, "scramble", layers.length);
    recordHistory();
    mutateProject(
      (draft) => {
        const target = getLayers(draft);
        target.push(next);
        draft.layers = target;
      },
      { history: false },
    );
    setActiveLayerId(getLayerId(next));
  };

  const duplicateLayer = (layerId: string) => {
    const source = layers.find((layer) => getLayerId(layer) === layerId);
    if (!source) return;
    const duplicate = clone(source);
    duplicate.id = makeId("layer");
    duplicate.name = `${source.name ?? "Text layer"} copy`;
    recordHistory();
    mutateProject(
      (draft) => {
        const target = getLayers(draft);
        const index = target.findIndex(
          (layer) => getLayerId(layer) === layerId,
        );
        target.splice(index + 1, 0, duplicate);
        draft.layers = target;
      },
      { history: false },
    );
    setActiveLayerId(getLayerId(duplicate));
  };

  const removeLayer = (layerId: string) => {
    if (layers.length <= 1) {
      notify("Keep one layer in the composition");
      return;
    }
    recordHistory();
    mutateProject(
      (draft) => {
        draft.layers = getLayers(draft).filter(
          (layer) => getLayerId(layer) !== layerId,
        );
      },
      { history: false },
    );
    const nextActive = layers.find((layer) => getLayerId(layer) !== layerId);
    setActiveLayerId(nextActive ? getLayerId(nextActive) : null);
  };

  const moveLayer = (layerId: string, direction: -1 | 1) => {
    recordHistory();
    mutateProject(
      (draft) => {
        const target = getLayers(draft);
        const from = target.findIndex((layer) => getLayerId(layer) === layerId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= target.length) return;
        const [layer] = target.splice(from, 1);
        target.splice(to, 0, layer);
        draft.layers = target;
      },
      { history: false },
    );
  };

  const chooseDimension = (preset: DimensionPreset) => {
    if (!project) return;
    const dimensions: Record<DimensionPreset, [number, number]> = {
      wide: [1920, 1080],
      portrait: [1080, 1920],
      square: [1080, 1080],
    };
    const [width, height] = dimensions[preset];
    recordHistory();
    mutateProject((draft) => setCanvasSize(draft, width, height), {
      history: false,
    });
  };

  const handleProjectImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const validated = parseProject(parsed) as TextFxProject;
      const next = validated;
      recordHistory();
      setProject(next);
      setCurrentTimeMs(0);
      setActiveLayerId(next.layers[0]?.id ?? null);
      notify("Project imported");
    } catch {
      notify("That project JSON could not be opened");
    }
  };

  const exportJson = () => {
    if (!project) return;
    downloadBlob(
      new Blob([JSON.stringify(project, null, 2)], {
        type: "application/json",
      }),
      `${(draftName.trim() || "text-fx-project").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`,
    );
    notify("Project JSON downloaded");
  };

  const startExport = async (scale = exportScale) => {
    if (!project || exportStatus === "exporting") return;
    setExportStatus("exporting");
    setExportProgress(0);
    setExportError("");
    const controller = new AbortController();
    exportAbortRef.current = controller;
    try {
      await document.fonts.ready;
      const blob = await exportProject(project, {
        format: exportFormat,
        scale,
        signal: controller.signal,
        onProgress: (progress: number) =>
          setExportProgress(Math.max(0, Math.min(1, progress))),
      });
      downloadBlob(
        blob,
        `${(draftName.trim() || "text-fx").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${exportFormat}`,
      );
      setExportStatus("done");
      notify(`${exportFormat.toUpperCase()} ready`);
    } catch (error) {
      if (controller.signal.aborted) {
        setExportStatus("idle");
        notify("Export cancelled");
      } else {
        setExportStatus("error");
        setExportError(
          error instanceof Error
            ? error.message
            : "Export ran out of browser memory",
        );
      }
    } finally {
      exportAbortRef.current = null;
    }
  };

  const activeKeyframes = activeLayer ? getKeyframes(activeLayer) : [];
  const selectedKeyframeData =
    selectedKeyframe &&
    activeLayer &&
    selectedKeyframe.layerId === getLayerId(activeLayer)
      ? activeKeyframes[selectedKeyframe.index]
      : null;

  if (!project) {
    return (
      <main className="fx-studio fx-loading" aria-busy="true">
        <div className="fx-loading-mark">
          <Sparkles size={18} /> Preparing canvas
        </div>
        <div className="fx-loading-bar">
          <span />
        </div>
      </main>
    );
  }

  return (
    <main className="fx-studio">
      <header className="fx-topbar">
        <div className="fx-brand-lockup">
          <a href="/" className="fx-brand" aria-label="RapidScreen home">
            RAPIDSCREEN<span>_</span>
          </a>
          <span className="fx-slash">/</span>
          <span className="fx-product">TEXT FX LAB</span>
        </div>
        <div className="fx-topbar-center">
          <button
            className="fx-draft-trigger"
            onClick={() => setShowDrafts((visible) => !visible)}
            aria-expanded={showDrafts}
            aria-haspopup="listbox"
          >
            <span className="fx-status-dot" />
            <span className="fx-draft-name">
              {draftName || "Untitled sequence"}
            </span>
            <ChevronDown size={14} />
          </button>
          {showDrafts && (
            <div
              className="fx-draft-menu"
              role="listbox"
              aria-label="Saved drafts"
            >
              <div className="fx-draft-menu-head">
                <span>SAVED DRAFTS</span>
                <button
                  className="fx-icon-button"
                  onClick={() => setShowDrafts(false)}
                  aria-label="Close draft list"
                >
                  <X size={14} />
                </button>
              </div>
              <label className="fx-draft-rename">
                <span>NAME</span>
                <input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  aria-label="Draft name"
                />
              </label>
              {drafts.length === 0 && (
                <div className="fx-empty-note">
                  Autosaved drafts appear here.
                </div>
              )}
              {drafts.map((draft) => (
                <button
                  className={`fx-draft-option ${draft.id === activeDraftId ? "is-active" : ""}`}
                  key={draft.id}
                  role="option"
                  aria-selected={draft.id === activeDraftId}
                  onClick={() => {
                    const next = draft.project;
                    setProject(next);
                    setActiveDraftId(draft.id);
                    setDraftName(draft.name);
                    setCurrentTimeMs(0);
                    setActiveLayerId(next.layers[0]?.id ?? null);
                    setShowDrafts(false);
                  }}
                >
                  <span>{draft.name}</span>
                  <small>
                    {new Date(draft.updatedAt).toLocaleDateString()}
                  </small>
                </button>
              ))}
              <button
                className="fx-draft-new"
                onClick={() => {
                  const next = projectFromPreset("scramble");
                  setProject(next);
                  setDraftName("Untitled sequence");
                  setActiveDraftId(null);
                  setCurrentTimeMs(0);
                  setActiveLayerId(next.layers[0]?.id ?? null);
                  setShowDrafts(false);
                }}
              >
                <FilePlus2 size={14} /> New draft
              </button>
            </div>
          )}
        </div>
        <div className="fx-topbar-actions">
          <button
            className="fx-ghost-button"
            onClick={undo}
            disabled={historyPast.length === 0}
            title="Undo (Ctrl/Cmd + Z)"
          >
            <Undo2 size={15} /> <span>Undo</span>
          </button>
          <button
            className="fx-ghost-button"
            onClick={redo}
            disabled={historyFuture.length === 0}
            title="Redo (Ctrl/Cmd + Shift + Z)"
          >
            <Redo2 size={15} /> <span>Redo</span>
          </button>
          <button
            className="fx-ghost-button"
            onClick={exportJson}
            title="Download project JSON"
          >
            <Download size={15} /> <span>JSON</span>
          </button>
          <label className="fx-format-picker">
            <span className="sr-only">Export format</span>
            <select
              value={exportFormat}
              onChange={(event) =>
                setExportFormat(event.target.value as ExportFormat)
              }
              aria-label="Export format"
            >
              <option value="webm">WEBM</option>
              <option value="mp4">MP4</option>
              <option value="gif">GIF</option>
            </select>
          </label>
          <button
            className="fx-primary-button fx-export-button"
            onClick={() =>
              exportStatus === "exporting"
                ? exportAbortRef.current?.abort()
                : void startExport()
            }
          >
            {exportStatus === "exporting" ? (
              <X size={15} />
            ) : (
              <Download size={15} />
            )}
            {exportStatus === "exporting"
              ? `Cancel ${Math.round(exportProgress * 100)}%`
              : "Export"}
          </button>
        </div>
      </header>

      <div className="fx-shell">
        <aside
          className="fx-panel fx-panel-left"
          aria-label="Presets and layers"
        >
          <div className="fx-panel-header">
            <div>
              <span className="fx-eyebrow">BUILD</span>
              <h1>Text treatments</h1>
            </div>
            <Sparkles size={16} className="fx-panel-glyph" />
          </div>
          <section className="fx-section fx-preset-section">
            <div className="fx-section-heading">
              <span>Presets</span>
              <span className="fx-section-count">
                {PRESET_OPTIONS.length.toString().padStart(2, "0")}
              </span>
            </div>
            <div className="fx-preset-list">
              {PRESET_OPTIONS.slice(0, 6).map((preset) => (
                <button
                  className="fx-preset-card"
                  key={preset.id}
                  onClick={() => selectPreset(preset.id)}
                >
                  <span className="fx-preset-glyph" aria-hidden="true">
                    {preset.id === "ascii"
                      ? "░▒▓"
                      : preset.id === "led"
                        ? "→→→"
                        : preset.id === "glitch"
                          ? "R/G/B"
                          : "///"}
                  </span>
                  <span className="fx-preset-copy">
                    <strong>{preset.label}</strong>
                    <small>{preset.description}</small>
                  </span>
                  <Plus size={13} className="fx-preset-add" />
                </button>
              ))}
            </div>
          </section>
          <section className="fx-section fx-layers-section">
            <div className="fx-section-heading">
              <span>Layers</span>
              <span className="fx-section-count">
                {layers.length.toString().padStart(2, "0")}
              </span>
            </div>
            <div
              className="fx-layer-list"
              role="listbox"
              aria-label="Text layers"
            >
              {[...layers].reverse().map((layer, reverseIndex) => {
                const index = layers.length - reverseIndex - 1;
                const id = getLayerId(layer);
                const selected = id === getLayerId(activeLayer);
                return (
                  <div
                    className={`fx-layer-row ${selected ? "is-selected" : ""} ${layer.visible === false ? "is-hidden" : ""}`}
                    key={id}
                    role="option"
                    aria-selected={selected}
                  >
                    <button
                      className="fx-layer-select"
                      onClick={() => setActiveLayerId(id)}
                    >
                      <GripVertical size={13} className="fx-layer-grip" />
                      <span className="fx-layer-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="fx-layer-text">
                        <strong>{layer.name}</strong>
                        <small>{String(layer.effect ?? "scramble")}</small>
                      </span>
                    </button>
                    <button
                      className="fx-layer-visibility"
                      onClick={() =>
                        updateLayer(id, (draft) => {
                          draft.visible = draft.visible === false;
                        })
                      }
                      aria-label={`${layer.visible === false ? "Show" : "Hide"} ${layer.name}`}
                    >
                      {layer.visible === false ? (
                        <EyeOff size={14} />
                      ) : (
                        <Eye size={14} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            <button className="fx-add-layer" onClick={addLayer}>
              <Plus size={14} /> Add text layer
            </button>
          </section>
          <div className="fx-left-footer">
            <span>
              <span className="fx-live-indicator" /> Autosaved locally
            </span>
            <span>v1.0</span>
          </div>
        </aside>

        <section className="fx-stage" aria-label="Canvas preview">
          <div className="fx-stage-toolbar">
            <div className="fx-toolbar-group">
              <span className="fx-toolbar-label">PREVIEW</span>
              <span className="fx-toolbar-divider" />
              <span className="fx-toolbar-meta">
                {formatDimension(canvasSize.width)} ×{" "}
                {formatDimension(canvasSize.height)}
              </span>
            </div>
            <div className="fx-toolbar-group">
              <button className="fx-stage-tool" aria-label="Fit canvas">
                <Maximize2 size={14} />
              </button>
              <span className="fx-toolbar-meta">100%</span>
            </div>
          </div>
          <div className="fx-canvas-stage">
            <div
              className={`fx-canvas-frame ${background.type === "transparent" ? "is-transparent" : ""}`}
              ref={canvasFrameRef}
              style={{
                aspectRatio: `${canvasSize.width} / ${canvasSize.height}`,
              }}
            >
              <canvas
                ref={canvasRef}
                className="fx-preview-canvas"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
                aria-label="Animated text preview. Drag the selected text to reposition it."
              />
              {renderError && (
                <div className="fx-render-error" role="alert">
                  <X size={13} />
                  <span>Preview render failed: {renderError}</span>
                </div>
              )}
              {activeLayer && (
                <div className="fx-canvas-corner fx-canvas-corner-tl">
                  {String(activeLayer.effect ?? "SCRAMBLE").toUpperCase()}
                </div>
              )}
              <div className="fx-canvas-corner fx-canvas-corner-br">
                {formatTime(currentTimeMs)} / {formatTime(durationMs)}
              </div>
            </div>
          </div>
          <div className="fx-stage-controls">
            <button
              className="fx-play-button"
              onClick={() => setIsPlaying((playing) => !playing)}
              aria-label={isPlaying ? "Pause preview" : "Play preview"}
            >
              {isPlaying ? (
                <Pause size={17} fill="currentColor" />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
            </button>
            <button
              className="fx-stop-button"
              onClick={() => {
                setIsPlaying(false);
                setCurrentTimeMs(0);
              }}
              aria-label="Stop preview"
            >
              <CircleStop size={17} />
            </button>
            <span className="fx-time-readout">{formatTime(currentTimeMs)}</span>
            <input
              className="fx-scrub-range"
              type="range"
              min={0}
              max={durationMs}
              step={10}
              value={currentTimeMs}
              onChange={(event) => setCurrentTimeMs(Number(event.target.value))}
              aria-label="Preview timeline"
            />
            <span className="fx-time-readout fx-time-total">
              {formatTime(durationMs)}
            </span>
            <button
              className="fx-loop-button"
              onClick={() =>
                setCurrentTimeMs((time) =>
                  time >= durationMs ? 0 : durationMs,
                )
              }
              aria-label="Jump to end"
            >
              END
            </button>
          </div>
        </section>

        <aside className="fx-panel fx-panel-right" aria-label="Properties">
          <div className="fx-panel-header fx-panel-header-right">
            <div>
              <span className="fx-eyebrow">INSPECTOR</span>
              <h1>{activeLayer?.name ?? "No selection"}</h1>
            </div>
            <Settings2 size={16} className="fx-panel-glyph" />
          </div>
          {activeLayer ? (
            <div className="fx-inspector-scroll">
              <section className="fx-inspector-section">
                <div className="fx-section-heading">
                  <span>Content</span>
                  <span className="fx-section-rule" />
                </div>
                <label className="fx-field fx-field-full">
                  <span>Layer name</span>
                  <input
                    value={String(activeLayer.name ?? "")}
                    onChange={(event) =>
                      updateLayer(getLayerId(activeLayer), (layer) => {
                        layer.name = event.target.value;
                      })
                    }
                  />
                </label>
                <label className="fx-field fx-field-full">
                  <span>Text</span>
                  <textarea
                    rows={2}
                    value={String(activeLayer.text ?? "")}
                    onChange={(event) =>
                      updateLayer(getLayerId(activeLayer), (layer) => {
                        layer.text = event.target.value;
                      })
                    }
                  />
                </label>
                <div className="fx-field-grid">
                  <label className="fx-field">
                    <span>Effect</span>
                    <select
                      value={activeLayer.effect}
                      onChange={(event) =>
                        updateLayer(getLayerId(activeLayer), (layer) => {
                          layer.effect = event.target.value as EffectKind;
                        })
                      }
                    >
                      {EFFECTS.map((effect) => (
                        <option value={effect.id} key={effect.id}>
                          {effect.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="fx-field">
                    <span>Font</span>
                    <select
                      value={activeLayer.font}
                      onChange={(event) =>
                        updateLayer(getLayerId(activeLayer), (layer) => {
                          layer.font = event.target.value as FontId;
                        })
                      }
                    >
                      {FONT_OPTIONS.map((font) => (
                        <option value={font.id} key={font.id}>
                          {font.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="fx-field-grid">
                  <label className="fx-field">
                    <span>Font size</span>
                    <div className="fx-number-with-unit">
                      <input
                        type="number"
                        min={8}
                        max={480}
                        value={Number(activeLayer.fontSize ?? 96)}
                        onChange={(event) =>
                          updateLayer(getLayerId(activeLayer), (layer) => {
                            layer.fontSize = Number(event.target.value);
                          })
                        }
                      />
                      <em>px</em>
                    </div>
                  </label>
                  <label className="fx-field">
                    <span>Color</span>
                    <div className="fx-color-field">
                      <input
                        type="color"
                        value={String(activeLayer.color ?? "#f26622")}
                        onChange={(event) =>
                          updateLayer(getLayerId(activeLayer), (layer) => {
                            layer.color = event.target.value;
                          })
                        }
                      />
                      <input
                        value={String(activeLayer.color ?? "#f26622")}
                        onChange={(event) =>
                          updateLayer(getLayerId(activeLayer), (layer) => {
                            layer.color = event.target.value;
                          })
                        }
                      />
                    </div>
                  </label>
                </div>
              </section>
              <section className="fx-inspector-section">
                <div className="fx-section-heading">
                  <span>Timing</span>
                  <span className="fx-section-rule" />
                </div>
                <div className="fx-field-grid">
                  <label className="fx-field">
                    <span>In</span>
                    <div className="fx-number-with-unit">
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, activeLayer.endMs - 1)}
                        step={100}
                        value={activeLayer.startMs}
                        onChange={(event) =>
                          updateLayer(getLayerId(activeLayer), (layer) => {
                            setLayerTiming(
                              layer,
                              "startMs",
                              Number(event.target.value),
                              durationMs,
                            );
                          })
                        }
                      />
                      <em>ms</em>
                    </div>
                  </label>
                  <label className="fx-field">
                    <span>Out</span>
                    <div className="fx-number-with-unit">
                      <input
                        type="number"
                        min={Math.min(durationMs, activeLayer.startMs + 1)}
                        max={durationMs}
                        step={100}
                        value={activeLayer.endMs}
                        onChange={(event) =>
                          updateLayer(getLayerId(activeLayer), (layer) => {
                            setLayerTiming(
                              layer,
                              "endMs",
                              Number(event.target.value),
                              durationMs,
                            );
                          })
                        }
                      />
                      <em>ms</em>
                    </div>
                  </label>
                </div>
                <div className="fx-range-field">
                  <div className="fx-range-head">
                    <span>Effect intensity</span>
                    <output>
                      {Math.round(
                        getLayerValue(activeLayer, "intensity") * 100,
                      )}
                      %
                    </output>
                    <button
                      className="fx-keyframe-button"
                      onClick={() =>
                        addKeyframe(getLayerId(activeLayer), "intensity")
                      }
                      aria-label="Add effect intensity keyframe"
                    >
                      <Diamond size={13} />
                    </button>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={getLayerValue(activeLayer, "intensity")}
                    onChange={(event) =>
                      updateKeyedValue(
                        getLayerId(activeLayer),
                        "intensity",
                        Number(event.target.value),
                      )
                    }
                    aria-label="Effect intensity"
                  />
                </div>
              </section>
              <section className="fx-inspector-section">
                <div className="fx-section-heading">
                  <span>Transform</span>
                  <span className="fx-section-rule" />
                  <button
                    className="fx-key-all"
                    onClick={() => addKeyframe(getLayerId(activeLayer))}
                  >
                    <Diamond size={13} /> Key all
                  </button>
                </div>
                <TransformField
                  label="X position"
                  value={getLayerValue(activeLayer, "x")}
                  min={0}
                  max={canvasSize.width}
                  step={1}
                  suffix="px"
                  property="x"
                  onChange={updateKeyedValue}
                  onKeyframe={() => addKeyframe(getLayerId(activeLayer), "x")}
                  onSelect={setSelectedProperty}
                  layerId={getLayerId(activeLayer)}
                />
                <TransformField
                  label="Y position"
                  value={getLayerValue(activeLayer, "y")}
                  min={0}
                  max={canvasSize.height}
                  step={1}
                  suffix="px"
                  property="y"
                  onChange={updateKeyedValue}
                  onKeyframe={() => addKeyframe(getLayerId(activeLayer), "y")}
                  onSelect={setSelectedProperty}
                  layerId={getLayerId(activeLayer)}
                />
                <TransformField
                  label="Scale"
                  value={getLayerValue(activeLayer, "scale")}
                  min={0.1}
                  max={4}
                  step={0.05}
                  suffix="×"
                  property="scale"
                  onChange={updateKeyedValue}
                  onKeyframe={() =>
                    addKeyframe(getLayerId(activeLayer), "scale")
                  }
                  onSelect={setSelectedProperty}
                  layerId={getLayerId(activeLayer)}
                />
                <TransformField
                  label="Rotation"
                  value={getLayerValue(activeLayer, "rotation")}
                  min={-180}
                  max={180}
                  step={1}
                  suffix="°"
                  property="rotation"
                  onChange={updateKeyedValue}
                  onKeyframe={() =>
                    addKeyframe(getLayerId(activeLayer), "rotation")
                  }
                  onSelect={setSelectedProperty}
                  layerId={getLayerId(activeLayer)}
                />
                <TransformField
                  label="Opacity"
                  value={Math.round(
                    getLayerValue(activeLayer, "opacity") * 100,
                  )}
                  min={0}
                  max={100}
                  step={1}
                  suffix="%"
                  property="opacity"
                  onChange={(layerId, property, value) =>
                    updateKeyedValue(layerId, property, value / 100)
                  }
                  onKeyframe={() =>
                    addKeyframe(getLayerId(activeLayer), "opacity")
                  }
                  onSelect={setSelectedProperty}
                  layerId={getLayerId(activeLayer)}
                />
              </section>
              <section className="fx-inspector-section">
                <div className="fx-section-heading">
                  <span>Canvas</span>
                  <span className="fx-section-rule" />
                </div>
                <div
                  className="fx-dimension-buttons"
                  role="group"
                  aria-label="Canvas aspect ratio"
                >
                  <button
                    onClick={() => chooseDimension("wide")}
                    className={
                      canvasSize.width >= canvasSize.height * 1.4
                        ? "is-active"
                        : ""
                    }
                  >
                    16:9
                  </button>
                  <button
                    onClick={() => chooseDimension("portrait")}
                    className={
                      canvasSize.height >= canvasSize.width * 1.4
                        ? "is-active"
                        : ""
                    }
                  >
                    9:16
                  </button>
                  <button
                    onClick={() => chooseDimension("square")}
                    className={
                      Math.abs(canvasSize.width - canvasSize.height) < 20
                        ? "is-active"
                        : ""
                    }
                  >
                    1:1
                  </button>
                </div>
                <div className="fx-field-grid">
                  <label className="fx-field">
                    <span>Duration</span>
                    <div className="fx-number-with-unit">
                      <input
                        type="number"
                        min={0.5}
                        max={30}
                        step={0.5}
                        value={(durationMs / 1000).toFixed(1)}
                        onChange={(event) => {
                          const next = Math.min(
                            30000,
                            Math.max(500, Number(event.target.value) * 1000),
                          );
                          recordHistory();
                          mutateProject((draft) => setDuration(draft, next), {
                            history: false,
                          });
                        }}
                      />
                      <em>sec</em>
                    </div>
                  </label>
                  <label className="fx-field">
                    <span>Background</span>
                    <select
                      value={background.type}
                      onChange={(event) => {
                        const type = event.target.value as BackgroundKind;
                        recordHistory();
                        mutateProject(
                          (draft) =>
                            setBackground(draft, {
                              ...getBackground(draft),
                              type,
                            }),
                          { history: false },
                        );
                      }}
                    >
                      <option value="solid">Solid</option>
                      <option value="gradient">Gradient</option>
                      <option value="pattern">Pattern</option>
                      <option value="transparent">Transparent</option>
                    </select>
                  </label>
                </div>
                {background.type !== "transparent" && (
                  <div className="fx-field-grid">
                    <label className="fx-field">
                      <span>Color A</span>
                      <div className="fx-color-field">
                        <input
                          type="color"
                          value={background.color}
                          onChange={(event) =>
                            mutateProject(
                              (draft) =>
                                setBackground(draft, {
                                  ...getBackground(draft),
                                  color: event.target.value,
                                }),
                              { history: true },
                            )
                          }
                        />
                        <input
                          value={background.color}
                          onChange={(event) =>
                            mutateProject(
                              (draft) =>
                                setBackground(draft, {
                                  ...getBackground(draft),
                                  color: event.target.value,
                                }),
                              { history: true },
                            )
                          }
                        />
                      </div>
                    </label>
                    {background.type === "gradient" ||
                    background.type === "pattern" ? (
                      <label className="fx-field">
                        <span>Color B</span>
                        <div className="fx-color-field">
                          <input
                            type="color"
                            value={background.color2}
                            onChange={(event) =>
                              mutateProject(
                                (draft) =>
                                  setBackground(draft, {
                                    ...getBackground(draft),
                                    color2: event.target.value,
                                  }),
                                { history: true },
                              )
                            }
                          />
                          <input
                            value={background.color2}
                            onChange={(event) =>
                              mutateProject(
                                (draft) =>
                                  setBackground(draft, {
                                    ...getBackground(draft),
                                    color2: event.target.value,
                                  }),
                                { history: true },
                              )
                            }
                          />
                        </div>
                      </label>
                    ) : (
                      <span />
                    )}
                  </div>
                )}
                {background.type === "transparent" && (
                  <label className="fx-field">
                    <span>MP4 matte color</span>
                    <div className="fx-color-field">
                      <input
                        type="color"
                        value={project.background.matteColor}
                        onChange={(event) =>
                          mutateProject((draft) => {
                            draft.background.matteColor = event.target.value;
                          })
                        }
                        aria-label="MP4 matte color"
                      />
                      <input
                        value={project.background.matteColor}
                        onChange={(event) =>
                          mutateProject((draft) => {
                            draft.background.matteColor = event.target.value;
                          })
                        }
                        aria-label="MP4 matte hex color"
                      />
                    </div>
                  </label>
                )}
              </section>
              <section className="fx-inspector-section fx-layer-actions">
                <button onClick={() => duplicateLayer(getLayerId(activeLayer))}>
                  <Copy size={14} /> Duplicate
                </button>
                <button
                  onClick={() => moveLayer(getLayerId(activeLayer), -1)}
                  aria-label="Move layer down"
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  onClick={() => moveLayer(getLayerId(activeLayer), 1)}
                  aria-label="Move layer up"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  className="is-danger"
                  onClick={() => removeLayer(getLayerId(activeLayer))}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </section>
            </div>
          ) : (
            <div className="fx-empty-inspector">
              Select a text layer to edit its treatment.
            </div>
          )}
          {exportStatus === "error" && (
            <div className="fx-export-error" role="alert">
              <span>{exportError || "Export failed."}</span>
              <button
                onClick={() => {
                  setExportScale(0.667);
                  void startExport(0.667);
                }}
              >
                Retry at 720p
              </button>
            </div>
          )}
          {exportStatus === "done" && (
            <div className="fx-export-success" role="status">
              <Check size={14} /> Download started
            </div>
          )}
        </aside>

        <section className="fx-timeline" aria-label="Keyframe timeline">
          <div className="fx-timeline-header">
            <div className="fx-timeline-title">
              <span className="fx-eyebrow">TIMELINE</span>
              <strong>{layers.length} layers</strong>
            </div>
            <div className="fx-timeline-hint">
              <Diamond size={12} fill="currentColor" /> click a diamond to
              select · delete to remove
            </div>
            <div className="fx-timeline-actions">
              <button
                className="fx-icon-button"
                onClick={() => setCurrentTimeMs(0)}
                aria-label="Go to start"
              >
                |◀
              </button>
              <button
                className="fx-icon-button"
                onClick={() =>
                  setCurrentTimeMs((time) => Math.max(0, time - 100))
                }
                aria-label="Previous frame"
              >
                ◀
              </button>
              <button
                className="fx-icon-button"
                onClick={() =>
                  setCurrentTimeMs((time) => Math.min(durationMs, time + 100))
                }
                aria-label="Next frame"
              >
                ▶
              </button>
            </div>
          </div>
          <div className="fx-timeline-body">
            <div className="fx-timeline-label-column">
              <div className="fx-ruler-spacer" />
              <div className="fx-timeline-layer-labels">
                {[...layers].reverse().map((layer) => (
                  <button
                    key={getLayerId(layer)}
                    className={`fx-timeline-layer-label ${getLayerId(layer) === getLayerId(activeLayer) ? "is-active" : ""}`}
                    onClick={() => setActiveLayerId(getLayerId(layer))}
                  >
                    <span
                      className="fx-timeline-layer-swatch"
                      style={{ background: layer.color ?? "#f26622" }}
                    />
                    <span>{layer.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="fx-timeline-track-column">
              <div
                className="fx-ruler"
                onPointerDown={(event) => handleTimelinePointerDown(event)}
              >
                {[0, 25, 50, 75, 100].map((mark) => (
                  <span key={mark} style={{ left: `${mark}%` }}>
                    {formatTime((durationMs * mark) / 100)}
                  </span>
                ))}
                <i
                  className="fx-playhead"
                  style={{ left: `${(currentTimeMs / durationMs) * 100}%` }}
                />
              </div>
              <div className="fx-timeline-tracks">
                {[...layers].reverse().map((layer) => (
                  <div
                    className={`fx-keyframe-track ${getLayerId(layer) === getLayerId(activeLayer) ? "is-active" : ""}`}
                    key={getLayerId(layer)}
                    onPointerDown={(event) => handleTimelinePointerDown(event)}
                  >
                    {getKeyframes(layer).map((keyframe, index) => (
                      <button
                        key={`${getLayerId(layer)}-${index}`}
                        className={`fx-keyframe-dot ${selectedKeyframe?.layerId === getLayerId(layer) && selectedKeyframe?.index === index ? "is-selected" : ""}`}
                        style={{
                          left: `${(getKeyframeTime(keyframe) / durationMs) * 100}%`,
                        }}
                        onPointerDown={(event) =>
                          handleKeyframePointerDown(
                            event,
                            getLayerId(layer),
                            index,
                          )
                        }
                        onPointerMove={handleKeyframePointerMove}
                        onPointerUp={handleKeyframePointerUp}
                        aria-label={`Keyframe at ${formatTime(getKeyframeTime(keyframe))}`}
                      >
                        <Diamond size={13} fill="currentColor" />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <div
                className="fx-timeline-playhead"
                style={{ left: `${(currentTimeMs / durationMs) * 100}%` }}
              />
            </div>
          </div>
        </section>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={handleProjectImport}
      />
      <div className="fx-file-actions" aria-label="Project files">
        <button onClick={() => fileInputRef.current?.click()}>
          <Upload size={14} /> Import JSON
        </button>
        <button onClick={exportJson}>
          <FileDown size={14} /> Export JSON
        </button>
      </div>
      {toast && (
        <div className="fx-toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}

function TransformField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  property,
  layerId,
  onChange,
  onKeyframe,
  onSelect,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  property: KeyProperty;
  layerId: string;
  onChange: (layerId: string, property: KeyProperty, value: number) => void;
  onKeyframe: () => void;
  onSelect: (property: KeyProperty) => void;
}) {
  return (
    <div className="fx-transform-field" onClick={() => onSelect(property)}>
      <label>
        <span>{label}</span>
        <div className="fx-number-with-unit">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) =>
              onChange(layerId, property, Number(event.target.value))
            }
          />
          <em>{suffix}</em>
        </div>
      </label>
      <button
        className="fx-keyframe-button"
        onClick={onKeyframe}
        aria-label={`Add ${label} keyframe`}
      >
        <Diamond size={13} />
      </button>
    </div>
  );
}
