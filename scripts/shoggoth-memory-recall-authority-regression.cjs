"use strict";

// Memory repair stage 1: in-flight reads are revoked only by changes that can
// withdraw returned content; cited Markdown is proven by its unchanged prefix;
// the cross-turn recall cache still refreshes on any content change.
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { captureEvidence, evidenceCurrent, validEvidence } = require("../app/agent-service/shoggoth-memory/active-memory-evidence.cjs");
const { A, FACT, fixture, recallModel } = require("./fixtures/memory-repair-fixture.cjs");

const fakeIndex = files => ({ readIndexedSource: relative => ({ text: files[relative], hash: core.hashText(files[relative]) }) });
const ENTRY = (id, text) => `<!-- shoggoth-memory-entry:${id} -->\n- ${text}\n<!-- /shoggoth-memory-entry -->\n`;

test("prefix evidence survives appends and rejects rewrites, glued text and broken pairs", () => {
  const original = `# User\n\n${ENTRY("a", "A fact.")}`;
  const files = { "USER.md": original }, index = fakeIndex(files);
  const evidence = captureEvidence(index, "USER.md", "memory", core.hashText(original));
  assert.equal(validEvidence(evidence), true);
  assert.equal(typeof evidence.prefixHash, "string");
  assert.equal(evidence.hash, core.hashText(original), "the whole-file version is kept beside the proof");
  assert.equal(evidenceCurrent(index, evidence), true);
  // The file store appends after trimEnd(), exactly like this.
  files["USER.md"] = `${original.trimEnd()}\n\n${ENTRY("b", "Another fact.")}`;
  assert.equal(evidenceCurrent(index, evidence), true, "an appended entry keeps the proof");
  files["USER.md"] = original.replace("A fact", "A changed fact");
  assert.equal(evidenceCurrent(index, evidence), false, "rewriting proven content revokes it");
  files["USER.md"] = `${original.trimEnd()}X`;
  assert.equal(evidenceCurrent(index, evidence), false, "text glued to the prefix is not an append");
  files["USER.md"] = original.slice(0, 10);
  assert.equal(evidenceCurrent(index, evidence), false, "a truncated file revokes it");
  assert.equal(validEvidence({ ...evidence, throughBytes: undefined }), false, "a prefix proof travels as a pair");
  assert.equal(validEvidence({ ...evidence, prefixHash: undefined }), false);
  assert.equal(validEvidence({ path: "x", source: "sessions", hash: evidence.hash, prefixHash: evidence.prefixHash, throughBytes: 1 }), false,
    "only Markdown memory carries a prefix proof");
});

test("legacy evidence without a prefix proof keeps the whole-file comparison", () => {
  const original = `# User\n\n${ENTRY("a", "A fact.")}`;
  const files = { "USER.md": original }, index = fakeIndex(files);
  const legacy = { path: "USER.md", source: "memory", hash: core.hashText(original) };
  assert.equal(validEvidence(legacy), true);
  assert.equal(evidenceCurrent(index, legacy), true);
  files["USER.md"] = `${original.trimEnd()}\n\n${ENTRY("b", "Another fact.")}`;
  assert.equal(evidenceCurrent(index, legacy), false);
});

test("evidence capture refuses a file that changed after the search result", () => {
  const files = { "USER.md": `# User\n\n${ENTRY("a", "Old.")}` }, index = fakeIndex(files);
  const searched = core.hashText(files["USER.md"]);
  files["USER.md"] = `# User\n\n${ENTRY("a", "New.")}`;
  assert.throws(() => captureEvidence(index, "USER.md", "memory", searched), { code: "MEMORY_SOURCE_CHANGED" });
});

test("deleting a session during a search still conflicts", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.saveUser(FACT);
  const input = f.turn("amber telescope"), other = f.session(), operationId = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(other.sessionKey, "binding-delete", f.now());
  f.service.chatSessionStore.completeBinding(other.sessionKey, "binding-delete", "runtime-delete");
  const pending = f.search("amber telescope", input, { minScore: 0 });
  setImmediate(() => {
    f.service.chatSessionStore.requestDelete(other.sessionKey, operationId, f.now());
    f.service.chatSessionStore.completeRemoteOperation(operationId);
  });
  await assert.rejects(pending, { code: "MEMORY_REVISION_CONFLICT" });
  await f.finish(input);
});

test("new sessions, bindings and ordinary turns leave the authority version unchanged", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.saveUser(FACT);
  const before = f.owner.authorityStamp(A);
  const session = f.session();
  f.service.chatSessionStore.requestBinding(session.sessionKey, "binding-1", f.now());
  f.service.chatSessionStore.completeBinding(session.sessionKey, "binding-1", "runtime-1");
  f.noise(session); f.service.chatSessionStore.touchSession(session.sessionKey, f.now());
  await f.saveUser("Violet ink dries overnight.");
  assert.equal(f.owner.authorityStamp(A), before);
});

test("a prepared recall survives an append to its cited file before it is taken", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); await f.saveUser(FACT);
  recallModel(f, "amber telescope");
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input);
  await f.saveUser("Violet ink dries overnight.");
  assert.match(f.owner.takeActiveMemory(input)?.content || "", /calibrated every evening/u);
  await f.finish(input);
});

test("a prepared recall is dropped when its cited entry is rewritten before it is taken", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); const saved = await f.saveUser(FACT);
  recallModel(f, "amber telescope");
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input);
  await f.owner.delete({ profileId: A, id: saved.id, reason: "forgotten", operationId: crypto.randomUUID() });
  assert.equal(f.owner.takeActiveMemory(input), null);
  await f.finish(input);
});

