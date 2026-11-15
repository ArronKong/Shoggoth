"use strict";

// Real Service IPC, durable stores and Coordinator. The preparation gate and
// native transport are controlled locally, so no installed App or provider runs.
const assert = require("node:assert/strict");
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { transcriptEventId } = require("../app/agent-service/transcript-store");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");

const RPC_TIMEOUT_MS = 8_000;
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId",
  "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];

async function fixture(t, serviceOptions = {}, { startupConcurrency = 8, cooperativeCompile = false } = {}) {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: false, durableChatAcceptance: true, ...serviceOptions } });
  const { service, paths, transport } = f;
  const { workRunCoordinator: coordinator, contextCompiler: compiler } = service;
  const pending = new Set();
  let release;
  let reopened = null, stopped = false;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(async () => {
    release();
    await Promise.allSettled([...pending]);
    if (reopened) await reopened.close();
    else if (stopped) fs.rmSync(f.root, { recursive: true, force: true });
    else await f.close();
  });
  const config = service.nativeRuntimeConfig.read();
  service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1, maxActive: 32, startupConcurrency,
    flags: { ...config.flags, runtimeAdmissionV1: true } });
  const source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  const profileB = service.productStore.putAgentProfile({ ...source,
    id: "fixture-agent-b", agentId: "fixture-agent-b", runtimeProfileId: "fixture-agent-b",
    name: "Fixture B", isDefault: false });
  service.agentDefinitionStore.ensureProfile({ profileId: profileB.id });
  const workspaceB = path.join(f.root, "workspace-b");
  fs.mkdirSync(workspaceB, { mode: 0o700 });
  const a = f.createSession();
  const b = service.chatSessionStore.createSession({ operationId: "create-b", profileId: profileB.id,
    workspace: workspaceB, createdAt: Date.now() });

  const preparing = [];
  const stoppedCompiles = [];
  if (cooperativeCompile) {
    const compileAsync = compiler.compileAsync.bind(compiler);
    compiler.compileAsync = async (input, ...args) => {
      preparing.push(input.query);
      if (input.query === "Slow A") {
        assert.ok(input.signal instanceof AbortSignal, "the compile receives the Run signal");
        let onAbort;
        try {
          await Promise.race([blocked, new Promise((_, reject) => {
            onAbort = () => reject(input.signal.reason);
            input.signal.addEventListener("abort", onAbort, { once: true });
            if (input.signal.aborted) onAbort();
          })]);
        } finally {
          input.signal.removeEventListener("abort", onAbort);
          if (input.signal.aborted) stoppedCompiles.push(input.run.id);
        }
      }
      return compileAsync(input, ...args);
    };
  } else {
    compiler.semanticSearch ||= {};
    compiler.prepareRelated = async ({ query }) => {
      preparing.push(query);
      if (query === "Slow A") await blocked;
    };
  }
  const rpc = (method, params) => {
    const request = requestService(paths, { token: readClientToken(paths), version: PROTOCOL_VERSION, method, params },
      { timeoutMs: RPC_TIMEOUT_MS });
    pending.add(request);
    request.then(() => pending.delete(request), () => pending.delete(request));
    return request;
  };
  const params = (operationId, session, prompt) => ({ operationId, sessionKey: session.sessionKey,
    createdAt: Date.now(), prompt });
  const userEvents = (session, operationId) => service.transcriptStore.listEvents(session.profileId, session.id)
    .filter(event => event.kind === "user" && event.content.operationId === operationId);
  const nativeTurns = () => [...transport.handles.values()].reduce((sum, handle) => sum + handle.host.turnStartCalls, 0);
  const run = id => (reopened?.service || service).workRunCoordinator.getRun(id);
  const running = async id => {
    await waitUntil(() => run(id)?.status === "running", `Run ${id} to enter native execution`, RPC_TIMEOUT_MS);
    return run(id);
  };
  async function reopenWhileBlocked(serviceOptions = { durableChatAcceptance: true }) {
    await f.close({ remove: false });
    stopped = true;
    if (!cooperativeCompile) release();
    reopened = await openHandoffFixture({ root: f.root, transport,
      serviceOptions: { memoryCore: false, ...serviceOptions } });
    return reopened;
  }
  return { ...f, a, b, preparing, stoppedCompiles, release, rpc, params, userEvents, nativeTurns, run, running, reopenWhileBlocked };
}

