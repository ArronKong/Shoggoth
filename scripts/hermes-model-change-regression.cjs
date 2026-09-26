#!/usr/bin/env node
"use strict";

// Hermes 条件写、per-profile mutation gate 与 coordinator capability 定向回归。
// 全部用内存响应，不连接或修改用户 dashboard。

const assert = require("node:assert/strict");
const http = require("node:http");
const {
  createHermesModelMutationGate,
} = require("../app/core/hermes-model-mutation");
const {
  HERMES_SCANNER_VERSION,
  HERMES_REFERENCE_SCANNERS,
  validateHermesReferenceScanners,
  scanHermesReferences,
} = require("../app/core/hermes-model-references");
const { createHermesModelChange } = require("../app/core/hermes-model-change");
const { HermesBackend } = require("../app/core/hermes-backend");

const tests = [];

/** 注册顺序执行的独立回归。 */
function test(name, run) {
  tests.push({ name, run });
}

/** 生成只包含白名单响应头的条件写响应。 */
function conditionalResponse(etag = '"v1"', declaration = "if-match") {
  return {
    status: 200,
    body: "{}",
    headers: {
      etag,
      "x-hermes-conditional-write": declaration,
      "x-hermes-mutation-version": "1",
    },
  };
}

/** 创建旧/新 Hermes dashboard loopback，真实检查 If-Match 与 412 保值。 */
async function dashboardFixture({ conditional = true } = {}) {
  const state = {
    etag: '"v1"',
    provider: { base_url: "https://old.example", models: [{ id: "old" }] },
    writes: 0,
    conflictNextPut: false,
  };
  const server = http.createServer((req, res) => {
    if (conditional) {
      res.setHeader("ETag", state.etag);
      res.setHeader("X-Hermes-Conditional-Write", "if-match");
      res.setHeader("X-Hermes-Mutation-Version", "1");
    }
    if (req.method === "GET" && req.url === "/api/config") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ providers: { alpha: state.provider } }));
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        state.writes += 1;
        if (state.conflictNextPut) {
          state.conflictNextPut = false;
          state.etag = '"external-v2"';
        }
        if (!conditional || req.headers["if-match"] !== state.etag) {
          res.statusCode = conditional ? 412 : 428;
          res.end("conflict");
          return;
        }
        const fields = JSON.parse(raw)?.config?.providers?.alpha;
        state.provider = { ...state.provider, ...fields };
        state.etag = '"v2"';
        res.setHeader("ETag", state.etag);
        res.setHeader("X-Hermes-Conditional-Write", "if-match");
        res.setHeader("X-Hermes-Mutation-Version", "1");
        res.end("{}");
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const backend = new HermesBackend();
  backend.dashboards.set("default", {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "fixture-token",
  });
  return {
    backend,
    state,
    async authorizedUpdate(patch, operationId = "authorized-update") {
      return backend._withModelChangeCoordinatorContext(
        operationId,
        () => backend.updateModelProvider("alpha", patch),
      );
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

/** 为五类 scanner 提供逐 Profile 原始 store 页；未声明页返回明确空终点。 */
function referenceBackend(pages = {}) {
  const profiles = [...new Set(Object.keys(pages).map((key) => key.split(":")[0]))].sort();
  return {
    dashboards: new Map(profiles.map((profile) => [profile, { profile }])),
    async readHermesModelReferenceStore(profile, store, options = {}) {
      const key = `${profile}:${store}:${options.offset || 0}`;
      const value = pages[key] ?? pages[`${profile}:${store}`];
      if (value instanceof Error) throw value;
      const body = value?.body ?? (
        store === "provider" ? { providers: {} }
          : store === "main" ? {}
            : store === "auxiliary" ? { tasks: [] }
              : store === "cron" ? { jobs: [], has_more: false }
                : { sessions: [], has_more: false, total: 0 }
      );
      return {
        status: value?.status ?? 200,
        body,
        headers: value?.headers ?? {
          etag: `"${profile}-${store}-v1"`,
          "x-hermes-conditional-write": "if-match",
          "x-hermes-mutation-version": "1",
        },
      };
    },
    async writeHermesModelReference() { return { status: 200, body: {}, headers: {} }; },
  };
}

/** rename safeSpec 统一使用 provider+id 精确身份。 */
function hermesRenameSpec(overrides = {}) {
  return {
    kind: "rename",
    providerKey: "alpha",
    sourceModelId: "old",
    model: { id: "new" },
    ...overrides,
  };
}

/** 构造无外部 I/O 的 Hermes saga fake，记录每个 Provider 操作与阶段。 */
function hermesSagaHarness() {
  const mutationGate = createHermesModelMutationGate();
  const state = {
    profiles: new Map([
      ["bull", new Set(["old"])],
      ["default", new Set(["old"])],
    ]),
    calls: [],
  };
  const backend = {
    dashboards: new Map([["bull", {}], ["default", {}]]),
    // preview 必须以全部 Profile 的 fresh Provider 真值检查 source/target。
    async _readProvidersByProfile() {
      return new Map([...state.profiles].map(([profile, models]) => [profile, {
        alpha: { models: [...models].map((id) => ({ id })) },
      }]));
    },
    _hermesModelEntries(models) {
      return Array.isArray(models) ? models : [];
    },
    _withModelChangeCoordinatorContext(operationId, run) {
      return mutationGate.withCoordinatorContext(operationId, run);
    },
    async getHermesConditionalWriteCapabilities() {
      return { supported: true, create: true, update: true, rename: true, delete: true, blockers: [] };
    },
    async addModelConfig(spec) {
      mutationGate.assertCoordinatorContext();
      state.calls.push(["add", spec.model.id]);
      for (const models of state.profiles.values()) models.add(spec.model.id);
      return {};
    },
    async removeModelConfig(ref) {
      mutationGate.assertCoordinatorContext();
      state.calls.push(["remove-model", ref.modelId]);
      for (const models of state.profiles.values()) models.delete(ref.modelId);
      return {};
    },
    async removeModelProvider(providerKey) {
      mutationGate.assertCoordinatorContext();
      state.calls.push(["remove-provider", providerKey]);
      for (const models of state.profiles.values()) models.clear();
      return {};
    },
    async updateModelProvider(providerKey) {
      mutationGate.assertCoordinatorContext();
      state.calls.push(["update-provider", providerKey]);
      return {};
    },
    async verifyHermesModelTarget(spec, profiles) {
      return profiles.every((profile) => state.profiles.get(profile)?.has(spec.model.id));
    },
    async getModelCatalogSources() { return { models: [], config: [], runtime: [] }; },
  };
  const scan = async (_backend, spec) => ({
    scannerVersion: 1,
    profiles: ["bull", "default"],
    references: [],
    blockers: [],
    stores: {},
    fingerprints: { scannerVersion: 1, kind: spec.kind, source: spec.sourceModelId || null, target: spec.model?.id || null },
  });
  const adapter = createHermesModelChange({
    backend,
    mutationGate,
    scanners: HERMES_REFERENCE_SCANNERS,
    scan,
  });
  return { adapter, backend, mutationGate, state, scan };
}

/** 构造可观测 journal context。 */
function sagaContext(operationId, fingerprints) {
  const events = [];
  return {
    events,
    value: {
      operationId,
      journalEntry: { fingerprints },
      assertProviderLease() {},
      async recordStage(stage) { events.push(stage); },
      async recordStep(step) { events.push(`${step.store}:${step.referenceKey}`); },
      async markCommitting() { events.push("committing"); },
      async markCommitted() { events.push("committed"); },
    },
  };
}

/** 构造 Hermes adapter crash recovery 使用的最小 journal 摘要。 */
function hermesRecoveryEntry({
  operationId,
  kind = "rename",
  commitState = "committing",
  sourceModelId = "old",
  targetModelId = "new",
} = {}) {
  return {
    operationId,
    kind,
    providerKey: "alpha",
    commitState,
    status: "in_progress",
    stage: commitState === "precommit" ? "stage-target" : "commit",
    source: sourceModelId ? { provider: "alpha", modelId: sourceModelId } : null,
    target: targetModelId ? { provider: "alpha", modelId: targetModelId } : null,
    modelDiff: targetModelId ? {
      before: sourceModelId ? { id: sourceModelId, provider: "alpha", backendId: "hermes" } : null,
      after: { id: targetModelId, provider: "alpha", backendId: "hermes" },
    } : sourceModelId ? {
      before: { id: sourceModelId, provider: "alpha", backendId: "hermes" },
      after: null,
    } : null,
    createdProvider: false,
    secretStep: "not_required",
    fingerprints: { provider: "crashed-process" },
    steps: [],
  };
}

test("inspectStore 只有 ETag + if-match 同时存在才声明支持", () => {
  const gate = createHermesModelMutationGate();
  assert.equal(gate.inspectStore(conditionalResponse(), "provider").supported, true);
  assert.equal(gate.inspectStore({ status: 200, body: "{}", headers: { etag: '"v1"' } }, "provider").supported, false);
  assert.equal(gate.inspectStore({ status: 200, body: "{}", headers: { "x-hermes-conditional-write": "if-match" } }, "provider").supported, false);
  assert.equal(gate.inspectStore(conditionalResponse("", "if-match"), "provider").supported, false);
});

test("conditionalHeaders 只返回 If-Match，412 映射稳定冲突且不泄露响应正文", () => {
  const gate = createHermesModelMutationGate();
  const snapshot = gate.inspectStore(conditionalResponse('"secret-free-etag"'), "provider");
  assert.deepEqual(gate.conditionalHeaders(snapshot), { "If-Match": '"secret-free-etag"' });
  assert.throws(
    () => gate.assertConditionalSuccess({ status: 412, body: "token=do-not-leak", headers: {} }, snapshot),
    (error) => error?.code === "hermes_write_conflict"
      && error?.status === 409
      && !String(error.message).includes("do-not-leak"),
  );
  assert.throws(
    () => gate.conditionalHeaders({ supported: false, store: "provider" }),
    (error) => error?.code === "hermes_conditional_write_unsupported",
  );
});

test("同 Profile 串行、不同 Profile 可并发，多锁按排序顺序避免死锁", async () => {
  const gate = createHermesModelMutationGate();
  let sameActive = 0;
  let sameMax = 0;
  let allActive = 0;
  let allMax = 0;
  const run = (profiles, id) => gate.withProfiles(profiles, id, async () => {
    sameActive += profiles.includes("default") ? 1 : 0;
    sameMax = Math.max(sameMax, sameActive);
    allActive += 1;
    allMax = Math.max(allMax, allActive);
    await new Promise((resolve) => setTimeout(resolve, 10));
    allActive -= 1;
    sameActive -= profiles.includes("default") ? 1 : 0;
  });
  await Promise.all([
    run(["default"], "same-a"),
    run(["default"], "same-b"),
    run(["bull"], "other"),
    run(["bull", "default"], "multi-reversed"),
  ]);
  assert.equal(sameMax, 1);
  assert.equal(allMax >= 2, true, "不同 Profile 应能并发");
});

test("coordinator context 不导出 capability，闭包外 Provider 写稳定拒绝", async () => {
  const gate = createHermesModelMutationGate();
  assert.throws(
    () => gate.assertCoordinatorContext(),
    (error) => error?.code === "model_change_coordinator_required",
  );
  await gate.withCoordinatorContext("operation-one", async () => {
    assert.equal(gate.assertCoordinatorContext().operationId, "operation-one");
  });
  assert.throws(
    () => gate.assertCoordinatorContext(),
    (error) => error?.code === "model_change_coordinator_required",
  );
});

test("HermesBackend legacy Provider 写在任何配置 GET/PUT 前要求 coordinator", async () => {
  const backend = new HermesBackend();
  let reads = 0;
  let writes = 0;
  backend._readProvidersByProfile = async () => { reads += 1; return new Map(); };
  backend._putProviderEntry = async () => { writes += 1; };
  await assert.rejects(
    backend.updateModelProvider("alpha", { baseUrl: "https://new.example" }),
    (error) => error?.code === "model_change_coordinator_required",
  );
  assert.deepEqual({ reads, writes }, { reads: 0, writes: 0 });
});

test("旧 dashboard capability 全 false，授权写也在首个 PUT 前 fail-closed", async () => {
  const fixture = await dashboardFixture({ conditional: false });
  try {
    const capabilities = await fixture.backend.getModelChangeCapabilities();
    assert.deepEqual(
      [capabilities.create, capabilities.update, capabilities.rename, capabilities.delete, capabilities.updateProvider],
      [false, false, false, false, false],
    );
    await assert.rejects(
      fixture.authorizedUpdate({ baseUrl: "https://new.example" }),
      (error) => error?.code === "hermes_conditional_write_unsupported",
    );
    assert.equal(fixture.state.writes, 0);
    assert.equal(fixture.state.provider.base_url, "https://old.example");
  } finally {
    await fixture.close();
  }
});

test("新 dashboard 同时证明 ETag/if-match 后开放能力并条件更新", async () => {
  const fixture = await dashboardFixture({ conditional: true });
  try {
    const capabilities = await fixture.backend.getModelChangeCapabilities();
    assert.deepEqual(
      [capabilities.create, capabilities.update, capabilities.rename, capabilities.delete, capabilities.updateProvider],
      [true, true, true, true, true],
    );
    await fixture.authorizedUpdate({ baseUrl: "https://new.example" });
    assert.equal(fixture.state.writes, 1);
    assert.equal(fixture.state.provider.base_url, "https://new.example");
  } finally {
    await fixture.close();
  }
});

test("Hermes 多 Profile 条件写失败也等待全部在途 PUT 结束后再释放 gate", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("bull", { profile: "bull" });
  backend.dashboards.set("default", { profile: "default" });
  backend._readProvidersByProfile = async () => new Map([
    ["bull", { alpha: { base_url: "https://old.example", models: [{ id: "old" }] } }],
    ["default", { alpha: { base_url: "https://old.example", models: [{ id: "old" }] } }],
  ]);
  let releaseLateWrite;
  const lateWrite = new Promise((resolve) => { releaseLateWrite = resolve; });
  let lateWriteFinished = false;
  backend._putProviderEntry = async (dash) => {
    if (dash.profile === "bull") {
      const error = new Error("conflict");
      error.code = "hermes_write_conflict";
      throw error;
    }
    await lateWrite;
    lateWriteFinished = true;
  };
  const pending = backend._withModelChangeCoordinatorContext(
    "multi-profile-write",
    () => backend.addModelConfig({ providerKey: "alpha", model: { id: "new" } }),
  );
  let settled = false;
  pending.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "首个冲突不得让方法早于其它 PUT 返回");
  releaseLateWrite();
  await assert.rejects(pending, (error) => error?.code === "hermes_write_conflict");
  assert.equal(lateWriteFinished, true);
});

