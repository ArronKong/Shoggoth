"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { GroupActivityProjection, validGroupActivity } = require("../app/agent-service/group-activity");
const { GroupDraftTracker } = require("../app/agent-service/group-drafts");
const { GroupNativeExecutor } = require("../app/agent-service/group-native-executor");
const { GroupNativeToolExposure } = require("../app/agent-service/group-native-tool-exposure");
const { probeGroupNativeToolSupport } = require("../app/agent-service/group-native-capability-probe");
const { groupCapabilities, nativeCapabilities, validGroupCapabilities } = require("../app/agent-service/group-capabilities");
const { RuntimeAdapterRegistry } = require("../app/agent-service/runtime-adapter-registry");
const { createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { HermesInspirationAdapter } = require("../app/core/hermes-inspiration-adapter");
const { OpenClawInspirationAdapter } = require("../app/core/openclaw-inspiration-adapter");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const binding = { groupId: "g", discussionId: "d", memberId: "m", opportunityId: "o", runId: "r", executionGeneration: "f1:r" };
const event = (seq, type, payload = {}, extra = {}) => ({ seq, type, payload, ...extra });
function projection() {
  let now = 100;
  const p = new GroupActivityProjection(binding, { now: () => now }); p.setStream("s1");
  return { p, advance: time => { now += time; } };
}

test("explicit compaction Run events retain a bounded receipt through resumed work and terminal fences", () => {
  const { p, advance } = projection();
  p.observeEvents([event(1, "status", { status: "compacting", text: "untrusted status detail" })], "s1");
  assert.equal(p.snapshot().phase, "compacting");
  assert.deepEqual(p.snapshot().compaction, { status: "compacting", eventSeq: 1, observedAt: 100, lastObservedAt: 100 });
  const progress = p.snapshot().lastProgressAt; advance(10);
  p.observeEvents([event(2, "status", { status: "compacting" })], "s1");
  p.observeStatus("running");
  assert.equal(p.snapshot().phase, "compacting");
  assert.equal(p.snapshot().lastProgressAt, progress, "polling and duplicate phase are not business progress");
  p.observeEvents([event(3, "status", { status: "compacted" })], "s1");
  assert.equal(p.snapshot().phase, "compacted");
  const receipt = p.snapshot().compaction;
  assert.deepEqual(receipt, { status: "compacted", eventSeq: 3, observedAt: 110, lastObservedAt: 110 });
  p.observeEvents([event(4, "tool.start", { toolCallId: "t", tool: { name: "read_file" } })], "s1");
  assert.equal(p.snapshot().phase, "tool"); assert.deepEqual(p.snapshot().compaction, receipt);
  p.observeStatus("completed"); advance(10);
  p.observeEvents([event(5, "status", { status: "compacting" })], "s1");
  assert.equal(p.snapshot().phase, "completed"); assert.deepEqual(p.snapshot().compaction, receipt);
  assert.ok(validGroupActivity(p.snapshot()));
  assert.equal(JSON.stringify(p.snapshot()).includes("untrusted status detail"), false);
});

test("compaction rejects foreign identity and retired streams; old host activity remains valid", () => {
  const { p } = projection();
  assert.equal(Object.hasOwn(p.snapshot(), "compaction"), false, "unobserved compaction keeps the prior wire shape");
  p.observeEvents([event(1, "status", { status: "compacting" }, { runId: "foreign" })], "s1");
  assert.equal(p.snapshot().phase, "preparing");
  p.observeEvents([event(1, "status", { status: "compacted" })], "s1");
  const legacy = p.snapshot(); delete legacy.compaction;
  assert.ok(validGroupActivity(legacy));
  assert.equal(validGroupActivity({ ...p.snapshot(), compaction: { status: "compacting", eventSeq: 3, observedAt: 100, lastObservedAt: 100 } }), false);
  assert.equal(validGroupActivity({ ...p.snapshot(), compaction: { ...p.snapshot().compaction, text: "not a public field" } }), false);
  assert.equal(validGroupActivity({ ...p.snapshot(), extra: true }), false);
  p.setStream("s2");
  assert.equal(p.snapshot().compaction, undefined, "a receipt cannot cross stream generations");
  p.observeEvents([event(100, "status", { status: "compacting" })], "s1");
  assert.equal(p.snapshot().compaction, undefined);
});

test("public native tool descriptors retain display args, result, error and duration without using output as terminal evidence", () => {
  const { p, advance } = projection();
  p.observeEvents([event(1, "tool.start", { toolCallId: "t", tool: { name: "exec_command", displayArgs: { title: "运行验证", cmd: "node test.cjs" } } })], "s1");
  assert.equal(p.snapshot().phase, "tool"); assert.equal(p.snapshot().title, "运行验证");
  advance(20);
  p.observeEvents([event(2, "tool.result", { toolCallId: "t", tool: { status: "failed", errorCode: "EXIT_1", resultSummary: "", durationMs: 20 } })], "s1");
  const activity = p.snapshot();
  assert.equal(activity.phase, "running", "tool failure is not Run failure");
  assert.equal(activity.recentTools[0].status, "failed"); assert.equal(activity.recentTools[0].finishedAt, 120);
  assert.equal(activity.recentTools[0].input.cmd, "node test.cjs"); assert.equal(activity.recentTools[0].output, "");
  assert.ok(validGroupActivity(activity));
});

test("events are ordered/deduplicated and foreign Run/stream events never advance the cursor", () => {
  const { p } = projection();
  p.observeEvents([event(3, "text.delta", { delta: "C" }), event(1, "text.delta", { delta: "A" }),
    event(2, "text.delta", { delta: "B" }), event(100, "text", { text: "foreign" }, { runId: "other" })], "s1");
  assert.equal(p.draft(), "ABC"); assert.equal(p.snapshot().eventSeq, 3);
  p.observeEvents([event(2, "text.delta", { delta: "duplicate" }), event(4, "text", { text: "bad" }, { streamId: "old" })], "s1");
  assert.equal(p.draft(), "ABC"); assert.equal(p.snapshot().eventSeq, 3);
});

test("completed tool/Run never resurrect from late progress; empty output is still a completed tool", () => {
  const { p, advance } = projection();
  p.observeEvents([event(1, "tool.start", { toolCallId: "t", tool: { name: "read_file" } }),
    event(2, "tool.result", { toolCallId: "t", tool: {} })], "s1");
  const progress = p.snapshot().lastProgressAt; advance(200);
  p.observeEvents([event(3, "tool.update", { toolCallId: "t", message: "late" }),
    event(4, "tool.result", { toolCallId: "t", tool: {} })], "s1");
  assert.equal(p.snapshot().lastProgressAt, progress); assert.equal(p.snapshot().recentTools[0].status, "completed");
  p.observeEvents([event(5, "terminal", { status: "completed" })], "s1");
  p.observeEvents([event(6, "tool.start", { toolCallId: "new", tool: { name: "exec" } })], "s1");
  assert.equal(p.snapshot().phase, "completed");
});

test("heartbeat, polling, reasoning and identical tool updates do not refresh lastProgressAt", () => {
  const { p, advance } = projection(); p.observeStatus("running");
  const at = p.snapshot().lastProgressAt; advance(100);
  p.observeStatus("running"); p.observeEvents([event(1, "heartbeat"), event(2, "reasoning.delta", { delta: "private" })], "s1");
  assert.equal(p.snapshot().lastProgressAt, at);
  p.observeEvents([event(3, "tool.update", { toolCallId: "t", tool: { name: "read" }, progress: { stage: "one" } })], "s1");
  const toolAt = p.snapshot().lastProgressAt; advance(100);
  p.observeEvents([event(4, "tool.update", { toolCallId: "t", tool: { name: "read" }, progress: { stage: "one" } })], "s1");
  assert.equal(p.snapshot().lastProgressAt, toolAt);
});

test("new stream generation drops old cursor/text; retired generations cannot replace the new stream", () => {
  const { p } = projection(); p.observeEvents([event(8, "text", { text: "old" })], "s1");
  p.observeEvents([event(1, "text", { text: "new" })], "s2");
  assert.equal(p.draft(), "new"); assert.equal(p.snapshot().eventSeq, 1);
  assert.equal(p.observeEvents([event(9, "text", { text: "late old" })], "s1"), false);
  assert.equal(p.draft(), "new");
});

test("tools redact credentials and bound details; private reasoning never becomes a draft", () => {
  const { p } = projection();
  p.observeEvents([event(1, "text", { text: "private", phase: "analysis" }), event(2, "tool.start", {
    toolCallId: "t", tool: { name: "exec", input: { title: "核对配置", api_key: "secret", command: "x".repeat(8000) } },
  })], "s1");
  assert.equal(p.draft(), null); assert.equal(p.snapshot().tool.input.api_key, "[已隐去]");
  assert.ok(Buffer.byteLength(JSON.stringify(p.snapshot())) < 10 * 1024);
});

test("long text keeps bounded tails and repeated full snapshots after deltas do not fabricate progress", () => {
  const { p, advance } = projection(); const text = "🙂正文".repeat(20_000);
  p.observeEvents([event(1, "text", { itemId: "answer", text })], "s1");
  assert.ok(p.draft().length <= 4000); assert.ok(p.draft().isWellFormed()); assert.ok(p.draft().endsWith("🙂正文"));
  const initial = p.snapshot().lastProgressAt; advance(20);
  p.observeEvents([event(2, "text", { itemId: "answer", text })], "s1"); assert.equal(p.snapshot().lastProgressAt, initial);
  p.observeEvents([event(3, "text.delta", { itemId: "answer", delta: "新的尾部" })], "s1");
  const afterDelta = p.snapshot().lastProgressAt; advance(20);
  p.observeEvents([event(4, "text", { itemId: "answer", text: `${text}新的尾部` })], "s1");
  assert.equal(p.snapshot().lastProgressAt, afterDelta); assert.ok(p.draft().endsWith("新的尾部"));
  for (let index = 0; index < 50; index++) p.observeEvents([event(index + 5, "text", { itemId: `item-${index}`, text })], "s1");
  assert.equal(p.items.size, 32); assert.equal(p.itemHashes.size, 32);
  assert.ok([...p.items.values()].every(value => value.length <= 4000 && value.isWellFormed()));
});

test("maximum tool detail and JSON escape expansion still produce a valid activity frame", () => {
  const { p } = projection(); let seq = 0;
  const hostile = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`${index}${"\u0001".repeat(95)}`, "\u0002".repeat(500)]));
  for (let index = 0; index < 10; index++) {
    const id = `tool-${index}`;
    p.observeEvents([event(++seq, "tool.update", { toolCallId: id, tool: { name: "read_file", input: hostile, output: hostile, error: hostile }, progress: hostile })], "s1");
    if (index < 9) p.observeEvents([event(++seq, "tool.result", { toolCallId: id, tool: { durationMs: 1.5, output: hostile } })], "s1");
  }
  const activity = p.snapshot();
  assert.equal(activity.tool.id, "tool-9"); assert.equal(activity.recentTools.at(-2).durationMs, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(activity)) <= 64 * 1024); assert.ok(validGroupActivity(activity));
  assert.equal(p.observeEvents([event(++seq, "tool.start", { toolCallId: "x".repeat(513), tool: { name: "exec" } })], "s1"), false);
});

