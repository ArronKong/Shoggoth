"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { ConversationCheckpointStore, SUMMARY_FIELDS, coveredTranscript } = require("../app/agent-service/conversation-checkpoint-store");
const { ProductMemorySessions } = require("../app/agent-service/shoggoth-memory/session-source.cjs");
const { planConversationCompaction } = require("../app/agent-service/conversation-compaction");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { normalizeBorrowedMemoryRefs, mergeBorrowedMemoryRefs, isBorrowedMemoryDerived, isReferentialMemoryRequest, assertNoBorrowedMemoryWrite } = require("../app/agent-service/shoggoth-memory/borrowed-memory-provenance.cjs");
const MARKER = "BORROWED_OWNER_TEXT_725954";
function refs() {
  const sourceHash = crypto.createHash("sha256").update(MARKER).digest("hex");
  return [{ version: 1, requesterProfileId: "profile-1", ownerProfileId: "profile-2", ownerDisplayName: "Other Agent",
    canonicalRelativePath: "MEMORY.md", documentKind: "long_term", startLine: 2, endLine: 2,
    sourceHash, sourceRevision: `sha256:${sourceHash}`, policyRevision: 1 }];
}
function contents(directory) {
  const values = [];
  const visit = target => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const file = path.join(target, entry.name);
      if (entry.isDirectory()) visit(file); else if (entry.isFile()) values.push(fs.readFileSync(file).toString());
    }
  };
  visit(directory); return values.join("\n");
}
function summary(text) { return { ...Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []])), state: [text] }; }
function addBorrow(f) {
  f.append({ id: "user-first", kind: "user", content: { text: "请检索其他助理" } });
  return f.append({ id: "borrowed-tool", kind: "tool_result", borrowedMemoryRefs: refs(),
    content: { resultSummary: MARKER, tool: { name: "memory_get", output: { text: MARKER, sourceRef: "access-secret" } } },
    contextContent: { tool: { name: "memory_get", output: { text: MARKER } } } });
}
function recallFixture(f) {
  const session = { id: f.transcriptSessionId, sessionKey: f.run.sourceId, profileId: f.profile.id,
    workspace: f.run.workspace, status: "ready" };
  const sessions = { listSessions: () => [structuredClone(session)], getSession: key => key === session.sessionKey ? structuredClone(session) : null,
    getCronSessionOrigin: () => null };
  const recall = new ConversationRecallService({ paths: f.paths, transcriptStore: f.transcripts, chatSessionStore: sessions,
    workDispatcher: { getRun: id => ({ ...f.run, id, status: "completed" }) }, getRunSessionKey: () => f.run.sourceId,
    recallPolicy: f.memoryEngine.recallPolicy, memoryStore: f.memoryStore });
  const source = new ProductMemorySessions({ sessions, transcripts: f.transcripts, recall,
    database: { tombstones: () => [] }, assertProfile: () => {} });
  return { recall, source };
}

test("persistent dependency metadata drops access tokens and rejects accessors", () => {
  const input = { ...refs()[0], sourceRef: "access-secret", snippet: MARKER };
  const safe = normalizeBorrowedMemoryRefs([input]);
  assert.equal(normalizeBorrowedMemoryRefs([{ ...refs()[0], policyRevision: 0 }])[0].policyRevision, 0);
  assert.throws(() => normalizeBorrowedMemoryRefs([{ ...refs()[0], policyRevision: -1 }]), { code: "BORROWED_MEMORY_PROVENANCE_INVALID" });
  const origins = mergeBorrowedMemoryRefs([{ ...refs()[0], sourceOriginHash: "5".repeat(64) }], [{ ...refs()[0], sourceOriginHash: "6".repeat(64) }]);
  assert.equal(origins.length, 2, "same report body with changed origins remains two distinct dependencies");
  assert.throws(() => normalizeBorrowedMemoryRefs([{ ...refs()[0], sourceOriginHash: "forged" }]), { code: "BORROWED_MEMORY_PROVENANCE_INVALID" });
  assert.equal(safe[0].sourceRef, undefined); assert.equal(safe[0].snippet, undefined);
  let calls = 0;
  Object.defineProperty(input, "snippet", { get() { calls++; return MARKER; } });
  assert.throws(() => normalizeBorrowedMemoryRefs([input]), { code: "BORROWED_MEMORY_PROVENANCE_INVALID" });
  assert.equal(calls, 0);
});

test("Product tool journal and context objects retain metadata without borrowed body", () => {
  const f = contextFixture();
  try {
    const event = addBorrow(f);
    assert.equal(event.content.contextRef, undefined);
    assert.match(event.content.resultSummary, /Other Agent.*MEMORY.md/u);
    const disk = contents(path.join(f.paths.agentsDir, f.profile.id, "transcripts"));
    assert.doesNotMatch(disk, new RegExp(MARKER)); assert.doesNotMatch(disk, /access-secret/u);
    assert.deepEqual(event.content.borrowedMemoryRefs, refs());
  } finally { f.cleanup(); }
});

