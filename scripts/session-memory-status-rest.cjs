"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DEFAULT_AGENT_PROFILE_ID: profileId } = require("../app/agent-service/product-store");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const protocol = require("../app/agent-service/active-memory-status-protocol");

async function run() {
  const config = { memory: { search: { provider: "none", rememberAcrossConversations: false } },
    plugins: { entries: { "active-memory": { enabled: true, config: { agents: [profileId], mode: "always", model: "fixture-model" } } } } };
  const f = await startInspirationFixture({ serviceOptions: { memoryCore: true, memoryCoreConfig: config, prewarmMcpAuth: false } });
  try {
    const owner = f.service.memoryEngine, profile = f.service.productStore.getAgentProfile(profileId);
    require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(owner);
    const publicKey = await f.backend.createSession(profile.agentId);
    const sessionKey = f.backend.getSessionRows().find(row => row.key === publicKey).sessionId;
    const session = f.service.chatSessionStore.getSession(sessionKey);
    const url = `${f.url}/__api/agents/${profile.agentId}/memory-status?backend=shoggoth&sessionKey=${encodeURIComponent(publicKey)}`;
    let modelCalls = 0, runtimeCalls = 0;
    const acquire = f.service.runtimeManager.acquire;
    f.service.runtimeManager.acquire = async () => { runtimeCalls++; throw Error("status fixture must never start a Runtime"); };
    owner.complete = async () => ({ text: ++modelCalls % 2
      ? '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}'
      : '{"summary":"The status fixture uses a violet telescope."}' });
    const read = async (trace = false) => {
      const response = await fetch(`${url}&trace=${trace ? "1" : "0"}`);
      assert.equal(response.status, 200); return response.json();
    };
    assert.equal((await read()).phase, "idle");
    await owner.propose({ profileId, classification: "explicit", scope: "agent", sourceRefs: ["user:status-fixture"],
      content: "The status fixture uses a violet telescope." });
    let counter = 0;
    const recall = async () => {
      const input = { profile, run: { id: `status-${++counter}`, profileId, source: "chat", sourceId: sessionKey, workspace: session.workspace },
        query: "Recall the telescope" };
      await owner.prepareActiveMemory(input); assert.match(owner.takeActiveMemory(input)?.content || "", /violet telescope/u);
      await owner.finishActiveMemoryRun(input.run);
    };
    await recall();
    const metadata = await read(); assert.equal(metadata.phase, "complete"); assert.equal(metadata.outcome, "ok");
    assert.deepEqual(metadata.traceLines, []); assert.ok(!JSON.stringify(metadata).includes("violet telescope"));
    assert.match((await read(true)).traceLines.join(" "), /violet telescope/u);
    await recall(); assert.match((await read()).statusLines.join(" "), /cached/u); assert.equal(modelCalls, 2);
    assert.equal((await fetch(`${url}&trace=wrong`)).status, 400);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    await assert.rejects(f.ipc(protocol.METHOD, { profileId: "wrong-profile", sessionKey, includeTrace: true }), { code: "MEMORY_STATUS_UNAVAILABLE" });
    await assert.rejects(f.ipc(protocol.METHOD, { profileId, sessionKey: crypto.randomUUID(), includeTrace: true }), { code: "MEMORY_STATUS_UNAVAILABLE" });
    const otherKey = await f.backend.createSession(profile.agentId);
    const otherUrl = url.replace(encodeURIComponent(publicKey), encodeURIComponent(otherKey));
    assert.equal((await (await fetch(otherUrl)).json()).phase, "idle");
    const file = path.join(owner.host(profileId).workspaceDir, "MEMORY.md"), original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `${original}\nChanged source.\n`);
    const stale = await read(true); assert.equal(stale.phase, "stale"); assert.deepEqual(stale.traceLines, []);
    fs.writeFileSync(file, original);
    assert.equal((await read(true)).phase, "stale", "restoring file bytes does not rewind the source revision");
    await recall(); assert.equal((await read(true)).phase, "complete");
    config.plugins.entries["active-memory"].config.thinking = "high";
    assert.equal((await read(true)).phase, "stale");
    delete config.plugins.entries["active-memory"].config.thinking;
    await f.ipc("memory.active.command", { sessionKey, text: "/active-memory off" });
    assert.equal((await read(true)).phase, "disabled");
    await f.ipc("memory.active.command", { sessionKey, text: "/active-memory on" });
    assert.equal((await read(true)).phase, "idle");
    config.plugins.entries["active-memory"].config.agents = [];
    assert.equal((await read()).phase, "disabled", "an enabled plugin alone does not enable this Profile");
    config.memory.search.rememberAcrossConversations = true;
    assert.equal((await read()).phase, "idle", "private conversation recall has its own upstream eligibility");
    assert.equal(runtimeCalls, 0); assert.equal(modelCalls, 4, "status reads never generate model output");
    f.service.runtimeManager.acquire = acquire;
    console.log("PASS memory status REST/IPC: original lines, explicit trace, cached result, source/config invalidation, per-session isolation, command clear, zero Runtime/model reads");
  } finally { await f.close(); }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