function trackerFixture() {
  const timers = []; let clock = 10;
  const opportunity = { id: "o", groupId: "g", discussionId: "d", memberId: "m", state: "running", runId: "r", fence: 1 };
  const pages = new Map([["r", []]]);
  const store = { getOpportunity: () => opportunity };
  const executor = { readEvents: async ({ runId, afterSeq }) => ({ runId, streamId: `s:${runId}`, events: pages.get(runId).filter(item => item.seq > afterSeq),
    nextCursor: pages.get(runId).at(-1)?.seq ?? afterSeq, hasMore: false, gap: null }) };
  const tracker = new GroupDraftTracker({ store, nativeExecutor: executor, now: () => clock,
    setTimer: callback => { const handle = { callback }; timers.push(handle); return handle; }, clearTimer: handle => { handle.closed = true; } });
  const tick = async () => { const due = timers.splice(0); for (const timer of due) if (!timer.closed) timer.callback();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { tracker, opportunity, pages, executor, tick, advance: ms => { clock += ms; } };
}

test("late poll after Run replacement cannot overwrite the new binding or expose stale draft", async () => {
  const h = trackerFixture(); let resolve;
  h.executor.readEvents = () => new Promise(done => { resolve = done; });
  h.tracker.watch("o"); await h.tick(); h.opportunity.runId = "new";
  resolve({ runId: "r", streamId: "old", events: [event(1, "text", { text: "late" })], nextCursor: 1, hasMore: false });
  await new Promise(done => setImmediate(done));
  assert.equal(h.tracker.activityFor("o"), null); assert.equal(h.tracker.draftFor("o"), null); h.tracker.stop();
});

test("missing tool detail stays generic; legacy draft changes are actual text progress without heartbeat progress", async () => {
  const h = trackerFixture(); let draft = null; h.opportunity.runKind = "external"; h.opportunity.external = {};
  h.tracker.externalExecutor = { draft: async () => draft };
  h.tracker.watch("o"); await h.tick(); assert.equal(h.tracker.activityFor("o").phase, "running");
  const at = h.tracker.activityFor("o").lastProgressAt; h.advance(100); await h.tick();
  assert.equal(h.tracker.activityFor("o").lastProgressAt, at);
  draft = "实际正文"; await h.tick(); assert.equal(h.tracker.activityFor("o").phase, "text"); h.tracker.stop();
});

test("native configured Host supports bootstrap separately from actual authenticated exposure", async () => {
  const issuer = { opened: true }, runtime = { runtimeProfileId: "rp", runtimeAccountId: "ra" };
  const exposure = new GroupNativeToolExposure();
  const input = { binding: runtime, host: { host: { ...runtime, mcpGateIssuer: issuer } }, issuer, exposure };
  let proof = await probeGroupNativeToolSupport(input);
  assert.equal(proof.collaborationSupport, true); assert.equal(proof.collaborationActions, false);
  let valid = true;
  exposure.record({ ...runtime, sessionToken: "opaque", instanceId: crypto.randomUUID(), protocolVersion: 2,
    tools: ["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"] }, { authorize: () => { if (!valid) throw Error("expired"); } });
  proof = await probeGroupNativeToolSupport(input); assert.equal(proof.collaborationActions, true);
  valid = false; proof = await probeGroupNativeToolSupport(input); assert.equal(proof.collaborationActions, false);
  assert.equal((await probeGroupNativeToolSupport({ ...input, host: { host: { ...runtime, mcpGateIssuer: { opened: true } } } })).collaborationSupport, false);
});

test("actual Codex MCP inventory is bound and paged; another server's tool names cannot prove group support", async () => {
  const runtime = { runtimeProfileId: "rp", runtimeAccountId: "ra" }; const calls = [];
  const tools = Object.fromEntries(["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"].map(name => [name, {}]));
  const host = { host: { ...runtime, mcpServerStatusList: async input => { calls.push(input);
    return input.cursor ? { data: [{ name: "shoggoth", tools }], nextCursor: null } : { data: [{ name: "other", tools }], nextCursor: "p2" }; } } };
  const proof = await probeGroupNativeToolSupport({ binding: runtime, host });
  assert.equal(proof.collaborationActions, true); assert.equal(calls.length, 2);
  assert.equal((await probeGroupNativeToolSupport({ binding: { ...runtime, runtimeAccountId: "different" }, host })).collaborationActions, false);
});

test("actual applied MCP overlay proves bootstrap only for its frozen binding and Service helper", async () => {
  const { CodexRuntimeConfigWriter, validMcpBootstrapReceipt } = require("../app/agent-service/codex-runtime-config");
  const binding = { runtimeProfileId: "rp", runtimeAccountId: "ra" }, launch = { command: process.execPath, argsPrefix: [] };
  const writer = new CodexRuntimeConfigWriter({ paths: { stateDir: "/private/tmp", trustedRoot: "/private/tmp" }, mcpHelperLaunch: launch });
  const applied = writer.overlay({ ...binding, runtimeConfig: null });
  assert.equal(validMcpBootstrapReceipt(applied.mcpBootstrap, { binding, launch, configArgs: applied.args }), true);
  assert.equal(validMcpBootstrapReceipt(structuredClone(applied.mcpBootstrap), { binding, launch, configArgs: applied.args }), false,
    "copied or forged payload is not a receipt issued by the actual config writer");
  assert.equal(validMcpBootstrapReceipt(applied.mcpBootstrap, { binding: { ...binding, runtimeAccountId: "other" }, launch, configArgs: applied.args }), false);
  assert.equal(validMcpBootstrapReceipt(applied.mcpBootstrap, { binding, launch: { command: "/bin/false", argsPrefix: [] }, configArgs: applied.args }), false);
  assert.equal(validMcpBootstrapReceipt(applied.mcpBootstrap, { binding, launch,
    configArgs: [...applied.args, "-c", "mcp_servers.shoggoth.enabled=false"] }), false);
  const missingEnvironment = [...applied.args];
  const environmentIndex = missingEnvironment.findIndex(value => value.startsWith("mcp_servers.shoggoth.env="));
  missingEnvironment.splice(environmentIndex - 1, 2);
  assert.equal(validMcpBootstrapReceipt(applied.mcpBootstrap, { binding, launch, configArgs: missingEnvironment }), false);
  const proof = await probeGroupNativeToolSupport({ binding, host: { host: { ...binding,
    groupMcpBootstrap: applied.mcpBootstrap, mcpServerStatusList: async () => ({ data: [], nextCursor: null }) } },
    issuer: { opened: true }, mcpHelperLaunch: launch });
  assert.equal(proof.collaborationSupport, true); assert.equal(proof.collaborationActions, false); assert.equal(proof.groupTools, false);
  const forged = await probeGroupNativeToolSupport({ binding, host: { host: { ...binding,
    groupMcpBootstrap: structuredClone(applied.mcpBootstrap) } }, issuer: { opened: true }, mcpHelperLaunch: launch });
  assert.equal(forged.collaborationSupport, false);
});

test("inventory reads have one bounded budget across pages and never publish an abandoned late response", async () => {
  const binding = { runtimeProfileId: "rp", runtimeAccountId: "ra" }, issuer = { opened: true }, calls = [];
  const tools = Object.fromEntries(["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"].map(name => [name, {}]));
  let late;
  const native = { ...binding, mcpGateIssuer: issuer,
    async mcpServerStatusList(input, options) {
      calls.push(options.timeoutMs);
      if (!input.cursor) { await new Promise(resolve => setTimeout(resolve, 5)); return { data: [], nextCursor: "next" }; }
      return new Promise(resolve => { late = () => resolve({ data: [{ name: "shoggoth", tools }], nextCursor: null }); });
    } };
  const started = performance.now();
  const proof = await probeGroupNativeToolSupport({ binding, host: { host: native }, issuer, inventoryTimeoutMs: 20 });
  assert.ok(performance.now() - started < 150); assert.equal(calls.length, 2); assert.ok(calls[1] < calls[0]);
  assert.equal(proof.collaborationSupport, true); assert.equal(proof.groupTools, false); assert.equal(proof.collaborationActions, false);
  late(); await new Promise(resolve => setImmediate(resolve)); assert.equal(proof.collaborationActions, false);
});

test("unavailable MCP inventory preserves independently verified exposure and ordinary runtime availability", async () => {
  const rb = { runtime: "codex", runtimeProfileId: "rp", runtimeAccountId: "ra" }, issuer = { opened: true };
  const exposure = new GroupNativeToolExposure();
  const native = { ...rb, mcpGateIssuer: issuer, async mcpServerStatusList() { throw Object.assign(Error("inventory"), { code: "REQUEST_TIMEOUT" }); } };
  const host = { host: native, capabilities: { "session.start": true, "session.resume": true, "turn.start": true } };
  const coordinator = { productStore: { getAgentProfile: () => ({ id: "p", enabled: true, ...rb }) },
    runtimeManager: { acquire: async () => host } };
  const executor = new GroupNativeExecutor({ getWorkRunCoordinator: () => coordinator,
    chatSessionStore: { getSession: () => null }, getGroupToolCapability: input => probeGroupNativeToolSupport({ ...input, issuer, exposure }) });
  let cap = await executor.probe({ member: { profileId: "p" } });
  assert.equal(cap.availability, "available"); assert.equal(cap.discussion, true);
  assert.equal(cap.collaborationBootstrap, true); assert.equal(cap.collaborationActions, false);
  exposure.record({ ...rb, sessionToken: "opaque", instanceId: crypto.randomUUID(), protocolVersion: 2,
    tools: ["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"] }, { authorize() {} });
  cap = await executor.probe({ member: { profileId: "p" } });
  assert.equal(cap.availability, "available"); assert.equal(cap.collaborationActions, true);
  for (const code of ["METHOD_NOT_FOUND", "MCP_INVENTORY_UNKNOWN"]) {
    native.mcpServerStatusList = async () => { throw Object.assign(Error("inventory"), { code }); };
    assert.equal((await executor.probe({ member: { profileId: "p" } })).collaborationActions, true);
  }
  exposure.clear(); native.mcpGateIssuer = null;
  cap = await executor.probe({ member: { profileId: "p" } });
  assert.equal(cap.discussion, true); assert.equal(cap.availability, "available");
  assert.equal(cap.collaborationActions, false); assert.equal(cap.collaborationSupport, false);
});

test("real MCP tools/list pages register exactly exposed group schema and revoke on close", async () => {
  const runtime = { runtimeProfileId: "rp", runtimeAccountId: "ra" }, registry = new GroupNativeToolExposure(); let active = true;
  const handler = createMcpStdioHandler({ ...runtime, sessionToken: crypto.randomBytes(32).toString("base64url"), reportGroupExposure: true,
    requestService: async (_paths, request) => { assert.equal(request.method, "mcp.group.exposure");
      return registry.record(request.params, { executionRunId: "r", authorize: () => { if (!active) throw Error("closed"); } }); } });
  await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
  let cursor;
  do { const result = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} });
    assert.ok(result.result); cursor = result.result.nextCursor; } while (cursor);
  assert.deepEqual([...registry.entries.values()].flatMap(entry => [...entry.tools]).sort(), ["group_member_role_read", "group_messages_read"]);
  assert.equal(registry.capability({ ...runtime, runId: "r" }).collaborationActions, false,
    "retired task/collaboration tools are not advertised by the current product catalog");
  assert.equal(registry.capability({ ...runtime, runId: "different" }).collaborationActions, false);
  handler.close(); await new Promise(resolve => setImmediate(resolve)); active = false;
  assert.equal(registry.entries.size, 0);
  assert.equal(registry.capability({ ...runtime, runId: "r" }).collaborationActions, false);
});

