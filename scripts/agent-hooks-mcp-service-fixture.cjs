"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { createMcpStdioHandler, authenticateMcpSession, MCP_STDIO_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const uuid = () => crypto.randomUUID();
async function until(predicate) {
  const limit = Date.now() + 8000;
  while (Date.now() < limit) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Hook Service fixture timed out");
}
async function fixture(t, { separateHosts = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hooks-ipc-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const host = new InspirationRuntime(), sent = [], runtimeErrors = [];
  host.startInputs = []; host.turnInputs = []; host.injectedInputs = [];
  const originalStart = host.threadStart.bind(host), originalTurn = host.turnStart.bind(host), originalInject = host.threadInjectItems.bind(host);
  host.threadStart = input => { host.startInputs.push(structuredClone(input)); return originalStart(input); };
  host.turnStart = input => { host.turnInputs.push(structuredClone(input)); return originalTurn(input); };
  host.threadInjectItems = input => { host.injectedInputs.push(structuredClone(input)); return originalInject(input); };
  host.threadArchive = async ({ threadId }) => {
    const thread = host.threads.find(item => item.id === threadId); assert.ok(thread); thread.archived = true; return {};
  };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
    decryptString: value => value.toString() };
  const hosts = new Map();
  const runtimePool = { async get(binding) {
    if (!separateHosts) return host;
    const key = binding.runtimeProfileId;
    if (!hosts.has(key)) {
      if (hosts.size === 0) hosts.set(key, host);
      else {
        const other = new InspirationRuntime(), start = other.threadStart.bind(other);
        other.threadStart = async input => {
          const response = await start(input), thread = other.threads.at(-1);
          thread.id = "isolated-" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 16) + "-" + thread.id;
          return { ...response, thread: structuredClone(thread) };
        };
        hosts.set(key, other);
      }
    }
    return hosts.get(key);
  }, async stopAll() {} };
  const serviceOptions = { paths, safeStorage, autoSparkNotes: false,
    onRuntimeError: async (error, cleanup) => { runtimeErrors.push({ code: error?.code, cleanup: cleanup?.code }); },
    runtimePool,
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    notificationSender: async input => { sent.push(input); return { state: "submitted" }; } };
  let service = createAgentService(serviceOptions);
  let helper;
  t.after(async () => { await helper?.close(); await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const ipc = (method, params) => requestService(paths, { id: uuid(), token: readClientToken(paths),
    version: PROTOCOL_VERSION, method, params });
  const sessions = await ipc("chat.session.list", { profileId: DEFAULT_AGENT_PROFILE_ID, includeArchived: false, cursor: null, limit: 20 });
  const sessionKey = sessions.sessions[0].sessionKey;
  const send = async prompt => {
    const accepted = await ipc("chat.send", { operationId: uuid(), sessionKey, prompt, createdAt: Date.now() });
    try {
      await until(() => {
        const run = service.workDispatcher.getRun(accepted.run.id);
        assert.ok(!["failed", "interrupted", "canceled"].includes(run.status), JSON.stringify({ prompt, run, runtimeErrors }));
        return run.status === "running";
      });
    } catch (error) {
      error.message += " " + JSON.stringify({ prompt, run: service.workDispatcher.getRun(accepted.run.id),
        runtimeErrors, coordinator: service.workRunCoordinator.state,
        owners: [...service.workRunCoordinator.hookWorkspaceWriters.owners.keys()] });
      throw error;
    }
    return service.workDispatcher.getRun(accepted.run.id);
  };
  const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const session = await authenticateMcpSession({ paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, safeStorage, requestService });
  helper = createMcpStdioHandler({ paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, sessionToken: session.token, bindRuntimeCalls: true, requestService });
  await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: { elicitation: {} }, clientInfo: { name: "hooks-fixture", version: "1" } } });
  let sequence = 2, currentRun;
  const call = async (name, args, { confirm = true } = {}) => {
    const result = await helper({ jsonrpc: "2.0", id: sequence++, method: "tools/call",
      params: { name, arguments: args } }, { requestClient: async (method, proof) => {
        assert.equal(method, "elicitation/create");
        if (!confirm) return { action: "cancel" };
        if (proof.requestedSchema?.properties?.confirm_product_action) {
          assert.match(proof.message, /内容摘要/);
          return { action: "accept", content: { confirm_product_action: "确认执行" } };
        }
        return host.request("mcpServer/elicitation/request", { ...proof, serverName: "shoggoth",
          threadId: currentRun.runtimeSessionRef.sessionId, turnId: currentRun.runtimeTurnRef.turnId });
      } });
    return result.result;
  };
  const complete = async run => { host.complete(run, "完成"); await until(() => service.workDispatcher.getRun(run.id).status === "completed"); await service.hookRunner.drain(); };
  const value = { root, paths, service, host, hosts, safeStorage, sent, profile, ipc, helper, send, call, complete, setRun: run => { currentRun = run; } };
  value.restart = async () => {
    await helper.close(); await service.stop({ notify: false });
    service = createAgentService(serviceOptions); value.service = service; await service.start();
    const fresh = await authenticateMcpSession({ paths, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, safeStorage, requestService });
    helper = createMcpStdioHandler({ paths, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, sessionToken: fresh.token, bindRuntimeCalls: true, requestService });
    value.helper = helper;
    await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { elicitation: {} }, clientInfo: { name: "hooks-recovery-fixture", version: "1" } } });
  };
  return value;
}
function registerNativeMcp(f) {
  const workspace = f.paths.defaultWorkspaceDir, effects = path.join(workspace, "native-effects.jsonl");
  const executable = path.join(workspace, "native-fixture.cjs");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.writeFileSync(executable, "#!" + process.execPath + "\n" + `
const fs = require("node:fs"), readline = require("node:readline");
const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  properties: { amount: { type: "number", minimum: 0, maximum: 1000 }, email: { type: "string" } }, required: ["amount"] };
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line); let result;
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "native-fixture", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "purchase_quote", description: "Isolated purchase fixture", inputSchema: schema }] };
  else if (request.method === "tools/call") {
    fs.appendFileSync(${JSON.stringify(effects)}, JSON.stringify(request.params.arguments) + "\\n");
    result = { content: [{ type: "text", text: "报价邮箱 a@example.com" }], structuredContent: { status: "completed", id: "quote-1", amount: request.params.arguments.amount, text: "报价邮箱 a@example.com" }, isError: false };
  } else return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`, { mode: 0o700 });
  const registered = f.service.nativeMcpStore.register({ expectedRevision: f.service.nativeMcpStore.revision,
    server: { id: "living-native", name: "生活 MCP 测试", command: executable, args: [], cwd: workspace, enabled: true } });
  return { registered, effects: () => fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").trim().split("\n").map(JSON.parse) : [] };
}
test("two real Profiles share one Account but keep Hook access, snapshots, Hosts and cancellation isolated", async t => {
  const f = await fixture(t, { separateHosts: true }), native = registerNativeMcp(f), setup = await f.send("设置持续预算。"); f.setRun(setup);
  const workspace = path.join(f.root, "second-workspace"); fs.mkdirSync(workspace);
  const secondProfile = (await f.ipc("agent.create", { operationId: uuid(), backendId: "shoggoth",
    name: "临时第二个 Agent", defaultCwd: workspace, createdAt: Date.now() })).profile;
  assert.equal(secondProfile.runtimeAccountId, f.profile.runtimeAccountId);
  assert.notEqual(secondProfile.runtimeProfileId, f.profile.runtimeProfileId);
  const saved = (await f.call("hook_register", { definition: { schemaVersion: 1, name: "第一个 Agent 的预算", event: "tool.before", kind: "guard",
    scope: { workspace: "profile", sources: ["chat"] }, matcher: { toolScopes: ["native_mcp"], toolNames: ["purchase_quote"], serverId: "living-native" },
    handler: { type: "builtin", name: "guard.condition", config: { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "block", reason: "仅第一个 Agent" } } } })).structuredContent;
  assert.equal((await f.call("hook_test", { hookId: saved.hookId, version: 1, payload: { arguments: { amount: 600 } } })).structuredContent.passed, true);
  await f.call("hook_grant", { hookId: saved.hookId, version: 1 });
  await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: saved.revision }); await f.complete(setup);
  const first = await f.send("报价 600 元"); f.setRun(first);
  const session = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: secondProfile.id, workspace, createdAt: Date.now() })).session;
  const accepted = (await f.ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey, prompt: "另一个 Agent 的报价", createdAt: Date.now() })).run;
  await until(() => ["running", "failed"].includes(f.service.workDispatcher.getRun(accepted.id).status));
  const second = f.service.workDispatcher.getRun(accepted.id); assert.equal(second.status, "running", JSON.stringify(second));
  assert.deepEqual(f.service.hookStore.snapshotForRun(second.id).entries, []);
  const secondHost = f.hosts.get(secondProfile.runtimeProfileId); assert.ok(secondHost && secondHost !== f.host);
  const authentication = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: secondProfile.runtimeProfileId,
    runtimeAccountId: secondProfile.runtimeAccountId, safeStorage: f.safeStorage, requestService });
  const helper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: secondProfile.runtimeProfileId,
    runtimeAccountId: secondProfile.runtimeAccountId, sessionToken: authentication.token, bindRuntimeCalls: true, requestService });
  t.after(() => helper.close());
  await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: { elicitation: {} }, clientInfo: { name: "second-profile-fixture", version: "1" } } });
  let sequence = 2;
  const call = async (name, args) => (await helper({ jsonrpc: "2.0", id: sequence++, method: "tools/call", params: { name, arguments: args } },
    { requestClient: async (_method, proof) => secondHost.request("mcpServer/elicitation/request", { ...proof, serverName: "shoggoth",
      threadId: second.runtimeSessionRef.sessionId, turnId: second.runtimeTurnRef.turnId }) })).result;
  assert.equal((await call("hook_get", { hookId: saved.hookId })).isError, true);
  assert.equal((await f.call("mcp_server_call", { serverId: "living-native", toolName: "purchase_quote", arguments: { amount: 600 } })).isError, true);
  assert.equal(native.effects().length, 0);
  await f.ipc("chat.abort", { operationId: uuid(), sessionKey: first.sourceId, runId: first.id, createdAt: Date.now() });
  assert.equal(f.service.workDispatcher.getRun(second.id).status, "running");
  assert.equal((await call("mcp_server_call", { serverId: "living-native", toolName: "purchase_quote", arguments: { amount: 600 } })).isError, false);
  assert.equal(native.effects().length, 1);
  secondHost.complete(second); await until(() => f.service.workDispatcher.getRun(second.id).status === "completed"); await f.service.hookRunner.drain();
});
test("a queued writer wakes only after canceled Run workers finish, without another user request", async t => {
  const f = await fixture(t), first = await f.send("第一个临时任务");
  const session = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: f.profile.id,
    workspace: first.workspace, createdAt: Date.now() })).session;
  const second = (await f.ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey,
    prompt: "第二个临时任务", createdAt: Date.now() })).run;
  assert.equal(second.status, "queued");
  let finishWorkers;
  const workerExit = new Promise(resolve => { finishWorkers = resolve; });
  const cancel = f.service.hookRunner.cancelRun.bind(f.service.hookRunner);
  f.service.hookRunner.cancelRun = async runId => { await cancel(runId); if (runId === first.id) await workerExit; };
  await f.ipc("chat.abort", { operationId: uuid(), sessionKey: first.sourceId, runId: first.id, createdAt: Date.now() });
  assert.equal(f.service.workDispatcher.getRun(first.id).status, "canceled");
  assert.equal(f.service.workDispatcher.getRun(second.id).status, "queued");
  assert.equal(f.service.workRunCoordinator.hookWorkspaceWriters.owners.get(first.workspace), first.id);
  assert.equal(f.host.turnStarts, 1);
  finishWorkers();
  await until(() => f.service.workDispatcher.getRun(second.id).status === "running");
  assert.equal(f.host.turnStarts, 2);
  await f.complete(f.service.workDispatcher.getRun(second.id));
});
test("actual Chat, Cron, Kanban and Inspiration admission, tool and terminal lifecycle boundaries", async t => {
  const f = await fixture(t), native = registerNativeMcp(f), setup = await f.send("设置持续规则。"); f.setRun(setup);
  const workspace = setup.workspace;
  const scope = { workspace: "current", sources: ["chat", "cron", "kanban", "inspiration"] };
  const enable = async definition => {
    const saved = (await f.call("hook_register", { definition: { schemaVersion: 1, scope, ...definition } })).structuredContent;
    assert.ok(saved?.hookId);
    const tested = await f.call("hook_test", { hookId: saved.hookId, version: 1, payload: { arguments: { amount: 600 } } });
    assert.equal(tested.structuredContent.passed, true);
    if (definition.handler.name === "guard.condition") await f.call("hook_grant", { hookId: saved.hookId, version: 1 });
    assert.equal((await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: saved.revision })).isError, false);
  };
  for (const event of ["run.before", "run.started", "run.completed", "run.failed", "run.canceled", "run.interrupted", "session.created", "session.closed"]) {
    await enable({ name: "观察 " + event, event, kind: "observe", matcher: {},
      handler: { type: "builtin", name: "observe.record", config: { tags: ["lifecycle-proof"] } } });
  }
  const contextMarker = "ISOLATED_HOOK_CONTEXT_FOR_ALL_SOURCES";
  await enable({ name: "任务上下文", event: "context.prepare", kind: "transform", matcher: {},
    handler: { type: "builtin", name: "context.literal", config: { text: contextMarker } } });
  await enable({ name: "通用预算", event: "tool.before", kind: "guard",
    matcher: { toolScopes: ["native_mcp"], toolNames: ["purchase_quote"], serverId: "living-native" },
    handler: { type: "builtin", name: "guard.condition", config: { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "block", reason: "预算规则" } } });
  await f.complete(setup);
  const running = async run => {
    await until(() => ["running", "failed"].includes(f.service.workDispatcher.getRun(run.id).status));
    const current = f.service.workDispatcher.getRun(run.id);
    assert.equal(current.status, "running", JSON.stringify(current)); return current;
  };
  const createCron = async () => {
    const job = (await f.ipc("cron.job.create", { operationId: uuid(), name: "临时报价任务", enabled: false,
      profileId: f.profile.id, prompt: "查看报价", workspace, schedule: { kind: "at", at: Date.now() + 60000 },
      misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip", threadPolicy: "new", threadId: null, createdAt: Date.now() })).job;
    return (await f.ipc("cron.run.trigger", { operationId: uuid(), jobId: job.id, createdAt: Date.now() })).run;
  };
  const createKanban = () => {
    const store = f.service.nativeKanbanStore;
    const board = store.createBoard({ operationId: uuid(), profileId: f.profile.id, slug: "hook-lifecycle", name: "生活事项", description: null, createdAt: Date.now() });
    const card = store.createCard({ operationId: uuid(), profileId: f.profile.id, boardId: board.id,
      title: "查看报价", body: "仅临时工具", status: "backlog", position: 0, createdAt: Date.now() });
    return f.service.kanbanRunService.dispatchCard({ operationId: uuid(), cardId: card.id, workspace, createdAt: Date.now() }).run;
  };
  const createInspiration = async () => {
    const idea = (await f.ipc("inspiration.create", { operationId: uuid(), body: "收集生活报价" })).idea;
    const started = await f.ipc("inspiration.start", { operationId: uuid(), id: idea.id, expectedRevision: idea.revision,
      backendId: "shoggoth", agentId: f.profile.agentId, instruction: "仅临时工具", workspace });
    return f.service.workDispatcher.getRun(started.idea.latestExecution.runId);
  };
  for (const [source, create] of [["chat", () => f.send("查看报价")], ["cron", createCron], ["kanban", createKanban], ["inspiration", createInspiration]]) {
    const injectedBefore = f.host.injectedInputs.length;
    const run = await running(await create()); f.setRun(run); assert.equal(run.source, source);
    assert.equal(run.workspace, workspace);
    const context = f.service.contextSnapshotStore.get(f.profile.id, run.contextSnapshotId);
    const injected = f.host.injectedInputs.slice(injectedBefore)
      .filter(input => input.threadId === run.runtimeSessionRef.sessionId).flatMap(input => input.items);
    assert.ok(injected.some(item => item.role === "user"
      && item.content.some(part => part.type === "input_text" && part.text.includes(contextMarker))),
      JSON.stringify({ source, contextContainsMarker: context.dynamicContext.includes(contextMarker),
        hookEntries: f.service.hookStore.snapshotForRun(run.id).entries.map(entry => ({ event: entry.definition.event, kind: entry.definition.kind })),
        hookBlocks: context.blocks.filter(item => item.id.startsWith("hook")).map(item => ({ id: item.id, content: item.content })),
        injected, turnInputs: f.host.turnInputs.at(-1).input }));
    assert.equal((await f.call("mcp_server_call", { serverId: "living-native", toolName: "purchase_quote", arguments: { amount: 600 } })).isError, true);
    assert.equal((await f.call("mcp_server_call", { serverId: "living-native", toolName: "purchase_quote", arguments: { amount: 100 } })).isError, false);
    await f.complete(run);
    const receipts = f.service.hookStore.executions(f.profile.id, { runId: run.id }).items;
    for (const event of ["run.before", "context.prepare", "run.started", "run.completed"]) {
      assert.equal(receipts.filter(item => item.event === event && item.state === "settled").length, 1, JSON.stringify({ source, event, receipts }));
    }
    assert.equal(f.service.hookRunner.lastObserverError, undefined);
  }
  assert.equal(native.effects().length, 4);
  const session = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: f.profile.id,
    workspace, createdAt: Date.now() })).session;
  const sessionRun = (await f.ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey,
    prompt: "临时会话生命周期", createdAt: Date.now() })).run;
  await f.complete(await running(sessionRun));
  await f.ipc("chat.session.archive", { operationId: uuid(), sessionKey: session.sessionKey, createdAt: Date.now() });
  await f.service.hookRunner.drain();
  const sessionReceipts = f.service.hookStore.executions(f.profile.id).items;
  for (const event of ["session.created", "session.closed"]) assert.ok(sessionReceipts.some(item => item.event === event && item.state === "settled"));
  const canceled = await f.send("取消边界验证");
  await f.ipc("chat.abort", { operationId: uuid(), sessionKey: canceled.sourceId, runId: canceled.id, createdAt: Date.now() });
  await until(() => f.service.workDispatcher.getRun(canceled.id).status === "canceled"); await f.service.hookRunner.drain();
  assert.equal(f.service.hookStore.executions(f.profile.id, { runId: canceled.id }).items.filter(item => item.event === "run.canceled" && item.state === "settled").length, 1);
});
test("50 real Service rounds, 1000 authenticated helper interactions and five clean restart cycles", async t => {
  const f = await fixture(t), native = registerNativeMcp(f), setup = await f.send("以后报价超过 500 元时暂停。"); f.setRun(setup);
  const definition = { schemaVersion: 1, name: "持续预算规则", event: "tool.before", kind: "guard",
    scope: { workspace: "current", sources: ["chat", "cron", "kanban", "inspiration"] },
    matcher: { toolScopes: ["native_mcp"], toolNames: ["purchase_quote"], serverId: "living-native" },
    handler: { type: "builtin", name: "guard.condition", config: { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "block", reason: "持续规则" } } };
  const saved = (await f.call("hook_register", { definition })).structuredContent;
  assert.equal((await f.call("hook_test", { hookId: saved.hookId, version: 1, payload: { arguments: { amount: 600 } } })).structuredContent.passed, true);
  assert.equal((await f.call("hook_grant", { hookId: saved.hookId, version: 1 })).isError, false);
  await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: saved.revision });
  const { validateDefinition } = require("../app/agent-service/hook-contract");
  // Trusted setup inserts foreign owner/workspace canaries. The authenticated
  // Agent cannot read either, and neither may block its own allowed operation.
  const foreign = f.service.hookStore.register("another-profile", uuid(), validateDefinition({ ...definition, name: "foreign owner",
    handler: { type: "builtin", name: "guard.block", config: { reason: "must not enter this Profile" } } }, f.paths.defaultWorkspaceDir));
  f.service.hookStore.activate("another-profile", uuid(), foreign.hookId, 1, 1, () => {});
  const otherWorkspace = path.join(f.root, "other-workspace"); fs.mkdirSync(otherWorkspace);
  const elsewhere = f.service.hookStore.register(f.profile.id, uuid(), validateDefinition({ ...definition, name: "foreign workspace",
    handler: { type: "builtin", name: "guard.block", config: { reason: "must not enter this workspace" } } }, otherWorkspace));
  f.service.hookStore.activate(f.profile.id, uuid(), elsewhere.hookId, 1, 1, () => {});
  assert.equal((await f.call("hook_get", { hookId: foreign.hookId })).isError, true);
  await f.complete(setup);
  let calls = 0, blocked = 0;
  for (let round = 0; round < 50; round++) {
    const run = await f.send("受控报价验收 " + round); f.setRun(run);
    const snapshot = f.service.hookStore.snapshotForRun(run.id);
    assert.deepEqual(snapshot.entries.map(entry => entry.hookId), [saved.hookId]);
    for (let interaction = 0; interaction < 20; interaction++) {
      const deny = interaction % 2 === 0;
      const result = await f.call("mcp_server_call", { serverId: "living-native", toolName: "purchase_quote", arguments: { amount: deny ? 600 : 200 } });
      assert.equal(result.isError === true, deny, JSON.stringify({ round, interaction, result })); if (deny) { blocked++; assert.match(JSON.stringify(result), /HOOK_BLOCKED/); }
      calls++;
    }
    await f.complete(run);
    assert.ok(f.service.hookStore.db && f.service.hookStore.lease && !f.service.hookStore.poisoned,
      JSON.stringify({ round, db: !!f.service.hookStore.db, lease: !!f.service.hookStore.lease,
        poisoned: f.service.hookStore.poisoned, coordinator: f.service.workRunCoordinator.state, runnerClosed: f.service.hookRunner.closed }));
    const receipts = f.service.hookStore.executions(f.profile.id, { runId: run.id, limit: 50 }).items;
    assert.equal(receipts.filter(item => item.hookId === saved.hookId).length, 20);
    if ((round + 1) % 10 === 0) {
      await f.restart();
      assert.equal(f.service.hookStore.get(f.profile.id, saved.hookId).activeVersion, 1);
      assert.equal(f.service.hookProcessHost.children.size, 0);
      assert.equal(f.service.workRunCoordinator.hookWorkspaceWriters.owners.size, 0);
      assert.equal(f.service.hookStore.snapshotForRun(run.id).entries[0].hookId, saved.hookId);
      t.diagnostic(`completed ${round + 1} Service rounds and restart ${(round + 1) / 10}`);
    }
  }
  assert.equal(calls, 1000); assert.equal(blocked, 500); assert.equal(native.effects().length, 500);
});
async function registerPluginMcp(f) {
  const sourcePath = path.join(f.root, "plugin-package"); fs.mkdirSync(sourcePath, { mode: 0o700 });
  fs.writeFileSync(path.join(sourcePath, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "living-mcp-fixture" }));
  fs.writeFileSync(path.join(sourcePath, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { local: { type: "stdio", command: "node", args: ["./server.cjs"] } } }));
  fs.writeFileSync(path.join(sourcePath, "server.cjs"), `
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  properties: { amount: { type: "number", minimum: 0, maximum: 1000 } }, required: ["amount"] };
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line); let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "plugin-fixture", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "purchase_quote", description: "Isolated quote", inputSchema: schema }] };
  else if (request.method === "tools/call") {
    fs.appendFileSync(path.join(process.env.PLUGIN_DATA, "effects.jsonl"), JSON.stringify(request.params.arguments) + "\\n");
    result = { content: [{ type: "text", text: "a@example.com" }], structuredContent: { status: "completed", id: "plugin-quote-1", amount: request.params.arguments.amount, text: "a@example.com" }, isError: false };
  } else return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
  const installer = f.service.pluginPackageInstaller, store = f.service.pluginStore;
  const preview = installer.preview(sourcePath);
  let installation = installer.install({ sourcePath, previewDigest: preview.contentDigest, expectedRevision: 0, operationId: uuid() });
  const component = new PluginComponentCatalog({ store }).list().find(item => item.installationId === installation.installationId)
    .components.find(item => item.kind === "mcp-server");
  const pin = { installationId: installation.installationId, releaseDigest: installation.releaseDigest,
    componentId: component.componentId, descriptorDigest: component.descriptorDigest };
  const dependencies = f.service.pluginDependencyController.registry;
  const prepared = dependencies.preview({ ...pin, executablePath: process.execPath });
  dependencies.prepare({ ...pin, executablePath: process.execPath, previewDigest: prepared.previewDigest,
    expectedRevision: 0, operationId: uuid(), confirmed: true });
  installation = store.setInstallationDesiredState({ installationId: installation.installationId, expectedRevision: installation.revision, desiredState: "enabled" });
  const pending = store.createConnection({ connectionId: "living-plugin", installationId: installation.installationId,
    componentId: component.componentId, endpointIdentity: "stdio:" + component.descriptorDigest });
  const connection = store.setConnectionIdentity({ connectionId: pending.connectionId, expectedRevision: pending.revision,
    principalIdentity: "fixture-local-account", state: "ready" });
  const created = store.createBinding({ bindingId: "living-plugin-binding", profileId: f.profile.id,
    installationId: installation.installationId, componentId: component.componentId, connectionId: connection.connectionId });
  const binding = store.setBindingEnabled({ bindingId: created.bindingId, expectedRevision: created.revision, enabled: true });
  const client = await f.service.pluginMcpConnectionManager.acquire({ installation, binding, connection });
  let catalog; try { catalog = await f.service.pluginToolCatalogRegistry.refresh({ installation, connection, client }); } finally { await client.release(); }
  const tool = catalog.entries[0];
  store.setGrant({ grantId: "living-plugin-grant", bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
    contractDigest: tool.contractDigest, effect: "allow", approvalMode: "always", expectedRevision: 0 });
  const scopeId = crypto.createHash("sha256").update(JSON.stringify([component.componentId, connection.connectionId, connection.principalIdentity])).digest("hex");
  const effectsFile = path.join(f.paths.pluginDataDir, installation.installationId, scopeId, "effects.jsonl");
  return { serverId: pluginServerId(binding.bindingId), binding, tool,
    effects: () => fs.existsSync(effectsFile) ? fs.readFileSync(effectsFile, "utf8").trim().split("\n").map(JSON.parse) : [] };
}
test("real Service → authenticated helper → Controller: all 12 headless tools and automatic next-run guard", async t => {
  const f = await fixture(t), first = await f.send("以后发提醒前，按我设置的持续规则检查。"); f.setRun(first);
  const catalog = await f.helper({ jsonrpc: "2.0", id: 101, method: "tools/list", params: {} });
  assert.equal(catalog.result.tools.filter(tool => tool.name.startsWith("hook_")).length, 12);
  const ui = await f.ipc("harness.tools.list", { profileId: f.profile.id });
  assert.equal(ui.tools.some(tool => tool.name.startsWith("hook_")), false);
  // The workflow can be delivered inline or with the model-visible tool catalog.
  const hookGuidance = [f.host.startInputs[0].developerInstructions,
    catalog.result.tools.find(tool => tool.name === "hook_register").description].join("\n\n");
  assert.match(hookGuidance, /hook_capabilities/);
  const caps = await f.call("hook_capabilities", {});
  assert.equal(caps.isError, false); assert.equal(caps.structuredContent.activation, "next_run");
  assert.equal(caps.structuredContent.scopes.runtime_builtin.guard.status, "unsupported");
  const input = { schemaVersion: 1, name: "提醒前检查", event: "tool.before", kind: "guard",
    scope: { workspace: "current", sources: ["chat"] }, matcher: { toolScopes: ["product"], toolNames: ["notification_send"] },
    handler: { type: "builtin", name: "guard.block", config: { reason: "按持续规则暂停提醒" } } };
  const registered = await f.call("hook_register", { definition: input });
  assert.equal(registered.isError, false, JSON.stringify(registered));
  const saved = registered.structuredContent;
  assert.equal((await f.call("hook_list", {})).structuredContent.items.length, 1);
  assert.equal((await f.call("hook_get", { hookId: saved.hookId })).structuredContent.revision, 1);
  const tested = await f.call("hook_test", { hookId: saved.hookId, version: 1, payload: { arguments: {} } });
  assert.equal(tested.structuredContent.passed, true, JSON.stringify(tested));
  const granted = await f.call("hook_grant", { hookId: saved.hookId, version: 1 });
  assert.equal(granted.isError, false, JSON.stringify(granted));
  const enabled = await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: 1 });
  assert.equal(enabled.structuredContent.effectiveFrom, "next_run");
  await f.complete(first);
  const next = await f.send("请发一条测试提醒。"); f.setRun(next);
  const frozen = f.service.hookStore.snapshotForRun(next.id); assert.equal(frozen.entries[0].hookId, saved.hookId);
  const snapshot = f.service.contextSnapshotStore.get(f.profile.id, next.contextSnapshotId);
  assert.match(snapshot.developerInstructions, /FROZEN HOOK RULES/); assert.match(snapshot.developerInstructions, new RegExp(saved.hookId));
  const rejected = await f.call("notification_send", { runId: next.id, title: "测试", body: "被阻止的通知" });
  assert.equal(rejected.isError, true); assert.equal(f.sent.length, 0);
  const receipts = (await f.call("hook_executions", { runId: next.id })).structuredContent.items;
  assert.equal(receipts.length, 1); assert.equal(receipts[0].state, "settled");
  assert.equal((await f.call("hook_execution_get", { executionId: receipts[0].id })).structuredContent.event, "tool.before");
  const updated = await f.call("hook_update", { hookId: saved.hookId, expectedRevision: 2,
    definition: { ...input, name: "更新规则" } });
  assert.equal(updated.structuredContent.version, 2); assert.equal(f.service.hookStore.snapshotForRun(next.id).entries[0].version, 1);
  const disabled = await f.call("hook_disable", { hookId: saved.hookId, expectedRevision: 3 });
  assert.equal(disabled.structuredContent.effectiveFrom, "immediate");
  const removed = await f.call("hook_remove", { hookId: saved.hookId, expectedRevision: 4 });
  assert.equal(removed.structuredContent.removed, true);
  await f.complete(next);
  await f.service.stop({ notify: false }); await f.service.start();
  assert.equal(f.service.hookStore.list(f.profile.id).items.length, 0);
  assert.equal(f.service.hookRunner.closed, false);
});

test("real approval card uses transformed final arguments; deny and revoke send nothing", async t => {
  const f = await fixture(t), setup = await f.send("以后每条提醒发出前都让我确认。"); f.setRun(setup);
  const rule = (name, kind, config) => ({ schemaVersion: 1, name, event: "tool.before", kind,
    scope: { workspace: "current", sources: ["chat"] },
    matcher: { toolScopes: ["product"], toolNames: ["notification_send"] },
    handler: { type: "builtin", name: kind === "transform" ? "arguments.patch" : "guard.require_approval", config } });
  const enable = async definition => {
    const saved = (await f.call("hook_register", { definition })).structuredContent;
    assert.equal((await f.call("hook_test", { hookId: saved.hookId, version: 1,
      payload: { arguments: { runId: setup.id, title: "original", body: "body" } } })).structuredContent.passed, true);
    assert.equal((await f.call("hook_grant", { hookId: saved.hookId, version: 1 })).isError, false);
    return (await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: 1 })).structuredContent;
  };
  await enable(rule("提醒标题", "transform", { patch: { title: "最终标题" } }));
  const guard = await enable(rule("提醒发送确认", "guard", { reason: "每条提醒需要本人确认" }));
  await f.complete(setup);
  const run = await f.send("发送测试提醒。"); f.setRun(run);
  const send = () => f.call("notification_send", { runId: run.id, title: "original", body: "body" });
  const pending = send();
  await until(() => f.service.workDispatcher.getRun(run.id).status === "waiting_approval");
  const requestId = f.service.workDispatcher.getRun(run.id).waitingRequestId;
  const stream = await f.ipc("run.subscribe", { runId: run.id, streamId: null, afterSeq: 0, limit: 100 });
  const approval = stream.events.find(item => item.type === "approval" && item.payload.requestId === requestId);
  assert.ok(approval);
  assert.equal(JSON.parse(approval.payload.command).title, "最终标题");
  assert.equal(f.sent.length, 0);
  await f.ipc("run.approval.respond", { operationId: uuid(), createdAt: Date.now(), runId: run.id, requestId, choice: "once" });
  assert.equal((await pending).isError, false); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].title, "最终标题");
  const denied = send();
  await until(() => f.service.workDispatcher.getRun(run.id).status === "waiting_approval");
  await f.ipc("run.approval.respond", { operationId: uuid(), createdAt: Date.now(), runId: run.id,
    requestId: f.service.workDispatcher.getRun(run.id).waitingRequestId, choice: "deny" });
  assert.equal((await denied).isError, true); assert.equal(f.sent.length, 1);
  const revoked = send();
  await until(() => f.service.workDispatcher.getRun(run.id).status === "waiting_approval");
  const revokeRequest = f.service.workDispatcher.getRun(run.id).waitingRequestId;
  // Revoke while the human is reading the card, using the actual owning Store.
  f.service.hookStore.disable(f.profile.id, uuid(), guard.hookId, guard.revision);
  await f.ipc("run.approval.respond", { operationId: uuid(), createdAt: Date.now(), runId: run.id,
    requestId: revokeRequest, choice: "once" });
  assert.equal((await revoked).isError, true); assert.equal(f.sent.length, 1);
  await f.complete(run);
});

test("actual native MCP process: block sends zero frames, 2020 schema and final result reach helper, revoked configuration cannot send", async t => {
  const f = await fixture(t), native = registerNativeMcp(f);
  const setup = await f.send("以后购物报价超过 500 元就暂停，邮件地址在结果中隐去。"); f.setRun(setup);
  const rule = (name, event, kind, handler) => ({ schemaVersion: 1, name, event, kind,
    scope: { workspace: "current", sources: ["chat"] },
    matcher: { toolScopes: ["native_mcp"], toolNames: ["purchase_quote"], serverId: "living-native" }, handler });
  const enable = async definition => {
    const saved = (await f.call("hook_register", { definition })).structuredContent;
    assert.ok(saved?.hookId);
    assert.equal((await f.call("hook_test", { hookId: saved.hookId, version: 1,
      payload: { arguments: { amount: 600 }, result: { isError: false, text: "a@example.com" } } })).structuredContent.passed, true);
    assert.equal((await f.call("hook_grant", { hookId: saved.hookId, version: 1 })).isError, false);
    const enabled = await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: saved.revision });
    assert.equal(enabled.isError, false, JSON.stringify(enabled)); return enabled.structuredContent;
  };
  const guard = await enable(rule("报价预算", "tool.before", "guard", { type: "builtin", name: "guard.condition",
    config: { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "block", reason: "超出预算" } }));
  await enable(rule("报价邮箱隐去", "tool.result.transform", "transform", { type: "builtin", name: "result.redact", config: { patterns: ["email"] } }));
  await f.complete(setup);
  const run = await f.send("获取购物报价。"); f.setRun(run);
  const invoke = amount => f.call("mcp_server_call", { serverId: "living-native", toolName: "purchase_quote", arguments: { amount } });
  assert.equal((await invoke(600)).isError, true); assert.equal(native.effects().length, 0);
  assert.equal((await invoke(-1)).isError, true); assert.equal(native.effects().length, 0);
  const result = await invoke(200); assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.result.structuredContent.amount, 200);
  assert.equal(result.structuredContent.result.structuredContent.id, "quote-1");
  assert.doesNotMatch(JSON.stringify(result), /a@example\.com/); assert.match(JSON.stringify(result), /redacted/);
  assert.deepEqual(native.effects(), [{ amount: 200 }]);
  await f.complete(run);
  const update = await f.send("调整报价金额，并且每次提交前让我确认。"); f.setRun(update);
  assert.equal((await f.call("hook_disable", { hookId: guard.hookId, expectedRevision: guard.revision })).isError, false);
  await enable(rule("调整报价参数", "tool.before", "transform", { type: "builtin", name: "arguments.patch", config: { patch: { amount: 800 } } }));
  await enable(rule("报价提交确认", "tool.before", "guard", { type: "builtin", name: "guard.require_approval", config: { reason: "提交前确认" } }));
  await f.complete(update);
  const next = await f.send("再获取一次报价。"); f.setRun(next);
  const pending = invoke(20);
  await until(() => f.service.workDispatcher.getRun(next.id).status === "waiting_approval");
  const requestId = f.service.workDispatcher.getRun(next.id).waitingRequestId;
  const stream = await f.ipc("run.subscribe", { runId: next.id, streamId: null, afterSeq: 0, limit: 100 });
  assert.equal(JSON.parse(stream.events.find(item => item.type === "approval" && item.payload.requestId === requestId).payload.command).amount, 800);
  await f.ipc("run.approval.respond", { operationId: uuid(), createdAt: Date.now(), runId: next.id, requestId, choice: "once" });
  assert.equal((await pending).isError, false); assert.deepEqual(native.effects(), [{ amount: 200 }, { amount: 800 }]);
  const revoked = invoke(20);
  await until(() => f.service.workDispatcher.getRun(next.id).status === "waiting_approval");
  const revokedRequest = f.service.workDispatcher.getRun(next.id).waitingRequestId;
  f.service.nativeMcpStore.remove({ id: "living-native", expectedRevision: f.service.nativeMcpStore.revision });
  await f.ipc("run.approval.respond", { operationId: uuid(), createdAt: Date.now(), runId: next.id, requestId: revokedRequest, choice: "once" });
  assert.equal((await revoked).isError, true); assert.equal(native.effects().length, 2);
  await f.complete(next);
});

test("actual plugin MCP process: final schema, result redaction, one merged approval and Hook revocation fence", async t => {
  const f = await fixture(t), plugin = await registerPluginMcp(f);
  const setup = await f.send("以后每次询价不能超过预算，并隐去邮箱。"); f.setRun(setup);
  const rule = (name, event, kind, builtinName, config) => ({ schemaVersion: 1, name, event, kind,
    scope: { workspace: "current", sources: ["chat"] }, matcher: { toolScopes: ["plugin_mcp"], toolNames: ["purchase_quote"], serverId: plugin.serverId },
    handler: { type: "builtin", name: builtinName, config } });
  const enable = async definition => {
    const saved = (await f.call("hook_register", { definition })).structuredContent;
    assert.ok(saved?.hookId);
    assert.equal((await f.call("hook_test", { hookId: saved.hookId, version: 1,
      payload: { arguments: { amount: 600 }, result: { isError: false, text: "a@example.com" } } })).structuredContent.passed, true);
    assert.equal((await f.call("hook_grant", { hookId: saved.hookId, version: 1 })).isError, false);
    const enabled = await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: saved.revision });
    assert.equal(enabled.isError, false, JSON.stringify(enabled)); return enabled.structuredContent;
  };
  const guard = await enable(rule("插件报价预算", "tool.before", "guard", "guard.condition",
    { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "block", reason: "超出预算" }));
  await enable(rule("插件邮箱隐去", "tool.result.transform", "transform", "result.redact", { patterns: ["email"] }));
  await f.complete(setup);
  const run = await f.send("请求购物报价。"); f.setRun(run);
  const invoke = amount => f.call("mcp_server_call", { serverId: plugin.serverId, toolName: "purchase_quote", arguments: { amount } });
  assert.equal((await invoke(600)).isError, true); assert.equal((await invoke(-1)).isError, true);
  assert.equal(plugin.effects().length, 0);
  const result = await invoke(200); assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.result.structuredContent.id, "plugin-quote-1");
  assert.doesNotMatch(JSON.stringify(result), /a@example\.com/); assert.deepEqual(plugin.effects(), [{ amount: 200 }]);
  await f.complete(run);
  const update = await f.send("调整询价参数，每次提交前让我确认。"); f.setRun(update);
  await f.call("hook_disable", { hookId: guard.hookId, expectedRevision: guard.revision });
  await enable(rule("插件调整参数", "tool.before", "transform", "arguments.patch", { patch: { amount: 800 } }));
  const approvalRule = await enable(rule("插件提交确认", "tool.before", "guard", "guard.require_approval", { reason: "询价前确认" }));
  const grant = f.service.pluginStore.getGrant(plugin.binding.bindingId, plugin.tool.toolIdentity);
  f.service.pluginStore.setGrant({ grantId: grant.grantId, bindingId: plugin.binding.bindingId,
    toolIdentity: plugin.tool.toolIdentity, contractDigest: plugin.tool.contractDigest, effect: "allow", approvalMode: "each-call", expectedRevision: grant.revision });
  await f.complete(update);
  const next = await f.send("再获取购物报价。"); f.setRun(next);
  const approve = async (pending, revoke = false) => {
    await until(() => f.service.workDispatcher.getRun(next.id).status === "waiting_approval");
    const requestId = f.service.workDispatcher.getRun(next.id).waitingRequestId;
    const stream = await f.ipc("run.subscribe", { runId: next.id, streamId: null, afterSeq: 0, limit: 100 });
    const cards = stream.events.filter(item => item.type === "approval" && item.payload.requestId === requestId);
    assert.equal(cards.length, 1); assert.equal(JSON.parse(cards[0].payload.command).amount, 800);
    if (revoke) f.service.hookStore.disable(f.profile.id, uuid(), approvalRule.hookId, approvalRule.revision);
    await f.ipc("run.approval.respond", { operationId: uuid(), createdAt: Date.now(), runId: next.id, requestId, choice: "once" });
    return pending;
  };
  assert.equal((await approve(invoke(20))).isError, false);
  assert.deepEqual(plugin.effects(), [{ amount: 200 }, { amount: 800 }]);
  assert.equal((await approve(invoke(20), true)).isError, true); assert.equal(plugin.effects().length, 2);
  await f.complete(next);
});
