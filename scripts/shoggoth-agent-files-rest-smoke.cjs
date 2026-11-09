"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { AgentFileStore } = require("../app/agent-service/agent-file-store");
const { createAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");

async function waitRunning(service, runId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = service.workDispatcher.getRun(runId);
    if (run?.status === "running" && run.runtimeTurnRef) return run;
    if (["failed", "cancelled", "skipped"].includes(run?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Run did not reach the native host: ${JSON.stringify(service.workDispatcher.getRun(runId))}`);
}

async function run() {
  const f = await openHandoffFixture();
  let server;
  try {
    const backend = new ShoggothBackend({ paths: f.paths });
    backend._state = "started";
    const profile = f.profile;
    const { profile: other } = await f.service.agentLifecycleServiceController.handle("agent.create", {
      operationId: "files-other-agent", backendId: "shoggoth", name: "Other File Owner",
      defaultCwd: null, createdAt: Date.now(),
    });
    await backend._refreshManagedProfiles();
    const registry = new BackendRegistry();
    registry.register(backend);
    registry.setInspirationOwner(backend);
    server = await startStaticServer(0, { registry, homeDir: f.root, userDataRoot: path.join(f.root, "ui") });
    const request = (url, options = {}) => fetch(server.url + url, options);
    const route = (agent = profile, suffix = "") =>
      `/__api/agents/${encodeURIComponent(agent.agentId)}/managed-files${suffix}?backend=shoggoth`;
    const importUrl = route() + "&" + new URLSearchParams({
      operationId: "file-smoke-import", name: "调研结果.txt", mimeType: "text/plain; charset=utf-8",
    });
    const upload = { method: "POST", body: Buffer.from("Import from a clean installation") };
    assert.equal((await request(importUrl, upload)).status, 403);
    upload.headers = { Origin: server.url, "Content-Type": "application/octet-stream" };
    const imported = await request(importUrl, upload);
    assert.equal(imported.status, 200);
    const { file } = await imported.json();
    assert.equal(file.mimeType, "text/plain");
    const replay = await request(importUrl, upload);
    assert.deepEqual((await replay.json()).file, file);
    const payload = route(profile, `/${file.fileId}/content`);
    const meta = route(profile, `/${file.fileId}`);
    const entry = (await (await request(meta)).json()).path;
    assert.equal(entry, path.join(f.paths.agentsDir, profile.id, "files", file.fileId, file.name));
    assert.deepEqual(fs.readFileSync(entry), upload.body);
    assert.equal((await request(route(other, `/${file.fileId}/content`))).status, 404);
    const rename = (url, file, name) => request(url, {
      method: "PUT", headers: { Origin: server.url, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: file.revision, name }),
    });
    const edit = await rename(meta, file, "交付结果.txt");
    const renamed = (await edit.json()).file;
    assert.equal(edit.status, 200);
    assert.equal(renamed.fileId, file.fileId);
    assert.equal(fs.existsSync(entry), false);
    const preview = await request(payload + "&preview=1");
    assert.match(preview.headers.get("content-type"), /^text\/plain/u);
    assert.equal(await preview.text(), upload.body.toString());
    assert.match(preview.headers.get("content-disposition"), new RegExp(encodeURIComponent(renamed.name)));
    const renamedPath = path.join(path.dirname(entry), renamed.name);
    fs.writeFileSync(renamedPath, Buffer.alloc(upload.body.length));
    assert.equal((await request(payload)).status, 404);
    assert.equal((await (await request(meta)).json()).file.status, "missing");
    fs.writeFileSync(renamedPath, upload.body);

    const remove = (url, file) => request(url, {
      method: "DELETE", headers: { Origin: server.url, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: file.revision }),
    });
    const deleteResult = await remove(meta, renamed);
    assert.equal(deleteResult.status, 200);
    assert.equal((await deleteResult.json()).file.status, "deleted");
    const gone = await request(payload);
    assert.equal(gone.status, 410);
    assert.equal((await gone.json()).code, "AGENT_FILE_DELETED");
    assert.deepEqual((await (await request(route())).json()).items, []);

    const session = f.createSession();
    const work = path.join(f.workspace, "made-by-run.txt");
    fs.writeFileSync(work, "Produced by a native Run");
    const nativeRun = await f.send(session.sessionKey, "agent-files-chat-send");
    assert.equal(nativeRun.status, "running", JSON.stringify(nativeRun));
    const publish = (run, runId = run.id, callId = crypto.randomUUID()) => f.service.workRunCoordinator.invokeRuntimeCapability({
      runId: run.id, runtimeProfileId: run.runtimeSessionRef.runtimeProfileId,
      runtimeAccountId: run.runtimeSessionRef.runtimeAccountId, kind: "artifact",
    }, scope => f.service.mcpProductToolController.handle("artifact_publish", {
      runId, relativePath: "made-by-run.txt", name: "Delivered.txt", kind: "document", mimeType: "text/plain",
    }, { profileId: profile.id, callId, confirmation: true }, scope));
    const callId = crypto.randomUUID();
    await assert.rejects(publish(nativeRun, "another-run"), { code: "MCP_TOOL_FORBIDDEN" });
    const published = await publish(nativeRun, nativeRun.id, callId);
    assert.deepEqual(await publish(nativeRun, nativeRun.id, callId), published);
    assert.equal(await (await request(published.file.url)).text(), "Produced by a native Run");
    assert.equal(fs.readFileSync(work, "utf8"), "Produced by a native Run");
    const scoped = (await (await request(route() + "&" + new URLSearchParams({ runId: nativeRun.id }))).json()).items;
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].fileId, published.file.fileId);
    assert.equal(scoped[0].source.sessionKey, session.sessionKey);
    await f.complete(nativeRun);
    await backend._refreshManagedProfiles();
    const artifacts = await backend.listAgentArtifacts(profile.agentId);
    assert.equal(artifacts.items.some(item => item.fileId === published.file.fileId), true);
    const recent = await backend.getRecentArtifacts();
    assert.equal(recent.items.some(item => item.fileId === published.file.fileId), true);
    const group = await f.send(f.createSession().sessionKey, "group-turn-agent-files-boundary");
    assert.equal(group.status, "running");
    await assert.rejects(publish(group), { code: "MCP_TOOL_FORBIDDEN" });
    await f.complete(group);
    console.log("PASS fresh Agent file REST, origin, scoped native chat publish, rename, stable content, Dashboard, delete and cross-Agent denial");

    const job = (await backend._call("cron.job.create", { operationId: crypto.randomUUID(), name: "Private file Cron",
      enabled: false, profileId: profile.id, prompt: "Save a deliverable", workspace: f.workspace,
      schedule: { kind: "at", at: Date.now() + 60_000 }, misfirePolicy: "latest", maxCatchUp: 1,
      overlapPolicy: "skip", threadPolicy: "new", threadId: null, createdAt: Date.now() })).job;
    const triggered = (await backend._call("cron.run.trigger", { operationId: crypto.randomUUID(),
      jobId: job.id, createdAt: Date.now() })).run;
    const cronRun = await waitRunning(f.service, triggered.id);
    const cronFile = (await publish(cronRun)).file;
    await f.complete(cronRun);
    const cronReport = await backend.getDashboardRunDetail(cronRun.id);
    assert.deepEqual(cronReport.artifacts.map(item => item.url), [cronFile.url]);
    assert.deepEqual((await backend.listRunArtifacts(profile.agentId, cronRun.id)).map(item => item.fileId), [cronFile.fileId]);

    const store = f.service.nativeKanbanStore;
    const board = store.listBoards().find(item => item.profileId === profile.id);
    const card = store.createCard({ operationId: crypto.randomUUID(), boardId: board.id, profileId: profile.id,
      title: "Private file Kanban", body: "Save a deliverable", status: "backlog", position: 0, createdAt: Date.now() });
    const dispatched = f.service.kanbanRunService.dispatchCard({ operationId: crypto.randomUUID(),
      cardId: card.id, workspace: f.workspace, createdAt: Date.now() }).run;
    const taskRun = await waitRunning(f.service, dispatched.id);
    const taskFile = (await publish(taskRun)).file;
    await f.complete(taskRun);
    const taskMeta = route(profile, `/${taskFile.fileId}`);
    const taskOriginal = (await (await request(taskMeta)).json()).file;
    const taskRenamed = (await (await rename(taskMeta, taskOriginal, "Renamed task deliverable.txt")).json()).file;
    const task = await backend.getTask(card.id);
    assert.equal(task.artifacts[0].label, taskRenamed.name);
    assert.equal(task.artifacts[0].url, taskFile.url);
    assert.equal((await remove(taskMeta, taskRenamed)).status, 200);
    assert.equal((await backend.getTask(card.id)).artifacts[0].status, "deleted");
    assert.equal((await request(taskFile.url)).status, 410);

    const idea = (await backend._call("inspiration.create", { operationId: crypto.randomUUID(), body: "Private file Spark Note" })).idea;
    const started = (await backend._call("inspiration.start", { operationId: crypto.randomUUID(),
      id: idea.id, expectedRevision: idea.revision, backendId: profile.backendId, agentId: profile.agentId,
      instruction: "Save a deliverable", workspace: f.workspace })).idea.latestExecution;
    const ideaRun = await waitRunning(f.service, started.runId);
    const ideaFile = (await publish(ideaRun)).file;
    await f.complete(ideaRun);
    const ideaFiles = (await (await request(route() + "&" + new URLSearchParams({ runId: started.runId }))).json()).items;
    assert.deepEqual(ideaFiles.map(item => item.fileId), [ideaFile.fileId]);
    assert.equal(ideaFiles[0].source.sessionKey, started.sessionKey);
    assert.equal(ideaFiles[0].source.sourceId, idea.id);
    const activity = await registry.getInspirationActivity(idea.id, ideaRun.id);
    assert.deepEqual(activity.artifacts.items.filter(item => item.fileId).map(item => item.fileId), [ideaFile.fileId]);
    assert.equal((await backend.listRunArtifacts(other.agentId, started.runId)).length, 0);
    assert.equal(fs.readFileSync(work, "utf8"), "Produced by a native Run");
    console.log("PASS Cron report, Kanban stable references and deletion, Spark Note round and Agent isolation");

    const stage = path.join(f.paths.agentsDir, profile.id, "files", `.stage-${"a".repeat(64)}-unused`);
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(stage, "uncommitted.txt"), "not committed", { mode: 0o600 });
    await server.close();
    server = null;
    await f.close({ remove: false });
    const backupId = "private-file-smoke";
    const backup = createAuthorityBackup({ paths: f.paths, backupId });
    assert.equal(backup.manifest.entries.some(item => item.path.includes("/files/.stage-")), false);
    const restored = path.join(f.root, "restored");
    restoreAuthorityBackup({ paths: f.paths, backupId, destinationStateDir: restored });
    const restoredStore = new AgentFileStore({ paths: { ...f.paths, agentsDir: path.join(restored, "agents") },
      productStore: { getAgentProfile: id => id === profile.id ? profile : null } });
    restoredStore.open();
    try {
      const afterRestore = restoredStore.get({ profileId: profile.id, fileId: ideaFile.fileId });
      assert.equal(afterRestore.file.source.runId, ideaRun.id);
      assert.equal(fs.readFileSync(afterRestore.path, "utf8"), "Produced by a native Run");
      const deleted = restoredStore.get({ profileId: profile.id, fileId: taskFile.fileId });
      assert.equal(deleted.file.status, "deleted");
      assert.equal(deleted.path, null);
    } finally { await restoredStore.close(); }
    console.log("PASS authority backup and restore preserve private bytes, source IDs and deleted receipts without staging");
  } finally {
    if (server) await server.close();
    await f.close();
  }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
