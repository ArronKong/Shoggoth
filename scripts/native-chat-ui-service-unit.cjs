#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { test } = require("node:test");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { fingerprintMcpToolCall, MCP_PRODUCT_TOOL_DEFINITIONS, validateMcpProductToolArguments, isNativeOnlyMcpTool } = require("../app/agent-service/mcp-product-tool-controller");
const c = require("../app/agent-service/chat-ui-contract");
const declaration = () => ({ sourceFile: "card.html", title: "方案比较", summary: "选择方案并调整参数", stateSchemaVersion: 1,
  stateSchema: { type: "object", properties: { selected: { type: "string", enum: ["A", "B", "C"] } }, required: ["selected"], additionalProperties: false },
  initialState: { selected: "A" }, actions: [{ actionId: "continue", kind: "continue_agent", label: "继续分析",
    instruction: "根据当前选择继续分析", stateFields: ["selected"] }] });
const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
async function fixture(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-ui-svc-"))); fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "card.html"), "<!doctype html><h1>原始冻结页面</h1>");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  let service;
  const open = async () => { service = createAgentService({ paths, safeStorage, ...options }); await service.start(); return service; };
  await open();
  const ipc = (method, params, version = SERVICE_PROTOCOL_VERSION) => requestService(paths,
    { id: crypto.randomUUID(), token: readClientToken(paths), version, method, params });
  await ipc("chat.ui.config.apply", { revision: 1, config: { nativeChatUiV1: true } });
  const created = await ipc("chat.session.create", { operationId: crypto.randomUUID(), profileId: DEFAULT_AGENT_PROFILE_ID, workspace, createdAt: Date.now() });
  const sessionKey = created.session.sessionKey;
  const binding = service.chatSessionStore.requestBinding(sessionKey, "ui-fixture-binding", Date.now());
  service.chatSessionStore.completeBinding(sessionKey, binding.operationId, "ui-fixture-runtime-session");
  const session = service.chatSessionStore.getSession(sessionKey), profile = service.productStore.getAgentProfile(session.profileId);
  const runId = `fixture-${crypto.randomUUID()}`;
  // Fixed Runtime fixture uses the actual issuer and current-run fencing. It
  // does not claim Provider acceptance; that is a separate live qualification.
  service.productStore.putWorkRun({ id: runId, source: "chat", sourceId: sessionKey, profileId: profile.id,
    workspace, idempotencyKey: `shoggoth:chat-send:${runId}`, status: "running", contextSnapshotId: null,
    runtimeSessionRef: null, runtimeTurnRef: null, eventSeq: 1, waitingRequestId: null,
    startedAt: Date.now(), finishedAt: null, resultSummary: null, errorCode: null, retryOf: null });
  service.hookService.freezeRun(service.productStore.getWorkRun(runId), profile);
  const lease = service.workRunCoordinator.hostCapabilityIssuer.issue({ identity: { runId, profileId: profile.id,
    bindingId: profile.runtimeProfileId, runtime: profile.runtime, runtimeAccountId: profile.runtimeAccountId,
    attemptId: "fixture-attempt", workspace }, validate: () => service.productStore.getWorkRun(runId)?.status === "running" });
  service.workRunCoordinator.runCapabilityLeases.set(runId, lease);
  service.workRunCoordinator.runExecutionContracts.set(runId, { borrowedMemoryRefs: [] });
  const scope = { runId, assertCurrent: () => service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId } }) };
  service.transcriptStore.appendEvent({ profileId: profile.id, sessionId: session.id, id: "fixture-user-source", runId,
    kind: "user", content: { text: "比较三个方案" }, runtimeRef: null, contextExcluded: false, occurredAt: Date.now() });
  const call = (name, args, callId = crypto.randomUUID()) => service.mcpProductToolController.handle(name, args, { profileId: profile.id, callId }, scope);
  const owner = { profileId: profile.id, sessionKey }, reference = part => ({ ...owner, artifactId: part.artifactId, revision: part.revision, sourceEventId: part.sourceEventId });
  const close = async () => {
    if (service.workRunCoordinator.runCapabilityLeases.has(runId)) {
      service.workRunCoordinator.hostCapabilityIssuer.revoke(lease); service.workRunCoordinator.runCapabilityLeases.delete(runId);
      service.workRunCoordinator.runExecutionContracts.delete(runId);
      const run = service.productStore.getWorkRun(runId);
      if (run?.status === "running") service.productStore.putWorkRun({ ...run, status: "completed", finishedAt: Date.now(), eventSeq: run.eventSeq + 1 });
    }
    await service.stop();
  };
  return { root, workspace, paths, open, close, ipc, call, owner, reference, runId, scope,
    get service() { return service; }, remove: async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
if (require.main === module) {
test("UI MCP discovery is store-free and rejects model-selected authority", () => {
  for (const name of ["render_ui", "update_ui", "get_ui_state"]) {
    assert.ok(MCP_PRODUCT_TOOL_DEFINITIONS.find(tool => tool.name === name)); assert.equal(isNativeOnlyMcpTool(name), true);
  }
  assert.equal(validateMcpProductToolArguments("render_ui", declaration()), true);
  for (const key of ["profileId", "sessionKey", "runId", "creatorAttemptId", "borrowedMemoryRefs"]) {
    assert.equal(validateMcpProductToolArguments("render_ui", { ...declaration(), [key]: "spoof" }), false);
  }
  const { spawnSync } = require("node:child_process");
  const probe = spawnSync(process.execPath, ["-e", 'require("./app/agent-service/mcp-product-tool-controller"); if (Object.keys(require.cache).some(p=>/\\/(?:product-store|chat-ui-store)\\.js$/.test(p))) process.exit(2)'], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
});
test("MCP reports disabled UI accurately and publishes after explicit enablement", async () => {
  const { createMcpStdioHandler, MCP_STDIO_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
  const f = await fixture(); let handler;
  try {
    await f.ipc("chat.ui.config.apply", { revision: 2, config: { nativeChatUiV1: false } });
    const errors = [];
    handler = createMcpStdioHandler({ runtimeProfileId: "ui-fixture-runtime", runtimeAccountId: "ui-fixture-account",
      sessionToken: Buffer.alloc(32, 0x39).toString("base64url"),
      requestService: async (_paths, request) => {
        assert.equal(request.method, "mcp.tool.call");
        try { return await f.call(request.params.name, request.params.arguments, request.params.callId); }
        catch (error) { errors.push(error.code); throw error; }
      } });
    await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ui-fixture", version: "1" } } });
    const call = id => handler({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "render_ui", arguments: declaration() } });
    const disabled = await call(2);
    assert.deepEqual(errors, ["UI_FEATURE_DISABLED"]);
    assert.equal(disabled.result.isError, true);
    assert.equal(disabled.result.structuredContent.error.code, "UI_FEATURE_DISABLED");
    assert.match(disabled.result.content[0].text, /交互卡片已停用/u);
    assert.equal(f.service.chatUiStore.publicationsForRecovery().length, 0);
    await f.ipc("chat.ui.config.apply", { revision: 3, config: { nativeChatUiV1: true } });
    const enabled = await call(3);
    assert.equal(enabled.result.isError, false, JSON.stringify(enabled));
    const part = enabled.result.structuredContent.part;
    assert.equal(part.title, declaration().title);
    const opened = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "enabled-after-disabled" });
    const read = await f.ipc("chat.ui.read", { ...f.owner, leaseId: opened.leaseId, offset: 0 });
    assert.equal(Buffer.from(read.data, "base64").toString(), "<!doctype html><h1>原始冻结页面</h1>");
    const events = f.service.transcriptStore.listEvents(f.owner.profileId, f.service.chatSessionStore.getSession(f.owner.sessionKey).id);
    assert.equal(events.filter(event => event.kind === "artifact").length, 1);
  } finally { handler?.close(); await f.remove(); }
});

test("real Service commits one canonical card, freezes source and preserves exact durable replay", async () => {
  const f = await fixture(); try {
    const args = declaration(), callId = crypto.randomUUID(), first = await f.call("render_ui", args, callId), part = first.part;
    fs.writeFileSync(path.join(f.workspace, "card.html"), "<h1>源文件已改写</h1>");
    assert.deepEqual(await f.call("render_ui", args, callId), first);
    await assert.rejects(f.call("render_ui", { ...args, title: "changed" }, callId), { code: "MCP_TOOL_STATE_CONFLICT" });
    const events = f.service.transcriptStore.listEvents(f.owner.profileId, f.service.chatSessionStore.getSession(f.owner.sessionKey).id);
    assert.equal(events.filter(event => event.kind === "artifact").length, 1);
    assert.equal(events.find(event => event.kind === "artifact").id, part.sourceEventId);
    const opened = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "mount-1" });
    const read = await f.ipc("chat.ui.read", { ...f.owner, leaseId: opened.leaseId, offset: 0 });
    assert.equal(Buffer.from(read.data, "base64").toString(), "<!doctype html><h1>原始冻结页面</h1>");
    const durable = f.service.productStore.lookupMcpToolCall({ profileId: f.owner.profileId, callId, name: "render_ui", fingerprint: fingerprintMcpToolCall("render_ui", args) });
    assert.equal(durable.status, "completed"); assert.equal(JSON.stringify(durable.binding).includes("<h1>"), false);
    await f.close(); await f.open();
    const restored = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "mount-after-restart" });
    const resumed = await f.ipc("chat.ui.read", { ...f.owner, leaseId: restored.leaseId, offset: 0 });
    assert.equal(resumed.htmlHash, read.htmlHash); assert.equal(resumed.data, read.data);
    const recoveredEvents = f.service.transcriptStore.listEvents(f.owner.profileId, f.service.chatSessionStore.getSession(f.owner.sessionKey).id);
    assert.equal(recoveredEvents.filter(event => event.kind === "artifact").length, 1);
  } finally { await f.remove(); }
});
test("confirmed state, window CAS, independent revision sources and strict RPC bounds", async () => {
  const f = await fixture(); try {
    const first = await f.call("render_ui", declaration()), part = first.part, ref = f.reference(part);
    const a = await f.ipc("chat.ui.open", { ...ref, mountId: "a" }), b = await f.ipc("chat.ui.open", { ...ref, mountId: "b" });
    await f.ipc("chat.ui.state.save", { ...f.owner, leaseId: a.leaseId, baseStateRevision: 0, patch: { selected: "B" } });
    await assert.rejects(f.ipc("chat.ui.state.save", { ...f.owner, leaseId: b.leaseId, baseStateRevision: 0, patch: { selected: "C" } }), { code: "UI_STATE_CONFLICT" });
    assert.equal((await f.ipc("chat.ui.renew", { ...f.owner, leaseId: b.leaseId })).state.selected, "B");
    const modelState = await f.call("get_ui_state", { artifactId: part.artifactId, revision: 1 }); assert.equal(modelState.state.selected, "B");
    const second = await f.call("update_ui", { ...declaration(), artifactId: part.artifactId, expectedRevision: 1, updateNote: "新版本" });
    assert.notEqual(second.part.sourceEventId, part.sourceEventId); assert.equal(second.part.revision, 2);
    assert.equal((await f.call("get_ui_state", { artifactId: part.artifactId, revision: 1 })).state.selected, "B");
    assert.equal((await f.call("get_ui_state", { artifactId: part.artifactId, revision: 2 })).state.selected, "A");
    await assert.rejects(f.ipc("chat.ui.open", { ...f.reference(second.part), sourceEventId: part.sourceEventId, mountId: "wrong" }), { code: "UI_SCOPE_MISMATCH" });
    await assert.rejects(f.ipc("chat.ui.read", { ...f.owner, leaseId: a.leaseId, offset: 0, actionId: "continue" }), { code: "UI_REQUEST_INVALID" });
    await assert.rejects(f.ipc("chat.ui.describe", ref, SERVICE_PROTOCOL_VERSION - 1), { code: "PROTOCOL_VERSION_MISMATCH" });
    await f.ipc("chat.ui.config.apply", { revision: 2, config: { nativeChatUiV1: false } });
    assert.equal((await f.ipc("chat.ui.describe", ref)).readOnlyReason, "UI_FEATURE_DISABLED");
    await assert.rejects(f.ipc("chat.ui.read", { ...f.owner, leaseId: a.leaseId, offset: 0 }), { code: "UI_SOURCE_EXPIRED" });
    assert.equal((await f.ipc("service.status", {})).healthy, true);
  } finally { await f.remove(); }
});
test("source path escape, symlink and unsupported schema are refused before publication", async () => {
  const f = await fixture(); try {
    fs.symlinkSync(path.join(f.workspace, "card.html"), path.join(f.workspace, "linked.html"));
    for (const sourceFile of ["../workspace/card.html", "linked.html", "/etc/passwd"]) {
      await assert.rejects(f.call("render_ui", { ...declaration(), sourceFile }), { code: "UI_REQUEST_INVALID" });
    }
    await assert.rejects(f.call("render_ui", { ...declaration(), stateSchema: { $ref: "https://example.com/schema" } }), { code: "UI_SCHEMA_INVALID" });
    assert.equal(f.service.chatUiStore.publicationsForRecovery().length, 0);
  } finally { await f.remove(); }
});
}
module.exports = { fixture, declaration, safeStorage };
