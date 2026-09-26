#!/usr/bin/env node
"use strict";

// Hermes 模型/Provider 配置的定向回归：所有 HTTP 都指向本地假服务，绝不读写真实 ~/.hermes。

const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { HermesBackend, agentIdForProfile } = require("../app/core/hermes-backend");
const { computeCatalogRevision } = require("../app/core/model-catalog-revision");

const tests = [];

// 注册独立用例，末尾统一执行，确保 RED 阶段能一次看到全部缺失行为。
function test(name, run) {
  tests.push({ name, run });
}

// 启动仅监听 loopback 的假 Hermes dashboard，并返回可关闭的服务信息。
async function startFakeDashboard(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

// 输出 JSON 响应，保持各用例的假接口定义简洁可读。
function sendJson(res, status, body) {
  // 既有 CRUD 场景模拟新版 dashboard；旧版 fail-closed 由专用 Task 11 脚本覆盖。
  res.writeHead(status, {
    "content-type": "application/json",
    etag: '"fixture-v1"',
    "x-hermes-conditional-write": "if-match",
    "x-hermes-mutation-version": "1",
  });
  res.end(JSON.stringify(body));
}

// 关闭假服务；即使断言失败也由用例 finally 调用，避免回归脚本残留监听端口。
async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// 捕获 strict 刷新前后的所有目录缓存，验证失败轮次不会提交残缺集合。
function captureCatalogState(backend) {
  return {
    modelChoices: structuredClone(backend.modelChoices),
    modelMeta: [...(backend.modelMeta || new Map()).entries()].map(([key, value]) => [key, structuredClone(value)]),
    modelsByProfile: [...backend.modelsByProfile.entries()].map(([key, value]) => [key, [...value]]),
    modelsByProfileIdentity: [...backend.modelsByProfileIdentity.entries()].map(([key, value]) => [
      key,
      [...value],
    ]),
    fallbacks: backend.agents.map((agent) => [...(agent.fallbacks || [])]),
  };
}

// strict 目录不可用必须暴露稳定的服务端契约，供 REST 层安全映射为 503。
function assertCatalogUnavailable(error, messagePattern) {
  assert.equal(error?.code, "ERR_HERMES_CATALOG_UNAVAILABLE");
  assert.equal(error?.statusCode, 503);
  assert.match(String(error?.message || error), messagePattern);
  return true;
}

// 旧专项通过 backend 内部 coordinator 闭包调用 Provider CRUD，避免测试旁路裸写。
function authorizedModelChange(backend, operationId, run) {
  return backend._withModelChangeCoordinatorContext(operationId, run);
}

test("跨 provider 的同 id 模型均保留，且 pricing/reasoning 元数据不串", async () => {
  const fake = await startFakeDashboard((req, res) => {
    if (req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: [
          {
            slug: "alpha",
            models: ["shared-model"],
            pricing: { "shared-model": { input: 1, output: 2 } },
            capabilities: { "shared-model": { reasoning: true } },
          },
          {
            slug: "beta",
            models: ["shared-model"],
            pricing: { "shared-model": { input: 9, output: 10 } },
            capabilities: { "shared-model": { reasoning: false } },
          },
        ],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    const scope = agentIdForProfile("default");
    backend.agents = [{ id: scope }];
    backend.profileById.set(scope, "default");
    await backend.refreshModelChoices();

    assert.deepEqual(
      backend.getModelChoices().map(({ id, provider }) => ({ id, provider })),
      [
        { id: "shared-model", provider: "alpha" },
        { id: "shared-model", provider: "beta" },
      ],
    );
    assert.deepEqual(backend.modelsByProfile.get("default"), ["shared-model"]);
    assert.deepEqual(backend.agents[0].fallbacks, ["shared-model"]);

    const models = await backend.getModels();
    const alpha = models.find((model) => model.provider === "alpha");
    const beta = models.find((model) => model.provider === "beta");
    assert.deepEqual(alpha?.pricing, { input: 1, output: 2 });
    assert.equal(alpha?.reasoning, true);
    assert.deepEqual(beta?.pricing, { input: 9, output: 10 });
    assert.equal(beta?.reasoning, false);
  } finally {
    await closeServer(fake.server);
  }
});

test("strict 双来源快照分别保留配置真值与运行时目录，不泄露 provider secret", async () => {
  const fake = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "https://config-user:config-password@example.invalid/v1",
            api_key: "config-secret",
            models: {
              "config-only": {
                name: "Configured model",
                context_length: 4096,
                max_tokens: 512,
                reasoning: true,
              },
            },
          },
        },
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: [
          {
            slug: "beta",
            models: ["runtime-only"],
            pricing: { "runtime-only": { input: 1, output: 2 } },
            capabilities: { "runtime-only": { reasoning: false } },
          },
        ],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    const sources = await backend.getModelCatalogSources({ fresh: true });

    assert.deepEqual(sources.config.map(({ providerConfigDigest, ...row }) => {
      assert.match(providerConfigDigest, /^[0-9a-f]{64}$/);
      return row;
    }), [
      {
        id: "config-only",
        name: "Configured model",
        provider: "alpha",
        backendId: "hermes",
        profile: "default",
        contextWindow: 4096,
        maxTokens: 512,
        reasoning: true,
      },
    ]);
    assert.deepEqual(sources.runtime, [
      {
        id: "runtime-only",
        name: "runtime-only",
        provider: "beta",
        backendId: "hermes",
        profile: "default",
        reasoning: false,
        pricing: { input: 1, output: 2 },
        acpProviderRef: undefined,
      },
    ]);
    assert.deepEqual(sources.models, [
      {
        id: "runtime-only",
        name: "runtime-only",
        provider: "beta",
        backendId: "hermes",
        reasoning: false,
        pricing: { input: 1, output: 2 },
        acpProviderRef: undefined,
      },
    ]);
    const serialized = JSON.stringify(sources);
    assert.equal(serialized.includes("config-secret"), false);
    assert.equal(serialized.includes("config-user"), false);
    assert.equal(serialized.includes("config-password"), false);
    assert.equal(serialized.includes("base_url"), false);
  } finally {
    await closeServer(fake.server);
  }
});

test("strict 双来源配置读取不复用普通 provider in-flight，并返回独立 fresh 值", async () => {
  let configRequestCount = 0;
  let releaseOrdinary;
  let ordinaryReleased = false;
  let markOrdinaryStarted;
  let markStrictStarted;
  const ordinaryStarted = new Promise((resolve) => {
    markOrdinaryStarted = resolve;
  });
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      configRequestCount += 1;
      if (configRequestCount === 1) {
        markOrdinaryStarted();
        releaseOrdinary = () => {
          if (ordinaryReleased) return;
          ordinaryReleased = true;
          sendJson(res, 200, {
            providers: {
              alpha: {
                base_url: "http://alpha.invalid",
                models: { target: { max_tokens: 111 } },
              },
            },
          });
        };
        return;
      }
      markStrictStarted();
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "http://alpha.invalid",
            models: { target: { max_tokens: 222 } },
          },
        },
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, { providers: [{ slug: "alpha", models: ["target"] }] });
      return;
    }
    sendJson(res, 404, {});
  });
  let ordinary;
  let strict;
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    ordinary = backend._readProvidersByProfile();
    await ordinaryStarted;

    strict = backend.getModelCatalogSources({ fresh: true });
    const independentStarted = await Promise.race([
      strictStarted.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!independentStarted) releaseOrdinary();
    const sources = await strict;

    assert.equal(independentStarted, true);
    assert.equal(configRequestCount, 2);
    assert.equal(sources.config[0]?.maxTokens, 222);
    releaseOrdinary();
    await ordinary;
    assert.equal(
      backend._providersByProfile.get("default")?.alpha?.models?.target?.max_tokens,
      222,
      "迟到 ordinary provider refresh 不得覆盖 strict fresh 缓存",
    );
  } finally {
    if (releaseOrdinary) releaseOrdinary();
    await Promise.allSettled([ordinary, strict].filter(Boolean));
    await closeServer(fake.server);
  }
});

