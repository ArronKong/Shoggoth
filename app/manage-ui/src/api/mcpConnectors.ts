import { jsonFetch } from "./client";

export type McpTransport = { kind: "remote"; protocol: "streamable-http" | "sse"; url: string }
  | { kind: "stdio-command"; command: string; args: string[]; cwd?: string }
  | { kind: "stdio-package"; registryType: "npm" | "pypi" | "oci"; identifier: string; version: string; packageArgs?: string[] };
export type McpFields = { arguments?: Record<string, string>; variables?: Record<string, string>; env?: Record<string, string>; headers?: Record<string, string>; query?: Record<string, string>; oauthClient?: { clientId: string; clientSecret?: string } };
export type McpRequestFields = Pick<McpFields, "env" | "headers"> & { oauthClient?: { clientId?: string; clientSecret?: string } };
export interface McpSetupField { name: string; location: "env" | "header" | "query" | "argument" | "variable"; required: boolean; secret: boolean; description?: string; default?: string }
export interface McpIcon { src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }
export interface McpRegistryItem { registryName: string; name: string; description: string; version: string; repositoryUrl?: string | null; websiteUrl?: string | null; icons?: McpIcon[];
  options: Array<{ id: string; transport: McpTransport; fields: McpSetupField[]; available?: boolean; errorCode?: string | null }> }
export interface McpRegistryPage { items: McpRegistryItem[]; nextCursor: string | null; featured: string[]; cachedAt: number }
export interface McpServer { id: string; name: string; enabled: boolean; createdAt: number; updatedAt: number;
  recommendationId?: "blender-lab" | "ticketmaster" | "flightaware";
  source: { kind: "custom" } | { kind: "registry"; registryName: string; version: string };
  transport: McpTransport; auth: { kind: "none" | "headers" | "oauth-dcr" | "oauth-client" };
  setup: { requiredFields: Array<string | McpSetupField>; configuredFields: string[] };
  status: "needsSetup" | "signedOut" | "checking" | "ready" | "failed" | "disabled";
  lastCheck: { at: number; toolCount: number; errorCode: string | null } | null; disabledProfileIds: string[];
  availableUpdate?: string | null }
export interface McpList { revision: number; servers: McpServer[] }
export interface McpSubject { profileId: string; backendId: string; agentId: string; label: string; enabled: boolean }
export interface McpMutation { revision: number; server: McpServer }
export interface McpToolDescription { name: string; description: string }
export interface McpToolList { id: string; available: boolean; items: McpToolDescription[]; totalCount: number; checkedAt: number | null }
export interface McpSignIn { signInId: string; status?: string; phase?: string; authorizationUrl?: string | null; url?: string | null; errorCode?: string | null; redirectUri?: string | null; flow?: "device" | "redirect"; userCode?: string | null; installationUrl?: string | null; expiresAt?: number }
export interface McpConnectionRequest { requestId: string; kind: "connection" | "secret" | "setup"; serverId: string | null; registryName: string | null; url: string | null;
  serverIds?: string[]; continuation?: "waiting" | "scheduled" | "unknown";
  title: string; purpose: string; status: "pending" | "completed" | "expired";
  requiredFields: Array<{ name: string; label: string; kind: "env" | "header" | "oauthClient" }>;
  expiresAt: number; createdAt: number; updatedAt: number }