async function assertAccepted(f, request, session, ack) {
  assert.equal(ack.disposition, "queued");
  assert.equal(ack.run.status, "queued");
  assert.equal(ack.run.profileId, session.profileId);
  const command = f.service.pendingCommandInbox.get(request.operationId);
  assert.equal(command?.runId, ack.run.id);
  assert.equal(command?.sessionKey, session.sessionKey);
  const events = f.userEvents(session, request.operationId);
  assert.equal(events.length, 1);
  assert.equal(events[0].content.text, request.prompt);
  const readBack = await f.rpc("chat.operation.get", { operationId: request.operationId, sessionKey: session.sessionKey });
  assert.equal(readBack.status, "found");
  assert.equal(readBack.run.id, ack.run.id);
}

test("durable chat receipts precede slow preparation and an independent session dispatches first", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const a = f.params("send-a", f.a, "Slow A");
  const b = f.params("send-b", f.b, "Independent B");
  const c = f.params("send-c", f.a, "Next in session A");
  const ackA = await f.rpc("chat.send", a);
  await assertAccepted(f, a, f.a, ackA);
  await waitUntil(() => f.preparing.includes(a.prompt), "A to wait on its preparation gate", RPC_TIMEOUT_MS);
  assert.equal(f.nativeTurns(), 0);

  const ackC = await f.rpc("chat.send", c);
  const ackB = await f.rpc("chat.send", b);
  await assertAccepted(f, b, f.b, ackB);
  await assertAccepted(f, c, f.a, ackC);
  const runB = await f.running(ackB.run.id);
  assert.equal(f.run(ackA.run.id).status, "queued");
  assert.equal(f.run(ackC.run.id).status, "queued");
  assert.deepEqual(f.preparing, [a.prompt, b.prompt]);
  assert.equal(f.nativeTurns(), 1, "B dispatched while A is still blocked");
  await f.complete(runB);

  f.release();
  const runA = await f.running(ackA.run.id);
  assert.equal(f.nativeTurns(), 2);
  assert.ok(!f.preparing.includes(c.prompt), "C cannot prepare while A still owns the session");
  const contextA = f.transport.acquisitions.find(row => row.options.executionContract?.runId === runA.id)
    ?.options.executionContract.dynamicContext;
  assert.equal(typeof contextA, "string");
  assert.ok(!contextA.includes(c.prompt), "a later accepted user event is not part of A's context");
  const answerA = "A completed before the next turn started";
  await f.complete(runA, answerA);
  const runC = await f.running(ackC.run.id);
  assert.deepEqual(f.preparing, [a.prompt, b.prompt, c.prompt]);
  assert.equal(f.nativeTurns(), 3);
  const contextC = f.transport.acquisitions.find(row => row.options.executionContract?.runId === runC.id)
    ?.options.executionContract.dynamicContext;
  assert.ok(contextC.includes(answerA), "C sees A's preceding answer even though it was written after C's receipt");
  assert.ok(!contextC.includes(c.prompt), "C's prompt is delivered separately from its prior conversation");
  await f.complete(runC);
  const replay = await f.rpc("chat.send", a);
  assert.equal(replay.run.id, ackA.run.id);
  assert.equal(replay.run.status, "completed");
  assert.equal(f.userEvents(f.a, a.operationId).length, 1);
  assert.equal(f.nativeTurns(), 3, "retrying the original receipt does not dispatch another turn");
});

test("canceling an accepted chat fences a late preparation result", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const a = f.params("send-a", f.a, "Slow A");
  const ack = await f.rpc("chat.send", a);
  await assertAccepted(f, a, f.a, ack);
  await waitUntil(() => f.preparing.includes(a.prompt), "A to wait on its preparation gate", RPC_TIMEOUT_MS);
  const canceled = await f.rpc("chat.abort", { operationId: "stop-a", sessionKey: f.a.sessionKey,
    runId: ack.run.id, createdAt: Date.now() });
  assert.equal(canceled.run?.status, "canceled");
  assert.equal(f.service.pendingCommandInbox.get(a.operationId)?.state, "canceled");
  assert.equal(f.nativeTurns(), 0);

  f.release();
  const next = f.params("send-after-cancel", f.a, "Next in session A");
  const nextAck = await f.rpc("chat.send", next);
  await assertAccepted(f, next, f.a, nextAck);
  await f.complete(await f.running(nextAck.run.id));
  assert.equal(f.nativeTurns(), 1, "only the new operation reached the Runtime");
  const replay = await f.rpc("chat.send", a);
  assert.equal(replay.run.id, ack.run.id);
  assert.equal(replay.run.status, "canceled");
  assert.equal(f.userEvents(f.a, a.operationId).length, 1);
});

