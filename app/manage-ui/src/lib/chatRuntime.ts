// ChatPage 运行时的可测试状态转换：集中处理 socket 生命周期、命令参数、重试附件与渲染身份。

export function createLatestRequestGuard() {
  let sequence = 0;
  return {
    begin(): number {
      sequence += 1;
      return sequence;
    },
    isCurrent(ticket: number): boolean {
      return ticket === sequence;
    },
    invalidate(): void {
      sequence += 1;
    },
  };
}

export interface ChatAttachment {
  id: string;
  dataUrl: string;
  mimeType: string;
  name: string;
  // 附件种类（S5）：缺省 image（历史重试路径只恢复内嵌图片）。pdf/file/video 仅在
  // 后端能力（getChatCapabilities）声明支持时可被添加（video 按 file 上传，只是
  // UI 侧给它可播放的预览）。
  kind?: "image" | "audio" | "pdf" | "file" | "video";
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  nativeRef?: { id: string; name: string; mimeType: string; size: number };
}

export interface ChatMediaFact {
  name: string;
  kind: "image" | "audio" | "video" | "file";
  mimeType?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
}

/** Durable native attachment references use the app's authenticated media route. */
export function nativeChatMedia(raw: unknown): { images: string[]; files: Array<ChatMediaFact & { src: string }>; attachments: ChatAttachment[] } {
  const images: string[] = [];
  const files: Array<ChatMediaFact & { src: string }> = [];
  const attachments: ChatAttachment[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)
      || typeof item.name !== "string" || typeof item.mimeType !== "string"
      || !Number.isSafeInteger(item.size) || item.size <= 0) continue;
    const src = `/__api/inspirations/media?id=${encodeURIComponent(item.id)}`;
    const kind = item.mimeType.startsWith("image/") ? "image" : item.mimeType.startsWith("video/") ? "video"
      : item.mimeType.startsWith("audio/") ? "audio" : item.mimeType === "application/pdf" ? "pdf" : "file";
    attachments.push({ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.size, kind,
      dataUrl: src, nativeRef: { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size } });
    if (item.mimeType.startsWith("image/")) images.push(src + (/^image\/hei[cf]$/.test(item.mimeType) ? "&preview=1" : ""));
    else files.push({ name: item.name, mimeType: item.mimeType, sizeBytes: item.size, src,
      kind: item.mimeType.startsWith("video/") ? "video" : item.mimeType.startsWith("audio/") ? "audio" : "file" });
  }
  return { images, files, attachments };
}

/** Build the 2026.8.1 chat.send attachment item; never re-wrap the base64 in legacy source. */
export function buildOpenClawAttachment(attachment: ChatAttachment): Record<string, unknown> {
  if (attachment.nativeRef) return { nativeRef: attachment.nativeRef };
  const content = attachment.dataUrl.replace(/^data:[^,]*;base64,/i, "");
  const kind = attachment.kind || "image";
  return {
    type: kind,
    mimeType: attachment.mimeType,
    fileName: attachment.name,
    content,
    ...(Number.isFinite(attachment.sizeBytes) && (attachment.sizeBytes as number) >= 0
      ? { sizeBytes: attachment.sizeBytes }
      : {}),
    ...(Number.isFinite(attachment.durationMs) && (attachment.durationMs as number) >= 0
      ? { durationMs: attachment.durationMs }
      : {}),
    ...(Number.isFinite(attachment.width) && (attachment.width as number) > 0 ? { width: attachment.width } : {}),
    ...(Number.isFinite(attachment.height) && (attachment.height as number) > 0 ? { height: attachment.height } : {}),
  };
}

/** Build the shared chat.send params used by OpenClaw and the proxy-routed backends. */
export function buildChatSendParams(
  sessionKey: string,
  message: string,
  idempotencyKey: string,
  attachments: readonly ChatAttachment[],
): Record<string, unknown> {
  return {
    sessionKey,
    message,
    idempotencyKey,
    ...(attachments.length ? { attachments: attachments.map(buildOpenClawAttachment) } : {}),
  };
}

export interface GatewayRequestPayloadBudget {
  allowed: boolean;
  payloadBytes: number;
  maxPayload?: number;
}

/**
 * Measure the complete JSON message consumed by the gateway's maxPayload limit.
 * TextEncoder is intentional: string.length counts UTF-16 code units and would
 * under-count non-ASCII session keys, messages, and file names on the wire.
 */