test("strict provider 拓扑拒绝不提交新增、删除或替换 dashboard 的配置快照", async () => {
  for (const scenario of ["add", "delete", "replace"]) {
    let releaseResponse;
    let responseReleased = false;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const fake = await startFakeDashboard((req, res) => {
      if (req.method === "GET" && req.url === "/api/config") {
        markStarted();
        releaseResponse = () => {
          if (responseReleased) return;
          responseReleased = true;
          sendJson(res, 200, {
            providers: {
              fresh: {
                base_url: "http://fresh.invalid",
                models: { [scenario]: {} },
              },
            },
          });
        };
        return;
      }
      sendJson(res, 404, {});
    });
    const backend = new HermesBackend();
    const original = { baseUrl: fake.baseUrl, token: "fake" };
    const cached = new Map([
      [
        "default",
        {
          cached: {
            base_url: "http://cached.invalid",
            models: { warm: {} },
          },
        },
      ],
    ]);
    const cachedContent = structuredClone([...cached.entries()]);
    backend.dashboards.set("default", original);
    backend._providersByProfile = cached;
    try {
      const strict = backend._readProvidersByProfile({ fresh: true, requireComplete: true });
      await started;
      if (scenario === "add") backend.dashboards.set("added", original);
      if (scenario === "delete") backend.dashboards.delete("default");
      if (scenario === "replace") {
        backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
      }
      releaseResponse();

      await assert.rejects(
        strict,
        (error) => assertCatalogUnavailable(error, /provider 配置读取期间 dashboard 拓扑变化/),
      );
      assert.equal(backend._providersByProfile, cached, `${scenario} 必须保留缓存对象引用`);
      assert.deepEqual([...backend._providersByProfile.entries()], cachedContent);
    } finally {
      if (releaseResponse) releaseResponse();
      await closeServer(fake.server);
    }
  }
});

test("strict provider 零 dashboard 时返回受信 503 并保留旧热缓存", async () => {
  const backend = new HermesBackend();
  const cached = new Map([
    [
      "default",
      {
        cached: {
          base_url: "http://cached.invalid",
          models: { warm: {} },
        },
      },
    ],
  ]);
  const cachedValue = structuredClone([...cached.entries()]);
  backend._providersByProfile = cached;

  await assert.rejects(
    backend._readProvidersByProfile({ fresh: true, requireComplete: true }),
    (error) => assertCatalogUnavailable(error, /provider 配置读取不完整.*没有可用 dashboard/),
  );
  assert.equal(backend._providersByProfile, cached);
  assert.deepEqual([...backend._providersByProfile.entries()], cachedValue);
});

test("strict provider 拓扑失败会立即取消旧 ordinary 的迟到提交资格", async () => {
  let requestCount = 0;
  let releaseOrdinary;
  let releaseStrict;
  let markOrdinaryStarted;
  let markStrictStarted;
  const ordinaryStarted = new Promise((resolve) => {
    markOrdinaryStarted = resolve;
  });
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.method !== "GET" || req.url !== "/api/config") {
      sendJson(res, 404, {});
      return;
    }
    requestCount += 1;
    if (requestCount === 1) {
      markOrdinaryStarted();
      releaseOrdinary = () => sendJson(res, 200, {
        providers: {
          stale: { base_url: "http://stale.invalid", models: { stale: {} } },
        },
      });
      return;
    }
    markStrictStarted();
    releaseStrict = () => sendJson(res, 200, {
      providers: {
        fresh: { base_url: "http://fresh.invalid", models: { fresh: {} } },
      },
    });
  });
  const backend = new HermesBackend();
  const original = { baseUrl: fake.baseUrl, token: "fake" };
  const cached = new Map([
    ["default", { warm: { base_url: "http://warm.invalid", models: { warm: {} } } }],
  ]);
  const cachedValue = structuredClone([...cached.entries()]);
  backend.dashboards.set("default", original);
  backend._providersByProfile = cached;
  let ordinary;
  let strict;
  try {
    ordinary = backend._refreshProvidersByProfile();
    await ordinaryStarted;
    strict = backend._readProvidersByProfile({ fresh: true, requireComplete: true });
    await strictStarted;
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    releaseStrict();
    releaseStrict = null;

    await assert.rejects(
      strict,
      (error) => assertCatalogUnavailable(error, /provider 配置读取期间 dashboard 拓扑变化/),
    );
    releaseOrdinary();
    releaseOrdinary = null;
    await ordinary;

    assert.equal(backend._providersByProfile, cached);
    assert.deepEqual([...backend._providersByProfile.entries()], cachedValue);
  } finally {
    if (releaseStrict) releaseStrict();
    if (releaseOrdinary) releaseOrdinary();
    await Promise.allSettled([ordinary, strict].filter(Boolean));
    await closeServer(fake.server);
  }
});

test("strict 先启动时，后发 ordinary 也不能提交已替换 dashboard 的 provider 快照", async () => {
  let requestCount = 0;
  let releaseStrict;
  let releaseOrdinary;
  let markStrictStarted;
  let markOrdinaryStarted;
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const ordinaryStarted = new Promise((resolve) => {
    markOrdinaryStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.method !== "GET" || req.url !== "/api/config") {
      sendJson(res, 404, {});
      return;
    }
    requestCount += 1;
    if (requestCount === 1) {
      markStrictStarted();
      releaseStrict = () => sendJson(res, 200, {
        providers: { strict: { base_url: "http://strict.invalid", models: { strict: {} } } },
      });
      return;
    }
    markOrdinaryStarted();
    releaseOrdinary = () => sendJson(res, 200, {
      providers: { stale: { base_url: "http://stale.invalid", models: { stale: {} } } },
    });
  });
  const backend = new HermesBackend();
  const original = { baseUrl: fake.baseUrl, token: "fake" };
  const cached = new Map([
    ["default", { warm: { base_url: "http://warm.invalid", models: { warm: {} } } }],
  ]);
  const cachedValue = structuredClone([...cached.entries()]);
  backend.dashboards.set("default", original);
  backend._providersByProfile = cached;
  let strict;
  let ordinary;
  try {
    strict = backend._readProvidersByProfile({ fresh: true, requireComplete: true });
    await strictStarted;
    ordinary = backend._refreshProvidersByProfile();
    await ordinaryStarted;
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    releaseStrict();
    releaseStrict = null;

    await assert.rejects(
      strict,
      (error) => assertCatalogUnavailable(error, /provider 配置读取期间 dashboard 拓扑变化/),
    );
    releaseOrdinary();
    releaseOrdinary = null;
    await ordinary;

    assert.equal(backend._providersByProfile, cached);
    assert.deepEqual([...backend._providersByProfile.entries()], cachedValue);
  } finally {
    if (releaseStrict) releaseStrict();
    if (releaseOrdinary) releaseOrdinary();
    await Promise.allSettled([strict, ordinary].filter(Boolean));
    await closeServer(fake.server);
  }
});

