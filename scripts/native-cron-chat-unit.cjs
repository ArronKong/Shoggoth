"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { validateContainer } = require("../app/agent-service/chat-session-store");
const { WorkRunCoordinator } = require("../app/agent-service/work-run-coordinator");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");
const { PRODUCT_CONFIRMATION_META, productConfirmationIdentity } = require("../app/agent-service/cron-approval-policy");
const id = () => crypto.randomUUID();

function productApproval(ctx, run, target = "Chrome") {
  return ctx.host.request("mcpServer/elicitation/request", {
    threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
    serverName: "shoggoth", mode: "form", message: `允许此任务使用 ${target}？`,
    _meta: { [PRODUCT_CONFIRMATION_META]: productConfirmationIdentity("computer_session_open",
      { runId: run.id, allowedApplications: [target] }) },
    requestedSchema: { type: "object", properties: {
      confirm_product_action: { type: "string", title: "确认操作", enum: ["确认执行", "取消"] },
    }, required: ["confirm_product_action"] },
  });
}

async function acceptProductApproval(ctx, run) {
  await until(() => ctx.service.workDispatcher.getRun(run.id).status === "waiting_input");
  const waiting = ctx.service.workDispatcher.getRun(run.id);
  return ctx.ipc("run.input.respond", { operationId: id(), createdAt: ctx.clock.value,
    runId: run.id, requestId: waiting.waitingRequestId, action: "submit",
    answers: { confirm_product_action: "确认执行" } });
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Cron condition timed out");
}

