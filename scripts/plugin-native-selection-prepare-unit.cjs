"use strict";
const assert = require("node:assert/strict");
const { openFixture, sendAndDrain, waitUntil, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function selectedStore(f) {
  const installation = { installationId: "native-selected-fixture", revision: 1, desiredState: "enabled",
    sourceIdentity: "fixture:native-selection", releaseDigest: "a".repeat(64) };
  f.coordinator.pluginStore = { getInstallation: id => id === installation.installationId ? installation : null,
    getRelease: () => ({ name: "Native selected fixture", declaredVersion: "1", components: { skills: [{ name: "local-skill" }], mcpServers: [] } }) };
  return { installation, selection: [{ installationId: installation.installationId, revision: installation.revision }] };
}
async function withFixture(fn) { const f = await openFixture(); try { await fn(f, selectedStore(f)); } finally { await f.coordinator.close(); } }
async function main() {
  await withFixture(async (f, { selection }) => {
    const hold = deferred(); let entered = false, calls = 0;
    f.coordinator.preparePluginSelection = value => { calls += 1; entered = true;
      assert(Object.isFrozen(value)); assert(Object.isFrozen(value[0])); return hold.promise; };
    const input = { operationId: "native-capture-and-concurrent", sessionKey: SESSION_KEY, prompt: "original message", pluginSelection: selection };
    const original = structuredClone(input), first = f.coordinator.send(input);
    await waitUntil(() => entered, 1000, "prepare entered");
    input.operationId = "mutated-operation"; input.prompt = "mutated message"; input.sessionKey = "mutated-owner"; input.pluginSelection[0].revision = 99;
    const second = f.coordinator.send(original);
    assert.equal(f.dispatcher.listRuns().length, 0); assert.equal(f.inbox.list().length, 0); assert.equal(f.host.turnStartCalls, 0);
    hold.resolve(); const [a, b] = await Promise.all([first, second]); await f.coordinator.waitForIdle(a.run.id);
    assert.equal(a.run.id, b.run.id); assert.equal(calls, 1); assert.equal(f.dispatcher.listRuns().length, 1); assert.equal(f.host.turnStartCalls, 1);
    assert.equal(f.inbox.get(original.operationId).prompt, original.prompt);
    assert.deepEqual(f.inbox.get(original.operationId).pluginSelection, original.pluginSelection);
    console.log("PASS frozen selected input and same-session same-key retry one Run");
  });
  await withFixture(async (f, { selection }) => {
    const hold = deferred(); let entered = false;
    f.coordinator.preparePluginSelection = () => { entered = true; return hold.promise; };
    const pending = f.coordinator.send({ operationId: "native-owner-change", sessionKey: SESSION_KEY, prompt: "stay with original owner", pluginSelection: selection });
    const rejected = assert.rejects(pending, { code: "CHAT_SESSION_NOT_READY" });
    await waitUntil(() => entered, 1000, "prepare entered"); f.sessions.session.profileId = "another-owner"; hold.resolve(); await rejected;
    assert.equal(f.dispatcher.listRuns().length, 0); assert.equal(f.inbox.list().length, 0); assert.equal(f.host.turnStartCalls, 0);
    console.log("PASS owner changes while restoring reject before inbox, Run and model");
  });
  await withFixture(async (f, { selection }) => {
    const hold = deferred(); let entered = false;
    f.coordinator.preparePluginSelection = () => { entered = true; return hold.promise; };
    const pending = f.coordinator.send({ operationId: "native-close-fence", sessionKey: SESSION_KEY, prompt: "no new generation send", pluginSelection: selection });
    const rejected = assert.rejects(pending, error => ["WORK_RUN_COORDINATOR_CLOSED", "WORK_RUN_COORDINATOR_CLOSING"].includes(error.code));
    await waitUntil(() => entered, 1000, "prepare entered"); await f.coordinator.close(); hold.resolve(); await rejected;
    assert.equal(f.dispatcher.listRuns().length, 0); assert.equal(f.inbox.list().length, 0); assert.equal(f.host.turnStartCalls, 0);
    console.log("PASS closed lifecycle cannot mint a selected send");
  });
  await withFixture(async (f, { selection }) => {
    f.coordinator.preparePluginSelection = async () => { throw Object.assign(new Error("catalog unavailable"), { code: "PLUGIN_SELECTION_UNAVAILABLE" }); };
    await assert.rejects(f.coordinator.send({ operationId: "native-failed-prepare", sessionKey: SESSION_KEY, prompt: "do not send", pluginSelection: selection }), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
    assert.equal(f.dispatcher.listRuns().length, 0); assert.equal(f.inbox.list().length, 0); assert.equal(f.host.turnStartCalls, 0);
    await sendAndDrain(f, { operationId: "ordinary-preserved" }); assert.equal(f.host.turnStartCalls, 1);
    console.log("PASS failed catalog stays closed and ordinary chat remains unchanged");
  });
  await withFixture(async (f, { installation, selection }) => {
    let calls = 0;
    f.coordinator.preparePluginSelection = async () => { calls += 1; };
    const request = { operationId: "native-completed-selection-observation", sessionKey: SESSION_KEY,
      prompt: "observe original completed operation", pluginSelection: selection };
    const ack = await f.coordinator.send(request); await f.coordinator.waitForIdle(ack.run.id);
    const run = f.dispatcher.getRun(ack.run.id), thread = f.host.threads.find(row => row.id === run.runtimeSessionRef.sessionId);
    thread.turns.find(row => row.id === run.runtimeTurnRef.turnId).status = "completed";
    f.host.emit({ known: true, type: "complete", method: "turn/completed", threadId: thread.id,
      turnId: run.runtimeTurnRef.turnId, status: "completed" });
    await f.coordinator.waitForIdle(run.id);
    assert.equal(f.dispatcher.getRun(run.id).status, "completed"); installation.desiredState = "disabled";
    const replay = await f.coordinator.send(request);
    assert.equal(replay.disposition, "completed"); assert.equal(replay.run.id, run.id);
    assert.equal(calls, 1); assert.equal(f.host.turnStartCalls, 1);
    await assert.rejects(f.coordinator.send({ ...request, prompt: "changed completed input" }), { code: "PENDING_COMMAND_IDEMPOTENCY_CONFLICT" });
    console.log("PASS completed selected receipt observes original after disable without restore or resend");
  });
  console.log(JSON.stringify({ ok: true, groups: 5, noRemote: true, localRuntimeTransport: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