test("strict 运行时刷新任一 profile 失败时拒绝并保持完整热缓存", async () => {
  let badFails = false;
  let goodModel = "old-good";
  const good = await startFakeDashboard((req, res) => {
    if (req.url === "/api/model/options") {
      sendJson(res, 200, { providers: [{ slug: "alpha", models: [goodModel] }] });
      return;
    }
    sendJson(res, 404, {});
  });
  const bad = await startFakeDashboard((req, res) => {
    if (req.url === "/api/model/options") {
      if (badFails) {
        sendJson(res, 503, { error: "profile unavailable" });
      } else {
        sendJson(res, 200, { providers: [{ slug: "beta", models: ["old-bad"] }] });
      }
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("good", { baseUrl: good.baseUrl, token: "fake" });
    backend.dashboards.set("bad", { baseUrl: bad.baseUrl, token: "fake" });
    for (const profile of ["good", "bad"]) {
      const id = agentIdForProfile(profile);
      backend.agents.push({ id });
      backend.profileById.set(id, profile);
    }
    await backend.refreshModelChoices();
    const warm = captureCatalogState(backend);
    goodModel = "new-good";
    badFails = true;

    await assert.rejects(
      backend.refreshModelChoices({ fresh: true, requireComplete: true }),
      (error) => assertCatalogUnavailable(error, /运行时目录读取不完整.*bad/),
    );
    assert.deepEqual(captureCatalogState(backend), warm);
  } finally {
    await Promise.all([closeServer(good.server), closeServer(bad.server)]);
  }
});

test("strict 运行时刷新全失败时不退回热缓存", async () => {
  let fails = false;
  const fake = await startFakeDashboard((req, res) => {
    if (req.url === "/api/model/options") {
      if (fails) sendJson(res, 503, { error: "all unavailable" });
      else sendJson(res, 200, { providers: [{ slug: "alpha", models: ["warm-model"] }] });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    await backend.refreshModelChoices();
    const warm = captureCatalogState(backend);
    fails = true;

    await assert.rejects(
      backend.refreshModelChoices({ fresh: true, requireComplete: true }),
      /运行时目录读取不完整.*default/,
    );
    assert.deepEqual(captureCatalogState(backend), warm);
  } finally {
    await closeServer(fake.server);
  }
});

test("strict 运行时刷新拒绝中途新增、删除或替换 dashboard 的旧拓扑快照", async () => {
  for (const scenario of ["add", "delete", "replace"]) {
    let releaseResponse;
    let responseReleased = false;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const fake = await startFakeDashboard((req, res) => {
      if (req.url === "/api/model/options") {
        markStarted();
        releaseResponse = () => {
          if (responseReleased) return;
          responseReleased = true;
          sendJson(res, 200, { providers: [{ slug: "alpha", models: [scenario] }] });
        };
        return;
      }
      sendJson(res, 404, {});
    });
    const backend = new HermesBackend();
    const original = { baseUrl: fake.baseUrl, token: "fake" };
    backend.dashboards.set("default", original);
    const before = captureCatalogState(backend);
    try {
      const refreshing = backend.refreshModelChoices({ fresh: true, requireComplete: true });
      await started;
      if (scenario === "add") backend.dashboards.set("added", original);
      if (scenario === "delete") backend.dashboards.delete("default");
      if (scenario === "replace") {
        backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
      }
      releaseResponse();

      await assert.rejects(refreshing, /运行时目录读取期间 dashboard 拓扑变化/);
      assert.deepEqual(captureCatalogState(backend), before, `${scenario} 不得提交旧快照`);
    } finally {
      if (releaseResponse) releaseResponse();
      await closeServer(fake.server);
    }
  }
});

test("strict 运行时刷新不复用已有普通 in-flight，并返回独立 fresh 结果", async () => {
  let requestCount = 0;
  let releaseOrdinary;
  let ordinaryReleased = false;
  let markOrdinaryStarted;
  let markStrictStarted;
  const ordinaryStarted = new Promise((resolve) => {
    markOrdinaryStarted = resolve;
  });
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.url !== "/api/model/options") {
      sendJson(res, 404, {});
      return;
    }
    requestCount += 1;
    if (requestCount === 1) {
      sendJson(res, 200, {
        providers: [{ slug: "alpha", models: ["warm-model"] }],
      });
      return;
    }
    if (requestCount === 2) {
      markOrdinaryStarted();
      releaseOrdinary = () => {
        if (ordinaryReleased) return;
        ordinaryReleased = true;
        sendJson(res, 200, {
          providers: [
            {
              slug: "alpha",
              models: ["stale-model"],
              pricing: { "stale-model": { input: 111 } },
              capabilities: { "stale-model": { reasoning: false } },
            },
          ],
        });
      };
      return;
    }
    markStrictStarted();
    sendJson(res, 200, {
      providers: [
        {
          slug: "alpha",
          models: ["fresh-model"],
          pricing: { "fresh-model": { input: 222 } },
          capabilities: { "fresh-model": { reasoning: true } },
        },
      ],
    });
  });
  let ordinary;
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    const scope = agentIdForProfile("default");
    backend.agents = [{ id: scope }];
    backend.profileById.set(scope, "default");
    await backend.refreshModelChoices();
    ordinary = backend.refreshModelChoices();
    await ordinaryStarted;

    const strict = backend.refreshModelChoices({ fresh: true, requireComplete: true });
    const independentStarted = await Promise.race([
      strictStarted.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!independentStarted) releaseOrdinary();
    const strictResult = await strict;

    assert.equal(independentStarted, true);
    assert.deepEqual(strictResult.map(({ id }) => id), ["fresh-model"]);
    releaseOrdinary();
    await ordinary;
    assert.deepEqual(
      backend.modelChoices.map(({ id }) => id),
      ["fresh-model"],
      "迟到 ordinary runtime refresh 不得覆盖 strict fresh 缓存",
    );
    assert.deepEqual(backend.modelsByProfile.get("default"), ["fresh-model"]);
    assert.deepEqual(
      backend.modelMeta.get(JSON.stringify(["alpha", "fresh-model"])),
      { pricing: { input: 222 }, reasoning: true },
    );
    assert.deepEqual(
      [...backend.modelsByProfileIdentity.get("default")],
      [JSON.stringify(["alpha", "fresh-model"])],
    );
    assert.deepEqual(backend.agents[0].fallbacks, ["fresh-model"]);
  } finally {
    if (releaseOrdinary) releaseOrdinary();
    if (ordinary) await Promise.allSettled([ordinary]);
    await closeServer(fake.server);
  }
});

test("strict runtime 拓扑失败会立即取消旧 ordinary 的迟到提交资格", async () => {
  let requestCount = 0;
  let releaseOrdinary;
  let releaseStrict;
  let markOrdinaryStarted;
  let markStrictStarted;
  const ordinaryStarted = new Promise((resolve) => {
    markOrdinaryStarted = resolve;
  });
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.url !== "/api/model/options") {
      sendJson(res, 404, {});
      return;
    }
    requestCount += 1;
    if (requestCount === 1) {
      markOrdinaryStarted();
      releaseOrdinary = () => sendJson(res, 200, {
        providers: [{ slug: "alpha", models: ["stale"] }],
      });
      return;
    }
    markStrictStarted();
    releaseStrict = () => sendJson(res, 200, {
      providers: [{ slug: "alpha", models: ["fresh"] }],
    });
  });
  const backend = new HermesBackend();
  const original = { baseUrl: fake.baseUrl, token: "fake" };
  const scope = agentIdForProfile("default");
  const warmChoices = [{ id: "warm", name: "warm", provider: "alpha" }];
  const warmMeta = new Map([[JSON.stringify(["alpha", "warm"]), { reasoning: true }]]);
  const warmByProfile = new Map([["default", ["warm"]]]);
  const warmIdentities = new Map([["default", new Set([JSON.stringify(["alpha", "warm"])])]]);
  const warmFallbacks = ["warm"];
  backend.dashboards.set("default", original);
  backend.profileById.set(scope, "default");
  backend.agents = [{ id: scope, fallbacks: warmFallbacks }];
  backend.modelChoices = warmChoices;
  backend.modelMeta = warmMeta;
  backend.modelsByProfile = warmByProfile;
  backend.modelsByProfileIdentity = warmIdentities;
  let ordinary;
  let strict;
  try {
    ordinary = backend.refreshModelChoices();
    await ordinaryStarted;
    strict = backend.refreshModelChoices({ fresh: true, requireComplete: true });
    await strictStarted;
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    releaseStrict();
    releaseStrict = null;

    await assert.rejects(
      strict,
      (error) => assertCatalogUnavailable(error, /运行时目录读取期间 dashboard 拓扑变化/),
    );
    releaseOrdinary();
    releaseOrdinary = null;
    await ordinary;

    assert.equal(backend.modelChoices, warmChoices);
    assert.equal(backend.modelMeta, warmMeta);
    assert.equal(backend.modelsByProfile, warmByProfile);
    assert.equal(backend.modelsByProfileIdentity, warmIdentities);
    assert.equal(backend.agents[0].fallbacks, warmFallbacks);
    assert.deepEqual(captureCatalogState(backend), {
      modelChoices: structuredClone(warmChoices),
      modelMeta: [...warmMeta.entries()],
      modelsByProfile: [["default", ["warm"]]],
      modelsByProfileIdentity: [["default", [JSON.stringify(["alpha", "warm"])]]],
      fallbacks: [["warm"]],
    });
  } finally {
    if (releaseStrict) releaseStrict();
    if (releaseOrdinary) releaseOrdinary();
    await Promise.allSettled([ordinary, strict].filter(Boolean));
    await closeServer(fake.server);
  }
});

test("strict 先启动时，后发 ordinary 也不能提交已替换 dashboard 的 runtime 快照", async () => {
  let requestCount = 0;
  let releaseStrict;
  let releaseOrdinary;
  let markStrictStarted;
  let markOrdinaryStarted;
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const ordinaryStarted = new Promise((resolve) => {
    markOrdinaryStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.url !== "/api/model/options") {
      sendJson(res, 404, {});
      return;
    }
    requestCount += 1;
    if (requestCount === 1) {
      markStrictStarted();
      releaseStrict = () => sendJson(res, 200, {
        providers: [{ slug: "alpha", models: ["strict"] }],
      });
      return;
    }
    markOrdinaryStarted();
    releaseOrdinary = () => sendJson(res, 200, {
      providers: [{ slug: "alpha", models: ["stale"] }],
    });
  });
  const backend = new HermesBackend();
  const original = { baseUrl: fake.baseUrl, token: "fake" };
  const scope = agentIdForProfile("default");
  const warmChoices = [{ id: "warm", name: "warm", provider: "alpha" }];
  const warmMeta = new Map([[JSON.stringify(["alpha", "warm"]), { reasoning: true }]]);
  const warmByProfile = new Map([["default", ["warm"]]]);
  const warmIdentities = new Map([["default", new Set([JSON.stringify(["alpha", "warm"])])]]);
  const warmFallbacks = ["warm"];
  backend.dashboards.set("default", original);
  backend.profileById.set(scope, "default");
  backend.agents = [{ id: scope, fallbacks: warmFallbacks }];
  backend.modelChoices = warmChoices;
  backend.modelMeta = warmMeta;
  backend.modelsByProfile = warmByProfile;
  backend.modelsByProfileIdentity = warmIdentities;
  let strict;
  let ordinary;
  try {
    strict = backend.refreshModelChoices({ fresh: true, requireComplete: true });
    await strictStarted;
    ordinary = backend.refreshModelChoices();
    await ordinaryStarted;
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    releaseStrict();
    releaseStrict = null;

    await assert.rejects(
      strict,
      (error) => assertCatalogUnavailable(error, /运行时目录读取期间 dashboard 拓扑变化/),
    );
    releaseOrdinary();
    releaseOrdinary = null;
    await ordinary;

    assert.equal(backend.modelChoices, warmChoices);
    assert.equal(backend.modelMeta, warmMeta);
    assert.equal(backend.modelsByProfile, warmByProfile);
    assert.equal(backend.modelsByProfileIdentity, warmIdentities);
    assert.equal(backend.agents[0].fallbacks, warmFallbacks);
    assert.deepEqual(captureCatalogState(backend).modelChoices, warmChoices);
  } finally {
    if (releaseStrict) releaseStrict();
    if (releaseOrdinary) releaseOrdinary();
    await Promise.allSettled([strict, ordinary].filter(Boolean));
    await closeServer(fake.server);
  }
});

