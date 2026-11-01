import type { McpApproval, McpConnectionRequest, McpFields, McpRegistryItem, McpRequestFields, McpSetupField, McpServer, McpTransport } from "../api/mcpConnectors";
import type { InteractiveRequestV1 } from "../types";

export const FIGMA_REGISTRY_NAME = "com.figma.mcp/mcp";
export const FIGMA_DESKTOP_URL = "http://127.0.0.1:3845/mcp";

export interface McpRecommendation {
  id: string; name: string; url?: string; docsUrl: string; registryName?: string;
  endpoints?: Array<{ url: string; label: { "zh-CN": string; en: string } }>;
  connectAllServices?: boolean;
  setup?: "oauth" | "oauth-client" | "token" | "none" | "instance" | "endpoint" | "local" | "api-key" | "restricted";
  transport?: Exclude<McpTransport, { kind: "remote" }>;
  envKey?: string;
  defaults?: { env?: Record<string, string> };
  fields?: Array<McpSetupField & { label?: { "zh-CN": string; en: string }; format?: "absolute-path" }>;
  clientSecretRequired?: boolean;
  requiresOAuthApp?: boolean;
  hidden?: boolean;
  supersededBy?: string;
  description: { "zh-CN": string; en: string };
  note?: { "zh-CN": string; en: string };
  setupSteps?: Array<{ "zh-CN": string; en: string }>;
}
export function mcpRecommendationText(value: McpRecommendation["description"], language = "en"): string {
  return language.startsWith("zh") ? value["zh-CN"] : value.en;
}
export function matchesMcpRecommendation(value: McpRecommendation, search: string): boolean {
  return [value.name, value.url, value.description.en, value.description["zh-CN"]].join(" ").toLowerCase().includes(search.trim().toLowerCase());
}
export function mcpRemoteUrlsMatch(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  // The store persists URL.href (including the root slash and normalized host/port).
  // Keep full URL identity: paths, query parameters and non-default ports still differ.
  try { return new URL(left).href === new URL(right).href; } catch { return false; }
}
export function mcpRegistryHasRemote(item: McpRegistryItem, url?: string): boolean {
  return !!url && item.options.some(option => option.transport.kind === "remote" && mcpRemoteUrlsMatch(option.transport.url, url));
}
export function mcpRecommendationMatchesServer(value: McpRecommendation, server: McpServer): boolean {
  const transport = server.transport;
  if (value.id === "ticketmaster") return server.recommendationId === "ticketmaster" && transport.kind === "stdio-command";
  if (value.id === "flightaware") return server.recommendationId === "flightaware" && transport.kind === "stdio-command";
  if (value.url) return transport.kind === "remote" && transport.protocol === "streamable-http"
    && [value.url, ...(value.endpoints || []).map(endpoint => endpoint.url)].some(url => mcpRemoteUrlsMatch(transport.url, url));
  if (value.transport?.kind === "stdio-command") {
    const expected = value.transport;
    if (!expected.command) return !!value.id && server.recommendationId === value.id && transport.kind === "stdio-command";
    return !!expected.command && transport.kind === "stdio-command"
      && (transport.command === expected.command || !expected.command.includes("/") && transport.command.split("/").at(-1) === expected.command)
      // Public server DTOs omit argv. This only selects the management dialog;
      // saving or launching still uses the backend's private transport record.
      && (transport.args === undefined || Array.isArray(transport.args)
        && transport.args.length === expected.args.length && transport.args.every((arg, index) => arg === expected.args[index]));
  }
  if (value.transport?.kind === "stdio-package") return transport.kind === "stdio-package" && transport.registryType === value.transport.registryType && transport.identifier === value.transport.identifier;
  return false;
}

export function mcpServiceGroupEndpoints(value?: McpRecommendation): NonNullable<McpRecommendation["endpoints"]> {
  return value?.connectAllServices && (value.endpoints?.length || 0) > 1 ? value.endpoints! : [];
}

export function mcpServiceGroupSummary(value: McpRecommendation, servers: McpServer[]) {
  const endpoints = mcpServiceGroupEndpoints(value);
  const members = servers.filter(server => mcpRecommendationMatchesServer(value, server));
  const matches = endpoints.map(endpoint => members.filter(server => server.transport.kind === "remote" && mcpRemoteUrlsMatch(server.transport.url, endpoint.url)));
  return { members, total: endpoints.length, ready: matches.filter(items => items.length === 1 && items[0].enabled && items[0].status === "ready").length,
    ambiguous: matches.some(items => items.length > 1) };
}

