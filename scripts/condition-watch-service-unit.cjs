"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID: id } = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { parseBindingElicitation } = require("../app/agent-service/runtime-mcp-call-binding");
const { authenticateMcpSession, createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");
const { isPublishedNoticeEvent, watchNoticeEventId } = require("../app/agent-service/notice-delivery-controller");
const { ConditionWatchStore } = require("../app/agent-service/condition-watch-store");
const { normalizeDefinition } = require("../app/agent-service/condition-watch-protocol");
const { probe } = require("../app/agent-service/condition-watch-probe");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { createAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");

const MINUTE = 60_000;
const GROUP_URL = "https://group.example.com/stock";
const CHAT_URL = "https://direct.example.com/stock";
const BROKEN_URL = "https://broken.example.com/stock";
const REVIEW_URL = "https://review.example.com/stock";
const CONTROL_URL = "https://control.example.com/stock";
const stock = (url, extra = {}) => ({
  name: "128GB 补货", source: { kind: "public_json", url, path: ["inStock"] },
  predicate: { op: "equals", value: true }, intervalMs: MINUTE, ...extra,
});
const quote = url => `每分钟检查 ${url} 的 inStock，从缺货变成有货就发回这个会话。`;
async function until(fn, label) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out: ${label}`);
}

test("watch chat notices keep their published identity with or without old management links", () => {
  const watchId = `watch-${"a".repeat(64)}`, noticeId = `notice-${"b".repeat(64)}`;
  const event = { id: watchNoticeEventId(watchId, noticeId), kind: "assistant", runId: null, runtimeRef: null,
    content: { text: "An inventory watch matched.", proactiveNotice: { id: noticeId, kind: "condition_watch", watchId, items: [] } } };
  assert.equal(isPublishedNoticeEvent(event), true);
  const legacy = structuredClone(event);
  legacy.content.proactiveNotice.items = [{ title: "旧守望链接", href: "/cron?view=watches" }];
  assert.equal(isPublishedNoticeEvent(legacy), true);
  assert.equal(isPublishedNoticeEvent({ ...event, id: "another-event" }), false);
  assert.equal(isPublishedNoticeEvent({ ...event, runId: "model-run" }), false);
  const heartbeat = structuredClone(event);
  heartbeat.id = `proactive-${noticeId}`;
  heartbeat.content.proactiveNotice.kind = "heartbeat";
  assert.equal(isPublishedNoticeEvent(heartbeat), false, "other proactive notices still need items");
});

class WatchRuntime extends InspirationRuntime {
  reviews = [];
  released = [];
  reviewThreads = new Set();
  answer = "report";
  beforeReviewResult = null;
  async configRead() { return { config: { mcp_servers: { shoggoth: { command: "fixture" } } } }; }
  async experimentalFeatureList() { return { data: [{ name: "shell_tool", enabled: false }], nextCursor: null }; }
  async mcpServerStatusList() { return { data: [], nextCursor: null }; }
  async threadStart(params) {
    const result = await super.threadStart(params);
    if (!params.ephemeral) return result;
    this.reviewThreads.add(result.thread.id);
    assert.equal(params.config["mcp_servers.shoggoth.enabled"], false);
    assert.equal(params.config.web_search, "disabled");
    assert.equal(params.config.project_doc_max_bytes, 0);
    assert.equal(params.approvalPolicy, "never");
    return { ...result, model: "fixture-review-model", sandbox: { type: "readOnly", networkAccess: false },
      approvalPolicy: params.approvalPolicy };
  }
  async turnStart(params) {
    const result = await super.turnStart(params);
    if (!this.reviewThreads.has(params.threadId)) return result;
    assert.equal(params.model, "fixture-review-model");
    assert.equal(params.input.length, 1);
    const text = params.input[0].text;
    const evidence = JSON.parse(text.split("\n").at(-1).slice("Evidence (JSON): ".length));
    this.reviews.push({ evidence, operationId: params.clientUserMessageId, text });
    this.beforeReviewResult?.();
    if (this.answer !== "wait") {
      const run = { runtimeSessionRef: { sessionId: params.threadId }, runtimeTurnRef: { turnId: result.turn.id } };
      const body = { decision: this.answer === "dismiss" ? "dismiss" : "report",
        evidenceIds: [this.answer === "invalid" ? "unrelated-evidence" : evidence.id], note: "Fixture review." };
      if (this.answer !== "no-usage") this.emit({ known: true, type: "usage", method: "fixture/usage", threadId: params.threadId,
        turnId: result.turn.id, responseId: result.turn.id, usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
      super.complete(run, JSON.stringify(body));
    }
    return result;
  }
  async turnInterrupt(params) {
    await super.turnInterrupt(params);
    this.emit({ known: true, type: "complete", method: "turn/completed", threadId: params.threadId, turnId: params.turnId, status: "canceled" });
    return {};
  }
  async threadUnsubscribe({ threadId }) {
    assert(this.reviewThreads.delete(threadId));
    this.released.push(threadId);
    return { status: "unsubscribed" };
  }
}

test("direct and group MCP setup automatically previews and enables, quiet checks use no model, and outbox reconciles restarts", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-watch-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const host = new WatchRuntime();
  let now = Date.now();
  const stockValues = new Map([[GROUP_URL, false], [CHAT_URL, false], [REVIEW_URL, false], [CONTROL_URL, false]]);
  const reads = [];
  const systemNotices = [];
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text),
    decryptString: value => value.toString() };
  const service = createAgentService({ paths, now: () => now, safeStorage, prewarmMcpAuth: false,
    notificationSender: async notice => { systemNotices.push(notice); return { state: "submitted" }; },
    runtimePool: { async get() { return host; }, async stopAll() {} },
    setConditionWatchTimer: () => 1, clearConditionWatchTimer() {},
    setCronTimer: () => 1, clearCronTimer() {},
    conditionWatchReadProbe: (definition, options) => probe(definition, { ...options, request: async url => {
      reads.push({ url, preview: options.preview });
      return { url, status: 200, headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(stockValues.has(url) ? { inStock: stockValues.get(url) } : { missing: true })) };
    } }),
  });
  t.after(async () => {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const ipc = (method, params) => requestService(paths, {
    id: id(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params,
  }, { timeoutMs: 12_000 });
  const watch = async watchId => (await ipc("watch.get", { watchId })).watch;
  const history = async watchId => (await ipc("watch.history", { watchId })).checks;
  const waitCheck = (watchId, predicate) => until(async () => (await history(watchId)).find(predicate), "recorded check");
  const tick = () => service.conditionWatchService.tick();
  const createAgent = name => ipc("agent.create", { operationId: id(), backendId: "shoggoth", name, defaultCwd: null, createdAt: now });
  await createAgent("Gemini");
  await createAgent("Other");
  const profiles = service.productStore.listAgentProfiles();
  const gemini = profiles.find(item => item.name === "Gemini");
  const createGroup = name => ipc("group.create", { operationId: id(), name, purpose: "",
    members: profiles.map(item => ({ backendId: "shoggoth", agentId: item.agentId })) });
  const newsroom = (await createGroup("示例监测群")).group;
  const other = (await createGroup("另一个群")).group;
  const member = (await ipc("group.get", { groupId: newsroom.id })).members.find(item => item.profileId === gemini.id || item.agentId === gemini.agentId);
  const sendGroup = body => ipc("group.send", { groupId: newsroom.id, clientMessageId: id(), body,
    mentions: [member.id], replyTo: null, attachments: [] });
  const groupRun = () => until(() => {
    const turn = service.groupChatStore.runningOpportunities().find(item => item.groupId === newsroom.id && item.runId);
    const run = turn && service.workDispatcher.getRun(turn.runId);
    return run?.status === "running" && run.runtimeTurnRef && run;
  }, "bound group turn");
  const groupNotices = () => service.groupChatStore.listMessages({ groupId: newsroom.id, limit: 50 }).messages
    .filter(message => message.origin?.watchId);
  async function directRun(session, prompt) {
    const sent = await ipc("chat.send", { operationId: id(), sessionKey: session.sessionKey, prompt, createdAt: now });
    return until(() => {
      const run = service.workDispatcher.getRun(sent.run?.id ?? sent.runId);
      return run?.status === "running" && run.runtimeTurnRef && run;
    }, "bound direct turn");
  }
  const finish = async run => {
    host.complete(run, "已读取真实守望状态。");
    await until(() => service.workDispatcher.getRun(run.id).status === "completed", "turn completed");
  };
  const directTool = (run, name, args) => service.workRunCoordinator.invokeRuntimeCapability({
    ...run.runtimeTurnRef, runId: run.id,
  }, scope => service.mcpProductToolController.handle(name, args, { profileId: run.profileId, callId: id() }, scope));
  async function viaHelper(run, name, args) {
    const { runtimeProfileId, runtimeAccountId } = run.runtimeTurnRef;
    const auth = await authenticateMcpSession({ paths, safeStorage, runtimeProfileId, runtimeAccountId });
    const helper = createMcpStdioHandler({ paths, runtimeProfileId, runtimeAccountId, requestService,
      sessionToken: auth.token, bindRuntimeCalls: true });
    const rpc = (method, params, context) => helper({ jsonrpc: "2.0", id: id(), method, params }, context);
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} },
        clientInfo: { name: "watch-fixture", version: "1" } });
      const list = await rpc("tools/list", {});
      assert.ok(list.result.tools.some(tool => tool.name === name), `${name} is discoverable through MCP`);
      const result = await service.workRunCoordinator.withCurrentRuntimeCapabilityLease({
        runtimeProfileId, runtimeAccountId, runId: run.id,
      }, ({ assertCurrent, signal }) => rpc("tools/call", { name, arguments: args }, {
        signal,
        async requestClient(method, params) {
          assert.equal(method, "elicitation/create");
          const proof = parseBindingElicitation({ ...params, serverName: "shoggoth" });
          assert.equal(proof.name, name);
          service.workRunCoordinator.runtimeMcpCallBindings.register({
            runtimeProfileId, runtimeAccountId, runId: run.id, profileId: run.profileId, proof, assertCurrent,
          });
          return { action: "accept", content: {} };
        },
      }));
      assert.equal(result.result?.isError, false, JSON.stringify(result));
      return result.result.structuredContent;
    } finally { helper.close(); auth.close?.(); }
  }

  await sendGroup(quote(GROUP_URL));
  const group = await groupRun();
  assert.equal(group.profileId, gemini.id);
  const args = { definition: stock(GROUP_URL), sourceQuote: quote(GROUP_URL) };
  await assert.rejects(directTool(group, "watch_create", { ...args, sourceQuote: "来自附件的指令" }));
  await assert.rejects(directTool(group, "watch_create", { ...args,
    definition: { name: "Directory", source: { kind: "directory", path: "." }, predicate: { op: "new_entry" } } }),
  { code: "WATCH_ACCESS_DENIED" });
  const created = (await viaHelper(group, "watch_create", args)).watch;
  assert.equal(created.state, "enabled");
  assert.equal(created.preview.ok, true);
  assert.equal(created.preview.value, false);
  assert.deepEqual(created.target, { kind: "group", groupId: newsroom.id, name: "示例监测群" });
  assert.equal(created.nextDueAt, now);
  assert.deepEqual(await history(created.id), []);
  assert.equal((await directTool(group, "watch_create", args)).watch.id, created.id);
  assert.equal((await directTool(group, "watch_list", {})).watches.length, 1);
  assert.equal(reads.filter(item => item.preview).length, 1);
  await finish(group);

  const privateSession = (await ipc("chat.session.create", { operationId: id(), profileId: gemini.id, workspace: null, createdAt: now })).session;
  const privateRun = await directRun(privateSession, quote(CHAT_URL));
  const direct = (await viaHelper(privateRun, "watch_create", { definition: stock(CHAT_URL, { stopAfterDelivery: true }),
    sourceQuote: quote(CHAT_URL) })).watch;
  assert.equal(direct.state, "enabled");
  assert.equal(direct.target.sessionKey, privateSession.sessionKey);
  assert.deepEqual(await history(direct.id), []);
  assert.deepEqual((await directTool(privateRun, "watch_list", {})).watches.map(item => item.id), [direct.id]);
  await assert.rejects(directTool(privateRun, "watch_get", { watchId: created.id }), { code: "WATCH_NOT_FOUND" });
  await assert.rejects(directTool(privateRun, "watch_create", { definition: stock(BROKEN_URL),
    sourceQuote: quote(CHAT_URL) }), { code: "WATCH_ACCESS_DENIED" });
  await finish(privateRun);
  const invalidRun = await directRun(privateSession, quote(BROKEN_URL));
  const invalid = (await directTool(invalidRun, "watch_create", { definition: stock(BROKEN_URL),
    sourceQuote: quote(BROKEN_URL) })).watch;
  assert.equal(invalid.state, "draft");
  assert.equal(invalid.preview.reason, "WATCH_SOURCE_INVALID");
  await assert.rejects(ipc("watch.setEnabled", { operationId: id(), watchId: invalid.id, expectedRevision: invalid.revision, enabled: true }),
    { code: "WATCH_TEST_REQUIRED" });
  await finish(invalidRun);

  const runCount = service.workDispatcher.listRuns().length;
  const modelCount = host.turnStarts;
  tick();
  await waitCheck(created.id, check => check.outcome === "seed");
  await waitCheck(direct.id, check => check.outcome === "seed");
  const liveSession = service.chatSessionStore.getSession(privateSession.sessionKey);
  const directNotices = () => service.transcriptStore.listEvents(gemini.id, liveSession.id).filter(isPublishedNoticeEvent);
  assert.deepEqual(groupNotices(), []);
  assert.deepEqual(directNotices(), []);
  const beforePreview = service.conditionWatchStore.get(created.id).checkpoint;
  stockValues.set(GROUP_URL, true);
  const preview = (await ipc("watch.test", { watchId: created.id, expectedRevision: (await watch(created.id)).revision })).watch;
  assert.equal(preview.preview.matches, true);
  assert.deepEqual(service.conditionWatchStore.get(created.id).checkpoint, beforePreview);
  assert.deepEqual(groupNotices(), []);
  stockValues.set(GROUP_URL, false);
  now += MINUTE;
  tick();
  await waitCheck(created.id, check => check.outcome === "silent");
  await waitCheck(direct.id, check => check.outcome === "silent");
  assert.equal(service.workDispatcher.listRuns().length, runCount);
  assert.equal(host.turnStarts, modelCount);

  const registry = new BackendRegistry();
  const backend = new ShoggothBackend({ paths });
  registry.register(backend);
  assert.equal((await registry.start()).get(backend.id), true);
  const web = await startStaticServer(0, { registry, homeDir: root, userDataRoot: path.join(root, "web") });
  try {
    const request = (method, params = {}) => fetch(`${web.url}/__api/condition-watches`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: web.url }, body: JSON.stringify({ method, params }),
    });
    assert.equal((await request("watch.list", { profileId: gemini.id })).status, 404);
    assert.equal((await request("watch.setEnabled", { operationId: id(), watchId: created.id,
      expectedRevision: (await watch(created.id)).revision, enabled: false })).status, 404);
    assert.equal((await watch(created.id)).state, "enabled");
  } finally { await web.close(); await registry.stop(); }

  stockValues.set(GROUP_URL, true);
  stockValues.set(CHAT_URL, true);
  now += MINUTE;
  const publish = service.groupChatService.publishWatchReply;
  service.groupChatService.publishWatchReply = () => {
    throw Object.assign(new Error("fixture stops before chat write"), { code: "SQLITE_BUSY" });
  };
  try {
    tick();
    await waitCheck(created.id, check => check.event?.state === "pending" && check.event.reason);
    await waitCheck(direct.id, check => check.event?.state === "published");
  } finally { service.groupChatService.publishWatchReply = publish; }
  assert.deepEqual(groupNotices(), []);
  assert.equal(directNotices().length, 1);
  assert.equal((await watch(direct.id)).state, "completed");

  // Restart with a committed hit and no destination message.
  await service.stop({ notify: false });
  now += MINUTE;
  await service.start();
  const settle = service.conditionWatchStore.settleDelivery;
  service.conditionWatchStore.settleDelivery = function (event, outcome) {
    if (outcome.receipt && event.watchId === created.id) return this.event(event.id);
    return settle.call(this, event, outcome);
  };
  try { tick(); } finally { service.conditionWatchStore.settleDelivery = settle; }
  const message = groupNotices()[0];
  assert.ok(message, "the pending hit is replayed to the exact original group");
  assert.equal(message.author.memberId, member.id);
  assert.match(message.body, /条件守望/u);
  assert.equal((await history(created.id)).find(check => check.event)?.event.state, "writing");
  assert.equal(service.groupChatStore.listMessages({ groupId: other.id, limit: 20 }).messages.length, 0);
  await service.stop({ notify: false });
  await service.start();
  tick();
  const receipt = (await waitCheck(created.id, check => check.event?.state === "published")).event.receipt;
  assert.equal(receipt.messageId, message.id);
  assert.deepEqual(groupNotices().map(item => item.id), [message.id]);
  assert.equal(directNotices().length, 1);
  assert.deepEqual(directNotices()[0].content.proactiveNotice.items, []);
  assert.equal(systemNotices.filter(notice => notice.noticeId.startsWith("condition-watch-")).length, 2);
  assert.equal(new Set(systemNotices.map(notice => notice.noticeId)).size, systemNotices.length);
  assert.equal(service.workDispatcher.listRuns().length, runCount);
  assert.equal(host.turnStarts, modelCount);

  const editQuote = `请把打不开的库存守望改成 ${CONTROL_URL}，试跑通过就启用。`;
  const editRun = await directRun(privateSession, editQuote);
  const firstPage = await viaHelper(editRun, "watch_list", { cursor: null, limit: 1 });
  assert.equal(firstPage.watches.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await viaHelper(editRun, "watch_list", { cursor: firstPage.nextCursor, limit: 1 });
  assert.deepEqual(new Set([...firstPage.watches, ...secondPage.watches].map(item => item.id)), new Set([direct.id, invalid.id]));
  assert.equal(secondPage.nextCursor, null);
  const { watch: beforeEdit } = await directTool(editRun, "watch_get", { watchId: invalid.id });
  const { watch: edited } = await viaHelper(editRun, "watch_update", {
    watchId: invalid.id, expectedRevision: beforeEdit.revision, definition: stock(CONTROL_URL), sourceQuote: editQuote,
  });
  assert.equal(edited.state, "draft");
  const { watch: tested } = await viaHelper(editRun, "watch_test", {
    watchId: invalid.id, expectedRevision: edited.revision, sourceQuote: editQuote,
  });
  assert.equal(tested.preview.ok, true);
  const { watch: activated } = await viaHelper(editRun, "watch_set_enabled", {
    watchId: invalid.id, expectedRevision: tested.revision, enabled: true, sourceQuote: editQuote,
  });
  assert.equal(activated.state, "enabled");
  await finish(editRun);
  const changeEnabled = async (enabled, sourceQuote, expectedRevision) => {
    const run = await directRun(privateSession, sourceQuote);
    const result = await viaHelper(run, "watch_set_enabled", { watchId: invalid.id, expectedRevision, enabled, sourceQuote });
    await finish(run);
    return result.watch;
  };
  const paused = await changeEnabled(false, "暂停刚修好的库存守望。", activated.revision);
  assert.equal(paused.state, "paused");
  const resumed = await changeEnabled(true, "恢复刚暂停的库存守望。", paused.revision);
  assert.equal(resumed.state, "enabled");
  const deleteQuote = "删除刚恢复的库存守望。";
  const deleteRun = await directRun(privateSession, deleteQuote);
  assert.deepEqual(await viaHelper(deleteRun, "watch_delete", { watchId: invalid.id,
    expectedRevision: resumed.revision, sourceQuote: deleteQuote }), { watchId: invalid.id, deleted: true });
  assert.deepEqual((await directTool(deleteRun, "watch_list", {})).watches.map(item => item.id), [direct.id]);
  await finish(deleteRun);

  const workspace = path.join(root, "log-workspace");
  fs.mkdirSync(workspace);
  const logFile = path.join(workspace, "service.log");
  fs.writeFileSync(logFile, "ERROR before preview\n");
  const logQuote = "每分钟检查 service.log，新一行含 ERROR 就告诉我。";
  const logDefinition = { name: "日志", source: { kind: "log_file", path: "service.log" },
    predicate: { op: "new_line", contains: "ERROR" } };
  await sendGroup(logQuote);
  const localGroupRun = await groupRun();
  await assert.rejects(directTool(localGroupRun, "watch_create", { definition: logDefinition, sourceQuote: logQuote }),
    { code: "WATCH_ACCESS_DENIED" });
  await finish(localGroupRun);
  const logSession = (await ipc("chat.session.create", { operationId: id(), profileId: gemini.id, workspace, createdAt: now })).session;
  const logRun = await directRun(logSession, logQuote);
  await assert.rejects(directTool(logRun, "watch_create", { definition: { ...logDefinition, predicate: { op: "new_line", contains: "INFO" } },
    sourceQuote: logQuote }), { code: "WATCH_ACCESS_DENIED" });
  const logWatch = (await viaHelper(logRun, "watch_create", { definition: logDefinition, sourceQuote: logQuote })).watch;
  assert.equal(logWatch.state, "enabled");
  assert.equal(logWatch.reviewAvailable, false);
  assert.deepEqual(logWatch.preview.value, { count: 0 });
  await finish(logRun);
  fs.appendFileSync(logFile, "ERROR appended before first live poll synthetic-private-log\n");

  const criteria = "命中后用模型复核，只在明确有货时提醒我";
  const reviewQuote = `每分钟检查 ${REVIEW_URL} 的 inStock，从缺货变成有货时${criteria}。`;
  await sendGroup(reviewQuote);
  const reviewRun = await groupRun();
  const reviewDefinition = stock(REVIEW_URL, { action: "agent_review", reviewInstruction: criteria, stopAfterDelivery: true });
  await assert.rejects(directTool(reviewRun, "watch_create", {
    definition: { ...reviewDefinition, reviewInstruction: "Other instructions" }, sourceQuote: reviewQuote,
  }), { code: "WATCH_ACCESS_DENIED" });
  const reviewed = (await viaHelper(reviewRun, "watch_create", { definition: reviewDefinition, sourceQuote: reviewQuote })).watch;
  assert.equal(reviewed.state, "enabled");
  assert.equal(reviewed.reviewAvailable, true);
  assert.equal(reviewed.preview.value, false);
  assert.equal(host.reviews.length, 0);
  await finish(reviewRun);
  const postSetupRuns = service.workDispatcher.listRuns().length;
  const checkLog = () => service.transcriptStore.listEvents(gemini.id, logSession.id).filter(isPublishedNoticeEvent);
  const reviewNotices = () => groupNotices().filter(message => message.origin.watchId === reviewed.id);
  const waitReview = state => waitCheck(reviewed.id, check => check.event?.state === state);
  tick();
  await waitCheck(reviewed.id, check => check.outcome === "seed");
  const logHit = await waitCheck(logWatch.id, check => check.event?.state === "published");
  assert.deepEqual(logHit.event.evidence, { count: 1, gap: false });
  assert.equal(checkLog().length, 1);
  assert.doesNotMatch(JSON.stringify(checkLog()), /synthetic-private-log/u);
  assert.doesNotMatch(JSON.stringify(await history(logWatch.id)), /synthetic-private-log/u);
  now += MINUTE;
  tick();
  await waitCheck(reviewed.id, check => check.outcome === "silent");
  assert.equal(host.reviews.length, 0);

  const poll = async (value, outcome) => {
    stockValues.set(REVIEW_URL, value);
    now += MINUTE;
    const observedAt = now;
    tick();
    return waitCheck(reviewed.id, check => check.startedAt === observedAt && check.outcome === outcome);
  };
  async function retryReview(eventId) {
    const sourceQuote = "请重试刚才未完成的守望复核。";
    await sendGroup(sourceQuote);
    const run = await groupRun();
    const { watch: saved } = await directTool(run, "watch_get", { watchId: reviewed.id });
    const { checks } = await directTool(run, "watch_history", { watchId: reviewed.id });
    assert(checks.some(check => check.event?.id === eventId && ["review_failed", "review_uncertain"].includes(check.event.state)));
    const result = await viaHelper(run, "watch_retry_event", { watchId: reviewed.id, expectedRevision: saved.revision, eventId, sourceQuote });
    assert.equal(result.eventId, eventId);
    await finish(run);
  }
  await poll(true, "hit");
  assert.equal(host.reviews.length, 0, "hit is committed before the first model request");
  host.answer = "dismiss";
  tick();
  const dismissed = (await waitReview("dismissed")).event;
  assert.deepEqual(dismissed.review.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(dismissed.review.decision, "dismiss");
  assert.equal((await watch(reviewed.id)).state, "enabled", "a one-shot watch keeps watching after dismissal");
  assert.deepEqual(reviewNotices(), []);
  assert.match(host.reviews[0].text, new RegExp(criteria, "u"));
  assert.equal(host.reviews[0].evidence.id, dismissed.id);
  assert.equal(Object.hasOwn(dismissed.review, "fingerprint"), false);

  await poll(false, "silent");
  await poll(true, "hit");
  host.answer = "invalid";
  tick();
  const invalidReview = (await waitReview("review_failed")).event;
  assert.equal(invalidReview.reason, "WATCH_REVIEW_INVALID");
  assert.deepEqual(reviewNotices(), []);
  await retryReview(invalidReview.id);
  host.answer = "no-usage";
  tick();
  const unmeasured = (await waitReview("review_failed")).event;
  assert.equal(unmeasured.reason, "WATCH_REVIEW_USAGE_UNKNOWN");
  assert.equal(unmeasured.review.attempts, 2);
  await retryReview(invalidReview.id);
  host.answer = "wait";
  tick();
  await until(() => host.reviews.length === 4, "in-flight model review");
  assert.equal((await waitReview("reviewing")).event.id, invalidReview.id);
  await service.stop({ notify: false });
  await service.start();
  now += MINUTE;
  tick();
  assert.equal((await waitReview("review_uncertain")).event.id, invalidReview.id);
  assert.equal(host.reviews.length, 4);
  assert.deepEqual(reviewNotices(), []);
  assert.equal(checkLog().length, 1, "restart does not replay matched log bytes");

  await retryReview(invalidReview.id);
  host.answer = "report";
  const publishReview = service.groupChatService.publishWatchReply;
  service.groupChatService.publishWatchReply = function (input) {
    if (input.watchId === reviewed.id) throw Object.assign(new Error("interrupted before group write"), { code: "SQLITE_BUSY" });
    return publishReview.call(this, input);
  };
  try {
    tick();
    await waitCheck(reviewed.id, check => check.event?.review?.decision === "report" && check.event.state === "pending" && check.event.reason);
  } finally { service.groupChatService.publishWatchReply = publishReview; }
  assert.deepEqual(reviewNotices(), []);
  await service.stop({ notify: false });
  await service.start();
  now += MINUTE;
  tick();
  const reported = (await waitReview("published")).event;
  assert.equal(reported.id, invalidReview.id);
  assert.equal(reported.review.model, "fixture-review-model");
  assert.equal(reported.review.attempts, 4);
  assert.equal(reviewNotices().length, 1);
  assert.equal(reviewNotices()[0].id, reported.receipt.messageId);
  assert.equal(reviewNotices()[0].author.memberId, member.id);
  assert.match(reviewNotices()[0].body, /review\.example\.com/u);
  assert.equal(service.groupChatStore.listMessages({ groupId: other.id, limit: 20 }).messages.length, 0);
  assert.equal(directNotices().length, 1);
  assert.equal(checkLog().length, 1);
  assert.equal(host.reviews.length, 5);
  assert.equal(host.released.length, 5);
  assert.equal(service.workDispatcher.listRuns().length, postSetupRuns + 3, "only the three user-requested retry chats added WorkRuns");
  assert.equal((await watch(reviewed.id)).state, "completed");

  const resumeLog = await watch(logWatch.id);
  fs.appendFileSync(logFile, "ERR");
  const logCheck = async () => {
    const sourceQuote = "现在检查一次日志守望。";
    const run = await directRun(logSession, sourceQuote);
    const { watch: current } = await directTool(run, "watch_get", { watchId: logWatch.id });
    const { checkId } = await viaHelper(run, "watch_check_now", {
      watchId: logWatch.id, expectedRevision: current.revision, sourceQuote,
    });
    const check = await waitCheck(logWatch.id, entry => entry.id === checkId && entry.outcome !== "reading");
    const page = await viaHelper(run, "watch_history", { watchId: logWatch.id, limit: 1 });
    assert.equal(page.checks[0]?.id, checkId);
    assert.equal(page.checks[0]?.outcome, check.outcome);
    assert.ok(page.nextCursor);
    const older = await directTool(run, "watch_history", { watchId: logWatch.id, limit: 1, cursor: page.nextCursor });
    assert.equal(older.checks.length, 1);
    assert.notEqual(older.checks[0].id, checkId);
    await finish(run);
    return check;
  };
  await waitCheck(logWatch.id, check => check.startedAt === now && check.outcome === "silent");
  assert.equal((await logCheck()).outcome, "silent");
  assert.equal((await watch(logWatch.id)).revision, resumeLog.revision);
  await service.stop({ notify: false });
  await service.start();
  fs.appendFileSync(logFile, "OR completed after restart\n");
  assert.equal((await logCheck()).event?.evidence.count, 1);
  assert.equal(checkLog().length, 2);
  assert.equal((await logCheck()).outcome, "silent");
  assert.equal(host.reviews.length, 5);

  // A default-route change after generation starts fences even a valid result.
  const fenced = (await ipc("watch.create", { operationId: id(), target: { sessionKey: privateSession.sessionKey },
    definition: { ...reviewDefinition, stopAfterDelivery: false, notifyIfInitiallyMatched: true } })).watch;
  now += MINUTE;
  const ready = (await ipc("watch.test", { watchId: fenced.id, expectedRevision: fenced.revision })).watch;
  assert.equal(ready.preview.ok, true);
  await ipc("watch.setEnabled", { operationId: id(), watchId: fenced.id, expectedRevision: ready.revision, enabled: true });
  tick();
  await waitCheck(fenced.id, check => check.event?.state === "review_queued");
  host.beforeReviewResult = () => {
    const bindings = service.productStore.getAgentRuntimeBindings(gemini.id);
    service.productStore.setAgentDefaultModel(gemini.id, bindings.defaultBindingId, {
      revision: bindings.revision, model: "fixture-changed-default",
    });
  };
  try {
    tick();
    const failed = await waitCheck(fenced.id, check => check.event?.state === "review_failed");
    assert.equal(failed.event.reason, "WATCH_REVIEW_ROUTE_CHANGED");
  } finally { host.beforeReviewResult = null; }
  assert.equal(directNotices().length, 1);
  assert.equal(host.reviews.length, 6);

  const latest = await ipc("group.get", { groupId: newsroom.id });
  await ipc("group.members.remove", { groupId: newsroom.id, memberId: member.id, expectedRosterRevision: latest.group.rosterRevision });
  now += 2 * MINUTE;
  tick();
  assert.equal((await watch(created.id)).state, "blocked");
  assert.deepEqual(new Set(groupNotices().map(item => item.id)), new Set([message.id, reported.receipt.messageId]));

  await service.stop({ notify: false });
  const backupId = "condition-watch-verification";
  const backup = createAuthorityBackup({ paths, backupId });
  assert.ok(backup.manifest.entries.some(entry => entry.path === "condition-watches.sqlite"));
  const restoredState = path.join(root, "restored-state");
  restoreAuthorityBackup({ paths, backupId, destinationStateDir: restoredState });
  const restored = new ConditionWatchStore({ paths: { ...paths, stateDir: restoredState }, now: () => now }).open();
  try {
    assert.equal(restored.get(created.id).state, "paused");
    assert.equal(restored.get(created.id).checkpoint, null);
    assert.equal(restored.get(created.id).test, null);
    assert.equal(restored.get(direct.id).state, "completed");
    assert.equal(restored.history(created.id).checks.find(check => check.event?.state === "published").event.receipt.messageId, message.id);
    assert.deepEqual(restored.pending(now), []);
  } finally { restored.close(); }
});

test("store recovery interrupts an unfinished read and authority restore revokes its previews and pending delivery", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-store-")));
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  let now = Date.now();
  const store = new ConditionWatchStore({ paths, now: () => now }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const rule = normalizeDefinition(stock(CHAT_URL, { notifyIfInitiallyMatched: true }));
  const target = { kind: "chat", profileId: "profile", sessionKey: "chat", sessionId: "session", messageId: null };
  const watchId = `watch-${"a".repeat(64)}`;
  const saved = store.operation("create", watchId, rule, () => store.create(watchId, rule, target));
  const tested = store.saveTest(saved.id, 1, 1, { ok: true, expiresAt: now + MINUTE, version: 1, epoch: 1, binding: { url: CHAT_URL } });
  const enabled = store.operation("enable", saved.id, true, () => store.setEnabled(tested, true));
  const inFlight = store.claim(enabled.id, now).check;
  store.close();
  now += 10;
  store.open();
  store.recover();
  assert.equal(store.getCheck(inFlight.id).outcome, "interrupted");
  const { check } = store.claim(enabled.id, now);
  assert.equal(store.rememberCheck(enabled.id, "manual-coalesced", check.id), check.id);
  assert.deepEqual(store.manualCheck(enabled.id, "manual-coalesced"), { id: check.id });
  const event = store.settle(check, { outcome: "hit", reason: "matched", checkpoint: { baseline: { value: true, matched: true } },
    evidence: { value: true } });
  assert.equal(event.state, "pending");
  store.recover({ restore: true });
  assert.equal(store.get(enabled.id).state, "paused");
  assert.equal(store.get(enabled.id).binding, null);
  assert.equal(store.event(event.id).state, "canceled");
});

test("restart with an interrupted slot at the same clock value claims a new slot without reusing the identity", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-slot-")));
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  let now = Date.now();
  const store = new ConditionWatchStore({ paths, now: () => now }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const rule = normalizeDefinition(stock(CHAT_URL));
  const target = { kind: "chat", profileId: "profile", sessionKey: "chat", sessionId: "session", messageId: null };
  const watchId = `watch-${"b".repeat(64)}`;
  const watch = store.operation("create", watchId, rule, () => store.create(watchId, rule, target));
  const tested = store.saveTest(watch.id, 1, 1, { ok: true, expiresAt: now + MINUTE, version: 1, epoch: 1, binding: { url: CHAT_URL } });
  const enabled = store.operation("enable", watch.id, true, () => store.setEnabled(tested, true));
  const first = store.claim(enabled.id, now).check;
  store.close();
  store.open();
  store.recover();
  assert.equal(store.getCheck(first.id).outcome, "interrupted");
  assert.equal(store.claim(watchId, now), null);
  now += 1;
  const second = store.claim(watchId, now).check;
  assert.notEqual(first.id, second.id);
  const result = store.settle(second, { outcome: "seed", reason: "baseline", checkpoint: { baseline: { value: false, matched: false } } });
  assert.equal(result, null);
  assert.equal(store.get(watchId).checkpoint.baseline.value, false);
});

test("review quota survives restart and deletion, and upgrading the original watch database keeps its watches", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-review-quota-")));
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  let now = Date.UTC(2026, 10, 13, 2);
  const store = new ConditionWatchStore({ paths, now: () => now }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const target = { kind: "chat", profileId: "profile", sessionKey: "chat", sessionId: "session", messageId: null };
  const definition = normalizeDefinition(stock(CHAT_URL));
  const legacyId = `watch-${"0".repeat(64)}`;
  store.operation("legacy", legacyId, definition, () => store.create(legacyId, definition, target));
  store.db.exec("DROP TABLE review_attempts; PRAGMA user_version=1");
  store.close();
  store.open();
  assert.deepEqual(store.get(legacyId).definition, definition);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
  const route = { bindingId: "binding", runtime: "codex", model: "model", fingerprint: "fixed-route" };
  function create(index) {
    const watchId = `watch-${index.toString(16).padStart(64, "0")}`;
    const url = `https://example.com/test-${index}`;
    const rule = normalizeDefinition(stock(url, { action: "agent_review", reviewInstruction: "Review only if available." }));
    const watch = store.operation(`create-${index}`, watchId, rule, () => store.create(watchId, rule, target));
    const tested = store.saveTest(watch.id, 1, 1, { ok: true, expiresAt: now + MINUTE, version: 1, epoch: 1, binding: { url } });
    return store.operation(`enable-${index}`, watch.id, true, () => store.setEnabled(tested, true));
  }
  function hit(watch, index) {
    const check = store.claim(watch.id, now, `check-${watch.id}-${index}`).check;
    return store.settle(check, { outcome: "hit", reason: "matched", checkpoint: { baseline: { value: true } }, evidence: { value: true } });
  }
  for (let watchIndex = 1; watchIndex <= 3; watchIndex++) {
    const watch = create(watchIndex);
    for (let index = 1; index <= 10; index++) {
      const event = hit(watch, index);
      const claim = store.claimReview(event.id, route);
      assert.equal(claim.state, "reviewing");
      assert.equal(store.claimReview(event.id, route), null);
      store.settleReview(event.id, claim.review.operationId, { decision: "dismiss", note: "Reviewed", usage: { inputTokens: 1, outputTokens: 2 } });
    }
    if (watchIndex === 1) {
      const event = hit(watch, 11);
      assert.equal(store.claimReview(event.id, route), null);
      assert.equal(store.event(event.id).reason, "WATCH_REVIEW_LIMITED");
      store.operation("delete-review-watch", watch.id, true, () => store.delete(watch));
    }
  }
  const overflow = create(4);
  const event = hit(overflow, 1);
  store.close();
  store.open();
  store.recover();
  assert.equal(store.claimReview(event.id, route), null, "deleted watches still count towards the Profile limit");
  assert.equal(store.event(event.id).reason, "WATCH_REVIEW_LIMITED");
  assert.deepEqual(store.db.prepare("SELECT sum(input_tokens) AS input, sum(output_tokens) AS output FROM review_attempts").get(),
    Object.assign(Object.create(null), { input: 30, output: 60 }));
  now += 86_400_000;
  store.operation("retry-next-day", overflow.id, event.id, () => store.retry(overflow, event.id));
  const claim = store.claimReview(event.id, route);
  store.close();
  store.open();
  store.recover();
  assert.equal(store.event(event.id).state, "review_uncertain");
  assert.deepEqual(store.pendingReviews(now, 10), []);
  assert.equal(store.settleReview(event.id, claim.review.operationId, { decision: "report" }), null);
  assert.equal(store.event(event.id).state, "review_uncertain");
});
