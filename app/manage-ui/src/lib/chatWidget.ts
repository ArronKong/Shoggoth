import type { ChatCanvasWidgetPart } from "../types";

export const CHAT_WIDGET_MIN_HEIGHT = 48;
export const CHAT_WIDGET_MAX_HEIGHT = 8_000;
export const CHAT_WIDGET_DEFAULT_HEIGHT = 320;
export const CHAT_WIDGET_PROMPT_MAX_CHARS = 4_000;
export const CHAT_WIDGET_PROMPT_RATE_LIMIT = 10;
export const CHAT_WIDGET_PROMPT_RATE_WINDOW_MS = 60_000;

const CANVAS_PREFIX = "/__openclaw__/canvas/documents/";
const DOC_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BOARD_WIDGET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BACKEND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CANVAS_PART_KEYS = new Set(["type", "preview", "rawText"]);
const CANVAS_PREVIEW_KEYS = new Set([
  "kind", "surface", "render", "viewId", "url", "title", "preferredHeight",
  "sandbox", "boardWidgetName",
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function decodedCanvasSegments(rawPath: string): string[] | null {
  if (
    rawPath.length > 4_096
    || !rawPath.startsWith(CANVAS_PREFIX)
    || rawPath.includes("?")
    || rawPath.includes("#")
  ) return null;
  const rawSegments = rawPath.slice(CANVAS_PREFIX.length).split("/");
  if (rawSegments.length < 2 || rawSegments.length > 32) return null;
  const decoded: string[] = [];
  for (const rawSegment of rawSegments) {
    if (!rawSegment || rawSegment.length > 768) return null;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      !segment
      || segment.length > 255
      || segment === "."
      || segment === ".."
      || /[\\/:\u0000-\u001f\u007f]/u.test(segment)
    ) return null;
    decoded.push(segment);
  }
  return decoded;
}

/** Normalize one raw rich-content item into the only Canvas shape the UI accepts. */
export function normalizeChatCanvasWidgetPart(raw: unknown): ChatCanvasWidgetPart | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (
    !hasOnlyKeys(item, CANVAS_PART_KEYS)
    || item.type !== "canvas"
    || !item.preview
    || typeof item.preview !== "object"
    || Array.isArray(item.preview)
  ) {
    return null;
  }
  const preview = item.preview as Record<string, unknown>;
  if (
    !hasOnlyKeys(preview, CANVAS_PREVIEW_KEYS)
    || preview.kind !== "canvas"
    || preview.surface !== "assistant_message"
    || preview.render !== "url"
    || typeof preview.viewId !== "string"
    || !DOC_ID_RE.test(preview.viewId)
    || typeof preview.url !== "string"
  ) return null;
  const segments = decodedCanvasSegments(preview.url);
  if (!segments || segments[0] !== preview.viewId) return null;
  if (preview.sandbox !== undefined && preview.sandbox !== "scripts") return null;
  if (preview.boardWidgetName !== undefined && (
    typeof preview.boardWidgetName !== "string"
    || !BOARD_WIDGET_NAME_RE.test(preview.boardWidgetName)
  )) return null;
  if (preview.title !== undefined && (typeof preview.title !== "string" || preview.title.length > 256)) return null;
  if (preview.preferredHeight !== undefined && (
    typeof preview.preferredHeight !== "number" || !Number.isFinite(preview.preferredHeight)
  )) return null;
  if (item.rawText !== undefined && typeof item.rawText !== "string") return null;
  return {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: preview.viewId,
      url: preview.url,
      ...(preview.title !== undefined ? { title: preview.title } : {}),
      ...(preview.preferredHeight !== undefined ? { preferredHeight: preview.preferredHeight } : {}),
      ...(preview.boardWidgetName !== undefined ? { boardWidgetName: preview.boardWidgetName } : {}),
    },
    ...(typeof item.rawText === "string" ? { rawText: item.rawText.slice(0, 4_000) } : {}),
  };
}

/** Collect Canvas items from cumulative live content without retaining unknown fields. */
export function normalizeChatCanvasWidgetParts(content: unknown): Array<ChatCanvasWidgetPart | null> {
  const items = Array.isArray(content)
    ? content
    : content && typeof content === "object" && !Array.isArray(content)
      && (content as { type?: unknown }).type === "canvas"
      ? [content]
      : [];
  const parts: Array<ChatCanvasWidgetPart | null> = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || (item as { type?: unknown }).type !== "canvas") continue;
    parts.push(normalizeChatCanvasWidgetPart(item));
  }
  return parts;
}

export function buildChatWidgetUrl(backendId: string, canvasPath: string): string | null {
  if (!BACKEND_ID_RE.test(backendId) || !decodedCanvasSegments(canvasPath)) return null;
  return `/__widget/${encodeURIComponent(backendId)}${canvasPath}`;
}

export function clampChatWidgetHeight(value: unknown): number {
  const height = typeof value === "number" && Number.isFinite(value) ? Math.ceil(value) : CHAT_WIDGET_DEFAULT_HEIGHT;
  return Math.min(CHAT_WIDGET_MAX_HEIGHT, Math.max(CHAT_WIDGET_MIN_HEIGHT, height));
}

export interface ChatWidgetPinSpec {
  name: string;
  docId: string;
}

/** Use only the Gateway-issued stable board identity plus the validated Canvas id. */
export function chatWidgetPinSpec(part: ChatCanvasWidgetPart | null): ChatWidgetPinSpec | null {
  const name = part?.preview.boardWidgetName;
  const docId = part?.preview.viewId;
  return typeof name === "string"
    && BOARD_WIDGET_NAME_RE.test(name)
    && typeof docId === "string"
    && DOC_ID_RE.test(docId)
    ? { name, docId }
    : null;
}

export interface ChatWidgetPromptContext {
  documentVisible: boolean;
  documentFocused: boolean;
  frameFocused: boolean;
  userActivated: boolean;
}

/** Fail closed before an untrusted widget prompt reaches ChatPage's ordinary send gate. */
export function normalizeChatWidgetPrompt(raw: unknown, context: ChatWidgetPromptContext): string | null {
  if (!context.documentVisible || !context.documentFocused || !context.frameFocused || !context.userActivated) return null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > CHAT_WIDGET_PROMPT_MAX_CHARS || text.startsWith("/")) return null;
  return text;
}

/** Session-scoped rolling-minute limiter. The caller owns and persists the timestamp array. */
export function consumeChatWidgetPromptRate(timestamps: number[], now: number): boolean {
  const cutoff = now - CHAT_WIDGET_PROMPT_RATE_WINDOW_MS;
  let removeCount = 0;
  while (removeCount < timestamps.length && timestamps[removeCount] <= cutoff) removeCount += 1;
  if (removeCount) timestamps.splice(0, removeCount);
  if (timestamps.length >= CHAT_WIDGET_PROMPT_RATE_LIMIT) return false;
  timestamps.push(now);
  return true;
}

/** Sandboxed frames have opaque `null` origins; source identity binds the message to one iframe. */
export function isOwnedChatWidgetWindowMessage(
  source: MessageEventSource | null,
  origin: string,
  frameWindow: Window | null,
): boolean {
  return source === frameWindow && origin === "null";
}