test("Dreaming completes while ordinary transcript appends continue", { timeout: 120000 }, async t => {
  const f = await fixture(t); await f.dailyNote(`- ${FACT}`);
  f.model = async () => ({ text: "NONE" });
  const other = f.session(), timer = setInterval(() => f.noise(other), 0);
  try { assert.equal((await f.owner.dream(A)).handled, true); } finally { clearInterval(timer); }
});

test("the cross-turn cache version changes with content while the authority version does not", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.saveUser(FACT);
  const memory = f.owner.activeMemory;
  const before = { cache: memory.cacheStamp(A), authority: memory.authority(A) };
  await f.dailyNote("- Violet ink dries overnight.");
  assert.notEqual(memory.cacheStamp(A), before.cache, "new memory in another file must refresh cached recalls");
  assert.equal(memory.authority(A), before.authority, "new memory must not revoke in-flight recalls");
});

function mcpRead(f, input, name, args, authority = { profileId: A, callId: crypto.randomUUID() }) {
  const controller = f.service.mcpProductToolController;
  // The fixture has no native Runtime. Supply its exact authenticated routing
  // context while keeping the real controller, Hook snapshot and source guards.
  controller.getRuntimeContext = (profileId, selector) => profileId === A
    && selector.source === "chat" && selector.sourceId === input.session.sessionKey
    ? { profileId: A, source: "chat", sourceId: input.session.sessionKey, runId: input.run.id } : null;
  if (!controller.hookToolExecution.service.store.snapshotForRun(input.run.id)) {
    controller.hookToolExecution.service.freezeRun(input.run, input.profile);
  }
  return controller.handle(name, {
    source: "chat", sourceId: input.session.sessionKey, ...args,
  }, authority, { runId: input.run.id, assertCurrent() {} });
}

const mcpSearch = (f, input, authority) => mcpRead(f, input, "memory_search", { query: "amber telescope", minScore: 0 }, authority);

for (const mutation of ["transcript append", "session timestamp", "memory append"]) {
  test(`MCP memory search preserves valid results across ${mutation}`, { timeout: 60000 }, async t => {
    const f = await fixture(t); const saved = await f.saveUser(FACT);
    const input = f.turn("What do you remember about the amber telescope?"), other = f.session();
    const memory = f.service.mcpProductToolController.conversationMemoryService;
    const search = memory.searchWithSemantic.bind(memory);
    let engineReadCompleted = false;
    memory.searchWithSemantic = async (...args) => {
      const result = await search(...args); engineReadCompleted = true;
      if (mutation === "transcript append") f.noise(other);
      else if (mutation === "session timestamp") f.service.chatSessionStore.touchSession(other.sessionKey, f.now() + 1);
      else await f.saveUser("Violet ink dries overnight.");
      return result;
    };
    const result = await mcpSearch(f, input);
    assert.equal(engineReadCompleted, true);
    assert.ok(result.items.some(item => item.id === saved.id));
    await f.finish(input);
  });
}

for (const mutation of ["context exclusion", "memory withdrawal"]) {
  test(`MCP memory search still rejects ${mutation} before publication`, { timeout: 60000 }, async t => {
    const f = await fixture(t); const saved = await f.saveUser(FACT);
    const input = f.turn("What do you remember about the amber telescope?"), other = f.session(), event = f.noise(other);
    const memory = f.service.mcpProductToolController.conversationMemoryService;
    const search = memory.searchWithSemantic.bind(memory);
    memory.searchWithSemantic = async (...args) => {
      const result = await search(...args);
      if (mutation === "context exclusion") {
        f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: other.id, eventId: event.id, contextExcluded: true });
      } else await f.owner.delete({ profileId: A, id: saved.id, reason: "forgotten", operationId: crypto.randomUUID() });
      return result;
    };
    await assert.rejects(mcpSearch(f, input), { code: "MCP_TOOL_STATE_CONFLICT" });
    await f.finish(input);
  });
}

for (const mutation of ["transcript append", "session timestamp", "source exclusion"]) {
  test(`MCP conversation search revalidates source authority across ${mutation}`, { timeout: 60000 }, async t => {
    const f = await fixture(t), past = f.session();
    const bind = (session, id) => {
      f.service.chatSessionStore.requestBinding(session.sessionKey, `binding-${id}`, f.now());
      f.service.chatSessionStore.completeBinding(session.sessionKey, `binding-${id}`, `runtime-${id}`);
    };
    bind(past, "past");
    const old = f.turn(FACT, past); await f.finish(old);
    const input = f.turn("What did we say about the amber telescope?"), other = f.session();
    bind(input.session, "current");
    const recall = f.service.mcpProductToolController.conversationRecallService;
    const search = recall.searchWithSemantic.bind(recall); let observed = 0;
    recall.searchWithSemantic = async (...args) => {
      const result = await search(...args); observed = result.results.length;
      if (mutation === "transcript append") f.noise(other);
      else if (mutation === "session timestamp") f.service.chatSessionStore.touchSession(other.sessionKey, f.now() + 1);
      else f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: past.id, eventId: old.event.id, contextExcluded: true });
      return result;
    };
    const pending = mcpRead(f, input, "conversation_search", { query: "amber telescope" });
    if (mutation === "source exclusion") {
      await assert.rejects(pending, error => ["MCP_TOOL_STATE_CONFLICT", "MCP_TOOL_NOT_FOUND"].includes(error.code));
    } else assert.ok((await pending).results.some(row => row.eventId === old.event.id));
    assert.ok(observed > 0, "the real source search must return the seeded historical event");
    await f.finish(input);
  });
}
