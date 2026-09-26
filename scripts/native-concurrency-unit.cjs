"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { PendingCommandInbox } = require("../app/agent-service/pending-command-inbox");
const { createWorkDispatcher, ACTIVE_WORK_RUN_STATUSES } = require("../app/agent-service/work-run");
const { RuntimeAccountAdmission } = require("../app/agent-service/runtime-account-admission");
const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
const { WorkRunCoordinator } = require("../app/agent-service/work-run-coordinator");
const { domainOperationId, domainThreadSource } = require("../app/agent-service/domain-work-run-executor");
const { createChatServiceController, resolveProfileWorkspace } = require("../app/agent-service/chat-service-controller");
const { validateChatServiceResult } = require("../app/agent-service/chat-service-protocol");
const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("../app/agent-service/runtime-account");
const { RuntimeStartupGate } = require("../app/agent-service/runtime-startup-gate");
const { defaultNativeRuntimeConfig } = require("../app/agent-service/native-runtime-config");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");

async function until(fn) {
  const deadline = Date.now() + 4000;
  while (!fn()) {
    assert.ok(Date.now() < deadline, "native scheduler did not reach expected state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-concurrency-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const store = new JsonlProductStore({ paths }).open();
  const sessions = new ChatSessionStore({ paths }).open();
  const inbox = new PendingCommandInbox({ paths, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString(),
  } });
  await inbox.open();
  const hosts = new Map();
  const host = {
    get turnStarts() { return [...hosts.values()].reduce((sum, value) => sum + value.turnStarts, 0); },
    get interrupts() { return [...hosts.values()].reduce((sum, value) => sum + value.interrupts, 0); },
    emit(profile, event) { hosts.get(profile.runtimeProfileId).emit(event); },
    complete(run, text) { return hosts.get(run.runtimeSessionRef.runtimeProfileId).complete({ ...run,
      codexThreadId: run.runtimeSessionRef.sessionId, codexTurnId: run.runtimeTurnRef.turnId }, text); },
    ask(run) { return hosts.get(run.runtimeSessionRef.runtimeProfileId).ask({ ...run,
      codexThreadId: run.runtimeSessionRef.sessionId, codexTurnId: run.runtimeTurnRef.turnId }); },
  };
  const config = options.config || defaultNativeRuntimeConfig();
  const getNativeRuntimeConfig = () => config;
  const startupGate = new RuntimeStartupGate({ getConfig: getNativeRuntimeConfig });
  let dispatcher, accountAdmission, coordinator, controller;
  const initialize = async () => {
    dispatcher = createWorkDispatcher({ store, getNativeRuntimeConfig });
    accountAdmission = new RuntimeAccountAdmission({ runtimeAccountLookup: id => store.getRuntimeAccount(id),
      resolveMaxActive: options.resolveMaxActive || (account => config.flags.runtimeAdmissionV1
        ? Math.min(account.maxActive ?? config.maxActive, config.maxActive) : 4) });
    coordinator = new WorkRunCoordinator({ productStore: store, dispatcher, chatSessionStore: sessions, inbox,
      getNativeRuntimeConfig, startupGate, runExecutionStore: options.runExecutionStore,
      startupReconcileTimeoutMs: options.startupReconcileTimeoutMs,
      runtimeManager: { async acquire(binding) {
        await options.beforeAcquire?.(binding);
        if (!hosts.has(binding.runtimeProfileId)) hosts.set(binding.runtimeProfileId, new InspirationRuntime());
        const raw = hosts.get(binding.runtimeProfileId);
        const session = thread => ({ ...thread, source: thread.threadSource });
        return { ...binding, terminated: raw.terminated, registeredSecrets: [],
          subscribe: listener => raw.subscribe(listener),
          registerServerRequestHandler: (...args) => raw.registerServerRequestHandler(...args),
          async sessionList(input) { const result = await raw.threadList(input); return { ...result, data: result.data.map(session) }; },
          async sessionStart(input) {
            await raw.threadStart({ ...input, threadSource: input.source });
            const thread = raw.threads.at(-1);
            thread.id = `${binding.runtimeProfileId}-${raw.threads.length}`;
            return { session: session(structuredClone(thread)) };
          },
          async sessionResume(input) { return { session: session((await raw.threadResume({ threadId: input.sessionId })).thread) }; },
          async sessionRead(input) { await options.beforeSessionRead?.(input); return { session: session((await raw.threadRead({ threadId: input.sessionId })).thread) }; },
          turnStart: async input => { await options.beforeTurnStart?.(input); return raw.turnStart({ ...input, threadId: input.sessionId, clientUserMessageId: input.operationId }); },
          turnInterrupt: input => raw.turnInterrupt(input),
        };
      }, async stop(binding) { await options.onStop?.(binding); }, stopAll() {} }, runtimeAccountAdmission: accountAdmission,
      assertSecretSafe: () => true, sanitizeSummary: text => text });
    await coordinator.open();
    controller = createChatServiceController({ paths, productStore: store, chatSessionStore: sessions, coordinator,
      cursorSecret: Buffer.alloc(32, 19) });
    await controller.open();
  };
  await initialize();
  t.after(async () => {
    await controller.close(); await coordinator.close(); await inbox.close(); sessions.close(); store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profile = store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  let nextBackend = 0;
  const addProfile = (backend = null) => {
    const id = randomUUID();
    const backendId = backend === true ? "shoggoth"
      : backend || ["codex", "pi", "deepseek-harness", "grok-build"][nextBackend++ % 4];
    const accountId = backendId === "shoggoth" ? profile.runtimeAccountId : DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[backendId];
    const runtime = store.getRuntimeAccount(accountId).runtime;
    return store.putAgentProfile({ ...profile, id, agentId: `agent-${id}`, name: `Test ${id}`,
      backendId: "shoggoth", runtime, runtimeProfileId: `runtime-${id}`, runtimeAccountId: accountId, isDefault: false });
  };
  const session = async (p = profile, workspace = null) => (await controller.handle("chat.session.create", {
    operationId: randomUUID(), profileId: p.id, workspace, createdAt: Date.now(),
  })).session;
  const send = async (s, op = randomUUID()) => {
    const result = await coordinator.send({ operationId: op, sessionKey: s.sessionKey, prompt: `Test ${op}` });
    validateChatServiceResult("chat.send", result);
    await coordinator.waitForIdle(result.run.id);
    return { ...result, run: coordinator.getRun(result.run.id) };
  };
  return { root, paths, store, sessions, inbox, host, profile, addProfile, session, send, config, startupGate,
    get dispatcher() { return dispatcher; }, get coordinator() { return coordinator; },
    get controller() { return controller; }, get accountAdmission() { return accountAdmission; },
    async restart() {
      await controller.close(); await coordinator.close();
      await inbox.close(); sessions.close(); store.close();
      store.open(); sessions.open(); await inbox.open();
      const recoveredDispatcher = createWorkDispatcher({ store });
      // Before canonical recovery, durable active work still occupies all slots.
      for (const run of store.listWorkRuns()) if (ACTIVE_WORK_RUN_STATUSES.has(run.status)) {
        recoveredDispatcher.recoverActiveRunAfterServiceRestart(run.id);
      }
      await initialize();
    },
  };
}

test("one native Agent runs four sessions, fifth queues and wakes once; events stay scoped", async t => {
  const f = await fixture(t);
  const sessions = await Promise.all(Array.from({ length: 5 }, () => f.session()));
  assert.equal(new Set(sessions.map(s => s.workspace)).size, 5);
  const results = await Promise.all(sessions.map(s => f.send(s)));
  const [a, b, , , queued] = results;
  assert.deepEqual(results.map(r => r.run.status), ["running", "running", "running", "running", "queued"]);
  assert.equal(queued.reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  assert.equal(f.host.turnStarts, 4);
  const snapshot = f.coordinator.getRunSnapshot(queued.run.id);
  assert.equal(snapshot.queue.reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  assert.ok(snapshot.queue.queuedAt <= Date.now());
  const events = [];
  f.coordinator.subscribeRun(b.run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
  f.host.complete(a.run, "only A");
  await until(() => f.coordinator.getRun(queued.run.id).status === "running");
  assert.equal(f.host.turnStarts, 5);
  assert.equal(f.coordinator.getRun(b.run.id).status, "running");
  assert.equal(JSON.stringify(events).includes("only A"), false);
});

test("native runtime accounts share one Shoggoth fallback budget", async t => {
  const f = await fixture(t);
  const profiles = [f.profile, f.addProfile("codex"), f.addProfile("pi"), f.addProfile("deepseek-harness")];
  assert.equal(profiles[0].runtime, profiles[1].runtime, "Shoggoth and Codex both use Codex runtime");
  const results = await Promise.all(profiles.map(async p => {
    const sessions = await Promise.all(Array.from({ length: 5 }, () => f.session(p)));
    return Promise.all(sessions.map(s => f.send(s)));
  }));
  const running = results.flat().filter(result => result.run.status === "running");
  assert.equal(running.length, 4);
  assert.equal(f.host.turnStarts, 4);
  const queued = results.flat().filter(result => result.run.status === "queued");
  assert.equal(queued.length, 16);
  f.host.complete(running[0].run);
  await until(() => f.host.turnStarts === 5);
  assert.equal(queued.filter(result => f.coordinator.getRun(result.run.id).status === "running").length, 1);

});

test("multiple Agents share their account's four slots", async t => {
  const f = await fixture(t);
  const shared = f.addProfile(true);
  const a = await f.send(await f.session());
  for (let i = 0; i < 3; i++) await f.send(await f.session(shared));
  const sharedQueued = await f.send(await f.session(shared));
  assert.equal(sharedQueued.reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  assert.equal(f.host.turnStarts, 4);
  f.host.complete(a.run);
  await until(() => f.coordinator.getRun(sharedQueued.run.id).status === "running");
  assert.equal(f.host.turnStarts, 5);
});

test("backend budget stays four across Profiles even with a higher account limit and a new dispatcher", async t => {
  const f = await fixture(t, { resolveMaxActive: () => 8 });
  const shared = f.addProfile(true), other = f.addProfile("pi");
  const a = await f.send(await f.session());
  await f.send(await f.session());
  await f.send(await f.session(shared)); await f.send(await f.session(shared));
  const fifth = await f.send(await f.session(shared));
  assert.equal(fifth.reason, "BACKEND_ACTIVE_LIMIT");
  assert.equal(f.accountAdmission.read(shared.runtimeAccountId).active, 4, "backend denial returns the reserved account slot");
  assert.equal(createWorkDispatcher({ store: f.store }).admit(fifth.run.id).reason, "BACKEND_ACTIVE_LIMIT",
    "recreating a dispatcher counts durable active runs");
  const otherRuns = await Promise.all(Array.from({ length: 4 }, async () => f.send(await f.session(other))));
  assert.ok(otherRuns.every(result => result.run.status === "queued"), "every native account shares the same product backend budget");
  assert.equal(f.host.turnStarts, 4);
  f.host.complete(a.run);
  await until(() => f.coordinator.getRun(fifth.run.id).status === "running");
  assert.equal(f.host.turnStarts, 5);
});

test("same session and explicit writable workspace remain exclusive across accounts", async t => {
  const f = await fixture(t);
  const other = f.addProfile();
  const s = await f.session(f.profile, path.join(f.root, "explicit"));
  const a = await f.send(s);
  const same = await f.send(s);
  assert.equal(same.reason, "CHAT_SESSION_BUSY");
  const sharedDirectory = await f.send(await f.session(other, s.workspace));
  assert.equal(sharedDirectory.reason, "WORKSPACE_WRITE_BUSY");
  assert.equal(f.accountAdmission.read(other.runtimeAccountId).active, 0);
  assert.equal(f.host.turnStarts, 1);
  await f.coordinator.abort({ operationId: randomUUID(), sessionKey: s.sessionKey, runId: same.run.id });
  f.host.complete(a.run);
  await until(() => f.coordinator.getRun(sharedDirectory.run.id).status === "running");
  assert.equal(f.host.turnStarts, 2);
});

test("canceling a queued turn writes a tombstone, survives restart, and never calls runtime", async t => {
  const f = await fixture(t);
  const a = await f.send(await f.session());
  for (let i = 0; i < 3; i++) await f.send(await f.session());
  const queuedSession = await f.session();
  const canceled = await f.send(queuedSession);
  const abort = { operationId: randomUUID(), sessionKey: queuedSession.sessionKey, runId: null };
  const results = await Promise.all([f.coordinator.abort(abort), f.coordinator.abort(abort)]);
  assert.equal(results[0].status, "canceled"); assert.deepEqual(results[0], results[1]);
  assert.equal(f.host.interrupts, 0);
  const pending = await f.send(await f.session());
  f.host.complete(a.run);
  await until(() => f.coordinator.getRun(pending.run.id).status === "running");
  assert.equal(f.host.turnStarts, 5);
  const waitingAtRestart = await f.send(await f.session());
  assert.equal(waitingAtRestart.run.status, "queued");
  await f.restart();
  assert.equal(f.coordinator.getRun(canceled.run.id).status, "canceled");
  assert.equal(f.coordinator.getRun(waitingAtRestart.run.id).status, "running");
  assert.equal(f.host.turnStarts, 6, "restart starts only the previously queued turn");
});

test("Shoggoth fallback budget reserves two background and two chat slots across native accounts", async t => {
  const f = await fixture(t);
  const profiles = [f.addProfile(true), f.addProfile(true), f.addProfile(true), f.addProfile("pi"), f.addProfile("pi")];
  const background = await Promise.all(profiles.map(async p => {
    const run = f.dispatcher.enqueue({ id: randomUUID(), source: "kanban", sourceId: randomUUID(),
      idempotencyKey: randomUUID(), profileId: p.id, workspace: path.join(f.root, p.id), retryOf: null });
    await f.coordinator.executeDomainRun({ runId: run.id, operationId: domainOperationId(run), prompt: "Background task",
      threadSource: domainThreadSource(run, "new"), threadId: null });
    return run;
  }));
  await until(() => [0, 1].every(i => f.coordinator.getRun(background[i].id).status === "running"));
  assert.equal(f.coordinator.getRunSnapshot(background[2].id).queue.reason, "BACKEND_BACKGROUND_ACTIVE_LIMIT");
  assert.equal(f.host.turnStarts, 2, "native runtimes share Shoggoth background capacity");
  const waitingRun = f.coordinator.getRun(background[0].id);
  const answer = f.host.ask(waitingRun).catch(() => {});
  await until(() => f.coordinator.getRun(waitingRun.id).status === "waiting_input");
  const a = await f.send(await f.session()); const b = await f.send(await f.session());
  assert.equal(a.run.status, "running"); assert.equal(b.run.status, "running");
  f.host.complete(a.run);
  await until(() => f.coordinator.getRun(a.run.id).status === "completed");
  assert.equal(f.coordinator.getRun(background[2].id).status, "queued", "chat slot cannot become third background slot");
  const done = f.coordinator.getRun(background[1].id); f.host.complete(done);
  await until(() => f.coordinator.getRun(background[2].id).status === "running");
  assert.equal(f.coordinator.getRun(waitingRun.id).status, "waiting_input");
  await f.coordinator.close(); await answer;
});

test("implicit workspaces isolate new sessions and current create retries are stable", async t => {
  const f = await fixture(t);
  const operationId = randomUUID(), createdAt = Date.now();
  const first = (await f.controller.handle("chat.session.create", { operationId, profileId: f.profile.id,
    workspace: null, createdAt })).session;
  const replay = await f.controller.handle("chat.session.create", { operationId, profileId: f.profile.id,
    workspace: null, createdAt });
  assert.equal(replay.session.sessionKey, first.sessionKey);
  assert.equal(replay.session.workspace, first.workspace);
  const next = await f.session(); assert.notEqual(next.workspace, first.workspace);
  const configured = f.store.putAgentProfile({ ...f.addProfile(), defaultCwd: path.join(f.root, "project") });
  assert.equal((await f.session(configured)).workspace, configured.defaultCwd);
  assert.equal(resolveProfileWorkspace({ paths: f.paths, profile: f.profile, requested: null }), path.join(f.paths.defaultWorkspaceDir, f.profile.id),
    "non-chat workspace consumers keep profile workspace semantics");
  const explicitOperation = randomUUID();
  await f.controller.handle("chat.session.create", { operationId: explicitOperation, profileId: f.profile.id,
    workspace: path.join(f.root, "explicit-replay"), createdAt });
  await assert.rejects(f.controller.handle("chat.session.create", { operationId: explicitOperation,
    profileId: f.profile.id, workspace: null, createdAt }), { code: "CHAT_OPERATION_ID_CONFLICT" });
});

test("trusted account cooldown wakes the queue without requiring another request or terminal", async t => {
  const f = await fixture(t);
  f.accountAdmission.noteBackoff({ runtimeAccountId: f.profile.runtimeAccountId, retryAt: Date.now() + 500 });
  const queued = await f.send(await f.session());
  assert.equal(queued.reason, "RUNTIME_ACCOUNT_BACKOFF");
  assert.equal(f.host.turnStarts, 0);
  await until(() => f.coordinator.getRun(queued.run.id).status === "running");
  assert.equal(f.host.turnStarts, 1);
});

test("exhausted Codex plan with credits still admits the next Shoggoth task", async t => {
  const f = await fixture(t);
  const session = await f.session();
  const first = await f.send(session);
  f.host.emit(f.profile, normalizeCodexEvent({ method: "account/rateLimits/updated", params: {
    rateLimits: { primary: { usedPercent: 100, resetsAt: Math.ceil(Date.now() / 1000) + 4 * 86400 },
      secondary: null, credits: { hasCredits: true, unlimited: false, balance: "1000" },
      spendControlReached: false, rateLimitReachedType: null },
  } }));
  f.host.complete(first.run);
  await until(() => f.coordinator.getRun(first.run.id).status === "completed");
  const second = await f.send(session);
  assert.equal(second.run.status, "running");
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).backoffUntil, null);
  assert.equal(f.host.turnStarts, 2);
});

test("true exhaustion fails immediately; idle-host recovery permits retry without replaying failed work", async t => {
  const f = await fixture(t);
  const session = await f.session();
  const first = await f.send(session);
  const rateLimits = { primary: { usedPercent: 100, resetsAt: Math.ceil(Date.now() / 1000) + 4 * 86400 },
    secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" },
    spendControlReached: false, rateLimitReachedType: null };
  const emitLimits = (snapshot) => f.host.emit(f.profile, normalizeCodexEvent({
    method: "account/rateLimits/updated", params: { rateLimits: snapshot },
  }));
  emitLimits(rateLimits);
  f.host.complete(first.run);
  await until(() => f.coordinator.getRun(first.run.id).status === "completed");
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).active, 0);
  const operationId = randomUUID();
  const rejected = await f.send(session, operationId);
  assert.equal(rejected.run.status, "failed");
  assert.equal(rejected.run.errorCode, "RUNTIME_QUOTA_EXHAUSTED");
  assert.equal(rejected.run.startedAt, null);
  assert.equal(f.inbox.get(operationId).state, "completed");
  assert.equal(f.coordinator.getRunSnapshot(rejected.run.id).queue, undefined);
  assert.equal(f.host.turnStarts, 1);
  emitLimits({ credits: null, spendControlReached: null, rateLimitReachedType: null });
  assert.ok(f.accountAdmission.read(f.profile.runtimeAccountId).backoffUntil > Date.now());
  emitLimits({ ...rateLimits, credits: { hasCredits: true, unlimited: false, balance: "1000" } });
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).backoffUntil, null);
  assert.equal((await f.send(session, operationId)).run.status, "failed",
    "retrying the same operation must not silently resurrect a failed request");
  assert.equal((await f.send(session)).run.status, "running");
  assert.equal(f.host.turnStarts, 2);
});

test("quota recovery is shared by peer Agents but isolated from other accounts", async t => {
  const f = await fixture(t);
  const peer = f.addProfile("shoggoth");
  const other = f.addProfile("codex");
  const first = await f.send(await f.session());
  await f.send(await f.session(peer));
  await f.send(await f.session(other));
  const rateLimits = { primary: { usedPercent: 100, resetsAt: Math.ceil(Date.now() / 1000) + 4 * 86400 },
    secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" },
    spendControlReached: false, rateLimitReachedType: null };
  f.host.emit(f.profile, normalizeCodexEvent({ method: "account/rateLimits/updated", params: { rateLimits } }));
  f.host.complete(first.run);
  await until(() => f.coordinator.getRun(first.run.id).status === "completed");
  const session = await f.session();
  assert.equal((await f.send(session)).run.errorCode, "RUNTIME_QUOTA_EXHAUSTED");
  const recovery = normalizeCodexEvent({ method: "account/rateLimits/updated", params: {
    rateLimits: { ...rateLimits, credits: { hasCredits: true, unlimited: false, balance: "1000" } },
  } });
  f.host.emit(other, recovery);
  assert.ok(f.accountAdmission.read(f.profile.runtimeAccountId).backoffUntil > Date.now());
  assert.equal((await f.send(session)).run.errorCode, "RUNTIME_QUOTA_EXHAUSTED");
  f.host.emit(peer, recovery);
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).backoffUntil, null);
  assert.equal((await f.send(session)).run.status, "running");
  assert.equal(f.host.turnStarts, 4);
});

