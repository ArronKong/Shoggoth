"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { openFixture, sendAndDrain, FakeHost, directRuntimeManager } = require("./shoggoth-work-run-coordinator-unit.cjs");

test("native tool timing excludes buffered delivery and ignores output-provided duration", async t => {
  let now = 1000;
  const host = new FakeHost([], { threads: [{ id: "timing", threadSource: null, turns: [] }] });
  const runtimeManager = directRuntimeManager(host, "antigravity");
  const handle = await runtimeManager.acquire({ runtime: "antigravity" });
  const f = await openFixture({ now: () => now, runtime: "antigravity", host, runtimeManager,
    sessionStatus: "ready", threadId: "timing" });
  t.after(() => f.coordinator.close());

  const { ack } = await sendAndDrain(f, { operationId: "native-tool-timing" });
  const run = f.coordinator.getRun(ack.run.id), events = [];
  const sub = f.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, e => events.push(e));
  t.after(() => sub.unsubscribe());
  const send = (type, id, extra = {}) => f.host.emit({ known: true, type, method: "session/update",
    threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
    itemId: id, toolCallId: id, tool: { kind: "read", name: "view_file", status: type === "tool_start" ? "in_progress" : "completed",
      output: "x".repeat(6000), durationMs: 1 }, ...extra });
  now = 1100; send("tool_start", "native");
  now = 4000; send("tool_result", "native", { toolTiming: { source: "antigravity-native", startedAt: 1050, completedAt: 1055 } });
  const native = events.find(e => e.type === "tool.result").payload.tool;
  assert.equal(native.durationMs, 5);
  assert.equal(native.resultTruncated, true);
  assert.ok(Buffer.byteLength(native.resultSummary) <= 2048);
  assert.match(native.resultSummary, /结果预览已截断/);
  assert.equal(events.find(e => e.type === "performance.stage" && e.payload.stage === "tool_execution").payload.durationMs, 5);
  now = 4100; send("tool_start", "observed");
  now = 6000; send("tool_result", "observed", { toolTiming: { source: "antigravity-observed", completedAt: 4200 } });
  assert.equal(events.filter(e => e.type === "tool.result").at(-1).payload.tool.durationMs, 100);
  now = 6100; send("tool_start", "invalid");
  now = 6200; send("tool_result", "invalid", { toolTiming: { source: "antigravity-native", startedAt: 0, completedAt: 99999 } });
  assert.equal(events.filter(e => e.type === "tool.result").at(-1).payload.tool.durationMs, 100);
  handle.runtime = "codex";
  now = 6300; send("tool_start", "wrong-runtime");
  now = 6500; send("tool_result", "wrong-runtime", { toolTiming: { source: "antigravity-native", startedAt: 6300, completedAt: 6301 } });
  assert.equal(events.filter(e => e.type === "tool.result").at(-1).payload.tool.durationMs, 200);
});
