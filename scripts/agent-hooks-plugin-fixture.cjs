"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { PluginStore, assertPluginCatalogBaseline } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { PluginDataRollback } = require("../app/agent-service/plugin-data-rollback");
const { PluginHookRegistry } = require("../app/agent-service/plugin-hook-registry");
const { HookStore } = require("../app/agent-service/hook-store");
const { HookService } = require("../app/agent-service/hook-service");
const { HookRunner } = require("../app/agent-service/hook-runner");
const { HookProcessHost } = require("../app/agent-service/hook-process-host");
const { HookToolExecution } = require("../app/agent-service/hook-tool-execution");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { resolveServicePaths } = require("../app/agent-service/paths");
const uuid = () => crypto.randomUUID(), hash = value => crypto.createHash("sha256").update(value).digest("hex");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, value, { mode: 0o600 }); };
async function fixture(t, { observer = false, dependency = false, compatibility = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hook-plugin-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  const plugins = new PluginStore({ paths }).open(), installer = new PluginPackageInstaller({ store: plugins });
  const resolver = new PluginComponentResolver({ store: plugins }), registry = new PluginHookRegistry({ store: plugins, resolver });
  const store = new HookStore({ paths }).open(); store.pluginHooks = registry;
  const host = new HookProcessHost({ store, cacheDir: paths.hookEphemeralDir }); assert.equal(await host.verify(), true);
  const runner = new HookRunner({ store, processHost: host });
  const profile = { id: "profile-one", runtime: "codex", enabled: true }, runs = new Map();
  const products = { getAgentProfile: id => id === profile.id ? profile : null };
  const service = new HookService({ store, runner, processHost: host, productStore: products, pluginHooks: registry,
    getRun: id => runs.get(id), toolRegistry: DEFAULT_TOOL_REGISTRY, cacheDir: paths.hookEphemeralDir,
    permissionEngine: new PermissionEngine({ toolRegistry: DEFAULT_TOOL_REGISTRY }), resolveToolIdentity: async () => [{ name: "business_tool" }] });
  const execution = new HookToolExecution({ service });
  const run = () => { const run = { id: uuid(), profileId: profile.id, source: "chat", workspace, status: "running" }; runs.set(run.id, run); return run; };
  const scope = run => ({ runId: run.id, assertCurrent() {}, signal: new AbortController().signal });
  const call = (name, args, actor = run(), confirmed = false) => service.handleTool(name, args,
    { profileId: profile.id, callId: uuid(), confirmation: confirmed }, scope(actor));
  const sourcePath = path.join(root, "package"), canary = path.join(root, "executed-at-install");
  write(path.join(sourcePath, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "living-rules" }));
  const script = compatibility ? "const input=JSON.parse(require('node:fs').readFileSync(0,'utf8')); console.log(JSON.stringify({decision:input.tool_input.amount>300?'block':'approve',reason:'兼容预算'}));" : observer ? "module.exports=e=>({tag:'lifecycle-observed'})"
    : "module.exports=e=>({decision:e.payload.arguments.amount>300?'block':'allow',reason:'生活预算'})";
  const dangerous = "require('node:fs').writeFileSync(" + JSON.stringify(canary) + ",'must not execute at install');module.exports=()=>({decision:'allow'})";
  write(path.join(sourcePath, "budget.cjs"), script); write(path.join(sourcePath, "dangerous.cjs"), dangerous);
  const rule = (name, relative, source) => ({ schemaVersion: 1, name,
    event: observer ? "run.completed" : "tool.before", kind: observer ? "observe" : "guard",
    scope: { workspace: "current", sources: ["chat"] }, matcher: observer ? {} : { toolScopes: ["product"], toolNames: ["business_tool"] },
    handler: { type: "script", language: "javascript", relativePath: relative, sha256: hash(source),
      ...(compatibility && relative === "budget.cjs" ? { compatibility: "claude-code-pretooluse-v1" } : {}) },
    ...(dependency ? { requiresConnections: ["local"] } : {}) });
  const document = { $schema: "https://shoggoth.app/schemas/hooks/1.0.0/plugin-hooks.schema.json",
    hooks: [rule("budget", "budget.cjs", script), rule("dangerous", "dangerous.cjs", dangerous)] };
  if (dependency) {
    write(path.join(sourcePath, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["./server.cjs"] } } }));
    write(path.join(sourcePath, "server.cjs"), "process.stdin.resume();");
  }
  write(path.join(sourcePath, "hooks.json"), JSON.stringify(document));
  const preview = installer.preview(sourcePath);
  let installed = installer.install({ sourcePath, previewDigest: preview.contentDigest, operationId: uuid(), expectedRevision: 0 });
  installed = plugins.setInstallationDesiredState({ installationId: installed.installationId, desiredState: "enabled", expectedRevision: installed.revision });
  t.after(async () => { await runner.close(); store.close(); plugins.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, workspace, plugins, installer, registry, store, host, runner, service, profile, run, scope, call,
    execution, sourcePath, canary, document, installed, writeDocument: () => write(path.join(sourcePath, "hooks.json"), JSON.stringify(document)) };
}
test("package preview/install never run code; headless tools test/grant/enable immutable plugin code and fence disable/update/restore", async t => {
  const f = await fixture(t); assert.equal(fs.existsSync(f.canary), false);
  const catalog = new PluginComponentCatalog({ store: f.plugins }).list(); assert.equal(catalog[0].components.filter(item => item.kind === "hook").length, 2);
  const actor = f.run(), items = (await f.call("hook_list", {}, actor)).items;
  const candidate = items.find(item => item.definition.name === "budget"); assert.equal(candidate.owner, "plugin");
  assert.equal(candidate.definition.handler.source, undefined);
  const full = await f.call("hook_get", { hookId: candidate.hookId }, actor); assert.match(full.source, /生活预算/);
  await assert.rejects(f.call("hook_update", { hookId: candidate.hookId, expectedRevision: 1, definition: {} }, actor), { code: "HOOK_FORBIDDEN" });
  assert.equal((await f.call("hook_test", { hookId: candidate.hookId, version: 1, payload: { arguments: { amount: 500 } } }, actor)).passed, true);
  await assert.rejects(f.call("hook_grant", { hookId: candidate.hookId, version: 1 }, actor), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  await f.call("hook_grant", { hookId: candidate.hookId, version: 1 }, actor, true);
  const enabled = await f.call("hook_enable", { hookId: candidate.hookId, version: 1, expectedRevision: candidate.revision }, actor);
  assert.equal(enabled.effectiveFrom, "next_run");
  const run = f.run(), snapshot = f.service.freezeRun(run, f.profile); assert.equal(snapshot.entries[0].owner, "plugin");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM versions").get().n, 0, "HookStore does not own plugin code versions");
  const stored = f.store.db.prepare("SELECT data FROM snapshots WHERE run_id=?").get(run.id).data;
  assert.doesNotMatch(stored, /module\.exports|budget\.cjs/);
  assert.doesNotMatch(f.store.db.prepare("SELECT result FROM operations").all().map(row => row.result).join(""), /module\.exports/);
  let calls = 0;
  const invoke = amount => f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
    args: { amount }, scope: f.scope(run), callId: uuid(), validateArguments: () => true }, async () => { calls++; return { status: "completed" }; });
  await assert.rejects(invoke(500), { code: "HOOK_BLOCKED" }); assert.equal(calls, 0);
  assert.equal((await invoke(100)).status, "completed"); assert.equal(calls, 1);
  f.store.close(); f.store.open(); assert.equal(f.store.snapshotForRun(run.id).entries[0].contentDigest, snapshot.entries[0].contentDigest);
  const danger = items.find(item => item.definition.name === "dangerous");
  assert.equal((await f.call("hook_test", { hookId: danger.hookId, version: 1, payload: {} }, actor)).passed, false);
  assert.equal(fs.existsSync(f.canary), false);
  f.installed = f.plugins.setInstallationDesiredState({ installationId: f.installed.installationId, desiredState: "disabled", expectedRevision: f.installed.revision });
  await assert.rejects(invoke(100), { code: "HOOK_REVOKED" }); assert.equal(calls, 1);
  f.installed = f.plugins.setInstallationDesiredState({ installationId: f.installed.installationId, desiredState: "enabled", expectedRevision: f.installed.revision });
  assert.equal(f.service.freezeRun(f.run(), f.profile).entries.length, 0, "rapid off/on does not restore a Hook grant");
  f.installed = f.plugins.setInstallationDesiredState({ installationId: f.installed.installationId, desiredState: "disabled", expectedRevision: f.installed.revision });
  f.document.hooks[0].priority = 100; f.writeDocument();
  const preview = f.installer.preview(f.sourcePath);
  f.installed = f.installer.install({ sourcePath: f.sourcePath, previewDigest: preview.contentDigest, operationId: uuid(), expectedRevision: f.installed.revision });
  f.installed = f.plugins.setInstallationDesiredState({ installationId: f.installed.installationId, desiredState: "enabled", expectedRevision: f.installed.revision });
  assert.equal(f.registry.candidates(f.profile.id, f.workspace).some(item => item.hookId === candidate.hookId), false);
  assert.equal(f.service.freezeRun(f.run(), f.profile).entries.length, 0, "new package requires its own test and exact grant");
  f.plugins.rotateAuthorityForRestore({ backupId: "fixture" });
  f.plugins.close(); assertPluginCatalogBaseline(f.paths); f.plugins.open();
  assert.equal(f.service.freezeRun(f.run(), f.profile).entries.length, 0);
  assert.equal(f.host.children.size, 0);
});
test("immutable package compatibility is explicit, hash-bound and normalized only in the sandbox Worker", async t => {
  const f = await fixture(t, { compatibility: true }); assert.equal(fs.existsSync(f.canary), false);
  const candidate = (await f.call("hook_list", {})).items.find(item => item.definition.name === "budget");
  assert.equal(candidate.definition.handler.compatibility, "claude-code-pretooluse-v1");
  const receipt = await f.call("hook_test", { hookId: candidate.hookId, version: 1, payload: { arguments: { amount: 500 } } });
  assert.equal(receipt.passed, true); assert.equal(receipt.output.decision, "block");
  await f.call("hook_grant", { hookId: candidate.hookId, version: 1 }, f.run(), true);
  await f.call("hook_enable", { hookId: candidate.hookId, version: 1, expectedRevision: candidate.revision });
  const run = f.run(); f.service.freezeRun(run, f.profile); let effects = 0;
  const invoke = amount => f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
    args: { amount }, scope: f.scope(run), callId: uuid(), validateArguments: () => true }, async () => { effects++; return { status: "completed" }; });
  await assert.rejects(invoke(500), { code: "HOOK_BLOCKED" }); assert.equal(effects, 0);
  assert.equal((await invoke(100)).status, "completed"); assert.equal(effects, 1);
});
test("plugin Hook JSON rejects external/native formats, bad source digests and package path escapes", async t => {
  const f = await fixture(t);
  for (const alter of [
    document => { document.hooks[0].handler.relativePath = "../budget.cjs"; },
    document => { document.hooks[0].handler.sha256 = "a".repeat(64); },
    document => { document.hooks[0].requiresConnections = ["not-declared"]; },
    document => { document.hooks[0].handler.compatibility = "auto-claude"; },
    document => { document.hooks[0].profileId = "another-profile"; },
  ]) {
    const copy = structuredClone(f.document); alter(copy);
    write(path.join(f.sourcePath, "hooks.json"), JSON.stringify(copy));
    assert.throws(() => f.installer.preview(f.sourcePath), { code: "PACKAGE_INVALID" });
  }
  write(path.join(f.sourcePath, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [] } }));
  assert.throws(() => f.installer.preview(f.sourcePath), { code: "PACKAGE_INVALID" });
  assert.equal(fs.existsSync(f.canary), false);
});

