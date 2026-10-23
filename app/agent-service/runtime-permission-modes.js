"use strict";

const { serviceError } = require("./security");

// These IDs are deliberately distinct from every legacy CLI mode. Old saved
// sessions and frozen recovery contracts retain their original restrictions.
const CHAT_PERMISSION_MODES = Object.freeze({
  ask: "request-approval", auto: "auto-review", full: "full-access",
});
const CHAT_MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: CHAT_PERMISSION_MODES.ask, label: "Request approval",
    description: "Ask you when an action needs approval.", risk: "standard" }),
  Object.freeze({ id: CHAT_PERMISSION_MODES.auto, label: "Approve for me",
    description: "Review actions automatically and ask you when needed.", risk: "elevated" }),
  Object.freeze({ id: CHAT_PERMISSION_MODES.full, label: "Full access",
    description: "Allow broad access to files, network, and tools.", risk: "danger", requiresConfirmation: true }),
]);

const MODE_CATALOGS = Object.freeze({
  codex: Object.freeze([
    Object.freeze({ id: "read-only", label: "Read only", description: "Read files without changing the workspace.", risk: "safe" }),
    Object.freeze({ id: "ask", label: "Ask", description: "Ask before commands that need broader access.", risk: "standard" }),
    Object.freeze({ id: "workspace-auto", label: "Workspace auto", description: "Automatically approve changes inside the workspace.", risk: "elevated" }),
    Object.freeze({ id: "full", label: "Full access", description: "Run without approval or sandbox restrictions.", risk: "danger", requiresConfirmation: true }),
  ]),
  "grok-build": Object.freeze([
    Object.freeze({ id: "ask", label: "Ask", description: "Ask before executing tools that need approval.", risk: "standard" }),
    Object.freeze({ id: "auto", label: "Auto", description: "Automatically handle safe actions and ask for risky ones.", risk: "elevated" }),
    Object.freeze({ id: "always-approve", label: "Always approve", description: "Approve all tool actions without prompting.", risk: "danger", requiresConfirmation: true }),
  ]),
  antigravity: Object.freeze([
    Object.freeze({ id: "plan", label: "Plan", description: "Inspect and plan without editing files.", risk: "safe" }),
    Object.freeze({ id: "accept-edits", label: "Accept edits", description: "Allow workspace edits and ask for broader access.", risk: "elevated" }),
    Object.freeze({ id: "full", label: "Full access", description: "Skip permission checks and sandbox restrictions.", risk: "danger", requiresConfirmation: true }),
  ]),
  pi: Object.freeze([
    Object.freeze({ id: "read-only", label: "Read only", description: "Read files without changing the workspace.", risk: "safe" }),
    Object.freeze({ id: "ask", label: "Ask", description: "Ask before commands that need broader access.", risk: "standard" }),
    Object.freeze({ id: "workspace-auto", label: "Workspace auto", description: "Automatically approve changes inside the workspace.", risk: "elevated" }),
    Object.freeze({ id: "full", label: "Full access", description: "Run without approval or sandbox restrictions.", risk: "danger", requiresConfirmation: true }),
  ]),
  "claude-code": Object.freeze([
    Object.freeze({ id: "default", label: "Default", description: "Ask when Claude Code requires permission.", risk: "standard" }),
    Object.freeze({ id: "acceptEdits", label: "Accept edits", description: "Automatically accept file edits in the workspace.", risk: "elevated" }),
    Object.freeze({ id: "auto", label: "Auto", description: "Automatically handle safe actions and ask for risky ones.", risk: "elevated" }),
    Object.freeze({ id: "dontAsk", label: "Don't ask", description: "Do not show permission prompts; unapproved actions are denied.", risk: "safe" }),
    Object.freeze({ id: "plan", label: "Plan", description: "Plan and inspect without editing files.", risk: "safe" }),
    Object.freeze({ id: "bypassPermissions", label: "Bypass", description: "Bypass all permission checks.", risk: "danger", requiresConfirmation: true }),
  ]),
  opencode: Object.freeze([
    Object.freeze({ id: "ask", label: "Ask", description: "Ask before OpenCode tool actions.", risk: "standard" }),
  ]),
  "deepseek-harness": Object.freeze([
    Object.freeze({ id: "workspace-write", label: "Workspace", description: "Allow workspace changes and ask before broader access.", risk: "standard" }),
    Object.freeze({ id: "danger-full-access", label: "Full access", description: "Run without approval or sandbox restrictions.", risk: "danger", requiresConfirmation: true }),
  ]),
});