export function gatewayRequestPayloadBudget(
  id: string,
  method: string,
  params: unknown,
  maxPayload?: number,
): GatewayRequestPayloadBudget {
  const hasLimit = Number.isSafeInteger(maxPayload) && (maxPayload as number) >= 0;
  // Backends without a negotiated whole-frame limit must not pay for a second
  // stringify + UTF-8 copy of a potentially tens-of-megabytes attachment body.
  if (!hasLimit) return { allowed: true, payloadBytes: 0 };
  const frame = JSON.stringify({ type: "req", id, method, params });
  const payloadBytes = new TextEncoder().encode(frame).byteLength;
  return {
    allowed: payloadBytes <= (maxPayload as number),
    payloadBytes,
    maxPayload,
  };
}

function mediaKind(rawType: unknown, mimeType: unknown): ChatMediaFact["kind"] {
  const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
  const mime = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  if (type === "image" || mime.startsWith("image/")) return "image";
  if (type === "audio" || mime.startsWith("audio/")) return "audio";
  if (type === "video" || mime.startsWith("video/")) return "video";
  return "file";
}

function finiteMediaNumber(value: unknown, positive = false): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0)
    ? value
    : undefined;
}

// chat.history projects attachment facts under __openclaw.media. Deliberately
// ignore uri/path/content: a browser has no authority to dereference gateway media
// handles, and projecting a local path could disclose private host state.
export function normalizeOpenClawMediaFacts(raw: unknown): ChatMediaFact[] {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const items = Array.isArray(raw) ? raw : Array.isArray(record?.items) ? record.items : record ? [record] : [];
  const facts: ChatMediaFact[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const mimeType = typeof value.mimeType === "string"
      ? value.mimeType
      : typeof value.mime_type === "string"
        ? value.mime_type
        : typeof value.contentType === "string"
          ? value.contentType
          : undefined;
    const rawName = typeof value.fileName === "string"
      ? value.fileName
      : typeof value.filename === "string"
        ? value.filename
        : typeof value.name === "string"
          ? value.name
          : "";
    // A malformed gateway must not turn an accidental path into renderer text.
    const name = rawName.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 240) || "attachment";
    facts.push({
      name,
      kind: mediaKind(value.type ?? value.kind, mimeType),
      ...(mimeType ? { mimeType } : {}),
      ...(finiteMediaNumber(value.sizeBytes ?? value.size_bytes ?? value.size) !== undefined
        ? { sizeBytes: finiteMediaNumber(value.sizeBytes ?? value.size_bytes ?? value.size) }
        : {}),
      ...(finiteMediaNumber(value.durationMs ?? value.duration_ms ?? value.duration) !== undefined
        ? { durationMs: finiteMediaNumber(value.durationMs ?? value.duration_ms ?? value.duration) }
        : {}),
      ...(finiteMediaNumber(value.width, true) !== undefined ? { width: finiteMediaNumber(value.width, true) } : {}),
      ...(finiteMediaNumber(value.height, true) !== undefined ? { height: finiteMediaNumber(value.height, true) } : {}),
    });
  }
  return facts;
}

export interface PendingRpcEntry<TSocket = unknown> {
  socket: TSocket;
  timer: ReturnType<typeof setTimeout>;
  resolve: (frame: any) => void;
  reject: (error: unknown) => void;
}

interface RenderPart {
  type?: string;
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  planEntries?: unknown[];
  diff?: unknown;
}

interface RenderMessage {
  id?: string;
  role?: string;
  ts?: number;
  model?: string;
  provider?: string;
  pending?: boolean;
  parts?: RenderPart[];
  images?: string[];
  divider?: { sealedAt?: number | null; fromReset?: boolean; truncated?: boolean };
}

interface RenderGroup {
  msgs: readonly RenderMessage[];
}

export interface ChatSearchAnchor {
  query: string;
  snippet: string;
  role?: string;
  messageId?: string;
}

export interface KeyedChatValue<T> {
  item: T;
  key: string;
}

// 新连接不能继承旧 socket 的半截工具、思考或计划流；三个容器必须作为一个状态转换清空。
export function clearLiveTurnState(
  liveTools: Map<string, unknown>,
  pendingThinking: Map<string, unknown>,
  pendingPlan: Map<string, unknown>,
): void {
  liveTools.clear();
  pendingThinking.clear();
  pendingPlan.clear();
}

// 取走一次 RPC 响应并同步清除 timeout；socket 身份不符时保留新连接的同类请求。
export function takePendingRpc<TSocket>(
  pending: Map<string, PendingRpcEntry<TSocket>>,
  id: string,
  socket: TSocket,
): PendingRpcEntry<TSocket> | undefined {
  const entry = pending.get(id);
  if (!entry || entry.socket !== socket) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  return entry;
}