test("authenticated helper re-registers its actual tools/list exposure after session refresh", async () => {
  const rb = { runtimeProfileId: "rp", runtimeAccountId: "ra" }, reports = [];
  const first = crypto.randomBytes(32).toString("base64url"), second = crypto.randomBytes(32).toString("base64url");
  let now = 1000;
  const handler = createMcpStdioHandler({ ...rb, sessionToken: first, sessionExpiresAt: 100_000, now: () => now,
    sessionRefreshSkewMs: 10, reportGroupExposure: true,
    refreshSession: async () => ({ ...rb, token: second,
      protocolVersion: require("../app/agent-service/service-protocol-version").SERVICE_PROTOCOL_VERSION, profileId: "p", expiresAt: 200_000 }),
    requestService: async (_paths, request) => {
      if (request.method === "mcp.group.exposure") { reports.push(request.params); return { registered: true }; }
      return { run: { id: "run" } };
    } });
  await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
  let cursor;
  do { const result = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} }); cursor = result.result.nextCursor; } while (cursor);
  assert.deepEqual([...reports.at(-1).tools].sort(), ["group_member_role_read", "group_messages_read"]);
  const instance = reports.at(-1).instanceId;
  now = 100_001;
  const result = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_get", arguments: { runId: "run" } } });
  assert.equal(result.result.isError, false); assert.equal(reports.at(-1).sessionToken, second);
  assert.equal(reports.at(-1).instanceId, instance);
  assert.deepEqual([...reports.at(-1).tools].sort(), ["group_member_role_read", "group_messages_read"]); handler.close();
});

