import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = require("typescript");
function load(file, parent = import.meta.url) {
  const url = new URL(file, parent), exports = {};
  const source = ts.transpileModule(fs.readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, URL, require: name => load(`${name}.ts`, url) });
  return exports;
}
const { toolActivityTitle, toolActivityTitles, deriveRelations, createTimeline, reduceTimeline, stepsFromParts } = load("../app/manage-ui/src/lib/turnTimeline.ts");
const t = key => key;
let state = createTimeline();
const feed = event => { state = reduceTimeline(state, event, 100 + state.steps.length); };
feed({ kind: "delta", text: "先核对官方限制。" });
feed({ kind: "interim", text: "先核对官方限制。", activity: true, activityId: "note-1" });
feed({ kind: "interim", text: "先核对官方限制。", activity: true, activityId: "note-1" });
feed({ kind: "progress", text: "先核对官方限制。", activityId: "note-1" });
const calls = [["search", "shoggoth/web_search", { query: "Oracle free limits", activityTitle: "核对 Oracle 免费配额" }],
  ["fetch", "mcp__shoggoth__web_fetch", { url: "https://example.com", activityTitle: "读取官方资源限制" }]];
for (const [toolCallId, name, args] of calls) feed({ kind: "tool", toolCallId, name, args, phase: "start" });
feed({ kind: "tool", toolCallId: "fetch", phase: "result", isError: true, result: "timeout" });
feed({ kind: "tool", toolCallId: "search", phase: "result", result: "limits" });
feed({ kind: "progress", activityId: "note-2", text: "先核对官方限制。" });
feed({ kind: "delta", text: "最终答案。" });
const notes = state.steps.filter(s => s.activity);
assert.equal(notes.length, 2, "deduplicate by source ID, preserve repeated wording from a later step");
assert.ok(state.steps.some(s => s.kind === "final" && !s.activity), "answer is separate");
const history = stepsFromParts([{ type: "text", activity: true, segmentId: "note-1", text: notes[0].text },
  ...calls.flatMap(([toolCallId, toolName, toolArgs]) => [{ type: "toolCall", toolCallId, toolName, toolArgs },
    { type: "toolResult", toolCallId, text: "output", isError: toolCallId === "fetch" }]),
  { type: "text", activity: true, segmentId: "note-2", text: notes[1].text }, { type: "text", text: "最终答案。" }]);
assert.equal(history.length, 4);
assert.equal(history.filter(s => s.activity).length, 2);
for (const steps of [state.steps, history]) {
  for (const [id, , args] of calls) {
    const step = steps.find(s => s.toolCallId === id);
    assert.equal(toolActivityTitle(step.toolName, step.args, t), args.activityTitle);
    assert.equal(step.status, id === "fetch" ? "error" : "ok");
  }
}
assert.notEqual(toolActivityTitle("document_create", { description: "private document body" }, t), "private document body");
assert.notEqual(toolActivityTitle("web_search", { query: "query", activityTitle: "invalid\nline" }, t), "invalid\nline");
assert.equal(toolActivityTitle("read_file", { path: "source.ts", nativeActivityTitle: "核对源文件边界" }, t), "核对源文件边界");
assert.equal(toolActivityTitle("Bash", { command: "pwd", description: "检查工作目录", nativeActivityTitle: "Run pwd" }, t), "检查工作目录");
assert.equal(toolActivityTitle("web_search", { activityTitle: "核对官方公告", nativeActivityTitle: "Search sources" }, t), "核对官方公告");
// Different requests in a parallel batch must not look like repeated executions.
const queries = ["AI news OpenAI Anthropic Google", "AI 人工智能 新闻", "AI news Reuters"];
let parallel = createTimeline();
for (const [i, query] of queries.entries()) parallel = reduceTimeline(parallel,
  { kind: "tool", toolCallId: `parallel-${i}`, name: "shoggoth/web_search", args: { query, activityTitle: "搜索 AI 新闻" }, phase: "start" }, 10 + i);
for (const i of [1, 0, 2]) parallel = reduceTimeline(parallel,
  { kind: "tool", toolCallId: `parallel-${i}`, phase: "result", result: "unavailable", isError: true }, 30 + i);
assert.equal(deriveRelations(parallel.steps).size, 0, "parallel failures are not retries");
const headlines = toolActivityTitles(parallel.steps, t);
assert.equal(new Set(headlines.values()).size, 3, "equal model titles reveal the different search targets");
for (const [i, query] of queries.entries()) assert.ok(headlines.get(`tool:parallel-${i}`).includes(query));
parallel = reduceTimeline(parallel, { kind: "tool", toolCallId: "retry", name: "shoggoth/web_search",
  args: { query: queries[0], activityTitle: "重试官方公告检索" }, phase: "start" }, 50);
assert.equal(deriveRelations(parallel.steps).get("tool:retry")?.fromStepId, "tool:parallel-0", "find the failed target, not the adjacent unrelated call");
parallel = reduceTimeline(parallel, { kind: "tool", toolCallId: "different", name: "shoggoth/web_search",
  args: { query: "new topic" }, phase: "start" }, 51);
assert.equal(deriveRelations(parallel.steps).has("tool:different"), false, "a different search is not a retry");
const urls = ["https://user:private@example.com/a?token=private#secret", "https://example.com/b"];
const pages = urls.map((url, i) => ({ id: `page-${i}`, kind: "tool", toolName: "shoggoth/web_fetch", args: { url, activityTitle: "核对新闻正文" }, startTs: i, status: "ok" }));
const pageTitles = toolActivityTitles(pages, t);
assert.notEqual(pageTitles.get("page-0"), pageTitles.get("page-1"), "different pages on the same host are distinguishable");
for (const title of pageTitles.values()) assert.ok(!/user|private|token|secret/.test(title), "URL credentials, query strings and fragments never enter labels");
assert.equal(deriveRelations(stepsFromParts([
  { type: "toolCall", toolCallId: "a", toolName: "web_fetch", toolArgs: { url: urls[0] } },
  { type: "toolCall", toolCallId: "b", toolName: "web_fetch", toolArgs: { url: urls[1] } },
  { type: "toolResult", toolCallId: "a", text: "timeout", isError: true },
  { type: "toolResult", toolCallId: "b", text: "timeout", isError: true },
])).size, 0, "history also retains parallel execution order");
parallel = reduceTimeline(parallel, { kind: "tool", toolCallId: "retry", phase: "result", result: "found", isError: false }, 60);
parallel = reduceTimeline(parallel, { kind: "tool", toolCallId: "after-success", name: "shoggoth/web_search",
  args: { query: queries[0] }, phase: "start" }, 70);
assert.equal(deriveRelations(parallel.steps).has("tool:after-success"), false, "a past failure cannot turn a later successful target into an endless retry chain");
const unknown = pages.map((p, i) => ({ ...p, toolName: "external/arbitrary", args: { query: `hidden-${i}`, activityTitle: "外部操作" } }));
assert.ok([...toolActivityTitles(unknown, t).values()].every(title => title === "外部操作"), "unknown external input is not promoted into a target label");
console.log("PASS native public progress: parallel labels, results, replay, history, answer separation");