test("外部 writer 在 GET 后更新 ETag 时返回稳定冲突且不覆盖外部值", async () => {
  const fixture = await dashboardFixture({ conditional: true });
  try {
    fixture.state.conflictNextPut = true;
    await assert.rejects(
      fixture.authorizedUpdate({ baseUrl: "https://shoggoth.example" }, "conflict-update"),
      (error) => error?.code === "hermes_write_conflict" && error?.status === 409,
    );
    assert.equal(fixture.state.provider.base_url, "https://old.example");
    assert.equal(fixture.state.etag, '"external-v2"');
  } finally {
    await fixture.close();
  }
});

test("Hermes scanner registry 固定版本、五 store 且每项具备五方法", () => {
  assert.equal(HERMES_SCANNER_VERSION, 1);
  assert.deepEqual(HERMES_REFERENCE_SCANNERS.map((scanner) => scanner.store), [
    "provider", "main", "auxiliary", "cron", "sessions",
  ]);
  assert.equal(validateHermesReferenceScanners(HERMES_REFERENCE_SCANNERS), HERMES_REFERENCE_SCANNERS);
  assert.throws(
    () => validateHermesReferenceScanners([{ id: "broken", store: "provider", enumerate() {} }]),
    (error) => error?.code === "invalid_hermes_reference_scanner",
  );
});

