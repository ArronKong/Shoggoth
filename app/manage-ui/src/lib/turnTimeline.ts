// turnTimeline —— 「一次 agent 回合」的过程时间线核心(纯函数,零 React/DOM 依赖)。
//
// 输入是与 core/agent-backend.js sendMessage() 钩子契约 1:1 同形的事件流
// (TurnEvent),外加两个仅客户端合成的事件(user / promptAnswer);输出是
// append-only 的 TurnStep[]。将来并入 ChatPage 时,把它现有 WS 处理里的字段
// 原样喂进 reduceTimeline 即可,本模块无需改动。
//
// 与 ChatPage 既有语义对齐的点(改这里前先看那边):
// - 工具事件合并规则照抄 ChatPage.tsx:2406-2429(name 可覆盖 / args 只写一次 /
//   durationS>0 才采 / isError 含 "status":"error" 正则兜底)。
// - thinking/delta 在线上是「全量累积」文本(见根 CLAUDE.md 雷区);本模块靠
//   已封存前缀切片,把累积流还原成真实交错的分段。
// - 输出截断与 ChatPage formatToolOutput 同为 4000 字。

export type TurnEvent =
  | { kind: "user"; text: string } // 合成:开启本回合的用户消息
  | { kind: "delta"; text: string } // 全量累积的回答文本
  | { kind: "interim"; text: string } // 把当前回答段封存为独立分段
  | { kind: "thinking"; text: string } // 全量累积的思考文本
  | {
      kind: "tool";
      toolCallId: string;
      name?: string;
      args?: unknown;
      phase: "start" | "update" | "result";
      result?: unknown;
      partialResult?: unknown; // OpenClaw update 相的流式输出
      isError?: boolean;
      durationS?: number; // Hermes tool.complete 的耗时
      diff?: { path: string; oldText: string; newText: string };
      diffText?: string; // Hermes inline_diff(unified diff 文本)
    }
  | { kind: "plan"; entries: { content: string; status?: string }[] }
  | { kind: "status"; status: { kind: string; text?: string } } // compacting | compacted
  | {
      kind: "prompt";
      prompt: { kind: string; requestId?: string; question?: string; command?: string; description?: string; choices?: string[] };
    }
  | { kind: "promptExpire"; requestId?: string }
  | { kind: "promptAnswer"; requestId?: string; choice?: string } // 合成:用户已应答
  | { kind: "error"; message: string }
  | { kind: "aborted"; message?: string } // OpenClaw chat state:"aborted"(用户停止/超时);message = 线上 errorMessage
  | { kind: "toolTiming"; toolCallId: string; startedAt?: number; endedAt?: number; failed?: boolean; error?: string } // OpenClaw stream:"item"(kind:"tool") 的服务端毫秒起止
  | {
      kind: "final";
      text: string;
      errored?: boolean;
      meta?: { usage?: { input?: number; output?: number; contextUsed?: number; contextMax?: number; contextPercent?: number }; model?: string };
    };

export type StepKind = "user" | "thinking" | "tool" | "text" | "plan" | "prompt" | "status" | "error" | "final";
export type StepStatus = "running" | "ok" | "error" | "pending" | "aborted";
export type ToolCategory = "gather" | "read" | "execute" | "message" | "workboard" | "other";

export interface TurnStep {
  id: string;
  kind: StepKind;
  status: StepStatus;
  startTs: number; // 该步首个事件的客户端时钟(剧本里是虚拟时钟)
  endTs?: number;
  durationS?: number; // 优先后端 durationS;否则(允许派生时)按 ts 差算;缺省显示「—」
  // tool 步
  toolName?: string; // 线上原始名(mcp__* 原样保留)
  canonicalName?: string; // 别名归并后的规范名(exec≡bash≡sandbox_exec≡node_exec)
  category?: ToolCategory;
  args?: unknown; // 只写一次(对齐 ChatPage:2420)
  output?: string; // capText 处理后的最新 partial/最终结果
  outputTruncated?: boolean;
  isError?: boolean;
  diff?: { path: string; oldText: string; newText: string };
  diffText?: string;
  updateCount?: number;
  // 文本类步(user / thinking 段 / text 段 / final / error)
  text?: string;
  // plan / prompt / status / final 元数据
  planEntries?: { content: string; status?: string }[];
  planVersion?: number;
  prompt?: { kind: string; requestId?: string; question?: string; command?: string; description?: string; choices?: string[] };
  promptOutcome?: "answered" | "expired";
  promptChoice?: string;
  statusKind?: string;
  model?: string;
  usage?: { input?: number; output?: number; contextUsed?: number; contextMax?: number; contextPercent?: number };
}