async function fixture(t, configure = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-cron-chat-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const clock = { value: Date.now() };
  const host = new InspirationRuntime();
  configure(host);
  const service = createAgentService({ paths, now: () => clock.value,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString() },
    runtimePool: { async get() { return host; }, async stopAll() {} },
    setCronTimer: () => 1, clearCronTimer() {},
  });
  const backend = new ShoggothBackend({ paths, now: () => clock.value,
    readinessTimeoutMs: 2000, serviceEventPollMs: 25,
    async requestService(servicePaths, request, options) {
      const result = await requestService(servicePaths, request, options);
      // The isolated transport has no real MCP credential. Exercise readiness
      // without connecting a user account; all chat/domain calls use real IPC.
      return request.method === "service.status" ? { ...result, mcpCredentialsLocked: false } : result;
    },
  });
  const activities = [];
  t.after(async () => {
    await backend.stop();
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  assert.equal(await backend.start({ onSessionActivity: (event) => activities.push(event) }), true);
  const ipc = (method, params) => requestService(paths, {
    id: id(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params,
  });
  const create = async (policy, prompt = "收到回复我一个我收到了啊") => (await ipc("cron.job.create", {
    operationId: id(), name: "测试任务", enabled: false, profileId: DEFAULT_AGENT_PROFILE_ID,
    prompt, workspace: null,
    schedule: { kind: "at", at: clock.value + 1000 }, misfirePolicy: "latest", maxCatchUp: 1,
    overlapPolicy: "skip", ...(policy ? { threadPolicy: policy, threadId: null } : {}), createdAt: clock.value,
  })).job;
  const trigger = async (job, operationId = id()) => (await ipc("cron.run.trigger", {
    operationId, jobId: job.id, createdAt: clock.value,
  })).run;
  const running = async (run) => {
    await until(() => ["running", "failed"].includes(service.workDispatcher.getRun(run.id).status));
    const current = service.workDispatcher.getRun(run.id);
    assert.equal(current.status, "running", JSON.stringify(current));
    return current;
  };
  const complete = async (run, text = "我收到了啊") => {
    const current = await running(run);
    clock.value += 100;
    host.complete(current, text);
    await until(() => service.workDispatcher.getRun(run.id).status === "completed");
    return service.workDispatcher.getRun(run.id);
  };
  const sessions = async () => (await ipc("chat.session.list", {
    profileId: DEFAULT_AGENT_PROFILE_ID, includeArchived: false, cursor: null, limit: 100,
  })).sessions.filter((session) => session.cronJobId);
  return { root, paths, service, backend, host, clock, activities, ipc, create, trigger, running, complete, sessions };
}

test("scheduled cron persists a typed conversation, full reply, trajectory and application message", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create();
  await ctx.ipc("cron.job.enabled.set", { operationId: id(), jobId: job.id,
    enabled: true, createdAt: ctx.clock.value });
  ctx.clock.value += 1000;
  await ctx.service.nativeCronScheduler.tick();
  await until(() => ctx.service.workDispatcher.listRuns({ source: "cron", sourceId: job.id }).length === 1);
  const run = ctx.service.workDispatcher.listRuns({ source: "cron", sourceId: job.id })[0];
  await ctx.complete(run);
  const rows = await ctx.sessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cronJobId, job.id);
  assert.deepEqual(rows[0].cronRunIds, [run.id]);
  const history = await ctx.ipc("chat.history", { sessionKey: rows[0].sessionKey, cursor: null, limit: 100 });
  assert.ok(history.messages.some((item) => item.payload.message.role === "user"
    && item.payload.message.shoggoth.source === "cron"
    && JSON.stringify(item).includes("收到回复我一个我收到了啊")));
  assert.ok(history.messages.some((item) => item.payload.message.role === "assistant"
    && JSON.stringify(item).includes("我收到了啊")));
  const delivery = await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`, job.schedule.at);
  assert.equal(delivery.fullText, "我收到了啊");
  assert.equal(delivery.source, "transcript");
  assert.ok(delivery.sessionKey.endsWith(rows[0].sessionKey));
  const trajectory = await ctx.backend.getCronRunTrajectory(`shoggoth:${job.id}`, { sessionKey: delivery.sessionKey });
  assert.equal(trajectory.supported, true);
  assert.ok(trajectory.parts.some((part) => part.text === "我收到了啊"));
  await until(() => ctx.activities.some((event) => event.kind === "federation.chat.terminal" && event.runId === run.id));
  assert.equal(ctx.backend.getSessionRows().find((row) => row.key === delivery.sessionKey).kind, "cron");
  assert.equal(ctx.activities.find((event) => event.runId === run.id).notificationCategory, "cron");
  assert.equal(ctx.host.turnStarts, 1);
  if (process.env.NATIVE_CRON_PREVIEW_DATA) fs.writeFileSync(path.resolve(process.env.NATIVE_CRON_PREVIEW_DATA),
    JSON.stringify({ sessions: ctx.backend.getSessionRows(), agents: ctx.backend.getAgents(),
      history: await ctx.backend.getHistory(delivery.sessionKey),
      jobs: await ctx.backend.getCronJobs(), runs: await ctx.backend.getCronRuns(`shoggoth:${job.id}`),
      jobDetail: await ctx.backend.getCronJob(`shoggoth:${job.id}`),
      delivery, trajectory, activity: ctx.activities.find((event) => event.runId === run.id) }));
});

test("silent cron keeps its audit but emits no chat history, delivery or terminal text", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create("continue");
  const run = await ctx.running(await ctx.trigger(job));
  const [session] = await ctx.sessions();
  await ctx.backend.stop();
  await ctx.backend.start({ onSessionActivity: event => ctx.activities.push(event) });
  const key = ctx.backend.getSessionRows().find(row => row.key.endsWith(session.sessionKey)).key;
  const live = [], status = [];
  const observe = ctx.backend.watchSession(key, {
    delta: text => live.push(["delta", text]), interim: text => live.push(["interim", text]),
    thinking: text => live.push(["thinking", text]), tool: value => live.push(["tool", value]),
    final: (text, error, meta) => live.push(["final", text, meta]),
    status: value => status.push(value.kind),
  });
  await until(() => status.includes("running"));
  ctx.host.emit({ known: true, type: "text", method: "item/completed", threadId: run.runtimeSessionRef.sessionId,
    turnId: run.runtimeTurnRef.turnId, itemId: "progress", phase: "commentary", text: "Checking the watermark." });
  const history = () => ctx.ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  await until(() => ctx.service.workRunCoordinator.getRunSnapshot(run.id).run.status === "running");
  assert.deepEqual((await history()).messages, [], "pending cron output must not enter public history");
  await ctx.complete(run, "NO_REPLY");
  await observe;
  assert.equal(live.length, 1, "only an empty terminal signal may reach the live observer");
  assert.equal(live[0][0], "final");
  assert.equal(live[0][1], "");
  assert.equal(live[0][2].outputDisposition, "silent");
  assert.deepEqual((await history()).messages, [], "silent output must remain hidden after completion");
  const delivery = await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`);
  assert.equal(delivery.outputDisposition, "silent");
  assert.equal(delivery.fullText, null);
  assert.equal(delivery.source, "none");
  assert.equal(delivery.summary, undefined);
  const { runs } = await ctx.backend.getCronRuns(`shoggoth:${job.id}`);
  assert.equal(runs[0].outputDisposition, "silent");
  assert.equal(ctx.service.workDispatcher.getRun(run.id).resultSummary, "NO_REPLY", "audit is retained");
  await until(() => ctx.activities.some(event => event.kind === "federation.chat.terminal" && event.runId === run.id));
  const activity = ctx.activities.find(event => event.kind === "federation.chat.terminal" && event.runId === run.id);
  assert.equal(activity.result, null);
  assert.equal(activity.outputDisposition, "silent");
  assert.deepEqual((await ctx.ipc("chat.search", { profileId: session.profileId, query: "NO_REPLY", limit: 20 })).results, []);
  const trajectory = await ctx.backend.getCronRunTrajectory(`shoggoth:${job.id}`, { runId: run.id });
  assert.ok(trajectory.parts.some(part => part.text === "NO_REPLY"), "explicit audit can still inspect the raw output");
  const next = await ctx.trigger(job);
  await ctx.complete(next, "Reset confirmed");
  const visible = (await history()).messages;
  assert.ok(visible.some(item => JSON.stringify(item).includes("Reset confirmed")));
  assert.ok(visible.every(item => item.runId !== run.id));
  await assert.rejects(ctx.ipc("chat.history", { sessionKey: session.sessionKey, auditRunId: id(), cursor: null, limit: 100 }));
  const recovered = [];
  await ctx.backend._settleTerminal({ run, key, sessionKey: session.sessionKey,
    target: ctx.backend._sessionTarget(key), generation: ctx.backend._generation,
    hooks: { final: (text, error, meta) => recovered.push({ text, meta }) }, poll: {} }, {},
  ctx.service.workDispatcher.getRun(run.id), { skipHistory: true });
  assert.equal(recovered[0].text, "", "snapshot/generation changes cannot fall back to raw summary");
  assert.equal(recovered[0].meta.outputDisposition, "silent");
  await ctx.backend.stop();
  await ctx.service.stop({ notify: false });
  await ctx.service.start();
  await ctx.backend.start({ onSessionActivity: event => ctx.activities.push(event) });
  assert.ok((await history()).messages.every(item => item.runId !== run.id));
  const restored = await ctx.backend.getCronRunTrajectory(`shoggoth:${job.id}`, { runId: run.id });
  assert.ok(restored.parts.some(part => part.text === "NO_REPLY"), "silent audit survives service restart");
  assert.equal(ctx.host.turnStarts, 2, "recovery does not rerun the check");
  if (process.env.NATIVE_CRON_SILENT_PREVIEW_DATA) {
    const snapshot = async () => ({ sessions: ctx.backend.getSessionRows(), agents: ctx.backend.getAgents(),
      history: await ctx.backend.getHistory(key), jobs: await ctx.backend.getCronJobs(),
      runtimeModels: await ctx.backend.getSessionRuntimeModels(ctx.backend.getAgents()[0].id, key),
      capabilities: ctx.backend.getChatCapabilities(ctx.backend.getAgents()[0].id),
      runs: await ctx.backend.getCronRuns(`shoggoth:${job.id}`), jobDetail: await ctx.backend.getCronJob(`shoggoth:${job.id}`),
      delivery: await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`) });
    const before = await snapshot();
    const last = await ctx.trigger(job);
    await ctx.complete(last, "NO_RESET");
    await until(() => ctx.activities.some(event => event.kind === "federation.chat.terminal" && event.runId === last.id));
    const silentAfter = await snapshot();
    assert.deepEqual(silentAfter.history, before.history);
    const trajectory = await ctx.backend.getCronRunTrajectory(`shoggoth:${job.id}`, { runId: last.id });
    fs.writeFileSync(path.resolve(process.env.NATIVE_CRON_SILENT_PREVIEW_DATA), JSON.stringify({ ...before,
      trajectory, silentAfter, activity: ctx.activities.find(event => event.runId === last.id) }));
  }
});

test("new runs isolate conversations; duplicate operations do not create another turn or reply", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create("new");
  const operationId = id();
  const first = await ctx.trigger(job, operationId);
  const duplicate = await ctx.trigger(job, operationId);
  assert.equal(first.id, duplicate.id);
  await ctx.complete(first, "first result");
  const second = await ctx.trigger(job);
  await ctx.complete(second, "second result");
  const rows = await ctx.sessions();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].runtimeSessionId, rows[1].runtimeSessionId);
  assert.equal(ctx.host.turnStarts, 2);
  for (const row of rows) {
    const history = await ctx.ipc("chat.history", { sessionKey: row.sessionKey, cursor: null, limit: 100 });
    const assistants = history.messages.filter((item) => item.payload.message.role === "assistant");
    assert.equal(assistants.length, 1);
  }
});

test("silent aliases and empty success preserve normal chat and reports that mention the token", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create("continue", "Check this detailed policy.\n" + "x".repeat(50000));
  for (const text of ["NO_RESET", "[SILENT]", ""]) {
    const run = await ctx.trigger(job);
    await ctx.complete(run, text);
    const delivery = await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`);
    assert.equal(delivery.outputDisposition, "silent", JSON.stringify({ text, delivery }));
    assert.equal(delivery.source, "none");
  }
  const [session] = await ctx.sessions();
  const report = await ctx.trigger(job);
  await ctx.complete(report, "Reset confirmed. The old marker was NO_REPLY.");
  assert.equal((await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`)).outputDisposition, "deliver");
  const long = await ctx.trigger(job);
  await ctx.complete(long, "NO_REPLY" + " ".repeat(50000) + "Actual report");
  assert.equal((await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`)).outputDisposition, "deliver", "bounded summary must not turn a long report into a silent marker");
  const chat = await ctx.ipc("chat.send", { operationId: id(), sessionKey: session.sessionKey,
    prompt: "Explain the marker", createdAt: ctx.clock.value });
  await ctx.complete(chat.run, "NO_REPLY");
  const history = await ctx.ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  assert.ok(history.messages.some(item => item.runId === chat.run.id && item.payload.message.role === "assistant"));
  assert.ok(history.messages.every(item => [report.id, long.id, chat.run.id].includes(item.runId)));
});

