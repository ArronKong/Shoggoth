import type { ModelCatalogSnapshot, ModelCatalogWireResponse, UnifiedModel } from "./types";
import { toModelCatalogSnapshot } from "./api/client";

const TTL_MS = 24 * 60 * 60 * 1000;
const REVISION_RE = /^[0-9a-f]{64}$/;
const CURRENT_PREFIX = "shoggoth.models.v2.current.";
const ENTRY_PREFIX = "shoggoth.models.v2.entry.";
const LEGACY_PREFIX = "shoggoth.chat.models.v1.";

export interface ModelCatalogStore {
  read(backendId: string): ModelCatalogSnapshot | null;
  publishApplied(snapshot: ModelCatalogSnapshot): void;
  revalidate(
    backendId: string,
    fetcher: (knownRevision?: string) => Promise<ModelCatalogWireResponse>,
  ): Promise<ModelCatalogSnapshot>;
  subscribe(
    backendId: string,
    listener: (snapshot: ModelCatalogSnapshot) => void,
  ): () => void;
}

interface StoreDependencies {
  storage: Storage;
  events: EventTarget;
  now?: () => number;
}

// key 只使用已编码的 backend，避免特殊字符打破 entry 前缀枚举。
function backendToken(backendId: string): string {
  return encodeURIComponent(backendId);
}

function currentKey(backendId: string): string {
  return `${CURRENT_PREFIX}${backendToken(backendId)}`;
}

function entryPrefix(backendId: string): string {
  return `${ENTRY_PREFIX}${backendToken(backendId)}.`;
}

function entryKey(backendId: string, revision: string): string {
  return `${entryPrefix(backendId)}${revision}`;
}

function legacyKey(backendId: string): string {
  return `${LEGACY_PREFIX}${backendId}`;
}

// 目录模型只保留 UI 消费的可序列化字段，并统一归属当前 backend。
function normalizeModel(raw: unknown, backendId: string): UnifiedModel | null {
  if (!raw || typeof raw !== "object") return null;
  const model = raw as Partial<UnifiedModel>;
  if (typeof model.id !== "string" || !model.id.trim()
    || typeof model.name !== "string" || !model.name.trim()
    || typeof model.provider !== "string" || !model.provider.trim()) return null;
  return { ...model, id: model.id, name: model.name, provider: model.provider, backendId };
}

// TTL 的边界是严格 `<24h`；未来时间也不能作为可信首屏数据。
function isFreshTimestamp(value: unknown, now: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value <= now
    && now - value < TTL_MS;
}

// 校验持久快照的 backend、revision、时间与每一条模型结构。
function normalizeSnapshot(
  raw: unknown,
  backendId: string,
  now: number,
): ModelCatalogSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ModelCatalogSnapshot>;
  if (value.backendId !== backendId
    || typeof value.catalogRevision !== "string"
    || !REVISION_RE.test(value.catalogRevision)
    || !isFreshTimestamp(value.verifiedAt, now)
    || !Array.isArray(value.models)) return null;
  const models = value.models.map((model) => normalizeModel(model, backendId));
  if (models.some((model) => model === null)) return null;
  return {
    backendId,
    catalogRevision: value.catalogRevision,
    models: models as UnifiedModel[],
    verifiedAt: value.verifiedAt,
    ...(value.legacyPlaceholder === true ? { legacyPlaceholder: true } : {}),
  };
}

