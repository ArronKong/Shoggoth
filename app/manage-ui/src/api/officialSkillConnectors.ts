import { jsonFetch } from "./client";
import { MCP_CHANGE_EVENT } from "./mcpConnectors";

export type OfficialConnectorId = "doordash" | "shop" | "quark-drive" | "rollinggo-hotel" | "fliggy" | "meituan-paotui" | "weread" | "alipay" | "netease-music" | "baidu-maps";
export interface OfficialConnectorStatus {
  id: OfficialConnectorId; revision: number;
  state: "notInstalled" | "installing" | "installed" | "removing" | "failed";
  stage: "download" | "verify" | "installSkills" | "registerMcp" | null;
  version: string; installedVersion: string | null; skillCount: number;
  serverId: string | null; canRemove: boolean; errorCode: string | null;
}
export interface OfficialAccountStatus {
  id: OfficialConnectorId; state: "signedOut" | "authorizing" | "ready" | "unknown";
  verificationUrl: string | null; qrCode: string | null; userCode: string | null;
  userName: string | null; errorCode: string | null;
}
export const OFFICIAL_CONNECTORS_CHANGE_EVENT = "shoggoth:official-connectors-changed";
export const getOfficialConnectors = () => jsonFetch<{ items: OfficialConnectorStatus[] }>("/__api/connectors/official/status");
const post = <T,>(action: string, input: object) => jsonFetch<T>(`/__api/connectors/official/${action}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
});
export const changeOfficialConnector = (id: OfficialConnectorId, action: "install" | "remove", expectedRevision: number) =>
  post<OfficialConnectorStatus>(action, { id, expectedRevision }).then(result => {
    window.dispatchEvent(new Event(OFFICIAL_CONNECTORS_CHANGE_EVENT));
    window.dispatchEvent(new Event(MCP_CHANGE_EVENT)); return result;
  });
export const officialAccount = (id: OfficialConnectorId, expectedRevision: number, action: "status" | "start" | "bind" | "logout", code?: string) =>
  post<OfficialAccountStatus>("account", { id, expectedRevision, action, ...(code ? { code } : {}) });
export function officialConnectorErrorKey(error: unknown) {
  const code = (error as { code?: string })?.code || "";
  const suffix = code.replace(/^OFFICIAL_(?:SKILL_)?(?:CONNECTOR_)?/, "");
  if (code === "OFFICIAL_SKILL_CONFLICT") return "skillConflict";
  if (suffix === "APPROVAL_REQUIRED") return "approvalRequired";
  if (suffix === "PLATFORM_UNSUPPORTED") return "platform";
  if (suffix === "RATE_LIMITED") return "rateLimited";
  if (suffix === "PURCHASE_REVIEW_REQUIRED") return "purchaseReview";
  if (suffix === "QUARK_FAILED") return "quarkFailed";
  if (suffix === "QUARK_LIMITED") return "quarkLimited";
  if (suffix === "OPERATION_UNCERTAIN") return "uncertain";
  if (suffix === "SESSION_REQUIRED") return "sessionRequired";
  if (/REVISION_CONFLICT|BUSY/.test(suffix)) return "conflict";
  if (/DOWNLOAD/.test(suffix)) return "download";
  if (/INTEGRITY|OWNERSHIP|SKILL_CONFLICT/.test(suffix)) return "integrity";
  if (/UNSUPPORTED|RUNTIME/.test(suffix)) return "runtime";
  if (/AUTH|SECRET|SETUP|CREDENTIAL/.test(suffix)) return "auth";
  if (/INTERRUPTED/.test(suffix)) return "interrupted";
  if (/UNAVAILABLE/.test(suffix)) return "unavailable";
  return "failed";
}
