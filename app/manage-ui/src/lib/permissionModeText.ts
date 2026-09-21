import type { TFunction } from "i18next";
import type { ChatPermissionModeOption } from "../types";

// Match catalog prose exactly: runtimes can share a mode ID but describe different policies.
const permissionTextKeys = new Map<string, string>([
  ["Read only", "readOnly"],
  ["Guarded", "guarded"],
  ["Inherit", "inherit"],
  ["YOLO", "yolo"],
  ["Ask", "ask"],
  ["Workspace auto", "workspaceAuto"],
  ["Full access", "fullAccess"],
  ["Auto", "auto"],
  ["Always approve", "alwaysApprove"],
  ["Plan", "plan"],
  ["Accept edits", "acceptEdits"],
  ["Default", "default"],
  ["Don't ask", "dontAsk"],
  ["Bypass", "bypass"],
  ["Workspace", "workspace"],
  ["Read files without changing the workspace.", "readOnlyDescription"],
  ["Ask before sensitive commands or changes.", "guardedDescription"],
  ["Use the Hermes profile approval mode.", "inheritDescription"],
  ["Approve all tool actions for this session.", "yoloDescription"],
  ["Automatically allow changes inside the workspace.", "workspaceAllowDescription"],
  ["Ask before commands that need broader access.", "askCommandsDescription"],
  ["Automatically approve changes inside the workspace.", "workspaceAutoDescription"],
  ["Run without approval or sandbox restrictions.", "fullAccessDescription"],
  ["Ask before executing tools that need approval.", "askToolsDescription"],
  ["Automatically handle safe actions and ask for risky ones.", "autoDescription"],
  ["Approve all tool actions without prompting.", "alwaysApproveDescription"],
  ["Inspect and plan without editing files.", "inspectPlanDescription"],
  ["Allow workspace edits and ask for broader access.", "acceptWorkspaceEditsDescription"],
  ["Skip permission checks and sandbox restrictions.", "skipRestrictionsDescription"],
  ["Ask when Claude Code requires permission.", "defaultDescription"],
  ["Automatically accept file edits in the workspace.", "acceptEditsDescription"],
  ["Do not show permission prompts; unapproved actions are denied.", "dontAskDescription"],
  ["Plan and inspect without editing files.", "planDescription"],
  ["Bypass all permission checks.", "bypassDescription"],
  ["Allow workspace changes and ask before broader access.", "workspaceDescription"],
]);

export function localizePermissionMode(option: ChatPermissionModeOption, t: TFunction): ChatPermissionModeOption {
  const translate = (text: string) => {
    const key = permissionTextKeys.get(text);
    return key ? t(`chat.permissionModes.${key}`, { defaultValue: text }) : text;
  };
  return {
    ...option,
    label: translate(option.label),
    ...(option.description ? { description: translate(option.description) } : {}),
  };
}