test("多 profile 同模型元数据按稳定 profile 顺序折叠且不受 HTTP 完成顺序影响", async () => {
  const requests = { alpha: 0, beta: 0 };
  const fixtures = [];
  try {
    for (const profile of ["alpha", "beta"]) {
      const fake = await startFakeDashboard((req, res) => {
        if (req.url !== "/api/model/options") {
          sendJson(res, 404, {});
          return;
        }
        requests[profile] += 1;
        const firstPass = requests[profile] === 1;
        const delayMs = profile === "alpha" ? (firstPass ? 0 : 30) : (firstPass ? 30 : 0);
        const pricing = profile === "alpha" ? { input: 1, output: 2 } : { input: 9, output: 10 };
        const reasoning = profile === "alpha";
        setTimeout(() => {
          sendJson(res, 200, {
            providers: [
              {
                slug: "shared-provider",
                models: ["shared-model"],
                pricing: { "shared-model": pricing },
                capabilities: { "shared-model": { reasoning } },
              },
            ],
          });
        }, delayMs);
      });
      fixtures.push({ profile, ...fake });
    }
    const backend = new HermesBackend();
    // 故意以反向插入顺序注册，确保胜出规则来自稳定 profile 排序而不是 Map 顺序。
    for (const fixture of [...fixtures].reverse()) {
      backend.dashboards.set(fixture.profile, { baseUrl: fixture.baseUrl, token: "fake" });
    }

    const first = await backend.refreshModelChoices({
      fresh: true,
      requireComplete: true,
      returnSnapshot: true,
    });
    const second = await backend.refreshModelChoices({
      fresh: true,
      requireComplete: true,
      returnSnapshot: true,
    });
    const identity = JSON.stringify(["shared-provider", "shared-model"]);
    const firstModels = backend._runtimeModelsFromChoices(first.choices, first.meta);
    const secondModels = backend._runtimeModelsFromChoices(second.choices, second.meta);

    assert.deepEqual(second.choices, first.choices);
    assert.deepEqual(first.meta.get(identity), {
      pricing: { input: 1, output: 2 },
      reasoning: true,
    });
    assert.deepEqual(second.meta.get(identity), first.meta.get(identity));
    assert.deepEqual(secondModels, firstModels);
    assert.equal(
      computeCatalogRevision({ backendId: "hermes", config: [], runtime: first.catalogRows }),
      computeCatalogRevision({ backendId: "hermes", config: [], runtime: second.catalogRows }),
    );
  } finally {
    await Promise.all(fixtures.map(({ server }) => closeServer(server)));
  }
});

test("Hermes config/runtime 摘要保留 profile 迁移，UI models 仍按身份去重", async () => {
  const activeByProfile = { alpha: true, beta: false };
  const fixtures = [];
  try {
    for (const profile of ["alpha", "beta"]) {
      const fake = await startFakeDashboard((req, res) => {
        if (req.method === "GET" && req.url === "/api/config") {
          sendJson(res, 200, {
            providers: {
              custom: {
                base_url: "http://custom.invalid",
                models: activeByProfile[profile] ? { shared: {} } : {},
              },
            },
          });
          return;
        }
        if (req.method === "GET" && req.url === "/api/model/options") {
          sendJson(res, 200, {
            providers: [{ slug: "custom", models: activeByProfile[profile] ? ["shared"] : [] }],
          });
          return;
        }
        sendJson(res, 404, {});
      });
      fixtures.push(fake);
    }

    const backend = new HermesBackend();
    backend.dashboards.set("alpha", { baseUrl: fixtures[0].baseUrl, token: "fake" });
    backend.dashboards.set("beta", { baseUrl: fixtures[1].baseUrl, token: "fake" });

    const before = await backend.getModelCatalogSources({ fresh: true });
    activeByProfile.alpha = false;
    activeByProfile.beta = true;
    const after = await backend.getModelCatalogSources({ fresh: true });

    assert.deepEqual(before.models.map(({ id, provider }) => ({ id, provider })), [
      { id: "shared", provider: "custom" },
    ]);
    assert.deepEqual(after.models.map(({ id, provider }) => ({ id, provider })), [
      { id: "shared", provider: "custom" },
    ]);
    assert.equal(before.config.find((row) => row.id === "shared")?.profile, "alpha");
    assert.equal(before.runtime[0]?.profile, "alpha");
    assert.equal(after.config.find((row) => row.id === "shared")?.profile, "beta");
    assert.equal(after.runtime[0]?.profile, "beta");
    assert.notEqual(
      computeCatalogRevision({ backendId: "hermes", config: before.config, runtime: before.runtime }),
      computeCatalogRevision({ backendId: "hermes", config: after.config, runtime: after.runtime }),
    );
  } finally {
    await Promise.all(fixtures.map(({ server }) => closeServer(server)));
  }
});

test("Hermes Provider 端点或 API mode 变化必须更新公开摘要且不得泄露 URL", () => {
  const backend = new HermesBackend();
  const before = backend._modelConfigFromProfiles(new Map([["default", {
    alpha: { base_url: "https://old.example/v1", api_mode: "chat", models: [{ id: "shared" }] },
  }]])).catalogRows;
  const endpointChanged = backend._modelConfigFromProfiles(new Map([["default", {
    alpha: { base_url: "https://new.example/v1", api_mode: "chat", models: [{ id: "shared" }] },
  }]])).catalogRows;
  const modeChanged = backend._modelConfigFromProfiles(new Map([["default", {
    alpha: { base_url: "https://old.example/v1", api_mode: "responses", models: [{ id: "shared" }] },
  }]])).catalogRows;
  assert.match(before[0].providerConfigDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(endpointChanged[0].providerConfigDigest, before[0].providerConfigDigest);
  assert.notEqual(modeChanged[0].providerConfigDigest, before[0].providerConfigDigest);
  assert.equal(JSON.stringify([before, endpointChanged, modeChanged]).includes("example/v1"), false);

  const empty = backend._modelConfigFromProfiles(new Map([["default", {
    alpha: { base_url: "https://empty.example/v1", api_mode: "chat", models: [] },
  }]])).catalogRows;
  assert.equal(empty[0].id, "__provider_config__");
  assert.match(empty[0].providerConfigDigest, /^[0-9a-f]{64}$/);
});

test("Hermes env Provider 端点覆盖变化进入安全目录摘要且不泄露端点", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("default", { profile: "default" });
  const redactedValue = "http…same";
  let revealedValue = "https://old.example/v1";
  backend._listEnvVarsOf = async () => [{
    key: "ALPHA_BASE_URL",
    isSet: true,
    redactedValue,
    category: "provider",
    provider: "alpha",
    isPassword: false,
  }];
  backend._revealEnvVarOf = async () => revealedValue;
  const before = await backend._envProviderCatalogRows();
  revealedValue = "https://new.example/v1";
  const after = await backend._envProviderCatalogRows();
  assert.equal(before.length, 1);
  assert.match(before[0].providerConfigDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(before[0].providerConfigDigest, after[0].providerConfigDigest);
  assert.equal(JSON.stringify([before, after]).includes("example"), false);
  backend._listEnvVarsOf = async () => null;
  await assert.rejects(
    backend._envProviderCatalogRows(),
    (error) => assertCatalogUnavailable(error, /env Provider 读取不完整.*default/),
  );
});

test("getActiveModel 同时返回裸 model 与按 scope 精确对应的 provider", async () => {
  const fake = await startFakeDashboard((req, res) => {
    if (req.url === "/api/model/info") {
      sendJson(res, 200, { model: "shared-model", provider: "beta" });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    const scope = agentIdForProfile("default");
    backend.profileById.set(scope, "default");
    assert.deepEqual(await backend.getActiveModel(), {
      byScope: { [scope]: "shared-model" },
      providerByScope: { [scope]: "beta" },
    });
  } finally {
    await closeServer(fake.server);
  }
});

// 构造一个 profile 正常、另一个 profile 失败的配置环境，并记录所有 PUT 写请求。
async function partialConfigFixture() {
  let putCount = 0;
  const good = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          custom: {
            base_url: "http://example.invalid",
            api_key: "healthy-config-secret",
            models: { "shared-model": { context_length: 4096 } },
          },
        },
      });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      putCount += 1;
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, {});
  });
  const bad = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 503, { error: "profile unavailable" });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      putCount += 1;
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, {});
  });
  const backend = new HermesBackend();
  backend.dashboards.set("good", { baseUrl: good.baseUrl, token: "fake" });
  backend.dashboards.set("bad", { baseUrl: bad.baseUrl, token: "fake" });
  return {
    backend,
    getPutCount: () => putCount,
    close: async () => Promise.all([closeServer(good.server), closeServer(bad.server)]),
  };
}

