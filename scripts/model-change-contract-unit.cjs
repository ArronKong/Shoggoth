#!/usr/bin/env node
"use strict";

// 模型变更契约单测：以串行执行器确保每个输入规范化与默认后端行为独立可定位。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentBackend } = require("../app/core/agent-backend");
const {
  ModelChangeError,
  normalizeModelChangeRequest,
  normalizeModelDeleteSpec,
  modelIdentityKey,
  modelChangeRequestDigest,
} = require("../app/core/model-change-validation");
const {
  computeCatalogRevision,
  normalizeCatalogRows,
} = require("../app/core/model-catalog-revision");
const { createEntry, createModelChangeJournal } = require("../app/core/model-change-journal");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");

const tests = [];

/** 注册一个按声明顺序执行的契约测试。 */
function test(name, fn) {
  tests.push({ name, fn });
}

/** 构造可由测试精确控制完成时点的 Promise。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 让并发协调器推进到指定条件，超过微任务上限即明确失败。 */
async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

/** 生成协调器测试使用的最小创建请求。 */
function coordinatorSpec(providerKey, modelId, extra = {}) {
  return {
    providerKey,
    providerMode: "existing",
    model: { id: modelId, name: modelId.toUpperCase() },
    ...extra,
  };
}

/** 创建真实 journal + fake backend/registry，确保测试穿过生产协调器与锁实现。 */
function createCoordinatorHarness({ now = () => 1_000, apply, recover } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-change-coordinator-"));
  const journal = createModelChangeJournal(path.join(directory, "journal.json"), { now });
  const state = {
    applyCalls: 0,
    previewCalls: 0,
    catalogCalls: 0,
    lastPreviewSpec: null,
    lastApplySpec: null,
    lastApplyContext: null,
    lastSecretEnvelope: null,
    nextPreview: null,
    nextApplyResult: null,
    nextApplyStatus: "applied",
    started: false,
    recoverCalls: [],
    lifecycle: [],
  };
  const backend = {
    id: "openclaw",
    async start() {
      state.started = true;
      state.lifecycle.push("registry.start");
      return true;
    },
    async getModelChangeCapabilities() {
      return { supported: true, create: true, update: true, rename: true, delete: true, blockers: [] };
    },
    async previewModelChange(safeSpec) {
      state.previewCalls += 1;
      state.lastPreviewSpec = safeSpec;
      return state.nextPreview || {
        references: [],
        blockers: [],
        runtimeApply: "hot",
        fingerprints: { config: `config:${safeSpec.providerKey}` },
      };
    },
    async applyModelChange(safeSpec, context, secretEnvelope) {
      state.applyCalls += 1;
      state.lastApplySpec = safeSpec;
      state.lastApplyContext = context;
      state.lastSecretEnvelope = secretEnvelope;
      if (apply) return apply(safeSpec, context, secretEnvelope, state);
      return state.nextApplyResult || { status: state.nextApplyStatus, stage: "verify-ready" };
    },
    async recoverModelChange(entry, context) {
      if (!state.started) throw new Error("backend recovery before start");
      state.recoverCalls.push({ entry, context });
      state.lifecycle.push(`recover:${entry.operationId}`);
      if (recover) return recover(entry, context, state);
      return { status: "applied", stage: "verify-ready" };
    },
  };
  const registry = {
    _activeGet(backendId) {
      return backendId === backend.id ? backend : null;
    },
    async listModelsSnapshot(backendId, options) {
      state.catalogCalls += 1;
      state.lastCatalogRequest = { backendId, options };
      return {
        models: [{ id: "model-applied", name: "Applied", provider: "alpha", backendId }],
        catalogRevision: "a".repeat(64),
      };
    },
  };
  const coordinator = new ModelChangeCoordinator({
    registry,
    journal,
    now,
    tokenSecret: Buffer.alloc(32, 7),
  });
  return {
    coordinator,
    journal,
    backend,
    registry,
    state,
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

/** 在真实 journal 中建立恢复用 operation，并按需要推进 commitState/status。 */
async function seedRecoveryEntry(journal, {
  operationId,
  providerKey,
  commitState = "precommit",
  status = "in_progress",
}) {
  await journal.withExclusiveLock(`seed:${operationId}`, () => {
    journal.begin(createEntry({
      operationId,
      requestDigest: operationId.padEnd(64, "0").slice(0, 64),
      previewTokenDigest: operationId.padEnd(64, "f").slice(0, 64),
      backendId: "openclaw",
      providerKey,
      kind: "rename",
      source: { provider: providerKey, modelId: "old" },
      target: { provider: providerKey, modelId: "new" },
      fingerprints: { config: `before:${providerKey}` },
      modelDiff: {
        before: { id: "old", provider: providerKey, backendId: "openclaw" },
        after: { id: "new", provider: providerKey, backendId: "openclaw" },
      },
    }, 1_000));
    if (["committing", "committed"].includes(commitState)) {
      journal.setStage(operationId, "commit-retire", { commitState: "committing" });
    }
    if (commitState === "committed") {
      journal.setStage(operationId, "cleanup", { commitState: "committed", status });
    } else if (status !== "in_progress") {
      journal.setStage(operationId, "recover", { status });
    }
  });
}

test("规范化保留完整编辑字段并生成复合身份", () => {
  const { safeSpec: spec, secretEnvelope } = normalizeModelChangeRequest({
    providerKey: "alpha",
    providerMode: "existing",
    sourceModelId: "old",
    model: { id: "new", name: "New", contextWindow: 8192, maxTokens: 1024, reasoning: false },
  });

  assert.deepEqual(spec.model, { id: "new", name: "New", contextWindow: 8192, maxTokens: 1024, reasoning: false });
  assert.equal(spec.sourceKey, modelIdentityKey("alpha", "old"));
  assert.equal(spec.targetKey, modelIdentityKey("alpha", "new"));
  assert.equal(spec.model.reasoning, false);
  assert.equal(secretEnvelope, null);
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.model), true);
});

test("删除模型与删除 Provider 生成不含 target 的明确 kind", () => {
  const deleteModel = normalizeModelDeleteSpec({ providerKey: "alpha", modelId: "m" });
  const deleteProvider = normalizeModelDeleteSpec({ providerKey: "alpha" });

  assert.equal(deleteModel.kind, "delete-model");
  assert.equal(deleteModel.sourceKey, modelIdentityKey("alpha", "m"));
  assert.equal(deleteProvider.kind, "delete-provider");
  assert.equal(deleteProvider.sourceKey, modelIdentityKey("alpha", "*"));
  assert.equal(deleteProvider.target, null);
});

test("create-new 与 create-existing 明确区分且摘要排除 secret", () => {
  const base = {
    providerKey: "alpha",
    providerMode: "new",
    baseUrl: "https://api.example.com/v1",
    model: { id: "m" },
  };
  const first = normalizeModelChangeRequest({ ...base, apiKey: "secret-one" });
  const second = normalizeModelChangeRequest({ ...base, apiKey: "secret-two" });

  assert.equal(first.safeSpec.kind, "create");
  assert.equal(first.safeSpec.providerMode, "new");
  assert.deepEqual(first.secretEnvelope, { apiKey: "secret-one" });
  assert.equal("apiKey" in first.safeSpec, false);
  assert.equal(modelChangeRequestDigest(first.safeSpec), modelChangeRequestDigest(second.safeSpec));
  assert.throws(
    () => normalizeModelChangeRequest({ ...base, sourceModelId: "old" }),
    (err) => err instanceof ModelChangeError && err.code === "provider_locked" && err.field === "providerKey",
  );
});

test("非法 URL、空 ID、非正整数或非整数返回安全的字段级错误", () => {
  for (const input of [
    { providerKey: "alpha", model: { id: "", contextWindow: 1 } },
    { providerKey: "alpha", baseUrl: "ftp://secret@example.com", model: { id: "m" } },
    { providerKey: "alpha", model: { id: "m", contextWindow: 0 } },
    { providerKey: "alpha", model: { id: "m", maxTokens: 1.5 } },
  ]) {
    assert.throws(() => normalizeModelChangeRequest(input), (err) => {
      assert.equal(err instanceof ModelChangeError, true);
      assert.equal(typeof err.code, "string");
      assert.equal(typeof err.field, "string");
      assert.equal(String(err.message).includes("secret@example.com"), false);
      return true;
    });
  }
});

test("模型 token 上限只接受安全正整数或严格十进制字符串", () => {
  for (const field of ["contextWindow", "maxTokens"]) {
    for (const value of [true, [1], {}, 1.5, "1.5", "1e3", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => normalizeModelChangeRequest({ providerKey: "alpha", model: { id: "m", [field]: value } }),
        (err) => err instanceof ModelChangeError && err.code === "positive_integer" && err.field === `model.${field}`,
      );
    }
  }

  const { safeSpec } = normalizeModelChangeRequest({
    providerKey: "alpha",
    model: { id: "m", contextWindow: "8192", maxTokens: 1024 },
  });
  assert.equal(safeSpec.model.contextWindow, 8192);
  assert.equal(safeSpec.model.maxTokens, 1024);
});

test("变更与删除请求拒绝非普通对象输入并返回字段级错误", () => {
  for (const normalize of [normalizeModelChangeRequest, normalizeModelDeleteSpec]) {
    for (const input of [null, [], "invalid", 1, true]) {
      assert.throws(
        () => normalize(input),
        (err) => err instanceof ModelChangeError && err.code === "invalid_input" && err.field === "input",
      );
    }
  }
});

test("请求摘要对对象键顺序稳定并拒绝 safeSpec 顶层 secret", () => {
  assert.equal(
    modelChangeRequestDigest({ providerKey: "alpha", model: { id: "m", name: "M" } }),
    modelChangeRequestDigest({ model: { name: "M", id: "m" }, providerKey: "alpha" }),
  );
  assert.throws(
    () => modelChangeRequestDigest({ apiKey: "not-allowed" }),
    (err) => err instanceof ModelChangeError && err.code === "secret_in_safe_spec",
  );
});

test("目录 revision 对对象键序与行序稳定，并输出严格 SHA-256 hex", () => {
  const first = computeCatalogRevision({
    backendId: "openclaw",
    config: [
      { id: "b", provider: "beta", backendId: "openclaw", pricing: { output: 2, input: 1 } },
      { provider: "alpha", id: "a", backendId: "openclaw", reasoning: true },
    ],
    runtime: [{ id: "runtime", provider: "alpha", backendId: "openclaw" }],
  });
  const reordered = computeCatalogRevision({
    runtime: [{ backendId: "openclaw", provider: "alpha", id: "runtime" }],
    config: [
      { reasoning: true, backendId: "openclaw", id: "a", provider: "alpha" },
      { pricing: { input: 1, output: 2 }, backendId: "openclaw", provider: "beta", id: "b" },
    ],
    backendId: "openclaw",
  });

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(reordered, first);
});

test("目录 revision 覆盖 backend、config/runtime 与配置专属 maxTokens 变化", () => {
  const base = {
    backendId: "openclaw",
    config: [{ id: "model-a", provider: "alpha", maxTokens: 1024 }],
    runtime: [{ id: "model-a", provider: "alpha", contextWindow: 8192 }],
  };
  const initial = computeCatalogRevision(base);

  assert.notEqual(computeCatalogRevision({ ...base, backendId: "hermes" }), initial);
  assert.notEqual(
    computeCatalogRevision({
      ...base,
      config: [{ id: "model-a", provider: "alpha", maxTokens: 2048 }],
    }),
    initial,
  );
  assert.notEqual(
    computeCatalogRevision({
      ...base,
      runtime: [{ id: "model-a", provider: "alpha", contextWindow: 16384 }],
    }),
    initial,
  );
  assert.notEqual(
    computeCatalogRevision({
      ...base,
      config: [{ ...base.config[0], providerConfigDigest: "b".repeat(64) }],
    }),
    initial,
    "Provider baseUrl/api 的安全摘要变化必须推进 revision",
  );
});

test("目录 revision 保留 profile 身份并感知模型跨 profile 迁移", () => {
  const inAlpha = {
    backendId: "hermes",
    config: [{ id: "model-a", provider: "alpha", profile: "profile-a" }],
    runtime: [{ id: "model-a", provider: "alpha", profile: "profile-a" }],
  };
  const inBeta = {
    ...inAlpha,
    config: [{ id: "model-a", provider: "alpha", profile: "profile-b" }],
    runtime: [{ id: "model-a", provider: "alpha", profile: "profile-b" }],
  };

  assert.deepEqual(normalizeCatalogRows(inAlpha.config), [
    { id: "model-a", profile: "profile-a", provider: "alpha" },
  ]);
  assert.notEqual(computeCatalogRevision(inAlpha), computeCatalogRevision(inBeta));
  assert.notEqual(
    computeCatalogRevision({
      ...inAlpha,
      runtime: [{ ...inAlpha.runtime[0], modelScopes: ["profile-a"] }],
    }),
    computeCatalogRevision({
      ...inAlpha,
      runtime: [{ ...inAlpha.runtime[0], modelScopes: ["profile-b"] }],
    }),
    "共享 provider 下的 Agent Profile 模型边界变化必须推进 revision",
  );
});

test("聚合 revision 保留行 backendId，跨 backend 重排行仍稳定", () => {
  const config = [
    { id: "shared", provider: "alpha", backendId: "openclaw" },
    { id: "shared", provider: "alpha", backendId: "hermes" },
  ];
  const forward = computeCatalogRevision({ backendId: "all", config, runtime: [] });
  const reversed = computeCatalogRevision({ backendId: "all", config: [...config].reverse(), runtime: [] });
  const missingIdentity = computeCatalogRevision({
    backendId: "all",
    config: config.map(({ backendId, ...row }) => row),
    runtime: [],
  });

  assert.equal(reversed, forward);
  assert.notEqual(missingIdentity, forward);
});

