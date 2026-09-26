#!/usr/bin/env node
"use strict";

// Hermes 历史缓存 scope 契约：scope 必须由主进程按真实数据源生成，只公开摘要，
// 且读取路径不能等待 dashboard 状态探测。全部夹具使用临时目录与内存配置。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { HermesBackend } = require("../app/core/hermes-backend");
const { startStaticServer } = require("../app/static-server");

function requestJson(method, url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let body = raw;
          try { body = JSON.parse(raw); } catch { /* 由断言报告非 JSON */ }
          resolve({ status: res.statusCode, body, raw });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function makeHermes(getConfig) {
  return new HermesBackend({ getConfig });
}

(async () => {
  const previousHome = process.env.HERMES_HOME;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cache-scope-"));
  const homeA = path.join(temp, "home-a");
  const homeB = path.join(temp, "home-b");
  const homeAlias = path.join(temp, "home-a-alias");
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
  fs.symlinkSync(homeA, homeAlias, "dir");

  try {
    class UnsupportedBackend extends AgentBackend {
      get id() { return "unsupported"; }
    }
    assert.equal(
      typeof new UnsupportedBackend().getChatCacheScope,
      "function",
      "AgentBackend 公开默认 cache-scope capability",
    );
    assert.equal(
      new UnsupportedBackend().getChatCacheScope(),
      null,
      "AgentBackend 默认不声明聊天历史缓存 scope",
    );

    process.env.HERMES_HOME = homeA;
    const localA = makeHermes(() => ({ hermesMode: "local", hermesRemotes: [] }));
    const localScopeA = localA.getChatCacheScope();
    const localScopeARepeated = localA.getChatCacheScope();
    assert.match(localScopeA, /^[0-9a-f]{64}$/, "local scope 是 SHA-256 hex");
    assert.equal(localScopeARepeated, localScopeA, "相同本地数据源重复读取稳定");

    process.env.HERMES_HOME = homeAlias;
    const localAlias = makeHermes(() => ({ hermesMode: "local", hermesRemotes: [] }));
    assert.equal(localAlias.getChatCacheScope(), localScopeA, "本地 home 以 realpath 解析，符号链接不换 scope");

    process.env.HERMES_HOME = homeB;
    const localB = makeHermes(() => ({ hermesMode: "local", hermesRemotes: [] }));
    assert.notEqual(localB.getChatCacheScope(), localScopeA, "不同本地 Hermes home 使用不同 scope");

    const remoteOne = [
      { profile: "owl", baseUrl: "https://owl.example.test/", token: "secret-owl-a" },
      { profile: "bull", baseUrl: "https://bull.example.test", token: "secret-bull" },
    ];
    const remoteReordered = [...remoteOne].reverse();
    const remoteTokenChanged = remoteOne.map((row) => (
      row.profile === "owl" ? { ...row, token: "secret-owl-b" } : row
    ));
    const remoteScopeA = makeHermes(() => ({ hermesMode: "remote", hermesRemotes: remoteOne }))
      .getChatCacheScope();
    const remoteScopeReordered = makeHermes(() => ({ hermesMode: "remote", hermesRemotes: remoteReordered }))
      .getChatCacheScope();
    const remoteScopeTokenB = makeHermes(() => ({ hermesMode: "remote", hermesRemotes: remoteTokenChanged }))
      .getChatCacheScope();
    assert.match(remoteScopeA, /^[0-9a-f]{64}$/, "remote scope 是 SHA-256 hex");
    assert.equal(remoteScopeReordered, remoteScopeA, "远程配置按 profile/baseUrl/token 排序后稳定");
    assert.notEqual(remoteScopeTokenB, remoteScopeA, "远程 token 变化会隔离旧历史");
    assert.notEqual(remoteScopeA, localScopeA, "local 与 remote 模式不会共享 scope");

    process.env.HERMES_HOME = homeA;
    let apiConfig = { hermesMode: "local", hermesRemotes: [] };
    const apiBackend = makeHermes(() => apiConfig);
    let statusReads = 0;
    apiBackend.getStatus = async () => {
      statusReads += 1;
      throw new Error("cache scope route must not call getStatus");
    };
    apiBackend._getDashboardStatusRows = async () => {
      statusReads += 1;
      throw new Error("cache scope route must not ping dashboards");
    };
    const registry = new BackendRegistry();
    registry.register(apiBackend);
    registry.register(new UnsupportedBackend());
    assert.deepEqual(registry.getChatCacheScope("hermes"), {
      backendId: "hermes",
      cacheScope: localScopeA,
    }, "registry 只转发 backend id 与摘要");
    assert.equal(registry.getChatCacheScope("missing"), null, "registry 对未知后端 fail closed");
    assert.equal(registry.getChatCacheScope("unsupported"), null, "registry 对未声明能力的后端 fail closed");

    const server = await startStaticServer(0, { registry });
    try {
      const first = await requestJson("GET", `${server.url}/__api/chat/cache-scope?backend=hermes`);
      const repeated = await requestJson("GET", `${server.url}/__api/chat/cache-scope?backend=hermes`);
      assert.equal(first.status, 200);
      assert.deepEqual(Object.keys(first.body).sort(), ["backendId", "cacheScope"]);
      assert.deepEqual(first.body, { backendId: "hermes", cacheScope: localScopeA });
      assert.deepEqual(repeated.body, first.body, "scope API 重复读取稳定");
      assert.equal(statusReads, 0, "scope API 不读取 status、不 ping dashboard");
      for (const secret of [homeA, homeB]) {
        assert.equal(first.raw.includes(secret), false, `响应不泄漏 ${secret}`);
      }

      apiConfig = { hermesMode: "remote", hermesRemotes: remoteOne };
      const remoteResponse = await requestJson("GET", `${server.url}/__api/chat/cache-scope?backend=hermes`);
      assert.deepEqual(remoteResponse.body, { backendId: "hermes", cacheScope: remoteScopeA });
      for (const secret of ["owl.example.test", "bull.example.test", "secret-owl-a", "secret-bull"]) {
        assert.equal(remoteResponse.raw.includes(secret), false, `远程响应不泄漏 ${secret}`);
      }
      assert.equal(statusReads, 0, "远程 scope API 同样不探测 dashboard");

      const unknown = await requestJson("GET", `${server.url}/__api/chat/cache-scope?backend=missing`);
      const unsupported = await requestJson("GET", `${server.url}/__api/chat/cache-scope?backend=unsupported`);
      const wrongMethod = await requestJson("POST", `${server.url}/__api/chat/cache-scope?backend=hermes`);
      assert.equal(unknown.status, 404, "未知后端 fail closed");
      assert.equal(unsupported.status, 404, "无 scope 能力的后端 fail closed");
      assert.equal(wrongMethod.status, 405, "scope API 只读");

      registry.setDisabledBackendsProvider(() => ["hermes"]);
      assert.equal(registry.getChatCacheScope("hermes"), null, "disabled backend registry fail closed");
      const disabled = await requestJson("GET", `${server.url}/__api/chat/cache-scope?backend=hermes`);
      assert.equal(disabled.status, 404, "disabled backend API fail closed");
      assert.equal(statusReads, 0, "disabled 路径也不探测 dashboard");
    } finally {
      await server.close();
    }

    console.log("chat cache scope API regression: PASS");
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