test("canceling a compiling chat releases the only preparation slot", { timeout: 40_000 }, async t => {
  const f = await fixture(t, {}, { startupConcurrency: 1, cooperativeCompile: true });
  const a = f.params("send-compile-a", f.a, "Slow A");
  const ackA = await f.rpc("chat.send", a);
  await assertAccepted(f, a, f.a, ackA);
  await waitUntil(() => f.preparing.includes(a.prompt), "A to begin context compilation", RPC_TIMEOUT_MS);

  const b = f.params("send-compile-b", f.b, "Independent B");
  const ackB = await f.rpc("chat.send", b);
  await assertAccepted(f, b, f.b, ackB);
  assert.deepEqual(f.preparing, [a.prompt]);
  assert.equal(f.nativeTurns(), 0);

  const canceled = await f.rpc("chat.abort", { operationId: "stop-compile-a", sessionKey: f.a.sessionKey,
    runId: ackA.run.id, createdAt: Date.now() });
  assert.equal(canceled.run?.status, "canceled");
  assert.equal(f.service.pendingCommandInbox.get(a.operationId)?.state, "canceled");
  await f.complete(await f.running(ackB.run.id));
  assert.deepEqual(f.stoppedCompiles, [ackA.run.id]);
  assert.equal(f.nativeTurns(), 1);
  assert.equal(f.userEvents(f.a, a.operationId).length, 1);
});

test("Service stop cancels its compile before reopen resumes the receipt once", { timeout: 40_000 }, async t => {
  const f = await fixture(t, {}, { startupConcurrency: 1, cooperativeCompile: true });
  const a = f.params("send-old-service-compile", f.a, "Slow A");
  const ack = await f.rpc("chat.send", a);
  await assertAccepted(f, a, f.a, ack);
  await waitUntil(() => f.preparing.includes(a.prompt), "old Service to begin context compilation", RPC_TIMEOUT_MS);
  assert.equal(f.nativeTurns(), 0);

  const reopened = await f.reopenWhileBlocked();
  assert.deepEqual(f.stoppedCompiles, [ack.run.id]);
  await reopened.complete(await f.running(ack.run.id));
  const events = reopened.service.transcriptStore.listEvents(f.a.profileId, f.a.id, { runId: ack.run.id });
  assert.equal(events.filter(event => event.kind === "user" && event.content.operationId === a.operationId).length, 1);
  const replay = await f.rpc("chat.send", a);
  assert.equal(replay.run.id, ack.run.id);
  assert.equal(replay.run.status, "completed");
  assert.equal(f.nativeTurns(), 1);
});

test("an acknowledged but undispatched chat resumes once after Service reopen", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const a = f.params("send-before-reopen", f.a, "Slow A");
  const ack = await f.rpc("chat.send", a);
  await assertAccepted(f, a, f.a, ack);
  await waitUntil(() => f.preparing.includes(a.prompt), "A to wait on its preparation gate", RPC_TIMEOUT_MS);
  assert.equal(f.nativeTurns(), 0);

  const reopened = await f.reopenWhileBlocked();
  const run = await f.running(ack.run.id);
  assert.equal(f.nativeTurns(), 1);
  const events = reopened.service.transcriptStore.listEvents(f.a.profileId, f.a.id)
    .filter(event => event.kind === "user" && event.content.operationId === a.operationId);
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, ack.run.id);
  await reopened.complete(run);
  const replay = await f.rpc("chat.send", a);
  assert.equal(replay.run.id, ack.run.id);
  assert.equal(replay.run.status, "completed");
  assert.equal(f.nativeTurns(), 1);
});

