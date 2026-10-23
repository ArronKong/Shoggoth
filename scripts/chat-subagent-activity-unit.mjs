import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const ts = createRequire(path.join(root, "app/manage-ui/package.json"))("typescript");
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {}; cache.set(name, exports);
  const source = fs.readFileSync(path.join(root, `app/manage-ui/src/lib/${name}.ts`), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { exports, require: dep => load(dep.replace("./", "")), setTimeout, clearTimeout, console });
  return exports;
}
const { createSubagentActivity } = load("chatSubagentActivity");
const { stepsFromParts } = load("turnTimeline");
const parent = "agent:main:main", other = "agent:other:main";
const child = "agent:main:subagent:one", sibling = "agent:other:subagent:two";
const methods = ["sessions.messages.subscribe", "sessions.messages.unsubscribe"];
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = [], histories = new Map();
let changed = 0, held;
const activity = createSubagentActivity({ normalize: value => value, changed: () => changed++,
  request: async (method, params) => {
    calls.push({ method, params });
    if (method === "chat.history") {
      if (held) return held;
      const value = histories.get(params.sessionKey);
      if (value instanceof Error) throw value;
      return { payload: { messages: value || [], hasMore: false } };
    }
    return { payload: { subscribed: true } };
  } });
const spawnHistory = (key = child, id = "spawn-one", run = "parent-run") => [
  { role: "assistant", activityRunId: run, parts: [{ type: "toolCall", toolCallId: id, toolName: "sessions_spawn", toolArgs: { label: "配置诊断" } }] },
  { role: "toolResult", activityRunId: run, parts: [{ type: "toolResult", toolCallId: id, toolName: "sessions_spawn",
    text: JSON.stringify({ status: "accepted", childSessionKey: key, runId: `${key}-run` }) }] },
];
const parentSteps = stepsFromParts(spawnHistory().flatMap(m => m.parts));
const progress = () => activity.project(parent, parentSteps, "parent-run")[0].subagent;
activity.watch(parent); activity.connect(methods);
activity.sessions([{ key: parent, backendId: "first" }, { key: other, backendId: "first" },
  { key: child, backendId: "first", spawnedBy: parent, status: "running", updatedAt: 100 }]);
activity.observeHistory(parent, spawnHistory());
await settle();
assert.equal(progress().label, "配置诊断");
assert.equal(progress().status, "running");
assert.equal(parentSteps[0].status, "ok", "creation success is not rewritten as child execution success");
assert.ok(calls.some(c => c.method === "sessions.messages.subscribe" && c.params.key === child));
assert.ok(calls.some(c => c.method === "chat.history" && c.params.sessionKey === child));
const tool = (key, phase, extra = {}) => activity.event("session.tool", { sessionKey: key, runId: `${key}-run`,
  data: { phase, toolCallId: "same-tool-id", name: "read", args: { path: "config.json" }, ...extra } });
tool(child, "start"); tool(child, "update", { partialResult: "正在检查" });
assert.equal(progress().steps[0].status, "running");
assert.equal(progress().steps[0].output, "正在检查");
activity.event("chat", { sessionKey: child, runId: `${child}-run`, state: "delta", message: { role: "assistant", parts: [{ type: "text", text: "正在核对配置" }] } });
assert.ok(progress().steps.some(step => step.text === "正在核对配置"), "child assistant text is visible while streaming");
activity.event("chat", { sessionKey: child, runId: `${child}-run`, state: "final", message: { role: "assistant", parts: [{ type: "text", text: "等待嵌套任务完成" }] } });
assert.equal(progress().status, "running", "a final text segment does not prove the yielded child task completed");
activity.observeHistory(parent, spawnHistory(sibling, "spawn-two"));
tool(sibling, "result", { result: "second result" });
assert.equal(progress().steps.filter(step => step.kind === "tool").length, 1, "siblings with the same tool id cannot collide");
assert.equal(activity.project(other, parentSteps, "parent-run")[0].subagent, undefined, "no cross-conversation projection");
assert.equal(activity.project(parent, parentSteps, "another-run")[0].subagent, undefined, "no cross-run projection");
activity.event("agent", { sessionKey: child, runId: `${child}-run`, ts: 200,
  stream: "lifecycle", data: { phase: "end", status: "timed_out", error: "time limit" } });
assert.equal(progress().status, "timeout");
assert.equal(progress().steps[0].status, "aborted", "unfinished child tools stop animating at terminal state");
tool(child, "update", { partialResult: "late update" });
assert.equal(progress().steps[0].output, "正在检查", "late updates cannot reopen terminal work");
activity.sessions([{ key: parent }, { key: child, spawnedBy: parent, status: "running", updatedAt: 150 }]);
assert.equal(progress().status, "timeout", "older snapshots cannot overwrite an observed terminal state");
activity.event("agent", { sessionKey: child, runId: `${child}-run`, ts: 150,
  stream: "lifecycle", data: { phase: "end" } });
