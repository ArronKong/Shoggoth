// Turn Lab 真实回放(demo-only)—— 直连 /__chatws 的迷你 WS-RPC 客户端 +
// chat.history → TurnEvent[] 适配器。
//
// 历史是「降级数据」:没有 phase/时序/配对 id(工具调用与结果只能按出现顺序 FIFO
// 配对),Hermes 历史连 isError 都不落;所以回放只还原顺序,不还原耗时(页面用
// deriveDurations:false 建时间线,耗时一律「—」)。
// vite dev 通过严格同源的 WS proxy 接入 /__chatws；后端未启动时页面显示不可用提示。

import type { TurnEvent } from "../../lib/turnTimeline";

export interface ReplaySessionRow {
  key: string;
  label: string;
  updatedAt?: number;
}
export interface ReplayTurn {
  label: string;
  events: TurnEvent[];
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ChatWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private reqId = 1;

  // 帧协议与 ChatPage 同款:{type:"req",id,method,params} ↔ {type:"res",id,ok,error,payload}。
  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}://${location.host}/__chatws`);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(new Error("connect timeout"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("connect failed"));
      };
      ws.onclose = () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("socket closed"));
        }
        this.pending.clear();
        this.ws = null;
      };
      ws.onmessage = (evt) => {
        let f: any;
        try {
          f = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        if (f?.type === "res" && f.id != null) {
          const p = this.pending.get(String(f.id));
          if (!p) return;
          this.pending.delete(String(f.id));
          clearTimeout(p.timer);
          if (f.ok === false) p.reject(new Error(f.error?.message || "request failed"));
          else p.resolve(f);
        }
      };
    });
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("not connected"));
      const id = String(this.reqId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}

// sessions.list 分页拉全(照抄 ChatPage fetchAllSessions 的兼容语义:老网关没有
// 分页参数会整帧拒绝 → 退化为无参单页;跨页可能重发同 key 行 → Map 去重)。
export async function listReplaySessions(client: ChatWsClient): Promise<ReplaySessionRow[]> {
  const byKey = new Map<string, ReplaySessionRow>();
  let offset = 0;
  let paged = true;
  for (let i = 0; i < 30; i += 1) {
    let res;
    try {
      res = await client.request("sessions.list", paged ? { limit: 200, offset } : {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (paged && /unexpected property/i.test(msg)) {
        paged = false;
        continue;
      }
      throw e;
    }
    const p = res?.payload || {};
    const rows: any[] = p.sessions || p.rows || [];
    for (const r of rows) {
      if (!r?.key) continue;
      byKey.set(String(r.key), {
        key: String(r.key),
        label: String(r.label || r.title || r.displayName || r.key),
        updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : undefined,
      });
    }
    if (!paged) break;
    const nextOffset = typeof p.nextOffset === "number" ? p.nextOffset : offset + rows.length;
    if (!p.hasMore || rows.length === 0 || nextOffset <= offset) break;
    offset = nextOffset;
  }
  return [...byKey.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// ---- chat.history 原始记录 → 分回合事件流 -----------------------------------

// DEMO-ONLY:ChatPage.tsx normalize()/contentToText(:561-642)的裁剪拷贝,只保留
// 回放需要的字段。抽成共享库是「并入聊天页」阶段的第一步,届时删除本拷贝。
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const cc = c as { text?: string; thinking?: string };
        return cc?.text ?? cc?.thinking ?? "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const cc = content as { text?: string };
    if (typeof cc.text === "string") return cc.text;
  }
  return "";
}

interface LitePart {
  type: "text" | "thinking" | "toolCall" | "toolResult";
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  isError?: boolean;
}
interface LiteMsg {
  role: "user" | "assistant" | "toolResult" | "system";
  parts: LitePart[];
  isError: boolean;
  errorMessage?: string;
}

function normalizeLite(raw: any): LiteMsg {
  const role = raw?.role === "assistant" || raw?.role === "toolResult" || raw?.role === "system" ? raw.role : "user";
  const msg: LiteMsg = { role, parts: [], isError: raw?.isError === true, errorMessage: raw?.errorMessage };
  if (role === "toolResult") {
    msg.parts = [{ type: "toolResult", text: contentToText(raw?.content), toolName: raw?.toolName, isError: raw?.isError === true }];
    return msg;
  }
  if (role === "user" || role === "system") {
    msg.parts = [{ type: "text", text: contentToText(raw?.content) }];
    return msg;
  }
  const content = raw?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const cc = c as { type?: string; text?: string; thinking?: string; toolName?: string; name?: string; arguments?: unknown; args?: unknown; input?: unknown };
      if (cc?.type === "thinking") msg.parts.push({ type: "thinking", text: cc.thinking ?? "" });
      else if (cc?.type === "toolCall") msg.parts.push({ type: "toolCall", toolName: cc.toolName ?? cc.name ?? "tool", toolArgs: cc.arguments ?? cc.args ?? cc.input });
      else if (typeof cc?.text === "string") msg.parts.push({ type: "text", text: cc.text });
    }
  } else if (typeof content === "string") {
    msg.parts.push({ type: "text", text: content });
  }
  if (!msg.parts.some((p) => p.type === "toolCall" || !!p.text?.trim()) && raw?.errorMessage) {
    msg.parts = [{ type: "text", text: raw.errorMessage }];
    msg.isError = true;
  }
  return msg;
}

