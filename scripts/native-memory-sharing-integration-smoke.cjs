"use strict";
// Real isolated Product Service, authenticated IPC projection, MCP controller,
// owner indexes, flush/Dreaming and restart. Model completions are controlled
// literals; no production memories or provider accounts are accessed.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { McpProductToolController, PUBLIC_MESSAGES } = require("../app/agent-service/mcp-product-tool-controller");
const { SUMMARY_FIELDS, coveredTranscript } = require("../app/agent-service/conversation-checkpoint-store");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { sha256 } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const MARKER = "telescope_borrowed_secret_482731";
const DERIVED = "translated_borrowed_answer_84917";
const DAILY = "telescope_daily_origin_97241";
const OWN = "owner_new_fact_564738";
const OLD_DIARY = "old_untracked_other_workspace_diary_918372";
function allText(directory) {
  if (!fs.existsSync(directory)) return "";
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? allText(target) : entry.isFile() ? fs.readFileSync(target).toString() : "";
  }).join("\n");
}
function databaseText(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())).join("\n");
}
function databaseLeakMetadata(db, markers) {
  const found = [];
  const inspect = (value, jsonPath, matches, depth = 0) => {
    if (depth > 32) return;
    if (typeof value === "string") {
      if (/^[\[{]/u.test(value.trim())) { try { inspect(JSON.parse(value), jsonPath, matches, depth + 1); return; } catch {} }
      const labels = Object.keys(markers).filter(label => value.includes(markers[label]));
      if (labels.length) matches.push({ jsonPath, labels });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) inspect(child, `${jsonPath}.${key}`, matches, depth + 1);
    }
  };
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const [rowIndex, row] of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().entries()) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string" || !Object.values(markers).some(marker => value.includes(marker))) continue;
        const matches = []; inspect(value, "$", matches);
        found.push({ table: name, rowIndex, column, matches });
      }
    }
  }
  return found;
}
function seed(service, profileId, workspace, tag, prompt) {
  const session = service.chatSessionStore.createSession({ profileId, workspace, operationId: `${tag}-session`, createdAt: Date.now() });
  service.chatSessionStore.requestBinding(session.sessionKey, `${tag}-binding`, Date.now());
  service.chatSessionStore.completeBinding(session.sessionKey, `${tag}-binding`, `${tag}-native`);
  const run = service.workDispatcher.enqueue({ id: `${tag}-run`, profileId, source: "chat", sourceId: session.sessionKey,
    idempotencyKey: `${tag}-run`, workspace }); service.workDispatcher.admit(run.id); service.workDispatcher.transition(run.id, "running");
  service.transcriptStore.appendEvent({ profileId, sessionId: session.id, id: `${tag}-user`, runId: run.id, kind: "user", content: { text: prompt } });
  return { session, run: service.workDispatcher.getRun(run.id) };
}
function next(service, session, tag, prompt) {
  const run = service.workDispatcher.enqueue({ id: `${tag}-run`, profileId: session.profileId, source: "chat", sourceId: session.sessionKey,
    idempotencyKey: `${tag}-run`, workspace: session.workspace }); service.workDispatcher.admit(run.id); service.workDispatcher.transition(run.id, "running");
  service.transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id, id: `${tag}-user`, runId: run.id, kind: "user", content: { text: prompt } });
  return service.workDispatcher.getRun(run.id);
}
function controller(service) {
  const noop = () => null;
  const memory = new ConversationMemoryService({ memoryEngine: service.memoryEngine, memoryStore: service.memoryStore,
    transcriptStore: service.transcriptStore, chatSessionStore: service.chatSessionStore,
    getRunSessionKey: run => run.sourceId, memoryProvenanceService: service.memoryProvenanceService });
  let current;
  const mcp = new McpProductToolController({ productStore: service.productStore, conversationMemoryService: memory,
    conversationRecallService: service.conversationRecallService, permissionEngine: service.permissionEngine,
    domainController: { handle: noop }, kanbanStore: Object.fromEntries(["getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts"].map(key => [key, noop])),
    kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop }, workDispatcher: service.workDispatcher,
    // Only the Runtime context transport is a controlled test double. The
    // current identity/status/workspace are still read from durable Product.
    getRuntimeContext: profileId => current?.profileId === profileId ? { source: current.source, sourceId: current.sourceId, profileId, runId: current.id } : null,
    notificationSender: noop, isSensitiveValue: () => false, artifactRoot: service.paths?.trustedRoot || os.tmpdir() });
  return (run, name, args = {}) => { current = service.workDispatcher.getRun(run.id);
    return mcp.handle(name, { source: run.source, sourceId: run.sourceId, ...args }, { profileId: run.profileId, callId: crypto.randomUUID() }); };
}

