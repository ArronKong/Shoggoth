import type { InteractiveApprovalOption } from "../types";

type Translate = (key: string) => string;

export function approvalOptionIsVisible(option: InteractiveApprovalOption): boolean {
  // Keep the single canonical, one-time denial. Persistent denial is not a UI action.
  return option.kind.startsWith("allow_") || (option.kind === "reject_once" && option.choice === "deny");
}

function displayScope(option: InteractiveApprovalOption): InteractiveApprovalOption["scope"] {
  if (option.scope) return option.scope;
  // Grok can send this known label without a recognized scope ID. Localize it
  // for both new requests and existing pending cards; keep the native choice.
  if (option.kind === "allow_always" && option.label === "Yes, allow all edits during this session") {
    return "session_files";
  }
  return undefined;
}

function labelKey(option: InteractiveApprovalOption): string {
  const scope = option.kind === "allow_always" ? displayScope(option) : undefined;
  if (scope) return {
    tool: "chat.promptAllowTool",
    server: "chat.promptAllowServer",
    session_files: "chat.promptAllowSession",
    all_operations: "chat.promptAllowAllOperations",
  }[scope];
  // Provider wording can change independently of the protocol's approval kind.
  return {
    allow_once: "chat.promptAllowOnce",
    allow_always: "chat.promptAllowAlways",
    reject_once: "chat.promptDenyOperation",
    reject_always: "chat.promptDenyOperation",
  }[option.kind];
}

export function approvalOptionLabel(option: InteractiveApprovalOption, t: Translate,
  peers: InteractiveApprovalOption[] = [option]): string {
  const key = labelKey(option);
  const label = t(key);
  const alternatives = peers.filter((item) => labelKey(item) === key);
  if (alternatives.length < 2) return label;
  // Number different native rules that share a preset. The existing hover text
  // preserves their original scope, and each button retains its own choice.
  const index = alternatives.findIndex((item) => item.choice === option.choice);
  return index < 0 ? label : `${label} (${index + 1})`;
}

export function approvalOptionHint(option: InteractiveApprovalOption, t: Translate): string {
  const scope = displayScope(option);
  const key = scope && {
    tool: "chat.promptToolScopeHint",
    server: "chat.promptServerScopeHint",
    session_files: "chat.promptSessionFilesScopeHint",
    all_operations: "chat.promptAllOperationsScopeHint",
  }[scope];
  return key ? t(key) : option.label;
}
