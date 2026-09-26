// Hermes 启动前需要直接恢复最近一次已确认的对话。复用图片缓存已有的 object store，
// 用独立前缀隔离数据，避免升级 IndexedDB 版本影响现有附件缓存。
const DB_NAME = "shoggoth-chat";
const DB_VERSION = 1;
const STORE = "images";
const KEY_PREFIX = "history::v1::";
const INDEX_KEY = `${KEY_PREFIX}index`;

const MAX_MESSAGES = 300;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_SESSIONS = 24;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

interface HistoryEnvelope {
  version: 1;
  scope: string;
  sessionKey: string;
  messages: unknown[];
  updatedAt: number;
  byteSize: number;
}

interface HistoryIndexEntry {
  key: string;
  scope: string;
  sessionKey: string;
  updatedAt: number;
  byteSize: number;
}

interface HistoryIndex {
  version: 1;
  entries: HistoryIndexEntry[];
}

const DROP = Symbol("drop");
let dbPromise: Promise<IDBDatabase> | null = null;
let lastTimestamp = 0;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  dbPromise = opening;
  void opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function historyKey(scope: string, sessionKey: string): string {
  return `${KEY_PREFIX}${scope}::${sessionKey}`;
}

function isValidPart(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}

function isBinary(value: unknown): boolean {
  if (typeof ArrayBuffer !== "undefined") {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  return false;
}

function isPayloadKey(key: string): boolean {
  return /^(?:base64|binary|blob|buffer|bytes|byteArray|arrayBuffer|payload)$/i.test(key);
}

function isMediaContainerKey(key: string): boolean {
  return /^(?:image|images|audio|video|media|attachment|attachments|file|files|thumbnail|preview|source|src|url|dataUrl)$/i.test(key);
}

function isMediaPayloadObject(value: Record<string, unknown>): boolean {
  return value.type === "base64" || typeof value.media_type === "string" || typeof value.mediaType === "string";
}

function sanitize(value: unknown, seen: WeakSet<object>, key = "", mediaContext = false): unknown | typeof DROP {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : DROP;
  if (typeof value === "string") {
    if (/^\s*data:/i.test(value)) return DROP;
    if (isPayloadKey(key)) return DROP;
    return value;
  }
  if (typeof value !== "object" || isBinary(value)) return DROP;

  if (seen.has(value)) return DROP;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        const cleaned = sanitize(item, seen, key, mediaContext || isMediaContainerKey(key));
        if (cleaned !== DROP) result.push(cleaned);
      }
      return result.length > 0 ? result : DROP;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return DROP;

    const source = value as Record<string, unknown>;
    const childMediaContext = mediaContext || isMediaContainerKey(key) || isMediaPayloadObject(source);
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(source)) {
      if (childKey === "__proto__" || childKey === "constructor" || childKey === "prototype") continue;
      if (isPayloadKey(childKey)) continue;
      if (childMediaContext && childKey === "data") continue;
      const cleaned = sanitize(childValue, seen, childKey, childMediaContext || isMediaContainerKey(childKey));
      if (cleaned === DROP) continue;
      if (isMediaContainerKey(childKey)) {
        if (Array.isArray(cleaned) && cleaned.length === 0) continue;
        if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      }
      result[childKey] = cleaned;
    }
    return Object.keys(result).length > 0 ? result : DROP;
  } finally {
    seen.delete(value);
  }
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function prepareMessages(messages: unknown[]): { messages: unknown[]; byteSize: number } | undefined {
  if (messages.length === 0) return { messages: [], byteSize: jsonBytes([]) };

  // Count each sanitized message once, including the JSON array brackets and
  // commas. Re-encoding every growing suffix blocks agent switches quadratically.
  const suffix: unknown[] = [];
  let byteSize = 2;
  for (let index = messages.length - 1; index >= 0 && suffix.length < MAX_MESSAGES; index--) {
    const cleaned = sanitize(messages[index], new WeakSet<object>());
    if (cleaned === DROP) continue;
    const candidateSize = byteSize + jsonBytes(cleaned) + (suffix.length ? 1 : 0);
    // Keep a contiguous sanitized suffix; never skip an oversized newer message.
    if (candidateSize > MAX_ENTRY_BYTES) break;
    suffix.push(cleaned);
    byteSize = candidateSize;
  }
  return suffix.length ? { messages: suffix.reverse(), byteSize } : undefined;
}