test("Provider scanner 按 Profile + provider + modelId 精确匹配，不误伤同名 beta", async () => {
  const backend = referenceBackend({
    "default:provider": {
      body: {
        providers: {
          alpha: { base_url: "https://alpha.example", models: [{ id: "old" }] },
          beta: { base_url: "https://beta.example", models: [{ id: "old" }] },
        },
      },
    },
  });
  const result = await scanHermesReferences(backend, hermesRenameSpec());
  const providerRefs = result.references.filter((reference) => reference.store === "provider");
  assert.equal(providerRefs.length, 1);
  assert.equal(providerRefs[0].profile, "default");
  assert.equal(providerRefs[0].before.provider, "alpha");
  assert.equal(providerRefs[0].before.modelId, "old");
  assert.equal(providerRefs[0].after.modelId, "new");
  assert.equal(providerRefs[0].definition, true);
});

test("Hermes delete-model preview 过滤 Provider definition 但保留真实 Main 引用", async () => {
  const backend = referenceBackend({
    "default:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "default:main": { body: { provider: "alpha", model: "old" } },
  });
  backend._withModelChangeCoordinatorContext = async (_operationId, run) => run();
  backend.getHermesConditionalWriteCapabilities = async () => ({ supported: true, create: true, update: true, rename: true, delete: true, blockers: [] });
  const mutationGate = createHermesModelMutationGate();
  const adapter = createHermesModelChange({ backend, mutationGate });
  const result = await adapter.preview({ kind: "delete-model", providerKey: "alpha", sourceModelId: "old" });
  assert.equal(result.references.some((reference) => reference.definition === true), false);
  assert.deepEqual(result.references.map((reference) => reference.store), ["main"]);
});