export const MCP_CHANGE_EVENT = "shoggoth:mcp-connectors-changed";
const query = (input: object) => new URLSearchParams(Object.entries(input).filter(([,v]) => v !== undefined).map(([k,v]) => [k,String(v)])).toString();
const read = <T,>(name: string, input: object = {}, signal?: AbortSignal) => jsonFetch<T>(`/__api/connectors/mcp/${name}?${query(input)}`, { signal });
const write = <T,>(name: string, input: object) => jsonFetch<T>(`/__api/connectors/mcp/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then(result => { window.dispatchEvent(new Event(MCP_CHANGE_EVENT)); return result; });
export const listMcpConnectors = (signal?: AbortSignal) => read<McpList>("list", {}, signal);
export const listMcpTools = (id: string, signal?: AbortSignal) => read<McpToolList>("tools", { id }, signal);
export const listMcpSubjects = (signal?: AbortSignal) => read<{ items: McpSubject[]; unavailableBackends: string[] }>("subjects", {}, signal);
export const searchMcpRegistry = (search = "", cursor?: string, signal?: AbortSignal) => read<McpRegistryPage>("registry", { search, cursor }, signal);
export const addMcpConnector = (input: { source: McpServer["source"]; option: McpTransport | { id: string }; fields?: McpFields; expectedRevision: number; name?: string }) => write<McpMutation>("add", input);
export const importMcpConnectors = (config: string, expectedRevision: number) => write<McpList & { errors?: Array<{ name?: string; errorCode?: string }> }>("import", { config, expectedRevision });
export const rebindMcpConnector = (id: string, option: McpTransport, expectedRevision: number) => write<McpMutation>("rebind", { id, option, expectedRevision });
export const verifyMcpConnector = (id: string) => write<McpMutation>("verify", { id });
export const saveMcpCredentials = (id: string, fields: McpFields, expectedRevision: number) => write<McpMutation>("credentials", { id, fields, expectedRevision });
export const setMcpAgents = (id: string, disabledProfileIds: string[], expectedRevision: number) => write<McpMutation>("agents", { id, disabledProfileIds, expectedRevision });
export const updateMcpConnector = (id: string, version: string, expectedRevision: number) => write<McpMutation>("update", { id, version, expectedRevision });
export const removeMcpConnector = (id: string, expectedRevision: number) => write<{ revision: number }>("remove", { id, expectedRevision });
export const getMcpOAuthInfo = () => read<{ redirectUri: string }>("oauth-info");
export const startMcpSignIn = (id: string) => write<McpSignIn>("signin", { id });
export const getMcpSignIn = (signInId: string) => read<McpSignIn>("signin-status", { signInId });
export const cancelMcpSignIn = (signInId: string) => write<McpSignIn>("signin-cancel", { signInId });
export const listMcpRequests = (input: { agentId: string; sessionKey: string; backendId: string }, signal?: AbortSignal) => read<{ items: McpConnectionRequest[] }>("requests", input, signal);
export const completeMcpRequest = (input: { requestId: string; fields?: McpRequestFields; serverId?: string; expectedRevision?: number }) => write<McpConnectionRequest>("request-complete", input);
export function mcpPublicError(error: unknown): string { const code = (error as { code?: unknown })?.code; return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "MCP_CONNECTOR_REQUEST_FAILED"; }

export interface McpApproval { requestId: string; backendId: string; agentId: string; sessionId: string; toolName: string; serverId: string | null; argumentsPreview: string; argumentDigest: string; reason: string; createdAt: number; expiresAt: number | null }
export const listMcpApprovals = (signal?: AbortSignal) => read<{ items: McpApproval[]; generation: number }>("approvals", {}, signal);
export const resolveMcpApproval = (requestId: string, argumentDigest: string, approved: boolean) => write<{ resolved: true; approved: boolean }>("approval-resolve", { requestId, argumentDigest, approved });

const MCP_ERROR_KEYS: Record<string, string> = {
  FLIGHTAWARE_PYTHON_REQUIRED:"flightawarePython", FLIGHTAWARE_RATE_LIMITED:"flightawareRateLimit", FLIGHTAWARE_PLAN_REQUIRED:"flightawarePlan", FLIGHTAWARE_METERED_DISABLED:"flightawareMeteredDisabled",
  TICKETMASTER_PYTHON_REQUIRED:"ticketmasterPython", TICKETMASTER_RATE_LIMITED:"ticketmasterRateLimit",
  MCP_OAUTH_REGISTRATION_DENIED:"registrationDenied", MCP_SERVER_ACCESS_DENIED:"providerAccessDenied", CONNECTOR_UNAVAILABLE:"service",
  MCP_API_KEY_INVALID:"apiKeyInvalid", MCP_AUTH_REQUIRED:"auth", MCP_SIGN_IN_REQUIRED:"auth", MCP_OAUTH_CLIENT_REQUIRED:"client", MCP_OAUTH_CALLBACK_UNAVAILABLE:"callback", MCP_OAUTH_CALLBACK_INVALID:"oauth", MCP_OAUTH_DENIED:"denied", MCP_OAUTH_CANCELLED:"cancelled", MCP_OAUTH_EXPIRED:"expired", MCP_OAUTH_SESSION_NOT_FOUND:"expired", MCP_OAUTH_CLIENT_CHANGED:"oauthChanged", MCP_OAUTH_REDIRECT_CHANGED:"oauthChanged", MCP_OAUTH_REDIRECT_REJECTED:"oauth", MCP_OAUTH_FAILED:"oauth",
  MCP_REGISTRY_UNAVAILABLE:"registry", MCP_REGISTRY_RESPONSE_INVALID:"registry", MCP_REGISTRY_REQUEST_INVALID:"registry", MCP_REGISTRY_CURSOR_INVALID:"registry", MCP_REGISTRY_OPTION_INVALID:"catalogChanged", MCP_REGISTRY_ENTRY_INVALID:"catalogChanged", MCP_REGISTRY_ENTRY_UNAVAILABLE:"catalogChanged", MCP_REGISTRY_REVISION_CONFLICT:"conflict",
  MCP_REQUEST_ACK_UNKNOWN:"ackUnknown", MCP_CONNECTION_ACK_UNKNOWN:"ackUnknown", MCP_SERVER_RESULT_UNKNOWN:"resultUnknown", MCP_CONNECTOR_RESULT_UNKNOWN:"resultUnknown", MCP_REGISTRY_COMMIT_UNCERTAIN:"saveUnknown", MCP_CONNECTION_OWNER_UNCONFIRMED:"owner", MCP_REQUEST_ACCESS_DENIED:"owner", MCP_REQUEST_TARGET_MISMATCH:"target", MCP_REQUEST_EXPIRED:"requestExpired", MCP_CONNECTOR_REQUEST_EXPIRED:"requestExpired", MCP_REQUEST_NOT_FOUND:"requestExpired",
  MCP_CONNECTORS_UNAVAILABLE:"service", MCP_CONNECTION_HOST_UNAVAILABLE:"service", MCP_EXTERNAL_APPROVAL_UNAVAILABLE:"service", MCP_EXTERNAL_APPROVAL_EXPIRED:"approvalExpired", MCP_EXTERNAL_APPROVAL_INVALID:"approvalExpired", MCP_EXTERNAL_APPROVAL_DENIED:"denied", MCP_CONNECTOR_ACCESS_DENIED:"access", MCP_CONNECTOR_NOT_READY:"notReady",
  MCP_SERVER_PROBE_FAILED:"probe", MCP_SERVER_CONNECTION_FAILED:"network", MCP_SERVER_TIMEOUT:"timeout", MCP_SERVER_START_FAILED:"probe", MCP_SERVER_EXITED:"probe", MCP_CHECK_INTERRUPTED:"probe", MCP_SERVER_RESPONSE_INVALID:"probe", MCP_SERVER_RESPONSE_TOO_LARGE:"capacity", MCP_SERVER_PATH_INVALID:"path", MCP_SERVER_COMMAND_FORBIDDEN:"command", MCP_SERVER_URL_INVALID:"url", MCP_PACKAGE_VERSION_INVALID:"version", MCP_PACKAGE_INVALID:"version", MCP_PACKAGE_RUNTIME_MISSING:"runtime", MCP_REGISTRY_SECRET_ARGUMENT:"secretArgument", MCP_SETUP_REQUIRED:"setup", MCP_SECRET_INVALID:"credential", MCP_CREDENTIALS_LOCKED:"locked", MCP_CREDENTIAL_WRITE_FAILED:"locked", MCP_IMPORT_INVALID:"import", MCP_SERVER_NOT_FOUND:"missing", MCP_SERVER_ALREADY_EXISTS:"exists", OPEN_CONNECTOR_RETIRED:"retired",
};
export function formatMcpError(error: unknown, translate: (key: string) => string): string {
  const code = mcpPublicError(error);
  if (code.startsWith("APPLE_DEVICE_")) {
    const deviceErrors: Record<string, string> = {
      APPLE_DEVICE_ACCESS_DENIED: "accessDenied", APPLE_DEVICE_ACCESS_REVOKED: "revoked", APPLE_DEVICE_CONNECTION_REQUIRED: "connection",
      APPLE_DEVICE_AUTHORIZATION_DENIED: "denied", APPLE_DEVICE_PERMISSION_REQUIRED: "permission", APPLE_DEVICE_APPROVAL_REQUIRED: "approvalRequired",
      APPLE_DEVICE_APPROVAL_DENIED: "approvalDenied", APPLE_DEVICE_APPROVAL_EXPIRED: "approvalExpired", APPLE_DEVICE_APPROVAL_INVALID: "approvalExpired",
      APPLE_DEVICE_HOST_UNAVAILABLE: "unavailable", APPLE_DEVICE_UNAVAILABLE: "unavailable", APPLE_DEVICE_APPROVAL_UNAVAILABLE: "unavailable", APPLE_DEVICE_SUBJECTS_UNAVAILABLE: "unavailable",
      APPLE_DEVICE_CANCELLED: "cancelled", APPLE_DEVICE_CANCELED: "cancelled", APPLE_DEVICE_IDENTITY_REQUIRED: "identity", APPLE_DEVICE_PROFILE_INVALID: "identity",
      APPLE_DEVICE_REVISION_CONFLICT: "conflict", APPLE_DEVICE_CONFLICT: "changed", APPLE_DEVICE_CALL_CONFLICT: "changed", APPLE_DEVICE_READ_ONLY: "readOnly", APPLE_DEVICE_NOT_FOUND: "notFound",
      APPLE_DEVICE_WRITE_UNCERTAIN: "writeUncertain", APPLE_DEVICE_TIMEOUT: "writeUncertain", APPLE_DEVICE_FAILED: "writeUncertain",
    };
    return translate(`appleDevices.errors.${deviceErrors[code] || "failed"}`);
  }
  if (code === "MCP_REQUEST_PRIVATE_CHAT_REQUIRED") return translate("mcpConnectors.privateOnly");
  return translate(`mcpConnectors.errors.${MCP_ERROR_KEYS[code] || "fallback"}`);
}
