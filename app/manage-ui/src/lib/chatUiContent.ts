export interface NativeUiArtifactPart {
  type: "ui_artifact";
  schemaVersion: 1;
  artifactId: string;
  revision: number;
  sourceEventId: string;
  segmentId: string;
  title: string;
  summary: string;
}
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export function normalizeNativeUiPart(raw: unknown): NativeUiArtifactPart | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = ["type", "schemaVersion", "artifactId", "revision", "sourceEventId", "segmentId", "title", "summary"];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.type !== "ui_artifact" || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || ["artifactId", "sourceEventId", "segmentId"].some(key => typeof value[key] !== "string" || !id.test(value[key] as string))
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 120
    || typeof value.summary !== "string" || value.summary.length > 600
    || [value.title, value.summary].some(text => new TextDecoder().decode(new TextEncoder().encode(text)) !== text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) return null;
  if (new TextEncoder().encode(JSON.stringify(value)).length > 8192) return null;
  return value as unknown as NativeUiArtifactPart;
}
export function nativeUiPartKey(part: NativeUiArtifactPart): string {
  return `${part.sourceEventId}:${part.segmentId}:${part.artifactId}`;
}
export function nativeUiSummary(part: NativeUiArtifactPart): string { return `[交互卡片：${part.title}] ${part.summary}`; }

interface NativeUiLegacyMessage {
  role: string;
  pending?: boolean;
  canonicalSourceEventId?: string;
  sourceEventIds?: string[];
  parts: { type: string; text?: string; sourceEventId?: string }[];
}
const canonicalId = (value: unknown): string | undefined => typeof value === "string" && id.test(value) ? value : undefined;

// Fences belong to individual canonical sources. Joining different messages
// would change their block indexes or turn two incomplete fences into a page.
export function nativeUiLegacySources(message: NativeUiLegacyMessage): { text: string; sourceEventId: string }[] {
  if (message.role !== "assistant" || message.pending) return [];
  const grouped = Array.isArray(message.sourceEventIds);
  const allowed = new Set((grouped ? message.sourceEventIds! : [message.canonicalSourceEventId])
    .map(canonicalId).filter((value): value is string => value !== undefined));
  const sources = new Map<string, string[]>();
  for (const part of message.parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const sourceEventId = canonicalId(part.sourceEventId)
      ?? (!grouped && part.sourceEventId === undefined ? canonicalId(message.canonicalSourceEventId) : undefined);
    if (!sourceEventId || !allowed.has(sourceEventId)) continue;
    const texts = sources.get(sourceEventId) ?? [];
    texts.push(part.text); sources.set(sourceEventId, texts);
  }
  return [...sources].map(([sourceEventId, texts]) => ({ sourceEventId, text: texts.join("\n") }));
}

// Display grouping keeps each assistant text's canonical source, including
// imported messages whose native id differs from their Transcript event id.
export function groupNativeUiHistory(raw: any[]): any[] {
  const cardRuns = new Set(raw.filter(message => message?.role === "assistant"
    && message.content?.some?.((part: unknown) => normalizeNativeUiPart(part))).map(message => message.shoggoth?.runId).filter(Boolean));
  const output: any[] = [];
  for (const message of raw) {
    const runId = message?.shoggoth?.runId;
    const eligible = cardRuns.has(runId) && ["assistant", "toolResult"].includes(message.role);
    if (!eligible) { output.push(message); continue; }
    const sourceEventId = message.role === "assistant" ? canonicalId(message.shoggoth?.sourceEventId) : undefined;
    const content = message.content.map((part: any) => part?.type === "text"
      ? { ...part, sourceEventId } : part);
    const allowedSource = sourceEventId && message.shoggoth?.contextExcluded !== true ? sourceEventId : undefined;
    const previous = output.at(-1);
    if (previous?.shoggoth?.uiDisplayRunId === runId) {
      previous.content.push(...content);
      previous.timestamp = message.timestamp;
      if (allowedSource && !previous.shoggoth.sourceEventIds.includes(allowedSource)) previous.shoggoth.sourceEventIds.push(allowedSource);
    } else output.push({ ...message, role: "assistant", content,
      shoggoth: { ...message.shoggoth, uiDisplayRunId: runId, displayId: `native-run:${runId}`, sourceEventIds: allowedSource ? [allowedSource] : [] } });
  }
  return output;
}
