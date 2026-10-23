"use strict";

// Fixture-only overlay for the official app-server. Keep production Host,
// provider/model selection, account authority and registered secrets intact.
const fs = require("node:fs"), path = require("node:path");
function fixtureError(code) { return Object.assign(new Error(code), { code }); }
const SHELL_FEATURES = Object.freeze(["shell_tool", "unified_exec"]);
const CONTEXT_GUARD_FEATURES = Object.freeze(["skip_host_skill_discovery"]);
const REQUIRED_CODE_HOST = Object.freeze({ enabled: true, disable_in_process_fallback: true });
const DISABLED_NATIVE_DELEGATION = Object.freeze({ enabled: false, max_concurrent_threads_per_session: 1 });
// The pinned Runtime forces these stable presentation/routing flags on. They
// do not add model tools; the production adapter has the same exact list.
const PRESENTATION_FEATURES = Object.freeze(["item_ids", "terminal_resize_reflow", "resize_all_images", "tool_search_always_defer_mcp_tools", "tui_app_server"]);
// Verified names from the pinned 0.159.2 feature inventory. The complete
// inventory is closed again for each thread before any model turn is allowed.
const EXTERNAL_OR_UNBOUNDED_FEATURES = Object.freeze(["view_image", "sleep_tool", "unified_exec_tty",
  "shell_zsh_fork", "unified_exec_zsh_fork", "shell_snapshot", "shell_snapshot_v2", "js_repl", "code_mode",
  "code_mode_buffered_exec", "code_mode_host", "code_mode_prewarm", "code_mode_only", "js_repl_tools_only",
  "web_search_request", "web_search_cached", "standalone_web_search", "search_tool", "hooks", "plugin_hooks",
  "request_permissions_tool", "worktrees", "multi_agent", "multi_agent_v2", "multi_agent_mode", "enable_fanout",
  "agent_message_board", "apps", "enable_mcp_apps", "tool_search", "tool_suggest", "recommended_plugins",
  "plugins", "in_app_browser", "in_app_chat", "in_app_dictation", "in_app_local_automation", "in_app_updates",
  "browser_use", "browser_use_full_cdp_access", "browser_use_external", "computer_use", "remote_plugin", "plugin_sharing"]);
