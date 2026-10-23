import { sessionKindOf } from "./sessionKind";
import { createTimeline, reduceTimeline, stepsFromParts, mergeToolArgs, type TimelinePartLike, type TurnStep, type TurnTimelineState } from "./turnTimeline";
import { createOpenClawPreambles, type OpenClawPreambleMessage } from "./openclawPreambles";

type Row = { key: string; kind?: string; backendId?: string; spawnedBy?: string; parentSessionKey?: string;
  label?: string; status?: string; lastRunId?: string; lastRunError?: string; updatedAt?: number };
type Message = OpenClawPreambleMessage & { role: string; parts: TimelinePartLike[]; activityRunId?: string; nativeRunId?: string;
  ts?: number; stopReason?: string; errorMessage?: string };
export type SubagentProgress = { key: string; label: string; status: string; steps: TurnStep[];
  error?: string; unavailable?: boolean; truncated?: boolean };
type Child = { key: string; parent: string; callId?: string; parentRunId?: string; runId?: string;
  label: string; status: string; error?: string; statusAt: number; history: Message[];
  preambles: ReturnType<typeof createOpenClawPreambles<Message>>;
  live: TurnTimelineState; unavailable?: boolean; truncated?: boolean; loaded: boolean };
const terminal = (status: string) => ["done", "failed", "timeout", "killed", "interrupted"].includes(status);
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const childKey = (key: string, kind?: string) => sessionKindOf(key, kind) === "subagent";
function resultObject(value: unknown, depth = 0): Record<string, any> | null {
  if (depth > 4 || (typeof value === "string" && value.length > 65536)) return null;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, any>;
  // Gateway tool results may wrap their structured result in text content.
  if (!record.childSessionKey && Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        const nested = resultObject(part.text, depth + 1);
        if (nested?.childSessionKey) return nested;
      }
    }
  }
  return record;
}