export interface TurnTimelineState {
  steps: TurnStep[];
  status: "idle" | "running" | "done" | "error";
  deriveDurations: boolean; // 历史回放没有时序 → false,工具耗时不按到达时刻派生
  thinkingSealed: string; // 已封存的思考前缀(全量累积流的切片基准)
  answerSealed: string; // 已封存的回答前缀(同上;interim/工具打断都会推进)
  nextId: number;
}

export function createTimeline(opts?: { deriveDurations?: boolean }): TurnTimelineState {
  return { steps: [], status: "idle", deriveDurations: opts?.deriveDurations !== false, thinkingSealed: "", answerSealed: "", nextId: 1 };
}

// ---- 工具名归并与分类 -------------------------------------------------------

// 同一能力在不同 harness/沙箱下换名出现(exec 会以 bash/sandbox_exec/node_exec
// 名义到达);重试/换工具判定与图标着色都要先归并。
const TOOL_ALIASES: Record<string, string> = {
  bash: "exec",
  command: "exec",
  commandexecution: "exec",
  sandbox_exec: "exec",
  node_exec: "exec",
  sandbox_process: "process",
  node_process: "process",
  filechange: "file_change",
  websearch: "web_search",
  "web search": "web_search",
  "web search:": "web_search",
  search_web: "web_search",
  run_terminal_command: "exec",
  run_command: "exec",
  terminal_command: "exec",
  search_replace: "edit",
  imageview: "image_view",
  imagegeneration: "image_generate",
  mcptoolcall: "mcp",
  dynamictoolcall: "dynamic_tool",
  collabagenttoolcall: "collab",
};

export function canonicalToolName(name: string): string {
  const n = name.toLowerCase();
  return TOOL_ALIASES[n] ?? n;
}

const CAT_EXACT: Record<string, ToolCategory> = {
  web_search: "gather",
  web_fetch: "gather",
  web_extract: "gather",
  x_search: "gather",
  read: "read",
  read_file: "read",
  image_view: "read",
  sessions_history: "read",
  search_files: "read",
  grep: "read",
  find: "read",
  ls: "read",
  exec: "execute",
  terminal: "execute",
  process: "execute",
  write: "execute",
  edit: "execute",
  patch: "execute",
  apply_patch: "execute",
  write_file: "execute",
  file_change: "execute",
  image_generate: "execute",
  message: "message",
  sessions_send: "message",
};
const CAT_PREFIX: Array<[string, ToolCategory]> = [
  ["browser", "gather"],
  ["memory_", "read"],
  ["wiki_", "read"],
  ["discord", "message"],
  ["telegram", "message"],
  ["slack", "message"],
  // Figma 稿把 OpenClaw workboard 与 Hermes kanban 归成同一类看板图标(node 7167:630)。
  ["workboard", "workboard"],
  ["kanban", "workboard"],
];

export function categorizeTool(name: string): ToolCategory {
  const n = canonicalToolName(name);
  const leaf = canonicalToolName(n.includes("/") ? n.split("/").at(-1)! : n);
  const exact = CAT_EXACT[n] ?? CAT_EXACT[leaf];
  if (exact) return exact;
  for (const [prefix, cat] of CAT_PREFIX) {
    if (n.startsWith(prefix) || leaf.startsWith(prefix)) return cat;
  }
  return "other";
}

