"use strict";
// Join the real native Adapter/Registry to the real Service, scheduler,
// SQLite store and delivery state machine. Only the HTTP model and OS
// notification sender are controlled. Nothing touches production user data.
const assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../../app/agent-service/server");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { RuntimeAdapterRegistry } = require("../../app/agent-service/runtime-adapter-registry");
const { DEFAULT_AGENT_PROFILE_ID } = require("../../app/agent-service/product-store");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../../app/agent-service/runtime-account");
const { workspaceMemoryRefs } = require("../../app/agent-service/memory-engine");

async function seedProactiveAgentContext(service, profileId, workspace, at) {
  const current = service.agentDefinitionStore.get(profileId);
  const definitions = {
    IDENTITY: "# Identity\n\nYou are the observatory's patient guide.\n",
    AGENTS: "# Operating rules\n\nPresent the observation before the interpretation.\n",
    SOUL: "# Soul\n\n" + "Use calm language when reporting an observation.\n".repeat(360)
      + "Close each actionable reminder with a gentle next step.\n",
  };
  service.agentDefinitionStore.update({ profileId, expectedRevision: current.manifest.revision,
    actor: "user", documents: definitions });
  const user = "The user prefers a brief, friendly opening in reminders.";
  const agent = "The observatory team reviews the amber telescope after dark.";
  const daily = "Today's observation found the lens cover was closed.";
  const project = "The private project uses a different telescope.";
  for (const [content, input] of [[user, { scope: "user", sensitivity: "private" }], [agent, { scope: "agent" }],
    [daily, { scope: "agent", dailyNotePath: `memory/${new Date(at).toISOString().slice(0, 10)}.md` }],
    [project, { scope: "project", sourceRefs: ["user-edit:review-fixture", ...workspaceMemoryRefs(workspace, "project")] }]]) {
    await service.memoryEngine.propose({ profileId, classification: "explicit", content, sourceRefs: ["user-edit:review-fixture"], ...input });
  }
  return { definitions, user, agent, daily, project };
}

async function verifyProactiveNativeClosure({ root, adapter, runtime, model, setResponse }) {
  const registry = new RuntimeAdapterRegistry(); registry.register(runtime, adapter);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "service-state"),
    profileRoot: path.join(root, "service-profile"), cacheRoot: path.join(root, "service-cache") });
  let now = Date.UTC(2026, 9, 28, 11, 30), modelCalls = 0;
  const sent = [], id = () => crypto.randomUUID(), profileId = DEFAULT_AGENT_PROFILE_ID;
  const service = createAgentService({ paths, runtimeManager: registry, now: () => now,
    autoSparkNotes: false, proactiveReviewTimeoutMs: 90_000, proactiveProfileAvailable: () => true,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    notificationSender: async input => { sent.push(input); return { state: "submitted" }; } });
  const call = (method, params) => service.proactiveService.handle(method, params);
  const monitor = async kind => (await call("proactive.monitor.get", { kind, profileId })).monitor;
  const save = config => call("proactive.monitor.set", { config, operationId: id(),
    expectedRevision: service.proactiveStore.getMonitor(config.id)?.revision ?? 0 });
  const tick = async () => { await service.proactiveScheduler.tick(); await service.proactiveScheduler.waitForIdle(); };
  setResponse(body => {
    assert.deepEqual(body.tools || [], []);
    const runs = service.workDispatcher.listRuns({ source: "proactive" }).filter(run => run.status === "running");
    assert.equal(runs.length, 1, "account admission serializes native reviews");
    const run = runs[0], occurrence = service.proactiveStore.occurrenceForRun(run.id);
    const wire = JSON.stringify(body), candidate = occurrence.candidates[0];
    assert.ok(wire.includes(run.id)); assert.ok(wire.includes(candidate.id));
    modelCalls++;
    return JSON.stringify({ runId: run.id, outcome: "notice", candidates: [{ id: candidate.id,
      evidenceVersion: candidate.evidenceVersion }], reason: "原生 Runtime 检查发现需要关注的变化", body: "请回顾这条待处理记录。",
      ...(occurrence.heartbeat ? { scratch: "原生 Runtime 已检查：状态 A" } : {}) });
  });
  try {
    await service.start();
    const products = service.productStore;
    products.addAgentRuntimeBinding(profileId, { runtime,
      runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(a => a.runtime === runtime).id }, { operationId: id() });
    const state = products.getAgentRuntimeBindings(profileId), binding = state.bindings.find(b => b.runtime === runtime);
    products.setAgentDefaultBinding(profileId, binding.id, { revision: state.revision });
    products.putAgentProfile({ ...products.getAgentProfile(profileId), defaultModel: model });
    await service.inspirationService.handle("inspiration.create", { operationId: id(), body: "值得回顾的原生 Runtime 验收灵感" });
    now += 2 * 24 * 60 * 60_000;
    const document = (await call("proactive.document.get", { profileId })).document;
    await call("proactive.document.set", { profileId, expectedRevision: document.revision,
      content: "# HEARTBEAT\n\n检查提供的状态，保留短检查笔记；仅在有值得关注的变化时提醒。\n" });
    const heartbeat = await monitor("heartbeat");
    await save({ ...heartbeat.config, enabled: true, activeHours: null, timezone: "UTC" });
    await tick();
    const check = service.proactiveStore.history(heartbeat.config.id)[0];
    assert.equal(check?.state, "published", JSON.stringify({ check, errors: [...service.workRunCoordinator.lastErrors.values()]
      .map(e => ({ code: e.code, message: e.message })) }));
    assert.equal(modelCalls, 1); assert.equal(sent.length, 1);
    assert.equal(service.proactiveStore.heartbeatScratch(profileId).content, "原生 Runtime 已检查：状态 A");
    await tick(); assert.equal(modelCalls, 1); assert.equal(sent.length, 1);
    const daily = await monitor("inspiration");
    await save({ ...daily.config, enabled: true, timezone: "UTC", schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" } });
    now += 30 * 60_000; await tick();
    const inspiration = service.proactiveStore.history(daily.config.id)[0];
    assert.equal(inspiration?.state, "published", JSON.stringify(inspiration));
    assert.equal(service.proactiveStore.history(heartbeat.config.id)[0].reason, "duplicate_notice");
    assert.equal(sent.length, 2); assert.equal(modelCalls, 3);
    const usage = service.tokenUsageStore.list({ profileId }).filter(row => row.source === "proactive");
    assert.equal(usage.length, 3); assert.ok(usage.every(row => row.runtime === runtime && row.totalTokens > 0));
    assert.equal(service.proactiveService.status(service.proactiveStore.getMonitor(daily.config.id)).modelResponseRecords, 1);
    await service.stop({ notify: false }); await service.start(); await tick();
    assert.equal(sent.length, 2); assert.equal(modelCalls, 3);
    assert.equal(service.proactiveStore.heartbeatScratch(profileId).content, "原生 Runtime 已检查：状态 A");
    return { nativeServiceClosure: true, runtime, heartbeat: true, scratchPersisted: true, dailyInspiration: true,
      deduplicated: true, restartNoReplay: true, modelCalls, noticesSubmitted: sent.length,
      actualProviderCalls: 0, physicalOsNotifications: 0 };
  } finally { setResponse(null); await service.stop({ notify: false }); }
}
module.exports = { verifyProactiveNativeClosure, seedProactiveAgentContext };
