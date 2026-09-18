import { sessionTail } from "./sessionKind";

export interface SessionDisplayRow {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  title?: string;
  name?: string;
  subject?: string;
  lastMessagePreview?: string;
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function contentTitle(row: SessionDisplayRow): string {
  const tail = sessionTail(row.key);
  for (const value of [row.label, row.title, row.displayName, row.derivedTitle, row.name, row.subject]) {
    const text = oneLine(value);
    if (text && text !== row.key && text !== tail) return text;
  }
  return "";
}

/** Human-readable session name. Raw ids are reserved for search/tooltips. */
export function sessionDisplayTitle(row: SessionDisplayRow, t: TFn): string {
  const content = contentTitle(row);
  if (content) return content;

  const tail = sessionTail(row.key);
  if (!tail || tail === "main") return t("chat.sessionKindMain");
  let match: RegExpExecArray | null;
  if (/^dashboard:[0-9a-f][0-9a-f-]+$/i.test(tail)) return t("chat.sessionKindWeb");
  if ((match = /^telegram:[^:]+:direct:(\d+)(?::thread:(\d+))?$/.exec(tail)))
    return t("chat.sessionKindTgDirect", { id: match[1] }) + (match[2] ? ` · ${t("chat.sessionKindTopic", { topic: match[2] })}` : "");
  if ((match = /^telegram:group:(@[\w-]+|-?\d+)(?::topic:(\d+))?$/.exec(tail))) {
    const group = match[1].startsWith("@") ? match[1] : `…${match[1].slice(-4)}`;
    return t("chat.sessionKindTgGroup", { id: group }) + (match[2] ? ` · ${t("chat.sessionKindTopic", { topic: match[2] })}` : "");
  }
  if ((match = /^discord:channel:(.+)$/.exec(tail))) return t("chat.sessionKindDiscord", { id: match[1].slice(-4) });
  if ((match = /^explicit:gateway-fallback-([0-9a-f-]+)$/i.exec(tail))) return t("chat.sessionKindFallback", { id: match[1].slice(0, 8) });
  if ((match = /^explicit:model-run-([0-9a-f-]+)$/i.exec(tail))) return t("chat.sessionKindModelRun", { id: match[1].slice(0, 8) });
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(tail)) return t("chat.sessionKindWeb");
  return tail;
}

/** Recent content shown below the title; omit duplicates and machine ids. */
export function sessionDisplayPreview(row: SessionDisplayRow, title: string): string {
  const tail = sessionTail(row.key);
  for (const value of [row.lastMessagePreview, row.subject]) {
    const text = oneLine(value);
    if (text && text !== title && text !== row.key && text !== tail) return text;
  }
  return "";
}
