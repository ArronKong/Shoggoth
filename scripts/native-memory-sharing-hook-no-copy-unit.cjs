"use strict";
// Actual Service/MCP/Coordinator and Hook stores/process host; only native
// Runtime transport is controlled. No production profile or Provider is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { AGENT_PROFILE_FIELDS } = require("../app/agent-service/product-store");
const { validateDefinition } = require("../app/agent-service/hook-contract");
// The real Hook host requires sandbox-exec. These cases are mandatory in the
// macos-hook-checks CI job; Linux still runs the rest of the memory suite.
const sandboxSkip = process.platform === "darwin" ? false : "requires macOS sandbox-exec; covered by macos-hook-checks";
const MARKER = "BORROWED_HOOK_EVENT_COPY_914857";
const FACT = `The telescope code is ${MARKER}.`;
const OWN = "OWN_HOOK_CONTROL_BODY_769131";

function databaseText(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())).join("\n");
}
function install(f, { event, kind, source }) {
  const definition = validateDefinition({ schemaVersion: 1, name: `copy probe ${event}`, kind, event,
    scope: { workspace: "current", sources: ["chat"] }, matcher: { toolScopes: ["product"], toolNames: ["memory_*"] },
    handler: { type: "script", language: "javascript", source } }, f.workspace);
  const store = f.service.hookStore, item = store.register(f.profile.id, crypto.randomUUID(), definition);
  // Test-only attestation of a controlled definition. Production grants and
  // existing Hook versions are untouched.
  store.recordTest(f.profile.id, item.hookId, item.version, item.contentDigest, true);
  store.grant(f.profile.id, crypto.randomUUID(), item.hookId, item.version);
  store.activate(f.profile.id, crypto.randomUUID(), item.hookId, item.version, item.revision, () => {});
  return item;
}
async function fixture() {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memorySharingFeatureReady: true,
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
      plugins: { entries: { "active-memory": { config: { enabled: false } } } } } } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  const B = "hook-copy-source-b", profile = Object.fromEntries(AGENT_PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  Object.assign(profile, { id: B, agentId: B, runtimeProfileId: B, name: B, isDefault: false });
  f.service.productStore.putAgentProfile(profile); f.service.agentDefinitionStore.ensureProfile({ profileId: B });
  const owner = f.service.memoryEngine;
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  f.service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  const item = await owner.propose({ profileId: B, content: FACT, scope: "agent", classification: "explicit",
    sourceRefs: ["user-edit:hook-copy-source"] });
  await owner.propose({ profileId: f.profile.id, content: `My own telescope cap is ${OWN}.`, scope: "agent", classification: "explicit",
    sourceRefs: ["user-edit:hook-copy-reader"] });
  return { ...f, B, owner, item };
}
function sourceState(f) {
  return { file: fs.readFileSync(path.join(f.owner.store.workspace(f.B), "MEMORY.md"), "utf8"),
    revision: f.owner.store.getRevision(f.B), item: f.owner.store.get(f.B, f.item.id) };
}
function scope(run) { return { runId: run.id, signal: new AbortController().signal, assertCurrent() {} }; }
function callFor(f, run) {
  return (name, args) => f.service.mcpProductToolController.handle(name,
    { source: "chat", sourceId: run.sourceId, ...args }, { profileId: f.profile.id, callId: crypto.randomUUID() }, scope(run));
}
async function assertNoHookCopy(f) {
  await f.service.hookRunner.drain();
  assert.equal(databaseText(f.service.hookStore.db).includes(MARKER), false,
    "Hook event payloads, worker receipts, executions and transformed outputs never persist borrowed source text");
  const product = f.service.productStore.paths;
  const productText = [product.eventLogPath, product.stateSnapshotPath].filter(target => target && fs.existsSync(target))
    .map(target => fs.readFileSync(target, "utf8")).join("\n");
  assert.equal(productText.includes(MARKER), false, "Product MCP JSONL journal and snapshot receipts remain body-free");
  assert.equal(databaseText(f.owner.host(f.profile.id).database.db).includes(MARKER), false,
    "reader recall/diagnostics remain body-free when tool query contains borrowed text");
}