test("rewriting, translating and summarizing across turns stay excluded from memory inputs after restart", () => {
  const f = contextFixture(); let recall;
  try {
    addBorrow(f);
    f.append({ id: "answer-original", kind: "assistant", content: { text: `来源回答 ${MARKER}` } });
    f.append({ id: "user-translation", runId: "run-2", kind: "user", content: { text: "请翻译刚才的回答" } });
    f.append({ id: "answer-translation", runId: "run-2", kind: "assistant", content: { text: "TRANSLATED_DERIVED_FACT" } });
    f.append({ id: "user-direct", runId: "run-3", kind: "user", content: { text: "我自己的新事实是喜欢绿色" } });
    f.append({ id: "answer-summary", runId: "run-3", kind: "assistant", content: { text: "SUMMARIZED_DERIVED_FACT" } });
    f.append({ id: "user-reference-save", runId: "run-4", kind: "user", content: { text: "把上面的内容记住" } });
    f.transcripts.close(); f.transcripts.open();
    const events = f.transcripts.listEvents(f.profile.id, f.transcriptSessionId);
    for (const id of ["answer-original", "answer-translation", "answer-summary", "user-reference-save"]) {
      assert.equal(isBorrowedMemoryDerived(events.find(event => event.id === id)), true, id);
    }
    assert.equal(isBorrowedMemoryDerived(events.find(event => event.id === "user-direct")), false);
    const value = recallFixture(f); recall = value.recall;
    const input = value.source.read(f.profile.id, f.transcriptSessionId);
    assert.match(input.content, /我自己的新事实是喜欢绿色/u);
    assert.doesNotMatch(input.content, /BORROWED_OWNER_TEXT|TRANSLATED_DERIVED_FACT|SUMMARIZED_DERIVED_FACT|把上面的内容记住/u);
    assert.deepEqual(input.lineMap, [1, 4, 6]);
  } finally { recall?.close(); f.cleanup(); }
});

test("snapshot dispatch remains complete in memory while disk and recovery are reference only", () => {
  const f = contextFixture();
  try {
    const block = { id: "active-memory", kind: "memory", content: MARKER, borrowedMemoryRefs: refs(),
      contentHash: refs()[0].sourceHash, byteLength: Buffer.byteLength(MARKER) };
    const snapshot = f.snapshots.create({ schemaVersion: 1, runId: "run-1", profileId: f.profile.id, createdAt: 500,
      revisions: {}, blocks: [block], developerInstructions: "trusted rules", dynamicContext: MARKER,
      dynamicContextWithoutTranscript: MARKER, borrowedMemoryRefs: refs() });
    assert.equal(snapshot.dynamicContext, MARKER); assert.equal(snapshot.blocks[0].content, MARKER);
    const raw = contents(path.join(f.paths.agentsDir, f.profile.id, "context-snapshots"));
    assert.doesNotMatch(raw, new RegExp(MARKER)); assert.match(raw, /reference_only/u);
    f.snapshots.close(); f.snapshots.open();
    const recovered = f.snapshots.get(f.profile.id, snapshot.id);
    assert.doesNotMatch(recovered.dynamicContext, new RegExp(MARKER));
    assert.deepEqual(recovered.borrowedMemoryRefs, refs());
  } finally { f.cleanup(); }
});

test("compiler preserves dependencies and replaces revoked assistant content before rebuilding", () => {
  const f = contextFixture(); let current = true;
  try {
    addBorrow(f);
    f.append({ id: "answer", kind: "assistant", content: { text: MARKER } });
    f.append({ id: "current", kind: "user", content: { text: "继续" } });
    f.compiler.borrowedMemoryDependenciesCurrent = () => current;
    const compile = () => f.compiler.compile({ profile: f.profile, run: f.run,
      transcriptSessionId: f.transcriptSessionId, query: "继续" });
    const first = compile();
    assert.match(first.dynamicContext, new RegExp(MARKER));
    assert.deepEqual(first.borrowedMemoryRefs, refs()); assert.deepEqual(first.nativeBorrowedMemoryRefs, refs());
    assert.doesNotMatch(contents(path.join(f.paths.agentsDir, f.profile.id, "context-snapshots")), new RegExp(MARKER));
    current = false;
    const rebuilt = compile();
    assert.doesNotMatch(rebuilt.dynamicContext, new RegExp(MARKER));
    assert.match(rebuilt.dynamicContext, /来源已变化或撤回/u);
    assert.deepEqual(rebuilt.nativeBorrowedMemoryRefs, []);
  } finally { f.cleanup(); }
});