test("目录 canonical 仅保留白名单字段，并递归排除 secret 与 URL", () => {
  const normalized = normalizeCatalogRows([
    {
      id: "model-a",
      name: "Model A",
      provider: "alpha",
      backendId: "openclaw",
      contextWindow: 8192,
      maxTokens: 1024,
      reasoning: true,
      modelScopes: ["profile-a", "profile-b"],
      defaultModelScopes: ["profile-a"],
      pricing: {
        output: 2,
        input: 1,
        Authorization: "Bearer nested-secret",
        baseUrl: "https://nested-secret@example.com/v1",
      },
      acpProviderRef: "custom:alpha",
      providerConfigDigest: "d".repeat(64),
      apiKey: "top-level-secret",
      token: "top-level-token",
      Authorization: "Bearer top-level-secret",
      baseUrl: "https://user:password@example.com/v1",
      endpoint: "https://another.example.com/v1",
    },
  ]);

  assert.deepEqual(normalized, [
    {
      acpProviderRef: "custom:alpha",
      backendId: "openclaw",
      contextWindow: 8192,
      id: "model-a",
      maxTokens: 1024,
      defaultModelScopes: ["profile-a"],
      modelScopes: ["profile-a", "profile-b"],
      name: "Model A",
      pricing: { input: 1, output: 2 },
      providerConfigDigest: "d".repeat(64),
      provider: "alpha",
      reasoning: true,
    },
  ]);
  const canonical = JSON.stringify(normalized);
  for (const forbidden of [
    "top-level-secret",
    "top-level-token",
    "nested-secret",
    "user:password",
    "https://",
    "apiKey",
    "Authorization",
    "baseUrl",
    "api.example.com",
  ]) {
    assert.equal(canonical.includes(forbidden), false, `canonical 不得包含 ${forbidden}`);
  }

  const safeDigest = computeCatalogRevision({ backendId: "openclaw", config: normalized, runtime: [] });
  const secretChanged = computeCatalogRevision({
    backendId: "openclaw",
    config: [{ ...normalized[0], apiKey: "changed-secret", token: "changed-token" }],
    runtime: [],
  });
  assert.equal(secretChanged, safeDigest);
});

test("AgentBackend 默认模型变更能力明确为 unsupported", async () => {
  class TestBackend extends AgentBackend {
    get id() { return "test"; }
  }
  const backend = new TestBackend();

  assert.deepEqual(await backend.getModelChangeCapabilities(), {
    supported: false,
    create: false,
    update: false,
    rename: false,
    delete: false,
    updateProvider: false,
    manageAuthProfiles: false,
    blockers: ["unsupported"],
  });
  await assert.rejects(backend.getModelCatalogSources(), /test: fresh model catalog sources not supported/);
  await assert.rejects(backend.previewModelChange(), /test: previewModelChange\(\) not supported/);
  await assert.rejects(backend.applyModelChange(), /test: applyModelChange\(\) not supported/);
  await assert.rejects(backend.recoverModelChange(), /test: recoverModelChange\(\) not supported/);
});