test("queued messages fail on confirmed exhaustion even while the preceding turn is still running", async t => {
  const f = await fixture(t);
  const session = await f.session();
  const running = await f.send(session);
  const operationId = randomUUID();
  const queued = await f.send(session, operationId);
  assert.equal(queued.reason, "CHAT_SESSION_BUSY");
  f.host.emit(f.profile, normalizeCodexEvent({ method: "account/rateLimits/updated", params: {
    rateLimits: { rateLimitReachedType: "workspace_member_credits_depleted" },
  } }));
  await until(() => f.coordinator.getRun(queued.run.id).status === "failed");
  await until(() => f.inbox.get(operationId).state === "completed");
  assert.equal(f.coordinator.getRun(queued.run.id).errorCode, "RUNTIME_QUOTA_EXHAUSTED");
  assert.equal(f.coordinator.getRunSnapshot(queued.run.id).queue, undefined);
  assert.equal(f.coordinator.getRun(running.run.id).status, "running");
  assert.equal(f.host.turnStarts, 1);
  assert.equal(f.host.interrupts, 0, "an account snapshot must not cancel an already running turn");
  const rejected = await f.send(session);
  assert.equal(rejected.run.errorCode, "RUNTIME_QUOTA_EXHAUSTED");
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).active, 1);
});

