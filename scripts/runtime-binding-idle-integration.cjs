"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { trackPoolHost } = require("../app/agent-service/runtime-pool-capacity");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "idle window did not retire the unrelated host");
    await delay(10);
  }
}

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-bi-")));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const stops = [], hosts = [];
  let modelGate = null;
  const pool = {
    entries: new Map(), stoppingProfiles: new Set(), blockedProfiles: new Set(),
    async get(binding, options = {}) {
      const key = options.executionContract?.runId
        ? `${binding.runtimeProfileId}:${options.executionContract.runId}` : binding.runtimeProfileId;
      if (this.entries.has(key)) return this.entries.get(key).host;
      const terminated = deferred();
      const host = {
        terminated: terminated.promise, finish: terminated.resolve, idle: true,
        workspace: options.workspace, controlInstance: !Object.hasOwn(options, "workspace"),
        mcpExecutionRunId: options.executionContract?.runId ?? null,
        subscribe() { return () => {}; }, registerServerRequestHandler() { return () => {}; },
        canRetireIdle() { return this.idle; },
        authenticationState() { return { authenticated: true, credentialPresent: true }; },
        async modelsList() {
          if (modelGate) await modelGate.promise;
          return { data: [{ model: "fixture", displayName: "Fixture", description: "", isDefault: true, hidden: false }], nextCursor: null };
        },
        sessionStart() {}, sessionResume() {}, sessionRead() {}, sessionList() {},
        sessionRename() {}, sessionArchive() {}, sessionUnarchive() {}, sessionDelete() {},
        turnStart() {}, turnSteer() {}, turnInterrupt() {}, commandsList() {}, commandExecute() {},
      };
      const entry = { key, host, runtimeProfileId: binding.runtimeProfileId, runtimeAccountId: binding.runtimeAccountId };
      trackPoolHost(entry, binding);
      entry.capacity.ready = true;
      this.entries.set(key, entry);
      hosts.push(host);
      return host;
    },
    async stop(id) {
      stops.push(id);
      for (const [key, entry] of this.entries) {
        if (entry.runtimeProfileId !== id) continue;
        this.entries.delete(key);
        entry.host.finish();
      }
    },
    async stopAll() {
      for (const entry of this.entries.values()) entry.host.finish();
      this.entries.clear();
    },
  };
  const service = createAgentService({
    paths, version: "binding-idle-test", builtinCliProfiles: true,
    builtinCliInstalledAccountIds: ["native-antigravity-default-v1"],
    runtimeIdleTimeoutMs: 50, antigravityRuntimePool: pool,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v),
      decryptString: v => Buffer.from(v).toString() },
  });
  t.after(async () => { modelGate?.resolve(); await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const profile = service.productStore.listAgentProfiles().find(p => p.runtime === "antigravity");
  const binding = { runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId };
  const added = service.productStore.addAgentRuntimeBinding(profile.id, {
    runtime: "antigravity", runtimeAccountId: binding.runtimeAccountId,
  }, { operationId: "second-antigravity" }).binding;
  const other = { runtime: added.runtime, runtimeProfileId: added.runtimeProfileId, runtimeAccountId: added.runtimeAccountId };
  const coordinator = service.workRunCoordinator;
  let runs = [];
  coordinator.listRuns = () => runs;
  const getRun = coordinator.getRun.bind(coordinator);
  coordinator.getRun = id => runs.find(run => run.id === id) || getRun(id);
  const ipc = (method, params, options) => requestService(paths, {
    version: SERVICE_PROTOCOL_VERSION, id: randomUUID(), token: readClientToken(paths), method, params,
  }, options);
  return { service, pool, stops, hosts, profile, binding, other, coordinator, ipc,
    setRuns(value) { runs = value; },
    setModelGate(value) { modelGate = value; },
    run(contractBinding, status = "running", id = "fixture-run") {
      const run = { id, profileId: profile.id, status };
      runs = [run];
      coordinator.runExecutionContracts.set(id, Object.freeze({
        ...contractBinding, runId: id, profileId: profile.id,
      }));
      return run;
    },
    admit(run, contractBinding) {
      const admitted = service.runtimeAccountAdmission.admit({
        runtimeAccountId: contractBinding.runtimeAccountId, runId: run.id,
      });
      coordinator.runAccountAdmissions.set(run.id, {
        runtimeAccountId: contractBinding.runtimeAccountId, generation: admitted.generation,
      });
    },
  };
}

test("an Agent's Codex run does not keep its idle Antigravity binding alive", async t => {
  const f = await fixture(t);
  f.run({ runtime: "codex", runtimeProfileId: "codex-other", runtimeAccountId: "native-codex-default-v1" });
  await f.service.runtimeManager.acquire(f.binding);
  assert.equal(f.service.runtimeManager.isIdle(f.binding), true);
  await until(() => f.stops.includes(f.binding.runtimeProfileId));
  assert.equal(f.coordinator.listRuns()[0].status, "running");
});

test("an admitted sibling binding on the same account does not prevent retirement", async t => {
  const f = await fixture(t);
  const run = f.run(f.other);
  f.admit(run, f.other);
  await f.service.runtimeManager.acquire(f.binding);
  await f.service.runtimeManager.acquire(f.other);
  assert.equal(f.service.runtimeManager.isIdle(f.binding), true);
  await until(() => f.stops.includes(f.binding.runtimeProfileId));
  assert.equal(f.stops.includes(f.other.runtimeProfileId), false);
  assert.equal(f.service.runtimeAccountAdmission.read(f.binding.runtimeAccountId).active, 1);
});

test("a slow, disconnected catalog request retains only the binding it acquired", async t => {
  const f = await fixture(t);
  await f.service.runtimeManager.acquire(f.other);
  const gate = deferred();
  f.setModelGate(gate);
  const request = f.ipc("profile.models.list", { profileId: f.profile.id, cursor: null, limit: 100 }, { timeoutMs: 150 });
  const timedOut = assert.rejects(request, error => error.code === "REQUEST_TIMEOUT");
  await until(() => f.pool.entries.get(f.binding.runtimeProfileId)?.capacity.pending > 0);
  await until(() => f.stops.includes(f.other.runtimeProfileId));
  await timedOut;
  await delay(100);
  assert.equal(f.stops.includes(f.binding.runtimeProfileId), false);
  const capacityGuard = f.service.grokBuildRuntimePool.canRetireHost;
  assert.equal(capacityGuard(f.other, { mcpExecutionRunId: "retired-run" }), true,
    "an unrelated Service request must not block proven-idle capacity retirement");
  assert.equal(capacityGuard(f.binding, { mcpExecutionRunId: "retired-run" }), false,
    "the acquired binding remains leased after its caller disconnects");
  gate.resolve();
  await until(() => f.stops.includes(f.binding.runtimeProfileId));
});

test("terminal execution hosts retire while another binding continues running", async t => {
  const f = await fixture(t);
  const run = f.run(f.binding);
  f.admit(run, f.binding);
  await f.service.runtimeManager.acquire(f.binding, { workspace: "/fixture",
    executionContract: { ...f.binding, runId: run.id } });
  assert.equal(f.hosts[0].mcpExecutionRunId, run.id);
  await delay(120);
  assert.equal(f.stops.length, 0);
  f.service.runtimeAccountAdmission.release({ runtimeAccountId: f.binding.runtimeAccountId, runId: run.id });
  f.coordinator.runAccountAdmissions.delete(run.id);
  f.coordinator.runExecutionContracts.delete(run.id);
  const next = f.run(f.other, "running", "other-run");
  f.admit(next, f.other);
  f.setRuns([{ ...run, status: "completed" }, next]);
  await until(() => f.stops.includes(f.binding.runtimeProfileId));
  assert.equal(f.coordinator.listRuns()[1].status, "running");
});

test("own work, queued binding uncertainty, broken activity, login and host I/O retain hosts", async t => {
  const f = await fixture(t);
  await f.service.runtimeManager.acquire(f.binding);
  const idle = () => f.service.runtimeManager.isIdle(f.binding);
  for (const status of ["queued", "starting", "running", "waiting_approval", "waiting_input"]) {
    f.run(f.binding, status);
    assert.equal(idle(), false, status);
    f.run(f.other, status);
    assert.equal(idle(), true, `unrelated frozen ${status}`);
  }
  f.coordinator.runExecutionContracts.clear();
  const otherProfile = f.service.productStore.listAgentProfiles().find(profile => profile.id !== f.profile.id);
  assert.ok(otherProfile);
  f.setRuns([{ id: "queued", profileId: otherProfile.id, status: "queued" }]);
  assert.equal(idle(), true, "unfrozen queue of an unrelated Agent");
  f.setRuns([{ id: "queued", profileId: f.profile.id, status: "queued" }]);
  assert.equal(idle(), false, "unfrozen queue conservatively reserves all candidate bindings");
  f.setRuns([{ id: "unknown", profileId: "missing-agent", status: "queued" }]);
  assert.equal(idle(), false, "missing queued ownership");
  f.setRuns([{ id: "unknown", profileId: f.profile.id, status: "running" }]);
  assert.equal(idle(), false, "active run without a frozen contract");
  f.run({ ...f.other, runtimeProfileId: null });
  assert.equal(idle(), false, "broken frozen binding");
  f.run(f.other);
  const contract = f.coordinator.runExecutionContracts.get("fixture-run");
  f.coordinator.runExecutionContracts.set("fixture-run", { ...contract, runId: "wrong-run" });
  assert.equal(idle(), false, "mismatched frozen owner");
  f.coordinator.runExecutionContracts.set("fixture-run", contract);
  f.coordinator.poisonError = new Error("activity unavailable");
  assert.equal(idle(), false, "poisoned coordinator");
  f.coordinator.poisonError = null;
  f.setRuns([]);
  f.coordinator.runExecutionContracts.clear();
  const admission = { runtimeAccountId: f.binding.runtimeAccountId, runId: "unowned-admission" };
  f.service.runtimeAccountAdmission.admit(admission);
  assert.equal(idle(), false, "unaccounted admission");
  f.service.runtimeAccountAdmission.release(admission);
  const mutation = { runtimeAccountId: f.binding.runtimeAccountId, operationId: "mutation" };
  f.service.runtimeAccountAdmission.beginMutation(mutation);
  assert.equal(idle(), false, "account mutation");
  f.service.runtimeAccountAdmission.cancelMutation(mutation);
  f.service.accountAuthManager.active.set(f.binding.runtimeAccountId, {});
  assert.equal(idle(), false, "login");
  f.service.accountAuthManager.active.delete(f.binding.runtimeAccountId);
  f.hosts[0].idle = false;
  assert.equal(idle(), false, "host-local pending work");
  await delay(120);
  assert.equal(f.stops.length, 0);
  f.hosts[0].idle = true;
  await until(() => f.stops.includes(f.binding.runtimeProfileId));
});
