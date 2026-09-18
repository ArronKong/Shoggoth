#!/usr/bin/env node
"use strict";

// 模型后端 URL 与 REST 契约的定向回归。所有后端 I/O 都通过方法注入替换，
// 静态服务器也只使用内存 fake registry，绝不触碰真实用户配置。

const assert = require("node:assert/strict");
const http = require("node:http");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { ModelChangeError } = require("../app/core/model-change-validation");
const { ModelChangeJournalError } = require("../app/core/model-change-journal");

let modelValidation;
let modelValidationLoadError;
try {
  modelValidation = require("../app/core/model-validation");
} catch (err) {
  // RED 阶段允许目标模块尚不存在；把加载错误纳入断言，继续执行其余行为回归。
  modelValidationLoadError = err;
  modelValidation = {};
}

let workAdmission;
let workAdmissionLoadError;
try {
  workAdmission = require("../app/core/work-admission-gate");
} catch (err) {
  // RED 阶段允许 gate 尚未实现；加载失败作为独立断言输出，不遮蔽其它 API 回归。
  workAdmissionLoadError = err;
  workAdmission = {};
}

const tests = [];

// 注册独立用例，末尾顺序执行并汇总失败，避免第一个 RED 掩盖其它契约缺口。
function test(name, run) {
  tests.push({ name, run });
}

// 发起 loopback JSON 请求，专用于 fake registry 的静态服务器契约测试。
function requestJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": payload.length,
            }
          : undefined,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let body = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            // 非 JSON 响应由具体断言报告，辅助函数不吞掉原始响应文本。
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 启动仅监听 loopback 的假 Hermes dashboard，真实穿过 backend HTTP 读取路径。
async function startFakeHermesDashboard(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// 写出 JSON 假响应，避免测试夹具重复响应头和序列化逻辑。
function sendFakeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// 校验参数错误 REST 响应既是 400，也不会把请求中的 URL 凭证反射给调用方。
function assertSafeBadRequest(response, secretUrl, username, password) {
  assert.equal(response.status, 400);
  const message = String(response.body?.error || "");
  assert.match(message, /baseUrl|HTTP/i);
  assert.equal(message.includes(secretUrl), false);
  assert.equal(message.includes(username), false);
  assert.equal(message.includes(password), false);
}

test("URL utility 导出严格判断与断言函数", () => {
  assert.ifError(modelValidationLoadError);
  assert.equal(typeof modelValidation.isHttpUrl, "function");
  assert.equal(typeof modelValidation.assertHttpUrl, "function");
  assert.equal(typeof modelValidation.normalizeOptionalString, "function");
  assert.equal(typeof modelValidation.ModelValidationError, "function");
});

test("work admission drain 等待已有入口退出，且并发 token 全释放后才重开", async () => {
  assert.ifError(workAdmissionLoadError);
  assert.equal(typeof workAdmission.createWorkAdmissionGate, "function");
  const gate = workAdmission.createWorkAdmissionGate();
  const leave = gate.enter("openclaw", "chat.send");
  const firstDrain = gate.beginDrain("openclaw", "model-apply-one");
  const secondDrain = gate.beginDrain("openclaw", "model-apply-two");

  assert.throws(
    () => gate.enter("openclaw", "cron.run"),
    (error) => error?.code === "gateway_draining" && error?.status === 409,
  );
  assert.equal(await firstDrain.waitForIdle(10), false);
  leave();
  leave(); // leave 必须幂等，不能把 active 计数减成负数。
  assert.equal(await firstDrain.waitForIdle(100), true);
  assert.deepEqual(gate.snapshot("openclaw"), {
    backendId: "openclaw",
    activeAdmissions: 0,
    draining: true,
    drainCount: 2,
    reasons: ["model-apply-one", "model-apply-two"],
  });

  firstDrain.release();
  assert.throws(() => gate.enter("openclaw", "agent"), (error) => error?.code === "gateway_draining");
  secondDrain.release();
  const resumedLeave = gate.enter("openclaw", "agent");
  resumedLeave();
  firstDrain.release(); // release 同样必须幂等。
  assert.equal(gate.snapshot("openclaw").draining, false);
});

test("optional string helper 保留字符串兼容并拒绝数组或对象强转", () => {
  const { ModelValidationError: ErrorType, normalizeOptionalString } = modelValidation;
  assert.equal(typeof normalizeOptionalString, "function");
  assert.equal(normalizeOptionalString(undefined, "baseUrl"), "");
  assert.equal(normalizeOptionalString(null, "baseUrl"), "");
  assert.equal(normalizeOptionalString("", "baseUrl"), "");
  assert.equal(normalizeOptionalString("  https://api.example.com/v1  ", "baseUrl"), "https://api.example.com/v1");
  for (const value of [["https://array.example/v1"], { url: "https://object.example/v1" }]) {
    assert.throws(
      () => normalizeOptionalString(value, "baseUrl"),
      (err) => {
        assert.equal(err instanceof ErrorType, true);
        assert.equal(err?.code, "ERR_INVALID_MODEL_URL");
        assert.match(String(err?.message || err), /baseUrl|字符串/i);
        return true;
      },
    );
  }
});

test("URL utility 只接受带 hostname 的 HTTP(S) URL", () => {
  const { isHttpUrl } = modelValidation;
  assert.equal(typeof isHttpUrl, "function");
  for (const value of [
    "http://localhost:11434/v1",
    "https://api.example.com/v1?region=cn",
    "https://127.0.0.1:9443",
  ]) {
    assert.equal(isHttpUrl(value), true, `应接受 ${value}`);
  }
  for (const value of [
    "",
    "api.example.com/v1",
    "ftp://api.example.com/v1",
    "file:///tmp/model.sock",
    "javascript:alert(1)",
    "https://",
    "/relative/path",
    null,
  ]) {
    assert.equal(isHttpUrl(value), false, `应拒绝 ${String(value)}`);
  }
});

test("URL assertion 的错误不回显可能包含凭证的完整 URL", () => {
  const { assertHttpUrl } = modelValidation;
  const ErrorType = modelValidation.ModelValidationError;
  assert.equal(typeof assertHttpUrl, "function");
  assert.equal(typeof ErrorType, "function");
  const secretUrl = "ftp://model-user:super-secret@example.com/v1";
  assert.throws(
    () => assertHttpUrl(secretUrl, "baseUrl"),
    (err) => {
      const message = String(err?.message || err);
      assert.equal(err instanceof ErrorType, true);
      assert.equal(err?.code, "ERR_INVALID_MODEL_URL");
      assert.match(message, /baseUrl|HTTP/i);
      assert.equal(message.includes(secretUrl), false);
      assert.equal(message.includes("model-user"), false);
      assert.equal(message.includes("super-secret"), false);
      return true;
    },
  );
});

test("OpenClaw legacy 模型写入口全部要求 coordinator 且配置零读写", async () => {
  const backend = new OpenClawBackend();
  let patchCalls = 0;
  backend._patchModelProviders = async () => {
    patchCalls += 1;
    throw new Error("不应进入配置读取/patch");
  };

  const operations = [
    () => backend.addModelConfig({ providerKey: "custom", model: { id: "new-model" } }),
    () => backend.updateModelProvider("custom", { baseUrl: "https://new.example" }),
    () => backend.removeModelConfig({ providerKey: "custom", modelId: "old-model" }),
    () => backend.removeModelProvider("custom"),
  ];
  for (const operation of operations) {
    await assert.rejects(
      operation,
      (error) => error?.code === "model_change_coordinator_required" && error?.status === 409,
    );
  }
  assert.equal(patchCalls, 0);
});

test("Hermes add 非法显式 baseUrl 在任何配置读写前拒绝", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("default", { baseUrl: "http://fake.invalid", token: "fake" });
  let readCalls = 0;
  let writeCalls = 0;
  backend._readProvidersByProfile = async () => {
    readCalls += 1;
    return new Map();
  };
  backend._putProviderEntry = async () => {
    writeCalls += 1;
  };

  await assert.rejects(
    backend._withModelChangeCoordinatorContext("api-invalid-add", () => (
      backend.addModelConfig({
        providerKey: "custom",
        baseUrl: "file:///tmp/model.sock",
        model: { id: "new-model" },
      })
    )),
    /baseUrl|HTTP/i,
  );
  assert.equal(readCalls, 0);
  assert.equal(writeCalls, 0);
});

