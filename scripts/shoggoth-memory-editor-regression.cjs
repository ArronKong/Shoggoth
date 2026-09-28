#!/usr/bin/env node
"use strict";

// Real Service -> Backend -> REST -> memory journal/projections/context. Model
// processes are fixture-only; no installed profiles or accounts are modified.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { workspaceMemoryRef } = require("../app/agent-service/memory-engine");

async function verify(f) {
  const { service } = f;
  const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const other = service.productStore.listAgentProfiles().find((item) => item.id !== profile.id);
  const base = `/__api/agents/${encodeURIComponent(profile.agentId)}`;
  const request = async (suffix, method = "GET", body, browserOrigin = true) => {
    const response = await fetch(`${f.url}${base}/${suffix}${suffix.includes("?") ? "&" : "?"}backend=shoggoth`, {
      method, ...(body ? { headers: { "Content-Type": "application/json",
        ...(browserOrigin ? { Origin: new URL(f.url).origin } : {}) },
      body: JSON.stringify(body) } : {}),
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
  assert.equal(initial.recallPolicy.ready, true);
  assert.deepEqual(initial.items, []);
  const noOriginCreate = await request("memory", "POST", { action: "create",
    content: "无 Origin 的写入", scope: "user", expectedRevision: 0 }, false);
  assert.equal(noOriginCreate.response.status, 403);
  assert.equal((await list()).revision, 0);
  let result = await write("POST", { action: "create", content: "用户希望被称呼为林溪", scope: "user", expectedRevision: 0,
    profileId: other.id }); // Body input must never redirect the route's Agent target.
  const userItem = result.item;
  const explain = async (memoryId) => (await request(`memory-explain?memoryId=${encodeURIComponent(memoryId)}`)).data.explanation;
  assert.equal(userItem.status, "active");
  assert.equal(userItem.confidence, 1);
  assert.match(userItem.sourceRefs[0], /^user-edit:/u);
  const noOriginUpdate = await request("memory", "PUT", { id: userItem.id,
    content: "无 Origin 的改写", confidence: 1, validUntil: null,
    expectedRevision: result.revision }, false);
  assert.equal(noOriginUpdate.response.status, 403);
  const noOriginDelete = await request("memory", "DELETE", {
    id: userItem.id, expectedRevision: result.revision }, false);
  assert.equal(noOriginDelete.response.status, 403);
  assert.equal(service.memoryStore.get(profile.id, userItem.id).status, "active");
  assert.equal((await explain(userItem.id)).evidence.status, "verified_origin");
  for (const kind of ["USER", "MEMORY"]) assert.match((await read(kind)).content, /林溪/u);
  const stale = await request("memory", "POST", { action: "create", content: "旧窗口写入", scope: "agent", expectedRevision: 0 });
  assert.notEqual(stale.response.status, 200);
  assert.match(JSON.stringify(stale.data), /HARNESS_REVISION_CONFLICT/u);
  assert.equal((await list()).items.length, 1);
  console.log("PASS manual creation is immediately active; stale writes cannot overwrite newer memory");

  result = await write("PUT", { id: userItem.id, content: "用户希望被称呼为林予", confidence: 1,
    validUntil: null, expectedRevision: result.revision });
  const editedUser = result.item;
  assert.notEqual(editedUser.id, userItem.id);
  assert.equal(editedUser.supersedes, userItem.id);
  assert.equal(service.memoryStore.get(profile.id, userItem.id).status, "superseded");
  assert.equal(userItem.sourceRefs.some((ref) => editedUser.sourceRefs.includes(ref)), false,
    "新内容不得沿用旧来源");
  assert.match(editedUser.sourceRefs[0], /^user-edit:/u);
  assert.equal((await explain(editedUser.id)).evidence.origin, "ui_edit");
  assert.equal((await explain(userItem.id)).item.status, "superseded");
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
  assert.equal((await explain(personal.item.id)).item.status, "deleted");
  assert.doesNotMatch((await read("MEMORY")).content, /manual.qa@example.com/u);
  console.log("PASS manual correction/deletion synchronizes USER and MEMORY, preserves provenance and Agent isolation");

  // A conversation save after a manual edit must add a record without losing it.
  service.memoryEngine.propose({ profileId: profile.id, classification: "explicit", content: "持续项目青石-417",
    scope: "project", type: "project", sourceRefs: ["fixture-conversation", workspaceMemoryRef("/workspace/a")] });
  const project = service.memoryStore.list(profile.id).find((item) => item.content.includes("青石-417"));
  result = await write("PUT", { id: project.id, content: "持续项目青石-418", confidence: 1,
    validUntil: project.validUntil, expectedRevision: service.memoryStore.getRevision(profile.id) });
  for (const key of ["scope", "type", "validUntil"]) assert.deepEqual(result.item[key], project[key]);
  assert.notEqual(result.item.id, project.id);
  assert.equal(result.item.supersedes, project.id);
  assert.equal(service.memoryStore.get(profile.id, project.id).status, "superseded");
  assert.deepEqual(result.item.sourceRefs.filter((ref) => ref.startsWith("workspace:")),
    project.sourceRefs.filter((ref) => ref.startsWith("workspace:")));
  assert.equal(result.item.sourceRefs.includes("fixture-conversation"), false);
  assert.equal(service.memoryEngine.search({ profileId: profile.id, query: "青石", workspace: "/workspace/b" }).items
    .some((item) => item.id === project.id), false);
  assert.match((await read("MEMORY")).content, /林予/u);

  const relatedOnly = service.memoryEngine.propose({ profileId: profile.id,
    classification: "explicit", content: "用户喜欢安静的工作环境", scope: "user",
    type: "semantic", sourceRefs: ["fixture-conversation"] });
  assert.equal((await explain(relatedOnly.id)).evidence.status, "legacy_unverified");
  const duplicateRevision = service.memoryStore.getRevision(profile.id);
  const duplicateCreate = await write("POST", { action: "create",
    content: relatedOnly.content, scope: "user", expectedRevision: duplicateRevision });
  assert.equal(duplicateCreate.item.id, relatedOnly.id);
  assert.equal(duplicateCreate.revision, duplicateRevision);
  assert.equal((await explain(relatedOnly.id)).evidence.status, "legacy_unverified",
    "重复的 UI 创建不得把旧会话记忆标成已验证的 UI 来源");

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
  const source = service.memoryStore.get(profile.id, editedUser.id);
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

  // A committed forget may outlive a failed Markdown projection write. Normal
  // file reads must never return the old USER/MEMORY text in that interval.
  const definitions = service.agentDefinitionStore;
  for (const failedMethod of ["writeGeneratedView", "update"]) {
    const forgottenText = `投影故障遗忘-${failedMethod}`;
    const saved = await write("POST", { action: "create", content: forgottenText,
      scope: "user", expectedRevision: service.memoryStore.getRevision(profile.id) });
    for (const kind of ["USER", "MEMORY"]) {
      assert.match((await read(kind)).content, new RegExp(forgottenText, "u"));
    }
    const original = definitions[failedMethod];
    definitions[failedMethod] = () => { throw new Error(`injected ${failedMethod} failure`); };
    try {
      const deleted = await write("DELETE", { id: saved.item.id,
        expectedRevision: saved.revision });
      assert.equal(deleted.item.status, "deleted");
      assert.equal(service.memoryEngine.viewStatus(profile.id).stale, true);
      for (const kind of ["USER", "MEMORY"]) {
        const failedRead = await request(`file?file=${kind}.md`);
        assert.notEqual(failedRead.response.status, 200,
          `${kind}.md must fail closed after ${failedMethod} failure`);
        assert.doesNotMatch(JSON.stringify(failedRead.data), new RegExp(forgottenText, "u"));
      }
    } finally {
      definitions[failedMethod] = original;
    }
    for (const kind of ["USER", "MEMORY"]) {
      const recovered = await request(`file?file=${kind}.md`);
      assert.equal(recovered.response.status, 200, JSON.stringify(recovered.data));
      assert.doesNotMatch(recovered.data.file.content, new RegExp(forgottenText, "u"));
    }
    assert.equal(service.memoryEngine.viewStatus(profile.id).stale, false);
  }
  console.log("PASS current USER/MEMORY file reads fail closed after projection faults and recover safely");

  const importRoot = path.join(f.root, "codex", "memories");
  fs.mkdirSync(importRoot, { recursive: true, mode: 0o700 });
  const importBytes = Buffer.from("Imported REST fixture fact.\n");
  fs.writeFileSync(path.join(importRoot, "fixture.md"), importBytes, { mode: 0o600 });
  assert.equal(service.memoryEngine.importCodexNative({ profileId: profile.id, root: importRoot }).imported, 1);
  const importedItem = service.memoryStore.list(profile.id, { status: "active" })
    .find((item) => item.content === "Imported REST fixture fact.");
  assert.ok(importedItem);
  const importedExplanation = await explain(importedItem.id);
  assert.deepEqual(importedExplanation.evidence.importFile, { name: "fixture.md",
    sha256: crypto.createHash("sha256").update(importBytes).digest("hex") });
  assert.equal(importedExplanation.evidence.status, "verified_origin");
  console.log("PASS production service import records file source through REST explain");
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
