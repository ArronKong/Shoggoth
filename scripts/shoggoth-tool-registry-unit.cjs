#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_TOOL_REGISTRY,
} = require("../app/agent-service/mcp-product-tool-controller");
const {
  PRODUCT_CAPABILITIES,
  PRODUCT_DOMAIN_NOTES,
  publicProductCapabilities,
} = require("../app/agent-service/product-capability-manifest");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { ToolRegistry } = require("../app/agent-service/tool-registry");
const { resolveServicePaths } = require("../app/agent-service/paths");

function inputs() {
  const tools = DEFAULT_TOOL_REGISTRY.list();
  return {
    capabilities: tools.map(({ definition, enabled, ...capability }) => structuredClone(capability)),
    definitions: tools.map(({ definition }) => {
      const { _meta, ...publicDefinition } = definition;
      return structuredClone(publicDefinition);
    }),
    domainNotes: structuredClone(PRODUCT_DOMAIN_NOTES),
    lifecycle: structuredClone(publicProductCapabilities().lifecycle),
  };
}

const registry = new ToolRegistry(inputs());
assert.match(registry.revision, /^[a-f0-9]{64}$/u);
const revision = registry.revision;
const mcp = registry.mcpDefinitions();
const ui = registry.publicProjection();
const markdown = registry.toolsMarkdown();
const developer = registry.developerSummary();
const visibleCapabilities = PRODUCT_CAPABILITIES.filter(({ modelVisible }) => modelVisible !== false);
assert.equal(mcp.length, visibleCapabilities.length);
assert.equal(registry.list().length, PRODUCT_CAPABILITIES.length);
assert.equal(ui.capabilities.length, mcp.length);
assert.equal(ui.revision, revision);
assert.equal(mcp.every((tool) => tool._meta["shoggoth/toolRegistryRevision"] === revision), true);
assert.match(markdown, new RegExp(revision, "u"));
assert.match(developer, new RegExp(revision, "u"));
assert.deepEqual(mcp.map((tool) => tool.name), ui.capabilities.map((tool) => tool.tool));
for (const hidden of ["external_agent_list", "external_agent_get", "external_agent_run"]) {
  assert.equal(registry.get(hidden)?.modelVisible, false, `${hidden} remains callable for old helpers`);
  assert.equal(mcp.some((tool) => tool.name === hidden), false);
  assert.equal(ui.capabilities.some((tool) => tool.tool === hidden), false);
  assert.equal(markdown.includes(hidden), false);
  assert.equal(developer.includes(hidden), false);
}
console.log("PASS MCP/UI/developer/TOOLS.md 四种投影来自同一 Registry revision");

const invalid = inputs();
invalid.definitions.pop();
assert.throws(() => registry.replace(invalid), TypeError);
assert.equal(registry.revision, revision, "无效更新必须在完整校验前保持旧 revision");
assert.equal(registry.mcpDefinitions().length, visibleCapabilities.length);
console.log("PASS Registry 更新失败原子保留完整旧 revision");

const permission = new PermissionEngine({ toolRegistry: registry });
const profile = { id: "profile-1", enabled: true };
assert.equal(permission.profileProjection(profile.id).tools.some(
  (tool) => tool.name === "external_agent_list",
), false);
assert.throws(() => permission.authorize({
  name: "cron_delete", profileId: profile.id, profile, confirmed: false,
}), (error) => error.code === "MCP_TOOL_CONFIRMATION_REQUIRED");
const confirmed = permission.authorize({
  name: "cron_delete", profileId: profile.id, profile, confirmed: true,
});
assert.equal(confirmed.toolRevision, registry.revision);
assert.throws(() => permission.authorize({
  name: "run_get", profileId: profile.id, profile,
  run: { profileId: "profile-2", workspace: "/workspace-a" },
}), (error) => error.code === "MCP_TOOL_FORBIDDEN");
assert.throws(() => permission.authorize({
  name: "run_get", profileId: profile.id, profile,
  run: { profileId: profile.id, workspace: "/workspace-a" }, workspace: "/workspace-b",
}), (error) => error.code === "MCP_TOOL_FORBIDDEN");
permission.setProfileOverride(profile.id, "run_get", "deny");
assert.throws(() => permission.authorize({
  name: "run_get", profileId: profile.id, profile,
}), (error) => error.code === "MCP_TOOL_FORBIDDEN");
console.log("PASS 外层权限覆盖确认、Profile/Run/workspace scope 与即时撤权");

const removed = inputs();
removed.capabilities = removed.capabilities.filter((tool) => tool.tool !== "run_get");
removed.definitions = removed.definitions.filter((tool) => tool.name !== "run_get");
registry.replace(removed);
assert.throws(() => permission.authorize({
  name: "run_get", profileId: profile.id, profile,
}), (error) => error.code === "MCP_TOOL_FORBIDDEN");
console.log("PASS active 调用边界读取当前 Registry，工具删除立即 fail closed");

const persistenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-tool-permission-"));
try {
  fs.chmodSync(persistenceRoot, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: persistenceRoot,
    stateRoot: path.join(persistenceRoot, "state"),
    profileRoot: path.join(persistenceRoot, "profile"),
    cacheRoot: path.join(persistenceRoot, "cache"),
  });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const persistentRegistry = new ToolRegistry(inputs());
  const first = new PermissionEngine({ toolRegistry: persistentRegistry, paths });
  first.open([profile.id]);
  first.setProfileOverride(profile.id, "run_get", "deny", 1);
  const persistedRevision = first.revision;
  first.close();
  const legacy = JSON.parse(fs.readFileSync(paths.toolPolicyPath, "utf8"));
  legacy.profiles[profile.id].browser_navigate = "deny";
  fs.writeFileSync(paths.toolPolicyPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const restarted = new PermissionEngine({ toolRegistry: persistentRegistry, paths });
  restarted.open([profile.id]);
  assert.equal(restarted.revision, persistedRevision + 1);
  const migrated = JSON.parse(fs.readFileSync(paths.toolPolicyPath, "utf8"));
  assert.equal(Object.hasOwn(migrated.profiles[profile.id], "browser_navigate"), false);
  assert.throws(() => restarted.authorize({
    name: "run_get", profileId: profile.id, profile,
  }), (error) => error.code === "MCP_TOOL_FORBIDDEN");
  assert.throws(() => restarted.setProfileOverride(
    profile.id, "run_get", "allow", persistedRevision - 1,
  ), (error) => error.code === "TOOL_PERMISSION_REVISION_CONFLICT");
  restarted.close();
  console.log("PASS per-Profile 撤权持久化、退役 Browser 权限迁移与旧 revision 冲突");
} finally {
  fs.rmSync(persistenceRoot, { recursive: true, force: true });
}
console.log("PASS shoggoth tool registry unit (5)");
