#!/usr/bin/env node
"use strict";

// Hermes config-only 写路线回归：全部 HTTP 指向本地假 dashboard，绝不读写真实 ~/.hermes。
// 假 dashboard 模拟真实线上旧版行为：响应不带 ETag / x-hermes-conditional-write 头。

const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { HermesBackend } = require("../app/core/hermes-backend");

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

async function startFakeDashboard(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// 内存态假 dashboard：GET /api/config 回 providers；PUT /api/config 记录请求并按
// 官方 _deep_merge 语义并入（dict 递归、list/标量/null 直接替换、null 不删键）。
// 可选 pool/env 状态模拟凭证池与 .env 端点（poolOnly provider 清凭证链路用）。
function fakeDashboardState(initialProviders = {}, { pool = {}, env = {} } = {}) {
  const state = {
    providers: structuredClone(initialProviders),
    puts: [], // { body, headers }
    pool: structuredClone(pool), // { providerId: [{index,label,source,...}] }
    env: structuredClone(env), // { KEY: {is_set, category, is_password, provider?} }
    poolDeletes: [], // "providerId/index"
    envDeletes: [], // key
  };
  const deepMerge = (base, override) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] =
        out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) &&
        v && typeof v === "object" && !Array.isArray(v)
          ? deepMerge(out[k], v)
          : v;
    }
    return out;
  };
  const handler = (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/api/config")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ providers: state.providers }));
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/api/credentials/pool")) {
        // 真机 dashboard 恒有凭证池端点；删除 provider 的清池步骤要求它可读。
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          providers: Object.entries(state.pool).map(([provider, entries]) => ({ provider, entries })),
        }));
        return;
      }
      if (req.method === "DELETE" && req.url.startsWith("/api/credentials/pool/")) {
        const [, , , , providerId, indexRaw] = req.url.split("/");
        const index = Number(indexRaw);
        const entries = state.pool[decodeURIComponent(providerId)] || [];
        state.poolDeletes.push(`${decodeURIComponent(providerId)}/${index}`);
        if (index < 1 || index > entries.length) {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        entries.splice(index - 1, 1);
        entries.forEach((e, i) => { e.index = i + 1; });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/api/env")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(state.env));
        return;
      }
      if (req.method === "DELETE" && req.url.startsWith("/api/env")) {
        const body = JSON.parse(raw || "{}");
        state.envDeletes.push(body.key);
        if (state.env[body.key]) delete state.env[body.key];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "PUT" && req.url.startsWith("/api/config")) {
        const body = JSON.parse(raw || "{}");
        state.puts.push({ body, headers: { ...req.headers } });
        state.providers = deepMerge(state.providers, body?.config?.providers || {});
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  };
  return { state, handler };
}

function backendFor(fixtures) {
  // fixtures: Map<profile, {baseUrl}>
  const backend = new HermesBackend();
  for (const [profile, f] of fixtures) {
    backend.dashboards.set(profile, { baseUrl: f.baseUrl, token: "fake" });
  }
  return backend;
}

test("unconditional put writes without If-Match against legacy dashboard", async () => {
  const { state, handler } = fakeDashboardState({
    alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }] },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    await backend._readProvidersByProfile({ fresh: true, requireComplete: true });
    const target = backend.dashboards.get("default");
    await backend._putProviderEntry(target, "alpha", { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }, { id: "m1" }] }, { conditional: false });
    assert.equal(state.puts.length, 1);
    assert.equal(state.puts[0].headers["if-match"], undefined);
    assert.deepEqual(state.puts[0].body.config.providers.alpha.models.map((m) => m.id), ["m0", "m1"]);
  } finally {
    await dash.close();
  }
});

test("conditional put still fails closed against legacy dashboard", async () => {
  const { handler } = fakeDashboardState({ alpha: { base_url: "http://127.0.0.1:9/v1", models: [] } });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    await backend._readProvidersByProfile({ fresh: true, requireComplete: true });
    const target = backend.dashboards.get("default");
    await assert.rejects(
      () => backend._putProviderEntry(target, "alpha", { base_url: "http://127.0.0.1:9/v1", models: [] }),
      (err) => err?.code === "hermes_conditional_write_unsupported",
    );
  } finally {
    await dash.close();
  }
});

test("config write capabilities: no dashboard -> unsupported", async () => {
  const backend = new HermesBackend();
  const caps = await backend.getModelConfigWriteCapabilities();
  assert.equal(caps.supported, false);
  assert.deepEqual(caps.blockers, ["no_dashboard"]);
});

