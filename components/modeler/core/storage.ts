import { cloneModelProject, parseModelProject, type ModelProject } from "./model";

export type ModelBinaryInput = ArrayBuffer | Uint8Array | Blob;

export type ModelDraftSummary = {
  id: string;
  name: string;
  updatedAt: number;
};

export type ModelDraftRecord = ModelDraftSummary & {
  project: ModelProject;
};

export interface ModelDraftStore {
  saveDraft(
    name: string,
    project: ModelProject,
    assets?: Record<string, ModelBinaryInput>,
  ): Promise<ModelDraftRecord>;
  loadDraft(idOrName: string): Promise<ModelDraftRecord | undefined>;
  listDrafts(): Promise<ModelDraftSummary[]>;
  deleteDraft(idOrName: string): Promise<void>;
  saveAsset(storageKey: string, data: ModelBinaryInput): Promise<void>;
  loadAsset(storageKey: string): Promise<ArrayBuffer | undefined>;
  deleteAsset(storageKey: string): Promise<void>;
}

type StoredDraft = ModelDraftRecord;
type StoredAsset = { key: string; bytes: ArrayBuffer };

const fallbackDrafts = new Map<string, StoredDraft>();
const fallbackAssets = new Map<string, ArrayBuffer>();

const cloneBuffer = (value: ArrayBuffer): ArrayBuffer => value.slice(0);

const inputToArrayBuffer = async (input: ModelBinaryInput): Promise<ArrayBuffer> => {
  if (input instanceof ArrayBuffer) return cloneBuffer(input);
  if (input instanceof Uint8Array) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  }
  return input.arrayBuffer();
};

const idForDraft = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const normalizedName = (name: string): string => {
  const value = name.trim();
  if (!value) throw new Error("Model draft name cannot be empty");
  return value.slice(0, 120);
};

class MemoryModelDraftStore implements ModelDraftStore {
  async saveDraft(name: string, project: ModelProject, assets: Record<string, ModelBinaryInput> = {}): Promise<ModelDraftRecord> {
    const normalized = normalizedName(name);
    for (const [key, data] of Object.entries(assets)) await this.saveAsset(key, data);
    const existing = [...fallbackDrafts.values()].find((draft) => draft.name === normalized);
    const record: ModelDraftRecord = {
      id: existing?.id ?? idForDraft(),
      name: normalized,
      updatedAt: Date.now(),
      project: cloneModelProject(parseModelProject(project)),
    };
    fallbackDrafts.set(record.id, record);
    return cloneRecord(record);
  }

  async loadDraft(idOrName: string): Promise<ModelDraftRecord | undefined> {
    const record = fallbackDrafts.get(idOrName) ?? [...fallbackDrafts.values()].find((draft) => draft.name === idOrName);
    return record ? cloneRecord(record) : undefined;
  }

  async listDrafts(): Promise<ModelDraftSummary[]> {
    return [...fallbackDrafts.values()]
      .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteDraft(idOrName: string): Promise<void> {
    const record = fallbackDrafts.get(idOrName) ?? [...fallbackDrafts.values()].find((draft) => draft.name === idOrName);
    if (record) fallbackDrafts.delete(record.id);
  }

  async saveAsset(storageKey: string, data: ModelBinaryInput): Promise<void> {
    fallbackAssets.set(storageKey, await inputToArrayBuffer(data));
  }

  async loadAsset(storageKey: string): Promise<ArrayBuffer | undefined> {
    const data = fallbackAssets.get(storageKey);
    return data ? cloneBuffer(data) : undefined;
  }

  async deleteAsset(storageKey: string): Promise<void> {
    fallbackAssets.delete(storageKey);
  }
}

const cloneRecord = (record: ModelDraftRecord): ModelDraftRecord => ({
  id: record.id,
  name: record.name,
  updatedAt: record.updatedAt,
  project: cloneModelProject(record.project),
});

class IndexedDbModelDraftStore implements ModelDraftStore {
  private readonly database: Promise<IDBDatabase>;

