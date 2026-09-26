#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("node:module").createRequire(path.resolve(__dirname, "../app/manage-ui/package.json"))("typescript");
const { extractPluginAppCallId } = require("../app/core/plugin-app-call-reference");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { FakeHost, openFixture, sendAndDrain, directRuntimeManager } = require("./shoggoth-work-run-coordinator-unit.cjs");
const id = `runtime-${"a".repeat(64)}`;
const result = { result: { content: [{ type: "text", text: "large output ".repeat(2000) }] },
  shoggothPluginApp: { callId: id } };
const mcp = { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
const shapes = { codex: mcp, "grok-build": [{ type: "content", content: mcp.content[0] }],
  antigravity: mcp, pi: { content: mcp.content, details: null }, opencode: JSON.stringify(mcp),
  "deepseek-harness": JSON.stringify(result), "claude-code": mcp.content };
async function main() {
  const timelineModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../app/manage-ui/src/lib/turnTimeline.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: timelineModule.exports });
  const { createTimeline, reduceTimeline, stepsFromParts } = timelineModule.exports;
  for (const [runtime, output] of Object.entries(shapes)) {
    assert.equal(extractPluginAppCallId(output), id, `${runtime} native result container`);
    const host = new FakeHost([], { accountReadSupported: false,
      authenticationStateResult: { authenticated: true, credentialPresent: true } });
    const fixture = await openFixture({ runtime, host, runtimeManager: directRuntimeManager(host, runtime) });
    try {
      const { ack } = await sendAndDrain(fixture, { operationId: `app-reference-${runtime}` });
      const run = fixture.coordinator.getRun(ack.run.id);
      assert.equal(run.status, "running");
      const events = [];
      fixture.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
      host.emit({ known: true, type: "tool_result", method: `${runtime}/fixture-tool-result`,
        threadId: run.runtimeSessionRef.sessionId, sessionId: run.runtimeSessionRef.sessionId,
        turnId: run.runtimeTurnRef.turnId, toolCallId: "native-tool-call", itemId: "native-tool-call",
        tool: { name: "shoggoth_mcp_server_call", kind: "mcp", status: "completed", output },
        contextTool: { output } });
      const event = events.find(value => value.type === "tool.result");
      assert.equal(event?.payload?.tool?.pluginAppCallId, id, `${runtime} structured Coordinator reference`);
      assert(Buffer.byteLength(event.payload.tool.resultSummary || "") <= 2048, "public summary stays bounded");
      assert.equal((event.payload.tool.resultSummary || "").includes(id), false, "receipt lies beyond the summary boundary");
      let hook;
      await ShoggothBackend.prototype._consumeEvent.call({ _invokeHook: (_hooks, _name, value) => { hook = value; } },
        { hooks: {} }, {}, event);
      assert.equal(hook.pluginAppCallId, id, `${runtime} live Backend hook`);
      const state = reduceTimeline(createTimeline(), { kind: "tool", ...hook }, 1);
      assert.equal(state.steps[0].pluginAppCallId, id, `${runtime} live UI reducer`);
      assert.equal(stepsFromParts([{ type: "toolResult", toolName: hook.name,
        text: "truncated output without JSON", pluginAppCallId: id }])[0].pluginAppCallId, id,
      `${runtime} history reducer`);
    } finally { await fixture.coordinator.close(); }
  }
  for (const invalid of [null, "runtime-no", { arguments: result }, { note: result },
    { shoggothPluginApp: { callId: id, secret: "not-a-reference" } },
    { shoggothPluginApp: { callId: "runtime-" + "z".repeat(64) } },
    "x".repeat(8 * 1024 * 1024 + 1)]) assert.equal(extractPluginAppCallId(invalid), null);
  const cycle = {}; cycle.result = cycle; assert.equal(extractPluginAppCallId(cycle), null);
  const getter = {}; Object.defineProperty(getter, "shoggothPluginApp", { get() { throw Error("do not read"); } });
  assert.equal(extractPluginAppCallId(getter), null);
  assert.equal(reduceTimeline(createTimeline(), { kind: "tool", phase: "result", toolCallId: "bad",
    pluginAppCallId: "invalid" }, 1).steps[0].pluginAppCallId, undefined);
  console.log("PASS App references: 7 native result shapes, Coordinator + Backend + live/history reducers, large output, invalid/nested/getter/cycle bounds (Claude projection only; release-disabled)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