test("config write capabilities: dashboards present -> supported, activation null, bypass map", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("default", { baseUrl: "http://127.0.0.1:9", token: "fake" });
  const caps = await backend.getModelConfigWriteCapabilities();
  assert.equal(caps.supported, true);
  assert.equal(caps.create, true);
  assert.equal(caps.update, true);
  assert.equal(caps.delete, true);
  assert.equal(caps.updateProvider, true);
  assert.equal(caps.activation, null);
  assert.equal(caps.renameCatalogModel, undefined);
  assert.equal(caps.renameProvider, undefined);
  assert.equal(caps.batch, undefined);
  assert.deepEqual(caps.bypassBlockerCodes["*"], ["hermes_conditional_write_unsupported"]);
  assert.ok(caps.bypassBlockerCodes.create.includes("session_enumeration_incomplete"));
  assert.ok(!("delete-model" in caps.bypassBlockerCodes));
  assert.ok(caps.bypassBlockerCodes["delete-model:forced"].includes("references_exist"));
  assert.ok(caps.bypassBlockerCodes["delete-model:forced"].includes("session_model_reference"));
});

function opContext(id) {
  return { operationId: id };
}

test("config-only create writes array models without If-Match; result applied", async () => {
  const { state, handler } = fakeDashboardState({
    alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }] },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    const result = await backend.applyModelChangeConfigOnly(
      { kind: "create", providerKey: "alpha", model: { id: "m1", contextWindow: 128000 } },
      opContext("op-create-1"),
      null,
    );
    assert.deepEqual(result, { status: "applied", stage: "config-write" });
    assert.equal(state.puts.length, 1);
    assert.equal(state.puts[0].headers["if-match"], undefined);
    const written = state.puts[0].body.config.providers.alpha;
    assert.ok(Array.isArray(written.models));
    assert.deepEqual(written.models.map((m) => m.id).sort(), ["m0", "m1"]);
    assert.equal(written.models.find((m) => m.id === "m1").context_length, 128000);
  } finally {
    await dash.close();
  }
});

test("config-only delete-model rewrites full models array; replay idempotent", async () => {
  const { state, handler } = fakeDashboardState({
    alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }, { id: "m1" }] },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    const spec = { kind: "delete-model", providerKey: "alpha", sourceModelId: "m0" };
    const result = await backend.applyModelChangeConfigOnly(spec, opContext("op-del-1"), null);
    assert.equal(result.status, "applied");
    assert.deepEqual(state.puts[0].body.config.providers.alpha.models.map((m) => m.id), ["m1"]);
    // 重放（如 partial 后续提）：目标已不在任何 profile → 幂等 applied，不报"不存在"。
    const replay = await backend.applyModelChangeConfigOnly(spec, opContext("op-del-1"), null);
    assert.equal(replay.status, "applied");
  } finally {
    await dash.close();
  }
});

test("config-only delete-provider nulls the key; replay idempotent", async () => {
  const { state, handler } = fakeDashboardState({
    alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }] },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    const spec = { kind: "delete-provider", providerKey: "alpha" };
    const result = await backend.applyModelChangeConfigOnly(spec, opContext("op-delp-1"), null);
    assert.equal(result.status, "applied");
    assert.equal(state.puts[0].body.config.providers.alpha, null);
    const replay = await backend.applyModelChangeConfigOnly(spec, opContext("op-delp-1"), null);
    assert.equal(replay.status, "applied");
  } finally {
    await dash.close();
  }
});

test("config-only update-provider merges endpoint fields + secret; renameTo rejected", async () => {
  const { state, handler } = fakeDashboardState({
    alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }] },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    const result = await backend.applyModelChangeConfigOnly(
      { kind: "update-provider", providerKey: "alpha", patch: { baseUrl: "http://127.0.0.1:9/v2" } },
      opContext("op-up-1"),
      { apiKey: "sk-fake-123" },
    );
    assert.equal(result.status, "applied");
    assert.equal(state.puts[0].body.config.providers.alpha.base_url, "http://127.0.0.1:9/v2");
    assert.equal(state.puts[0].body.config.providers.alpha.api_key, "sk-fake-123");
    await assert.rejects(
      () => backend.applyModelChangeConfigOnly(
        { kind: "update-provider", providerKey: "alpha", patch: { renameTo: "beta" } },
        opContext("op-up-2"),
        null,
      ),
      (err) => err?.code === "config_only_kind_unsupported",
    );
  } finally {
    await dash.close();
  }
});

test("config-only partial: one profile fails -> partial retryable, replay converges", async () => {
  const good = fakeDashboardState({ alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }] } });
  let failNext = true;
  const bad = fakeDashboardState({ alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m0" }] } });
  const badHandler = (req, res) => {
    if (req.method === "PUT" && failNext) {
      failNext = false;
      res.statusCode = 500;
      res.end("{}");
      return;
    }
    bad.handler(req, res);
  };
  const dashGood = await startFakeDashboard(good.handler);
  const dashBad = await startFakeDashboard(badHandler);
  try {
    const backend = backendFor(new Map([["p1", dashGood], ["p2", dashBad]]));
    const spec = { kind: "create", providerKey: "alpha", model: { id: "m1" } };
    const first = await backend.applyModelChangeConfigOnly(spec, opContext("op-partial-1"), null);
    assert.equal(first.status, "partial");
    assert.equal(first.retryable, true);
    assert.equal(first.code, "hermes_partial_profiles");
    const second = await backend.applyModelChangeConfigOnly(spec, opContext("op-partial-1"), null);
    assert.equal(second.status, "applied");
    assert.deepEqual(bad.state.providers.alpha.models.map((m) => m.id).sort(), ["m0", "m1"]);
    assert.deepEqual(good.state.providers.alpha.models.map((m) => m.id).sort(), ["m0", "m1"]);
  } finally {
    await dashGood.close();
    await dashBad.close();
  }
});