test("default recurring cron keeps one conversation across scheduled runs, manual runs and scheduler restart", async (t) => {
  const ctx = await fixture(t);
  const operationId = id();
  const input = { operationId, name: "Recurring", enabled: true, profileId: DEFAULT_AGENT_PROFILE_ID,
    prompt: "Keep this job's context", workspace: null,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: ctx.clock.value },
    misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip", createdAt: ctx.clock.value };
  const { job } = await ctx.ipc("cron.job.create", input);
  assert.equal(job.threadPolicy, "continue");
  assert.equal(job.threadId, null);
  assert.equal((await ctx.ipc("cron.job.create", input)).job.id, job.id);
  const runs = [];
  for (const text of ["first scheduled result", "second scheduled result"]) {
    ctx.clock.value = ctx.service.nativeCronStore.getJob(job.id).nextRunAt;
    await ctx.service.nativeCronScheduler.tick();
    const run = ctx.service.workDispatcher.listRuns({ source: "cron", sourceId: job.id })
      .find(item => !runs.some(previous => previous.id === item.id));
    assert.ok(run);
    runs.push(await ctx.complete(run, text));
    await ctx.service.nativeCronScheduler.waitForIdle(run.id);
    await ctx.service.nativeCronScheduler.close();
    await ctx.service.nativeCronScheduler.open();
  }
  const manualId = id();
  const manual = await ctx.trigger(job, manualId);
  assert.equal((await ctx.trigger(job, manualId)).id, manual.id);
  runs.push(await ctx.complete(manual, "manual result"));
  const [session] = await ctx.sessions();
  assert.equal((await ctx.sessions()).length, 1);
  assert.deepEqual(session.cronRunIds, runs.map(run => run.id));
  assert.equal(new Set(runs.map(run => run.runtimeSessionRef.sessionId)).size, 1);
  assert.equal(ctx.host.threads.length, 1);
  const history = await ctx.ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  assert.equal(history.messages.filter(item => item.payload.message.role === "assistant").length, 3);
  const other = await ctx.create();
  await ctx.complete(await ctx.trigger(other), "another job");
  assert.equal((await ctx.sessions()).length, 2);
  assert.equal(ctx.host.threads.length, 2);
});

