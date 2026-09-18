#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createKanbanProjectStore } = require("../app/core/kanban-project-store");

function backend(id, name, kind, fixture) {
  return {
    id,
    name,
    getBackendDescriptor() {
      return { id, name, surfaces: { kanban: { kind } } };
    },
    async listAgents() { return fixture.agents || []; },
    async getBoards() {
      if (fixture.boardsError) throw fixture.boardsError;
      return fixture.boards || [];
    },
    async getTaskBoard(opts) {
      fixture.boardReads ||= [];
      fixture.boardReads.push(opts || {});
      return fixture.taskBoards?.[opts?.board || "default"] || fixture.taskBoard || { columns: [] };
    },
    async getTask(idValue) {
      return { id: idValue, title: idValue, body: "", column: fixture.currentStatus || "todo", backendId: id };
    },
    async createBoard(spec) {
      fixture.createdBoards ||= [];
      fixture.createdBoards.push(spec);
      return { id: `${id}-board-${spec.slug}`, slug: spec.slug, name: spec.name, agentId: spec.agentId };
    },
    async deleteBoard(slug, hard) {
      fixture.deletedBoards ||= [];
      fixture.deletedBoards.push({ slug, hard });
      if (fixture.deleteBoardError) throw fixture.deleteBoardError;
      return { ok: true };
    },
    async createTask(spec, opts) {
      fixture.createdTasks ||= [];
      fixture.createdTasks.push({ spec, opts });
      return { id: `${id}-created`, title: spec.title, column: spec.status || "backlog", backendId: id };
    },
    async moveTask(idValue, status, position, opts) {
      fixture.moves ||= [];
      fixture.moves.push({ id: idValue, status, position, opts });
      return { id: idValue, title: idValue, column: status, backendId: id };
    },
    async archiveTask(idValue, archived, opts) {
      fixture.archives ||= [];
      fixture.archives.push({ id: idValue, archived, opts });
      return { id: idValue, title: idValue, column: archived ? "archived" : "todo", backendId: id };
    },
    async deleteTask(idValue, opts) {
      fixture.deletedTasks ||= [];
      fixture.deletedTasks.push({ id: idValue, opts });
      if (fixture.deleteTaskError) throw fixture.deleteTaskError;
    },
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-federated-registry-"));
  try {
    const store = createKanbanProjectStore(path.join(tempDir, "projects.json"));
    store.upsertProject({ slug: "research", name: "研究项目" }, 1);
    store.bindTask("openclaw", "oc-1", "research");
    const openclaw = {
      agents: [{ id: "main", name: "Main", backendId: "openclaw" }],
      taskBoard: {
        columns: [{ id: "scheduled", tasks: [{
          id: "oc-1", title: "Timed", column: "scheduled", agentId: "main",
          wb: { metadata: { automation: { boardId: "research", scheduledAt: 2_000_000_000_000 } } },
        }] }],
        capabilities: { run: true, archive: true },
      },
    };
    const hermes = {
      agents: [{ id: "hermes-builder", name: "Builder", kanbanAssignee: "builder", backendId: "hermes" }],
      boards: [{ slug: "research", name: "Research", total: 1 }],
      taskBoards: {
        research: {
          columns: [{ id: "triage", tasks: [{ id: "he-1", title: "Idea", column: "triage", agentId: "hermes-builder" }] }],
          capabilities: { drag: true, archive: true, completionSummary: true },
        },
      },
    };
    const native = {
      agents: [{ id: "shoggoth-codex", name: "Codex", backendId: "codex" }],
      boards: [{ id: "native-board", slug: "research", name: "Research", total: 1, agentId: "shoggoth-codex" }],
      taskBoards: {
        "native-board": {
          columns: [{ id: "queued", tasks: [{ id: "na-1", title: "Queued", column: "queued", agentId: "shoggoth-codex" }] }],
          capabilities: { run: true, archive: true },
        },
      },
    };
    const pi = {
      agents: [{ id: "shoggoth-pi", name: "Pi", backendId: "pi" }],
      boards: [{
        id: "pi-default-board",
        slug: "agent-pi-profile",
        projectKey: "default",
        name: "Pi",
        total: 1,
        agentId: "shoggoth-pi",
      }],
      taskBoards: {
        "pi-default-board": {
          columns: [{ id: "backlog", tasks: [{
            id: "pi-1", title: "Pi default task", column: "backlog", agentId: "shoggoth-pi",
          }] }],
          capabilities: { run: true, archive: true },
        },
      },
    };

    const registry = new BackendRegistry();
    registry.attachKanbanProjectStore(store);
    registry.register(backend("openclaw", "OpenClaw", "workboard", openclaw));
    registry.register(backend("hermes", "Hermes", "hermes", hermes));
    registry.register(backend("codex", "Codex", "native", native));
    registry.register(backend("pi", "Pi", "native", pi));

    const board = await registry.getFederatedKanban({ project: "research" });
    assert.equal(board.project.key, "research");
    assert.equal(board.project.name, "研究项目");
    assert.equal(board.project.sources.length, 3);
    assert.equal(board.project.total, 3);
    assert.deepEqual(board.columns.map((column) => column.id), [
      "triage", "ready", "in_progress", "review", "blocked", "done", "archived",
    ]);
    assert.equal(board.columns.find((column) => column.id === "triage").tasks[0].backendId, "hermes");
    const scheduled = board.columns.find((column) => column.id === "ready").tasks.find((task) => task.id === "oc-1");
    assert.equal(scheduled.rawStatus, "scheduled");
    assert.equal(scheduled.scheduledAt, 2_000_000_000_000);
    assert.ok(board.agents.some((agent) => agent.agentKey === "openclaw:main"));
    assert.ok(board.agents.some((agent) => agent.agentKey === "hermes:hermes-builder"));

    const defaultBoard = await registry.getFederatedKanban({ project: "default" });
    assert.equal(defaultBoard.project.key, "default");
    assert.ok(defaultBoard.project.sources.some((source) => (
      source.backendId === "pi" && source.boardId === "pi-default-board"
    )));
    assert.equal(defaultBoard.columns.find((column) => column.id === "ready").tasks[0].id, "pi-1");

    await registry.createFederatedTask("default", "pi:shoggoth-pi", {
      title: "Created on Pi", status: "ready",
    });
    assert.equal(pi.createdBoards, undefined, "logical default must reuse Pi's physical default board");
    assert.equal(pi.createdTasks.at(-1).spec.board, "pi-default-board");

    await registry.moveFederatedTask({
      backendId: "hermes", id: "he-1", rawStatus: "triage", sourceBoard: "research",
    }, "ready");
    assert.equal(hermes.moves.at(-1).status, "ready");
    assert.equal(hermes.moves.at(-1).opts.board, "research");
    await assert.rejects(() => registry.moveFederatedTask({
      backendId: "hermes", id: "he-1", rawStatus: "triage", sourceBoard: "research",
    }, "in_progress"), /无法移动/u);

    await registry.moveFederatedTask({
      backendId: "hermes", id: "he-archived", rawStatus: "archived", sourceBoard: "research",
    }, "blocked");
    assert.deepEqual(hermes.archives.at(-1), {
      id: "he-archived", archived: false, opts: { board: "research" },
    });
    assert.equal(hermes.moves.at(-1).status, "blocked");
    const archiveCount = hermes.archives.length;
    await assert.rejects(() => registry.moveFederatedTask({
      backendId: "hermes", id: "he-archived", rawStatus: "archived", sourceBoard: "research",
    }, "review"), /无法移动/u);
    assert.equal(hermes.archives.length, archiveCount, "unsupported target must not partially unarchive");

    await registry.moveFederatedTask({
      backendId: "codex", id: "na-new", rawStatus: "backlog", sourceBoard: "native-board",
    }, "blocked");
    assert.deepEqual(native.moves.slice(-2).map((move) => move.status), ["queued", "waiting"]);
    await registry.moveFederatedTask({
      backendId: "codex", id: "na-new", rawStatus: "waiting", sourceBoard: "native-board",
    }, "archived");
    assert.deepEqual(native.archives.at(-1), {
      id: "na-new", archived: true, opts: { board: "native-board" },
    });

    const created = await registry.createFederatedTask("research", "openclaw:main", {
      title: "Created", status: "triage",
    });
    assert.equal(openclaw.createdTasks[0].spec.agentId, "main");
    assert.equal(openclaw.createdTasks[0].spec.status, "triage");
    assert.equal(created.projectKey, "research");
    assert.equal(store.projectForTask("openclaw", "openclaw-created"), "research");

    await registry.createFederatedTask("research", "hermes:hermes-builder", {
      title: "Already complete", body: "Completion note", status: "done",
    });
    assert.equal(hermes.createdTasks.at(-1).spec.status, "todo");
    assert.equal(hermes.moves.at(-1).status, "done");
    assert.equal(hermes.moves.at(-1).opts.summary, "Completion note");

    await assert.rejects(() => registry.deleteFederatedKanbanProject("research"), /Codex.*不支持永久删除/u,
      "a native source must block the whole deletion during preflight");
    assert.equal(openclaw.deletedTasks, undefined, "preflight rejection must not delete OpenClaw tasks");
    assert.equal(hermes.deletedBoards, undefined, "preflight rejection must not delete Hermes boards");

    native.boards = [];
    hermes.boardsError = new Error("Hermes unavailable");
    await assert.rejects(() => registry.deleteFederatedKanbanProject("research"), /hermes 当前不可用/u,
      "an unavailable backend must block the whole deletion during preflight");
    assert.equal(openclaw.deletedTasks, undefined);
    assert.equal(hermes.deletedBoards, undefined);

    hermes.boardsError = null;
    openclaw.deleteTaskError = new Error("OpenClaw delete failed");
    await assert.rejects(() => registry.deleteFederatedKanbanProject("research"), /部分失败/u);
    assert.ok(store.listProjects().some((project) => project.key === "research"),
      "a partial backend failure must retain the local project for retry");
    assert.equal(store.projectForTask("openclaw", "oc-1"), "research");

    openclaw.deleteTaskError = null;
    const deleted = await registry.deleteFederatedKanbanProject("research");
    assert.deepEqual(deleted, { key: "research", deletedTasks: 1, deletedBoards: 1 });
    assert.deepEqual(openclaw.deletedTasks.at(-1), { id: "oc-1", opts: undefined });
    assert.deepEqual(hermes.deletedBoards.at(-1), { slug: "research", hard: true });
    assert.ok(!store.listProjects().some((project) => project.key === "research"));
    assert.equal(store.projectForTask("openclaw", "oc-1"), null);
    await assert.rejects(() => registry.deleteFederatedKanbanProject("default"), /Default/u);

    console.log("kanban federated registry unit: PASS");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