test("fresh 配置部分读取失败时，removeModelConfig 在任何 PUT 前失败并指出 profile", async () => {
  const fixture = await partialConfigFixture();
  try {
    await assert.rejects(
      authorizedModelChange(fixture.backend, "partial-remove-model", () => (
        fixture.backend.removeModelConfig({ providerKey: "custom", modelId: "shared-model" })
      )),
      (error) => assertCatalogUnavailable(error, /provider 配置读取不完整.*bad/),
    );
    assert.equal(fixture.getPutCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("fresh 配置部分读取失败时，updateModelProvider 在任何 PUT 前失败并指出 profile", async () => {
  const fixture = await partialConfigFixture();
  try {
    await assert.rejects(
      authorizedModelChange(fixture.backend, "partial-update-provider", () => (
        fixture.backend.updateModelProvider("custom", { baseUrl: "http://new.invalid" })
      )),
      /bad/,
    );
    assert.equal(fixture.getPutCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("fresh 配置部分读取失败时，addModelConfig 在任何 PUT 前失败并指出 profile", async () => {
  const fixture = await partialConfigFixture();
  try {
    await assert.rejects(
      authorizedModelChange(fixture.backend, "partial-add-model", () => (
        fixture.backend.addModelConfig({
          providerKey: "custom",
          baseUrl: "http://example.invalid",
          model: { id: "new-model" },
        })
      )),
      /bad/,
    );
    assert.equal(fixture.getPutCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("fresh 配置部分读取失败时，removeModelProvider 在任何 PUT 前失败并指出 profile", async () => {
  const fixture = await partialConfigFixture();
  try {
    await assert.rejects(
      authorizedModelChange(fixture.backend, "partial-remove-provider", () => (
        fixture.backend.removeModelProvider("custom")
      )),
      /bad/,
    );
    assert.equal(fixture.getPutCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("旧拓扑 refresh 挂起后新增 profile，update 在首个 PUT 前拒绝拓扑变化", async () => {
  let putCount = 0;
  const releases = [];
  let configRequestCount = 0;
  let markOldStarted;
  let markStrictStarted;
  const oldStarted = new Promise((resolve) => {
    markOldStarted = resolve;
  });
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const old = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      releases.push(() =>
        sendJson(res, 200, {
          providers: {
            custom: {
              base_url: "http://old.invalid",
              models: { "shared-model": {} },
            },
          },
        }));
      configRequestCount += 1;
      if (configRequestCount === 1) markOldStarted();
      if (configRequestCount === 2) markStrictStarted();
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") putCount += 1;
    sendJson(res, 200, { ok: true });
  });
  const added = await startFakeDashboard((req, res) => {
    if (req.method === "PUT" && req.url === "/api/config") putCount += 1;
    sendJson(res, 200, { providers: {} });
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("old", { baseUrl: old.baseUrl, token: "fake" });
    const oldRefresh = backend._readProvidersByProfile({ fresh: true });
    await oldStarted;

    // 写路径必须启动独立 strict；待 strict 捕获 old 后再加入 added，验证其自身
    // 的拓扑保护仍会在首个 PUT 前拒绝，而不是依赖普通 in-flight 的旧快照。
    const updating = authorizedModelChange(backend, "topology-update-provider", () => (
      backend.updateModelProvider("custom", { baseUrl: "http://new.invalid" })
    ));
    const updatingRejected = assert.rejects(updating, /拓扑变化/);
    await strictStarted;
    backend.dashboards.set("added", { baseUrl: added.baseUrl, token: "fake" });
    for (const release of releases) release();
    releases.length = 0;
    await oldRefresh;
    await updatingRejected;
    assert.equal(putCount, 0);
  } finally {
    for (const release of releases) release();
    await Promise.all([closeServer(old.server), closeServer(added.server)]);
  }
});

test("旧拓扑 refresh 挂起后删除 profile，remove 在首个 PUT 前拒绝拓扑变化", async () => {
  let putCount = 0;
  const releases = [];
  let startedCount = 0;
  let markBothStarted;
  let markStrictStarted;
  const bothStarted = new Promise((resolve) => {
    markBothStarted = resolve;
  });
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  // 创建配置 GET 可挂起的 profile，确保删除拓扑发生在同一 in-flight 快照期间。
  const makeDashboard = async (name) =>
    startFakeDashboard((req, res) => {
      if (req.method === "GET" && req.url === "/api/config") {
        releases.push(() =>
          sendJson(res, 200, {
            providers: {
              custom: {
                base_url: `http://${name}.invalid`,
                models: { "shared-model": {} },
              },
            },
          }),
        );
        startedCount += 1;
        if (startedCount === 2) markBothStarted();
        if (startedCount === 4) markStrictStarted();
        return;
      }
      if (req.method === "PUT" && req.url === "/api/config") putCount += 1;
      sendJson(res, 200, { ok: true });
    });
  const kept = await makeDashboard("kept");
  const removed = await makeDashboard("removed");
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("kept", { baseUrl: kept.baseUrl, token: "fake" });
    backend.dashboards.set("removed", { baseUrl: removed.baseUrl, token: "fake" });
    const oldRefresh = backend._readProvidersByProfile({ fresh: true });
    await bothStarted;

    // 独立 strict 也先捕获两个 profile；随后移除 removed，必须由 strict 自身拒绝。
    const removing = authorizedModelChange(backend, "topology-remove-model", () => (
      backend.removeModelConfig({
        providerKey: "custom",
        modelId: "shared-model",
      })
    ));
    const removingRejected = assert.rejects(removing, /拓扑变化/);
    await strictStarted;
    backend.dashboards.delete("removed");
    for (const release of releases) release();
    releases.length = 0;
    await oldRefresh;
    await removingRejected;
    assert.equal(putCount, 0);
  } finally {
    for (const release of releases) release();
    await Promise.all([closeServer(kept.server), closeServer(removed.server)]);
  }
});

test("同 profile key 替换 dashboard 对象时 remove 在新 dashboard 零 PUT 并拒绝拓扑变化", async () => {
  const releases = [];
  let configRequestCount = 0;
  let markOldStarted;
  let markStrictStarted;
  const oldStarted = new Promise((resolve) => {
    markOldStarted = resolve;
  });
  const strictStarted = new Promise((resolve) => {
    markStrictStarted = resolve;
  });
  const old = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      releases.push(() =>
        sendJson(res, 200, {
          providers: {
            custom: {
              base_url: "http://old-provider.invalid",
              models: { target: {}, "old-only": {} },
            },
          },
        }));
      configRequestCount += 1;
      if (configRequestCount === 1) markOldStarted();
      if (configRequestCount === 2) markStrictStarted();
      return;
    }
    sendJson(res, 404, {});
  });
  let currentPutCount = 0;
  const current = await startFakeDashboard((req, res) => {
    if (req.method === "PUT" && req.url === "/api/config") currentPutCount += 1;
    sendJson(res, 200, { ok: true });
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("same", { baseUrl: old.baseUrl, token: "old-fake-token" });
    const oldRefresh = backend._readProvidersByProfile({ fresh: true });
    await oldStarted;

    const removing = authorizedModelChange(backend, "topology-replaced-remove", () => (
      backend.removeModelConfig({ providerKey: "custom", modelId: "target" })
    ));
    const removingRejected = assert.rejects(removing, /拓扑变化/);
    await strictStarted;
    // profile key 保持 same，但在 strict 捕获后替换 dashboard 对象/baseUrl/token；
    // strict 快照绝不能写进新 dashboard，否则会把其当前 models 覆盖成 old-only。
    backend.dashboards.set("same", {
      baseUrl: current.baseUrl,
      token: "current-fake-token",
    });
    for (const release of releases) release();
    releases.length = 0;
    await oldRefresh;
    await removingRejected;
    assert.equal(currentPutCount, 0);
  } finally {
    for (const release of releases) release();
    await Promise.all([closeServer(old.server), closeServer(current.server)]);
  }
});

test("普通读部分 profile 失败时返回并保留完整双 profile 热缓存", async () => {
  const fixture = await partialConfigFixture();
  try {
    const cached = new Map([
      [
        "good",
        {
          custom: {
            base_url: "http://good.cached.invalid",
            models: { "good-model": {} },
          },
        },
      ],
      [
        "bad",
        {
          custom: {
            base_url: "http://bad.cached.invalid",
            models: { "bad-model": {} },
          },
        },
      ],
    ]);
    fixture.backend._providersByProfile = cached;

    // 普通读先立即返回完整热缓存；等待后台部分失败刷新结束后，缓存仍须保持双 profile，
    // 不能被本轮只含 good 的残缺 Map 覆盖。
    assert.equal(await fixture.backend._readProvidersByProfile(), cached);
    await fixture.backend._providersRefreshing;
    assert.equal(fixture.backend._providersByProfile, cached);
    assert.deepEqual([...fixture.backend._providersByProfile.keys()], ["good", "bad"]);
    assert.equal(await fixture.backend._readProvidersByProfile(), cached);
  } finally {
    await fixture.close();
  }
});

test("reveal 在部分 profile 失败时仍可读取健康 config provider", async () => {
  const fixture = await partialConfigFixture();
  try {
    assert.deepEqual(await fixture.backend.revealModelProviderKey("custom"), {
      apiKey: "healthy-config-secret",
    });
  } finally {
    await fixture.close();
  }
});

test("reveal 在部分 profile 失败时仍会继续读取 env provider", async () => {
  const fixture = await partialConfigFixture();
  try {
    // env provider 与 config 快照无关；另一 profile 读取失败不能阻断后续 env reveal。
    fixture.backend._envProviders = async () => [
      {
        key: "builtin",
        keyEnv: "BUILTIN_API_KEY",
        baseUrlEnv: "BUILTIN_BASE_URL",
        hasApiKey: true,
        hasBaseUrl: false,
      },
    ];
    fixture.backend.revealEnvVar = async (key) => ({
      value: key === "BUILTIN_API_KEY" ? "healthy-env-secret" : "",
    });
    assert.deepEqual(await fixture.backend.revealModelProviderKey("builtin"), {
      apiKey: "healthy-env-secret",
      baseUrl: "",
    });
  } finally {
    await fixture.close();
  }
});

test("fresh reveal 在部分失败且有热缓存时优先健康 profile 的本轮 NEW config", async () => {
  const fixture = await partialConfigFixture();
  try {
    fixture.backend._providersByProfile = new Map([
      [
        "good",
        {
          custom: {
            base_url: "http://old.good.invalid",
            api_key: "old-config-secret",
            models: { "old-model": {} },
          },
        },
      ],
      [
        "bad",
        {
          custom: {
            base_url: "http://old.bad.invalid",
            api_key: "older-config-secret",
            models: { "older-model": {} },
          },
        },
      ],
    ]);

    // good 本轮返回 healthy-config-secret，bad 返回 503；fresh reveal 必须使用
    // 本轮 current partial，不能让完整但陈旧的热缓存 OLD 覆盖健康 profile 的 NEW。
    assert.deepEqual(await fixture.backend.revealModelProviderKey("custom"), {
      apiKey: "healthy-config-secret",
    });
  } finally {
    await fixture.close();
  }
});

test("fresh reveal 的旧 config 热缓存不遮蔽本轮健康结果作出的 env 判定", async () => {
  const fixture = await partialConfigFixture();
  try {
    fixture.backend._providersByProfile = new Map([
      ["good", { builtin: { base_url: "http://old.good.invalid", api_key: "old-config-secret" } }],
      ["bad", { builtin: { base_url: "http://old.bad.invalid", api_key: "older-config-secret" } }],
    ]);
    fixture.backend._envProviders = async () => [
      {
        key: "builtin",
        keyEnv: "BUILTIN_API_KEY",
        baseUrlEnv: "BUILTIN_BASE_URL",
        hasApiKey: true,
        hasBaseUrl: false,
      },
    ];
    fixture.backend.revealEnvVar = async (key) => ({
      value: key === "BUILTIN_API_KEY" ? "current-env-secret" : "",
    });

    // good 的本轮 config 不再含 builtin，因此应继续走 env；不能被 OLD config 截胡。
    assert.deepEqual(await fixture.backend.revealModelProviderKey("builtin"), {
      apiKey: "current-env-secret",
      baseUrl: "",
    });
  } finally {
    await fixture.close();
  }
});

test("配置全失败时普通读可降级热缓存，但并发 fresh 写仍拒绝旧缓存", async () => {
  let putCount = 0;
  const first = await startFakeDashboard((req, res) => {
    if (req.method === "PUT") putCount += 1;
    sendJson(res, 503, { error: "first unavailable" });
  });
  const second = await startFakeDashboard((req, res) => {
    if (req.method === "PUT") putCount += 1;
    sendJson(res, 503, { error: "second unavailable" });
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("first", { baseUrl: first.baseUrl, token: "fake" });
    backend.dashboards.set("second", { baseUrl: second.baseUrl, token: "fake" });
    const cached = new Map([
      [
        "first",
        {
          custom: {
            base_url: "http://cached.invalid",
            models: { "shared-model": {} },
          },
        },
      ],
    ]);
    backend._providersByProfile = cached;

    // 普通读立即返回热缓存，同时启动后台刷新；紧随其后的 fresh 写必须复用该
    // in-flight 结果并看到两个 profile 全失败，不能把 cached 当作 fresh 快照写回。
    assert.equal(await backend._readProvidersByProfile(), cached);
    await assert.rejects(
      authorizedModelChange(backend, "failed-refresh-remove", () => (
        backend.removeModelConfig({ providerKey: "custom", modelId: "shared-model" })
      )),
      /first.*second|second.*first/,
    );
    assert.equal(putCount, 0);
  } finally {
    await Promise.all([closeServer(first.server), closeServer(second.server)]);
  }
});

test("删除同名模型时等待旧刷新且不误删另一 provider 的 profile fallback", async () => {
  let deleted = false;
  let optionsRequestCount = 0;
  let releaseOldRefresh = null;
  let markOldRefreshStarted;
  const oldRefreshStarted = new Promise((resolve) => {
    markOldRefreshStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "http://alpha.invalid",
            models: { "shared-model": { context_length: 4096 } },
          },
          beta: {
            base_url: "http://beta.invalid",
            models: { "shared-model": { context_length: 8192 } },
          },
        },
      });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      deleted = true;
      sendJson(res, 200, { ok: true });
      if (releaseOldRefresh) releaseOldRefresh();
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      optionsRequestCount += 1;
      const providers = [
        ...(!deleted
          ? [
              {
                slug: "alpha",
                models: ["shared-model"],
                pricing: { "shared-model": { input: 1, output: 2 } },
              },
            ]
          : []),
        {
          slug: "beta",
          models: ["shared-model"],
          pricing: { "shared-model": { input: 9, output: 10 } },
        },
      ];
      if (optionsRequestCount === 2) {
        // 第二轮固定返回删除前快照，并延迟到 PUT 成功后才提交，复现旧 in-flight 晚覆盖。
        const staleProviders = providers;
        releaseOldRefresh = () => sendJson(res, 200, { providers: staleProviders });
        markOldRefreshStarted();
        return;
      }
      sendJson(res, 200, {
        providers,
      });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    const scope = agentIdForProfile("default");
    backend.agents = [{ id: scope }];
    backend.profileById.set(scope, "default");

    // 先预热同 profile 的同名双 provider，再挂起一轮删除前目录刷新。
    await backend.refreshModelChoices();
    const oldRefresh = backend.refreshModelChoices();
    await oldRefreshStarted;

    await authorizedModelChange(backend, "cache-remove-model", () => (
      backend.removeModelConfig({ providerKey: "alpha", modelId: "shared-model" })
    ));
    await oldRefresh;
    const models = await backend.getModels();
    assert.deepEqual(
      models.map(({ provider, id }) => ({ provider, id })),
      [{ provider: "beta", id: "shared-model" }],
    );
    assert.deepEqual(backend.modelsByProfile.get("default"), ["shared-model"]);
    assert.deepEqual(backend.agents[0].fallbacks, ["shared-model"]);
    assert.equal(backend.modelMeta.has(JSON.stringify(["alpha", "shared-model"])), false);
    assert.equal(backend.modelMeta.has(JSON.stringify(["beta", "shared-model"])), true);
  } finally {
    // 断言提前失败时释放挂起响应，确保假服务可以正常关闭。
    if (releaseOldRefresh && !deleted) releaseOldRefresh();
    await closeServer(fake.server);
  }
});

test("删除跨 profile 同名模型时只清理目标 profile 的裸 id fallback", async () => {
  let alphaDeleted = false;
  const alpha = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "http://alpha.invalid",
            models: { "shared-model": {} },
          },
        },
      });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      alphaDeleted = true;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: alphaDeleted ? [] : [{ slug: "alpha", models: ["shared-model"] }],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  const beta = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          beta: {
            base_url: "http://beta.invalid",
            models: { "shared-model": {} },
          },
        },
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: [{ slug: "beta", models: ["shared-model"] }],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("a", { baseUrl: alpha.baseUrl, token: "fake" });
    backend.dashboards.set("b", { baseUrl: beta.baseUrl, token: "fake" });
    const alphaScope = agentIdForProfile("a");
    const betaScope = agentIdForProfile("b");
    backend.agents = [{ id: alphaScope }, { id: betaScope }];
    backend.profileById.set(alphaScope, "a");
    backend.profileById.set(betaScope, "b");
    await backend.refreshModelChoices();

    await authorizedModelChange(backend, "profile-remove-model", () => (
      backend.removeModelConfig({ providerKey: "alpha", modelId: "shared-model" })
    ));

    assert.deepEqual(backend.modelsByProfile.get("a"), []);
    assert.deepEqual(backend.agents[0].fallbacks, []);
    assert.deepEqual(backend.modelsByProfile.get("b"), ["shared-model"]);
    assert.deepEqual(backend.agents[1].fallbacks, ["shared-model"]);
  } finally {
    await Promise.all([closeServer(alpha.server), closeServer(beta.server)]);
  }
});

test("删除 holder 模型时保留另一 profile 暴露的相同 provider 身份", async () => {
  let holderDeleted = false;
  const holder = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "http://alpha.invalid",
            models: { "shared-model": {} },
          },
        },
      });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      holderDeleted = true;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: holderDeleted ? [] : [{ slug: "alpha", models: ["shared-model"] }],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  const builtin = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      // 此 profile 的 alpha/shared 来自非 config 目录，因此不是 removeModelConfig holder。
      sendJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: [
          {
            slug: "alpha",
            models: ["shared-model"],
            pricing: { "shared-model": { input: 9, output: 10 } },
          },
        ],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("holder", { baseUrl: holder.baseUrl, token: "fake" });
    backend.dashboards.set("builtin", { baseUrl: builtin.baseUrl, token: "fake" });
    const holderScope = agentIdForProfile("holder");
    const builtinScope = agentIdForProfile("builtin");
    backend.agents = [{ id: holderScope }, { id: builtinScope }];
    backend.profileById.set(holderScope, "holder");
    backend.profileById.set(builtinScope, "builtin");
    await backend.refreshModelChoices();

    const catalogKey = JSON.stringify(["alpha", "shared-model"]);
    assert.equal(backend.modelMeta.has(catalogKey), true);
    await authorizedModelChange(backend, "builtin-remove-model", () => (
      backend.removeModelConfig({ providerKey: "alpha", modelId: "shared-model" })
    ));

    assert.equal(
      backend.modelChoices.some(
        (model) => model.provider === "alpha" && model.id === "shared-model",
      ),
      true,
    );
    assert.equal(backend.modelMeta.has(catalogKey), true);
    assert.deepEqual(backend.modelsByProfile.get("holder"), []);
    assert.deepEqual(backend.agents[0].fallbacks, []);
    assert.deepEqual(backend.modelsByProfile.get("builtin"), ["shared-model"]);
    assert.deepEqual(backend.agents[1].fallbacks, ["shared-model"]);
  } finally {
    await Promise.all([closeServer(holder.server), closeServer(builtin.server)]);
  }
});

