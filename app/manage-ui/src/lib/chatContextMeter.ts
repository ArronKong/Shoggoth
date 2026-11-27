import type { ChatResponseMetadata, ContextComposition, RuntimeContextUsage } from "../types";

export interface ContextMeter {
  usedTokens: number;
  contextWindow: number;
  percent: number;
  level: "normal" | "warning" | "high";
  estimated: boolean;
}

export function fmtTokens(n?: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function sessionContextMeter(session: { totalTokens?: number; totalTokensFresh?: boolean; contextTokens?: number;
  contextUsage?: RuntimeContextUsage | null } | null, native: boolean): ContextMeter | null {
  if (!session) return null;
  const usage = session.contextUsage;
  if (native ? usage?.quality !== "exact" && usage?.quality !== "estimated" : session.totalTokensFresh === false) return null;
  const usedTokens = native ? usage?.usedTokens : session.totalTokens;
  const contextWindow = native ? usage?.contextWindow : session.contextTokens;
  if (usedTokens == null || !Number.isSafeInteger(usedTokens) || usedTokens < 0
    || contextWindow == null || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null;
  const fraction = usedTokens / contextWindow;
  return { usedTokens, contextWindow, percent: Math.min(100, fraction * 100),
    level: fraction > 0.8 ? "high" : fraction >= 0.7 ? "warning" : "normal",
    estimated: native && usage?.quality === "estimated" };
}

export function meterPercentLabel(meter: ContextMeter) {
  const rounded = Math.round(meter.percent);
  if (rounded === 70 && meter.level === "normal") return "<70%";
  if (rounded === 80 && meter.level === "high") return ">80%";
  return rounded + "%";
}

/** A reset, compaction, new input or incomplete turn invalidates the previous input snapshot. */
export function latestContextReply(messages: readonly { role: string; nativeRunId?: string; responseMetadata?: ChatResponseMetadata;
  pending?: boolean; notice?: string; divider?: object; local?: boolean; isError?: boolean; errorCode?: string; stopReason?: string }[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.divider || m.pending || m.isError || m.errorCode || m.stopReason === "error" || m.role === "user"
      || m.notice === "modelSwitch" || m.notice === "contextCompacted" || m.notice === "contextRenewed" || m.notice === "runInterrupted") return null;
    if (m.local || m.notice || m.role !== "assistant") continue;
    return m.nativeRunId ? { runId: m.nativeRunId, context: m.responseMetadata?.context } : null;
  }
  return null;
}

export function contextParts(c: ContextComposition, meter: ContextMeter, replyContext?: ChatResponseMetadata["context"]) {
  const parts = [
    { key: "message", tokens: c.messageTokens },
    { key: "history", tokens: c.historyDelivered ? c.historyTokens : 0 },
    { key: "rules", tokens: c.rulesTokens },
    { key: "definition", tokens: c.definitionTokens },
    { key: "memory", tokens: c.memoryTokens },
    { key: "skills", tokens: c.skillTokens },
    { key: "tools", tokens: c.toolExposure === "resident" ? c.toolTokens : 0 },
  ].filter(p => p.tokens > 0);
  const sum = parts.reduce((total, part) => total + part.tokens, 0);
  const sameObservation = replyContext?.usedTokens === meter.usedTokens && replyContext.windowTokens === meter.contextWindow
    && (replyContext.quality === "estimated") === meter.estimated;
  const reconciled = sameObservation && sum <= meter.usedTokens;
  if (reconciled && sum < meter.usedTokens) parts.push({ key: "other", tokens: meter.usedTokens - sum });
  parts.sort((a, b) => b.tokens - a.tokens);
  return { parts, reconciled, catalog: c.toolExposure === "all" && c.toolCount > 0 ? { count: c.toolCount, tokens: c.toolTokens } : null };
}
