#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  createAgentLifecycleServiceController,
} = require(path.join(ROOT, "app", "agent-service", "agent-lifecycle-service-controller.js"));
const {
  validateAgentLifecycleParams,
  validateAgentLifecycleResult,
} = require(path.join(ROOT, "app", "agent-service", "agent-lifecycle-service-protocol.js"));
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  BUILTIN_CLI_AGENT_PROFILES,
} = require(path.join(ROOT, "app", "agent-service", "builtin-cli-profiles.js"));
const {
  createAgentService,
  PROTOCOL_VERSION,
} = require(path.join(ROOT, "app", "agent-service", "server.js"));
const {
  readClientToken,
  requestService,
} = require(path.join(ROOT, "app", "agent-service", "client.js"));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agent-lifecycle-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  const clock = { value: 10_000 };
  const productStore = new JsonlProductStore({ paths, now: () => clock.value });
  productStore.open();
  const effects = { initialized: [], activated: [], stopped: [], profileChanges: [], failInitialize: 0, failStop: 0 };
  const controller = createAgentLifecycleServiceController({
    productStore,
    runtimeManager: {
      async stop(binding) {
        effects.stopped.push(structuredClone(binding));
        if (effects.failStop > 0) {
          effects.failStop -= 1;
          throw new Error("injected stop failure");
        }
      },
    },
    async initializeProfile(profile, initialization) {
      effects.initialized.push(profile.id);
      effects.lastInitialization = initialization;
      if (effects.failInitialize > 0) {
        effects.failInitialize -= 1;
        throw new Error("injected initialize failure");
      }
    },
    async activateProfile(profile) {
      effects.activated.push({ id: profile.id, enabled: profile.enabled });
    },
    onProfileChanged(payload) { effects.profileChanges.push(payload); },
    now: () => clock.value,
  });
  controller.open();
  return { root, paths, clock, productStore, effects, controller };
}

function createParams(operationId, name = "Alpha", backendId = "shoggoth") {
  return { operationId, backendId, name, defaultCwd: null, createdAt: 10_000 };
}

function validQueuedRun(profileId, id = "run-disabled") {
  return {
    id,
    source: "chat",
    sourceId: `source-${id}`,
    idempotencyKey: `idem-${id}`,
    profileId,
    workspace: "/tmp/shoggoth-lifecycle-workspace",
    status: "queued",
    contextSnapshotId: null,
    runtimeSessionRef: null,
    runtimeTurnRef: null,
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
  };
}

async function closeFixture(value) {
  await value.controller.close();
  value.productStore.close();
  fs.rmSync(value.root, { recursive: true, force: true });
}

async function testProtocol() {
  assert.deepEqual(validateAgentLifecycleParams("agent.create", createParams("create-protocol")),
    createParams("create-protocol"));
  assert.throws(
    () => validateAgentLifecycleParams("agent.create", { ...createParams("create-protocol"), extra: true }),
    (error) => error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateAgentLifecycleParams("agent.create", {
      ...createParams("create-protocol"), runtimeAccountId: "native-codex-default-v1",
    }),
    (error) => error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateAgentLifecycleResult("agent.lifecycle.list", { agents: [{ state: "active" }] }),
    (error) => error.code === "AGENT_RESPONSE_INVALID",
  );
}

