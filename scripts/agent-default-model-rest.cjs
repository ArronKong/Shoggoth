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
  let clockOffset = 0;
  const f = await openHandoffFixture({ builtinCliProfiles: true,
    catalogs: { codex: ["fixture-model", "codex-only"], pi: ["fixture-model", "pi-only"] },
    serviceOptions: { now: () => Date.now() + clockOffset } });
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
    const nativePi = store.listAgentProfiles().find(profile => profile.agentId === "shoggoth-pi");
    const nativeBindings = await backend.getAgentRuntimeBindings(nativePi.agentId);
    assert.ok(nativeBindings.bindings.length > 1);
    assert.equal(store.resolveAgentRuntimeProfile(nativePi.id).defaultModel, null);
    const startAcquisitions = f.transport.acquisitions.length;
    const overview = await fetch(`${server.url}/__api/agents/${nativePi.agentId}/default-model?backend=shoggoth&scope=default`);
    assert.equal(overview.status, 200);
    const inherited = await overview.json();
    assert.deepEqual(inherited.selection, { bindingId: nativeBindings.defaultBindingId,
      revision: nativeBindings.revision, model: "fixture-model" });
    assert.deepEqual(inherited.runtimes.map(runtime => runtime.bindingId), [nativeBindings.defaultBindingId]);
    assert.deepEqual(new Set(f.transport.acquisitions.slice(startAcquisitions).map(({ binding }) => binding.runtime)), new Set(["pi"]));
    assert.equal(store.resolveAgentRuntimeProfile(nativePi.id).defaultModel, null, "reading the inherited default does not pin it");
    assert.equal(store.getAgentRuntimeBindings(nativePi.id).revision, nativeBindings.revision);

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

    const cronModelsResponse = await fetch(`${server.url}/__api/cron/models?${new URLSearchParams({ backendId: "shoggoth", agentId })}`);
    assert.equal(cronModelsResponse.status, 200);
    const cronModels = await cronModelsResponse.json();
    assert.deepEqual(cronModels.defaultSelection, { bindingId: harness.id, model: "fixture-model", modelProviderRef: "@chatgpt" });
    assert.deepEqual(cronModels.models.filter(row => row.bindingId === harness.id && row.id === "fixture-model")
      .map(row => row.modelProviderRef).sort(), ["@chatgpt", endpoint.id], "Cron choices pin the source of duplicate model IDs");
    const piModel = { bindingId: pi.id, model: "pi-only" };
    assert.ok(cronModels.models.some(row => row.bindingId === pi.id && row.id === piModel.model));
    const createTask = { backendId: "shoggoth", agentId, name: "Cron model fixture", enabled: false,
      prompt: "Fixture only", schedule: { kind: "every", everyMs: 60_000 }, workspace: f.workspace };
    const cronRequest = async (method, body, id = "") => {
      const response = await fetch(`${server.url}/__api/cron/jobs${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const invalid = await cronRequest("POST", { ...createTask, modelSelection: { ...piModel, model: "missing-model" } });
    assert.equal(invalid.status, 409, JSON.stringify(invalid.body));
    assert.equal(invalid.body.code, "CRON_MODEL_UNAVAILABLE");
    assert.ok(!f.service.nativeCronStore.listJobs().some(row => row.name === createTask.name));
    const saved = await cronRequest("POST", { ...createTask, modelSelection: piModel });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const task = saved.body.job;
    assert.deepEqual(task.modelSelection, piModel);
    assert.equal(task.model, "pi-only");
    const read = await fetch(`${server.url}/__api/cron/jobs?id=${encodeURIComponent(task.id)}&action=detail`);
    assert.deepEqual((await read.json()).job.modelSelection, piModel);
    const waitForTaskTurn = async (runId) => {
      await waitUntil(() => {
        const current = coordinator.getRun(runId);
        return current?.runtimeTurnRef || ["failed", "interrupted"].includes(current?.status);
      }, 5000, "Cron task model");
      const current = coordinator.getRun(runId);
      assert.equal(current.status, "running", current.errorCode);
      return current;
    };
    const triggerTask = async (jobId) => {
      const { run } = await ipc("cron.run.trigger", { operationId: crypto.randomUUID(), jobId, createdAt: Date.now() });
      return waitForTaskTurn(run.id);
    };
    const jobId = task.id.split(":")[1];
    const first = await triggerTask(jobId);
    assert.equal(first.runtimeSessionRef.runtime, "pi");
    assert.equal(f.transport.hosts.get("pi").lastTurnStartParams.model, "pi-only");
    const cronSession = coordinator.getRunSessionKey(first);
    const busy = await cronRequest("PUT", { modelSelection: null }, task.id);
    assert.equal(busy.body.code, "CRON_MODEL_UPDATE_BUSY");
    assert.deepEqual(f.service.nativeCronStore.getJob(jobId).modelSelection, piModel);
    await f.complete(first);
    await f.service.nativeCronScheduler.waitForIdle(first.id);

    const endpointModel = { bindingId: harness.id, model: "fixture-model", modelProviderRef: endpoint.id };
    const edited = await cronRequest("PUT", { modelSelection: endpointModel }, task.id);
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const second = await triggerTask(jobId);
    assert.equal(second.runtimeSessionRef.runtime, "codex");
    assert.equal(coordinator.getRunSessionKey(second), cronSession);
    assert.equal(coordinator.runExecutionContracts.get(second.id).provider.providerRef, endpoint.id);
    const endpointHost = [...f.transport.handles.values()].find(handle =>
      handle.host.threads.some(thread => thread.id === second.runtimeSessionRef.sessionId)).host;
    assert.equal(endpointHost.lastTurnStartParams.model, "fixture-model");
    await f.complete(second);
    await f.service.nativeCronScheduler.waitForIdle(second.id);

    const cleared = await cronRequest("PUT", { modelSelection: null }, task.id);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.job.modelSelection, null);
    const inheritedTaskRun = await triggerTask(jobId);
    assert.equal(coordinator.getRunSessionKey(inheritedTaskRun), cronSession);
    assert.notEqual(inheritedTaskRun.runtimeSessionRef.sessionId, second.runtimeSessionRef.sessionId);
    assert.equal(coordinator.runExecutionContracts.get(inheritedTaskRun.id).provider.providerRef, null);
    assert.equal(store.resolveAgentRuntimeProfile(profileId).providerRef, null);
    await f.complete(inheritedTaskRun);
    await f.service.nativeCronScheduler.waitForIdle(inheritedTaskRun.id);

    const assistantChat = f.createSession();
    const assistantRun = await f.send(assistantChat.sessionKey, "scope-cron-model-tool", "Create a test task with the named model.");
    assert.equal(assistantRun.status, "running", assistantRun.errorCode);
    const { runtimeAccountId, runtimeProfileId } = assistantRun.runtimeSessionRef;
    const call = (tool, args, callId = crypto.randomUUID()) => coordinator.invokeRuntimeCapability({
      runId: assistantRun.id, runtimeAccountId, runtimeProfileId, kind: "mcp",
    }, scope => f.service.mcpProductToolController.handle(tool, args, { profileId, callId }, scope));
    const available = await call("cron_models", {});
    assert.equal(available.bindingId, harness.id, JSON.stringify(available));
    assert.ok(available.bindings.some(binding => binding.bindingId === pi.id));
    const selected = available.models.find(row => row.modelSelection.modelProviderRef === endpoint.id
      && row.modelSelection.model === "fixture-model");
    assert.deepEqual(selected.modelSelection, endpointModel);
    const createFromChat = { name: "Chat Cron model fixture", prompt: "Fixture only",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() }, modelSelection: selected.modelSelection };
    const callId = crypto.randomUUID();
    const chatJob = (await call("cron_create", createFromChat, callId)).job;
    assert.deepEqual((await call("cron_create", createFromChat, callId)).job, chatJob);
    assert.deepEqual(chatJob.modelSelection, endpointModel);
    await f.complete(assistantRun);
    const { nativeCronScheduler: scheduler, nativeCronStore: cronStore, workDispatcher } = f.service;
    await scheduler.close();
    cronStore.close();
    cronStore.open();
    await scheduler.open();
    assert.deepEqual(cronStore.getJob(chatJob.id).modelSelection, endpointModel);
    clockOffset = 60_000;
    await scheduler.tick();
    const [scheduled] = workDispatcher.listRuns({ source: "cron", sourceId: chatJob.id });
    const chatRun = await waitForTaskTurn(scheduled.id);
    assert.equal(coordinator.runExecutionContracts.get(chatRun.id).provider.providerRef, endpoint.id);
    assert.equal(sessions.getSession(assistantChat.sessionKey).modelOverride, null);
    await f.complete(chatRun);
    console.log("PASS Agent and Cron model REST/MCP: scoped catalogs, exact source, busy edits, default inheritance, manual and scheduled dispatch after reload.");
  } finally { if (server) await server.close(); await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
