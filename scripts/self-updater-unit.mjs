#!/usr/bin/env node
// SelfUpdater 状态落盘（2026-07-14 事故复盘）：
//   1) 终态必须落盘，app 重启后 status() 仍能报告上次结果（不再是纯内存态）；
//   2) 磁盘残留 running:true（更新进行中 app 退出）→ 恢复成 interrupted 失败终态；
//   3) onSuccess（更新收尾健康检查）抛错 → ok=false + postUpdateError，
//      不再是「ok:true 但服务其实没起来」。
// 运行：node scripts/self-updater-unit.mjs

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { SelfUpdater } = require("../app/core/self-updater.js");

const results = [];
const check = (name, ok) => results.push({ name, ok });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-updater-unit-"));
const statePath = (name) => path.join(tmpDir, `${name}.json`);
const node = (script) => () => ({ cmd: process.execPath, args: ["-e", script] });

async function waitDone(updater, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (updater.status().running) {
    if (Date.now() > deadline) throw new Error("updater did not settle in time");
    await new Promise((r) => setTimeout(r, 40));
  }
  return updater.status();
}

// 1) 无 statePath：原行为不变（纯内存，成功终态）。
{
  const u = new SelfUpdater({ command: node("console.log('ok')") });
  u.run();
  const s = await waitDone(u);
  check("无 statePath 成功终态", s.ok === true && s.exitCode === 0 && !s.running);
}

// 2) 成功终态落盘：内存与磁盘一致。
{
  const file = statePath("success");
  const u = new SelfUpdater({ command: node("console.log('hello-tail')"), statePath: file });
  u.run();
  const s = await waitDone(u);
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  check("成功终态写入磁盘", disk.ok === true && disk.exitCode === 0 && disk.running === false);
  check("logTail 落盘", String(disk.logTail || "").includes("hello-tail"));
  check("内存与磁盘一致", s.finishedAt === disk.finishedAt && s.startedAt === disk.startedAt);

  // 3) 新实例（模拟 app 重启）恢复上次终态。
  const revived = new SelfUpdater({ command: node(""), statePath: file });
  const r = revived.status();
  check("重启后恢复上次终态", r.ok === true && r.finishedAt === disk.finishedAt && !r.running);
}

// 4) 磁盘残留 running:true → interrupted 失败终态，并回写磁盘。
{
  const file = statePath("interrupted");
  fs.writeFileSync(file, JSON.stringify({ running: true, startedAt: 123, command: "x update" }));
  const u = new SelfUpdater({ command: node(""), statePath: file });
  const s = u.status();
  check(
    "running 残留判 interrupted",
    s.running === false && s.ok === false && s.interrupted === true && s.startedAt === 123,
  );
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  check("interrupted 终态回写磁盘", disk.interrupted === true && disk.running === false);
  check("interrupted 后可再 run", u.run().running === true);
  await waitDone(u);
}

// 5) 命令成功但 onSuccess（健康检查）抛错 → ok=false + postUpdateError。
{
  const file = statePath("post-fail");
  let sawState = null;
  const u = new SelfUpdater({
    command: node("console.log('updated')"),
    statePath: file,
    onSuccess: (state) => {
      sawState = state;
      throw new Error("gateway not ready after update: Reason X");
    },
  });
  u.run();
  const s = await waitDone(u);
  check(
    "onSuccess 抛错翻 ok=false",
    s.ok === false && s.exitCode === 0 && String(s.postUpdateError).includes("gateway not ready"),
  );
  check("onSuccess 收到本轮状态", !!sawState && sawState.startedAt === s.startedAt);
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  check("收尾失败终态落盘", disk.ok === false && disk.exitCode === 0 && !!disk.postUpdateError);
}

// 6) 命令失败：exitCode 非 0，onSuccess 不触发。
{
  let ran = false;
  const u = new SelfUpdater({
    command: node("process.exit(3)"),
    statePath: statePath("cmd-fail"),
    onSuccess: () => { ran = true; },
  });
  u.run();
  const s = await waitDone(u);
  check("命令失败 ok=false exitCode=3", s.ok === false && s.exitCode === 3);
  check("命令失败不跑收尾", ran === false);
}

// 7) 状态文件损坏：静默从头开始，不抛。
{
  const file = statePath("corrupt");
  fs.writeFileSync(file, "{not json");
  const u = new SelfUpdater({ command: node(""), statePath: file });
  check("损坏状态文件降级为空", u.status().running === false && u.status().ok === undefined);
}

// 8) 超龄但仍存活的 detached 更新进程必须继续占有单飞锁。HARD_TIMEOUT 的
// 定时器属于旧 app，app 退出后不能把“年龄”误当成进程已经死亡并启动第二轮。
{
  const file = statePath("stale-live");
  fs.writeFileSync(file, JSON.stringify({
    running: true,
    pid: process.pid,
    startedAt: Date.now() - 24 * 60 * 60 * 1000,
    command: "redacted update",
  }));
  let commandCalls = 0;
  const u = new SelfUpdater({
    command: () => {
      commandCalls += 1;
      return { cmd: process.execPath, args: ["-e", ""] };
    },
    statePath: file,
  });
  const adopted = u.status();
  const rerun = u.run();
  check("超龄 live orphan 仍保持 running", adopted.running === true && rerun.running === true);
  check("超龄 live orphan 阻止第二次更新", commandCalls === 0);
  check("超龄 live orphan 状态可诊断", adopted.staleLive === true);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