function validIndex(value: unknown): HistoryIndex {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
    return { version: 1, entries: [] };
  }
  const raw = (value as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return { version: 1, entries: [] };
  const entries = raw.filter((entry): entry is HistoryIndexEntry => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as Partial<HistoryIndexEntry>;
    return typeof item.key === "string"
      && item.key.startsWith(KEY_PREFIX)
      && item.key !== INDEX_KEY
      && typeof item.scope === "string"
      && typeof item.sessionKey === "string"
      && typeof item.updatedAt === "number"
      && Number.isFinite(item.updatedAt)
      && typeof item.byteSize === "number"
      && Number.isFinite(item.byteSize)
      && item.byteSize >= 0;
  });
  return { version: 1, entries };
}

function isEnvelope(value: unknown, scope: string, sessionKey: string): value is HistoryEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<HistoryEnvelope>;
  return envelope.version === 1
    && envelope.scope === scope
    && envelope.sessionKey === sessionKey
    && Array.isArray(envelope.messages)
    && typeof envelope.updatedAt === "number"
    && Number.isFinite(envelope.updatedAt)
    && typeof envelope.byteSize === "number"
    && Number.isFinite(envelope.byteSize)
    && envelope.byteSize >= 0
    && envelope.byteSize <= MAX_ENTRY_BYTES;
}

function nextTimestamp(minimum = 0): number {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1, minimum + 1);
  return lastTimestamp;
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

async function touchEntry(key: string): Promise<void> {
  try {
    const database = await openDb();
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(INDEX_KEY);
    request.onsuccess = () => {
      const index = validIndex(request.result);
      const position = index.entries.findIndex((entry) => entry.key === key);
      if (position < 0) return;
      const maximum = index.entries.reduce((value, entry) => Math.max(value, entry.updatedAt), 0);
      index.entries[position] = { ...index.entries[position], updatedAt: nextTimestamp(maximum) };
      try {
        store.put(index, INDEX_KEY);
      } catch {
        try { transaction.abort(); } catch { /* transaction already closed */ }
      }
    };
    await waitForTransaction(transaction);
  } catch {
    // LRU 刷新失败不应把一次成功的缓存读取变成失败。
  }
}