test("Coordinator 同 backend+provider 串行，不同 provider 可并发", async () => {
  const sameGate = deferred();
  const same = createCoordinatorHarness({
    apply: async () => {
      await sameGate.promise;
      return { status: "applied", stage: "verify-ready" };
    },
  });
  try {
    const firstSpec = coordinatorSpec("alpha", "first");
    const secondSpec = coordinatorSpec("alpha", "second");
    const firstPreview = await same.coordinator.preview("openclaw", firstSpec);
    const secondPreview = await same.coordinator.preview("openclaw", secondSpec);
    const first = same.coordinator.apply("openclaw", firstSpec, {
      previewToken: firstPreview.previewToken,
      operationId: "same-provider-first",
    });
    await waitUntil(() => same.state.applyCalls === 1, "第一个同 Provider apply 未进入 backend");
    const second = same.coordinator.apply("openclaw", secondSpec, {
      previewToken: secondPreview.previewToken,
      operationId: "same-provider-second",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(same.state.applyCalls, 1);
    sameGate.resolve();
    await Promise.all([first, second]);
    assert.equal(same.state.applyCalls, 2);
  } finally {
    same.cleanup();
  }

  const parallelGate = deferred();
  let active = 0;
  let maxActive = 0;
  const parallel = createCoordinatorHarness({
    apply: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await parallelGate.promise;
      active -= 1;
      return { status: "applied", stage: "verify-ready" };
    },
  });
  try {
    const alpha = coordinatorSpec("alpha", "model-a");
    const beta = coordinatorSpec("beta", "model-b");
    const alphaPreview = await parallel.coordinator.preview("openclaw", alpha);
    const betaPreview = await parallel.coordinator.preview("openclaw", beta);
    const alphaApply = parallel.coordinator.apply("openclaw", alpha, {
      previewToken: alphaPreview.previewToken,
      operationId: "parallel-alpha",
    });
    const betaApply = parallel.coordinator.apply("openclaw", beta, {
      previewToken: betaPreview.previewToken,
      operationId: "parallel-beta",
    });
    await waitUntil(() => parallel.state.applyCalls === 2, "不同 Provider 未并发进入 backend");
    assert.equal(maxActive, 2);
    parallelGate.resolve();
    await Promise.all([alphaApply, betaApply]);
  } finally {
    parallel.cleanup();
  }
});

test("Coordinator operationId 幂等且 preview token 只能绑定一个 operation", async () => {
  let currentTime = 1_000;
  const harness = createCoordinatorHarness({ now: () => currentTime });
  try {
    const spec = coordinatorSpec("alpha", "stable");
    const preview = await harness.coordinator.preview("openclaw", spec);
    const first = await harness.coordinator.apply("openclaw", spec, {
      previewToken: preview.previewToken,
      operationId: "stable-operation",
    });
    currentTime += 60 * 60 * 1000;
    const replay = await harness.coordinator.apply("openclaw", spec, {
      previewToken: preview.previewToken,
      operationId: "stable-operation",
    });
    assert.deepEqual(replay, first);
    assert.equal(harness.state.applyCalls, 1);

    await assert.rejects(
      harness.coordinator.apply("openclaw", coordinatorSpec("alpha", "different"), {
        previewToken: preview.previewToken,
        operationId: "stable-operation",
      }),
      (error) => error?.code === "operation_reused" && error?.status === 409,
    );
    await assert.rejects(
      harness.coordinator.apply("openclaw", spec, {
        previewToken: preview.previewToken,
        operationId: "different-operation",
      }),
      (error) => error?.code === "preview_reused" && error?.status === 409,
    );
  } finally {
    harness.cleanup();
  }
});

test("Coordinator token、journal、backend context 不接收 secret，Provider guard 必须可 checkpoint", async () => {
  let guardChecks = 0;
  const harness = createCoordinatorHarness({
    apply: async (_safeSpec, context, secretEnvelope) => {
      assert.equal(typeof context.assertProviderLease, "function");
      assert.equal(context.providerLeaseSignal.aborted, false);
      context.assertProviderLease();
      guardChecks += 1;
      assert.deepEqual(secretEnvelope, { apiKey: "top-secret-value" });
      return { status: "applied", stage: "verify-ready" };
    },
  });
  try {
    const rawSpec = coordinatorSpec("alpha", "secret-model", { apiKey: "top-secret-value" });
    const preview = await harness.coordinator.preview("openclaw", rawSpec);
    assert.equal(JSON.stringify(harness.state.lastPreviewSpec).includes("top-secret-value"), false);
    const result = await harness.coordinator.apply("openclaw", rawSpec, {
      previewToken: preview.previewToken,
      operationId: "secret-operation",
    });
    assert.equal(result.status, "applied");
    assert.equal(guardChecks, 1);
    assert.equal(JSON.stringify(harness.state.lastApplySpec).includes("top-secret-value"), false);
    assert.equal(JSON.stringify(harness.state.lastApplyContext).includes("top-secret-value"), false);
    assert.equal(JSON.stringify(harness.journal.get("secret-operation")).includes("top-secret-value"), false);
  } finally {
    harness.cleanup();
  }
});

test("Coordinator 只有 applied 附 strict catalog，partial 不生成伪目录", async () => {
  const harness = createCoordinatorHarness();
  try {
    const appliedSpec = coordinatorSpec("alpha", "applied");
    const appliedPreview = await harness.coordinator.preview("openclaw", appliedSpec);
    const applied = await harness.coordinator.apply("openclaw", appliedSpec, {
      previewToken: appliedPreview.previewToken,
      operationId: "catalog-applied",
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.operationId, "catalog-applied");
    assert.deepEqual(applied.catalog.models, [{
      id: "model-applied", name: "Applied", provider: "alpha", backendId: "openclaw",
    }]);
    assert.equal(applied.catalog.catalogRevision, "a".repeat(64));
    assert.deepEqual(harness.state.lastCatalogRequest, {
      backendId: "openclaw", options: { fresh: true },
    });

    harness.state.nextApplyResult = {
      status: "partial",
      stage: "runtime",
      catalog: { models: [{ id: "backend-unverified" }], catalogRevision: "unverified" },
    };
    const partialSpec = coordinatorSpec("alpha", "partial");
    const partialPreview = await harness.coordinator.preview("openclaw", partialSpec);
    const partial = await harness.coordinator.apply("openclaw", partialSpec, {
      previewToken: partialPreview.previewToken,
      operationId: "catalog-partial",
    });
    assert.equal(partial.status, "partial");
    assert.equal(partial.operationId, "catalog-partial");
    assert.equal("catalog" in partial, false);
    assert.equal(harness.state.catalogCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test("Coordinator 非终态重试以 journal 为真值走 recover，不重新 preview/apply secret", async () => {
  let currentTime = 1_000;
  const harness = createCoordinatorHarness({
    now: () => currentTime,
    apply: async (_safeSpec, context, secretEnvelope, state) => {
      if (state.applyCalls === 1) {
        assert.deepEqual(secretEnvelope, { apiKey: "retry-secret-value" });
        await context.recordStage("provider-secret", { secretStep: "applied" });
        return { status: "partial", code: "runtime_pending", stage: "runtime" };
      }
      assert.equal(secretEnvelope, null);
      return { status: "applied", stage: "verify-ready" };
    },
  });
  try {
    await harness.backend.start();
    const spec = coordinatorSpec("alpha", "retry-model", { apiKey: "retry-secret-value" });
    const preview = await harness.coordinator.preview("openclaw", spec);
    const first = await harness.coordinator.apply("openclaw", spec, {
      previewToken: preview.previewToken,
      operationId: "partial-retry",
    });
    assert.equal(first.status, "partial");

    // 首次 apply 已改变存储指纹且 token 已过期；既有 journal 必须继续该 operation，不能当作新预检拒绝。
    currentTime += 60 * 60 * 1000;
    harness.state.nextPreview = {
      references: [], blockers: [], runtimeApply: "hot", fingerprints: { config: "changed-by-operation" },
    };
    const retried = await harness.coordinator.apply("openclaw", spec, {
      previewToken: preview.previewToken,
      operationId: "partial-retry",
    });
    assert.equal(retried.status, "applied");
    assert.equal(harness.state.previewCalls, 2);
    assert.equal(harness.state.applyCalls, 1);
    assert.equal(harness.state.recoverCalls.length, 1);
    assert.equal(harness.state.recoverCalls[0].entry.operationId, "partial-retry");
  } finally {
    harness.cleanup();
  }
});

test("Coordinator secretStep pending 在空凭证重试和启动恢复时只能进入 needs_secret", async () => {
  const harness = createCoordinatorHarness({
    apply: async () => ({ status: "partial", code: "profile_partial", stage: "stage-target" }),
  });
  try {
    await harness.backend.start();
    const withSecret = coordinatorSpec("alpha", "secret-model", { apiKey: "ephemeral-secret" });
    const preview = await harness.coordinator.preview("openclaw", withSecret);
    const first = await harness.coordinator.apply("openclaw", withSecret, {
      previewToken: preview.previewToken,
      operationId: "pending-secret-op",
    });
    assert.equal(first.status, "partial");
    assert.equal(harness.journal.get("pending-secret-op").secretStep, "pending");

    const withoutSecret = coordinatorSpec("alpha", "secret-model");
    const retry = await harness.coordinator.apply("openclaw", withoutSecret, {
      operationId: "pending-secret-op",
    });
    assert.equal(retry.status, "needs_secret");
    assert.equal(harness.state.applyCalls, 1);
    assert.equal(harness.state.recoverCalls.length, 0);

    // 新进程启动恢复同样不得调用 backend recover 并伪报公开配置已收敛。
    await harness.journal.withExclusiveLock("reset-needs-secret", () => {
      harness.journal.setStage("pending-secret-op", "stage-target", { status: "partial" });
    });
    const restarted = new ModelChangeCoordinator({
      registry: harness.registry,
      journal: harness.journal,
      now: () => 2_000,
      tokenSecret: Buffer.alloc(32, 11),
    });
    const recovered = await restarted.recoverPending();
    assert.equal(recovered[0].result.status, "needs_secret");
    assert.equal(harness.state.recoverCalls.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("Coordinator cleanup_pending 同 operationId 重试必须走 forward-only recover", async () => {
  const harness = createCoordinatorHarness({
    apply: async () => ({ status: "cleanup_pending", code: "runtime_ghost", stage: "commit-retire" }),
    recover: async (_entry, context) => {
      assert.equal(context.recoveryMode, "forward-only");
      assert.equal(context.forwardOnly, true);
      return { status: "applied", stage: "recovery" };
    },
  });
  try {
    await harness.backend.start();
    const spec = coordinatorSpec("alpha", "cleanup-model");
    const preview = await harness.coordinator.preview("openclaw", spec);
    const first = await harness.coordinator.apply("openclaw", spec, {
      previewToken: preview.previewToken,
      operationId: "cleanup-retry",
    });
    assert.equal(first.status, "cleanup_pending");
    const recovered = await harness.coordinator.apply("openclaw", spec, {
      previewToken: preview.previewToken,
      operationId: "cleanup-retry",
    });
    assert.equal(recovered.status, "applied");
    assert.equal(harness.state.previewCalls, 2);
    assert.equal(harness.state.applyCalls, 1);
    assert.equal(harness.state.recoverCalls.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("Coordinator compat blocker 零写，Provider 更新 secret 仍仅走第三参数", async () => {
  const blocked = createCoordinatorHarness();
  try {
    blocked.state.nextPreview = {
      references: [], runtimeApply: "unsupported", fingerprints: { config: "blocked" },
      blockers: [{ code: "runtime_busy", stage: "preflight" }],
    };
    const result = await blocked.coordinator.applyCompat(
      "openclaw",
      coordinatorSpec("alpha", "blocked-model"),
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "runtime_busy");
    assert.equal(blocked.state.applyCalls, 0);
  } finally {
    blocked.cleanup();
  }

  const provider = createCoordinatorHarness();
  try {
    provider.state.nextPreview = {
      references: [], blockers: [], runtimeApply: "hot", fingerprints: { config: "provider-before" },
      providerDiff: { beforeDigest: "1".repeat(64), afterDigest: "2".repeat(64) },
    };
    const result = await provider.coordinator.updateProviderCompat("openclaw", "alpha", {
      baseUrl: "https://api.example.com/v1",
      apiKey: "provider-secret-value",
      clearBaseUrl: false,
    }, { operationId: "provider-update" });
    assert.equal(result.status, "applied");
    assert.equal(provider.state.lastApplySpec.kind, "update-provider");
    assert.equal("apiKey" in provider.state.lastApplySpec, false);
    assert.deepEqual(provider.state.lastSecretEnvelope, { apiKey: "provider-secret-value" });
    const providerEntry = provider.journal.get("provider-update");
    assert.deepEqual(providerEntry.providerDiff, {
      beforeDigest: "1".repeat(64),
      afterDigest: "2".repeat(64),
    });
    assert.equal(JSON.stringify(providerEntry).includes("provider-secret-value"), false);
    assert.equal(JSON.stringify(providerEntry).includes("api.example.com"), false);

    const cleared = await provider.coordinator.updateProviderCompat("openclaw", "alpha", {
      clearBaseUrl: true,
    }, { operationId: "provider-clear-base-url" });
    assert.equal(cleared.status, "applied");
    assert.deepEqual(provider.state.lastApplySpec.patch, { clearBaseUrl: true });
  } finally {
    provider.cleanup();
  }
});

test("Coordinator journal 的 modelDiff.before 保存 preview 返回的完整公开源快照", async () => {
  const harness = createCoordinatorHarness();
  try {
    harness.state.nextPreview = {
      references: [], blockers: [], runtimeApply: "hot", fingerprints: { config: "source-before" },
      sourceSnapshot: {
        id: "same", name: "Before", contextWindow: 4096, maxTokens: 512, reasoning: false,
      },
    };
    const result = await harness.coordinator.applyCompat("openclaw", coordinatorSpec("alpha", "same", {
      sourceModelId: "same",
      model: { id: "same", name: "After", contextWindow: 8192, maxTokens: 1024, reasoning: true },
    }), { operationId: "source-snapshot" });
    assert.equal(result.status, "applied");
    assert.deepEqual(harness.journal.get("source-snapshot").modelDiff.before, {
      id: "same",
      name: "Before",
      contextWindow: 4096,
      maxTokens: 512,
      reasoning: false,
      provider: "alpha",
      backendId: "openclaw",
    });
  } finally {
    harness.cleanup();
  }
});

test("Coordinator recovery 必须晚于 backend start，且 committed 只进入 forward-only", async () => {
  const harness = createCoordinatorHarness({
    recover: async (entry, context) => {
      assert.equal(typeof context.assertProviderLease, "function");
      assert.equal(context.providerLeaseSignal.aborted, false);
      if (entry.commitState === "committed" || entry.status === "cleanup_pending") {
        assert.equal(context.recoveryMode, "forward-only");
        assert.equal(context.forwardOnly, true);
      } else if (entry.commitState === "committing") {
        assert.equal(context.recoveryMode, "resolve-commit");
        assert.equal(context.forwardOnly, false);
      } else {
        assert.equal(context.recoveryMode, "precommit");
        assert.equal(context.forwardOnly, false);
      }
      return { status: "applied", stage: "verify-ready" };
    },
  });
  try {
    await seedRecoveryEntry(harness.journal, {
      operationId: "recover-precommit", providerKey: "alpha", commitState: "precommit",
    });
    await seedRecoveryEntry(harness.journal, {
      operationId: "recover-committing", providerKey: "beta", commitState: "committing",
    });
    await seedRecoveryEntry(harness.journal, {
      operationId: "recover-committed", providerKey: "gamma", commitState: "committed", status: "cleanup_pending",
    });

    const beforeStart = await harness.coordinator.recoverPending();
    assert.equal(beforeStart.length, 3);
    assert.equal(beforeStart.every((item) => item.result?.code === "recovery_failed"), true);
    assert.equal(harness.coordinator.isReady(), false);

    harness.state.recoverCalls.length = 0;
    harness.state.lifecycle.length = 0;
    await harness.backend.start();
    const results = await harness.coordinator.recoverPending();
    assert.equal(results.length, 3);
    assert.deepEqual(harness.state.lifecycle, [
      "registry.start",
      "recover:recover-committed",
      "recover:recover-committing",
      "recover:recover-precommit",
    ]);
    assert.equal(harness.coordinator.isReady(), false, "recoverPending 不得自行越过入口编排标 ready");
    harness.state.lifecycle.push("coordinator.markReady");
    harness.coordinator.markReady();
    assert.equal(harness.coordinator.isReady(), true);
    assert.doesNotThrow(() => harness.coordinator.requireReady());

    const committed = harness.state.recoverCalls.find((call) => call.entry.operationId === "recover-committed");
    assert.equal(committed.context.forwardOnly, true, "提交点后不得暴露补偿/恢复旧 ID 模式");
    assert.equal(harness.journal.listPending().length, 0);
  } finally {
    harness.cleanup();
  }
});

test("Coordinator 将未收敛 journal 隔离在原 Provider，不让单条 operation 全局永久阻断 readiness", async () => {
  const harness = createCoordinatorHarness({
    recover: async (entry) => (
      entry.operationId === "recover-invalid"
        ? {}
        : { status: "partial", code: "manual_check", stage: "recovery" }
    ),
  });
  try {
    await seedRecoveryEntry(harness.journal, {
      operationId: "recover-partial", providerKey: "alpha", commitState: "precommit",
    });
    await seedRecoveryEntry(harness.journal, {
      operationId: "recover-secret", providerKey: "beta", commitState: "precommit", status: "needs_secret",
    });
    await seedRecoveryEntry(harness.journal, {
      operationId: "recover-invalid", providerKey: "gamma", commitState: "committing",
    });
    await harness.backend.start();
    const results = await harness.coordinator.recoverPending();
    assert.equal(results.length, 3);
    assert.equal(harness.coordinator.isReady(), false);
    assert.equal(harness.state.recoverCalls.some((call) => call.entry.operationId === "recover-secret"), false);
    assert.equal(harness.journal.get("recover-partial").status, "partial");
    assert.equal(harness.journal.get("recover-secret").status, "needs_secret");
    assert.equal(harness.journal.get("recover-invalid").status, "partial");
    assert.equal(harness.journal.get("recover-invalid").result.code, "recovery_invalid_result");
    harness.coordinator.markReady();
    assert.doesNotThrow(() => harness.coordinator.requireReady());

    const pendingSpec = coordinatorSpec("alpha", "new-after-unresolved");
    const preview = await harness.coordinator.preview("openclaw", pendingSpec);
    await assert.rejects(
      harness.coordinator.apply("openclaw", pendingSpec, {
        previewToken: preview.previewToken,
        operationId: "new-after-unresolved",
      }),
      (error) => error?.code === "provider_change_pending" && error?.status === 409,
    );
  } finally {
    harness.cleanup();
  }
});

test("Coordinator 重启后既有非终态 operation 仅凭 journal 摘要续跑，不要求旧进程 token", async () => {
  const harness = createCoordinatorHarness();
  try {
    await harness.backend.start();
    const spec = coordinatorSpec("alpha", "restart-model");
    const preview = await harness.coordinator.preview("openclaw", spec);
    harness.state.nextApplyStatus = "partial";
    const first = await harness.coordinator.apply("openclaw", spec, {
      previewToken: preview.previewToken,
      operationId: "restart-operation",
    });
    assert.equal(first.status, "partial");

    harness.state.nextApplyStatus = "applied";
    const restarted = new ModelChangeCoordinator({
      registry: harness.registry,
      journal: harness.journal,
      now: () => 10_000,
      tokenSecret: Buffer.alloc(32, 9),
    });
    const result = await restarted.apply("openclaw", spec, { operationId: "restart-operation" });
    assert.equal(result.status, "applied");
    assert.equal(harness.state.applyCalls, 1);
    assert.equal(harness.state.recoverCalls.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("Coordinator 同 Provider 存在其它非终态 journal 时拒绝新 operation", async () => {
  const harness = createCoordinatorHarness();
  try {
    const firstSpec = coordinatorSpec("alpha", "pending-model");
    const firstPreview = await harness.coordinator.preview("openclaw", firstSpec);
    harness.state.nextApplyStatus = "partial";
    await harness.coordinator.apply("openclaw", firstSpec, {
      previewToken: firstPreview.previewToken,
      operationId: "provider-pending",
    });

    harness.state.nextApplyStatus = "applied";
    const secondSpec = coordinatorSpec("alpha", "new-model");
    const secondPreview = await harness.coordinator.preview("openclaw", secondSpec);
    await assert.rejects(
      harness.coordinator.apply("openclaw", secondSpec, {
        previewToken: secondPreview.previewToken,
        operationId: "provider-new-operation",
      }),
      (error) => error?.code === "provider_change_pending" && error?.status === 409,
    );
    assert.equal(harness.state.applyCalls, 1, "新 operation 不得越过旧非终态进入 backend 写入");
  } finally {
    harness.cleanup();
  }
});

/** 给 harness backend 挂 config-only 降级契约；activation 与 bypass 由用例覆盖。 */
function armConfigOnly(harness, { activation = { kind: "gateway_restart" }, caps = {} } = {}) {
  const { backend, state } = harness;
  state.configOnlyCalls = 0;
  state.configOnlyRecoverCalls = 0;
  backend.getModelConfigWriteCapabilities = async () => ({
    supported: true, create: true, update: true, delete: true, updateProvider: true,
    activation, bypassBlockerCodes: ["runtime_apply_unsupported"], blockers: [], ...caps,
  });
  backend.applyModelChangeConfigOnly = async (safeSpec, context, secretEnvelope) => {
    state.configOnlyCalls += 1;
    state.lastConfigOnlySpec = safeSpec;
    state.lastConfigOnlySecret = secretEnvelope;
    return { status: "applied", stage: "config-write" };
  };
  backend.recoverModelChangeConfigOnly = async (entry) => {
    state.configOnlyRecoverCalls += 1;
    state.lastConfigOnlyRecoverEntry = entry;
    return { status: "applied", stage: "recovery" };
  };
}

const CAPABILITY_BLOCKER = { code: "runtime_apply_unsupported", store: "runtime", message: "运行时变更能力不可用" };

test("能力类 blocker + configWrite 支持时 applyCompat 降级为 config-only 并附 activation", async () => {
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    harness.state.nextPreview = {
      references: [], blockers: [CAPABILITY_BLOCKER], runtimeApply: "blocked",
      fingerprints: { config: "config:alpha" },
    };
    const result = await harness.coordinator.applyCompat("openclaw", {
      providerKey: "alpha", baseUrl: "https://api.example.com/v1", providerMode: "new",
      model: { id: "m-co" }, apiKey: "secret-co",
    }, { operationId: "co-op-1" });
    assert.equal(result.status, "applied");
    assert.deepEqual(result.activation, { kind: "gateway_restart" });
    assert.equal(harness.state.configOnlyCalls, 1);
    assert.equal(harness.state.applyCalls, 0, "完整 applyModelChange 不得被调用");
    assert.deepEqual(harness.state.lastConfigOnlySecret, { apiKey: "secret-co" });
    assert.equal(JSON.stringify(harness.state.lastConfigOnlySpec).includes("secret-co"), false);
    assert.equal(harness.journal.get("co-op-1").mode, "config-only");
    assert.equal(harness.journal.get("co-op-1").status, "applied");
    // 同 operationId + 同请求重放返回同一终态，不再触发第二次配置写
    const replay = await harness.coordinator.applyCompat("openclaw", {
      providerKey: "alpha", baseUrl: "https://api.example.com/v1", providerMode: "new",
      model: { id: "m-co" }, apiKey: "secret-co",
    }, { operationId: "co-op-1" });
    assert.equal(replay.status, "applied");
    assert.equal(harness.state.configOnlyCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test("冲突类 blocker 混入或 rename kind 时绝不降级 config-only", async () => {
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    harness.state.nextPreview = {
      references: [], blockers: [CAPABILITY_BLOCKER, { code: "target_conflict", store: "config", message: "目标模型已存在" }],
      runtimeApply: "blocked", fingerprints: { config: "config:alpha" },
    };
    const conflicted = await harness.coordinator.applyCompat("openclaw", {
      providerKey: "alpha", model: { id: "m-dup" },
    }, { operationId: "co-op-2" });
    assert.equal(conflicted.status, "blocked");
    // 顶层 code 必须挑最有信息量的硬拦截(重名),不能被排在前面的环境类
    // 警告(runtime_apply_unsupported)顶掉——否则 UI 只能显示笼统文案
    assert.equal(conflicted.code, "target_conflict");
    assert.equal(harness.state.configOnlyCalls, 0);

    harness.state.nextPreview = {
      references: [], blockers: [CAPABILITY_BLOCKER], runtimeApply: "blocked",
      fingerprints: { config: "config:alpha" },
    };
    const renamed = await harness.coordinator.applyCompat("openclaw", {
      providerKey: "alpha", sourceModelId: "m-old", model: { id: "m-new" },
    }, { operationId: "co-op-3" });
    assert.equal(renamed.status, "blocked", "rename 不允许 config-only 降级");
    assert.equal(harness.state.configOnlyCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test("bypass 按 kind 分级：update-provider 放行枚举不完整，delete 保持 fail-closed", async () => {
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    const KIND_BYPASS = {
      "*": ["runtime_apply_unsupported"],
      "update-provider": ["session_enumeration_incomplete", "cron_enumeration_incomplete"],
    };
    harness.backend.getModelConfigWriteCapabilities = async () => ({
      supported: true, create: true, update: true, delete: true, updateProvider: true,
      activation: { kind: "gateway_restart" }, bypassBlockerCodes: KIND_BYPASS, blockers: [],
    });
    const ENUM_BLOCKERS = [
      CAPABILITY_BLOCKER,
      { code: "session_enumeration_incomplete", store: "sessions", message: "旧网关单页可能被截断" },
      { code: "cron_enumeration_incomplete", store: "cron", message: "Cron 单页可能被截断" },
    ];
    harness.state.nextPreview = {
      references: [], blockers: ENUM_BLOCKERS, runtimeApply: "blocked",
      fingerprints: { config: "config:alpha" },
      providerDiff: { beforeDigest: "1".repeat(64), afterDigest: "2".repeat(64) },
    };
    const saved = await harness.coordinator.updateProviderCompat("openclaw", "alpha", {
      apiKey: "next-key",
    }, { operationId: "kind-bypass-op" });
    assert.equal(saved.status, "applied", "update-provider 应绕过枚举类 blocker 完成 config-only 保存");
    assert.equal(harness.state.configOnlyCalls, 1);
    assert.deepEqual(harness.state.lastConfigOnlySecret, { apiKey: "next-key" });

    harness.state.nextPreview = {
      references: [], blockers: ENUM_BLOCKERS, runtimeApply: "blocked",
      fingerprints: { config: "config:alpha" },
    };
    const removed = await harness.coordinator.deleteCompat("openclaw", {
      providerKey: "alpha", modelId: "m-guarded",
    }, { operationId: "kind-guard-op" });
    assert.equal(removed.status, "blocked", "delete 的枚举类 blocker 不在其 kind bypass 内，必须保持阻断");
    assert.equal(harness.state.configOnlyCalls, 1, "delete 不得触发第二次 config-only 写");
  } finally {
    harness.cleanup();
  }
});

test("delete 引用拦截可被 force 覆盖：默认 references_exist 零写，force 后照删", async () => {
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    harness.backend.getModelConfigWriteCapabilities = async () => ({
      supported: true, create: true, update: true, delete: true, updateProvider: true,
      activation: { kind: "gateway_restart" },
      bypassBlockerCodes: {
        "*": ["runtime_apply_unsupported"],
        "delete-model:forced": ["session_enumeration_incomplete", "cron_enumeration_incomplete"],
      },
      blockers: [],
    });
    const previewWithRefs = {
      references: [{ store: "sessions", referenceKey: "session:1", writable: true }],
      blockers: [
        CAPABILITY_BLOCKER,
        { code: "session_enumeration_incomplete", store: "sessions", message: "旧网关单页可能被截断" },
      ],
      runtimeApply: "blocked",
      fingerprints: { config: "config:alpha" },
    };
    harness.state.nextPreview = previewWithRefs;
    const blocked = await harness.coordinator.deleteCompat("openclaw", {
      providerKey: "alpha", modelId: "m-used",
    }, { operationId: "force-del-1" });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.code, "references_exist");
    assert.equal(harness.state.configOnlyCalls, 0, "默认引用拦截必须零写");

    harness.state.nextPreview = previewWithRefs;
    const forced = await harness.coordinator.deleteCompat("openclaw", {
      providerKey: "alpha", modelId: "m-used",
    }, { operationId: "force-del-2", force: true });
    assert.equal(forced.status, "applied", "force 删除应绕过引用与枚举拦截完成 config-only 写");
    assert.equal(harness.state.configOnlyCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test("config-only 非终态 journal 的启动恢复走读回验证而非完整恢复状态机", async () => {
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    harness.state.nextPreview = {
      references: [], blockers: [CAPABILITY_BLOCKER], runtimeApply: "blocked",
      fingerprints: { config: "config:alpha" },
    };
    // 让 config-only 首轮停在显式非终态，启动后只读回验证。
    harness.backend.applyModelChangeConfigOnly = async () => ({ status: "partial", code: "catalog_pending", stage: "config-write", retryable: true });
    await harness.coordinator.applyCompat("openclaw", {
      providerKey: "alpha", baseUrl: "https://api.example.com/v1", providerMode: "new", model: { id: "m-rec" },
    }, { operationId: "co-op-4" });
    assert.equal(harness.journal.get("co-op-4").status, "partial");
    await harness.backend.start();
    const outcomes = await harness.coordinator.recoverPending();
    assert.equal(harness.state.configOnlyRecoverCalls, 1, "必须走 recoverModelChangeConfigOnly");
    assert.equal(harness.state.recoverCalls.length, 0, "不得走完整 recoverModelChange");
    assert.equal(harness.journal.get("co-op-4").status, "applied");
    assert.ok(Array.isArray(outcomes));
  } finally {
    harness.cleanup();
  }
});

test("config-only 写成后丢响应保持 partial，凭据 checkpoint 后同请求只读回并等待 fresh catalog", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    let parsed = { models: { providers: {} }, agents: { defaults: { modelPolicy: { allow: [] } } } };
    let writes = 0;
    let authWrites = 0;
    let mirrors = 0;
    const backend = new OpenClawBackend();
    backend._isLocalGateway = () => true;
    backend._configSnapshot = async () => ({ parsed, hash: "hash-fixture" });
    backend._writeAuthProfileKey = async () => { authWrites += 1; };
    backend._localAuthKeyProviders = () => new Set(["alpha"]);
    backend._loadLocalAuthKeyProfiles = async () => new Map([["alpha", {}]]);
    backend._syncRegistryProvider = () => { mirrors += 1; };
    backend._pathsNeedRestart = async () => false;
    backend.request = async (method, params) => {
      assert.equal(method, "config.patch");
      writes += 1;
      const patch = JSON.parse(params.raw);
      parsed = { models: patch.models, agents: patch.agents };
      throw new Error("connection closed during hot reload");
    };
    harness.backend.applyModelChangeConfigOnly = backend.applyModelChangeConfigOnly.bind(backend);
    harness.backend.recoverModelChangeConfigOnly = backend.recoverModelChangeConfigOnly.bind(backend);
    harness.backend.previewModelChange = async () => ({
      references: [], blockers: parsed.models.providers.alpha
        ? [{ code: "target_conflict", stage: "preflight" }] : [CAPABILITY_BLOCKER],
      runtimeApply: "blocked", fingerprints: { config: "config:alpha" },
    });
    const input = { providerKey: "alpha", providerMode: "new", baseUrl: "https://private-endpoint.example/v1", model: { id: "recover-me", name: "Recover Me" } };
    const result = await harness.coordinator.applyCompat("openclaw", { ...input, apiKey: "credential-fixture" }, { operationId: "config-lost-response" });
    assert.equal(result.status, "partial");
    assert.equal(result.retryable, true);
    const entry = harness.journal.get("config-lost-response");
    assert.equal(entry.secretStep, "applied");
    assert.equal(entry.stage, "config-write-pending");
    assert.equal(entry.fingerprints.configOnlyTarget.digest.length, 64);
    assert.equal(JSON.stringify(entry).includes("credential-fixture"), false);
    assert.equal(JSON.stringify(entry).includes("private-endpoint.example"), false);
    assert.equal(writes, 1);
    assert.equal(authWrites, 1);

    const fresh = harness.registry.listModelsSnapshot;
    harness.registry.listModelsSnapshot = async () => { throw new Error("catalog reconnecting"); };
    const pending = await harness.coordinator.applyCompat("openclaw", input, { operationId: "config-lost-response" });
    assert.equal(pending.status, "partial");
    assert.equal(pending.code, "catalog_pending");
    assert.equal(pending.catalog, undefined);
    harness.registry.listModelsSnapshot = fresh;
    const restored = await harness.coordinator.applyCompat("openclaw", input, { operationId: "config-lost-response" });
    assert.equal(restored.status, "applied");
    assert.equal(restored.activation, null);
    assert.equal(writes, 1, "已确认落盘的 create 不得重写或被 target_conflict 阻断");
    assert.equal(authWrites, 1, "已持久 checkpoint 的凭据不要求再次提供或重写");
    assert.ok(mirrors > 0, "丢响应跳过的本机定义镜像必须恢复");
    assert.deepEqual(harness.state.lastCatalogRequest.options, { fresh: true });

    const changed = structuredClone(parsed);
    changed.models.providers.alpha.models[0].name = "Other user's edit";
    parsed = changed;
    const mismatch = await backend.recoverModelChangeConfigOnly(entry);
    assert.equal(mismatch.status, "partial");
    assert.equal(mismatch.code, "config_write_not_applied", "同 modelId 但内容不同不能误判目标已经写入");
    const missingWitness = await backend.recoverModelChangeConfigOnly({ ...entry, fingerprints: {} });
    assert.equal(missingWitness.status, "partial", "历史条目缺少读回判据时不能凭存在性宣告成功");

    const baseline = structuredClone(changed);
    baseline.models.providers.alpha.models[0].name = "Recover Me";
    for (const extra of [{ reasoning: true }, { contextWindow: 99999 }, { maxTokens: 9999 }]) {
      parsed = structuredClone(baseline);
      Object.assign(parsed.models.providers.alpha.models[0], extra);
      assert.equal((await backend.recoverModelChangeConfigOnly(entry)).status, "partial", "应清除的可选字段仍存在时不得声明 applied");
    }
    parsed = structuredClone(baseline);
    parsed.models.providers.alpha.baseUrl = "https://changed-destination.example";
    assert.equal((await backend.recoverModelChangeConfigOnly(entry)).status, "partial", "凭据目标 endpoint 改变不得通过恢复验证");
    const previousAuthWrites = authWrites;
    await assert.rejects(backend.applyModelChangeConfigOnly({
      kind: "update", providerKey: "alpha", providerMode: "existing", model: input.model,
    }, { journalEntry: entry }, { apiKey: "credential-fixture" }), { code: "provider_conflict" });
    assert.equal(authWrites, previousAuthWrites, "existing Provider 也不得把重供凭据写向漂移后的 endpoint");
  } finally { harness.cleanup(); }
});

test("config-only 官方已写入但需恢复重启回执立即精确读回，保持重启提示且不重写", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const restartReceipt = "config.patch persisted and updated the active Gateway, but a recovery restart is required; wait for the Gateway to restart, then run config.get to confirm the active revision";
  for (const scenario of ["match", "catalog-fails", "readback-fails", "mismatch", "unavailable", "not-active"]) {
    const harness = createCoordinatorHarness();
    try {
      armConfigOnly(harness);
      let parsed = { models: { providers: {} }, agents: { defaults: { modelPolicy: { allow: [] } } } };
      let writes = 0;
      let readbackFails = scenario === "readback-fails";
      const backend = new OpenClawBackend();
      backend._isLocalGateway = () => true;
      backend._configSnapshot = async () => {
        if (writes > 0 && readbackFails) throw new Error("Gateway restarting");
        return { parsed, hash: "restart-fixture" };
      };
      backend._writeAuthProfileKey = async () => {};
      backend._localAuthKeyProviders = () => new Set(["alpha"]);
      backend._loadLocalAuthKeyProfiles = async () => new Map([["alpha", {}]]);
      backend._syncRegistryProvider = () => {};
      backend._pathsNeedRestart = async () => false;
      backend.request = async (method, params) => {
        assert.equal(method, "config.patch");
        writes += 1;
        const patch = JSON.parse(params.raw);
        parsed = { models: patch.models, agents: patch.agents };
        if (scenario === "mismatch") parsed.models.providers.alpha.models[0].name = "Concurrent edit";
        const error = new Error(scenario === "unavailable" ? "Gateway temporarily unavailable"
          : scenario === "not-active" ? "config.patch persisted but was not applied to the active Gateway (failed)"
            : restartReceipt);
        error.code = "UNAVAILABLE";
        throw error;
      };
      harness.backend.applyModelChangeConfigOnly = backend.applyModelChangeConfigOnly.bind(backend);
      harness.backend.recoverModelChangeConfigOnly = backend.recoverModelChangeConfigOnly.bind(backend);
      harness.state.nextPreview = { references: [], blockers: [CAPABILITY_BLOCKER], runtimeApply: "blocked", fingerprints: {} };
      const freshCatalog = harness.registry.listModelsSnapshot;
      if (scenario === "catalog-fails") harness.registry.listModelsSnapshot = async () => { throw new Error("Catalog unavailable"); };
      const input = { providerKey: "alpha", providerMode: "new", baseUrl: "https://restart-fixture.example", model: { id: "new-model" } };
      const options = { operationId: `restart-receipt-${scenario}` };
      const result = await harness.coordinator.applyCompat("openclaw", { ...input, apiKey: "restart-fixture-credential" }, options);
      assert.equal(writes, 1, `${scenario}: recovery must never repeat config.patch`);
      assert.equal(result.status, scenario === "match" ? "applied" : "partial");
      const recognized = !["unavailable", "not-active"].includes(scenario);
      if (recognized) {
        assert.equal(result.restartRequired, true, "a hot path must not erase the explicit restart requirement");
        assert.deepEqual(result.activation, { kind: "gateway_restart" });
        assert.equal(harness.journal.get(options.operationId).fingerprints.configOnlyRestartRequired, true);
        assert.equal(harness.journal.get(options.operationId).secretStep, "applied");
      } else {
        assert.equal(result.code, "UNAVAILABLE", "other UNAVAILABLE replies keep their failure semantics");
        assert.equal(result.restartRequired, undefined);
        assert.equal(result.activation, undefined);
      }
      if (scenario === "catalog-fails") {
        assert.equal(result.code, "catalog_pending");
        assert.equal(result.catalog, undefined);
        harness.registry.listModelsSnapshot = freshCatalog;
        const retry = await harness.coordinator.applyCompat("openclaw", input, options);
        assert.equal(retry.status, "applied");
        assert.equal(retry.restartRequired, true);
        assert.deepEqual(retry.activation, { kind: "gateway_restart" });
        assert.equal(writes, 1);
      }
      if (scenario === "readback-fails") {
        assert.equal(result.code, "config_restart_pending");
        readbackFails = false;
        await harness.coordinator.recoverPending();
        const recovered = harness.journal.get(options.operationId).result;
        assert.equal(recovered.status, "applied");
        assert.equal(recovered.restartRequired, true);
        assert.deepEqual(recovered.activation, { kind: "gateway_restart" });
        assert.equal(writes, 1);
      }
      if (scenario === "mismatch") assert.equal(result.code, "config_restart_pending");
      assert.equal(JSON.stringify(harness.journal.get(options.operationId)).includes("restart-fixture-credential"), false);
      assert.equal(JSON.stringify(harness.journal.get(options.operationId)).includes(restartReceipt), false);
    } finally { harness.cleanup(); }
  }
});

test("config-only 新 Provider 名称被抢占时凭据和配置均保持零写", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const backend = new OpenClawBackend();
  let authWrites = 0;
  let configWrites = 0;
  backend._isLocalGateway = () => true;
  backend._configSnapshot = async () => ({ parsed: { models: { providers: {
    alpha: { baseUrl: "https://other-writer.example", api: "openai-completions", models: [] },
  } } }, hash: "fresh-other-writer" });
  backend._writeAuthProfileKey = async () => { authWrites += 1; };
  backend.request = async () => { configWrites += 1; };
  await assert.rejects(backend.applyModelChangeConfigOnly({
    kind: "create", providerKey: "alpha", providerMode: "new", baseUrl: "https://requested.example", model: { id: "model" },
  }, {}, { apiKey: "credential-fixture" }), { code: "provider_conflict" });
  assert.equal(authWrites, 0);
  assert.equal(configWrites, 0);
});

test("config-only 远端响应丢失需要重供凭据，精确目标重放后才 checkpoint", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    let parsed = { models: { providers: {} }, agents: { defaults: { modelPolicy: { allow: [] } } } };
    let writes = 0;
    const backend = new OpenClawBackend();
    backend._isLocalGateway = () => false;
    backend._configSnapshot = async () => ({ parsed, hash: "remote-fixture" });
    backend._loadLocalAuthKeyProfiles = async () => new Map();
    backend._syncRegistryProvider = () => {};
    backend._pathsNeedRestart = async () => true;
    backend.request = async (method, params) => {
      assert.equal(method, "config.patch");
      writes += 1;
      const patch = JSON.parse(params.raw);
      parsed = { models: patch.models, agents: patch.agents };
      assert.equal(parsed.models.providers.alpha.apiKey, "remote-credential-fixture");
      if (writes === 1) throw new Error("lost response");
      return {};
    };
    harness.backend.applyModelChangeConfigOnly = backend.applyModelChangeConfigOnly.bind(backend);
    harness.backend.recoverModelChangeConfigOnly = backend.recoverModelChangeConfigOnly.bind(backend);
    harness.backend.previewModelChange = async () => ({
      references: [], blockers: parsed.models.providers.alpha ? [{ code: "provider_conflict" }] : [CAPABILITY_BLOCKER],
      runtimeApply: "blocked", fingerprints: {},
    });
    const input = { providerKey: "alpha", providerMode: "new", baseUrl: "https://remote-provider.example", model: { id: "remote-model" } };
    const options = { operationId: "remote-secret-retry" };
    assert.equal((await harness.coordinator.applyCompat("openclaw", { ...input, apiKey: "remote-credential-fixture" }, options)).status, "partial");
    assert.equal(harness.journal.get(options.operationId).secretStep, "pending");
    assert.equal((await harness.coordinator.applyCompat("openclaw", input, options)).status, "needs_secret");
    assert.equal(writes, 1);
    const result = await harness.coordinator.applyCompat("openclaw", { ...input, apiKey: "remote-credential-fixture" }, options);
    assert.equal(result.status, "applied");
    assert.equal(writes, 2);
    assert.equal(harness.journal.get(options.operationId).secretStep, "applied");
  } finally { harness.cleanup(); }
});

test("fresh model catalog 读取 Gateway 当前完整 generation，不强制重建且错误不回退旧目录", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const backend = new OpenClawBackend();
  backend._configSnapshot = async () => ({ parsed: {}, hash: "config" });
  backend.request = async (method, params, timeout) => {
    assert.equal(method, "models.list");
    assert.equal(params.refresh, undefined);
    assert.equal(params.view, "all");
    assert.equal(timeout, 60000);
    return { models: [{ id: "fresh-model", provider: "alpha" }] };
  };
  assert.equal((await backend.getModelCatalogSources()).models[0].id, "fresh-model");
  backend.request = async () => { throw new Error("refresh unavailable"); };
  await assert.rejects(backend.getModelCatalogSources(), { code: "ERR_MODEL_CATALOG_RUNTIME" });
  backend.request = async () => ({});
  await assert.rejects(backend.getModelCatalogSources(), { code: "ERR_MODEL_CATALOG_RUNTIME" });
});

test("config-only 未确认写入的启动恢复保留可恢复状态，完整原请求可重放", async () => {
  const harness = createCoordinatorHarness();
  try {
    armConfigOnly(harness);
    harness.state.nextPreview = { references: [], blockers: [CAPABILITY_BLOCKER], runtimeApply: "blocked", fingerprints: {} };
    harness.backend.applyModelChangeConfigOnly = async () => { throw new Error("socket disconnected before response"); };
    harness.backend.recoverModelChangeConfigOnly = async () => ({ status: "failed", code: "config_write_not_applied", stage: "recovery", retryable: true });
    const input = { providerKey: "alpha", providerMode: "existing", model: { id: "pending-model" } };
    await harness.coordinator.applyCompat("openclaw", input, { operationId: "config-not-written" });
    assert.equal(harness.journal.get("config-not-written").status, "partial");
    await harness.coordinator.recoverPending();
    assert.equal(harness.journal.get("config-not-written").status, "partial", "启动恢复不得把 retryable failed 固化为终态");
    harness.backend.applyModelChangeConfigOnly = async () => ({ status: "applied", stage: "config-write" });
    const retry = await harness.coordinator.applyCompat("openclaw", input, { operationId: "config-not-written" });
    assert.equal(retry.status, "applied");
  } finally { harness.cleanup(); }
});

test("OpenClaw config-only 写分离 modelPolicy allow 与 models alias/settings", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-only-auth-"));
  let seq = 0;
  const makeBackend = (parsed) => {
    const backend = new OpenClawBackend();
    const calls = [];
    seq += 1;
    backend._configSnapshot = async () => ({ parsed, hash: "hash-1" });
    backend.request = async (method, params) => { calls.push({ method, params }); };
    // 密钥/注册表路径落到隔离临时目录,sqlite 分发与分身清理打成记录桩——绝不触碰真实 ~/.openclaw
    backend._authProfilesPathOverride = path.join(authDir, `auth-${seq}.json`);
    backend._modelAuthCliVersionOverride = "2026.8.1";
    backend._registryPathOverride = path.join(authDir, `registry-${seq}.json`);
    backend._isLocalGateway = () => true;
    backend._sqliteSyncCalls = [];
    backend._syncAgentSqliteAuthKey = (id, cred) => { backend._sqliteSyncCalls.push({ id, cred }); };
    backend._purgeAgentShadowRegistries = () => {};
    backend._shadowRenameCalls = [];
    backend._renameAgentShadowRegistries = (a, b) => { backend._shadowRenameCalls.push([a, b]); };
    backend._listAgentSqliteAuthProfiles = () => new Map();
    return { backend, calls };
  };
  const configPatchCalls = (calls) => calls.filter((call) => call.method === "config.patch");
  const rawOf = (calls) => JSON.parse(configPatchCalls(calls)[0].params.raw);
  try {

  // create：provider 配置与 modelPolicy 允许列表登记同一次 patch；既有 alias/settings 不动
  {
    const parsed = {
      models: { providers: {} },
      agents: {
        defaults: {
          modelPolicy: { allow: ["keep/x"] },
          models: { "keep/x": { alias: "keep" } },
        },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({
      kind: "create", providerKey: "alpha", providerMode: "new",
      baseUrl: "https://api.example.com/v1", api: null, sourceModelId: null,
      model: { id: "m1", name: "M1" },
    }, {}, { apiKey: "sk-secret-k" });
    const raw = rawOf(calls);
    assert.equal(raw.models.providers.alpha.models[0].id, "m1");
    assert.equal("apiKey" in raw.models.providers.alpha, false, "key 不得进 config patch");
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["keep/x", "alpha/m1"]);
    assert.equal(raw.agents.defaults.models, undefined, "create 不得把 models alias/settings 当 allowlist 改写");
    assert.deepEqual(parsed.agents.defaults.models, { "keep/x": { alias: "keep" } }, "既有 alias/settings 保留");
    const store = JSON.parse(fs.readFileSync(backend._authProfilesPathOverride, "utf8"));
    assert.deepEqual(store.profiles["alpha:default"], { type: "api_key", provider: "alpha", key: "sk-secret-k" });
    // key 同步分发到各 agent sqlite(记录桩),注册表镜像纯定义不带 key
    assert.deepEqual(backend._sqliteSyncCalls, [{ id: "alpha:default", cred: { type: "api_key", provider: "alpha", key: "sk-secret-k" } }]);
    const registry = JSON.parse(fs.readFileSync(backend._registryPathOverride, "utf8"));
    assert.equal(registry.providers.alpha.baseUrl, "https://api.example.com/v1");
    assert.equal(registry.providers.alpha.models[0].id, "m1");
    assert.equal("apiKey" in registry.providers.alpha, false, "注册表镜像不得带 key");
  }
  // 远程网关降级:key 回落 config(auth 文件不可达)
  {
    const { backend, calls } = makeBackend({
      models: { providers: {} },
      agents: { defaults: { modelPolicy: { allow: [] } }, entries: { main: {} } },
    });
    backend._isLocalGateway = () => false;
    await backend.applyModelChangeConfigOnly({
      kind: "create", providerKey: "beta", providerMode: "new",
      baseUrl: "https://api.example.com/v1", api: null, sourceModelId: null,
      model: { id: "m1" },
    }, {}, { apiKey: "sk-remote-k" });
    assert.equal(rawOf(calls).models.providers.beta.apiKey, "sk-remote-k");
  }
  // update-provider 换 key:profile 更新,config 里旧明文顺带清成 null
  {
    const parsed = { models: { providers: { alpha: { baseUrl: "https://a", apiKey: "old-plain", models: [{ id: "m1" }] } } } };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({
      kind: "update-provider", providerKey: "alpha", patch: {},
    }, {}, { apiKey: "sk-rotated" });
    const raw = rawOf(calls);
    assert.equal(raw.models.providers.alpha.apiKey, null, "config 旧明文应被 null 清除");
    const store = JSON.parse(fs.readFileSync(backend._authProfilesPathOverride, "utf8"));
    assert.equal(store.profiles["alpha:default"].key, "sk-rotated");
  }
  // delete-provider:api_key profile 一并清除
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }] } } },
      agents: {
        defaults: {
          modelPolicy: { allow: ["alpha/m1"] },
          models: { "alpha/m1": { alias: "retired" }, "keep/x": { alias: "keep" } },
        },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "alpha:default": { type: "api_key", provider: "alpha", key: "sk-die" },
      "keep:default": { type: "oauth", provider: "keep", access: "t" },
    } }));
    fs.writeFileSync(backend._registryPathOverride, JSON.stringify({ providers: { alpha: { baseUrl: "https://a", models: [] }, other: { baseUrl: "https://o" } } }));
    await backend.applyModelChangeConfigOnly({ kind: "delete-provider", providerKey: "alpha" }, {});
    const store = JSON.parse(fs.readFileSync(backend._authProfilesPathOverride, "utf8"));
    assert.equal("alpha:default" in store.profiles, false, "provider 删除应连带清 api_key profile");
    assert.equal("keep:default" in store.profiles, true);
    assert.deepEqual(backend._sqliteSyncCalls, [{ id: "alpha:default", cred: null }], "各 agent sqlite 同步清除");
    const registry = JSON.parse(fs.readFileSync(backend._registryPathOverride, "utf8"));
    assert.equal("alpha" in registry.providers, false, "注册表条目应随删除清掉");
    assert.equal("other" in registry.providers, true);
    assert.ok(calls.length >= 1);
    const raw = rawOf(calls);
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, [], "provider 删除应清理可见性策略");
    assert.deepEqual(raw.agents.defaults.models, { "alpha/m1": null }, "provider 删除应清理精确 alias/settings 键");
  }
  // update-provider 改名:config 搬键 + modelPolicy 前缀搬迁 + alias/settings 精确搬迁 +
  // primary/fallbacks 改写(defaults 与 agents.entries) + auth-profiles/注册表/sqlite 迁移
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", api: "openai-completions", models: [{ id: "m1" }] }, keep: { baseUrl: "https://k", models: [] } } },
      agents: {
        defaults: {
          model: { primary: "alpha/m1", fallbacks: ["alpha/m1", "keep/x"] },
          modelPolicy: { allow: ["alpha/m1", "keep/x"] },
          models: {
            "alpha/m1": { alias: "fast", params: { old: true } },
            "beta/m1": { params: { target: true }, codeMode: true },
            "keep/x": { alias: "keep" },
          },
        },
        entries: {
          a1: {
            model: { primary: "alpha/m1" },
            modelPolicy: { allow: ["alpha/m1"] },
            models: { "alpha/m1": { alias: "agent-fast" } },
          },
          a2: {
            model: { primary: "keep/x", fallbacks: ["alpha/m1"] },
            modelPolicy: { allow: ["alpha/m1", "keep/x"] },
            models: {
              "alpha/m1": { temperature: 0.2, params: { old: true } },
              "beta/m1": { params: { target: true } },
            },
          },
        },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "alpha:default": { type: "api_key", provider: "alpha", key: "sk-move" },
      "keep:default": { type: "api_key", provider: "keep", key: "sk-stay" },
    } }));
    fs.writeFileSync(backend._registryPathOverride, JSON.stringify({ providers: {
      alpha: { baseUrl: "https://a", api: "openai-completions", models: [{ id: "m1" }], apiKey: "profile:alpha:default" },
      other: { baseUrl: "https://o" },
    } }));
    await backend.applyModelChangeConfigOnly({
      kind: "update-provider", providerKey: "alpha", patch: { renameTo: "beta" },
    }, {});
    const raw = rawOf(calls);
    assert.equal(raw.models.providers.alpha, null, "旧键应删除");
    assert.equal(raw.models.providers.beta.baseUrl, "https://a");
    assert.equal(raw.models.providers.beta.models[0].id, "m1");
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["keep/x", "beta/m1"], "默认可见性策略搬前缀");
    assert.deepEqual(raw.agents.defaults.models, {
      "alpha/m1": null,
      "beta/m1": { alias: "fast", params: { target: true }, codeMode: true },
    }, "alias/settings 搬迁时目标显式设置优先，仅补缺失字段");
    assert.equal(raw.agents.defaults.model.primary, "beta/m1", "defaults primary 改写");
    assert.deepEqual(raw.agents.defaults.model.fallbacks, ["beta/m1", "keep/x"]);
    assert.equal(raw.agents.entries.a1.model.primary, "beta/m1", "agent primary 改写");
    assert.deepEqual(raw.agents.entries.a1.modelPolicy.allow, ["beta/m1"]);
    assert.deepEqual(raw.agents.entries.a1.models, {
      "alpha/m1": null, "beta/m1": { alias: "agent-fast" },
    });
    assert.deepEqual(raw.agents.entries.a2.model.fallbacks, ["beta/m1"]);
    assert.equal(raw.agents.entries.a2.model.primary, "keep/x", "无关引用不动");
    assert.deepEqual(raw.agents.entries.a2.modelPolicy.allow, ["beta/m1", "keep/x"]);
    assert.deepEqual(raw.agents.entries.a2.models, {
      "alpha/m1": null,
      "beta/m1": { temperature: 0.2, params: { target: true } },
    });
    assert.deepEqual(
      calls[0].params.replacePaths.sort(),
      [
        "agents.defaults.model.fallbacks",
        "agents.defaults.modelPolicy.allow",
        "agents.entries.a1.modelPolicy.allow",
        "agents.entries.a2.model.fallbacks",
        "agents.entries.a2.modelPolicy.allow",
        "models.providers.alpha.models",
      ].sort(),
    );
    const store = JSON.parse(fs.readFileSync(backend._authProfilesPathOverride, "utf8"));
    assert.equal("alpha:default" in store.profiles, false, "旧名 profile 应搬走");
    assert.deepEqual(store.profiles["beta:default"], { type: "api_key", provider: "beta", key: "sk-move" });
    assert.equal(store.profiles["keep:default"].key, "sk-stay");
    assert.deepEqual(backend._sqliteSyncCalls, [
      { id: "alpha:default", cred: null },
      { id: "beta:default", cred: { type: "api_key", provider: "beta", key: "sk-move" } },
    ], "sqlite 逐 agent 迁移:删旧写新");
    const registry = JSON.parse(fs.readFileSync(backend._registryPathOverride, "utf8"));
    assert.equal("alpha" in registry.providers, false, "注册表旧键应删除");
    assert.equal(registry.providers.beta.baseUrl, "https://a");
    assert.equal(registry.providers.beta.apiKey, "profile:alpha:default", "注册表原 key 引用保留");
    assert.equal("other" in registry.providers, true);
    assert.deepEqual(backend._shadowRenameCalls, [["alpha", "beta"]], "分身注册表同步改名");
  }
  // 改名重试幂等:旧键已搬走且新键存在 → 全程零写
  {
    const parsed = { models: { providers: { beta: { baseUrl: "https://a", models: [{ id: "m1" }] } } } };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({
      kind: "update-provider", providerKey: "alpha", patch: { renameTo: "beta" },
    }, {});
    assert.equal(calls.length, 0, "重试应零 config 写");
    assert.equal(fs.existsSync(backend._authProfilesPathOverride), false, "重试不得再碰授权文件");
    assert.deepEqual(backend._shadowRenameCalls, [], "重试不得再迁分身注册表");
  }
  // 改名撞已有 provider → 409 拒绝
  {
    const parsed = { models: { providers: { alpha: { baseUrl: "https://a", models: [] }, beta: { baseUrl: "https://b", models: [] } } } };
    const { backend } = makeBackend(parsed);
    await assert.rejects(
      backend.applyModelChangeConfigOnly({ kind: "update-provider", providerKey: "alpha", patch: { renameTo: "beta" } }, {}),
      (err) => err.code === "provider_exists" && err.status === 409,
    );
  }
  // 改名 + 换 key 同时提交:key 落到新名 profile,不被搬迁覆盖
  {
    const parsed = { models: { providers: { alpha: { baseUrl: "https://a", apiKey: "old-plain", models: [{ id: "m1" }] } } } };
    const { backend, calls } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "alpha:default": { type: "api_key", provider: "alpha", key: "sk-old" },
    } }));
    await backend.applyModelChangeConfigOnly({
      kind: "update-provider", providerKey: "alpha", patch: { renameTo: "beta" },
    }, {}, { apiKey: "sk-new" });
    const raw = rawOf(calls);
    assert.equal("apiKey" in raw.models.providers.beta, false, "config 新条目不得带明文 key");
    const store = JSON.parse(fs.readFileSync(backend._authProfilesPathOverride, "utf8"));
    assert.equal(store.profiles["beta:default"].key, "sk-new", "新 key 必须在搬迁后写入新名");
    assert.equal("alpha:default" in store.profiles, false);
  }
  // auth-only(内置 provider,凭证在 auth-profiles、config 无条目,如 openrouter):
  // getModelConfig 合成 source:"auth" 条目;换 key 零 config 写;删除=撤销授权+引用收口
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }] } } },
      agents: {
        defaults: {
          model: { primary: "alpha/m1", fallbacks: ["openrouter/free-a", "alpha/m1"] },
          modelPolicy: { allow: ["openrouter/free-a", "alpha/m1"] },
          models: { "openrouter/free-a": { alias: "free" }, "alpha/m1": { alias: "alpha" } },
        },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or" },
    } }));
    fs.writeFileSync(backend._registryPathOverride, JSON.stringify({ providers: {} }));
    const cfg = await backend.getModelConfig();
    const authRow = cfg.providers.find((r) => r.key === "openrouter");
    assert.equal(authRow?.source, "auth", "auth-only provider 应合成 source:auth 条目");
    assert.equal(authRow?.hasApiKey, true);
    assert.equal(authRow?.editable, true);
    assert.equal(cfg.providers.find((r) => r.key === "alpha")?.source, "config");
    // 换 key:auth-profiles 更新 + sqlite 分发,零 config 写
    await backend.applyModelChangeConfigOnly({
      kind: "update-provider", providerKey: "openrouter", patch: {},
    }, {}, { apiKey: "sk-rotated" });
    assert.equal(calls.length, 0, "auth-only 换 key 不得动 config");
    const store = JSON.parse(fs.readFileSync(backend._authProfilesPathOverride, "utf8"));
    assert.equal(store.profiles["openrouter:default"].key, "sk-rotated");
    // reveal 走 auth-profiles(config 无条目)
    backend._isLocalGateway = () => true;
    // 删除=撤销授权:profile 删+sqlite 清+fallbacks/allowlist 同 patch 收口(providers 不动)
    await backend.applyModelChangeConfigOnly({ kind: "delete-provider", providerKey: "openrouter" }, {});
    const raw = rawOf(calls);
    assert.deepEqual(raw.models.providers, {}, "auth-only 删除不得动 config providers");
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["alpha/m1"]);
    assert.deepEqual(raw.agents.defaults.models, { "openrouter/free-a": null }, "auth-only 删除清理精确 alias/settings");
    assert.deepEqual(raw.agents.defaults.model.fallbacks, ["alpha/m1"]);
    const store2 = JSON.parse(fs.readFileSync(backend._authProfilesPathOverride, "utf8"));
    assert.equal("openrouter:default" in store2.profiles, false, "授权 profile 应删除");
    assert.deepEqual(backend._sqliteSyncCalls.at(-1), { id: "openrouter:default", cred: null });
  }
  // auth-only 带端点字段 → 明确拒绝(端点由网关内置);两处都没有 → 不存在
  {
    const parsed = { models: { providers: {} } };
    const { backend } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or" },
    } }));
    await assert.rejects(
      backend.applyModelChangeConfigOnly({
        kind: "update-provider", providerKey: "openrouter", patch: { baseUrl: "https://x" },
      }, {}),
      /不存在或不可编辑/,
    );
    await assert.rejects(
      backend.applyModelChangeConfigOnly({ kind: "delete-provider", providerKey: "ghost" }, {}),
      /不存在或不可编辑/,
    );
  }
  // 目录模型删除(config 不管定义,如 openrouter 内置目录):允许列表键移除+引用收口,
  // config providers 不动;无键无引用 → 不存在
  {
    const parsed = {
      models: { providers: {} },
      agents: {
        defaults: {
          model: { primary: "alpha/m1", fallbacks: ["openrouter/free-a", "alpha/m1"] },
          modelPolicy: { allow: ["openrouter/free-a", "openrouter/free-b", "alpha/m1"] },
          models: {
            "openrouter/free-a": { alias: "remove" },
            "openrouter/free-b": { alias: "keep" },
          },
        },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({
      kind: "delete-model", providerKey: "openrouter", sourceModelId: "free-a",
    }, {});
    const raw = rawOf(calls);
    assert.deepEqual(raw.models.providers, {}, "目录模型删除不得动 config providers");
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["openrouter/free-b", "alpha/m1"]);
    assert.deepEqual(raw.agents.defaults.models, { "openrouter/free-a": null }, "目录模型删除清理精确 alias/settings");
    assert.deepEqual(raw.agents.defaults.model.fallbacks, ["alpha/m1"], "引用一并剔除");
    await assert.rejects(
      backend.applyModelChangeConfigOnly({ kind: "delete-model", providerKey: "openrouter", sourceModelId: "ghost" }, {}),
      /不存在或不可编辑/,
    );
  }
  // 批量合并写:N 个操作按序作用于同一工作副本,diff 出一次 patch;幂等/冲突定位/顺序依赖
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }, { id: "m2" }] } } },
      agents: {
        defaults: {
          model: { primary: "alpha/m2", fallbacks: ["openrouter/del-me:free", "openrouter/old-id", "alpha/m1"] },
          modelPolicy: {
            allow: ["alpha/m1", "alpha/m2", "openrouter/del-me:free", "openrouter/old-id"],
          },
          models: {
            "alpha/m1": { alias: "remove-alpha" },
            "alpha/m2": { alias: "alpha-two" },
            "openrouter/del-me:free": { alias: "remove-catalog" },
            "openrouter/old-id": { alias: "keep", params: { old: true } },
            "openrouter/new-id": { params: { target: true }, codeMode: true },
          },
        },
        entries: {
          a1: {
            model: { fallbacks: ["openrouter/old-id"] },
            modelPolicy: { allow: ["openrouter/old-id"] },
            models: { "openrouter/old-id": { alias: "agent-old" } },
          },
        },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or" },
    } }));
    fs.writeFileSync(backend._registryPathOverride, JSON.stringify({ providers: {
      alpha: { baseUrl: "https://a", models: [{ id: "m1" }, { id: "m2" }] },
    } }));
    await backend.applyModelChangeConfigOnlyBatch([
      { kind: "delete-model", providerKey: "alpha", sourceModelId: "m1" },
      { kind: "delete-model", providerKey: "openrouter", sourceModelId: "del-me:free" },
      { kind: "rename", providerKey: "openrouter", sourceModelId: "old-id", model: { id: "new-id" } },
      { kind: "create", providerKey: "openrouter", model: { id: "fresh:free" } },
    ]);
    assert.equal(configPatchCalls(calls).length, 1, "整批必须只发一次 config.patch");
    const raw = rawOf(calls);
    assert.deepEqual(raw.models.providers.alpha.models.map((m) => m.id), ["m2"], "config 模型删除");
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, [
      "alpha/m2", "openrouter/new-id", "openrouter/fresh:free",
    ], "modelPolicy allow 增删改按序合并");
    assert.deepEqual(raw.agents.defaults.models, {
      "alpha/m1": null,
      "openrouter/del-me:free": null,
      "openrouter/old-id": null,
      "openrouter/new-id": { alias: "keep", params: { target: true }, codeMode: true },
    }, "models 只清理/搬移精确 alias/settings；create 不创建空设置");
    assert.deepEqual(raw.agents.defaults.model.fallbacks, ["openrouter/new-id"], "两个删除的引用剔除+改名引用改写同批完成");
    assert.deepEqual(raw.agents.entries.a1.model.fallbacks, ["openrouter/new-id"]);
    assert.deepEqual(raw.agents.entries.a1.modelPolicy.allow, ["openrouter/new-id"]);
    assert.deepEqual(raw.agents.entries.a1.models, {
      "openrouter/old-id": null, "openrouter/new-id": { alias: "agent-old" },
    });
    assert.equal(raw.agents.defaults.model.primary ?? "alpha/m2", "alpha/m2", "无关 primary 不动");
    const registry = JSON.parse(fs.readFileSync(backend._registryPathOverride, "utf8"));
    assert.deepEqual(registry.providers.alpha.models.map((m) => m.id), ["m2"], "注册表镜像剩余模型");
    // 幂等重放:全批已收敛 → 零写
    const parsed2 = JSON.parse(JSON.stringify(parsed));
    parsed2.models.providers.alpha.models = [{ id: "m2" }];
    parsed2.agents.defaults.modelPolicy.allow = ["alpha/m2", "openrouter/new-id", "openrouter/fresh:free"];
    parsed2.agents.defaults.models = {
      "alpha/m2": { alias: "alpha-two" },
      "openrouter/new-id": { alias: "keep", params: { target: true }, codeMode: true },
    };
    parsed2.agents.defaults.model.fallbacks = ["openrouter/new-id"];
    parsed2.agents.entries.a1.model.fallbacks = ["openrouter/new-id"];
    parsed2.agents.entries.a1.modelPolicy.allow = ["openrouter/new-id"];
    parsed2.agents.entries.a1.models = { "openrouter/new-id": { alias: "agent-old" } };
    const { backend: bReplay, calls: cReplay } = makeBackend(parsed2);
    fs.writeFileSync(bReplay._authProfilesPathOverride, JSON.stringify({ profiles: {
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or" },
    } }));
    await bReplay.applyModelChangeConfigOnlyBatch([
      { kind: "delete-model", providerKey: "alpha", sourceModelId: "m1" },
      { kind: "delete-model", providerKey: "openrouter", sourceModelId: "del-me:free" },
      { kind: "rename", providerKey: "openrouter", sourceModelId: "old-id", model: { id: "new-id" } },
      { kind: "create", providerKey: "openrouter", model: { id: "fresh:free" } },
    ]);
    assert.equal(cReplay.length, 0, "整批重放应零写");
    // config 型 provider 批量新增:config models 追加(条目形状与即时路径一致)
    // + allowlist 登记 + 注册表镜像最终形态
    const parsedCfg = {
      models: { providers: { nvidia: { baseUrl: "https://n", api: "openai-completions", models: [{ id: "m1" }] } } },
      agents: {
        defaults: {
          modelPolicy: { allow: ["nvidia/m1"] },
          models: { "nvidia/m1": { alias: "existing" } },
        },
        entries: { main: {} },
      },
    };
    const { backend: bCfg, calls: cCfg } = makeBackend(parsedCfg);
    fs.writeFileSync(bCfg._registryPathOverride, JSON.stringify({ providers: {
      nvidia: { baseUrl: "https://n", models: [{ id: "m1" }], apiKey: "profile:nvidia:default" },
    } }));
    await bCfg.applyModelChangeConfigOnlyBatch([
      { kind: "create", providerKey: "nvidia", model: { id: "new-model", name: "New", contextWindow: 8192, reasoning: true } },
    ]);
    const rawCfg = rawOf(cCfg);
    const added = rawCfg.models.providers.nvidia.models.find((x) => x.id === "new-model");
    assert.ok(added, "config models 应追加");
    assert.equal(added.name, "New");
    assert.equal(added.contextWindow, 8192);
    assert.equal(added.reasoning, true);
    assert.deepEqual(added.input, ["text"], "条目形状与即时路径一致");
    assert.deepEqual(rawCfg.agents.defaults.modelPolicy.allow, ["nvidia/m1", "nvidia/new-model"]);
    assert.equal(rawCfg.agents.defaults.models, undefined, "create 不得创建空 alias/settings");
    const regCfg = JSON.parse(fs.readFileSync(bCfg._registryPathOverride, "utf8"));
    assert.equal(regCfg.providers.nvidia.models.length, 2, "注册表镜像最终形态");
    assert.equal(regCfg.providers.nvidia.apiKey, "profile:nvidia:default", "注册表 key 引用保留");
    // 冲突定位:第 2 项(index 1)撞名
    const parsed3 = {
      models: { providers: {} },
      agents: { defaults: { modelPolicy: { allow: ["or/a", "or/b", "or/c"] } }, entries: { main: {} } },
    };
    const { backend: bConf } = makeBackend(parsed3);
    await assert.rejects(
      bConf.applyModelChangeConfigOnlyBatch([
        { kind: "delete-model", providerKey: "or", sourceModelId: "c" },
        { kind: "rename", providerKey: "or", sourceModelId: "a", model: { id: "b" } },
      ]),
      (err) => err.code === "target_conflict" && err.batchIndex === 1,
    );
    // 顺序依赖:先删 A,再把 B 改名为 A(同批内前序结果可见)
    const parsed4 = {
      models: { providers: {} },
      agents: {
        defaults: {
          model: { primary: "keep/x" },
          modelPolicy: { allow: ["or/a", "or/b"] },
          models: { "or/a": { alias: "target-old" }, "or/b": { alias: "move" } },
        },
        entries: { main: {} },
      },
    };
    const { backend: bSeq, calls: cSeq } = makeBackend(parsed4);
    fs.writeFileSync(bSeq._authProfilesPathOverride, JSON.stringify({ profiles: {
      "or:default": { type: "api_key", provider: "or", key: "k" },
    } }));
    await bSeq.applyModelChangeConfigOnlyBatch([
      { kind: "delete-model", providerKey: "or", sourceModelId: "a" },
      { kind: "rename", providerKey: "or", sourceModelId: "b", model: { id: "a" } },
    ]);
    const rawSeq = rawOf(cSeq);
    assert.deepEqual(rawSeq.agents.defaults.modelPolicy.allow, ["or/a"], "先删后占同名:a 最终存在(来自 b)");
    assert.deepEqual(rawSeq.agents.defaults.models, {
      "or/a": { alias: "move" }, "or/b": null,
    }, "前序删除 alias 后，后序 rename 可精确占用同名设置键");
  }
  // modelPolicy 真值层:auth 型 provider 的目录残影滤除+新键合成(改名/删除后列表立即正确)
  {
    const parsed = {
      models: { providers: { deepseek: { baseUrl: "https://d", models: [{ id: "cfg-m" }] } } },
      agents: {
        defaults: {
          modelPolicy: { allow: ["openrouter/kept:free", "openrouter/renamed-new", "deepseek/cfg-m"] },
          models: { "openrouter/kept:free": { alias: "Kept alias" } },
        },
        entries: { main: {} },
      },
    };
    const { backend } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or" },
    } }));
    parsed.agents.defaults.modelPolicy.allow.push("openrouter/owl-alpha");
    const catalog = [
      { id: "kept:free", name: "Kept", provider: "openrouter", backendId: "openclaw", contextWindow: 8192 },
      { id: "ghost-old", name: "Ghost", provider: "openrouter", backendId: "openclaw" },
      // 目录行 id 自带 provider 前缀(平台同名 org):必须改写为裸 id 保持操作口径
      { id: "openrouter/owl-alpha", name: "OWL Alpha", provider: "openrouter", backendId: "openclaw", contextWindow: 4096 },
      { id: "claude-x", name: "Claude X", provider: "anthropic", backendId: "openclaw" },
    ];
    const merged = backend._mergeAllowlistModels(catalog, parsed);
    const ids = merged.map((m) => `${m.provider}/${m.id}`).sort();
    assert.deepEqual(ids, ["anthropic/claude-x", "openrouter/kept:free", "openrouter/owl-alpha", "openrouter/renamed-new"].sort(),
      "残影滤除+新键合成+无凭证 provider 不动+前缀行归一");
    assert.equal(merged.find((m) => m.id === "kept:free").contextWindow, 8192, "命中行保留目录元数据");
    assert.equal(merged.find((m) => m.id === "renamed-new").name, "renamed-new", "合成行裸元数据");
    const owl = merged.find((m) => m.id === "owl-alpha");
    assert.ok(owl, "带前缀目录行必须以裸 id 保留(与 allowlist 键口径一致)");
    assert.equal(owl.contextWindow, 4096, "改写 id 时保留元数据");
    assert.equal(merged.some((m) => m.id === "openrouter/owl-alpha"), false, "带前缀原行不得残留");
  }
  // 热重载窗口的 hash 冲突:带退避重试收敛;持续冲突抛专属 code(UI 映射等待提示)
  {
    const parsed = { models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }] } } } };
    const { backend, calls } = makeBackend(parsed);
    backend._patchRetryDelaysMs = [0, 0, 0, 0];
    let failures = 2;
    const record = backend.request;
    backend.request = async (method, params) => {
      if (failures > 0) { failures -= 1; throw new Error("config changed since last load; re-run config.get and retry"); }
      return record(method, params);
    };
    await backend.applyModelChangeConfigOnly({
      kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://b" },
    }, {});
    assert.equal(configPatchCalls(calls).length, 1, "冲突两轮后第三轮应成功落盘");
    // 全程冲突 → config_write_conflict
    const { backend: b2 } = makeBackend(parsed);
    b2._patchRetryDelaysMs = [0, 0];
    b2.request = async () => { throw new Error("config changed since last load"); };
    await assert.rejects(
      b2.applyModelChangeConfigOnly({ kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://b" } }, {}),
      (err) => err.code === "config_write_conflict",
    );
    // 网关显式限流:按 retry-after 等待一次后重试成功
    const { backend: b3, calls: c3 } = makeBackend(parsed);
    b3._patchRetryDelaysMs = [0, 0];
    let limited = true;
    const record3 = b3.request;
    b3.request = async (method, params) => {
      if (limited) { limited = false; throw new Error("rate limit exceeded for config.patch; retry after 0s"); }
      return record3(method, params);
    };
    await b3.applyModelChangeConfigOnly({ kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://c" } }, {});
    assert.equal(configPatchCalls(c3).length, 1, "限流等待后应重试成功");
    // 持续限流 → config_write_conflict(不无限等)
    const { backend: b4 } = makeBackend(parsed);
    b4._patchRetryDelaysMs = [0, 0];
    b4.request = async () => { throw new Error("rate limit exceeded for config.patch; retry after 0s"); };
    await assert.rejects(
      b4.applyModelChangeConfigOnly({ kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://d" } }, {}),
      (err) => err.code === "config_write_conflict",
    );
  }
  // 能力声明形状:rename 的 config-only 降级必须带枚举类 bypass(R183 真机教训:
  // 漏配则 session_enumeration_incomplete 直接 blocked,目录模型改 ID 永远失败)
  {
    const { backend } = makeBackend({ models: { providers: {} } });
    const caps = await backend.getModelConfigWriteCapabilities();
    assert.equal(caps.renameCatalogModel, true);
    assert.deepEqual(
      caps.bypassBlockerCodes.rename,
      ["session_enumeration_incomplete", "cron_enumeration_incomplete", "ambiguous_model_reference"],
      "rename 必须与 create/update 同级绕过枚举类 blocker",
    );
  }
  // auth 型 provider 新增模型:modelPolicy 裸登记(config providers 不动，aliases 不动);
  // 无凭证也无既有键的 provider 才要求 baseUrl
  {
    const parsed = {
      models: { providers: {} },
      agents: {
        defaults: {
          modelPolicy: { allow: ["openrouter/old"] },
          models: { "openrouter/old": { alias: "old alias" } },
        },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: {
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or" },
    } }));
    await backend.applyModelChangeConfigOnly({
      kind: "create", providerKey: "openrouter", providerMode: "existing",
      baseUrl: null, api: null, sourceModelId: null, model: { id: "qwen/new-free" },
    }, {});
    const raw = rawOf(calls);
    assert.deepEqual(raw.models.providers, {}, "auth 型新增不得建 config provider 条目");
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["openrouter/old", "openrouter/qwen/new-free"]);
    assert.equal(raw.agents.defaults.models, undefined, "auth 型 create 不得把 models 当 allowlist");
    await assert.rejects(
      backend.applyModelChangeConfigOnly({
        kind: "create", providerKey: "ghost", providerMode: "existing",
        baseUrl: null, api: null, sourceModelId: null, model: { id: "x" },
      }, {}),
      /新建需提供 baseUrl/,
    );
  }
  // 目录模型 id 改名:modelPolicy 搬引用 + alias/settings 精确搬键 + primary/fallbacks 引用改写;
  // 冲突 409;重试幂等零写;config 有定义的模型拒绝
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "cfg" }] } } },
      agents: {
        defaults: {
          model: { primary: "openrouter/old-id", fallbacks: ["openrouter/old-id", "alpha/cfg"] },
          modelPolicy: { allow: ["openrouter/old-id", "openrouter/other", "alpha/cfg"] },
          models: {
            "openrouter/old-id": { alias: "fast", params: { old: true } },
            "openrouter/new-id": { params: { target: true }, codeMode: true },
            "openrouter/other": { alias: "other" },
          },
        },
        entries: {
          a1: {
            model: { fallbacks: ["openrouter/old-id"] },
            modelPolicy: { allow: ["openrouter/old-id"] },
            models: {
              "openrouter/old-id": { alias: "agent-fast" },
              "openrouter/new-id": { temperature: 0.4 },
            },
          },
        },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({
      kind: "rename", providerKey: "openrouter", sourceModelId: "old-id", model: { id: "new-id" },
    }, {});
    const raw = rawOf(calls);
    assert.deepEqual(raw.models.providers, {}, "目录模型改名不得动 config providers");
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["openrouter/other", "alpha/cfg", "openrouter/new-id"]);
    assert.deepEqual(raw.agents.defaults.models, {
      "openrouter/old-id": null,
      "openrouter/new-id": { alias: "fast", params: { target: true }, codeMode: true },
    });
    assert.equal(raw.agents.defaults.model.primary, "openrouter/new-id", "primary 引用改写");
    assert.deepEqual(raw.agents.defaults.model.fallbacks, ["openrouter/new-id", "alpha/cfg"]);
    assert.deepEqual(raw.agents.entries.a1.model.fallbacks, ["openrouter/new-id"]);
    assert.deepEqual(raw.agents.entries.a1.modelPolicy.allow, ["openrouter/new-id"]);
    assert.deepEqual(raw.agents.entries.a1.models, {
      "openrouter/old-id": null,
      "openrouter/new-id": { alias: "agent-fast", temperature: 0.4 },
    });
    // 冲突:目标键已存在
    const parsed2 = {
      models: { providers: {} },
      agents: { defaults: { modelPolicy: { allow: ["or/a", "or/b"] } }, entries: { main: {} } },
    };
    const { backend: b2 } = makeBackend(parsed2);
    await assert.rejects(
      b2.applyModelChangeConfigOnly({ kind: "rename", providerKey: "or", sourceModelId: "a", model: { id: "b" } }, {}),
      (err) => err.code === "target_conflict" && err.status === 409,
    );
    // 幂等:旧键已搬走且新键存在 → 零写
    const parsed3 = {
      models: { providers: {} },
      agents: { defaults: { modelPolicy: { allow: ["or/b"] } }, entries: { main: {} } },
    };
    const { backend: b3, calls: c3 } = makeBackend(parsed3);
    await b3.applyModelChangeConfigOnly({ kind: "rename", providerKey: "or", sourceModelId: "a", model: { id: "b" } }, {});
    assert.equal(c3.length, 0, "重试应零写");
    // config 有定义的模型:config-only 改名拒绝(runtime 迁移路径的事)
    const parsed4 = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["alpha/m1"] } }, entries: { main: {} } },
    };
    const { backend: b4 } = makeBackend(parsed4);
    await assert.rejects(
      b4.applyModelChangeConfigOnly({ kind: "rename", providerKey: "alpha", sourceModelId: "m1", model: { id: "m2" } }, {}),
      (err) => err.code === "config_only_kind_unsupported",
    );
  }
  // delete-model（provider 还有剩余模型）：清 policy ref 与精确 alias/settings 键
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }, { id: "m2" }] } } },
      agents: {
        defaults: {
          modelPolicy: { allow: ["alpha/m1", "alpha/m2"] },
          models: { "alpha/m1": { alias: "remove" }, "alpha/m2": { alias: "keep" } },
        },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({ kind: "delete-model", providerKey: "alpha", sourceModelId: "m1" }, {});
    const raw = rawOf(calls);
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["alpha/m2"]);
    assert.deepEqual(raw.agents.defaults.models, { "alpha/m1": null });
    assert.equal(raw.models.providers.alpha.models.length, 1);
  }
  // delete-provider：policy 清掉 provider 前缀全部引用，models 清精确 provider/model 设置键
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }] } } },
      agents: {
        defaults: {
          modelPolicy: { allow: ["alpha/m1", "alpha/ghost-model", "beta/keep"] },
          models: {
            "alpha/m1": { alias: "one" },
            "alpha/ghost-model": { alias: "ghost" },
            "alpha/*": { alias: "wildcard stays" },
            alpha: { alias: "bare stays" },
            "beta/keep": { alias: "keep" },
          },
        },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({ kind: "delete-provider", providerKey: "alpha" }, {});
    const raw = rawOf(calls);
    assert.deepEqual(raw.models.providers, { alpha: null });
    assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["beta/keep"]);
    assert.deepEqual(raw.agents.defaults.models, { "alpha/m1": null, "alpha/ghost-model": null });
  }
  // 删除同步剔除 defaults 与 agents.entries 的 fallbacks 引用（悬空引用会被网关 savior 复活删掉的 provider）
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }] } } },
      agents: {
        defaults: {
          model: { primary: "beta/keep", fallbacks: ["alpha/m1", "beta/fb"] },
          modelPolicy: { allow: ["alpha/m1", "beta/fb"] },
          models: { "alpha/m1": { alias: "remove" } },
        },
        entries: {
          main: { model: { primary: "beta/keep", fallbacks: ["alpha/m1", "beta/fb"] } },
          clean: { model: { primary: "beta/keep", fallbacks: ["beta/fb"] } },
        },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    await backend.applyModelChangeConfigOnly({ kind: "delete-provider", providerKey: "alpha" }, {});
    const raw = rawOf(calls);
    assert.deepEqual(raw.agents.defaults.model.fallbacks, ["beta/fb"]);
    assert.deepEqual(raw.agents.entries.main.model.fallbacks, ["beta/fb"]);
    assert.deepEqual(raw.agents.entries.clean.model.fallbacks, ["beta/fb"]);
    assert.ok(calls[0].params.replacePaths.includes("agents.defaults.model.fallbacks"));
    assert.ok(calls[0].params.replacePaths.includes("agents.entries.main.model.fallbacks"));
  }
  // primary（默认或任一 agent）仍指向被删对象 → 拒删，避免悬空 primary 触发 savior 回滚复活
  {
    const parsed = {
      models: { providers: { alpha: { baseUrl: "https://a", models: [{ id: "m1" }] } } },
      agents: {
        defaults: { model: { primary: "alpha/m1", fallbacks: [] }, modelPolicy: { allow: ["alpha/m1"] } },
        entries: { main: {} },
      },
    };
    const { backend, calls } = makeBackend(parsed);
    await assert.rejects(
      backend.applyModelChangeConfigOnly({ kind: "delete-provider", providerKey: "alpha" }, {}),
      (err) => err.code === "primary_model_in_use" && err.status === 409,
    );
    assert.equal(calls.length, 0, "primary 在用时必须零写");
  }
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("OpenClaw 授权 profile 管理：脱敏列表 / api_key 写入 / oauth 拒覆盖 / 删除与备份", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-profiles-"));
  const file = path.join(directory, "auth-profiles.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ profiles: {
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or-v1-secret-tail" }, // gitleaks:allow -- synthetic test fixture; not a usable credential
      "mm:default": { type: "oauth", provider: "mm", email: "u@x.com", access: "tok-a", refresh: "tok-r", expires: 42 },
    } }));
    const backend = new OpenClawBackend();
    backend._authProfilesPathOverride = file;
    backend._isLocalGateway = () => true;
    backend._modelAuthCliVersionOverride = "2026.8.1";
    const sqliteClears = [];
    backend._syncAgentSqliteAuthKey = (id, cred) => { if (cred === null) sqliteClears.push(id); };
    // agent sqlite 聚合打成桩:xai oauth 只在 2 个 agent 库里,openrouter 已分发 1 个
    backend._listAgentSqliteAuthProfiles = () => new Map([
      ["xai:u@g.com", { profile: { type: "oauth", provider: "xai", email: "u@g.com", access: "tok-z", expires: 99 }, agents: ["main", "ada"] }],
      ["openrouter:default", { profile: { type: "api_key", provider: "openrouter", key: "sk-or-v1-secret-tail" }, agents: ["main"] }], // gitleaks:allow -- synthetic test fixture; not a usable credential
    ]);

    const listed = await backend.listModelAuthProfiles();
    assert.equal(listed.supported, true);
    const flat = JSON.stringify(listed);
    assert.equal(flat.includes("sk-or-v1-secret"), false, "完整 key 绝不出现在列表");
    assert.equal(flat.includes("tok-a") || flat.includes("tok-r") || flat.includes("tok-z"), false, "oauth token 绝不出现在列表");
    assert.deepEqual(listed.profiles.find((p) => p.id === "openrouter:default").keyTail, "tail");
    assert.equal(listed.profiles.find((p) => p.id === "mm:default").email, "u@x.com");
    // 聚合:主 store 行标注分发数;agent 库独有行 source:"agents"(xai 登录直写场景)
    const orRow = listed.profiles.find((p) => p.id === "openrouter:default");
    assert.equal(orRow.source, "both");
    assert.equal(orRow.agentCount, 1);
    assert.equal(listed.profiles.find((p) => p.id === "mm:default").source, "store");
    const xaiRow = listed.profiles.find((p) => p.id === "xai:u@g.com");
    assert.equal(xaiRow?.source, "agents", "agent 库独有授权必须进列表");
    assert.equal(xaiRow?.agentCount, 2);
    assert.equal(xaiRow?.email, "u@g.com");

    const set = await backend.setModelAuthProfileKey("openrouter", "sk-or-v1-NEW-key9");
    assert.equal(set.ok, true);
    assert.equal(set.activation.kind, "gateway_restart");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).profiles["openrouter:default"].key, "sk-or-v1-NEW-key9");
    assert.ok(fs.existsSync(`${file}.bak`), "写前滚动备份");

    await assert.rejects(
      backend.setModelAuthProfileKey("mm", "sk-x"),
      (err) => err.code === "auth_type_mismatch",
    );

    const removed = await backend.deleteModelAuthProfile("openrouter:default");
    assert.equal(removed.ok, true);
    assert.equal("openrouter:default" in JSON.parse(fs.readFileSync(file, "utf8")).profiles, false);
    assert.ok(sqliteClears.includes("openrouter:default"), "主 store 删除必须连清 agent 库副本");
    // agent 库独有授权(主 store 无)也可删:不 404,逐库清除
    const removedAgentsOnly = await backend.deleteModelAuthProfile("xai:u@g.com");
    assert.equal(removedAgentsOnly.ok, true);
    assert.ok(sqliteClears.includes("xai:u@g.com"), "agents-only 授权删除走 sqlite 清除");
    backend._listAgentSqliteAuthProfiles = () => new Map();
    await assert.rejects(
      backend.deleteModelAuthProfile("openrouter:default"),
      (err) => err.code === "auth_profile_not_found" && err.status === 404,
    );

    backend._isLocalGateway = () => false;
    await assert.rejects(backend.setModelAuthProfileKey("any", "k"), (err) => err.code === "auth_remote_gateway");
    assert.deepEqual(await backend.listModelAuthProfiles(), { supported: false, reason: "remote", profiles: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("OpenClaw 9.1 授权管理只走官方 CLI：摘要列表 / stdin 写 key / logout / 失败不回退", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-profiles-91-"));
  const legacyFile = path.join(directory, "auth-profiles.json");
  const originalLegacy = { profiles: {
    "legacy:default": { type: "api_key", provider: "legacy", key: "must-not-change" },
  } };
  fs.writeFileSync(legacyFile, JSON.stringify(originalLegacy));
  try {
    const backend = new OpenClawBackend();
    backend._authProfilesPathOverride = legacyFile;
    backend._isLocalGateway = () => true;
    backend._gatewayVersion = "2026.9.1";
    backend._modelAuthAgentIdsOverride = ["main"];
    let profiles = [
      { id: "openrouter:default", provider: "openrouter", type: "api_key", label: "OpenRouter" },
      {
        id: "openai:user@example.com",
        provider: "openai",
        type: "oauth",
        label: "User",
        email: "user@example.com",
        displayName: "Example User",
        expiresAt: "2026-09-05T00:00:00.000Z",
      },
    ];
    const calls = [];
    backend._runModelAuthCli = async (args, options = {}) => {
      calls.push({ args: [...args], stdin: options.stdin });
      if (args[2] === "list") return { profiles: profiles.map((profile) => ({ ...profile })) };
      if (args[2] === "paste-api-key") {
        profiles = profiles.filter((profile) => profile.id !== "deepseek:default");
        profiles.push({ id: "deepseek:default", provider: "deepseek", type: "api_key", label: "deepseek:default" });
        return {};
      }
      if (args[2] === "logout") {
        profiles = profiles.filter((profile) => profile.id !== args[3]);
        return {};
      }
      throw new Error(`unexpected auth CLI call: ${args.join(" ")}`);
    };

    const listed = await backend.listModelAuthProfiles();
    assert.equal(listed.supported, true);
    assert.deepEqual(listed.profiles.map((profile) => profile.id), [
      "openrouter:default",
      "openai:user@example.com",
    ]);
    assert.equal(listed.profiles[0].source, "canonical");
    assert.equal(listed.profiles[0].keyTail, undefined, "9.1 CLI 不暴露 key 尾部");
    assert.equal(listed.profiles[1].displayName, "Example User");
    assert.equal(listed.profiles[1].expires, Date.parse("2026-09-05T00:00:00.000Z"));

    const secret = "sk-9.1-stdin-only";
    const set = await backend.setModelAuthProfileKey("deepseek", secret);
    assert.equal(set.id, "deepseek:default");
    const pasteCall = calls.find((call) => call.args[2] === "paste-api-key");
    assert.deepEqual(pasteCall.args, [
      "models", "auth", "paste-api-key", "--provider", "deepseek", "--profile-id", "deepseek:default",
      "--agent", "main",
    ]);
    assert.equal(pasteCall.stdin, secret);
    assert.equal(pasteCall.args.join(" ").includes(secret), false, "密钥不得进入进程参数");

    const removed = await backend.deleteModelAuthProfile("deepseek:default");
    assert.equal(removed.ok, true);
    assert.ok(calls.some((call) => call.args.join(" ") === "models auth logout deepseek:default --yes --agent main"));

    backend._runModelAuthCli = async () => {
      const error = new Error("canonical store busy");
      error.code = "auth_cli_failed";
      throw error;
    };
    await assert.rejects(
      backend.setModelAuthProfileKey("legacy", "replacement-must-not-land"),
      (error) => error.code === "auth_cli_failed",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, "utf8")), originalLegacy,
      "9.1 CLI 失败不得回退写旧 auth-profiles.json");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("OpenClaw 9.1 保存 Key 同步 agent 同名覆盖，任一失败不得报告成功", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const backend = new OpenClawBackend();
  backend._isLocalGateway = () => true;
  backend._modelAuthCliVersionOverride = "2026.9.1";
  backend._modelAuthAgentIdsOverride = ["main", "cto", "ada", "cto"];
  const stores = new Map(["main", "cto", "ada"].map((agentId) => [agentId, {
    "deepseek:default": { id: "deepseek:default", provider: "deepseek", type: "api_key", key: `old-${agentId}` },
    "deepseek:personal": { id: "deepseek:personal", provider: "deepseek", type: "api_key", key: "keep-personal" },
    "other:oauth": { id: "other:oauth", provider: "other", type: "oauth" },
  }]));
  let failure = null;
  const calls = [];
  backend._runModelAuthCli = async (args, options = {}) => {
    const agentId = args[args.indexOf("--agent") + 1];
    const action = args[2];
    calls.push({ action, agentId, args });
    if (failure?.agentId === agentId && failure.action === action) {
      const error = new Error("canonical store busy");
      error.code = "auth_cli_failed";
      throw error;
    }
    const store = stores.get(agentId);
    if (action === "list") return { profiles: Object.values(store).map(({ key, ...row }) => row) };
    assert.equal(action, "paste-api-key");
    assert.equal(args.includes(options.stdin), false, "密钥不能进入进程参数");
    store["deepseek:default"].key = options.stdin;
    return {};
  };
  backend._syncAgentSqliteAuthKey = () => assert.fail("9.1 不得直接写 SQLite");
  backend._writeAuthProfiles = () => assert.fail("9.1 不得回退旧 JSON");

  assert.equal((await backend.setModelAuthProfileKey("deepseek", "replacement-key")).ok, true);
  assert.deepEqual(calls.map(({ action, agentId }) => `${action}:${agentId}`), [
    "list:main", "list:cto", "list:ada",
    "paste-api-key:main", "paste-api-key:cto", "paste-api-key:ada",
  ]);
  for (const store of stores.values()) {
    assert.equal(store["deepseek:default"].key, "replacement-key");
    assert.equal(store["deepseek:personal"].key, "keep-personal");
    assert.equal(store["other:oauth"].type, "oauth");
  }
  assert.equal(JSON.stringify(backend._canonicalAuthProfiles).includes("replacement-key"), false);

  calls.length = 0;
  stores.get("ada")["deepseek:default"].type = "oauth";
  await assert.rejects(backend.setModelAuthProfileKey("deepseek", "do-not-write"),
    (error) => error.code === "auth_type_mismatch" && error.message.includes("ada"));
  assert.ok(calls.every(({ action }) => action === "list"), "agent 类型冲突必须在所有写入前阻断");
  stores.get("ada")["deepseek:default"].type = "api_key";

  calls.length = 0;
  failure = { agentId: "cto", action: "list" };
  await assert.rejects(backend.setModelAuthProfileKey("deepseek", "do-not-write"),
    (error) => error.code === "auth_cli_failed");
  assert.ok(calls.every(({ action }) => action === "list"), "未能读取 agent 授权时不得开始写入");

  failure = { agentId: "cto", action: "paste-api-key" };
  await assert.rejects(backend.setModelAuthProfileKey("deepseek", "retry-key"),
    (error) => error.code === "auth_cli_failed" && error.message.includes("cto"));
  assert.equal(stores.get("main")["deepseek:default"].key, "retry-key");
  assert.equal(stores.get("cto")["deepseek:default"].key, "replacement-key");
  failure = null;
  assert.equal((await backend.setModelAuthProfileKey("deepseek", "retry-key")).ok, true);
  assert.ok([...stores.values()].every((store) => store["deepseek:default"].key === "retry-key"));
});

test("OpenClaw 9.1 Key 同步必须完整读取 configured agent roster", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-roster-91-"));
  const originalHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = directory;
  try {
    const backend = new OpenClawBackend();
    backend._isLocalGateway = () => true;
    backend._modelAuthCliVersionOverride = "2026.9.1";
    backend._runModelAuthCli = async () => assert.fail("未读到 roster 不得调用授权 CLI");
    await assert.rejects(backend.setModelAuthProfileKey("deepseek", "test-key"), { code: "ENOENT" });
    fs.writeFileSync(path.join(directory, "openclaw.json"), JSON.stringify({
      agents: { entries: { cto: {}, main: {}, ada: {} } },
    }));
    assert.deepEqual(backend._modelAuthAgentIds(), ["main", "cto", "ada"]);
    fs.writeFileSync(path.join(directory, "openclaw.json"), "broken");
    await assert.rejects(backend.setModelAuthProfileKey("deepseek", "test-key"), SyntaxError);
  } finally {
    if (originalHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalHome;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("OpenClaw 9.1 provider 改名：旧授权必须显式重建，OAuth 要求重新登录", async () => {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const makeCanonicalBackend = (profiles) => {
    const backend = new OpenClawBackend();
    backend._isLocalGateway = () => true;
    backend._usesCanonicalModelAuthCli = () => true;
    backend._modelAuthAgentIdsOverride = ["main"];
    backend._loadCanonicalAuthProfiles = async () => profiles.map((profile) => ({ ...profile }));
    return backend;
  };

  const missingKey = makeCanonicalBackend([
    { id: "old:default", provider: "old", type: "api_key" },
  ]);
  let renamed = false;
  missingKey._configOnlyRenameProvider = async () => { renamed = true; };
  await assert.rejects(
    missingKey._configOnlyUpdateProvider({ providerKey: "old", patch: { renameTo: "next" } }, {}),
    (error) => error.code === "auth_profile_reauth_required" && error.status === 409,
  );
  assert.equal(renamed, false, "缺新 key 时必须在 config 改名前阻断");

  const oauth = makeCanonicalBackend([
    { id: "old:user", provider: "old", type: "oauth" },
  ]);
  oauth._configOnlyRenameProvider = async () => { throw new Error("must not rename"); };
  await assert.rejects(
    oauth._configOnlyUpdateProvider(
      { providerKey: "old", patch: { renameTo: "next" } },
      { apiKey: "new-key-does-not-convert-oauth" },
    ),
    (error) => error.code === "auth_profile_reauth_required" && error.status === 409,
  );

  const apiKey = makeCanonicalBackend([
    { id: "old:default", provider: "old", type: "api_key" },
  ]);
  const order = [];
  apiKey._writeAuthProfileKey = async (provider, key) => {
    order.push(["create", provider, key]);
    return `${provider}:default`;
  };
  apiKey._configOnlyRenameProvider = async (oldKey, newKey) => {
    order.push(["rename", oldKey, newKey]);
    return { restart: true };
  };
  apiKey._deleteCanonicalAuthProfile = async (id) => { order.push(["delete", id]); };
  await apiKey._configOnlyUpdateProvider(
    { providerKey: "old", patch: { renameTo: "next" } },
    { apiKey: "replacement" },
  );
  assert.deepEqual(order, [
    ["create", "next", "replacement"],
    ["rename", "old", "next"],
    ["delete", "old:default"],
  ]);
});

/** 逐项执行已注册测试，并以进程退出码让 CI 判断契约是否成立。 */
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (error) {
      console.error(`model change contract unit: FAIL - ${name}`);
      throw error;
    }
  }
  console.log("model change contract unit: PASS");
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
