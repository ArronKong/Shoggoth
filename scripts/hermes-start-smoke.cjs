#!/usr/bin/env node
"use strict";

// Hermes 启动路径回归：并行拉起 / 端口映射稳定 / 分批就绪广播 / 保活开关。
//
// 为什么单独一个脚本：crud/proxy smoke 打的都是「已经起好的后端」，覆盖不到
// start() 与 stop() 本身的时序和进程生命周期，而这两处正是 R289/R290 改的地方。
//
// 零副作用：_spawnOrReuseDashboard 等全部 stub，不 spawn 任何真进程、不碰用户的
// ~/.hermes（HERMES_HOME 指向临时目录）、不动端口。

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` -> ${detail}` : ""}`);
};

const SLOW_MS = 200; // 模拟单个 dashboard 的冷启动
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 临时 HERMES_HOME：profiles/ 下放 4 个 named profile，形状与真机一致。
function makeHome(withProfiles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-start-smoke-"));
  if (withProfiles) {
    for (const p of ["owl", "bull", "horse", "coder"]) {
      fs.mkdirSync(path.join(home, "profiles", p), { recursive: true });
    }
    // 点开头的目录必须被忽略（不是 profile）
    fs.mkdirSync(path.join(home, "profiles", ".cache"), { recursive: true });
  }
  return home;
}

// backend 实例 + 全套 stub。返回 { be, calls, publishes }。
function makeBackend() {
  delete require.cache[require.resolve("../app/core/hermes-backend.js")];
  const { HermesBackend } = require("../app/core/hermes-backend.js");
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  const t0 = Date.now();
  const calls = []; // { profile, port, startedAt, finishedAt }
  const publishes = [];

  be._spawnOrReuseDashboard = async (profile, port) => {
    const call = { profile, port, startedAt: Date.now() - t0 };
    calls.push(call);
    await sleep(SLOW_MS);
    call.finishedAt = Date.now() - t0;
    return { profile, port, baseUrl: `http://127.0.0.1:${port}`, token: "t", proc: null, spawned: false };
  };
  // 权威列表：带 model/provider，且顺序与 /api/profiles 一致（default 在前）。
  be._refreshAgentsFor = async () => {
    be._installProfileRows(["default", "bull", "coder", "horse", "owl"].map((p) => ({
      name: p,
      model: `model-${p}`,
      provider: "xm",
    })));
  };
  be.refreshSessions = async () => [];
  be.refreshModelChoices = async () => [];
  be.getAgents = () => be.agents;

  const start = (hooks) => be.start(hooks);
  return { be, calls, publishes, start, elapsed: () => Date.now() - t0 };
}

function fakeProc() {
  const p = new EventEmitter();
  p.exitCode = null;
  p.signalCode = null;
  p.killed = false;
  p.unrefed = false;
  p.kill = () => {
    p.killed = true;
    p.exitCode = 0;
    queueMicrotask(() => p.emit("exit"));
  };
  p.unref = () => { p.unrefed = true; };
  return p;
}