test("checkpoint and native continuation check exact source dependencies across restart", () => {
  const f = contextFixture(); let current = true;
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy,
    borrowedMemoryDependenciesCurrent: () => current });
  store.open();
  try {
    addBorrow(f); f.append({ id: "answer", kind: "assistant", content: { text: MARKER } });
    const events = f.transcripts.listEvents(f.profile.id, f.transcriptSessionId), memory = store.memoryState(f.profile.id);
    const record = store.commit({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      expectedRevision: f.transcripts.getRevision(f.profile.id, f.transcriptSessionId), expectedMemoryRevision: memory.revision,
      expectedMemoryFreshUntil: memory.freshUntil, throughSeq: 3, coveredHash: coveredTranscript(events, 3).hash,
      summary: summary("a derived summary"), provenance: { runId: "compact", bindingId: "binding", runtime: "codex", model: "model", method: "model" } });
    assert.deepEqual(record.borrowedMemoryRefs, refs());
    const version = { ...store.nativeMemoryVersion(f.profile.id), borrowedMemoryRefs: refs() };
    assert.equal(store.recordNativeSession(f.profile.id, f.transcriptSessionId, "native-1", "binding", version), true);
    store.close(); store.open();
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId)?.id, record.id);
    assert.equal(store.nativeSessionStale(f.profile.id, f.transcriptSessionId, "native-1", "binding"), false);
    assert.deepEqual(store.nativeSessionBorrowedMemoryRefs(f.profile.id, f.transcriptSessionId, "native-1", "binding"), refs());
    assert.deepEqual(store.nativeSessionBorrowedMemoryRefs(f.profile.id, f.transcriptSessionId, "wrong-native", "binding"), []);
    current = false;
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId), null);
    assert.equal(store.nativeSessionStale(f.profile.id, f.transcriptSessionId, "native-1", "binding"), true);
    assert.deepEqual(store.nativeSessionBorrowedMemoryRefs(f.profile.id, f.transcriptSessionId, "native-1", "binding"), refs(), "revoked metadata remains available for a recovery fence");
    const rebuilt = { ...store.nativeMemoryVersion(f.profile.id), borrowedMemoryRefs: [] };
    assert.equal(store.recordNativeSession(f.profile.id, f.transcriptSessionId, "native-2", "binding", rebuilt), true);
    assert.equal(store.nativeSessionStale(f.profile.id, f.transcriptSessionId, "native-2", "binding"), false);
  } finally { store.close(); f.cleanup(); }
});

test("short-term recall and every marked write reject borrowed material before durable promotion", async () => {
  const f = contextFixture(); let database;
  try {
    assert.throws(() => assertNoBorrowedMemoryWrite({ content: MARKER, borrowedMemoryRefs: refs() }), { code: "MEMORY_BORROWED_READ_ONLY" });
    database = new MemoryDatabase({ paths: f.paths, databasePath: path.join(f.paths.agentsDir, f.profile.id, "memory-core.sqlite") });
    database.open();
    const host = new ShoggothMemoryHost({ database, paths: f.paths, profileId: f.profile.id, workspaceDir: f.run.workspace,
      roster: () => [{ id: f.profile.id, workspace: f.run.workspace }], sessions: {} });
    const store = host.openKeyedStore({ namespace: core.SHORT_TERM_RECALL_NAMESPACE, maxEntries: 100 });
    await assert.rejects(store.register("borrowed-candidate", { value: { text: MARKER, borrowedMemoryRefs: refs() } }), { code: "MEMORY_BORROWED_READ_ONLY" });
    assert.equal(await store.count(), 0);
  } finally { database?.close(); f.cleanup(); }
});

test("Dreaming report source snapshot contains exact read ranges without body", () => {
  const f = contextFixture(); let database;
  try {
    database = new MemoryDatabase({ paths: f.paths, databasePath: path.join(f.paths.agentsDir, f.profile.id, "memory-core.sqlite") }); database.open();
    const host = new ShoggothMemoryHost({ database, paths: f.paths, profileId: f.profile.id, workspaceDir: f.run.workspace,
      roster: () => [{ id: f.profile.id, workspace: f.run.workspace }], sessions: {} });
    host.searchIndex = { sourceFiles: { read: () => ({ text: `header\n${MARKER}\nunrelated` }) } };
    host.runWithSourceEvidence(() => {
      host.rememberSourceRange({ path: "MEMORY.md", startLine: 2, endLine: 2 });
      assert.deepEqual(host.sourceEvidenceSnapshot(), [{ path: "MEMORY.md", startLine: 2, endLine: 2, sourceHash: refs()[0].sourceHash }]);
      assert.doesNotMatch(JSON.stringify(host.sourceEvidenceSnapshot()), new RegExp(MARKER));
    });
  } finally { database?.close(); f.cleanup(); }
});


