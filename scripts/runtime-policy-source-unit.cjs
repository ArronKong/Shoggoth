"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { defaultRuntimeSelectionPolicy, selectRuntimeBinding } = require("../app/agent-service/runtime-selection-policy");
const { SourceConversationStore, sourcePolicyForRun } = require("../app/agent-service/source-conversation-policy");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const facts = { installed: true, authenticated: true, permissionEnforcementProven: true, models: [], attachmentKinds: [] };
test("Fixed/Preferred/Auto enforce authorization before stable affinity and ranking; occupancy does not reroute", () => {
  const bindings = ["a", "b", "outside"].map(id => ({ id, enabled: true, runtime: "codex" }));
  const base = { bindings, facts: { a: facts, b: { ...facts, active: 100, quota: "exhausted" }, outside: facts },
    currentBindingId: "a", defaultBindingId: "a", requirements: { permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } } };
  const policy = { ...defaultRuntimeSelectionPolicy(), mode: "preferred", allowedBindingIds: ["a", "b"], preferredBindingIds: ["b", "a"], affinity: false };
  assert.equal(selectRuntimeBinding({ ...base, policy }).bindingId, "b");
  assert.equal(selectRuntimeBinding({ ...base, policy: { ...policy, affinity: true } }).bindingId, "a");
  const fallback = selectRuntimeBinding({ ...base, facts: { ...base.facts, b: { ...facts, installed: false } }, policy });
  assert.equal(fallback.bindingId, "a"); assert.equal(fallback.reason, "PRE_DISPATCH_FALLBACK");
  assert.equal(selectRuntimeBinding({ ...base, policy, explicitBindingId: "outside" }).bindingId, null);
  assert.equal(selectRuntimeBinding({ ...base, policy: { ...policy, mode: "auto", weights: { a: 3, b: 8 } } }).bindingId, "b");
});
test("authenticated policy RPC affects the next send, preserves busy conversation and records explanation", async () => {
  const f = await openHandoffFixture();
  try {
    const call = (method, params) => requestService(f.paths, { version: PROTOCOL_VERSION, token: readClientToken(f.paths), method, params }, { timeoutMs: 30_000 });
    const initial = await call("agent.runtimePolicy.get", { profileId: f.profile.id });
    const policy = { ...initial, mode: "preferred", affinity: false, allowedBindingIds: [f.binding("codex").id, f.binding("pi").id], preferredBindingIds: [f.binding("pi").id] };
    await call("agent.runtimePolicy.set", { profileId: f.profile.id, policy });
    const session = f.createSession(), run = await f.send(session.sessionKey, "preferred-send");
    assert.equal(run.runtimeSessionRef.runtime, "pi");
    assert.ok(f.service.transcriptStore.listEvents(f.profile.id, session.id).some(event => event.content.transcriptType === "runtime.selected"));
    const queued = await f.send(session.sessionKey, "preferred-queued"); assert.equal(queued.status, "queued");
    await f.complete(run); await f.service.workRunCoordinator.waitForIdle(queued.id);
    const next = f.service.workRunCoordinator.getRun(queued.id); assert.equal(next.runtimeSessionRef.runtime, "pi"); await f.complete(next);
    const metrics = await call("runtime.observability.get", {}); assert.equal(metrics.version, 1); assert.ok(metrics.counters["runtime.admission.admitted"] >= 2);
  } finally { await f.close(); }
});
test("switch first-turn metrics count Binding changes once and exclude same-Binding context renewal", async () => {
  const f = await openHandoffFixture();
  try {
    const session = f.createSession(), telemetry = f.service.workRunCoordinator.telemetry;
    await f.complete(await f.send(session.sessionKey, "metrics-initial"));
    assert.equal(telemetry.snapshot().counters["runtime.switch.first_turn"] || 0, 0);
    await f.switch(session.sessionKey, "pi");
    await f.complete(await f.send(session.sessionKey, "metrics-first"));
    await f.complete(await f.send(session.sessionKey, "metrics-second"));
    assert.equal(telemetry.snapshot().counters.switchFirstTurnSucceeded, 1);
    await f.switch(session.sessionKey, "pi");
    await f.complete(await f.send(session.sessionKey, "metrics-renewed"));
    assert.equal(telemetry.snapshot().counters["session.runtime.switched"], 1);
    assert.equal(telemetry.snapshot().counters.switchFirstTurnSucceeded, 1);
    await f.switch(session.sessionKey, "codex");
    await f.complete(await f.send(session.sessionKey, "metrics-return"));
    assert.equal(telemetry.snapshot().counters.switchFirstTurnSucceeded, 2);
  } finally { await f.close(); }
});
test("Kanban source policies persist exact ownership, dedicated reuse, explicit sessions and deletion", async () => {
  const f = await openHandoffFixture();
  try {
    const store = new SourceConversationStore({ paths: f.paths, chatSessionStore: f.service.chatSessionStore });
    const run = { id: "kanban-run-one", source: "kanban", sourceId: "task-one", profileId: f.profile.id, workspace: f.workspace };
    const first = store.ensure(run); assert.equal(store.ensure(run).sessionKey, first.sessionKey);
    const second = store.ensure({ ...run, id: "kanban-run-two" }); assert.notEqual(second.sessionKey, first.sessionKey);
    const dedicated = store.ensure({ ...run, id: "dedicated-one" }, { mode: "dedicated" });
    assert.equal(store.ensure({ ...run, id: "dedicated-two" }, { mode: "dedicated" }).sessionKey, dedicated.sessionKey);
    const explicit = store.ensure({ ...run, id: "explicit-one" }, { mode: "explicit", sessionKey: first.sessionKey }); assert.equal(explicit.sessionKey, first.sessionKey);
    assert.throws(() => store.ensure({ ...run, id: "wrong-profile", profileId: "other" }, { mode: "explicit", sessionKey: first.sessionKey }));
    const reopened = new SourceConversationStore({ paths: f.paths, chatSessionStore: f.service.chatSessionStore });
    assert.equal(reopened.get(run.id).sessionKey, first.sessionKey);
    const ready = await f.send(first.sessionKey, "source-ready"); await f.complete(ready);
    f.service.chatSessionStore.requestDelete(first.sessionKey, "delete-source-fixture", Date.now());
    f.service.chatSessionStore.completeRemoteOperation("delete-source-fixture");
    assert.equal(reopened.ensure(run), null, "an old run must not recreate its deleted conversation");
    assert.equal(sourcePolicyForRun({ source: "cron" }, { threadPolicy: "continue" }).mode, "dedicated");
    assert.equal(sourcePolicyForRun({ source: "inspiration" }).mode, "dedicated");
    assert.equal(sourcePolicyForRun({ source: "cron" }).mode, "new-each-run");
  } finally { await f.close(); }
});