(async () => {
  const homes = [];
  try {
    // --- 1. 并行拉起 -------------------------------------------------------
    console.log("--- 并行拉起（磁盘预测 profile 名单） ---");
    {
      const home = makeHome(true);
      homes.push(home);
      process.env.HERMES_HOME = home;
      const { be, calls, start, elapsed } = makeBackend();
      const publishes = [];
      const publishCompleteness = [];
      ok(
        "启动前会话快照非权威",
        be.getSessionRowsSnapshot?.().complete === false,
      );
      const okStart = await start({
        onPartialReady: () => {
          publishes.push(elapsed());
          publishCompleteness.push(be.getSessionRowsSnapshot?.().complete);
        },
      });
      const total = elapsed();
      if (be.sessionsRefreshTimer) clearInterval(be.sessionsRefreshTimer);

      ok("start() 成功", okStart === true);
      ok("5 个 profile 全部拉起", calls.length === 5, `${calls.map((c) => c.profile).join(",")}`);
      ok(
        "Agent 展示名只保留 profile 名",
        JSON.stringify(be.agents.map((agent) => agent.name)) === JSON.stringify(["default", "bull", "coder", "horse", "owl"]),
        JSON.stringify(be.agents.map((agent) => agent.name)),
      );
      // 核心断言：全部在第一波并行开始，没有谁在等 default 就绪。
      const maxStart = Math.max(...calls.map((c) => c.startedAt));
      ok("所有 spawn 都在第一波并行开始（不等 default）", maxStart < SLOW_MS, `最晚起步 ${maxStart}ms`);
      ok("总时长 ≈ 单波而非两波", total < SLOW_MS * 2, `${total}ms < ${SLOW_MS * 2}ms`);
      // 端口映射：default=startPort，其余按名单序递增。跨启动稳定才复用得上，
      // 错位会让复用全线落空、进程翻倍。
      const ports = Object.fromEntries(calls.map((c) => [c.profile, c.port]));
      ok(
        "端口映射按名单序稳定分配",
        ports.default === 9119 && ports.bull === 9120 && ports.coder === 9121 && ports.horse === 9122 && ports.owl === 9123,
        JSON.stringify(ports),
      );
      ok("点开头目录不算 profile", !calls.some((c) => c.profile.startsWith(".")));
      // 分批广播（R289）：每个就绪一次，不是攒到最后一次性发。
      ok("分批广播 ≥2 次", publishes.length >= 2, `${publishes.length} 次`);
      ok(
        "分批 ready 期间会话快照仍非权威",
        publishCompleteness.length > 0 && publishCompleteness.every((complete) => complete === false),
        JSON.stringify(publishCompleteness),
      );
      ok("start 完成后会话快照转为权威", be.getSessionRowsSnapshot?.().complete === true);
      ok("权威校正后 agent 带上 model", be.agents.every((a) => a.model), be.agents.map((a) => a.model).join(","));
    }

    // --- 2. 最终权威快照必须晚于全部 partial refresh -----------------------
    console.log("--- 分批刷新尾部竞态 ---");
    {
      const home = makeHome(true);
      homes.push(home);
      process.env.HERMES_HOME = home;
      const { be, start } = makeBackend();
      const delays = { default: 10, bull: 35, coder: 45, horse: 55, owl: 65 };
      be._spawnOrReuseDashboard = async (profile, port) => {
        await sleep(delays[profile]);
        return { profile, port, baseUrl: `http://127.0.0.1:${port}`, token: "t", proc: null, spawned: false };
      };
      be.refreshSessions = async () => {
        const profiles = [...be.dashboards.keys()];
        // 第一批故意比最终全量刷新更晚返回，复现旧 partial 覆盖新 full 的竞态。
        await sleep(profiles.length === 1 ? 120 : 2);
        be.sessionRows = profiles.map((profile) => ({ key: `agent:hermes-${profile}:main` }));
        return be.sessionRows;
      };
      const published = [];
      const okStart = await start({
        onPartialReady: () => published.push(be.getSessionRowsSnapshot?.()),
      });
      await sleep(140);
      if (be.sessionsRefreshTimer) clearInterval(be.sessionsRefreshTimer);
      ok("尾部竞态场景 start() 成功", okStart === true);
      ok(
        "任何 partial 广播都不能把局部行标成权威",
        published.every((snapshot) => snapshot?.complete === false || snapshot?.rows?.length === 5),
        published.map((snapshot) => `${snapshot?.rows?.length}:${snapshot?.complete}`).join(","),
      );
      ok("最终权威快照包含全部 profile", be.getSessionRowsSnapshot?.().complete === true && be.sessionRows.length === 5);
    }

    // --- 3. 串行 fallback --------------------------------------------------
    console.log("--- 串行 fallback（没有 profiles/ 目录） ---");
    {
      const home = makeHome(false);
      homes.push(home);
      process.env.HERMES_HOME = home;
      const { be, calls, start, elapsed } = makeBackend();
      const okStart = await start({ onPartialReady: () => {} });
      if (be.sessionsRefreshTimer) clearInterval(be.sessionsRefreshTimer);
      ok("start() 成功", okStart === true);
      // 串行路径：default 先起，其余等它就绪拿到名单后才起。
      const def = calls.find((c) => c.profile === "default");
      const others = calls.filter((c) => c.profile !== "default");
      ok("default 最先起", def && def.startedAt < SLOW_MS);
      ok(
        "其余 profile 等 default 就绪后才起",
        Boolean(def) && Number.isFinite(def.finishedAt)
          && others.every((call) => call.startedAt >= def.finishedAt),
        `${others.length} 个，default=${def?.finishedAt}ms，first=${Math.min(...others.map((call) => call.startedAt))}ms`,
      );
      ok("串行路径仍拉齐 5 个", calls.length === 5);
    }

    // --- 4. default 失败 = 后端失败 ---------------------------------------
    console.log("--- default 失败 ---");
    {
      process.env.HERMES_HOME = homes[0];
      const { be, start } = makeBackend();
      be._spawnOrReuseDashboard = async (profile, port) => {
        await sleep(10);
        if (profile === "default") {
          be.lastError = "模拟 default 起不来";
          return null;
        }
        return { profile, port, baseUrl: "", token: "t", proc: null, spawned: false };
      };
      const okStart = await start({ onPartialReady: () => {} });
      if (be.sessionsRefreshTimer) clearInterval(be.sessionsRefreshTimer);
      ok("default 失败 → start() 返回 false", okStart === false);
      ok("lastError 是 default 的原因", be.lastError === "模拟 default 起不来", be.lastError);
    }

    // --- 5. 保活开关（stop 的进程生命周期） --------------------------------
    console.log("--- 保活开关 ---");
    {
      process.env.HERMES_HOME = homes[0];
      const { be } = makeBackend();
      // 两个自己 spawn 的 + 一个复用来的（复用的本来就不在杀的范围内）
      const spawnedA = fakeProc();
      const spawnedB = fakeProc();
      be.dashboards.set("default", { profile: "default", proc: spawnedA, spawned: true });
      be.dashboards.set("bull", { profile: "bull", proc: spawnedB, spawned: true });
      be.dashboards.set("owl", { profile: "owl", proc: null, spawned: false });
      await be.stop({ keepProcesses: true });
      ok("keepProcesses 时不杀 spawn 的进程", !spawnedA.killed && !spawnedB.killed);
      ok("keepProcesses 时 unref（否则主进程不退）", spawnedA.unrefed && spawnedB.unrefed);
      ok("keepProcesses 时连接状态照旧清空", be.dashboards.size === 0 && be.sessionRows.length === 0);
      ok("stop 后会话快照恢复非权威", be.getSessionRowsSnapshot?.().complete === false);

      const { be: be2 } = makeBackend();
      const killA = fakeProc();
      be2.dashboards.set("default", { profile: "default", proc: killA, spawned: true });
      await be2.stop();
      ok("默认（无参）仍然真杀", killA.killed === true);

      const { be: be3 } = makeBackend();
      const killB = fakeProc();
      be3.dashboards.set("default", { profile: "default", proc: killB, spawned: true });
      await be3.stop({ keepProcesses: false });
      ok("显式 false 也真杀", killB.killed === true);
    }

    // --- 6. status 给出 profile 级精确 readiness ---------------------------
    console.log("--- profile 级 readiness ---");
    {
      process.env.HERMES_HOME = homes[0];
      const { be } = makeBackend();
      const profiles = ["default", "bull", "coder", "horse", "owl"];
      be.profileById = new Map(profiles.map((profile) => [`hermes-${profile}`, profile]));
      be.agents = profiles.map((profile) => ({ id: `hermes-${profile}`, name: profile }));
      be.dashboards = new Map(profiles.map((profile, index) => [
        profile,
        {
          profile,
          port: 9119 + index,
          baseUrl: `http://127.0.0.1:${9119 + index}`,
          token: `must-not-leak-${profile}`,
        },
      ]));
      let readyProfiles = new Set();
      be._getDashboardStatusSnapshot = async () => ({
        stale: false,
        generation: be._lifecycleGeneration,
        rows: profiles.map((profile, index) => ({
          profile,
          port: 9119 + index,
          baseUrl: `http://127.0.0.1:${9119 + index}`,
          connected: readyProfiles.has(profile),
        })),
      });

      be._startingAt = Date.now();
      const none = await be.getStatus();
      ok("无 profile ready 时保留 starting 语义", none.connected === false && none.info.starting === true);
      ok("无 profile ready 时 readiness 明确为空", Array.isArray(none.info.readyAgentIds) && none.info.readyAgentIds.length === 0);

      readyProfiles = new Set(["default", "owl"]);
      const partial = await be.getStatus();
      ok("任一 profile ready 时后端 connected 语义不变", partial.connected === true);
      ok(
        "partial status 只放行已可达 profile",
        JSON.stringify(partial.info.readyAgentIds) === JSON.stringify(["hermes-default", "hermes-owl"]),
        JSON.stringify(partial.info.readyAgentIds),
      );
      ok(
        "status 保留 dashboards[].baseUrl",
        partial.info.dashboards.every((row) => typeof row.baseUrl === "string" && row.baseUrl.startsWith("http://")),
      );
      ok("status 不泄漏 dashboard token", !JSON.stringify(partial).includes("must-not-leak"));

      readyProfiles = new Set(profiles);
      const final = await be.getStatus();
      ok(
        "最终 status readiness 包含全部五个 agent",
        JSON.stringify(final.info.readyAgentIds) === JSON.stringify(profiles.map((profile) => `hermes-${profile}`)),
        JSON.stringify(final.info.readyAgentIds),
      );
      ok(
        "readyAgentIds 只包含 agent id 字符串",
        Array.isArray(final.info.readyAgentIds)
          && final.info.readyAgentIds.every((id) => typeof id === "string" && /^hermes-[a-z0-9-]+$/.test(id)),
      );
    }

    // --- 7. status 单飞不能跨 lifecycle/dashboard 身份 --------------------
    console.log("--- status lifecycle 单飞隔离 ---");
    {
      process.env.HERMES_HOME = homes[0];
      const { be: stopped } = makeBackend();
      let resolveStoppedProbe;
      stopped._computeDashboardStatusRows = () => new Promise((resolve) => {
        resolveStoppedProbe = resolve;
      });
      stopped.profileById = new Map([["hermes-default", "default"]]);
      stopped.dashboards = new Map([[
        "default",
        { profile: "default", baseUrl: "http://stopped", token: "stopped" },
      ]]);
      let restartCalls = 0;
      stopped.start = async () => {
        restartCalls += 1;
        return true;
      };
      const stoppedStatusPromise = stopped.getStatus();
      await Promise.resolve();
      await stopped.stop();
      resolveStoppedProbe([{
        profile: "default",
        baseUrl: "http://stopped",
        port: 9119,
        connected: true,
      }]);
      const stoppedStatus = await stoppedStatusPromise;
      await Promise.resolve();
      ok(
        "local stop 后迟到 status fail closed 且不触发自愈重启",
        stoppedStatus.connected === false
          && stoppedStatus.info.readyAgentIds?.length === 0
          && restartCalls === 0,
        `restart=${restartCalls}`,
      );

      const { be } = makeBackend();
      be._getConfig = () => ({
        hermesMode: "remote",
        hermesRemotes: [{ profile: "default", baseUrl: "http://new", token: "new" }],
      });
      const deferred = [];
      be._computeDashboardStatusRows = (entries) => new Promise((resolve) => {
        deferred.push({ resolve, entries });
      });
      const oldDash = { profile: "default", baseUrl: "http://old", token: "old" };
      be.profileById = new Map([["hermes-default", "default"]]);
      be.dashboards = new Map([["default", oldDash]]);

      const staleStatusPromise = be.getStatus();
      await Promise.resolve();
      ok("旧 lifecycle status 探测已开始", deferred.length === 1);

      await be.stop();
      const newDash = { profile: "default", baseUrl: "http://new", token: "new" };
      be.profileById = new Map([["hermes-default", "default"]]);
      be.dashboards = new Map([["default", newDash]]);
      const currentStatusPromise = be.getStatus();
      await Promise.resolve();
      ok("新 lifecycle 不复用旧 status 单飞", deferred.length === 2, `${deferred.length} 次探测`);

      deferred[0].resolve([{
        profile: "default",
        baseUrl: "http://old",
        port: 9119,
        connected: true,
      }]);
      const staleStatus = await staleStatusPromise;
      ok(
        "旧 lifecycle connected 结果迟到后 fail closed",
        staleStatus.connected === false && staleStatus.info.readyAgentIds?.length === 0,
        JSON.stringify(staleStatus.info.readyAgentIds),
      );

      // 旧 promise 的 finally 不能清掉当前 lifecycle 的 in-flight，否则这里会发起
      // 第三次状态探测，破坏单飞并再次制造乱序窗口。
      const coalescedStatusPromise = be.getStatus();
      await Promise.resolve();
      ok("旧 promise finally 不清当前单飞", deferred.length === 2, `${deferred.length} 次探测`);
      for (let index = 1; index < deferred.length; index += 1) {
        deferred[index].resolve([{
          profile: "default",
          baseUrl: "http://new",
          port: 9120,
          connected: false,
        }]);
      }
      const [currentStatus, coalescedStatus] = await Promise.all([
        currentStatusPromise,
        coalescedStatusPromise,
      ]);
      ok(
        "新 lifecycle disconnected 结果不被旧同名 profile 放行",
        currentStatus.connected === false
          && currentStatus.info.readyAgentIds?.length === 0
          && coalescedStatus.info.readyAgentIds?.length === 0,
      );

      // 同一 lifecycle 内替换同名 dashboard 对象也必须换身份并开新探测；旧对象
      // 的 200 不能映射到新对象的同名 agent。
      const identityStart = deferred.length;
      const firstIdentityDash = { profile: "default", baseUrl: "http://identity-old", token: "old" };
      be.dashboards = new Map([["default", firstIdentityDash]]);
      const staleIdentityPromise = be.getStatus();
      await Promise.resolve();
      const secondIdentityDash = { profile: "default", baseUrl: "http://identity-new", token: "new" };
      be.dashboards = new Map([["default", secondIdentityDash]]);
      const currentIdentityPromise = be.getStatus();
      await Promise.resolve();
      ok(
        "同 lifecycle 的 dashboard 身份替换不复用旧单飞",
        deferred.length === identityStart + 2,
        `${deferred.length - identityStart} 次探测`,
      );
      deferred[identityStart].resolve([{
        profile: "default",
        baseUrl: firstIdentityDash.baseUrl,
        port: 9121,
        connected: true,
      }]);
      for (let index = identityStart + 1; index < deferred.length; index += 1) {
        deferred[index].resolve([{
          profile: "default",
          baseUrl: secondIdentityDash.baseUrl,
          port: 9122,
          connected: false,
        }]);
      }
      const [staleIdentity, currentIdentity] = await Promise.all([
        staleIdentityPromise,
        currentIdentityPromise,
      ]);
      ok(
        "旧 dashboard 身份的 200 迟到后 fail closed",
        staleIdentity.connected === false
          && staleIdentity.info.readyAgentIds?.length === 0
          && currentIdentity.info.readyAgentIds?.length === 0,
      );

      // token 续期/baseUrl 修正会原地修改 dashboard；仅比较对象引用仍会误用旧探测。
      const fieldStart = deferred.length;
      const mutableDash = { profile: "default", baseUrl: "http://field-old", token: "old" };
      be.dashboards = new Map([["default", mutableDash]]);
      const staleFieldPromise = be.getStatus();
      await Promise.resolve();
      mutableDash.baseUrl = "http://field-new";
      mutableDash.token = "new";
      const currentFieldPromise = be.getStatus();
      await Promise.resolve();
      ok(
        "同一 dashboard 对象的连接身份变化会开新探测",
        deferred.length === fieldStart + 2,
        `${deferred.length - fieldStart} 次探测`,
      );
      deferred[fieldStart].resolve([{
        profile: "default",
        baseUrl: "http://field-old",
        port: 9123,
        connected: true,
      }]);
      for (let index = fieldStart + 1; index < deferred.length; index += 1) {
        deferred[index].resolve([{
          profile: "default",
          baseUrl: "http://field-new",
          port: 9124,
          connected: false,
        }]);
      }
      const [staleField, currentField] = await Promise.all([
        staleFieldPromise,
        currentFieldPromise,
      ]);
      ok(
        "旧连接字段的 200 迟到后 fail closed",
        staleField.connected === false
          && staleField.info.readyAgentIds?.length === 0
          && currentField.info.readyAgentIds?.length === 0,
      );
    }

    // --- 8. dashboard token 401 自愈（_dashGet / _renewDashToken） ----------
    // dash.token 只在 start() 抓一次；dashboard 中途换进程后 token 就废了，
    // 全部读路径 401 → 模型目录整体 503，而 dashboard 本身是健康的。
    // 这里用一个真的 HTTP server 当假 dashboard（临时端口，零副作用）。
    console.log("--- token 401 自愈 ---");
    {
      process.env.HERMES_HOME = homes[0];
      const state = { token: "token-v2", home: homes[0], indexHits: 0 };
      const server = http.createServer((req, res) => {
        const json = (code, obj) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.url === "/") {
          state.indexHits += 1;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<script>window.__HERMES_SESSION_TOKEN__="${state.token}";</script>`);
          return;
        }
        if ((req.headers.authorization || "").replace(/^Bearer /, "") !== state.token) {
          json(401, { detail: "Unauthorized" });
          return;
        }
        if (req.url === "/api/status") {
          json(200, { hermes_home: state.home, version: "0.19.0" });
          return;
        }
        json(200, { providers: {} });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      const GET = { timeoutMs: 5000 };
      try {
        const { be } = makeBackend();
        const dash = { profile: "default", port, baseUrl, token: "token-v1", proc: null, spawned: false };
        be.dashboards.set("default", dash);

        const res = await be._dashGet(dash, "/api/config", GET);
        ok("401 → 续期后重试拿到 200", res.status === 200, `status=${res.status}`);
        ok("dash.token 就地续期", dash.token === "token-v2", dash.token);

        const hits = state.indexHits;
        await be._dashGet(dash, "/api/config", GET);
        ok("token 有效时不去探首页", state.indexHits === hits);

        // 端口被另一个 profile 的 dashboard 占走：换 token 就能读到——但读的是
        // 别人的配置。身份不符必须拒绝续期，宁可返回 401。
        state.token = "token-v3";
        state.home = path.join(homes[0], "profiles", "someone-else");
        dash.token = "token-stale";
        const crossed = await be._dashGet(dash, "/api/config", GET);
        ok(
          "hermes_home 不符 → 拒绝续期、原样返回 401",
          crossed.status === 401 && dash.token === "token-stale",
          `${crossed.status} / ${dash.token}`,
        );

        // 多条读路径同时撞 401 时只探一次首页。
        state.home = homes[0];
        state.token = "token-v4";
        dash.token = "token-stale-2";
        const before = state.indexHits;
        const all = await Promise.all([
          be._dashGet(dash, "/api/config", GET),
          be._dashGet(dash, "/api/model/options", GET),
          be._dashGet(dash, "/api/env", GET),
        ]);
        ok("三路并发 401 只探一次首页（单飞）", state.indexHits - before === 1, `探了 ${state.indexHits - before} 次`);
        ok("并发续期后三路全部 200", all.every((r) => r.status === 200));

        // 续期后单飞表要清空，否则下一次失效就再也续不上了。
        ok("单飞表已释放", be._tokenRenewals.size === 0);
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  } finally {
    delete process.env.HERMES_HOME;
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  }

  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