for (const dreamingStorageMode of ["separate", "both"]) test(`real Product cross-Agent reads preserve D1, reject copies and survive source edits, revocation and restart (${dreamingStorageMode})`, { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "smr-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "s"), profileRoot: path.join(root, "p"), cacheRoot: path.join(root, "c") });
  const workspace = path.join(root, "w"); fs.mkdirSync(workspace, { mode: 0o700 });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const config = { memory: { search: { provider: "none", sources: ["memory", "sessions"], rememberAcrossConversations: false } },
    agents: { defaults: { compaction: { memoryFlush: { enabled: true } } } },
    plugins: { entries: { "memory-core": { config: { dreaming: { storage: { mode: dreamingStorageMode }, phases: { light: { enabled: true }, rem: { enabled: true }, deep: { minScore: 0, minRecallCount: 1, minUniqueQueries: 1 } } } } } } } };
  let service;
  const open = async () => { service = createAgentService({ paths, safeStorage, memoryCore: true, memoryCoreConfig: config,
    memorySharingFeatureReady: true, prewarmMcpAuth: false }); await service.start();
    require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(service.memoryEngine);
    return service; };
  try {
    await open(); const A = DEFAULT_AGENT_PROFILE_ID, B = "source-b", C = "source-c";
    const base = service.productStore.getAgentProfile(A), fields = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
    for (const id of [B, C]) {
      const profile = Object.fromEntries(fields.map(field => [field, base[field]])); Object.assign(profile, { id, agentId: id, name: id, runtimeProfileId: id, isDefault: false });
      service.productStore.putAgentProfile(profile); service.agentDefinitionStore.ensureProfile({ profileId: id }); service.memoryStore.ensureProfile(id); service.memoryEngine.recallPolicy.assertReady(id);
    }
    const apply = async (revision, enabled = true, excludedProfiles = []) => {
      try { return await requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths), version: PROTOCOL_VERSION,
        method: "memory.sharing.config.apply", params: { revision, config: { enabled, excludedProfiles } } }); }
      catch (error) { const diagnostic = path.join(paths.runtimeDir, "service-recovery.json");
        if (fs.existsSync(diagnostic)) error.message += `; ${fs.readFileSync(diagnostic, "utf8")}`;
        throw error; }
    };
    await apply(0);
    let owner = service.memoryEngine, call = controller(service), modelCalls = 0;
    owner.complete = async () => { modelCalls++; assert.fail("search must never start source chat models"); };
    const source = await owner.propose({ profileId: B, content: `${MARKER} sapphire calibration`, scope: "agent", classification: "explicit", sourceRefs: ["user-edit:source-main"] });
    await owner.propose({ profileId: C, content: "telescope independent C calibration", scope: "agent", classification: "explicit", sourceRefs: ["user-edit:source-peer"] });
    const a = seed(service, A, workspace, "reader-first", "Find telescope information");
    const found = await call(a.run, "memory_search", { query: "telescope", minScore: 0, maxResults: 20 });
    const borrowed = found.results.find(row => row.ownerProfileId === B && row.snippet.includes(MARKER)); assert.ok(borrowed, JSON.stringify(found));
    assert.equal(found.coverage, "complete"); assert.equal(modelCalls, 0); assert.ok(found.results.some(row => row.ownerProfileId === C));
    assert.deepEqual(owner.listShared(A).items, []);
    const read = await call(a.run, "memory_get", { id: borrowed.sourceRef }); assert.match(read.text, new RegExp(MARKER));
    assert.equal((await call(a.run, "memory_explain", { id: borrowed.sourceRef })).evidence.status, "verified");
    await assert.rejects(call(a.run, "memory_get", { path: "../source-b/MEMORY.md" }));
    service.transcriptStore.appendEvent({ profileId: A, sessionId: a.session.id, id: "reader-tool", runId: a.run.id, kind: "tool_result",
      borrowedMemoryRefs: read.borrowedMemoryRefs, content: { resultSummary: read.text, tool: { name: "memory_get", output: read } }, contextContent: { tool: { name: "memory_get", output: read } } });
    service.transcriptStore.appendEvent({ profileId: A, sessionId: a.session.id, id: "reader-answer", runId: a.run.id, kind: "assistant", content: { text: `From B: ${MARKER}` } });
    assert.doesNotMatch(JSON.stringify(service.transcriptStore.getEvent(A, a.session.id, "reader-tool")), new RegExp(MARKER));
    service.workDispatcher.transition(a.run.id, "completed"); await owner.finishActiveMemoryRun(a.run);
    const rewriting = next(service, a.session, "reader-translate", "Translate the previous answer");
    await assert.rejects(call(rewriting, "memory_get", { id: borrowed.sourceRef }), error => {
      assert.equal(error.code, "MEMORY_SHARED_REFERENCE_INVALID");
      assert.equal(typeof PUBLIC_MESSAGES[error.code], "string", "Service must expose a known memory error instead of an authentication failure");
      return true;
    });
    service.transcriptStore.appendEvent({ profileId: A, sessionId: a.session.id, id: "reader-translated", runId: rewriting.id, kind: "assistant", content: { text: DERIVED } });
    service.workDispatcher.transition(rewriting.id, "completed");
    const explicit = next(service, a.session, "reader-own", `My own new fact is ${OWN}`);
    const saved = await call(explicit, "memory_save", { expectedRevision: owner.store.getRevision(A), content: `My own new fact is ${OWN}`,
      scope: "agent", classification: "explicit", sourceQuote: `My own new fact is ${OWN}` }); assert.equal(saved.saved, true);
    const snapInput = { profile: service.productStore.resolveAgentRuntimeProfile(A), run: explicit, transcriptSessionId: a.session.id, query: "continue" };
    const snapshot = service.contextCompiler.compile(snapInput); assert.match(snapshot.dynamicContext, new RegExp(MARKER)); assert.ok(snapshot.borrowedMemoryRefs.length);
    assert.doesNotMatch(allText(path.join(paths.agentsDir, A, "context-snapshots")), new RegExp(`${MARKER}|${DERIVED}`));
    const checkpointStore = service.conversationCheckpointStore, memory = checkpointStore.memoryState(A), events = service.transcriptStore.listEvents(A, a.session.id);
    const summary = { ...Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []])), state: ["A source-dependent dialogue summary"] };
    let checkpoint = checkpointStore.commit({ profileId: A, sessionId: a.session.id, expectedRevision: service.transcriptStore.getRevision(A, a.session.id),
      expectedMemoryRevision: memory.revision, expectedMemoryFreshUntil: memory.freshUntil, throughSeq: events.at(-1).seq, coveredHash: coveredTranscript(events, events.at(-1).seq).hash,
      summary, provenance: { runId: "compact", bindingId: "binding", runtime: "codex", model: "literal", method: "model" } });
    assert.ok(checkpoint.borrowedMemoryRefs.length); assert.doesNotMatch(allText(path.join(paths.agentsDir, A, "conversation-checkpoints")), new RegExp(MARKER));
    service.workDispatcher.transition(explicit.id, "completed");
    const referential = next(service, a.session, "reader-copy", "把上面的内容记住");
    await assert.rejects(call(referential, "memory_save", { expectedRevision: owner.store.getRevision(A), content: MARKER, scope: "agent", classification: "explicit", sourceQuote: "把上面的内容记住" }), error => {
      assert.equal(error.code, "MEMORY_BORROWED_READ_ONLY");
      assert.equal(typeof PUBLIC_MESSAGES[error.code], "string", "Borrowed write rejection must survive the Service public error projection");
      return true;
    });
    service.workDispatcher.transition(referential.id, "completed");
    const normalized = owner.host(A).sessions.read(A, a.session.id); assert.match(normalized.content, new RegExp(OWN)); assert.doesNotMatch(normalized.content, new RegExp(`${MARKER}|${DERIVED}|把上面的内容记住`));
    owner.complete = async ({ prompt }) => { assert.doesNotMatch(prompt, new RegExp(`${MARKER}|${DERIVED}`)); return { text: prompt.includes("Host file-write transport") ? JSON.stringify({ append: `Own durable record ${OWN}` }) : `Reviewed own notes ${OWN}` }; };
    assert.equal((await owner.flushBeforeCompaction({ profileId: A, sessionId: a.session.id })).appended, true);
    assert.equal((await owner.dream(A)).handled, true);
    assert.doesNotMatch(allText(owner.store.workspace(A)), new RegExp(`${MARKER}|${DERIVED}`));
    assert.doesNotMatch(databaseText(owner.host(A).database.db), new RegExp(`${MARKER}|${DERIVED}`));
    assert.equal(owner.host(B).database.db.prepare("SELECT count(*) n FROM memory_state WHERE namespace=? AND value IS NOT NULL").get(core.SHORT_TERM_RECALL_NAMESPACE).n, 0);
    // Real session-derived daily source: exactly matching directories only.
    const b = seed(service, B, workspace, "source-daily", `New daily fact ${DAILY}`); service.workDispatcher.transition(b.run.id, "completed");
    owner.complete = async () => ({ text: JSON.stringify({ append: `New daily fact ${DAILY}` }) });
    const flushed = await owner.flushBeforeCompaction({ profileId: B, sessionId: b.session.id }); assert.equal(flushed.appended, true);
    const same = next(service, a.session, "reader-daily", "Find telescope daily origin");
    const dailyFound = await call(same, "memory_search", { query: DAILY, minScore: 0, ownerProfileId: B }); assert.ok(dailyFound.results.some(row => row.canonicalRelativePath === flushed.path));
    service.workDispatcher.transition(same.id, "completed"); await owner.finishActiveMemoryRun(same);
    for (const [index, otherWorkspace] of [path.join(root, "other"), path.join(workspace, "child")].entries()) {
      fs.mkdirSync(otherWorkspace, { recursive: true, mode: 0o700 }); const other = seed(service, A, otherWorkspace, `reader-other-${index}`, `Find ${DAILY}`);
      assert.equal((await call(other.run, "memory_search", { query: DAILY, minScore: 0, ownerProfileId: B })).results.some(row => row.canonicalRelativePath === flushed.path || row.snippet.includes(DAILY)), false);
      service.workDispatcher.transition(other.run.id, "completed"); await owner.finishActiveMemoryRun(other.run);
    }
    const dep = borrowed.borrowedMemoryRefs;
    assert.equal(dep[0].policyRevision, 0);
    // The reader's own flush/Dreaming changes its memory revision. Establish
    // a current own-memory anchor before testing foreign fragment invalidation.
    const currentMemory = checkpointStore.memoryState(A);
    checkpoint = checkpointStore.commit({ profileId: A, sessionId: a.session.id,
      expectedRevision: service.transcriptStore.getRevision(A, a.session.id),
      expectedMemoryRevision: currentMemory.revision, expectedMemoryFreshUntil: currentMemory.freshUntil,
      throughSeq: checkpoint.coveredThroughSeq, coveredHash: checkpoint.coveredHash, summary,
      provenance: { runId: "compact-current", bindingId: "binding", runtime: "codex", model: "literal", method: "model" } });
    const unrelated = path.join(owner.store.workspace(B), "memory/2026-10-08.md"); fs.writeFileSync(unrelated, "unrelated source fragment\n", { mode: 0o600 });
    assert.equal(owner.borrowedMemoryDependenciesCurrent(A, a.session.id, dep), true);
    assert.equal(checkpointStore.compatible(A, a.session.id)?.id, checkpoint.id);
    const sourceFile = path.join(owner.store.workspace(B), "MEMORY.md"), before = fs.readFileSync(sourceFile, "utf8");
    fs.writeFileSync(sourceFile, before.replace("sapphire", "emerald"), { mode: 0o600 }); assert.equal(owner.borrowedMemoryDependenciesCurrent(A, a.session.id, dep), false);
    assert.equal(checkpointStore.compatible(A, a.session.id), null);
    const continued = next(service, a.session, "reader-changed", "Continue with the current source");
    const rebuilt = service.contextCompiler.compile({ ...snapInput, run: continued }); assert.doesNotMatch(rebuilt.dynamicContext, /sapphire/u);
    assert.match(rebuilt.dynamicContext, /来源已变化或撤回/u); service.workDispatcher.transition(continued.id, "completed");
    fs.writeFileSync(sourceFile, before, { mode: 0o600 });
    await service.stop({ notify: false }); service = null; await open(); owner = service.memoryEngine; call = controller(service);
    assert.equal(service.nativeMemorySharingConfig.read().config.enabled, true); assert.equal(owner.borrowedMemoryDependenciesCurrent(A, a.session.id, dep), true);
    const restored = next(service, service.chatSessionStore.getSession(a.session.sessionKey), "reader-restored", "Continue telescope");
    assert.ok((await call(restored, "memory_search", { query: "telescope", minScore: 0 })).results.some(row => row.ownerProfileId === B));
    service.workDispatcher.transition(restored.id, "completed"); await owner.finishActiveMemoryRun(restored);
    await apply(1, true, [B]); assert.equal(owner.borrowedMemoryDependenciesCurrent(A, a.session.id, dep), false);
    const excluded = next(service, service.chatSessionStore.getSession(a.session.sessionKey), "reader-excluded", "Find excluded source");
    await assert.rejects(call(excluded, "memory_search", { query: "telescope", ownerProfileId: B, minScore: 0 }));
    service.workDispatcher.transition(excluded.id, "completed"); await owner.finishActiveMemoryRun(excluded);
    await apply(2, false); assert.equal(service.nativeMemorySharingConfig.resolve(A, service.productStore.listAgentProfiles()).enabled, false);
    assert.match(owner.store.readFile(B, "MEMORY.md"), new RegExp(MARKER));
    assert.doesNotMatch(allText(owner.store.workspace(A)), new RegExp(`${MARKER}|${DERIVED}`));
    assert.doesNotMatch(databaseText(owner.host(A).database.db), new RegExp(`${MARKER}|${DERIVED}`));
    // A real B-owned session/flush source must actually pass native recall
    // thresholds and Deep promotion before its report is a sharing fixture.
    await apply(3, true);
    const bSession = service.chatSessionStore.getSession(b.session.sessionKey);
    const deepRun = next(service, bSession, "source-deep-recall", `Review my own daily fact ${DAILY}`);
    for (const query of [DAILY, `daily ${DAILY}`, `fact ${DAILY}`]) {
      const recalled = await owner.searchOwnMemory({ profileId: B, query, minScore: 0, maxResults: 20, workspace, sources: ["memory"] });
      assert.ok(recalled.results.some(row => row.canonicalRelativePath === flushed.path || row.path === flushed.path));
    }
    service.workDispatcher.transition(deepRun.id, "completed"); await owner.finishActiveMemoryRun(deepRun);
    const bHost = owner.host(B), nativeConfig = core.resolveMemoryDeepDreamingConfig({ cfg: owner.config(B), pluginConfig: core.resolveMemoryDreamingPluginConfig(owner.config(B)) });
    const candidates = await bHost.run(() => core.rankShortTermPromotionCandidates({ ...nativeConfig, workspaceDir: bHost.workspaceDir, nowMs: owner.now() }));
    assert.ok(candidates.some(candidate => candidate.path === flushed.path), "real owner daily recalls must produce Deep promotion candidates");
    const promotionBefore = bHost.database.db.prepare("SELECT count(*) n FROM memory_promotion_sources").get().n;
    // Preserve an old, untracked diary from a different logical workspace. A
    // current Deep write may prove its own output, never this historic text.
    fs.writeFileSync(path.join(bHost.workspaceDir, "DREAMS.md"), `# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n\n---\n\n*Old unrelated workspace*\n\n${OLD_DIARY}\n\n<!-- openclaw:dreaming:diary:end -->\n`, { mode: 0o600 });
    let phaseEvidence = [];
    const phaseSnapshot = bHost.phaseEvidenceSnapshot.bind(bHost);
    bHost.phaseEvidenceSnapshot = () => { phaseEvidence = phaseSnapshot(); return phaseEvidence; };
    owner.complete = async ({ profileId, prompt }) => {
      assert.equal(profileId, B, "only the owner model may process owner promotion");
      const start = prompt.indexOf('{"currentMemory"');
      if (start >= 0) {
        const request = JSON.parse(prompt.slice(start));
        return { text: JSON.stringify({ operations: request.candidates.map(candidate => ({ candidateKey: candidate.key, action: "added", priorEntries: [] })) }) };
      }
      const phase = prompt.includes("Memories that crystallized") ? "deep" : prompt.includes("Diary continuity context") ? "light" : "rem";
      return { text: `Owner ${phase} reflection reviews daily calibration ${DAILY}.` };
    };
    assert.equal((await owner.dream(B)).handled, true);
    const promotionAfter = bHost.database.db.prepare("SELECT count(*) n FROM memory_promotion_sources").get().n;
    assert.ok(promotionAfter > promotionBefore, "Deep must commit at least one grounded promotion");
    assert.match(owner.store.readFile(B, "MEMORY.md"), new RegExp(DAILY));
    const ownDaily = owner.getFile({ profileId: B, path: flushed.path, from: 1, lines: 6, workspace, maxSensitivity: "private" });
    assert.match(ownDaily.text, new RegExp(DAILY), "owner can still read original daily lines after inline reports");
    const ownDailySearch = await owner.searchOwnMemory({ profileId: B, query: DAILY, minScore: 0, maxResults: 20, workspace, sources: ["memory"] });
    if (!ownDailySearch.results.some(row => row.canonicalRelativePath === flushed.path || row.path === flushed.path)) {
      const scope = { profileId: B, workspace, maxSensitivity: "private" };
      const chunks = bHost.searchIndex.db.prepare("SELECT path,source,start_line AS startLine,end_line AS endLine,text AS snippet FROM memory_index_chunks WHERE path=?").all(flushed.path);
      t.diagnostic(`OWNER_DAILY_META ${JSON.stringify({ results: ownDailySearch.results.map(row => ({ path: row.path, startLine: row.startLine, endLine: row.endLine })),
        chunks: chunks.map(row => ({ path: row.path, startLine: row.startLine, endLine: row.endLine, allowed: owner.allowResult(B, row, scope) })),
        records: owner.store.list(B, { status: "active" }).filter(item => item.memoryPath === flushed.path).map(item => ({ startLine: item.startLine, endLine: item.endLine,
          projection: !!item.projection, documentKind: item.documentKind, visible: owner.visible(item, scope), sourceSessionsVisible: owner.sourceSessionsVisible(B, item.authorityText || item.content, workspace),
          sourceEvidenceVisible: !item.sourceEvidence || owner.sourceEvidenceVisible(B, item.sourceEvidence, workspace),
          recallVisible: owner.recallPolicy.isMemoryVisible(B, item), sourceEvidence: item.sourceEvidence?.length || 0,
          fileOrigins: [...(item.authorityText || item.content).matchAll(/\b(memory\/[^\n`<>]*?\.(?:txt|md))(?::(\d+)-(\d+)|#L(\d+)-L(\d+))/gu)].map(match => {
            const source = { path: match[1], startLine: Number(match[2] || match[4]), endLine: Number(match[3] || match[5]) };
            try {
              const corpus = /^memory\/\.dreams\/session-corpus\/\d{4}-\d{2}-\d{2}\.txt$/u.test(source.path);
              const text = corpus ? fs.readFileSync(path.join(bHost.workspaceDir, source.path), "utf8") : bHost.searchIndex.sourceFiles.read(source.path).text,
                fragment = text.split("\n").slice(source.startLine - 1, source.endLine).join("\n");
              return { ...source, sourceHash: sha256(fragment), diagnosticReadOnlyInternalCorpus: corpus,
                sourcePathManaged: bHost.searchIndex.sourceFiles.isManaged(source.path), independentSessionVisible: owner.sourceSessionsVisible(B, fragment, workspace),
                sessionRefs: [...fragment.matchAll(/\[[^\]\s]+\/sessions\/(?:[^/\s]+\/)?([^#\s\]]+)#L(\d+)\]\s*([^\n]*)/gu)].map(ref => {
                  const found = service.chatSessionStore.listSessions().find(entry => entry.profileId === B && entry.id === ref[1]);
                  const event = service.conversationRecallService.scanEligibleSession({ profileId: B, sessionId: ref[1], afterSeq: Number(ref[2]) - 1, limit: 1, completedOnly: true }).events.find(entry => entry.seq === Number(ref[2]));
                  return { sessionId: ref[1], seq: Number(ref[2]), ownerProfileMatch: !!found, exactWorkspaceMatch: found?.workspace === workspace,
                    eligibleEventFound: !!event, eventKind: event?.kind, eventHash: event ? sha256(`${event.kind === "user" ? "User" : "Assistant"}: ${event.text.replace(/\s+/gu, " ").trim()}`) : null };
                }), hasSessionRef: /\/sessions\//u.test(fragment), hasFileOrigin: /memory\/[^\n`<>]*?\.(?:txt|md)(?::\d+-\d+|#L\d+-L\d+)/u.test(fragment),
                promotionKeys: core.extractPromotionKeys(fragment),
                overlappingSourceEvidence: owner.store.list(B, { status: "active" }).filter(bound => bound.memoryPath === source.path && bound.startLine <= source.endLine && bound.endLine >= source.startLine)
                  .map(bound => ({ startLine: bound.startLine, endLine: bound.endLine, sourceEvidenceVisible: !bound.sourceEvidence || owner.sourceEvidenceVisible(B, bound.sourceEvidence, workspace) })) };
            } catch (error) { return { ...source, readErrorCode: error.code || error.name }; }
          }) })) })}`);
    }
    assert.ok(ownDailySearch.results.some(row => row.canonicalRelativePath === flushed.path || row.path === flushed.path), "owner native search still returns its daily source after inline reports");
    const dailyEvidence = owner.sharing.reader.evidence({ ownerProfileId: B, requesterProfileId: A, workspace, maxSensitivity: "private" },
      { path: flushed.path, startLine: 1, endLine: 6 });
    assert.match(dailyEvidence.snippet, new RegExp(DAILY), "exact-directory borrower can verify only original daily subset");
    assert.throws(() => owner.sharing.reader.evidence({ ownerProfileId: B, requesterProfileId: A,
      workspace: path.join(workspace, "child"), maxSensitivity: "private" }, { path: flushed.path, startLine: 1, endLine: 6 }),
      "child-directory borrower cannot verify the same original daily subset");
    const rootLines = owner.store.readFile(B, "DREAMS.md").split("\n"), oldLine = rootLines.findIndex(line => line.includes(OLD_DIARY)) + 1;
    assert.ok(oldLine > 0, "Deep must preserve prior owner diary content");
    assert.equal(owner.store.reportEvidence(B, "DREAMS.md", oldLine, oldLine), null, "old untracked diary must never inherit current Deep proof");
    if (!phaseEvidence.some(entry => entry.phase === "deep" && !entry.unresolved && entry.sources.length)) {
      t.diagnostic(`DEEP_SOURCE_PROOF_META ${JSON.stringify(phaseEvidence.filter(entry => entry.phase === "deep").map(entry => ({
        kind: entry.kind, unresolved: entry.unresolved, unresolvedReason: entry.unresolvedReason, sourceCount: entry.sources.length,
        unavailableInputs: entry.inputEvidence?.filter(input => input.unresolved) })))}`);
    }
    assert.ok(phaseEvidence.some(entry => entry.phase === "deep" && !entry.unresolved && entry.sources.length), "Deep output needs its own precise input proof");
    assert.ok(phaseEvidence.some(entry => entry.unresolved), "incomplete phase/narrative inputs must remain visibly unproved");
    for (const entry of phaseEvidence.filter(entry => entry.path === "DREAMS.md" && !entry.unresolved)) {
      assert.ok(oldLine < entry.startLine || oldLine > entry.endLine, "no fresh proof may cover old diary text");
    }
    const deepReportPath = owner.store._files(B).filter(file => /^memory\/dreaming\/deep\//u.test(file.path)).find(file => /Promoted [1-9]\d* candidate/u.test(file.content))?.path;
    const rootReportPath = ["DREAMS.md", "dreams.md"].find(file => /Promoted [1-9]\d* candidate/u.test(owner.store.readFile(B, file)));
    assert.ok(deepReportPath && rootReportPath, "both native Deep and root reflection reports must record committed promotion");
    const reportRun = next(service, service.chatSessionStore.getSession(a.session.sessionKey), "reader-deep-report", "Find owner reflection ranked candidates");
    const reportSearch = await call(reportRun, "memory_search", { query: "Ranked", minScore: 0, maxResults: 20, ownerProfileId: B });
    const oldSearch = await call(reportRun, "memory_search", { query: OLD_DIARY, minScore: 0, maxResults: 20, ownerProfileId: B });
    assert.equal(oldSearch.results.some(row => row.snippet?.includes(OLD_DIARY)), false, `untracked old diary is not readable: ${JSON.stringify(oldSearch.results.map(row => ({ path: row.canonicalRelativePath, startLine: row.startLine, endLine: row.endLine, documentKind: row.documentKind, containsOld: row.snippet?.includes(OLD_DIARY) })))}`);
    const reportReads = [], reportEvidenceRows = [];
    for (const reportPath of [deepReportPath, rootReportPath]) {
      const reportRows = owner.database.db.prepare("SELECT count(*) n FROM memory_report_evidence WHERE profile_id=? AND path=?").get(B, reportPath).n;
      assert.ok(reportRows > 0, "reports must retain exact native promotion-source evidence");
      reportEvidenceRows.push({ path: reportPath, rows: reportRows });
      const report = reportSearch.results.find(row => row.canonicalRelativePath === reportPath && row.documentKind === "reflection_report");
      if (!report) {
        const proofRows = owner.database.db.prepare("SELECT data FROM memory_report_evidence WHERE profile_id=? AND path=?").all(B, reportPath);
        const origins = [...new Map(proofRows.flatMap(row => JSON.parse(row.data).sources).map(source => [JSON.stringify(source), source])).values()];
        const scope = { profileId: B, workspace, maxSensitivity: "private" }, policyInput = { ownerProfileId: B, requesterProfileId: A, workspace, maxSensitivity: "private" };
        t.diagnostic(`REPORT_SOURCE_META ${JSON.stringify(origins.map(source => {
          const text = owner.host(B).searchIndex.sourceFiles.read(source.path).text, fragment = text.split("\n").slice(source.startLine - 1, source.endLine).join("\n");
          return { ...source, sourceHashCurrent: sha256(fragment) === source.sourceHash,
            kind: require("../app/agent-service/shoggoth-memory/shared-document.cjs").documentKind(source.path, text, source.startLine, source.endLine),
            ownAllowed: owner.allowResult(B, { ...source, source: "memory", snippet: fragment }, scope),
            sharedAllowed: owner.sharing.reader.policy.allowResult(policyInput, { ...source, source: "memory", snippet: fragment }),
            overlappingRecords: owner.store.list(B, { status: "active" }).filter(item => item.memoryPath === source.path && item.startLine <= source.endLine && item.endLine >= source.startLine)
              .map(item => ({ startLine: item.startLine, endLine: item.endLine, projection: !!item.projection, scope: item.scope, classification: item.classification, visible: owner.visible(item, scope), sourceEvidence: item.sourceEvidence?.length || 0 })) };
        }))}`);
      }
      assert.ok(report, `same-directory reader must retrieve actual report: ${JSON.stringify({ reportPath, candidates: candidates.map(row => ({ path: row.path, startLine: row.startLine, endLine: row.endLine })), reportEvidenceRows: reportRows, found: reportSearch.results.map(row => ({ canonicalRelativePath: row.canonicalRelativePath, documentKind: row.documentKind })), coverage: reportSearch.coverage })}`);
      const reportRead = await call(reportRun, "memory_get", { id: report.sourceRef });
      assert.match(reportRead.text, /Ranked|Promoted/u);
      assert.ok(reportRead.borrowedMemoryRefs.every(ref => /^[a-f0-9]{64}$/u.test(ref.sourceOriginHash)));
      assert.equal(owner.borrowedMemoryDependenciesCurrent(A, a.session.id, reportRead.borrowedMemoryRefs), true);
      reportReads.push({ report, reportRead });
    }
    for (const [index, otherWorkspace] of [path.join(root, "other"), path.join(workspace, "child")].entries()) {
      const other = seed(service, A, otherWorkspace, `reader-report-other-${index}`, "Find owner reflection ranked candidates");
      const hidden = await call(other.run, "memory_search", { query: "Ranked", minScore: 0, maxResults: 20, ownerProfileId: B });
      assert.equal(hidden.results.some(row => row.documentKind === "reflection_report"), false, "Deep reports inherit exact source-directory scope");
      service.workDispatcher.transition(other.run.id, "completed"); await owner.finishActiveMemoryRun(other.run);
    }
    const dailySourceFile = path.join(owner.store.workspace(B), flushed.path), originalDaily = fs.readFileSync(dailySourceFile, "utf8");
    fs.writeFileSync(dailySourceFile, originalDaily.replaceAll(DAILY, "withdrawn_owner_daily_origin"), { mode: 0o600 });
    for (const { report, reportRead } of reportReads) {
      assert.equal(owner.borrowedMemoryDependenciesCurrent(A, a.session.id, reportRead.borrowedMemoryRefs), false, "changing real report origins must invalidate cached report dependencies");
      await assert.rejects(call(reportRun, "memory_get", { id: report.sourceRef }));
    }
    service.workDispatcher.transition(reportRun.id, "completed"); await owner.finishActiveMemoryRun(reportRun);
    assert.doesNotMatch(allText(owner.store.workspace(A)), new RegExp(`${MARKER}|${DERIVED}|${DAILY}`));
    const finalDatabaseLeaks = databaseLeakMetadata(owner.host(A).database.db, { borrowed: MARKER, derived: DERIVED, daily: DAILY });
    if (finalDatabaseLeaks.length) t.diagnostic(`READER_DATABASE_LEAK_META ${JSON.stringify(finalDatabaseLeaks)}`);
    assert.equal(finalDatabaseLeaks.length, 0, "reader durable database cannot contain borrowed source bodies");
    t.diagnostic(`DEEP_ACCEPTANCE_META ${JSON.stringify({ dreamingStorageMode, candidates: candidates.length, committedPromotions: promotionAfter - promotionBefore, reportEvidenceRows, sameDirectoryReportReadable: true, differentAndChildDirectoryReportHidden: true, sourceOriginHashRevokedAfterEdit: true, oldUntrackedDiaryHidden: true, unresolvedSkipped: phaseEvidence.filter(entry => entry.unresolved).length, freshDeepRanges: phaseEvidence.filter(entry => entry.phase === "deep" && !entry.unresolved).length })}`);
  } finally { await service?.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); }
});
