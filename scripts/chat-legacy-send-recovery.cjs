"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { test } = require("node:test");
const { fixture } = require("./fixtures/inspiration-coordinator-fixture.cjs");
const { PendingCommandInbox } = require("../app/agent-service/pending-command-inbox");
const { createChatServiceController } = require("../app/agent-service/chat-service-controller");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const cryptoBroker = { async encrypt(bytes) { return Buffer.from(bytes); }, async decrypt(bytes) { return Buffer.from(bytes); } };

test("real stores/controller/backend recover an unadmitted send without restarting; a fresh follow-up still runs", async t => {
  let f, inbox, controller;
  t.after(async () => { await controller?.close(); await f?.coordinator.close(); await inbox?.close(); });
  f = await fixture(t);
  inbox = await new PendingCommandInbox({ paths: f.paths, cryptoBroker }).open();
  f.coordinator.inbox = inbox;
  const session = f.sessions.createSession({ operationId: crypto.randomUUID(), profileId: f.profile.id,
    // Match the Service workspace resolver, including macOS /var aliases.
    workspace: fs.realpathSync(f.root), createdAt: Date.now() });
  // Retain an unrelated command alongside the uncertain operation. It carries
  // no replay payload after cancellation and never reaches the Runtime.
  await inbox.enqueue({ operationId: "retained-seed", sessionKey: session.sessionKey, runId: "seed-run",
    prompt: "fixture", createdAt: Date.now() });
  await inbox.transition("retained-seed", "canceled");
  controller = createChatServiceController({ paths: f.paths, productStore: f.productStore,
    chatSessionStore: f.sessions, coordinator: f.coordinator, transcriptStore: f.transcript,
    cursorSecret: Buffer.alloc(32, 7) });
  await controller.open();
  const backend = new ShoggothBackend({ paths: f.paths });
  backend._profilesByAgent.set(f.profile.agentId, f.profile);
  backend._sessionsByKey.set(session.sessionKey, session);
  backend._call = (method, params) => controller.handle(method, params);
  const key = `agent:${f.profile.agentId}:${session.sessionKey}`, clientKey = crypto.randomUUID();
  const operationId = `send-${crypto.createHash("sha256").update("shoggoth-chat-send\0").update(session.sessionKey).update("\0").update(clientKey).digest("hex")}`;
  const createdAt = Date.now();
  f.coordinator.beforeSessionSend = async () => { throw Object.assign(new Error("legacy preparation failed"), { code: "MEMORY_SESSION_REVOKED" }); };
  await assert.rejects(controller.handle("chat.send", { operationId, sessionKey: session.sessionKey,
    prompt: "old follow-up must never replay", createdAt }), { code: "MEMORY_SESSION_REVOKED" });
  assert.equal(f.host.turnStarts, 0);
  assert.equal((await backend.getChatOperation(key, clientKey)).status, "unresolved");
  assert.deepEqual(await backend.reconcileChatOperation(key, clientKey, createdAt), { status: "not_admitted", run: null });
  assert.equal(inbox.isUnadmittedRejection(operationId, session.sessionKey), true);
  assert.equal(f.dispatcher.listRuns().length, 0);
  await inbox.close();
  inbox = await new PendingCommandInbox({ paths: f.paths, cryptoBroker }).open(); f.coordinator.inbox = inbox;
  assert.deepEqual(await backend.reconcileChatOperation(key, clientKey, createdAt), { status: "not_admitted", run: null });
  f.coordinator.beforeSessionSend = () => {};
  await assert.rejects(controller.handle("chat.send", { operationId, sessionKey: session.sessionKey,
    prompt: "late original", createdAt: Date.now() }), { code: "WORK_RUN_SEND_REJECTED", admissionAccepted: false });
  assert.equal(f.host.turnStarts, 0);
  assert.equal(f.dispatcher.listRuns().length, 0);
  const freshOperation = crypto.randomUUID();
  const fresh = await controller.handle("chat.send", { operationId: freshOperation, sessionKey: session.sessionKey,
    prompt: "fresh follow-up", createdAt: Date.now() });
  await f.coordinator.waitForIdle(fresh.run.id);
  assert.equal(f.host.turnStarts, 1);
  assert.equal(f.dispatcher.listRuns().length, 1);
  const accepted = await controller.handle("chat.operation.reconcile", { operationId: freshOperation, sessionKey: session.sessionKey, createdAt });
  assert.equal(accepted.status, "found"); assert.equal(accepted.run.id, fresh.run.id);
  const events = f.transcript.listEvents(session.profileId, session.id);
  assert.ok(events.some(event => event.kind === "user" && event.content.text === "fresh follow-up"));
  assert.ok(events.every(event => !JSON.stringify(event.content).includes("old follow-up must never replay")));
  f.host.complete(f.dispatcher.getRun(fresh.run.id)); await f.coordinator.waitForIdle(fresh.run.id);
});
