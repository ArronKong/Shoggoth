"use strict";

// Memory repair stage 1: in-flight reads are revoked only by changes that can
// withdraw returned content; cited Markdown is proven by its unchanged prefix;
// the cross-turn recall cache still refreshes on any content change.
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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

test("Active Memory avoids repeated tree walks and drops source metadata edited during a model call", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" });
  const saved = await f.saveUser(FACT);
  const original = f.owner.store._filesystemStamp;
  let walks = 0;
  f.owner.store._filesystemStamp = function(...args) { walks++; return original.apply(this, args); };
  t.after(() => { f.owner.store._filesystemStamp = original; });
  recallModel(f, "amber telescope");
  const first = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(first);
  assert.match(f.owner.takeActiveMemory(first)?.content || "", /calibrated every evening/u);
  assert.ok(walks <= 4, `native recall enumerated the tree ${walks} times`);
  await f.finish(first);
  f.owner.activeMemory.cacheProofs.clear();
  const second = f.turn("Recall the amber telescope calibration", undefined, { queued: true });
  let entered = false;
  f.model = async () => {
    entered = true;
    f.owner.database.db.prepare("UPDATE memory_file_records SET data=json_set(data,'$.sensitivity','restricted') WHERE profile_id=? AND id=?")
      .run(A, saved.id);
    return { text: JSON.stringify({ summary: FACT }) };
  };
  await f.owner.prepareActiveMemory(second);
  assert.equal(entered, true);
  assert.equal(f.owner.takeActiveMemory(second), null);
  await f.finish(second);
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
    // Exercise source authority after the derived index is ready. A cold
    // search may legitimately return rebuilding before it has any results.
    recall.prebuildProfile(A);
    await recall.whenIndexReady(A);
    assert.equal(recall.prebuildProfile(A), "ready");
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

test("background lexical recall uses worker views and discards a source revoked before publication", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const recall = f.service.conversationRecallService, index = recall.index;
  recall.semanticSearch = null;
  const suppressed = await f.saveUser("Violet ink dries overnight.");
  await f.owner.delete({ profileId: A, id: suppressed.id, reason: "forgotten", operationId: crypto.randomUUID() });
  const past = f.session();
  f.service.chatSessionStore.requestBinding(past.sessionKey, "binding-background-fts", f.now());
  f.service.chatSessionStore.completeBinding(past.sessionKey, "binding-background-fts", "runtime-background-fts");
  const historical = f.turn(FACT, past);
  await f.finish(historical);
  recall.forgetProfile(A);
  index.invalidateProfile(A);

  const { AsyncLocalStorage } = require("node:async_hooks");
  const backgroundRead = new AsyncLocalStorage();
  const worker = recall.withBackgroundReadView.bind(recall);
  const originalStamp = f.owner.store._filesystemStamp;
  let workerViews = 0, synchronousWalks = 0, validations = 0;
  t.mock.method(f.owner.store, "_filesystemStamp", function(...args) {
    if (backgroundRead.getStore()) synchronousWalks++;
    return originalStamp.apply(this, args);
  });
  const ensure = index.ensure.bind(index);
  t.mock.method(index, "ensure", (profileId, sessions, revision, loadPage, validate, ...args) =>
    ensure(profileId, sessions, revision, loadPage, () => {
      validations++;
      return validate();
    }, ...args));
  let entered, release;
  const publicationAttempt = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let blocked = false;
  t.mock.method(recall, "withBackgroundReadView", async (profileId, read) => {
    return backgroundRead.run(true, async () => {
      workerViews++;
      if (validations === 1 && !blocked) {
        blocked = true;
        entered();
        await hold;
      }
      return worker(profileId, read);
    });
  });
  recall.scheduleWarm(A);
  try {
    await publicationAttempt;
    const building = index.whenReady(A);
    assert.equal((await f.ipc("service.status", {})).healthy, true);
    f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: past.id,
      eventId: historical.event.id, contextExcluded: true });
    release();
    await building;
    assert.equal(index.connections.has(A), false, "the invalidated build never publishes its plaintext index");
    assert.ok(workerViews >= 4, "warmup, page extraction and both publication checks enter the worker path");
    assert.equal(synchronousWalks, 0);
  } finally { release(); }
  await worker(A, () => recall.prebuildProfile(A));
  await index.whenReady(A);
  assert.equal(await worker(A, () => recall.prebuildProfile(A)), "ready");
  assert.ok(!index.search(A, "amber telescope", 10, past.workspace).some(row => row.event_id === historical.event.id));
});