function namedPermissionConfig({ workspace, writable = true, name = "owned-evaluation", disabledMcpNames = [] }) {
  if (!path.isAbsolute(workspace) || fs.realpathSync(workspace) !== workspace
    || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || !Array.isArray(disabledMcpNames)
    || disabledMcpNames.some(server => !/^[A-Za-z0-9_-]{1,128}$/.test(server) || server === "shoggoth"))
    throw fixtureError("CODEX_OWNED_PERMISSION_CONFIG_INVALID");
  const config = { default_permissions: name,
    [`permissions.${name}.filesystem`]: { ":root": "deny", ":minimal": "read", ":tmpdir": "deny", ":slash_tmp": "deny", [workspace]: writable ? "write" : "read" },
    [`permissions.${name}.network.enabled`]: false,
    "features.apps": false, "features.plugins": false, "features.remote_plugin": false,
    "features.memories": false, "memories.generate_memories": false, "memories.use_memories": false,
    "web_search": "disabled", "project_doc_max_bytes": 0 };
  for (const feature of EXTERNAL_OR_UNBOUNDED_FEATURES) config[`features.${feature}`] = false;
  // gpt-6.1-sol routes native group/shell tools through functions.exec. Keep
  // that host available while forbidding its in-process fallback.
  config["features.code_mode_host"] = { ...REQUIRED_CODE_HOST };
  config["features.multi_agent_v2"] = { ...DISABLED_NATIVE_DELEGATION };
  for (const server of disabledMcpNames) config[`mcp_servers.${server}.enabled`] = false;
  return config;
}
function ownedShellEnvironmentConfig({ tempDirectory, inheritedSetNames = [] }) {
  if (!path.isAbsolute(tempDirectory) || fs.realpathSync(tempDirectory) !== tempDirectory)
    throw fixtureError("CODEX_OWNED_SHELL_ENVIRONMENT_INVALID");
  if (!Array.isArray(inheritedSetNames) || inheritedSetNames.length > 2048 || new Set(inheritedSetNames).size !== inheritedSetNames.length
    || inheritedSetNames.some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name)))
    throw fixtureError("CODEX_OWNED_SHELL_ENVIRONMENT_INVALID");
  return { "shell_environment_policy.inherit": "none", "shell_environment_policy.ignore_default_excludes": false,
    "shell_environment_policy.include_only": [], "shell_environment_policy.exclude": ["*"],
    "shell_environment_policy.set": { ...Object.fromEntries(inheritedSetNames.map(name => [name, ""])),
      PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: tempDirectory, TERM: "dumb" } };
}
function ownedContextConfig({ instructionsFile, disabledSkillPaths = [] }) {
  if (!path.isAbsolute(instructionsFile) || fs.realpathSync(instructionsFile) !== instructionsFile || !fs.lstatSync(instructionsFile).isFile()
    || !Array.isArray(disabledSkillPaths) || disabledSkillPaths.length > 2048 || new Set(disabledSkillPaths).size !== disabledSkillPaths.length
    || disabledSkillPaths.some(file => !path.isAbsolute(file) || file.includes("\0")))
    throw fixtureError("CODEX_OWNED_CONTEXT_CONFIG_INVALID");
  return { project_doc_max_bytes: 0, developer_instructions: "", model_instructions_file: instructionsFile,
    "features.skip_host_skill_discovery": true, "skills.config": disabledSkillPaths.map(file => ({ path: file, enabled: false })), notify: [] };
}
function validateFeatures(features) {
  if (!Array.isArray(features) || features.length === 0 || features.length > 2048)
    throw fixtureError("CODEX_OWNED_FEATURE_INVENTORY_INVALID");
  const names = new Set();
  for (const feature of features) {
    if (!feature || !/^[a-z][a-z0-9_.]{0,127}$/.test(feature.name) || typeof feature.enabled !== "boolean" || names.has(feature.name))
      throw fixtureError("CODEX_OWNED_FEATURE_INVENTORY_INVALID");
    names.add(feature.name);
  }
  if ([...SHELL_FEATURES, ...CONTEXT_GUARD_FEATURES].some(name => !names.has(name))) throw fixtureError("CODEX_OWNED_SHELL_FEATURE_UNAVAILABLE");
  return features;
}
function boundedLocalFeatureConfig(features, { allowShell = true } = {}) {
  if (typeof allowShell !== "boolean") throw fixtureError("CODEX_OWNED_FEATURE_POLICY_INVALID");
  // The model's tool builder consumes flat per-feature overrides. A whole
  // `features` object can update the refreshed list while leaving model tools
  // active. Namespaced flags cannot be addressed by flat overrides; reject an
  // enabled one and verify every dotted entry remains off after thread start.
  const config = {};
  for (const feature of validateFeatures(features)) {
    if (feature.name.includes(".")) {
      if (feature.enabled) throw fixtureError("CODEX_OWNED_NAMESPACED_FEATURE_UNBOUNDED");
      continue;
    }
    config[`features.${feature.name}`] = feature.name === "code_mode_host" ? { ...REQUIRED_CODE_HOST }
      : feature.name === "multi_agent_v2" ? { ...DISABLED_NATIVE_DELEGATION }
      : CONTEXT_GUARD_FEATURES.includes(feature.name) || (allowShell && SHELL_FEATURES.includes(feature.name));
  }
  return config;
}
function assertOwnedFeatureInventory(features, { allowShell = true } = {}) {
  const permitted = boundedLocalFeatureConfig(features, { allowShell });
  // 0.159.2 reports unified_exec on even when disabled. The production
  // isolated-generation path proves it adds no tool with shell_tool off.
  if (features.some(feature => !PRESENTATION_FEATURES.includes(feature.name)
    && !(allowShell === false && feature.name === "unified_exec") && feature.enabled !== (feature.name === "code_mode_host" ? true
      : feature.name === "multi_agent_v2" ? false : permitted[`features.${feature.name}`] ?? false)))
    throw fixtureError("CODEX_OWNED_FEATURE_POLICY_UNVERIFIED");
  return true;
}
function tomlLiteral(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(tomlLiteral).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).map(([key, item]) => JSON.stringify(key) + "=" + tomlLiteral(item)).join(",") + "}";
  throw fixtureError("CODEX_OWNED_PERMISSION_VALUE_INVALID");
}
function permissionConfigArgs(config) { return Object.entries(config).flatMap(([key, value]) => ["-c", key + "=" + tomlLiteral(value)]); }
function wrapOwnedPermissionHost(host, config, evidence = []) {
  for (const method of ["threadStart", "threadResume"]) {
    const original = host[method].bind(host);
    host[method] = async (params, options) => {
      if (params.sandbox !== undefined && !["read-only", "workspace-write"].includes(params.sandbox))
        throw fixtureError("CODEX_OWNED_PERMISSION_LEGACY_POLICY_INVALID");
      const { sandbox, ...rest } = params;
      const input = { ...rest, config: { ...(params.config ?? {}), ...config } };
      evidence.push({ method, removedLegacySandbox: sandbox ?? null, modelProvided: Object.hasOwn(input, "model"),
        approvalPolicy: input.approvalPolicy ?? null, cwd: input.cwd ?? null, namedProfile: config.default_permissions });
      const response = await original(input, options);
      if (response.activePermissionProfile?.id !== config.default_permissions || response.activePermissionProfile.extends !== null)
        throw fixtureError("CODEX_OWNED_NAMED_PROFILE_UNVERIFIED");
      return response;
    };
  }
  return host;
}
module.exports = { namedPermissionConfig, ownedShellEnvironmentConfig, ownedContextConfig, boundedLocalFeatureConfig, assertOwnedFeatureInventory,
  permissionConfigArgs, wrapOwnedPermissionHost, tomlLiteral };
