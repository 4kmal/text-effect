import { cloneModelProject, parseModelProject, type ModelProject } from "./model";
import type { ModelBinaryInput } from "./storage";

export const MODEL_BUNDLE_MAGIC = "RAPIDSCREEN_MODEL_BUNDLE_V1";

export type ModelBundleAsset = {
  storageKey: string;
  mimeType?: string;
  data: string;
};

export type ModelProjectBundle = {
  format: typeof MODEL_BUNDLE_MAGIC;
  project: ModelProject;
  assets: ModelBundleAsset[];
};

export type ImportedModelBundle = {
  project: ModelProject;
  assets: Record<string, Uint8Array>;
};

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const toBase64 = (bytes: Uint8Array): string => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += base64Alphabet[first >> 2];
    output += base64Alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : base64Alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : base64Alphabet[third & 63];
  }
  return output;
};

const fromBase64 = (input: string): Uint8Array => {
  const clean = input.replace(/\s/g, "");
  if (clean.length % 4 !== 0) throw new Error("Invalid model bundle asset encoding");
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const a = base64Alphabet.indexOf(clean[index]!);
    const b = base64Alphabet.indexOf(clean[index + 1]!);
    const c = clean[index + 2] === "=" ? 0 : base64Alphabet.indexOf(clean[index + 2]!);
    const d = clean[index + 3] === "=" ? 0 : base64Alphabet.indexOf(clean[index + 3]!);
    if (a < 0 || b < 0 || (clean[index + 2] !== "=" && c < 0) || (clean[index + 3] !== "=" && d < 0)) {
      throw new Error("Invalid model bundle asset encoding");
    }
    bytes.push((a << 2) | (b >> 4));
    if (clean[index + 2] !== "=") bytes.push(((b & 15) << 4) | (c >> 2));
    if (clean[index + 3] !== "=") bytes.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(bytes);
};

const bytesFromInput = async (input: ModelBinaryInput): Promise<Uint8Array> => {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  return new Uint8Array(await input.arrayBuffer());
};

const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export async function exportModelProjectBundle(
  project: ModelProject,
  assets: Record<string, ModelBinaryInput> = {},
): Promise<Uint8Array> {
  const parsed = parseModelProject(project);
  const bundleAssets: ModelBundleAsset[] = [];
  for (const [storageKey, input] of Object.entries(assets)) {
    bundleAssets.push({ storageKey, data: toBase64(await bytesFromInput(input)) });
  }
  const bundle: ModelProjectBundle = {
    format: MODEL_BUNDLE_MAGIC,
    project: parsed,
    assets: bundleAssets,
  };
  const text = `${MODEL_BUNDLE_MAGIC}\n${JSON.stringify(bundle)}`;
  return new TextEncoder().encode(text);
}

export async function exportModelProjectBundleBlob(
  project: ModelProject,
  assets: Record<string, ModelBinaryInput> = {},
): Promise<Blob> {
  const bytes = await exportModelProjectBundle(project, assets);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/json" });
}

export async function importModelProjectBundle(
  input: ArrayBuffer | Uint8Array | Blob | string,
): Promise<ImportedModelBundle> {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input instanceof Blob) text = decodeText(new Uint8Array(await input.arrayBuffer()));
  else if (input instanceof Uint8Array) text = decodeText(input);
  else text = decodeText(new Uint8Array(input));
  const separator = text.indexOf("\n");
  if (separator < 0 || text.slice(0, separator) !== MODEL_BUNDLE_MAGIC) {
    throw new Error("Invalid model bundle: unsupported format");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(separator + 1)) as unknown;
  } catch {
    throw new Error("Invalid model bundle: malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid model bundle: expected an object");
  const candidate = parsed as Partial<ModelProjectBundle>;
  if (candidate.format !== MODEL_BUNDLE_MAGIC || !Array.isArray(candidate.assets)) {
    throw new Error("Invalid model bundle: missing manifest or assets");
  }
  const project = parseModelProject(candidate.project);
  const assets: Record<string, Uint8Array> = {};
  for (const asset of candidate.assets) {
    if (!asset || typeof asset !== "object" || typeof asset.storageKey !== "string" || typeof asset.data !== "string") {
      throw new Error("Invalid model bundle: malformed asset");
    }
    if (assets[asset.storageKey]) throw new Error(`Invalid model bundle: duplicate asset ${asset.storageKey}`);
    assets[asset.storageKey] = fromBase64(asset.data);
  }
  return { project: cloneModelProject(project), assets };
}
