// turnTimeline —— 「一次 agent 回合」的过程时间线核心(纯函数,零 React/DOM 依赖)。
//
// 输入是与 core/agent-backend.js sendMessage() 钩子契约 1:1 同形的事件流
// (TurnEvent),外加两个仅客户端合成的事件(user / promptAnswer);输出是
// append-only 的 TurnStep[]。将来并入 ChatPage 时,把它现有 WS 处理里的字段
// 原样喂进 reduceTimeline 即可,本模块无需改动。
//
// 与 ChatPage 既有语义对齐的点(改这里前先看那边):
// - 工具事件合并规则与 ChatPage 共用(name 可覆盖 / args 支持后补和结果合并 /
//   durationS>0 才采 / 失败标记优先，未提供时仅检查结果根节点状态)。
// - thinking/delta 在线上是「全量累积」文本(见根 CLAUDE.md 雷区);本模块靠
//   已封存前缀切片,把累积流还原成真实交错的分段。
// - 输出截断与 ChatPage formatToolOutput 同为 4000 字。

// Display-only identifier; opening it revalidates its call and Grants.
export function validPluginAppCallId(value: unknown): string | undefined {
  return typeof value === "string" && /^runtime-[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export type TurnPrompt = {
  kind: string; requestId?: string; question?: string; command?: string; description?: string; choices?: string[];
  title?: string; message?: string;
};

export type TurnEvent =
  | { kind: "user"; text: string } // 合成:开启本回合的用户消息
  | { kind: "delta"; text: string } // 全量累积的回答文本
  | { kind: "interim"; text: string; activity?: boolean; activityId?: string } // 封存当前回答段
  | { kind: "progress"; text: string; activityId: string } // 按来源 ID 更新公开进度
  | { kind: "thinking"; text: string } // 全量累积的思考文本
  | {
      kind: "tool";
      toolCallId: string;
      name?: string;
      args?: unknown;
      phase: "start" | "update" | "result";
      result?: unknown;
      pluginAppCallId?: string;
      partialResult?: unknown; // OpenClaw update 相的流式输出
      isError?: boolean;
      durationS?: number; // Hermes tool.complete 的耗时
      diff?: { path: string; oldText: string; newText: string };
      diffText?: string; // Hermes inline_diff(unified diff 文本)
    }
  | { kind: "plan"; entries: { content: string; status?: string }[] }
  | { kind: "status"; status: { kind: string; text?: string } } // compacting | compacted | recalling | recalled
  | {
      kind: "prompt";
      prompt: TurnPrompt;
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
export type ToolCategory = "gather" | "read" | "execute" | "message" | "workboard" | "cron" | "inspiration" | "other";

export interface TurnStep {
  subagent?: import("./chatSubagentActivity").SubagentProgress;
  id: string;
  toolCallId?: string; // exact host call identity; never infer from tool name/position
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
  pluginAppCallId?: string;
  isError?: boolean;
  diff?: { path: string; oldText: string; newText: string };
  diffText?: string;
  updateCount?: number;
  // 文本类步(user / thinking 段 / text 段 / final / error)
  text?: string;
  activity?: boolean; // explicit public progress, shown inside the activity timeline
  // plan / prompt / status / final 元数据
  planEntries?: { content: string; status?: string }[];
  planVersion?: number;
  prompt?: TurnPrompt;
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
  "x search": "x_search",
  "x search:": "x_search",
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
  // Antigravity (ACP) and OpenCode names for the same capabilities.
  read_url_content: "web_fetch",
  webfetch: "web_fetch",
  view_file: "read_file",
  list_directory: "ls",
  find_file: "find",
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
  x_semantic_search: "gather",
  x_keyword_search: "gather",
  x_thread_fetch: "gather",
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
  cron: "cron",
  cronjob: "cron",
  cronjob_manage: "cron",
  automations: "cron",
  inspiration: "inspiration",
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
  ["cron_", "cron"],
  ["inspiration_", "inspiration"],
];

export function categorizeTool(name: string): ToolCategory {
  // Reuse the action-title namespaces without changing the original tool identity.
  const n = canonicalToolName(productActivityTool(name) ?? name);
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

// Language-neutral argument excerpt retained for diagnostic callers.
// Compact activity surfaces use toolActivityTitle instead of raw arguments.
const PRIMARY_ARG_KEYS = ["command", "path", "file_path", "filePath", "url", "query", "pattern", "name", "message", "title", "summary", "server"];

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

// Display aliases are deliberately separate from capability/approval matching.
const ACTIVITY_ALIASES: Record<string, string> = {
  exec_command: "exec", run_shell_command: "exec", execute_bash: "exec", shell: "exec", execute: "exec", fetch: "web_fetch",
  "terminal command": "exec",
  readfile: "read_file", view_image: "image_view", notebookedit: "edit", write_to_file: "write_file", replace_file_content: "edit",
  multi_replace_file_content: "edit", edit_file: "edit", multiedit: "edit",
  grep_search: "grep", glob: "find", find_by_name: "find", list_dir: "ls",
  browse_page: "web_fetch", todo_list: "update_plan", process_manage: "process", cronjob_manage: "cronjob",
  automations: "cron",
  spawnagent: "spawn_agent", sendinput: "send_input", resumeagent: "resume_agent", closeagent: "close_agent",
};

function activityToolName(name?: string, args?: unknown): string {
  const rawName = (name ?? "").trim();
  const tool = canonicalToolName(rawName);
  // Some ACP execute records use the command as their title, or the generic
  // "tool" when that title exceeds the adapter's limit. Use the already-public
  // command field only for those shapes; other tool identities stay unchanged.
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const a = args as Record<string, unknown>;
    const command = [a.command, a.cmd, a.CommandLine].find((value): value is string => typeof value === "string" && !!value.trim());
    if (command && !tool.startsWith("mcp__") && (tool === "tool"
      || rawName.replace(/\s+/gu, " ") === command.replace(/\s+/gu, " ").trim())) return "exec";
  }
  return ACTIVITY_ALIASES[tool] ?? tool;
}

// Execution tools may supply an action label alongside the shell command.
// Explicit activityTitle is presentation metadata. Other tools can use description
// for document/task content, so only command tools promote that older field.
// Keep the original args for expanded details.
export function toolActionTitle(name?: string, args?: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const activity = (args as Record<string, unknown>).activityTitle;
    if (typeof activity === "string" && activity.trim() && activity.length <= 120
      && !/[\u0000-\u001f\u007f]/u.test(activity)) return activity.trim();
  }
  const tool = activityToolName(name, args);
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const a = args as Record<string, unknown>;
  for (const key of tool === "exec" || tool === "terminal" ? ["title", "description"] : []) {
    const value = a[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  const native = a.nativeActivityTitle;
  if (typeof native === "string" && native.trim() && native.length <= 120
    && !/[\u0000-\u001f\u007f]/u.test(native)) return native.trim();
  return "";
}

export function summarizeArgs(name?: string, args?: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, any>) : null;
  if (!a) return "";
  const actionTitle = toolActionTitle(name, args);
  if (actionTitle) return actionTitle.length > 90 ? actionTitle.slice(0, 90) + "…" : actionTitle;
  // Language-neutral: the step label already says what kind of action it is.
  if (canonicalToolName(name ?? "") === "web_search" && typeof a.query === "string") return `"${a.query}"`;
  if (canonicalToolName(name ?? "") === "web_fetch" && typeof a.url === "string") return a.url;
  for (const k of PRIMARY_ARG_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) {
      const one = primaryArgText(k, v);
      return one.length > 90 ? one.slice(0, 90) + "…" : one;
    }
  }
  return "";
}

type ActivityTranslate = (key: string, values?: Record<string, unknown>) => string;

// Product tools have the same identity across runtimes, with these three MCP
// namespaces or a direct name. This is display matching only: do not use it for
// permission, dispatch, or result ownership checks.
function productActivityTool(name: string | undefined): string | undefined {
  const raw = name?.trim().toLowerCase() || "";
  const bare = raw.replace(/^(?:mcp__shoggoth__|shoggoth__|shoggoth\/)/u, "");
  return /^[a-z][a-z0-9_]*$/u.test(bare) ? bare : undefined;
}

/** Runtime arguments can arrive after the start event. Merge already-projected
 * object fields so a completed/result-only part retains earlier descriptions. */
export function mergeToolArgs(current: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return current;
  const record = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === "string" && value.trimStart().startsWith("{")) {
      try { value = JSON.parse(value); } catch { return undefined; }
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  };
  const prior = record(current);
  const next = record(incoming);
  return prior && next ? { ...prior, ...next } : incoming;
}

/** A tool can successfully return a list of failed jobs. Never scan nested
 * output text for statuses, and preserve an explicit false from the runtime. */
export function toolResultFailed(result: unknown, isError?: boolean): boolean {
  if (typeof isError === "boolean") return isError;
  let value = result;
  if (typeof value === "string" && value.trimStart().startsWith("{")) {
    try { value = JSON.parse(value); } catch { return false; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.isError === true || data.is_error === true || data.status === "error"
    || data.status === "failed" || data.success === false;
}

const ACTIVITY_ACTIONS: Record<string, string> = {
  read: "readFile", read_file: "readFile", image_view: "viewImage",
  write: "writeFile", write_file: "writeFile", edit: "editFile", patch: "editFile",
  apply_patch: "editFile", file_change: "editFile", ls: "listDirectory",
  find: "findFiles", grep: "searchFiles", search_files: "searchFiles",
  web_search: "webSearch", x_search: "xSearch", x_semantic_search: "xSemanticSearch",
  x_keyword_search: "xKeywordSearch", x_thread_fetch: "xThread", web_fetch: "openPage", web_extract: "openPage",
  search: "searchContent",
  browser_navigate: "navigatePage",
  process: "process", update_plan: "plan", todo: "plan", todowrite: "plan",
  message: "message", sessions_send: "message", delegate_task: "delegate", task: "delegate",
};

/** A compact activity headline, never a raw command, result, or JSON payload.
 * Labels describe the requested action; status remains a separate, factual field.
 * All backends use this after their normal argument projection/redaction. */
export function toolActivityTitle(name: string | undefined, args: unknown, t: ActivityTranslate, wrapperDepth = 0): string {
  const short = (value: string, max = 90) => {
    const text = value.replace(/\s+/gu, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  let input = args;
  if (typeof input === "string" && input.trimStart().startsWith("{")) {
    try { input = JSON.parse(input); } catch { /* A raw command is also valid. */ }
  }
  const a = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const first = (...keys: string[]) => keys.map(key => a[key]).find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
  const tool = activityToolName(name, a);
  const explicit = toolActionTitle(name, a);
  if (explicit) return short(explicit);
  const action = (key: string, values?: Record<string, unknown>) => t(`turnLab.activity.${key}`, values);
  const withTarget = (key: string, target?: string) => short(target ? `${action(key)} · ${target}` : action(key));
  const translated = (key: string) => {
    const text = t(key, { defaultValue: "" });
    return text && text !== key ? text : "";
  };
  // A single UI row still represents the outer call. Unwrap only known runtime
  // wrappers for its headline, without changing identity, pairing, or statuses.
  if (wrapperDepth < 2) {
    const rawName = name?.trim().toLowerCase();
    if (["call_mcp_tool", "use_tool", "callmcptool", "usetool", "tool_call"].includes(rawName || "")) {
      const referenced = first("toolName", "tool_name", "tool", "name");
      const server = first("server", "serverName", "server_name")?.toLowerCase();
      const scoped = referenced && /^(?:mcp__shoggoth__|shoggoth__|shoggoth\/)/iu.test(referenced);
      if (referenced && (scoped || server === "shoggoth" || rawName === "tool_call")) {
        const nested = [a.arguments, a.args, a.parameters, a.input]
          .find(value => value && typeof value === "object" && !Array.isArray(value));
        return toolActivityTitle(referenced, nested || a, t, wrapperDepth + 1);
      }
      if (rawName === "tool_call" && Array.isArray(a.calls) && a.calls.length) {
        const titles = a.calls.slice(0, 2).map(call => {
          const value = call && typeof call === "object" ? call as Record<string, unknown> : {};
          const callName = typeof value.name === "string" ? value.name : undefined;
          return toolActivityTitle(callName, value.arguments || value.args || value.parameters, t, wrapperDepth + 1);
        });
        return short(`${action("batchTools", { count: a.calls.length })} · ${titles.join(" / ")}`);
      }
    }
  }
  const product = productActivityTool(name);
  let productTitle = product && translated(`turnLab.productTools.${product}`);
  if (productTitle) {
    if (product === "app_state_get") {
      const section = first("section");
      if (section && /^[a-z_]+$/u.test(section)) {
        productTitle = translated(`turnLab.appStateSections.${section}`) || productTitle;
      }
    } else if (product === "app_manage") {
      const operation = first("operation");
      if (operation && /^(?:cron|kanban)_[a-z_]+$/u.test(operation)) {
        productTitle = translated(`turnLab.productTools.${operation}`) || productTitle;
      }
    } else if (product === "cron_set_enabled" && typeof a.enabled === "boolean") {
      productTitle = action(a.enabled ? "enableCron" : "disableCron");
    }
    return short(productTitle);
  }

  const operation = first("action", "operation");
  if (operation && /^[a-z_.-]+$/u.test(operation)
    && ["process", "cron", "cronjob", "browser", "gateway", "message", "memory", "subagents", "terminal"].includes(tool)) {
    const operationTitle = translated(`turnLab.operations.${tool}.${operation.replace(/[.-]/gu, "_")}`);
    if (operationTitle) return short(operationTitle);
    const familyTitle = translated(`turnLab.builtinTools.${tool}`);
    if (familyTitle) return short(familyTitle);
  }

  if (tool === "exec" || tool === "terminal") {
    const command = unwrapShellCommand(first("command", "cmd", "CommandLine") || (typeof input === "string" ? input : "")).trim();
    const program = /^(?:[\w./~-]*\/)?([\w.+-]+)(?=\s|$)/u.exec(command)?.[1];
    if (program && /^python(?:\d+(?:\.\d+)*)?$/u.test(program)) return action("runScript", { language: "Python" });
    if (program === "node" || program === "nodejs") return action("runScript", { language: "Node.js" });
    // Only classify a single, simple command. Pipelines, substitutions and shell
    // scripts can do more than their first command suggests, so keep those generic.
    if (command && !/[\r\n;&|><`$()]/u.test(command)) {
      const words = command.split(/\s+/u);
      const operation = words[1];
      if (program === "git" && ["status", "diff", "log"].includes(operation)) return action(`git_${operation}`);
      if (program === "pwd") return action("workingDirectory");
      if (program === "ls") return action("listDirectory");
      if (program && ["cat", "head", "tail"].includes(program)) return action("readFile");
      if (program && ["rg", "grep"].includes(program)) return action("searchFiles");
      if (program === "find") return action("findFiles");
      if (program && ["npm", "pnpm", "yarn", "bun"].includes(program)) {
        const script = operation === "run" ? words[2] : operation;
        if (script === "test") return action("test");
        if (script === "build") return action("build");
      }
    }
    return action("runCommand");
  }

  const path = first("path", "file_path", "filePath", "file", "notebook_path", "TargetFile", "target_file", "AbsolutePath", "DirectoryPath", "SearchDirectory", "SearchPath", "directory", "output_path", "output_file");
  const file = path?.replace(/\\/gu, "/").replace(/\/$/u, "").split("/").at(-1) || path;
  const query = first("query", "pattern", "Query", "Pattern")
    || (Array.isArray(a.queries) ? a.queries.filter((value): value is string => typeof value === "string").join(" · ") : undefined);
  const xOperation = tool === "x_search" && ["x_semantic_search", "x_keyword_search", "x_thread_fetch"].includes(operation || "")
    ? operation! : tool;
  const key = ACTIVITY_ACTIONS[xOperation] || ACTIVITY_ACTIONS[product || ""];
  if (key === "xThread") return withTarget(key, first("post_id"));
  if (["xSearch", "xSemanticSearch", "xKeywordSearch"].includes(key)) return withTarget(key, query);
  if (key === "openPage" || key === "navigatePage") {
    const url = first("url", "Url", "URL") || (Array.isArray(a.urls) && typeof a.urls[0] === "string" ? a.urls[0] : undefined);
    // Host only: query strings and credentials are unnecessary in a step title.
    const host = url && /^https?:\/\/(?:[^@/?#]*@)?([^/?#]+)/iu.exec(url)?.[1];
    return withTarget(key, host || undefined);
  }
  if (key === "webSearch" || key === "searchFiles" || key === "findFiles") return withTarget(key, query || file);
  if (["readFile", "writeFile", "editFile", "listDirectory", "viewImage"].includes(key)) {
    const count = typeof a.changeCount === "number" ? a.changeCount : Array.isArray(a.changes) ? a.changes.length : 0;
    if (key === "editFile" && count > 1) return action("editFiles", { count });
    const changed = Array.isArray(a.changes) ? a.changes[0] as { path?: unknown } | undefined : undefined;
    return withTarget(key, file || (typeof changed?.path === "string" ? changed.path.split("/").at(-1) : undefined));
  }
  if (key) return action(key);
  const builtinTitle = translated(`turnLab.builtinTools.${tool}`);
  if (builtinTitle) return short(builtinTitle);
  if (tool.startsWith("browser")) return action("browser");
  if (tool.startsWith("memory_") || tool.startsWith("wiki_")) return action("memory");
  if (tool.startsWith("mcp__") || tool.includes("/")) return withTarget("externalTool", first("title", "name"));
  // ACP can use a prose title as its tool name. Keep that supplied label when
  // it contains ordinary words, rather than replacing it with an identifier.
  const supplied = name?.trim();
  if (supplied && /^[\p{L}\p{N} ,，。.!?'’()-]+$/u.test(supplied)
    && (/\p{Script=Han}/u.test(supplied) || /^[A-Z][a-z]+ /u.test(supplied))) return short(supplied);
  // Known product tools retain their translated family name. Unknown identifiers
  // stay in the tooltip/details instead of becoming the primary activity text.
  const label = t(toolLabelKey(name || "tool"), { defaultValue: "" });
  return short(label && (label !== tool || tool === "kanban" || tool === "workboard") ? label : action("tool"));
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

// Status kinds that are real process steps: a running kind and the kind that completes it.
const STATUS_STEP_DONE: Record<string, string> = { compacting: "compacted", recalling: "recalled" };
const STATUS_STEP_RUNNING: Record<string, string> = { compacted: "compacting", recalled: "recalling" };

export function reduceTimeline(state: TurnTimelineState, ev: TurnEvent, ts: number): TurnTimelineState {
  // 运行生命周期不属于过程步骤，也不能打断思考/回答分段或提前结束上下文压缩/记忆回忆。
  if (ev.kind === "status" && !STATUS_STEP_DONE[ev.status.kind] && !STATUS_STEP_RUNNING[ev.status.kind]) return state;

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
    case "progress": {
      if (!ev.text.trim()) break;
      const id = `progress:${ev.activityId}`;
      const i = steps.findIndex(s => s.id === id);
      if (i >= 0) steps = replaceStep(steps, i, { text: ev.text });
      else steps = [...steps, { id, kind: "text", activity: true, status: "ok", startTs: ts, endTs: ts, text: ev.text }];
      break;
    }
    case "interim": {
      // interim 携带的就是本段权威文本;上游随后把累积清零重来。
      const progressId = ev.activity && ev.activityId ? `progress:${ev.activityId}` : undefined;
      const existing = progressId ? steps.findIndex(s => s.id === progressId) : -1;
      if (existing >= 0) {
        steps = replaceStep(steps, existing, { text: ev.text });
        answerSealed = "";
        break;
      }
      const i = lastIndexWhere(steps, (s) => s.kind === "final" && s.status === "running");
      if (i >= 0) steps = replaceStep(steps, i, { kind: "text", status: "ok", endTs: ts, text: ev.text,
        ...(ev.activity ? { activity: true, ...(ev.activityId ? { id: `progress:${ev.activityId}` } : {}) } : {}) });
      else if (ev.text) steps = [...steps, { id: ev.activityId ? `progress:${ev.activityId}` : takeId(), kind: "text", status: "ok", startTs: ts, endTs: ts, text: ev.text,
        ...(ev.activity ? { activity: true } : {}) }];
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
            toolCallId: ev.toolCallId,
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
      if (cur.endTs !== undefined && ev.phase !== "result") return state;
      const patch: Partial<TurnStep> = {};
      if (ev.name && ev.name.trim() && ev.name !== cur.toolName) {
        patch.toolName = ev.name;
        patch.canonicalName = canonicalToolName(ev.name);
        patch.category = categorizeTool(ev.name);
      }
      if (ev.args !== undefined) patch.args = mergeToolArgs(cur.args, ev.args);
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
        patch.pluginAppCallId = validPluginAppCallId(ev.pluginAppCallId);
        if (ev.result !== undefined) {
          const capped = capText(ev.result);
          patch.output = capped.text;
          patch.outputTruncated = capped.truncated;
        }
        patch.endTs = ts;
        const failed = typeof ev.isError === "boolean" ? ev.isError
          : cur.isError === true || toolResultFailed(ev.result ?? cur.output);
        patch.isError = failed;
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
      const kind = ev.status.kind;
      const runningKind = STATUS_STEP_DONE[kind] ? kind : STATUS_STEP_RUNNING[kind];
      const open = lastIndexWhere(steps, (s) => s.kind === "status" && s.status === "running" && s.statusKind === runningKind);
      if (STATUS_STEP_DONE[kind]) {
        if (open >= 0) steps = replaceStep(steps, open, { text: ev.status.text ?? steps[open].text });
        else steps = [...steps, { id: takeId(), kind: "status", status: "running", startTs: ts, statusKind: kind, text: ev.status.text }];
      } else if (open >= 0) {
        steps = replaceStep(steps, open, { status: "ok", endTs: ts, statusKind: kind, text: ev.status.text ?? steps[open].text });
      } else {
        const last = steps.length - 1;
        if (steps[last]?.kind === "status" && steps[last].statusKind === kind && steps[last].status === "ok") {
          steps = replaceStep(steps, last, { text: ev.status.text ?? steps[last].text });
        } else {
          steps = [...steps, { id: takeId(), kind: "status", status: "ok", startTs: ts, endTs: ts, statusKind: ev.status.kind, text: ev.status.text }];
        }
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
        if (s.kind === "status" && s.status === "running") return { ...s, status: "aborted" as const, endTs: ts };
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
        if (s.kind === "status" && s.status === "running") {
          return { ...s, status: ev.kind === "error" || ev.errored ? ("error" as const) : ("aborted" as const), endTs: ts };
        }
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
  activity?: boolean;
  segmentId?: string;
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolCallId?: string;
  pluginAppCallId?: string;
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
    if (p.type === "text" && p.activity === true) {
      if (p.text?.trim()) steps.push({ id: p.segmentId ? `progress:${p.segmentId}` : `h${n++}`, kind: "text", activity: true,
        status: "ok", startTs: ts, endTs: ts, text: p.text });
    } else if (p.type === "thinking") {
      if (p.text?.trim()) steps.push({ id: `h${n++}`, kind: "thinking", status: "ok", startTs: ts, endTs: ts, text: p.text });
    } else if (p.type === "toolCall") {
      const name = p.toolName?.trim() || "tool";
      const st: TurnStep = {
        id: `h${n++}`,
        toolCallId: p.toolCallId,
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
        st = { id: `h${n++}`, toolCallId: p.toolCallId, kind: "tool", status: "running", startTs: ts, toolName: name, canonicalName: canonicalToolName(name), category: categorizeTool(name) };
        steps.push(st);
      } else if (p.toolName?.trim() && st.toolName === "tool") {
        st.toolName = p.toolName;
        st.canonicalName = canonicalToolName(p.toolName);
        st.category = categorizeTool(p.toolName);
      }
      if (p.toolArgs !== undefined) st.args = mergeToolArgs(st.args, p.toolArgs);
      const capped = capText(p.text ?? "");
      st.output = capped.text;
      st.pluginAppCallId = validPluginAppCallId(p.pluginAppCallId);
      st.outputTruncated = capped.truncated;
      st.isError = toolResultFailed(p.text, p.isError);
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

// Only already-public fields of known tools can identify an activity's target.
// This is a display comparison, never an execution or authorization identity.
function activityTarget(name: string | undefined, args: unknown, depth = 0): { tool: string; key: string; label: string } | undefined {
  let input = args;
  if (typeof input === "string" && input.trimStart().startsWith("{")) {
    try { input = JSON.parse(input); } catch { return; }
  }
  const a = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const first = (...keys: string[]) => keys.map(key => a[key]).find((value): value is string => typeof value === "string" && !!value.trim())?.trim();
  const rawName = name?.trim().toLowerCase() || "";
  if (depth < 2 && ["call_mcp_tool", "use_tool", "callmcptool", "usetool", "tool_call"].includes(rawName)) {
    const referenced = first("toolName", "tool_name", "tool", "name");
    if (referenced && (/^(?:mcp__shoggoth__|shoggoth__|shoggoth\/)/iu.test(referenced)
      || first("server", "serverName", "server_name")?.toLowerCase() === "shoggoth" || rawName === "tool_call")) {
      return activityTarget(referenced, a.arguments || a.args || a.parameters || a.input, depth + 1);
    }
    return;
  }
  const tool = activityToolName(productActivityTool(name) || name, a);
  let kind = "", value = "", label = "";
  if (["web_search", "x_search", "x_semantic_search", "x_keyword_search"].includes(tool)) {
    kind = "query"; value = first("query", "Query") || ""; label = value;
  } else if (["web_fetch", "browser_navigate", "read_url"].includes(tool)) {
    const url = first("url", "Url", "URL");
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return;
      kind = "url"; value = `${parsed.origin}${parsed.pathname}${parsed.search}`;
      label = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch { return; }
  } else if (["exec", "terminal"].includes(tool)) {
    kind = "command"; value = unwrapShellCommand(first("command", "cmd", "CommandLine") || (typeof input === "string" ? input : ""));
  } else if (["read", "read_file", "write", "write_file", "edit", "ls", "list_directory", "image_view"].includes(tool)) {
    kind = "path"; value = first("path", "file_path", "filePath", "file", "TargetFile", "AbsolutePath", "DirectoryPath") || "";
  }
  return value ? { tool, key: `${kind}:${value}`, label } : undefined;
}

/** Preserve model wording; qualify repeated web headlines with their real target. */
export function toolActivityTitles(steps: TurnStep[], t: ActivityTranslate): Map<string, string> {
  const titles = new Map<string, string>();
  const targets = new Map<string, Set<string>>();
  const rows = steps.filter(step => step.kind === "tool").map(step => {
    const title = toolActivityTitle(step.toolName, step.args, t), target = activityTarget(step.toolName, step.args);
    titles.set(step.id, title);
    if (target?.label) {
      if (!targets.has(title)) targets.set(title, new Set());
      targets.get(title)!.add(target.key);
    }
    return { step, title, target };
  });
  for (const { step, title, target } of rows) {
    if (!target?.label || (targets.get(title)?.size ?? 0) < 2) continue;
    const base = title.length > 38 ? `${title.slice(0, 37)}…` : title;
    const label = target.label.replace(/\s+/gu, " ");
    const compact = label.length > 48 ? `${label.slice(0, 20)}…${label.slice(-27)}` : label;
    titles.set(step.id, `${base} · ${compact}`);
  }
  return titles;
}

// ---- 派生关系:已失败目标的后续重试 / 换工具 -------------------------------

export interface StepRelation {
  type: "retry" | "switch";
  fromStepId: string;
}

// A matching tool name alone cannot establish retry intent. The same target
// must have failed before this call started; overlapping batches are unrelated.
export function deriveRelations(steps: TurnStep[]): Map<string, StepRelation> {
  const rel = new Map<string, StepRelation>();
  const latest = new Map<string, { step: TurnStep; tool: string }>();
  for (const cur of steps) {
    if (cur.kind !== "tool") continue;
    const target = activityTarget(cur.toolName, cur.args);
    if (!target) continue;
    const previous = latest.get(target.key), prev = previous?.step;
    if (previous && prev?.isError && prev.endTs !== undefined && prev.endTs <= cur.startTs) {
      rel.set(cur.id, { type: previous.tool === target.tool ? "retry" : "switch", fromStepId: prev.id });
    }
    // A newer success or overlapping call supersedes an older failure.
    latest.set(target.key, { step: cur, tool: target.tool });
  }
  return rel;
}
