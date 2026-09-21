#!/usr/bin/env node
"use strict";

// OpenClaw 模型引用扫描、分页完整性与 mutation lease 的定向回归。
// 全部 RPC 都是内存 fake；本脚本不会连接或修改用户网关。

const assert = require("node:assert/strict");
const http = require("node:http");
const {
  OPENCLAW_SCANNER_VERSION,
  OPENCLAW_MODEL_PATHS,
  MODEL_REFERENCE_SCANNERS,
  validateReferenceScanners,
  scanOpenClawReferences,
  acquireReferenceMutationLeases,
} = require("../app/core/openclaw-model-references");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
const { startStaticServer } = require("../app/static-server");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { createOpenClawRuntimeApply } = require("../app/core/openclaw-runtime-apply");
const { createOpenClawModelChange } = require("../app/core/openclaw-model-change");
const { createOpenclawHostController } = require("../app/openclaw-host");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const tests = [];

/** 注册顺序执行的独立回归。 */
function test(name, run) {
  tests.push({ name, run });
}

/** 构造 rename 使用的无凭证 safeSpec。 */
function renameSpec(overrides = {}) {
  return {
    kind: "rename",
    providerKey: "alpha",
    sourceModelId: "old",
    sourceKey: JSON.stringify(["alpha", "old"]),
    targetKey: JSON.stringify(["alpha", "new"]),
    model: { id: "new" },
    ...overrides,
  };
}

/** 生成带稳定 key/model/version 的 Session 行。 */
function sessionRows(count, start = 0, model = "alpha/old") {
  const separator = model.indexOf("/");
  return Array.from({ length: count }, (_, index) => ({
    key: `agent:main:session-${start + index}`,
    providerOverride: separator >= 0 ? model.slice(0, separator) : "alpha",
    modelOverride: separator >= 0 ? model.slice(separator + 1) : model,
    version: `v-${start + index}`,
  }));
}

/** 默认配置只定义 alpha/old，使裸 old 可以安全消歧。 */
function baseConfig(extra = {}) {
  return {
    models: { providers: { alpha: { models: [{ id: "old", name: "Old" }] } } },
    agents: { defaults: {}, entries: { main: {} } },
    ...extra,
  };
}

/** 按 config.patch 的对象 merge/null-delete 语义更新 fake 配置。 */
function mergeConfigPatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const next = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = mergeConfigPatch(next[key], value);
    } else next[key] = JSON.parse(JSON.stringify(value));
  }
  return next;
}

/** 读取 scanner referenceKey 指向的当前配置值。 */
function getConfigPath(root, path) {
  const segments = String(path).match(/[^.[\]]+/g) || [];
  let cursor = root;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[/^\d+$/.test(segment) ? Number(segment) : segment];
  }
  return cursor;
}

/** 构造可观测的 journal hooks，锁定每个阶段与 committing 顺序。 */
function createModelChangeContext(operationId = "model-change-test") {
  const events = [];
  return {
    events,
    context: {
      operationId,
      journalEntry: { fingerprints: {} },
      assertProviderLease() { events.push("lease-check"); },
      async recordStage(stage, patch = {}) { events.push(["stage", stage, patch]); },
      async recordStep(step) { events.push(["step", step.store, step.referenceKey, step.writeStatus]); },
      async markCommitting(patch = {}) { events.push(["committing", patch]); },
      async markCommitted(patch = {}) { events.push(["committed", patch]); },
    },
  };
}

/** 构造 adapter crash recovery 使用的最小 journal 公开摘要。 */
function openClawRecoveryEntry({
  operationId,
  kind = "rename",
  commitState = "committing",
  status = "in_progress",
  sourceModelId = "old",
  targetModelId = "new",
} = {}) {
  return {
    operationId,
    kind,
    providerKey: "alpha",
    commitState,
    status,
    stage: commitState === "precommit" ? "stage-target" : "commit",
    source: sourceModelId ? { provider: "alpha", modelId: sourceModelId } : null,
    target: targetModelId ? { provider: "alpha", modelId: targetModelId } : null,
    modelDiff: targetModelId ? {
      before: sourceModelId ? { id: sourceModelId, provider: "alpha", backendId: "openclaw" } : null,
      after: { id: targetModelId, name: "New", provider: "alpha", backendId: "openclaw" },
    } : sourceModelId ? {
      before: { id: sourceModelId, provider: "alpha", backendId: "openclaw" },
      after: null,
    } : null,
    createdProvider: false,
    secretStep: "not_required",
    fingerprints: { config: "crashed-process" },
    steps: [],
  };
}

/** 构造可观测的 crash recovery context，记录提交点推进。 */
function openClawRecoveryContext(entry, recoveryMode = "resolve-commit") {
  const events = [];
  return {
    events,
    value: {
      operationId: entry.operationId,
      journalEntry: entry,
      recoveryMode,
      forwardOnly: recoveryMode === "forward-only",
      assertProviderLease() {},
      async recordStage(stage) { events.push(stage); },
      async recordStep(step) { events.push(`${step.writeStatus}:${step.referenceKey}`); },
      async markCommitting() { events.push("committing"); },
      async markCommitted() { events.push("committed"); },
    },
  };
}

/**
 * 构造 Task 10 状态机 fake：配置写采用真实 config.patch shape，引用 scanner 和
 * runtime lease 都记录调用，便于证明 source 保留、逆序补偿与零旁路写。
 */
function createModelChangeHarness({
  config = baseConfig({
    agents: {
      defaults: { model: { primary: "alpha/old", fallbacks: ["old"] } },
      entries: { writer: { model: { primary: "old", fallbacks: [] } } },
    },
  }),
  references = [],
  runtimeMode = "hot",
  failWriteKey = null,
} = {}) {
  const state = {
    config: JSON.parse(JSON.stringify(config)),
    hash: "hash-1",
    patchCalls: [],
    referenceWrites: [],
    referenceUndos: [],
    runtimeAcquires: 0,
    runtimeReleases: 0,
    runtimeVerified: 0,
    runtimeConverged: 0,
    leaseRuns: 0,
  };
  const byKey = new Map(references.map((reference) => [reference.referenceKey, JSON.parse(JSON.stringify(reference.before))]));
  const backend = {
    async request(method, params = {}) {
      if (method === "config.get") {
        return { hash: state.hash, parsed: JSON.parse(JSON.stringify(state.config)) };
      }
      if (method === "config.patch") {
        state.patchCalls.push(JSON.parse(JSON.stringify(params)));
        if (params.baseHash !== state.hash) throw Object.assign(new Error("changed since last load"), { code: "conflict" });
        state.config = mergeConfigPatch(state.config, JSON.parse(params.raw));
        state.hash = `hash-${state.patchCalls.length + 1}`;
        return {};
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  };
  const scanners = ["config", "sessions", "cron"].map((store) => ({
    id: `openclaw.${store === "config" ? "config.v2" : `${store}.v1`}`,
    store,
    async enumerate() {},
    async read(_backend, reference) { return JSON.parse(JSON.stringify(byKey.get(reference.referenceKey))); },
    async write(_backend, reference) {
      state.referenceWrites.push(reference.referenceKey);
      if (reference.referenceKey === failWriteKey) throw Object.assign(new Error("injected"), { code: "injected" });
      byKey.set(reference.referenceKey, JSON.parse(JSON.stringify(reference.after)));
      return {};
    },
    async verify(_backend, reference) {
      return JSON.stringify(byKey.get(reference.referenceKey)) === JSON.stringify(reference.after);
    },
    async undo(_backend, reference) {
      state.referenceUndos.push(reference.referenceKey);
      byKey.set(reference.referenceKey, JSON.parse(JSON.stringify(reference.undo)));
      return {};
    },
  }));
  const scan = async (_backend, safeSpec) => {
    const source = safeSpec.sourceModelId;
    const provider = state.config.models?.providers?.[safeSpec.providerKey];
    const rows = Array.isArray(provider?.models) ? provider.models : [];
    const activeReferences = references.filter((reference) => (
      reference.store === "config"
        ? JSON.stringify(getConfigPath(state.config, reference.referenceKey)) === JSON.stringify(reference.before)
        : JSON.stringify(byKey.get(reference.referenceKey)) === JSON.stringify(reference.before)
    ));
    const configReplacePaths = [...new Set(activeReferences
      .filter((reference) => reference.store === "config" && typeof reference.replacePath === "string")
      .map((reference) => reference.replacePath))].sort();
    return {
      scannerVersion: 2,
      stores: {
        config: { complete: true, fingerprint: state.hash, baseHash: state.hash, replacePaths: configReplacePaths },
        sessions: { complete: true, fingerprint: `sessions-${activeReferences.filter((ref) => ref.store === "sessions").length}` },
        cron: { complete: true, fingerprint: `cron-${activeReferences.filter((ref) => ref.store === "cron").length}` },
      },
      fingerprints: {
        scannerVersion: 2,
        config: state.hash,
        sessions: `sessions-${activeReferences.filter((ref) => ref.store === "sessions").length}`,
        cron: `cron-${activeReferences.filter((ref) => ref.store === "cron").length}`,
      },
      references: source ? activeReferences : [],
      blockers: [],
      catalog: rows,
    };
  };
  const acquireLeases = async (_backend, refs, options) => ({
    async run(callback) {
      state.leaseRuns += 1;
      await options.rescan();
      return callback({ sessions: { token: "sessions-lease" }, cron: { token: "cron-lease" } });
    },
    async release() {},
  });
  const runtimeApply = {
    async inspect() { return { mode: runtimeMode, safeApply: true, verified: true }; },
    async acquireForApply() {
      state.runtimeAcquires += 1;
      return {
        mode: runtimeMode,
        checkpoint() {},
        async verifyTarget() { state.runtimeVerified += 1; return true; },
        async convergeAfterRetire() { state.runtimeConverged += 1; return true; },
        async release() { state.runtimeReleases += 1; },
      };
    },
    async recoverLease() { return this.acquireForApply(); },
  };
  const adapter = createOpenClawModelChange({ backend, scanners, runtimeApply, scan, acquireLeases });
  return { adapter, backend, scanners, runtimeApply, scan, state, byKey };
}

/**
 * 创建只记录调用的 fake RPC。handler 可按 method/params 返回动态页，未声明的
 * Session/Cron 默认返回确定的完整空单页。
 */
function createFakeRpc({ config = baseConfig(), capabilities = {}, handler, acquireLease } = {}) {
  const calls = [];
  const writes = [];
  return {
    calls,
    writes,
    capabilities,
    async getModelReferenceCapabilities() {
      return capabilities;
    },
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "config.get") return { hash: "config-hash", parsed: config };
      if (handler) {
        const handled = await handler(method, params, { calls, writes });
        if (handled !== undefined) return handled;
      }
      if (method === "sessions.list") return { sessions: [], hasMore: false };
      if (method === "cron.list") return { jobs: [], hasMore: false };
      writes.push({ method, params });
      return {};
    },
    ...(acquireLease ? { acquireReferenceMutationLease: acquireLease } : {}),
  };
}

/** 创建 Task 9 的 fake backend，记录 tasks/verify 调用与连接身份。 */
function createRuntimeBackend({ mode = "unknown", verified = false, tasks = [], verify = [true] } = {}) {
  const state = {
    identity: { gatewayVersion: "2026.7.1", upstreamUrl: "ws://127.0.0.1:18792", connectionGeneration: 1 },
    mode,
    verified,
    tasks,
    verify: [...verify],
    taskCalls: 0,
    verifyCalls: 0,
  };
  return {
    state,
    getModelRuntimeIdentity() { return { ...state.identity }; },
    async getModelRuntimeApplyCapabilities() { return { mode: state.mode, verified: state.verified }; },
    async listModelRuntimeTasks() {
      state.taskCalls += 1;
      return { supported: true, tasks: state.tasks, truncated: false };
    },
    async verifyModelTarget() {
      state.verifyCalls += 1;
      return state.verify.length > 1 ? state.verify.shift() : state.verify[0];
    },
  };
}

/** 创建支持完整 supervisor 契约的 fake，并记录同一 token 是否贯穿重启。 */
function createRuntimeSupervisor({ topology = "local", capabilities, tasksLeaseTtlMs = 30 } = {}) {
  const state = {
    acquired: 0,
    recovered: 0,
    restarted: 0,
    healthy: 0,
    renewed: 0,
    released: 0,
    restartTokens: [],
    healthyTokens: [],
    held: null,
  };
  const caps = capabilities || { drain: true, recoverDrain: true, restartPaused: true, waitHealthy: true };
  const makeLease = (operationId, token = `drain-${operationId}`) => {
    const lease = { token, operationId, expiresAt: Date.now() + tasksLeaseTtlMs };
    state.held = lease;
    return {
      ...lease,
      async renew() {
        state.renewed += 1;
        lease.expiresAt = Date.now() + tasksLeaseTtlMs;
        return { expiresAt: lease.expiresAt };
      },
      async release() {
        state.released += 1;
        if (state.held?.token === token) state.held = null;
      },
    };
  };
  return {
    topology,
    capabilities: caps,
    state,
    isDispatchPaused() {
      if (state.held && state.held.expiresAt <= Date.now()) state.held = null;
      return state.held !== null;
    },
    async acquireDrain({ operationId }) {
      state.acquired += 1;
      return makeLease(operationId);
    },
    async recoverDrain({ operationId }) {
      state.recovered += 1;
      return state.held?.operationId === operationId ? makeLease(operationId, state.held.token) : null;
    },
    async restartPaused({ token }) {
      state.restarted += 1;
      state.restartTokens.push(token);
    },
    async waitHealthy({ token }) {
      state.healthy += 1;
      state.healthyTokens.push(token);
      return true;
    },
  };
}

