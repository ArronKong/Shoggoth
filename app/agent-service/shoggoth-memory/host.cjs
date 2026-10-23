"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const core = require("./core.cjs");
const { callHost, withMemoryHost } = require("./host-bridge.cjs");

core.configureMemoryCoreDreamingState(options => callHost("openKeyedStore", options));
const { assertNoBorrowedMemoryWrite } = require("./borrowed-memory-provenance.cjs");
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

class ShoggothMemoryHost {
  constructor({ database, paths, profileId, workspaceDir, roster, sessions, assertCurrent = () => {} }) {
    this.database = database;
    this.paths = paths;
    this.profileId = profileId;
    this.workspaceDir = path.resolve(workspaceDir);
    this.roster = roster;
    this.sessions = sessions;
    this.assertAuthority = assertCurrent;
    this.fileEvidence = new AsyncLocalStorage();
  }

  assertCurrent() {
    this.database.assertOpen();
    this.assertAuthority();
    if (!this.roster().some(profile => profile.id === this.profileId && path.resolve(profile.workspace) === this.workspaceDir)) {
      throw Object.assign(new Error("Memory Profile or workspace is no longer current"), { code: "MEMORY_SCOPE_REVOKED" });
    }
  }
  run(action) { return withMemoryHost(this, action); }
  runWithSourceEvidence(action) {
    return this.fileEvidence.run({ files: new Map(), sourceRanges: new Map(), actualReads: new Map(),
      deepSources: new Map(), pendingWrites: [], phaseEvidence: [], completedPhase: null, narrative: null }, () => this.run(action));
  }
  rememberUnavailableInput(relative, kind, reason) {
    const reads = this.fileEvidence.getStore()?.actualReads;
    if (!reads) return;
    const input = { ...(typeof relative === "string" ? { path: relative } : {}), kind,
      unresolved: true, unresolvedReason: reason };
    reads.set(JSON.stringify([relative, kind, reason]), input);
  }
  rememberActualRead(relative, text, kind = "memory") {
    const reads = this.fileEvidence.getStore()?.actualReads;
    if (!reads) return;
    if (typeof relative !== "string" || typeof text !== "string") {
      this.rememberUnavailableInput(relative, kind, "native_input_content_unavailable"); return;
    }
    const input = { path: relative, startLine: 1, endLine: text.split("\n").length, sourceHash: sha256(text), kind };
    reads.set(JSON.stringify([relative, input.sourceHash, kind]), input);
  }
  phaseEvidenceSnapshot() {
    return (this.fileEvidence.getStore()?.phaseEvidence || []).map(entry => structuredClone(entry));
  }
  async runWithDreamingCompletionSourceEvidence(request, action) {
    const scope = this.fileEvidence.getStore();
    if (!scope) return action();
    scope.narrative = null;
    // Native consolidation is JSON; its optional sharing proof must not enter
    // the legacy retained-marker guard or abort an owner-only model request.
    const consolidation = typeof request.message === "string" && /^\s*[\[{]/u.test(request.message);
    if (consolidation) this.capturePromotionSources(request.message);
    const inputEvidence = [...(scope.completedPhaseInputs || []), ...scope.actualReads.values()].map(value => ({ ...value }));
    const unavailableInput = inputEvidence.find(value => value.unresolved);
    // The pinned core omits sourceEntryKeys from narrative requests. The Deep
    // narrative is bounded by actual promoted source receipts; Light/REM and
    // any diary continuity input therefore remain unproved and unshareable.
    const narrative = consolidation ? null : {
      phase: scope.completedPhase || "unknown", sources: [...scope.deepSources.values()].map(value => ({ ...value })),
      unresolved: scope.completedPhase !== "deep" || !scope.deepSources.size || Boolean(unavailableInput) || /Diary continuity context:/u.test(request.message),
      unresolvedReason: unavailableInput?.unresolvedReason || (/Diary continuity context:/u.test(request.message) ? "diary_continuity_unproved" : "native_narrative_source_keys_unavailable"),
      inputEvidence,
    };
    const result = await action();
    if (narrative && typeof result?.text === "string" && result.text.trim()) {
      scope.narrative = { ...narrative, body: result.text.trim() };
    }
    return result;
  }
  async captureDreamingWrite(files, target, action, kind) {
    const scope = this.fileEvidence.getStore();
    if (!scope) return action();
    files.owned(target, false, true);
    const before = fs.existsSync(target) ? files.__evidenceRead(target).toString("utf8") : "";
    const result = await action();
    const text = files.__evidenceRead(target).toString("utf8"), lines = text.split("\n");
    const relative = path.relative(this.workspaceDir, target).replaceAll(path.sep, "/");
    // Later diary insertions can move a proved Deep block. Rebase only through
    // this admitted write's unchanged prefix/suffix; never locate proof by
    // matching arbitrary historic text elsewhere in the file.
    const oldLines = before.split("\n");
    let prefix = 0, suffix = 0;
    while (prefix < oldLines.length && prefix < lines.length && oldLines[prefix] === lines[prefix]) prefix++;
    while (suffix < oldLines.length - prefix && suffix < lines.length - prefix
      && oldLines[oldLines.length - suffix - 1] === lines[lines.length - suffix - 1]) suffix++;
    for (const entry of [...scope.phaseEvidence, ...scope.pendingWrites]) {
      if (entry.path !== relative) continue;
      if (entry.startLine > oldLines.length - suffix) {
        const delta = lines.length - oldLines.length; entry.startLine += delta; entry.endLine += delta;
      } else if (entry.endLine > prefix) {
        entry.unresolved = true; entry.unresolvedReason = "output_changed_after_generation";
      }
      if (sha256(lines.slice(entry.startLine - 1, entry.endLine).join("\n")) !== entry.rangeHash) {
        entry.unresolved = true; entry.unresolvedReason = "output_changed_after_generation";
      }
    }
    const reportPhase = /^memory\/dreaming\/(light|rem|deep)\/[^/]+\.md$/u.exec(relative)?.[1];
    const span = (phase, startLine, endLine) => ({ phase, path: relative, startLine, endLine,
      rangeHash: sha256(lines.slice(startLine - 1, endLine).join("\n")) });
    if (kind === "report" && reportPhase) scope.pendingWrites.push(span(reportPhase, 1, lines.length));
    if (kind === "dreams") {
      const start = lines.indexOf("<!-- openclaw:dreaming:deep:start -->"), end = lines.indexOf("<!-- openclaw:dreaming:deep:end -->");
      const previous = before.split("\n"), oldStart = previous.indexOf("<!-- openclaw:dreaming:deep:start -->"), oldEnd = previous.indexOf("<!-- openclaw:dreaming:deep:end -->");
      if (start >= 0 && end > start + 1 && (oldStart < 0 || oldEnd < oldStart
        || previous.slice(oldStart + 1, oldEnd).join("\n") !== lines.slice(start + 1, end).join("\n"))) {
        scope.pendingWrites.push(span("deep", start + 2, end));
      }
      const narrative = scope.narrative; scope.narrative = null;
      if (narrative) {
        const offset = text.indexOf(narrative.body), duplicate = offset >= 0 && text.indexOf(narrative.body, offset + 1) >= 0;
        // Bind the exact newly inserted model body, excluding old diary lines.
        if (offset >= 0 && !duplicate && !before.includes(narrative.body)
          && (offset === 0 || text[offset - 1] === "\n")
          && (offset + narrative.body.length === text.length || text[offset + narrative.body.length] === "\n")) {
          const startLine = text.slice(0, offset).split("\n").length;
          scope.phaseEvidence.push({ ...span(narrative.phase, startLine, startLine + narrative.body.split("\n").length - 1),
            kind: "narrative", sources: narrative.sources, unresolved: narrative.unresolved,
            ...(narrative.unresolved ? { unresolvedReason: narrative.unresolvedReason } : {}), inputEvidence: narrative.inputEvidence });
        }
      }
    }
    return result;
  }
  recordDreamingPhaseEvent(event) {
    const scope = this.fileEvidence.getStore();
    if (!scope || event?.type !== "memory.dream.completed" || !["light", "rem", "deep"].includes(event.phase)) return;
    const admitted = new Set([event.inlinePath, event.reportPath].filter(value => typeof value === "string")
      .map(value => path.relative(this.workspaceDir, value).replaceAll(path.sep, "/")));
    for (const output of scope.pendingWrites) {
      if (output.phase !== event.phase || !admitted.has(output.path)) continue;
      const sources = event.phase === "deep" ? [...scope.deepSources.values()].map(value => ({ ...value })) : [];
      const inputEvidence = [...scope.actualReads.values()].map(value => ({ ...value }));
      const unavailableInput = inputEvidence.find(value => value.unresolved);
      const unresolved = !sources.length || Boolean(unavailableInput);
      scope.phaseEvidence.push({ ...output, kind: "phase_report", sources, unresolved,
        ...(unresolved ? { unresolvedReason: unavailableInput?.unresolvedReason || "native_phase_input_keys_unavailable" } : {}), inputEvidence });
    }
    scope.pendingWrites = scope.pendingWrites.filter(output => output.phase !== event.phase);
    scope.completedPhase = event.phase;
    scope.completedPhaseInputs = [...scope.actualReads.values()].map(value => ({ ...value }));
    // No earlier phase input can authorize the next phase's generated output.
    scope.actualReads.clear();
  }
  sourceChanged(message) {
    const error = Object.assign(new Error(message), { code: "MEMORY_SOURCE_CHANGED" });
    const scope = this.fileEvidence.getStore();
    if (scope) scope.failure ||= error;
    return error;
  }
  rememberFileSource(relative, text) {
    const evidence = this.fileEvidence.getStore()?.files;
    if (!evidence) return;
    const hash = sha256(text), previous = evidence.get(relative);
    if (previous && previous !== hash) throw this.sourceChanged("Memory library changed during maintenance");
    evidence.set(relative, hash);
  }
  sourceEvidenceSnapshot() {
    return [...(this.fileEvidence.getStore()?.sourceRanges?.values() || [])].map(value => ({ ...value }));
  }
  rememberSourceRange(source, { required = false } = {}) {
    const ranges = this.fileEvidence.getStore()?.sourceRanges;
    if (!ranges) return null;
    const unavailable = reason => {
      if (required) this.rememberUnavailableInput(source?.path, "source_range", reason);
    };
    if (!source || typeof source.path !== "string" || !Number.isSafeInteger(source.startLine)
      || !Number.isSafeInteger(source.endLine) || source.startLine < 1 || source.endLine < source.startLine
      || source.endLine - source.startLine > 1000) {
      unavailable("native_source_range_invalid"); return null;
    }
    let current;
    try { current = this.searchIndex?.sourceFiles?.read(source.path); } catch { /* Optional sharing proof only. */ }
    if (typeof current?.text !== "string") {
      unavailable("native_source_content_unavailable"); return null;
    }
    const lines = current.text.split("\n");
    if (source.endLine > lines.length) {
      unavailable("native_source_range_invalid"); return null;
    }
    const sourceHash = sha256(lines.slice(source.startLine - 1, source.endLine).join("\n"));
    if (source.sourceHash !== undefined && source.sourceHash !== sourceHash) {
      unavailable("native_source_range_changed"); return null;
    }
    const range = { path: source.path, startLine: source.startLine, endLine: source.endLine, sourceHash };
    ranges.set(JSON.stringify([range.path, range.startLine, range.endLine, sourceHash]), range);
    return range;
  }
  capturePromotionSources(text) {
    const scope = this.fileEvidence.getStore();
    if (!scope) return;
    let request;
    try { request = JSON.parse(text); } catch { /* Invalid candidate requests get no sharing proof. */ }
    if (!request || !Array.isArray(request.candidates) || !request.candidates.length) {
      this.rememberUnavailableInput(undefined, "consolidation_candidates", "native_candidate_request_invalid"); return;
    }
    const workspaceKey = core.memoryCoreWorkspaceStateKey(this.workspaceDir);
    for (const candidate of request.candidates) {
      if (typeof candidate?.key !== "string" || !candidate.key || candidate.key.length > 1024) {
        this.rememberUnavailableInput(undefined, "consolidation_candidates", "native_candidate_key_invalid"); continue;
      }
      const stateKey = `${workspaceKey}:${sha256(candidate.key)}`;
      let source;
      try {
        const retained = this.database.db.prepare("SELECT path,start_line AS startLine,end_line AS endLine,source_hash AS sourceHash FROM memory_promotion_sources WHERE state_key=?").get(stateKey);
        const row = !retained && this.database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=? AND value IS NOT NULL")
          .get(core.SHORT_TERM_RECALL_NAMESPACE, stateKey);
        const entry = row && JSON.parse(row.value);
        source = retained || (entry?.workspaceKey === workspaceKey && entry.value?.key === candidate.key ? entry.value : null);
      } catch { /* Missing/corrupt receipts cannot authorize generated output. */ }
      const captured = source && this.rememberSourceRange(source, { required: true });
      if (captured) scope.deepSources.set(JSON.stringify(captured), captured);
      else this.rememberUnavailableInput(source?.path, "consolidation_candidates", "native_candidate_source_unproved");
    }
  }
  rememberPromotionSources(text) {
    if (!this.fileEvidence.getStore()) return;
    // Preserve the original retained-marker guard. Consolidation JSON is only
    // observed by capturePromotionSources and never changes this guard's timing.
    for (const key of core.extractPromotionKeys(text)) {
      const stateKey = `${core.memoryCoreWorkspaceStateKey(this.workspaceDir)}:${sha256(key)}`;
      const retained = this.database.db.prepare("SELECT path,start_line AS startLine,end_line AS endLine,source_hash AS sourceHash FROM memory_promotion_sources WHERE state_key=?").get(stateKey);
      const row = !retained && this.database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=? AND value IS NOT NULL")
        .get(core.SHORT_TERM_RECALL_NAMESPACE, stateKey);
      const source = retained || (row && JSON.parse(row.value).value);
      if (source && this.searchIndex.sourceFiles.isManaged(source.path)) {
        const captured = this.rememberSourceRange(source, { required: true });
        if (captured) this.fileEvidence.getStore().deepSources.set(JSON.stringify(captured), captured);
        continue;
      }
      let file;
      try { if (retained) file = this.searchIndex.sourceFiles.read(source.path); } catch { /* fail closed below */ }
      if (!file || !Number.isSafeInteger(source.startLine) || source.startLine < 1
        || !Number.isSafeInteger(source.endLine) || source.endLine < source.startLine || source.endLine - source.startLine > 1000
        || sha256(file.text.split("\n").slice(source.startLine - 1, source.endLine).join("\n")) !== source.sourceHash) {
        throw this.sourceChanged("A promoted memory library source is no longer current");
      }
      this.rememberFileSource(source.path, file.text);
      const captured = this.rememberSourceRange(source, { required: true });
      if (captured) this.fileEvidence.getStore().deepSources.set(JSON.stringify(captured), captured);
    }
  }
  assertFileSources() {
    this.assertCurrent();
    const scope = this.fileEvidence.getStore();
    if (scope?.failure) throw scope.failure;
    for (const [relative, hash] of scope?.files || []) {
      let source;
      try { source = this.searchIndex.sourceFiles.read(relative); }
      catch { throw this.sourceChanged("Memory library is no longer available"); }
      if (sha256(source.text) !== hash) throw this.sourceChanged("Memory library changed during maintenance");
    }
  }
  assertWorkspace(workspace) {
    this.assertCurrent();
    if (path.resolve(workspace) !== this.workspaceDir) throw new Error("Memory workspace is outside the current scope");
    // A replaced directory or symlink cannot redirect memory operations.
    if (fs.realpathSync.native(this.workspaceDir) !== this.workspaceDir) throw new Error("Memory workspace must be canonical");
  }
  assertAgent(agentId) {
    this.assertCurrent();
    if (!this.roster().some(profile => profile.id === agentId && path.resolve(profile.workspace) === this.workspaceDir)) {
      throw new Error("Memory agent is outside the current workspace");
    }
  }

  resolveStateDir() { return this.paths.stateDir; }
  listAgentIds() { return this.roster().filter(profile => path.resolve(profile.workspace) === this.workspaceDir).map(profile => profile.id); }
  resolveDefaultAgentId() { return this.profileId; }
  resolveAgentWorkspaceDir(_cfg, id) {
    const found = this.roster().find(profile => profile.id === id);
    if (!found) throw new Error("Memory Profile does not exist");
    return found.workspace;
  }
  resolveAgentConfig(cfg, id) {
    this.assertAgent(id);
    return cfg?.agents?.entries?.[id] ?? cfg?.agents?.list?.find(profile => profile.id === id)
      ?? this.roster().find(profile => profile.id === id)?.config ?? {};
  }
  assertSecretOwnerAvailable(kind, owner) {
    this.assertCurrent();
    if (kind !== "capability" || owner !== `memory-provider:${this.profileId}`) throw new Error("Foreign memory credential owner");
    // The index-only resolver consumes no credentials. A configured provider
    // must independently resolve its capabilities at the embedding boundary.
  }
  getMemoryEmbeddingProvider(id, cfg) {
    this.assertCurrent();
    return this.searchIndex?.embeddingAdapter(id, cfg);
  }
  listRegisteredMemoryEmbeddingProviderAdapters() {
    this.assertCurrent();
    return this.searchIndex?.registeredEmbeddingAdapters() || [];
  }
  resolveAgentDir(_cfg, id) { this.assertAgent(id); return this.paths.agentsDir ? path.join(this.paths.agentsDir, id) : path.dirname(this.database.path); }
  async readMemoryFile(params) {
    this.assertWorkspace(params.workspaceDir);
    try {
      const source = this.searchIndex.readSource(params.relPath);
      this.rememberActualRead(params.relPath, source.text, source.kind);
      return core.buildMemoryReadResult({ ...params, content: source.text, suggestReadFallback: source.kind === "memory" });
    } catch (error) {
      if (error.code === "ENOENT") return { status: "not_found", text: "", path: params.relPath };
      throw error;
    }
  }
  resolveRuntimeWorkerArgv() { throw new Error("Memory host has no sqlite-vec subprocess capability"); }
  getAgentWorkspaceAccess(workspace) {
    this.assertWorkspace(workspace);
    // Load after the host exports its pinned core; file operations delegate back
    // to native upstream helpers without their workspace argument.
    if (!this.workspaceFiles) {
      const files = new (require("./workspace-files.cjs").MemoryWorkspaceFiles)(this);
      const read = files.read.bind(files); files.__evidenceRead = read;
      files.read = target => {
        const value = read(target);
        if (this.fileEvidence.getStore()) {
          const relative = path.relative(this.workspaceDir, target).replaceAll(path.sep, "/");
          if (this.searchIndex?.sourceFiles) this.rememberActualRead(this.searchIndex.sourceFiles.relative(target), value.toString("utf8"));
          else this.rememberUnavailableInput(relative, "memory", "native_source_index_unavailable");
        }
        return value;
      };
      const readDreams = files.maintenance.readDreams;
      files.maintenance.readDreams = async target => {
        const value = await readDreams(target);
        this.rememberActualRead(path.relative(this.workspaceDir, target).replaceAll(path.sep, "/"), value, "diary");
        return value;
      };
      for (const [name, kind] of [["replaceReport", "report"], ["writeDreams", "dreams"]]) {
        const write = files.maintenance[name];
        files.maintenance[name] = (target, content) => this.captureDreamingWrite(files, target, () => write(target, content), kind);
      }
      this.workspaceFiles = files;
    }
    return { memoryFiles: this.workspaceFiles };
  }
  async pruneUnavailableLibraryCandidates() {
    return this.run(() => core.withMemoryWorkspaceLock(this.workspaceDir, async () => {
      const workspaceKey = core.memoryCoreWorkspaceStateKey(this.workspaceDir);
      const store = this.openKeyedStore({ namespace: core.SHORT_TERM_RECALL_NAMESPACE, maxEntries: 50_000 });
      for (const entry of await store.entries()) {
        if (entry.value.workspaceKey !== workspaceKey) continue;
        const candidate = entry.value.value;
        if (!candidate || this.searchIndex?.sourceFiles.isManaged(candidate.path)) continue;
        let valid = false;
        try {
          if (this.searchIndex?.sourceFiles.isExtra(candidate.path)) {
            const files = this.getAgentWorkspaceAccess(this.workspaceDir).memoryFiles;
            valid = Boolean(await files.rehydrateExact(candidate));
          }
        } catch (error) {
          this.assertCurrent();
          if (error.code === "MEMORY_SOURCE_CHANGED") throw error;
        }
        // The native resolver also tries memory/<basename>. Removing only the
        // file access would let a revoked library borrow a canonical namesake.
        if (!valid) await store.delete(entry.key);
      }
    }));
  }
  openKeyedStore(options) {
    const store = this.database.openKeyedStore(options, () => this.assertCurrent(),
      options.namespace === core.SHORT_TERM_RECALL_NAMESPACE ? (key, value) => {
        const source = value?.value;
        assertNoBorrowedMemoryWrite(source);
        if (!source?.promotedAt) return;
        this.rememberSourceRange(source);
        this.assertFileSources();
        if (this.database.db.prepare("SELECT 1 FROM memory_promotion_sources WHERE state_key=?").get(key)) return;
        // Upstream may evict a promoted candidate from its bounded short-term
        // store. Keep only the source range/hash needed for Product revocation
        // checks; it must not evict the durable MEMORY.md entry with it.
        const relative = source.path, absolute = typeof relative === "string" ? path.resolve(this.workspaceDir, relative) : "";
        const external = this.searchIndex?.sourceFiles.isExtra(relative);
        if ((!external && !absolute.startsWith(this.workspaceDir + path.sep)) || typeof relative !== "string"
          || relative.includes("\\") || relative.includes("\0") || path.posix.normalize(relative) !== relative
          || !Number.isSafeInteger(source.startLine) || source.startLine < 1
          || !Number.isSafeInteger(source.endLine) || source.endLine < source.startLine || source.endLine - source.startLine > 1000) {
          throw new Error("Invalid promoted memory source");
        }
        const content = external ? this.searchIndex.sourceFiles.read(relative).text
          : this.getAgentWorkspaceAccess(this.workspaceDir).memoryFiles.read(absolute).toString("utf8");
        if (external) this.rememberFileSource(relative, content);
        const fragment = content.split("\n").slice(source.startLine - 1, source.endLine).join("\n");
        this.database.db.prepare("INSERT OR IGNORE INTO memory_promotion_sources VALUES (?,?,?,?,?)")
          .run(key, relative, source.startLine, source.endLine, sha256(fragment));
      } : null);
    if (options.namespace === core.SHORT_TERM_RECALL_NAMESPACE) {
      const remember = values => {
        const scope = this.fileEvidence.getStore();
        if (!scope) return;
        for (const value of values) {
          const record = value?.value;
          if (value?.workspaceKey !== core.memoryCoreWorkspaceStateKey(this.workspaceDir) || !record) continue;
          const captured = this.rememberSourceRange(record);
          if (captured) scope.actualReads.set(JSON.stringify(["short_term_candidate", captured]), { ...captured, kind: "short_term_candidate" });
        }
      };
      for (const name of ["entries", "entriesInKeyRange"]) {
        const read = store[name]; store[name] = async (...args) => {
          const rows = await read(...args); remember(rows.map(row => row.value)); return rows;
        };
      }
      for (const name of ["lookup", "observe"]) {
        const read = store[name]; store[name] = async (...args) => {
          const value = await read(...args); remember([name === "observe" ? value.value : value]); return value;
        };
      }
    }
    return store;
  }

  async listSessionTranscriptCorpusEntriesForAgent(agentId) {
    this.assertAgent(agentId);
    const entries = await this.sessions.list(agentId);
    this.assertAgent(agentId);
    return entries.map(entry => ({
      agentId, sessionId: entry.id, sessionKey: entry.sessionKey,
      sessionFile: path.join(this.workspaceDir, ".session-source", entry.id),
      transcriptSource: "sqlite", sessionKind: entry.interactive ? "interactive" : "automation",
      storePath: this.database.path,
      artifactKind: entry.deleted ? "retained-session" : "active-session", updatedAtMs: entry.updatedAt,
      ...(entry.generatedByCronRun ? { generatedByCronRun: true } : {}),
      ...(entry.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    }));
  }
  assertSessionSource(absolutePath, options) {
    if (options.agentId !== this.profileId) throw Object.assign(new Error("Foreign Product transcript owner"), { code: "MEMORY_SCOPE_REVOKED" });
    this.assertAgent(options.agentId);
    const relative = this.searchIndex.sessionPath(options.sessionId);
    if (options.storePath !== this.database.path
      || absolutePath !== path.join(this.workspaceDir, ".session-source", options.sessionId)) {
      throw Object.assign(new Error("Foreign Product transcript source"), { code: "MEMORY_SCOPE_REVOKED" });
    }
    return relative;
  }
  sessionPathForSessionIdentity(agentId, sessionId) {
    this.assertAgent(agentId);
    if (agentId !== this.profileId) throw Object.assign(new Error("Foreign Product transcript owner"), { code: "MEMORY_SCOPE_REVOKED" });
    return this.searchIndex.sessionPath(sessionId);
  }
  buildSessionEntry(absolutePath, options) {
    const relative = this.assertSessionSource(absolutePath, options);
    const value = this.sessions.read(options.agentId, options.sessionId);
    this.rememberActualRead(relative, value?.content, "sessions");
    return { ...value, absPath: absolutePath, path: relative, sessionId: options.sessionId };
  }
  statSessionEntrySync(absolutePath, options) {
    const relative = this.assertSessionSource(absolutePath, options);
    return { ...this.sessions.stat(options.agentId, options.sessionId), absPath: absolutePath, path: relative, sessionId: options.sessionId };
  }
  async readMemoryTranscriptStatsInWorker(targets) {
    this.assertCurrent();
    const stats = targets.map(target => {
      this.assertSessionSource(path.join(this.workspaceDir, ".session-source", target.sessionId), target);
      if (this.sessions.transcriptStats) return this.sessions.transcriptStats(target.agentId, target.sessionId);
      const value = this.sessions.stat(target.agentId, target.sessionId);
      return { eventCount: value.lineMap?.length || 0, sizeBytes: value.size,
        ...(value.revisionMs === undefined ? {} : { maxSeq: value.revisionMs }) };
    });
    this.assertCurrent();
    return stats;
  }
  onInternalSessionTranscriptUpdate(listener) {
    this.assertCurrent();
    return this.sessions.subscribeChanges?.(update => core.runInMemoryBackgroundContext(() => this.run(() => listener(update))),
      { profileId: this.profileId, signal: this.searchIndex.lifetime.signal }) || (() => {});
  }
  loadMemorySessionMetadata(options) {
    this.assertAgent(options.agentId);
    return this.sessions.metadata(options.agentId, options.sessionId);
  }
  matchesSessionEntryPrefixHash(entry, lineCount, hash) {
    return sha256(entry.content.split("\n").slice(0, lineCount).join("\n")) === hash;
  }
  sessionPathForFile(file) {
    const base = path.join(this.workspaceDir, ".session-source") + path.sep;
    if (!file.startsWith(base) || path.dirname(file) + path.sep !== base) throw new Error("Foreign memory transcript is not admitted");
    return `sessions/${path.basename(file)}`;
  }

  async listMemoryArtifactProvenance({ workspaceDir }) {
    this.assertWorkspace(workspaceDir);
    const entries = await this.openKeyedStore({ namespace: "artifact-provenance", maxEntries: 50_000 }).entries();
    return entries.filter(entry => entry.value.workspaceDir === this.workspaceDir)
      .map(entry => ({ relativePath: entry.value.relativePath, provenance: entry.value.provenance }));
  }
  async readMemoryArtifactProvenance({ workspaceDir, relativePath }) {
    const entries = await this.listMemoryArtifactProvenance({ workspaceDir });
    return entries.find(entry => entry.relativePath === relativePath)?.provenance;
  }
  async appendMemoryHostEvent(workspace, event) {
    this.assertWorkspace(workspace);
    this.recordDreamingPhaseEvent(event);
    this.database.transact(() => {
      this.database.db.prepare("INSERT INTO memory_host_events(workspace,time,data) VALUES (?,?,?)")
        .run(this.workspaceDir, this.database.now(), JSON.stringify(event));
      this.database.db.prepare("DELETE FROM memory_host_events WHERE sequence < (SELECT max(sequence)-10000 FROM memory_host_events)").run();
    }, () => this.assertCurrent());
  }

  resolveOpenClawAgentSqlitePath({ agentId }) { this.assertAgent(agentId); return this.database.path; }
  resolveRuntimeWorkerUrl(value) {
    if (value !== "shoggoth-memory-entry-origins") throw new Error("Unrecognized memory database operation");
    return value;
  }
  async runOpenClawAgentWriteAdmission(options, run) {
    this.assertAgent(options.agentId);
    const check = () => this.assertAgent(options.agentId);
    const result = await run(this.database.identity, check);
    check();
    return result;
  }
  async withOpenClawAgentDatabaseRuntime(options, run, assertOriginal) {
    this.assertAgent(options.agentId); assertOriginal?.();
    const result = await run({ db: this.database.db });
    this.assertAgent(options.agentId); assertOriginal?.();
    return result;
  }
  async openOpenClawAgentSqliteWorkerStore(options, db, binding) {
    this.assertAgent(options.agentId);
    if (db !== this.database.db || !["origin", "forget"].includes(binding.input?.kind)) throw new Error("Invalid memory database binding");
    let closed = false;
    return {
      run: async (run, assertOriginal = () => {}) => {
        const check = () => { if (closed) throw new Error("Memory database binding closed"); this.assertAgent(options.agentId); assertOriginal(); };
        check();
        const result = await run({ execute: command => {
          check();
          if (command.input?.agentId !== options.agentId) throw new Error("Memory database agent mismatch");
          if (command.type === "forget.mark" || command.type === "forget.purge") {
            return this.database.transact(() => command.type === "forget.mark"
              ? core.markMemoryForgotten(db, command.input) : core.purgeForgottenMemory(db, command.input), check);
          }
          return this.database.originCommand(command, check);
        } });
        check(); return result;
      },
      close: async () => { closed = true; },
    };
  }
  runMemoryOriginRows(target, filters) { this.assertAgent(target.agentId); return this.database.origins(target.agentId, filters); }
  runMemoryOriginExists(target, filters) { return this.runMemoryOriginRows(target, filters).length > 0; }
  runMemoryTombstoneRows(target, sessionIds) { this.assertAgent(target.agentId); return this.database.tombstones(target.agentId, sessionIds); }
  resolveStorePath(_store, { agentId }) { this.assertAgent(agentId); return this.database.path; }
  async resolveMemorySessionTargetsAsync({ agentId, sessionIds, hookSources, participants }) {
    this.assertAgent(agentId);
    if (hookSources?.length || participants?.length) throw new Error("Shoggoth memory session selectors require Product session IDs");
    const entries = await this.sessions.list(agentId);
    // A tombstoned/deleted session remains selectable on retry, so an interrupted
    // purge resumes even after the source is no longer model-visible.
    return [...new Set(sessionIds || [])].map(sessionId => {
      const entry = entries.find(item => item.id === sessionId);
      if (!entry && !this.database.tombstones(agentId, [sessionId]).length) throw new Error("Unknown memory session");
      return { sessionId, ...(entry ? { sessionKey: entry.sessionKey } : {}), resolution: "explicit" };
    });
  }
  isDreamingNarrativeSessionStoreKey(key) {
    // Product UUID session keys cannot be OpenClaw-generated narrative keys.
    return /^(?:agent:[^:]+:)?dreaming-narrative-/u.test(key.trim());
  }
  borrowOpenClawAgentDatabase(options) {
    this.assertAgent(options.agentId);
    if (options.path !== this.database.path) throw new Error("Foreign memory database");
    return { db: this.database.db, release: () => {} };
  }
  async withOpenClawAgentDatabaseWrite(options, action) {
    this.borrowOpenClawAgentDatabase(options);
    const result = await action(); this.assertAgent(options.agentId); return result;
  }
  withFreshOpenClawAgentDatabaseReadOnly(action, options) {
    const { db } = this.borrowOpenClawAgentDatabase(options);
    return { found: true, value: action({ db }) };
  }
  readMemoryEntryOriginsInDatabase(db, input) {
    if (db !== this.database.db) throw new Error("Foreign memory origin database");
    return this.runMemoryOriginRows({ agentId: input.agentId }, input);
  }
  runMemoryForgetIndexPlan(request) { this.assertIndexTarget(request); return core.readMemoryForgetIndexInWorker(request); }
  openMemoryIndexShadow(filename, allowExtension) {
    if (!this.searchIndex?.rebuildOwner) throw new Error("Memory rebuild owner unavailable");
    return this.searchIndex.rebuildOwner.openShadow(filename, allowExtension);
  }
  openNodeSqliteDatabase(filename, options) { return require("./index-coordination.cjs").openMemoryCoordinationDatabase(this, filename, options); }
  loadSqliteVecExtension() { throw new Error("Memory host uses upstream bounded vector scanning"); }
  assertIndexTarget(target) {
    this.assertAgent(target.agentId);
    if (!this.searchIndex || target.databasePath !== this.searchIndex.databasePath) throw new Error("Memory index scope mismatch");
  }
  runMemoryKeywordSearch(target, query, signal, includeIndexState) { this.assertIndexTarget(target); return this.searchIndex.keywordWorker(query, signal, includeIndexState); }
  runMemoryIndexState(target, signal) {
    this.assertIndexTarget(target); signal?.throwIfAborted();
    return core.readMemoryRetrievalIndexState(this.searchIndex.db);
  }
  async runMemoryVectorFallback(target, query, signal) {
    this.assertIndexTarget(target); signal?.throwIfAborted();
    const candidates = await core.searchChunksByEmbedding({ db: this.searchIndex.db, ...query,
      sourceFilter: this.searchIndex.constrainSourceFilter?.(query.sourceFilter, undefined, "chunk") ?? query.sourceFilter, signal });
    return this.searchIndex.admitCandidates(candidates);
  }
  runMemoryRecallMetadata(target, query, signal) { this.assertIndexTarget(target); signal?.throwIfAborted(); return this.searchIndex.recallMetadata(query); }
  runMemoryCuratedCandidates(target, query) {
    this.assertIndexTarget(target);
    const read = query.projectsOnly ? core.readCuratedProjectMemoryCandidates : core.readCuratedMemoryTriggerCandidates;
    const rows = this.searchIndex.readCuratedCandidates(read, 512, query.activeProjectKeys);
    const admitted = new Set(this.searchIndex.admitCandidates(rows.map(row => ({ ...row,
      source: "memory", startLine: row.start_line, endLine: row.end_line, snippet: row.text,
    }))).map(result => result.id));
    return { rows: rows.filter(row => admitted.has(row.id)).slice(0, query.limit), provenanceRepairPending: false };
  }
  log(level, subsystem, message) { this.assertCurrent(); this.searchIndex?.logger?.[level]?.(`[${subsystem}] ${message}`); }
}

module.exports = { ShoggothMemoryHost, core };