function catalogFor(runtime) {
  return MODE_CATALOGS[runtime] || null;
}

function runtimePermissionModeOptions(runtime) {
  const workspaceExecution = ["antigravity", "pi", "opencode", "deepseek-harness"].includes(runtime);
  return catalogFor(runtime) ? CHAT_MODE_OPTIONS.map((option) => ({ ...option,
    ...(workspaceExecution && option.id === CHAT_PERMISSION_MODES.auto ? {
      description: "Automatically run workspace files and commands in a sandbox; ask before wider access.",
    } : {}),
  })) : [];
}

function isUnifiedPermissionMode(mode) {
  return Object.values(CHAT_PERMISSION_MODES).includes(mode);
}

function initialRuntimePermissionMode(runtime) {
  // Only creation uses this default. Saved session choices and legacy profile
  // policies continue through resolveRuntimePermissionMode unchanged.
  return catalogFor(runtime) ? CHAT_PERMISSION_MODES.auto : null;
}

// Adapter-facing IDs remain native to each integration; the public selection
// stays unchanged when the conversation switches Runtime.
function adapterPermissionMode(runtime, mode) {
  if (!isUnifiedPermissionMode(mode)) return mode;
  const index = Object.values(CHAT_PERMISSION_MODES).indexOf(mode);
  const modes = {
    codex: ["ask", "auto-review", "full"],
    "claude-code": ["default", "auto", "bypassPermissions"],
    "grok-build": ["ask", "auto", "always-approve"],
    antigravity: ["ask", "auto-review", "full"],
    pi: ["ask", "auto-review", "full"],
    opencode: ["ask", "auto-review", "full"],
    "deepseek-harness": ["workspace-write", "workspace-write", "danger-full-access"],
  };
  return modes[runtime]?.[index] ?? mode;
}

function unifiedPermission(runtime, mode) {
  const full = mode === CHAT_PERMISSION_MODES.full;
  const nativeMode = {
    codex: full ? "full" : mode === CHAT_PERMISSION_MODES.auto ? "auto_review" : "ask",
    "claude-code": adapterPermissionMode(runtime, mode),
    "grok-build": full ? "bypassPermissions" : mode === CHAT_PERMISSION_MODES.auto ? "auto" : "default",
    // ACP currently exposes default/auto_edit/yolo. Keep its approval gate
    // open and review in Shoggoth instead of claiming auto_edit is auto review.
    antigravity: full ? "yolo" : "default",
    pi: full ? "full" : "ask",
    opencode: "ask",
    "deepseek-harness": full ? "danger-full-access" : "workspace-write",
  }[runtime];
  return Object.freeze({ mode, nativeMode, permissionPolicy: policy(
    full && !["codex", "opencode"].includes(runtime) ? "never" : "on-request",
    // OpenCode's gate is an application permission policy, not an OS sandbox.
    runtime === "opencode" || full ? "danger-full-access" : "workspace-write",
  ) });
}

function defaultRuntimePermissionMode(runtime, permissionPolicy = {}) {
  const approval = permissionPolicy.approvalPolicy;
  const sandbox = permissionPolicy.sandbox;
  if (runtime === "grok-build") return approval === "never" ? "always-approve" : "ask";
  if (runtime === "antigravity") {
    if (sandbox === "read-only") return "plan";
    return sandbox === "danger-full-access" && approval === "never" ? "full" : "accept-edits";
  }
  if (runtime === "claude-code") {
    if (sandbox === "read-only") return "plan";
    if (sandbox === "danger-full-access" && approval === "never") return "bypassPermissions";
    return approval === "never" ? "acceptEdits" : "default";
  }
  if (runtime === "opencode") return "ask";
  if (runtime === "deepseek-harness") {
    return sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write";
  }
  if (runtime !== "codex" && runtime !== "pi") return "profile";
  if (sandbox === "read-only") return "read-only";
  if (sandbox === "danger-full-access" && approval === "never") return "full";
  return approval === "never" ? "workspace-auto" : "ask";
}

function policy(approvalPolicy, sandbox) {
  return Object.freeze({ approvalPolicy, sandbox });
}

