"use client";

import {
  Box,
  Circle,
  Diamond,
  Download,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cloneModelProject,
  createBlankModelProject,
  createMeshSelection,
  createModelDraftStore,
  createVitruvianProject,
  defaultMaterial,
  defaultTransform,
  evaluateModelFrame,
  edgeKey,
  extrudeFaces,
  insetFaces,
  bevelEdges,
  moveVertices,
  rotateVertices,
  scaleVertices,
  remeshStatic,
  applySculptBrush,
  exportModelProjectBundleBlob,
  importModelProjectBundle,
  parseModelProject,
} from "./core";
import type {
  EvaluatedModelFrame,
  ModelAnimationTrack,
  ModelDraftStore,
  ModelDraftSummary,
  IndexedPolygonMesh,
  MeshSelection,
  SculptBrushKind,
  ModelProject,
  ModelSceneObject,
  ModelTrackProperty,
  Vec3,
} from "./core";
import { NumberField, PanelSection, VectorFields } from "./controls";
import { ModelerScene } from "./runtime/scene";
import type { PrimitiveKind, RuntimeFrame, Vector3Tuple } from "./runtime/scene";
import { applyIndexedMeshToThree, decodeIndexedMesh, encodeIndexedMesh, indexedMeshFromThree } from "./runtime/mesh";

type Mode = "object" | "edit" | "sculpt" | "pose";
type ExportFormat = "prores4444" | "webm" | "mp4" | "png-sequence";
type SelectionKind = "vertex" | "edge" | "face";
type StudioAction =
  | { type: "project"; before: ModelProject; after: ModelProject }
  | { type: "mesh"; meshName: string; before: IndexedPolygonMesh; after: IndexedPolygonMesh };

const MAX_HISTORY = 60;
const RESOLUTIONS = [
  { label: "1080p · 16:9", width: 1920, height: 1080 },
  { label: "720p · 16:9", width: 1280, height: 720 },
  { label: "1080p · 9:16", width: 1080, height: 1920 },
  { label: "1080p · 1:1", width: 1080, height: 1080 },
] as const;
const TOOLS: Array<{ id: Mode; label: string }> = [
  { id: "object", label: "Object" },
  { id: "edit", label: "Mesh" },
  { id: "sculpt", label: "Sculpt" },
  { id: "pose", label: "Pose" },
];
const TRACK_OPTIONS: Array<{ id: ModelTrackProperty; label: string }> = [
  { id: "rotationY", label: "Spin Y" },
  { id: "position", label: "Position" },
  { id: "rotation", label: "Rotation" },
  { id: "scale", label: "Scale" },
  { id: "opacity", label: "Opacity" },
  { id: "boneRotation", label: "Bone rotation" },
  { id: "cameraPosition", label: "Camera" },
  { id: "cameraTarget", label: "Camera target" },
  { id: "lightIntensity", label: "Light intensity" },
];

const makeId = (prefix: string) =>
  prefix + "-" + (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10));

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

const frameForScene = (frame: EvaluatedModelFrame, project: ModelProject): RuntimeFrame => {
  const figure = frame.objects.find((object) => object.id === "vitruvian-figure");
  const rig = frame.rigs.find((item) => item.id === figure?.rigId);
  const boneRotations: Record<string, Vector3Tuple> = {};
  if (rig) {
    for (const [name, pose] of Object.entries(rig.pose)) {
      boneRotations[name] = pose.rotation;
    }
  }
  return {
    position: figure?.transform.position ?? [0, 0, 0],
    rotation: figure?.transform.rotation ?? [0, 0, 0],
    scale: figure?.transform.scale ?? [1, 1, 1],
    boneRotations,
    camera: frame.camera.position,
    cameraTarget: frame.camera.target,
    fov: frame.camera.fov,
    lightIntensity: frame.lights.find((light) => light.type !== "ambient")?.intensity ?? 2.5,
    glow: project.render.glow ? project.render.glowIntensity / 3 : 0,
    glowRadius: project.render.glowRadius,
  };
};

const syncScene = (scene: ModelerScene, frame: EvaluatedModelFrame, project: ModelProject) => {
  const existing = new Set(scene.getSceneItems().map((item) => item.id));
  for (const item of project.objects) {
    if (!existing.has(item.id) && item.geometry) {
      scene.addPrimitive(item.id, item.geometry.type as PrimitiveKind);
    }
  }
  for (const item of scene.getSceneItems()) {
    if (!project.objects.some((object) => object.id === item.id)) scene.removeItem(item.id);
  }
  for (const object of frame.objects) {
    scene.setItem(object.id, {
      name: object.name,
      visible: object.visible,
      position: object.id === "vitruvian-figure" ? undefined : object.transform.position,
      rotation: object.id === "vitruvian-figure" ? undefined : object.transform.rotation,
      scale: object.id === "vitruvian-figure" ? undefined : object.transform.scale,
      material: object.material,
    });
  }
};

const trackValue = (project: ModelProject, property: ModelTrackProperty, targetId: string, boneName: string): number | number[] => {
  const object = project.objects.find((item) => item.id === targetId);
  if (property === "position") return object?.transform.position ?? [0, 0, 0];
  if (property === "rotation") return object?.transform.rotation ?? [0, 0, 0];
  if (property === "rotationY") return object?.transform.rotation[1] ?? 0;
  if (property === "scale") return object?.transform.scale ?? [1, 1, 1];
  if (property === "opacity") return object?.material.opacity ?? 1;
  if (property === "cameraPosition") return project.camera.position;
  if (property === "cameraTarget") return project.camera.target;
  if (property === "lightIntensity") return project.lights.find((light) => light.id === targetId)?.intensity ?? 0;
  if (property === "boneRotation") return project.rigs.flatMap((rig) => Object.entries(rig.pose))
    .find(([name]) => name === boneName)?.[1].rotation ?? [0, 0, 0];
  return 0;
};