test("continue reuses its conversation and exact occurrence delivery excludes other turns", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create("continue");
  const first = await ctx.trigger(job);
  await ctx.complete(first, "first result");
  const second = await ctx.trigger(job);
  await ctx.complete(second, "second result");
  const rows = await ctx.sessions();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].cronRunIds, [first.id, second.id]);
  assert.equal(ctx.host.threads.length, 1);
  const delivery = await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`);
  assert.equal(delivery.fullText, "second result");
  const firstTrajectory = await ctx.backend.getCronRunTrajectory(`shoggoth:${job.id}`,
    { sessionKey: delivery.sessionKey, runId: first.id });
  assert.ok(firstTrajectory.parts.some((part) => part.text === "first result"));
  assert.equal(firstTrajectory.parts.some((part) => part.text === "second result"), false);
  const associated = await ctx.ipc("run.list", { profileId: DEFAULT_AGENT_PROFILE_ID,
    sessionKey: rows[0].sessionKey, status: null, cursor: null, limit: 100 });
  assert.equal(associated.runs.length, 2);
});

test("approval belongs to the cron conversation and can be answered through chat controls", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create();
  const run = await ctx.running(await ctx.trigger(job));
  const approval = productApproval(ctx, run);
  await until(() => ctx.service.workDispatcher.getRun(run.id).status === "waiting_input");
  const [session] = await ctx.sessions();
  assert.equal(ctx.service.workRunCoordinator.getRunSessionKey(run), session.sessionKey);
  await until(() => ctx.activities.some((event) => event.kind === "federation.chat.interaction"
    && event.runId === run.id && event.interaction.phase === "requested"));
  await acceptProductApproval(ctx, run);
  await approval;
  await ctx.complete(run);
});

test("cron runs use full access without an approval selector and deny ordinary unattended input", async (t) => {
  const ctx = await fixture(t), job = await ctx.create();
  ctx.service.permissionEngine.setProfileOverride(DEFAULT_AGENT_PROFILE_ID, "app_status", "deny");
  const run = await ctx.running(await ctx.trigger(job));
  const contract = ctx.service.workRunCoordinator.runExecutionContracts.get(run.id);
  assert.equal(contract.permissionMode, "full-access");
  assert.equal(contract.permissionPolicy.sandbox, "danger-full-access");
  assert.match(contract.turnDeveloperInstructions, /unattended scheduled task/);
  assert.equal((await ctx.sessions())[0].permissionMode, "full-access");
  assert.deepEqual(await ctx.host.approve(run), { decision: "accept" });
  assert.deepEqual(await ctx.host.ask(run), { action: "decline" });
  assert.deepEqual(await ctx.host.request("mcpServer/elicitation/request", {
    threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
    serverName: "shoggoth", mode: "form", message: 'Allow the shoggoth MCP server to run tool "app_status"?',
    requestedSchema: { type: "object", properties: {} },
  }), { action: "decline" });
  assert.equal(ctx.service.workDispatcher.getRun(run.id).status, "running");
  assert.equal(ctx.service.workRunCoordinator.pendingRequests.size, 0);
  await ctx.complete(run, "无法在授权范围内完成此轮任务。");
  assert.equal(ctx.service.workRunCoordinator.runExecutionContracts.has(run.id), false);
  await until(() => ctx.activities.some(event => event.runId === run.id && event.notificationCategory === "cron"));
  const [session] = await ctx.sessions();
  ctx.service.chatSessionStore.setPermissionMode(session.sessionKey, "request-approval");
  const next = await ctx.running(await ctx.trigger(job));
  assert.equal(ctx.service.workRunCoordinator.runExecutionContracts.get(next.id).permissionMode, "full-access");
  await ctx.complete(next, "已通过其他允许的方法完成。");
});

test("one product approval survives a new cron run and restart but never authorizes another job or target", async (t) => {
  const ctx = await fixture(t), job = await ctx.create("new");
  const first = await ctx.running(await ctx.trigger(job));
  const approval = productApproval(ctx, first);
  await acceptProductApproval(ctx, first);
  assert.deepEqual(await approval, { action: "accept", content: { confirm_product_action: "确认执行" } });
  await ctx.complete(first);
  await ctx.backend.stop();
  await ctx.service.stop({ notify: false });
  await ctx.service.start();
  assert.equal(await ctx.backend.start({ onSessionActivity: event => ctx.activities.push(event) }), true);
  const next = await ctx.running(await ctx.trigger(job));
  assert.deepEqual(await productApproval(ctx, next), { action: "accept", content: { confirm_product_action: "确认执行" } });
  assert.equal(ctx.service.workRunCoordinator.pendingRequests.size, 0);
  const changed = productApproval(ctx, next, "Safari");
  await acceptProductApproval(ctx, next);
  await changed;
  await ctx.complete(next);
  const other = await ctx.running(await ctx.trigger(await ctx.create("new")));
  const otherApproval = productApproval(ctx, other);
  await acceptProductApproval(ctx, other);
  await otherApproval;
  await ctx.complete(other);
});

test("editing then restoring a cron definition revokes remembered operations", async (t) => {
  const ctx = await fixture(t), job = await ctx.create();
  const originalPrompt = ctx.service.nativeCronStore.getJob(job.id).prompt;
  const first = await ctx.running(await ctx.trigger(job));
  const approval = productApproval(ctx, first);
  await acceptProductApproval(ctx, first); await approval; await ctx.complete(first);
  for (const prompt of ["Changed task", originalPrompt]) {
    await ctx.ipc("cron.job.update", { operationId: id(), jobId: job.id,
      patch: { prompt }, createdAt: ctx.clock.value });
  }
  const next = await ctx.running(await ctx.trigger(job));
  const repeated = productApproval(ctx, next);
  await acceptProductApproval(ctx, next); await repeated; await ctx.complete(next);
});

test("remembered authorization cannot outlive a synchronous capability revocation", async (t) => {
  const ctx = await fixture(t), job = await ctx.create("new");
  const first = await ctx.running(await ctx.trigger(job)), approval = productApproval(ctx, first);
  await acceptProductApproval(ctx, first); await approval; await ctx.complete(first);
  const next = await ctx.running(await ctx.trigger(job));
  const coordinator = ctx.service.workRunCoordinator, previous = coordinator.onTranscriptCommitted;
  coordinator.onTranscriptCommitted = (event, run) => {
    previous?.(event, run);
    if (event.content?.transcriptType === "cron.authorization" && event.content.decision === "accept") {
      ctx.service.permissionEngine.setProfileOverride(run.profileId, "app_status", "deny");
    }
  };
  await assert.rejects(productApproval(ctx, next), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(coordinator.pendingRequests.size, 0);
});

test("a failed grant write keeps the approval answerable and a stale task approval declines", async (t) => {
  const ctx = await fixture(t), job = await ctx.create();
  const run = await ctx.running(await ctx.trigger(job)), request = productApproval(ctx, run);
  await until(() => ctx.service.workDispatcher.getRun(run.id).status === "waiting_input");
  const store = ctx.service.nativeCronStore.authorizations, write = store.atomicWrite;
  store.atomicWrite = () => { throw Object.assign(new Error("fixture write failed"), { code: "EIO" }); };
  await assert.rejects(acceptProductApproval(ctx, run));
  assert.equal(ctx.service.workDispatcher.getRun(run.id).status, "waiting_input");
  assert.equal(ctx.service.workRunCoordinator.pendingRequests.size, 1);
  store.atomicWrite = write;
  await acceptProductApproval(ctx, run);
  assert.equal((await request).action, "accept");
  const stale = productApproval(ctx, run, "Safari");
  await until(() => ctx.service.workDispatcher.getRun(run.id).status === "waiting_input");
  // Inject authority invalidation at the storage boundary while the request
  // is pending. The scheduler separately owns live-job update admission.
  ctx.service.nativeCronStore.updateJobDerived({ operationId: id(), jobId: job.id,
    patch: { prompt: "A revised scheduled task" }, createdAt: ctx.clock.value });
  await acceptProductApproval(ctx, run);
  assert.deepEqual(await stale, { action: "decline" });
  assert.equal(ctx.service.workRunCoordinator.pendingRequests.size, 0);
  await ctx.complete(run, "旧任务的确认已失效，此轮结束。");
  const next = await ctx.running(await ctx.trigger(job)), repeated = productApproval(ctx, next);
  await acceptProductApproval(ctx, next); await repeated; await ctx.complete(next);
});

test("declined unattended work cannot silently complete and releases its execution slot", async (t) => {
  const ctx = await fixture(t), job = await ctx.create();
  const run = await ctx.running(await ctx.trigger(job));
  assert.deepEqual(await ctx.host.ask(run), { action: "decline" });
  assert.deepEqual(await ctx.host.request("item/commandExecution/requestApproval", {
    threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
    command: "unreviewable operation", redacted: true,
  }), { decision: "decline" });
  ctx.host.complete(run, "NO_REPLY");
  await until(() => ctx.service.workDispatcher.getRun(run.id).status === "failed");
  const terminal = ctx.service.workDispatcher.getRun(run.id);
  assert.equal(terminal.errorCode, "CRON_AUTHORIZATION_DENIED");
  assert.equal(terminal.resultSummary, null, "a silence marker is not the failure report");
  const delivery = await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`);
  assert.equal(delivery.outputDisposition, "deliver");
  await until(() => ctx.activities.some(event => event.kind === "federation.chat.terminal"
    && event.runId === run.id && event.notificationCategory === "cron"));
  const activity = ctx.activities.find(event => event.kind === "federation.chat.terminal" && event.runId === run.id);
  assert.equal(activity.errorCode, "CRON_AUTHORIZATION_DENIED");
  assert.equal(activity.result, null);
  assert.equal(ctx.service.workRunCoordinator.pendingRequests.size, 0);
  assert.equal(ctx.service.workRunCoordinator.runExecutionContracts.has(run.id), false);
  await ctx.complete(await ctx.trigger(job), "下一轮正常运行。");
});