test("Main/Aux 精确迁移；Aux auto 只能用同 snapshot main provider 消歧", async () => {
  const backend = referenceBackend({
    "default:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "default:main": { body: { provider: "alpha", model: "old" } },
    "default:auxiliary": {
      body: {
        tasks: [
          { task: "summary", provider: "alpha", model: "old" },
          { task: "auto-ok", provider: "auto", model: "old" },
        ],
      },
    },
  });
  const result = await scanHermesReferences(backend, hermesRenameSpec());
  assert.deepEqual(
    result.references.filter((reference) => ["main", "auxiliary"].includes(reference.store))
      .map((reference) => `${reference.store}:${reference.referenceKey}`),
    ["main:default:main", "auxiliary:default:summary", "auxiliary:default:auto-ok"],
  );

  const ambiguous = referenceBackend({
    "default:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "default:main": { body: { provider: "beta", model: "other" } },
    "default:auxiliary": { body: { tasks: [{ task: "auto", provider: "auto", model: "old" }] } },
  });
  const blocked = await scanHermesReferences(ambiguous, hermesRenameSpec());
  assert.equal(blocked.blockers.some((item) => item.code === "ambiguous_auto_provider"), true);
});

test("Cron 重复 owner 或截断不明会阻断，精确 provider/model/fallbacks 才生成引用", async () => {
  const backend = referenceBackend({
    "a:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "b:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "a:cron": { body: { jobs: [{ id: "job-1", provider: "alpha", model: "old", fallbacks: [] }], has_more: false } },
    "b:cron": { body: { jobs: [{ id: "job-1", provider: "alpha", model: "old", fallbacks: [] }], has_more: false } },
  });
  const result = await scanHermesReferences(backend, hermesRenameSpec());
  assert.equal(result.blockers.some((item) => item.code === "cron_owner_ambiguous"), true);

  const truncated = referenceBackend({
    "default:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "default:cron": { body: { jobs: Array.from({ length: 200 }, (_, index) => ({ id: `job-${index}` })) } },
  });
  const incomplete = await scanHermesReferences(truncated, hermesRenameSpec());
  assert.equal(incomplete.blockers.some((item) => item.code === "cron_enumeration_incomplete"), true);

  const shortUnproven = referenceBackend({
    "default:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "default:cron": { body: { jobs: [{ id: "short-page" }] } },
  });
  const shortIncomplete = await scanHermesReferences(shortUnproven, hermesRenameSpec());
  assert.equal(
    shortIncomplete.blockers.some((item) => item.code === "cron_enumeration_incomplete"),
    true,
    "短页也必须有 has_more=false 或精确 total 才能证明到达末页",
  );
});

test("Session offset 持续到明确终点并对任何裸 source 产生不可写 blocker", async () => {
  const backend = referenceBackend({
    "default:provider": { body: { providers: { alpha: { models: [{ id: "old" }] } } } },
    "default:sessions:0": {
      body: {
        sessions: Array.from({ length: 2 }, (_, index) => ({ id: `s-${index}`, model: index === 0 ? "old" : "new" })),
        has_more: true,
        next_offset: 2,
        total: 3,
      },
    },
    "default:sessions:2": {
      body: { sessions: [{ id: "s-2", model: "other" }], has_more: false, total: 3 },
    },
  });
  const result = await scanHermesReferences(backend, hermesRenameSpec(), { pageLimit: 2 });
  assert.equal(result.blockers.some((item) => item.code === "session_model_reference"), true);
  assert.equal(result.references.some((reference) => reference.store === "sessions"), false);
  assert.equal(result.stores.sessions.default.complete, true);
  assert.equal(result.stores.sessions.default.count, 3);
  const sessionScanner = HERMES_REFERENCE_SCANNERS.find((scanner) => scanner.store === "sessions");
  await assert.rejects(
    sessionScanner.write(backend, { profile: "default", referenceKey: "s-0" }),
    (error) => error?.code === "hermes_session_write_unsupported",
  );
});

test("Hermes model-change factory 暴露固定四方法且依赖缺失时拒绝", () => {
  assert.throws(
    () => createHermesModelChange({ backend: {}, mutationGate: {}, scanners: [] }),
    (error) => error?.code === "invalid_hermes_model_change_dependency",
  );
});