// localStorage 可能不可用或超配额；读写失败只禁用热缓存，不影响网络真值。
function parseStored(storage: Storage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createModelCatalogStore({
  storage,
  events,
  now: readNow = () => Date.now(),
}: StoreDependencies): ModelCatalogStore {
  const listeners = new Map<string, Set<(snapshot: ModelCatalogSnapshot) => void>>();
  // Storage 不可用时仍保留当前 renderer 的 verified winner，保证跨页广播不中断。
  const memoryCurrent = new Map<string, ModelCatalogSnapshot>();

  // 删除失效 current 时同时删除它指向的内容，避免损坏条目反复参与首屏读取。
  function removeCurrent(backendId: string, revision?: string | null): void {
    try {
      storage.removeItem(currentKey(backendId));
      if (revision) storage.removeItem(entryKey(backendId, revision));
    } catch {
      // Storage 清理失败不升级成页面错误。
    }
  }

  // 按指定 revision 读取，用于 unchanged 响应沿用本地 verified 内容。
  function readRevision(backendId: string, revision: string): ModelCatalogSnapshot | null {
    const key = entryKey(backendId, revision);
    const snapshot = normalizeSnapshot(parseStored(storage, key), backendId, readNow());
    if (!snapshot || snapshot.legacyPlaceholder) {
      try { storage.removeItem(key); } catch { /* 忽略 Storage 清理失败 */ }
      return null;
    }
    return snapshot;
  }

  // 只保留最近两个 verified revision；current 指针永远最后更新。
  function retainRecent(backendId: string): void {
    const prefix = entryPrefix(backendId);
    const entries: Array<{ key: string; verifiedAt: number }> = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const revision = key.slice(prefix.length);
        const snapshot = REVISION_RE.test(revision) ? readRevision(backendId, revision) : null;
        if (!snapshot) {
          storage.removeItem(key);
          index -= 1;
          continue;
        }
        entries.push({ key, verifiedAt: snapshot.verifiedAt });
      }
      entries.sort((left, right) => right.verifiedAt - left.verifiedAt);
      for (const entry of entries.slice(2)) storage.removeItem(entry.key);
    } catch {
      // 枚举失败时保留已有有效项，不能影响当前应用结果。
    }
  }

  // entry 先落盘、current 后切换，读取者只会看到旧快照或完整新快照。
  function persistVerified(snapshot: ModelCatalogSnapshot): boolean {
    const normalized = normalizeSnapshot(snapshot, snapshot.backendId, readNow());
    if (!normalized || normalized.legacyPlaceholder) return false;
    memoryCurrent.set(normalized.backendId, normalized);
    try {
      storage.setItem(entryKey(normalized.backendId, normalized.catalogRevision), JSON.stringify(normalized));
      storage.setItem(currentKey(normalized.backendId), normalized.catalogRevision);
      storage.removeItem(legacyKey(normalized.backendId));
      retainRecent(normalized.backendId);
      return true;
    } catch {
      // 持久化失败只影响冷启动缓存；内存快照仍是本 renderer 的原子 winner。
      return true;
    }
  }

  function read(backendId: string): ModelCatalogSnapshot | null {
    if (!backendId) return null;
    const memory = memoryCurrent.get(backendId);
    if (memory) return memory;
    let revision: string | null = null;
    try { revision = storage.getItem(currentKey(backendId)); } catch { /* 尝试 legacy */ }
    if (revision) {
      if (!REVISION_RE.test(revision)) {
        removeCurrent(backendId, revision);
      } else {
        const snapshot = readRevision(backendId, revision);
        if (snapshot) return snapshot;
        removeCurrent(backendId, revision);
      }
    }

    // v1 没有内容 revision，只能做临时 placeholder，绝不写入 v2。
    const rawLegacy = parseStored(storage, legacyKey(backendId));
    if (!rawLegacy || typeof rawLegacy !== "object") return null;
    const legacy = rawLegacy as { savedAt?: unknown; verifiedAt?: unknown; models?: unknown };
    const verifiedAt = legacy.savedAt ?? legacy.verifiedAt;
    const currentNow = readNow();
    if (!isFreshTimestamp(verifiedAt, currentNow) || !Array.isArray(legacy.models)) {
      try { storage.removeItem(legacyKey(backendId)); } catch { /* 忽略清理失败 */ }
      return null;
    }
    const models = legacy.models.map((model) => normalizeModel(model, backendId));
    if (models.some((model) => model === null)) {
      try { storage.removeItem(legacyKey(backendId)); } catch { /* 忽略清理失败 */ }
      return null;
    }
    return {
      backendId,
      catalogRevision: "0".repeat(64),
      models: models as UnifiedModel[],
      verifiedAt,
      legacyPlaceholder: true,
    };
  }

  function publishApplied(snapshot: ModelCatalogSnapshot): void {
    if (!persistVerified(snapshot)) return;
    events.dispatchEvent(new CustomEvent("models:changed", { detail: snapshot }));
  }

  // 事件是跨页面同步边界：只接受新鲜 verified 快照，过期事件不会重新落盘。
  function onChanged(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object") return;
    const backendId = (detail as Partial<ModelCatalogSnapshot>).backendId;
    if (typeof backendId !== "string") return;
    const normalized = normalizeSnapshot(detail, backendId, readNow());
    if (!normalized || normalized.legacyPlaceholder) return;

    const current = read(backendId);
    if (!current || current.legacyPlaceholder || current.catalogRevision !== normalized.catalogRevision) {
      if (!persistVerified(normalized)) return;
    }
    for (const listener of listeners.get(backendId) || []) listener(normalized);
  }
  events.addEventListener("models:changed", onChanged);

  async function revalidate(
    backendId: string,
    fetcher: (knownRevision?: string) => Promise<ModelCatalogWireResponse>,
  ): Promise<ModelCatalogSnapshot> {
    const initial = read(backendId);
    const initialRevision = initial && !initial.legacyPlaceholder ? initial.catalogRevision : undefined;
    let wire = await fetcher(initialRevision);

    // 请求期间 apply 已发布时，当前目录胜出；迟到 GET 不能作为 Promise 结果泄漏 loser。
    const afterFetch = read(backendId);
    const afterRevision = afterFetch && !afterFetch.legacyPlaceholder ? afterFetch.catalogRevision : undefined;
    if (afterRevision !== initialRevision && afterFetch && !afterFetch.legacyPlaceholder) return afterFetch;

    if (wire.unchanged === true) {
      const known = REVISION_RE.test(String(wire.catalogRevision || ""))
        ? readRevision(backendId, wire.catalogRevision)
        : null;
      if (known) return known;
      // 本地没有服务端所指 revision 时必须重新取完整响应，不能把省略 models 当空目录。
      wire = await fetcher(undefined);
      const retryWinner = read(backendId);
      const retryRevision = retryWinner && !retryWinner.legacyPlaceholder
        ? retryWinner.catalogRevision
        : undefined;
      if (retryRevision !== initialRevision && retryWinner && !retryWinner.legacyPlaceholder) {
        return retryWinner;
      }
    }

    const snapshot = toModelCatalogSnapshot(backendId, wire, readNow());
    const beforePublish = read(backendId);
    const currentRevision = beforePublish && !beforePublish.legacyPlaceholder
      ? beforePublish.catalogRevision
      : undefined;
    if (currentRevision !== initialRevision && beforePublish && !beforePublish.legacyPlaceholder) {
      return beforePublish;
    }
    publishApplied(snapshot);
    return read(backendId) || snapshot;
  }

  function subscribe(
    backendId: string,
    listener: (snapshot: ModelCatalogSnapshot) => void,
  ): () => void {
    const backendListeners = listeners.get(backendId) || new Set();
    backendListeners.add(listener);
    listeners.set(backendId, backendListeners);
    return () => {
      backendListeners.delete(listener);
      if (backendListeners.size === 0) listeners.delete(backendId);
    };
  }

  return { read, publishApplied, revalidate, subscribe };
}

let browserStore: ModelCatalogStore | null = null;

// browser singleton 延迟初始化，Node 回归可以只使用可注入工厂。
function getBrowserStore(): ModelCatalogStore {
  if (!browserStore) {
    if (typeof window === "undefined" || !window.localStorage) {
      throw new Error("模型目录 store 仅可在浏览器中使用");
    }
    browserStore = createModelCatalogStore({ storage: window.localStorage, events: window });
  }
  return browserStore;
}

export function readModelCatalog(backendId: string): ModelCatalogSnapshot | null {
  return getBrowserStore().read(backendId);
}

export function publishAppliedModelCatalog(snapshot: ModelCatalogSnapshot): void {
  getBrowserStore().publishApplied(snapshot);
}

export function revalidateModelCatalog(
  backendId: string,
  fetcher: (knownRevision?: string) => Promise<ModelCatalogWireResponse>,
): Promise<ModelCatalogSnapshot> {
  return getBrowserStore().revalidate(backendId, fetcher);
}

export function subscribeModelCatalog(
  backendId: string,
  listener: (snapshot: ModelCatalogSnapshot) => void,
): () => void {
  return getBrowserStore().subscribe(backendId, listener);
}
