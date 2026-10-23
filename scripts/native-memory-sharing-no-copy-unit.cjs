"use strict";
// Actual Product Service/MCP/Coordinator and owner indexes. The native Runtime
// transport is controlled; provider execution is outside this acceptance.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
const MARKER = "BORROWED_NO_COPY_BODY_763819";
const FACT = `The telescope code is ${MARKER}.`;
const FRESH = "My telescope needs a violet lens cap FRESH_USER_FACT_839142.";

async function fixture() {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memorySharingFeatureReady: true,
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
      plugins: { entries: { "active-memory": { config: { enabled: false } } } } } } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  const B = "no-copy-source-b", source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  Object.assign(source, { id: B, agentId: B, runtimeProfileId: B, name: B, isDefault: false });
  f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: B });
  const owner = f.service.memoryEngine;
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  f.service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  const item = await owner.propose({ profileId: B, content: FACT, scope: "agent", classification: "explicit",
    sourceRefs: ["user-edit:no-copy-source"] });
  return { ...f, B, owner, item };
}
function databaseText(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())).join("\n");
}
function markdownText(directory) {
  if (!fs.existsSync(directory)) return "";
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownText(target) : entry.isFile() && entry.name.endsWith(".md") ? fs.readFileSync(target, "utf8") : "";
  }).join("\n");
}
function callFor(f, run) {
  return (name, args) => f.service.mcpProductToolController.handle(name,
    { source: "chat", sourceId: run.sourceId, ...args }, { profileId: f.profile.id, callId: crypto.randomUUID() });
}
function ownerState(f) {
  return { file: fs.readFileSync(path.join(f.owner.store.workspace(f.B), "MEMORY.md"), "utf8"),
    revision: f.owner.store.getRevision(f.B), item: f.owner.store.get(f.B, f.item.id) };
}
function assertNoReaderBody(f) {
  assert.doesNotMatch(markdownText(f.owner.store.workspace(f.profile.id)), new RegExp(MARKER), "reader Markdown never persists the source fact");
  assert.equal(databaseText(f.owner.host(f.profile.id).database.db).includes(MARKER), false, "reader SQLite/FTS/short-term recall/diagnostics never persists the source fact");
  assert.equal(f.owner.store.list(f.profile.id).some(item => item.content.includes(MARKER)), false,
    "both active and candidate records are free of borrowed source content");
}

test("borrowed chat manual writes require the complete independent fact in the current user event", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const session = f.createSession(), prompt = `Please find relevant telescope memory. My fresh fact: ${FRESH}`;
    const run = await f.send(session.sessionKey, "no-copy-manual", prompt); assert.equal(run.status, "running", run.errorCode);
    const before = ownerState(f), call = callFor(f, run);
    const found = await call("memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0, maxResults: 20 });
    assert.ok(found.results.some(value => value.ownerProfileId === f.B && value.borrowed));
    assert.ok(f.owner.sharing.borrowedRefsForRun(run.id).length > 0);
    const revision = f.owner.store.getRevision(f.profile.id);
    await assert.rejects(call("memory_save", { expectedRevision: revision, content: FACT,
      scope: "agent", classification: "explicit", sourceQuote: prompt }), { code: "MEMORY_BORROWED_READ_ONLY" },
    "shared query keywords do not prove that the user supplied the source fact");
    const user = f.service.transcriptStore.listEvents(f.profile.id, session.id).find(event => event.kind === "user" && event.runId === run.id);
    await assert.rejects(f.owner.propose({ profileId: f.profile.id, id: "no-copy-direct-attempt", content: FACT,
      scope: "agent", classification: "explicit", sourceRefs: [user.id, run.id], expectedRevision: revision }),
    { code: "MEMORY_BORROWED_READ_ONLY" }, "the common Service write entrance rejects the same unproven copy");
    assertNoReaderBody(f); assert.deepEqual(ownerState(f), before);
    assert.equal(f.owner.store.getRevision(f.profile.id), revision, "rejected copies have no primary-store write");
    const saved = await call("memory_save", { expectedRevision: revision, content: FRESH,
      scope: "agent", classification: "explicit", sourceQuote: FRESH });
    assert.equal(saved.saved, true); assert.equal(saved.item.status, "active"); assert.equal(saved.item.content, FRESH);
    assert.ok(f.owner.store.list(f.profile.id).some(item => item.content === FRESH), "current independent user facts remain saveable in a borrowed chat");
    assertNoReaderBody(f); assert.deepEqual(ownerState(f), before);
    await f.complete(run, "Saved only the user's independently supplied new fact");
  } finally { await f.close(); }
});

test("borrowed model queries do not persist body text in the reader's own recall diagnostics", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.owner.propose({ profileId: f.profile.id, content: "My own telescope needs a lens cap", scope: "agent",
      classification: "explicit", sourceRefs: ["user-edit:no-copy-own"] });
    const session = f.createSession(), run = await f.send(session.sessionKey, "no-copy-query", "Find telescope notes");
    assert.equal(run.status, "running", run.errorCode);
    const before = ownerState(f), call = callFor(f, run);
    const found = await call("memory_search", { query: "telescope", minScore: 0, maxResults: 20 });
    assert.ok(found.results.some(value => value.borrowed && value.ownerProfileId === f.B));
    assert.ok(found.results.some(value => !value.borrowed), "an own hit exercises native recall logging");
    const queried = await call("memory_search", { query: FACT, minScore: 0, maxResults: 20 });
    assert.ok(queried.results.some(value => !value.borrowed), "body-bearing model query still completes its authorized own read");
    assertNoReaderBody(f); assert.deepEqual(ownerState(f), before);
    await f.complete(run, "Independent answer after an in-memory borrowed-context query");
  } finally { await f.close(); }
});
