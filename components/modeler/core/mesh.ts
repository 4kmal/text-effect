export type MeshVector3 = [number, number, number];

export type IndexedPolygonMesh = {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  skinIndices?: Uint16Array;
  skinWeights?: Float32Array;
};

export type MeshSelection = {
  vertices: Set<number>;
  edges: Set<string>;
  faces: Set<number>;
};

export type VertexTransformOptions = {
  symmetry?: boolean;
  tolerance?: number;
  pivot?: MeshVector3;
};

export type SculptBrushKind =
  | "grab"
  | "inflate"
  | "smooth"
  | "flatten"
  | "crease"
  | "pinch";

export type SculptBrush = {
  kind: SculptBrushKind;
  center: MeshVector3;
  radius: number;
  strength: number;
  direction?: MeshVector3;
  axis?: 0 | 1 | 2;
  plane?: number;
  symmetry?: boolean;
  selection?: MeshSelection;
};

type MutableMesh = {
  positions: number[];
  indices: number[];
  normals?: number[];
  uvs?: number[];
  skinIndices?: number[];
  skinWeights?: number[];
};

type VertexData = {
  position: MeshVector3;
  normal?: MeshVector3;
  uv?: [number, number];
  skinIndices?: [number, number, number, number];
  skinWeights?: [number, number, number, number];
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const length = (value: MeshVector3): number =>
  Math.hypot(value[0], value[1], value[2]);

const normalize = (value: MeshVector3): MeshVector3 => {
  const size = length(value);
  return size > 1e-8 ? [value[0] / size, value[1] / size, value[2] / size] : [0, 1, 0];
};

const add = (a: MeshVector3, b: MeshVector3): MeshVector3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];

const subtract = (a: MeshVector3, b: MeshVector3): MeshVector3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

const multiply = (a: MeshVector3, scalar: number): MeshVector3 => [
  a[0] * scalar,
  a[1] * scalar,
  a[2] * scalar,
];