test("Hermes capability 明确声明仅 id/contextWindow 可编辑", async () => {
  const harness = hermesSagaHarness();
  const capabilities = await harness.adapter.getCapabilities();
  assert.deepEqual(capabilities.fields, {
    id: true,
    name: false,
    contextWindow: true,
    maxTokens: false,
    reasoning: false,
  });
});

test("Hermes Provider fingerprint 覆盖完整公开模型与安全配置摘要", async () => {
  const makeBackend = (provider) => referenceBackend({
    "default:provider": { body: { providers: { alpha: provider } } },
  });
  const first = await scanHermesReferences(makeBackend({
    base_url: "https://one.example/v1",
    api_mode: "chat",
    models: [{ id: "old", context_length: 4096 }],
  }), hermesRenameSpec());
  const fieldChanged = await scanHermesReferences(makeBackend({
    base_url: "https://one.example/v1",
    api_mode: "chat",
    models: [{ id: "old", context_length: 8192 }],
  }), hermesRenameSpec());
  const endpointChanged = await scanHermesReferences(makeBackend({
    base_url: "https://two.example/v1",
    api_mode: "chat",
    models: [{ id: "old", context_length: 4096 }],
  }), hermesRenameSpec());
  assert.notEqual(first.fingerprints.provider, fieldChanged.fingerprints.provider);
  assert.notEqual(first.fingerprints.provider, endpointChanged.fingerprints.provider);
  assert.equal(JSON.stringify([first.fingerprints, endpointChanged.fingerprints]).includes("example/v1"), false);
});

test("Hermes apply 在 Profile gate 内重新预检并阻断锁等待期间出现的目标冲突", async () => {
  const harness = hermesSagaHarness();
  let reads = 0;
  const originalRead = harness.backend._readProvidersByProfile;
  harness.backend._readProvidersByProfile = async (...args) => {
    reads += 1;
    if (reads >= 3) harness.state.profiles.get("bull").add("new");
    return originalRead(...args);
  };
  const preview = await harness.adapter.preview(hermesRenameSpec());
  const context = sagaContext("hermes-lock-revalidation", preview.fingerprints);
  const result = await harness.adapter.apply(hermesRenameSpec(), context.value, null);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "target_conflict");
  assert.equal(harness.state.calls.length, 0);
});

test("Hermes 同 store 多引用写与逆序补偿必须逐次推进 ETag", async () => {
  const mutationGate = createHermesModelMutationGate();
  const values = new Map([["default:k1", "old"], ["default:k2", "old"], ["default:k3", "old"]]);
  let currentEtag = '"v1"';
  let version = 1;
  let failedThird = false;
  const seenEtags = [];
  const backend = {
    dashboards: new Map([["default", {}]]),
    async _readProvidersByProfile() {
      return new Map([["default", { alpha: { models: [{ id: "old" }] } }]]);
    },
    _hermesModelEntries(models) { return Array.isArray(models) ? models : []; },
    _withModelChangeCoordinatorContext(operationId, run) {
      return mutationGate.withCoordinatorContext(operationId, run);
    },
    async getHermesConditionalWriteCapabilities() {
      return { supported: true, create: true, update: true, rename: true, delete: true, blockers: [] };
    },
    async readHermesModelReference(reference) {
      return { profile: "default", provider: "alpha", model: values.get(reference.referenceKey) };
    },
    async writeHermesModelReference(reference, value) {
      seenEtags.push(reference.snapshot.etag);
      assert.equal(reference.snapshot.etag, currentEtag, "每次条件写必须使用上次响应的新 ETag");
      if (reference.referenceKey === "default:k3" && !failedThird) {
        failedThird = true;
        const error = new Error("fixture third write failed");
        error.code = "fixture_write_failed";
        throw error;
      }
      values.set(reference.referenceKey, value.model);
      version += 1;
      currentEtag = `"v${version}"`;
      reference.snapshot = { ...reference.snapshot, etag: currentEtag };
      return conditionalResponse(currentEtag);
    },
    async addModelConfig() { return {}; },
    async removeModelConfig() { return {}; },
  };
  const makeReferences = () => ["k1", "k2", "k3"].map((key) => ({
    scannerId: "hermes.main.v1",
    store: "main",
    profile: "default",
    referenceKey: `default:${key}`,
    before: { profile: "default", provider: "alpha", model: "old" },
    after: { profile: "default", provider: "alpha", model: "new" },
    undo: { profile: "default", provider: "alpha", model: "old" },
    snapshot: { supported: true, etag: '"v1"', store: "main", profile: "default" },
  }));
  const scan = async () => ({
    scannerVersion: 1,
    profiles: ["default"],
    references: makeReferences(),
    blockers: [],
    stores: {},
    fingerprints: { provider: "same", main: "same" },
  });
  const adapter = createHermesModelChange({ backend, mutationGate, scanners: HERMES_REFERENCE_SCANNERS, scan });
  const preview = await adapter.preview(hermesRenameSpec());
  const context = sagaContext("hermes-etag-progression", preview.fingerprints);
  const result = await adapter.apply(hermesRenameSpec(), context.value, null);
  assert.equal(result.status, "compensated");
  assert.deepEqual([...values.values()], ["old", "old", "old"]);
  assert.deepEqual(seenEtags, ['"v1"', '"v2"', '"v3"', '"v3"', '"v4"']);
});