test("phase evidence proves exact fresh Deep output and never stamps historical or continuity diary content", async () => {
  const f = contextFixture(); let database;
  try {
    const workspace = path.join(fs.realpathSync(f.root), "dream-workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), `header\n${MARKER}\n`, { mode: 0o600 });
    const old = "OLD_UNTRACKED_DIARY_FROM_ANOTHER_WORKSPACE";
    fs.writeFileSync(path.join(workspace, "DREAMS.md"), `# Dream Diary\n<!-- openclaw:dreaming:diary:start -->\n\n---\n\n${old}\n\n<!-- openclaw:dreaming:diary:end -->\n`, { mode: 0o600 });
    database = new MemoryDatabase({ paths: f.paths, databasePath: path.join(f.paths.agentsDir, f.profile.id, "dream-phase.sqlite") }); database.open();
    const host = new ShoggothMemoryHost({ database, paths: f.paths, profileId: f.profile.id, workspaceDir: workspace,
      roster: () => [{ id: f.profile.id, workspace }], sessions: {} });
    host.searchIndex = { sourceFiles: { relative: target => path.relative(workspace, target).replaceAll(path.sep, "/"),
      read: relative => ({ text: fs.readFileSync(path.join(workspace, relative), "utf8") }), isManaged: () => true, isExtra: () => false } };
    const key = "MEMORY.md:2:2", stateKey = `${core.memoryCoreWorkspaceStateKey(workspace)}:${crypto.createHash("sha256").update(key).digest("hex")}`;
    await host.openKeyedStore({ namespace: core.SHORT_TERM_RECALL_NAMESPACE, maxEntries: 10 }).register(stateKey,
      { workspaceKey: core.memoryCoreWorkspaceStateKey(workspace), value: { key, path: "MEMORY.md", startLine: 2, endLine: 2 } });
    await host.runWithSourceEvidence(async () => {
      await host.runWithDreamingCompletionSourceEvidence({ message: JSON.stringify({ currentMemory: [], candidates: [{ key }] }) }, async () => ({ text: "consolidation result" }));
      const files = host.getAgentWorkspaceAccess(workspace).memoryFiles.maintenance;
      const reportPath = path.join(workspace, "memory", "dreaming", "deep", "2026-10-09.md");
      await files.replaceReport(reportPath, "# Deep Sleep\n\n- Ranked 1 candidate(s).\n- Promoted 1 candidate(s).\n");
      const dreamsPath = path.join(workspace, "DREAMS.md");
      await files.writeDreams(dreamsPath, fs.readFileSync(dreamsPath, "utf8")
        + "\n## Deep Sleep\n<!-- openclaw:dreaming:deep:start -->\n- Ranked 1 candidate(s).\n- Promoted 1 candidate(s).\n<!-- openclaw:dreaming:deep:end -->\n");
      await host.appendMemoryHostEvent(workspace, { type: "memory.dream.completed", phase: "deep", inlinePath: dreamsPath, reportPath });
      const appendBody = async (message, body) => {
        await host.runWithDreamingCompletionSourceEvidence({ message }, async () => ({ text: body }));
        const existing = fs.readFileSync(dreamsPath, "utf8");
        await files.writeDreams(dreamsPath, existing.replace("<!-- openclaw:dreaming:diary:end -->", `---\n\n${body}\n\n<!-- openclaw:dreaming:diary:end -->`));
      };
      await appendBody(`Write a dream diary entry from these memory fragments:\n- ${MARKER}`, "FRESH_DEEP_DIARY_BODY");
      host.recordDreamingPhaseEvent({ type: "memory.dream.completed", phase: "light" });
      await appendBody(`Write a dream diary entry from these memory fragments:\n- ${MARKER}\nDiary continuity context:\n- ${old}`, "FRESH_LIGHT_WITH_UNPROVED_CONTINUITY");
      const evidence = host.phaseEvidenceSnapshot(), rootLines = fs.readFileSync(path.join(workspace, "DREAMS.md"), "utf8").split("\n");
      const oldLine = rootLines.findIndex(line => line.includes(old)) + 1;
      const deep = evidence.filter(entry => entry.phase === "deep" && !entry.unresolved);
      assert.equal(deep.length, 3, "separate Deep report, root Deep block and fresh Deep body are independently proved");
      assert.ok(evidence.some(entry => entry.kind === "narrative" && entry.unresolvedReason === "diary_continuity_unproved"));
      for (const entry of deep) {
        const lines = fs.readFileSync(path.join(workspace, entry.path), "utf8").split("\n");
        assert.equal(crypto.createHash("sha256").update(lines.slice(entry.startLine - 1, entry.endLine).join("\n")).digest("hex"), entry.rangeHash);
        assert.deepEqual(entry.sources, [{ path: "MEMORY.md", startLine: 2, endLine: 2, sourceHash: refs()[0].sourceHash }]);
        if (entry.path === "DREAMS.md") assert.ok(oldLine < entry.startLine || oldLine > entry.endLine);
      }
      assert.doesNotMatch(JSON.stringify(evidence), new RegExp(`${MARKER}|${old}|FRESH_DEEP_DIARY_BODY`), "evidence is metadata only");
    });
  } finally { database?.close(); f.cleanup(); }
});


test("unavailable read observations preserve native results and grant no report authority", async () => {
  const f = contextFixture(); let database;
  try {
    const workspace = path.join(fs.realpathSync(f.root), "bare-workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
    const memory = path.join(workspace, "MEMORY.md"); fs.writeFileSync(memory, MARKER, { mode: 0o600 });
    database = new MemoryDatabase({ paths: f.paths, databasePath: path.join(f.paths.agentsDir, f.profile.id, "bare-observer.sqlite") }); database.open();
    const host = new ShoggothMemoryHost({ database, paths: f.paths, profileId: f.profile.id, workspaceDir: workspace,
      roster: () => [{ id: f.profile.id, workspace }], sessions: { read: () => null } });
    const files = host.getAgentWorkspaceAccess(workspace).memoryFiles;
    assert.equal(files.read(memory).toString("utf8"), MARKER, "a bare native Host read does not require the optional sharing index");
    await host.runWithSourceEvidence(async () => {
      assert.equal(files.read(memory).toString("utf8"), MARKER);
      host.searchIndex = { sessionPath: id => `sessions/${f.profile.id}/${id}.jsonl`, sourceFiles: {
        isExtra: () => false, relative: target => path.relative(workspace, target).replaceAll(path.sep, "/") } };
      const result = host.buildSessionEntry(path.join(workspace, ".session-source", "missing"),
        { agentId: f.profile.id, sessionId: "missing", storePath: database.path });
      assert.deepEqual(result, { absPath: path.join(workspace, ".session-source", "missing"),
        path: `sessions/${f.profile.id}/missing.jsonl`, sessionId: "missing" }, "the original null spread result is retained");
      assert.equal(host.fileEvidence.getStore().actualReads.size, 2);
      assert.ok([...host.fileEvidence.getStore().actualReads.values()].every(input => input.unresolved));
      assert.doesNotMatch(JSON.stringify([...host.fileEvidence.getStore().actualReads.values()]), new RegExp(MARKER));
      await files.maintenance.replaceReport(path.join(workspace, "memory", "dreaming", "deep", "2026-10-09.md"), "# Owner-only Deep result\n");
      host.recordDreamingPhaseEvent({ type: "memory.dream.completed", phase: "deep",
        reportPath: path.join(workspace, "memory", "dreaming", "deep", "2026-10-09.md") });
      assert.equal(host.phaseEvidenceSnapshot()[0].unresolved, true);
    });
  } finally { database?.close(); f.cleanup(); }
});

test("unknown and corrupt consolidation candidates allow owner work but cannot authorize Deep reports or diary bodies", async () => {
  const f = contextFixture(); let database;
  try {
    const workspace = path.join(fs.realpathSync(f.root), "candidate-workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), `header\n${MARKER}\n`, { mode: 0o600 });
    database = new MemoryDatabase({ paths: f.paths, databasePath: path.join(f.paths.agentsDir, f.profile.id, "candidate-proof.sqlite") }); database.open();
    const host = new ShoggothMemoryHost({ database, paths: f.paths, profileId: f.profile.id, workspaceDir: workspace,
      roster: () => [{ id: f.profile.id, workspace }], sessions: {} });
    host.searchIndex = { sourceFiles: { relative: target => path.relative(workspace, target).replaceAll(path.sep, "/"),
      read: relative => ({ text: fs.readFileSync(path.join(workspace, relative), "utf8") }), isManaged: () => true, isExtra: () => false } };
    const workspaceKey = core.memoryCoreWorkspaceStateKey(workspace), key = "known-candidate", corruptKey = "corrupt-candidate";
    const stateKey = value => `${workspaceKey}:${crypto.createHash("sha256").update(value).digest("hex")}`;
    const store = host.openKeyedStore({ namespace: core.SHORT_TERM_RECALL_NAMESPACE, maxEntries: 10 });
    for (const candidateKey of [key, corruptKey]) await store.register(stateKey(candidateKey),
      { workspaceKey, value: { key: candidateKey, path: "MEMORY.md", startLine: 2, endLine: 2 } });
    database.db.prepare("UPDATE memory_state SET value=? WHERE namespace=? AND key=?")
      .run("{corrupt JSON", core.SHORT_TERM_RECALL_NAMESPACE, stateKey(corruptKey));
    const requests = [JSON.stringify({ candidates: [{ key }, { key: "unknown-candidate" }] }),
      JSON.stringify({ candidates: [{ key: corruptKey }] }), '{"candidates": [broken JSON', JSON.stringify({ candidates: "invalid" })];
    for (const [index, message] of requests.entries()) await host.runWithSourceEvidence(async () => {
      let calls = 0;
      await host.runWithDreamingCompletionSourceEvidence({ message }, async () => { calls++; return { text: "Owner result" }; });
      assert.equal(calls, 1, "optional source proof does not introduce a pre-model failure");
      host.rememberPromotionSources(message); host.assertFileSources();
      assert.equal(host.fileEvidence.getStore().failure, undefined, "the retained-marker enforcement scope is unchanged");
      const reportPath = path.join(workspace, "memory", "dreaming", "deep", "2026-10-09.md");
      const files = host.getAgentWorkspaceAccess(workspace).memoryFiles.maintenance;
      await files.replaceReport(reportPath, `# Deep result ${index}\n`);
      host.recordDreamingPhaseEvent({ type: "memory.dream.completed", phase: "deep", reportPath });
      await host.runWithDreamingCompletionSourceEvidence({ message: "Write a dream diary entry from these memory fragments:" }, async () => ({ text: `UNPROVED_BODY_${index}` }));
      await files.writeDreams(path.join(workspace, "DREAMS.md"), `# Dream Diary\nUNPROVED_BODY_${index}\n`);
      const evidence = host.phaseEvidenceSnapshot();
      assert.ok(evidence.some(entry => entry.kind === "phase_report"));
      assert.ok(evidence.some(entry => entry.kind === "narrative"));
      assert.ok(evidence.every(entry => entry.unresolved), "a valid sibling cannot launder an unknown candidate's generated output");
      assert.doesNotMatch(JSON.stringify(evidence), new RegExp(`${MARKER}|UNPROVED_BODY`));
    });
  } finally { database?.close(); f.cleanup(); }
});

test("compaction reprojects revoked history, verifies its source before and after generation and preserves valid dependencies", () => {
  const f = contextFixture(); let current = true;
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy,
    borrowedMemoryDependenciesCurrent: () => current });
  store.open();
  try {
    addBorrow(f); f.append({ id: "borrowed-answer", kind: "assistant", content: { text: MARKER } });
    f.append({ id: "own-direct", kind: "user", content: { text: "自己的独立事实" } });
    const plan = () => planConversationCompaction({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      transcriptStore: f.transcripts, checkpointStore: store, force: true, targetThroughSeq: 4 });
    const commit = (source, text, runId) => store.commit({ ...source, summary: summary(text),
      provenance: { runId, bindingId: "binding", runtime: "codex", model: "model", method: "model" } });
    const valid = plan(); assert.match(valid.prompt, new RegExp(MARKER));
    assert.deepEqual(store.assertSourceProjectionCurrent(valid), refs());
    const forged = { ...valid, sourceProjection: { ...valid.sourceProjection, borrowedMemoryRefs: [] } };
    assert.throws(() => store.assertSourceProjectionCurrent(forged), { code: "CHECKPOINT_STALE" });
    assert.throws(() => commit(forged, "forged dependency omission", "forged"), { code: "CHECKPOINT_STALE" });
    const original = commit(valid, "a borrowed fact", "valid-summary");
    assert.deepEqual(original.borrowedMemoryRefs, refs());
    assert.deepEqual(commit(valid, "a borrowed fact", "valid-summary"), original, "commit retry remains idempotent");
    current = false;
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId), null);
    assert.throws(() => store.assertSourceProjectionCurrent(valid), { code: "CHECKPOINT_STALE" });
    const redacted = plan(); assert.doesNotMatch(redacted.prompt, new RegExp(MARKER));
    assert.doesNotMatch(redacted.prompt, /a borrowed fact/u);
    assert.match(redacted.prompt, /来源已变化或撤回/u);
    assert.match(redacted.prompt, /自己的独立事实/u);
    assert.deepEqual(store.assertSourceProjectionCurrent(redacted), []);
    const rebuilt = commit(redacted, "only own fact and an unavailable source citation", "safe-summary");
    assert.equal(rebuilt.borrowedMemoryRefs, undefined);
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId).id, rebuilt.id);
    assert.throws(() => commit({ ...valid, sourceProjection: null }, "old text cannot be laundered", "unsafe-summary"), { code: "CHECKPOINT_STALE" });
  } finally { store.close(); f.cleanup(); }
});

