import { canonicalToolName, toolLabelKey } from "./turnTimeline";

// Plain-language description of what an approval request would do. It is built
// only from the structured request (tool, arguments, parsed command actions),
// never from model-written text, so the headline cannot be steered by content
// the agent read. Chat cards and the live activity share it.

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface ApprovalFacts {
  kind?: string;
  toolName?: string;
  serverName?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  input?: string;
  actions?: string;
  networkHost?: string;
}

export interface ApprovalPhrase {
  /** `chat.approvalDo.<key>`; "product" uses `chat.promptActions.<product>`. */
  key: string;
  values: Record<string, string | number>;
  target?: { kind: "command" | "url" | "path" | "query"; text: string };
  readOnly: boolean;
  web: boolean;
  technical?: string;
}

export const PRODUCT_ACTIONS = new Set([
  "kanban_card_create", "kanban_card_update", "kanban_card_delete",
  "kanban_board_create", "kanban_board_update", "system_open_url", "system_open_folder",
]);
const MCP_NAME = /^mcp__([A-Za-z0-9][A-Za-z0-9._-]*?)__([A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const EDIT_TOOLS = new Set(["edit", "write", "write_file", "patch", "apply_patch", "file_change"]);

function parseObject(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    let parsed = JSON.parse(value);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function parseActions(value?: string): Array<{ type: string; path?: string; query?: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.type === "string") : [];
  } catch { return []; }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Host only: never shows credentials embedded in the URL.
function hostOf(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/iu.exec(url)?.[1] || url;
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || path;
}

function technicalLine(tool: string, input: Record<string, unknown>): string {
  const pairs = Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 3)
    .map(([key, value]) => {
      const one = String(value).replace(/\s+/gu, " ");
      return `${key}=${one.length > 40 ? `${one.slice(0, 40)}…` : one}`;
    });
  const line = [tool, ...pairs].join(" · ");
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

export function productToolOf(facts: ApprovalFacts): string | undefined {
  const name = facts.toolName || "";
  const match = /^(?:mcp__)?shoggoth__([a-z0-9_]+)$/u.exec(name);
  const product = match?.[1] || (facts.serverName === "shoggoth" ? name : undefined);
  return product && PRODUCT_ACTIONS.has(product) ? product : undefined;
}

export function describeApproval(facts: ApprovalFacts): ApprovalPhrase | null {
  if (facts.kind === "permissions") return null;
  const input = parseObject(facts.input);
  const product = productToolOf(facts);
  if (product) return { key: "product", values: { product }, readOnly: false, web: false };
  const rawName = facts.toolName || "";
  const mcp = MCP_NAME.exec(rawName) || (rawName.includes("/") ? [rawName, ...rawName.split("/", 2)]
    : facts.serverName && rawName ? [rawName, facts.serverName, rawName] : null);
  const leaf = mcp ? mcp[2] : rawName;
  const canonical = canonicalToolName(leaf);
  const technical = rawName ? technicalLine(rawName, input) : undefined;
  const url = text(input.url);
  const path = text(input.path) || text(input.file_path) || text(input.filePath);
  const query = text(input.query) || text(input.pattern);
  const command = text(facts.command) || text(input.command);
  const base = { technical };

  if (canonical === "list_resources") {
    const server = text(input.server) || (mcp ? mcp[1] : undefined) || "MCP";
    return { ...base, key: "listResources", values: { server }, readOnly: true, web: false };
  }
  // Codex Apps asks on behalf of an app; its validated tool names read
  // "<app>.<tool>". The app's display name is untrusted and stays in the reason.
  const app = mcp?.[1] === "codex_apps" ? /^([a-z0-9][a-z0-9_-]*)\.(.+)$/iu.exec(leaf) : null;
  if (app) {
    return { ...base, key: "appTool", values: { app: app[1], tool: app[2] }, readOnly: false, web: false };
  }
  if (mcp && canonical !== "web_fetch") {
    return { ...base, key: "mcpTool", values: { server: mcp[1], tool: leaf }, readOnly: false, web: false };
  }
  if (canonical === "web_fetch" && url) {
    return { ...base, key: "fetch", values: { host: hostOf(url) }, target: { kind: "url", text: url }, readOnly: true, web: true };
  }
  if (canonical === "web_search" && query) {
    return { ...base, key: "webSearch", values: { query }, target: { kind: "query", text: query }, readOnly: true, web: true };
  }
  if (["read", "read_file", "image_view"].includes(canonical) && path) {
    return { ...base, key: "readFile", values: { name: baseName(path) }, target: { kind: "path", text: path }, readOnly: true, web: false };
  }
  if (canonical === "ls" && path) {
    return { ...base, key: "listDir", values: { name: baseName(path) }, target: { kind: "path", text: path }, readOnly: true, web: false };
  }
  if (["grep", "search_files"].includes(canonical) && query) {
    return { ...base, key: "searchFiles", values: { query }, target: path ? { kind: "path", text: path } : undefined, readOnly: true, web: false };
  }
  if (canonical === "external_directory" && path) {
    return { ...base, key: "accessOutside", values: { name: baseName(path) }, target: { kind: "path", text: path }, readOnly: false, web: false };
  }
  if (canonical === "find") {
    return { ...base, key: "findFiles", values: {}, target: query ? { kind: "query", text: query } : path ? { kind: "path", text: path } : undefined, readOnly: true, web: false };
  }
  if (EDIT_TOOLS.has(canonical) || (!rawName && facts.kind === "file_change")) {
    const changed = path || text(facts.grantRoot);
    return path
      ? { ...base, key: "editFile", values: { name: baseName(path) }, target: { kind: "path", text: path }, readOnly: false, web: false }
      : { ...base, key: "editFiles", values: {}, target: changed ? { kind: "path", text: changed } : undefined, readOnly: false, web: false };
  }
  // Codex: parsed actions say whether a command only reads, lists or searches.
  const actions = parseActions(facts.actions);
  if (!rawName && actions.length > 0 && !facts.networkHost) {
    const kinds = new Set(actions.map((action) => action.type));
    const target = command ? { kind: "command" as const, text: command } : undefined;
    if (kinds.size === 1 && kinds.has("read")) {
      const paths = actions.map((action) => action.path).filter((item): item is string => Boolean(item));
      return paths.length === 1
        ? { ...base, key: "readFile", values: { name: baseName(paths[0]) }, target, readOnly: true, web: false }
        : { ...base, key: "readFiles", values: { count: actions.length }, target, readOnly: true, web: false };
    }
    if (kinds.size === 1 && kinds.has("listFiles")) {
      const listed = actions[0].path;
      return { ...base, key: listed ? "listDir" : "listFiles", values: listed ? { name: baseName(listed) } : {}, target, readOnly: true, web: false };
    }
    if (kinds.size === 1 && kinds.has("search") && actions[0].query) {
      return { ...base, key: "searchFiles", values: { query: actions[0].query }, target, readOnly: true, web: false };
    }
  }
  if (canonical === "exec" || command) {
    return { ...base, key: facts.networkHost ? "runCommandNetwork" : "runCommand", values: {},
      target: command ? { kind: "command", text: command } : undefined, readOnly: false, web: false };
  }
  if (rawName) return { ...base, key: "tool", values: { tool: rawName }, readOnly: false, web: false };
  return null;
}

/** The localized action without a subject, e.g. "打开网页 example.com". */
export function approvalActionText(phrase: ApprovalPhrase, t: Translate): string {
  if (phrase.key === "product") return t(`chat.promptActions.${phrase.values.product}`);
  if (phrase.key === "tool") {
    const raw = String(phrase.values.tool);
    return t("chat.approvalDo.tool", { tool: t(toolLabelKey(raw), { defaultValue: "" }) || raw });
  }
  return t(`chat.approvalDo.${phrase.key}`, phrase.values);
}

// Chinese puts a space after a Latin name ("Antigravity 想…") but not after a
// Chinese one ("小助手想…"); the Chinese template itself has no space.
function subject(agent: string, language?: string): string {
  return language?.startsWith("zh") && /[A-Za-z0-9)\]]$/u.test(agent) ? `${agent} ` : agent;
}

/** The card headline, e.g. "Antigravity 想打开网页 example.com". */
export function approvalHeadline(phrase: ApprovalPhrase, agent: string, t: Translate, language?: string): string {
  const action = approvalActionText(phrase, t);
  return t(phrase.key === "product" ? "chat.approvalWantsProduct" : "chat.approvalWants",
    { agent: subject(agent, language), action });
}

export function pathOutside(path: string, root?: string): boolean {
  if (!root || !path.startsWith("/") || !root.startsWith("/")) return false;
  const base = root.replace(/\/+$/u, "");
  return path !== base && !path.startsWith(`${base}/`);
}