test("recovery drains a missing plugin observer while preserving other observers and the strict Run boundary", async t => {
  const f = await fixture(t, { observer: true }), actor = f.run();
  const candidate = (await f.call("hook_list", {}, actor)).items.find(item => item.definition.name === "budget");
  assert.equal((await f.call("hook_test", { hookId: candidate.hookId, version: 1, payload: {} }, actor)).passed, true);
  await f.call("hook_grant", { hookId: candidate.hookId, version: 1 }, actor, true);
  await f.call("hook_enable", { hookId: candidate.hookId, version: 1, expectedRevision: candidate.revision }, actor);
  const native = await f.call("hook_register", { definition: { schemaVersion: 1, name: "其他观察",
    event: "run.completed", kind: "observe", scope: { workspace: "current", sources: ["chat"] }, matcher: {},
    handler: { type: "builtin", name: "observe.record", config: {} } } }, actor);
  await f.call("hook_test", { hookId: native.hookId, version: 1, payload: {} }, actor);
  await f.call("hook_enable", { hookId: native.hookId, version: 1, expectedRevision: native.revision }, actor);
  const run = f.run(), snapshot = f.service.freezeRun(run, f.profile);
  const event = f.service.event(snapshot, run, "run.completed", "recover-observer", { status: "completed", contact: "synthetic@example.com" });
  f.store.enqueueEvent(snapshot, event);
  f.plugins.setInstallationDesiredState({ installationId: f.installed.installationId, desiredState: "disabled", expectedRevision: f.installed.revision });
  fs.rmSync(path.join(f.paths.pluginPackagesDir, f.installed.releaseDigest), { recursive: true, force: true });
  f.store.close(); f.store.open();
  assert.throws(() => f.store.snapshotForRun(run.id), { code: "PACKAGE_CHANGED" });
  f.runner.recoverObservers(); await f.runner.drain();
  assert.equal(f.runner.lastObserverError, "HOOK_PLUGIN_OBSERVER_UNAVAILABLE");
  assert.equal(f.store.pendingEvents().length, 0);
  const receipts = f.store.executions(f.profile.id, { runId: run.id }).items;
  assert.equal(receipts.length, 1); assert.equal(receipts[0].hookId, native.hookId); assert.equal(receipts[0].state, "settled");
  f.runner.recoverObservers(); await f.runner.drain(); assert.equal(f.store.executions(f.profile.id, { runId: run.id }).items.length, 1);
});

