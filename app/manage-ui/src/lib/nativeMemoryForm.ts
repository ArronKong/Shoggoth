import type { NativeMemorySettings, NativeMemorySharingSettings } from "../types";

export function memorySetting(config: NativeMemorySettings, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => value && typeof value === "object"
    ? (value as Record<string, unknown>)[key] : undefined, config);
}

// Update only the edited setting. Empty parents are pruned when inheritance is
// restored; settings belonging to other Agents and collapsed sections survive.
export function changeMemorySetting(config: NativeMemorySettings, path: readonly string[], value: unknown): NativeMemorySettings {
  if (!path.length || path.some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw Error("Invalid setting path");
  const next = structuredClone(config);
  let object = next as Record<string, unknown>;
  const parents: Array<[Record<string, unknown>, string]> = [];
  for (const key of path.slice(0, -1)) {
    if (!object[key] || typeof object[key] !== "object") object[key] = {};
    parents.push([object, key]); object = object[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (value === undefined) delete object[last]; else object[last] = value;
  for (const [parent, key] of parents.reverse()) {
    if (Object.keys(parent[key] as object).length) break;
    delete parent[key];
  }
  return next;
}

const activeAgentPath = ["plugins", "entries", "active-memory", "config"];

export function activeMemoryAgentSelected(config: NativeMemorySettings, profileId: string): boolean {
  const active = config.plugins?.entries?.["active-memory"]?.config;
  return (active?.agents === undefined || active.agents.includes(profileId))
    && !active?.excludedAgents?.includes(profileId);
}

// Exclusions preserve the default-all policy as new Profiles are created. A
// legacy allowlist stays explicit until the user chooses all Agents.
export function changeActiveMemoryAgent(config: NativeMemorySettings, profileId: string, enabled: boolean): NativeMemorySettings {
  const active = config.plugins?.entries?.["active-memory"]?.config;
  let next = config;
  if (enabled && active?.agents !== undefined && !active.agents.includes(profileId)) {
    next = changeMemorySetting(next, [...activeAgentPath, "agents"], [...active.agents, profileId]);
  }
  const excluded = active?.excludedAgents || [];
  const updated = enabled ? excluded.filter(id => id !== profileId) : [...new Set([...excluded, profileId])];
  return changeMemorySetting(next, [...activeAgentPath, "excludedAgents"], updated.length ? updated : undefined);
}

export function enableAllActiveMemoryAgents(config: NativeMemorySettings): NativeMemorySettings {
  return changeMemorySetting(changeMemorySetting(config, [...activeAgentPath, "agents"], undefined),
    [...activeAgentPath, "excludedAgents"], undefined);
}

export function sameMemorySettings(left: NativeMemorySettings, right: NativeMemorySettings): boolean {
  // Model-map order decides the winner when aliases collide. Other config
  // property order has no meaning and stays canonical for dirty detection.
  const canonical = (value: unknown, ordered = false): unknown => Array.isArray(value) ? value.map(item => canonical(item))
    : value && typeof value === "object" ? Object.fromEntries((ordered ? Object.entries(value)
      : Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      .map(([key, item]) => [key, canonical(item, key === "models")])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export const memoryEmbeddingProviders = ["none", "shoggoth-e5", "local", "openai", "gemini", "google", "voyage", "mistral", "bedrock", "ollama", "lmstudio", "openai-compatible"];
export const memoryProviderIdPattern = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const publicId = (value: unknown): value is string => typeof value === "string" && new RegExp(`^${memoryProviderIdPattern}$`, "u").test(value)
  && !["__proto__", "prototype", "constructor"].includes(value);
const transportHeaderNames = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "content-length", "te", "trailer", "upgrade"]);
const sensitiveHeaderName = /auth|cookie|token|api[-_]?key|password|secret|credential|signature|session|bearer|jwt/iu;
const sensitiveHeaderValue = /(?:^|\s)(?:bearer|basic|digest|token)\s+|(?:^|\b)(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{12,})/iu;
const plainRecord = (value: unknown): value is Record<string, unknown> => !!value && Object.getPrototypeOf(value) === Object.prototype;
export function validMemoryRemoteHeaders(value: unknown): value is Record<string, string> {
  if (!plainRecord(value) || Reflect.ownKeys(value).length > 128) return false;
  const seen = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(key)
      || sensitiveHeaderName.test(key) || transportHeaderNames.has(key.toLowerCase()) || ["__proto__", "prototype", "constructor"].includes(key) || seen.has(key.toLowerCase())) return false;
    seen.add(key.toLowerCase());
    const descriptor = Object.getOwnPropertyDescriptor(value, key), content = descriptor?.value;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || typeof content !== "string" || content.length > 4096
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content) || /[\u0000-\u001f\u007f]/u.test(content) || sensitiveHeaderValue.test(content)) return false;
  }
  return true;
}
// Invalid editor text stays in the draft and never crosses the save boundary.
export function parseMemoryRemoteHeaders(value: string): Record<string, string> | undefined | string {
  if (value === "") return undefined;
  if (value.trim() === "{}") return Object.fromEntries([]);
  const entries: Array<[string, string]> = [];
  for (const line of value.split(/\r?\n/u).filter(line => line.trim())) {
    const separator = line.indexOf(":");
    if (separator < 1) return value;
    entries.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  if (!entries.length || new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length) return value;
  const result = Object.fromEntries(entries);
  return validMemoryRemoteHeaders(result) ? result : value;
}
export function formatMemoryRemoteHeaders(value: unknown): string {
  if (typeof value === "string") return value;
  if (!plainRecord(value)) return "";
  return Object.keys(value).length === 0 ? "{}" : Object.entries(value).map(([key, content]) => `${key}: ${String(content)}`).join("\n");
}
export function effectiveMemorySearch(config: NativeMemorySettings, profileId: string) {
  const global = config.memory?.search || {}, override = profileId ? config.agents?.entries?.[profileId]?.memory?.search || {} : {};
  return { ...global, ...override, remote: { ...global.remote, ...override.remote,
    batch: { ...global.remote?.batch, ...override.remote?.batch } },
    multimodal: { ...global.multimodal, ...override.multimodal }, providerRefs: { ...global.providerRefs, ...override.providerRefs } };
}
export function validMemorySearchDraft(config: NativeMemorySettings): boolean {
  for (const search of [config.memory?.search, ...Object.values(config.agents?.entries || {}).map(entry => entry.memory?.search)]) {
    if (!search) continue;
    for (const id of [search.provider, search.fallback]) if (id !== undefined && !publicId(id)) return false;
    if (search.providerRefs !== undefined && (!plainRecord(search.providerRefs) || Object.keys(search.providerRefs).length > 128
      || Object.entries(search.providerRefs).some(([key, value]) => !publicId(key) || !publicId(value)))) return false;
    if (search.remote?.headers !== undefined && !validMemoryRemoteHeaders(search.remote.headers)) return false;
    if (search.remote?.baseUrl !== undefined) {
      if (typeof search.remote.baseUrl !== "string" || search.remote.baseUrl !== search.remote.baseUrl.trim()
        || /[\u0000-\u001f\u007f]/u.test(search.remote.baseUrl)) return false;
      let url: URL;
      try { url = new URL(search.remote.baseUrl); } catch { return false; }
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return false;
    }
  }
  for (const profile of ["", ...Object.keys(config.agents?.entries || {})]) {
    const search = effectiveMemorySearch(config, profile);
    if (search.multimodal.enabled !== true || search.multimodal.modalities?.length === 0) continue;
    if ((search.fallback ?? "none") !== "none" || !search.provider || ["none", "shoggoth-e5", "local"].includes(search.provider.toLowerCase())) return false;
    if (search.model !== undefined && typeof search.model !== "string") return false;
    const model = (search.model ?? "").trim().replace(/^(?:models\/(?:gemini\/|google\/)?|gemini\/|google\/)/u, "");
    if (!["gemini-embedding-2", "gemini-embedding-2-preview"].includes(model)) return false;
  }
  return true;
}

// The participant inventory comes from the Service. Store only exclusions so
// new enabled native Profiles participate without rewriting the saved policy.
export function memorySharingAgentSelected(config: NativeMemorySharingSettings, profileId: string): boolean {
  return !config.excludedProfiles.includes(profileId);
}
export function changeMemorySharingAgent(config: NativeMemorySharingSettings, profileId: string, included: boolean): NativeMemorySharingSettings {
  const excluded = new Set(config.excludedProfiles);
  if (included) excluded.delete(profileId); else excluded.add(profileId);
  return { enabled: config.enabled, excludedProfiles: [...excluded].sort() };
}
export function sameMemorySharingSettings(left: NativeMemorySharingSettings, right: NativeMemorySharingSettings): boolean {
  return left.enabled === right.enabled && JSON.stringify([...left.excludedProfiles].sort()) === JSON.stringify([...right.excludedProfiles].sort());
}