test("Hermes update 非法 baseUrl 在任何配置读写前拒绝", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("default", { baseUrl: "http://fake.invalid", token: "fake" });
  let readCalls = 0;
  let writeCalls = 0;
  backend._readProvidersByProfile = async () => {
    readCalls += 1;
    return new Map();
  };
  backend._putProviderEntry = async () => {
    writeCalls += 1;
  };

  await assert.rejects(
    backend._withModelChangeCoordinatorContext("api-invalid-update", () => (
      backend.updateModelProvider("custom", {
        baseUrl: "ssh://example.com/model",
        api: "openai-completions",
      })
    )),
    /baseUrl|HTTP/i,
  );
  assert.equal(readCalls, 0);
  assert.equal(writeCalls, 0);
});

test("Hermes 已有 provider 不传 baseUrl 时仍可只新增模型", async () => {
  const backend = new HermesBackend();
  const dash = { baseUrl: "http://fake.invalid", token: "fake" };
  backend.dashboards.set("default", dash);
  backend._readProvidersByProfile = async () =>
    new Map([
      [
        "default",
        {
          custom: {
            base_url: "legacy-endpoint",
            models: { "old-model": {} },
          },
        },
      ],
    ]);
  const writes = [];
  backend._putProviderEntry = async (...args) => {
    writes.push(args);
  };

  await backend._withModelChangeCoordinatorContext("api-add-existing", () => (
    backend.addModelConfig({
      providerKey: "custom",
      model: { id: "new-model" },
    })
  ));
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], dash);
  assert.equal(writes[0][1], "custom");
  assert.equal(writes[0][2].base_url, "legacy-endpoint");
  assert.deepEqual(
    writes[0][2].models.map((model) => model.id),
    ["old-model", "new-model"],
  );
});

