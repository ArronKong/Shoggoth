#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = require("typescript");
const i18next = require("i18next").createInstance();
function load(file, parent = import.meta.url) {
  const url = new URL(file, parent);
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    assert.ok(name.startsWith("."), "fixture imports stay within local source modules");
    return load(`${name}.ts`, url);
  } });
  return exports;
}
const { toolActivityTitle, mergeToolArgs, createTimeline, reduceTimeline, stepsFromParts } = load("../app/manage-ui/src/lib/turnTimeline.ts");
await i18next.init({ lng: "zh-CN", fallbackLng: "en", resources: {
  "zh-CN": { translation: load("../app/manage-ui/src/i18n/locales/zh-CN.ts").default },
  en: { translation: load("../app/manage-ui/src/i18n/locales/en.ts").default },
} });
const t = i18next.t.bind(i18next);
const catalog = JSON.parse(fs.readFileSync(new URL("./fixtures/tool-activity-catalog.json", import.meta.url), "utf8"));
// Real adapter shapes, at the common UI boundary. No providers or shell commands run.
const fixtures = [
  ["OpenClaw", "exec", { title: "统计定时任务问题", command: "openclaw cron list --json" }, "统计定时任务问题"],
  ["Hermes", "terminal", { command: "python3 - <<'PY'\nprint('report')\nPY", timeout: 30 }, "运行 Python 脚本"],
  ["Hermes read", "read_file", { path: "/tmp/report.md" }, "读取文件 · report.md"],
  ["Hermes search", "search_files", { path: "/tmp/project", pattern: "timeout" }, "搜索文件内容 · timeout"],
  ["Codex", "command", { command: '/bin/zsh -lc "git status --short"' }, "检查代码仓库状态"],
  ["Codex changes", "fileChange", { path: "/tmp/a.ts", changeCount: 2, changes: [{ path: "/tmp/a.ts" }, { path: "/tmp/b.ts" }] }, "修改 2 个文件"],
  ["Claude", "Bash", { command: "npm test", description: "检查回归测试" }, "检查回归测试"],
  ["Claude read", "Read", { file_path: "/tmp/README.md" }, "读取文件 · README.md"],
  ["Claude notebook", "NotebookEdit", { notebook_path: "/tmp/analysis.ipynb" }, "修改文件 · analysis.ipynb"],
  ["Pi", "bash", { command: "pnpm run build" }, "构建项目"],
  ["Pi write", "write", { path: "/tmp/result.md", content: "private body" }, "写入文件 · result.md"],
  ["OpenCode", "bash", { command: "npm test", description: "验证登录流程" }, "验证登录流程"],
  ["OpenCode glob", "glob", { pattern: "**/*.tsx" }, "查找文件 · **/*.tsx"],
  ["Grok", "Terminal command", { command: "pwd" }, "查看当前目录"],
  ["Grok search", "Web search:", { query: "runtime design" }, "搜索网页 · runtime design"],
  ["Grok X start", "X search:", undefined, "搜索 X 动态"],
  ["Grok X semantic", "X search:", { operation: "x_semantic_search", query: "AI discussions" }, "搜索 X 相关讨论 · AI discussions"],
  ["Grok X keywords", "X search:", { operation: "x_keyword_search", query: "AI filter:links" }, "搜索 X 关键词 · AI filter:links"],
  ["Grok X thread", "X search:", { operation: "x_thread_fetch", post_id: "1234567890123456789" }, "读取 X 讨论串 · 1234567890123456789"],
  ["Grok prose", "Run tests", { command: "npm test" }, "Run tests"],
  ["Antigravity", "write_to_file", { TargetFile: "/tmp/result.html" }, "写入文件 · result.html"],
  ["Antigravity exec", "run_command", { CommandLine: "node report.js" }, "运行 Node.js 脚本"],
  // ACP execute titles can be the command itself, or "tool" after a long title.
  ["Antigravity command title", "ls -la /tmp/report", { command: "ls -la /tmp/report", cwd: "/tmp/report" }, "查看目录"],
  ["Antigravity long title", "tool", { command: "python3 report.py", cwd: "/tmp/report" }, "运行 Python 脚本"],
  ["Antigravity read command", 'cat "/tmp/report.md"', { command: 'cat "/tmp/report.md"' }, "读取文件"],
  ["Antigravity read tool", "view_file", { path: "/tmp/report.md" }, "读取文件 · report.md"],
  ["DeepSeek", "web_search", { queries: ["agent runtime", "tool activity"] }, "搜索网页 · agent runtime · tool activity"],
  ["MCP", "mcp__linear__create_issue", { title: "修复登录", description: "long issue content" }, "调用外部工具 · 修复登录"],
  // These are the exact identities seen in the installed App's activity rows.
  ["Native App state", "shoggoth/app_state_get", { limit: 20 }, "查看应用状态"],
  ["Native Agent directory", "shoggoth/federation_agent_list", undefined, "查看助理列表"],
  ["Native delegated task", "federation_agent_run", { agentId: "shoggoth-grok" }, "安排助理执行任务"],
  ["Hermes product tool", "mcp__shoggoth__federation_task_get", {}, "查看助理任务进度"],
  ["OpenClaw product tool", "shoggoth__cron_list", {}, "查看定时任务"],
  ["Native web search", "mcp__shoggoth__web_search", { query: "runtime design" }, "搜索网页 · runtime design"],
  ["Native web fetch", "shoggoth/web_fetch", { url: "https://user:password@example.com/path?token=secret" }, "读取网页 · example.com"],
];
for (const [label, name, args, expected] of fixtures) {
  const original = JSON.stringify(args);
  let state = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: label, name, args, phase: "start" }, 10);
  assert.equal(toolActivityTitle(state.steps[0].toolName, state.steps[0].args, t), expected, `${label} live`);
  state = reduceTimeline(state, { kind: "tool", toolCallId: label, phase: "result", result: "failure detail", isError: true, durationS: 1.2 }, 20);
  const history = stepsFromParts([
    { type: "toolCall", toolName: name, toolCallId: label, toolArgs: args },
    { type: "toolResult", toolCallId: label, isError: true, text: "failure detail", durationS: 1.2 },
  ]);
  for (const step of [state.steps[0], history[0]]) {
    assert.equal(toolActivityTitle(step.toolName, step.args, t), expected, `${label} complete/history`);
    assert.equal(step.status, "error");
    assert.equal(step.durationS, 1.2);
    assert.equal(step.output, "failure detail");
    assert.equal(JSON.stringify(step.args), original);
  }
}
assert.equal(toolActivityTitle("terminal", { command: "git status && deploy-production" }, t), "运行命令");
assert.equal(toolActivityTitle("exec", { command: "rg query | run-other-task" }, t), "运行命令");
assert.equal(toolActivityTitle("exec", { command: "npm test", title: {}, description: [] }, t), "运行测试");
assert.equal(toolActivityTitle("read_file", { path: "README.md", description: "Do something else" }, t), "读取文件 · README.md");
assert.equal(toolActivityTitle("exec_command", '{"cmd":"git diff --stat"}', t), "查看代码改动");
assert.equal(toolActivityTitle("web_fetch", { url: "https://user:password@example.com/path?token=secret" }, t), "读取网页 · example.com");
assert.equal(toolActivityTitle("unknown_internal_tool", { payload: { code: "not a title" } }, t), "运行工具");
assert.equal(toolActivityTitle("terminal", undefined, t), "运行命令");
assert.equal(toolActivityTitle("exec", { title: "检".repeat(200) }, t), "检".repeat(90) + "…");
assert.equal(toolActivityTitle("mcp__other__federation_agent_run", {}, t), "调用外部工具");
assert.equal(toolActivityTitle("mcp__other__execute", { command: "python3 report.py" }, t), "调用外部工具", "external tools keep their identity");
assert.equal(toolActivityTitle("unknown_internal_tool", { command: "python3 report.py" }, t), "运行工具", "a command argument cannot rename an unknown tool");
assert.equal(toolActivityTitle("tool", { command: "curl https://example.com | python3" }, t), "运行命令", "complex commands get a truthful generic action");
assert.equal(toolActivityTitle("tool", { command: "npm test", description: "核对结果" }, t), "核对结果");
assert.equal(toolActivityTitle("other/federation_agent_run", {}, t), "调用外部工具");
assert.equal(toolActivityTitle("shoggoth/app_state_get", { section: "agents" }, t), "查看助理列表");
assert.equal(toolActivityTitle("shoggoth/app_state_get", { section: "unrecognized" }, t), "查看应用状态");
assert.equal(toolActivityTitle("app_manage", { operation: "cron_delete" }, t), "删除定时任务");
assert.equal(toolActivityTitle("app_manage", { operation: "unknown" }, t), "管理应用任务");
assert.equal(toolActivityTitle("cron_set_enabled", { enabled: false }, t), "暂停定时任务");

