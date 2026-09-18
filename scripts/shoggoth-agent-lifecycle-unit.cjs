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
  const effects = { initialized: [], activated: [], stopped: [], failInitialize: 0, failStop: 0 };
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
    async initializeProfile(profile) {
      effects.initialized.push(profile.id);
      if (effects.failInitialize > 0) {
        effects.failInitialize -= 1;
        throw new Error("injected initialize failure");
      }
    },
    async activateProfile(profile) {
      effects.activated.push({ id: profile.id, enabled: profile.enabled });
    },
    now: () => clock.value,
  });
  controller.open();
  return { root, paths, clock, productStore, effects, controller };
}

function createParams(operationId, name = "Alpha", backendId = "codex") {
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
    assert.equal(created.profile.backendId, "codex");
    assert.equal(created.profile.runtime, "codex");
    assert.match(created.profile.agentId, /^codex-[0-9a-f-]+$/u);
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
    const archivedList = await value.controller.handle("agent.lifecycle.list", { backendId: "codex" });
    assert.equal(archivedList.agents[0].state, "archived");

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
      () => value.controller.handle("agent.create", createParams("create-recover", "Recoverable", "grok-build")),
      (error) => error.code === "AGENT_INITIALIZATION_FAILED",
    );
    const pending = value.productStore.listMcpToolCalls().find((call) => call.name === "agent.create");
    assert.equal(pending.status, "pending");
    assert.equal(value.productStore.getAgentProfile(pending.binding.targetProfileId).enabled, false);
    const recovered = await value.controller.handle(
      "agent.create", createParams("create-recover", "Recoverable", "grok-build"),
    );
    assert.equal(recovered.profile.enabled, true);
    assert.match(recovered.profile.agentId, /^grok-/u);

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
    const repairing = await value.controller.handle("agent.lifecycle.list", { backendId: "grok-build" });
    assert.equal(repairing.agents[0].state, "archive-repair");
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
    await assert.rejects(() => requestService(paths, {
      method: "agent.create", token, version: PROTOCOL_VERSION,
      params: { operationId: "service-create-disabled-claude", backendId: "claude-code",
        name: "Disabled Claude", defaultCwd: null, createdAt: Date.now() },
    }, { timeoutMs: 5_000 }), (error) => error.code === "AGENT_BACKEND_NOT_SUPPORTED");
    for (const [index, backendId] of [
      "shoggoth", "codex", "grok-build", "antigravity", "pi",
      "deepseek-harness",
    ].entries()) {
      const result = await requestService(paths, {
        method: "agent.create",
        token,
        version: PROTOCOL_VERSION,
        params: {
          operationId: `service-create-${backendId}`,
          backendId,
          name: `Service ${backendId}`,
          defaultCwd: null,
          createdAt: Date.now() + index,
        },
      }, { timeoutMs: 5_000 });
      created.push(result.profile);
      assert.deepEqual(result.profile.permissionPolicy, {
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      });
      assert.ok(service.agentDefinitionStore.get(result.profile.id));
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
      assert.ok(service.agentDefinitionStore.get(profile.id));
      assert.equal(service.nativeKanbanStore.listBoards()
        .some((board) => board.profileId === profile.id), true);
    }
  } finally {
    await service.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const tests = [
    ["protocol exactness", testProtocol],
    ["CRUD replay and guards", testCrudReplayAndGuards],
    ["pending recovery", testPendingRecovery],
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