test("payload observers and result transforms cannot persist borrowed memory through tool results or later arguments", { timeout: 40000, skip: sandboxSkip }, async () => {
  const f = await fixture();
  try {
    const before = sourceState(f);
    install(f, { event: "tool.after", kind: "observe", source: "module.exports = event => ({ payload: event.payload });" });
    install(f, { event: "tool.before", kind: "guard", source: "module.exports = event => ({ decision: 'allow', reason: JSON.stringify(event.payload.arguments) });" });
    install(f, { event: "tool.result.transform", kind: "transform", source: "module.exports = event => ({ result: event.payload.result });" });
    const session = f.createSession(), run = await f.send(session.sessionKey, "hook-no-copy", "Find telescope notes");
    assert.equal(run.status, "running", run.errorCode);
    const call = callFor(f, run);
    const own = await call("memory_search", { query: OWN, memoryScope: "own", minScore: 0, maxResults: 20 });
    assert.ok(own.results.some(value => !value.borrowed && value.snippet.includes(OWN)), "clean own-memory control is readable");
    await f.service.hookRunner.drain();
    assert.equal(databaseText(f.service.hookStore.db).includes(OWN), true,
      "enabled payload observers and transform executions run normally before the first borrowed dependency");
    const found = await call("memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0, maxResults: 20 });
    const borrowed = found.results.find(value => value.borrowed && value.ownerProfileId === f.B);
    assert.ok(borrowed && borrowed.snippet.includes(MARKER), "current borrowed body is still delivered in memory to its authorized caller");
    await assertNoHookCopy(f);
    const get = await call("memory_get", { path: borrowed.path, from: borrowed.startLine, lines: borrowed.endLine - borrowed.startLine + 1 });
    assert.ok(JSON.stringify(get).includes(MARKER), "current bounded memory_get retains its authorized read");
    await assertNoHookCopy(f);
    const queried = await call("memory_search", { query: FACT, memoryScope: "own", minScore: 0, maxResults: 20 });
    assert.ok(queried.results.some(value => !value.borrowed), "borrowed model argument still completes an own-memory read");
    await assertNoHookCopy(f);
    await assert.rejects(call("memory_save", { content: FACT, expectedRevision: f.owner.store.getRevision(f.profile.id),
      scope: "agent", classification: "explicit", sourceQuote: "Find telescope notes" }), { code: "MEMORY_BORROWED_READ_ONLY" });
    await assertNoHookCopy(f);
    assert.deepEqual(sourceState(f), before, "Hook execution and read-only borrowed tools never alter the source owner");
    await f.complete(run, "Independent answer after a bounded borrowed-memory read");
    await assertNoHookCopy(f);
  } finally {
    await f.service.hookRunner.drain();
    await f.close();
  }
});

test("a body-free pending borrowed Hook observer recovers with the same durable event identity", { timeout: 30000, skip: sandboxSkip }, async () => {
  const f = await fixture();
  try {
    install(f, { event: "tool.after", kind: "observe", source: "module.exports = event => ({ payload: event.payload });" });
    const session = f.createSession(), run = await f.send(session.sessionKey, "hook-no-copy-recovery", "Find telescope notes");
    assert.equal(run.status, "running", run.errorCode);
    const found = await callFor(f, run)("memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0, maxResults: 20 });
    assert.ok(found.results.some(value => value.borrowed && value.snippet.includes(MARKER)));
    await f.service.hookRunner.drain();
    const store = f.service.hookStore, snapshot = store.snapshotForRun(run.id);
    const event = f.service.hookService.event(snapshot, run, "tool.after", `pending-${crypto.randomUUID()}`,
      { result: found, status: "completed" }, { scope: "product", name: "memory_search" }, crypto.randomUUID());
    assert.equal(store.enqueueEvent(snapshot, event), true, "an admitted observer can remain pending at a Service interruption");
    const before = store.pendingEvents().find(pending => pending.event.eventId === event.eventId);
    assert.ok(before && !JSON.stringify(before.event).includes(MARKER), "the pending event has no source body at rest");
    assert.doesNotThrow(() => f.service.hookRunner.recoverObservers(), "recovery projection preserves event identity instead of conflicting with its own ledger");
    await f.service.hookRunner.drain();
    assert.equal(store.pendingEvents().some(pending => pending.event.eventId === event.eventId), false,
      "the recovered observer reaches its terminal event receipt");
    const recovered = store.db.prepare("SELECT data,state FROM events WHERE id=?").get(event.eventId);
    assert.equal(recovered.state, "settled");
    assert.equal(recovered.data, JSON.stringify(before.event), "recovering a projected observer does not change its durable event bytes");
    await assertNoHookCopy(f);
    await f.complete(run, "Independent answer after observer recovery");
  } finally {
    await f.service.hookRunner.drain();
    await f.close();
  }
});

test("borrowed model text in Hook test diagnostics is not copied into durable Product receipts", { timeout: 30000, skip: sandboxSkip }, async () => {
  const f = await fixture();
  try {
    const observer = install(f, { event: "tool.after", kind: "observe", source: "module.exports = event => ({ payload: event.payload });" });
    const session = f.createSession(), run = await f.send(session.sessionKey, "hook-no-copy-synthetic", "Find telescope notes");
    assert.equal(run.status, "running", run.errorCode);
    const found = await callFor(f, run)("memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0, maxResults: 20 });
    assert.ok(found.results.some(value => value.borrowed && value.snippet.includes(MARKER)));
    const result = await f.service.mcpProductToolController.handle("hook_test", {
      hookId: observer.hookId, version: observer.version, payload: { modelGeneratedDiagnostic: FACT },
    }, { profileId: f.profile.id, callId: crypto.randomUUID() }, scope(run));
    assert.equal(result.passed, true, "controlled synthetic Hook test still runs in its isolated scratch workspace");
    await assertNoHookCopy(f);
    await f.complete(run, "Independent answer after a metadata-only Hook diagnostic");
  } finally {
    await f.service.hookRunner.drain();
    await f.close();
  }
});

test("the first cross-owner search query cannot persist source text through a guard before refs exist", { timeout: 30000, skip: sandboxSkip }, async () => {
  const f = await fixture();
  try {
    const before = sourceState(f);
    install(f, { event: "tool.before", kind: "guard", source: "module.exports = event => ({ decision: 'allow', reason: JSON.stringify(event.payload.arguments) });" });
    const session = f.createSession(), run = await f.send(session.sessionKey, "hook-no-copy-first-query", "Find telescope notes");
    assert.equal(run.status, "running", run.errorCode);
    assert.equal(f.owner.sharing.borrowedRefsForRun(run.id).length, 0, "the real first lookup has not registered any borrowed dependencies");
    const call = callFor(f, run);
    const own = await call("memory_search", { query: OWN, memoryScope: "own", minScore: 0, maxResults: 20 });
    assert.ok(own.results.some(value => !value.borrowed && value.snippet.includes(OWN)));
    assert.equal(f.owner.sharing.borrowedRefsForRun(run.id).length, 0, "clean own-only control cannot create a foreign dependency");
    assert.ok(databaseText(f.service.hookStore.db).includes(OWN), "clean own-only guards retain their normal execution diagnostics");
    const found = await call("memory_search", { query: FACT, ownerProfileId: f.B, minScore: 0, maxResults: 20 });
    assert.ok(found.results.some(value => value.borrowed && value.ownerProfileId === f.B && value.snippet.includes(MARKER)));
    assert.ok(f.owner.sharing.borrowedRefsForRun(run.id).length > 0, "only the actual completed lookup creates source dependencies");
    await assertNoHookCopy(f);
    assert.deepEqual(sourceState(f), before);
    await f.complete(run, "Independent answer after the first cross-owner lookup");
    await assertNoHookCopy(f);
  } finally {
    await f.service.hookRunner.drain();
    await f.close();
  }
});
