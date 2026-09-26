import type { ChatAttachment } from "../../lib/chatRuntime";
import type { AdvancedSessionMethodMap, SessionForkResult } from "../../types";

export const EMPTY_ADVANCED_SESSION_METHODS: AdvancedSessionMethodMap = {
  "environments.list": false,
  "sessions.describe": false,
  "sessions.branches.list": false,
  "sessions.fork": false,
};

export function hasAdvancedSessionDetails(methods: AdvancedSessionMethodMap | null | undefined): boolean {
  return methods?.["environments.list"] === true
    || methods?.["sessions.describe"] === true
    || methods?.["sessions.branches.list"] === true;
}

interface ForkMessageCandidate {
  role?: string;
  id?: string;
  local?: boolean;
  pending?: boolean;
}

/** Return only the persisted id of the exact user message under the pointer. */
export function forkEntryIdAt(
  messages: readonly ForkMessageCandidate[],
  messageIndex: number | undefined,
  methods: AdvancedSessionMethodMap | null | undefined,
): string | null {
  if (methods?.["sessions.fork"] !== true || !Number.isInteger(messageIndex)) return null;
  const message = messages[messageIndex as number];
  if (message?.role !== "user" || message.local === true || message.pending === true) return null;
  const id = message.id;
  return typeof id === "string"
    && id.length > 0
    && id === id.trim()
    && id.length <= 1024
    && !/[\0\r\n]/.test(id)
    ? id
    : null;
}

export function shouldApplySessionResult(
  requestTicket: number,
  currentTicket: number,
  expectedSessionKey: string,
  currentSessionKey: string | null,
): boolean {
  return requestTicket === currentTicket && expectedSessionKey === currentSessionKey;
}

const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BASE64_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS_BASE64_BYTES = 64 * 1024 * 1024;

function attachmentKind(mimeType: string): ChatAttachment["kind"] {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  return "file";
}

function attachmentExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  return extensions[mimeType.toLowerCase()] ?? "";
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export interface ForkEditorDraft {
  text: string;
  attachments: ChatAttachment[];
  attachmentsOmitted: boolean;
}

/** Revalidate the browser-bound fork payload before putting it into the composer. */
export function forkEditorDraft(result: SessionForkResult): ForkEditorDraft {
  const text = typeof result.editorText === "string" && result.editorText.length <= 1024 * 1024
    ? result.editorText
    : "";
  const raw = Array.isArray(result.editorAttachments) ? result.editorAttachments : [];
  const attachments: ChatAttachment[] = [];
  let totalBase64Bytes = 0;
  let omitted = result.attachmentsOmitted === true || raw.length > MAX_ATTACHMENT_COUNT;

  for (const item of raw.slice(0, MAX_ATTACHMENT_COUNT)) {
    const mimeType = item?.mimeType;
    const data = item?.data;
    if (
      typeof mimeType !== "string"
      || !MIME_RE.test(mimeType)
      || typeof data !== "string"
      || data.length === 0
      || data.length % 4 !== 0
      || data.length > MAX_ATTACHMENT_BASE64_BYTES
      || !BASE64_RE.test(data)
      || totalBase64Bytes + data.length > MAX_ATTACHMENTS_BASE64_BYTES
    ) {
      omitted = true;
      continue;
    }
    totalBase64Bytes += data.length;
    const index = attachments.length + 1;
    attachments.push({
      id: crypto.randomUUID(),
      dataUrl: `data:${mimeType};base64,${data}`,
      mimeType,
      name: `fork-attachment-${index}${attachmentExtension(mimeType)}`,
      kind: attachmentKind(mimeType),
      sizeBytes: decodedBase64Bytes(data),
    });
  }

  return { text, attachments, attachmentsOmitted: omitted };
}