for (const [runtime, module, Adapter] of [
  ["codex", "codex", "Codex"], ["grok-build", "grok-build", "GrokBuild"], ["antigravity", "antigravity", "Antigravity"],
  ["pi", "pi", "Pi"], ["opencode", "opencode", "OpenCode"], ["deepseek-harness", "deepseek-harness", "DeepSeekHarness"],
]) test(`native ${runtime}: real adapter/Registry capability contract and event projection`, async () => {
  const issuer = { opened: true }, rb = { runtime, runtimeProfileId: "rp", runtimeAccountId: "ra" }; let listener;
  const host = { ...rb, nativeApprovalsAvailable: runtime === "antigravity", terminated: new Promise(() => {}),
    mcpGateIssuer: issuer, subscribe: callback => { listener = callback; return () => {}; },
    registerServerRequestHandler() {}, sessionList() {}, sessionStart() {}, sessionResume() {}, sessionRead() {},
    turnStart() {}, turnSteer() {}, turnInterrupt() {} };
  const pool = { get: async () => host, stop: async () => {}, stopAll: async () => {} };
  const Type = require(`../app/agent-service/${module}-runtime-adapter`)[`${Adapter}RuntimeAdapter`];
  const registry = new RuntimeAdapterRegistry(); registry.register(runtime, new Type({ runtimePool: pool }));
  const coordinator = { productStore: { getAgentProfile: () => ({ id: "p", enabled: true, ...rb }) }, runtimeManager: registry };
  const executor = new GroupNativeExecutor({ getWorkRunCoordinator: () => coordinator, chatSessionStore: { getSession: () => null },
    getChatServiceController: () => null, getGroupToolCapability: input => probeGroupNativeToolSupport({ ...input, issuer }) });
  const caps = await executor.probe({ member: { profileId: "p" } });
  assert.equal(caps.discussion, true); assert.equal(caps.collaborationSupport, true);
  assert.equal(caps.collaborationActions, false); assert.equal(caps.collaborationBootstrap, true); assert.ok(validGroupCapabilities(caps));
  const handle = await registry.acquire(rb); const p = new GroupActivityProjection(binding);
  let seq = 0; handle.subscribe(value => p.observeEvents([event(++seq, { tool_start: "tool.start", tool_result: "tool.result" }[value.type],
    { toolCallId: value.toolCallId, tool: value.tool })], "native"));
  listener({ known: true, method: "item/started", type: "tool_start", sessionId: "s", turnId: "t",
    itemId: "i", toolCallId: "call", tool: { name: "read_file", input: { path: "fixture.txt" } } });
  assert.equal(p.snapshot().phase, "tool");
  listener({ known: true, method: "item/completed", type: "tool_result", sessionId: "s", turnId: "t",
    itemId: "i", toolCallId: "call", tool: { name: "read_file", output: "" } });
  assert.equal(p.snapshot().recentTools[0].status, "completed");
});