/** 发起 loopback JSON 请求，验证真实 REST 公开字段。 */
function requestJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : undefined,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 递归冻结 JSON fixture，让只读 mapper 的误修改立即失败。 */
function deepFreezeFixture(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeFixture(child);
  return Object.freeze(value);
}

/**
 * 构造 OpenClaw 自定义端点只读 mapper 的内存依赖。
 * 凭证只用脱敏哨兵/摘要；任何写帮助方法被调用都会让用例立即失败。
 */
function createOpenClawEndpointBackend({
  local = true,
  parsed,
  catalog = {},
  authProviders = [],
  authProfileIds = authProviders.map((provider) => `${provider}:default`),
  keyDigests = [],
  canUpdateProvider = true,
} = {}) {
  const reads = { config: 0, catalog: 0, auth: 0, digest: 0 };
  let writes = 0;
  deepFreezeFixture(parsed);
  deepFreezeFixture(catalog);
  deepFreezeFixture(authProviders);
  deepFreezeFixture(authProfileIds);
  deepFreezeFixture(keyDigests);
  const backend = new OpenClawBackend({
    getUpstreamUrl: () => local ? "ws://127.0.0.1:18792" : "wss://gateway.example.test",
  });
  // This fixture supplies legacy auth readers in memory. Never select the host's
  // installed CLI/version and accidentally consult its real canonical auth store.
  backend._modelAuthCliVersionOverride = "2026.8.1";
  backend._configSnapshot = async () => {
    reads.config += 1;
    return { parsed, hash: "endpoint-fixture-hash" };
  };
  backend._providerCatalogSnapshot = () => {
    reads.catalog += 1;
    return { providers: catalog };
  };
  backend._localAuthKeyProviders = () => {
    reads.auth += 1;
    return new Set(authProviders);
  };
  backend._localAuthKeyProfiles = () => {
    reads.auth += 1;
    const profiles = new Map();
    for (const id of authProfileIds) {
      const provider = String(id).split(":")[0];
      const ids = profiles.get(provider) || new Set();
      ids.add(id);
      profiles.set(provider, ids);
    }
    return profiles;
  };
  backend._localKeyDigests = () => {
    reads.digest += 1;
    return new Map(keyDigests);
  };
  backend._patchModelProviders = async () => {
    writes += 1;
    throw new Error("只读 endpoint mapper 不得写配置");
  };
  backend._writeAuthProfiles = () => {
    writes += 1;
    throw new Error("只读 endpoint mapper 不得写授权");
  };
  backend._writeRegistry = () => {
    writes += 1;
    throw new Error("只读 endpoint mapper 不得写注册表");
  };
  backend.attachModelChangeAdapter({
    async getCapabilities() {
      return {
        supported: canUpdateProvider,
        updateProvider: canUpdateProvider,
      };
    },
    async preview() { throw new Error("endpoint mapper 不应 preview"); },
    async apply() { throw new Error("endpoint mapper 不应 apply"); },
    async recover() { throw new Error("endpoint mapper 不应 recover"); },
  });
  return { backend, reads, getWrites: () => writes };
}

test("scanner registry 固定版本、精确路径并强制五能力", () => {
  assert.equal(OPENCLAW_SCANNER_VERSION, 2);
  assert.deepEqual(OPENCLAW_MODEL_PATHS, [
    "models.providers.*.models[*].id",
    "agents.defaults.model.primary",
    "agents.defaults.model.fallbacks[*]",
    "agents.defaults.modelPolicy.allow[*]",
    "agents.entries.*.model.primary",
    "agents.entries.*.model.fallbacks[*]",
    "agents.entries.*.modelPolicy.allow[*]",
    "agents.defaults.subagents.model",
  ]);
  assert.deepEqual(MODEL_REFERENCE_SCANNERS.map(({ id, store }) => ({ id, store })), [
    { id: "openclaw.config.v2", store: "config" },
    { id: "openclaw.sessions.v1", store: "sessions" },
    { id: "openclaw.cron.v1", store: "cron" },
  ]);
  assert.throws(
    () => validateReferenceScanners([{ id: "broken", store: "config", enumerate() {}, read() {}, write() {}, verify() {} }]),
    (error) => error?.code === "invalid_reference_scanner" && /undo/.test(error.message),
  );
});

test("config scanner 覆盖声明路径并为每个引用提供可补偿元数据", async () => {
  const config = baseConfig({
    agents: {
      defaults: {
        model: { primary: "alpha/old", fallbacks: ["old", "beta/other"] },
        models: { "alpha/old": { alias: "fast" } },
        modelPolicy: { allow: ["alpha/old", "alpha/*", "fast"] },
        subagents: { model: "alpha/old" },
      },
      entries: {
        main: {
          model: { primary: "old", fallbacks: ["alpha/old", "other"] },
          modelPolicy: { allow: ["beta/other", "alpha/old"] },
        },
      },
    },
  });
  const rpc = createFakeRpc({ config });
  const result = await scanOpenClawReferences(rpc, renameSpec());
  const configRefs = result.references.filter((reference) => reference.store === "config");
  assert.deepEqual(configRefs.map((reference) => reference.referenceKey), [
    "models.providers.alpha.models[0].id",
    "agents.defaults.model.primary",
    "agents.defaults.model.fallbacks[0]",
    "agents.defaults.modelPolicy.allow[0]",
    "agents.entries.main.model.primary",
    "agents.entries.main.model.fallbacks[0]",
    "agents.entries.main.modelPolicy.allow[1]",
    "agents.defaults.subagents.model",
  ]);
  for (const reference of configRefs) {
    assert.equal(reference.scannerId, "openclaw.config.v2");
    assert.equal(typeof reference.fingerprint, "string");
    assert.equal(Object.prototype.hasOwnProperty.call(reference, "before"), true);
    assert.equal(Object.prototype.hasOwnProperty.call(reference, "after"), true);
    assert.equal(Object.prototype.hasOwnProperty.call(reference, "undo"), true);
  }
  assert.equal(result.stores.config.complete, true);
  assert.equal(result.stores.config.endReached, true);
  assert.deepEqual(result.stores.config.replacePaths, [
    "agents.defaults.model.fallbacks",
    "agents.defaults.modelPolicy.allow",
    "agents.entries.main.model.fallbacks",
    "agents.entries.main.modelPolicy.allow",
    "models.providers.alpha.models",
  ]);
  assert.equal(result.scannerVersion, 2);
  assert.deepEqual(config.agents.defaults.models, { "alpha/old": { alias: "fast" } });
  assert.deepEqual(rpc.writes, []);
});

test("config scanner 对 legacy list 与畸形 canonical roster fail-closed", async () => {
  const legacy = await scanOpenClawReferences(createFakeRpc({
    config: {
      models: { providers: { alpha: { models: [{ id: "old" }] } } },
      agents: { defaults: {}, list: [{ id: "main" }] },
    },
  }), renameSpec());
  assert.equal(legacy.stores.config.complete, false);
  assert.ok(legacy.blockers.some((item) => item.code === "legacy_agent_list_requires_migration"));

  const malformed = await scanOpenClawReferences(createFakeRpc({
    config: {
      models: { providers: { alpha: { models: [{ id: "old" }] } } },
      agents: { defaults: {}, entries: { main: { id: "main" } } },
    },
  }), renameSpec());
  assert.equal(malformed.stores.config.complete, false);
  assert.ok(malformed.blockers.some((item) => item.code === "agent_entry_id_forbidden"));
});

test("delete-provider 扫描全部精确/wildcard policy ref，但不把 models aliases 当 allowlist", async () => {
  const aliases = {
    "alpha/old": { alias: "fast", params: { temperature: 0.2 } },
    "beta/keep": { alias: "keep" },
  };
  const config = {
    models: { providers: { alpha: { models: [{ id: "old" }, { id: "second" }] } } },
    agents: {
      defaults: {
        models: aliases,
        modelPolicy: { allow: ["alpha/old", "alpha/*", "fast", "beta/keep"] },
      },
      entries: {
        main: { modelPolicy: { allow: ["alpha/stale", "beta/keep"] } },
      },
    },
  };
  const result = await scanOpenClawReferences(createFakeRpc({ config }), {
    kind: "delete-provider",
    providerKey: "alpha",
    sourceModelId: null,
  });
  assert.deepEqual(
    result.references.filter((item) => item.store === "config").map((item) => item.referenceKey),
    [
      "agents.defaults.modelPolicy.allow[0]",
      "agents.defaults.modelPolicy.allow[1]",
      "agents.entries.main.modelPolicy.allow[0]",
    ],
  );
  assert.equal(result.references.some((item) => item.referenceKey.includes("defaults.models")), false);
  assert.deepEqual(config.agents.defaults.models, aliases);
});

test("同 ID 多 Provider 时不迁移裸引用，schema 外模型路径 fail-closed", async () => {
  const config = {
    models: {
      providers: {
        alpha: { models: [{ id: "old", name: "old" }] },
        beta: { models: [{ id: "old" }] },
      },
    },
    agents: {
      defaults: { model: { primary: "old", fallbacks: ["alpha/old"] } },
      entries: { main: {} },
    },
    plugins: { custom: { model: "alpha/old" } },
  };
  const result = await scanOpenClawReferences(createFakeRpc({ config }), renameSpec());
  const keys = result.references.map((reference) => reference.referenceKey);
  assert.equal(keys.includes("agents.defaults.model.primary"), false);
  assert.equal(keys.includes("agents.defaults.model.fallbacks[0]"), true);
  assert.ok(result.blockers.some((blocker) => blocker.code === "ambiguous_model_reference"));
  assert.deepEqual(
    result.blockers
      .filter((blocker) => blocker.code === "unknown_model_reference_path")
      .map((blocker) => blocker.referenceKey),
    ["plugins.custom.model"],
  );
});

test("Session offset-v1 翻过 200 条且按 key 去重", async () => {
  const allRows = sessionRows(205);
  const rpc = createFakeRpc({
    capabilities: {
      sessionsPagination: "offset-v1",
      sessionsPageLimit: 200,
      referenceMutationLeases: { sessions: true },
    },
    handler(method, params) {
      if (method !== "sessions.list") return undefined;
      const offset = params.offset || 0;
      const rows = allRows.slice(offset, offset + params.limit);
      const hasMore = offset + rows.length < allRows.length;
      return { sessions: rows, hasMore, ...(hasMore ? { nextOffset: offset + rows.length } : {}) };
    },
  });
  const result = await scanOpenClawReferences(rpc, renameSpec());
  assert.equal(result.stores.sessions.count, 205);
  assert.equal(result.stores.sessions.pagination, "offset");
  assert.equal(result.stores.sessions.endReached, true);
  assert.equal(result.references.filter((reference) => reference.store === "sessions").length, 205);
  assert.deepEqual(
    rpc.calls.filter(({ method }) => method === "sessions.list").map(({ params }) => params.offset),
    [0, 200],
  );
});

test("Session cursor-v1 保持协议并跨页去重", async () => {
  const first = sessionRows(200);
  const second = [first[199], ...sessionRows(5, 200)];
  const rpc = createFakeRpc({
    capabilities: {
      sessionsPagination: "cursor-v1",
      sessionsPageLimit: 200,
      referenceMutationLeases: { sessions: true },
    },
    handler(method, params) {
      if (method !== "sessions.list") return undefined;
      return params.cursor
        ? { sessions: second, hasMore: false }
        : { sessions: first, hasMore: true, nextCursor: "page-2" };
    },
  });
  const result = await scanOpenClawReferences(rpc, renameSpec());
  assert.equal(result.stores.sessions.count, 205);
  assert.equal(result.stores.sessions.pagination, "cursor");
  assert.deepEqual(
    rpc.calls.filter(({ method }) => method === "sessions.list").map(({ params }) => params.cursor),
    [undefined, "page-2"],
  );
});

test("Session 分页不前进、协议切换、未知 shape 与重复页均 fail-closed", async () => {
  const scenarios = [
    {
      name: "offset-not-advancing",
      capabilities: { sessionsPagination: "offset-v1", sessionsPageLimit: 200 },
      page: () => ({ sessions: sessionRows(200), hasMore: true, nextOffset: 0 }),
    },
    {
      name: "offset-switches-to-cursor",
      capabilities: { sessionsPagination: "offset-v1", sessionsPageLimit: 200 },
      page: () => ({ sessions: sessionRows(200), hasMore: true, nextCursor: "bad" }),
    },
    {
      name: "unknown-shape",
      capabilities: { sessionsPagination: "offset-v1", sessionsPageLimit: 200 },
      page: () => ({ rows: sessionRows(2), hasMore: false }),
    },
    {
      name: "duplicate-page",
      capabilities: { sessionsPagination: "cursor-v1", sessionsPageLimit: 200 },
      page: () => ({ sessions: sessionRows(200), hasMore: true, nextCursor: "same" }),
    },
  ];
  for (const scenario of scenarios) {
    const rpc = createFakeRpc({
      capabilities: scenario.capabilities,
      handler(method, params) {
        return method === "sessions.list" ? scenario.page(params) : undefined;
      },
    });
    const result = await scanOpenClawReferences(rpc, renameSpec());
    assert.equal(result.stores.sessions.complete, false, scenario.name);
    assert.equal(result.stores.sessions.endReached, false, scenario.name);
    assert.ok(
      result.blockers.some((blocker) => blocker.code === "session_enumeration_incomplete"),
      scenario.name,
    );
  }
});