test("dependent plugin disconnect and reconnect cannot revive a frozen Hook grant", async t => {
  const f = await fixture(t, { dependency: true }), actor = f.run();
  const candidate = (await f.call("hook_list", {}, actor)).items.find(item => item.definition.name === "budget");
  await f.call("hook_test", { hookId: candidate.hookId, version: 1, payload: { arguments: { amount: 100 } } }, actor);
  await assert.rejects(f.call("hook_grant", { hookId: candidate.hookId, version: 1 }, actor, true), { code: "HOOK_PLUGIN_CONNECTION_REQUIRED" });
  const component = componentId(f.installed.installationId, "mcp-server", "local");
  const pending = f.plugins.createConnection({ connectionId: "living-dependency", installationId: f.installed.installationId,
    componentId: component, endpointIdentity: "fixture://local" });
  const connection = f.plugins.setConnectionIdentity({ connectionId: pending.connectionId, expectedRevision: pending.revision,
    principalIdentity: "synthetic-account", state: "ready" });
  const created = f.plugins.createBinding({ bindingId: "living-binding", profileId: f.profile.id, installationId: f.installed.installationId,
    componentId: component, connectionId: connection.connectionId });
  f.plugins.setBindingEnabled({ bindingId: created.bindingId, expectedRevision: created.revision, enabled: true });
  await f.call("hook_grant", { hookId: candidate.hookId, version: 1 }, actor, true);
  await f.call("hook_enable", { hookId: candidate.hookId, version: 1, expectedRevision: candidate.revision }, actor);
  const run = f.run(); f.service.freezeRun(run, f.profile);
  let calls = 0;
  const invoke = () => f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
    args: { amount: 100 }, scope: f.scope(run), callId: uuid(), validateArguments: () => true }, async () => { calls++; return { success: true }; });
  await invoke(); assert.equal(calls, 1);
  const disconnected = f.plugins.disconnectMcpConnection({ connectionId: connection.connectionId, expectedRevision: connection.revision });
  await assert.rejects(invoke(), { code: "HOOK_REVOKED" }); assert.equal(calls, 1);
  f.plugins.setConnectionIdentity({ connectionId: connection.connectionId, expectedRevision: disconnected.connection.revision,
    principalIdentity: "synthetic-account", state: "ready" });
  const disabled = f.plugins.getBinding(created.bindingId);
  f.plugins.setBindingEnabled({ bindingId: disabled.bindingId, expectedRevision: disabled.revision, enabled: true });
  await assert.rejects(invoke(), { code: "HOOK_REVOKED" });
  assert.throws(() => f.service.freezeRun(f.run(), f.profile), { code: "HOOK_REVOKED" }); assert.equal(calls, 1);
});