test("Inbox-only acknowledgement survives projection I/O failure and can be canceled by original operation",
  { timeout: 40_000 }, async t => {
    const f = await fixture(t);
    const request = f.params("inbox-only", f.a, "Accepted before user projection");
    const dispatcher = f.service.workRunCoordinator.dispatcher;
    const original = f.service.transcriptStore.appendEvent.bind(f.service.transcriptStore);
    let blocked = true;
    f.service.transcriptStore.appendEvent = event => {
      if (blocked && event.content?.operationId === request.operationId) {
        throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
      }
      return original(event);
    };
    t.after(() => { blocked = false; });
    const receipt = await f.rpc("chat.send.accept", request);
    assert.equal(receipt.version, 1);
    assert.equal(receipt.operationId, request.operationId);
    assert.equal(receipt.sessionKey, request.sessionKey);
    assert.equal(f.service.pendingCommandInbox.get(receipt.operationId).runId, receipt.runId);
    assert.equal(f.userEvents(f.a, request.operationId).length, 0);
    assert.equal(f.nativeTurns(), 0);
    assert.ok(!f.preparing.includes(request.prompt));
    const cancel = await f.rpc("chat.send.cancel", { operationId: request.operationId, sessionKey: request.sessionKey });
    assert.deepEqual(cancel, receipt);
    assert.equal(f.service.pendingCommandInbox.get(receipt.operationId).cancelRequested, true);
    blocked = false;
    await waitUntil(() => f.service.pendingCommandInbox.get(receipt.operationId)?.state === "canceled",
      "canceled acceptance to settle", RPC_TIMEOUT_MS);
    assert.equal(dispatcher.getRun(receipt.runId).status, "canceled");
    assert.equal(f.userEvents(f.a, receipt.operationId).length, 1);
    assert.equal(f.nativeTurns(), 0);
    const replay = await f.rpc("chat.send.accept", request);
    assert.deepEqual(replay, receipt);
  });

test("a materialized acceptance keeps its receipt until the user event and direct abort preserves that event",
  { timeout: 40_000 }, async t => {
    const f = await fixture(t);
    const request = f.params("abort-between-projections", f.a, "Preserve this accepted prompt when stopping");
    const { workRunCoordinator: coordinator, productStore, transcriptStore, pendingCommandInbox: inbox } = f.service;
    const userEventId = transcriptEventId("chat-user", request.operationId);
    const abortScope = new AsyncLocalStorage();
    let firstOwnerTurn, observingEnqueue = false, allowAbortWrite = false;
    let userAttempts = 0, directAttempts = 0, preflights = 0;
    let directAbortError;

    const unsubscribe = coordinator.dispatcher.subscribeChanges(run => {
      if (observingEnqueue || run.status !== "queued"
        || run.idempotencyKey !== `shoggoth:chat-send:${request.operationId}`) return;
      observingEnqueue = true;
      queueMicrotask(() => {
        firstOwnerTurn = {
          run: productStore.getWorkRun(run.id),
          event: transcriptStore.getEvent(f.a.profileId, f.a.id, userEventId),
          attempts: userAttempts,
        };
      });
    });
    t.after(unsubscribe);

    const abort = coordinator.abort.bind(coordinator);
    t.mock.method(coordinator, "abort", input => {
      const scope = { active: true };
      return abortScope.run(scope, async () => {
        try { return await abort(input); }
        catch (error) { directAbortError = error.code; throw error; }
        finally { scope.active = false; }
      });
    });
    const preflight = coordinator.beforeSessionSend.bind(coordinator);
    t.mock.method(coordinator, "beforeSessionSend", input => {
      if (input.operationId === request.operationId) preflights++;
      return preflight(input);
    });
    const append = transcriptStore.appendEvent.bind(transcriptStore);
    t.mock.method(transcriptStore, "appendEvent", event => {
      if (event.id === userEventId) {
        userAttempts++;
        const direct = abortScope.getStore()?.active === true;
        if (direct) directAttempts++;
        if (!direct || !allowAbortWrite) {
          throw Object.assign(new Error("fixture user transcript write blocked"), { code: "ENOSPC" });
        }
      }
      return append(event);
    });

    const receipt = await f.rpc("chat.send.accept", request);
    await waitUntil(() => firstOwnerTurn, "durable WorkRun without user projection", RPC_TIMEOUT_MS);
    assert.equal(firstOwnerTurn.run.id, receipt.runId);
    assert.equal(firstOwnerTurn.run.status, "queued");
    assert.equal(firstOwnerTurn.event, null);
    assert.equal(firstOwnerTurn.attempts, 0, "transcript append runs in a later owner turn");

    const lookup = { operationId: request.operationId, sessionKey: request.sessionKey, includeAcceptance: true };
    const expected = { status: "accepted", run: null, receipt };
    assert.deepEqual(await f.rpc("chat.operation.get", lookup), expected);
    assert.deepEqual(await f.rpc("chat.operation.reconcile", { ...lookup, createdAt: request.createdAt }), expected);
    const stop = operationId => f.rpc("chat.abort", { operationId, sessionKey: request.sessionKey,
      runId: receipt.runId, createdAt: Date.now() });
    await assert.rejects(stop("stop-while-user-write-blocked"));
    assert.equal(directAbortError, "ENOSPC");
    assert.equal(directAttempts, 1);
    assert.equal(productStore.getWorkRun(receipt.runId).status, "queued");
    assert.equal(inbox.get(receipt.operationId).state, "pending");
    assert.equal(f.userEvents(f.a, receipt.operationId).length, 0);
    assert.deepEqual(await f.rpc("chat.operation.get", lookup), expected);
    assert.equal(preflights, 0);

    // Keep the timer's append blocked so this successful write belongs to the abort itself.
    allowAbortWrite = true;
    const canceled = await stop("stop-after-user-write-available");
    assert.equal(canceled.run.id, receipt.runId);
    assert.equal(canceled.run.status, "canceled");
    assert.equal(directAttempts, 2);
    assert.equal(inbox.get(receipt.operationId).state, "canceled");
    const events = transcriptStore.listEvents(f.a.profileId, f.a.id, { runId: receipt.runId });
    const users = events.filter(event => event.kind === "user");
    const terminals = events.filter(event => event.content?.transcriptType === "terminal");
    assert.equal(users.length, 1);
    assert.equal(users[0].id, userEventId);
    assert.equal(users[0].content.text, request.prompt);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].content.status, "canceled");
    assert.ok(users[0].seq < terminals[0].seq);
    assert.equal(preflights, 0);
    assert.equal(f.nativeTurns(), 0);
    const settled = await f.rpc("chat.operation.get", lookup);
    assert.equal(settled.status, "found");
    assert.equal(settled.run.id, receipt.runId);
    assert.equal(settled.run.status, "canceled");
    assert.deepEqual(await f.rpc("chat.send.accept", request), receipt);
    assert.equal(f.userEvents(f.a, receipt.operationId).length, 1);
  });