const cross = (a: MeshVector3, b: MeshVector3): MeshVector3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const dot = (a: MeshVector3, b: MeshVector3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const lerp = (a: MeshVector3, b: MeshVector3, amount: number): MeshVector3 => [
  a[0] + (b[0] - a[0]) * amount,
  a[1] + (b[1] - a[1]) * amount,
  a[2] + (b[2] - a[2]) * amount,
];

type MeshTypedArray = Float32Array | Uint32Array | Uint16Array;

const cloneArray = <T extends MeshTypedArray>(value: T): T =>
  value.slice() as T;

export function cloneIndexedMesh(mesh: IndexedPolygonMesh): IndexedPolygonMesh {
  return {
    positions: cloneArray(mesh.positions),
    indices: cloneArray(mesh.indices),
    normals: mesh.normals ? cloneArray(mesh.normals) : undefined,
    uvs: mesh.uvs ? cloneArray(mesh.uvs) : undefined,
    skinIndices: mesh.skinIndices ? cloneArray(mesh.skinIndices) : undefined,
    skinWeights: mesh.skinWeights ? cloneArray(mesh.skinWeights) : undefined,
  };
}

export function validateIndexedMesh(mesh: IndexedPolygonMesh): void {
  if (mesh.positions.length % 3 !== 0) throw new Error("Mesh positions must contain three components per vertex");
  if (mesh.indices.length % 3 !== 0) throw new Error("Mesh indices must contain three indices per face");
  const vertexCount = mesh.positions.length / 3;
  for (let index = 0; index < mesh.indices.length; index += 1) {
    if (!Number.isInteger(mesh.indices[index]) || mesh.indices[index]! < 0 || mesh.indices[index]! >= vertexCount) {
      throw new Error(`Mesh index ${index} is outside the vertex buffer`);
    }
  }
  if (mesh.normals && mesh.normals.length !== mesh.positions.length) throw new Error("Mesh normals must match positions");
  if (mesh.uvs && mesh.uvs.length !== vertexCount * 2) throw new Error("Mesh UVs must contain two components per vertex");
  if (mesh.skinIndices && mesh.skinIndices.length !== vertexCount * 4) throw new Error("Mesh skin indices must contain four entries per vertex");
  if (mesh.skinWeights && mesh.skinWeights.length !== vertexCount * 4) throw new Error("Mesh skin weights must contain four entries per vertex");
  for (const value of mesh.positions) if (!Number.isFinite(value)) throw new Error("Mesh positions must be finite");
}

export function createMeshSelection(
  values: Partial<{ vertices: Iterable<number>; edges: Iterable<string>; faces: Iterable<number> }> = {},
): MeshSelection {
  return {
    vertices: new Set(values.vertices ?? []),
    edges: new Set(values.edges ?? []),
    faces: new Set(values.faces ?? []),
  };
}

export const edgeKey = (a: number, b: number): string =>
  a < b ? `${a}:${b}` : `${b}:${a}`;

const parseEdgeKey = (key: string): [number, number] | undefined => {
  const parts = key.split(":");
  if (parts.length !== 2) return undefined;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return Number.isInteger(a) && Number.isInteger(b) ? [a, b] : undefined;
};

export function selectionVertices(mesh: IndexedPolygonMesh, selection: MeshSelection): Set<number> {
  const vertices = new Set<number>();
  selection.vertices.forEach((index) => vertices.add(index));
  selection.edges.forEach((key) => {
    const parsed = parseEdgeKey(key);
    if (parsed) {
      vertices.add(parsed[0]);
      vertices.add(parsed[1]);
    }
  });
  selection.faces.forEach((face) => {
    const offset = face * 3;
    if (offset >= 0 && offset + 2 < mesh.indices.length) {
      vertices.add(mesh.indices[offset]!);
      vertices.add(mesh.indices[offset + 1]!);
      vertices.add(mesh.indices[offset + 2]!);
    }
  });
  return new Set([...vertices].filter((index) => index >= 0 && index < mesh.positions.length / 3));
}

const mutableFrom = (mesh: IndexedPolygonMesh): MutableMesh => {
  validateIndexedMesh(mesh);
  return {
    positions: Array.from(mesh.positions),
    indices: Array.from(mesh.indices),
    normals: mesh.normals ? Array.from(mesh.normals) : undefined,
    uvs: mesh.uvs ? Array.from(mesh.uvs) : undefined,
    skinIndices: mesh.skinIndices ? Array.from(mesh.skinIndices) : undefined,
    skinWeights: mesh.skinWeights ? Array.from(mesh.skinWeights) : undefined,
  };
};

const toTypedMesh = (mesh: MutableMesh): IndexedPolygonMesh => {
  const result: IndexedPolygonMesh = {
    positions: new Float32Array(mesh.positions),
    indices: new Uint32Array(mesh.indices),
  };
  if (mesh.normals) result.normals = new Float32Array(mesh.normals);
  if (mesh.uvs) result.uvs = new Float32Array(mesh.uvs);
  if (mesh.skinIndices) result.skinIndices = new Uint16Array(mesh.skinIndices);
  if (mesh.skinWeights) result.skinWeights = new Float32Array(mesh.skinWeights);
  return result;
};

const readVertex = (mesh: MutableMesh, index: number): VertexData => {
  const position: MeshVector3 = [
    mesh.positions[index * 3] ?? 0,
    mesh.positions[index * 3 + 1] ?? 0,
    mesh.positions[index * 3 + 2] ?? 0,
  ];
  const vertex: VertexData = { position };
  if (mesh.normals) vertex.normal = [mesh.normals[index * 3] ?? 0, mesh.normals[index * 3 + 1] ?? 0, mesh.normals[index * 3 + 2] ?? 0];
  if (mesh.uvs) vertex.uv = [mesh.uvs[index * 2] ?? 0, mesh.uvs[index * 2 + 1] ?? 0];
  if (mesh.skinIndices) vertex.skinIndices = [
    mesh.skinIndices[index * 4] ?? 0,
    mesh.skinIndices[index * 4 + 1] ?? 0,
    mesh.skinIndices[index * 4 + 2] ?? 0,
    mesh.skinIndices[index * 4 + 3] ?? 0,
  ];
  if (mesh.skinWeights) vertex.skinWeights = [
    mesh.skinWeights[index * 4] ?? 0,
    mesh.skinWeights[index * 4 + 1] ?? 0,
    mesh.skinWeights[index * 4 + 2] ?? 0,
    mesh.skinWeights[index * 4 + 3] ?? 0,
  ];
  return vertex;
};

const appendVertex = (mesh: MutableMesh, vertex: VertexData): number => {
  const index = mesh.positions.length / 3;
  mesh.positions.push(...vertex.position);
  if (mesh.normals) mesh.normals.push(...(vertex.normal ?? [0, 1, 0]));
  if (mesh.uvs) mesh.uvs.push(...(vertex.uv ?? [0, 0]));
  if (mesh.skinIndices) mesh.skinIndices.push(...(vertex.skinIndices ?? [0, 0, 0, 0]));
  if (mesh.skinWeights) mesh.skinWeights.push(...(vertex.skinWeights ?? [1, 0, 0, 0]));
  return index;
};

const averageVertex = (mesh: MutableMesh, indices: number[], weights?: number[]): VertexData => {
  const safeWeights = weights ?? indices.map(() => 1 / Math.max(1, indices.length));
  const result: VertexData = { position: [0, 0, 0] };
  const skinWeights = new Map<number, number>();
  indices.forEach((index, item) => {
    const vertex = readVertex(mesh, index);
    const weight = safeWeights[item] ?? 0;
    result.position = add(result.position, multiply(vertex.position, weight));
    if (vertex.normal) result.normal = add(result.normal ?? [0, 0, 0], multiply(vertex.normal, weight));
    if (vertex.uv) {
      result.uv = [
        (result.uv?.[0] ?? 0) + vertex.uv[0] * weight,
        (result.uv?.[1] ?? 0) + vertex.uv[1] * weight,
      ];
    }
    if (vertex.skinIndices && vertex.skinWeights) {
      vertex.skinIndices.forEach((bone, slot) => skinWeights.set(bone, (skinWeights.get(bone) ?? 0) + vertex.skinWeights![slot]! * weight));
    }
  });
  if (result.normal) result.normal = normalize(result.normal);
  if (skinWeights.size > 0) {
    const top = [...skinWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((sum, entry) => sum + entry[1], 0) || 1;
    result.skinIndices = [top[0]?.[0] ?? 0, top[1]?.[0] ?? 0, top[2]?.[0] ?? 0, top[3]?.[0] ?? 0];
    result.skinWeights = [top[0]?.[1] ?? 0, top[1]?.[1] ?? 0, top[2]?.[1] ?? 0, top[3]?.[1] ?? 0].map((weight) => weight / total) as [number, number, number, number];
  }
  return result;
};

const blendVertexData = (from: VertexData, to: VertexData, amount: number): VertexData => {
  const result: VertexData = {
    position: lerp(from.position, to.position, amount),
  };
  if (from.normal || to.normal) result.normal = normalize(lerp(from.normal ?? [0, 1, 0], to.normal ?? [0, 1, 0], amount));
  if (from.uv || to.uv) result.uv = [
    (from.uv?.[0] ?? 0) + ((to.uv?.[0] ?? 0) - (from.uv?.[0] ?? 0)) * amount,
    (from.uv?.[1] ?? 0) + ((to.uv?.[1] ?? 0) - (from.uv?.[1] ?? 0)) * amount,
  ];
  if (from.skinIndices && from.skinWeights || to.skinIndices && to.skinWeights) {
    const weights = new Map<number, number>();
    for (const [indices, values, factor] of [
      [from.skinIndices, from.skinWeights, 1 - amount],
      [to.skinIndices, to.skinWeights, amount],
    ] as const) {
      if (!indices || !values) continue;
      indices.forEach((bone, index) => weights.set(bone, (weights.get(bone) ?? 0) + values[index]! * factor));
    }
    const top = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((sum, entry) => sum + entry[1], 0) || 1;
    result.skinIndices = [top[0]?.[0] ?? 0, top[1]?.[0] ?? 0, top[2]?.[0] ?? 0, top[3]?.[0] ?? 0];
    result.skinWeights = [top[0]?.[1] ?? 0, top[1]?.[1] ?? 0, top[2]?.[1] ?? 0, top[3]?.[1] ?? 0].map((value) => value / total) as [number, number, number, number];
  }
  return result;
};

const faceNormal = (mesh: MutableMesh, face: number): MeshVector3 => {
  const offset = face * 3;
  const a = readVertex(mesh, mesh.indices[offset]! ).position;
  const b = readVertex(mesh, mesh.indices[offset + 1]! ).position;
  const c = readVertex(mesh, mesh.indices[offset + 2]! ).position;
  return normalize(cross(subtract(b, a), subtract(c, a)));
};

export function recomputeMeshNormals(mesh: IndexedPolygonMesh): IndexedPolygonMesh {
  const result = cloneIndexedMesh(mesh);
  const normals = new Float32Array(result.positions.length);
  for (let face = 0; face < result.indices.length / 3; face += 1) {
    const a = result.indices[face * 3]!;
    const b = result.indices[face * 3 + 1]!;
    const c = result.indices[face * 3 + 2]!;
    const ap: MeshVector3 = [result.positions[a * 3]!, result.positions[a * 3 + 1]!, result.positions[a * 3 + 2]!];
    const bp: MeshVector3 = [result.positions[b * 3]!, result.positions[b * 3 + 1]!, result.positions[b * 3 + 2]!];
    const cp: MeshVector3 = [result.positions[c * 3]!, result.positions[c * 3 + 1]!, result.positions[c * 3 + 2]!];
    const normal = cross(subtract(bp, ap), subtract(cp, ap));
    for (const index of [a, b, c]) {
      normals[index * 3] += normal[0];
      normals[index * 3 + 1] += normal[1];
      normals[index * 3 + 2] += normal[2];
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const normal = normalize([normals[index]!, normals[index + 1]!, normals[index + 2]!]);
    normals[index] = normal[0];
    normals[index + 1] = normal[1];
    normals[index + 2] = normal[2];
  }
  result.normals = normals;
  return result;
}

const mirrorVertex = (mesh: MutableMesh, index: number, tolerance: number): number | undefined => {
  const source = readVertex(mesh, index).position;
  let best: number | undefined;
  let bestDistance = tolerance * tolerance;
  for (let candidate = 0; candidate < mesh.positions.length / 3; candidate += 1) {
    if (candidate === index) continue;
    const position = readVertex(mesh, candidate).position;
    const distance = (position[0] + source[0]) ** 2 + (position[1] - source[1]) ** 2 + (position[2] - source[2]) ** 2;
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

const selectedWithSymmetry = (mesh: MutableMesh, selection: MeshSelection, options: VertexTransformOptions): Map<number, boolean> => {
  const indices = selectionVertices(toTypedMesh(mesh), selection);
  const result = new Map<number, boolean>();
  indices.forEach((index) => result.set(index, false));
  if (options.symmetry) {
    indices.forEach((index) => {
      const mirror = mirrorVertex(mesh, index, options.tolerance ?? 0.001);
      if (mirror !== undefined && !result.has(mirror)) result.set(mirror, true);
    });
  }
  return result;
};

export function moveVertices(mesh: IndexedPolygonMesh, selection: MeshSelection, delta: MeshVector3, options: VertexTransformOptions = {}): IndexedPolygonMesh {
  const mutable = mutableFrom(mesh);
  const targets = selectedWithSymmetry(mutable, selection, options);
  targets.forEach((mirrored, index) => {
    const offset: MeshVector3 = mirrored ? [-delta[0], delta[1], delta[2]] : delta;
    mutable.positions[index * 3] += offset[0];
    mutable.positions[index * 3 + 1] += offset[1];
    mutable.positions[index * 3 + 2] += offset[2];
  });
  return mesh.normals ? recomputeMeshNormals(toTypedMesh(mutable)) : toTypedMesh(mutable);
}

const rotationMatrix = (rotation: MeshVector3): ((position: MeshVector3) => MeshVector3) => {
  const [x, y, z] = rotation.map((value) => (value * Math.PI) / 180) as MeshVector3;
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return ([px, py, pz]) => {
    const y1 = py * cx - pz * sx;
    const z1 = py * sx + pz * cx;
    const x2 = px * cy + z1 * sy;
    const z2 = -px * sy + z1 * cy;
    return [x2 * cz - y1 * sz, x2 * sz + y1 * cz, z2];
  };
};

const selectionPivot = (mesh: MutableMesh, selection: MeshSelection, options: VertexTransformOptions): MeshVector3 => {
  if (options.pivot) return [...options.pivot] as MeshVector3;
  const indices = [...selectionVertices(toTypedMesh(mesh), selection)];
  if (indices.length === 0) return [0, 0, 0];
  const sum = indices.reduce<MeshVector3>((value, index) => add(value, readVertex(mesh, index).position), [0, 0, 0]);
  return multiply(sum, 1 / indices.length);
};

export function scaleVertices(mesh: IndexedPolygonMesh, selection: MeshSelection, scale: MeshVector3, options: VertexTransformOptions = {}): IndexedPolygonMesh {
  const mutable = mutableFrom(mesh);
  const pivot = selectionPivot(mutable, selection, options);
  const targets = selectedWithSymmetry(mutable, selection, options);
  targets.forEach((_mirrored, index) => {
    const position = readVertex(mutable, index).position;
    const relative = subtract(position, pivot);
    const scaled: MeshVector3 = [relative[0] * scale[0], relative[1] * scale[1], relative[2] * scale[2]];
    const next = add(pivot, scaled);
    mutable.positions[index * 3] = next[0];
    mutable.positions[index * 3 + 1] = next[1];
    mutable.positions[index * 3 + 2] = next[2];
  });
  return mesh.normals ? recomputeMeshNormals(toTypedMesh(mutable)) : toTypedMesh(mutable);
}

export function rotateVertices(mesh: IndexedPolygonMesh, selection: MeshSelection, rotationDegrees: MeshVector3, options: VertexTransformOptions = {}): IndexedPolygonMesh {
  const mutable = mutableFrom(mesh);
  const pivot = selectionPivot(mutable, selection, options);
  const rotate = rotationMatrix(rotationDegrees);
  const targets = selectedWithSymmetry(mutable, selection, options);
  targets.forEach((_mirrored, index) => {
    const relative = subtract(readVertex(mutable, index).position, pivot);
    const next = add(pivot, rotate(relative));
    mutable.positions[index * 3] = next[0];
    mutable.positions[index * 3 + 1] = next[1];
    mutable.positions[index * 3 + 2] = next[2];
  });
  return mesh.normals ? recomputeMeshNormals(toTypedMesh(mutable)) : toTypedMesh(mutable);
}

export function extrudeFaces(mesh: IndexedPolygonMesh, faces: Iterable<number>, distance: number): IndexedPolygonMesh {
  const mutable = mutableFrom(mesh);
  const selected = new Set([...faces].filter((face) => Number.isInteger(face) && face >= 0 && face < mutable.indices.length / 3));
  if (selected.size === 0) return cloneIndexedMesh(mesh);
  const nextIndices: number[] = [];
  for (let face = 0; face < mutable.indices.length / 3; face += 1) {
    const offset = face * 3;
    const a = mutable.indices[offset]!, b = mutable.indices[offset + 1]!, c = mutable.indices[offset + 2]!;
    if (!selected.has(face)) {
      nextIndices.push(a, b, c);
      continue;
    }
    const normal = faceNormal(mutable, face);
    const delta = multiply(normal, finite(distance, 0));
    const duplicated = [a, b, c].map((index) => {
      const vertex = readVertex(mutable, index);
      vertex.position = add(vertex.position, delta);
      return appendVertex(mutable, vertex);
    });
    nextIndices.push(duplicated[0]!, duplicated[2]!, duplicated[1]!);
    nextIndices.push(a, b, duplicated[1]!, duplicated[0]!);
    nextIndices.push(b, c, duplicated[2]!, duplicated[1]!);
    nextIndices.push(c, a, duplicated[0]!, duplicated[2]!);
  }
  mutable.indices = nextIndices;
  return mesh.normals ? recomputeMeshNormals(toTypedMesh(mutable)) : toTypedMesh(mutable);
}

export function insetFaces(mesh: IndexedPolygonMesh, faces: Iterable<number>, amount: number): IndexedPolygonMesh {
  const mutable = mutableFrom(mesh);
  const selected = new Set([...faces].filter((face) => Number.isInteger(face) && face >= 0 && face < mutable.indices.length / 3));
  if (selected.size === 0) return cloneIndexedMesh(mesh);
  const ratio = clamp(finite(amount, 0), 0, 1);
  const nextIndices: number[] = [];
  for (let face = 0; face < mutable.indices.length / 3; face += 1) {
    const offset = face * 3;
    const a = mutable.indices[offset]!, b = mutable.indices[offset + 1]!, c = mutable.indices[offset + 2]!;
    if (!selected.has(face)) {
      nextIndices.push(a, b, c);
      continue;
    }
    const center = averageVertex(mutable, [a, b, c]);
    const inner = [a, b, c].map((index) => {
      const vertex = blendVertexData(readVertex(mutable, index), center, ratio);
      return appendVertex(mutable, vertex);
    });
    nextIndices.push(inner[0]!, inner[1]!, inner[2]!);
    nextIndices.push(a, b, inner[1]!, inner[0]!);
    nextIndices.push(b, c, inner[2]!, inner[1]!);
    nextIndices.push(c, a, inner[0]!, inner[2]!);
  }
  mutable.indices = nextIndices;
  return mesh.normals ? recomputeMeshNormals(toTypedMesh(mutable)) : toTypedMesh(mutable);
}

export function bevelEdges(mesh: IndexedPolygonMesh, edges: Iterable<string>, amount: number): IndexedPolygonMesh {
  const mutable = mutableFrom(mesh);
  const ratio = finite(amount, 0);
  if (ratio === 0) return cloneIndexedMesh(mesh);
  const nextIndices = [...mutable.indices];
  const seen = new Set<string>();
  for (const key of edges) {
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = parseEdgeKey(key);
    if (!parsed || parsed[0] < 0 || parsed[1] < 0 || parsed[0] >= mutable.positions.length / 3 || parsed[1] >= mutable.positions.length / 3) continue;
    const a = parsed[0], b = parsed[1];
    const midpoint = multiply(add(readVertex(mutable, a).position, readVertex(mutable, b).position), 0.5);
    const aVertex = readVertex(mutable, a);
    const bVertex = readVertex(mutable, b);
    aVertex.position = lerp(aVertex.position, midpoint, clamp(ratio, 0, 0.9));
    bVertex.position = lerp(bVertex.position, midpoint, clamp(ratio, 0, 0.9));
    const aBevel = appendVertex(mutable, aVertex);
    const bBevel = appendVertex(mutable, bVertex);
    nextIndices.push(a, b, bBevel, a, bBevel, aBevel);
  }
  mutable.indices = nextIndices;
  return mesh.normals ? recomputeMeshNormals(toTypedMesh(mutable)) : toTypedMesh(mutable);
}

const faceAdjacency = (mesh: MutableMesh): Map<number, Set<number>> => {
  const adjacency = new Map<number, Set<number>>();
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    for (const vertex of [mesh.indices[face * 3]!, mesh.indices[face * 3 + 1]!, mesh.indices[face * 3 + 2]!]) {
      const set = adjacency.get(vertex) ?? new Set<number>();
      for (const other of [mesh.indices[face * 3]!, mesh.indices[face * 3 + 1]!, mesh.indices[face * 3 + 2]!]) if (other !== vertex) set.add(other);
      adjacency.set(vertex, set);
    }
  }
  return adjacency;
};

const brushFalloff = (distance: number, radius: number): number => {
  const normalized = clamp(distance / Math.max(1e-6, radius), 0, 1);
  return 1 - normalized * normalized * (3 - 2 * normalized);
};

const brushVertices = (mesh: MutableMesh, brush: SculptBrush): number[] => {
  const selection = brush.selection ? selectionVertices(toTypedMesh(mesh), brush.selection) : undefined;
  const centers: Array<{ point: MeshVector3; mirrored: boolean }> = [{ point: brush.center, mirrored: false }];
  if (brush.symmetry && Math.abs(brush.center[0]) > 1e-7) centers.push({ point: [-brush.center[0], brush.center[1], brush.center[2]], mirrored: true });
  const output: number[] = [];
  for (let index = 0; index < mesh.positions.length / 3; index += 1) {
    if (selection && !selection.has(index)) continue;
    const position = readVertex(mesh, index).position;
    if (centers.some(({ point }) => length(subtract(position, point)) <= brush.radius)) output.push(index);
  }
  return output;
};

export function applySculptBrush(mesh: IndexedPolygonMesh, brush: SculptBrush): IndexedPolygonMesh {
  const mutable = mutableFrom(mesh);
  const radius = Math.max(1e-6, finite(brush.radius, 1));
  const strength = finite(brush.strength, 0);
  const centers: Array<{ point: MeshVector3; mirrored: boolean }> = [{ point: brush.center, mirrored: false }];
  if (brush.symmetry && Math.abs(brush.center[0]) > 1e-7) centers.push({ point: [-brush.center[0], brush.center[1], brush.center[2]], mirrored: true });
  const normals = recomputeMeshNormals(toTypedMesh(mutable)).normals;
  const adjacency = faceAdjacency(mutable);
  const candidates = brushVertices(mutable, brush);
  const updates = new Map<number, MeshVector3>();
  const neighborsAverage = (index: number): MeshVector3 => {
    const neighbors = [...(adjacency.get(index) ?? [])];
    if (neighbors.length === 0) return readVertex(mutable, index).position;
    return multiply(neighbors.reduce<MeshVector3>((sum, neighbor) => add(sum, readVertex(mutable, neighbor).position), [0, 0, 0]), 1 / neighbors.length);
  };
  for (const index of candidates) {
    const position = readVertex(mutable, index).position;
    const normal: MeshVector3 = normals ? [normals[index * 3]!, normals[index * 3 + 1]!, normals[index * 3 + 2]!] : [0, 1, 0];
    let displacement: MeshVector3 = [0, 0, 0];
    let weight = 0;
    for (const { point: center, mirrored } of centers) {
      const distance = length(subtract(position, center));
      const falloff = brushFalloff(distance, radius);
      if (falloff <= 0) continue;
      weight += falloff;
      if (brush.kind === "grab") {
        const direction = brush.direction ?? [0, 1, 0];
        displacement = add(displacement, multiply(mirrored ? [-direction[0], direction[1], direction[2]] : direction, strength * falloff));
      }
      if (brush.kind === "inflate") displacement = add(displacement, multiply(normal, strength * falloff));
      if (brush.kind === "smooth") displacement = add(displacement, multiply(subtract(neighborsAverage(index), position), strength * falloff));
      if (brush.kind === "flatten") {
        const axis = brush.axis ?? 1;
        const flatten = [...position] as MeshVector3;
        flatten[axis] = brush.plane ?? center[axis];
        displacement = add(displacement, multiply(subtract(flatten, position), strength * falloff));
      }
      if (brush.kind === "crease") displacement = add(displacement, multiply(normal, -strength * falloff));
      if (brush.kind === "pinch") displacement = add(displacement, multiply(subtract(center, position), strength * falloff));
    }
    if (weight > 1) displacement = multiply(displacement, 1 / weight);
    updates.set(index, displacement);
  }
  updates.forEach((displacement, index) => {
    mutable.positions[index * 3] += displacement[0];
    mutable.positions[index * 3 + 1] += displacement[1];
    mutable.positions[index * 3 + 2] += displacement[2];
  });
  const result = toTypedMesh(mutable);
  return mesh.normals ? recomputeMeshNormals(result) : result;
}

const hasSkin = (mesh: IndexedPolygonMesh): boolean =>
  Boolean(mesh.skinIndices || mesh.skinWeights);

export type RemeshOptions = {
  targetEdgeLength?: number;
  skinned?: boolean;
};

export function remeshStatic(mesh: IndexedPolygonMesh, options: RemeshOptions = {}): IndexedPolygonMesh {
  if (options.skinned || hasSkin(mesh)) {
    throw new Error("Remesh is available only for static meshes; preserve the rigged mesh for pose editing");
  }
  const mutable = mutableFrom(mesh);
  const vertexCount = mutable.positions.length / 3;
  if (vertexCount === 0) return cloneIndexedMesh(mesh);
  const target = Math.max(1e-6, finite(options.targetEdgeLength ?? 0, 0));
  if (target <= 1e-6) return cloneIndexedMesh(mesh);
  const groups = new Map<string, number[]>();
  for (let index = 0; index < vertexCount; index += 1) {
    const position = readVertex(mutable, index).position;
    const key = `${Math.round(position[0] / target)}:${Math.round(position[1] / target)}:${Math.round(position[2] / target)}`;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }
  const remapped = new Map<number, number>();
  const next: MutableMesh = {
    positions: [],
    indices: [],
    normals: mutable.normals ? [] : undefined,
    uvs: mutable.uvs ? [] : undefined,
  };
  groups.forEach((group) => {
    const nextIndex = appendVertex(next, averageVertex(mutable, group));
    group.forEach((index) => remapped.set(index, nextIndex));
  });
  for (let face = 0; face < mutable.indices.length / 3; face += 1) {
    const a = remapped.get(mutable.indices[face * 3]!);
    const b = remapped.get(mutable.indices[face * 3 + 1]!);
    const c = remapped.get(mutable.indices[face * 3 + 2]!);
    if (a === undefined || b === undefined || c === undefined || a === b || b === c || c === a) continue;
    next.indices.push(a, b, c);
  }
  const result = toTypedMesh(next);
  return mesh.normals ? recomputeMeshNormals(result) : result;
}

export type MeshHistoryEntry = {
  label: string;
  before: IndexedPolygonMesh;
  after: IndexedPolygonMesh;
};

export class MeshHistory {
  private readonly undoStack: MeshHistoryEntry[] = [];
  private readonly redoStack: MeshHistoryEntry[] = [];
  private currentMesh: IndexedPolygonMesh;

  constructor(initial: IndexedPolygonMesh) {
    validateIndexedMesh(initial);
    this.currentMesh = cloneIndexedMesh(initial);
  }

  get mesh(): IndexedPolygonMesh {
    return cloneIndexedMesh(this.currentMesh);
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  apply(label: string, operation: (mesh: IndexedPolygonMesh) => IndexedPolygonMesh): IndexedPolygonMesh {
    const before = cloneIndexedMesh(this.currentMesh);
    const after = operation(cloneIndexedMesh(this.currentMesh));
    validateIndexedMesh(after);
    this.currentMesh = cloneIndexedMesh(after);
    this.undoStack.push({ label, before, after: cloneIndexedMesh(after) });
    this.redoStack.length = 0;
    return this.mesh;
  }

  undo(): IndexedPolygonMesh {
    const entry = this.undoStack.pop();
    if (!entry) return this.mesh;
    this.redoStack.push(entry);
    this.currentMesh = cloneIndexedMesh(entry.before);
    return this.mesh;
  }

  redo(): IndexedPolygonMesh {
    const entry = this.redoStack.pop();
    if (!entry) return this.mesh;
    this.undoStack.push(entry);
    this.currentMesh = cloneIndexedMesh(entry.after);
    return this.mesh;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

export class MeshEditor {
  readonly history: MeshHistory;
  selection: MeshSelection;

  constructor(mesh: IndexedPolygonMesh) {
    this.history = new MeshHistory(mesh);
    this.selection = createMeshSelection();
  }

  get mesh(): IndexedPolygonMesh { return this.history.mesh; }

  move(delta: MeshVector3, options?: VertexTransformOptions): IndexedPolygonMesh {
    return this.history.apply("Move vertices", (mesh) => moveVertices(mesh, this.selection, delta, options));
  }

  scale(value: MeshVector3, options?: VertexTransformOptions): IndexedPolygonMesh {
    return this.history.apply("Scale vertices", (mesh) => scaleVertices(mesh, this.selection, value, options));
  }

  rotate(value: MeshVector3, options?: VertexTransformOptions): IndexedPolygonMesh {
    return this.history.apply("Rotate vertices", (mesh) => rotateVertices(mesh, this.selection, value, options));
  }

  extrude(distance: number): IndexedPolygonMesh {
    return this.history.apply("Extrude faces", (mesh) => extrudeFaces(mesh, this.selection.faces, distance));
  }

  inset(amount: number): IndexedPolygonMesh {
    return this.history.apply("Inset faces", (mesh) => insetFaces(mesh, this.selection.faces, amount));
  }

  bevel(amount: number): IndexedPolygonMesh {
    return this.history.apply("Bevel edges", (mesh) => bevelEdges(mesh, this.selection.edges, amount));
  }

  sculpt(brush: Omit<SculptBrush, "selection">): IndexedPolygonMesh {
    return this.history.apply(`Sculpt ${brush.kind}`, (mesh) => applySculptBrush(mesh, { ...brush, selection: this.selection }));
  }

  remesh(options?: RemeshOptions): IndexedPolygonMesh {
    return this.history.apply("Remesh static mesh", (mesh) => remeshStatic(mesh, options));
  }

  undo(): IndexedPolygonMesh { return this.history.undo(); }
  redo(): IndexedPolygonMesh { return this.history.redo(); }
}

export function createMeshEditor(mesh: IndexedPolygonMesh): MeshEditor {
  return new MeshEditor(mesh);
}