export async function fetchReplayTurns(client: ChatWsClient, sessionKey: string): Promise<ReplayTurn[]> {
  const res = await client.request("chat.history", { sessionKey, limit: 1000 });
  const messages: any[] = res?.payload?.messages || [];
  const turns: ReplayTurn[] = [];
  let cur: ReplayTurn | null = null;
  // FIFO 待配对的工具调用(历史里配对 id 已丢,只能按顺序对):
  let openToolIds: string[] = [];
  let toolSeq = 0;
  // 每回合的文本段先全记成 interim,收尾时把最后一段升格成 final。
  let interimIdxs: number[] = [];
  let lastErrored = false;

  const finishTurn = () => {
    const turn = cur;
    if (!turn) return;
    if (interimIdxs.length) {
      const lastIdx = interimIdxs[interimIdxs.length - 1];
      const last = turn.events[lastIdx];
      if (last.kind === "interim") turn.events[lastIdx] = { kind: "final", text: last.text, errored: lastErrored };
    } else if (turn.events.length > 1) {
      turn.events.push({ kind: "final", text: "", errored: lastErrored });
    }
    if (turn.events.length > 1) turns.push(turn);
    cur = null;
    openToolIds = [];
    interimIdxs = [];
    lastErrored = false;
  };

  for (const raw of messages) {
    const m = normalizeLite(raw);
    if (m.role === "system") continue;
    if (m.role === "user") {
      finishTurn();
      const text = m.parts[0]?.text ?? "";
      cur = { label: text.replace(/\s+/g, " ").trim().slice(0, 60) || "(empty)", events: [{ kind: "user", text }] };
      continue;
    }
    const turn = cur;
    if (!turn) continue; // 首个 user 之前的杂项(心跳/占位)不回放
    if (m.role === "toolResult") {
      const id = openToolIds.shift() ?? `h${toolSeq++}`;
      turn.events.push({ kind: "tool", toolCallId: id, name: m.parts[0]?.toolName, phase: "result", result: m.parts[0]?.text, isError: m.parts[0]?.isError });
      continue;
    }
    // assistant:按 parts 顺序转事件
    for (const p of m.parts) {
      if (p.type === "thinking") {
        if (p.text?.trim()) turn.events.push({ kind: "thinking", text: p.text });
      } else if (p.type === "toolCall") {
        const id = `h${toolSeq++}`;
        openToolIds.push(id);
        turn.events.push({ kind: "tool", toolCallId: id, name: p.toolName, phase: "start", args: p.toolArgs });
      } else if (p.type === "text" && p.text?.trim()) {
        interimIdxs.push(turn.events.length);
        turn.events.push({ kind: "interim", text: p.text });
        lastErrored = m.isError;
      }
    }
    if (m.isError) lastErrored = true;
  }
  finishTurn();
  return turns.reverse(); // 最新回合排最前,便于挑最近的看
}
