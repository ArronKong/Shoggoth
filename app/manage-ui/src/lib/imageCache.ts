import type { ChatAttachment } from "./chatRuntime";

// External history can carry media metadata without bytes. Prefer the exact
// send operation. The text keys below are retained for legacy history.
const DB_NAME = "shoggoth-chat";
const STORE = "images";

let dbp: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp = opening;
  // 失败 Promise 不能永久占住单飞槽；只清理当前这一次，避免误伤后续成功连接。
  void opening.catch(() => {
    if (dbp === opening) dbp = null;
  });
  return opening;
}

const operationCacheKey = (session: string, operation: string) =>
  `attachments::${JSON.stringify([session, operation.replace(/:user$/u, "")])}`;

export async function putOperationAttachments(session: string, operation: string, attachments: ChatAttachment[]): Promise<void> {
  if (!attachments.length) return;
  try {
    const d = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(attachments, operationCacheKey(session, operation));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* An unavailable local cache must not block chat.send. */ }
}

export async function getOperationAttachments(session: string, operation: string): Promise<ChatAttachment[] | undefined> {
  try {
    const d = await openDb();
    return await new Promise<ChatAttachment[] | undefined>((resolve) => {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(operationCacheKey(session, operation));
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : undefined);
      req.onerror = () => resolve(undefined);
    });
  } catch { return undefined; }
}

// Legacy key: session + normalized text.
export function imgCacheKey(sessionKey: string, text: string): string {
  return `${sessionKey}::${(text || "").trim()}`;
}

// 发送带图消息时调用：把这条消息的图片（base64 dataURL[]）按 key 落 IndexedDB。
export async function putImages(key: string, images: string[]): Promise<void> {
  if (!images?.length) return;
  try {
    const d = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const previous = store.get(key);
      previous.onsuccess = () => {
        const old = previous.result;
        const ambiguous = old === null || Array.isArray(old)
          && (old.length !== images.length || old.some((src, index) => src !== images[index]));
        store.put(ambiguous ? null : images, key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* IndexedDB 不可用 / 配额满：放弃缓存，不影响发送本身 */
  }
}

// loadHistory 还原时调用：按 key 取回该消息缓存的图片，没有则 undefined。
export async function getImages(key: string): Promise<string[] | undefined> {
  try {
    const d = await openDb();
    return await new Promise<string[] | undefined>((resolve) => {
      const tx = d.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as string[]) : undefined);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

// ---- 非图片附件（PDF/任意文件）----
//
// 同样的问题、同样的解法：两个后端的 chat.history 里都没有「这条消息带了哪些
// 文件」的结构化字段（Hermes 只有转录里的 `[file: x]` 文本 marker，OpenClaw
// 连 marker 都没有——纯媒体消息在历史里是 `[User sent media without caption]`
// 这样的占位）。于是重开 app / 切回会话后，用户看不到自己发过什么文件。
// 缓存元数据与有界的文件来源，让附件标签可以重新打开文件。
// 复用同一个 store，靠 key 前缀分空间（避免为此升 DB 版本动已有数据）。
// `src`：安全的应用媒体引用或有界 dataURL；超过调用方大小上限只保留名字。
export interface CachedFileRef { name: string; kind: string; src?: string; sourceAmbiguous?: boolean }

export function fileCacheKey(sessionKey: string, text: string): string {
  return `files::${sessionKey}::${(text || "").trim()}`;
}

export async function putFiles(key: string, files: CachedFileRef[]): Promise<void> {
  if (!files?.length) return;
  try {
    const d = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const previous = store.get(key);
      previous.onsuccess = () => {
        const old: CachedFileRef[] | undefined = Array.isArray(previous.result) ? previous.result : undefined;
        // The legacy key is session + text. Repeated text with different files
        // cannot identify a historical message, so never lend it the new bytes.
        const ambiguous = old && (old.some((file) => file.sourceAmbiguous)
          || old.length !== files.length
          || old.some((file, index) => file.name !== files[index].name
            || file.kind !== files[index].kind || file.src !== files[index].src));
        store.put(ambiguous ? files.map(({ name, kind }) => ({ name, kind, sourceAmbiguous: true })) : files, key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* IndexedDB 不可用 / 配额满：放弃缓存，不影响发送本身 */
  }
}

export async function getFiles(key: string): Promise<CachedFileRef[] | undefined> {
  try {
    const d = await openDb();
    return await new Promise<CachedFileRef[] | undefined>((resolve) => {
      const tx = d.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof x.name === "string" && !x.sourceAmbiguous)
          ? (v as CachedFileRef[])
          : undefined);
      };
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}
