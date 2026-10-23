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
  // A runtime can encode different answers or rules with the same approval kind.
  // Keep their meaning visible instead of replacing it with numbered presets.
  return option.label;
}

export function approvalOptionsNeedSelection(options: InteractiveApprovalOption[]): boolean {
  const keys = options.filter((option) => option.kind.startsWith("allow_")).map(labelKey);
  return new Set(keys).size < keys.length;
}

/** A choice as its control reads, never the internal choice id. */
export function approvalChoiceLabel(choice: string, t: Translate,
  options: InteractiveApprovalOption[] = [], permissions = false): string {
  const option = options.find((item) => item.choice === choice);
  if (option) return approvalOptionLabel(option, t, options);
  return choice === "once" ? t(permissions ? "chat.promptAllowTurn" : "chat.promptAllowOnce")
    : choice === "session" ? t("chat.promptAllowSession")
      : choice === "always" ? t("chat.promptAllowAlways")
        : choice === "deny" ? t("chat.promptDenyOperation")
          : choice === "cancel" ? t("common.cancel") : choice;
}

export function approvalOptionHint(option: InteractiveApprovalOption, t: Translate): string {
  const scope = displayScope(option);
  const key = scope && {
    tool: "chat.promptToolScopeHint",
    server: "chat.promptServerScopeHint",
    session_files: "chat.promptSessionFilesScopeHint",
    all_operations: "chat.promptAllOperationsScopeHint",
  }[scope];
  if (key) return t(key);
  return option.kind === "allow_always" ? `${option.label}\n${t("chat.promptAlwaysScopeHint")}` : option.label;
}