test("domain tasks report spending limits without joining the cooldown queue", async t => {
  const f = await fixture(t);
  await f.send(await f.session());
  f.host.emit(f.profile, normalizeCodexEvent({ method: "account/rateLimits/updated", params: {
    rateLimits: { spendControlReached: true, individualLimit: null },
  } }));
  const run = f.dispatcher.enqueue({ id: randomUUID(), source: "kanban", sourceId: randomUUID(),
    idempotencyKey: randomUUID(), profileId: f.profile.id, workspace: path.join(f.root, "domain"), retryOf: null });
  const ack = await f.coordinator.executeDomainRun({ runId: run.id, operationId: domainOperationId(run),
    prompt: "Blocked task", threadSource: domainThreadSource(run, "new"), threadId: null });
  assert.equal(ack.disposition, "completed");
  assert.equal(ack.run.status, "failed");
  assert.equal(ack.run.errorCode, "RUNTIME_SPENDING_LIMIT_REACHED");
  assert.equal(f.host.turnStarts, 1);
});


function unifiedConfig(overrides = {}) {
  const config = defaultNativeRuntimeConfig();
  return { ...config, flags: { ...config.flags, runtimeAdmissionV1: true }, ...overrides };
}

test("unified admission permits 100 mixed native runs, queues 101, releases exactly one slot", async t => {
  const f = await fixture(t, { config: unifiedConfig() });
  const runs = [];
  for (let i = 0; i < 100; i++) {
    const p = f.addProfile();
    runs.push(await f.send(await f.session(p)));
  }
  assert.ok(runs.every(result => result.run.status === "running"));
  const extra = await f.send(await f.session(f.addProfile()));
  assert.equal(extra.run.status, "queued");
  assert.equal(extra.reason, "GLOBAL_CAPACITY");
  assert.equal(f.host.turnStarts, 100);
  assert.equal(f.coordinator.nativeCapacitySnapshot().active, 100);
  f.host.complete(runs[0].run);
  await until(() => f.coordinator.getRun(extra.run.id).status === "running");
  assert.equal(f.host.turnStarts, 101);
  assert.equal(f.coordinator.nativeCapacitySnapshot().active, 100);
});

