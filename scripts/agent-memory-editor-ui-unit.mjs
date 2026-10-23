import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react");
const { act, create } = require("react-test-renderer");
const ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const pending = [];
const notices = [];
let deferCandidates = false;
let guard;
// Resolved immediately so the ordered request queue below is unaffected.
let importStatus = { supported: true, applicable: false };
const importCalls = [];
const timers = new Map();
let timerId = 0;
const deferred = (name, args) => new Promise((resolve, reject) => pending.push({ name, args, resolve, reject }));
const api = {
  listAgentMemories: (...args) => deferred("list", args),
  mutateAgentMemory: (...args) => deferred("write", args),
  explainAgentMemory: (...args) => deferred("explain", args),
  listAgentMemoryCandidates: (...args) => deferCandidates ? deferred("candidates", args)
    : Promise.resolve({ revision: 0, items: [], nextCursor: null, hasMore: false,
      usage: { day: null, calls: 0, inputTokens: 0, outputTokens: 0 } }),
  reviewAgentMemoryCandidate: (...args) => deferred("review", args),
  acceptAgentMemoryCandidates: (...args) => deferred("batch", args),
  listAgentTranscripts: (...args) => deferred("source", args),
  getAgentMemoryImport: (...args) => { importCalls.push(args); return Promise.resolve(importStatus); },
  getAgentMemoryImportReport: (...args) => deferred("report", args),
  undoAgentMemoryConsolidation: (...args) => deferred("undo", args),
  forgetAgentMemorySession: (...args) => deferred("forgetSession", args),
};
function load(relative) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, Set, Error,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    require: (name) => {
      if (name.endsWith(".css")) return {};
      if (name.endsWith("/api/client")) return api;
      if (name.endsWith("/components/ui")) return { useToast: () => ({ success: (value) => notices.push(value) }) };
      if (name.endsWith("/navigation-guard")) return { useNavigationGuard: (value) => { guard = value; } };
      if (name === "./CodexMemoryImportReportDialog") return { __esModule: true, default: (props) => props.open
        ? React.createElement("aside", { "data-report-dialog": props.agentId, onClose: props.onClose }) : null };
      if (name.startsWith("./")) return load(path.join(path.dirname(relative), `${name}.tsx`));
      if (name.endsWith("/components/Modal")) return { __esModule: true, default: (props) => props.open
        ? React.createElement("section", { role: "dialog" }, props.children, props.footer) : null };
      if (name.endsWith("/components/ChatMarkdown")) return { __esModule: true, default: (props) => React.createElement("div",
        { "data-report-text": true }, props.text) };
      if (name === "react-i18next") return { useTranslation: () => ({ t: (key, values) => values?.lines ? `${key}:${values.lines}` : key }) };
      return require(name);
    },
  });
  return module.exports;
}
const Editor = load("src/pages/agents/AgentMemoryEditor.tsx").default;
const { visibleAgentFiles } = load("src/lib/agentFiles.ts");
assert.deepEqual(Array.from(visibleAgentFiles([{ name: "MEMORY.md" }, { name: "TOOLS.md" }, { name: "tools.md" }]), (file) => file.name), ["MEMORY.md"]);
const item = (id, content) => ({ id, content, status: "active", scope: "agent", type: "semantic",
  confidence: 1, validUntil: null, sensitivity: "normal", updatedAt: 1, validFrom: 0, sourceRefs: ["user-edit:fixture"] });
const page = (items, revision, hasMore = false, nextCursor = items.length) => ({ supported: true, items, revision, hasMore, nextCursor });
const candidate = (id, content) => ({ id, content, profileId: "agent-a", scope: "user",
  sensitivity: "normal", status: "pending", createdAt: 1, updatedAt: 1, acceptedMemoryId: null,
  source: { sessionId: "session-a", eventId: `event-${id}`, runId: "run-a", seq: 5,
    contentHash: "h", quoteHash: "h", quoteStart: 0, quoteLength: 4, workspace: null } });
const candidates = (items, revision, hasMore = false, nextCursor = null) => ({ items, revision,
  hasMore, nextCursor, usage: { day: "2026-09-27", calls: 2, inputTokens: 0, outputTokens: 0 } });
