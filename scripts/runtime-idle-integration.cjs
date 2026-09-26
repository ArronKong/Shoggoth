"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "timed out"); await delay(10); }
}

(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-idle-")));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const saved = path.join(root, "sessions.json");
  fs.writeFileSync(saved, "[]");
  const read = () => JSON.parse(fs.readFileSync(saved, "utf8"));
  const write = (sessions) => fs.writeFileSync(saved, JSON.stringify(sessions));
  let serial = 0; let starts = 0; let resumes = 0; let stops = 0; let modelGate = null;
  const hosts = new Map();
  const pool = {
    async get(_binding, options) {
      const key = options.workspace || "control";
      if (hosts.has(key)) return hosts.get(key);
      starts += 1;
      let finish;
      const host = {
        terminated: new Promise((resolve) => { finish = resolve; }),
        registeredSecrets: [],
        subscribe() { return () => {}; },
        registerServerRequestHandler() { return () => {}; },
        authenticationState() { return { authenticated: true, credentialPresent: true }; },
        async modelsList() {
          if (modelGate) await modelGate;
          return { data: [{ model: "idle-fixture", displayName: "Fixture", description: "", isDefault: true, hidden: false }], nextCursor: null };
        },
        async sessionList() { return { data: read(), nextCursor: null }; },
        async sessionStart(input) {
          const sessions = read();
          const session = { id: `session-${++serial}`, source: input.source, cwd: input.cwd, archived: false, turns: [] };
          sessions.push(session); write(sessions); return { session };
        },
        async sessionResume(input) {
          resumes += 1;
          const session = read().find((s) => s.id === input.sessionId);
          assert.ok(session, "durable session must survive runtime retirement");
          return { session };
        },
        async sessionRead(input) { return { session: read().find((s) => s.id === input.sessionId) }; },
        async turnStart(input) {
          const sessions = read(); const session = sessions.find((s) => s.id === input.sessionId);
          assert.ok(session);
          const turn = { id: `turn-${++serial}`, status: "completed", itemsView: "full", items: [
            { type: "userMessage", clientId: input.operationId },
            { type: "agentMessage", id: `message-${serial}`, text: "idle-resume-ok", phase: "final_answer", delivery: "local" },
          ] };
          session.turns.push(turn); write(sessions); return { turn };
        },
        async turnInterrupt() { return {}; },
        finish() { finish(); },
      };
      hosts.set(key, host); return host;
    },
    async stop() { stops += 1; for (const host of hosts.values()) host.finish(); hosts.clear(); },
    async stopAll() { for (const host of hosts.values()) host.finish(); hosts.clear(); },
  };
  const service = createAgentService({
    paths, version: "idle-integration", builtinCliProfiles: true, runtimeIdleTimeoutMs: 100,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => Buffer.from(v).toString() },
    deepSeekHarnessRuntimePool: pool,
  });
  try {
    await service.start();
    const profile = service.productStore.listAgentProfiles().find((p) => p.runtime === "deepseek-harness");
    assert.ok(profile);
    const binding = { runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId };
    const ipc = (method, params) => requestService(paths, { version: SERVICE_PROTOCOL_VERSION, id: randomUUID(), token: readClientToken(paths), method, params });
    const created = await ipc("chat.session.create", { operationId: "idle-create", profileId: profile.id, workspace: root, createdAt: Date.now() });
    const send = (operationId) => ipc("chat.send", { operationId, sessionKey: created.session.sessionKey, prompt: "Check durable continuation", createdAt: Date.now() });
    let sent = await send("idle-first");
    assert.equal((await service.workRunCoordinator.waitForIdle(sent.run.id)).status, "completed");
    const sessionId = read()[0].id;
    const firstStarts = starts;
    await until(() => stops === 1);
    assert.equal(hosts.size, 0);
    assert.equal(read()[0].turns.length, 1);
    sent = await send("idle-second");
    assert.equal((await service.workRunCoordinator.waitForIdle(sent.run.id)).status, "completed");
    assert.ok(starts > firstStarts); assert.ok(resumes > 0);
    assert.equal(read()[0].id, sessionId); assert.equal(read()[0].turns.length, 2);

    // Exercise the production service's guard, including paused user interaction.
    const listRuns = service.workRunCoordinator.listRuns.bind(service.workRunCoordinator);
    for (const status of ["queued", "starting", "running", "waiting_approval", "waiting_input"]) {
      service.workRunCoordinator.listRuns = () => [{ status, profileId: profile.id }];
      assert.equal(service.runtimeManager.isIdle(binding), false, status);
    }
    service.workRunCoordinator.listRuns = listRuns;
    const admission = { runtimeAccountId: binding.runtimeAccountId, runId: "idle-admission" };
    service.runtimeAccountAdmission.admit(admission);
    assert.equal(service.runtimeManager.isIdle(binding), false);
    service.runtimeAccountAdmission.release(admission);
    const mutation = { runtimeAccountId: binding.runtimeAccountId, operationId: "idle-login" };
    service.runtimeAccountAdmission.beginMutation(mutation);
    assert.equal(service.runtimeManager.isIdle(binding), false);
    service.runtimeAccountAdmission.cancelMutation(mutation);
    service.accountAuthManager.active.set(binding.runtimeAccountId, {});
    assert.equal(service.runtimeManager.isIdle(binding), false);
    service.accountAuthManager.active.delete(binding.runtimeAccountId);

    let releaseModels;
    modelGate = new Promise((resolve) => { releaseModels = resolve; });
    const models = ipc("profile.models.list", { profileId: profile.id, cursor: null, limit: 100 });
    await delay(25);
    const stopsBeforeRead = stops;
    await delay(250);
    assert.equal(stops, stopsBeforeRead, "an in-flight UI model read must retain the runtime");
    releaseModels(); assert.equal((await models).models[0].id, "idle-fixture"); modelGate = null;
    await until(() => stops > stopsBeforeRead);

    modelGate = new Promise((resolve) => { releaseModels = resolve; });
    const disconnected = requestService(paths, { version: SERVICE_PROTOCOL_VERSION, id: randomUUID(), token: readClientToken(paths),
      method: "profile.models.list", params: { profileId: profile.id, cursor: null, limit: 100 } }, { timeoutMs: 30 });
    await assert.rejects(disconnected, (error) => error.code === "REQUEST_TIMEOUT");
    const stopsBeforeDisconnect = stops;
    await delay(250);
    assert.equal(stops, stopsBeforeDisconnect, "client disconnect must not retire a still-running request");
    releaseModels(); modelGate = null;
    await until(() => stops > stopsBeforeDisconnect);

    const job = service.nativeCronStore.createJob({
      operationId: "idle-cron-create", name: "Idle wakeup fixture", enabled: false,
      profileId: profile.id, prompt: "Wake after retirement", workspace: root,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 }, misfirePolicy: "latest",
      maxCatchUp: 1, overlapPolicy: "skip", threadPolicy: "new", threadId: null, nextRunAt: null, createdAt: Date.now(),
    });
    const run = service.nativeCronScheduler.triggerJob({ operationId: "idle-cron-trigger", jobId: job.id, createdAt: Date.now() });
    assert.equal((await service.nativeCronScheduler.waitForIdle(run.id)).status, "completed");
    assert.ok(service.chatSessionStore.getSession(created.session.sessionKey));
    assert.equal(read()[0].turns.length, 2);

    // Use the real scheduler timer, with no manual trigger or chat/UI request
    // after creation. The Service stays open while every runtime has retired.
    await until(() => hosts.size === 0);
    const beforeTimedCron = starts;
    const timed = await ipc("cron.job.create", {
      operationId: randomUUID(), name: "Timer wakeup fixture", enabled: true,
      profileId: profile.id, prompt: "Scheduled wakeup", workspace: root,
      schedule: { kind: "at", at: Date.now() + 250 }, misfirePolicy: "latest",
      maxCatchUp: 1, overlapPolicy: "skip", threadPolicy: "new", threadId: null, createdAt: Date.now(),
    });
    await until(() => service.workRunCoordinator.listRuns().some((r) => r.sourceId === timed.job.id && r.status === "completed"));
    assert.ok(starts > beforeTimedCron, "due Cron must cold-start a retired runtime automatically");

    await until(() => hosts.size === 0);
    const beforeGrowth = starts;
    // Isolate only App-host readiness. Growth, durable queue, work admission,
    // runtime retirement and session restoration use the production Service.
    service.inspirationService.readinessClient = { async request(method) {
      assert.equal(method, "inspiration.executor.ready"); return { ready: true };
    } };
    await ipc("inspiration.growth.set", { expectedRevision: 1, enabled: true,
      executors: [{ backendId: profile.backendId, agentId: profile.agentId }] });
    const seed = await ipc("inspiration.create", { operationId: randomUUID(), body: "Idle automatic growth fixture" });
    await until(() => service.inspirationStore.latestExecution(seed.idea.id)?.runId);
    const firstGrowth = service.inspirationStore.latestExecution(seed.idea.id);
    await until(() => service.workRunCoordinator.getRun(firstGrowth.runId)?.status === "completed");
    assert.ok(starts > beforeGrowth, "saving a seed must wake a retired runtime through auto growth");
    const growthSession = service.inspirationStore.latestExecution(seed.idea.id).sessionKey;
    assert.ok(growthSession);

    await until(() => hosts.size === 0);
    const beforeContinuation = starts;
    const beforeResumes = resumes;
    const continued = await ipc("inspiration.start", { id: seed.idea.id, operationId: randomUUID(),
      expectedRevision: service.inspirationStore.get(seed.idea.id).revision,
      backendId: profile.backendId, agentId: profile.agentId, instruction: "Continue after retirement", workspace: null });
    await until(() => service.workRunCoordinator.getRun(continued.idea.latestExecution.runId)?.status === "completed");
    assert.ok(starts > beforeContinuation && resumes > beforeResumes);
    assert.equal(service.inspirationStore.latestExecution(seed.idea.id).sessionKey, growthSession);
    console.log("PASS idle retirement -> same chat resumes; UI reads, work/approval/input/login protected; timed Cron and auto Inspiration wake fresh hosts; Inspiration continues the same session after another retirement");
  } finally {
    await service.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
