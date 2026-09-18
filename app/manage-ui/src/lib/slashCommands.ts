// OpenClaw-derived code: MIT. Copyright and full terms:
// resources/legal/licenses/source/OPENCLAW.txt
// Static slash-command catalog for the chat composer palette.
//
// Ported 1:1 from OpenClaw's UI command registry
// (ui/src/ui/chat/slash-commands.ts → buildLocalSlashCommands(), itself built from
// src/auto-reply/commands-registry.shared.ts). The real Control UI fetches a
// per-agent list via the `commands.list` RPC and falls back to this builtin set;
// ChatPage now also fetches commands.list for OpenClaw agents and merges over this.
//
// Dropped vs upstream: the 4 Discord/Telegram channel-only commands
// (focus / unfocus / activation / send) — no-ops in webchat.
//
// `argOptions` holds the fixed argument choices (for the badge + the arg-picker
// submenu). Commands with dynamic/no choices omit it.

export type SlashCategory = "session" | "model" | "tools" | "agents";

export interface SlashCommand {
  /** command name without the leading slash, e.g. "model" */
  name: string;
  /** description, verbatim from the source registry */
  description: string;
  /** argument hint shown after the name, e.g. "[level]" or "<name> [input]" */
  args?: string;
  category: SlashCategory;
  /** icon key, resolved to an SVG by <SlashIcon> in ChatPage */
  icon: string;
  /** executes with no args upstream → shows the "instant" badge */
  instant?: boolean;
  /** fixed first-argument choices → "N options" badge + the arg-picker submenu */
  argOptions?: string[];
  /** extra names this command also matches when filtering (without slash) */
  aliases?: string[];
  source?: string;
  execution?: "runtime" | "client" | "cli";
}

// Curated to the commands that actually EXECUTE in webchat (OpenClaw's own Control UI
// only implements a subset client-side; the rest — skills/plugins, config-set, host
// exec — only run via Telegram/CLI, so we hide them). Each command here is wired in
// ChatPage's dispatchSlash (settings → sessions.patch; control → chat.abort/steer/etc.).
export const SLASH_COMMANDS: SlashCommand[] = [
  // ---- session ----
  { name: "stop", description: "Stop the current run.", category: "session", icon: "stop", instant: true },
  { name: "reset", description: "Reset the current session.", category: "session", icon: "refresh", instant: true },
  { name: "new", description: "Start a new session; native Agents can set a workspace.", args: "[workspace]", category: "session", icon: "plus" },
  { name: "compact", description: "Compact the session context.", args: "[instructions]", category: "session", icon: "loader" },
  { name: "clear", description: "Clear chat history", category: "session", icon: "trash", instant: true },

  // ---- model / per-session settings (all via sessions.patch) ----
  { name: "model", description: "Show or set the model.", args: "[model]", category: "model", icon: "brain" },
  { name: "models", description: "List available models.", category: "model", icon: "brain" },
  { name: "think", description: "Set thinking level.", args: "[level]", category: "model", icon: "brain", argOptions: ["off", "minimal", "low", "medium", "high", "xhigh"], aliases: ["thinking", "t"] },
  { name: "verbose", description: "Toggle verbose mode.", args: "[mode]", category: "model", icon: "terminal", argOptions: ["on", "off"], aliases: ["v"] },
  { name: "fast", description: "Toggle fast mode.", args: "[mode]", category: "model", icon: "zap", argOptions: ["status", "on", "off"] },
  { name: "trace", description: "Toggle plugin trace lines.", args: "[mode]", category: "model", icon: "terminal", argOptions: ["on", "off", "raw"] },
  { name: "reasoning", description: "Toggle reasoning visibility.", args: "[mode]", category: "model", icon: "terminal", argOptions: ["on", "off", "stream"], aliases: ["reason"] },
  { name: "elevated", description: "Toggle elevated mode.", args: "[mode]", category: "model", icon: "terminal", argOptions: ["on", "off", "ask", "full"], aliases: ["elev"] },
  { name: "exec", description: "Set exec defaults (host security ask node).", args: "[host] [security] [ask] [node]", category: "model", icon: "terminal", argOptions: ["sandbox", "gateway", "node"] },

  // ---- info ----
  { name: "status", description: "Show current session status.", category: "tools", icon: "barChart" },
  { name: "usage", description: "Show token usage for this session.", category: "tools", icon: "barChart" },
  { name: "help", description: "Show available commands.", category: "tools", icon: "book", instant: true },
  { name: "commands", description: "List all slash commands.", category: "tools", icon: "book", instant: true },

  // ---- agents / subagents ----
  { name: "agents", description: "List thread-bound agents for this session.", category: "agents", icon: "monitor", instant: true },
  { name: "subagents", description: "List subagent runs for this session.", args: "[action]", category: "agents", icon: "folder" },
  { name: "kill", description: "Kill a running subagent (or all).", args: "[target]", category: "agents", icon: "x" },
  { name: "steer", description: "Inject a message into the active run.", args: "<message>", category: "agents", icon: "send", aliases: ["tell"] },
  { name: "redirect", description: "Abort and restart with a new message.", args: "<message>", category: "agents", icon: "refresh" },
];