test("release-disabled claude-code and unknown MCP host retain explicit unsupported capability", async () => {
  const registry = new RuntimeAdapterRegistry(); const rb = { runtime: "claude-code", runtimeProfileId: "rp", runtimeAccountId: "ra" };
  await assert.rejects(registry.acquire(rb), error => error.code === "RUNTIME_UNSUPPORTED");
  const caps = nativeCapabilities({ "session.start": true, "session.resume": true, "turn.start": true, events: true }, null);
  assert.equal(caps.collaborationSupport, false); assert.equal(caps.collaborationActions, false);
  const legacy = groupCapabilities({ source: "legacy-host", groupTools: true });
  assert.equal(legacy.protocolVersion, 1); assert.equal(legacy.collaborationActions, false);
});

for (const mode of ["gateway", "acp"]) test(`Hermes ${mode}: actual hooks project tools/text and reject old lifecycle`, async () => {
  let hooks, finish, clock = 100;
  const sessionKey = "agent:hermes-test:group-session";
  const backend = { _lifecycleGeneration: 1, sessionWorkspaceByKey: new Map([[sessionKey, "/private/tmp"]]),
    freshSessionTransports: new Map([[sessionKey, mode]]),
    createSession: async () => sessionKey,
    sendMessage: async (_s, _p, _r, observed) => { hooks = observed; return new Promise(resolve => { finish = resolve; }); } };
  const adapter = new HermesInspirationAdapter({ backend, sessionPurpose: "group", now: () => clock });
  const prepared = await adapter.prepare({ agentId: "hermes-test", sessionId: "intent" });
  const input = { ...prepared, agentId: "hermes-test", runId: "r", prompt: "fixture" };
  adapter.start(input); await new Promise(resolve => setImmediate(resolve));
  hooks.tool({ phase: "start", toolCallId: "t", name: "read_file", args: { path: "fixture.txt" } });
  assert.equal(adapter.activity(input).phase, "tool"); clock += 50;
  hooks.tool({ phase: "result", toolCallId: "t", result: "" }); assert.equal(adapter.activity(input).recentTools[0].status, "completed");
  hooks.delta("正文"); assert.equal(adapter.activity(input).phase, "text");
  hooks.status({ kind: "compacting", text: "private compaction detail" });
  assert.equal(adapter.activity(input).phase, "compacting");
  hooks.status({ kind: "compacted", text: "private compaction detail" });
  assert.equal(adapter.activity(input).phase, "compacted");
  assert.equal(adapter.activity(input).compaction.status, "compacted");
  assert.equal(JSON.stringify(adapter.activity(input)).includes("private compaction detail"), false);
  const completedReceipt = adapter.activity(input).compaction;
  clock += 50; hooks.tool({ phase: "start", toolCallId: "after-compact", name: "read_file", args: { path: "next.txt" } });
  const resumedProgress = adapter.activity(input).lastProgressAt;
  clock += 50; hooks.status({ kind: "compacted" });
  assert.equal(adapter.activity(input).phase, "tool", "a repeated unkeyed Hermes status cannot replace resumed work");
  assert.equal(adapter.activity(input).lastProgressAt, resumedProgress);
  assert.equal(adapter.activity(input).compaction.observedAt, completedReceipt.observedAt, "first completion observation is retained");
  assert.equal(adapter.activity(input).compaction.lastObservedAt, clock, "later receipt stays observable without claiming a new cycle");
  clock += 50; hooks.status({ kind: "compacting" });
  assert.equal(adapter.activity(input).phase, "compacting", "a newly observed start can open the next cycle");
  clock += 50; hooks.status({ kind: "compacted" }); assert.equal(adapter.activity(input).phase, "compacted");
  assert.equal(adapter.activity(input).compaction.observedAt, clock);
  const at = adapter.activity(input).lastProgressAt; clock += 500; hooks.thinking("private");
  assert.equal(adapter.activity(input).lastProgressAt, at);
  const caps = await adapter.probe(input); assert.equal(caps.mode, mode); assert.equal(caps.interactive, mode === "gateway");
  backend._lifecycleGeneration++; hooks.delta("late"); assert.equal(adapter.activity(input), null); finish();
});