// Resolve explicit, non-secret package arguments before crossing the existing
// connector API. Never send placeholders or infer a broad filesystem root.
export function mcpRecommendationPackageTransport(recommendation: McpRecommendation, fields: McpFields, installed?: McpTransport): McpTransport {
  if (recommendation.transport?.kind !== "stdio-package") throw new Error("INVALID_JSON");
  const packageArgs = (recommendation.transport.packageArgs || []).map(argument => {
    const match = argument.match(/^\{([A-Za-z_][A-Za-z0-9_-]*)\}$/);
    if (!match) return argument;
    const field = recommendation.fields?.find(field => field.location === "argument" && field.name === match[1] && !field.secret);
    const value = fields.arguments?.[match[1]]?.trim();
    if (!field || !value || value.includes("\0") || field.format === "absolute-path" && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) {
      throw Object.assign(new Error("MCP_SETUP_REQUIRED"), { code: "MCP_SETUP_REQUIRED" });
    }
    return value;
  });
  return { ...recommendation.transport, ...(installed?.kind === "stdio-package" ? { version: installed.version } : {}), ...(recommendation.transport.packageArgs ? { packageArgs } : {}) };
}

// Only the known, unauthenticated desktop endpoint gets the simplified UI.
// A display name or another loopback service must never hide credential setup.
export function isFigmaDesktopConnector(server?: McpServer): boolean {
  return server?.source.kind === "custom" && server.auth?.kind === "none"
    && server.transport.kind === "remote" && server.transport.protocol === "streamable-http"
    && /^http:\/\/(?:127\.0\.0\.1|localhost):3845\/mcp\/?$/.test(server.transport.url);
}

export interface McpApprovalConversation {
  backendId: string;
  agentId: string;
  sessionId?: string;
}

export function mcpApprovalMatchesConversation(approval: McpApproval, conversation: McpApprovalConversation): boolean {
  return !!conversation.sessionId && approval.backendId === conversation.backendId
    && approval.agentId === conversation.agentId && approval.sessionId === conversation.sessionId;
}

const APPLE_APPROVAL_ACTIONS: Record<string, { resource: "calendar" | "reminders"; action: string; fallback: string }> = {
  apple_calendar_list: { resource: "calendar", action: "listCalendars", fallback: "List calendars" },
  apple_calendar_events: { resource: "calendar", action: "readEvents", fallback: "Read events" },
  apple_calendar_get: { resource: "calendar", action: "readEvent", fallback: "Read event" },
  apple_calendar_create: { resource: "calendar", action: "createEvent", fallback: "Create event" },
  apple_calendar_update: { resource: "calendar", action: "updateEvent", fallback: "Change event" },
  apple_calendar_delete: { resource: "calendar", action: "deleteEvent", fallback: "Delete event" },
  apple_reminders_lists: { resource: "reminders", action: "listReminderLists", fallback: "List reminder lists" },
  apple_reminders_search: { resource: "reminders", action: "readReminders", fallback: "Read reminders" },
  apple_reminders_get: { resource: "reminders", action: "readReminder", fallback: "Read reminder" },
  apple_reminders_create: { resource: "reminders", action: "createReminder", fallback: "Create reminder" },
  apple_reminders_update: { resource: "reminders", action: "updateReminder", fallback: "Change reminder" },
  apple_reminders_delete: { resource: "reminders", action: "deleteReminder", fallback: "Delete reminder" },
};

export function mcpApprovalDisplay(approval: McpApproval, translate?: (key: string) => string): { title: string; serverName: string; toolName: string } {
  const action = Object.hasOwn(APPLE_APPROVAL_ACTIONS, approval.toolName) ? APPLE_APPROVAL_ACTIONS[approval.toolName] : undefined;
  if (!action) return { title: approval.toolName, serverName: approval.serverId || "MCP", toolName: approval.toolName };
  const serverName = translate ? translate(`appleDevices.resources.${action.resource}.name`) : action.resource === "calendar" ? "Apple Calendar" : "Apple Reminders";
  const toolName = `${serverName} · ${translate ? translate(`appleDevices.approvalActions.${action.action}`) : action.fallback}`;
  return { title: toolName, serverName, toolName };
}