// 工具显示名的 i18n 键(R340):别名先归并(exec≡bash≡sandbox_exec…),再把家族
// 工具折到族键（kanban_show→kanban 等）。组件用
// `t(toolLabelKey(name), { defaultValue: "" }) || name` 取显示名——zh 映射成中文,
// en 的映射值就是原标识符；未知 server/tool 名称归为 MCP，其他未收录项回退原名。
const LABEL_FAMILY: Array<[string, string]> = [
  ["browser", "browser"],
  ["cron_", "cron"],
  ["kanban_", "kanban"],
  ["workboard", "workboard"],
  ["memory_", "memory"],
  ["skill_", "skills"],
  ["computer_", "computer_use"],
  ["system_", "system"],
  ["notification_", "notification"],
  ["runtime_", "runtime"],
  ["agent_", "agent"],
  ["collab/", "collab"],
  ["wiki_", "wiki"],
  ["sessions_", "sessions"],
];

export function toolLabelKey(name: string): string {
  const n = canonicalToolName(name);
  const leaf = canonicalToolName(n.includes("/") ? n.split("/").at(-1)! : n);
  for (const [prefix, family] of LABEL_FAMILY) {
    if (n.startsWith(prefix) || leaf.startsWith(prefix)) return `turnLab.tools.${family}`;
  }
  if (n.startsWith("mcp__")) return "turnLab.tools.mcp";
  if (n.includes("/")) return "turnLab.tools.mcp";
  return `turnLab.tools.${leaf.replace(/[^a-z0-9_]/g, "_")}`;
}

// ---- 文本工具 ---------------------------------------------------------------

const OUTPUT_CAP = 4000; // 与 ChatPage formatToolOutput 同上限

export function capText(v: unknown): { text: string; truncated: boolean } {
  if (v == null) return { text: "", truncated: false };
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v, null, 2);
    } catch {
      s = String(v);
    }
  }
  if (s.length > OUTPUT_CAP) return { text: s.slice(0, OUTPUT_CAP), truncated: true };
  return { text: s, truncated: false };
}

// 与 ChatPage formatToolTitle 同一套「人话标题」规则(web_search/web_fetch 特判 +
// 主参数扫描),让演示页与聊天页说同一种语言。
const PRIMARY_ARG_KEYS = ["command", "path", "file_path", "filePath", "url", "query", "pattern", "name", "message", "title", "summary"];

function compactPath(value: string): string {
  const managed = /\/shoggoth-core\/workspaces\/[^/]+\/(.+)$/u.exec(value);
  return managed?.[1] || value;
}

function unwrapShellCommand(value: string): string {
  const match = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/u.exec(value.trim());
  if (!match) return value;
  const body = match[1].trim();
  if (body.startsWith('"') && body.endsWith('"')) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === "string") return parsed;
    } catch {}
  }
  if (body.startsWith("'") && body.endsWith("'")) {
    return body.slice(1, -1).replace(/'\\''/gu, "'");
  }
  return body;
}

function primaryArgText(key: string, value: string): string {
  const one = value.replace(/\s+/g, " ").trim();
  if (key === "command") return unwrapShellCommand(one);
  if (["path", "file_path", "filePath"].includes(key)) return compactPath(one);
  return one;
}

export function summarizeArgs(name?: string, args?: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, any>) : null;
  if (!a) return "";
  if (canonicalToolName(name ?? "") === "web_search" && typeof a.query === "string") {
    const n = a.count ?? a.top_n ?? a.topN;
    return n != null ? `for "${a.query}" (top ${n})` : `for "${a.query}"`;
  }
  if (canonicalToolName(name ?? "") === "web_fetch" && typeof a.url === "string") {
    const max = a.max_chars ?? a.maxChars ?? a.max_length ?? a.maxLength;
    return max != null ? `from ${a.url} (max ${max} chars)` : `from ${a.url}`;
  }
  for (const k of PRIMARY_ARG_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) {
      const one = primaryArgText(k, v);
      return one.length > 90 ? one.slice(0, 90) + "…" : one;
    }
  }
  return "";
}