let renderer;
const view = (agentId) => React.createElement(Editor, { key: agentId, backendId: "shoggoth", agentId });
const settle = async (value, reject = false) => {
  const request = pending.shift(); assert.ok(request);
  await act(async () => { request[reject ? "reject" : "resolve"](value); });
  return request;
};
await act(async () => { renderer = create(view("a")); });
assert.equal(pending[0].args[1], "a");
// An older Agent response must never overwrite the newly selected Agent.
await act(async () => { renderer.update(view("b")); });
await settle(page([item("old", "other Agent")], 1));
assert.equal(renderer.root.findAllByType("textarea").length, 0);
await settle(page([item("one", "first"), item("two", "second")], 2, true));
const entries = () => renderer.root.findAllByType("article");
const text = (index) => entries()[index].findByType("textarea");
const saveButton = (index) => entries()[index].findAllByType("button").at(-1);
await act(async () => {
  text(0).props.onChange({ target: { value: "unsaved first" } });
  text(1).props.onChange({ target: { value: "saved second" } });
});
assert.equal(guard.dirty, true);
await act(async () => { saveButton(1).props.onClick(); });
assert.equal(guard.busy, true);
assert.equal(pending[0].args[1], "b");
assert.equal(pending[0].args[3].expectedRevision, 2);
await settle({ revision: 3, item: { ...item("two-v2", "saved second"), supersedes: "two", updatedAt: 3 } });
assert.equal(entries().some((entry) => entry.findByType("textarea").props.value === "second"), false,
  "新版本写入后旧版本从 active 列表移除");
assert.equal(entries().some((entry) => entry.findByType("textarea").props.value === "saved second"), true);
assert.ok(renderer.root.findAllByType("textarea").some((node) => node.props.value === "unsaved first"));
assert.equal(guard.dirty, true, "saving one record preserves another record's draft");
const more = () => renderer.root.findAllByType("button").find((node) => node.children.includes("common.loadMore"));
await act(async () => { more().props.onClick(); });
assert.equal(pending[0].args[4], 2);
await settle(page([item("three", "third")], 3, false, 3));
assert.equal(entries().length, 3);
const first = entries().find((entry) => entry.findByType("textarea").props.value === "unsaved first");
await act(async () => { first.findAllByType("button").at(-1).props.onClick(); });
await settle(new Error("HARNESS_REVISION_CONFLICT"), true);
assert.ok(renderer.root.findAllByType("textarea").some((node) => node.props.value === "unsaved first"));
assert.equal(notices.length, 1, "failed saves never report success");
assert.equal(renderer.root.findByProps({ role: "alert" }).findByType("p").children[0], "HARNESS_REVISION_CONFLICT");
await act(async () => { renderer.unmount(); });

// A completed write on a closed editor must not toast or mutate another Agent.
await act(async () => { renderer = create(view("c")); });
await settle(page([item("four", "fourth")], 4));
await act(async () => {
  renderer.root.findAllByType("article")[0].findByType("textarea").props.onChange({ target: { value: "changed" } });
});
await act(async () => { saveButton(0).props.onClick(); });
await act(async () => { renderer.unmount(); });
await settle({ revision: 5, item: item("four", "changed") });
assert.equal(notices.length, 1);
await act(async () => { renderer = create(view("d")); });
await settle({ ...page([item("active", "current")], 6),
  recallPolicy: { ready: false, revision: null, indexPending: true, code: "RECALL_POLICY_UNAVAILABLE" } });
assert.equal(renderer.root.findAllByProps({ role: "alert" }).some((node) => (
  node.findAllByType("p").some((p) => p.children.includes("agents.memoryRecallNeedsRepair"))
)), true);
const auditButton = renderer.root.findAllByType("button")
  .find((node) => node.children.includes("agents.memoryShowForgotten"));
await act(async () => { auditButton.props.onClick(); });
assert.equal(pending[0].args[2], "deleted");
await settle(page([{ ...item("forgotten", "old content"), status: "deleted" }], 7));
const audited = renderer.root.findByType("article");
assert.equal(audited.findByType("textarea").props.disabled, true);
await act(async () => { audited.findByType("button").props.onClick(); });
assert.equal(pending[0].name, "explain");
await settle({ item: { ...item("forgotten", "old content"), status: "deleted" },
  evidence: { status: "verified_origin", origin: "ui_create" },
  withdrawalReason: "forgotten" });
assert.equal(renderer.root.findAllByType("aside").length, 1);
assert.ok(renderer.root.findByType("aside").findAllByType("p")
  .some((node) => node.children.includes("agents.memoryWithdrawalReasons.forgotten")));
