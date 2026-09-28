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
};
function load(relative) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, Set, Error,
    require: (name) => {
      if (name.endsWith(".css")) return {};
      if (name.endsWith("/api/client")) return api;
      if (name.endsWith("/components/ui")) return { useToast: () => ({ success: (value) => notices.push(value) }) };
      if (name.endsWith("/navigation-guard")) return { useNavigationGuard: (value) => { guard = value; } };
      if (name === "react-i18next") return { useTranslation: () => ({ t: (key) => key }) };
      return require(name);
    },
  });
  return module.exports;
}
const Editor = load("src/pages/agents/AgentMemoryEditor.tsx").default;
const { visibleAgentFiles } = load("src/lib/agentFiles.ts");
assert.deepEqual(Array.from(visibleAgentFiles([{ name: "MEMORY.md" }, { name: "TOOLS.md" }, { name: "tools.md" }]), (file) => file.name), ["MEMORY.md"]);
const item = (id, content) => ({ id, content, status: "active", scope: "agent", type: "semantic",
  confidence: 1, validUntil: null, sensitivity: "normal", updatedAt: 1, validFrom: 0 });
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
console.log("PASS memory editor: provenance, candidate pagination/source/review/batch, stale failures, Agent response isolation and draft preservation");