test("background semantic recall checks the worker proof at physical embedding send", { timeout: 30000 }, async t => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  const { LocalEmbeddingService } = require("../app/agent-service/local-embedding-service");
  const { NativeMemorySemanticService } = require("../app/agent-service/native-memory-semantic-service");
  const f = await fixture(t), recall = f.service.conversationRecallService;
  const saved = await f.saveUser("Violet ink dries overnight.");
  await f.owner.delete({ profileId: A, id: saved.id, reason: "forgotten", operationId: crypto.randomUUID() });
  const past = f.session();
  f.service.chatSessionStore.requestBinding(past.sessionKey, "binding-background-semantic", f.now());
  f.service.chatSessionStore.completeBinding(past.sessionKey, "binding-background-semantic", "runtime-background-semantic");
  const historical = f.turn(FACT, past);
  await f.finish(historical);
  recall.forgetProfile(A);
  const background = new AsyncLocalStorage();
  const original = f.owner.store._filesystemStamp;
  let synchronousWalks = 0;
  t.mock.method(f.owner.store, "_filesystemStamp", function(...args) {
    if (background.getStore()) synchronousWalks++;
    return original.apply(this, args);
  });
  const sent = [];
  const embedding = new LocalEmbeddingService();
  t.mock.method(embedding, "start", async () => {});
  t.mock.method(embedding, "_send", async (method, args) => {
    sent.push({ method, args });
    if (method === "ready") return { ready: false };
    if (method === "begin") return { epoch: 1 };
    if (method === "commit") return { documents: sent.filter(entry => entry.method === "upsert").length };
    return {};
  });
  let entered, release;
  const beforeSend = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const request = embedding.request.bind(embedding);
  let block = false;
  t.mock.method(embedding, "request", async (method, args, options) => {
    if (method === "upsert" && !block) {
      block = true;
      entered();
      await hold;
    }
    return request(method, args, options);
  });
  const semantic = new NativeMemorySemanticService({ embeddingFactory: () => embedding });
  recall.semanticSearch = semantic;
  t.after(() => semantic.close());
  const start = () => background.run(true, async () => {
    // Carry the same verified view as timer-based prewarm into job creation.
    let job;
    await recall.withBackgroundReadView(A, () => { job = recall._ensureSemantic(A); });
    return job;
  });
  try {
    const job = await start();
    await beforeSend;
    assert.equal((await f.ipc("service.status", {})).healthy, true);
    const memory = path.join(f.owner.store.workspace(A), "memory");
    fs.mkdirSync(memory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(memory, "2025-07-01.md"), "# New file\n", { mode: 0o600 });
    release();
    await job.promise;
    assert.deepEqual(sent.map(entry => entry.method), ["ready", "begin"]);
    assert.equal(semantic.status(A, "conversation").coverage, "unindexed");
  } finally { release(); }
  const after = await start();
  await after.promise;
  assert.equal(after.state, "ready");
  assert.ok(sent.some(({ method, args }) => method === "upsert" && args.document.source.eventId === historical.event.id));
  assert.equal(sent.filter(entry => entry.method === "commit").length, 1);
  assert.equal(synchronousWalks, 0);
});

for (const name of ["conversation_get", "conversation_search"]) {
  test(`MCP ${name} uses bounded worker views and rechecks after response projection`, { timeout: 30000 }, async t => {
    const f = await fixture(t), saved = await f.saveUser(FACT);
    const bind = (session, id) => {
      f.service.chatSessionStore.requestBinding(session.sessionKey, `binding-${id}`, f.now());
      f.service.chatSessionStore.completeBinding(session.sessionKey, `binding-${id}`, `runtime-${id}`);
    };
    const past = f.session(); bind(past, "past-worker-read");
    const old = f.turn(FACT, past); await f.finish(old);
    const input = f.turn("Find the earlier calibration result"); bind(input.session, "current-worker-read");
    const controller = f.service.mcpProductToolController;
    const recall = controller.conversationRecallService;
    recall.prebuildProfile(A);
    await recall.whenIndexReady(A);
    const args = name === "conversation_get" ? { sessionId: past.id, eventId: old.event.id } : { query: "amber telescope" };
    const read = f.owner.withAsyncMemoryReadView.bind(f.owner);
    const stamp = f.owner.store._filesystemStamp.bind(f.owner.store);
    let wait, blocked = false, recording = true, synchronousWalks = 0, workerViews = 0;
    f.owner.store._filesystemStamp = profileId => {
      if (profileId === A && recording && controller.executionContext.getStore()?.runId === input.run.id) synchronousWalks++;
      return stamp(profileId);
    };
    f.owner.withAsyncMemoryReadView = async (profileId, signal, callback, scanSignal) => {
      if (profileId === A && recording) {
        workerViews++;
        if (!blocked) {
          blocked = true;
          await new Promise(resolve => { wait = resolve; });
        }
      }
      return read(profileId, signal, callback, scanSignal);
    };
    t.after(() => { wait?.(); });
    const pending = mcpRead(f, input, name, args);
    pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
    await waitUntil(() => blocked, 5000, "conversation worker wait");
    const status = await f.ipc("service.status", {});
    assert.equal(status.healthy, true, "Service still answers status while the recall read is waiting");
    wait(); wait = null;
    const result = await pending;
    assert.ok((result.results || result.events).some(row => row.eventId === old.event.id));
    assert.ok(workerViews >= 3, "visibility capture, result and final publication use separate current views");
    assert.equal(synchronousWalks, 0, "MCP did not run a synchronous memory tree scan");

    let projected = false;
    controller.getSecretScope = async () => ({});
    controller.secretExecution = { async projectForModel(_scope, value) {
      projected = true;
      const relative = saved.memoryPath || "USER.md", file = path.join(f.owner.store.workspace(A), relative);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("calibrated every evening", "adjusted each morning"));
      return value;
    } };
    await assert.rejects(mcpRead(f, input, name, args), { code: "MCP_TOOL_STATE_CONFLICT" });
    assert.equal(projected, true);
    assert.equal(synchronousWalks, 0);
    recording = false;
    await f.finish(input);
  });
}