// socket 关闭时立即结算它拥有的全部 RPC；旧 socket 的迟到 close 不得删除新 socket 请求。
export function rejectPendingRpcForSocket<TSocket>(
  pending: Map<string, PendingRpcEntry<TSocket>>,
  socket: TSocket,
  error: Error,
): number {
  let rejected = 0;
  for (const [id, entry] of [...pending.entries()]) {
    if (entry.socket !== socket) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
    rejected += 1;
  }
  return rejected;
}

// /compact 的可选说明只透传 trim 后的非空文本；空参数保持原有 `{ key }` 协议。
export function buildCompactParams(key: string, rawInstructions: string): { key: string; instructions?: string } {
  const instructions = rawInstructions.trim();
  return instructions ? { key, instructions } : { key };
}

// MIME 子类型转换为便于上传识别的扩展名，覆盖常见的 jpeg/svg 特例。
function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  const subtype = mimeType.split("/")[1] ?? "image";
  return subtype.replace(/[^a-z0-9]+/gi, "") || "image";
}

// 默认附件 id 优先使用浏览器 UUID；极旧环境下仍生成当前页面内足够唯一的备用值。
function createAttachmentId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 把历史 user message 中的 base64 图片恢复为 sendChatMessage 使用的附件结构；非内嵌图片不伪造上传。
export function retryChatAttachments(
  images: readonly string[],
  createId: () => string = createAttachmentId,
): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  for (const dataUrl of images) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(dataUrl);
    if (!match) continue;
    const mimeType = match[1].toLowerCase();
    attachments.push({
      id: createId(),
      dataUrl,
      mimeType,
      name: `retry-image-${attachments.length + 1}.${imageExtension(mimeType)}`,
    });
  }
  return attachments;
}

// 对可能很大的正文/data URL 取首尾样本，避免渲染 key 每次遍历整张图片的 base64。
function sampleString(value: string): string {
  if (value.length <= 512) return value;
  return `${value.slice(0, 256)}:${value.length}:${value.slice(-256)}`;
}

// 生成与对象字段顺序无关的稳定内容串；循环引用只保留标记，不能阻断消息渲染。
function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === "string") return JSON.stringify(sampleString(value));
  if (value == null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`).join(",")}}`;
}

