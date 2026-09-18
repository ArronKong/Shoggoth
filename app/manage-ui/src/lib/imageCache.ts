// 本地图片缓存（IndexedDB）。OpenClaw 不把用户发送的图片写进 chat.history（图片只活在
// 喂给模型的 trajectory 里），所以重开 app 从 chat.history 重载时 user 消息已没有图。这里在
// 发送时按 `会话Key::文本` 存图，loadHistory 后据此还原 user 消息的 images。
// 局限：同一会话用「完全相同的文本」发不同图会互相覆盖（罕见，已与用户对齐）。
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

// 关联键：会话 + 归一化文本。重开后 history 消息只有文本可用来回认其图片。
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
      tx.objectStore(STORE).put(images, key);
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
// 这里只缓存元数据（文件名 + 类别），不存字节——chip 只需要名字。
// 复用同一个 store，靠 key 前缀分空间（避免为此升 DB 版本动已有数据）。
// `src`：仅视频缓存 dataURL（重载后仍可播放）。其余类别只留名字——chip 不需要
// 数据，而视频若超过调用方的大小上限也会退化成无 src 的 chip。
export interface CachedFileRef { name: string; kind: string; src?: string }

export function fileCacheKey(sessionKey: string, text: string): string {
  return `files::${sessionKey}::${(text || "").trim()}`;
}

export async function putFiles(key: string, files: CachedFileRef[]): Promise<void> {
  if (!files?.length) return;
  try {
    const d = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(files, key);
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
        resolve(Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof x.name === "string")
          ? (v as CachedFileRef[])
          : undefined);
      };
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}