const CATEGORY_ORDER: SlashCategory[] = ["session", "model", "tools", "agents"];

export const CATEGORY_LABELS: Record<SlashCategory, string> = {
  session: "Session",
  model: "Model",
  tools: "Tools",
  agents: "Agents",
};

const RUN_CONTROL_COMMANDS = new Set(["stop", "steer", "redirect", "kill", "new"]);
const HERMES_LOCAL_COMMANDS = new Set(["model", "models", "stop", "clear", "compact", "usage", "status", "new"]);
const NATIVE_RECOVERY_COMMANDS = new Set(["new"]);
const NATIVE_LOCAL_COMMANDS = new Set([
  "stop",
  "new",
  "clear",
  "model",
  "models",
  "status",
  "usage",
  "help",
  "commands",
]);

// /new 是故障恢复入口：即使旧轮次尚未收尾，也必须能切到一条不依赖旧 runtime 的空会话。
export function canRunSlashDuringTurn(commandName: string): boolean {
  return RUN_CONTROL_COMMANDS.has(commandName.replace(/^shoggoth:/, ""));
}

// Hermes 的大部分命令由官方 slash.exec 执行；共享控制命令在客户端走通用 RPC。
// /new 必须留在本地，否则 slash worker 会先恢复旧会话，凭证悬空时连新会话也建不出来。
export function shouldHandleSlashLocally(
  agentId: string,
  commandName: string,
  nativeAgent = false,
): boolean {
  if (nativeAgent) return NATIVE_LOCAL_COMMANDS.has(commandName);
  return !agentId.startsWith("hermes-") || HERMES_LOCAL_COMMANDS.has(commandName);
}

// A backend that advertises slash=false still needs the UI-owned `/new` escape
// hatch. The capability, not the backend id, determines whether to add it.
export function recoverySlashCommandsForBackend(
  slashSupported: boolean,
  catalog: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  return slashSupported
    ? []
    : catalog.filter((command) => NATIVE_RECOVERY_COMMANDS.has(command.name));
}

// Native runtimes do not expose a server-side slash worker, but several commands
// are implemented entirely by the shared chat UI and backend-neutral session RPCs.
// Keep this list deliberately narrower than SLASH_COMMANDS: every item here must
// work for an agentHarness backend without falling through to execSlash/chat.send.
export function nativeLocalSlashCommands(
  catalog: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  return catalog.filter((command) => NATIVE_LOCAL_COMMANDS.has(command.name))
    .map((command) => ({ ...command, source: "Shoggoth", execution: "client" }));
}

// Native names AND aliases own their spelling. Keep the application equivalent
// available under an explicit namespace instead of changing CLI semantics.
export function mergeNativeSlashCommands(server: SlashCommand[]): SlashCommand[] {
  const claimed = new Set(server.flatMap((command) => [command.name, ...(command.aliases || [])]));
  const extras = nativeLocalSlashCommands().map((command) => ({
    ...command,
    name: claimed.has(command.name) ? `shoggoth:${command.name}` : command.name,
    aliases: command.aliases?.filter((alias) => !claimed.has(alias)),
  }));
  return [...server, ...extras];
}