test("legacy send preserves session order behind a durable acceptance with an unwritten user event",
  { timeout: 40_000 }, async t => {
    const f = await fixture(t);
    const first = f.params("modern-before-legacy", f.a, "Slow A");
    // Numeric operation IDs are valid but enumerate before other object keys.
    const second = f.params("42", f.a, "Reply to the previously accepted message");
    const { transcriptStore, pendingCommandInbox: inbox } = f.service;
    const firstId = transcriptEventId("chat-user", first.operationId);
    const secondId = transcriptEventId("chat-user", second.operationId);
    const events = () => transcriptStore.listEvents(f.a.profileId, f.a.id)
      .filter(event => event.id === firstId || event.id === secondId);
    let blockFirst = true, firstWriteBlocked = false;
    const append = transcriptStore.appendEvent.bind(transcriptStore);
    t.mock.method(transcriptStore, "appendEvent", event => {
      if (blockFirst && event.id === firstId) {
        firstWriteBlocked = true;
        throw Object.assign(new Error("fixture first user transcript write blocked"), { code: "ENOSPC" });
      }
      return append(event);
    });

    const firstReceipt = await f.rpc("chat.send.accept", first);
    await waitUntil(() => firstWriteBlocked, "background projection to hit the first user write barrier", RPC_TIMEOUT_MS);
    assert.equal(f.run(firstReceipt.runId).status, "queued");
    await assert.rejects(f.rpc("chat.send", second), { code: "CHAT_OPERATION_VERIFICATION_REQUIRED" });
    const secondCommand = inbox.get(second.operationId);
    assert.equal(secondCommand.state, "pending");
    assert.equal(secondCommand.sessionKey, f.a.sessionKey);
    assert.ok(secondCommand.acceptance);
    const lookup = await f.rpc("chat.operation.get", { operationId: second.operationId,
      sessionKey: second.sessionKey, includeAcceptance: true });
    assert.deepEqual(lookup, { status: "accepted", run: null, receipt: { version: 1,
      operationId: second.operationId, sessionKey: second.sessionKey, runId: secondCommand.runId,
      acceptedAt: secondCommand.createdAt } });
    assert.deepEqual(events(), []);
    assert.deepEqual(f.preparing, []);
    assert.equal(f.nativeTurns(), 0);

    blockFirst = false;
    await waitUntil(() => events().length === 2 && f.preparing.includes(first.prompt),
      "ordered user events and the first preparation", RPC_TIMEOUT_MS);
    assert.deepEqual(events().map(event => [event.id, event.runId, event.content.text]),
      [[firstId, firstReceipt.runId, first.prompt], [secondId, secondCommand.runId, second.prompt]]);
    assert.deepEqual(f.preparing, [first.prompt]);
    assert.equal(f.nativeTurns(), 0);

    f.release();
    await f.complete(await f.running(firstReceipt.runId));
    await f.complete(await f.running(secondCommand.runId));
    const replay = await f.rpc("chat.send", second);
    assert.equal(replay.run.id, secondCommand.runId);
    assert.equal(replay.run.status, "completed");
    assert.deepEqual(events().map(event => event.id), [firstId, secondId]);
    assert.deepEqual(f.preparing, [first.prompt, second.prompt]);
    assert.equal(f.nativeTurns(), 2);
  });