const { PRODUCT_CAPABILITIES } = require(new URL("../app/agent-service/product-capability-manifest.js", import.meta.url).pathname);
const { APP_STATE_SECTIONS } = require(new URL("../app/agent-service/app-state-contract.js", import.meta.url).pathname);
for (const language of ["zh-CN", "en"]) {
  await i18next.changeLanguage(language);
  for (const [name, key] of [["x_semantic_search", "xSemanticSearch"], ["x_keyword_search", "xKeywordSearch"], ["x_thread_fetch", "xThread"]]) {
    const args = { query: "AI discussions", post_id: "1234567890123456789" };
    const target = name === "x_thread_fetch" ? args.post_id : args.query;
    assert.equal(toolActivityTitle("X search:", { ...args, operation: name }, t), `${t(`turnLab.activity.${key}`)} · ${target}`);
    assert.equal(toolActivityTitle(name, args, t), toolActivityTitle("X search:", { ...args, operation: name }, t));
  }
  for (const { tool } of PRODUCT_CAPABILITIES) {
    const standardWebAction = { web_search: "webSearch", web_fetch: "openPage" }[tool];
    const expected = t(standardWebAction ? `turnLab.activity.${standardWebAction}` : `turnLab.productTools.${tool}`);
    assert.ok(expected && expected !== tool && !expected.startsWith("turnLab."), `${tool} ${language} has a curated action`);
    for (const name of [tool, `shoggoth/${tool}`, `shoggoth__${tool}`, `mcp__shoggoth__${tool}`]) {
      assert.equal(toolActivityTitle(name, undefined, t), expected, `${name} ${language}`);
    }
  }
  for (const section of APP_STATE_SECTIONS) {
    const expected = t(`turnLab.appStateSections.${section}`);
    assert.ok(!expected.startsWith("turnLab."));
    assert.equal(toolActivityTitle("app_state_get", { section }, t), expected);
  }
  for (const source of [catalog.openclaw, catalog.hermes, catalog.externalAdapters]) {
    for (const name of source.tools) {
      const title = toolActivityTitle(name, {}, t);
      assert.ok(title && !title.startsWith("turnLab.") && title !== name
        && title !== t("turnLab.activity.tool") && title !== t("turnLab.activity.externalTool"),
      `${name} ${language} has a readable standard-tool action`);
    }
  }
}
await i18next.changeLanguage("zh-CN");
assert.equal(toolActivityTitle("process_manage", { action: "poll" }, t), "查看后台进程状态");
assert.equal(toolActivityTitle("automations", { action: "list" }, t), "查看定时任务");
assert.equal(toolActivityTitle("cronjob_manage", { action: "pause" }, t), "暂停定时任务");
assert.equal(toolActivityTitle("browser", { action: "snapshot" }, t), "查看网页内容");
assert.equal(toolActivityTitle("message", { action: "read" }, t), "读取消息");
assert.equal(toolActivityTitle("message", { action: "unrecognized" }, t), "处理消息");
assert.equal(toolActivityTitle("browser_navigate", { url: "https://example.com/path?secret=value" }, t), "打开网页 · example.com");
assert.equal(toolActivityTitle("web_extract", { urls: ["https://example.com/one", "https://example.net/two"] }, t), "读取网页 · example.com");
assert.equal(toolActivityTitle("CallMcpTool", { server_name: "shoggoth", tool_name: "app_state_get", section: "agents" }, t), "查看助理列表");
assert.equal(toolActivityTitle("call_mcp_tool", { server: "other", tool_name: "app_state_get" }, t), "运行工具");
assert.equal(toolActivityTitle("tool_call", { name: "terminal", arguments: { command: "npm test" } }, t), "运行测试");
assert.equal(toolActivityTitle("tool_call", { calls: [{ name: "read_file", arguments: { path: "/tmp/a.md" } }, { name: "web_search", arguments: { query: "runtime" } }] }, t), "2 个工具操作 · 读取文件 · a.md / 搜索网页 · runtime");