await act(async () => { renderer.unmount(); });

deferCandidates = true;
await act(async () => { renderer = create(view("e")); });
assert.deepEqual(pending.map((request) => request.name), ["list", "candidates"]);
await settle(page([item("existing", "existing memory")], 9));
await settle(candidates([candidate("c1", "Proposed durable fact")], 3, true, 1));
const candidateEntries = () => renderer.root.findAllByType("article")
  .filter((entry) => entry.findAllByType("p").some((node) => node.children.includes("Proposed durable fact")
    || node.children.includes("Second durable fact")));
assert.equal(candidateEntries().length, 1);
await act(async () => { candidateEntries()[0].findAllByType("button")[0].props.onClick(); });
assert.equal(pending[0].name, "source");
assert.equal(pending[0].args[3], 4, "source lookup uses seq only as a hint and verifies event identity");
await settle({ supported: true, revision: 1, items: [{ id: "event-c1", runId: "run-a",
  seq: 5, kind: "user", content: { text: "The original user message" }, contextExcluded: false,
  occurredAt: 1 }], nextCursor: 5, hasMore: false });
assert.ok(renderer.root.findAllByType("blockquote").some((node) => node.children.includes("The original user message")));
const candidateMore = renderer.root.findAllByType("button")
  .find((node) => node.children.includes("common.loadMore"));
await act(async () => { candidateMore.props.onClick(); });
assert.equal(pending[0].name, "candidates");
assert.equal(pending[0].args[3], 1);
assert.equal(pending[0].args[5], 3, "append pins candidate revision");
await settle(candidates([candidate("c2", "Second durable fact")], 3, false));
assert.equal(candidateEntries().length, 2);
await act(async () => { candidateEntries()[0].findAllByType("button")[2].props.onClick(); });
assert.equal(pending[0].name, "review");
assert.deepEqual(pending[0].args.slice(2), ["accept", "c1", 3, 9]);
await settle({ revision: 4, candidate: { ...candidate("c1", "Proposed durable fact"), status: "accepted" },
  memoryItem: item("reviewed-c1", "Proposed durable fact"), memoryRevision: 10 });
assert.deepEqual(pending.map((request) => request.name), ["candidates", "list"]);
await settle(candidates([candidate("c2", "Second durable fact")], 4));
await settle(page([item("reviewed-c1", "Proposed durable fact"), item("existing", "existing memory")], 10));
assert.equal(candidateEntries().length, 1);
assert.ok(entries().some((entry) => entry.findAllByType("textarea")
  .some((field) => field.props.value === "Proposed durable fact")));
await act(async () => { candidateEntries()[0].findAllByType("button")[2].props.onClick(); });
assert.deepEqual(pending[0].args.slice(2), ["accept", "c2", 4, 10]);
await settle(new Error("MEMORY_CANDIDATE_SOURCE_UNAVAILABLE"), true);
assert.equal(candidateEntries().length, 1, "failed source recheck keeps candidate pending");
assert.ok(renderer.root.findAllByProps({ role: "alert" }).some((node) => node.children
  .some((child) => child.children?.includes("MEMORY_CANDIDATE_SOURCE_UNAVAILABLE"))));
// A source request that completes after a candidate list switch must leave
// the new list actionable and cannot display stale transcript text.
await act(async () => { candidateEntries()[0].findAllByType("button")[0].props.onClick(); });
assert.equal(pending[0].name, "source");
const switchCandidates = renderer.root.findAllByType("button")
  .find((node) => node.children.includes("agents.memoryCandidatesShowAll"));
await act(async () => { switchCandidates.props.onClick(); });
assert.deepEqual(pending.map((request) => request.name), ["source", "candidates"]);
await settle({ supported: true, revision: 1, items: [{ id: "event-c2", runId: "run-a",
  seq: 5, kind: "user", content: { text: "stale source" }, contextExcluded: false,
  occurredAt: 1 }], nextCursor: 5, hasMore: false });
