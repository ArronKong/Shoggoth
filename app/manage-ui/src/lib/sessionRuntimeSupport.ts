// 会话 Runtime 支持码（Service 的 RUNTIME_SUPPORT_CODES）→ agents.* 文案 key。
// Service 对外只给这些码本身，界面负责翻译；未知码返回 null，由调用方决定兜底。
const SUPPORT_KEYS: Record<string, string> = {
  BINDING_DISABLED: "bindingDisabled",
  RUNTIME_NOT_INSTALLED: "sessionRuntimeNotInstalled",
  RUNTIME_RELEASE_DISABLED: "bindingRuntimeUnavailable",
  ACCOUNT_NOT_AUTHENTICATED: "sessionRuntimeAuthRequired",
  ACCOUNT_AUTH_UNKNOWN: "sessionRuntimeAuthUnknown",
  MODEL_ROUTE_UNSUPPORTED: "sessionRuntimeModelUnsupported",
  ATTACHMENT_UNSUPPORTED: "sessionRuntimeAttachmentUnsupported",
  PERMISSION_ENFORCEMENT_UNPROVEN: "sessionRuntimePermissionUnsupported",
  WORKSPACE_REQUIRED: "sessionRuntimeWorkspaceRequired",
  RUNTIME_FACTS_UNKNOWN: "sessionRuntimeFactsUnknown",
};

export function sessionRuntimeSupportKey(code: string | undefined): string | null {
  const key = code ? SUPPORT_KEYS[code] : undefined;
  return key ? `agents.${key}` : null;
}