test("部分 profile 失败时用上一轮快照补位：不清它的模型，也不冻住健康 profile", async () => {
  let healthyRound = 0;
  let flakyRound = 0;
  const healthy = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      healthyRound += 1;
      // 第二轮起多出 healthy-b：用来证明健康 profile 的更新没有被整体冻住。
      sendJson(res, 200, {
        providers: [{ slug: "alpha", models: healthyRound === 1 ? ["healthy-a"] : ["healthy-a", "healthy-b"] }],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  const flaky = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      flakyRound += 1;
      // 首轮答上来建立热缓存，之后一直 503（健康但慢/抖动的 profile）。
      if (flakyRound > 1) {
        sendJson(res, 503, { error: "options unavailable" });
        return;
      }
      sendJson(res, 200, { providers: [{ slug: "beta", models: ["flaky-model"] }] });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("healthy", { baseUrl: healthy.baseUrl, token: "fake" });
    backend.dashboards.set("flaky", { baseUrl: flaky.baseUrl, token: "fake" });
    const healthyScope = agentIdForProfile("healthy");
    const flakyScope = agentIdForProfile("flaky");
    backend.agents = [{ id: healthyScope }, { id: flakyScope }];
    backend.profileById.set(healthyScope, "healthy");
    backend.profileById.set(flakyScope, "flaky");

    await backend.refreshModelChoices();
    assert.deepEqual(backend.modelsByProfile.get("flaky"), ["flaky-model"]);

    // commit 是整体替换：缺席的 profile 会被清空，所以失败轮次必须靠上一轮快照补位。
    await backend.refreshModelChoices();
    const ids = backend.modelChoices.map((choice) => choice.id).sort();
    assert.ok(ids.includes("flaky-model"), "失败 profile 的模型不该被清出目录");
    assert.ok(ids.includes("healthy-b"), "健康 profile 的新模型不该被失败 profile 冻住");
    assert.deepEqual(backend.modelsByProfile.get("flaky"), ["flaky-model"]);
  } finally {
    await closeServer(healthy.server);
    await closeServer(flaky.server);
  }
});

test("已删除的模型不得被后续失败轮次的快照补位复活", async () => {
  let flakyRound = 0;
  const healthy = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, { providers: [{ slug: "alpha", models: ["healthy-model"] }] });
      return;
    }
    sendJson(res, 404, {});
  });
  const flaky = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      flakyRound += 1;
      if (flakyRound > 1) {
        sendJson(res, 503, { error: "options unavailable" });
        return;
      }
      sendJson(res, 200, { providers: [{ slug: "alpha", models: ["keep-model", "doomed-model"] }] });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("healthy", { baseUrl: healthy.baseUrl, token: "fake" });
    backend.dashboards.set("flaky", { baseUrl: flaky.baseUrl, token: "fake" });
    const healthyScope = agentIdForProfile("healthy");
    const flakyScope = agentIdForProfile("flaky");
    backend.agents = [{ id: healthyScope }, { id: flakyScope }];
    backend.profileById.set(healthyScope, "healthy");
    backend.profileById.set(flakyScope, "flaky");

    await backend.refreshModelChoices();
    assert.ok(backend.modelChoices.some((choice) => choice.id === "doomed-model"));

    // 删除成功后目录被就地裁剪；上一轮快照里仍留着它，补位若不同步就会把删除撤销。
    await backend._syncRemovedModelCache(
      ["flaky"],
      (identity) => identity === JSON.stringify(["alpha", "doomed-model"]),
    );
    assert.ok(!backend.modelChoices.some((choice) => choice.id === "doomed-model"));

    await backend.refreshModelChoices();
    const ids = backend.modelChoices.map((choice) => choice.id);
    assert.ok(!ids.includes("doomed-model"), "已删除的模型被补位复活了");
    assert.ok(!(backend.agents[1].fallbacks || []).includes("doomed-model"), "已删除的模型回到了 fallback");
  } finally {
    await closeServer(healthy.server);
    await closeServer(flaky.server);
  }
});