test("Hermes recovery 遇到同 ID 不同普通字段时报告 target_conflict 且零覆盖", async () => {
  const harness = hermesSagaHarness();
  for (const models of harness.state.profiles.values()) {
    models.delete("old");
    models.add("new");
  }
  harness.backend.verifyHermesModelTarget = undefined;
  harness.backend._readProvidersByProfile = async () => new Map([
    ["bull", { alpha: { models: [{ id: "new", context_length: 4096 }] } }],
    ["default", { alpha: { models: [{ id: "new", context_length: 4096 }] } }],
  ]);
  const entry = hermesRecoveryEntry({
    operationId: "hermes-recover-content-conflict",
    kind: "create",
    commitState: "precommit",
    sourceModelId: null,
  });
  entry.modelDiff.after.contextWindow = 8192;
  const context = sagaContext(entry.operationId, entry.fingerprints);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "target_conflict");
  assert.equal(harness.state.calls.length, 0);
});

test("Hermes update 部分 Profile 已写 after、其余仍是 before 时恢复继续收敛", async () => {
  const harness = hermesSagaHarness();
  const rows = new Map([
    ["bull", { id: "old", context_length: 8192 }],
    ["default", { id: "old", context_length: 4096 }],
  ]);
  harness.backend._readProvidersByProfile = async () => new Map(
    [...rows].map(([profile, model]) => [profile, { alpha: { models: [model] } }]),
  );
  harness.backend.addModelConfig = async (spec) => {
    harness.mutationGate.assertCoordinatorContext();
    harness.state.calls.push(["add", spec.model.id]);
    for (const profile of rows.keys()) {
      rows.set(profile, { id: spec.model.id, context_length: spec.model.contextWindow });
    }
    return {};
  };
  harness.backend.verifyHermesModelTarget = async (spec, profiles) => profiles.every(
    (profile) => Number(rows.get(profile)?.context_length) === Number(spec.model.contextWindow),
  );
  const entry = hermesRecoveryEntry({
    operationId: "hermes-recover-update-partial",
    kind: "update",
    commitState: "precommit",
    sourceModelId: "old",
    targetModelId: "old",
  });
  entry.modelDiff.before.contextWindow = 4096;
  entry.modelDiff.after.contextWindow = 8192;
  const context = sagaContext(entry.operationId, entry.fingerprints);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "applied");
  assert.deepEqual([...rows.values()].map((model) => model.context_length), [8192, 8192]);
  assert.deepEqual(harness.state.calls, [["add", "old"]]);
});

test("Hermes update 恢复按逐 Profile 异构 before 判定，不把合法旧值当冲突", async () => {
  const harness = hermesSagaHarness();
  let rows = new Map([
    ["bull", { id: "old", context_length: 8192 }],
    ["default", { id: "old", context_length: 4096 }],
  ]);
  harness.backend._readProvidersByProfile = async () => new Map(
    [...rows].map(([profile, model]) => [profile, { alpha: { models: [model] } }]),
  );
  harness.backend.addModelConfig = async (spec) => {
    harness.mutationGate.assertCoordinatorContext();
    rows = new Map([...rows].map(([profile]) => [profile, {
      id: spec.model.id,
      context_length: spec.model.contextWindow,
    }]));
    return {};
  };
  harness.backend.verifyHermesModelTarget = async (spec, profiles) => profiles.every(
    (profile) => Number(rows.get(profile)?.context_length) === Number(spec.model.contextWindow),
  );
  const spec = { kind: "update", providerKey: "alpha", sourceModelId: "old", model: { id: "old", contextWindow: 16384 } };
  const preview = await harness.adapter.preview(spec);
  assert.equal(Array.isArray(preview.modelProfiles), true);
  rows.get("default").context_length = 16384;
  const entry = hermesRecoveryEntry({
    operationId: "hermes-recover-update-heterogeneous",
    kind: "update",
    commitState: "precommit",
    sourceModelId: "old",
    targetModelId: "old",
  });
  entry.modelDiff.before.contextWindow = 4096;
  entry.modelDiff.after.contextWindow = 16384;
  entry.modelDiff.profiles = preview.modelProfiles;
  const result = await harness.adapter.recover(entry, sagaContext(entry.operationId, entry.fingerprints).value);
  assert.equal(result.status, "applied");
  assert.equal([...rows.values()].every((model) => model.context_length === 16384), true);
});

test("Hermes 多 Profile secret 变更在逐 Profile secret journal 完成前首写前拒绝", async () => {
  const harness = hermesSagaHarness();
  const spec = { kind: "create", providerKey: "alpha", providerMode: "existing", model: { id: "secret-model" } };
  const preview = await harness.adapter.preview(spec);
  const result = await harness.adapter.apply(
    spec,
    sagaContext("hermes-multi-profile-secret", preview.fingerprints).value,
    { apiKey: "ephemeral-secret" },
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "hermes_multi_profile_secret_unsupported");
  assert.equal(harness.state.calls.length, 0);
});

