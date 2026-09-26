"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");

const models = { codex: "codex-only", antigravity: "antigravity-only" };
const terminal = new Set(["completed", "failed", "skipped", "interrupted", "canceled"]);

async function fixture(defaultRuntime) {
  const f = await openHandoffFixture({ catalogs: {
    codex: ["fixture-model", models.codex], antigravity: ["fixture-model", models.antigravity],
    pi: ["fixture-model"], "deepseek-harness": ["fixture-model"],
  } });
  f.service.productStore.addAgentRuntimeBinding(f.profile.id, { runtime: "antigravity",
    runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(account => account.runtime === "antigravity").id },
  { operationId: "inspiration-antigravity-binding" });
  const bindings = f.service.productStore.getAgentRuntimeBindings(f.profile.id);
  f.service.productStore.setAgentDefaultBinding(f.profile.id, f.binding(defaultRuntime).id,
    { revision: bindings.revision });
  f.ipc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(),
    token: readClientToken(f.paths), version: PROTOCOL_VERSION, method, params }, { timeoutMs: 10_000 });
  f.setModel = async (key, runtime) => {
    const session = f.service.chatSessionStore.getSession(key);
    return f.ipc("chat.session.runtime.model.set", { profileId: f.profile.id, sessionKey: key,
      bindingId: f.binding(runtime).id, model: models[runtime], revision: session.revision, acceptAdjustments: true });
  };
  f.settledStart = async (runId) => {
    await waitUntil(() => {
      const run = f.service.workRunCoordinator.getRun(runId);
      return run.status === "running" || terminal.has(run.status);
    }, 5000, "Inspiration Runtime admission");
    await f.service.workRunCoordinator.waitForIdle(runId);
    return f.service.workRunCoordinator.getRun(runId);
  };
  const { idea } = await f.ipc("inspiration.create", {
    operationId: crypto.randomUUID(), body: "Preserve this idea and its conversation across runtimes.",
  });
  f.ideaId = idea.id;
  f.startBackground = async () => {
    const idea = f.service.inspirationStore.get(f.ideaId);
    const { idea: updated } = await f.ipc("inspiration.start", { id: idea.id,
      expectedRevision: idea.revision, operationId: crypto.randomUUID(), instruction: "Continue the idea",
      agentId: f.profile.agentId, backendId: f.profile.backendId, workspace: f.workspace });
    f.sessionKey = updated.latestExecution.sessionKey;
    return f.settledStart(updated.latestExecution.runId);
  };
  const first = await f.startBackground();
  assert.equal(first.status, "running", first.errorCode);
  assert.equal(first.runtimeSessionRef.runtime, defaultRuntime);
  await f.complete(first, "PRESERVED INITIAL ANSWER");
  f.first = first;
  return f;
}