test("plugin and Hook approvals are remembered only for the same task and current authority", async (t) => {
  const ctx = await fixture(t), job = await ctx.create("new");
  const approve = (run, revision = 1) => ctx.service.workRunCoordinator.requestPluginToolApproval({
    runId: run.id, profileId: run.profileId, packageName: "Fixture", toolName: "send_report",
    arguments: { destination: "team", report: "daily" }, authorizationIdentity: { authRevision: revision, hookDigest: "fixture" },
    assertCurrent() { assert.ok(["running", "waiting_approval"].includes(ctx.service.workDispatcher.getRun(run.id).status)); },
  });
  const respond = async (run, choice) => {
    await until(() => ctx.service.workDispatcher.getRun(run.id).status === "waiting_approval");
    const current = ctx.service.workDispatcher.getRun(run.id);
    return ctx.ipc("run.approval.respond", { operationId: id(), runId: run.id,
      requestId: current.waitingRequestId, choice, createdAt: ctx.clock.value });
  };
  const first = await ctx.running(await ctx.trigger(job)), denied = approve(first);
  await respond(first, "deny"); assert.equal((await denied).approved, false);
  const retry = approve(first); await respond(first, "once"); assert.equal((await retry).approved, true);
  await ctx.complete(first);
  const next = await ctx.running(await ctx.trigger(job));
  assert.equal((await approve(next)).approved, true);
  assert.equal(ctx.service.workRunCoordinator.pendingRequests.size, 0);
  const changed = approve(next, 2); await respond(next, "once"); assert.equal((await changed).approved, true);
  await ctx.complete(next);
});