test("OpenClaw fresh 双来源只读一次配置与原始目录，并保留配置-only 字段", async () => {
  const backend = new OpenClawBackend();
  let configReads = 0;
  let runtimeReads = 0;
  backend._configSnapshot = async () => {
    configReads += 1;
    return {
      hash: "fake-hash",
      parsed: {
        models: {
          providers: {
            alpha: {
              baseUrl: "https://config-user:config-password@example.invalid/v1",
              apiKey: "config-secret",
              models: [
                {
                  id: "kept",
                  name: "Configured Kept",
                  contextWindow: 8192,
                  maxTokens: 1024,
                  reasoning: true,
                },
                { id: "config-only", maxTokens: 512 },
              ],
            },
          },
        },
      },
    };
  };
  backend.request = async (method) => {
    assert.equal(method, "models.list");
    runtimeReads += 1;
    return {
      models: [
        { id: "stale", name: "Stale", provider: "alpha" },
        { id: "kept", name: "Runtime Kept", provider: "alpha", contextWindow: 4096 },
        { id: "builtin", name: "Builtin", provider: "beta" },
      ],
    };
  };

  const sources = await backend.getModelCatalogSources({ fresh: true });
  assert.equal(configReads, 1);
  assert.equal(runtimeReads, 1);
  assert.deepEqual(sources.models.map(({ id }) => id), ["kept", "config-only", "builtin"]);
  assert.deepEqual(
    sources.models.filter(({ provider }) => provider === "alpha").map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    })),
    [
      { id: "kept", name: "Configured Kept", contextWindow: 8192, maxTokens: 1024, reasoning: true },
      { id: "config-only", name: "config-only", contextWindow: undefined, maxTokens: 512, reasoning: false },
    ],
  );
  assert.deepEqual(sources.runtime.map(({ id }) => id), ["stale", "kept", "builtin"]);
  assert.deepEqual(
    sources.config.map(({ id, provider, contextWindow, maxTokens, reasoning }) => ({
      id,
      provider,
      contextWindow,
      maxTokens,
      reasoning,
    })),
    [
      {
        id: "kept",
        provider: "alpha",
        contextWindow: 8192,
        maxTokens: 1024,
        reasoning: true,
      },
      {
        id: "config-only",
        provider: "alpha",
        contextWindow: undefined,
        maxTokens: 512,
        reasoning: false,
      },
    ],
  );
  const serialized = JSON.stringify(sources);
  assert.equal(serialized.includes("config-secret"), false);
  assert.equal(serialized.includes("config-user"), false);
  assert.equal(serialized.includes("config-password"), false);
  assert.equal(serialized.includes("baseUrl"), false);
  assert.match(sources.config[0].providerConfigDigest, /^[0-9a-f]{64}$/);
  assert.equal(sources.config[0].providerConfigDigest, sources.config[1].providerConfigDigest);
  const changedEndpoint = backend._modelConfigRowsFromParsed({
    models: { providers: { alpha: { baseUrl: "https://changed.example/v1", models: [{ id: "kept" }] } } },
  });
  assert.notEqual(changedEndpoint[0].providerConfigDigest, sources.config[0].providerConfigDigest);
  assert.equal(JSON.stringify(changedEndpoint).includes("changed.example"), false);

  const emptyConfiguredProvider = backend._mergeConfiguredModels(
    [{ id: "runtime-ghost", name: "Ghost", provider: "alpha", backendId: "openclaw" }],
    { models: { providers: { alpha: { baseUrl: "https://api.example/v1", models: [] } } } },
  );
  assert.deepEqual(emptyConfiguredProvider, [], "配置中显式空 Provider 必须屏蔽运行时幽灵模型");
});