// FNV-1a 内容摘要让 React key 保持短小，同时对克隆后的同一消息保持确定性。
function stableHash(value: unknown): string {
  const text = stableSerialize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// 消息基础身份优先采用服务端 id；缺失时使用 reset 元数据或稳定内容。
function chatMessageBaseKey(message: RenderMessage): string {
  if (message.id) return `message:${message.id}`;
  if (message.divider) {
    return `divider:${message.divider.sealedAt ?? "unknown"}:${message.divider.fromReset ? 1 : 0}:${message.divider.truncated ? 1 : 0}`;
  }
  if (message.pending) return `message:pending:${message.role ?? "assistant"}`;
  const imageIdentity = (message.images ?? []).map((src) => `${src.length}:${stableHash(sampleString(src))}`);
  return `message:${message.role ?? "unknown"}:${message.ts ?? "no-ts"}:${stableHash({
    model: message.model,
    provider: message.provider,
    parts: message.parts ?? [],
    images: imageIdentity,
  })}`;
}

// 视觉组基础身份锚定首个带 id 的消息；全组无 id 时锚定首条稳定消息身份。
function chatGroupBaseKey(messages: readonly RenderMessage[]): string {
  const identified = messages.find((message) => message.id);
  if (identified?.id) return `group:${identified.id}`;
  const first = messages[0];
  return first ? `group:${chatMessageBaseKey(first)}` : "group:empty";
}

// 同级相同基础身份用局部 occurrence 消歧；从尾部计数时，头部 prepend 同身份节点也不改旧 key。
function keyedByOccurrence<T>(
  items: readonly T[],
  baseKey: (item: T) => string,
  countFrom: "start" | "end" = "start",
): KeyedChatValue<T>[] {
  const occurrences = new Map<string, number>();
  const keyed = new Array<KeyedChatValue<T>>(items.length);
  const start = countFrom === "end" ? items.length - 1 : 0;
  const stop = countFrom === "end" ? -1 : items.length;
  const step = countFrom === "end" ? -1 : 1;
  for (let index = start; index !== stop; index += step) {
    const item = items[index];
    const base = baseKey(item);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    keyed[index] = { item, key: `${base}:occurrence:${occurrence}` };
  }
  return keyed;
}

// 消息从尾部计算同身份 ordinal：归档向头部插入相同匿名消息时，已有消息 key 不变。
export function keyedChatMessages<T extends RenderMessage>(messages: readonly T[]): KeyedChatValue<T>[] {
  return keyedByOccurrence(messages, chatMessageBaseKey, "end");
}

// shownGroups 同样从尾部消歧，保证归档在组列表头部 prepend 后既有组 identity 不变。
export function keyedChatGroups<T extends RenderGroup>(groups: readonly T[]): KeyedChatValue<T>[] {
  return keyedByOccurrence(groups, (group) => chatGroupBaseKey(group.msgs), "end");
}

function normalizedSearchText(value: string): string {
  return value.replace(/>>>|<<</g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function searchSnippetProbe(value: string): string {
  return normalizedSearchText(value)
    .replace(/^(?:(?:\.\.\.)|…)+\s*/, "")
    .replace(/\s*(?:(?:\.\.\.)|…)+$/, "")
    .trim();
}

// OpenClaw supplies an exact message id. Hermes' dashboard search currently
// exposes only the FTS snippet, so match that contiguous excerpt against the
// fully loaded transcript and fall back to the literal query for short rows.
export function findChatSearchGroupKey<T extends RenderGroup>(
  groups: readonly KeyedChatValue<T>[],
  anchor: ChatSearchAnchor,
): string | undefined {
  if (anchor.messageId) {
    return groups.find(({ item }) => item.msgs.some((message) => message.id === anchor.messageId))?.key;
  }
  const snippet = searchSnippetProbe(anchor.snippet);
  const query = normalizedSearchText(anchor.query);
  for (const { item, key } of groups) {
    for (const message of item.msgs) {
      if (anchor.role && message.role !== anchor.role) continue;
      const text = normalizedSearchText((message.parts ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text || "")
        .join("\n"));
      if ((snippet.length >= 4 && text.includes(snippet)) || (query && text.includes(query))) return key;
    }
  }
  return undefined;
}

// Settled children use content identity. The live text/thinking/plan slots are
// updated in place: hashing their growing content remounts the entire subtree on
// every delta. Count per type so inserting a tool/plan before text keeps its key.
export function keyedChatChildren<T>(
  message: RenderMessage,
  kind: string,
  children: readonly T[],
): KeyedChatValue<T>[] {
  const parentKey = chatMessageBaseKey(message);
  return keyedByOccurrence(children, (child) => {
    const type = child && typeof child === "object" ? (child as RenderPart).type : undefined;
    const liveSlot = message.pending && kind === "part"
      && (type === "text" || type === "thinking" || type === "plan");
    return `${parentKey}:${kind}:${liveSlot ? `live:${type}` : stableHash(child)}`;
  });
}

// Detect our quote-reply format in an outgoing user message: leading `> `
// blockquote paragraphs (each = one or more consecutive `> ` lines; multi-line
// since R152 carries the quoted message in full), then the body. Lets the sent
// bubble collapse every quote to one clickable line (instead of a full
// markdown blockquote). The terminating blank line is OPTIONAL（R154）：gateway
// chat.history 会把超长消息截到 ~8K 并附 "...(truncated)..."，截口常落在引用块
// 中间——未终结的块也必须折叠，否则渲染成整面 blockquote 墙、正文不可见。ALL
// leading quote paragraphs are consumed — a resend can stack the prefix twice
// (paste a quote-carrying message + re-quote, R115) — and exact duplicates
// collapse to one. Each quote is returned de-prefixed (original newlines
// restored). Hand-typed leading `> ` lines collapse too — acceptable: the
// body still renders, the row is just a no-op jump.
//
// 空引用行两种形态都要认（R347）：发送时是 `"> "`（尾随空格），但 loadHistory 的
// extractAttachmentMarkers 会逐行剥尾随空白，历史重载后变成裸 `">"`。只认前者
// 会在第一个空行断开引用块，后半截引用掉进 body 渲染成 blockquote 墙。两种形态
// 去前缀后都得到空串，折叠出的引用载荷因此逐字节一致（跳转匹配不分叉）。
const isQuoteLine = (line: string) => line === ">" || line.startsWith("> ");
const stripQuoteMark = (line: string) => (line.startsWith("> ") ? line.slice(2) : line.slice(1));

export function parseQuoteFromText(text: string): { quotes: string[]; body: string } | null {
  const lines = text.split("\n");
  const quotes: string[] = [];
  let i = 0;
  while (i < lines.length && isQuoteLine(lines[i])) {
    const block: string[] = [];
    while (i < lines.length && isQuoteLine(lines[i])) {
      block.push(stripQuoteMark(lines[i]));
      i++;
    }
    const q = block.join("\n");
    if (q.trim() && !quotes.includes(q)) quotes.push(q);
    let sawBlank = false;
    while (i < lines.length && !lines[i].trim()) {
      i++;
      sawBlank = true;
    }
    if (!sawBlank) break; // 截断/手打的未终结块：剩余全归正文，不再吃下一块
  }
  if (!quotes.length) return null;
  return { quotes, body: lines.slice(i).join("\n") };
}