// Merge catalogs in priority order. The UI-owned shared command comes first so
// runtime aliases such as /model cannot bypass the backend-neutral session RPC.
export function mergeSlashCommands(...catalogs: SlashCommand[][]): SlashCommand[] {
  const seen = new Set<string>();
  return catalogs.flatMap((catalog) => catalog.filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  }));
}

// The composer shows the command palette only while the input is exactly a leading
// slash + partial command and no space yet ("/mod"). A trailing space means the
// command is chosen and the user is entering args (→ the arg-picker handles it).
// Returns the partial text after the slash, or null when the command menu should
// be closed. (Mirrors upstream views/chat.ts: value.match(/^\/(\S*)$/).)
/** A leading slash in a file path is ordinary chat text, not a command. */
export function isSlashCommandInput(input: string): boolean {
  return /^\/[a-z0-9_][a-z0-9:_-]*(?:\s|$)/i.test(input.trim());
}

export function slashQuery(input: string): string | null {
  const m = /^\/([a-z0-9_.:-]*)$/i.exec(input);
  return m ? m[1] : null;
}

// Parse "/cmd the partial-args" → { name, argPartial } when the command name is
// complete (a space follows it); null otherwise. Drives the arg-picker submenu.
export function slashArgQuery(input: string): { name: string; argPartial: string } | null {
  const m = /^\/([a-z0-9_][a-z0-9_.:-]*)\s(.*)$/i.exec(input);
  if (!m) return null;
  return { name: m[1].toLowerCase(), argPartial: m[2].trimStart() };
}

// Filter + sort the catalog for a partial query: name/alias prefix or description
// substring, then ordered by category, then by prefix match. (Array.sort is stable,
// so within a category the authored order is preserved.) `pool` lets ChatPage pass a
// merged (builtins + commands.list) catalog; defaults to the static builtins.
export function filterSlashCommands(
  query: string,
  pool: SlashCommand[] = SLASH_COMMANDS,
  describe: (command: SlashCommand) => string = (command) => command.description,
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? pool.filter(
        (c) =>
          c.name.startsWith(q) ||
          c.aliases?.some((a) => a.toLowerCase().startsWith(q)) ||
          c.description.toLowerCase().includes(q) ||
          describe(c).toLowerCase().includes(q),
      )
    : pool;
  return matched.slice().sort((a, b) => {
    if ((a.source === "Shoggoth") !== (b.source === "Shoggoth")) return a.source === "Shoggoth" ? 1 : -1;
    const ai = CATEGORY_ORDER.indexOf(a.category);
    const bi = CATEGORY_ORDER.indexOf(b.category);
    if (ai !== bi) return ai - bi;
    if (q) {
      const ax = a.name.startsWith(q) ? 0 : 1;
      const bx = b.name.startsWith(q) ? 0 : 1;
      if (ax !== bx) return ax - bx;
    }
    return 0;
  });
}

// Parse composer text ("/cmd the rest") into a recognized command + its argument
// string, or null when it isn't a known slash command (then it's sent as ordinary
// text). Matches by command name or alias (case-insensitive).
export function parseSlashInput(
  text: string,
  pool: SlashCommand[] = SLASH_COMMANDS,
): { command: SlashCommand; args: string } | null {
  const trimmed = text.trim();
  if (!/^\/[a-z0-9_][a-z0-9_.:-]*(?:\s|$)/i.test(trimmed)) return null;
  const body = trimmed.slice(1);
  const sep = body.search(/\s/);
  const rawName = (sep === -1 ? body : body.slice(0, sep)).toLowerCase();
  const args = sep === -1 ? "" : body.slice(sep + 1).trim();
  if (!rawName) return null;
  const command = pool.find(
    (c) => c.name === rawName || c.aliases?.some((a) => a.toLowerCase() === rawName),
  );
  return command ? { command, args } : null;
}