test("a completed cron conversation accepts a manual chat follow-up without changing cron delivery", async (t) => {
  const ctx = await fixture(t, host => {
    host.modelList = async () => ({ data: [{ model: "followup-model", displayName: "Follow-up model",
      description: "", isDefault: true, hidden: false, defaultReasoningEffort: "medium" }], nextCursor: null });
    const start = host.turnStart.bind(host);
    host.turnStart = async params => { host.lastSelectedModel = params.model; return start(params); };
  });
  const job = await ctx.create("continue");
  const cron = await ctx.complete(await ctx.trigger(job), "scheduled result");
  const [session] = await ctx.sessions();
  const operationId = id();
  const memory = ctx.service.memoryEngine, input = { profileId: session.profileId, sessionId: session.id };
  memory.complete = async () => { assert.fail("Cron transcripts must not be flushed into memory"); };
  assert.equal((await memory.observeBeforeSend(input)).status, "ineligible");
  assert.equal((await memory.flushBeforeCompaction(input)).status, "ineligible");
  const sent = await ctx.ipc("chat.send", { operationId, sessionKey: session.sessionKey,
    prompt: "Explain the scheduled result", createdAt: ctx.clock.value });
  assert.equal(sent.run.source, "chat");
  assert.equal(sent.run.sourceId, session.sessionKey);
  await ctx.complete(sent.run, "follow-up result");
  const original = await ctx.ipc("chat.operation.get", { operationId, sessionKey: session.sessionKey });
  assert.equal(original.status, "found");
  assert.equal(original.run.status, "completed");
  const replay = await ctx.ipc("chat.send", { operationId, sessionKey: session.sessionKey,
    prompt: "Explain the scheduled result", createdAt: ctx.clock.value });
  assert.equal(replay.run.id, sent.run.id);
  // Seed the picker result in the real session store. The send must retain
  // that selection and validate it against the fixture Runtime's model list.
  ctx.service.chatSessionStore.setModelOverride(session.sessionKey, "followup-model");
  const next = await ctx.ipc("chat.send", { operationId: id(), sessionKey: session.sessionKey,
    prompt: "Continue with the selected model", createdAt: ctx.clock.value });
  await ctx.complete(next.run, "selected-model reply");
  assert.equal(ctx.host.lastSelectedModel, "followup-model");
  const history = await ctx.ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  assert.ok(history.messages.some(item => JSON.stringify(item).includes("follow-up result")));
  const delivery = await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`);
  assert.equal(delivery.fullText, "scheduled result");
  assert.deepEqual((await ctx.sessions())[0].cronRunIds, [cron.id]);
  assert.ok(!memory.host(session.profileId).sessions.list(session.profileId).some(row => row.id === session.id));
  assert.equal(ctx.host.turnStarts, 3);
});

test("pre-send rejection survives real Service IPC and the backend without an ambiguous send receipt", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create();
  await ctx.complete(await ctx.trigger(job));
  const [session] = await ctx.sessions();
  const delivery = await ctx.backend.getCronLatestDelivery(`shoggoth:${job.id}`);
  for (const [internalCode, publicCode] of [["MEMORY_SESSION_REVOKED", "INTERNAL_ERROR"],
    ["PENDING_COMMAND_WRITE_FAILED", "SERVICE_UNAVAILABLE"]]) {
    ctx.service.memoryEngine.observeBeforeSend = async () => {
      throw Object.assign(new Error("private preparation details"), { code: internalCode });
    };
    const operationId = id();
    await assert.rejects(ctx.ipc("chat.send", { operationId, sessionKey: session.sessionKey,
      prompt: "Retry this rejected follow-up", createdAt: ctx.clock.value }), error =>
      error.code === publicCode && error.admissionAccepted === false && !error.message.includes("private"));
    assert.equal(ctx.service.workRunCoordinator.getChatRunByOperation(operationId, session.sessionKey), null);
    const failures = [], statuses = [];
    await ctx.backend.sendMessage(delivery.sessionKey, "Retry this rejected follow-up", id(), {
      error: (...args) => failures.push(args), status: value => statuses.push(value),
    }, { onAccepted: () => assert.fail("rejected preparation cannot acknowledge a turn") });
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0][1], { code: publicCode, admissionAccepted: false });
    assert.ok(!failures[0][0].includes("private"));
    assert.deepEqual(statuses, []);
  }
  assert.equal(ctx.host.turnStarts, 1);
});

test("authentication failures still have a durable cron conversation and visible error", async (t) => {
  const ctx = await fixture(t, (host) => {
    host.accountRead = async () => ({ account: null, requiresOpenaiAuth: true });
  });
  const run = await ctx.trigger(await ctx.create());
  await until(() => ctx.service.workDispatcher.getRun(run.id).status === "failed");
  const [session] = await ctx.sessions();
  assert.ok(session);
  const history = await ctx.ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  assert.ok(history.messages.some((item) => item.type === "error"));
  assert.equal(ctx.host.turnStarts, 0);
});

test("cron bindings reject changed ownership and unsupported storage versions", async (t) => {
  const ctx = await fixture(t);
  const run = await ctx.complete(await ctx.trigger(await ctx.create()));
  const store = ctx.service.chatSessionStore;
  const binding = store.getCronRunBinding(run.id);
  const { sessionKey, ...input } = binding;
  input.runtimeSessionId = run.runtimeSessionRef?.sessionId;
  for (const patch of [{ jobId: id() }, { profileId: id() }, { workspace: "/tmp/another-workspace" },
    { threadSource: "different-thread-source" }]) {
    assert.throws(() => store.ensureCronSession({ ...input, ...patch }), { code: "CHAT_SESSION_BINDING_CONFLICT" });
  }
  const container = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  const corrupted = structuredClone(container);
  corrupted.cronRuns[run.id].profileId = "other-profile";
  assert.throws(() => validateContainer(corrupted), { code: "CHAT_SESSION_STORE_CORRUPT" });
  container.version = 5;
  assert.throws(() => validateContainer(container), { code: "CHAT_SESSION_STORE_CORRUPT" });
});

test("service restart retains completed history and interrupts an active cron without rerunning it", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create();
  const first = await ctx.trigger(job);
  await ctx.complete(first);
  const active = await ctx.running(await ctx.trigger(job));
  const before = await ctx.sessions();
  await ctx.backend.stop();
  await ctx.service.stop({ notify: false });
  await ctx.service.start();
  assert.deepEqual((await ctx.sessions()).map((row) => row.sessionKey), before.map((row) => row.sessionKey));
  assert.equal(ctx.service.workDispatcher.getRun(active.id).status, "interrupted");
  const completed = before.find((row) => row.cronRunIds.includes(first.id));
  const history = await ctx.ipc("chat.history", { sessionKey: completed.sessionKey, cursor: null, limit: 100 });
  assert.ok(history.messages.some((item) => item.payload.message.role === "assistant"));
  assert.equal(ctx.host.turnStarts, 2);
});