test("actual OpenClaw socket observer binds ordered tool events and final evidence to the original Run", () => {
  const backend = Object.create(OpenClawBackend.prototype), socket = {}, calls = [];
  backend._finalObservers = new Map([["rpc", { socket, runId: "r", sessionKey: "s", agentId: "a", onTool: value => calls.push(value) }]]);
  const frame = (seq, overrides = {}) => ({ type: "event", event: "agent", payload: { stream: "tool", runId: "r",
    sessionKey: "s", agentId: "a", seq, data: { phase: "start", toolCallId: "t", name: "read_file" }, ...overrides } });
  backend._observeAssistantEvent(frame(1), {}); backend._observeAssistantEvent(frame(1, { runId: "foreign" }), socket);
  backend._observeAssistantEvent(frame(1), socket); backend._observeAssistantEvent(frame(1), socket); backend._observeAssistantEvent(frame(0), socket);
  assert.equal(calls.length, 1); assert.equal(backend.groupActivityProtocolVersion, 2);
});

test("OpenClaw group adapter exposes actual tools and full snapshots without reasoning or late terminal resurrection", async () => {
  let observer, clock = 100;
  const backend = { _connectionGeneration: 2, groupActivityProtocolVersion: 2, _connect: async () => {}, hasGatewayMethod: () => true,
    request: async method => method === "agents.list" ? { agents: [{ id: "a", workspace: "/private/tmp" }] } : null,
    requestWithFinalObservation: async (_method, params, hooks) => { observer = hooks;
      return { runId: params.idempotencyKey, sessionKey: params.sessionKey, agentId: params.agentId, status: "accepted" }; } };
  const adapter = new OpenClawInspirationAdapter({ backend, sessionPurpose: "group", now: () => clock });
  const input = { agentId: "a", sessionKey: `agent:a:dashboard:group-${"a".repeat(64)}`, runId: "r", workspace: "/private/tmp", prompt: "fixture" };
  await adapter.start(input); observer.onTool({ phase: "start", toolCallId: "t", name: "read_file" });
  assert.equal(adapter.activity(input).phase, "tool"); clock += 50;
  observer.onTool({ phase: "result", toolCallId: "t", output: "" }); assert.equal(adapter.activity(input).recentTools[0].status, "completed");
  observer.onAssistant({ text: "private", phase: "analysis" }); assert.equal(adapter.draft(input), null);
  observer.onAssistant({ text: "public" }); assert.equal(adapter.activity(input).phase, "text");
  const caps = await adapter.probe(input); assert.equal(caps.toolEvents, true); assert.equal(caps.collaborationSupport, true);
  observer.onFinal({ payload: { runId: "r", status: "ok", result: { payloads: [{ text: "done" }] } } });
  observer.onTool({ phase: "start", toolCallId: "late", name: "exec" }); assert.equal(adapter.activity(input).phase, "completed");
  adapter.reset();
});
