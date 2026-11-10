"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

async function run() {
  const f = await startInspirationFixture({ isolatedHome: true, codexFakeEnv: { CODEX_FAKE_MODEL_CATALOG: "1" },
    serviceOptions: { prewarmMcpAuth: false } });
  try {
    const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const publicKey = await f.backend.createSession(profile.agentId);
    const sessionKey = f.backend.getSessionRows().find(row => row.key === publicKey).sessionId;
    const before = f.service.chatSessionStore.getSession(sessionKey);
    const url = `${f.url}/__api/agents/${profile.agentId}/chat-prewarm?backend=shoggoth&sessionKey=${encodeURIComponent(publicKey)}`;
    const requests = await Promise.all(Array.from({ length: 3 }, () => fetch(url, { method: "POST" })));
    for (const response of requests) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { supported: true, state: "ready" }); }
    assert.equal(f.service.runtimeManager.statistics().hosts, 1);
    assert.deepEqual(f.service.chatSessionStore.getSession(sessionKey), before, "prewarming cannot bind or revise a session");
    assert.equal(f.service.productStore.listWorkRuns().length, 0, "no Run or model turn is created");
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url.replace(encodeURIComponent(publicKey), ""), { method: "POST" })).status, 400);
    assert.equal((await f.ipc("chat.session.prewarm", { profileId: "foreign", sessionKey })).state, "unavailable");
    assert.equal((await f.ipc("chat.session.prewarm", { profileId: profile.id, sessionKey: crypto.randomUUID() })).state, "unavailable");
    console.log("PASS native prewarm REST/IPC: real isolated process reused, no session/Run, ownership and malformed input");
  } finally { await f.close(); }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