test("Hermes Provider 跨 Profile 混合 before/after 摘要恢复为 needs_secret 而非永久冲突", async () => {
  const harness = hermesSagaHarness();
  let byProfile = new Map([
    ["bull", { alpha: { base_url: "https://old.example/v1", models: [{ id: "old" }] } }],
    ["default", { alpha: { base_url: "https://old.example/v1", models: [{ id: "old" }] } }],
  ]);
  harness.backend._readProvidersByProfile = async () => byProfile;
  const spec = { kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://new.example/v1" } };
  const preview = await harness.adapter.preview(spec);
  assert.equal(Array.isArray(preview.providerDiff.profiles), true);
  byProfile = new Map([
    ["bull", { alpha: { base_url: "https://new.example/v1", models: [{ id: "old" }] } }],
    ["default", { alpha: { base_url: "https://old.example/v1", models: [{ id: "old" }] } }],
  ]);
  const entry = hermesRecoveryEntry({
    operationId: "hermes-provider-partial",
    kind: "update-provider",
    commitState: "precommit",
    sourceModelId: null,
    targetModelId: null,
  });
  entry.stage = "stage-target";
  entry.providerDiff = preview.providerDiff;
  const result = await harness.adapter.recover(entry, sagaContext(entry.operationId, entry.fingerprints).value);
  assert.equal(result.status, "needs_secret");
  assert.equal(result.code, "recovery_input_required");
  assert.equal(JSON.stringify(entry).includes("new.example"), false);
});

test("Hermes Provider needs_secret 以同 operationId 续提时接受已记录的混合状态", async () => {
  const harness = hermesSagaHarness();
  harness.backend.dashboards = new Map([["default", {}]]);
  let byProfile = new Map([
    ["default", { alpha: { base_url: "https://old.example/v1", models: [{ id: "old" }] } }],
  ]);
  harness.backend._readProvidersByProfile = async () => byProfile;
  harness.backend.updateModelProvider = async () => {
    harness.mutationGate.assertCoordinatorContext();
    byProfile = new Map([...byProfile].map(([profile, providers]) => [profile, {
      alpha: { ...providers.alpha, base_url: "https://new.example/v1" },
    }]));
    return {};
  };
  const spec = { kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://new.example/v1" } };
  const original = await harness.adapter.preview(spec);
  byProfile.get("default").alpha.base_url = "https://old.example/v1";
  const context = sagaContext("hermes-provider-resume", original.fingerprints);
  context.value.journalEntry = {
    status: "needs_secret",
    fingerprints: original.fingerprints,
    providerDiff: original.providerDiff,
  };
  const result = await harness.adapter.apply(spec, context.value, { apiKey: "ephemeral-secret" });
  assert.equal(result.status, "applied");
  assert.equal([...byProfile.values()].every((providers) => providers.alpha.base_url === "https://new.example/v1"), true);
});

test("Hermes rename 部分 Profile stage 成功时记录阶段并保留给恢复前向收敛", async () => {
  const harness = hermesSagaHarness();
  const error = new Error("conditional conflict after bull applied");
  error.code = "hermes_write_conflict";
  error.partialProfiles = ["bull"];
  error.failedProfiles = ["default"];
  harness.backend.addModelConfig = async () => {
    harness.mutationGate.assertCoordinatorContext();
    harness.state.profiles.get("bull").add("new");
    throw error;
  };
  const spec = hermesRenameSpec();
  const preview = await harness.adapter.preview(spec);
  const context = sagaContext("hermes-rename-partial-stage", preview.fingerprints);
  const result = await harness.adapter.apply(spec, context.value, null);
  assert.equal(result.status, "partial");
  assert.equal(context.events.includes("stage-target"), true);
  assert.equal(harness.state.profiles.get("bull").has("new"), true);
  assert.equal(harness.state.profiles.get("default").has("new"), false);
  assert.equal(harness.state.calls.some((call) => call[0] === "remove-model"), false);
});

test("HermesBackend model-change 契约委托 adapter 并补充静态能力", async () => {
  const calls = [];
  const adapter = {
    async getCapabilities() { calls.push("capabilities"); return { supported: true }; },
    async preview(spec) { calls.push(["preview", spec]); return { references: [], blockers: [] }; },
    async apply(spec) { calls.push(["apply", spec]); return { status: "applied" }; },
    async recover(entry) { calls.push(["recover", entry]); return { status: "applied" }; },
  };
  const backend = new HermesBackend();
  backend.attachModelChangeAdapter(adapter);
  assert.deepEqual(await backend.getModelChangeCapabilities(), {
    supported: true,
    perAgentModelSettings: true,
  });
  assert.deepEqual(await backend.previewModelChange({ kind: "create" }), { references: [], blockers: [] });
  assert.deepEqual(await backend.applyModelChange({ kind: "create" }, {}, null), { status: "applied" });
  assert.deepEqual(await backend.recoverModelChange({ operationId: "recover" }, {}), { status: "applied" });
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "capabilities", "preview", "apply", "recover",
  ]);
});

test("Hermes rename 按五阶段 stage target、保留 source、committing 后 retire", async () => {
  const harness = hermesSagaHarness();
  const spec = hermesRenameSpec();
  const preview = await harness.adapter.preview(spec);
  const context = sagaContext("hermes-rename", preview.fingerprints);
  const result = await harness.adapter.apply(spec, context.value, null);
  assert.equal(result.status, "applied");
  assert.deepEqual(harness.state.calls, [["add", "new"], ["remove-model", "old"]]);
  for (const models of harness.state.profiles.values()) assert.deepEqual([...models], ["new"]);
  assert.deepEqual(context.events, [
    "preflight", "stage-target", "migrate-references", "verify-ready",
    "committing", "committed", "commit-retire",
  ]);
});

