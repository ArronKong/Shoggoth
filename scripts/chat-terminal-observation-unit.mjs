#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const requireUi = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = requireUi("typescript"), module = { exports: {} };
const source = fs.readFileSync(new URL("../app/manage-ui/src/lib/chatTerminalObservation.ts", import.meta.url), "utf8");
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { module, exports: module.exports });
const { observedChatTerminal: observe } = module.exports;
const event = (event, fields) => ({ type: "event", event, payload: { sessionKey: "agent:fixture:session", runId: "current", ...fields } });
const lifecycle = data => event("agent", { stream: "lifecycle", data });
assert.equal(observe(lifecycle({ phase: "end", aborted: true }), "old"), null);
assert.equal(observe(lifecycle({ phase: "end", aborted: true }), undefined), null);
assert.equal(observe(lifecycle({ phase: "start", aborted: true }), "current"), null);
assert.equal(observe(lifecycle({ phase: "error", error: "retryable provider attempt" }), "current"), null);
assert.equal(observe(lifecycle({ phase: "end", yielded: true, livenessState: "paused" }), "current"), null);
assert.equal(observe(lifecycle({ phase: "end", aborted: true }), "current").payload.state, "aborted");
const snapshot = fields => event("sessions.changed", { phase: "end", session: { status: "killed", hasActiveRun: false, lastRunId: "current", ...fields } });
assert.equal(observe(snapshot({ hasActiveRun: true }), "current"), null);
assert.equal(observe(snapshot({ lastRunId: "old" }), "current"), null);
assert.equal(observe(snapshot({ status: "running" }), "current"), null);
assert.equal(observe(snapshot({}), "current").payload.state, "aborted");
assert.equal(observe(snapshot({ status: "failed", lastRunError: "failure" }), "current").payload.errorMessage, "failure");
assert.equal(observe(snapshot({ status: "idle" }), "current").payload.statusKind, "idle");
const correlated = event("sessions.changed", { clientRunId: "operation", phase: "end",
  session: { status: "killed", hasActiveRun: false, lastRunId: "operation" } });
assert.equal(observe(correlated, "operation").payload.runId, "operation");
assert.equal(observe({ type: "res", event: "chat.abort", payload: { ok: true } }, "current"), null);
console.log("PASS 15 terminal-observation assertions (same-run proof, retry/abort-ACK rejection)");
