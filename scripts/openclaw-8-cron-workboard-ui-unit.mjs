#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireFromUi = createRequire(path.join(uiRoot, "package.json"));
const esbuild = requireFromUi("esbuild");

async function compile(relativePath, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoggoth-openclaw8-ui-${name}-`));
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, relativePath)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  return { mod: createRequire(outfile)(outfile), dir };
}

const cron = await compile("app/manage-ui/src/pages/cron/runPresentation.ts", "cron-run");
const workboard = await compile("app/manage-ui/src/pages/workboard/model.ts", "workboard");
const cronForm = await compile("app/manage-ui/src/pages/cron/OpenClawCronForm.tsx", "cron-form");
try {
  const run = {
    status: "error",
    completionStatus: "succeeded",
    deliveryStatus: "not-delivered",
    deliveryError: "channel offline",
  };
  assert.deepEqual(cron.mod.cronExecutionView(run), {
    value: "succeeded",
    tone: "success",
  }, "执行成功不能被送达失败改写");
  assert.deepEqual(cron.mod.cronDeliveryView(run), {
    value: "not-delivered",
    tone: "warning",
    detail: "channel offline",
  }, "送达失败必须作为独立结果展示");

  for (const schedule of [
    { kind: "on-exit", command: "npm test", cwd: "/tmp/project" },
    {
      kind: "stream",
      command: ["tail", "-f", "events.log"],
      cwd: "/tmp/project",
      mode: "match",
      match: "READY",
      batchMs: 250,
      maxBatchBytes: 4096,
    },
  ]) {
    const draft = cronForm.mod.openClawDraftFromJob({
      id: `job-${schedule.kind}`,
      backendId: "openclaw",
      name: schedule.kind,
      enabled: true,
      schedule,
    });
    assert.deepEqual(cronForm.mod.openClawInputFromDraft(draft).schedule, schedule,
      `${schedule.kind} schedule 编辑往返必须保真`);
  }

  const emptyOnExit = { ...cronForm.mod.emptyOpenClawDraft(), schedKind: "on-exit", onExitCommand: "  " };
  assert.equal(cronForm.mod.validateOpenClawDraft(emptyOnExit), "cronForm.openclawValidateOnExitCommand");
  const emptyStream = { ...cronForm.mod.emptyOpenClawDraft(), schedKind: "stream", streamCommand: "\n  \n" };
  assert.equal(cronForm.mod.validateOpenClawDraft(emptyStream), "cronForm.openclawValidateStreamCommand");
  assert.equal(cronForm.mod.validateOpenClawDraft({ ...emptyStream, streamCommand: "tail\n-f\nevents.log" }), null);

  const task = {
    id: "task-1",
    taskId: "task-1",
    status: "completed",
    terminalOutcome: "blocked",
    deliveryStatus: "failed",
    runtime: "codex",
    startedAt: 100,
    endedAt: 200,
  };
  const card = {
    id: "card-1",
    title: "Card",
    status: "blocked",
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    lifecycle: { state: "failed", session: null, task },
  };
  assert.equal(workboard.mod.taskConsistent(task, "failed"), true,
    "completed+blocked 必须与 blocked lifecycle 一致");
  assert.equal(workboard.mod.taskStatusKey(task), "taskOutcome_blocked",
    "completed+blocked 必须显示 blocked，而不是普通 completed");
  assert.equal(workboard.mod.taskResultNotDelivered(task), true);
  assert.equal(workboard.mod.lifecycleOf(card).state, "failed",
    "送达失败提示不能改写服务端执行 lifecycle");
  const t = (key) => key;
  assert.equal(
    workboard.mod.cardBadges(card, t).some((badge) => badge.text === "tasks.wb.taskResultNotDelivered" && badge.warning),
    true,
    "deliveryStatus=failed 必须只追加结果未送达提示",
  );
  const deliveredFailedTask = { ...task, terminalOutcome: "succeeded" };
  const deliveredFailedCard = {
    ...card,
    status: "review",
    lifecycle: { state: "succeeded", session: null, task: deliveredFailedTask },
  };
  assert.equal(workboard.mod.taskConsistent(deliveredFailedTask, "succeeded"), true);
  assert.equal(workboard.mod.lifecycleOf(deliveredFailedCard).state, "succeeded",
    "deliveryStatus=failed 不能把成功执行改成失败或 blocked");
  assert.equal(
    workboard.mod.cardBadges(deliveredFailedCard, t)
      .some((badge) => badge.text === "tasks.wb.taskResultNotDelivered"),
    true,
    "成功执行后的送达失败仍需独立提示",
  );

  const runPanel = fs.readFileSync(path.join(uiRoot, "src/pages/cron/CronRunHistoryPanel.tsx"), "utf8");
  assert.match(runPanel, /data-outcome="execution"/);
  assert.match(runPanel, /data-outcome="delivery"/);
  assert.ok(runPanel.indexOf('data-outcome="execution"') < runPanel.indexOf('data-outcome="delivery"'),
    "运行历史必须先显示执行结果，再独立显示送达结果");
  assert.doesNotMatch(runPanel, /backendId\s*===/,
    "运行结果展示不能按 backend id 特判");

  const workboardView = fs.readFileSync(path.join(uiRoot, "src/pages/workboard/WorkboardView.tsx"), "utf8");
  assert.match(workboardView, /taskStatusKey\(taskLine\)/,
    "Workboard 卡片必须消费 terminalOutcome-aware 状态文案");
  assert.match(workboardView, /taskResultNotDelivered/,
    "Workboard 必须把送达失败显示成独立提示");
  assert.doesNotMatch(workboardView, /backendId\s*===/,
    "Workboard 8.1 状态展示不能按 backend id 特判");
} finally {
  fs.rmSync(cron.dir, { recursive: true, force: true });
  fs.rmSync(workboard.dir, { recursive: true, force: true });
  fs.rmSync(cronForm.dir, { recursive: true, force: true });
}

console.log("openclaw 8 cron/workboard UI: PASS");
