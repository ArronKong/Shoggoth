"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { test } = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const { authenticateMcpSession } = require("../app/shoggoth-mcp-helper");
const { NATIVE_BACKEND_ID } = require("../app/agent-service/native-backend-identity");
const { isRuntimeAvailable } = require("../app/runtime-availability");

test("Inspiration resolves native Agent identity through REST and authenticated Service IPC", async t => {
  const f = await openHandoffFixture({ builtinCliProfiles: true });
  const backend = new ShoggothBackend({ paths: f.paths, pollIntervalMs: 15,
    readinessIntervalMs: 10, readinessTimeoutMs: 5000 });
  const registry = new BackendRegistry();
  registry.register(backend);
  registry.setInspirationOwner(backend);
  let server;
  let mcpSession;
  t.after(async () => { mcpSession?.close?.(); await server?.close(); await backend.stop(); await f.close(); });
  mcpSession = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: f.profile.runtimeProfileId,
    runtimeAccountId: f.profile.runtimeAccountId,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => Buffer.from(value).toString() } });
  assert.equal((await registry.start()).get(backend.id), true);
  server = await startStaticServer(0, { registry, homeDir: f.root, userDataRoot: path.join(f.root, "ui") });
  const ipc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(),
    token: readClientToken(f.paths), version: PROTOCOL_VERSION, method, params });
  const request = async (route, body) => {
    const response = await fetch(`${server.url}/__api/inspirations${route}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const running = async execution => {
    await waitUntil(() => {
      const run = f.service.workRunCoordinator.getRun(execution.runId);
      return run && !["queued", "starting"].includes(run.status);
    }, 5000, "native Inspiration admission");
    await f.service.workRunCoordinator.waitForIdle(execution.runId);
    const run = f.service.workRunCoordinator.getRun(execution.runId);
    assert.equal(run.status, "running", f.service.workRunCoordinator.lastErrors.get(run.id)?.stack || run.errorCode);
    return run;
  };
  const { agents } = await request("/agents");

  for (const profile of f.service.productStore.listAgentProfiles().filter(value => isRuntimeAvailable(value.runtime))) {
    const createdVia = profile.agentId;
    await t.test(`${createdVia}: drop, Session continuation and replay`, async () => {
      assert.ok(profile, `missing ${createdVia} fixture Profile`);
      const agent = agents.find(value => value.id === profile.agentId);
      assert.equal(agent?.backendId, NATIVE_BACKEND_ID);
      assert.equal(agent.capabilities.execute, true);
      const { idea } = await request("", { operationId: crypto.randomUUID(), body: `Identity regression: ${createdVia}` });
      const input = { expectedRevision: idea.revision, operationId: crypto.randomUUID(),
        backendId: agent.backendId, agentId: agent.id, instruction: "", workspace: f.workspace };
      const first = (await request(`/start?id=${idea.id}`, input)).idea.latestExecution;
      assert.equal(first.profileId, profile.id);
      assert.equal(first.backendId, NATIVE_BACKEND_ID);
      const run = await running(first);
      assert.equal(run.runtimeSessionRef.runtime, profile.runtime);
      assert.equal(f.service.productStore.getAgentProfile(profile.id).backendId, NATIVE_BACKEND_ID);
      const host = f.transport.hosts.get(profile.runtime);
      const starts = host.turnStartCalls;
      assert.equal((await request(`/start?id=${idea.id}`, input)).idea.latestExecution.runId, run.id);
      assert.equal(host.turnStartCalls, starts);
      await f.complete(run);

      const current = (await request(`/detail?id=${idea.id}`)).idea;
      const nextInput = { ...input, expectedRevision: current.revision,
        operationId: crypto.randomUUID(), backendId: NATIVE_BACKEND_ID };
      const next = (await request(`/start?id=${idea.id}`, nextInput)).idea.latestExecution;
      assert.equal(next.sessionKey, first.sessionKey);
      assert.equal(next.backendId, NATIVE_BACKEND_ID);
      await f.complete(await running(next));
      const chat = await ipc("chat.send", { sessionKey: first.sessionKey,
        operationId: crypto.randomUUID(), prompt: "Continue this idea", createdAt: Date.now() });
      const continuation = await running({ runId: chat.run.id });
      assert.equal(continuation.profileId, profile.id);
      assert.equal(f.service.inspirationStore.executionForRun(chat.run.id).sessionKey, first.sessionKey);
      await f.complete(continuation);

      const growth = await ipc("inspiration.growth.get", {});
      const configured = await ipc("inspiration.growth.set", { expectedRevision: growth.settings.revision,
        enabled: true, executors: [{ backendId: NATIVE_BACKEND_ID, agentId: profile.agentId }] });
      await ipc("inspiration.growth.set", { expectedRevision: configured.settings.revision,
        enabled: false, executors: configured.settings.executors });
    });
  }

  await t.test("unknown, disabled and mismatched Agents cannot create an execution", async () => {
    const { idea } = await request("", { operationId: crypto.randomUUID(), body: "Rejected identity" });
    const profile = f.service.productStore.putAgentProfile({ ...f.profile,
      id: "disabled-inspiration", agentId: "shoggoth-agent-disabled-inspiration",
      runtimeProfileId: "disabled-inspiration", isDefault: false, enabled: false });
    const input = { id: idea.id, expectedRevision: idea.revision, operationId: crypto.randomUUID(),
      backendId: NATIVE_BACKEND_ID, agentId: profile.agentId, instruction: "", workspace: f.workspace };
    await assert.rejects(ipc("inspiration.start", input), { code: "INSPIRATION_UNSUPPORTED" });
    await assert.rejects(ipc("inspiration.start", { ...input, agentId: "missing-agent" }), { code: "INSPIRATION_UNSUPPORTED" });
    await assert.rejects(ipc("inspiration.start", { ...input, agentId: f.profile.agentId, backendId: "unknown" }),
      { code: "INSPIRATION_UNSUPPORTED" });
    assert.throws(() => f.service.inspirationService.start({ ...input,
      profileId: f.profile.id }), { code: "INSPIRATION_UNSUPPORTED" });
    assert.equal(f.service.inspirationStore.executions(idea.id).length, 0);
    assert.equal(f.service.productStore.listWorkRuns().some(run => run.sourceId === idea.id), false);
  });
});
