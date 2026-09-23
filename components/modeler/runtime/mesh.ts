import * as THREE from "three";

import type { IndexedPolygonMesh } from "../core";

type MeshField = keyof IndexedPolygonMesh;

const fields: MeshField[] = [
  "positions",
  "indices",
  "normals",
  "uvs",
  "skinIndices",
  "skinWeights",
];

export function indexedMeshFromThree(object: THREE.Mesh): IndexedPolygonMesh {
  const geometry = object.geometry;
  const position = geometry.getAttribute("position");
  if (!position) throw new Error("Selected mesh has no vertex positions.");
  const index = geometry.getIndex();
  const vertexCount = position.count;
  const indices = index
    ? Uint32Array.from(index.array as ArrayLike<number>)
    : Uint32Array.from({ length: vertexCount }, (_, value) => value);
  const normals = geometry.getAttribute("normal");
  const uvs = geometry.getAttribute("uv");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  return {
    positions: Float32Array.from(position.array as ArrayLike<number>),
    indices,
    normals: normals ? Float32Array.from(normals.array as ArrayLike<number>) : undefined,
    uvs: uvs ? Float32Array.from(uvs.array as ArrayLike<number>) : undefined,
    skinIndices: skinIndex ? Uint16Array.from(skinIndex.array as ArrayLike<number>) : undefined,
    skinWeights: skinWeight ? Float32Array.from(skinWeight.array as ArrayLike<number>) : undefined,
  };
}

export function applyIndexedMeshToThree(object: THREE.Mesh, data: IndexedPolygonMesh): void {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  if (data.normals) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3));
  else geometry.computeVertexNormals();
  if (data.uvs) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
  if (data.skinIndices) geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(data.skinIndices, 4));
  if (data.skinWeights) geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(data.skinWeights, 4));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const previous = object.geometry;
  object.geometry = geometry;
  previous.dispose();
}

type MeshHeader = {
  version: 1;
  lengths: Record<MeshField, number>;
};

export function encodeIndexedMesh(data: IndexedPolygonMesh): ArrayBuffer {
  const lengths = {} as Record<MeshField, number>;
  for (const field of fields) lengths[field] = data[field]?.length ?? 0;
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, lengths } satisfies MeshHeader));
  const byteLength = 4 + header.byteLength + fields.reduce(
    (sum, field) => sum + (data[field]?.byteLength ?? 0),
    0,
  );
  const output = new Uint8Array(byteLength);
  new DataView(output.buffer).setUint32(0, header.byteLength, true);
  output.set(header, 4);
  let offset = 4 + header.byteLength;
  for (const field of fields) {
    const value = data[field];
    if (!value) continue;
    output.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), offset);
    offset += value.byteLength;
  }
  return output.buffer;
}

export function decodeIndexedMesh(buffer: ArrayBuffer): IndexedPolygonMesh {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 4) throw new Error("Mesh asset is incomplete.");
  const headerLength = new DataView(buffer).getUint32(0, true);
  if (headerLength > bytes.byteLength - 4) throw new Error("Mesh asset header is invalid.");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as MeshHeader;
  if (header.version !== 1) throw new Error("Unsupported mesh asset version.");
  let offset = 4 + headerLength;
  const read = (field: MeshField, bytesPerValue: number) => {
    const length = header.lengths[field];
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Mesh asset field is invalid.");
    const end = offset + length * bytesPerValue;
    if (end > bytes.byteLength) throw new Error("Mesh asset data is incomplete.");
    const copy = bytes.slice(offset, end).buffer;
    offset = end;
    return copy;
  };
  const positions = new Float32Array(read("positions", 4));
  const indices = new Uint32Array(read("indices", 4));
  const normals = new Float32Array(read("normals", 4));
  const uvs = new Float32Array(read("uvs", 4));
  const skinIndices = new Uint16Array(read("skinIndices", 2));
  const skinWeights = new Float32Array(read("skinWeights", 4));
  if (offset !== bytes.byteLength) throw new Error("Mesh asset contains unexpected trailing bytes.");
  return {
    positions,
    indices,
    normals: normals.length ? normals : undefined,
    uvs: uvs.length ? uvs : undefined,
    skinIndices: skinIndices.length ? skinIndices : undefined,
    skinWeights: skinWeights.length ? skinWeights : undefined,
  };
}
