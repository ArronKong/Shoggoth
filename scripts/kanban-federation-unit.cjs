#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CANONICAL_KANBAN_STATUSES,
  agentIdentity,
  buildCanonicalColumns,
  canonicalStatus,
  mergeProjectRows,
  nativeTargetForCanonical,
  normalizeFederatedTask,
  normalizeProjectKey,
  parseAgentIdentity,
  taskIdentity,
  taskProjectKey,
} = require("../app/core/kanban-federation");
const { createKanbanProjectStore } = require("../app/core/kanban-project-store");

const appSource = fs.readFileSync(path.join(__dirname, "../app/manage-ui/src/App.tsx"), "utf8");
const pageSource = fs.readFileSync(path.join(__dirname, "../app/manage-ui/src/pages/FederatedTasksPage.tsx"), "utf8");
const legacyTasksSource = fs.readFileSync(path.join(__dirname, "../app/manage-ui/src/pages/TasksPage.tsx"), "utf8");
const workboardSource = fs.readFileSync(path.join(__dirname, "../app/manage-ui/src/pages/workboard/WorkboardView.tsx"), "utf8");
const apiSource = fs.readFileSync(path.join(__dirname, "../app/static-server.js"), "utf8");
assert.match(appSource, /import\("\.\/pages\/FederatedTasksPage"\)/u);
assert.doesNotMatch(pageSource, /BackendTabs/u, "unified Kanban must not render backend tabs");
assert.match(pageSource, /\["triage", "ready", "in_progress", "review", "blocked", "done", "archived"\]/u);
assert.match(pageSource, /<TasksPage[\s\S]*detailOnly=/u, "federated cards must reuse the full backend detail UI");
assert.match(legacyTasksSource, /export interface TasksPageDetailTarget/u);
assert.match(workboardSource, /onDetailClose/u, "workboard detail must notify the federated host when it closes");
assert.match(apiSource, /segs\[1\] === "federated"/u);
assert.match(pageSource, /<Select value=\{projectKey\}/u,
  "project selector must reflect the user's requested project while a board response is loading");
assert.match(apiSource, /deleteFederatedKanbanProject/u,
  "the unified Kanban API must expose backend project deletion");

assert.deepEqual(CANONICAL_KANBAN_STATUSES, [
  "triage", "ready", "in_progress", "review", "blocked", "done", "archived",
]);
assert.match(normalizeProjectKey("研究项目", ""), /^project-[a-f0-9]{12}$/u);
assert.equal(normalizeProjectKey("研究项目", ""), normalizeProjectKey("研究项目", ""));

for (const status of ["backlog", "todo", "scheduled", "ready"]) {
  assert.equal(canonicalStatus("workboard", status), "ready", `OpenClaw ${status}`);
}
assert.equal(canonicalStatus("workboard", "running"), "in_progress");
assert.equal(canonicalStatus("workboard", "review"), "review");
assert.equal(canonicalStatus("workboard", "triage"), "triage");
assert.equal(canonicalStatus("workboard", "blocked"), "blocked");
assert.equal(canonicalStatus("workboard", "done"), "done");
assert.equal(canonicalStatus("workboard", "running", {
  wb: { archived: true, metadata: { archivedAt: 10 } },
}), "archived", "OpenClaw archived metadata overrides its raw status");

for (const status of ["todo", "scheduled", "ready"]) {
  assert.equal(canonicalStatus("hermes", status), "ready", `Hermes ${status}`);
}
assert.equal(canonicalStatus("hermes", "running"), "in_progress");
assert.equal(canonicalStatus("hermes", "review"), "review");
assert.equal(canonicalStatus("hermes", "triage"), "triage");
assert.equal(canonicalStatus("hermes", "blocked"), "blocked");
assert.equal(canonicalStatus("hermes", "done"), "done");
assert.equal(canonicalStatus("hermes", "archived"), "archived");

assert.equal(canonicalStatus("native", "triage"), "triage");
for (const status of ["backlog", "queued"]) {
  assert.equal(canonicalStatus("native", status), "ready", `Native ${status}`);
}
assert.equal(canonicalStatus("native", "running"), "in_progress");
assert.equal(canonicalStatus("native", "review"), "review");
for (const status of ["waiting", "failed", "canceled"]) {
  assert.equal(canonicalStatus("native", status), "blocked", `Native ${status}`);
}
assert.equal(canonicalStatus("native", "done"), "done");
assert.equal(canonicalStatus("native", "failed", { archivedAt: 10 }), "archived");

