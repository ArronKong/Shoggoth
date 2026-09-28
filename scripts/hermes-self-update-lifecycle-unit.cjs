#!/usr/bin/env node
"use strict";

// Hermes 自更新的本地 dashboard 生命周期：
//   1) `hermes update` 启动前先停掉本地 dashboard（官方 update 会清理/判定仍在跑
//      旧代码的 dashboard，其它 profile 的会被当成幸存者 → exit 1）；
//   2) 更新失败也要把 dashboard 拉回来；
//   3) 更新后作废缓存的 CLI 版本，版本守卫才会拿新版本比对。
// 运行：node scripts/hermes-self-update-lifecycle-unit.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function waitDone(backend, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (backend.getSelfUpdateStatus().status.running) {
    if (Date.now() > deadline) throw new Error("self-update did not settle in time");
    await new Promise((r) => setTimeout(r, 20));
  }
  return backend.getSelfUpdateStatus().status;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-self-update-"));
  process.env.HOME = home;
  const { HermesBackend } = require("../app/core/hermes-backend.js");

  // 假 hermes：记下 update 运行时 dashboard 是否还登记着，按 exit code 退出。
  const makeBackend = (exitCode) => {
    const events = [];
    const be = new HermesBackend({ bin: process.execPath, getConfig: () => ({ hermesMode: "local" }) });
    be._selfUpdater._command = () => ({ cmd: process.execPath, args: ["-e", `process.exit(${exitCode})`] });
    be.dashboards.set("default", { profile: "default", port: 9119, spawned: true, proc: null });
    be.dashboards.set("work", { profile: "work", port: 9120, spawned: false, proc: null });
    be._cliVersionPromise = Promise.resolve("0.1.0");
    const origStop = be.stop.bind(be);
    be.stop = async (...args) => {
      events.push(`stop:${be.dashboards.size}`);
      return origStop(...args);
    };
    be._reapStaleDashboard = async (port, profile, why) => {
      events.push(`reap:${profile}:${port}:${why}`);
      return true;
    };
    be.start = async () => {
      events.push(`start:cliCache=${be._cliVersionPromise === null ? "cleared" : "stale"}`);
      return true;
    };
    return { be, events };
  };

  {
    const { be, events } = makeBackend(0);
    const started = be.runSelfUpdate();
    check("本地模式支持自更新", started.supported === true && started.status.running === true);
    const s = await waitDone(be);
    check("成功终态", s.ok === true && s.exitCode === 0, JSON.stringify(s));
    check("update 前停掉自己的 dashboard", events[0] === "stop:2", events.join(","));
    check("update 前回收可证明归属的复用 dashboard", events[1] === "reap:work:9120:self-update", events.join(","));
    check("update 后重启并作废 CLI 版本缓存", events.slice(-1)[0] === "start:cliCache=cleared", events.join(","));
  }

  {
    const { be, events } = makeBackend(1);
    be.runSelfUpdate();
    const s = await waitDone(be);
    check("失败终态保留退出码", s.ok === false && s.exitCode === 1 && !s.postUpdateError, JSON.stringify(s));
    check("失败后仍把 dashboard 拉回来", events.slice(-1)[0] === "start:cliCache=cleared", events.join(","));
  }

  {
    const be = new HermesBackend({ bin: process.execPath, getConfig: () => ({ hermesMode: "remote" }) });
    check("remote 模式不支持自更新", be.runSelfUpdate().supported === false);
  }

  fs.rmSync(home, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(`RESULT ${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