test("a borrowed source revoked between safe planning and completion invalidates the summary", () => {
  const f = contextFixture(); let current = true;
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    borrowedMemoryDependenciesCurrent: () => current }); store.open();
  try {
    addBorrow(f); f.append({ id: "answer", kind: "assistant", content: { text: MARKER } });
    const plan = planConversationCompaction({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      transcriptStore: f.transcripts, checkpointStore: store, force: true, targetThroughSeq: 3 });
    assert.deepEqual(store.assertSourceProjectionCurrent(plan), refs());
    current = false;
    assert.throws(() => store.commit({ ...plan, summary: summary("model used old source"),
      provenance: { runId: "late", bindingId: "binding", runtime: "codex", model: "model", method: "model" } }), { code: "CHECKPOINT_STALE" });
    assert.equal(store.get(f.profile.id, f.transcriptSessionId), null);
  } finally { store.close(); f.cleanup(); }
});


test("revocation during a fragmented checkpoint can restart compaction from safe citations", () => {
  const f = contextFixture(); let current = true;
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    borrowedMemoryDependenciesCurrent: () => current }); store.open();
  try {
    f.append({ id: "large-borrowed-answer", kind: "assistant", borrowedMemoryRefs: refs(),
      content: { text: `${MARKER} `.repeat(2000) } });
    f.append({ id: "own-current", kind: "user", content: { text: "continue" } });
    const prepare = () => planConversationCompaction({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      transcriptStore: f.transcripts, checkpointStore: store, force: true, targetThroughSeq: 1, maxSourceBytes: 1024 });
    const first = prepare(); assert.equal(first.partial.seq, 1);
    const partial = store.commit({ ...first, summary: summary("first old source fragment"),
      provenance: { runId: "fragment-first", bindingId: "binding", runtime: "codex", model: "model", method: "model" } });
    assert.ok(partial.borrowedMemoryRefs.length);
    current = false;
    const safe = prepare(); assert.doesNotMatch(safe.prompt, new RegExp(MARKER));
    assert.equal(safe.partial, null); assert.equal(safe.previousId, null);
    const rebuilt = store.commit({ ...safe, summary: summary("old source unavailable"),
      provenance: { runId: "fragment-rebuilt", bindingId: "binding", runtime: "codex", model: "model", method: "model" } });
    assert.equal(rebuilt.coveredThroughSeq, 1); assert.equal(rebuilt.borrowedMemoryRefs, undefined);
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId).id, rebuilt.id);
  } finally { store.close(); f.cleanup(); }
});


