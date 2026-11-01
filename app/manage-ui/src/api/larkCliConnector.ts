import { jsonFetch } from "./client";

export interface LarkCliStatus {
  id: "lark-cli";
  revision: number;
  state: "notInstalled" | "installing" | "installed" | "removing" | "failed";
  stage: "downloadCli" | "downloadSkills" | "verify" | "installSkills" | null;
  version: string;
  installedVersion: string | null;
  skillCount: number;
  cliPath: string | null;
  canRemove: boolean;
  errorCode: string | null;
}
export const LARK_CLI_CHANGE_EVENT = "shoggoth:lark-cli-changed";
export const getLarkCliStatus = () => jsonFetch<LarkCliStatus>("/__api/connectors/lark/status");
export const changeLarkCli = (action: "install" | "remove", expectedRevision: number) =>
  jsonFetch<LarkCliStatus>(`/__api/connectors/lark/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision }),
  }).then(result => { window.dispatchEvent(new Event(LARK_CLI_CHANGE_EVENT)); return result; });

export interface LarkCliSetupStatus {
  state: "idle" | "starting" | "configuring" | "authorizing" | "ready" | "cancelled" | "failed";
  requestId: string | null;
  configured: boolean;
  appId: string | null;
  brand: "feishu" | "lark" | null;
  userName: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  qrCode: string | null;
  expiresAt: number | null;
  warning: "missingScopes" | null;
  errorCode: string | null;
}
export type LarkCliSetupInput = { expectedRevision: number; brand: "feishu" | "lark" } &
  ({ mode: "auto" | "reauthorize" } | { mode: "existing"; appId: string; appSecret: string });
export const getLarkCliSetup = () => jsonFetch<LarkCliSetupStatus>("/__api/connectors/lark/setup/status");
export const startLarkCliSetup = (input: LarkCliSetupInput) => jsonFetch<LarkCliSetupStatus>("/__api/connectors/lark/setup/start", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
});
export const cancelLarkCliSetup = (requestId: string) => jsonFetch<LarkCliSetupStatus>("/__api/connectors/lark/setup/cancel", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }),
});

export function larkCliErrorKey(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const keys: Record<string, string> = {
    LARK_CLI_REVISION_CONFLICT: "conflict", LARK_CLI_BUSY: "busy", LARK_CLI_UNSUPPORTED: "unsupported",
    LARK_CLI_DOWNLOAD_FAILED: "download", LARK_CLI_INTEGRITY_FAILED: "integrity",
    LARK_CLI_INTERRUPTED: "interrupted", LARK_CLI_SKILL_CONFLICT: "skills",
    LARK_CLI_OWNERSHIP_CONFLICT: "ownership", LARK_CLI_STATE_UNAVAILABLE: "state", LARK_CLI_INCOMPLETE: "incomplete",
    LARK_CLI_REMOVE_FAILED: "remove", LARK_CLI_UNAVAILABLE: "unavailable",
    LARK_CLI_NOT_INSTALLED: "notInstalled", LARK_CLI_SETUP_FAILED: "setup", LARK_CLI_CONFIG_EXISTS: "configExists",
    LARK_CLI_AUTH_FAILED: "auth", LARK_CLI_AUTH_EXPIRED: "expired", LARK_CLI_AUTH_CANCELLED: "cancelled",
    LARK_CLI_AUTH_STATUS_FAILED: "authStatus",
  };
  return typeof code === "string" && Object.hasOwn(keys, code) ? keys[code] : "failed";
}
export const matchesLarkCli = (query: string) => query.trim().toLowerCase().split(/\s+/u).every(word => "飞书 feishu lark larksuite cli".includes(word));