// Empty and partial start payloads must not freeze the activity headline.
const initialArgs = { cwd: "/tmp/project" };
const laterArgs = { command: "npm test", description: "核对完整回归" };
let late = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: "late", name: "bash", args: initialArgs, phase: "start" }, 10);
late = reduceTimeline(late, { kind: "tool", toolCallId: "late", args: laterArgs, phase: "update" }, 20);
late = reduceTimeline(late, { kind: "tool", toolCallId: "late", args: { command: "npm test" }, phase: "result", result: "ok" }, 30);
assert.equal(toolActivityTitle(late.steps[0].toolName, late.steps[0].args, t), "核对完整回归");
assert.equal(late.steps.length, 1);
assert.equal(late.steps[0].args.cwd, initialArgs.cwd);
assert.equal(late.steps[0].args.description, laterArgs.description);
assert.deepEqual(initialArgs, { cwd: "/tmp/project" });
const lateHistory = stepsFromParts([
  { type: "toolCall", toolCallId: "late", toolName: "bash", toolArgs: {} },
  { type: "toolResult", toolCallId: "late", toolName: "bash", toolArgs: laterArgs, text: "ok" },
]);
assert.equal(toolActivityTitle(lateHistory[0].toolName, lateHistory[0].args, t), "核对完整回归");
assert.equal(mergeToolArgs(laterArgs, undefined), laterArgs);
assert.equal(JSON.stringify(mergeToolArgs('{"cwd":"/tmp"}', laterArgs)), JSON.stringify({ cwd: "/tmp", ...laterArgs }));