export async function getCachedChatHistory(scope: string, sessionKey: string): Promise<unknown[] | undefined> {
  if (!isValidPart(scope) || !isValidPart(sessionKey)) return undefined;
  try {
    const database = await openDb();
    const key = historyKey(scope, sessionKey);
    const envelope = await new Promise<unknown>((resolve) => {
      const transaction = database.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    if (!isEnvelope(envelope, scope, sessionKey)) return undefined;
    const messages = JSON.parse(JSON.stringify(envelope.messages)) as unknown[];
    await touchEntry(key);
    return messages;
  } catch {
    return undefined;
  }
}

export async function putCachedChatHistory(scope: string, sessionKey: string, messages: unknown[]): Promise<void> {
  if (!isValidPart(scope) || !isValidPart(sessionKey) || !Array.isArray(messages)) return;
  let prepared: { messages: unknown[]; byteSize: number } | undefined;
  try {
    prepared = prepareMessages(messages);
  } catch {
    return;
  }
  if (!prepared) return;

  try {
    const database = await openDb();
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const key = historyKey(scope, sessionKey);
    const indexRequest = store.get(INDEX_KEY);
    indexRequest.onsuccess = () => {
      try {
        const index = validIndex(indexRequest.result);
        const maximum = index.entries.reduce((value, entry) => Math.max(value, entry.updatedAt), 0);
        const updatedAt = nextTimestamp(maximum);
        const envelope: HistoryEnvelope = {
          version: 1,
          scope,
          sessionKey,
          messages: prepared.messages,
          updatedAt,
          byteSize: prepared.byteSize,
        };

        // 条目和索引、容量淘汰在同一事务中完成，任一步失败都会保留旧快照。
        store.put(envelope, key);
        let entries = index.entries.filter((entry) => entry.key !== key);
        entries.push({ key, scope, sessionKey, updatedAt, byteSize: prepared.byteSize });
        entries.sort((left, right) => left.updatedAt - right.updatedAt);
        let totalBytes = entries.reduce((total, entry) => total + entry.byteSize, 0);
        while (entries.length > MAX_SESSIONS || totalBytes > MAX_TOTAL_BYTES) {
          const evicted = entries.shift();
          if (!evicted) break;
          totalBytes -= evicted.byteSize;
          store.delete(evicted.key);
        }
        store.put({ version: 1, entries } satisfies HistoryIndex, INDEX_KEY);
      } catch {
        try { transaction.abort(); } catch { /* transaction already closed */ }
      }
    };
    indexRequest.onerror = () => {
      try { transaction.abort(); } catch { /* transaction already closed */ }
    };
    await waitForTransaction(transaction);
  } catch {
    // 缓存不可用、事务中止或配额不足都不能影响真实聊天流程。
  }
}

export async function deleteCachedChatHistory(scope: string, sessionKey: string): Promise<void> {
  if (!isValidPart(scope) || !isValidPart(sessionKey)) return;
  try {
    const database = await openDb();
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const key = historyKey(scope, sessionKey);
    const indexRequest = store.get(INDEX_KEY);
    indexRequest.onsuccess = () => {
      try {
        store.delete(key);
        const index = validIndex(indexRequest.result);
        index.entries = index.entries.filter((entry) => entry.key !== key);
        store.put(index, INDEX_KEY);
      } catch {
        try { transaction.abort(); } catch { /* transaction already closed */ }
      }
    };
    indexRequest.onerror = () => {
      try { transaction.abort(); } catch { /* transaction already closed */ }
    };
    await waitForTransaction(transaction);
  } catch {
    // 删除失败保持原缓存，不影响会话本身的删除结果。
  }
}

export async function clearCachedChatHistoryExcept(scope: string): Promise<void> {
  if (!isValidPart(scope)) return;
  try {
    const database = await openDb();
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const retained: HistoryIndexEntry[] = [];
    const indexRequest = store.get(INDEX_KEY);
    indexRequest.onsuccess = () => {
      const currentEntries = new Map(validIndex(indexRequest.result).entries.map((entry) => [entry.key, entry]));
      const cursorRequest = store.openCursor(IDBKeyRange.bound(KEY_PREFIX, `${KEY_PREFIX}\uffff`));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          try {
            store.put({ version: 1, entries: retained } satisfies HistoryIndex, INDEX_KEY);
          } catch {
            try { transaction.abort(); } catch { /* transaction already closed */ }
          }
          return;
        }
        const key = typeof cursor.key === "string" ? cursor.key : "";
        if (key.startsWith(KEY_PREFIX) && key !== INDEX_KEY) {
          const value = cursor.value;
          if (value && typeof value === "object" && (value as Partial<HistoryEnvelope>).version === 1 && (value as Partial<HistoryEnvelope>).scope === scope) {
            const envelope = value as HistoryEnvelope;
            if (typeof envelope.sessionKey === "string" && typeof envelope.updatedAt === "number" && typeof envelope.byteSize === "number") {
              const indexed = currentEntries.get(key);
              const updatedAt = indexed?.scope === scope && indexed.sessionKey === envelope.sessionKey
                ? indexed.updatedAt
                : envelope.updatedAt;
              retained.push({ key, scope, sessionKey: envelope.sessionKey, updatedAt, byteSize: envelope.byteSize });
            }
          } else {
            cursor.delete();
          }
        }
        cursor.continue();
      };
      cursorRequest.onerror = () => {
        try { transaction.abort(); } catch { /* transaction already closed */ }
      };
    };
    indexRequest.onerror = () => {
      try { transaction.abort(); } catch { /* transaction already closed */ }
    };
    await waitForTransaction(transaction);
  } catch {
    // 清理失败时保留旧缓存，下一次 scope 校验仍会阻止跨配置读取。
  }
}