test("旧网关 legacy-single 只有小于声明上限且无截断信号才完整", async () => {
  for (const [count, complete] of [[199, true], [200, false]]) {
    const rpc = createFakeRpc({
      capabilities: { sessionsPagination: "legacy-single", sessionsPageLimit: 200 },
      handler(method) {
        return method === "sessions.list" ? { sessions: sessionRows(count) } : undefined;
      },
    });
    const result = await scanOpenClawReferences(rpc, renameSpec());
    assert.equal(result.stores.sessions.pagination, "legacy-single");
    assert.equal(result.stores.sessions.complete, complete);
    assert.equal(result.stores.sessions.endReached, complete);
  }
});

test("Session/Cron 末页的 null continuation 不表示截断", async () => {
  for (const continuation of [{ nextOffset: null }, { nextCursor: null }]) {
    const rpc = createFakeRpc({
      handler(method) {
        const rows = method === "sessions.list"
          ? sessionRows(99, 0, "beta/unused")
          : Array.from({ length: 62 }, (_, index) => ({ id: `cron-${index}` }));
        if (!["sessions.list", "cron.list"].includes(method)) return undefined;
        return {
          [method === "sessions.list" ? "sessions" : "jobs"]: rows,
          total: rows.length,
          hasMore: false,
          ...continuation,
        };
      },
    });
    const result = await scanOpenClawReferences(rpc, renameSpec());
    for (const store of ["sessions", "cron"]) {
      assert.equal(result.stores[store].complete, true, `${store}: ${JSON.stringify(continuation)}`);
      assert.equal(result.stores[store].endReached, true);
    }
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(rpc.writes, []);
  }
});

test("Session/Cron 的 null continuation 不能掩盖真实截断信号", async () => {
  for (const signal of [{ hasMore: true }, { truncated: true }, { total: 2 }, { nextOffset: 1 }, { nextCursor: "next" }]) {
    const rpc = createFakeRpc({
      handler(method) {
        if (!["sessions.list", "cron.list"].includes(method)) return undefined;
        return {
          [method === "sessions.list" ? "sessions" : "jobs"]: method === "sessions.list"
            ? sessionRows(1, 0, "beta/unused") : [{ id: "cron-0" }],
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
          ...signal,
        };
      },
    });
    const result = await scanOpenClawReferences(rpc, renameSpec());
    for (const store of ["sessions", "cron"]) {
      assert.equal(result.stores[store].complete, false, `${store}: ${JSON.stringify(signal)}`);
      assert.ok(result.blockers.some((item) => item.code === `${store === "sessions" ? "session" : "cron"}_enumeration_incomplete`));
    }
    assert.deepEqual(rpc.writes, []);
  }
});

test("Session scanner 使用 providerOverride/modelOverride 并以 {key, model} 条件更新", async () => {
  let session = {
    key: "agent:main:session-override",
    providerOverride: "alpha",
    modelOverride: "old",
    version: "session-v1",
  };
  const rpc = createFakeRpc({
    capabilities: {
      sessionsPagination: "offset-v1",
      sessionsPageLimit: 200,
      conditionalVersions: { sessions: true },
    },
    handler(method, params) {
      if (method === "sessions.list") return { sessions: [session], hasMore: false };
      if (method === "sessions.get") return { session: { ...session } };
      if (method === "sessions.patch") {
        assert.equal(Object.prototype.hasOwnProperty.call(params, "patch"), false);
        assert.equal(params.key, session.key);
        assert.equal(params.expectedVersion, "session-v1");
        const separator = params.model.indexOf("/");
        session = {
          ...session,
          providerOverride: params.model.slice(0, separator),
          modelOverride: params.model.slice(separator + 1),
        };
        return { session: { ...session } };
      }
      return undefined;
    },
  });
  const scanned = await scanOpenClawReferences(rpc, renameSpec());
  const reference = scanned.references.find((item) => item.store === "sessions");
  assert.ok(reference, "provider/model override 必须被扫描为可迁移引用");
  assert.deepEqual(
    { provider: reference.after.providerOverride, model: reference.after.modelOverride },
    { provider: "alpha", model: "new" },
  );
  const scanner = MODEL_REFERENCE_SCANNERS.find((candidate) => candidate.store === "sessions");
  await scanner.write(rpc, reference, {});
  assert.equal(await scanner.verify(rpc, reference, {}), true);
  await scanner.undo(rpc, reference, {});
  assert.deepEqual(
    { provider: session.providerOverride, model: session.modelOverride },
    { provider: "alpha", model: "old" },
  );
  assert.deepEqual(
    rpc.calls.filter(({ method }) => method === "sessions.patch").map(({ params }) => params.model),
    ["alpha/new", "alpha/old"],
  );
});

test("Session verify 通过真实 sessions.list 分页精确回读且不混入 mutation 参数", async () => {
  const targetKey = "agent:main:session-target";
  const pages = [
    sessionRows(2),
    [{
      key: targetKey,
      providerOverride: "alpha",
      modelOverride: "new",
      version: "session-v2",
    }],
  ];
  const rpc = createFakeRpc({
    capabilities: {
      sessionsPagination: "offset-v1",
      sessionsPageLimit: 2,
      conditionalVersions: { sessions: true },
    },
    handler(method, params) {
      if (method === "sessions.get") assert.fail("生产协议没有 sessions.get 元数据契约");
      if (method !== "sessions.list") return undefined;
      // 读取协议只允许分页字段；lease/expectedVersion 只能进入写 mutation。
      assert.deepEqual(Object.keys(params).sort(), ["limit", "offset"]);
      if (params.offset === 0) return { sessions: pages[0], hasMore: true, nextOffset: 2 };
      if (params.offset === 2) return { sessions: pages[1], hasMore: false };
      assert.fail(`unexpected sessions.list offset: ${params.offset}`);
    },
  });
  const scanner = MODEL_REFERENCE_SCANNERS.find((candidate) => candidate.store === "sessions");
  const reference = {
    store: "sessions",
    referenceKey: targetKey,
    expectedVersion: "session-v1",
    after: { providerOverride: "alpha", modelOverride: "new" },
  };
  assert.equal(await scanner.verify(rpc, reference, { token: "lease-secret" }), true);
  assert.equal(rpc.calls.some(({ method }) => method === "sessions.get"), false);
});

test("Session scanner 只认显式 providerOverride/modelOverride，不迁移派生 model/fallbacks", async () => {
  const rows = [
    {
      key: "agent:main:derived-model",
      model: "alpha/old",
      fallbacks: ["alpha/old"],
      version: "derived-v1",
    },
    {
      key: "agent:main:ambiguous-override",
      modelOverride: "old",
      version: "ambiguous-v1",
    },
  ];
  const rpc = createFakeRpc({
    capabilities: {
      sessionsPagination: "offset-v1",
      sessionsPageLimit: 200,
      conditionalVersions: { sessions: true },
    },
    handler(method) {
      if (method === "sessions.list") return { sessions: rows, hasMore: false };
      if (method === "sessions.patch") assert.fail("派生 Session 字段不得触发写入");
      return undefined;
    },
  });
  const scanned = await scanOpenClawReferences(rpc, renameSpec());
  assert.equal(scanned.references.some((item) => item.store === "sessions"), false);
  assert.equal(
    scanned.blockers.some((item) => item.code === "ambiguous_model_reference"),
    true,
  );
  assert.equal(rpc.calls.some(({ method }) => method === "sessions.patch"), false);
});

test("OpenClaw runtime verifier 必须校验目标普通字段内容而非仅模型 ID", async () => {
  const state = { contextWindow: 4096 };
  const backend = {
    runtimeIdentity: { endpoint: "local", generation: 1 },
    async request(method) {
      const model = { id: "new", name: "New", contextWindow: state.contextWindow, maxTokens: 1024, reasoning: true };
      if (method === "config.get") return { parsed: { models: { providers: { alpha: { models: [model] } } } } };
      if (method === "models.list") return { models: [{ ...model, provider: "alpha" }] };
      throw new Error(`unexpected method: ${method}`);
    },
  };
  const controller = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
  });
  const spec = {
    kind: "update",
    providerKey: "alpha",
    sourceModelId: "new",
    model: { id: "new", name: "New", contextWindow: 8192, maxTokens: 1024, reasoning: true },
  };
  assert.equal(await controller.verifyTarget(spec), false);
  state.contextWindow = 8192;
  assert.equal(await controller.verifyTarget(spec), true);
});

test("Cron scanner 保留完整 payload，只改精确或可消歧 model/fallbacks", async () => {
  const job = {
    id: "job-1",
    name: "keep-me",
    version: "cron-v1",
    payload: {
      kind: "agentTurn",
      message: "keep prompt",
      model: "alpha/old",
      fallbacks: ["old", "beta/other"],
      nested: { keep: true },
    },
    delivery: { mode: "announce" },
  };
  const rpc = createFakeRpc({
    capabilities: {
      cronPagination: "single",
      cronPageLimit: 200,
      referenceMutationLeases: { cron: true },
    },
    handler(method) {
      return method === "cron.list" ? { jobs: [job] } : undefined;
    },
  });
  const result = await scanOpenClawReferences(rpc, renameSpec());
  const references = result.references.filter((reference) => reference.store === "cron");
  assert.equal(references.length, 1);
  assert.deepEqual(references[0].before, job);
  assert.equal(references[0].after.payload.model, "alpha/new");
  assert.deepEqual(references[0].after.payload.fallbacks, ["new", "beta/other"]);
  assert.equal(references[0].after.payload.message, "keep prompt");
  assert.deepEqual(references[0].after.delivery, job.delivery);
});

test("Cron cursor-v1 翻页并保持协议", async () => {
  const rpc = createFakeRpc({
    capabilities: { cronPagination: "cursor-v1", cronPageLimit: 1 },
    handler(method, params) {
      if (method !== "cron.list") return undefined;
      return params.cursor
        ? { jobs: [{ id: "job-2", payload: { model: "other" } }], hasMore: false }
        : { jobs: [{ id: "job-1", payload: { model: "other" } }], hasMore: true, nextCursor: "next" };
    },
  });
  const result = await scanOpenClawReferences(rpc, renameSpec());
  assert.equal(result.stores.cron.complete, true);
  assert.equal(result.stores.cron.count, 2);
  assert.equal(result.stores.cron.pagination, "cursor");
  assert.deepEqual(
    rpc.calls.filter(({ method }) => method === "cron.list").map(({ params }) => params.cursor),
    [undefined, "next"],
  );
});

test("Session/Cron mutation 携带并发参数，Session verify 只使用分页读取参数", async () => {
  for (const store of ["sessions", "cron"]) {
    const scanner = MODEL_REFERENCE_SCANNERS.find((candidate) => candidate.store === store);
    const reference = store === "sessions"
      ? {
          referenceKey: `${store}-one`,
          before: { key: `${store}-one`, providerOverride: "alpha", modelOverride: "old" },
          after: { key: `${store}-one`, providerOverride: "alpha", modelOverride: "new" },
          undo: { key: `${store}-one`, providerOverride: "alpha", modelOverride: "old" },
          expectedVersion: "version-one",
        }
      : {
          referenceKey: `${store}-one`,
          before: { id: "before" },
          after: { id: "after" },
          undo: { id: "before" },
          expectedVersion: "version-one",
        };
    const calls = [];
    const rpc = {
      capabilities: store === "sessions"
        ? { sessionsPagination: "offset-v1", sessionsPageLimit: 200 }
        : {},
      async request(method, params) {
        calls.push({ method, params });
        if (method === "sessions.list") return { sessions: [reference.after], hasMore: false };
        if (method === "cron.get") return reference.after;
        return {};
      },
    };
    const context = { token: "lease-one" };
    await scanner.write(rpc, reference, context);
    assert.equal(await scanner.verify(rpc, reference, context), true);
    await scanner.undo(rpc, reference, context);
    for (const call of calls) {
      if (call.method === "sessions.list") {
        assert.deepEqual(Object.keys(call.params).sort(), ["limit", "offset"]);
        continue;
      }
      assert.equal(call.params.mutationLeaseToken, "lease-one", `${store}:${call.method}`);
      assert.equal(call.params.expectedVersion, "version-one", `${store}:${call.method}`);
    }
  }
});

test("Cron 截断不明与引用并发能力缺失都成为显式 blocker", async () => {
  const rpc = createFakeRpc({
    capabilities: { cronPagination: "single", cronPageLimit: 1 },
    handler(method) {
      if (method === "cron.list") {
        return { jobs: [{ id: "job", payload: { model: "alpha/old" } }], hasMore: true };
      }
      return undefined;
    },
  });
  const result = await scanOpenClawReferences(rpc, renameSpec());
  assert.equal(result.stores.cron.complete, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "cron_enumeration_incomplete"));
  assert.ok(result.blockers.some((blocker) => blocker.code === "reference_concurrency_unsupported"));
});

test("仅声明条件版本的 Session 引用无需申请 mutation lease 也能安全写入", async () => {
  const reference = {
    scannerId: "openclaw.sessions.v1",
    store: "sessions",
    referenceKey: "conditional-session",
    before: { key: "conditional-session", providerOverride: "alpha", modelOverride: "old", version: "v1" },
    after: { key: "conditional-session", providerOverride: "alpha", modelOverride: "new", version: "v2" },
    undo: { key: "conditional-session", providerOverride: "alpha", modelOverride: "old", version: "v1" },
    expectedVersion: "v1",
  };
  const rpc = createFakeRpc({
    capabilities: {
      sessionsPagination: "offset-v1",
      sessionsPageLimit: 200,
      conditionalVersions: { sessions: true },
    },
    async acquireLease() {
      assert.fail("conditional-only store 不得申请 mutation lease");
    },
    handler(method, params) {
      if (method === "sessions.patch") {
        assert.equal(params.expectedVersion, "v1");
        assert.equal(Object.prototype.hasOwnProperty.call(params, "mutationLeaseToken"), false);
        return { session: { ...reference.after, version: "v2" } };
      }
      return undefined;
    },
  });
  const bundle = await acquireReferenceMutationLeases(rpc, [reference], {
    expectedFingerprints: { sessions: "session-fingerprint" },
    async rescan() { return { fingerprints: { sessions: "session-fingerprint" } }; },
  });
  const scanner = MODEL_REFERENCE_SCANNERS.find((candidate) => candidate.store === "sessions");
  await bundle.run(async (contexts) => scanner.write(rpc, reference, contexts.sessions));
  assert.equal(reference.expectedVersion, "v2");
  assert.equal(rpc.calls.some(({ method }) => method.startsWith("references.lease.")), false);
});