test("身份快照缺失非 holder profile 时保守保留全局模型缓存", async () => {
  let holderDeleted = false;
  const holder = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "http://alpha.invalid",
            models: { "shared-model": {} },
          },
        },
      });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      holderDeleted = true;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: holderDeleted
          ? []
          : [
              {
                slug: "alpha",
                models: ["shared-model"],
                pricing: { "shared-model": { input: 1, output: 2 } },
              },
            ],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  const unknown = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      // config 可读但不持有目标，模型身份只能依赖可能失败的 options 目录判断。
      sendJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 503, { error: "options unavailable" });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("holder", { baseUrl: holder.baseUrl, token: "fake" });
    backend.dashboards.set("unknown", { baseUrl: unknown.baseUrl, token: "fake" });
    const holderScope = agentIdForProfile("holder");
    const unknownScope = agentIdForProfile("unknown");
    // unknown 的 fallback 来自更早的完整轮次（此处直接给定）。
    backend.agents = [{ id: holderScope }, { id: unknownScope, fallbacks: ["shared-model"] }];
    backend.profileById.set(holderScope, "holder");
    backend.profileById.set(unknownScope, "unknown");

    // 冷缓存下 options 失败的 profile 只能缺席首轮提交，身份快照因此缺 unknown；
    // 但旧 fallback 仍证明该 profile 可能继续暴露目标模型。
    await backend.refreshModelChoices();
    assert.deepEqual(backend.agents[1].fallbacks, ["shared-model"]);
    assert.equal(backend.modelsByProfileIdentity.has("unknown"), false);

    const catalogKey = JSON.stringify(["alpha", "shared-model"]);
    await authorizedModelChange(backend, "unknown-remove-model", () => (
      backend.removeModelConfig({ providerKey: "alpha", modelId: "shared-model" })
    ));

    assert.equal(
      backend.modelChoices.some(
        (model) => model.provider === "alpha" && model.id === "shared-model",
      ),
      true,
    );
    assert.equal(backend.modelMeta.has(catalogKey), true);
    assert.deepEqual(backend.modelsByProfile.get("holder"), []);
    assert.deepEqual(backend.agents[0].fallbacks, []);
    assert.deepEqual(backend.agents[1].fallbacks, ["shared-model"]);
  } finally {
    await Promise.all([closeServer(holder.server), closeServer(unknown.server)]);
  }
});