test("100 pending interactions hold capacity; lowering live limit never interrupts them", async t => {
  const f = await fixture(t, { config: unifiedConfig() });
  const runs = [];
  const responses = [];
  for (let i = 0; i < 100; i++) {
    const result = await f.send(await f.session(f.addProfile()));
    runs.push(result.run);
    responses.push(f.host.ask(result.run).catch(() => {}));
  }
  await until(() => runs.every(run => f.coordinator.getRun(run.id).status === "waiting_input"));
  f.config.maxActive = 2;
  await f.coordinator.capacityChanged();
  const extra = await f.send(await f.session(f.addProfile()));
  assert.equal(extra.reason, "GLOBAL_CAPACITY");
  assert.equal(f.coordinator.nativeCapacitySnapshot().active, 100);
  assert.equal(f.host.interrupts, 0);
  await f.coordinator.close();
  await Promise.all(responses);
});

test("startup gate covers encryption through turn acknowledgement and returns reservations", async t => {
  let unblock;
  const pending = new Promise(resolve => { unblock = resolve; });
  const config = unifiedConfig({ startupConcurrency: 1 });
  let encryptions = 0;
  const f = await fixture(t, { config, runExecutionStore: {
    async put(run, contract, command, fence, cryptoOptions) {
      assert.equal(cryptoOptions.waitForCapacity, true);
      assert.ok(cryptoOptions.signal);
      encryptions++;
      await pending;
      fence();
    }, remove() {}, has() { return false; }, get() { return null; },
  } });
  const firstSession = await f.session(), secondSession = await f.session();
  const first = await f.coordinator.send({ operationId: randomUUID(), sessionKey: firstSession.sessionKey, prompt: "one" });
  await until(() => encryptions === 1);
  const second = await f.send(secondSession);
  assert.equal(second.reason, "STARTUP_BACKPRESSURE");
  assert.equal(f.startupGate.read().active, 1);
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).active, 1);
  assert.equal(f.host.turnStarts, 0);
  unblock();
  await until(() => f.coordinator.getRun(second.run.id).status === "running");
  assert.equal(f.coordinator.getRun(first.run.id).status, "running");
  assert.equal(f.startupGate.read().active, 0);
  assert.equal(encryptions, 2);
});