// 与 ChatPage 工具卡耗时 chip 同规则:≥10s 取整,否则一位小数。
export function formatDuration(s?: number): string {
  if (typeof s !== "number" || !(s > 0)) return "—";
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

// ---- reducer ---------------------------------------------------------------

function replaceStep(steps: TurnStep[], idx: number, patch: Partial<TurnStep>): TurnStep[] {
  const next = steps.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

function lastIndexWhere(steps: TurnStep[], pred: (s: TurnStep) => boolean): number {
  for (let i = steps.length - 1; i >= 0; i--) if (pred(steps[i])) return i;
  return -1;
}

// 全量累积流 → 当前分段文本。累积被上游重置时(Hermes interim 后从空重来)退回全量。
function sliceAccumulated(full: string, sealed: string): { segment: string; sealed: string } {
  if (sealed && full.startsWith(sealed)) return { segment: full.slice(sealed.length), sealed };
  return { segment: full, sealed: "" };
}

export function reduceTimeline(state: TurnTimelineState, ev: TurnEvent, ts: number): TurnTimelineState {
  // 运行生命周期不属于过程步骤，也不能打断思考/回答分段或提前结束上下文压缩。
  if (ev.kind === "status" && ev.status.kind !== "compacting" && ev.status.kind !== "compacted") return state;

  let { steps, status, thinkingSealed, answerSealed, nextId } = state;
  const { deriveDurations } = state;
  if (status === "idle") status = "running";

  const takeId = () => `s${nextId++}`;

  // 1) 先封存被打断的进行中分段(思考段 / 回答段),还原真实交错。
  if (ev.kind !== "thinking") {
    const i = lastIndexWhere(steps, (s) => s.kind === "thinking" && s.status === "running");
    if (i >= 0) {
      thinkingSealed = thinkingSealed + (steps[i].text ?? "");
      steps = replaceStep(steps, i, { status: "ok", endTs: ts });
    }
  }
  if (ev.kind !== "delta" && ev.kind !== "final" && ev.kind !== "thinking") {
    const i = lastIndexWhere(steps, (s) => s.kind === "final" && s.status === "running");
    if (i >= 0) {
      answerSealed = answerSealed + (steps[i].text ?? "");
      steps = replaceStep(steps, i, { kind: "text", status: "ok", endTs: ts });
    }
  }

  switch (ev.kind) {
    case "user": {
      steps = [...steps, { id: takeId(), kind: "user", status: "ok", startTs: ts, endTs: ts, text: ev.text }];
      break;
    }
    case "thinking": {
      const cut = sliceAccumulated(ev.text, thinkingSealed);
      thinkingSealed = cut.sealed;
      const i = lastIndexWhere(steps, (s) => s.kind === "thinking" && s.status === "running");
      if (i >= 0) steps = replaceStep(steps, i, { text: cut.segment });
      else if (cut.segment) steps = [...steps, { id: takeId(), kind: "thinking", status: "running", startTs: ts, text: cut.segment }];
      break;
    }
    case "delta": {
      const cut = sliceAccumulated(ev.text, answerSealed);
      answerSealed = cut.sealed;
      const i = lastIndexWhere(steps, (s) => s.kind === "final" && s.status === "running");
      if (i >= 0) {
        // 乱序/迟到的更短全量帧直接丢弃(startsWith 守卫的另一半)。
        const cur = steps[i].text ?? "";
        if (!(cut.segment.length < cur.length && cur.startsWith(cut.segment))) steps = replaceStep(steps, i, { text: cut.segment });
      } else if (cut.segment) {
        steps = [...steps, { id: takeId(), kind: "final", status: "running", startTs: ts, text: cut.segment }];
      }
      break;
    }
    case "interim": {
      // interim 携带的就是本段权威文本;上游随后把累积清零重来。
      const i = lastIndexWhere(steps, (s) => s.kind === "final" && s.status === "running");
      if (i >= 0) steps = replaceStep(steps, i, { kind: "text", status: "ok", endTs: ts, text: ev.text });
      else if (ev.text) steps = [...steps, { id: takeId(), kind: "text", status: "ok", startTs: ts, endTs: ts, text: ev.text }];
      answerSealed = "";
      break;
    }
    case "tool": {
      const id = `tool:${ev.toolCallId}`;
      let i = steps.findIndex((s) => s.id === id);
      if (i < 0) {
        const name = ev.name && ev.name.trim() ? ev.name : "tool";
        steps = [
          ...steps,
          {
            id,
            kind: "tool",
            status: "running",
            startTs: ts,
            toolName: name,
            canonicalName: canonicalToolName(name),
            category: categorizeTool(name),
          },
        ];
        i = steps.length - 1;
      }
      const cur = steps[i];
      const patch: Partial<TurnStep> = {};
      if (ev.name && ev.name.trim() && ev.name !== cur.toolName) {
        patch.toolName = ev.name;
        patch.canonicalName = canonicalToolName(ev.name);
        patch.category = categorizeTool(ev.name);
      }
      if (cur.args === undefined && ev.args !== undefined) patch.args = ev.args;
      if (cur.diff === undefined && ev.diff) patch.diff = ev.diff;
      if (cur.diffText === undefined && typeof ev.diffText === "string" && ev.diffText) patch.diffText = ev.diffText;
      if (typeof ev.durationS === "number" && ev.durationS > 0) patch.durationS = ev.durationS;
      if (ev.phase === "update") {
        patch.updateCount = (cur.updateCount ?? 0) + 1;
        if (ev.partialResult !== undefined) {
          const capped = capText(ev.partialResult);
          patch.output = capped.text;
          patch.outputTruncated = capped.truncated;
        }
      }
      if (ev.phase === "result") {
        if (ev.result !== undefined) {
          const capped = capText(ev.result);
          patch.output = capped.text;
          patch.outputTruncated = capped.truncated;
        }
        patch.endTs = ts;
        const failed = ev.isError === true || /"status"\s*:\s*"error"/.test((patch.output ?? cur.output) || "");
        patch.isError = failed || cur.isError;
        patch.status = patch.isError ? "error" : "ok";
        const backendS = typeof ev.durationS === "number" && ev.durationS > 0 ? ev.durationS : cur.durationS;
        if (backendS) patch.durationS = backendS;
        else if (deriveDurations && cur.status === "running") patch.durationS = Math.max(0.05, (ts - cur.startTs) / 1000);
      } else if (ev.isError === true) {
        patch.isError = true;
      }
      steps = replaceStep(steps, i, patch);
      break;
    }
    case "plan": {
      const i = steps.findIndex((s) => s.kind === "plan");
      if (i >= 0) steps = replaceStep(steps, i, { planEntries: ev.entries, planVersion: (steps[i].planVersion ?? 1) + 1, endTs: ts });
      else steps = [...steps, { id: takeId(), kind: "plan", status: "ok", startTs: ts, endTs: ts, planEntries: ev.entries, planVersion: 1 }];
      break;
    }
    case "status": {
      const open = lastIndexWhere(steps, (s) => s.kind === "status" && s.status === "running");
      if (ev.status.kind === "compacting" && open < 0) {
        steps = [...steps, { id: takeId(), kind: "status", status: "running", startTs: ts, statusKind: ev.status.kind, text: ev.status.text }];
      } else if (open >= 0) {
        steps = replaceStep(steps, open, { status: "ok", endTs: ts, statusKind: ev.status.kind, text: ev.status.text ?? steps[open].text });
      } else {
        steps = [...steps, { id: takeId(), kind: "status", status: "ok", startTs: ts, endTs: ts, statusKind: ev.status.kind, text: ev.status.text }];
      }
      break;
    }
    case "prompt": {
      steps = [...steps, { id: takeId(), kind: "prompt", status: "pending", startTs: ts, prompt: ev.prompt }];
      break;
    }
    case "toolTiming": {
      // 服务端时钟的精确耗时(OpenClaw item end),优先于客户端到达时刻的估算;
      // Hermes 的 durationS 不走此路径,无冲突。
      const i = steps.findIndex((s) => s.id === `tool:${ev.toolCallId}`);
      if (i >= 0) {
        const patch: Partial<TurnStep> = {};
        if (typeof ev.startedAt === "number" && typeof ev.endedAt === "number" && ev.endedAt > ev.startedAt) {
          patch.durationS = (ev.endedAt - ev.startedAt) / 1000;
        }
        if (ev.failed) {
          patch.isError = true;
          if (steps[i].status === "ok") patch.status = "error";
        }
        if (ev.error && !steps[i].output) {
          const capped = capText(ev.error);
          patch.output = capped.text;
          patch.outputTruncated = capped.truncated;
        }
        steps = replaceStep(steps, i, patch);
      }
      break;
    }
    case "aborted": {
      steps = steps.map((s) => {
        if (s.status === "running") return { ...s, status: s.kind === "tool" ? ("aborted" as const) : ("ok" as const), endTs: s.endTs ?? ts };
        if (s.status === "pending") return { ...s, status: "aborted" as const, endTs: s.endTs ?? ts };
        return s;
      });
      if (ev.message) steps = [...steps, { id: takeId(), kind: "error", status: "aborted", startTs: ts, endTs: ts, text: ev.message }];
      status = "done";
      break;
    }
    case "promptAnswer":
    case "promptExpire": {
      const i = lastIndexWhere(
        steps,
        (s) => s.kind === "prompt" && s.status === "pending" && (!ev.requestId || !s.prompt?.requestId || s.prompt.requestId === ev.requestId),
      );
      if (i >= 0) {
        if (ev.kind === "promptAnswer") steps = replaceStep(steps, i, { status: "ok", endTs: ts, promptOutcome: "answered", promptChoice: ev.choice });
        else steps = replaceStep(steps, i, { status: "aborted", endTs: ts, promptOutcome: "expired" });
      }
      break;
    }
    case "error":
    case "final": {
      // 终结:所有仍在跑的步收敛(没等到结果的工具标「中断」,挂起的确认同样中断)。
      steps = steps.map((s) => {
        if (s.status === "running") return { ...s, status: s.kind === "tool" ? ("aborted" as const) : ("ok" as const), endTs: s.endTs ?? ts };
        if (s.status === "pending") return { ...s, status: "aborted" as const, endTs: s.endTs ?? ts };
        return s;
      });
      if (ev.kind === "error") {
        steps = [...steps, { id: takeId(), kind: "error", status: "error", startTs: ts, endTs: ts, text: ev.message }];
        status = "error";
      } else {
        // final 文本 = 最后一段(把已封存前缀切掉,OpenClaw 的 final 是整轮全量)。
        const cut = sliceAccumulated(ev.text, answerSealed);
        const i = lastIndexWhere(steps, (s) => s.kind === "final");
        const patch: Partial<TurnStep> = {
          status: ev.errored ? "error" : "ok",
          endTs: ts,
          text: cut.segment,
          model: ev.meta?.model,
          usage: ev.meta?.usage,
        };
        if (i >= 0) steps = replaceStep(steps, i, patch);
        else steps = [...steps, { id: takeId(), kind: "final", startTs: ts, ...patch } as TurnStep];
        status = ev.errored ? "error" : "done";
      }
      break;
    }
  }

  return { steps, status, deriveDurations, thinkingSealed, answerSealed, nextId };
}

// ---- 已结算 parts → 步骤(历史/已完成回合) ---------------------------------

// ChatPage 的 normalize() 产物里与过程有关的 part 子集(结构型输入,避免依赖
// ChatPage 内部类型)。
export interface TimelinePartLike {
  type: string; // thinking | toolCall | toolResult | plan
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolCallId?: string;
  isError?: boolean;
  durationS?: number;
  diff?: { path: string; oldText: string; newText: string };
  diffText?: string;
  planEntries?: { content: string; status?: string }[];
}

// 与 reduceTimeline 不同,这里的输入已经是「结算过的分段」(历史里 thinking 每段
// 独立、工具调用/结果各自成 part),不存在全量累积流,直接构造步骤;配对沿用降级
// 语义:toolCall↔toolResult 按出现顺序 FIFO(历史丢配对 id),没等到结果的调用
// 收敛为「中断」。ts 用序号占位(showDurations=false 场景,耗时仅采 part 自带的
// durationS)。
export function stepsFromParts(seq: TimelinePartLike[], options: { live?: boolean; includeText?: boolean } = {}): TurnStep[] {
  const steps: TurnStep[] = [];
  const open: TurnStep[] = [];
  const calls = new Map<string, TurnStep>();
  let n = 0;
  let ts = 0;
  let plan: TurnStep | null = null;
  for (const p of seq) {
    ts += 1;
    if (p.type === "thinking") {
      if (p.text?.trim()) steps.push({ id: `h${n++}`, kind: "thinking", status: "ok", startTs: ts, endTs: ts, text: p.text });
    } else if (p.type === "toolCall") {
      const name = p.toolName?.trim() || "tool";
      const st: TurnStep = {
        id: `h${n++}`,
        kind: "tool",
        status: "running",
        startTs: ts,
        toolName: name,
        canonicalName: canonicalToolName(name),
        category: categorizeTool(name),
        args: p.toolArgs,
        diff: p.diff,
        diffText: p.diffText,
      };
      steps.push(st);
      open.push(st);
      if (p.toolCallId) calls.set(p.toolCallId, st);
    } else if (p.type === "toolResult") {
      let st = p.toolCallId ? calls.get(p.toolCallId) : open[0];
      if (st) { const index = open.indexOf(st); if (index >= 0) open.splice(index, 1); }
      if (!st) {
        const name = p.toolName?.trim() || "tool";
        st = { id: `h${n++}`, kind: "tool", status: "running", startTs: ts, toolName: name, canonicalName: canonicalToolName(name), category: categorizeTool(name) };
        steps.push(st);
      } else if (p.toolName?.trim() && st.toolName === "tool") {
        st.toolName = p.toolName;
        st.canonicalName = canonicalToolName(p.toolName);
        st.category = categorizeTool(p.toolName);
      }
      if (st.args === undefined && p.toolArgs !== undefined) st.args = p.toolArgs;
      const capped = capText(p.text ?? "");
      st.output = capped.text;
      st.outputTruncated = capped.truncated;
      st.isError = p.isError === true || /"status"\s*:\s*"error"/.test(capped.text);
      st.status = st.isError ? "error" : "ok";
      st.endTs = ts;
      if (typeof p.durationS === "number" && p.durationS > 0) st.durationS = p.durationS;
      if (st.diffText === undefined && typeof p.diffText === "string" && p.diffText) st.diffText = p.diffText;
      if (st.diff === undefined && p.diff) st.diff = p.diff;
    } else if (p.type === "text" && options.includeText && p.text?.trim()) {
      steps.push({ id: `h${n++}`, kind: "text", status: "ok", startTs: ts, endTs: ts, text: p.text });
    } else if (p.type === "plan" && p.planEntries?.length) {
      if (plan) {
        plan.planEntries = p.planEntries;
        plan.planVersion = (plan.planVersion ?? 1) + 1;
        plan.endTs = ts;
      } else {
        plan = { id: `h${n++}`, kind: "plan", status: "ok", startTs: ts, endTs: ts, planEntries: p.planEntries, planVersion: 1 };
        steps.push(plan);
      }
    }
  }
  for (const st of open) st.status = options.live ? "running" : "aborted";
  return steps;
}

// ---- 派生关系:出错后的「同工具重试 / 换工具」 ------------------------------

export interface StepRelation {
  type: "retry" | "switch";
  fromStepId: string;
}

// 不落库、每次重算:并行场景里 error 可能晚于下一个工具的 start 到达,存量标记会算错。
export function deriveRelations(steps: TurnStep[]): Map<string, StepRelation> {
  const rel = new Map<string, StepRelation>();
  const tools = steps.filter((s) => s.kind === "tool");
  for (let i = 1; i < tools.length; i++) {
    const prev = tools[i - 1];
    const cur = tools[i];
    if (!prev.isError) continue;
    rel.set(cur.id, { type: prev.canonicalName === cur.canonicalName ? "retry" : "switch", fromStepId: prev.id });
  }
  return rel;
}
