#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const timelinePath = new URL("../app/manage-ui/src/lib/turnTimeline.ts", import.meta.url);
const javaScript = ts.transpileModule(fs.readFileSync(timelinePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: timelinePath.pathname,
}).outputText;
const timelineModule = { exports: {} };
vm.runInNewContext(javaScript, { exports: timelineModule.exports });
const { createTimeline, reduceTimeline } = timelineModule.exports;

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
compactionTimeline = reduceTimeline(compactionTimeline, { kind: "status", status: { kind: "compacted", text: "压缩完成" } }, 30);
assert.equal(compactionTimeline.steps.length, 1, "上下文压缩开始与完成仍合并为一个真实步骤");
assert.equal(compactionTimeline.steps[0].statusKind, "compacted");
assert.equal(compactionTimeline.steps[0].status, "ok");
assert.equal(compactionTimeline.steps[0].text, "压缩完成");

console.log("turn-timeline-status-regression: lifecycle noise, streaming segments, execution steps, and context compaction PASS");