export default function ModelerStudio() {
  const [project, setProject] = useState<ModelProject>(createVitruvianProject);
  const [selectedId, setSelectedId] = useState("vitruvian-figure");
  const [mode, setMode] = useState<Mode>("object");
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const [status, setStatus] = useState("Loading the Vitruvian scene...");
  const [statusError, setStatusError] = useState(false);
  const [selectedBone, setSelectedBone] = useState("arm-left-upper");
  const [selectedMesh, setSelectedMesh] = useState("");
  const [selectedFace, setSelectedFace] = useState<number | null>(null);
  const [selectionKind, setSelectionKind] = useState<SelectionKind>("face");
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [meshDelta, setMeshDelta] = useState<Vec3>([0, 0.1, 0]);
  const [meshAmount, setMeshAmount] = useState(0.15);
  const [keyProperty, setKeyProperty] = useState<ModelTrackProperty>("rotationY");
  const [drafts, setDrafts] = useState<ModelDraftSummary[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [brush, setBrush] = useState("grab");
  const [brushRadius, setBrushRadius] = useState(0.5);
  const [brushStrength, setBrushStrength] = useState(0.35);
  const [symmetry, setSymmetry] = useState(true);
  const [, refreshHistory] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ModelerScene | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<{ past: StudioAction[]; future: StudioAction[] }>({ past: [], future: [] });
  const selectionRef = useRef<MeshSelection>(createMeshSelection());
  const sculptStrokeRef = useRef<{ meshName: string; before: IndexedPolygonMesh; lastPoint: Vec3 } | null>(null);
  const persistQueueRef = useRef(Promise.resolve());
  const exportAbortRef = useRef<AbortController | null>(null);
  const draftStoreRef = useRef<ModelDraftStore | null>(null);
  if (!draftStoreRef.current) draftStoreRef.current = createModelDraftStore();
  const selected = project.objects.find((object) => object.id === selectedId) ?? null;
  const selectedRig = project.rigs.find((rig) => rig.id === selected?.rigId);
  const durationSeconds = project.durationMs / 1000;
  const projectRef = useRef(project);
  projectRef.current = project;

  const commit = useCallback((change: (draft: ModelProject) => void) => {
    const current = projectRef.current;
    const next = cloneModelProject(current);
    change(next);
    historyRef.current.past.push({ type: "project", before: current, after: next });
    if (historyRef.current.past.length > MAX_HISTORY) historyRef.current.past.shift();
    historyRef.current.future = [];
    projectRef.current = next;
    setProject(next);
  }, []);

  const updateObject = useCallback((id: string, change: (object: ModelSceneObject) => void) => {
    commit((draft) => {
      const object = draft.objects.find((item) => item.id === id);
      if (object) change(object);
    });
  }, [commit]);

  const notify = useCallback((message: string, error = false) => {
    setStatus(message);
    setStatusError(error);
  }, []);

  const renderPreview = useCallback((value: ModelProject, atMs: number) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const editRest = mode === "edit" || mode === "sculpt";
    const evaluated = evaluateModelFrame(value, editRest ? 0 : atMs);
    syncScene(scene, evaluated, value);
    const frame = frameForScene(evaluated, value);
    if (editRest) frame.boneRotations = {};
    scene.fitPreview(
      frame,
      value.render.outputFormat !== "mp4" && value.render.transparent,
      value.render.matteColor,
    );
  }, [mode]);

  const loadProjectAsset = useCallback(async (value: ModelProject) => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const item of scene.getSceneItems()) {
      if (item.type === "primitive") scene.removeItem(item.id);
    }
    const asset = value.assets.find((item) => item.kind === "glb");
    if (!asset) {
      scene.clearBase();
    } else if (asset.storageKey) {
      const bytes = await draftStoreRef.current!.loadAsset(asset.storageKey);
      if (!bytes) throw new Error("The model mesh for this draft is missing from local storage.");
      await scene.loadGlb(new Blob([bytes], { type: "model/gltf-binary" }), asset.name);
    } else if (asset.path === "/modeler/vitruvian.glb") {
      await scene.loadDefault();
    } else {
      throw new Error("This project references a mesh that is not available locally.");
    }
    for (const object of value.objects) {
      if (object.geometry) scene.addPrimitive(object.id, object.geometry.type as PrimitiveKind);
    }
    for (const overlay of value.assets.filter((item) => item.kind === "mesh" && item.storageKey)) {
      const bytes = await draftStoreRef.current!.loadAsset(overlay.storageKey!);
      const target = scene.getMesh(overlay.name);
      if (!bytes || !target) throw new Error("An edited mesh for this project is missing.");
      applyIndexedMeshToThree(target, decodeIndexedMesh(bytes));
    }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    const scene = new ModelerScene(host);
    sceneRef.current = scene;
    scene.onCameraChange = (position, target) => {
      setProject((current) => ({
        ...current,
        camera: { ...current.camera, position, target },
      }));
    };
    void (async () => {
      try {
        await scene.loadDefault();
        const saved = await draftStoreRef.current!.listDrafts();
        if (!active) return;
        setDrafts(saved);
        if (saved[0]) {
          const recent = await draftStoreRef.current!.loadDraft(saved[0].id);
          if (recent) {
            await loadProjectAsset(recent.project);
            if (!active) return;
            setProject(recent.project);
            setSelectedId(recent.project.objects[0]?.id ?? "");
          }
        }
        notify("Ready to sculpt, pose, and render.");
      } catch (error) {
        if (active) notify(error instanceof Error ? error.message : "The studio could not load its scene.", true);
      } finally {
        if (active) {
          setReady(true);
          setDraftsLoaded(true);
        }
      }
    })();
    return () => {
      active = false;
      scene.dispose();
      sceneRef.current = null;
    };
  }, [notify, loadProjectAsset]);

  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => renderPreview(project, timeMs));
    return () => cancelAnimationFrame(frame);
  }, [project, timeMs, ready, renderPreview]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.controls.enabled = mode === "object" || mode === "pose";
  }, [mode, ready]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let request = 0;
    const tick = (now: number) => {
      const elapsed = Math.min(100, now - last);
      last = now;
      setTimeMs((current) => (current + elapsed) % projectRef.current.durationMs);
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing]);

  useEffect(() => {
    if (!draftsLoaded) return;
    const timer = setTimeout(() => {
      void draftStoreRef.current!.saveDraft(project.name || "Untitled model scene", project)
        .then(() => draftStoreRef.current!.listDrafts())
        .then(setDrafts)
        .catch(() => notify("Local draft storage is full. Export a project bundle to keep a copy.", true));
    }, 700);
    return () => clearTimeout(timer);
  }, [project, notify, draftsLoaded]);

  const persistMesh = useCallback((meshName: string, mesh: IndexedPolygonMesh) => {
    let asset = projectRef.current.assets.find((item) => item.kind === "mesh" && item.name === meshName);
    if (!asset?.storageKey) {
      const next = cloneModelProject(projectRef.current);
      asset = { id: makeId("mesh-overlay"), name: meshName, kind: "mesh", storageKey: makeId("mesh") + ".rsmh" };
      next.assets.push(asset);
      projectRef.current = next;
      setProject(next);
    }
    const key = asset.storageKey;
    if (!key) return;
    const bytes = encodeIndexedMesh(mesh);
    persistQueueRef.current = persistQueueRef.current
      .then(() => draftStoreRef.current!.saveAsset(key, bytes))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "Mesh changes could not be saved.", true));
  }, [notify]);

  const pushMeshAction = (meshName: string, before: IndexedPolygonMesh, after: IndexedPolygonMesh) => {
    historyRef.current.past.push({ type: "mesh", meshName, before, after });
    if (historyRef.current.past.length > MAX_HISTORY) historyRef.current.past.shift();
    historyRef.current.future = [];
    refreshHistory((value) => value + 1);
    persistMesh(meshName, after);
  };

  const undo = () => {
    const step = historyRef.current.past.pop();
    if (!step) return;
    historyRef.current.future.push(step);
    refreshHistory((value) => value + 1);
    if (step.type === "project") {
      projectRef.current = step.before;
      setProject(step.before);
    } else {
      const target = sceneRef.current?.getMesh(step.meshName);
      if (target) {
        applyIndexedMeshToThree(target, step.before);
        persistMesh(step.meshName, step.before);
        renderPreview(projectRef.current, timeMs);
      }
    }
  };

  const redo = () => {
    const step = historyRef.current.future.pop();
    if (!step) return;
    historyRef.current.past.push(step);
    refreshHistory((value) => value + 1);
    if (step.type === "project") {
      projectRef.current = step.after;
      setProject(step.after);
    } else {
      const target = sceneRef.current?.getMesh(step.meshName);
      if (target) {
        applyIndexedMeshToThree(target, step.after);
        persistMesh(step.meshName, step.after);
        renderPreview(projectRef.current, timeMs);
      }
    }
  };

  const applyMeshOperation = (label: string, operation: (mesh: IndexedPolygonMesh) => IndexedPolygonMesh) => {
    const target = sceneRef.current?.getMesh(selectedMesh);
    if (!target) {
      notify("Select a mesh in the viewport first.", true);
      return;
    }
    try {
      const before = indexedMeshFromThree(target);
      const after = operation(before);
      applyIndexedMeshToThree(target, after);
      pushMeshAction(selectedMesh, before, after);
      sceneRef.current?.showSelection(selectedMesh, after, selectionRef.current);
      renderPreview(projectRef.current, timeMs);
      notify(label + " applied.");
    } catch (error) {
      notify(error instanceof Error ? error.message : label + " failed.", true);
    }
  };

  const newProject = async (starter: boolean) => {
    setPlaying(false);
    setTimeMs(0);
    historyRef.current = { past: [], future: [] };
    const next = starter ? createVitruvianProject() : createBlankModelProject();
    next.id = makeId("scene");
    if (starter) {
      try {
        await sceneRef.current?.loadDefault();
      } catch (error) {
        notify(error instanceof Error ? error.message : "The starter asset could not be loaded.", true);
      }
    } else {
      sceneRef.current?.clearBase();
    }
    setProject(next);
    setSelectedId(starter ? "vitruvian-figure" : "");
    notify(starter ? "Vitruvian preset loaded." : "New scene created.");
  };

  const addPrimitive = (kind: PrimitiveKind) => {
    const id = makeId(kind);
    const name = kind[0].toUpperCase() + kind.slice(1);
    const object: ModelSceneObject = {
      id,
      name,
      type: "mesh",
      transform: defaultTransform(),
      material: {
        ...defaultMaterial(),
        color: "#123e80",
        emissive: "#0066dd",
        emissiveIntensity: 1.8,
        metalness: 0.3,
      },
      geometry: { type: kind },
      visible: true,
      castShadow: false,
      receiveShadow: false,
    };
    commit((draft) => { draft.objects.push(object); });
    sceneRef.current?.addPrimitive(id, kind);
    setSelectedId(id);
    notify(name + " added.");
  };

  const addKeyframe = () => {
    const targetId = keyProperty.startsWith("camera") ? "camera"
      : keyProperty === "boneRotation" ? selectedRig?.id
      : keyProperty === "lightIntensity" ? project.lights.find((light) => light.type !== "ambient")?.id
      : selectedId;
    if (!targetId) return;
    const value = trackValue(project, keyProperty, targetId, selectedBone);
    const at = Math.round(timeMs);
    commit((draft) => {
      let track = draft.tracks.find((item) =>
        item.targetId === targetId && item.property === keyProperty &&
        (keyProperty !== "boneRotation" || item.boneName === selectedBone));
      if (!track) {
        track = {
          id: makeId("track"),
          targetId,
          property: keyProperty,
          boneName: keyProperty === "boneRotation" ? selectedBone : undefined,
          keyframes: [],
        };
        draft.tracks.push(track);
      }
      track.keyframes = [
        ...track.keyframes.filter((keyframe) => Math.abs(keyframe.timeMs - at) > 1),
        { timeMs: at, value: Array.isArray(value) ? [...value] : value, easing: "linear" as const },
      ].sort((a, b) => a.timeMs - b.timeMs);
    });
    notify("Keyframe saved at " + (at / 1000).toFixed(2) + "s.");
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mode === "pose") return;
    const scene = sceneRef.current;
    const hit = scene?.pick(event.clientX, event.clientY);
    if (!hit) return;
    setSelectedId(hit.id);
    setSelectedMesh(hit.meshName);
    setSelectedFace(hit.faceIndex);
    if (!scene || hit.faceIndex === null) return;
    const meshObject = scene.getMesh(hit.meshName);
    if (!meshObject) return;
    const data = indexedMeshFromThree(meshObject);
    const faceStart = hit.faceIndex * 3;
    const indices = Array.from(data.indices.slice(faceStart, faceStart + 3));
    const center = scene.localPoint(hit.meshName, hit.point);
    if (mode === "sculpt") {
      scene.clearSelection();
      sculptStrokeRef.current = { meshName: hit.meshName, before: data, lastPoint: center };
      event.currentTarget.setPointerCapture(event.pointerId);
      const after = applySculptBrush(data, {
        kind: brush as SculptBrushKind,
        center,
        radius: brushRadius,
        strength: brush === "grab" ? 0 : brushStrength * 0.2,
        direction: [0, 0, 0],
        symmetry,
      });
      applyIndexedMeshToThree(meshObject, after);
      renderPreview(projectRef.current, timeMs);
      return;
    }
    if (mode !== "edit" || indices.length !== 3) return;
    const selection = event.shiftKey && selectedMesh === hit.meshName ? {
      vertices: new Set(selectionRef.current.vertices),
      edges: new Set(selectionRef.current.edges),
      faces: new Set(selectionRef.current.faces),
    } : createMeshSelection();
    if (selectionKind === "face") {
      if (selection.faces.has(hit.faceIndex)) selection.faces.delete(hit.faceIndex);
      else selection.faces.add(hit.faceIndex);
    } else if (selectionKind === "vertex") {
      const nearest = indices.reduce((best, index) => {
        const offset = index * 3;
        const distance = Math.hypot(
          data.positions[offset]! - center[0],
          data.positions[offset + 1]! - center[1],
          data.positions[offset + 2]! - center[2],
        );
        return distance < best.distance ? { index, distance } : best;
      }, { index: indices[0]!, distance: Number.POSITIVE_INFINITY });
      if (selection.vertices.has(nearest.index)) selection.vertices.delete(nearest.index);
      else selection.vertices.add(nearest.index);
    } else {
      const edges = [[indices[0]!, indices[1]!], [indices[1]!, indices[2]!], [indices[2]!, indices[0]!]];
      const nearest = edges.reduce((best, pair) => {
        const a = pair[0] * 3;
        const b = pair[1] * 3;
        const distance = Math.hypot(
          (data.positions[a]! + data.positions[b]!) / 2 - center[0],
          (data.positions[a + 1]! + data.positions[b + 1]!) / 2 - center[1],
          (data.positions[a + 2]! + data.positions[b + 2]!) / 2 - center[2],
        );
        return distance < best.distance ? { pair, distance } : best;
      }, { pair: edges[0]!, distance: Number.POSITIVE_INFINITY });
      const key = edgeKey(nearest.pair[0], nearest.pair[1]);
      if (selection.edges.has(key)) selection.edges.delete(key);
      else selection.edges.add(key);
    }
    selectionRef.current = selection;
    scene.showSelection(hit.meshName, data, selection);
    setSelectionVersion((value) => value + 1);
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stroke = sculptStrokeRef.current;
    const scene = sceneRef.current;
    if (!stroke || !scene) return;
    const hit = scene.pick(event.clientX, event.clientY);
    if (!hit || hit.meshName !== stroke.meshName) return;
    const object = scene.getMesh(stroke.meshName);
    if (!object) return;
    const center = scene.localPoint(stroke.meshName, hit.point);
    const direction: Vec3 = [
      center[0] - stroke.lastPoint[0],
      center[1] - stroke.lastPoint[1],
      center[2] - stroke.lastPoint[2],
    ];
    stroke.lastPoint = center;
    const after = applySculptBrush(indexedMeshFromThree(object), {
      kind: brush as SculptBrushKind,
      center,
      radius: brushRadius,
      strength: brush === "grab" ? brushStrength : brushStrength * 0.16,
      direction,
      symmetry,
    });
    applyIndexedMeshToThree(object, after);
    renderPreview(projectRef.current, timeMs);
  };

  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stroke = sculptStrokeRef.current;
    sculptStrokeRef.current = null;
    if (!stroke) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const object = sceneRef.current?.getMesh(stroke.meshName);
    if (!object) return;
    pushMeshAction(stroke.meshName, stroke.before, indexedMeshFromThree(object));
    notify("Sculpt stroke saved.");
  };

  const onModelFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await sceneRef.current?.loadGlb(file, file.name.replace(/\.glb$/i, ""));
      const storageKey = makeId("mesh") + ".glb";
      await draftStoreRef.current!.saveAsset(storageKey, file);
      const bones = sceneRef.current?.getBones() ?? [];
      commit((draft) => {
        draft.name = file.name.replace(/\.glb$/i, "");
        draft.assets = [{ id: "vitruvian", name: file.name, kind: "glb", storageKey }];
        draft.objects = [{
          id: "vitruvian-figure",
          name: draft.name,
          type: "mesh",
          assetId: "vitruvian",
          rigId: bones.length ? "imported-rig" : undefined,
          transform: defaultTransform(),
          material: defaultMaterial(),
          visible: true,
          castShadow: false,
          receiveShadow: false,
        }];
        draft.rigs = bones.length ? [{
          id: "imported-rig",
          name: "Imported rig",
          bones: bones.map((name) => ({ name, rest: defaultTransform() })),
          pose: Object.fromEntries(bones.map((name) => [name, {
            position: [0, 0, 0] as Vec3,
            rotation: [0, 0, 0] as Vec3,
            scale: [1, 1, 1] as Vec3,
          }])),
        }] : [];
        draft.tracks = [];
      });
      setSelectedId("vitruvian-figure");
      setSelectedBone(bones[0] ?? "");
      notify("GLB loaded and stored in your browser.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The GLB could not be loaded.", true);
    }
  };

  const exportAsset = async (format: "glb" | "obj") => {
    const scene = sceneRef.current;
    if (!scene) return;
    try {
      if (format === "glb") {
        const clip = scene.createAssetClip(project.durationMs, (at) =>
          frameForScene(evaluateModelFrame(project, at), project));
        await scene.exportGlb(project.name + ".glb", [clip]);
      } else {
        scene.exportObj(project.name + ".obj");
      }
      notify(format.toUpperCase() + " downloaded.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Asset export failed.", true);
    }
  };

  const exportProjectBundle = async () => {
    try {
      const bundled = cloneModelProject(project);
      const assets: Record<string, ArrayBuffer> = {};
      for (const asset of bundled.assets) {
        const bytes = asset.storageKey
          ? await draftStoreRef.current!.loadAsset(asset.storageKey)
          : asset.path ? await (await fetch(asset.path)).arrayBuffer() : undefined;
        if (!bytes) throw new Error("A model asset is missing from this project.");
        const key = asset.storageKey ?? makeId("bundle-mesh") + ".glb";
        asset.storageKey = key;
        delete asset.path;
        assets[key] = bytes;
      }
      downloadBlob(await exportModelProjectBundleBlob(bundled, assets), project.name + ".rsm");
      notify("Project bundle downloaded with its meshes.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Project bundle export failed.", true);
    }
  };

  const onProjectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      let parsed: ModelProject;
      if (file.name.toLowerCase().endsWith(".rsm")) {
        const bundle = await importModelProjectBundle(file);
        parsed = bundle.project;
        for (const [key, bytes] of Object.entries(bundle.assets)) {
          await draftStoreRef.current!.saveAsset(key, bytes);
        }
      } else {
        parsed = parseModelProject(await file.text());
      }
      await loadProjectAsset(parsed);
      historyRef.current = { past: [], future: [] };
      setProject(parsed);
      setSelectedId(parsed.objects[0]?.id ?? "");
      setTimeMs(0);
      notify("Project loaded.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Project import failed.", true);
    }
  };

  const exportStill = () => {
    const scene = sceneRef.current;
    if (!scene) return;
    try {
      const evaluated = evaluateModelFrame(project, timeMs);
      syncScene(scene, evaluated, project);
      scene.renderFrame(
        frameForScene(evaluated, project),
        project.width,
        project.height,
        project.render.outputFormat !== "mp4" && project.render.transparent,
        project.render.matteColor,
        false,
      ).toBlob((blob) => {
        if (blob) downloadBlob(blob, project.name + "-" + Math.round(timeMs) + ".png");
        renderPreview(project, timeMs);
      }, "image/png");
    } catch (error) {
      notify(error instanceof Error ? error.message : "PNG render failed.", true);
    }
  };

  const exportVideo = async () => {
    notify("Video export is preparing...");
    setExporting(true);
    setExportProgress(0);
    exportAbortRef.current = new AbortController();
    try {
      const { exportModel } = await import("./export");
      const scene = sceneRef.current;
      if (!scene) throw new Error("3D renderer is unavailable.");
      const format = project.render.outputFormat === "prores4444"
        ? "mov" : project.render.outputFormat;
      const output = await exportModel({
        format,
        width: project.width,
        height: project.height,
        fps: project.fps,
        durationSeconds: project.durationMs / 1000,
        matte: project.render.matteColor,
        alpha: format !== "mp4" && project.render.transparent,
        basename: project.name.replace(/[^a-z0-9_-]+/gi, "-"),
        signal: exportAbortRef.current.signal,
        onProgress: setExportProgress,
        renderFrame: (seconds: number, width: number, height: number, alpha: boolean) => {
          const evaluated = evaluateModelFrame(project, seconds * 1000);
          syncScene(scene, evaluated, project);
          return scene.renderFrame(
            frameForScene(evaluated, project),
            width,
            height,
            alpha && project.render.transparent,
            project.render.matteColor,
            false,
          );
        },
      });
      if (output.blob) {
        const extension = format === "mov" ? ".mov" : "." + format;
        downloadBlob(output.blob, project.name + extension);
      }
      notify(format === "png-sequence" ? "PNG frames saved." : "Video export finished.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Video export failed.";
      const cause = error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause : undefined;
      const detail = cause instanceof Error ? " " + cause.message : "";
      notify(reason + detail, true);
    } finally {
      setExporting(false);
      exportAbortRef.current = null;
      renderPreview(project, timeMs);
    }
  };

  const visibleTracks = useMemo(
    () => project.tracks.filter((track) =>
      track.targetId === selectedId ||
      track.targetId === selectedRig?.id ||
      track.targetId === "camera" ||
      project.lights.some((light) => light.id === track.targetId)),
    [project.tracks, project.lights, selectedId, selectedRig?.id],
  );

  return (
    <div className="modeler-studio">
      <header className="modeler-topbar">
        <div className="modeler-brand">
          <strong>RAPID<span>SCREEN</span></strong>
          <small>/ 3D MODEL STUDIO</small>
        </div>
        <div className="modeler-top-actions">
          <input
            className="modeler-project-name"
            aria-label="Project name"
            value={project.name}
            onChange={(event) => setProject((current) => ({ ...current, name: event.target.value }))}
          />
          <button className="modeler-icon-button" aria-label="Undo" title="Undo" onClick={undo} disabled={!historyRef.current.past.length}><Undo2 size={14} /></button>
          <button className="modeler-icon-button" aria-label="Redo" title="Redo" onClick={redo} disabled={!historyRef.current.future.length}><Redo2 size={14} /></button>
          <button className="modeler-button" onClick={() => setShowDrafts((value) => !value)}><FolderOpen size={13} /> Drafts</button>
          <button className="modeler-button" onClick={() => void exportProjectBundle()}><Save size={13} /> Save bundle</button>
          <button className="modeler-icon-button" aria-label="Import project bundle" title="Import project bundle" onClick={() => projectFileRef.current?.click()}><Upload size={13} /></button>
          <button className="modeler-button is-primary" onClick={exportVideo} disabled={!ready || exporting}><Film size={13} /> Render clip</button>
        </div>
      </header>

      <div className="modeler-workspace">
        <aside className="modeler-sidebar" aria-label="Scene and assets">
          <PanelSection title="Start" aside="01 / scene">
            <div className="modeler-presets">
              <button className="modeler-preset" onClick={() => void newProject(true)}><span>VITRUVIAN</span><small>pose + 360 spin</small></button>
              <button className="modeler-preset" onClick={() => void newProject(false)}><span>EMPTY SCENE</span><small>build from shapes</small></button>
            </div>
          </PanelSection>
          <PanelSection title="Outliner" aside={String(project.objects.length).padStart(2, "0")}>
            <div className="modeler-list">
              {project.objects.map((object) => (
                <div className="modeler-row" key={object.id}>
                  <button
                    className={"modeler-list-button" + (selectedId === object.id ? " is-selected" : "")}
                    onClick={() => setSelectedId(object.id)}
                  >
                    {object.type === "ring" ? <Circle size={13} /> : <Box size={13} />}
                    <span>{object.name}</span>
                    <span className="modeler-subtle">{object.type}</span>
                  </button>
                  <button
                    className="modeler-icon-button"
                    aria-label={(object.visible ? "Hide " : "Show ") + object.name}
                    onClick={() => updateObject(object.id, (item) => { item.visible = !item.visible; })}
                  >{object.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
                </div>
              ))}
              {!project.objects.length && <p className="modeler-empty">Add a primitive or import a model.</p>}
            </div>
          </PanelSection>
          <PanelSection title="Add geometry" aside="mesh">
            <div className="modeler-fields-2">
              {(["box", "sphere", "torus", "cylinder"] as PrimitiveKind[]).map((kind) => (
                <button className="modeler-button" key={kind} onClick={() => addPrimitive(kind)}><Plus size={12} /> {kind}</button>
              ))}
            </div>
          </PanelSection>
          <PanelSection title="Assets" aside="local">
            <div className="modeler-action-row">
              <button className="modeler-button" onClick={() => fileRef.current?.click()}><Upload size={13} /> Import GLB</button>
              <input ref={fileRef} type="file" accept=".glb,model/gltf-binary" hidden onChange={(event) => void onModelFile(event)} />
            </div>
            <p className="modeler-hint">The first figure is an editable rigged GLB. Imported meshes stay on this device.</p>
          </PanelSection>
          {showDrafts && <PanelSection title="Named drafts" aside={String(drafts.length)}>
            <div className="modeler-list">
              {drafts.map((draft) => (
                <button
                  key={draft.id}
                  className="modeler-list-button"
                  onClick={() => {
                    void draftStoreRef.current!.loadDraft(draft.id).then(async (record) => {
                      if (!record) return;
                      await loadProjectAsset(record.project);
                      setProject(record.project);
                      setSelectedId(record.project.objects[0]?.id ?? "");
                      setTimeMs(0);
                      setShowDrafts(false);
                    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "Draft could not be loaded.", true));
                  }}
                >{draft.name}<span className="modeler-subtle">{new Date(draft.updatedAt).toLocaleDateString()}</span></button>
              ))}
              {!drafts.length && <p className="modeler-empty">Projects appear here after autosave.</p>}
            </div>
          </PanelSection>}
        </aside>

        <section className="modeler-stage" aria-label="3D viewport">
          <div className="modeler-stage-head">
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                className={"modeler-button" + (mode === tool.id ? " is-active" : "")}
                onClick={() => {
                  setMode(tool.id);
                  if (tool.id !== "edit") sceneRef.current?.clearSelection();
                  if (tool.id === "edit" || tool.id === "sculpt") {
                    setPlaying(false);
                    setTimeMs(0);
                  }
                }}
              >{tool.label}</button>
            ))}
            <span className="modeler-spacer" />
            <span className="modeler-overline">THREE.JS / WEBGL</span>
          </div>
          <div className="modeler-viewport-wrap">
            <div
              className={"modeler-viewport" + (project.render.outputFormat === "mp4" || !project.render.transparent ? " is-opaque" : "")}
              style={{ aspectRatio: String(project.width) + " / " + String(project.height), "--modeler-aspect": project.width / project.height } as React.CSSProperties}
              ref={hostRef}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            >
              <span className="modeler-viewport-corner top">CAM 01 · PERSPECTIVE</span>
              <span className="modeler-viewport-corner bottom">{project.width} × {project.height} / {project.fps} FPS</span>
              {!ready && <span className="modeler-overlay-message">Loading 3D scene...</span>}
            </div>
          </div>
          <div className="modeler-stage-foot">
            <span>{mode === "edit" || mode === "sculpt" ? "Editing the rest pose · Drag to orbit · Click mesh to select" : "Drag to orbit · Scroll to zoom · Click mesh to select"}</span>
            <span>{selectedMesh || "No mesh selected"}{selectedFace !== null ? " · face " + selectedFace : ""}</span>
          </div>
        </section>

        <aside className="modeler-inspector" aria-label="Properties">
          <PanelSection title="Selection" aside={mode}>
            <div className="modeler-field">
              <label>Object</label>
              <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                <option value="">None</option>
                {project.objects.map((object) => <option key={object.id} value={object.id}>{object.name}</option>)}
              </select>
            </div>
            {selected && <>
              <div className="modeler-field">
                <label>Name</label>
                <input value={selected.name} onChange={(event) => updateObject(selected.id, (item) => { item.name = event.target.value; })} />
              </div>
              <div className="modeler-action-row">
                <button
                  className="modeler-button"
                  disabled={selected.id === "vitruvian-figure"}
                  onClick={() => {
                    commit((draft) => { draft.objects = draft.objects.filter((item) => item.id !== selected.id); });
                    sceneRef.current?.removeItem(selected.id);
                    setSelectedId("vitruvian-figure");
                  }}
                ><Trash2 size={12} /> Delete</button>
              </div>
            </>}
          </PanelSection>
          {selected && <PanelSection title="Transform" aside="XYZ">
            <VectorFields label="Position" value={selected.transform.position} onChange={(value) => updateObject(selected.id, (item) => { item.transform.position = value; })} />
            <VectorFields label="Rotation °" value={selected.transform.rotation} step={1} onChange={(value) => updateObject(selected.id, (item) => { item.transform.rotation = value; })} />
            <VectorFields label="Scale" value={selected.transform.scale} min={0.01} onChange={(value) => updateObject(selected.id, (item) => { item.transform.scale = value; })} />
          </PanelSection>}
          {mode === "pose" && selectedRig && <PanelSection title="Bone pose" aside={String(selectedRig.bones.length)}>
            <div className="modeler-field">
              <label>Bone</label>
              <select aria-label="Bone" value={selectedBone} onChange={(event) => setSelectedBone(event.target.value)}>
                {selectedRig.bones.map((bone) => <option value={bone.name} key={bone.name}>{bone.name}</option>)}
              </select>
            </div>
            <VectorFields
              label="Rotation °"
              value={selectedRig.pose[selectedBone]?.rotation ?? [0, 0, 0]}
              step={1}
              onChange={(value) => commit((draft) => {
                const rig = draft.rigs.find((item) => item.id === selectedRig.id);
                if (rig?.pose[selectedBone]) rig.pose[selectedBone].rotation = value;
              })}
            />
            <p className="modeler-hint">Pose existing bones. Use the keyframe button below to animate the selected limb.</p>
          </PanelSection>}
          {mode === "edit" && <PanelSection title="Polygon edit" aside="selection">
            <div className="modeler-field">
              <label>Selection</label>
              <select value={selectionKind} onChange={(event) => {
                setSelectionKind(event.target.value as SelectionKind);
                selectionRef.current = createMeshSelection();
                sceneRef.current?.clearSelection();
                setSelectionVersion((value) => value + 1);
              }}>
                <option value="vertex">Vertex</option>
                <option value="edge">Edge</option>
                <option value="face">Face</option>
              </select>
            </div>
            <p className="modeler-hint">Shift-click to add or remove polygons.</p>
            <p className="modeler-hint">
              {selectedMesh || "Click a mesh"} · {selectionKind} · {
                selectionKind === "vertex" ? selectionRef.current.vertices.size :
                selectionKind === "edge" ? selectionRef.current.edges.size :
                selectionRef.current.faces.size
              } selected
            </p>
            <VectorFields label="Move / rotate amount" value={meshDelta} onChange={setMeshDelta} step={0.05} />
            <div className="modeler-action-row">
              <button className="modeler-button" onClick={() => applyMeshOperation("Move", (mesh) => moveVertices(mesh, selectionRef.current, meshDelta, { symmetry }))}>Move</button>
              <button className="modeler-button" onClick={() => applyMeshOperation("Rotate", (mesh) => rotateVertices(mesh, selectionRef.current, meshDelta, { symmetry }))}>Rotate</button>
              <button className="modeler-button" onClick={() => applyMeshOperation("Scale", (mesh) => scaleVertices(mesh, selectionRef.current, [1 + meshDelta[0], 1 + meshDelta[1], 1 + meshDelta[2]], { symmetry }))}>Scale</button>
            </div>
            <NumberField label="Topology amount" value={meshAmount} onChange={setMeshAmount} min={0.001} max={1} step={0.01} />
            <div className="modeler-action-row">
              <button className="modeler-button" disabled={!selectionRef.current.faces.size} onClick={() => applyMeshOperation("Extrude", (mesh) => extrudeFaces(mesh, selectionRef.current.faces, meshAmount))}>Extrude</button>
              <button className="modeler-button" disabled={!selectionRef.current.faces.size} onClick={() => applyMeshOperation("Inset", (mesh) => insetFaces(mesh, selectionRef.current.faces, meshAmount))}>Inset</button>
              <button className="modeler-button" disabled={!selectionRef.current.edges.size} onClick={() => applyMeshOperation("Bevel", (mesh) => bevelEdges(mesh, selectionRef.current.edges, meshAmount))}>Bevel</button>
            </div>
            <div className="modeler-action-row">
              <button className="modeler-button" onClick={() => applyMeshOperation("Remesh", (mesh) => remeshStatic(mesh, { targetEdgeLength: meshAmount }))}>Remesh static</button>
            </div>
            <p className="modeler-hint">Remesh applies to static meshes. Rigged geometry keeps its skin weights during the other edits.</p>
          </PanelSection>}
          {mode === "sculpt" && <PanelSection title="Sculpt" aside="brush">
            <div className="modeler-field">
              <label>Brush</label>
              <select value={brush} onChange={(event) => setBrush(event.target.value)}>
                {["grab", "inflate", "smooth", "flatten", "crease", "pinch"].map((value) => <option key={value}>{value}</option>)}
              </select>
            </div>
            <NumberField label="Radius" value={brushRadius} onChange={setBrushRadius} min={0.01} max={2} step={0.01} range />
            <NumberField label="Strength" value={brushStrength} onChange={setBrushStrength} min={0.01} max={1} step={0.01} range />
            <label className="modeler-row"><input type="checkbox" checked={symmetry} onChange={(event) => setSymmetry(event.target.checked)} /> X symmetry</label>
          </PanelSection>}
          {selected && <PanelSection title="Material" aside="surface">
            <div className="modeler-fields-2">
              <div className="modeler-field"><label>Base</label><input type="color" value={selected.material.color} onChange={(event) => updateObject(selected.id, (item) => { item.material.color = event.target.value; })} /></div>
              <div className="modeler-field"><label>Emission</label><input type="color" value={selected.material.emissive} onChange={(event) => updateObject(selected.id, (item) => { item.material.emissive = event.target.value; })} /></div>
            </div>
            <NumberField label="Emission" value={selected.material.emissiveIntensity} onChange={(value) => updateObject(selected.id, (item) => { item.material.emissiveIntensity = value; })} min={0} max={10} step={0.1} range />
            <NumberField label="Metalness" value={selected.material.metalness} onChange={(value) => updateObject(selected.id, (item) => { item.material.metalness = value; })} min={0} max={1} step={0.01} range />
            <NumberField label="Roughness" value={selected.material.roughness} onChange={(value) => updateObject(selected.id, (item) => { item.material.roughness = value; })} min={0} max={1} step={0.01} range />
            <NumberField label="Opacity" value={selected.material.opacity} onChange={(value) => updateObject(selected.id, (item) => { item.material.opacity = value; })} min={0} max={1} step={0.01} range />
          </PanelSection>}
          <PanelSection title="Look and camera" aside="render">
            <NumberField label="Glow" value={project.render.glowIntensity} onChange={(value) => commit((draft) => { draft.render.glowIntensity = value; })} min={0} max={6} step={0.1} range />
            <NumberField label="Field of view" value={project.camera.fov} onChange={(value) => commit((draft) => { draft.camera.fov = value; })} min={20} max={80} step={1} range />
            <NumberField label="Rim light" value={project.lights.find((light) => light.type !== "ambient")?.intensity ?? 0} onChange={(value) => commit((draft) => {
              const light = draft.lights.find((item) => item.type !== "ambient");
              if (light) light.intensity = value;
            })} min={0} max={30} step={0.1} range />
          </PanelSection>
        </aside>
      </div>

      <section className="modeler-timeline" aria-label="Animation timeline">
        <div className="modeler-timeline-head">
          <div className="modeler-transport">
            <button className="modeler-icon-button" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
            <button className="modeler-icon-button" aria-label="Return to start" onClick={() => { setPlaying(false); setTimeMs(0); }}><RotateCcw size={13} /></button>
            <span className="modeler-timecode">{(timeMs / 1000).toFixed(2)}s</span>
          </div>
          <span className="modeler-spacer" />
          <select aria-label="Keyframe property" value={keyProperty} onChange={(event) => setKeyProperty(event.target.value as ModelTrackProperty)}>
            {TRACK_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <button className="modeler-button" onClick={addKeyframe}><Diamond size={12} /> Add key</button>
          <button className="modeler-button" onClick={() => void exportAsset("glb")}><Download size={12} /> GLB</button>
          <button className="modeler-button" onClick={() => void exportAsset("obj")}><Download size={12} /> OBJ</button>
        </div>
        <div className="modeler-timeline-body">
          <div className="modeler-track-list">
            <div className="modeler-section-title">Animation tracks <span>{visibleTracks.length}</span></div>
            {visibleTracks.map((track) => (
              <div className="modeler-track-name" key={track.id}><SlidersHorizontal size={11} /> {track.property}{track.boneName ? " / " + track.boneName : ""}</div>
            ))}
            {!visibleTracks.length && <p className="modeler-empty">Add a keyframe to animate this scene.</p>}
          </div>
          <div className="modeler-ruler-wrap">
            <div
              className="modeler-ruler"
              onPointerDown={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setTimeMs(Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * project.durationMs));
              }}
            >
              {Array.from({ length: 7 }, (_, index) => <span key={index}>{(index * durationSeconds / 6).toFixed(0)}s</span>)}
            </div>
            <div className="modeler-lanes">
              <span className="modeler-playhead" style={{ left: String((timeMs / project.durationMs) * 100) + "%" }} />
              {visibleTracks.map((track) => (
                <div className="modeler-lane" key={track.id}>
                  {track.keyframes.map((keyframe, index) => (
                    <button
                      key={index}
                      className="modeler-key"
                      style={{ left: String((keyframe.timeMs / project.durationMs) * 100) + "%" }}
                      title={track.property + " · " + (keyframe.timeMs / 1000).toFixed(2) + "s"}
                      aria-label={"Seek to " + (keyframe.timeMs / 1000).toFixed(2) + " seconds"}
                      onClick={() => setTimeMs(keyframe.timeMs)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="modeler-export-panel">
            <div className="modeler-row">
              <span className="modeler-overline">OUTPUT</span>
              <select
                aria-label="Canvas resolution"
                value={String(project.width) + "x" + String(project.height)}
                onChange={(event) => {
                  const preset = RESOLUTIONS.find((item) => item.width + "x" + item.height === event.target.value);
                  if (preset) commit((draft) => { draft.width = preset.width; draft.height = preset.height; });
                }}
              >
                {RESOLUTIONS.map((preset) => <option key={preset.label} value={preset.width + "x" + preset.height}>{preset.label}</option>)}
              </select>
            </div>
            <div className="modeler-row">
              <label htmlFor="modeler-duration">Duration</label>
              <input id="modeler-duration" type="number" min={1} max={30} step={0.5} value={durationSeconds} onChange={(event) => {
                const seconds = Number(event.target.value);
                if (!Number.isFinite(seconds)) return;
                commit((draft) => { draft.durationMs = Math.max(1000, Math.min(30000, Math.round(seconds * 1000))); });
              }} />
              <span>s</span>
            </div>
            <div className="modeler-row">
              <label htmlFor="modeler-format">Format</label>
              <select id="modeler-format" value={project.render.outputFormat} onChange={(event) => commit((draft) => { draft.render.outputFormat = event.target.value as ExportFormat; })}>
                <option value="prores4444">MOV · ProRes 4444</option>
                <option value="webm">WebM · alpha</option>
                <option value="png-sequence">PNG frames</option>
                <option value="mp4">MP4 · matte</option>
              </select>
            </div>
            <div className="modeler-row">
              <label><input type="checkbox" checked={project.render.outputFormat !== "mp4" && project.render.transparent} disabled={project.render.outputFormat === "mp4"} onChange={(event) => commit((draft) => {
                draft.render.transparent = event.target.checked;
                draft.render.background = event.target.checked ? "transparent" : "solid";
              })} /> Alpha</label>
              <input aria-label="MP4 matte color" type="color" value={project.render.matteColor} onChange={(event) => commit((draft) => { draft.render.matteColor = event.target.value; })} />
            </div>
            {project.render.outputFormat === "prores4444" && <span className="modeler-status">MOV uses the local FFmpeg helper.</span>}
            {project.render.outputFormat === "mp4" && <span className="modeler-status">MP4 renders onto the matte colour.</span>}
            {exporting && <div className="modeler-progress"><span style={{ width: String(Math.round(exportProgress * 100)) + "%" }} /></div>}
            <div className="modeler-row">
              <button className="modeler-button" onClick={exportStill}><Sparkles size={12} /> Still PNG</button>
              {exporting && <button className="modeler-button" onClick={() => exportAbortRef.current?.abort()}><X size={12} /> Cancel</button>}
            </div>
            <div className={"modeler-status" + (statusError ? " is-error" : "")} title={status}>{status}</div>
          </div>
        </div>
      </section>
      <input ref={projectFileRef} type="file" accept=".rsm,.json,application/json" hidden onChange={(event) => void onProjectFile(event)} />
    </div>
  );
}
