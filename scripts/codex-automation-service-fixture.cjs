"use strict";
// Production private Service -> Backend -> HTTP, with a fake native model host
// and an isolated Codex Home. No user tasks, credentials or scheduler are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { OWNER, ACCOUNT_ID } = require("../app/agent-service/codex-automation-store");
const { AutomationHost, mockHome, waitUntil } = require("./helpers/codex-automation-harness.cjs");
async function run() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-auto-api-")));
  const home = mockHome(root), host = new AutomationHost(), key = crypto.randomBytes(32);
  const cryptoBroker = { async open() {}, async close() {}, async encrypt(input) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, Buffer.concat([cipher.update(input), cipher.final()]), cipher.getAuthTag()]); },
    async decrypt(input) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(0, 12));
      cipher.setAuthTag(input.subarray(-16)); return Buffer.concat([cipher.update(input.subarray(12, -16)), cipher.final()]); } };
  const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: root, cacheRoot: path.join(root, "cache") });
  const pool = { runtimeAccountResolver: { resolve: () => ({ home, nativeHome: home }) }, get: async () => host, stopAll: async () => {} };
  const service = createAgentService({ paths, cryptoBroker, runtimePool: pool, builtinCliProfiles: true,
    builtinCliInstalledAccountIds: [ACCOUNT_ID], autoSparkNotes: false, parentEnv: { HOME: root, CODEX_HOME: home, PATH: "/usr/bin:/bin" },
    runtimeStorageHomedir: root, version: "codex-automation-api-fixture" });
  let backend, http;
  try {
    await service.start();
    service.productStore.putAgentProfile({ ...service.productStore.getAgentProfile(OWNER.id), name: "Renamed native Codex",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" } });
    const ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
    await ipc("agent.create", { operationId: "create-clone-fixture", backendId: "shoggoth", name: "Codex clone", defaultCwd: null, createdAt: Date.now() });
    backend = new ShoggothBackend({ paths, pollIntervalMs: 50, readinessIntervalMs: 10, readinessTimeoutMs: 5000 });
    const registry = new BackendRegistry(); registry.register(backend);
    assert.equal((await registry.start()).get(backend.id), true);
    http = await startStaticServer(0, { registry, homeDir: root, userDataRoot: root });
    async function api(query, method = "GET", body, origin = true) {
      const response = await fetch(new URL(query, http.url), { method, ...(body ? { headers: { "Content-Type": "application/json",
        ...(origin ? { Origin: http.url } : {}) }, body: JSON.stringify(body) } : {}) });
      const data = await response.json(); return { status: response.status, data };
    }
    const source = await api("/__api/cron/codex?backend=shoggoth");
    assert.equal(source.status, 200); assert.equal(source.data.canCreate, true);
    const models = await api("/__api/cron/codex/models?backend=shoggoth");
    assert.equal(models.status, 200); assert.equal(models.data.defaultModelId, "fixture-model");
    const body = { backendId: "shoggoth", agentId: OWNER.agentId, origin: "codex-desktop", operationId: "create-service-task",
      name: "Service fixture", prompt: "Produce fixture result", kind: "cron", enabled: false, model: "fixture-model", reasoningEffort: "high",
      cwd: root, executionEnvironment: "local", schedule: { kind: "rrule", rrule: "RRULE:FREQ=HOURLY;INTERVAL=2;BYMINUTE=0;BYSECOND=0" } };
    assert.equal((await api("/__api/cron/jobs", "POST", body, false)).status, 403);
    const created = await api("/__api/cron/jobs", "POST", body);
    assert.equal(created.status, 200, JSON.stringify(created.data)); let job = created.data.job;
    const route = `/__api/cron/jobs?backend=shoggoth&id=${encodeURIComponent(job.id)}`;
    const agents = await backend.listAgents();
    assert.equal(agents.filter(a => a.codexAutomationOwner).length, 1);
    assert.equal(agents.find(a => a.id === OWNER.agentId).name, "Renamed native Codex");
    const clone = agents.find(a => a.name === "Codex clone"); assert.ok(clone);
    assert.equal((await backend.getAgent(OWNER.agentId)).codexAutomationOwner, true);
    assert.equal((await backend.getAgent(clone.id)).codexAutomationOwner, false);
    const list = await api(`/__api/cron/jobs?backend=shoggoth&agentIds=${OWNER.agentId}`);
    assert.equal(list.data.jobs.filter(j => j.origin === "codex-desktop").length, 1);
    assert.equal((await api(`/__api/cron/jobs?backend=shoggoth&agentIds=${clone.id}`)).data.jobs.length, 0);
    const rejected = await api("/__api/cron/jobs", "POST", { ...body, agentId: clone.id, operationId: "clone-no-task" });
    assert.notEqual(rejected.status, 200);
    const edited = await api(route, "PUT", { revision: job.revision, name: "Edited API fixture", enabled: true,
      schedule: { kind: "rrule", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30;BYSECOND=0" } });
    assert.equal(edited.status, 200, JSON.stringify(edited.data)); job = edited.data.job;
    assert.equal(job.enabled, true); assert.equal(job.name, "Edited API fixture");
    const paused = await api(route, "PUT", { revision: job.revision, enabled: false });
    assert.equal(paused.status, 200); job = paused.data.job;
    const runBody = { mode: "force", revision: job.revision, operationId: "api-run-task" };
    const receipt = await api(route + "&action=run", "POST", runBody);
    assert.equal(receipt.status, 200, JSON.stringify(receipt.data)); const runId = receipt.data.job.runId;
    await waitUntil(() => service.workDispatcher.getRun(runId)?.status === "running", "Service native execution", 5000);
    assert.equal(host.turnParams.model, "fixture-model"); assert.equal(host.turnParams.effort, "high");
    assert.equal((await api(route + "&action=run", "POST", runBody)).data.job.runId, runId);
    const nativeRun = service.workDispatcher.getRun(runId);
    host.finish(nativeRun.runtimeTurnRef.turnId, "# Service complete\n\n" + "full output ".repeat(2000));
    await waitUntil(() => service.workDispatcher.getRun(runId)?.status === "completed", "Service completion");
    const result = await api(route + `&action=result&runId=${runId}`);
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.available, true);
    assert.equal(result.data.outputComplete, true); assert.ok(result.data.fullText.length > 18000);
    const history = await api(route + "&action=runs&offset=0&limit=20");
    assert.equal(history.status, 200); assert.equal(history.data.runs[0].runId, runId);
    const occurrence = new Date(2026, 9, 6, 9).getTime();
    const nativeThreadId = crypto.randomUUID(), nativeText = "# Calendar report\n\n" + "Full native output. ".repeat(1200);
    host.threads.push({ id: nativeThreadId, turns: [
      { id: crypto.randomUUID(), status: "completed", itemsView: "full", items: [
        { type: "agentMessage", id: crypto.randomUUID(), phase: "final_answer", delivery: "sync", text: nativeText }] },
      { id: crypto.randomUUID(), status: "completed", itemsView: "full", items: [
        { type: "agentMessage", id: crypto.randomUUID(), phase: "final_answer", delivery: "sync", text: "Unrelated follow-up" }] },
    ] });
    const db = new DatabaseSync(path.join(home, "sqlite", "codex-dev.db"));
    try {
      const insert = db.prepare("INSERT INTO automation_runs(thread_id,automation_id,status,created_at,inbox_summary) VALUES(?,?,?,?,?)");
      insert.run(nativeThreadId, job.externalTaskId, "PENDING_REVIEW", occurrence + 6 * 3600000, "Native summary");
      for (let index = 1; index <= 45; index++) insert.run(crypto.randomUUID(), job.externalTaskId,
        "PENDING_REVIEW", occurrence + index * 86400000, "Newer summary");
    } finally { db.close(); }
    const delivery = await api(route + `&action=delivery&at=${occurrence}`);
    assert.equal(delivery.status, 200, JSON.stringify(delivery.data));
    assert.equal(delivery.data.runId, `codex:${nativeThreadId}`);
    assert.equal(delivery.data.fullText, nativeText, "calendar reads the full original turn through Service + HTTP");
    assert.equal(delivery.data.source, "transcript");
    assert.equal(delivery.data.outputComplete, true);
    assert.equal((await api(route + `&action=delivery&at=${occurrence - 86400000}`)).data.source, "none");
    assert.equal(service.productStore.listWorkRuns({ source: "automation" }).length, 0, "no experimental source in shared schema");
    assert.equal(service.nativeCronStore.listJobs({}).length, 0, "external tasks must not enter NativeCronScheduler");
    assert.equal(service.codexAutomationController.owner().store.read(job.externalTaskId).definition.status, "PAUSED");
    console.log("PASS production Service + Backend + HTTP: strict origin, native source/catalog, sole renamed owner, clone exclusion, create/edit/time/enable/pause, idempotent run, full result and delayed calendar output beyond the first history page");
  } catch (error) { console.error(error); throw error; } finally { await http?.close(); await backend?.stop(); await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
