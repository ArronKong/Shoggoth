#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const requireFromUi = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = requireFromUi("typescript");

const timelinePath = new URL("../app/manage-ui/src/lib/turnTimeline.ts", import.meta.url);
const javaScript = ts.transpileModule(fs.readFileSync(timelinePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: timelinePath.pathname,
}).outputText;
const timelineModule = { exports: {} };
vm.runInNewContext(javaScript, { exports: timelineModule.exports });
const { createTimeline, reduceTimeline, stepsFromParts, summarizeArgs } = timelineModule.exports;

const lifecycleStatuses = ["queued", "starting", "running", "inProgress", "waiting_approval", "completed"];
const idleTimeline = createTimeline();
for (const kind of lifecycleStatuses) {
  assert.equal(reduceTimeline(idleTimeline, { kind: "status", status: { kind, text: kind } }, 10), idleTimeline,
    `${kind} 不能生成上下文整理步骤、增加步数或产生空轨迹卡`);
}

let thinkingTimeline = reduceTimeline(createTimeline(), { kind: "thinking", text: "检查" }, 10);
for (const kind of lifecycleStatuses) {
  assert.equal(reduceTimeline(thinkingTimeline, { kind: "status", status: { kind, text: kind } }, 20), thinkingTimeline,
    `${kind} 不能封存或切断正在流式输出的思考段`);
}
thinkingTimeline = reduceTimeline(thinkingTimeline, { kind: "thinking", text: "检查代码" }, 30);
assert.equal(thinkingTimeline.steps.length, 1);
assert.equal(thinkingTimeline.steps[0].text, "检查代码");
thinkingTimeline = reduceTimeline(thinkingTimeline, { kind: "tool", toolCallId: "read-1", name: "read", phase: "start" }, 40);
thinkingTimeline = reduceTimeline(thinkingTimeline, { kind: "tool", toolCallId: "read-1", phase: "result", result: "code" }, 50);
thinkingTimeline = reduceTimeline(thinkingTimeline, { kind: "prompt", prompt: { kind: "approval", question: "继续？" } }, 60);
thinkingTimeline = reduceTimeline(thinkingTimeline, { kind: "error", message: "执行失败" }, 70);
assert.deepEqual(Array.from(thinkingTimeline.steps, (step) => step.kind), ["thinking", "tool", "prompt", "error"],
  "真实思考、工具调用、审批和错误必须继续显示");
assert.equal(thinkingTimeline.steps[1].output, "code");
assert.equal(thinkingTimeline.steps[3].status, "error");

let answerTimeline = reduceTimeline(createTimeline(), { kind: "delta", text: "回答" }, 10);
assert.equal(reduceTimeline(answerTimeline, { kind: "status", status: { kind: "running" } }, 20), answerTimeline,
  "运行状态不能把回答误封存成中间回复");
answerTimeline = reduceTimeline(answerTimeline, { kind: "final", text: "回答完成" }, 30);
assert.equal(answerTimeline.steps.length, 1);
assert.equal(answerTimeline.steps[0].text, "回答完成");

let compactionTimeline = reduceTimeline(createTimeline(), { kind: "status", status: { kind: "compacting", text: "正在压缩" } }, 10);
assert.equal(compactionTimeline.steps[0].status, "running");
assert.equal(reduceTimeline(compactionTimeline, { kind: "status", status: { kind: "running" } }, 20), compactionTimeline,
  "普通运行状态不能提前结束真正的上下文压缩");
const compactionId = compactionTimeline.steps[0].id;
compactionTimeline = reduceTimeline(compactionTimeline, { kind: "status", status: { kind: "compacting", text: "继续压缩" } }, 25);
assert.equal(compactionTimeline.steps.length, 1, "重复压缩进度不能增加步骤");
assert.equal(compactionTimeline.steps[0].id, compactionId);
assert.equal(compactionTimeline.steps[0].status, "running", "重复 compacting 不能误报完成");
assert.equal(compactionTimeline.steps[0].endTs, undefined);
assert.equal(compactionTimeline.steps[0].startTs, 10);
assert.equal(compactionTimeline.steps[0].text, "继续压缩");
compactionTimeline = reduceTimeline(compactionTimeline, { kind: "status", status: { kind: "compacted", text: "压缩完成" } }, 30);
assert.equal(compactionTimeline.steps.length, 1, "上下文压缩开始与完成仍合并为一个真实步骤");
assert.equal(compactionTimeline.steps[0].statusKind, "compacted");
assert.equal(compactionTimeline.steps[0].status, "ok");
assert.equal(compactionTimeline.steps[0].text, "压缩完成");
compactionTimeline = reduceTimeline(compactionTimeline, { kind: "status", status: { kind: "compacted" } }, 35);
assert.equal(compactionTimeline.steps.length, 1, "重复完成回执仍属于同一压缩步骤");
assert.equal(compactionTimeline.steps[0].id, compactionId);
assert.equal(compactionTimeline.steps[0].endTs, 30, "重复回执保留首次完成时刻");
assert.equal(compactionTimeline.steps[0].text, "压缩完成");
compactionTimeline = reduceTimeline(compactionTimeline, { kind: "status", status: { kind: "compacting" } }, 40);
assert.equal(compactionTimeline.steps.length, 2, "下一次压缩应创建独立步骤");
assert.equal(compactionTimeline.steps[0].status, "ok");
assert.equal(compactionTimeline.steps[1].status, "running");