await settle(candidates([candidate("c2", "Second durable fact")], 4));
assert.equal(renderer.root.findAllByType("blockquote").some((node) => node.children.includes("stale source")), false);
assert.equal(candidateEntries()[0].findAllByType("button")[0].props.disabled, false);
await act(async () => { renderer.unmount(); });
// Candidate data may arrive before the memory revision. Batch controls must
// remain safe, then submit the exact selected IDs and both observed revisions.
await act(async () => { renderer = create(view("f")); });
assert.deepEqual(pending.map((request) => request.name), ["list", "candidates"]);
const earlyCandidates = pending.splice(1, 1)[0];
await act(async () => { earlyCandidates.resolve(candidates([
  candidate("f1", "Proposed durable fact"), candidate("f2", "Second durable fact"),
], 7)); });
const batchButton = () => renderer.root.findAllByType("button")
  .find((node) => node.children.includes("agents.memoryCandidatesAcceptSelected"));
await settle(page([item("existing", "existing")], 11));
assert.equal(batchButton().props.disabled, true);
const checkboxes = renderer.root.findAllByType("input")
  .filter((node) => node.props.type === "checkbox");
assert.equal(checkboxes.length, 2);
await act(async () => { for (const checkbox of checkboxes) checkbox.props.onChange(); });
assert.equal(batchButton().props.disabled, false);
await act(async () => { batchButton().props.onClick(); });
assert.equal(pending[0].name, "batch");
assert.deepEqual(Array.from(pending[0].args[2]), ["f1", "f2"]);
assert.deepEqual(pending[0].args.slice(3), [7, 11]);
await settle({ revision: 8, acceptedCandidateIds: ["f1", "f2"],
  acceptedMemoryIds: ["reviewed-f1", "reviewed-f2"], memoryRevision: 12,
  viewStatus: { stale: false, revision: 12 } });
assert.deepEqual(pending.map((request) => request.name), ["candidates", "list"]);
await settle(candidates([], 8));
await settle(page([item("reviewed-f1", "Proposed durable fact"),
  item("reviewed-f2", "Second durable fact")], 12));
assert.equal(renderer.root.findAllByType("input").filter((node) => node.props.type === "checkbox").length, 0);
assert.equal(notices.at(-1), "agents.memoryCandidatesAccepted");
await act(async () => { renderer.unmount(); });
// A page containing only hidden/revoked candidates can still have a later
// visible item. The editor follows the monotonic raw cursor automatically.
await act(async () => { renderer = create(view("g")); });
await settle(page([], 13));
await settle(candidates([], 9, true, 256));
assert.equal(pending[0].name, "candidates");
assert.equal(pending[0].args[3], 256);
assert.equal(pending[0].args[5], 9);
await settle(candidates([candidate("g1", "Proposed durable fact")], 9));
assert.equal(renderer.root.findAllByType("article").length, 1);
await act(async () => { renderer.unmount(); });
await act(async () => { renderer = create(React.createElement(Editor,
  { key: "hermes-a", backendId: "hermes", agentId: "h" })); });
assert.deepEqual(pending.map((request) => request.name), ["list"],
  "non-native editor never requests the native candidate endpoint");
await settle({ ...page([], 0), supported: false });
assert.equal(renderer.root.findAllByProps({ "aria-label": "agents.memoryCandidatesTitle" }).length, 0);
await act(async () => { renderer.unmount(); });
// A source opened from the first row of a long list must render beside that
// row, and its previous-version link must keep the same visible anchor.
await act(async () => { renderer = create(view("visual")); });
await settle(page(Array.from({ length: 13 }, (_, index) => item(`long-${index}`,
  index === 0 ? "long memory content ".repeat(50) : `later memory ${index}`)), 15));
await settle(candidates([], 10));
await act(async () => { entries()[0].findAllByType("button")[0].props.onClick(); });
assert.equal(pending[0].name, "explain");
await settle({ item: { ...item("long-0", "long memory content"), supersedes: "older-0" },
  evidence: { status: "verified_quote", quote: "original message" } });
assert.equal(entries()[0].findAllByType("aside").length, 1);
assert.equal(entries().slice(1).every((entry) => entry.findAllByType("aside").length === 0), true);
const currentEvidence = entries()[0].findByType("aside");
assert.ok(currentEvidence.findAllByType("strong").some((node) => node.children.includes("agents.memoryCurrentVersionEvidence")));
assert.ok(currentEvidence.findAllByType("p").some((node) => node.children.includes("long memory content")));
await act(async () => { entries()[0].findByType("aside").findByType("button").props.onClick(); });
assert.equal(pending[0].args[2], "older-0");
await settle({ item: item("older-0", "older content"),
  evidence: { status: "verified_quote", quote: "old user's exact words" } });
