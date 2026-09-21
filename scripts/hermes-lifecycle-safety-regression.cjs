#!/usr/bin/env node
"use strict";

// BUG-001 / BUG-010 定向回归：真实新 spawn 的身份检查、start 单飞、
// stop/reconfigure 的代际写屏障，以及尚未登记进 dashboards 的子进程回收。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPids(file) {
  let last = "";
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      last = fs.readFileSync(file, "utf8").trim();
      const pids = last.split(/\s+/).map(Number);
      if (pids.length >= 2 && pids.every((pid) => Number.isInteger(pid) && pid > 0)) return pids;
    } catch { /* child has not written it yet */ }
    await sleep(5);
  }
  throw new Error(`fake child did not publish pid: ${file}; content=${JSON.stringify(last)}`);
}

async function waitForPid(file) {
  return (await waitForPids(file))[0];
}

async function waitForDead(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (err) {
      if (err?.code === "ESRCH") return true;
    }
    await sleep(5);
  }
  return false;
}

function pointFakeBin(fakeBin, pidFile) {
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh\n/bin/sleep 10000 &\nchild=$!\necho "$$ $child" > '${pidFile}'\nwait "$child"\n`,
    { mode: 0o700 },
  );
}

function fakeProc() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.kill = () => {
    if (proc.killed) return;
    proc.killed = true;
    proc.signalCode = "SIGTERM";
    queueMicrotask(() => proc.emit("exit", null, "SIGTERM"));
  };
  proc.unref = () => {};
  return proc;
}

function makeBackend(home, bin = process.execPath) {
  process.env.HERMES_HOME = home;
  delete require.cache[require.resolve("../app/core/hermes-backend.js")];
  const { HermesBackend } = require("../app/core/hermes-backend.js");
  const be = new HermesBackend({
    bin,
    getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }),
  });
  be.refreshSessions = async () => [];
  be.refreshModelChoices = async () => [];
  be._refreshAgentsFor = async () => {
    be.profileById = new Map([["hermes-default", "default"]]);
    be.agents = [{ id: "hermes-default", name: "default" }];
  };
  return be;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-lifecycle-safety-"));
  const fakeBin = path.join(home, "fake-hermes.cjs");
  try {
    // 真正进入 _spawnDashboard 的成功分支；旧代码会调用已经删除的方法并抛 TypeError。
    {
      const pidFile = path.join(home, "success.pid");
      pointFakeBin(fakeBin, pidFile);
      const be = makeBackend(home, fakeBin);
      be._waitForDashboard = async () => {
        await waitForPid(pidFile);
        return true;
      };
      be._dashboardIdentity = async () => ({ home, version: "test" });
      let dash = null;
      let error = null;
      try {
        dash = await be._spawnDashboard("default", 65520);
      } catch (err) {
        error = err;
      }
      check("新 spawn 使用现存身份探针，不调用 stale helper", !!dash && !error, error?.message);
      const [pid, helperPid] = await waitForPids(pidFile);
      if (dash) be.dashboards.set("default", dash);
      await be.stop();
      check("成功分支 stop 回收 detached 进程组", await waitForDead(pid) && await waitForDead(helperPid));
    }

    // 可证明的身份不匹配必须 fail-closed，并回收刚 spawn 的真实子进程。
    {
      const pidFile = path.join(home, "mismatch.pid");
      pointFakeBin(fakeBin, pidFile);
      const be = makeBackend(home, fakeBin);
      be._waitForDashboard = async () => {
        await waitForPid(pidFile);
        return true;
      };
      be._dashboardIdentity = async () => ({ home: path.join(home, "other"), version: "test" });
      const dash = await be._spawnDashboard("default", 65521);
      const [pid, helperPid] = await waitForPids(pidFile);
      check("identity mismatch 拒绝登记 dashboard", dash === null);
      check("identity mismatch 回收真实 spawned 进程组", await waitForDead(pid) && await waitForDead(helperPid));
    }

    // ready timeout 与探针异常都不能把局部 child 留成孤儿。
    {
      const pidFile = path.join(home, "timeout.pid");
      pointFakeBin(fakeBin, pidFile);
      const be = makeBackend(home, fakeBin);
      be._waitForDashboard = async () => {
        await waitForPid(pidFile);
        return false;
      };
      const dash = await be._spawnDashboard("default", 65522);
      const [pid, helperPid] = await waitForPids(pidFile);
      check("ready timeout 返回未就绪", dash === null);
      check("ready timeout 回收真实 spawned 进程组", await waitForDead(pid) && await waitForDead(helperPid));
    }
    {
      const pidFile = path.join(home, "exception.pid");
      pointFakeBin(fakeBin, pidFile);
      const be = makeBackend(home, fakeBin);
      be._waitForDashboard = async () => {
        await waitForPid(pidFile);
        throw new Error("probe exploded");
      };
      let error = null;
      await be._spawnDashboard("default", 65523).catch((err) => { error = err; });
      const [pid, helperPid] = await waitForPids(pidFile);
      check("ready 探针异常向上传播", error?.message === "probe exploded");
      check("ready 探针异常回收真实 spawned 进程组", await waitForDead(pid) && await waitForDead(helperPid));
    }

    // 同一代际的并发 start 必须共享一次启动。
    {
      const be = makeBackend(home);
      const gate = deferred();
      let calls = 0;
      be._spawnOrReuseDashboard = async () => {
        calls += 1;
        await gate.promise;
        return { profile: "default", baseUrl: "http://test", token: "t", proc: null, spawned: false };
      };
      const first = be.start();
      const second = be.start();
      await tick();
      check("并发 start 单飞", calls === 1, `spawn=${calls}`);
      gate.resolve();
      const [a, b] = await Promise.all([first, second]);
      check("单飞调用得到同一成功结果", a === true && b === true);
      await be.stop();
    }

    // stop 发生后，旧 start 的迟到 dashboard 不能回写，且其进程必须被回收。
    {
      const be = makeBackend(home);
      const gate = deferred();
      const proc = fakeProc();
      be._spawnOrReuseDashboard = async () => {
        await gate.promise;
        return { profile: "default", baseUrl: "http://old", token: "old", proc, spawned: true };
      };
      const starting = be.start();
      await tick();
      await be.stop();
      gate.resolve();
      const ready = await starting;
      check("stop 后旧 start 返回未就绪", ready === false);
      check("stop 后迟到 dashboard 不回写", be.dashboards.size === 0 && be.sessionsRefreshTimer === null);
      check("stop 后迟到 dashboard 子进程被杀", proc.killed === true);
    }

    // pending 子进程尚未进入 dashboards 时也属于 stop 的回收范围。
    {
      const be = makeBackend(home);
      const proc = fakeProc();
      be._pendingDashboardProcs?.add(proc);
      await be.stop();
      check("stop 回收 pending dashboard 子进程", proc.killed === true);
    }

    // reconfigure 可在旧启动未完成时开启新代际，旧结果不得覆盖新拓扑。
    {
      const be = makeBackend(home);
      const oldGate = deferred();
      const oldProc = fakeProc();
      let calls = 0;
      be._spawnOrReuseDashboard = async () => {
        calls += 1;
        if (calls === 1) {
          await oldGate.promise;
          return { profile: "default", baseUrl: "http://old", token: "old", proc: oldProc, spawned: true };
        }
        return { profile: "default", baseUrl: "http://new", token: "new", proc: null, spawned: false };
      };
      const oldStart = be.start();
      await tick();
      const reconfigured = await be.reconfigure();
      oldGate.resolve();
      const oldReady = await oldStart;
      check("reconfigure 启动新代际", reconfigured === true && be.dashboards.get("default")?.baseUrl === "http://new");
      check("旧代际完成后不覆盖新 dashboard", oldReady === false && be.dashboards.get("default")?.baseUrl === "http://new");
      check("旧代际迟到进程被杀", oldProc.killed === true);
      await be.stop();
    }
  } finally {
    delete process.env.HERMES_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }

  const failed = results.filter((row) => !row.pass).length;
  console.log(`RESULT ${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