// 记忆回忆与上下文压缩是同一类真实过程步骤，各自配对开始/完成，互不结束对方。
let recallTimeline = reduceTimeline(createTimeline(), { kind: "status", status: { kind: "recalling", text: "recalling" } }, 10);
assert.equal(recallTimeline.steps.length, 1);
assert.equal(recallTimeline.steps[0].status, "running");
assert.equal(recallTimeline.steps[0].statusKind, "recalling");
assert.equal(reduceTimeline(recallTimeline, { kind: "status", status: { kind: "queued" } }, 15), recallTimeline,
  "排队等运行状态不能结束正在进行的记忆回忆");
assert.equal(reduceTimeline(recallTimeline, { kind: "status", status: { kind: "compacted" } }, 16).steps[0].status, "running",
  "压缩完成回执不能结束记忆回忆");
recallTimeline = reduceTimeline(recallTimeline, { kind: "status", status: { kind: "recalling" } }, 18);
assert.equal(recallTimeline.steps.length, 1, "重复回忆进度不能增加步骤");
recallTimeline = reduceTimeline(recallTimeline, { kind: "status", status: { kind: "recalled", text: "recalled" } }, 30);
assert.equal(recallTimeline.steps.length, 1, "回忆开始与完成合并为一个步骤");
assert.equal(recallTimeline.steps[0].status, "ok");
assert.equal(recallTimeline.steps[0].statusKind, "recalled");
assert.equal(recallTimeline.steps[0].endTs - recallTimeline.steps[0].startTs, 20, "完成步骤保留回忆耗时");
recallTimeline = reduceTimeline(recallTimeline, { kind: "status", status: { kind: "compacting" } }, 40);
assert.equal(recallTimeline.steps.length, 2, "回忆后的上下文压缩是独立步骤");
assert.equal(recallTimeline.steps[1].statusKind, "compacting");
const interruptedRecall = reduceTimeline(reduceTimeline(createTimeline(),
  { kind: "status", status: { kind: "recalling" } }, 10), { kind: "error", message: "发送失败" }, 20);
assert.notEqual(interruptedRecall.steps[0].status, "running", "发送失败时回忆步骤不能一直转圈");

for (const [event, expected] of [
  [{ kind: "error", message: "压缩请求失败" }, "error"],
  [{ kind: "aborted" }, "aborted"],
  [{ kind: "final", text: "回合结束" }, "aborted"],
  [{ kind: "final", text: "回合失败", errored: true }, "error"],
]) {
  const running = reduceTimeline(createTimeline(), { kind: "status", status: { kind: "compacting" } }, 10);
  const terminal = reduceTimeline(running, event, 20);
  assert.equal(terminal.steps[0].status, expected, "没有完成回执的压缩不能标为成功");
  assert.equal(terminal.steps[0].endTs, 20);
}
const confirmed = reduceTimeline(compactionTimeline, { kind: "status", status: { kind: "compacted" } }, 45);
assert.equal(reduceTimeline(confirmed, { kind: "error", message: "后续工具失败" }, 50).steps[1].status, "ok",
  "已确认完成的压缩不能被后续错误覆盖");


// OpenClaw's exec call carries both a command and a human-readable title.
// Preserve that intent through live updates and a later history reload.
const actionTitles = ["统计cron任务问题", "统计投递与超时任务", "列出历史error与never任务", "列出24h内ok与高频失联任务"];
for (const [index, title] of actionTitles.entries()) {
  const args = { command: `openclaw cron list --json | report-${index}`, title, timeoutSeconds: 60 };
  const before = JSON.stringify(args);
  const id = `call-${index}`;
  let live = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: id, name: "exec", args, phase: "start" }, 10);
  assert.equal(summarizeArgs(live.steps[0].toolName, live.steps[0].args), title);
  live = reduceTimeline(live, { kind: "tool", toolCallId: id, phase: "result", result: "result", isError: index === 3 }, 20);
  const history = stepsFromParts([
    { type: "toolCall", toolName: "exec", toolCallId: id, toolArgs: args },
    { type: "toolResult", toolCallId: id, text: "result", isError: index === 3 },
  ]);
  for (const step of [live.steps[0], history[0]]) {
    assert.equal(summarizeArgs(step.toolName, step.args), title);
    assert.equal(step.status, index === 3 ? "error" : "ok");
    assert.equal(JSON.stringify(step.args), before, "展示摘要不能修改完整命令或参数");
  }
}
for (const name of ["exec", "bash", "terminal", "run_terminal_command"]) {
  assert.equal(summarizeArgs(name, { title: "  检查\n定时任务  ", description: "备用说明", command: "cron list" }), "检查 定时任务");
  assert.equal(summarizeArgs(name, { title: " ", description: "检查任务", command: "cron list" }), "检查任务");
  assert.equal(summarizeArgs(name, { title: {}, description: [], command: "cron list" }), "cron list");
  assert.equal(summarizeArgs(name, { command: "cron list" }), "cron list");
}
assert.equal(summarizeArgs("read", { path: "/tmp/report.md", description: "document content" }), "/tmp/report.md",
  "其他工具的正文 description 不能误当操作说明");
assert.equal(summarizeArgs("exec", { title: "查".repeat(100), command: "cron list" }), "查".repeat(90) + "…");

console.log("turn-timeline-status-regression: lifecycle, streaming/history action titles, preserved commands/errors, and context compaction PASS");