test("host capacity before acquisition requeues without a native send or leaked reservations", async t => {
  let blocked = true, acquires = 0;
  const f = await fixture(t, { config: unifiedConfig(), beforeAcquire() {
    acquires++;
    if (blocked) throw Object.assign(new Error("capacity"), { code: "RUNTIME_HOST_CAPACITY" });
  } });
  const result = await f.send(await f.session());
  assert.equal(result.run.status, "queued");
  assert.equal(f.coordinator.getRunSnapshot(result.run.id).queue.reason, "HOST_CAPACITY");
  assert.equal(acquires, 1);
  assert.equal(f.host.turnStarts, 0);
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).active, 0);
  assert.equal(f.startupGate.read().active, 0);
  blocked = false;
  await f.coordinator.capacityChanged();
  await until(() => f.coordinator.getRun(result.run.id).status === "running");
  assert.equal(f.host.turnStarts, 1);
});

test("unified admission respects explicit account/profile limits and flag-off legacy limits", async t => {
  const f = await fixture(t, { config: unifiedConfig() });
  const limited = f.store.putAgentProfile({ ...f.addProfile(), concurrency: { maxActive: 2, maxWorkspaceWrites: null } });
  await f.send(await f.session(limited)); await f.send(await f.session(limited));
  assert.equal((await f.send(await f.session(limited))).reason, "PROFILE_ACTIVE_LIMIT");
  const p = f.addProfile("codex");
  f.store.putRuntimeAccount({ ...f.store.getRuntimeAccount(p.runtimeAccountId), maxActive: 1 });
  await f.send(await f.session(p));
  assert.equal((await f.send(await f.session(p))).reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  for (let i = 0; i < 5; i++) assert.equal((await f.send(await f.session())).run.status, "running");
  f.config.flags.runtimeAdmissionV1 = false;
  assert.equal((await f.send(await f.session())).reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  assert.equal(f.host.interrupts, 0);
});


test("unknown turn acceptance has bounded reconciliation and stops the host before releasing capacity", async t => {
  let sends = 0, stopped = 0;
  const f = await fixture(t, { config: unifiedConfig(), startupReconcileTimeoutMs: 25,
    beforeTurnStart() { sends++; throw Object.assign(new Error("unknown"), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" }); },
    beforeSessionRead() { return new Promise(() => {}); },
    onStop() {
      assert.equal(f.coordinator.nativeCapacitySnapshot().active, 1, "reservation must remain until stop");
      stopped++;
    },
  });
  const result = await f.send(await f.session());
  assert.equal(result.run.status, "interrupted");
  assert.equal(result.run.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
  assert.equal(sends, 1); assert.equal(stopped, 1);
  assert.equal(f.coordinator.nativeCapacitySnapshot().active, 0);
  assert.equal(f.accountAdmission.read(f.profile.runtimeAccountId).active, 0);
  assert.equal(f.startupGate.read().active, 0);
  await f.restart();
  assert.equal(sends, 1, "unknown acceptance must never be replayed after restart");
});