test("Session/Cron 条件写成功后推进版本，逆序补偿使用最新 expectedVersion", async () => {
  for (const store of ["sessions", "cron"]) {
    const scanner = MODEL_REFERENCE_SCANNERS.find((candidate) => candidate.store === store);
    const reference = store === "sessions"
      ? {
          store,
          referenceKey: "versioned-session",
          after: { key: "versioned-session", providerOverride: "alpha", modelOverride: "new" },
          undo: { key: "versioned-session", providerOverride: "alpha", modelOverride: "old" },
          expectedVersion: "v1",
        }
      : {
          store,
          referenceKey: "versioned-cron",
          after: { id: "versioned-cron", payload: { model: "alpha/new" } },
          undo: { id: "versioned-cron", payload: { model: "alpha/old" } },
          expectedVersion: "v1",
        };
    const mutationMethod = store === "sessions" ? "sessions.patch" : "cron.update";
    const seenVersions = [];
    const rpc = createFakeRpc({
      handler(method, params) {
        if (method !== mutationMethod) return undefined;
        seenVersions.push(params.expectedVersion);
        const version = seenVersions.length === 1 ? "v2" : "v3";
        const row = seenVersions.length === 1 ? reference.after : reference.undo;
        return store === "sessions"
          ? { session: { ...row, version } }
          : { job: { ...row, version } };
      },
    });
    await scanner.write(rpc, reference, {});
    assert.equal(reference.expectedVersion, "v2", `${store}: write 应推进版本`);
    await scanner.undo(rpc, reference, {});
    assert.deepEqual(seenVersions, ["v1", "v2"], `${store}: undo 必须使用最新版本`);
    assert.equal(reference.expectedVersion, "v3", `${store}: undo 成功后继续推进版本`);
  }
});

test("mutation lease 重扫 fingerprint 变化时零写并在 finally 释放", async () => {
  let released = 0;
  let writes = 0;
  const rpc = createFakeRpc({
    capabilities: { referenceMutationLeases: { sessions: true } },
    acquireLease: async () => ({
      token: "lease-token",
      expiresAt: Date.now() + 100,
      async renew() {},
      async release() { released += 1; },
    }),
  });
  const bundle = await acquireReferenceMutationLeases(
    rpc,
    [{ store: "sessions", referenceKey: "one" }],
    {
      ttlMs: 90,
      expectedFingerprints: { sessions: "before" },
      async rescan() { return { fingerprints: { sessions: "changed" } }; },
    },
  );
  await assert.rejects(
    bundle.run(async () => { writes += 1; }),
    (error) => error?.code === "reference_fingerprint_changed",
  );
  assert.equal(writes, 0);
  assert.equal(released, 1);
});

test("mutation lease TTL/3 心跳阻止第二 writer，回调结束后逆序释放", async () => {
  const held = new Map();
  const releaseOrder = [];
  const acquireLease = async (store, { ttlMs }) => {
    const current = held.get(store);
    if (current && current.expiresAt > Date.now()) {
      const error = new Error("lease busy");
      error.code = "reference_lease_busy";
      throw error;
    }
    const lease = { token: `${store}-token`, expiresAt: Date.now() + ttlMs };
    held.set(store, lease);
    return {
      ...lease,
      async renew() { lease.expiresAt = Date.now() + ttlMs; },
      async release() { held.delete(store); releaseOrder.push(store); },
    };
  };
  const rpc = createFakeRpc({
    capabilities: { referenceMutationLeases: { sessions: true, cron: true } },
    acquireLease,
  });
  const references = [{ store: "sessions" }, { store: "cron" }];
  const bundle = await acquireReferenceMutationLeases(rpc, references, {
    ttlMs: 30,
    expectedFingerprints: { sessions: "s", cron: "c" },
    async rescan() { return { fingerprints: { sessions: "s", cron: "c" } }; },
  });
  await bundle.run(async (context) => {
    assert.equal(context.sessions.token, "sessions-token");
    assert.equal(context.cron.token, "cron-token");
    await new Promise((resolve) => setTimeout(resolve, 55));
    await assert.rejects(acquireLease("sessions", { ttlMs: 30 }), (error) => error?.code === "reference_lease_busy");
  });
  assert.deepEqual(releaseOrder, ["cron", "sessions"]);
  const next = await acquireLease("sessions", { ttlMs: 30 });
  await next.release();
});

test("runtime 已验证 hot 时只等待目录收敛，不调用 supervisor restart", async () => {
  const backend = createRuntimeBackend({ mode: "hot", verified: true, verify: [true] });
  const admissionGate = createWorkAdmissionGate();
  const runtime = createOpenClawRuntimeApply({ backend, admissionGate, hotWaitMs: 20, pollMs: 2 });
  assert.equal((await runtime.inspect()).mode, "hot");
  const lease = await runtime.acquireForApply({ operationId: "hot-one" });
  assert.throws(() => admissionGate.enter("openclaw", "chat.send"), (error) => error?.code === "gateway_draining");
  assert.equal(await lease.verifyTarget(renameSpec(), {}), true);
  await lease.release();
  const leave = admissionGate.enter("openclaw", "chat.send");
  leave();
  assert.equal(backend.state.taskCalls, 0);
});

test("restart-required 在同一 supervisor token 内 drain、idle、paused restart、health、验证", async () => {
  const backend = createRuntimeBackend({ mode: "restart-required", tasks: [], verify: [true] });
  const supervisor = createRuntimeSupervisor();
  const runtime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor,
    drainTtlMs: 30,
    hotWaitMs: 10,
    pollMs: 2,
  });
  const lease = await runtime.acquireForApply({ operationId: "restart-one" });
  assert.equal(backend.state.taskCalls, 1);
  assert.equal(await lease.verifyTarget(renameSpec(), {}), true);
  assert.equal(supervisor.state.restarted, 1);
  assert.equal(supervisor.state.healthy, 1);
  assert.deepEqual(supervisor.state.restartTokens, [lease.token]);
  assert.deepEqual(supervisor.state.healthyTokens, [lease.token]);
  assert.equal(supervisor.state.released, 0, "目录验证前不得提前 release");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(supervisor.state.renewed >= 1, "TTL/3 应自动续租");
  await lease.release();
  assert.equal(supervisor.state.released, 1);
});

test("慢 tasks.list 跨过 lease TTL 时仍由提前启动的心跳持续持锁", async () => {
  const backend = createRuntimeBackend({ mode: "restart-required", tasks: [] });
  backend.listModelRuntimeTasks = async () => {
    await new Promise((resolve) => setTimeout(resolve, 45));
    return { supported: true, tasks: [], truncated: false };
  };
  const supervisor = createRuntimeSupervisor({ tasksLeaseTtlMs: 30 });
  const runtime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor,
    drainTtlMs: 30,
  });
  const lease = await runtime.acquireForApply({ operationId: "slow-task-probe" });
  assert.ok(supervisor.state.renewed >= 1);
  assert.equal(supervisor.isDispatchPaused(), true);
  await lease.release();
});

test("active task、drain 不支持、远程无认证 restart、unknown 能力不完整都在首写前阻断", async () => {
  const failingTaskBackend = createRuntimeBackend({ mode: "restart-required" });
  failingTaskBackend.listModelRuntimeTasks = async () => { throw new Error("tasks timeout"); };
  const scenarios = [
    {
      name: "tasks-probe-timeout",
      backend: failingTaskBackend,
      supervisor: createRuntimeSupervisor(),
      code: "runtime_drain_unsupported",
    },
    {
      name: "runtime_busy",
      backend: createRuntimeBackend({ mode: "restart-required", tasks: [{ id: "running" }] }),
      supervisor: createRuntimeSupervisor(),
      code: "runtime_busy",
    },
    {
      name: "runtime_drain_unsupported",
      backend: createRuntimeBackend({ mode: "restart-required" }),
      supervisor: createRuntimeSupervisor({ capabilities: { drain: false, recoverDrain: false, restartPaused: false, waitHealthy: false } }),
      code: "runtime_drain_unsupported",
    },
    {
      name: "runtime_restart_unavailable",
      backend: createRuntimeBackend({ mode: "restart-required" }),
      supervisor: createRuntimeSupervisor({
        topology: "remote",
        capabilities: { drain: true, recoverDrain: false, restartPaused: false, waitHealthy: false },
      }),
      code: "runtime_restart_unavailable",
    },
    {
      name: "unknown-incomplete",
      backend: createRuntimeBackend({ mode: "unknown" }),
      supervisor: createRuntimeSupervisor({ capabilities: { drain: true, recoverDrain: false, restartPaused: false, waitHealthy: false } }),
      code: "runtime_drain_unsupported",
    },
  ];
  for (const scenario of scenarios) {
    let patchCalls = 0;
    const runtime = createOpenClawRuntimeApply({
      backend: scenario.backend,
      admissionGate: createWorkAdmissionGate(),
      supervisor: scenario.supervisor,
      hotWaitMs: 10,
      pollMs: 2,
    });
    await assert.rejects(
      (async () => {
        const lease = await runtime.acquireForApply({ operationId: scenario.name });
        patchCalls += 1;
        await lease.release();
      })(),
      (error) => error?.code === scenario.code,
      scenario.name,
    );
    assert.equal(patchCalls, 0, scenario.name);
    assert.equal(scenario.supervisor.state.restarted, 0, scenario.name);
  }
});

test("生产 controller 的 unknown 路径零 patch、零 restart、零 catalog broadcast", async () => {
  const backend = createRuntimeBackend({ mode: "unknown" });
  const controller = createOpenclawHostController();
  const runtime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor: controller,
  });
  let patchCalls = 0;
  let restartCalls = 0;
  let broadcasts = 0;
  const originalRestart = controller.restartPaused;
  // Object.freeze 的生产 controller 不可替换；计数保持 0 也证明 acquire 前已阻断。
  void originalRestart;
  const inspected = await runtime.inspect();
  assert.equal(inspected.mode, "unknown");
  assert.equal(inspected.safeApply, false);
  const modelChange = createOpenClawModelChange({
    backend: createFakeRpc(),
    runtimeApply: runtime,
  });
  const capabilities = await modelChange.getCapabilities();
  assert.deepEqual(
    [capabilities.supported, capabilities.create, capabilities.update, capabilities.rename, capabilities.delete],
    [false, false, false, false, false],
  );
  assert.deepEqual(capabilities.blockers, ["runtime_apply_unsupported"]);
  const preview = await modelChange.preview(renameSpec());
  assert.equal(preview.blockers.some((item) => item.code === "runtime_apply_unsupported"), true);
  await assert.rejects(
    (async () => {
      await runtime.acquireForApply({ operationId: "production-blocked" });
      patchCalls += 1;
      restartCalls += 1;
      broadcasts += 1;
    })(),
    (error) => error?.code === "runtime_drain_unsupported",
  );
  assert.deepEqual({ patchCalls, restartCalls, broadcasts }, { patchCalls: 0, restartCalls: 0, broadcasts: 0 });
});

test("畸形 supervisor lease 仍释放原始 token，capability 方法缺失稳定阻断", async () => {
  const backend = createRuntimeBackend({ mode: "restart-required" });
  let rawReleased = 0;
  const malformed = createRuntimeSupervisor();
  malformed.acquireDrain = async () => ({
    token: "malformed",
    async release() { rawReleased += 1; },
    // 缺 renew，必须在 normalize 阶段拒绝。
  });
  const malformedRuntime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor: malformed,
  });
  await assert.rejects(
    malformedRuntime.acquireForApply({ operationId: "malformed" }),
    (error) => error?.code === "runtime_drain_unsupported",
  );
  assert.equal(rawReleased, 1);

  const missingMethod = createRuntimeSupervisor();
  missingMethod.acquireDrain = undefined;
  const missingRuntime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor: missingMethod,
  });
  await assert.rejects(
    missingRuntime.acquireForApply({ operationId: "missing-method" }),
    (error) => error?.code === "runtime_drain_unsupported",
  );
});

test("unknown + 完整 supervisor 先探 hot，成功/超时重启后分别缓存 mode", async () => {
  const hotBackend = createRuntimeBackend({ mode: "unknown", verify: [false, true] });
  const hotSupervisor = createRuntimeSupervisor();
  const hotRuntime = createOpenClawRuntimeApply({
    backend: hotBackend,
    admissionGate: createWorkAdmissionGate(),
    supervisor: hotSupervisor,
    hotWaitMs: 20,
    pollMs: 2,
  });
  const hotLease = await hotRuntime.acquireForApply({ operationId: "unknown-hot" });
  assert.equal(await hotLease.verifyTarget(renameSpec(), {}), true);
  assert.equal(hotSupervisor.state.restarted, 0);
  await hotLease.release();
  assert.equal((await hotRuntime.inspect()).mode, "hot");

  const restartBackend = createRuntimeBackend({ mode: "unknown", verify: [false] });
  const restartSupervisor = createRuntimeSupervisor();
  const restartPaused = restartSupervisor.restartPaused.bind(restartSupervisor);
  restartSupervisor.restartPaused = async (input) => {
    await restartPaused(input);
    restartBackend.state.verify = [true];
  };
  const restartRuntime = createOpenClawRuntimeApply({
    backend: restartBackend,
    admissionGate: createWorkAdmissionGate(),
    supervisor: restartSupervisor,
    hotWaitMs: 8,
    pollMs: 2,
  });
  const restartLease = await restartRuntime.acquireForApply({ operationId: "unknown-restart" });
  assert.equal(await restartLease.verifyTarget(renameSpec(), {}), true);
  assert.equal(restartSupervisor.state.restarted, 1);
  await restartLease.release();
  assert.equal((await restartRuntime.inspect()).mode, "restart-required");
});