test("config-only delete-provider on pool-only provider clears pool AND env var from entry source", async () => {
  // xiaomi 型：config 无该 provider；池条目 source=env:XIAOMI_API_KEY；
  // /api/env 里该变量无 provider 归属（真实 drift）→ 变量名只能从池 source 提取。
  const { state, handler } = fakeDashboardState({}, {
    pool: { xiaomi: [{ index: 1, label: "XIAOMI_API_KEY", source: "env:XIAOMI_API_KEY", auth_type: "api_key" }] },
    env: { XIAOMI_API_KEY: { is_set: true, category: "provider", is_password: true } },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    const result = await backend.applyModelChangeConfigOnly(
      { kind: "delete-provider", providerKey: "xiaomi" },
      opContext("op-pool-del-1"),
      null,
    );
    assert.equal(result.status, "applied");
    assert.deepEqual(state.poolDeletes, ["xiaomi/1"]);
    assert.deepEqual(state.envDeletes, ["XIAOMI_API_KEY"]);
    assert.deepEqual(state.pool.xiaomi, []);
    // 重放（池已空、env 已删）→ 幂等 applied，不报「没有可清除的凭证」。
    const replay = await backend.applyModelChangeConfigOnly(
      { kind: "delete-provider", providerKey: "xiaomi" },
      opContext("op-pool-del-1"),
      null,
    );
    assert.equal(replay.status, "applied");
  } finally {
    await dash.close();
  }
});

test("removeProviderCredential cascades env var delete for env-sourced entries", async () => {
  const { state, handler } = fakeDashboardState({}, {
    pool: { xiaomi: [{ index: 1, label: "XIAOMI_API_KEY", source: "env:XIAOMI_API_KEY", auth_type: "api_key" }] },
    env: { XIAOMI_API_KEY: { is_set: true, category: "provider", is_password: true } },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    const result = await backend.removeProviderCredential("xiaomi", 1);
    assert.equal(result.ok, true);
    assert.deepEqual(state.poolDeletes, ["xiaomi/1"]);
    // 不删 .env 变量的话 dashboard load_pool 会立刻回种同一条目（现象2根因）。
    assert.deepEqual(state.envDeletes, ["XIAOMI_API_KEY"]);
  } finally {
    await dash.close();
  }
});

test("config-only recover: written -> applied; missing -> failed retryable; ghost provider delete -> applied", async () => {
  const { handler } = fakeDashboardState({
    alpha: { base_url: "http://127.0.0.1:9/v1", models: [{ id: "m1" }] },
  });
  const dash = await startFakeDashboard(handler);
  try {
    const backend = backendFor(new Map([["default", dash]]));
    const written = await backend.recoverModelChangeConfigOnly({
      kind: "create", providerKey: "alpha", target: { provider: "alpha", modelId: "m1" },
    });
    assert.deepEqual(written, { status: "applied", stage: "recovery" });
    const missing = await backend.recoverModelChangeConfigOnly({
      kind: "create", providerKey: "alpha", target: { provider: "alpha", modelId: "m9" },
    });
    assert.equal(missing.status, "failed");
    assert.equal(missing.code, "config_write_not_applied");
    assert.equal(missing.retryable, true);
    const deleted = await backend.recoverModelChangeConfigOnly({
      kind: "delete-provider", providerKey: "ghost",
    });
    assert.deepEqual(deleted, { status: "applied", stage: "recovery" });
    const pendingDelete = await backend.recoverModelChangeConfigOnly({
      kind: "delete-model", providerKey: "alpha", source: { provider: "alpha", modelId: "m1" },
    });
    assert.equal(pendingDelete.status, "failed");
    const updateProvider = await backend.recoverModelChangeConfigOnly({
      kind: "update-provider", providerKey: "alpha", target: { provider: "alpha" },
    });
    assert.equal(updateProvider.status, "failed");
    assert.equal(updateProvider.retryable, true);
  } finally {
    await dash.close();
  }
});

test("config-only recover: unreadable config -> partial retryable", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("default", { baseUrl: "http://127.0.0.1:9", token: "fake" });
  const result = await backend.recoverModelChangeConfigOnly({
    kind: "create", providerKey: "alpha", target: { provider: "alpha", modelId: "m1" },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.code, "recovery_config_unreadable");
  assert.equal(result.retryable, true);
});

async function main() {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ❌ ${name}`);
      console.error(err);
    }
  }
  console.log(failed === 0 ? "hermes-config-only-regression: ALL PASS" : `hermes-config-only-regression: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
