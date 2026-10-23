"use strict";
// Isolated real REST -> registry -> native Backend -> authenticated IPC.
// Runtime transports are fake; this test never reads production memory.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createConfigStore } = require("../app/core/config-store");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
async function run() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-share-rest-")); fs.chmodSync(root, 0o700);
  const store = createConfigStore(path.join(root, "config.json")); store.ensure();
  let f;
  try {
    f = await startInspirationFixture({ agentCount: 3, configStore: store,
      serviceOptions: { memoryCore: true, memorySharingFeatureReady: true, prewarmMcpAuth: false } });
    const request = async (route, body, origin = f.url, method) => {
      const response = await fetch(`${f.url}/__api/${route}`, { method: method || (body === undefined ? "GET" : "PUT"),
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const raw = await response.text();
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      return { status: response.status, data };
    };
    const read = await request("native-memory-sharing-config"); assert.equal(read.status, 200, JSON.stringify(read));
    assert.deepEqual(read.data, { revision: 0, config: { enabled: true, excludedProfiles: [] } });
    assert.deepEqual(f.service.nativeMemorySharingConfig.projection(), read.data);
    let context = await request("native-memory-sharing-config/context"); assert.equal(context.status, 200, JSON.stringify(context));
    assert.equal(context.data.owner, "shoggoth-memory-core"); assert.equal(context.data.featureReady, true); assert.equal(context.data.effectiveEnabled, true);
    const profiles = f.service.productStore.listAgentProfiles().filter(profile => profile.enabled && profile.backendId === "shoggoth");
    assert.deepEqual(context.data.agents.map(agent => agent.profileId), profiles.map(profile => profile.id));
    assert.equal(context.data.agents.every(agent => agent.participating), true); assert.equal(context.data.revision, 0);
    const excluded = profiles[1].id;
    const input = { expectedRevision: 0, config: { enabled: true, excludedProfiles: [excluded] } };
    assert.equal((await request("native-memory-sharing-config", input, null)).status, 403);
    assert.equal((await request("native-memory-sharing-config", input, "https://foreign.invalid")).status, 403);
    assert.equal((await request("native-memory-sharing-config/context", input)).status, 405);
    const updated = await request("native-memory-sharing-config", input);
    assert.equal(updated.status, 200, JSON.stringify(updated)); assert.equal(updated.data.revision, 1);
    context = await request("native-memory-sharing-config/context");
    assert.equal(context.data.agents.find(agent => agent.profileId === excluded).participating, false);
    assert.equal(f.service.nativeMemorySharingConfig.resolve(excluded, profiles).enabled, false);
    assert.equal(f.service.nativeMemorySharingConfig.resolve(profiles[0].id, profiles).participatingProfileIds.includes(excluded), false);
    assert.equal((await request("native-memory-sharing-config", input)).data.code, "NATIVE_MEMORY_SHARING_STALE");
    assert.equal((await request("native-memory-sharing-config", { expectedRevision: 1, config: { enabled: true, excludedProfiles: [], featureReady: true } })).status, 400);
    await request("config", { locale: "en", nativeMemorySharing: { revision: 900, config: { enabled: false, excludedProfiles: [] } } });
    assert.deepEqual(store.read().nativeMemorySharing, updated.data, "generic config cannot bypass dedicated CAS");
    const token = readClientToken(f.paths);
    const ipc = (method, params, auth = token) => requestService(f.paths, { id: crypto.randomUUID(), token: auth, version: PROTOCOL_VERSION, method, params });
    await assert.rejects(ipc("memory.sharing.config.apply", { revision: 2, config: { enabled: false, excludedProfiles: [] } }, "not-a-token"), { code: "AUTH_FAILED" });
    assert.equal(f.service.nativeMemorySharingConfig.read().revision, 1);
    await assert.rejects(ipc("memory.sharing.config.apply", { revision: 0, config: { enabled: true, excludedProfiles: [] } }), { code: "NATIVE_MEMORY_SHARING_STALE" });
    await assert.rejects(ipc("memory.sharing.config.context", { requesterProfileId: excluded }), { code: "NATIVE_MEMORY_SHARING_INVALID" });
    const off = await request("native-memory-sharing-config", { expectedRevision: 1, config: { enabled: false, excludedProfiles: [excluded] } });
    assert.equal(off.status, 200, JSON.stringify(off));
    context = await request("native-memory-sharing-config/context"); assert.equal(context.data.effectiveEnabled, false);
    assert.equal(f.service.nativeMemorySharingConfig.resolve(profiles[0].id, profiles).enabled, false);
    console.log("PASS isolated native memory sharing REST/IPC: defaults, Profile identity, bidirectional exclusions, CAS, gate, origin/auth fencing, generic config bypass prevention, global off");
  } finally { if (f) await f.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