test("gateway version/连接代际变化清空 runtime mode 缓存", async () => {
  const backend = createRuntimeBackend({ mode: "unknown", verify: [true] });
  const supervisor = createRuntimeSupervisor();
  const runtime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor,
    hotWaitMs: 10,
    pollMs: 2,
  });
  const lease = await runtime.acquireForApply({ operationId: "cache-one" });
  await lease.verifyTarget(renameSpec(), {});
  await lease.release();
  assert.equal((await runtime.inspect()).mode, "hot");
  backend.state.identity.connectionGeneration += 1;
  assert.equal((await runtime.inspect()).mode, "unknown");
  backend.state.identity.gatewayVersion = "2026.7.2";
  runtime.invalidateConnectionGeneration();
  assert.equal((await runtime.inspect()).mode, "unknown");
});

test("journal recovery 复用同 operationId supervisor lease；恢复失败保持 blocked", async () => {
  const backend = createRuntimeBackend({ mode: "restart-required", tasks: [] });
  const supervisor = createRuntimeSupervisor();
  const seeded = await supervisor.acquireDrain({ operationId: "recover-one" });
  const runtime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor,
    drainTtlMs: 30,
  });
  const recovered = await runtime.recoverLease("recover-one", { mode: "restart-required" });
  assert.equal(recovered.token, seeded.token);
  assert.equal(supervisor.state.recovered, 1);
  await recovered.release();

  const blockedSupervisor = createRuntimeSupervisor();
  blockedSupervisor.recoverDrain = async () => { throw Object.assign(new Error("lost"), { code: "lost" }); };
  blockedSupervisor.acquireDrain = async () => { throw Object.assign(new Error("busy"), { code: "busy" }); };
  const blockedRuntime = createOpenClawRuntimeApply({
    backend,
    admissionGate: createWorkAdmissionGate(),
    supervisor: blockedSupervisor,
  });
  await assert.rejects(
    blockedRuntime.recoverLease("missing", { mode: "restart-required" }),
    (error) => error?.code === "runtime_drain_unsupported",
  );
});

test("supervisor owner 崩溃后 TTL 自动开放；未恢复 token 的新进程不能提前派发", async () => {
  const supervisor = createRuntimeSupervisor({ tasksLeaseTtlMs: 25 });
  const crashedOwnerLease = await supervisor.acquireDrain({ operationId: "crashed-owner" });
  assert.equal(supervisor.isDispatchPaused(), true);
  assert.equal(await supervisor.recoverDrain({ operationId: "different-operation" }), null);
  assert.equal(supervisor.isDispatchPaused(), true, "未恢复原 token 时仍必须保持 paused");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(supervisor.isDispatchPaused(), false, "owner 崩溃且无续租后由 TTL 自动释放");
  // fake lease 已自然过期，不再调用 release 模拟崩溃；避免把正常释放路径混入证据。
  void crashedOwnerLease;
});

test("OpenClawBackend 连接代际变化主动失效注入的 runtime cache", () => {
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:18792" });
  let invalidations = 0;
  backend.attachModelRuntimeApply({
    async inspect() { return { mode: "unknown" }; },
    async acquireForApply() {},
    invalidateConnectionGeneration() { invalidations += 1; },
  });
  const before = backend.getModelRuntimeIdentity();
  backend._advanceModelRuntimeGeneration();
  const after = backend.getModelRuntimeIdentity();
  assert.equal(after.connectionGeneration, before.connectionGeneration + 1);
  assert.equal(invalidations, 1);
  assert.equal(backend.getModelRuntimeApply() !== null, true);
});

