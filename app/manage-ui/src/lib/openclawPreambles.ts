/** Public OpenClaw commentary is sent as item/preamble snapshots, independently
 * of the chat answer stream. Keep it until history acknowledges the same item. */
export interface OpenClawPreambleMessage {
  role?: string;
  ts?: number;
  pending?: boolean;
  activityRunId?: string;
  openclawPreambleIds?: string[];
  openclawPreambleKey?: string;
  openclawLivePreamble?: boolean;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const identity = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
export const openClawPreambleKey = (runId: string, itemId: string): string => JSON.stringify([runId, itemId]);

/** Signed commentary and explicit history segment projections identify preambles.
 * Tool/history records can share __openclaw.id, so that message id is insufficient. */
export function openClawPreambleIds(raw: unknown): string[] {
  const message = record(raw);
  if (message.role !== "assistant" || !identity(record(message.__openclaw).runId)) return [];
  const ids = new Set<string>();
  const fallback = record(message.openclawStreamFallback);
  const segmentId = fallback.source === "segment" ? identity(fallback.itemId) : undefined;
  if (segmentId) ids.add(segmentId);
  for (const part of Array.isArray(message.content) ? message.content : []) {
    const block = record(part);
    if (block.type !== "text" || typeof block.textSignature !== "string") continue;
    try {
      const signature = record(JSON.parse(block.textSignature));
      const id = identity(signature.id);
      if (signature.v === 1 && signature.phase === "commentary" && id) ids.add(id);
    } catch { /* Older unsigned text has no authoritative item identity. */ }
  }
  return [...ids];
}

interface Preamble { key: string; runId: string; text: string; ts: number; seq?: number; ended: boolean }
interface Run { closed: boolean; items: Map<string, Preamble>; acknowledged: Set<string> }
export function createOpenClawPreambles<T extends OpenClawPreambleMessage>(project: (item: Preamble) => T) {
  const sessions = new Map<string, Map<string, Run>>();
  const runFor = (sessionKey: string, runId: string): Run => {
    let runs = sessions.get(sessionKey);
    if (!runs) sessions.set(sessionKey, runs = new Map());
    let run = runs.get(runId);
    if (!run) runs.set(runId, run = { closed: false, items: new Map(), acknowledged: new Set() });
    return run;
  };
  return {
    ingest(payload: unknown): boolean {
      const p = record(payload), data = record(p.data);
      const sessionKey = identity(p.sessionKey), runId = identity(p.runId), itemId = identity(data.itemId);
      if (!sessionKey || !runId || !itemId || p.stream !== "item" || data.kind !== "preamble"
        || !["update", "end"].includes(String(data.phase)) || typeof data.progressText !== "string" || !data.progressText.trim()) return false;
      const run = runFor(sessionKey, runId);
      if (run.closed || run.acknowledged.has(itemId)) return false;
      const previous = run.items.get(itemId);
      const seq = typeof p.seq === "number" && Number.isFinite(p.seq) ? p.seq : undefined;
      if (previous?.ended || (seq !== undefined && previous?.seq !== undefined && seq <= previous.seq)) return false;
      const ts = typeof p.ts === "number" && Number.isFinite(p.ts) && p.ts > 0 ? p.ts : Date.now();
      run.items.set(itemId, { key: openClawPreambleKey(runId, itemId), runId, text: data.progressText,
        ts: previous?.ts ?? ts, seq: seq ?? previous?.seq, ended: data.phase === "end" });
      return true;
    },
    finish(sessionKey: string, runId: unknown): void {
      const id = identity(runId);
      if (id) runFor(sessionKey, id).closed = true;
    },
    merge(sessionKey: string, messages: readonly T[]): T[] {
      const history = messages.filter(message => !message.openclawLivePreamble);
      for (const message of history) {
        if (message.role !== "assistant" || !message.activityRunId || !message.openclawPreambleIds?.length) continue;
        const run = runFor(sessionKey, message.activityRunId);
        for (const itemId of message.openclawPreambleIds) {
          run.acknowledged.add(itemId);
          run.items.delete(itemId);
        }
      }
      const items = [...(sessions.get(sessionKey)?.values() ?? [])].flatMap(run => [...run.items.values()]);
      for (const item of items.sort((a, b) => a.ts - b.ts)) {
        const index = history.findIndex(message => message.pending || (message.ts !== undefined && message.ts > item.ts));
        history.splice(index < 0 ? history.length : index, 0, project(item));
      }
      return history;
    },
    forget(sessionKey: string): void {
      // Clear/reset retires visible items, but delayed frames from those runs
      // must not resurrect them in the freshly cleared conversation.
      for (const run of sessions.get(sessionKey)?.values() ?? []) {
        run.closed = true;
        run.items.clear();
      }
    },
  };
}