test("GET /__api/models fresh 返回稳定内容 revision，且配置或运行时变化会更新", async () => {
  const sourceCalls = [];
  const state = {
    models: [{ id: "known-model", name: "Known", provider: "alpha", backendId: "known" }],
    config: [
      {
        id: "known-model",
        name: "Configured Known",
        provider: "alpha",
        backendId: "known",
        maxTokens: 1024,
      },
    ],
    runtime: [
      {
        id: "known-model",
        name: "Runtime Known",
        provider: "alpha",
        backendId: "known",
        contextWindow: 8192,
      },
    ],
  };
  const backend = {
    id: "known",
    // 每次返回新的内存快照，模拟真实后端 fresh 双来源读取。
    async getModelCatalogSources(options) {
      sourceCalls.push(options);
      return {
        models: state.models.map((row) => ({ ...row })),
        config: state.config.map((row) => ({ ...row })),
        runtime: state.runtime.map((row) => ({ ...row })),
      };
    },
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  const server = await startStaticServer(0, { registry });
  try {
    const unknown = await requestJson("GET", `${server.url}/__api/models?backend=missing`);
    assert.equal(unknown.status, 404);
    assert.match(String(unknown.body?.error || ""), /unknown backend missing/i);
    assert.deepEqual(sourceCalls, []);

    const first = await requestJson("GET", `${server.url}/__api/models?backend=known`);
    const repeated = await requestJson("GET", `${server.url}/__api/models?backend=known`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.models, state.models);
    assert.match(String(first.body.catalogRevision || ""), /^[0-9a-f]{64}$/);
    assert.equal(repeated.body.catalogRevision, first.body.catalogRevision);

    state.config[0].maxTokens = 2048;
    const configChanged = await requestJson("GET", `${server.url}/__api/models?backend=known`);
    assert.notEqual(configChanged.body.catalogRevision, first.body.catalogRevision);

    state.runtime[0].contextWindow = 16384;
    const runtimeChanged = await requestJson("GET", `${server.url}/__api/models?backend=known`);
    assert.notEqual(runtimeChanged.body.catalogRevision, configChanged.body.catalogRevision);

    const aggregate = await requestJson("GET", `${server.url}/__api/models`);
    assert.equal(aggregate.status, 200);
    assert.deepEqual(aggregate.body.models, state.models);
    assert.match(String(aggregate.body.catalogRevision || ""), /^[0-9a-f]{64}$/);
    assert.notEqual(aggregate.body.catalogRevision, runtimeChanged.body.catalogRevision);

    const wrongMethod = await requestJson("POST", `${server.url}/__api/models?backend=missing`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(sourceCalls.length, 5);
    assert.equal(sourceCalls.every((options) => options?.fresh === true), true);
  } finally {
    await server.close();
  }
});

test("GET /__api/models 显式 disabled backend 返回 404 且不触达 sources", async () => {
  let sourceCalls = 0;
  const backend = {
    id: "disabled",
    name: "Disabled",
    getBackendDescriptor() { return { id: "disabled", name: "Disabled", disconnectable: true }; },
    async getModelCatalogSources() {
      sourceCalls += 1;
      return { models: [], config: [], runtime: [] };
    },
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  registry.setDisabledBackendsProvider(() => ["disabled"]);
  const server = await startStaticServer(0, { registry });
  try {
    await assert.rejects(
      registry.listModelsSnapshot("disabled", { fresh: true }),
      (error) => error?.statusCode === 404 && error?.code === "ERR_UNKNOWN_BACKEND",
    );
    const response = await requestJson("GET", `${server.url}/__api/models?backend=disabled`);

    assert.equal(response.status, 404);
    assert.match(String(response.body?.error || ""), /unknown backend disabled/i);
    assert.equal(sourceCalls, 0);
  } finally {
    await server.close();
  }
});

test("models capability 只读且 knownRevision 每次 fresh 校验后才返回 unchanged", async () => {
  let sourceCalls = 0;
  let capabilityCalls = 0;
  const backend = {
    id: "conditional",
    async getModelCatalogSources(options) {
      sourceCalls += 1;
      assert.equal(options?.fresh, true);
      return {
        models: [{ id: "m", name: "M", provider: "alpha", backendId: "conditional" }],
        config: [{ providerKey: "alpha", model: { id: "m" } }],
        runtime: [{ id: "m", provider: "alpha" }],
      };
    },
    async getModelChangeCapabilities() {
      capabilityCalls += 1;
      return { supported: true, create: true, update: true, rename: false, delete: true };
    },
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  const server = await startStaticServer(0, { registry });
  try {
    const first = await requestJson("GET", `${server.url}/__api/models?backend=conditional`);
    assert.equal(first.status, 200);
    assert.equal(first.body.unchanged, false);
    assert.equal(first.body.models.length, 1);

    const same = await requestJson(
      "GET",
      `${server.url}/__api/models?backend=conditional&knownRevision=${first.body.catalogRevision}`,
    );
    assert.deepEqual(same.body, { catalogRevision: first.body.catalogRevision, unchanged: true });
    assert.equal(sourceCalls, 2);

    const forged = await requestJson(
      "GET",
      `${server.url}/__api/models?backend=conditional&knownRevision=not-a-revision`,
    );
    assert.equal(forged.body.unchanged, false);
    assert.equal(forged.body.models.length, 1);
    assert.equal(sourceCalls, 3);

    const capability = await requestJson(
      "GET",
      `${server.url}/__api/models/config/capabilities?backend=conditional`,
    );
    assert.equal(capability.status, 200);
    assert.equal(capability.body.supported, true);
    assert.equal(capabilityCalls, 1);
    assert.equal(sourceCalls, 3);

    const missing = await requestJson(
      "GET",
      `${server.url}/__api/models/config/capabilities?backend=missing`,
    );
    assert.equal(missing.status, 404);
    assert.equal(capabilityCalls, 1);
  } finally {
    await server.close();
  }
});

test("GET /__api/models 将 Hermes strict profile 失败安全映射为稳定 503 且不提交部分缓存", async () => {
  const fake = await startFakeHermesDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendFakeJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendFakeJson(res, 503, { error: "profile unavailable" });
      return;
    }
    sendFakeJson(res, 404, {});
  });
  const backend = new HermesBackend();
  backend.dashboards.set("broken", { baseUrl: fake.baseUrl, token: "fake" });
  const warmChoices = [{ id: "warm", name: "warm", provider: "alpha" }];
  const warmMeta = new Map([[JSON.stringify(["alpha", "warm"]), { reasoning: true }]]);
  const warmByProfile = new Map([["broken", ["warm"]]]);
  const warmIdentities = new Map([["broken", new Set([JSON.stringify(["alpha", "warm"])])]]);
  backend.modelChoices = warmChoices;
  backend.modelMeta = warmMeta;
  backend.modelsByProfile = warmByProfile;
  backend.modelsByProfileIdentity = warmIdentities;

  const registry = new BackendRegistry();
  registry.register(backend);
  const server = await startStaticServer(0, { registry });
  try {
    const response = await requestJson("GET", `${server.url}/__api/models?backend=hermes`);

    assert.equal(response.status, 503);
    assert.equal(response.body?.code, "ERR_HERMES_CATALOG_UNAVAILABLE");
    assert.match(String(response.body?.error || ""), /运行时目录读取不完整.*broken/);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body, "models"), false);
    assert.equal(backend.modelChoices, warmChoices);
    assert.equal(backend.modelMeta, warmMeta);
    assert.equal(backend.modelsByProfile, warmByProfile);
    assert.equal(backend.modelsByProfileIdentity, warmIdentities);
  } finally {
    await Promise.all([server.close(), fake.close()]);
  }
});

test("REST 不接受任意 error.statusCode 注入响应状态或公开 code", async () => {
  const backend = {
    id: "untrusted",
    async getModelCatalogSources() {
      const error = new Error("untrusted status");
      // 即使伪造稳定 code/status，普通 Error 也不能冒充 Hermes 的受信错误类型。
      error.code = "ERR_HERMES_CATALOG_UNAVAILABLE";
      error.statusCode = 503;
      throw error;
    },
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  const server = await startStaticServer(0, { registry });
  try {
    const response = await requestJson("GET", `${server.url}/__api/models?backend=untrusted`);

    assert.equal(response.status, 500);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body, "code"), false);
  } finally {
    await server.close();
  }
});

test("聚合模型快照稳定排序并跳过失败后端，显式后端失败不伪装空成功", async () => {
  let successfulCalls = 0;
  const rows = [
    { id: "b", name: "B", provider: "beta", backendId: "good" },
    { id: "a", name: "A", provider: "alpha", backendId: "good" },
  ];
  const good = {
    id: "good",
    async getModelCatalogSources() {
      successfulCalls += 1;
      const ordered = successfulCalls % 2 === 1 ? rows : [...rows].reverse();
      return {
        models: ordered.map((row) => ({ ...row })),
        config: ordered.map((row) => ({ ...row })),
        runtime: ordered.map((row) => ({ ...row })),
      };
    },
  };
  const failed = {
    id: "failed",
    async getModelCatalogSources() {
      throw new Error("catalog unavailable");
    },
  };
  const registry = new BackendRegistry();
  registry.register(good);
  registry.register(failed);
  const server = await startStaticServer(0, { registry });
  try {
    const first = await requestJson("GET", `${server.url}/__api/models`);
    const repeated = await requestJson("GET", `${server.url}/__api/models`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.models.map(({ id }) => id), ["a", "b"]);
    assert.deepEqual(repeated.body.models, first.body.models);
    assert.equal(repeated.body.catalogRevision, first.body.catalogRevision);

    const explicitFailure = await requestJson(
      "GET",
      `${server.url}/__api/models?backend=failed`,
    );
    assert.equal(explicitFailure.status, 500);
    assert.equal(Object.prototype.hasOwnProperty.call(explicitFailure.body, "models"), false);
    assert.match(String(explicitFailure.body?.error || ""), /catalog unavailable/);
  } finally {
    await server.close();
  }
});