async function testCrudReplayAndGuards() {
  const value = fixture();
  try {
    const created = await value.controller.handle("agent.create", createParams("create-alpha"));
    assert.equal(created.profile.backendId, "shoggoth");
    assert.equal(created.profile.runtime, "codex");
    assert.match(created.profile.agentId, /^shoggoth-agent-[0-9a-f-]+$/u);
    assert.equal(created.profile.enabled, true);
    assert.equal(value.effects.initialized.length, 1);
    assert.equal(value.effects.activated.length, 1);
    assert.equal(value.effects.activated[0].enabled, false,
      "all activation resources must complete before enabled publish");

    const replay = await value.controller.handle("agent.create", createParams("create-alpha"));
    assert.deepEqual(replay, created);
    assert.equal(value.effects.initialized.length, 1);
    await assert.rejects(
      () => value.controller.handle("agent.create", createParams("create-alpha", "Different")),
      (error) => error.code === "AGENT_OPERATION_CONFLICT",
    );

    const updated = await value.controller.handle("agent.update", {
      operationId: "update-alpha",
      profileId: created.profile.id,
      name: "Alpha Reviewer",
      defaultCwd: "/tmp",
      expectedUpdatedAt: created.profile.updatedAt,
      createdAt: 10_000,
    });
    assert.equal(updated.profile.name, "Alpha Reviewer");
    assert.equal(updated.profile.defaultCwd, "/tmp");
    assert.ok(updated.profile.updatedAt > created.profile.updatedAt);
    await assert.rejects(
      () => value.controller.handle("agent.update", {
        operationId: "update-stale",
        profileId: created.profile.id,
        name: "Stale",
        defaultCwd: null,
        expectedUpdatedAt: created.profile.updatedAt,
        createdAt: 10_000,
      }),
      (error) => error.code === "AGENT_PROFILE_CONFLICT",
    );

    await assert.rejects(
      () => value.controller.handle("agent.archive", {
        operationId: "archive-default",
        profileId: DEFAULT_AGENT_PROFILE_ID,
        expectedUpdatedAt: value.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).updatedAt,
        createdAt: 10_000,
      }),
      (error) => error.code === "AGENT_PROTECTED",
    );

    const archived = await value.controller.handle("agent.archive", {
      operationId: "archive-alpha",
      profileId: created.profile.id,
      expectedUpdatedAt: updated.profile.updatedAt,
      createdAt: 10_000,
    });
    assert.equal(archived.profile.enabled, false);
    assert.equal(value.effects.stopped.length, 1);
    assert.throws(
      () => value.productStore.putWorkRun(validQueuedRun(created.profile.id)),
      (error) => error.code === "AGENT_PROFILE_DISABLED",
    );
    const archivedList = await value.controller.handle("agent.lifecycle.list", { backendId: "shoggoth" });
    assert.equal(archivedList.agents.find(item => item.profile.id === created.profile.id).state, "archived");

    const restored = await value.controller.handle("agent.restore", {
      operationId: "restore-alpha",
      profileId: created.profile.id,
      expectedUpdatedAt: archived.profile.updatedAt,
      createdAt: 10_000,
    });
    assert.equal(restored.profile.enabled, true);
    assert.equal(value.effects.initialized.length, 2);
    assert.equal(value.effects.activated.length, 2);
  } finally {
    await closeFixture(value);
  }
}

async function testPendingRecovery() {
  const value = fixture();
  try {
    value.effects.failInitialize = 1;
    await assert.rejects(
      () => value.controller.handle("agent.create", createParams("create-recover", "Recoverable", "shoggoth")),
      (error) => error.code === "AGENT_INITIALIZATION_FAILED",
    );
    const pending = value.productStore.listMcpToolCalls().find((call) => call.name === "agent.create");
    assert.equal(pending.status, "pending");
    assert.equal(value.productStore.getAgentProfile(pending.binding.targetProfileId).enabled, false);
    const recovered = await value.controller.handle(
      "agent.create", createParams("create-recover", "Recoverable", "shoggoth"),
    );
    assert.equal(recovered.profile.enabled, true);
    assert.match(recovered.profile.agentId, /^shoggoth-agent-/u);

    value.effects.failStop = 1;
    await assert.rejects(
      () => value.controller.handle("agent.archive", {
        operationId: "archive-recover",
        profileId: recovered.profile.id,
        expectedUpdatedAt: recovered.profile.updatedAt,
        createdAt: 10_000,
      }),
      (error) => error.code === "AGENT_RUNTIME_CLEANUP_FAILED",
    );
    const repairing = await value.controller.handle("agent.lifecycle.list", { backendId: "shoggoth" });
    assert.equal(repairing.agents.find(item => item.profile.id === recovered.profile.id).state, "archive-repair");
    const completed = await value.controller.handle("agent.archive", {
      operationId: "archive-recover",
      profileId: recovered.profile.id,
      expectedUpdatedAt: recovered.profile.updatedAt,
      createdAt: 10_000,
    });
    assert.equal(completed.profile.enabled, false);
    assert.equal(value.effects.stopped.length, 2);
  } finally {
    await closeFixture(value);
  }
}

async function testStoreIdentityUniqueness() {
  const value = fixture();
  try {
    const first = await value.controller.handle("agent.create", createParams("identity-a", "Identity A"));
    assert.throws(
      () => value.productStore.putAgentProfile({
        ...first.profile,
        id: "11111111-1111-8111-8111-111111111111",
        name: "Identity Collision",
        isDefault: false,
      }),
      (error) => error.code === "AGENT_PROFILE_IDENTITY_CONFLICT",
    );
  } finally {
    await closeFixture(value);
  }
}

