#!/usr/bin/env node
"use strict";

// Real Service -> Backend -> REST -> memory journal/projections/context. Model
// processes are fixture-only; no installed profiles or accounts are modified.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { workspaceMemoryRef } = require("../app/agent-service/memory-engine");

async function verify(f) {
  const { service } = f;
  const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const other = service.productStore.listAgentProfiles().find((item) => item.id !== profile.id);
  const base = `/__api/agents/${encodeURIComponent(profile.agentId)}`;
  const request = async (suffix, method = "GET", body) => {
    const response = await fetch(`${f.url}${base}/${suffix}${suffix.includes("?") ? "&" : "?"}backend=shoggoth`, {
      method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    return { response, data };
  };
  const write = async (method, body) => {
    const { response, data } = await request("memory", method, body);
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  };
  const list = async (cursor = 0) => (await request(`memories?status=active&cursor=${cursor}&limit=50`)).data.memories;
  const read = async (kind) => (await request(`file?file=${kind}.md`)).data.file;
  const initial = await list();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.items, []);
  let result = await write("POST", { action: "create", content: "用户希望被称呼为林溪", scope: "user", expectedRevision: 0,
    profileId: other.id }); // Body input must never redirect the route's Agent target.
  const userItem = result.item;
  assert.equal(userItem.status, "active");
  assert.equal(userItem.confidence, 1);
  assert.match(userItem.sourceRefs[0], /^user-edit:/u);
  for (const kind of ["USER", "MEMORY"]) assert.match((await read(kind)).content, /林溪/u);
  const stale = await request("memory", "POST", { action: "create", content: "旧窗口写入", scope: "agent", expectedRevision: 0 });
  assert.notEqual(stale.response.status, 200);
  assert.match(JSON.stringify(stale.data), /HARNESS_REVISION_CONFLICT/u);
  assert.equal((await list()).items.length, 1);
  console.log("PASS manual creation is immediately active; stale writes cannot overwrite newer memory");

  result = await write("PUT", { id: userItem.id, content: "用户希望被称呼为林予", confidence: 1,
    validUntil: null, expectedRevision: result.revision });
  assert.ok(userItem.sourceRefs.every((ref) => result.item.sourceRefs.includes(ref)));
  assert.ok(result.item.sourceRefs.includes("user-edit:agent-settings"));
  for (const kind of ["USER", "MEMORY"]) {
    const file = await read(kind);
    assert.match(file.content, /林予/u); assert.doesNotMatch(file.content, /林溪/u);
  }
  const personal = await write("POST", { action: "create", content: "联络邮箱 manual.qa@example.com", scope: "agent", expectedRevision: result.revision });
  assert.equal(personal.item.sensitivity, "private");
  assert.equal(personal.item.status, "active");
  for (const content of ["   ", "password=not-a-real-credential-fixture", "长".repeat(8193)]) {
    const rejected = await request("memory", "POST", { action: "create", content, scope: "agent", expectedRevision: personal.revision });
    assert.notEqual(rejected.response.status, 200);
    assert.equal((await list()).revision, personal.revision);
  }
  assert.deepEqual(service.memoryStore.list(other.id), []);
  const removed = await write("DELETE", { id: personal.item.id, expectedRevision: personal.revision });
  assert.equal(removed.item.status, "deleted");
  assert.doesNotMatch((await read("MEMORY")).content, /manual.qa@example.com/u);
  console.log("PASS manual correction/deletion synchronizes USER and MEMORY, preserves provenance and Agent isolation");

  // A conversation save after a manual edit must add a record without losing it.
  service.memoryEngine.propose({ profileId: profile.id, classification: "explicit", content: "持续项目青石-417",
    scope: "project", type: "project", sourceRefs: ["fixture-conversation", workspaceMemoryRef("/workspace/a")] });
  const project = service.memoryStore.list(profile.id).find((item) => item.content.includes("青石-417"));
  result = await write("PUT", { id: project.id, content: "持续项目青石-418", confidence: 1,
    validUntil: project.validUntil, expectedRevision: service.memoryStore.getRevision(profile.id) });
  for (const key of ["scope", "type", "validFrom", "validUntil"]) assert.deepEqual(result.item[key], project[key]);
  assert.ok(project.sourceRefs.every((ref) => result.item.sourceRefs.includes(ref)));
  assert.equal(service.memoryEngine.search({ profileId: profile.id, query: "青石", workspace: "/workspace/b" }).items
    .some((item) => item.id === project.id), false);
  assert.match((await read("MEMORY")).content, /林予/u);

  const session = service.chatSessionStore.listSessions().find((item) => item.profileId === profile.id);
  const started = await f.ipc("chat.send", { operationId: crypto.randomUUID(), sessionKey: session.sessionKey,
    prompt: "你知道我希望怎么称呼吗？", createdAt: Date.now() });
  let run;
  for (let attempt = 0; attempt < 500; attempt++) {
    run = service.workRunCoordinator.getRun(started.run.id);
    if (run.contextSnapshotId) break;
    assert.ok(!["failed", "canceled", "interrupted"].includes(run.status), JSON.stringify(run));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = service.contextSnapshotStore.get(profile.id, run.contextSnapshotId);
  assert.match(snapshot.dynamicContext, /林予/u);
  assert.doesNotMatch(snapshot.dynamicContext, /林溪|manual.qa@example.com/u);
  await f.ipc("chat.abort", { operationId: crypto.randomUUID(), sessionKey: session.sessionKey,
    runId: run.id, createdAt: Date.now() });
  console.log("PASS later chat context recalls manual edits; deleted values and other-workspace facts remain excluded");

  // Edit a visible row without dropping records beyond the first UI page.
  const source = service.memoryStore.get(profile.id, userItem.id);
  service.memoryStore.upsertMany(Array.from({ length: 55 }, (_, index) => ({ ...source,
    id: `editor-page-${index}`, scope: "agent", content: `分页记忆-${index}`, createdAt: source.createdAt + index,
    updatedAt: source.updatedAt + index, sourceRefs: ["fixture-page"] })));
  service.memoryEngine.rebuildViews(profile.id);
  const first = await list();
  assert.equal(first.items.length, 50); assert.equal(first.hasMore, true);
  const hidden = (await list(first.nextCursor)).items;
  const selected = first.items[0];
  await write("PUT", { id: selected.id, content: "分页中的手动修改", confidence: selected.confidence,
    validUntil: selected.validUntil, expectedRevision: first.revision });
  for (const item of hidden) assert.deepEqual(service.memoryStore.get(profile.id, item.id), item);
  assert.equal(service.memoryStore.list(profile.id, { status: "candidate" }).length, 0);
  assert.equal((await read("TOOLS")).readOnly, true);
  console.log("PASS pagination edits preserve unseen memories; generated TOOLS remains available to the runtime");
}

async function main() {
  const f = await startInspirationFixture({ agentCount: 2 });
  try { await verify(f); } finally { await f.close(); }
  if (process.argv.includes("--serve")) {
    const preview = await startInspirationFixture({ agentCount: 2 });
    const control = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(preview.service.productStore.listAgentProfiles().map((profile) => ({
        id: profile.id, name: profile.name,
        memories: preview.service.memoryStore.list(profile.id),
        memoryView: preview.service.agentDefinitionStore.readGeneratedView(profile.id, "MEMORY"),
        userView: preview.service.agentDefinitionStore.get(profile.id).documents.USER,
      }))));
    });
    await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
    console.log(JSON.stringify({ preview: preview.url, inspect: `http://127.0.0.1:${control.address().port}`, root: preview.root }));
    const close = async () => { control.close(); await preview.close(); process.exit(0); };
    process.once("SIGINT", close); process.once("SIGTERM", close);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