test("coordinator 与 REST preview 原样公开 scannerVersion/stores", async () => {
  const scanned = await scanOpenClawReferences(createFakeRpc(), renameSpec());
  const backend = {
    id: "openclaw",
    async getModelChangeCapabilities() { return { supported: true, rename: true }; },
    async previewModelChange() { return { ...scanned, runtimeApply: "hot" }; },
  };
  const registry = {
    backends: new Map([[backend.id, backend]]),
    _activeGet(id) { return id === backend.id ? backend : null; },
    async listModelsSnapshot() { return { models: [], catalogRevision: "a".repeat(64) }; },
  };
  const journal = {
    async withExclusiveLock(run) { return run(); },
    async withProviderLock(_backendId, _providerKey, run) { return run({ checkpoint() {} }); },
  };
  const coordinator = new ModelChangeCoordinator({ registry, journal });
  coordinator.markReady();
  const server = await startStaticServer(0, { registry, modelChangeCoordinator: coordinator });
  try {
    const response = await requestJson(
      "POST",
      `${server.url}/__api/models/config/preview?backend=openclaw`,
      { providerKey: "alpha", sourceModelId: "old", model: { id: "new" } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.scannerVersion, OPENCLAW_SCANNER_VERSION);
    assert.deepEqual(response.body.stores, scanned.stores);
    assert.equal(response.body.fingerprints.scannerVersion, OPENCLAW_SCANNER_VERSION);
  } finally {
    await server.close();
  }
});

test("OpenClaw 自定义端点只纳入目录外有效 config provider 并保持模型顺序与元数据", async () => {
  const parsed = {
    models: {
      providers: {
        alpha: {
          baseUrl: "https://alpha.example.test/v1",
          api: "openai-responses",
          apiKey: "__OPENCLAW_REDACTED__",
          models: [
            {
              id: "model-b",
              name: "Model B",
              contextWindow: 131072,
              maxTokens: 8192,
              reasoning: true,
              input: ["text", "image"],
            },
            {
              id: "model-a",
              name: "Model A",
              contextWindow: 32768,
              maxTokens: 4096,
              reasoning: false,
            },
          ],
        },
        "builtin-override": {
          baseUrl: "https://builtin-override.example.test/v1",
          models: [{ id: "builtin-model" }],
        },
        "invalid-url": {
          baseUrl: "not-a-url",
          models: [{ id: "invalid-model" }],
        },
        "non-http": {
          baseUrl: "ftp://non-http.example.test/v1",
          models: [{ id: "non-http-model" }],
        },
        "empty-models": {
          baseUrl: "https://empty.example.test/v1",
          models: [],
        },
        "manual-only": {
          baseUrl: "http://manual-only.example.test/api",
          models: [{ id: "manual-model", name: "Manual Model", reasoning: true }],
        },
        "non-object": "https://not-an-object.example.test/v1",
      },
    },
    auth: {
      profiles: {
        "auth-only:default": { provider: "auth-only", mode: "api_key" },
      },
    },
  };
  const catalog = {
    alpha: { builtin: false, label: "不能替代 Provider ID" },
    "builtin-override": { builtin: true, label: "内置提供方" },
    "manual-only": { builtin: false, label: "Manual Catalog Label" },
    "protocol-anthropic": { builtin: true, api: "anthropic-messages" },
    "protocol-completions": { builtin: true, api: "openai-completions" },
    "protocol-ollama": { builtin: true, api: "ollama" },
  };
  const authProviders = ["auth-only", "manual-only"];
  const keyDigests = [
    ["alpha", "sk-a...7890"],
    ["manual-only", "sk-m...4321"],
  ];
  const before = {
    parsed: JSON.parse(JSON.stringify(parsed)),
    catalog: JSON.parse(JSON.stringify(catalog)),
    authProviders: JSON.parse(JSON.stringify(authProviders)),
    keyDigests: JSON.parse(JSON.stringify(keyDigests)),
  };
  const { backend, reads, getWrites } = createOpenClawEndpointBackend({
    parsed,
    catalog,
    authProviders,
    keyDigests,
  });

  const snapshot = await backend.listCustomEndpoints();

  assert.equal(snapshot.supported, true);
  assert.deepEqual(snapshot.endpoints.map((endpoint) => endpoint.id), ["alpha", "manual-only"]);
  assert.deepEqual(snapshot.form, {
    apiOptions: [
      "openai-completions",
      "openai-responses",
      "openai-chatgpt-responses",
      "anthropic-messages",
      "google-generative-ai",
      "google-vertex",
      "github-copilot",
      "bedrock-converse-stream",
      "ollama",
      "azure-openai-responses",
    ],
    defaultApi: "openai-completions",
    nameEditable: false,
    nameIsProviderId: true,
    providerIdEditable: true,
    firstModelIsDefault: false,
    batchModelSelection: true,
    allowPrimaryModelRemoval: true,
  });
  const alpha = snapshot.endpoints[0];
  assert.equal(alpha.name, "alpha", "OpenClaw 显示名必须回落 provider id");
  assert.equal(alpha.baseUrl, "https://alpha.example.test/v1");
  assert.deepEqual(alpha.models, ["model-b", "model-a"]);
  assert.equal(alpha.model, "model-b");
  assert.equal(alpha.api, "openai-responses");
  assert.equal(alpha.hasApiKey, true);
  assert.equal(alpha.apiKeyPreview, "sk-a...7890");
  assert.equal(alpha.canRevealApiKey, true);
  assert.equal(alpha.canClearApiKey, true);
  const manualOnly = snapshot.endpoints[1];
  assert.equal(manualOnly.name, "manual-only");
  assert.equal(manualOnly.baseUrl, "http://manual-only.example.test/api");
  assert.deepEqual(manualOnly.models, ["manual-model"]);
  assert.equal(manualOnly.model, "manual-model");
  assert.equal(manualOnly.api ?? null, null);
  assert.equal(manualOnly.hasApiKey, true, "auth-profile 来源也必须计入 hasApiKey");
  assert.equal(manualOnly.apiKeyPreview, "sk-m...4321");
  assert.equal(manualOnly.canRevealApiKey, true, "本地普通 auth-profile Key 应允许 reveal");
  assert.equal(manualOnly.canClearApiKey, true, "clear 能力不得依赖 config 内是否有 apiKey");
  assert.deepEqual(parsed, before.parsed, "只读 mapper 不得压平或改写模型元数据");
  assert.deepEqual(catalog, before.catalog, "只读 mapper 不得改写生成/手工目录分类");
  assert.deepEqual(authProviders, before.authProviders, "只读 mapper 不得改写 auth provider 输入");
  assert.deepEqual(keyDigests, before.keyDigests, "只读 mapper 不得改写 key 摘要输入");
  assert.equal(Object.values(reads).every((count) => count > 0), true);
  assert.equal(getWrites(), 0);
});

test("OpenClaw 端点模型用途包含默认和多助理主模型，不把回退或歧义裸 ID 当作主模型", async () => {
  const { backend } = createOpenClawEndpointBackend({ parsed: {
    models: { providers: {
      alpha: { baseUrl: "https://fixture.test/v1", models: [{ id: "old" }, { id: "new" }, { id: "shared" }] },
      beta: { baseUrl: "https://fixture.test/v1", models: [{ id: "shared" }] },
    } },
    agents: {
      defaults: { model: { primary: "alpha/new", fallbacks: ["alpha/shared"] } },
      entries: {
        main: { model: { primary: "alpha/old" } }, sara: { model: { primary: "old" } },
        travelplanner: { model: { primary: "beta/shared" } }, ambiguous: { model: { primary: "shared" } },
      },
    },
  } });
  const snapshot = await backend.listCustomEndpoints();
  assert.deepEqual(snapshot.endpoints[0].primaryModelUsage, [
    { modelId: "old", isDefault: false, agentIds: ["main", "sara"] },
    { modelId: "new", isDefault: true, agentIds: [] },
  ]);
  assert.deepEqual(snapshot.endpoints[1].primaryModelUsage, [
    { modelId: "shared", isDefault: false, agentIds: ["travelplanner"] },
  ]);
});

test("OpenClaw 端点加载走实时 Gateway 授权摘要，模型回读缓存不跨 Agent 或连接", async () => {
  const backend = new OpenClawBackend();
  backend._isLocalGateway = () => true;
  backend._modelAuthCliVersionOverride = "2026.9.1";
  backend._modelAuthAgentIdsOverride = ["main"];
  backend._localKeyDigests = () => new Map();
  backend._providerCatalogSnapshot = () => ({ providers: {} });
  backend.getModelChangeCapabilities = async () => ({ supported: true, updateProvider: true });
  let authReads = 0;
  let profiles = [{ id: "custom:default", provider: "custom", type: "api_key" }];
  backend._runModelAuthCli = async () => { throw new Error("page loads must not launch the CLI"); };
  backend.request = async (method, params) => {
    assert.equal(method, "models.authStatus");
    assert.deepEqual(params, { agentId: backend._modelAuthAgentId(), refresh: true });
    authReads++;
    return { providers: [{ provider: "custom", profiles: profiles.map(profile => ({
      profileId: profile.id, type: profile.type, key: "must-not-leak",
    })) }] };
  };
  const config = { models: { providers: { custom: { baseUrl: "https://example.test/v1", models: [{ id: "one" }] } } } };
  backend._configSnapshot = async () => ({ parsed: structuredClone(config) });
  let snapshot = await backend.listCustomEndpoints({ refreshAuth: false });
  assert.equal(authReads, 1, "cold read queries the official Gateway without starting a CLI process");
  assert.equal(snapshot.endpoints[0].hasApiKey, true);
  assert.equal(snapshot.endpoints[0].canRevealApiKey, true);
  assert.equal(snapshot.endpoints[0].canClearApiKey, true);
  assert.equal(JSON.stringify(snapshot).includes("must-not-leak"), false);
  assert.equal(backend._canonicalAuthProfiles, null, "Gateway status must not replace the CLI profile inventory");
  config.models.providers.custom.models.push({ id: "two" });
  snapshot = await backend.listCustomEndpoints({ refreshAuth: false });
  assert.deepEqual(snapshot.endpoints[0].models, ["one", "two"], "config must never come from the auth cache");
  assert.equal(authReads, 1);
  profiles = [];
  snapshot = await backend.listCustomEndpoints();
  assert.equal(authReads, 2, "normal loads and credential edits require a fresh authorization list");
  assert.equal(snapshot.endpoints[0].hasApiKey, false);
  backend._modelAuthAgentIdsOverride = ["another-owner"];
  await backend.listCustomEndpoints({ refreshAuth: false });
  assert.equal(authReads, 3, "credential metadata cannot cross Agent owners");
  backend._advanceModelRuntimeGeneration();
  await backend.listCustomEndpoints({ refreshAuth: false });
  assert.equal(authReads, 4, "credential metadata cannot cross Gateway connections");
  backend._getUpstreamUrl = () => "ws://127.0.0.1:28792";
  await backend.listCustomEndpoints({ refreshAuth: false });
  assert.equal(authReads, 5, "credential metadata cannot cross Gateway URLs");
  profiles = [{ id: "custom:team", provider: "custom", type: "api_key" },
    { id: "custom:default", provider: "custom", type: "oauth" }];
  snapshot = await backend.listCustomEndpoints();
  assert.equal(snapshot.endpoints[0].hasApiKey, true);
  assert.equal(snapshot.endpoints[0].canRevealApiKey, false, "named profiles must not expose a default-key action");
  assert.equal(snapshot.endpoints[0].canClearApiKey, false);
});

test("OpenClaw 端点授权 RPC 不兼容时回退官方 CLI，双重失败不能返回旧状态", async () => {
  const backend = new OpenClawBackend();
  backend._isLocalGateway = () => true;
  backend._modelAuthCliVersionOverride = "2026.9.1";
  backend._modelAuthAgentIdsOverride = ["main"];
  let cliReads = 0;
  backend._runModelAuthCli = async () => {
    cliReads++;
    return { profiles: [{ id: "custom:default", provider: "custom", type: "api_key" }] };
  };
  for (const response of [null, { providers: [], unavailable: { code: "not_ready" } },
    { providers: [{ provider: "custom", profiles: [{ type: "api_key" }] }] }]) {
    backend.request = async () => response;
    const profiles = await backend._loadEndpointAuthKeyProfiles();
    assert.equal(profiles.get("custom").has("custom:default"), true);
  }
  assert.equal(cliReads, 3, "each normal load checks fresh official credentials even on fallback");
  backend.request = async () => { throw new Error("unknown method"); };
  backend._runModelAuthCli = async () => { throw new Error("official auth read failed"); };
  await assert.rejects(backend._loadEndpointAuthKeyProfiles(), /official auth read failed/);
  backend._isLocalGateway = () => false;
  assert.equal((await backend._loadEndpointAuthKeyProfiles()).size, 0, "remote Gateways must not consult local credentials");
});

test("OpenClaw 已知 Gateway 版本满足规范时不额外启动 CLI 探测版本", () => {
  const backend = new OpenClawBackend();
  backend._gatewayVersion = "2026.9.1";
  backend._localOpenClawVersion = () => { throw new Error("unnecessary CLI version probe"); };
  assert.equal(backend._usesCanonicalModelAuthCli(), true);
});

test("OpenClaw 自定义端点配置读取失败必须抛出而非伪装成空快照", async () => {
  const { backend, getWrites } = createOpenClawEndpointBackend({ parsed: {} });
  backend._configSnapshot = async () => {
    throw new Error("config unavailable");
  };

  await assert.rejects(
    backend.listCustomEndpoints(),
    (error) => error?.message === "config unavailable",
  );
  assert.equal(getWrites(), 0);
});

test("OpenClaw 自定义端点严格过滤畸形模型 ID 且过滤后为空时排除 provider", async () => {
  const { backend, getWrites } = createOpenClawEndpointBackend({
    parsed: {
      models: {
        providers: {
          malformed: {
            baseUrl: "https://malformed.example.test/v1",
            models: [null, {}, { id: " " }, { id: {} }, { id: true }],
          },
        },
      },
    },
  });

  const snapshot = await backend.listCustomEndpoints();

  assert.deepEqual(snapshot.endpoints, []);
  assert.equal(
    JSON.stringify(snapshot).includes("[object Object]") || JSON.stringify(snapshot).includes('"true"'),
    false,
  );
  assert.equal(getWrites(), 0);
});

test("OpenClaw clear Key 能力接受完整或 config-only updateProvider 并在两者缺失时关闭", async () => {
  const parsed = {
    models: {
      providers: {
        clearable: {
          baseUrl: "https://clearable.example.test/v1",
          apiKey: "__OPENCLAW_REDACTED__",
          models: [{ id: "clearable-model" }],
        },
      },
    },
  };
  const configOnly = createOpenClawEndpointBackend({
    parsed,
    canUpdateProvider: false,
  }).backend;
  configOnly.getModelConfigWriteCapabilities = async () => ({ supported: true, updateProvider: true });
  assert.equal((await configOnly.listCustomEndpoints()).endpoints[0].canClearApiKey, true);

  const fullUnavailable = createOpenClawEndpointBackend({
    parsed,
    canUpdateProvider: false,
  }).backend;
  fullUnavailable.getModelChangeCapabilities = async () => {
    throw new Error("full capabilities unavailable");
  };
  fullUnavailable.getModelConfigWriteCapabilities = async () => ({ supported: true, updateProvider: true });
  assert.equal((await fullUnavailable.listCustomEndpoints()).endpoints[0].canClearApiKey, true);

  const unavailable = createOpenClawEndpointBackend({
    parsed,
    canUpdateProvider: false,
  }).backend;
  unavailable.getModelChangeCapabilities = async () => {
    throw new Error("full capabilities unavailable");
  };
  unavailable.getModelConfigWriteCapabilities = async () => ({ supported: false, updateProvider: false });
  assert.equal((await unavailable.listCustomEndpoints()).endpoints[0].canClearApiKey, false);
});

test("OpenClaw Provider 目录按真实写能力投影 Key 清理按钮", async () => {
  const { backend } = createOpenClawEndpointBackend({
    parsed: {
      models: {
        providers: {
          "config-key": {
            baseUrl: "https://config-key.example.test/v1",
            apiKey: "__OPENCLAW_REDACTED__",
            models: [{ id: "model-a" }],
          },
        },
      },
      auth: {
        profiles: {
          "auth-only:default": { provider: "auth-only", type: "api_key" },
        },
      },
    },
    canUpdateProvider: false,
  });
  backend.getModelChangeCapabilities = async () => {
    throw new Error("full capabilities unavailable");
  };
  backend.getModelConfigWriteCapabilities = async () => ({
    supported: false,
    updateProvider: false,
  });

  const directory = await backend.getProviderDirectory();
  const byId = new Map(directory.providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.get("config-key").key.clearable, false);
  assert.equal(
    byId.get("auth-only").key.clearable,
    true,
    "纯 auth-profile Key 不依赖 updateProvider，可走 auth profile 删除",
  );

  const named = createOpenClawEndpointBackend({
    parsed: {
      auth: {
        profiles: {
          "named-profile": { provider: "named-auth", type: "api_key" },
        },
      },
    },
  }).backend;
  const namedDirectory = await named.getProviderDirectory();
  assert.equal(namedDirectory.providers[0].key.clearable, false, "非 default profile 不能误报可清理");

  const remote = createOpenClawEndpointBackend({
    local: false,
    parsed: {
      auth: {
        profiles: {
          "remote-auth:default": { provider: "remote-auth", type: "api_key" },
        },
      },
    },
  }).backend;
  const remoteDirectory = await remote.getProviderDirectory();
  assert.equal(remoteDirectory.providers[0].key.clearable, false, "远程 auth profile 不能误报可清理");
});

test("OpenClaw 命名 auth Key 只报告存在，默认 auth Key 才允许当前 reveal 与 clear", async () => {
  const { backend, getWrites } = createOpenClawEndpointBackend({
    parsed: {
      models: {
        providers: {
          named: {
            baseUrl: "https://named.example.test/v1",
            models: [{ id: "named-model" }],
          },
          defaulted: {
            baseUrl: "https://defaulted.example.test/v1",
            models: [{ id: "defaulted-model" }],
          },
        },
      },
    },
    authProviders: ["named", "defaulted"],
    authProfileIds: ["named:team", "defaulted:default"],
    keyDigests: [
      ["named", "sk-n...1111"],
      ["defaulted", "sk-d...2222"],
    ],
  });

  const snapshot = await backend.listCustomEndpoints();
  const named = snapshot.endpoints.find((endpoint) => endpoint.id === "named");
  const defaulted = snapshot.endpoints.find((endpoint) => endpoint.id === "defaulted");

  assert.ok(named);
  assert.equal(named.hasApiKey, true);
  assert.equal(named.apiKeyPreview, "sk-n...1111");
  assert.equal(named.canRevealApiKey, false);
  assert.equal(named.canClearApiKey, false);
  assert.ok(defaulted);
  assert.equal(defaulted.hasApiKey, true);
  assert.equal(defaulted.apiKeyPreview, "sk-d...2222");
  assert.equal(defaulted.canRevealApiKey, true);
  assert.equal(defaulted.canClearApiKey, true);
  assert.equal(getWrites(), 0);
});

test("OpenClaw 自定义端点表单公开权威 MODEL_APIS 全集并保留当前协议", async () => {
  const authoritativeApis = [
    "openai-completions",
    "openai-responses",
    "openai-chatgpt-responses",
    "anthropic-messages",
    "google-generative-ai",
    "google-vertex",
    "github-copilot",
    "bedrock-converse-stream",
    "ollama",
    "azure-openai-responses",
  ];
  const { backend } = createOpenClawEndpointBackend({
    parsed: {
      models: {
        providers: {
          vertex: {
            baseUrl: "https://vertex.example.test/v1",
            api: "google-vertex",
            models: [{ id: "vertex-model" }],
          },
        },
      },
    },
  });

  const snapshot = await backend.listCustomEndpoints();

  assert.deepEqual(snapshot.form.apiOptions, authoritativeApis);
  assert.equal(snapshot.endpoints[0].api, "google-vertex");
});

test("OpenClaw 远程普通 Key 不可 reveal 但 coordinator clear 能力保持开启", async () => {
  const { backend, getWrites } = createOpenClawEndpointBackend({
    local: false,
    parsed: {
      models: {
        providers: {
          remote: {
            baseUrl: "https://remote.example.test/v1",
            apiKey: "__OPENCLAW_REDACTED__",
            models: [{ id: "remote-model" }],
          },
        },
      },
    },
  });

  const snapshot = await backend.listCustomEndpoints();
  const endpoint = snapshot.endpoints.find((row) => row.id === "remote");

  assert.ok(endpoint);
  assert.equal(endpoint.hasApiKey, true);
  assert.equal(endpoint.apiKeyPreview ?? null, null);
  assert.equal(endpoint.canRevealApiKey, false);
  assert.equal(endpoint.canClearApiKey, true);
  assert.equal(getWrites(), 0);
});

test("OpenClaw managed SecretRef 不可 reveal 但 coordinator clear 能力保持开启", async () => {
  const { backend, getWrites } = createOpenClawEndpointBackend({
    parsed: {
      models: {
        providers: {
          managed: {
            baseUrl: "https://managed.example.test/v1",
            apiKey: { source: "env", id: "MANAGED_ENDPOINT_KEY" },
            models: [{ id: "managed-model" }],
          },
        },
      },
    },
  });

  const snapshot = await backend.listCustomEndpoints();
  const endpoint = snapshot.endpoints.find((row) => row.id === "managed");

  assert.ok(endpoint);
  assert.equal(endpoint.hasApiKey, true);
  assert.equal(endpoint.apiKeyPreview ?? null, null);
  assert.equal(endpoint.canRevealApiKey, false);
  assert.equal(endpoint.canClearApiKey, true);
  assert.equal(getWrites(), 0);
});

test("静态服务 clearApiKey 只透传 ModelChangeCoordinator 且不调用 backend 直写", async () => {
  let directWrites = 0;
  let coordinatorCalls = 0;
  let coordinatorCall = null;
  const backend = {
    id: "openclaw",
    async updateModelProvider() { directWrites += 1; throw new Error("不得直写 backend"); },
    async addModelConfig() { directWrites += 1; throw new Error("不得直写 backend"); },
    async removeModelConfig() { directWrites += 1; throw new Error("不得直写 backend"); },
    async removeModelProvider() { directWrites += 1; throw new Error("不得直写 backend"); },
  };
  const registry = { backends: new Map([[backend.id, backend]]) };
  const coordinator = {
    isReady() { return true; },
    async updateProviderCompat(backendId, providerKey, patch, options) {
      coordinatorCalls += 1;
      const allowedPatchKeys = new Set([
        "baseUrl",
        "apiKey",
        "api",
        "clearBaseUrl",
        "clearApiKey",
        "renameTo",
      ]);
      assert.deepEqual(
        Object.keys(patch).filter((key) => !allowedPatchKeys.has(key)),
        [],
        "coordinator patch 不得透传 body 的未知字段",
      );
      coordinatorCall = { backendId, providerKey, patch, options };
      return { status: "applied", activation: null };
    },
  };
  const server = await startStaticServer(0, {
    registry,
    modelChangeCoordinator: coordinator,
  });
  try {
    const response = await requestJson(
      "PUT",
      `${server.url}/__api/models/config?backend=openclaw`,
      {
        providerKey: "alpha",
        clearApiKey: true,
        operationId: "endpoint-clear-key",
        ignoredSentinel: true,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "applied");
    assert.equal(coordinatorCalls, 1);
    assert.deepEqual(coordinatorCall, {
      backendId: "openclaw",
      providerKey: "alpha",
      patch: {
        baseUrl: undefined,
        apiKey: undefined,
        api: undefined,
        clearBaseUrl: false,
        clearApiKey: true,
      },
      options: {
        operationId: "endpoint-clear-key",
      },
    });
    assert.equal(directWrites, 0);
  } finally {
    await server.close();
  }
});

test("model-change adapter 暴露固定四方法且 backend 只做委托", async () => {
  const calls = [];
  const adapter = {
    async getCapabilities() { calls.push("capabilities"); return { supported: true }; },
    async preview(spec) { calls.push(["preview", spec]); return { references: [], blockers: [] }; },
    async apply(spec, context, secret) { calls.push(["apply", spec, context, secret]); return { status: "applied" }; },
    async recover(entry, context) { calls.push(["recover", entry, context]); return { status: "applied" }; },
  };
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:18792" });
  backend.attachModelChangeAdapter(adapter);
  // capabilities = adapter 委托 + 静态能力位并入（providerDirectory 恒真，铁律 6：
  // 静态事实放运行时探测之外，一次读取失败不得翻转页面形态）
  assert.deepEqual(await backend.getModelChangeCapabilities(), { supported: true, providerDirectory: true, manageAuthProfiles: true });
  assert.deepEqual(await backend.previewModelChange({ kind: "create" }), { references: [], blockers: [] });
  assert.deepEqual(await backend.applyModelChange({ kind: "create" }, { operationId: "delegate" }, null), { status: "applied" });
  assert.deepEqual(await backend.recoverModelChange({ operationId: "delegate" }, {}), { status: "applied" });
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "capabilities", "preview", "apply", "recover",
  ]);
});