export function mcpApprovalPrompt(approval: McpApproval, translate?: (key: string) => string): InteractiveRequestV1 & { id: string } {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(approval.argumentsPreview);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
  } catch { /* Display the redacted preview separately, including any truncation. */ }
  const downstream = approval.toolName === "mcp_server_call" && typeof args.toolName === "string" ? args.toolName : undefined;
  const display = mcpApprovalDisplay(approval, translate);
  return {
    id: `external-mcp:${approval.requestId}:${approval.argumentDigest}`,
    version: 1, requestId: approval.requestId,
    // Display identity only: responses keep the broker's request and digest.
    runId: `external-mcp:${approval.requestId}`, kind: "mcp_permission",
    title: display.title, message: approval.reason, fields: [], approvalChoices: ["once", "deny"],
    approvalDetails: { serverName: display.serverName, toolName: downstream || display.toolName,
      input: downstream ? JSON.stringify(args.arguments ?? {}) : approval.argumentsPreview },
    expiresAt: approval.expiresAt,
  };
}

export function parseMcpStringMap(value: string): Record<string, string> {
  if (!value.trim()) return {};
  const result = JSON.parse(value);
  if (!result || Object.getPrototypeOf(result) !== Object.prototype || Object.keys(result).some(key => ["__proto__", "constructor", "prototype"].includes(key)) || Object.values(result).some(value => typeof value !== "string")) throw new Error("INVALID_JSON");
  return result;
}
export function parseMcpArguments(value: string): string[] {
  const result: unknown = JSON.parse(value);
  if (!Array.isArray(result) || result.some(value => typeof value !== "string")) throw new Error("INVALID_JSON");
  return result;
}
export function mcpFieldsFromInputs({ env, headers, definitions, values, includeDefaults = false }: {
  env: string; headers: string; definitions: McpSetupField[]; values: Record<string,string>; includeDefaults?: boolean;
}): McpFields {
  const fields: McpFields = {};
  if (env.trim()) fields.env = parseMcpStringMap(env);
  if (headers.trim()) fields.headers = parseMcpStringMap(headers);
  for (const field of definitions) {
    const value = values[`${field.location}:${field.name}`] ?? (includeDefaults ? field.default : undefined);
    if (value === undefined) continue;
    const key = field.location === "argument" ? "arguments" : field.location === "variable" ? "variables" : field.location === "env" ? "env" : field.location === "query" ? "query" : "headers";
    (fields[key] ||= {})[field.name] = value;
  }
  return fields;
}
export function mergeMcpRegistryItems(first: McpRegistryItem[], next: McpRegistryItem[]): McpRegistryItem[] {
  return [...new Map([...first, ...next].map(item => [`${item.registryName}@${item.version}`, item])).values()];
}
// Registry responses already contain only active/latest metadata. Match by
// publisher identity, never by a display label; discovering a version is read-only.
export function mcpAvailableUpdate(server: McpServer, items: McpRegistryItem[]): McpRegistryItem | undefined {
  if (server.source.kind !== "registry") return undefined;
  const name = server.source.registryName;
  const latest = [...items].reverse().find(item => item.registryName === name);
  return latest && latest.version !== server.source.version ? latest : undefined;
}
export function mcpRequestStatus(request: Pick<McpConnectionRequest,"status" | "expiresAt">, now = Date.now()): McpConnectionRequest["status"] {
  return request.status === "pending" && now >= request.expiresAt ? "expired" : request.status;
}
export function mcpRequestFields(request: Pick<McpConnectionRequest,"requiredFields">, values: Record<string,string>): McpRequestFields {
  const fields: McpRequestFields = {};
  for (const field of request.requiredFields) {
    const value = values[`${field.kind}:${field.name}`]; if (value === undefined) continue;
    const name = field.name.replace(/^(env|header|oauthClient)[.:]/, "");
    if (field.kind === "oauthClient") {
      const oauth = fields.oauthClient || {};
      if (name === "clientId" || name === "client_id") oauth.clientId = value;
      else if (name === "clientSecret" || name === "client_secret") oauth.clientSecret = value;
      else throw new Error("INVALID_JSON");
      fields.oauthClient = oauth;
    } else (field.kind === "env" ? fields.env ||= {} : fields.headers ||= {})[name] = value;
  }
  return fields;
}

export function canResolveMcpApproval(selected: McpApproval, latest: McpApproval | undefined, now = Date.now()): boolean {
  return !!latest && latest.requestId === selected.requestId && latest.argumentDigest === selected.argumentDigest
    && latest.expiresAt === selected.expiresAt && latest.backendId === selected.backendId
    && latest.agentId === selected.agentId && latest.sessionId === selected.sessionId
    && latest.toolName === selected.toolName && latest.serverId === selected.serverId
    && (selected.expiresAt === null || now < selected.expiresAt);
}