test("trusted rebuilt context can replace stale dependencies while the dialogue remains excluded from promotion", () => {
  const f = contextFixture(); let currentHash = refs()[0].sourceHash;
  try {
    addBorrow(f); f.append({ id: "old-answer", kind: "assistant", content: { text: MARKER } });
    const fresh = [{ ...refs()[0], sourceHash: "4".repeat(64), sourceRevision: `sha256:${"4".repeat(64)}` }];
    currentHash = fresh[0].sourceHash;
    const renewed = f.append({ id: "renewed-answer", runId: "run-renewed", kind: "assistant",
      borrowedMemoryProjection: { refs: fresh, derived: true }, content: { text: "CURRENT_SOURCE_VERSION" } });
    assert.deepEqual(renewed.content.borrowedMemoryRefs, fresh);
    assert.equal(renewed.content.borrowedMemoryDerived, true);
    assert.equal(renewed.content.borrowedMemoryProjection, undefined);
    f.compiler.borrowedMemoryDependenciesCurrent = (_profile, _session, values) => values.every(ref => ref.sourceHash === currentHash);
    f.append({ id: "renewed-current-user", runId: "run-after-renewed", kind: "user", content: { text: "continue" } });
    const compiled = f.compiler.compile({ profile: f.profile, run: { ...f.run, id: "run-after-renewed" },
      transcriptSessionId: f.transcriptSessionId, query: "continue" });
    assert.doesNotMatch(compiled.dynamicContext, new RegExp(MARKER));
    assert.match(compiled.dynamicContext, /CURRENT_SOURCE_VERSION/u);
    const cleared = f.append({ id: "own-answer-after-rebuild", runId: "run-cleared", kind: "assistant",
      borrowedMemoryProjection: { refs: [], derived: false }, content: { text: "TAINT_CANNOT_BE_CLEARED" } });
    assert.equal(cleared.content.borrowedMemoryDerived, true);
    assert.equal(cleared.content.borrowedMemoryRefs, undefined);
    f.transcripts.close(); f.transcripts.open();
    const { recall, source } = recallFixture(f);
    try { assert.doesNotMatch(source.read(f.profile.id, f.transcriptSessionId).content, /CURRENT_SOURCE_VERSION|TAINT_CANNOT_BE_CLEARED/u); }
    finally { recall.close(); }
  } finally { f.cleanup(); }
});


