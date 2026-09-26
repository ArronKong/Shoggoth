#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { ContextSnapshotStore } = require(path.join(ROOT, "app/agent-service/context-snapshot-store"));
const { resolveServicePaths } = require(path.join(ROOT, "app/agent-service/paths"));
const { JsonlProductStore } = require(path.join(ROOT, "app/agent-service/product-store"));
const {
  RuntimeSwitchManager,
} = require(path.join(ROOT, "scripts/fixtures/legacy-runtime-switch-manager.cjs"));
const { TranscriptStore } = require(path.join(ROOT, "app/agent-service/transcript-store"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture(checkpoint = () => {}, profileOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-switch-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  let time = 100;
  const now = () => ++time;
  const productStore = new JsonlProductStore({ paths, now });
  productStore.open();
  productStore.putAgentProfile({
    id: "profile-switch",
    backendId: "shoggoth",
    agentId: "shoggoth-profile-switch",
    name: "Switch Fixture",
    runtime: "codex",
    runtimeProfileId: "runtime-old",
    runtimeAccountId: "shoggoth-internal-codex-default-v1",
    providerRef: null,
    defaultModel: "fixture-model",
    defaultCwd: "/tmp/runtime-switch-workspace",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: false,
    enabled: true,
    ...profileOverrides,
  });
  const candidateAccount = productStore.putRuntimeAccount({ id: "future-account", runtime: "future",
    kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", providerRef: null,
    isDefault: false, createdAt: null, updatedAt: null });
  const candidate = productStore.addAgentRuntimeBinding("profile-switch", { runtime: "future",
    runtimeAccountId: candidateAccount.id }, { operationId: "future-binding-fixture" }).binding;
  const snapshots = new ContextSnapshotStore({ paths });
  snapshots.open();
  const snapshot = snapshots.create({
    schemaVersion: 1,
    runId: "run-switch-source",
    profileId: "profile-switch",
    createdAt: now(),
    revisions: { definition: 1, memory: 1, tools: "a".repeat(64), permission: 1, transcript: 1 },
    blocks: [],
    developerInstructions: "FUTURE_CANARY_DEFINITION_SENTINEL",
    dynamicContext: "BEGIN UNTRUSTED DATA\nFUTURE_CANARY_MEMORY_SENTINEL\nEND UNTRUSTED DATA",
    report: { totalBytes: 1, truncatedBlocks: [], memoryMatches: [] },
  });
  const transcripts = new TranscriptStore({ paths, now, assertSecretSafe: () => true });
  transcripts.open();
  transcripts.appendEvent({
    profileId: "profile-switch",
    sessionId: "session-switch",
    id: "event-switch",
    runId: "run-switch-source",
    seq: 1,
    kind: "user",
    content: { text: "FUTURE_CANARY_TRANSCRIPT_SENTINEL" },
    runtimeRef: null,
    contextExcluded: false,
    occurredAt: now(),
  });
  const calls = [];
  const handle = {
    async sessionStart(input) {
      calls.push(["sessionStart", input]);
      return { session: { id: "future-session", source: input.source } };
    },
    async turnStart(input) {
      calls.push(["turnStart", input]);
      return { turn: { id: "future-turn" } };
    },
  };
  const runtimeManager = {
    async acquire(binding, acquireOptions) {
      calls.push(["acquire", binding, acquireOptions]);
      return handle;
    },
    async stop(binding) { calls.push(["stop", binding]); },
  };
  const createManager = (nextCheckpoint = checkpoint) => new RuntimeSwitchManager({
    paths,
    productStore,
    runtimeManager,
    contextSnapshotStore: snapshots,
    transcriptStore: transcripts,
    assertExclusive: () => true,
    now,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    checkpoint: nextCheckpoint,
  }).open();
  return {
    root, paths, now, productStore, snapshots, snapshot, transcripts, calls, runtimeManager,
    createManager,
    input(overrides = {}) {
      const profile = productStore.getAgentProfile("profile-switch");
      return {
        operationId: "switch-operation",
        profileId: profile.id,
        expectedProfileUpdatedAt: profile.updatedAt,
        candidateBinding: {
          runtime: "future",
          runtimeProfileId: candidate.runtimeProfileId,
          runtimeAccountId: candidate.runtimeAccountId,
        },
        contextSnapshotId: snapshot.id,
        transcriptSessionId: "session-switch",
        workspace: "/tmp/runtime-switch-workspace",
        verifyCanary: async ({ snapshot: frozen, transcript, binding }) => {
          assert.equal(binding.runtime, "future");
          assert.match(frozen.developerInstructions, /FUTURE_CANARY_DEFINITION_SENTINEL/u);
          assert.match(frozen.dynamicContext, /FUTURE_CANARY_MEMORY_SENTINEL/u);
          assert.equal(transcript[0].content.text, "FUTURE_CANARY_TRANSCRIPT_SENTINEL");
          return { ok: true };
        },
        ...overrides,
      };
    },
    cleanup() {
      try { transcripts.close(); } catch {}
      try { snapshots.close(); } catch {}
      try { productStore.close(); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("fake Future Runtime 用通用 Context/Transcript canary 切换 binding 并停止旧 Runtime", async () => {
  const value = fixture();
  const manager = value.createManager();
  try {
    const previousRuntimeAccountId = value.productStore
      .getAgentProfile("profile-switch").runtimeAccountId;
    const switched = await manager.switchProfile(value.input());
    assert.equal(switched.runtime, "future");
    assert.equal(switched.runtimeProfileId, value.input().candidateBinding.runtimeProfileId);
    assert.equal(switched.runtimeAccountId, value.calls[0][1].runtimeAccountId);
    assert.deepEqual(value.calls.map(([name]) => name), ["acquire", "sessionStart", "turnStart", "stop"]);
    assert.deepEqual(value.calls[0][2], {
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
      workspace: "/tmp/runtime-switch-workspace",
    });
    assert.deepEqual(value.calls.at(-1)[1], {
      runtime: "codex",
      runtimeProfileId: "runtime-old",
      runtimeAccountId: previousRuntimeAccountId,
    });
    const sessionInput = value.calls.find(([name]) => name === "sessionStart")[1];
    const turnInput = value.calls.find(([name]) => name === "turnStart")[1];
    assert.deepEqual(sessionInput.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
    assert.deepEqual(turnInput.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
    assert.equal(Object.keys(turnInput).some((key) => key.startsWith("codex")), false);
    assert.equal(manager.journal.get(), null);
  } finally { manager.close(); value.cleanup(); }
});

test("candidate canary 失败时 binding 保持旧值且 candidate 被停止", async () => {
  const value = fixture();
  const manager = value.createManager();
  try {
    await assert.rejects(
      manager.switchProfile(value.input({ verifyCanary: async () => ({ ok: false }) })),
      (error) => error.code === "RUNTIME_SWITCH_CANARY_FAILED",
    );
    assert.equal(value.productStore.getAgentProfile("profile-switch").runtime, "codex");
    assert.deepEqual(value.calls.at(-1), ["stop", value.input().candidateBinding]);
    assert.equal(manager.journal.get(), null);
  } finally { manager.close(); value.cleanup(); }
});

test("Shoggoth Codex Profile 在 ProductStore 层拒绝显式独立账号", async () => {
  const value = fixture();
  const explicitAccount = value.productStore.putRuntimeAccount({
    id: "explicit-runtime-account",
    runtime: "codex",
    kind: "shoggoth-managed",
    installationKind: "bundled",
    homeKind: "managed-shared",
    providerRef: null,
    isDefault: false,
    createdAt: null,
    updatedAt: null,
  });
  const original = value.productStore.getAgentProfile("profile-switch");
  try {
    assert.throws(
      () => value.productStore.putAgentProfile({
        ...original,
        runtimeAccountId: explicitAccount.id,
      }),
      (error) => error.code === "AGENT_BINDING_PROJECTION_READONLY",
    );
    assert.deepEqual(value.productStore.getAgentProfile("profile-switch"), original);
    assert.deepEqual(value.calls, []);
    assert.equal(fs.existsSync(value.paths.runtimeSwitchPath), false);
  } finally { value.cleanup(); }
});

test("candidate Binding 不存在时不写 journal 或启动 canary", async () => {
  const value = fixture(() => {}, { runtimeAccountId: "native-codex-default-v1" });
  const before = value.productStore.getAgentProfile("profile-switch");
  const manager = value.createManager();
  try {
    await assert.rejects(
      manager.switchProfile(value.input({candidateBinding:{runtime:"future",runtimeProfileId:"missing",runtimeAccountId:"future-account"}})),
      (error) => error.code === "RUNTIME_SWITCH_ACCOUNT_UNSUPPORTED",
    );
    assert.deepEqual(value.productStore.getAgentProfile("profile-switch"), before);
    assert.deepEqual(value.calls, []);
    assert.equal(manager.journal.get(), null);
    assert.equal(fs.existsSync(value.paths.runtimeSwitchPath), false);
  } finally { manager.close(); value.cleanup(); }
});

for (const [crashPoint, expectedAction, expectedRuntime] of [
  ["prepared", "rolled-back", "codex"],
  ["candidate-verified", "rolled-back", "codex"],
  ["binding-committed", "commit-finished", "future"],
  ["previous-runtime-stopped", "commit-finished", "future"],
]) test(`crash point ${crashPoint} 重启后确定性 ${expectedAction}`, async () => {
  const crash = new Error(`simulated crash: ${crashPoint}`);
  crash.simulatedCrash = true;
  const value = fixture((point) => { if (point === crashPoint) throw crash; });
  const manager = value.createManager();
  try {
    await assert.rejects(manager.switchProfile(value.input()), (error) => error === crash);
    manager.close();
    const recoveredManager = value.createManager(() => {});
    try {
      const recovered = await recoveredManager.recover();
      assert.equal(recovered.action, expectedAction);
      assert.equal(value.productStore.getAgentProfile("profile-switch").runtime, expectedRuntime);
      assert.equal(recoveredManager.journal.get(), null);
    } finally { recoveredManager.close(); }
  } finally {
    try { manager.close(); } catch {}
    value.cleanup();
  }
});

test("active side-effect Run 未 drain 时拒绝切换，重启恢复只标 interrupted 不重放", async () => {
  const value = fixture();
  const manager = value.createManager();
  try {
    value.productStore.putWorkRun({
      id: "run-active",
      source: "kanban",
      sourceId: "card-active",
      idempotencyKey: "runtime-switch-active-run",
      profileId: "profile-switch",
      workspace: "/tmp/runtime-switch-workspace",
      status: "running",
      contextSnapshotId: value.snapshot.id,
      runtimeSessionRef: {
        runtime: "codex",
        runtimeProfileId: "runtime-old",
        runtimeAccountId: value.productStore.getAgentProfile("profile-switch").runtimeAccountId,
        sessionId: "old-session",
      },
      runtimeTurnRef: {
        runtime: "codex",
        runtimeProfileId: "runtime-old",
        runtimeAccountId: value.productStore.getAgentProfile("profile-switch").runtimeAccountId,
        sessionId: "old-session",
        turnId: "old-turn",
      },
      eventSeq: 1,
      waitingRequestId: null,
      startedAt: value.now(),
      finishedAt: null,
      resultSummary: null,
      errorCode: null,
      retryOf: null,
    });
    await assert.rejects(
      manager.switchProfile(value.input()),
      (error) => error.code === "RUNTIME_SWITCH_ACTIVE_RUNS",
    );
    assert.equal(value.calls.length, 0);
    assert.equal(manager.journal.get(), null);
    const interrupted = value.productStore.recoverActiveRunAfterServiceRestart("run-active");
    assert.equal(interrupted.status, "interrupted");
    assert.equal(value.calls.length, 0, "恢复不得自动重放 side-effect Run");
  } finally { manager.close(); value.cleanup(); }
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS shoggoth runtime switch regression (${tests.length})`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