assert.equal(entries()[0].findAllByType("aside").length, 1);
assert.equal(entries().slice(1).every((entry) => entry.findAllByType("aside").length === 0), true);
const historicalEvidence = entries()[0].findByType("aside");
assert.ok(historicalEvidence.findAllByType("strong").some((node) => node.children.includes("agents.memoryPreviousVersionEvidence")));
assert.ok(historicalEvidence.findAllByType("strong").some((node) => node.children.includes("agents.memoryHistoricalEvidenceOnly")));
assert.ok(historicalEvidence.findAllByType("p").some((node) => node.children.includes("older content")));
assert.ok(historicalEvidence.findAllByType("code").some((node) => node.children.includes("older-0")));
assert.equal(historicalEvidence.findAllByType("blockquote")[0].children[0], "old user's exact words");
await act(async () => { renderer.unmount(); });
assert.deepEqual(importCalls.at(-1), ["shoggoth", "visual"]);
assert.ok(!importCalls.some((args) => args[0] === "hermes"), "non-native editor never requests the Codex import status");
// The main Agent shows its Codex import result, and an imported record cites
// its Codex file lines and excerpt.
importStatus = { supported: true, applicable: true, state: "completed", reason: null, imported: 3, skipped: 1,
  chunks: { total: 2, done: 2, skipped: 0, pending: 0 }, sources: [], modelCalls: 2, updatedAt: 1, completedAt: 1 };
await act(async () => { renderer = create(view("main")); });
await settle(page([item("codex-import-a", "用户与助手用中文交流")], 3));
await settle(candidates([], 1));
assert.ok(renderer.root.findAllByType("p").some((node) => node.children.includes("agents.memoryCodexImport.completed")));
await act(async () => { entries()[0].findAllByType("button")[0].props.onClick(); });
await settle({ item: item("codex-import-a", "用户与助手用中文交流"),
  evidence: { status: "verified_origin", origin: "import", memoryRevision: 1, quote: null,
    importFile: { name: "MEMORY.md", sha256: "a".repeat(64) },
    importSpan: { lineStart: 17, lineEnd: 18, excerpt: "writes to the assistant in Chinese" } } });
const importEvidence = entries()[0].findByType("aside");
assert.ok(importEvidence.findAllByType("p").some((node) => node.children.includes("agents.memoryImportedLines:17–18")));
assert.equal(importEvidence.findAllByType("blockquote")[0].children[0], "writes to the assistant in Chinese");
await act(async () => { renderer.unmount(); });
importStatus = { supported: true, applicable: true, state: "abandoned", reason: "MEMORY_IMPORT_OUTPUT_INVALID", imported: 0,
  skipped: 0, chunks: { total: 1, done: 0, skipped: 1, pending: 0 }, sources: [], modelCalls: 2, updatedAt: 1, completedAt: 1 };
await act(async () => { renderer = create(view("main-abandoned")); });
await settle(page([], 0));
await settle(candidates([], 0));
assert.ok(renderer.root.findAllByType("p").some((node) => node.children.includes("agents.memoryCodexImport.abandoned")),
  "两次无效后放弃时说明不会再自动重试");
await act(async () => { renderer.unmount(); });
importStatus = { supported: true, applicable: true, state: "no_source", reason: "CODEX_MEMORY_NOT_FOUND", imported: 0,
  skipped: 0, chunks: { total: 0, done: 0, skipped: 0, pending: 0 }, sources: [], modelCalls: 0, updatedAt: 1, completedAt: null };
await act(async () => { renderer = create(view("main-without-codex")); });
await settle(page([], 0));
await settle(candidates([], 0));
assert.ok(!renderer.root.findAllByType("p").some((node) => node.children.some((child) =>
  typeof child === "string" && child.startsWith("agents.memoryCodexImport"))), "没有 Codex 记忆时不显示导入状态");
await act(async () => { renderer.unmount(); });
assert.equal(timers.size, 0, "unmounted editors cancel status polling");

// A completed report appears without remounting; reading it keeps current drafts.
importStatus = { supported: true, applicable: true, state: "running", reason: null,
  task: { jobId: "job-a", runId: "run-a", attempts: 1, maxAttempts: 2, reportRunId: null, retryAt: null } };