test("a native anchor accumulates dependencies until the native session is replaced", () => {
  const f = contextFixture(); let current = true;
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy,
    borrowedMemoryDependenciesCurrent: () => current });
  store.open();
  try {
    const first = refs(), second = first.map(ref => ({ ...ref, ownerProfileId: "profile-3" }));
    const write = (native, borrowedMemoryRefs) => store.recordNativeSession(f.profile.id, f.transcriptSessionId,
      native, "binding", { ...store.nativeMemoryVersion(f.profile.id), borrowedMemoryRefs });
    assert.equal(write("native-1", first), true);
    assert.equal(write("native-1", second), true);
    store.close(); store.open();
    const read = () => store.nativeSessionBorrowedMemoryRefs(f.profile.id, f.transcriptSessionId, "native-1", "binding");
    assert.deepEqual(read(), mergeBorrowedMemoryRefs(first, second));
    assert.equal(write("native-1", []), true);
    assert.deepEqual(read(), mergeBorrowedMemoryRefs(first, second), "a shorter current prompt cannot erase old native history");
    current = false;
    assert.equal(write("native-1", []), false, "omitting a revoked old dependency cannot bless its native session");
    assert.equal(store.nativeSessionStale(f.profile.id, f.transcriptSessionId, "native-1", "binding"), true);
    assert.equal(write("native-2", []), true, "new native history can drop old dependencies");
    assert.equal(store.nativeSessionStale(f.profile.id, f.transcriptSessionId, "native-2", "binding"), false);
  } finally { store.close(); f.cleanup(); }
});