async function testServiceResourceWiringAndRestart() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sagl-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  let service = createAgentService({
    paths, version: "agent-lifecycle-integration", builtinCliProfiles: true,
  });
  const created = [];
  try {
    await service.start();
    let token = readClientToken(paths);
    const builtin = service.productStore.getAgentProfile(BUILTIN_CLI_AGENT_PROFILES[0].id);
    for (const profile of service.productStore.listAgentProfiles()) {
      assert.equal(service.agentDefinitionStore.get(profile.id).documents.IDENTITY
        .match(/^- Name: (.+)$/mu)?.[1], profile.name);
    }
    await assert.rejects(
      () => requestService(paths, {
        method: "agent.archive",
        token,
        version: PROTOCOL_VERSION,
        params: {
          operationId: "service-archive-protected-builtin",
          profileId: builtin.id,
          expectedUpdatedAt: builtin.updatedAt,
          createdAt: Date.now(),
        },
      }, { timeoutMs: 5_000 }),
      (error) => error.code === "AGENT_PROTECTED",
    );
    for (const backendId of ["codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness"]) {
      await assert.rejects(() => requestService(paths, {
        method: "agent.create", token, version: PROTOCOL_VERSION,
        params: { operationId: `service-reject-peer-${backendId}`, backendId,
          name: "Invalid peer authority", defaultCwd: null, createdAt: Date.now() },
      }, { timeoutMs: 5_000 }), (error) => error.code === "AGENT_BACKEND_NOT_SUPPORTED");
    }
    for (const [index, backendId] of ["shoggoth"].entries()) {
      const result = await requestService(paths, {
        method: "agent.create",
        token,
        version: PROTOCOL_VERSION,
        params: {
          operationId: `service-create-${backendId}`,
          backendId,
          name: `Service ${backendId}`,
          initialIdentity: `我的身份是 ${backendId} 的辅助助理，协助完成任务。`,
          defaultCwd: null,
          createdAt: Date.now() + index,
        },
      }, { timeoutMs: 5_000 });
      created.push(result.profile);
      assert.deepEqual(result.profile.permissionPolicy, {
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      });
      assert.equal(service.agentDefinitionStore.get(result.profile.id).documents.IDENTITY
        .match(/^- Name: (.+)$/mu)?.[1], result.profile.name);
      assert.ok(service.agentDefinitionStore.get(result.profile.id).documents.IDENTITY
        .includes(`我的身份是 ${backendId} 的辅助助理，协助完成任务。`));
      assert.equal(Number.isSafeInteger(service.memoryStore.getRevision(result.profile.id)), true);
      assert.ok(service.nativeSkillStore.ensureProfile(result.profile.id));
      assert.equal(service.nativeKanbanStore.listBoards()
        .some((board) => board.profileId === result.profile.id), true);
      const runtimeHome = path.join(
        paths.stateDir,
        result.profile.runtime,
        result.profile.runtimeProfileId,
      );
      assert.equal(fs.existsSync(runtimeHome), false,
        "creating an Agent must not allocate a per-Profile Runtime Home");
    }
    const events = await requestService(paths, {
      method: "events.subscribe", token, version: PROTOCOL_VERSION, params: { afterSeq: 0 },
    });
    for (const profile of created) {
      assert.ok(events.events.some(event => event.type === "agent.profile.changed"
        && event.payload.profileId === profile.id && event.payload.backendId === profile.backendId));
    }
    await service.stop();

    service = createAgentService({
      paths, version: "agent-lifecycle-integration-restart", builtinCliProfiles: true,
    });
    await service.start();
    token = readClientToken(paths);
    for (const profile of created) {
      const listed = await requestService(paths, {
        method: "agent.lifecycle.list",
        token,
        version: PROTOCOL_VERSION,
        params: { backendId: profile.backendId },
      }, { timeoutMs: 5_000 });
      assert.equal(listed.agents.some((entry) => (
        entry.profile.id === profile.id && entry.state === "active"
      )), true);
      assert.equal(service.agentDefinitionStore.get(profile.id).documents.IDENTITY
        .match(/^- Name: (.+)$/mu)?.[1], profile.name);
      assert.ok(service.agentDefinitionStore.get(profile.id).documents.IDENTITY
        .includes(`我的身份是 ${service.productStore.getAgentProfile(profile.id).backendId} 的辅助助理，协助完成任务。`));
      assert.equal(service.nativeKanbanStore.listBoards()
        .some((board) => board.profileId === profile.id), true);
    }
  } finally {
    await service.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testNativeMcpManagement() {
  const { McpProductToolController } = require(path.join(ROOT, "app/agent-service/mcp-product-tool-controller"));
  const value = fixture();
  const noop = () => null;
  const makeMcp = () => new McpProductToolController({
    productStore: value.productStore, agentLifecycleService: value.controller,
    domainController: { handle: noop }, kanbanStore: Object.fromEntries([
      "getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts",
    ].map(name => [name, noop])),
    kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop },
    workDispatcher: { getRun: () => ({ id: "caller-run", profileId: DEFAULT_AGENT_PROFILE_ID, status: "running" }) },
    getRuntimeContext: (_profileId, selector) => ({ ...selector, profileId: DEFAULT_AGENT_PROFILE_ID, runId: "caller-run" }),
    notificationSender: async () => {}, isSensitiveValue: () => false, artifactRoot: path.join(value.root, "artifacts"),
    now: () => value.clock.value,
  });
  try {
    const context = { source: "chat", sourceId: "caller-session" };
    const authority = n => ({ profileId: DEFAULT_AGENT_PROFILE_ID, confirmation: true,
      callId: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}` });
    const createArgs = { ...context, backendId: "shoggoth", name: "星帆", workspace: null,
      identity: "身份是你的辅助助理，协助你完成任务。" };
    const createAuthority = { profileId: DEFAULT_AGENT_PROFILE_ID, callId: authority(7).callId };
    value.effects.failInitialize = 1;
    await assert.rejects(() => makeMcp().handle("native_agent_create", createArgs, createAuthority),
      { code: "AGENT_INITIALIZATION_FAILED" });
    const creation = await makeMcp().handle("native_agent_create", createArgs, createAuthority);
    assert.equal(creation.identitySaved, true);
    assert.deepEqual(value.effects.lastInitialization, { initialIdentity: createArgs.identity });
    const effectCount = value.effects.initialized.length;
    assert.deepEqual(await makeMcp().handle("native_agent_create", createArgs, createAuthority), creation);
    assert.equal(value.effects.initialized.length, effectCount);
    const matches = value.productStore.listAgentProfiles().filter(profile => profile.agentId === creation.agent.agentId);
    assert.equal(matches.length, 1);
    const created = { profile: matches[0] };
    const target = { backendId: "shoggoth", agentId: created.profile.agentId };
    const mcp = makeMcp();
    const initial = await mcp.handle("native_agent_get", target, authority(1));
    const updated = await mcp.handle("native_agent_update", { ...target, ...context,
      name: "星帆新名称", expectedUpdatedAt: initial.agent.updatedAt }, authority(2));
    assert.equal(value.productStore.getAgentProfile(created.profile.id).name, "星帆新名称");
    const args = { ...target, ...context, expectedUpdatedAt: updated.agent.updatedAt };
    const activeRun = validQueuedRun(created.profile.id);
    value.productStore.putWorkRun(activeRun);
    await assert.rejects(() => mcp.handle("native_agent_archive", args, authority(3)), { code: "AGENT_ACTIVE_RUNS" });
    value.productStore.putWorkRun({ ...activeRun, status: "canceled", eventSeq: 2, finishedAt: value.clock.value });
    value.effects.failStop = 1;
    await assert.rejects(() => mcp.handle("native_agent_archive", args, authority(4)), { code: "AGENT_RUNTIME_CLEANUP_FAILED" });
    assert.deepEqual(value.effects.profileChanges.at(-1), { profileId: created.profile.id, backendId: "shoggoth" });
    assert.equal(value.productStore.listMcpToolCalls().find(call => call.name === "native_agent_archive"
      && call.callId === authority(4).callId).status, "pending");
    const archived = await makeMcp().handle("native_agent_archive", args, authority(4));
    assert.equal(archived.agent.state, "archived");
    assert.equal(archived.dataDeleted, false);
    const stopCount = value.effects.stopped.length;
    const changeCount = value.effects.profileChanges.length;
    assert.deepEqual(await makeMcp().handle("native_agent_archive", args, authority(4)), archived);
    assert.equal(value.effects.stopped.length, stopCount);
    assert.equal(value.effects.profileChanges.length, changeCount);
    const restored = await value.controller.handle("agent.restore", { operationId: "mcp-restore",
      profileId: created.profile.id, expectedUpdatedAt: archived.agent.updatedAt, createdAt: value.clock.value });
    assert.equal(restored.profile.name, "星帆新名称");
    assert.equal(restored.profile.enabled, true);
    assert.equal(value.productStore.getWorkRun(activeRun.id).status, "canceled");
  } finally { await closeFixture(value); }
}

(async () => {
  const tests = [
    ["protocol exactness", testProtocol],
    ["CRUD replay and guards", testCrudReplayAndGuards],
    ["pending recovery", testPendingRecovery],
    ["native MCP management, recovery and data retention", testNativeMcpManagement],
    ["store identity uniqueness", testStoreIdentityUniqueness],
    ["service resource wiring and restart", testServiceResourceWiringAndRestart],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`${tests.length}/${tests.length} agent lifecycle tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