test("授权 profile 管理只属于本地 OpenClaw，能力探测失败不改变静态边界", async () => {
  for (const [url, expected] of [["ws://127.0.0.1:18792", true], ["wss://gateway.example.test", false]]) {
    const backend = new OpenClawBackend({ getUpstreamUrl: () => url });
    const unavailable = await backend.getModelChangeCapabilities();
    assert.equal(unavailable.supported, false);
    assert.equal(unavailable.manageAuthProfiles, expected);
    assert.equal(unavailable.providerDirectory, true);
  }
});

test("OpenClaw Provider 摘要在哈希前剥离 URL userinfo 与 query 凭据", () => {
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:18792" });
  const digestOf = (baseUrl) => backend._modelConfigRowsFromParsed({
    models: { providers: { alpha: { baseUrl, api: "openai", models: [{ id: "model-a" }] } } },
  })[0].providerConfigDigest;
  const safeDigest = digestOf("https://example.test/v1");
  assert.equal(
    digestOf("https://user:password@example.test/v1?api_key=top-secret#fragment"),
    safeDigest,
  );
  assert.equal(
    digestOf("not-a-url?token=top-secret"),
    digestOf("not-a-url"),
    "无效 URL 的查询凭据也不得进入摘要",
  );
});

test("直接 legacy 模型写入口无 coordinator capability 时稳定零写拒绝", async () => {
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:18792" });
  let configRpcCalls = 0;
  backend.request = async () => { configRpcCalls += 1; return {}; };
  const cases = [
    () => backend.addModelConfig({ providerKey: "alpha", model: { id: "new" } }),
    () => backend.updateModelProvider("alpha", { baseUrl: "https://example.test" }),
    () => backend.removeModelConfig({ providerKey: "alpha", modelId: "old" }),
    () => backend.removeModelProvider("alpha"),
  ];
  for (const run of cases) {
    await assert.rejects(run, (error) => error?.code === "model_change_coordinator_required");
  }
  assert.equal(configRpcCalls, 0);
});

test("model-change factory 在 runtime 与 scanner 能力缺失时 fail-closed", async () => {
  assert.throws(
    () => createOpenClawModelChange({ backend: {}, scanners: [], runtimeApply: {} }),
    (error) => error?.code === "invalid_model_change_dependency",
  );
});

test("delete preview 不把 source 配置定义误报为未来引用", async () => {
  const backend = createFakeRpc();
  const runtimeApply = {
    async inspect() { return { mode: "hot", safeApply: true, verified: true }; },
    async acquireForApply() { throw new Error("preview 不应 acquire"); },
    async recoverLease() {},
  };
  const adapter = createOpenClawModelChange({ backend, runtimeApply });
  const result = await adapter.preview({ kind: "delete-model", providerKey: "alpha", sourceModelId: "old" });
  assert.equal(result.references.some((reference) => reference.definition === true), false);
  assert.equal(result.blockers.some((item) => item.code === "references_exist"), false);
});

test("delete-provider 聚合多模型扫描时 policy ref 去重并阻断悬空可见性", async () => {
  const backend = createFakeRpc({
    config: {
      models: { providers: { alpha: { models: [{ id: "old" }, { id: "second" }] } } },
      agents: {
        defaults: { modelPolicy: { allow: ["alpha/old", "alpha/*"] } },
        entries: { main: { modelPolicy: { allow: ["alpha/stale"] } } },
      },
    },
  });
  const runtimeApply = {
    async inspect() { return { mode: "hot", safeApply: true, verified: true }; },
    async acquireForApply() { throw new Error("preview 不应 acquire"); },
    async recoverLease() {},
  };
  const adapter = createOpenClawModelChange({ backend, runtimeApply });
  const result = await adapter.preview({ kind: "delete-provider", providerKey: "alpha", sourceModelId: null });
  const policyRefs = result.references.filter((item) => item.referenceKey.includes("modelPolicy.allow"));
  assert.deepEqual(policyRefs.map((item) => item.referenceKey), [
    "agents.defaults.modelPolicy.allow[0]",
    "agents.defaults.modelPolicy.allow[1]",
    "agents.entries.main.modelPolicy.allow[0]",
  ]);
  assert.equal(new Set(policyRefs.map((item) => item.referenceKey)).size, policyRefs.length);
  assert.ok(result.blockers.some((item) => item.code === "references_exist"));
});

test("delete preview 在确认之前识别默认或助理主模型，回退引用仍可确认清理", async () => {
  for (const holder of ["defaults", "agent", "fallback"]) {
    const model = holder === "fallback" ? { fallbacks: ["alpha/old"] } : { primary: "alpha/old" };
    const backend = createFakeRpc({ config: {
      models: { providers: { alpha: { models: [{ id: "old" }] } } },
      agents: holder === "agent" ? { entries: { writer: { model } } } : { defaults: { model } },
    } });
    const adapter = createOpenClawModelChange({ backend, runtimeApply: {
      async inspect() { return { mode: "unsupported", safeApply: false }; },
      async acquireForApply() { throw new Error("preview 不应 acquire"); },
      async recoverLease() {},
    } });
    for (const kind of ["delete-model", "delete-provider"]) {
      const result = await adapter.preview({ kind, providerKey: "alpha", sourceModelId: kind === "delete-model" ? "old" : null });
      assert.equal(result.blockers.some(item => item.code === "references_exist"), true);
      assert.equal(result.blockers.some(item => item.code === "primary_model_in_use"), holder !== "fallback");
    }
  }
});

test("models alias 与 modelPolicy visibility 都不能伪装成模型存在性", async () => {
  const config = {
    models: { providers: { alpha: { models: [{ id: "old", name: "Old" }] } } },
    agents: {
      defaults: {
        models: {
          "alpha/ghost": { alias: "ghost" },
          "alpha/new": { alias: "prepared" },
        },
        modelPolicy: { allow: ["alpha/ghost", "alpha/new"] },
      },
      entries: { main: {} },
    },
  };
  const harness = createModelChangeHarness({ config });

  const missing = await harness.adapter.preview(renameSpec({ sourceModelId: "ghost" }));
  assert.ok(missing.blockers.some((item) => item.code === "source_not_found"));

  const create = await harness.adapter.preview({
    kind: "create",
    providerMode: "existing",
    providerKey: "alpha",
    sourceModelId: null,
    model: { id: "new" },
  });
  assert.equal(create.blockers.some((item) => item.code === "target_conflict"), false);
});

test("rename 用唯一 config.patch 原子加入 target、保留 source 并迁移 config Agent 引用", async () => {
  const references = [
    {
      scannerId: "openclaw.config.v2", store: "config", referenceKey: "agents.defaults.model.primary",
      before: "alpha/old", after: "alpha/new", undo: "alpha/old", fingerprint: "config-ref",
    },
    {
      scannerId: "openclaw.config.v2", store: "config", referenceKey: "agents.defaults.model.fallbacks[0]",
      before: "old", after: "new", undo: "old", fingerprint: "config-fallback-ref",
      replacePath: "agents.defaults.model.fallbacks",
    },
    {
      scannerId: "openclaw.config.v2", store: "config", referenceKey: "agents.entries.writer.model.primary",
      before: "old", after: "new", undo: "old", fingerprint: "config-agent-ref",
    },
    {
      scannerId: "openclaw.config.v2", store: "config", referenceKey: "agents.defaults.modelPolicy.allow[0]",
      before: "alpha/old", after: "alpha/new", undo: "alpha/old", fingerprint: "config-default-policy-ref",
      replacePath: "agents.defaults.modelPolicy.allow",
    },
    {
      scannerId: "openclaw.config.v2", store: "config", referenceKey: "agents.entries.writer.modelPolicy.allow[1]",
      before: "alpha/old", after: "alpha/new", undo: "alpha/old", fingerprint: "config-agent-policy-ref",
      replacePath: "agents.entries.writer.modelPolicy.allow",
    },
    {
      scannerId: "openclaw.sessions.v1", store: "sessions", referenceKey: "session-1",
      before: { model: "alpha/old" }, after: { model: "alpha/new" }, undo: { model: "alpha/old" }, fingerprint: "session-ref",
    },
    {
      scannerId: "openclaw.cron.v1", store: "cron", referenceKey: "cron-1",
      before: { model: "old", fallbacks: [] }, after: { model: "new", fallbacks: [] }, undo: { model: "old", fallbacks: [] }, fingerprint: "cron-ref",
    },
  ];
  const aliases = {
    "alpha/old": { alias: "fast", params: { temperature: 0.2 }, streaming: false },
    "alpha/new": { params: { temperature: 0.8 }, codeMode: true },
    "beta/other": { alias: "other" },
  };
  const agentAliases = {
    "alpha/old": { alias: "writer-fast", streaming: false },
    "alpha/new": { codeMode: true, streaming: true },
  };
  const harness = createModelChangeHarness({
    references,
    config: baseConfig({
      agents: {
        defaults: {
          model: { primary: "alpha/old", fallbacks: ["old"] },
          models: aliases,
          modelPolicy: { allow: ["alpha/old", "alpha/*", "fast"] },
        },
        entries: {
          writer: {
            model: { primary: "old", fallbacks: [] },
            models: agentAliases,
            modelPolicy: { allow: ["beta/other", "alpha/old"] },
          },
        },
      },
    }),
  });
  const spec = renameSpec({ model: { id: "new", name: "New", reasoning: false } });
  const preview = await harness.adapter.preview(spec);
  assert.equal(preview.blockers.length, 0);
  const { context, events } = createModelChangeContext("rename-happy");
  context.journalEntry.fingerprints = preview.fingerprints;
  const result = await harness.adapter.apply(spec, context, null);
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.equal(harness.state.patchCalls.length, 2, "stage 与 retire 各一次，config 引用不能二次 patch");
  const staged = JSON.parse(harness.state.patchCalls[0].raw);
  assert.deepEqual(harness.state.patchCalls[0].replacePaths, [
    "agents.defaults.model.fallbacks",
    "agents.defaults.modelPolicy.allow",
    "agents.entries.writer.modelPolicy.allow",
    "models.providers.alpha.models",
  ]);
  assert.equal(harness.state.patchCalls[0].replacePaths.includes("agents.list"), false);
  assert.deepEqual(staged.models.providers.alpha.models.map((model) => model.id), ["old", "new"]);
  assert.equal(staged.agents.defaults.model.primary, "alpha/new");
  assert.deepEqual(staged.agents.defaults.modelPolicy.allow, ["alpha/new", "alpha/*", "fast"]);
  assert.deepEqual(staged.agents.entries.writer.modelPolicy.allow, ["beta/other", "alpha/new"]);
  assert.deepEqual(staged.agents.defaults.models, {
    "alpha/old": null,
    "alpha/new": {
      alias: "fast",
      params: { temperature: 0.8 },
      streaming: false,
      codeMode: true,
    },
    "beta/other": { alias: "other" },
  });
  assert.deepEqual(staged.agents.entries.writer.models, {
    "alpha/old": null,
    "alpha/new": { alias: "writer-fast", streaming: true, codeMode: true },
  });
  assert.equal(harness.state.config.models.providers.alpha.models.some((model) => model.id === "old"), false);
  assert.equal(Object.hasOwn(harness.state.config.agents.defaults.models, "alpha/old"), false);
  assert.deepEqual(harness.state.config.agents.defaults.models["alpha/new"], {
    alias: "fast",
    params: { temperature: 0.8 },
    streaming: false,
    codeMode: true,
  });
  assert.equal(Object.hasOwn(harness.state.config.agents.entries.writer.models, "alpha/old"), false);
  assert.equal(harness.byKey.get("session-1").model, "alpha/new");
  assert.equal(harness.byKey.get("cron-1").model, "new");
  assert.deepEqual(harness.state.referenceWrites, ["session-1", "cron-1"]);
  assert.equal(harness.state.runtimeVerified, 1);
  assert.equal(harness.state.runtimeConverged, 1);
  assert.equal(harness.state.runtimeReleases, 1);
  const phaseEvents = events.filter((event) => Array.isArray(event) && ["stage", "committing", "committed"].includes(event[0]));
  assert.deepEqual(phaseEvents.map((event) => event[0] === "stage" ? event[1] : event[0]), [
    "preflight", "stage-target", "migrate-references", "verify-ready", "committing", "committed", "commit-retire",
  ]);
});