test("anchors written before automatic dependency capture retire once instead of blessing incomplete history", () => {
  const f = contextFixture();
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy });
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
  store.open();
  try {
    const write = native => store.recordNativeSession(f.profile.id, f.transcriptSessionId, native, "binding",
      { ...store.nativeMemoryVersion(f.profile.id), borrowedMemoryRefs: [] });
    assert.equal(write("native-old"), true);
    const file = path.join(f.paths.agentsDir, f.profile.id, "conversation-checkpoints",
      `${crypto.createHash("sha256").update(f.transcriptSessionId).digest("hex")}.native-memory-anchor.json`);
    const { checksum, ...old } = JSON.parse(fs.readFileSync(file));
    assert.equal(old.version, 3); old.version = 1; delete old.memoryInvalidationRevision;
    fs.writeFileSync(file, stable({ ...old, checksum: crypto.createHash("sha256").update(stable(old)).digest("hex") }) + "\n");
    store.close(); store.open();
    assert.equal(store.nativeSessionStale(f.profile.id, f.transcriptSessionId, "native-old", "binding"), true);
    assert.equal(write("native-old"), false, "missing historical dependencies cannot be repaired by blessing the same native session");
    assert.equal(write("native-new"), true);
    assert.equal(store.nativeSessionStale(f.profile.id, f.transcriptSessionId, "native-new", "binding"), false);
  } finally { store.close(); f.cleanup(); }
});


test("ordinary recall questions do not inherit historical borrowed references", () => {
  const f = contextFixture();
  try {
    addBorrow(f);
    const questions = [
      "Do you remember the reference code, audit interval, and my notebook material previously recorded for this project?",
      "Do you remember the previous telescope calibration?",
      "Did you still remember that calibration?",
      "Recall the previously saved telescope calibration.",
    ];
    for (const [index, text] of questions.entries()) {
      assert.equal(isReferentialMemoryRequest(text), false, text);
      const event = f.append({ id: `recall-question-${index}`, kind: "user", content: { text } });
      assert.equal(isBorrowedMemoryDerived(event), false, text);
      assert.deepEqual(event.content.borrowedMemoryRefs ?? [], []);
    }
    const marked = f.append({ id: "explicitly-derived-question", kind: "user", borrowedMemoryRefs: refs(),
      content: { text: questions[0], borrowedMemoryDerived: true } });
    assert.equal(isBorrowedMemoryDerived(marked), true, "trusted provenance remains authoritative regardless of phrasing");
    assert.deepEqual(marked.content.borrowedMemoryRefs, refs());
  } finally { f.cleanup(); }
});

test("referential saving still inherits borrowed provenance beside an ordinary recall question", () => {
  const f = contextFixture();
  try {
    addBorrow(f);
    const requests = [
      "Remember the previous answer.", "Please save the above.", "Could you remember that for later?",
      "Do you remember that code? Please save the above answer.",
      "Do you remember to save this?", "Did you remember that? Remember this answer for later.",
      "把上面的内容记住", "请保存刚才的回答", "请记住这个结论",
    ];
    for (const [index, text] of requests.entries()) {
      assert.equal(isReferentialMemoryRequest(text), true, text);
      const event = f.append({ id: `save-request-${index}`, kind: "user", content: { text } });
      assert.equal(isBorrowedMemoryDerived(event), true, text);
      assert.deepEqual(event.content.borrowedMemoryRefs, refs());
      assert.throws(() => assertNoBorrowedMemoryWrite(event.content), { code: "MEMORY_BORROWED_READ_ONLY" });
    }
  } finally { f.cleanup(); }
});