test("holder 身份快照缺失时删除配置不覆盖其旧 fallback", async () => {
  const holder = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "http://alpha.invalid",
            models: { "shared-model": {}, "keep-model": {} },
          },
        },
      });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 503, { error: "holder options unavailable" });
      return;
    }
    sendJson(res, 404, {});
  });
  const healthy = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, { providers: {} });
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      sendJson(res, 200, {
        providers: [{ slug: "beta", models: ["other-model"] }],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("holder", { baseUrl: holder.baseUrl, token: "fake" });
    backend.dashboards.set("healthy", { baseUrl: healthy.baseUrl, token: "fake" });
    const holderScope = agentIdForProfile("holder");
    const healthyScope = agentIdForProfile("healthy");
    // holder 的 fallback 来自更早的完整轮次（此处直接给定）。
    backend.agents = [
      { id: holderScope, fallbacks: ["shared-model", "keep-model"] },
      { id: healthyScope },
    ];
    backend.profileById.set(holderScope, "holder");
    backend.profileById.set(healthyScope, "healthy");

    // 冷缓存下 options 失败的 holder 只能缺席首轮提交，身份快照因此缺 holder。
    await backend.refreshModelChoices();
    assert.deepEqual(backend.agents[0].fallbacks, ["shared-model", "keep-model"]);
    assert.equal(backend.modelsByProfileIdentity.has("holder"), false);
    assert.equal(backend.modelsByProfile.has("holder"), false);

    await authorizedModelChange(backend, "holder-remove-model", () => (
      backend.removeModelConfig({ providerKey: "alpha", modelId: "shared-model" })
    ));

    // holder options 本轮不可知：不能凭空写入空身份集合，也不能清掉其旧 fallback。
    assert.equal(backend.modelsByProfileIdentity.has("holder"), false);
    assert.equal(backend.modelsByProfile.has("holder"), false);
    assert.deepEqual(backend.agents[0].fallbacks, ["shared-model", "keep-model"]);
  } finally {
    await Promise.all([closeServer(holder.server), closeServer(healthy.server)]);
  }
});

test("删除整个 provider 时等待旧刷新并同步清理其全部复合身份缓存", async () => {
  let deleted = false;
  let optionsRequestCount = 0;
  let releaseOldRefresh = null;
  let markOldRefreshStarted;
  const oldRefreshStarted = new Promise((resolve) => {
    markOldRefreshStarted = resolve;
  });
  const fake = await startFakeDashboard((req, res) => {
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, {
        providers: {
          alpha: {
            base_url: "http://alpha.invalid",
            models: { "alpha-only": {}, "shared-model": {} },
          },
        },
      });
      return;
    }
    if (req.method === "PUT" && req.url === "/api/config") {
      deleted = true;
      sendJson(res, 200, { ok: true });
      if (releaseOldRefresh) releaseOldRefresh();
      return;
    }
    if (req.method === "GET" && req.url === "/api/model/options") {
      optionsRequestCount += 1;
      const providers = [
        ...(!deleted
          ? [{ slug: "alpha", models: ["alpha-only", "shared-model"] }]
          : []),
        { slug: "beta", models: ["shared-model"] },
      ];
      if (optionsRequestCount === 2) {
        // 固定删除前快照并延迟响应，验证 provider 删除不会被旧刷新晚到覆盖。
        const staleProviders = providers;
        releaseOldRefresh = () => sendJson(res, 200, { providers: staleProviders });
        markOldRefreshStarted();
        return;
      }
      sendJson(res, 200, { providers });
      return;
    }
    sendJson(res, 404, {});
  });
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("default", { baseUrl: fake.baseUrl, token: "fake" });
    const scope = agentIdForProfile("default");
    backend.agents = [{ id: scope }];
    backend.profileById.set(scope, "default");
    backend._clearProviderPool = async () => ({ removed: 0, failures: [] });

    await backend.refreshModelChoices();
    const oldRefresh = backend.refreshModelChoices();
    await oldRefreshStarted;
    await authorizedModelChange(backend, "cache-remove-provider", () => (
      backend.removeModelProvider("alpha")
    ));
    await oldRefresh;

    assert.deepEqual(
      backend.getModelChoices().map(({ provider, id }) => ({ provider, id })),
      [{ provider: "beta", id: "shared-model" }],
    );
    assert.deepEqual(backend.modelsByProfile.get("default"), ["shared-model"]);
    assert.deepEqual(backend.agents[0].fallbacks, ["shared-model"]);
    assert.equal(backend.modelMeta.has(JSON.stringify(["alpha", "alpha-only"])), false);
    assert.equal(backend.modelMeta.has(JSON.stringify(["alpha", "shared-model"])), false);
  } finally {
    if (releaseOldRefresh && !deleted) releaseOldRefresh();
    await closeServer(fake.server);
  }
});

test("删除 provider 部分 profile 失败时保留目录缓存并返回 warnings", async () => {
  // 两个 holder 暴露同一 provider；一个 PUT 失败时目录仍真实存在，不能提前隐藏。
  const makeHolder = async (putStatus) =>
    startFakeDashboard((req, res) => {
      if (req.method === "GET" && req.url === "/api/config") {
        sendJson(res, 200, {
          providers: {
            alpha: { base_url: "http://alpha.invalid", models: { target: {} } },
          },
        });
        return;
      }
      if (req.method === "PUT" && req.url === "/api/config") {
        sendJson(res, putStatus, putStatus === 200 ? { ok: true } : { error: "write failed" });
        return;
      }
      if (req.method === "GET" && req.url === "/api/model/options") {
        sendJson(res, 200, { providers: [{ slug: "alpha", models: ["target"] }] });
        return;
      }
      sendJson(res, 404, {});
    });
  const good = await makeHolder(200);
  const bad = await makeHolder(500);
  try {
    const backend = new HermesBackend();
    backend.dashboards.set("good", { baseUrl: good.baseUrl, token: "fake" });
    backend.dashboards.set("bad", { baseUrl: bad.baseUrl, token: "fake" });
    backend._clearProviderPool = async () => ({ removed: 0, failures: [] });
    await backend.refreshModelChoices();

    const result = await authorizedModelChange(backend, "partial-remove-provider", () => (
      backend.removeModelProvider("alpha")
    ));

    assert.equal(result.warnings?.length, 1);
    assert.deepEqual(
      backend.getModelChoices().map(({ provider, id }) => ({ provider, id })),
      [{ provider: "alpha", id: "target" }],
    );
    assert.deepEqual(backend.modelsByProfile.get("good"), ["target"]);
    assert.deepEqual(backend.modelsByProfile.get("bad"), ["target"]);
  } finally {
    await Promise.all([closeServer(good.server), closeServer(bad.server)]);
  }
});

// 注入 env provider 与写删方法，只测试聚合判定，不触碰真实环境变量接口。
function envBackend({ setError = null, deleteError = null } = {}) {
  const backend = new HermesBackend();
  backend._envProviders = async () => [
    {
      key: "builtin",
      keyEnv: "BUILTIN_API_KEY",
      baseUrlEnv: "BUILTIN_BASE_URL",
      hasBaseUrl: true,
    },
  ];
  backend.setEnvVar = async () => {
    if (setError) throw new Error(setError);
  };
  backend.deleteEnvVar = async () => {
    if (deleteError) throw new Error(deleteError);
  };
  return backend;
}

test("env 只有 clear 操作且失败时抛错", async () => {
  const backend = envBackend({ deleteError: "clear failed" });
  await assert.rejects(
    backend._updateEnvProvider("builtin", { clearBaseUrl: true }),
    /clear failed/,
  );
});

test("env set+clear 仅 clear 失败时返回 warning，不误判全部失败", async () => {
  const backend = envBackend({ deleteError: "clear failed" });
  const result = await backend._updateEnvProvider("builtin", {
    apiKey: "new-key",
    clearBaseUrl: true,
  });
  assert.deepEqual(result, { warnings: ["BUILTIN_BASE_URL: clear failed"] });
});

// 串行执行便于定位失败用例，并让每个用例独占其假 dashboard 生命周期。
async function main() {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(`      ${err?.stack || err}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