await act(async () => { renderer = create(view("report-main")); });
await settle(page([], 0)); await settle(candidates([], 0));
const newMemory = renderer.root.findByType("textarea");
await act(async () => { newMemory.props.onChange({ target: { value: "keep this draft" } }); });
const [timerKey, timer] = [...timers][0]; assert.equal(timer.delay, 5000); timers.delete(timerKey);
importStatus = { ...importStatus, state: "deferred", reason: "MEMORY_IMPORT_TASK_FAILED",
  task: { ...importStatus.task, reportRunId: "run-a", retryAt: Date.now() + 1000 } };
await act(async () => { await timer.callback(); });
const showResult = renderer.root.findAllByType("button").find((node) => node.children.includes("agents.memoryCodexTask.reportOpen"));
assert.ok(showResult);
await act(async () => { showResult.props.onClick(); });
assert.equal(renderer.root.findByProps({ "data-report-dialog": "report-main" }).props["data-report-dialog"], "report-main");
assert.equal(renderer.root.findByType("textarea").props.value, "keep this draft");
assert.equal(pending.length, 0, "opening the result does not write memory or run an Agent");
await act(async () => { renderer.unmount(); }); assert.equal(timers.size, 0);

// The real report component pins continuation pages and ignores closed/other-Agent replies.
const ReportDialog = load("src/pages/agents/CodexMemoryImportReportDialog.tsx").default;
const reportView = (agentId, open = true) => React.createElement(ReportDialog, { backendId: "shoggoth", agentId, open, onClose() {} });
await act(async () => { renderer = create(reportView("a")); });
assert.equal(pending[0].name, "report"); assert.equal(pending[0].args[1], "a");
await act(async () => { renderer.update(reportView("b")); });
await settle({ text: "old Agent result", hasMore: false });
assert.equal(renderer.root.findAllByProps({ "data-report-text": true }).length, 0);
const firstReport = { supported: true, applicable: true, text: "first page\n", runId: "run-b", reportHash: "a".repeat(64),
  attempt: 1, runStatus: "failed", nextCursor: 11, hasMore: true };
await settle(firstReport);
assert.equal(renderer.root.findByProps({ "data-report-text": true }).children[0], "first page\n");
const moreReport = () => renderer.root.findAllByType("button").find((node) => node.children.includes("agents.memoryCodexTask.reportMore"));
await act(async () => { moreReport().props.onClick(); moreReport().props.onClick(); });
assert.equal(pending.length, 1, "double click cannot request duplicate continuation pages");
assert.equal(pending[0].args[2].runId, firstReport.runId); assert.equal(pending[0].args[2].expectedHash, firstReport.reportHash);
await settle({ ...firstReport, text: "different report", reportHash: "b".repeat(64), nextCursor: null, hasMore: false });
assert.equal(renderer.root.findByProps({ role: "alert" }).children[0], "agents.memoryCodexTask.reportChanged");
assert.equal(renderer.root.findByProps({ "data-report-text": true }).children[0], "first page\n");
await act(async () => { moreReport().props.onClick(); });
await settle({ ...firstReport, text: "last page", nextCursor: null, hasMore: false });
assert.equal(renderer.root.findByProps({ "data-report-text": true }).children[0], "first page\nlast page");
assert.equal(moreReport(), undefined);
const refreshReport = () => renderer.root.findAllByType("button").find((node) => node.children.includes("agents.memoryCodexTask.reportRefresh"));
await act(async () => { refreshReport().props.onClick(); renderer.update(reportView("b", false)); });
await settle({ ...firstReport, text: "late closed result" });
assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
await act(async () => { renderer.update(reportView("b")); });
await settle({ supported: true, applicable: true, text: "", nextCursor: null, hasMore: false });
assert.ok(renderer.root.findAllByType("p").some((node) => node.children.includes("agents.memoryCodexTask.reportEmpty")));
await act(async () => { refreshReport().props.onClick(); }); await settle(new Error("read failed"), true);
assert.equal(renderer.root.findByProps({ role: "alert" }).children[0], "read failed");
await act(async () => { renderer.unmount(); }); assert.equal(pending.length, 0);
// Facts shared by another Agent are listed separately, and a forget is written
// through the Agent that holds the fact at the revision the list was read with.
importStatus = { supported: true, applicable: false };
const sharedRow = { item: { ...item("peer-fact", "用户偏好简短回答"), scope: "user" },
  homeAgentId: "agent-home", homeAgentName: "Home", homeRevision: 7 };