assert.equal(progress().status, "timeout", "an older completion event cannot replace the timeout");
assert.equal(activity.event("chat", { sessionKey: child, runId: "foreign-run", state: "delta", message: { parts: [] } }), true);
assert.equal(progress().status, "timeout");
activity.watch(other); await settle();
assert.ok(calls.some(c => c.method === "sessions.messages.unsubscribe" && c.params.key === child));
const before = calls.length;
tool(child, "result", { result: "not current" });
await settle();
assert.equal(calls.length, before, "unwatched children do not trigger reads");

let release;
held = new Promise(resolve => { release = resolve; });
activity.watch(parent); await settle();
activity.connect(null);
release({ payload: { messages: [{ role: "assistant", parts: [{ type: "text", text: "stale connection" }] }] } });
held = null; await settle();
assert.ok(!progress().steps.some(s => s.text === "stale connection"));
histories.set(child, [{ role: "assistant", activityRunId: `${child}-run`, parts: [{ type: "text", text: "已恢复的子任务结果" }] }]);
activity.connect(methods); await settle();
assert.ok(progress().steps.some(s => s.text === "已恢复的子任务结果"));
histories.set(child, new Error("offline"));
activity.event("session.message", { sessionKey: child, message: { role: "assistant", parts: [] } });
await sleep(240); await settle();
assert.equal(progress().unavailable, true);
assert.ok(progress().steps.some(s => s.text === "已恢复的子任务结果"), "failed reads preserve the last good snapshot");
activity.connect(null);
assert.ok(changed > 0);
assert.ok(calls.every(c => ["chat.history", ...methods].includes(c.method)), "only read and subscription RPCs are allowed");
let liveHistory = [];
const liveOnly = createSubagentActivity({ normalize: value => value, changed() {},
  request: async () => ({ payload: { messages: liveHistory, hasMore: false } }) });
liveOnly.watch(parent); liveOnly.connect(methods);
liveOnly.event("agent", { sessionKey: parent, runId: "parent-run", stream: "tool",
  data: { phase: "start", toolCallId: "spawn-one", name: "sessions_spawn", args: { label: "实时创建" } } });
liveOnly.event("agent", { sessionKey: parent, runId: "parent-run", stream: "tool",
  data: { phase: "result", toolCallId: "spawn-one", result: { content: [{ type: "text",
    text: JSON.stringify({ status: "accepted", childSessionKey: child, runId: `${child}-run` }) }] } } });
await settle();
assert.equal(liveOnly.project(parent, parentSteps, "parent-run")[0].subagent.label, "实时创建", "live spawn receipt links before a session-list refresh");
const preamble = (seq, text) => liveOnly.event("agent", { sessionKey: child, runId: `${child}-run`, stream: "item", seq,
  data: { itemId: "child-preamble", kind: "preamble", phase: "update", progressText: text } });
preamble(1, "子代理公开检查进展");
const publicSteps = () => liveOnly.project(parent, parentSteps, "parent-run")[0].subagent.steps;
assert.ok(publicSteps().some(step => step.text === "子代理公开检查进展"), "public child preambles appear in the parent activity");
preamble(2, "子代理公开检查进展已更新"); preamble(1, "过时进展");
assert.equal(publicSteps().filter(step => step.kind === "text").length, 1, "preamble snapshots update by item identity");
assert.equal(publicSteps().find(step => step.kind === "text").text, "子代理公开检查进展已更新");
liveHistory = [{ role: "assistant", activityRunId: `${child}-run`, openclawPreambleIds: ["child-preamble"],
  parts: [{ type: "text", text: "子代理公开检查进展已更新" }] }];
liveOnly.event("session.message", { sessionKey: child, message: liveHistory[0] });
await sleep(240); await settle();
assert.equal(publicSteps().filter(step => step.kind === "text").length, 1, "canonical history acknowledges the same public item without duplication");
liveOnly.sessions([{ key: parent, backendId: "first" }, { key: sibling, spawnedBy: parent, backendId: "second" }]);
liveOnly.observeHistory(parent, spawnHistory(sibling, "foreign-spawn"));
assert.ok(!liveOnly.relatedKeys(parent).includes(sibling), "conflicting backend ownership is rejected");
liveOnly.connect(null);
console.log("chat-subagent-activity-unit: PASS (parent ownership, live discovery, live updates, concurrent children, timeout, late events, subscriptions, reconnect, stale reads, failure preservation)");