test("models/config 新旧写路由全部进入 ready coordinator，blocked 删除映射 409", async () => {
  const bareWrites = { add: 0, update: 0, removeModel: 0, removeProvider: 0 };
  const backend = {
    id: "openclaw",
    async getModelConfig() { return { providers: [] }; },
    async addModelConfig() { bareWrites.add += 1; },
    async updateModelProvider() { bareWrites.update += 1; },
    async removeModelConfig() { bareWrites.removeModel += 1; },
    async removeModelProvider() { bareWrites.removeProvider += 1; },
  };
  const calls = [];
  const final = {
    status: "applied",
    stage: "verify-ready",
    catalog: { models: [{ id: "applied", provider: "alpha", backendId: "openclaw" }], catalogRevision: "a".repeat(64) },
  };
  const coordinator = {
    isReady: () => true,
    requireReady() {},
    listPending(backendId) {
      return [{
        operationId: "pending-op",
        backendId,
        providerKey: "alpha",
        kind: "update-provider",
        status: "needs_secret",
        stage: "stage-target",
        source: null,
        target: { provider: "alpha" },
      }];
    },
    async preview(backendId, spec) {
      calls.push({ method: "preview", backendId, spec });
      return {
        previewToken: "signed-preview",
        capabilities: { supported: true, create: true },
        references: [], blockers: [], runtimeApply: "hot", fingerprints: { config: "one" },
      };
    },
    async apply(backendId, spec, options) {
      calls.push({ method: "apply", backendId, spec, options });
      return final;
    },
    async applyCompat(backendId, spec, options) {
      calls.push({ method: "applyCompat", backendId, spec, options });
      return final;
    },
    async updateProviderCompat(backendId, providerKey, patch, options) {
      calls.push({ method: "updateProviderCompat", backendId, providerKey, patch, options });
      return final;
    },
    async deleteCompat(backendId, ref, options) {
      calls.push({ method: "deleteCompat", backendId, ref, options });
      if (ref.providerKey === "referenced") {
        return { status: "blocked", code: "references_exist", stage: "preflight", references: [{ store: "cron" }] };
      }
      return final;
    },
  };
  const registry = { backends: new Map([[backend.id, backend]]) };
  const server = await startStaticServer(0, { registry, modelChangeCoordinator: coordinator });
  try {
    const pending = await requestJson("GET", `${server.url}/__api/models/config/pending?backend=openclaw`);
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.body.operations.map((entry) => entry.operationId), ["pending-op"]);

    const preview = await requestJson("POST", `${server.url}/__api/models/config/preview?backend=openclaw`, {
      providerKey: "alpha", model: { id: "new-model" },
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(Object.keys(preview.body).sort(), [
      "blockers", "capabilities", "fingerprints", "previewToken", "references", "runtimeApply",
    ]);

    const missing = await requestJson("PUT", `${server.url}/__api/models/config/model?backend=openclaw`, {
      providerKey: "alpha", model: { id: "new-model" },
    });
    assert.equal(missing.status, 400);
    assert.equal(calls.filter((call) => call.method === "apply").length, 0);

    const applied = await requestJson("PUT", `${server.url}/__api/models/config/model?backend=openclaw`, {
      providerKey: "alpha",
      model: { id: "new-model" },
      previewToken: "signed-preview",
      operationId: "operation-new-model",
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.catalog.catalogRevision, "a".repeat(64));

    assert.equal((await requestJson("POST", `${server.url}/__api/models/config?backend=openclaw`, {
      providerKey: "alpha", model: { id: "compat-model" }, operationId: "model-add-op",
    })).status, 200);
    assert.equal((await requestJson("PUT", `${server.url}/__api/models/config?backend=openclaw`, {
      providerKey: "alpha", baseUrl: "https://api.example.com/v2", operationId: "provider-put-op",
    })).status, 200);
    assert.equal((await requestJson("DELETE", `${server.url}/__api/models/config?backend=openclaw&provider=alpha&id=compat-model&operationId=model-delete-op`)).status, 200);
    assert.equal((await requestJson("DELETE", `${server.url}/__api/models/config?backend=openclaw&provider=alpha&operationId=provider-delete-op`)).status, 200);

    const referenced = await requestJson(
      "DELETE",
      `${server.url}/__api/models/config?backend=openclaw&provider=referenced&id=used-model`,
    );
    assert.equal(referenced.status, 409);
    assert.equal(referenced.body.code, "references_exist");
    assert.deepEqual(bareWrites, { add: 0, update: 0, removeModel: 0, removeProvider: 0 });
    assert.deepEqual(calls.map((call) => call.method), [
      "preview", "apply", "applyCompat", "updateProviderCompat", "deleteCompat", "deleteCompat", "deleteCompat",
    ]);
    const applyCall = calls.find((call) => call.method === "apply");
    assert.equal("previewToken" in applyCall.spec, false);
    assert.deepEqual(applyCall.options, { previewToken: "signed-preview", operationId: "operation-new-model" });
    const compatApplyCall = calls.find((call) => call.method === "applyCompat");
    assert.equal("operationId" in compatApplyCall.spec, false);
    assert.deepEqual(compatApplyCall.options, { operationId: "model-add-op" });
    assert.deepEqual(calls.find((call) => call.method === "updateProviderCompat").options, { operationId: "provider-put-op" });
    assert.deepEqual(calls.filter((call) => call.method === "deleteCompat").slice(0, 2).map((call) => call.options), [
      { operationId: "model-delete-op", force: false },
      { operationId: "provider-delete-op", force: false },
    ]);
    // force=1 透传为 deleteCompat 的 force:true（UI 确认框知情后带上）
    assert.equal((await requestJson(
      "DELETE",
      `${server.url}/__api/models/config?backend=openclaw&provider=alpha&id=compat-model&operationId=model-force-op&force=1`,
    )).status, 200);
    assert.deepEqual(calls.filter((call) => call.method === "deleteCompat").at(-1).options, {
      operationId: "model-force-op", force: true,
    });
  } finally {
    await server.close();
  }
});

test("models/config coordinator 缺失或恢复中时所有 mutation 返回 503，GET 仍可读", async () => {
  let bareWrites = 0;
  const backend = {
    id: "openclaw",
    async getModelConfig() { return { providers: [{ key: "readable" }] }; },
    async addModelConfig() { bareWrites += 1; },
    async updateModelProvider() { bareWrites += 1; },
    async removeModelConfig() { bareWrites += 1; },
    async removeModelProvider() { bareWrites += 1; },
  };
  const registry = { backends: new Map([[backend.id, backend]]) };
  const recovering = { isReady: () => false, requireReady() {
    throw new ModelChangeError("model_change_recovering", "恢复中", { stage: "recovery", status: 503 });
  } };
  for (const coordinator of [undefined, recovering]) {
    const server = await startStaticServer(0, { registry, modelChangeCoordinator: coordinator });
    try {
      const get = await requestJson("GET", `${server.url}/__api/models/config?backend=openclaw`);
      assert.equal(get.status, 200);
      assert.equal(get.body.providers[0].key, "readable");
      for (const [method, route, body] of [
        ["POST", "/__api/models/config?backend=openclaw", { providerKey: "alpha", model: { id: "m" } }],
        ["PUT", "/__api/models/config?backend=openclaw", { providerKey: "alpha", baseUrl: "https://api.example.com" }],
        ["DELETE", "/__api/models/config?backend=openclaw&provider=alpha&id=m", undefined],
        ["POST", "/__api/models/config/preview?backend=openclaw", { providerKey: "alpha", model: { id: "m" } }],
        ["PUT", "/__api/models/config/model?backend=openclaw", { providerKey: "alpha", model: { id: "m" }, previewToken: "p", operationId: "o" }],
      ]) {
        const response = await requestJson(method, `${server.url}${route}`, body);
        assert.equal(response.status, 503, `${method} ${route} 必须在恢复期返回 503`);
        assert.equal(response.body.code, "model_change_recovering");
      }
    } finally {
      await server.close();
    }
  }
  assert.equal(bareWrites, 0);
});

// R286：auxiliary 写不再挂 coordinator 条件写门——官方同款直写，授权由后端自守
// （Hermes 实现写；契约默认抛「不支持」→ 路由如实回 500）。profile 作用域必须透传。
test("Hermes auxiliary 路由直达后端并透传 profile；不支持的后端由契约默认拒绝", async () => {
  const calls = [];
  const backend = {
    id: "hermes",
    async getAuxiliaryModels(opts) { calls.push(["get", opts?.profile]); return { slots: [], main: {} }; },
    async setAuxiliaryModel(task, provider, model, opts) {
      calls.push(["set", task, provider, model, opts?.profile]);
      return { ok: true };
    },
  };
  const rejecting = {
    id: "openclaw",
    async getAuxiliaryModels() { return { slots: [], main: {} }; },
    async setAuxiliaryModel() { throw new Error("openclaw: setAuxiliaryModel() not supported"); },
  };
  const registry = { backends: new Map([[backend.id, backend], [rejecting.id, rejecting]]) };

  // 无 coordinator（恢复期）也不影响 auxiliary——它已不属于条件写域。
  const server = await startStaticServer(0, { registry });
  try {
    const get = await requestJson("GET", `${server.url}/__api/models/auxiliary?backend=hermes&profile=bull`);
    assert.equal(get.status, 200);
    const ok = await requestJson("POST", `${server.url}/__api/models/auxiliary?backend=hermes`, {
      task: "vision", provider: "alpha", model: "m", profile: "bull",
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true });
    const missingTask = await requestJson("POST", `${server.url}/__api/models/auxiliary?backend=hermes`, {
      provider: "alpha", model: "m",
    });
    assert.equal(missingTask.status, 400);
    const denied = await requestJson("POST", `${server.url}/__api/models/auxiliary?backend=openclaw`, {
      task: "vision", provider: "alpha", model: "m",
    });
    assert.equal(denied.status, 500);
    assert.match(denied.body.error, /not supported/);
    assert.deepEqual(calls, [["get", "bull"], ["set", "vision", "alpha", "m", "bull"]]);
  } finally {
    await server.close();
  }
});

test("models/config 只映射受信模型错误并白名单输出 details，普通异常保持 500", async () => {
  const secret = "top-secret-api-key";
  const coordinator = {
    isReady: () => true,
    requireReady() {},
    async preview(backendId) {
      if (backendId === "missing") {
        throw new ModelChangeError("unknown_backend", "未找到 backend", { stage: "validate", status: 404 });
      }
      throw new Error("backend unavailable");
    },
    async apply() {
      throw new ModelChangeJournalError("operation_reused", "operationId 已绑定不同请求", {
        stage: "journal",
        status: 409,
        details: { operations: [{ operationId: "safe-op", code: "operation_reused" }], apiKey: secret },
      });
    },
    async applyCompat() {
      throw new ModelChangeError("invalid_url", "baseUrl 必须是 HTTP(S) URL", {
        field: "baseUrl",
        stage: "validate",
        status: 400,
        details: { reason: "protocol", apiKey: secret },
      });
    },
  };
  const registry = { backends: new Map([["openclaw", { id: "openclaw", async getModelConfig() { return { providers: [] }; } }]]) };
  const server = await startStaticServer(0, { registry, modelChangeCoordinator: coordinator });
  try {
    const unknown = await requestJson("POST", `${server.url}/__api/models/config/preview?backend=missing`, {
      providerKey: "alpha", model: { id: "m" },
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: "未找到 backend", code: "unknown_backend", stage: "validate" });

    const reused = await requestJson("PUT", `${server.url}/__api/models/config/model?backend=openclaw`, {
      providerKey: "alpha", model: { id: "m" }, previewToken: "p", operationId: "same-op",
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.code, "operation_reused");
    assert.deepEqual(reused.body.details, { operations: [{ operationId: "safe-op", code: "operation_reused" }] });
    assert.equal(JSON.stringify(reused.body).includes(secret), false);

    const badUrl = await requestJson("POST", `${server.url}/__api/models/config?backend=openclaw`, {
      providerKey: "alpha", baseUrl: `ftp://user:${secret}@example.com`, apiKey: secret, model: { id: "m" },
    });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.body.field, "baseUrl");
    assert.deepEqual(badUrl.body.details, { reason: "protocol" });
    assert.equal(JSON.stringify(badUrl.body).includes(secret), false);

    const ordinary = await requestJson("POST", `${server.url}/__api/models/config/preview?backend=faulty`, {
      providerKey: "alpha", model: { id: "m" },
    });
    assert.equal(ordinary.status, 500);
    assert.equal(ordinary.body.error, "backend unavailable");
    assert.equal("code" in ordinary.body, false);
  } finally {
    await server.close();
  }
});

test("OpenClaw drain 拒绝 Cron 与 Workboard 启动动作，Hermes 和只读请求不受影响", async () => {
  assert.ifError(workAdmissionLoadError);
  const gate = workAdmission.createWorkAdmissionGate();
  const calls = [];
  const createBackend = (id) => ({
    id,
    async runCronJob(jobId, mode) {
      calls.push({ backendId: id, kind: "cron.run", jobId, mode });
      return { id: jobId, status: "started" };
    },
    async runTaskCard(taskId) {
      calls.push({ backendId: id, kind: "task.run", taskId });
      return { taskId, status: "started" };
    },
    async nudgeDispatcher() {
      calls.push({ backendId: id, kind: "task.dispatch" });
      return { status: "started" };
    },
  });
  const openclaw = createBackend("openclaw");
  const hermes = createBackend("hermes");
  const registry = {
    backends: new Map([[openclaw.id, openclaw], [hermes.id, hermes]]),
    routeByCronId(jobId) {
      return jobId.startsWith("hermes/") ? hermes : openclaw;
    },
    async aggregateCronJobs() {
      return [{ id: "openclaw/read-only", backendId: "openclaw" }];
    },
    async getTaskBoard(backendId) {
      return { backendId, columns: [] };
    },
  };
  const server = await startStaticServer(0, { registry, workAdmissionGate: gate });
  const drain = gate.beginDrain("openclaw", "model-apply");
  try {
    const blockedRequests = [
      ["POST", "/__api/cron/jobs?id=openclaw%2Fquery&action=run", { mode: "force" }],
      ["POST", "/__api/cron/jobs/openclaw%2Fpath/run", { mode: "force" }],
      ["POST", "/__api/tasks?backend=openclaw&id=task-1&action=run", {}],
      ["POST", "/__api/tasks?backend=openclaw&action=dispatch", {}],
    ];
    for (const [method, route, body] of blockedRequests) {
      const response = await requestJson(method, `${server.url}${route}`, body);
      assert.equal(response.status, 409, `${route} 必须返回 409`);
      assert.equal(response.body?.code, "gateway_draining");
    }
    assert.deepEqual(calls, []);

    const cronList = await requestJson("GET", `${server.url}/__api/cron/jobs`);
    const taskList = await requestJson("GET", `${server.url}/__api/tasks?backend=openclaw`);
    assert.equal(cronList.status, 200);
    assert.equal(taskList.status, 200);

    const hermesCron = await requestJson(
      "POST",
      `${server.url}/__api/cron/jobs?id=hermes%2Fjob&action=run`,
      { mode: "force" },
    );
    const hermesRun = await requestJson(
      "POST",
      `${server.url}/__api/tasks?backend=hermes&id=task-2&action=run`,
      {},
    );
    const hermesDispatch = await requestJson(
      "POST",
      `${server.url}/__api/tasks?backend=hermes&action=dispatch`,
      {},
    );
    assert.equal(hermesCron.status, 200);
    assert.equal(hermesRun.status, 200);
    assert.equal(hermesDispatch.status, 200);
    assert.deepEqual(calls.map(({ backendId, kind }) => ({ backendId, kind })), [
      { backendId: "hermes", kind: "cron.run" },
      { backendId: "hermes", kind: "task.run" },
      { backendId: "hermes", kind: "task.dispatch" },
    ]);
  } finally {
    drain.release();
    await server.close();
  }
});

// 顺序执行并输出每条证据；任一失败都设置非零退出码，供 RED/GREEN 与 CI 使用。
test("完整能力被 runtime 阻断而 configWrite 可用时，REST 保存降级 config-only 并暴露 activate", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
  const { createModelChangeJournal } = require("../app/core/model-change-journal");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-config-only-rest-"));
  const state = { configOnlyCalls: 0, fullApplyCalls: 0, activateCalls: 0 };
  const backend = {
    id: "openclaw",
    async getModelConfig() { return { providers: [] }; },
    async getModelChangeCapabilities() {
      return { supported: false, create: false, update: false, rename: false, delete: false, updateProvider: false, blockers: ["runtime_apply_unsupported"] };
    },
    async getModelConfigWriteCapabilities() {
      return {
        supported: true, create: true, update: true, delete: true, updateProvider: true,
        activation: { kind: "gateway_restart", available: true },
        bypassBlockerCodes: ["runtime_apply_unsupported"], blockers: [],
      };
    },
    async previewModelChange(safeSpec) {
      return {
        references: [],
        blockers: [{ code: "runtime_apply_unsupported", store: "runtime", message: "运行时变更能力不可用" }],
        runtimeApply: "blocked",
        fingerprints: { config: `config:${safeSpec.providerKey}` },
      };
    },
    async applyModelChangeConfigOnly() {
      state.configOnlyCalls += 1;
      return { status: "applied", stage: "config-write" };
    },
    async applyModelChange() {
      state.fullApplyCalls += 1;
      throw new Error("完整 apply 不应被调用");
    },
    async activateModelConfig() {
      state.activateCalls += 1;
      return { ok: true, restarted: true };
    },
  };
  const registry = {
    backends: new Map([[backend.id, backend]]),
    _activeGet(backendId) { return backendId === backend.id ? backend : null; },
    async listModelsSnapshot(backendId) {
      return { models: [{ id: "m-co", provider: "alpha", backendId }], catalogRevision: "b".repeat(64) };
    },
  };
  const journal = createModelChangeJournal(path.join(directory, "journal.json"));
  const coordinator = new ModelChangeCoordinator({ registry, journal, tokenSecret: Buffer.alloc(32, 9) });
  coordinator.markReady();
  const server = await startStaticServer(0, { registry, modelChangeCoordinator: coordinator });
  try {
    const capability = await requestJson("GET", `${server.url}/__api/models/config/capabilities?backend=openclaw`);
    assert.equal(capability.status, 200);
    assert.equal(capability.body.supported, false);
    assert.equal(capability.body.configWrite?.supported, true);
    assert.deepEqual(capability.body.configWrite?.activation, { kind: "gateway_restart", available: true });

    const saved = await requestJson("POST", `${server.url}/__api/models/config?backend=openclaw`, {
      providerKey: "alpha", providerMode: "new", baseUrl: "https://api.example.com/v1",
      model: { id: "m-co" }, operationId: "rest-co-op",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, "applied");
    assert.deepEqual(saved.body.activation, { kind: "gateway_restart", available: true });
    assert.equal(state.configOnlyCalls, 1);
    assert.equal(state.fullApplyCalls, 0);

    const activated = await requestJson("POST", `${server.url}/__api/models/config/activate?backend=openclaw`);
    assert.equal(activated.status, 200);
    assert.deepEqual(activated.body, { ok: true, restarted: true });
    assert.equal(state.activateCalls, 1);

    const missing = await requestJson("POST", `${server.url}/__api/models/config/activate?backend=missing`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// preview 合法地不带 providerDiff 有两条真实来路：OpenClaw 只在 auth-profiles 有
// key 的内置 provider（config 无条目 → 没有 provider 可摘要），Hermes provider 枚举
// 不完整降级 config-only。此时 journal 输入的 providerDiff 必须归一成 null——
// 递 undefined 给 createEntry 会被 assertSafeJson 当「不可序列化值」fail-closed → 500。
test("preview 不带 providerDiff 时 Provider PUT 仍落地，journal 记 null", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
  const { createModelChangeJournal } = require("../app/core/model-change-journal");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-provider-diffless-"));
  const state = { applied: 0, baseUrl: "https://api.example.com/v1" };
  const backend = {
    id: "openclaw",
    async getModelConfig() {
      return {
        providers: [{
          key: "alpha", name: "alpha", baseUrl: state.baseUrl, hasApiKey: true,
          source: "config", editable: true, models: [],
        }],
      };
    },
    async getModelChangeCapabilities() {
      return { supported: true, create: true, update: true, rename: true, delete: true, updateProvider: true, blockers: [] };
    },
    async previewModelChange() {
      return { references: [], blockers: [], runtimeApply: "hot", fingerprints: { config: "one" } };
    },
    async applyModelChange(safeSpec, context) {
      context.assertProviderLease();
      await context.markCommitting();
      state.applied += 1;
      if (typeof safeSpec.patch?.baseUrl === "string") state.baseUrl = safeSpec.patch.baseUrl;
      await context.markCommitted();
      return { status: "applied", stage: "verify-ready" };
    },
  };
  const registry = {
    backends: new Map([[backend.id, backend]]),
    _activeGet(backendId) { return backendId === backend.id ? backend : null; },
    async listModelsSnapshot(backendId) {
      return { models: [{ id: "m-alpha", provider: "alpha", backendId }], catalogRevision: "c".repeat(64) };
    },
  };
  const journalPath = path.join(directory, "journal.json");
  const coordinator = new ModelChangeCoordinator({
    registry,
    journal: createModelChangeJournal(journalPath),
    tokenSecret: Buffer.alloc(32, 7),
  });
  coordinator.markReady();
  const server = await startStaticServer(0, { registry, modelChangeCoordinator: coordinator });
  try {
    const updated = await requestJson("PUT", `${server.url}/__api/models/config?backend=openclaw`, {
      providerKey: "alpha", baseUrl: "https://api.example.com/v2", operationId: "diffless-op",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, "applied");
    assert.equal(state.applied, 1);
    assert.equal(state.baseUrl, "https://api.example.com/v2");
    const persisted = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const entry = persisted.operations.find((row) => row.operationId === "diffless-op");
    assert.equal(entry?.kind, "update-provider");
    assert.equal(entry?.providerDiff, null);
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function main() {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`\u2705 ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`\u274c ${name}`);
      console.error(err?.stack || err);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