function resolveRuntimePermissionMode(runtime, requestedMode, profilePermissionPolicy = {}) {
  const catalog = catalogFor(runtime);
  if (!catalog) {
    if (requestedMode && requestedMode !== "profile") {
      throw serviceError("CHAT_SESSION_PERMISSION_INVALID", `Unsupported permission mode for ${runtime}`);
    }
    return Object.freeze({
      mode: "profile",
      nativeMode: "profile",
      permissionPolicy: policy(profilePermissionPolicy.approvalPolicy, profilePermissionPolicy.sandbox),
    });
  }
  const mode = requestedMode || defaultRuntimePermissionMode(runtime, profilePermissionPolicy);
  if (isUnifiedPermissionMode(mode)) return unifiedPermission(runtime, mode);
  if (!catalog.some((option) => option.id === mode)) {
    throw serviceError("CHAT_SESSION_PERMISSION_INVALID", `Unsupported permission mode for ${runtime}`);
  }
  if (requestedMode == null) {
    const nativeMode = runtime === "grok-build"
      ? (mode === "always-approve" ? "bypassPermissions" : mode === "auto" ? "auto" : "default")
      : runtime === "antigravity"
        ? (mode === "full" ? "bypassPermissions" : mode)
        : mode;
    return Object.freeze({
      mode,
      nativeMode,
      permissionPolicy: policy(
        runtime === "codex" && profilePermissionPolicy.approvalPolicy === "never"
          ? "on-request" : profilePermissionPolicy.approvalPolicy,
        profilePermissionPolicy.sandbox,
      ),
    });
  }
  if (runtime === "grok-build") {
    const sandbox = ["read-only", "workspace-write", "danger-full-access"]
      .includes(profilePermissionPolicy.sandbox)
      ? profilePermissionPolicy.sandbox : "workspace-write";
    if (mode === "always-approve") return Object.freeze({ mode, nativeMode: "bypassPermissions", permissionPolicy: policy("never", sandbox) });
    return Object.freeze({ mode, nativeMode: mode === "auto" ? "auto" : "default", permissionPolicy: policy("on-request", sandbox) });
  }
  if (runtime === "antigravity") {
    if (mode === "plan") return Object.freeze({ mode, nativeMode: "plan", permissionPolicy: policy("never", "read-only") });
    if (mode === "full") return Object.freeze({ mode, nativeMode: "bypassPermissions", permissionPolicy: policy("never", "danger-full-access") });
    return Object.freeze({ mode, nativeMode: "accept-edits", permissionPolicy: policy("on-request", "workspace-write") });
  }
  if (runtime === "claude-code") {
    const mapped = {
      default: policy("on-request", "workspace-write"),
      acceptEdits: policy("on-request", "workspace-write"),
      auto: policy("on-request", "workspace-write"),
      dontAsk: policy("untrusted", "workspace-write"),
      plan: policy("never", "read-only"),
      bypassPermissions: policy("never", "danger-full-access"),
    };
    return Object.freeze({ mode, nativeMode: mode, permissionPolicy: mapped[mode] });
  }
  if (runtime === "deepseek-harness") {
    return mode === "danger-full-access"
      ? Object.freeze({ mode, nativeMode: mode, permissionPolicy: policy("never", "danger-full-access") })
      : Object.freeze({ mode, nativeMode: mode, permissionPolicy: policy("on-request", "workspace-write") });
  }
  if (runtime === "opencode") {
    return Object.freeze({ mode: "ask", nativeMode: "ask",
      permissionPolicy: policy("on-request", "danger-full-access") });
  }
  if (mode === "read-only") return Object.freeze({ mode, nativeMode: mode, permissionPolicy: policy("on-request", "read-only") });
  // Codex also uses the approval policy for MCP elicitation. "never" rejects
  // the helper's internal call-binding proof before it reaches Coordinator.
  // Keep the selected sandbox and let Coordinator validate the proof.
  const automaticApproval = runtime === "codex" ? "on-request" : "never";
  if (mode === "full") return Object.freeze({ mode, nativeMode: mode, permissionPolicy: policy(automaticApproval, "danger-full-access") });
  if (mode === "workspace-auto") return Object.freeze({ mode, nativeMode: mode, permissionPolicy: policy(automaticApproval, "workspace-write") });
  return Object.freeze({ mode, nativeMode: mode, permissionPolicy: policy("on-request", "workspace-write") });
}

module.exports = {
  CHAT_PERMISSION_MODES,
  adapterPermissionMode,
  defaultRuntimePermissionMode,
  initialRuntimePermissionMode,
  isUnifiedPermissionMode,
  resolveRuntimePermissionMode,
  runtimePermissionModeOptions,
};