await act(async () => { renderer = create(view("viewer")); });
await settle({ ...page([], 0), shared: { items: [sharedRow], truncated: false } });
await settle(candidates([], 0));
const sharedSection = renderer.root.findAll((node) => node.type === "section"
  && node.props["aria-label"] === "agents.memorySharedTitle")[0];
assert.ok(sharedSection, "shared facts are listed");
assert.equal(sharedSection.findByType("textarea").props.value, "用户偏好简短回答");
await act(async () => { sharedSection.findAllByType("button")[0].props.onClick(); });
const sharedForget = await settle({});
assert.deepEqual(JSON.parse(JSON.stringify(sharedForget.args)),
  ["shoggoth", "agent-home", "delete", { id: "peer-fact", expectedRevision: 7 }]);
await settle(page([], 0));
await act(async () => { renderer.unmount(); });
// A held save is marked and confirmed by re-saving it as the user's own.
await act(async () => { renderer = create(view("held")); });
await settle(page([{ ...item("held-fact", "用户每天七点起床"), sourceRefs: ["event-1", "untrusted:quote-unsupported"] },
  { ...item("plain-fact", "用户住在上海"), sourceRefs: ["user-edit:1"] }], 4));
await settle(candidates([], 0));
const heldEntry = entries()[0];
assert.ok(heldEntry.findAllByType("span").some((node) => node.children.includes("agents.memoryAwaitingConfirmation")));
assert.ok(!entries()[1].findAllByType("button").some((node) => node.children.includes("agents.memoryConfirm")));
const confirmButton = heldEntry.findAllByType("button").find((node) => node.children.includes("agents.memoryConfirm"));
await act(async () => { confirmButton.props.onClick(); });
const confirmWrite = await settle({ revision: 5, item: { ...item("held-confirmed", "用户每天七点起床"), sourceRefs: ["user-edit:2"] } });
assert.deepEqual(JSON.parse(JSON.stringify(confirmWrite.args.slice(1, 3))), ["held", "update"]);
assert.equal(confirmWrite.args[3].content, "用户每天七点起床");
assert.equal(confirmWrite.args[3].expectedRevision, 4);
await act(async () => { renderer.unmount(); });
// A consolidation record can be undone, and a conversation's memories forgotten
// after a second, confirming click.
await act(async () => { renderer = create(view("records")); });
await settle(page([{ ...item("reviewed-mc-run", "用户每天跑步"), scope: "user",
  sourceRefs: ["event-9", "run-9", "consolidated:auto"] }], 6));
await settle(candidates([{ ...candidate("mc-run", "用户每天跑步"), status: "accepted",
  acceptedMemoryId: "reviewed-mc-run" }], 3));
const recordButton = (label) => renderer.root.findAll((node) => node.type === "button"
  && node.children.includes(label))[0];
await act(async () => { recordButton("agents.memoryConsolidationUndo").props.onClick(); });
const undoCall = await settle({ revision: 7, item: { ...item("reviewed-mc-run", "用户每天跑步"), status: "deleted" },
  restored: null });
assert.deepEqual(JSON.parse(JSON.stringify(undoCall.args)), ["shoggoth", "records", "reviewed-mc-run", 6]);
assert.equal(notices.at(-1), "agents.memoryConsolidationUndone");
await settle(candidates([{ ...candidate("mc-run", "用户每天跑步"), status: "accepted",
  acceptedMemoryId: "reviewed-mc-run" }], 3));
await settle(page([], 7));
assert.equal(recordButton("agents.memoryConsolidationUndo"), undefined, "nothing left to undo");
await act(async () => { recordButton("agents.memoryForgetSession").props.onClick(); });
assert.equal(pending.length, 0, "the first click only asks for confirmation");
await act(async () => { recordButton("agents.memoryForgetSessionConfirm").props.onClick(); });
const forgetCall = await settle({ revision: 8, forgotten: 2 });
assert.deepEqual(JSON.parse(JSON.stringify(forgetCall.args)), ["shoggoth", "records", "session-a", 7]);
assert.equal(notices.at(-1), "agents.memorySessionForgotten");
await settle(candidates([], 3));
await settle(page([], 8));
await act(async () => { renderer.unmount(); });
console.log("PASS memory editor: provenance, candidate pagination/source/review/batch, stale failures, Agent response isolation and draft preservation, shared facts, confirmation of held saves, consolidation undo and conversation forget");