  constructor(databaseName = "rapid-screen-modeler") {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });
        if (!database.objectStoreNames.contains("assets")) database.createObjectStore("assets", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open model draft database"));
    });
  }

  private async transaction<T>(storeName: "drafts" | "assets", mode: IDBTransactionMode, action: (store: IDBObjectStore, finish: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const database = await this.database;
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      action(store, resolve, reject);
      transaction.onerror = () => reject(transaction.error ?? new Error("Model draft transaction failed"));
    });
  }

  async saveDraft(name: string, project: ModelProject, assets: Record<string, ModelBinaryInput> = {}): Promise<ModelDraftRecord> {
    const normalized = normalizedName(name);
    for (const [key, data] of Object.entries(assets)) await this.saveAsset(key, data);
    const existing = await this.loadDraft(normalized);
    const record: ModelDraftRecord = {
      id: existing?.id ?? idForDraft(),
      name: normalized,
      updatedAt: Date.now(),
      project: cloneModelProject(parseModelProject(project)),
    };
    await this.transaction<void>("drafts", "readwrite", (store, finish, fail) => {
      const request = store.put(record);
      request.onsuccess = () => finish(undefined);
      request.onerror = () => fail(request.error);
    });
    return cloneRecord(record);
  }

  async loadDraft(idOrName: string): Promise<ModelDraftRecord | undefined> {
    const byId = await this.transaction<StoredDraft | undefined>("drafts", "readonly", (store, finish, fail) => {
      const request = store.get(idOrName);
      request.onsuccess = () => finish(request.result as StoredDraft | undefined);
      request.onerror = () => fail(request.error);
    });
    if (byId) return cloneRecord(byId);
    const drafts = await this.transaction<StoredDraft[]>("drafts", "readonly", (store, finish, fail) => {
      const request = store.getAll();
      request.onsuccess = () => finish((request.result as StoredDraft[]) ?? []);
      request.onerror = () => fail(request.error);
    });
    const record = drafts.find((draft) => draft.name === idOrName);
    return record ? cloneRecord(record) : undefined;
  }

  async listDrafts(): Promise<ModelDraftSummary[]> {
    const drafts = await this.transaction<StoredDraft[]>("drafts", "readonly", (store, finish, fail) => {
      const request = store.getAll();
      request.onsuccess = () => finish((request.result as StoredDraft[]) ?? []);
      request.onerror = () => fail(request.error);
    });
    return drafts.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteDraft(idOrName: string): Promise<void> {
    const record = await this.loadDraft(idOrName);
    if (!record) return;
    await this.transaction<void>("drafts", "readwrite", (store, finish, fail) => {
      const request = store.delete(record.id);
      request.onsuccess = () => finish(undefined);
      request.onerror = () => fail(request.error);
    });
  }

  async saveAsset(storageKey: string, data: ModelBinaryInput): Promise<void> {
    const bytes = await inputToArrayBuffer(data);
    await this.transaction<void>("assets", "readwrite", (store, finish, fail) => {
      const request = store.put({ key: storageKey, bytes } satisfies StoredAsset);
      request.onsuccess = () => finish(undefined);
      request.onerror = () => fail(request.error);
    });
  }

  async loadAsset(storageKey: string): Promise<ArrayBuffer | undefined> {
    const asset = await this.transaction<StoredAsset | undefined>("assets", "readonly", (store, finish, fail) => {
      const request = store.get(storageKey);
      request.onsuccess = () => finish(request.result as StoredAsset | undefined);
      request.onerror = () => fail(request.error);
    });
    return asset?.bytes ? cloneBuffer(asset.bytes) : undefined;
  }

  async deleteAsset(storageKey: string): Promise<void> {
    await this.transaction<void>("assets", "readwrite", (store, finish, fail) => {
      const request = store.delete(storageKey);
      request.onsuccess = () => finish(undefined);
      request.onerror = () => fail(request.error);
    });
  }
}

export function createModelDraftStore(databaseName = "rapid-screen-modeler"): ModelDraftStore {
  if (typeof indexedDB === "undefined") return new MemoryModelDraftStore();
  return new IndexedDbModelDraftStore(databaseName);
}