assert.deepEqual(nativeTargetForCanonical("workboard", "triage", "todo"), {
  action: "move", status: "triage",
});
assert.deepEqual(nativeTargetForCanonical("hermes", "ready", "blocked"), {
  action: "move", status: "ready",
});
assert.deepEqual(nativeTargetForCanonical("native", "blocked", "queued"), {
  action: "move", status: "waiting",
});
assert.deepEqual(nativeTargetForCanonical("native", "archived", "done"), {
  action: "archive", archived: true,
});
assert.deepEqual(nativeTargetForCanonical("native", "triage", "queued"), {
  action: "move", status: "triage",
});
assert.deepEqual(nativeTargetForCanonical("native", "triage", "backlog"), {
  action: "move", status: "triage",
});
assert.deepEqual(nativeTargetForCanonical("native", "ready", "triage"), {
  action: "move", status: "backlog",
});
assert.equal(nativeTargetForCanonical("hermes", "review", "ready"), null,
  "Hermes review is worker-produced");
assert.deepEqual(parseAgentIdentity("openclaw:main"), {
  backendId: "openclaw", agentId: "main",
});
assert.equal(parseAgentIdentity("missing-separator"), null);

const projects = mergeProjectRows([
  { backendId: "hermes", kind: "hermes", slug: "default", name: "Default", total: 2 },
  { backendId: "codex", kind: "native", boardId: "board-c", slug: "default", name: "Default", agentId: "shoggoth-codex", total: 3 },
  { backendId: "hermes", kind: "hermes", slug: "research", name: "研究", total: 4 },
], [
  { key: "empty-project", name: "空项目" },
]);
assert.equal(projects[0].key, "default");
assert.equal(projects[0].total, 5);
assert.equal(projects[0].sources.length, 2, "same project merges backend sources");
assert.equal(projects.find((project) => project.key === "empty-project")?.total, 0);

const openclawCard = {
  id: "same-id",
  title: "Scheduled",
  column: "scheduled",
  backendId: "openclaw",
  agentId: "main",
  labels: ["source-review"],
  badges: { comments: 2, proof: 1 },
  wb: { metadata: { automation: { boardId: "research", scheduledAt: 1_800_000_000_000 } } },
};
const normalized = normalizeFederatedTask(openclawCard, {
  backendId: "openclaw",
  kind: "workboard",
  projectKey: "research",
});
assert.equal(normalized.column, "ready");
assert.equal(normalized.rawStatus, "scheduled");
assert.equal(normalized.projectKey, "research");
assert.equal(normalized.agentKey, agentIdentity("openclaw", "main"));
assert.equal(normalized.scheduledAt, 1_800_000_000_000);
assert.deepEqual(normalized.labels, ["source-review"]);
assert.deepEqual(normalized.badges, { comments: 2, proof: 1 });
assert.equal(normalized.wb, openclawCard.wb, "the raw workboard card must survive the canonical projection for full detail rendering");
assert.equal(taskProjectKey(openclawCard), "research");
assert.notEqual(taskIdentity("openclaw", "same-id"), taskIdentity("hermes", "same-id"));

const columns = buildCanonicalColumns([
  normalized,
  normalizeFederatedTask({ id: "same-id", title: "Done", column: "done" }, {
    backendId: "hermes", kind: "hermes", projectKey: "research",
  }),
]);
assert.equal(columns.length, 7);
assert.equal(columns.find((column) => column.id === "ready").tasks.length, 1);
assert.equal(columns.find((column) => column.id === "done").tasks.length, 1);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-kanban-projects-"));
try {
  const storePath = path.join(tempDir, "projects.json");
  const store = createKanbanProjectStore(storePath);
  const project = store.upsertProject({ slug: "Agent Harness", name: "Agent Harness 研究报告" }, 100);
  assert.equal(project.key, "agent-harness");
  assert.equal(store.listProjects()[0].name, "Agent Harness 研究报告");
  store.bindTask("openclaw", "card/1", "agent-harness");
  assert.equal(store.projectForTask("openclaw", "card/1"), "agent-harness");
  assert.equal(createKanbanProjectStore(storePath).projectForTask("openclaw", "card/1"), "agent-harness");
  assert.equal(store.deleteProject("agent-harness"), true);
  assert.equal(store.listProjects().length, 0);
  assert.equal(store.projectForTask("openclaw", "card/1"), null,
    "deleting a project must clear its task bindings");
  assert.throws(() => store.deleteProject("default"), /Default/u);
  store.removeTaskBinding("openclaw", "card/1");
  assert.equal(store.projectForTask("openclaw", "card/1"), null);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("kanban federation unit: PASS");
