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
const id = () => crypto.randomUUID();

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
  const create = async (policy = "new") => (await ipc("cron.job.create", {
    operationId: id(), name: "测试任务", enabled: false, profileId: DEFAULT_AGENT_PROFILE_ID,
    prompt: "收到回复我一个我收到了啊", workspace: null,
    schedule: { kind: "at", at: clock.value + 1000 }, misfirePolicy: "latest", maxCatchUp: 1,
    overlapPolicy: "skip", threadPolicy: policy, threadId: null, createdAt: clock.value,
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

test("new runs isolate conversations; duplicate operations do not create another turn or reply", async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.create();
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
  const approval = ctx.host.approve(run);
  await until(() => ctx.service.workDispatcher.getRun(run.id).status === "waiting_approval");
  const [session] = await ctx.sessions();
  assert.equal(ctx.service.workRunCoordinator.getRunSessionKey(run), session.sessionKey);
  await until(() => ctx.activities.some((event) => event.kind === "federation.chat.interaction"
    && event.runId === run.id && event.interaction.phase === "requested"));
  const waiting = ctx.service.workDispatcher.getRun(run.id);
  await ctx.ipc("run.approval.respond", { operationId: id(), createdAt: ctx.clock.value,
    runId: run.id, requestId: waiting.waitingRequestId, choice: "once" });
  await approval;
  await ctx.complete(run);
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
