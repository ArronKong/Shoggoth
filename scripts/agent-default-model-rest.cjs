"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { DEFAULT_RUNTIME_ACCOUNTS, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");

async function run() {
  const f = await openHandoffFixture({ builtinCliProfiles: true,
    catalogs: { codex: ["fixture-model", "codex-only"], pi: ["fixture-model", "pi-only"] } });
  let server;
  try {
    const { productStore: store, chatSessionStore: sessions, workRunCoordinator: coordinator } = f.service;
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeMultiBinding: true } });
    const profileId = f.profile.id, agentId = f.profile.agentId;
    const endpoint = store.putModelProvider({ id: "fixture-custom-responses", kind: "custom-responses",
      name: "Fixture Endpoint", baseUrl: "https://example.invalid/v1", model: "fixture-model",
      models: ["fixture-model", "endpoint-only"], credentialRef: null, headers: null, awsRegion: null, awsProfile: null,
      validationStatus: "protocol_valid" });
    const cli = DEFAULT_RUNTIME_ACCOUNTS.filter(account => account.runtime === "pi" && account.kind === "native-user").map(account => ({
      runtime: account.runtime, name: account.runtime, runtimeAccountId: account.id,
      binaryPath: path.join(f.root, "fixture-cli"), accountHome: f.root, processHome: f.root,
      homeEnv: null, accountKind: account.kind, credentialFile: "auth.json", loginArgs: [], logoutArgs: [], docsUrl: "https://example.invalid/",
    }));
    const backend = new ShoggothBackend({ paths: f.paths, runtimeCliAuth: cli });
    let disabled = [];
    backend._state = "started";
    await backend._refreshManagedProfiles();
    const registry = new BackendRegistry(); registry.register(backend); registry.setDisabledBackendsProvider(() => disabled);
    server = await startStaticServer(0, { registry, homeDir: f.root, userDataRoot: path.join(f.root, "ui") });
    const route = `/__api/agents/${agentId}/default-model?backend=shoggoth`;
    const request = async (body, origin = server.url) => {
      const response = await fetch(server.url + route, { method: body ? "PUT" : "GET", headers: {
        "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const existing = f.createSession();
    sessions.setModelOverride(existing.sessionKey, "codex-only");
    const existingState = sessions.getSession(existing.sessionKey);
    const existingRun = await f.send(existing.sessionKey, "active-before-default-switch");
    assert.equal(existingRun.status, "running", existingRun.errorCode);

    const initial = await request();
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const harness = f.binding("codex"), pi = f.binding("pi");
    assert.deepEqual(initial.body.selection, { bindingId: harness.id, model: "fixture-model",
      modelProviderRef: "@chatgpt", revision: store.getAgentRuntimeBindings(profileId).revision });
    assert.deepEqual(initial.body.models.filter(model => model.bindingId === harness.id && model.id === "fixture-model")
      .map(model => model.modelProviderRef).sort(), ["@chatgpt", endpoint.id]);

    const selection = { bindingId: pi.id, model: "pi-only", revision: initial.body.selection.revision };
    assert.equal((await request(selection, null)).status, 403);
    assert.equal((await request({ ...selection, profileId: "foreign" })).status, 400);
    assert.equal((await request({ ...selection, model: "codex-only" })).body.code, "PROFILE_MODEL_NOT_AVAILABLE");
    const otherBinding = store.listAgentProfiles().find(profile => profile.agentId === "shoggoth-pi").defaultBindingId;
    assert.equal((await request({ ...selection, bindingId: otherBinding })).status, 404);
    disabled = ["pi"];
    assert.equal((await request(selection)).body.code, "NATIVE_RUNTIME_DISABLED");
    assert.deepEqual((await request()).body.selection, initial.body.selection, "rejected selections never partially change the default");
    disabled = [];
    const switched = await request(selection);
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.deepEqual(switched.body, { ...selection, revision: selection.revision + 1 });
    assert.deepEqual((await request()).body.selection, switched.body);
    assert.equal((await backend.getAgent(agentId)).model, "pi-only");
    assert.equal((await backend.getInspirationModels(agentId)).defaultModel, "pi-only");
    const memory = coordinator.resolveMemoryTextRoute({ profileId });
    assert.equal(memory.profile.runtime, "pi");
    assert.equal(memory.model, "pi-only");
    assert.equal(sessions.getSession(existing.sessionKey).runtimeBindingId, existingState.runtimeBindingId);
    assert.equal(sessions.getSession(existing.sessionKey).modelOverride, existingState.modelOverride);
    assert.equal(coordinator.getRun(existingRun.id).status, "running");
    await f.complete(existingRun);
    const fresh = f.createSession();
    assert.equal(fresh.runtimeBindingId, pi.id);
    assert.equal(fresh.modelOverride, null);
    const run = await f.send(fresh.sessionKey, "new-chat-inherits-default-pair");
    assert.equal(run.status, "running", run.errorCode);
    assert.equal(run.runtimeSessionRef.runtime, "pi");
    assert.equal(f.transport.hosts.get("pi").lastTurnStartParams.model, "pi-only");
    await f.complete(run);

    const ipc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(),
      token: readClientToken(f.paths), version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 10_000 });
    const now = Date.now();
    const { job } = await ipc("cron.job.create", { operationId: crypto.randomUUID(), name: "Default model fixture",
      enabled: false, profileId, prompt: "Fixture only", workspace: f.workspace, schedule: { kind: "at", at: now + 600_000 },
      misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip", threadPolicy: "continue", threadId: null, createdAt: now });
    const { run: cron } = await ipc("cron.run.trigger", { operationId: crypto.randomUUID(), jobId: job.id, createdAt: Date.now() });
    await waitUntil(() => ["running", "failed", "interrupted"].includes(coordinator.getRun(cron.id)?.status), 5000, "Cron inherited route");
    const cronRun = coordinator.getRun(cron.id);
    assert.equal(cronRun.status, "running", cronRun.errorCode);
    assert.equal(cronRun.runtimeSessionRef.runtime, "pi");
    assert.equal(f.transport.hosts.get("pi").lastTurnStartParams.model, "pi-only");
    await f.complete(cronRun);

    const custom = { bindingId: harness.id, model: "fixture-model", modelProviderRef: endpoint.id, revision: switched.body.revision };
    assert.equal((await request({ ...custom, revision: selection.revision })).body.code, "AGENT_BINDING_REVISION_CONFLICT");
    const harnessSelected = await request(custom);
    assert.equal(harnessSelected.status, 200, JSON.stringify(harnessSelected.body));
    assert.deepEqual((await request()).body.selection, harnessSelected.body);
    assert.equal(store.resolveAgentRuntimeProfile(profileId).runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    assert.equal(store.resolveAgentRuntimeProfile(profileId).providerRef, endpoint.id, "same model id selects its exact source");
    assert.equal(store.resolveAgentRuntimeProfile(profileId, pi.id).defaultModel, "pi-only");
    const chatgpt = await request({ ...custom, modelProviderRef: "@chatgpt", revision: harnessSelected.body.revision });
    assert.equal(chatgpt.status, 200, JSON.stringify(chatgpt.body));
    assert.equal(store.resolveAgentRuntimeProfile(profileId).providerRef, null);
    console.log("PASS Agent default model REST: exact source, Runtime/model CAS, chat/Cron/memory inheritance, existing turn and override preserved.");
  } finally { if (server) await server.close(); await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
