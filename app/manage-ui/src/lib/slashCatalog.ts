import type { SlashCatalogResponse } from "../types";
import type { SlashCommand } from "./slashCommands";

export interface SlashCatalogEntry {
  status: "loading" | "ready" | "unsupported" | "error";
  commands: SlashCommand[];
  message: string;
  fetchedAt: number;
}

export function mapServerSlashCommand(command: SlashCatalogResponse["commands"][number]): SlashCommand | null {
  const name = command.name.trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[a-z0-9_][a-z0-9._:-]*$/u.test(name)) return null;
  const category = ["session", "model", "tools", "agents"].includes(command.category || "")
    ? command.category as SlashCommand["category"] : "tools";
  return {
    name,
    description: command.description.replace(/\s+/gu, " ").trim() || "Native runtime command",
    ...(command.args ? { args: command.args.replace(/\s+/gu, " ").trim() } : {}),
    category,
    icon: "terminal",
    aliases: [...new Set((command.aliases || []).map((alias) => alias.trim().replace(/^\/+/, "").toLowerCase())
      .filter((alias) => /^[a-z0-9_][a-z0-9._:-]*$/u.test(alias) && alias !== name))],
    source: command.source,
    execution: command.execution,
  };
}

// Requests belong to the backend/agent/session scope, not to a render effect.
// Session events may refresh the menu while a request is pending; they must not
// invalidate its completion or leave a loading lock with no subscriber.
export class SlashCatalogStore {
  private entries: Record<string, SlashCatalogEntry> = {};
  private pending = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();

  constructor(private fetchCatalog: (
    agentId: string, backendId: string, sessionKey: string, signal: AbortSignal,
  ) => Promise<SlashCatalogResponse>, private now = Date.now) {}

  static key(agentId: string, backendId: string, sessionKey: string): string {
    return JSON.stringify([backendId, agentId, sessionKey]);
  }

  getSnapshot = () => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(key: string, entry: SlashCatalogEntry) {
    this.entries = { ...this.entries, [key]: entry };
    for (const listener of this.listeners) listener();
  }

  load(agentId: string, backendId: string, sessionKey: string, force = false): Promise<void> {
    const key = SlashCatalogStore.key(agentId, backendId, sessionKey);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const previous = this.entries[key];
    if (!force && previous && this.now() - previous.fetchedAt < 5_000) return Promise.resolve();
    this.set(key, {
      status: "loading", commands: previous?.commands || [], message: "", fetchedAt: this.now(),
    });
    const request = Promise.resolve()
      .then(() => this.fetchCatalog(agentId, backendId, sessionKey, AbortSignal.timeout(45_000)))
      .then((catalog) => {
        this.set(key, {
          status: catalog.supported ? "ready" : "unsupported",
          commands: catalog.supported ? catalog.commands.map(mapServerSlashCommand)
            .filter((command): command is SlashCommand => command !== null) : [],
          message: catalog.reason || "",
          fetchedAt: this.now(),
        });
      })
      .catch((error: unknown) => {
        this.set(key, {
          status: "error", commands: previous?.commands || [],
          message: error instanceof Error ? error.message : String(error), fetchedAt: this.now(),
        });
      })
      .finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }
}