/** Read-only, connection-scoped projection. Never starts, stops or replays a task. */
export function createSubagentActivity(options: {
  request: (method: string, params: Record<string, unknown>) => Promise<any>;
  normalize: (raw: unknown) => Message;
  changed: () => void;
}) {
  const children = new Map<string, Child>();
  const subscriptions = new Map<string, string>();
  const fetching = new Map<string, Promise<void>>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let rows = new Map<string, Row>();
  let active = "", connected = false, supportsSubscriptions = false, epoch = 0, serial = 0;
  const desired = () => {
    const keys = new Set<string>(active ? [active] : []);
    // Bound traversal and reject cycles; only descendants of the selected conversation are read.
    for (let depth = 0; depth < 6 && keys.size < 65; depth++) {
      let added = false;
      for (const c of children.values()) if (c.callId && keys.has(c.parent) && !keys.has(c.key) && keys.size < 65) {
        keys.add(c.key); added = true;
      }
      if (!added) break;
    }
    return keys;
  };
  const add = (key: string, parent: string): Child | undefined => {
    if (!childKey(key, rows.get(key)?.kind) || key === parent || !parent) return;
    const a = rows.get(key)?.backendId, b = rows.get(parent)?.backendId;
    if (a && b && a !== b) return;
    const existing = children.get(key);
    if (existing) return existing.parent === parent ? existing : undefined;
    let ancestor: string | undefined = parent;
    for (let depth = 0; ancestor && depth < 8; depth++) {
      if (ancestor === key) return;
      ancestor = children.get(ancestor)?.parent;
    }
    if (ancestor) return;
    if (children.size >= 256) {
      const wanted = desired();
      const oldest = [...children.keys()].find(old => !wanted.has(old));
      if (oldest) children.delete(oldest);
      else return;
    }
    const c: Child = { key, parent, label: "", status: "pending", statusAt: 0, history: [], live: createTimeline(), loaded: false,
      preambles: createOpenClawPreambles<Message>(item => ({ role: "assistant", activityRunId: item.runId,
        openclawPreambleKey: item.key, openclawLivePreamble: true, ts: item.ts, parts: [{ type: "text", text: item.text }] })) };
    children.set(key, c);
    return c;
  };
  const learn = (parent: string, callId: string | undefined, name: string | undefined, result: unknown,
    args: any, parentRunId?: string) => {
    if (name !== "sessions_spawn" || !callId) return;
    const receipt = resultObject(result);
    const key = string(receipt?.childSessionKey);
    if (!key || receipt?.status !== "accepted") return;
    const c = add(key, parent);
    if (!c) return;
    // A reused child session must not attach its newer run to an older spawn receipt.
    if (c.callId && (c.callId !== callId || c.parentRunId !== parentRunId)) return;
    c.callId = callId; c.parentRunId = parentRunId;
    if (!c.runId && string(receipt?.runId)) {
      c.runId = receipt!.runId; c.history = []; c.loaded = false;
    }
    c.label ||= string(args?.label) || string(rows.get(key)?.label) || "";
  };
  const observeHistory = (key: string, messages: Message[]) => {
    const calls = new Map<string, { name?: string; args?: unknown }>();
    for (const m of messages) for (const p of m.parts) {
      if (!p.toolCallId) continue;
      if (p.type === "toolCall") calls.set(p.toolCallId, { name: p.toolName, args: p.toolArgs });
      if (p.type === "toolResult") {
        const call = calls.get(p.toolCallId);
        learn(key, p.toolCallId, p.toolName || call?.name, p.text, call?.args, m.activityRunId || m.nativeRunId);
      }
    }
    reconcile();
  };
  const fetchHistory = (key: string) => {
    if (!connected || !desired().has(key) || !children.has(key)) return Promise.resolve();
    const previous = fetching.get(key);
    if (previous) return previous;
    const generation = epoch, child = children.get(key)!;
    const pending = options.request("chat.history", { sessionKey: key, page: true, limit: 100 }).then(response => {
      if (generation !== epoch || !desired().has(key) || children.get(key) !== child) return;
      const payload = response?.payload;
      if (!Array.isArray(payload?.messages)) throw new Error("invalid child history");
      const messages: Message[] = payload.messages.slice(-1000).map(options.normalize);
      observeHistory(key, messages);
      const matching = messages.filter(m => m.role !== "user" && (!child.runId || !m.activityRunId || m.activityRunId === child.runId));
      child.history = matching;
      child.loaded = true; child.unavailable = false;
      child.truncated = payload.hasMore === true || payload.messages.length > 1000;
      options.changed();
    }).catch(() => {
      if (generation === epoch && desired().has(key) && children.get(key) === child) {
        child.unavailable = true; options.changed();
      }
    }).finally(() => { if (fetching.get(key) === pending) fetching.delete(key); });
    fetching.set(key, pending);
    return pending;
  };
  const refresh = (key: string) => {
    if (!desired().has(key) || refreshTimers.has(key)) return;
    const generation = epoch;
    refreshTimers.set(key, setTimeout(() => {
      refreshTimers.delete(key);
      if (generation === epoch) void (fetching.get(key) || Promise.resolve()).then(() => fetchHistory(key));
    }, 200));
  };
  function reconcile() {
    if (!connected) return;
    const wanted = desired();
    for (const [key, subscriptionId] of subscriptions) if (!wanted.has(key)) {
      subscriptions.delete(key);
      void options.request("sessions.messages.unsubscribe", { key, subscriptionId }).catch(() => {});
    }
    for (const key of wanted) {
      if (supportsSubscriptions && !subscriptions.has(key)) {
        const subscriptionId = `shoggoth-activity-${epoch}-${++serial}`;
        subscriptions.set(key, subscriptionId);
        const generation = epoch;
        void options.request("sessions.messages.subscribe", { key, subscriptionId }).then(() => {
          if (generation === epoch && subscriptions.get(key) === subscriptionId && children.has(key)) return fetchHistory(key);
        }).catch(() => {
          if (generation === epoch && subscriptions.get(key) === subscriptionId) {
            subscriptions.delete(key);
            return fetchHistory(key);
          }
        });
      } else if (children.has(key) && !children.get(key)!.loaded) void fetchHistory(key);
    }
  }
  const snapshot = (c: Child, depth: number): SubagentProgress => {
    const history = c.preambles.merge(c.key, c.history);
    const steps = stepsFromParts(history.flatMap(message => message.parts), { live: !terminal(c.status), includeText: true })
      .map(step => ({ ...step, id: `${c.key}:${step.id}` }));
    for (const raw of c.live.steps.filter(step => step.kind !== "user")) {
      const step = raw.kind === "final" ? { ...raw, kind: "text" as const } : raw;
      const index = step.toolCallId ? steps.findIndex(old => old.toolCallId === step.toolCallId) : -1;
      const current = { ...step, id: `${c.key}:${step.id}` };
      // A canonical terminal result outranks an earlier live partial result.
      if (index >= 0) {
        const old = steps[index];
        if (old.status === "running" || old.status === "aborted" || current.endTs !== undefined) steps[index] = {
          ...old, ...current, args: mergeToolArgs(old.args, current.args),
          ...(current.toolName === "tool" ? { toolName: old.toolName, canonicalName: old.canonicalName, category: old.category } : {}),
        };
      } else if (!(step.kind === "text" && steps.some(old => old.kind === "text" && old.text === step.text))) steps.push(current);
    }
    const settled = terminal(c.status) ? steps.map(step => step.status === "running" ? { ...step, status: "aborted" as const } : step) : steps;
    return { key: c.key, label: c.label, status: c.status, error: c.error,
      unavailable: c.unavailable, truncated: c.truncated,
      steps: depth < 6 ? project(c.key, settled, c.runId, depth + 1) : settled };
  };
  function project(parent: string, steps: TurnStep[], runId?: string, depth = 0): TurnStep[] {
    return steps.map(step => {
      const child = step.kind === "tool" && step.toolCallId && [...children.values()].find(c => c.callId && c.parent === parent && c.callId === step.toolCallId
        && (!c.parentRunId || !runId || c.parentRunId === runId));
      return child ? { ...step, subagent: snapshot(child, depth) } : step;
    });
  }
  const liveCalls = new Map<string, { name?: string; args?: unknown }>();
  return {
    observeHistory,
    project,
    relatedKeys(parent: string): string[] {
      const keys = new Set([parent]);
      for (let depth = 0; depth < 6 && keys.size < 65; depth++) {
        const before = keys.size;
        for (const c of children.values()) if (keys.has(c.parent) && keys.size < 65) keys.add(c.key);
        if (before === keys.size) break;
      }
      return [...keys];
    },
    watch(key: string) {
      if (active === key) return;
      active = key;
      // Returning to a conversation refreshes its children; no continuous polling.
      for (const child of children.values()) child.loaded = false;
      reconcile();
    },
    connect(methods: string[] | null) {
      if (connected) for (const [key, subscriptionId] of subscriptions) {
        void options.request("sessions.messages.unsubscribe", { key, subscriptionId }).catch(() => {});
      }
      epoch++; subscriptions.clear(); fetching.clear();
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
      connected = methods !== null;
      supportsSubscriptions = !!methods?.includes("sessions.messages.subscribe") && methods.includes("sessions.messages.unsubscribe");
      for (const child of children.values()) { child.loaded = false; child.live = createTimeline(); }
      reconcile();
    },
    sessions(next: Row[]) {
      rows = new Map(next.map(row => [row.key, row]));
      for (const row of next) {
        const parent = string(row.spawnedBy) || string(row.parentSessionKey);
        if (!parent) continue;
        const c = add(row.key, parent);
        if (!c) continue;
        c.label = string(row.label) || c.label;
        if (c.runId && row.lastRunId && c.runId !== row.lastRunId) continue;
        if (row.status && !(terminal(c.status) && row.status === "running") && (row.updatedAt || 0) >= c.statusAt) {
          c.status = row.status; c.error = row.lastRunError; c.statusAt = row.updatedAt || 0;
        }
      }
      reconcile(); options.changed();
    },
    event(name: string, payload: any): boolean {
      const key = string(payload?.sessionKey);
      if (!key) return false;
      const data = payload.data || payload;
      const runId = string(payload.runId);
      const isTool = name === "session.tool" || (name === "agent" && payload.stream === "tool");
      if (isTool) {
        const id = string(data.toolCallId) || string(data.id);
        if (id) {
          const identity = `${key}:${runId || ""}:${id}`;
          const old = liveCalls.get(identity);
          liveCalls.set(identity, { name: data.name || old?.name, args: data.args ?? old?.args });
          if (data.phase === "result") {
            learn(key, id, data.name || old?.name, data.result, data.args ?? old?.args, runId);
            liveCalls.delete(identity);
          }
          if (liveCalls.size > 2048) liveCalls.delete(liveCalls.keys().next().value!);
        }
      }
      if (name === "session.message" && payload.message) observeHistory(key, [options.normalize(payload.message)]);
      reconcile();
      const c = children.get(key);
      if (!c) return childKey(key);
      if (!desired().has(key) || (runId && c.runId && runId !== c.runId)) return true;
      c.runId ||= runId;
      const at = typeof data.endedAt === "number" ? data.endedAt : typeof payload.ts === "number" ? payload.ts : Date.now();
      if (name === "agent" && payload.stream === "item" && !terminal(c.status) && c.preambles.ingest(payload)) c.status = "running";
      if (isTool && string(data.toolCallId || data.id)) {
        if (terminal(c.status) && data.phase !== "result") return true;
        c.live = reduceTimeline(c.live, { ...data, kind: "tool", toolCallId: data.toolCallId || data.id }, at);
        if (!terminal(c.status)) c.status = "running";
      }
      if (name === "chat") {
        if (payload.state === "delta" && !terminal(c.status)) {
          const message = options.normalize(payload.message);
          c.live = reduceTimeline(c.live, { kind: "delta", text: message.parts.filter(p => p.type === "text").map(p => p.text || "").join("") }, at);
        }
        if (["final", "error", "aborted"].includes(payload.state)) {
          // A final chat segment can yield to a nested task. Only lifecycle or
          // the durable session row establishes successful task completion.
          if (payload.state === "final" && payload.message) {
            const message = options.normalize(payload.message);
            const text = message.parts.filter(p => p.type === "text").map(p => p.text || "").join("");
            if (text) c.live = reduceTimeline(c.live, { kind: "interim", text }, at);
          } else if (payload.state !== "final" && at >= c.statusAt) {
            c.status = payload.status === "timed_out" || payload.timeoutPhase ? "timeout" : payload.state === "error" ? "failed" : "killed";
            c.error = string(payload.errorMessage); c.statusAt = at;
          }
          refresh(key);
        }
      }
      if (name === "agent" && payload.stream === "lifecycle") {
        if (data.phase === "start" && !terminal(c.status)) c.status = "running";
        else if (["end", "error"].includes(data.phase) && at >= c.statusAt && !(data.yielded === true && data.livenessState === "paused")) {
          c.status = data.status === "timed_out" || data.timeoutPhase ? "timeout"
            : data.phase === "error" || data.error ? "failed"
            : data.aborted || data.status === "cancelled" ? "killed" : "done";
          c.error = string(data.error); c.statusAt = at; refresh(key);
        }
      }
      if (name === "session.message") refresh(key);
      if (terminal(c.status)) c.preambles.finish(key, c.runId);
      options.changed();
      return true;
    },
  };
}