for (const [from, to] of [["codex", "antigravity"], ["antigravity", "codex"]]) {
  test(`Inspiration chat ${from} -> ${to} preserves the selected Runtime and model on send`, async () => {
    const f = await fixture(from);
    try {
      const original = f.service.chatSessionStore.getSession(f.sessionKey);
      const defaultBindingId = f.service.productStore.getAgentProfile(f.profile.id).defaultBindingId;
      await f.setModel(f.sessionKey, to);
      const input = { sessionKey: f.sessionKey, operationId: crypto.randomUUID(),
        prompt: "Continue in the selected runtime", createdAt: Date.now() };
      const ack = await f.ipc("chat.send", input);
      const run = await f.settledStart(ack.run.id);
      assert.equal(run.status, "running", run.resultSummary || run.errorCode);
      assert.equal(run.runtimeSessionRef.runtime, to);
      assert.equal(f.transport.hosts.get(to).lastTurnStartParams.model, models[to]);
      assert.equal(f.service.inspirationStore.executionForRun(run.id).inputSource, "chat");
      assert.equal(f.service.inspirationStore.executionForRun(run.id).sessionKey, f.sessionKey);
      assert.equal(f.service.chatSessionStore.getSession(f.sessionKey).id, original.id);
      assert.equal(f.service.chatSessionStore.getSession(f.sessionKey).runtimeBindingId, f.binding(to).id);
      assert.equal(f.service.productStore.getAgentProfile(f.profile.id).defaultBindingId, defaultBindingId);
      assert.equal(f.transport.hosts.get(from).turnStartCalls, 1, "the old runtime must not receive this message");
      await f.complete(run, "PRESERVED SWITCHED ANSWER");
      const replay = await f.ipc("chat.send", input);
      assert.equal(replay.run.id, run.id);
      assert.equal(f.transport.hosts.get(to).turnStartCalls, 1, "replaying the operation must not duplicate a turn");
      const events = f.service.transcriptStore.listEvents(f.profile.id, original.id);
      assert.ok(events.some(event => event.content.text === "PRESERVED INITIAL ANSWER"));
      assert.ok(events.some(event => event.content.text === "PRESERVED SWITCHED ANSWER"));
      await f.setModel(f.sessionKey, from);
      const back = await f.ipc("chat.send", { ...input, operationId: crypto.randomUUID(), prompt: "Switch back" });
      const returned = await f.settledStart(back.run.id);
      assert.equal(returned.status, "running", returned.resultSummary || returned.errorCode);
      assert.equal(returned.runtimeSessionRef.runtime, from);
      assert.notEqual(returned.runtimeSessionRef.sessionId, f.first.runtimeSessionRef.sessionId,
        "returning to a runtime creates a fresh native session rather than resuming its retired one");
      await f.complete(returned);
    } finally { await f.close(); }
  });
}

test("background Inspiration still follows the Agent default after a conversation was switched", async () => {
  const f = await fixture("codex");
  try {
    await f.switch(f.sessionKey, "antigravity");
    const chat = await f.ipc("chat.send", { sessionKey: f.sessionKey, operationId: crypto.randomUUID(),
      prompt: "Selected runtime", createdAt: Date.now() });
    const switched = await f.settledStart(chat.run.id);
    assert.equal(switched.runtimeSessionRef?.runtime, "antigravity");
    await f.complete(switched);
    const key = f.sessionKey;
    const background = await f.startBackground();
    assert.equal(background.status, "running", background.errorCode);
    assert.equal(background.runtimeSessionRef.runtime, "codex");
    assert.equal(f.sessionKey, key);
    assert.notEqual(f.service.inspirationStore.executionForRun(background.id).inputSource, "chat");
    await f.complete(background);
  } finally { await f.close(); }
});

test("Inspiration preparation errors remain typed in the durable run and transcript", async () => {
  const f = await fixture("codex");
  try {
    f.service.workRunCoordinator.followDefaultSessionBinding = async () => {
      throw Object.assign(new Error("private diagnostic details"), { code: "SESSION_RUNTIME_CONFIRMATION_REQUIRED" });
    };
    const run = await f.startBackground();
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "SESSION_RUNTIME_CONFIRMATION_REQUIRED");
    assert.equal(run.startedAt, null);
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 1);
    const session = f.service.chatSessionStore.getSession(f.sessionKey);
    const event = f.service.transcriptStore.listEvents(f.profile.id, session.id)
      .find(event => event.runId === run.id && event.content.transcriptType === "terminal");
    assert.equal(event.content.errorCode, run.errorCode);
    assert.doesNotMatch(JSON.stringify(event), /private diagnostic details/);
  } finally { await f.close(); }
});

test("unknown preparation errors cannot expose private text as an error code", async () => {
  const f = await fixture("codex");
  try {
    f.service.workRunCoordinator.followDefaultSessionBinding = async () => {
      throw Object.assign(new Error("PRIVATE_DIAGNOSTIC_CANARY"), { code: "PRIVATE_DIAGNOSTIC_CANARY" });
    };
    const run = await f.startBackground();
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "RUNTIME_START_FAILED");
    assert.doesNotMatch(JSON.stringify(run), /PRIVATE_DIAGNOSTIC_CANARY/);
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 1);
  } finally { await f.close(); }
});