test("code rollback and data restore keep plugin Hooks disabled until new consent", async t => {
  const f = await fixture(t), actor = f.run();
  const candidate = (await f.call("hook_list", {}, actor)).items.find(item => item.definition.name === "budget");
  await f.call("hook_test", { hookId: candidate.hookId, version: 1, payload: { arguments: { amount: 100 } } }, actor);
  await f.call("hook_grant", { hookId: candidate.hookId, version: 1 }, actor, true);
  await f.call("hook_enable", { hookId: candidate.hookId, version: 1, expectedRevision: candidate.revision }, actor);
  f.installed = f.plugins.setInstallationDesiredState({ installationId: f.installed.installationId,
    expectedRevision: f.installed.revision, desiredState: "disabled" });
  const core = new PluginDataRollback({ store: f.plugins, drainInstallation: async () => { assert.equal(f.host.children.size, 0); } });
  const snapshot = await core.createSnapshot({ installationId: f.installed.installationId, expectedRevision: f.installed.revision, operationId: uuid() });
  const oldDigest = f.installed.releaseDigest;
  f.document.hooks[0].priority = 20; f.writeDocument();
  const preview = f.installer.preview(f.sourcePath);
  f.installed = f.installer.install({ sourcePath: f.sourcePath, previewDigest: preview.contentDigest, expectedRevision: f.installed.revision, operationId: uuid() });
  const codePreview = await core.previewCodeRollback({ installationId: f.installed.installationId, expectedRevision: f.installed.revision, targetDigest: oldDigest });
  const receipt = await core.rollbackCode({ preview: codePreview, operationId: uuid() });
  const dataPreview = await core.previewDataRestore({ installationId: receipt.installationId, expectedRevision: receipt.installationRevision,
    snapshotId: snapshot.snapshotId, snapshotDigest: snapshot.snapshotDigest });
  const restored = await core.restoreData({ preview: dataPreview, operationId: uuid(), approvedDataLoss: true });
  f.plugins.setInstallationDesiredState({ installationId: restored.installationId, expectedRevision: restored.installationRevision, desiredState: "enabled" });
  assert.equal(f.service.freezeRun(f.run(), f.profile).entries.length, 0);
  const rolledBack = await f.call("hook_get", { hookId: candidate.hookId }, actor);
  assert.equal(rolledBack.grantValid, false); assert.equal(rolledBack.activeVersion, null);
});