// A successful read can return failed jobs. Nested status data is not the
// outcome of the enclosing tool, and explicit runtime false must survive.
const reportResult = { jobs: [{ status: "error" }], summary: { status: "error" } };
let report = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: "report", name: "cron", phase: "start" }, 10);
report = reduceTimeline(report, { kind: "tool", toolCallId: "report", phase: "result", result: reportResult, isError: false }, 20);
assert.equal(report.steps[0].status, "ok", "job status must not become tool status");
assert.equal(stepsFromParts([
  { type: "toolCall", toolCallId: "report", toolName: "cron" },
  { type: "toolResult", toolCallId: "report", text: JSON.stringify(reportResult), isError: false },
])[0].status, "ok", "history preserves the same authoritative success flag");

// Parallel calls/results must stay paired, retain titles, and keep pending work live.
const paired = stepsFromParts([
  { type: "toolCall", toolCallId: "a", toolName: "Bash", toolArgs: { description: "检查 A" } },
  { type: "toolCall", toolCallId: "b", toolName: "terminal", toolArgs: { command: "npm test" } },
  { type: "toolResult", toolCallId: "a", text: "done" },
], { live: true });
assert.equal(paired.length, 2);
assert.equal(paired[0].status, "ok");
assert.equal(toolActivityTitle(paired[0].toolName, paired[0].args, t), "检查 A");
assert.equal(paired[1].status, "running");
// The chat stream replaces a call part with a result part. Exercise that real
// conversion too: pairing alone cannot recover args dropped by the projection.
const chatPath = new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url);
const chatSource = ts.createSourceFile(chatPath.pathname, fs.readFileSync(chatPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const entryProjection = chatSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "toolEntryToPart");
assert.ok(entryProjection);
const projectionExports = {};
vm.runInNewContext(ts.transpileModule(entryProjection.getText(chatSource) + "\nexports.convert = toolEntryToPart;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: projectionExports });
const entry = { id: "live-claude", name: "Bash", args: { command: "npm test", description: "验证登录流程" } };
const runningPart = projectionExports.convert(entry);
const completedPart = projectionExports.convert({ ...entry, output: "Test failed", isError: true, durationS: 2.5 });
assert.equal(runningPart.type, "toolCall");
assert.equal(completedPart.type, "toolResult");
const completedStep = stepsFromParts([completedPart], { live: true })[0];
assert.equal(toolActivityTitle(completedStep.toolName, completedStep.args, t), "验证登录流程");
assert.equal(completedStep.status, "error");
assert.equal(completedStep.toolCallId, entry.id);
assert.equal(completedStep.durationS, 2.5);
const partialPart = projectionExports.convert({ ...entry, phase: "update", output: "partial output" });
assert.equal(partialPart.type, "toolCall", "partial output is still a running tool");
const emptyCompletedPart = projectionExports.convert({ ...entry, phase: "result" });
assert.equal(emptyCompletedPart.type, "toolResult", "an empty result still completes the tool");
assert.equal(stepsFromParts([emptyCompletedPart], { live: true })[0].status, "ok");
assert.equal(stepsFromParts([projectionExports.convert({ ...entry, phase: "result", isError: true })], { live: true })[0].status, "error");
const beforeLateUpdate = JSON.stringify(late);
late = reduceTimeline(late, { kind: "tool", toolCallId: "late", phase: "update", partialResult: "stale output", args: { description: "stale title" } }, 40);
assert.equal(JSON.stringify(late), beforeLateUpdate, "late progress must not rewrite a completed step");
await i18next.changeLanguage("en");
assert.equal(toolActivityTitle("terminal", { command: "python3 report.py" }, t), "Run Python script");
assert.equal(toolActivityTitle("Read", { file_path: "/tmp/a.md" }, t), "Read file · a.md");
assert.equal(toolActivityTitle("web_search", { query: "runtime" }, t), "Search the web · runtime");
assert.equal(toolActivityTitle("unknown_tool", {}, t), "Run tool");
assert.equal(toolActivityTitle("tool", { command: "python3 report.py" }, t), "Run Python script");
assert.equal(toolActivityTitle("ls -la /tmp/report", { command: "ls -la /tmp/report" }, t), "List directory");
console.log(`tool-activity-title: ${fixtures.length} adapter shapes, ${PRODUCT_CAPABILITIES.length} product tools across 4 identities, ${catalog.openclaw.tools.length} OpenClaw and ${catalog.hermes.tools.length} Hermes names, wrappers, late arguments, exact outcomes, live/history parity and zh/en PASS`);