test("target 冲突与 apply 前 fingerprint/baseHash 变化均在首写前阻断", async () => {
  const conflictHarness = createModelChangeHarness({
    config: baseConfig({
      models: { providers: { alpha: { models: [{ id: "old" }, { id: "new" }] } } },
      agents: { defaults: {}, entries: { main: {} } },
    }),
  });
  const conflict = await conflictHarness.adapter.preview(renameSpec());
  assert.equal(conflict.blockers.some((item) => item.code === "target_conflict"), true);
  assert.equal(conflictHarness.state.patchCalls.length, 0);

  const staleHarness = createModelChangeHarness();
  const preview = await staleHarness.adapter.preview(renameSpec());
  const { context } = createModelChangeContext("rename-stale");
  context.journalEntry.fingerprints = preview.fingerprints;
  staleHarness.state.hash = "hash-external";
  const result = await staleHarness.adapter.apply(renameSpec(), context, null);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "reference_fingerprint_changed");
  assert.equal(staleHarness.state.patchCalls.length, 0);
  assert.equal(staleHarness.state.runtimeAcquires, 0);
});

test("rename precommit 引用失败按逆序补偿且始终保留 source", async () => {
  const references = [
    {
      scannerId: "openclaw.config.v2", store: "config", referenceKey: "agents.defaults.modelPolicy.allow[0]",
      before: "alpha/old", after: "alpha/new", undo: "alpha/old", fingerprint: "config-policy",
      replacePath: "agents.defaults.modelPolicy.allow",
    },
    {
      scannerId: "openclaw.sessions.v1", store: "sessions", referenceKey: "session-ok",
      before: { model: "old" }, after: { model: "new" }, undo: { model: "old" }, fingerprint: "session-ok",
    },
    {
      scannerId: "openclaw.cron.v1", store: "cron", referenceKey: "cron-fail",
      before: { model: "old" }, after: { model: "new" }, undo: { model: "old" }, fingerprint: "cron-fail",
    },
  ];
  const aliases = { "alpha/old": { alias: "fast" }, "beta/keep": { alias: "keep" } };
  const harness = createModelChangeHarness({
    references,
    failWriteKey: "cron-fail",
    config: baseConfig({
      agents: {
        defaults: {
          models: aliases,
          modelPolicy: { allow: ["alpha/old", "alpha/*", "fast"] },
        },
        entries: { main: { modelPolicy: { allow: ["beta/keep"] } } },
      },
    }),
  });
  const preview = await harness.adapter.preview(renameSpec());
  const { context } = createModelChangeContext("rename-compensate");
  context.journalEntry.fingerprints = preview.fingerprints;
  const result = await harness.adapter.apply(renameSpec(), context, null);
  assert.equal(result.status, "compensated");
  assert.deepEqual(harness.state.referenceUndos, ["session-ok"]);
  assert.equal(harness.byKey.get("session-ok").model, "old");
  assert.equal(harness.state.config.models.providers.alpha.models.some((model) => model.id === "old"), true);
  assert.equal(harness.state.config.models.providers.alpha.models.some((model) => model.id === "new"), false);
  assert.deepEqual(harness.state.config.agents.defaults.modelPolicy.allow, ["alpha/old", "alpha/*", "fast"]);
  assert.deepEqual(harness.state.config.agents.defaults.models, aliases);
  assert.equal(Object.hasOwn(harness.state.config.agents.defaults.models, "alpha/new"), false);
  const undoPatch = harness.state.patchCalls.at(-1);
  assert.equal(undoPatch.replacePaths.includes("agents.list"), false);
  assert.ok(undoPatch.replacePaths.includes("agents.defaults.modelPolicy.allow"));
  assert.ok(undoPatch.replacePaths.includes("agents.entries.main.modelPolicy.allow"));
  assert.equal(harness.state.runtimeReleases, 1);
});

test("create/update/delete/update-provider 使用独立阶段，不误走 rename retire", async () => {
  const cases = [
    {
      spec: { kind: "create", providerMode: "existing", providerKey: "alpha", sourceModelId: null, model: { id: "created" } },
      expected: ["preflight", "stage-target", "verify-ready", "committing", "committed"],
    },
    {
      spec: { kind: "update", providerMode: "existing", providerKey: "alpha", sourceModelId: "old", model: { id: "old", name: "Updated" } },
      expected: ["preflight", "stage-target", "verify-ready", "committing", "committed"],
    },
    {
      spec: { kind: "delete-model", providerKey: "alpha", sourceModelId: "old" },
      expected: ["preflight", "committing", "committed", "commit-retire"],
    },
    {
      spec: { kind: "update-provider", providerKey: "alpha", sourceModelId: null, patch: { baseUrl: "https://new.example" } },
      expected: ["preflight", "stage-target", "verify-ready", "committing", "committed"],
    },
  ];
  for (const { spec, expected } of cases) {
    const harness = createModelChangeHarness();
    const preview = await harness.adapter.preview(spec);
    const { context, events } = createModelChangeContext(`kind-${spec.kind}`);
    context.journalEntry.fingerprints = preview.fingerprints;
    const result = await harness.adapter.apply(spec, context, null);
    assert.equal(result.status, "applied", spec.kind);
    const phases = events
      .filter((event) => Array.isArray(event) && ["stage", "committing", "committed"].includes(event[0]))
      .map((event) => event[0] === "stage" ? event[1] : event[0]);
    assert.deepEqual(phases, expected, spec.kind);
    if (spec.kind !== "delete-model") assert.equal(phases.includes("commit-retire"), false, spec.kind);
  }
});

test("delete-model/provider 只清理精确 stale settings key 并保留其它 alias/wildcard", async () => {
  const modelHarness = createModelChangeHarness({
    config: {
      models: { providers: { alpha: { models: [{ id: "old" }, { id: "keep" }] } } },
      agents: {
        defaults: {
          models: {
            "alpha/old": { alias: "old-alias" },
            "alpha/keep": { alias: "keep-alias" },
            "alpha/*": { params: { temperature: 0.1 } },
            fast: { alias: "bare" },
          },
        },
        entries: {
          main: {
            models: {
              "alpha/old": { streaming: false },
              "beta/keep": { alias: "beta" },
            },
          },
        },
      },
    },
  });
  const modelSpec = { kind: "delete-model", providerKey: "alpha", sourceModelId: "old" };
  const modelPreview = await modelHarness.adapter.preview(modelSpec);
  const { context: modelContext } = createModelChangeContext("delete-model-settings");
  modelContext.journalEntry.fingerprints = modelPreview.fingerprints;
  assert.equal((await modelHarness.adapter.apply(modelSpec, modelContext, null)).status, "applied");
  assert.equal(Object.hasOwn(modelHarness.state.config.agents.defaults.models, "alpha/old"), false);
  assert.equal(Object.hasOwn(modelHarness.state.config.agents.entries.main.models, "alpha/old"), false);
  assert.deepEqual(modelHarness.state.config.agents.defaults.models["alpha/keep"], { alias: "keep-alias" });
  assert.deepEqual(modelHarness.state.config.agents.defaults.models["alpha/*"], { params: { temperature: 0.1 } });
  assert.deepEqual(modelHarness.state.config.agents.defaults.models.fast, { alias: "bare" });
  assert.deepEqual(modelHarness.state.config.agents.entries.main.models["beta/keep"], { alias: "beta" });

  const providerHarness = createModelChangeHarness({
    config: {
      models: { providers: { alpha: { models: [{ id: "old" }] } } },
      agents: {
        defaults: {
          models: {
            "alpha/old": { alias: "old" },
            "alpha/stale": { alias: "stale" },
            "alpha/*": { streaming: false },
            "beta/keep": { alias: "beta" },
          },
        },
        entries: { main: { models: { "alpha/agent-stale": { codeMode: true } } } },
      },
    },
  });
  const providerSpec = { kind: "delete-provider", providerKey: "alpha", sourceModelId: null };
  const providerPreview = await providerHarness.adapter.preview(providerSpec);
  const { context: providerContext } = createModelChangeContext("delete-provider-settings");
  providerContext.journalEntry.fingerprints = providerPreview.fingerprints;
  assert.equal((await providerHarness.adapter.apply(providerSpec, providerContext, null)).status, "applied");
  assert.deepEqual(providerHarness.state.config.agents.defaults.models, {
    "alpha/*": { streaming: false },
    "beta/keep": { alias: "beta" },
  });
  assert.deepEqual(providerHarness.state.config.agents.entries.main.models, {});
});

test("OpenClaw crash recovery 在 source+target 并存时完成 rename retire", async () => {
  const harness = createModelChangeHarness({
    config: baseConfig({
      models: { providers: { alpha: { models: [{ id: "old", name: "Old" }, { id: "new", name: "New" }] } } },
    }),
  });
  const entry = openClawRecoveryEntry({ operationId: "recover-rename-staged" });
  const context = openClawRecoveryContext(entry);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "applied");
  assert.deepEqual(
    harness.state.config.models.providers.alpha.models.map((model) => model.id),
    ["new"],
  );
  assert.equal(harness.state.runtimeConverged, 1);
  assert.equal(context.events.includes("committed"), true);
});

test("OpenClaw crash recovery 在 source 已缺失且 target 存在时只向前收敛", async () => {
  const harness = createModelChangeHarness({
    config: baseConfig({
      models: { providers: { alpha: { models: [{ id: "new", name: "New" }] } } },
    }),
  });
  const entry = openClawRecoveryEntry({ operationId: "recover-rename-retired" });
  const context = openClawRecoveryContext(entry);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "applied");
  assert.equal(harness.state.patchCalls.length, 0);
  assert.equal(harness.state.runtimeConverged, 1);
  assert.equal(context.events.includes("committed"), true);
});

test("OpenClaw delete committing recovery 依 fresh source 存在性幂等重试条件删除", async () => {
  const harness = createModelChangeHarness({
    config: baseConfig({
      agents: {
        defaults: { models: { "alpha/old": { alias: "old" }, "beta/keep": { alias: "keep" } } },
        entries: { main: { models: { "alpha/old": { streaming: false } } } },
      },
    }),
  });
  const entry = openClawRecoveryEntry({
    operationId: "recover-delete-committing",
    kind: "delete-model",
    targetModelId: null,
  });
  const context = openClawRecoveryContext(entry);
  const result = await harness.adapter.recover(entry, context.value);
  assert.equal(result.status, "applied");
  assert.deepEqual(harness.state.config.models.providers.alpha.models, []);
  assert.deepEqual(harness.state.config.agents.defaults.models, { "beta/keep": { alias: "keep" } });
  assert.deepEqual(harness.state.config.agents.entries.main.models, {});
  assert.equal(harness.state.runtimeConverged, 1);
  assert.equal(context.events.includes("committed"), true);
});

test("OpenClaw delete recovery 在模型已退役但 settings tombstone 未收敛时继续清理", async () => {
  const harness = createModelChangeHarness({
    config: baseConfig({
      models: { providers: { alpha: { models: [] } } },
      agents: {
        defaults: { models: { "alpha/old": { alias: "stale" }, "beta/keep": { alias: "keep" } } },
        entries: { main: {} },
      },
    }),
  });
  const entry = openClawRecoveryEntry({
    operationId: "recover-delete-settings-only",
    kind: "delete-model",
    targetModelId: null,
  });
  const result = await harness.adapter.recover(entry, openClawRecoveryContext(entry).value);
  assert.equal(result.status, "applied");
  assert.deepEqual(harness.state.config.agents.defaults.models, { "beta/keep": { alias: "keep" } });
  assert.equal(harness.state.patchCalls.length, 1);
  assert.equal(Object.hasOwn(JSON.parse(harness.state.patchCalls[0].raw), "models"), false);
});

test("OpenClaw Provider 更新恢复只在 fresh 摘要命中 after 时声明 applied", async () => {
  const harness = createModelChangeHarness();
  const spec = { kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "https://new.example/v1" } };
  const preview = await harness.adapter.preview(spec);
  const beforeEntry = openClawRecoveryEntry({
    operationId: "recover-provider-before",
    kind: "update-provider",
    commitState: "precommit",
    sourceModelId: null,
    targetModelId: null,
  });
  beforeEntry.providerDiff = preview.providerDiff;
  const before = await harness.adapter.recover(beforeEntry, openClawRecoveryContext(beforeEntry).value);
  assert.equal(before.status, "needs_secret");
  assert.equal(before.code, "recovery_input_required");

  harness.state.config.models.providers.alpha.baseUrl = "https://new.example/v1";
  const afterEntry = { ...beforeEntry, operationId: "recover-provider-after" };
  const afterContext = openClawRecoveryContext(afterEntry);
  const after = await harness.adapter.recover(afterEntry, afterContext.value);
  assert.equal(after.status, "applied");
  assert.equal(afterContext.events.includes("committed"), true);
  assert.equal(JSON.stringify(afterEntry).includes("new.example"), false);
});

/** 顺序执行并保留每个失败的完整证据。 */
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