test("compatible recovery reads v2 receipts with the new writer and fast admission disabled", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const slow = f.params("rollback-accepted", f.a, "Slow A");
  const receipt = await f.rpc("chat.send.accept", slow);
  await waitUntil(() => f.preparing.includes(slow.prompt), "accepted operation waiting before rollback reopen", RPC_TIMEOUT_MS);
  assert.equal(f.nativeTurns(), 0);
  const reopened = await f.reopenWhileBlocked({ durableChatAcceptance: false, pendingCommandWorkerWrites: false });
  const ready = await f.rpc("service.status", {});
  assert.equal(ready.chatAcceptanceV1, false);
  assert.equal(reopened.service.pendingCommandInbox.fileWriter, null);
  const run = await f.running(receipt.runId);
  assert.equal(f.nativeTurns(), 1);
  await reopened.complete(run);
  const lookup = await f.rpc("chat.operation.get", { operationId: slow.operationId, sessionKey: slow.sessionKey });
  assert.equal(lookup.run.id, receipt.runId);
  const replay = await f.rpc("chat.send", slow);
  assert.equal(replay.run.id, receipt.runId);
  assert.equal(replay.disposition, "completed");
  assert.equal(f.nativeTurns(), 1);
  const messages = reopened.service.transcriptStore.listEvents(f.a.profileId, f.a.id, { runId: run.id });
  assert.equal(messages.filter(event => event.kind === "user" && event.content.operationId === slow.operationId).length, 1);
});

test("a definite Inbox storage failure returns the safe issue and leaves no admitted operation", { timeout: 40_000 }, async t => {
  const full = Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
  let injectFailure = true;
  const pendingCommandFs = Object.create(fs, {
    openSync: { value(target, ...args) {
      if (injectFailure && target.endsWith("/pending-commands.json.tmp")) throw full;
      return fs.openSync(target, ...args);
    } },
  });
  const f = await fixture(t, { pendingCommandFs });
  const input = f.params("inbox-storage-full", f.a, "Only accept after durable storage is available");
  await assert.rejects(f.rpc("chat.send.accept", input), { code: "SERVICE_UNAVAILABLE", systemIssue: "STORAGE_FULL",
    admissionAccepted: false });
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.paths.runtimeDir, "chat-send-diagnostics.json"))).records.at(-1);
  assert.equal(diagnostic.phase, "command_enqueue");
  assert.equal(diagnostic.errors[0].code, "PENDING_COMMAND_WRITE_FAILED");
  assert.equal(diagnostic.systemIssue, "STORAGE_FULL");
  assert.equal(f.service.pendingCommandInbox.get(input.operationId), null);
  assert.equal(f.userEvents(f.a, input.operationId).length, 0);
  assert.equal(f.nativeTurns(), 0);
  injectFailure = false;
  const receipt = await f.rpc("chat.send.accept", input);
  assert.equal(receipt.operationId, input.operationId);
  const run = await f.running(receipt.runId);
  await f.complete(run);
  assert.equal(f.userEvents(f.a, input.operationId).length, 1);
  assert.equal(f.nativeTurns(), 1);
});
