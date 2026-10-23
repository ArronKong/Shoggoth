"use strict";
// REST/IPC smoke for one reply's context breakdown: a real Service turn writes
// its snapshot, the route reads that run's composition within its own session,
// and repeated reads reuse the per-snapshot cache instead of the file.
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { DEFAULT_AGENT_PROFILE_ID: profileId } = require("../app/agent-service/product-store");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const protocol = require("../app/agent-service/product-context-protocol");

// The snapshot is written at admission, so a started run already has one.
async function started(f, runId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const run = f.service.workRunCoordinator.getRun(runId);
    if (["running", "waiting_input", "waiting_approval", "completed"].includes(run?.status)) return run;
    if (["failed", "interrupted", "canceled"].includes(run?.status)) assert.fail(JSON.stringify(run));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Run did not start: ${runId}`);
}

async function run() {
  const f = await startInspirationFixture({ serviceOptions: { prewarmMcpAuth: false } });
  try {
    const profile = f.service.productStore.getAgentProfile(profileId);
    const publicKey = await f.backend.createSession(profile.agentId);
    const sessionKey = f.backend.getSessionRows().find(row => row.key === publicKey).sessionId;
    const sent = await f.ipc("chat.send", { operationId: crypto.randomUUID(), sessionKey,
      prompt: "context breakdown smoke", createdAt: Date.now() });
    const finished = await started(f, sent.run.id);
    assert.match(finished.contextSnapshotId || "", /^ctx-[a-f0-9]{64}$/u, "a chat turn records its context snapshot");
    const url = runId => `${f.url}/__api/agents/${profile.agentId}/context?backend=shoggoth`
      + `&sessionKey=${encodeURIComponent(publicKey)}&runId=${encodeURIComponent(runId)}`;
    let reads = 0;
    const snapshots = f.service.workRunCoordinator.contextCompiler.snapshotStore, get = snapshots.get.bind(snapshots);
    snapshots.get = (...args) => { reads++; return get(...args); };
    const response = await fetch(url(finished.id));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.deepEqual(protocol.validateBreakdown(body), body);
    assert.equal(body.runId, finished.id); assert.equal(body.snapshotId, finished.contextSnapshotId);
    const c = body.composition;
    assert.ok(c, "a new snapshot carries its composition");
    assert.equal(c.historyDelivered, true, "the first turn of a native session is sent by Shoggoth");
    assert.equal(c.toolExposure, "all", "the fixture Runtime is Codex, which loads tools on demand");
    assert.ok(c.rulesTokens > 0 && c.definitionTokens > 0 && c.toolTokens > 0 && c.toolCount > 0 && c.messageTokens > 0);
    for (let n = 0; n < 3; n++) assert.equal((await fetch(url(finished.id))).status, 200);
    assert.equal(reads, 1, "the snapshot file is read once; later reads use the cache");
    assert.equal((await fetch(url("../escape"))).status, 400);
    assert.equal((await fetch(url(crypto.randomUUID()))).status, 409, "unknown runs are not readable");
    const otherKey = await f.backend.createSession(profile.agentId);
    const other = await fetch(url(finished.id).replace(encodeURIComponent(publicKey), encodeURIComponent(otherKey)));
    assert.equal(other.status, 409, "a run is readable only within its own session");
    assert.equal((await other.json()).code, "PRODUCT_CONTEXT_BREAKDOWN_UNAVAILABLE");
    await assert.rejects(f.ipc(protocol.BREAKDOWN_METHOD, { profileId: "wrong-profile", sessionKey, runId: finished.id }),
      { code: "CHAT_SESSION_NOT_FOUND" });
    await assert.rejects(f.ipc(protocol.BREAKDOWN_METHOD, { profileId, sessionKey, runId: finished.id, extra: true }),
      { code: "PRODUCT_CONTEXT_INVALID" });
    await f.ipc("chat.abort", { operationId: crypto.randomUUID(), sessionKey, runId: finished.id, createdAt: Date.now() })
      .catch(error => { if (error.code !== "RUN_REQUEST_STATE_CONFLICT") throw error; });
    console.log("PASS context breakdown REST/IPC: snapshot composition, session scoping, strict params, cached snapshot read");
  } finally { await f.close(); }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
