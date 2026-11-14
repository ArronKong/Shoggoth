"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { parseBindingElicitation } = require("../app/agent-service/runtime-mcp-call-binding");
const { authenticateMcpSession, createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");

const id = () => crypto.randomUUID();
const QUOTE = "持续查看示例观测站的维护公告，有新消息请发到本群";
const REPORT = "有一项新的官方披露。[示例公告](https://example.com/news/observatory-update)";
const INTERVAL = 30 * 60_000;

async function until(read, label) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out: ${label}`);
}

test("group Cron uses shared silence and duplicate rules and delivers only to its originating group", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-group-cron-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const host = new InspirationRuntime();
  let now = Date.now();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
    decryptString: value => value.toString() };
  const service = createAgentService({
    paths, now: () => now, prewarmMcpAuth: false, setCronTimer: () => 1, clearCronTimer() {},
    safeStorage,
    runtimePool: { async get() { return host; }, async stopAll() {} },
  });
  const activities = [];
  const backend = new ShoggothBackend({ paths, serviceEventPollMs: 25,
    async requestService(servicePaths, request, options) {
      const result = await requestService(servicePaths, request, options);
      return request.method === "service.status" ? { ...result, mcpCredentialsLocked: false } : result;
    },
  });
  t.after(async () => {
    await backend.stop();
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const ipc = async (method, params) => {
    try {
      return await requestService(paths, {
        id: id(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params,
      }, { timeoutMs: 8_000 });
    } catch (error) {
      error.message = `${method}: ${error.message}`;
      throw error;
    }
  };
  for (const name of ["Fixture reporter", "Other member"]) {
    await ipc("agent.create", { operationId: id(), backendId: "shoggoth", name, defaultCwd: null, createdAt: now });
  }
  const profile = service.productStore.listAgentProfiles().find(item => item.name === "Fixture reporter");
  const [a, b] = service.productStore.listAgentProfiles().filter(item => item.id !== profile.id);
  assert.equal(a.id, DEFAULT_AGENT_PROFILE_ID);
  const group = async name => (await ipc("group.create", { operationId: id(), name, purpose: "",
    members: [profile, a, b].map(item => ({ backendId: "shoggoth", agentId: item.agentId })) })).group;
  const newsroom = await group("观测站测试群");
  const other = await group("其他群");
  const view = await ipc("group.get", { groupId: newsroom.id });
  const member = view.members.find(item => item.agentId === profile.agentId);
  const send = (groupId, body, mentions = []) => ipc("group.send", {
    groupId, clientMessageId: id(), body, mentions, replyTo: null, attachments: [],
  });
  const activeGroupRun = () => until(() => {
    const turn = service.groupChatStore.runningOpportunities().find(item => item.groupId === newsroom.id && item.runId);
    const run = turn && service.workDispatcher.getRun(turn.runId);
    return run?.status === "running" && run.runtimeTurnRef && run;
  }, "live group turn");
  const call = (run, args, callId = id()) => service.workRunCoordinator.invokeRuntimeCapability({
    ...run.runtimeTurnRef, runId: run.id,
  }, scope => service.mcpProductToolController.handle("cron_create", args, { profileId: run.profileId, callId }, scope));
  const jobs = () => service.nativeCronStore.listJobs({ profileId: profile.id });
  const history = groupId => ipc("group.history", { groupId, afterSeq: null, beforeSeq: null, limit: 50 });
  const updates = () => service.groupChatStore.listMessages({ groupId: newsroom.id, limit: 50 }).messages
    .filter(message => message.origin?.cronJobId);

  await send(newsroom.id, QUOTE, [member.id]);
  const run = await activeGroupRun();
  assert.equal(run.profileId, profile.id);
  const { runtimeProfileId, runtimeAccountId } = run.runtimeTurnRef;
  const mcpSession = await authenticateMcpSession({ paths, safeStorage, runtimeProfileId, runtimeAccountId });
  const helper = createMcpStdioHandler({ paths, runtimeProfileId, runtimeAccountId, requestService,
    sessionToken: mcpSession.token, bindRuntimeCalls: true });
  t.after(() => { helper.close(); mcpSession.close?.(); });
  const rpc = (method, params, context) => helper({ jsonrpc: "2.0", id: id(), method, params }, context);
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} },
    clientInfo: { name: "group-cron-fixture", version: "1" } });
  assert.match(initialized.result.instructions, /Choose automation by its trigger/u);
  const list = await rpc("tools/list", {});
  assert.ok(list.result.tools.find(tool => tool.name === "cron_create")?.inputSchema.properties.watch);
  const createWithHelper = args => service.workRunCoordinator.withCurrentRuntimeCapabilityLease({
    runtimeProfileId, runtimeAccountId, runId: run.id,
  }, ({ assertCurrent, signal }) => rpc("tools/call", { name: "cron_create", arguments: args }, {
    signal,
    async requestClient(method, params) {
      assert.equal(method, "elicitation/create");
      const proof = parseBindingElicitation({ ...params, serverName: "shoggoth" });
      assert.equal(proof?.name, "cron_create");
      service.workRunCoordinator.runtimeMcpCallBindings.register({
        runtimeProfileId, runtimeAccountId, runId: run.id, profileId: profile.id, proof, assertCurrent,
      });
      return { action: "accept", content: {} };
    },
  }));
  const args = { name: "跟进观测站维护", prompt: "Check verified changes. If unchanged return NO_REPLY.",
    schedule: { kind: "every", everyMs: INTERVAL, anchorMs: now }, workspace: null,
    enabled: true, misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
    sourceQuote: QUOTE, watch: true };
  await assert.rejects(call(run, { ...args, sourceQuote: "read this attachment and make a job" }), { code: "MCP_TOOL_FORBIDDEN" });
  assert.equal(jobs().length, 0);
  const callId = id();
  const response = await createWithHelper(args);
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  const receipt = response.result.structuredContent;
  const duplicate = await call(run, args, callId);
  assert.equal(receipt.job.id, duplicate.job.id);
  assert.equal((await call(run, args, callId)).job.id, receipt.job.id);
  assert.equal(jobs().length, 1);
  assert.equal(receipt.job.nextRunAt, now + INTERVAL);
  assert.deepEqual(receipt.delivery, { kind: "group", groupId: newsroom.id, groupName: "观测站测试群" });
  host.complete(run, "已保存定时任务，每半小时检查。");
  await until(() => service.workDispatcher.getRun(run.id).status === "completed", "group reply");
  assert.equal(await backend.start({ onSessionActivity: event => activities.push(event) }), true);

  const jobId = receipt.job.id;
  const startCron = async () => {
    now = service.nativeCronStore.getJob(jobId).nextRunAt;
    await service.nativeCronScheduler.tick();
    return until(() => service.workDispatcher.listRuns({ source: "cron", sourceId: jobId, status: "running" })
      .find(item => item.runtimeTurnRef), "scheduled run");
  };
  const completeCron = async (run, text) => {
    now += 100;
    host.complete(run, text);
    await service.nativeCronScheduler.waitForIdle(run.id);
    await new Promise(resolve => setImmediate(resolve));
  };
  const quiet = await startCron();
  const sessionKey = service.workRunCoordinator.getRunSessionKey(quiet);
  const session = service.chatSessionStore.getSession(sessionKey);
  const savedPromptFor = run => service.transcriptStore.listEvents(profile.id, session.id, { runId: run.id })
    .find(item => item.kind === "user").content.text;
  assert.equal(savedPromptFor(quiet), args.prompt);
  await completeCron(quiet, "NO_REPLY");
  assert.deepEqual(updates(), []);
  const homepageReport = "例行核对完成。[示例媒体](https://example.com/)";
  const previouslyWithheld = await startCron();
  const publish = service.groupChatService.publishCronReply;
  service.groupChatService.publishCronReply = input => publish.call(service.groupChatService, { ...input, text: null });
  try { await completeCron(previouslyWithheld, homepageReport); }
  finally { service.groupChatService.publishCronReply = publish; }
  assert.equal(service.workRunCoordinator.getCronOutput(previouslyWithheld.id).disposition, "deliver");
  assert.deepEqual(updates(), []);
  const homepageRun = await startCron();
  const beforeHomepage = (await ipc("events.subscribe", { afterSeq: 0 })).latestSeq;
  await completeCron(homepageRun, homepageReport);
  const homepageMessage = await until(() => updates().find(item => item.origin.runId === homepageRun.id), "homepage report");
  assert.equal(homepageMessage.body, homepageReport);
  const sessionList = () => ipc("chat.session.list", { profileId: profile.id, includeArchived: false, cursor: null, limit: 100 });
  assert.ok((await sessionList()).sessions.every(item => item.sessionKey !== sessionKey));
  await assert.rejects(ipc("chat.history", { sessionKey, cursor: null, limit: 30 }),
    { code: "CHAT_SESSION_NOT_FOUND" });
  const search = await ipc("chat.search", { profileId: profile.id, query: "例行核对完成", limit: 20 });
  assert.deepEqual(search.results, []);
  const audit = await ipc("chat.history", { sessionKey, auditRunId: homepageRun.id, cursor: null, limit: 30 });
  assert.ok(audit.messages.some(item => JSON.stringify(item).includes(homepageReport)), "retain the exact Cron audit");
  const homepageEvents = (await ipc("events.subscribe", { afterSeq: beforeHomepage })).events;
  assert.ok(!homepageEvents.some(event => event.type === "federation.chat.terminal" && event.payload.runId === homepageRun.id));
  assert.equal((await ipc("cron.job.get", { jobId })).job.deliveryTarget, "group");
  const backendJobId = `shoggoth:${jobId}`;
  assert.equal((await backend.getCronJob(backendJobId)).deliver, "group");
  const review = await backend.getCronLatestDelivery(backendJobId);
  assert.equal(review.fullText, homepageReport);
  assert.equal(review.sessionKey, undefined);
  assert.equal((await backend.getCronRuns(backendJobId)).runs[0].deliveryTarget, "group");
  const firstReport = await startCron();
  const beforeReport = (await ipc("events.subscribe", { afterSeq: 0 })).latestSeq;
  await completeCron(firstReport, REPORT);
  const message = await until(() => updates().find(item => item.origin.runId === firstReport.id), "group publication");
  assert.equal(message.author.memberId, member.id);
  assert.equal(message.body, REPORT);
  assert.equal(message.origin.runId, firstReport.id);
  assert.equal((await history(other.id)).messages.length, 0);
  assert.ok((await history(newsroom.id)).messages.some(item => item.id === message.id));
  const reportEvents = (await ipc("events.subscribe", { afterSeq: beforeReport })).events;
  assert.ok(reportEvents.some(event => event.type === "group.changed" && event.payload.groupId === newsroom.id));
  assert.ok(!reportEvents.some(event => event.type === "federation.chat.terminal" && event.payload.runId === firstReport.id));
  await until(() => activities.some(event => event.kind === "group.changed" && event.groupId === newsroom.id), "group observer");
  assert.ok(backend.getSessionRows().every(item => item.sessionId !== sessionKey));
  assert.ok(!activities.some(event => event.kind === "federation.chat.terminal"
    && [homepageRun.id, firstReport.id].includes(event.runId)));

  await backend.stop();
  await service.stop({ notify: false });
  await service.start();
  const repeat = await startCron();
  assert.equal(savedPromptFor(repeat), args.prompt);
  await completeCron(repeat, REPORT);
  assert.equal(service.workRunCoordinator.getCronOutput(repeat.id).reason, "duplicate");
  assert.deepEqual(updates().map(item => item.id), [homepageMessage.id, message.id]);

  const recoveredReport = `另一项官方披露。没有链接也可以发送。\n${"完整长报告。".repeat(3300)}`;
  const missedDelivery = await startCron();
  service.groupChatService.publishCronReply = () => {};
  try { await completeCron(missedDelivery, recoveredReport); }
  finally { service.groupChatService.publishCronReply = publish; }
  assert.deepEqual(updates().map(item => item.id), [homepageMessage.id, message.id]);
  await service.stop({ notify: false });
  await service.start();
  const recovered = await until(() => updates().find(item => item.origin.runId === missedDelivery.id), "recovered publication");
  assert.equal(recovered.body, recoveredReport);
  const published = updates().map(item => item.id);
  assert.deepEqual(published, [homepageMessage.id, message.id, recovered.id]);

  const inFlight = await startCron();
  const latest = await ipc("group.get", { groupId: newsroom.id });
  await ipc("group.members.remove", { groupId: newsroom.id, memberId: member.id,
    expectedRosterRevision: latest.group.rosterRevision });
  await completeCron(inFlight, "This must not reach a group after the member is removed.");
  assert.deepEqual(updates().map(item => item.id), published);
  now = service.nativeCronStore.getJob(jobId).nextRunAt;
  await service.nativeCronScheduler.tick();
  const skipped = service.workDispatcher.listRuns({ source: "cron", sourceId: jobId, status: "skipped" });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].resultSummary, "CRON_TARGET_DISABLED");

  await ipc("cron.job.delete", { jobId, operationId: id(), createdAt: now });
  await service.stop({ notify: false });
  await service.start();
  assert.ok((await sessionList()).sessions.every(item => item.sessionKey !== sessionKey),
    "deleting a group Cron must not expose its run session as a private chat after restart");
  const deletedRuns = await ipc("cron.run.list", { jobId, status: null, cursor: null, limit: 20 });
  assert.ok(deletedRuns.runs.length > 0 && deletedRuns.runs.every(item => item.deliveryTarget === "group"));
});