test("Hermes preview 在首写前阻断 source 缺失与跨 Profile target 冲突", async () => {
  const missing = hermesSagaHarness();
  for (const models of missing.state.profiles.values()) models.delete("old");
  const missingPreview = await missing.adapter.preview(hermesRenameSpec());
  assert.equal(missingPreview.blockers.some((item) => item.code === "source_not_found"), true);
  const missingContext = sagaContext("hermes-missing-source", missingPreview.fingerprints);
  const missingResult = await missing.adapter.apply(hermesRenameSpec(), missingContext.value, null);
  assert.equal(missingResult.status, "blocked");
  assert.equal(missing.state.calls.length, 0);

  const conflict = hermesSagaHarness();
  conflict.state.profiles.get("bull").add("new");
  const conflictPreview = await conflict.adapter.preview(hermesRenameSpec());
  assert.equal(conflictPreview.blockers.some((item) => item.code === "target_conflict"), true);
  const conflictContext = sagaContext("hermes-target-conflict", conflictPreview.fingerprints);
  const conflictResult = await conflict.adapter.apply(hermesRenameSpec(), conflictContext.value, null);
  assert.equal(conflictResult.status, "blocked");
  assert.equal(conflict.state.calls.length, 0);
});

test("Hermes crash recovery 在 source+target 并存时继续 rename retire", async () => {
  const harness = hermesSagaHarness();
  for (const models of harness.state.profiles.values()) models.add("new");
  const entry = hermesRecoveryEntry({ operationId: "hermes-recover-staged" });
  const context = sagaContext(entry.operationId, entry.fingerprints);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "applied");
  for (const models of harness.state.profiles.values()) assert.deepEqual([...models], ["new"]);
  assert.equal(harness.state.calls.some((call) => call[0] === "remove-model" && call[1] === "old"), true);
  assert.equal(context.events.includes("committed"), true);
});

test("Hermes crash recovery 在 source 已缺失且 target 存在时只前向收敛", async () => {
  const harness = hermesSagaHarness();
  for (const models of harness.state.profiles.values()) {
    models.delete("old");
    models.add("new");
  }
  const entry = hermesRecoveryEntry({ operationId: "hermes-recover-retired" });
  const context = sagaContext(entry.operationId, entry.fingerprints);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "applied");
  assert.equal(harness.state.calls.length, 0);
  assert.equal(context.events.includes("committed"), true);
});

test("Hermes delete committing recovery 依 fresh source 存在性幂等重试", async () => {
  const harness = hermesSagaHarness();
  const entry = hermesRecoveryEntry({
    operationId: "hermes-recover-delete",
    kind: "delete-model",
    targetModelId: null,
  });
  const context = sagaContext(entry.operationId, entry.fingerprints);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "applied");
  for (const models of harness.state.profiles.values()) assert.deepEqual([...models], []);
  assert.equal(context.events.includes("committed"), true);
});

test("Hermes Provider 更新恢复只在全 Profile fresh 摘要命中 after 时声明 applied", async () => {
  const harness = hermesSagaHarness();
  let baseUrl = "";
  harness.backend._readProvidersByProfile = async () => new Map([
    ["bull", { alpha: { base_url: baseUrl, models: [{ id: "old" }] } }],
    ["default", { alpha: { base_url: baseUrl, models: [{ id: "old" }] } }],
  ]);
  const spec = { kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://new.example/v1" } };
  const preview = await harness.adapter.preview(spec);
  const beforeEntry = hermesRecoveryEntry({
    operationId: "hermes-provider-before",
    kind: "update-provider",
    commitState: "precommit",
    sourceModelId: null,
    targetModelId: null,
  });
  beforeEntry.providerDiff = preview.providerDiff;
  const before = await harness.adapter.recover(beforeEntry, sagaContext(beforeEntry.operationId, beforeEntry.fingerprints).value);
  assert.equal(before.status, "needs_secret");
  assert.equal(before.code, "recovery_input_required");

  baseUrl = "https://new.example/v1";
  const afterEntry = { ...beforeEntry, operationId: "hermes-provider-after" };
  const afterContext = sagaContext(afterEntry.operationId, afterEntry.fingerprints);
  const after = await harness.adapter.recover(afterEntry, afterContext.value);
  assert.equal(after.status, "applied");
  assert.equal(afterContext.events.includes("committed"), true);
  assert.equal(JSON.stringify(afterEntry).includes("new.example"), false);
});

test("Hermes create/update/delete/update-provider 各走独立提交边界，不误删 rename source", async () => {
  const cases = [
    [{ kind: "create", providerKey: "alpha", providerMode: "existing", sourceModelId: null, model: { id: "created" } }, ["preflight", "stage-target", "verify-ready", "committing", "committed"]],
    [{ kind: "update", providerKey: "alpha", providerMode: "existing", sourceModelId: "old", model: { id: "old", name: "Updated" } }, ["preflight", "stage-target", "verify-ready", "committing", "committed"]],
    [{ kind: "delete-model", providerKey: "alpha", sourceModelId: "old" }, ["preflight", "committing", "committed", "commit-retire"]],
    [{ kind: "delete-provider", providerKey: "alpha", sourceModelId: null }, ["preflight", "committing", "committed", "commit-retire"]],
    [{ kind: "update-provider", providerKey: "alpha", sourceModelId: null, patch: { baseUrl: "https://new.example" } }, ["preflight", "stage-target", "verify-ready", "committing", "committed"]],
  ];
  for (const [spec, expected] of cases) {
    const harness = hermesSagaHarness();
    const preview = await harness.adapter.preview(spec);
    const context = sagaContext(`hermes-${spec.kind}`, preview.fingerprints);
    const result = await harness.adapter.apply(spec, context.value, null);
    assert.equal(result.status, "applied", spec.kind);
    assert.deepEqual(context.events, expected, spec.kind);
    if (!["delete-model", "delete-provider"].includes(spec.kind)) {
      assert.equal(harness.state.calls.some((call) => call[0] === "remove-model" && call[1] === "old"), false, spec.kind);
    }
  }
});

/** 顺序执行并保留完整失败证据。 */
async function main() {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(error?.stack || error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
