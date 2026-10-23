"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const c = require("./chat-ui-contract");
const { createChatUiDiagnostics, diagnosticMetadata } = require("./chat-ui-diagnostics");
const { normalizeBorrowedMemoryRefs } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
// The existing Chat Inbox accepts these states. A Runtime handoff leaves the
// same canonical conversation in draft until its new native session is bound.
const sendableSession = session => ["draft", "binding", "ready"].includes(session?.status);

// The Service owns this controller. Models only supply a declaration; owner,
// attempt and dependency provenance come from the current native Run lease.
class ChatUiController {
  constructor({ store, productStore, chatSessionStore, transcriptStore, coordinator, memoryEngine,
    getConfig, getOrigins, verifyClick = async () => false, assertPublishAllowed = async () => {}, now = Date.now, diagnosticSink }) {
    Object.assign(this, { store, productStore, chatSessionStore, transcriptStore, coordinator,
      memoryEngine, getConfig, getOrigins, verifyClick, assertPublishAllowed, now });
    this.diagnostics = createChatUiDiagnostics({ sink: diagnosticSink });
    this.lifecycleSubscriptions = []; this.pendingLifecycle = new Set(); this.sourceTimer = null;
    this.leases = new Map(); this.listeners = new Set(); this.publicationTails = new Map(); this.deliveries = new Map();
  }
  enabled() { return !this.storageError && this.store.opened && this.getConfig()?.config?.nativeChatUiV1 === true; }
  _enabled() { if (this.storageError) throw this.storageError; if (!this.enabled()) throw c.uiError("UI_FEATURE_DISABLED"); }
  _owner(profileId, sessionKey) {
    c.id(profileId); c.id(sessionKey);
    const session = this.chatSessionStore.getSession(sessionKey);
    if (!session || session.profileId !== profileId) throw c.uiError("UI_SCOPE_MISMATCH");
    return { profileId, sessionKey, transcriptSessionId: session.id };
  }
  _context(profileId, scope) {
    this._enabled(); scope?.assertCurrent?.();
    const context = this.coordinator.getNativeUiPublicationContext(profileId, scope);
    const origins = this.getOrigins(context.run, context.session);
    c.assertDirectChatEligibility({ profileId, scope, ...context, origins,
      hasUser: this.transcriptStore.hasUserEventForRun(profileId, context.session.id, context.run.id) });
    this._dependencies(context.owner, context.provenance); return context;
  }
  _dependencies(owner, provenance) {
    const refs = normalizeBorrowedMemoryRefs(provenance.borrowedMemoryRefs || []);
    if ((provenance.borrowedMemoryDerived && !refs.length) || (refs.length
      && this.memoryEngine?.borrowedMemoryDependenciesCurrent?.(owner.profileId, owner.transcriptSessionId, refs) !== true)) {
      throw c.uiError("UI_SOURCE_EXPIRED");
    }
  }
  _current(owner, rev, { execution = false } = {}) {
    if (rev.status !== "ready") throw c.uiError("UI_SOURCE_EXPIRED");
    const event = this.transcriptStore.getEvent(owner.profileId, owner.transcriptSessionId, rev.sourceEventId);
    if (rev.legacy) {
      if (!event || c.hash(this._legacySourceText(owner, event)) !== rev.legacy.sourceTextHash) throw c.uiError("UI_SOURCE_EXPIRED");
    } else {
      const part = event?.content?.uiArtifact;
      if (!event || event.contextExcluded || event.kind !== "artifact" || event.runId !== rev.creatorRunId
        || c.canonical(part) !== c.canonical(this.store.part(rev))) throw c.uiError("UI_SOURCE_EXPIRED");
    }
    try { this._dependencies(owner, rev.provenance); }
    catch (error) { this.store.revokeRevision(owner, rev.artifactId, rev.revision); this.revoke(owner, rev.artifactId, rev.revision); throw error; }
    if (execution) {
      this._enabled(); const session = this.chatSessionStore.getSession(owner.sessionKey);
      if (rev.currentEpoch !== rev.conversationEpoch || !sendableSession(session)
        || this.productStore.getAgentProfile(owner.profileId)?.enabled !== true
        || Object.values(this.getOrigins(null, session)).some(origin => origin !== null)) throw c.uiError("UI_SOURCE_EXPIRED");
    }
    return rev;
  }
  _legacySourceText(owner, event) {
    if (!event || event.kind !== "assistant" || event.contextExcluded || event.sessionId !== owner.transcriptSessionId)
      throw c.uiError("UI_SOURCE_EXPIRED");
    const source = this.transcriptStore.contextEvent(owner.profileId, owner.transcriptSessionId, event);
    if (source.content?.contextComplete === false) throw c.uiError("UI_SOURCE_EXPIRED");
    const imported = source.content?.historyItem;
    if (imported) {
      const message = imported.payload?.message;
      if (source.content.importedFrom !== "codex" || imported.fragment !== null || imported.role !== "assistant"
        || imported.type !== "text" || message?.role !== "assistant" || message.isError || message.notice)
        throw c.uiError("UI_SOURCE_EXPIRED");
      return (message.content || []).filter(part => part?.type === "text").map(part => part.text).join("\n");
    }
    if (source.content?.transcriptType !== "text" || typeof source.content.text !== "string") throw c.uiError("UI_SOURCE_EXPIRED");
    return source.content.text;
  }
  importLegacy(params) {
    this._enabled(); const owner = this._owner(params.profileId, params.sessionKey), session = this.chatSessionStore.getSession(params.sessionKey);
    if (!["ready", "archived"].includes(session.status) || !this.productStore.getAgentProfile(owner.profileId)
      || Object.values(this.getOrigins(null, session)).some(origin => origin !== null)) throw c.uiError("UI_DIRECT_CHAT_REQUIRED");
    const event = this.transcriptStore.getEvent(owner.profileId, owner.transcriptSessionId, params.sourceEventId);
    const text = this._legacySourceText(owner, event);
    const block = require("../manage-ui/src/lib/chatUiLegacy.mjs").legacyHtmlBlocks(text)[params.blockIndex];
    if (!block?.runnable) throw c.uiError("UI_SOURCE_EXPIRED");
    const source = this.transcriptStore.contextEvent(owner.profileId, owner.transcriptSessionId, event);
    const provenance = c.normalizeProvenance({ borrowedMemoryRefs: source.content?.borrowedMemoryRefs || [],
      ...(source.content?.borrowedMemoryDerived ? { borrowedMemoryDerived: true } : {}) });
    this._dependencies(owner, provenance);
    const callId = `legacy-ui-${c.hash([params.sourceEventId, params.blockIndex, c.hash(block.html)]).slice(0, 48)}`;
    const fingerprint = c.hash({ owner, callId, sourceTextHash: c.hash(text) });
    const declaration = { sourceFile: "legacy-transcript.html", title: "历史交互界面", summary: "原消息的 HTML 快照，可在本地预览",
      stateSchemaVersion: 1, stateSchema: { type: "object", properties: {}, additionalProperties: false }, initialState: {}, actions: [] };
    const pub = this.store.preparePublication({ owner, callId, fingerprint, tool: "render_ui", declaration, html: block.html,
      creatorRunId: event.runId || `legacy-run-${c.hash(event.id).slice(0, 48)}`, creatorAttemptId: "legacy-import",
      provenance, legacy: { sourceEventId: event.id, blockIndex: params.blockIndex, sourceTextHash: c.hash(text) } });
    return this._publish(pub, owner, false);
  }
  _sourceFile(workspace, sourceFile, assertCurrent) {
    if (typeof workspace !== "string" || !path.isAbsolute(workspace) || sourceFile.includes("\\")
      || sourceFile.includes("\0")) throw c.uiError("UI_REQUEST_INVALID");
    const root = fs.realpathSync(workspace), target = path.resolve(root, sourceFile), relative = path.relative(root, target);
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)
      || sourceFile.split("/").some(segment => [".", ".."].includes(segment))) throw c.uiError("UI_REQUEST_INVALID");
    const rootStat = fs.lstatSync(root);
    const directoryPins = [{ target: root, dev: rootStat.dev, ino: rootStat.ino }];
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      const parent = directoryPins.at(-1)?.target || root, dir = path.join(parent, segment), stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw c.uiError("UI_REQUEST_INVALID");
      directoryPins.push({ target: dir, dev: stat.dev, ino: stat.ino });
    }
    const before = fs.lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > c.LIMITS.html
      || (process.getuid && before.uid !== process.getuid())) throw c.uiError("UI_REQUEST_INVALID");
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw c.uiError("UI_REQUEST_INVALID");
      const buffer = Buffer.alloc(opened.size + 1); let length = 0, read;
      while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += read;
      const after = fs.fstatSync(fd), current = fs.lstatSync(target);
      if (length !== opened.size || ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].some(key => opened[key] !== after[key])
        || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
        || directoryPins.some(pin => { const stat = fs.lstatSync(pin.target); return stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino; })) throw c.uiError("UI_REQUEST_INVALID");
      if (fs.realpathSync(workspace) !== root) throw c.uiError("UI_REQUEST_INVALID");
      assertCurrent(); return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } catch (cause) { throw cause.code?.startsWith("UI_") ? cause : c.uiError("UI_REQUEST_INVALID", { cause }); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  bind(name, args, authority, scope, fingerprint) {
    return this.diagnostics.measure("publication.prepare", result => diagnosticMetadata({ ...authority, ...args }, result),
      () => this._preparePublication(name, args, authority, scope, fingerprint));
  }
  async _preparePublication(name, args, authority, scope, fingerprint) {
    const context = this._context(authority.profileId, scope);
    const existing = this.store.lookupPublication(authority.profileId, authority.callId, fingerprint);
    if (existing) {
      if (existing.creatorRunId !== context.run.id) throw c.uiError("UI_SCOPE_MISMATCH");
      return this._binding(existing, authority.profileId);
    }
    const declaration = c.normalizePublication(name, args, this.store.secretMatcher);
    if (name === "update_ui") this._current(context.owner,
      this.store.revision(context.owner, declaration.artifactId, declaration.expectedRevision), { execution: true });
    await this.assertPublishAllowed(context.session.sessionKey); scope.assertCurrent();
    // Recheck after Desktop/native owner observation, before freezing input.
    const current = this._context(authority.profileId, scope);
    const html = this._sourceFile(current.run.workspace, declaration.sourceFile, scope.assertCurrent);
    const pub = this.store.preparePublication({ owner: current.owner, callId: authority.callId, fingerprint,
      tool: name, declaration, html, creatorRunId: current.run.id, creatorAttemptId: current.identity.attemptId,
      provenance: current.provenance });
    return this._binding(pub, authority.profileId);
  }
  _binding(pub, profileId) { return { profileId, transcriptSessionId: pub.transcriptSessionId,
    publicationId: pub.publicationId, callId: pub.callId, fingerprint: pub.fingerprint }; }
  _publish(pub, owner, notify) {
    return this.diagnostics.measure("publication.publish", result => ({ ...diagnosticMetadata(owner, result),
      publicationId: pub.publicationId, runId: pub.creatorRunId, htmlBytes: pub.htmlBytes }), () => this._commitPublication(pub, owner, notify));
  }
  _commitPublication(pub, owner, notify) {
    if (!["preparing", "ready"].includes(pub.status)) throw c.uiError("UI_SOURCE_EXPIRED");
    this._dependencies(owner, pub.provenance);
    const part = this.store.part(pub);
    if (pub.legacy) {
      const event = this.transcriptStore.getEvent(owner.profileId, owner.transcriptSessionId, pub.sourceEventId);
      if (!event || c.hash(this._legacySourceText(owner, event)) !== pub.legacy.sourceTextHash) throw c.uiError("UI_SOURCE_EXPIRED");
      const rev = this.store.markPublicationReady(owner, pub.publicationId, event.seq);
      this._current(owner, rev); return { publicationId: pub.publicationId, status: "ready", part };
    }
    if (pub.status === "ready") {
      const rev = this.store.revision(owner, pub.artifactId, pub.revision, pub.sourceEventId);
      this._current(owner, rev);
      if (notify) this.coordinator.publishNativeUiArtifact(owner, rev,
        this.transcriptStore.getEvent(owner.profileId, owner.transcriptSessionId, pub.sourceEventId));
      return { publicationId: pub.publicationId, status: "ready", part };
    }
    if (notify) this.coordinator.flushNativeUiText(owner, pub);
    const content = { text: `[交互卡片：${part.title}] ${part.summary}`, uiArtifact: part,
      origin: "assistant_generated_ui", provenance: pub.provenance,
      publicationOperationId: pub.publicationId };
    const event = this.transcriptStore.appendEvent({ profileId: owner.profileId, sessionId: owner.transcriptSessionId,
      id: pub.sourceEventId, runId: pub.creatorRunId, kind: "artifact", content,
      borrowedMemoryProjection: { refs: pub.provenance.borrowedMemoryRefs, derived: pub.provenance.borrowedMemoryDerived === true },
      runtimeRef: null, contextExcluded: false, occurredAt: pub.createdAt });
    const rev = this.store.markPublicationReady(owner, pub.publicationId, event.seq);
    this._current(owner, rev);
    if (notify) this.coordinator.publishNativeUiArtifact(owner, rev, event);
    return { publicationId: pub.publicationId, status: "ready", part };
  }
  publish(name, args, authority, scope, binding) {
    const context = this._context(authority.profileId, scope);
    c.fields(binding, ["profileId", "transcriptSessionId", "publicationId", "callId", "fingerprint"],
      ["profileId", "transcriptSessionId", "publicationId", "callId", "fingerprint"]);
    const pub = this.store.lookupPublication(authority.profileId, authority.callId, binding.fingerprint);
    if (!pub || pub.publicationId !== binding.publicationId || pub.tool !== name
      || binding.profileId !== authority.profileId || binding.transcriptSessionId !== context.owner.transcriptSessionId
      || pub.creatorRunId !== context.run.id || binding.callId !== authority.callId) throw c.uiError("UI_SCOPE_MISMATCH");
    scope.assertCurrent(); return this._publish(pub, context.owner, true);
  }
  revalidateResult(profileId, result, scope) {
    const context = this._context(profileId, scope);
    const part = c.normalizePart(result.part), pub = this.store.publicationsForRecovery()
      .find(value => value.profileId === profileId && value.publicationId === result.publicationId);
    if (!pub) throw c.uiError("UI_ARTIFACT_NOT_FOUND");
    if (pub.sessionKey !== context.owner.sessionKey || pub.creatorRunId !== context.run.id) throw c.uiError("UI_SCOPE_MISMATCH");
    const owner = this._owner(profileId, pub.sessionKey), rev = this.store.revision(owner, part.artifactId, part.revision, part.sourceEventId);
    this._current(owner, rev); return result;
  }
  getState(args, authority, scope) {
    return this.diagnostics.measure("publication.state.read", result => diagnosticMetadata({ ...authority, ...args }, result),
      () => this._getState(args, authority, scope));
  }
  _getState(args, authority, scope) {
    const context = this._context(authority.profileId, scope), rev = this.store.revision(context.owner, args.artifactId, args.revision);
    this._current(context.owner, rev, { execution: true });
    return c.bounded({ artifactId: rev.artifactId, revision: rev.revision, sourceEventId: rev.sourceEventId,
      state: rev.state, stateRevision: rev.stateRevision, stateSchemaVersion: 1,
      provenance: rev.provenance }, c.LIMITS.publication);
  }
  _readOnly(owner, rev) {
    if (!this.enabled()) return "UI_FEATURE_DISABLED";
    const session = this.chatSessionStore.getSession(owner.sessionKey);
    if (!sendableSession(session) || rev.currentEpoch !== rev.conversationEpoch
      || this.productStore.getAgentProfile(owner.profileId)?.enabled !== true
      || Object.values(this.getOrigins(null, session)).some(origin => origin !== null)) return "UI_SOURCE_EXPIRED";
    return null;
  }
  async _readOnlyWithWriter(owner, rev) {
    const reason = this._readOnly(owner, rev); if (reason) return reason;
    try { await this.assertPublishAllowed(owner.sessionKey); }
    catch (error) { return error?.code === "CODEX_DESKTOP_BUSY" ? error.code : "UI_SOURCE_EXPIRED"; }
    const current = this._current(owner, this.store.revision(owner, rev.artifactId, rev.revision, rev.sourceEventId));
    return this._readOnly(owner, current);
  }
  async _writeLease(params) {
    const { lease } = this._lease(params, { write: true });
    await this.assertPublishAllowed(lease.owner.sessionKey);
    const rev = this._current(lease.owner, this.store.revision(lease.owner, lease.artifactId, lease.revision, lease.sourceEventId), { execution: true });
    if (!this.leases.has(params.leaseId) || lease.expiresAt <= this.now()) throw c.uiError("UI_SOURCE_EXPIRED");
    return { lease, rev };
  }
  async describe(params) {
    const owner = this._owner(params.profileId, params.sessionKey);
    const rev = this._current(owner, this.store.revision(owner, params.artifactId, params.revision, params.sourceEventId));
    const readOnlyReason = await this._readOnlyWithWriter(owner, rev);
    return c.bounded({ enabled: this.enabled(), part: this.store.part(rev), actions: rev.declaration.actions,
      stateSchemaVersion: 1, bridgeApiVersion: rev.bridgeApiVersion, rendererPolicyVersion: rev.rendererPolicyVersion,
      resourceBundleId: rev.resourceBundleId, legacy: Boolean(rev.legacy), htmlHash: rev.htmlHash, htmlBytes: rev.htmlBytes, headRevision: rev.headRevision,
      readOnly: readOnlyReason !== null, readOnlyReason }, c.LIMITS.publication);
  }
  _sweepLeases() {
    const now = this.now(); for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
  }
  _lease(params, { write = false } = {}) {
    this._sweepLeases(); const lease = this.leases.get(params.leaseId);
    if (!lease || lease.owner.profileId !== params.profileId || lease.owner.sessionKey !== params.sessionKey) throw c.uiError("UI_SOURCE_EXPIRED");
    if (this.now() - lease.rateSince >= 1000) { lease.rateSince = this.now(); lease.rateCount = 0; }
    if (++lease.rateCount > c.LIMITS.requestsPerSecond) throw c.uiError("UI_RATE_LIMITED");
    const rev = this._current(lease.owner, this.store.revision(lease.owner, lease.artifactId, lease.revision, lease.sourceEventId), { execution: write });
    return { lease, rev };
  }
  async open(params) {
    this._enabled(); this._sweepLeases();
    const owner = this._owner(params.profileId, params.sessionKey);
    let rev = this._current(owner, this.store.revision(owner, params.artifactId, params.revision, params.sourceEventId));
    const readOnlyReason = await this._readOnlyWithWriter(owner, rev);
    rev = this._current(owner, this.store.revision(owner, rev.artifactId, rev.revision, rev.sourceEventId));
    if ([...this.leases.values()].some(lease => lease.owner.profileId === owner.profileId
      && lease.owner.sessionKey === owner.sessionKey && lease.mountId === params.mountId)) throw c.uiError("UI_SCOPE_MISMATCH");
    if (this.leases.size >= c.LIMITS.leases) throw c.uiError("UI_RATE_LIMITED");
    const leaseId = require("node:crypto").randomUUID(), expiresAt = this.now() + c.LIMITS.leaseMs;
    this.leases.set(leaseId, { owner, mountId: params.mountId, artifactId: rev.artifactId, revision: rev.revision,
      sourceEventId: rev.sourceEventId, expiresAt, rateSince: this.now(), rateCount: 0 });
    return { leaseId, expiresAt, part: this.store.part(rev), state: rev.state, stateRevision: rev.stateRevision,
      readOnly: readOnlyReason !== null, readOnlyReason };
  }
  handle(method, input) {
    const stage = typeof method === "string" && method.startsWith("chat.ui.") ? `service.${method.slice(8)}` : "service.request";
    return this.diagnostics.measure(stage, result => diagnosticMetadata(input, result), () => this._handle(method, input));
  }
  _handle(method, input) {
    if (this.storageError) throw this.storageError;
    const params = c.normalizeUiRequest(method, input);
    if (method === "chat.ui.describe") return this.describe(params);
    if (method === "chat.ui.open") return this.open(params);
    if (method === "chat.ui.read") {
      const { lease, rev } = this._lease(params); return this.store.readObject(lease.owner, rev, params.offset);
    }
    if (method === "chat.ui.export") {
      const owner = this._owner(params.profileId, params.sessionKey), rev = this._current(owner,
        this.store.revision(owner, params.artifactId, params.revision, params.sourceEventId));
      return this.store.readObject(owner, rev, params.offset);
    }
    if (method === "chat.ui.renew") {
      const { lease, rev } = this._lease(params); lease.expiresAt = this.now() + c.LIMITS.leaseMs;
      return this._readOnlyWithWriter(lease.owner, rev).then(readOnlyReason => {
        const current = this._current(lease.owner, this.store.revision(lease.owner, rev.artifactId, rev.revision, rev.sourceEventId));
        return { leaseId: params.leaseId, expiresAt: lease.expiresAt, state: current.state,
          stateRevision: current.stateRevision, readOnly: readOnlyReason !== null, readOnlyReason };
      });
    }
    if (method === "chat.ui.close") {
      const lease = this.leases.get(params.leaseId);
      if (lease && (lease.owner.profileId !== params.profileId || lease.owner.sessionKey !== params.sessionKey)) throw c.uiError("UI_SCOPE_MISMATCH");
      this.leases.delete(params.leaseId); return { closed: true };
    }
    if (method === "chat.ui.state.save") {
      return this._writeLease(params).then(({ lease, rev }) =>
        this.store.saveState(lease.owner, rev.artifactId, rev.revision, params.baseStateRevision, params.patch));
    }
    if (method === "chat.ui.action") return this.action(params);
    if (method === "chat.ui.operation.get") {
      const owner = this._owner(params.profileId, params.sessionKey), operation = this.store.getOperation(owner, params);
      if (!operation) throw c.uiError("UI_OPERATION_EXPIRED"); return this.operationResult(owner, operation);
    }
    if (method === "chat.ui.import") return this.importLegacy(params);
    throw c.uiError("UI_REQUEST_INVALID");
  }
  async action(params) {
    // No state-port message can call this method. A fresh main-process proof
    // must match every clicked parameter, and is consumed over private UDS.
    const { actionFingerprint } = require("../desktop-chat-ui-authority");
    if (await this.verifyClick({ proofId: params.hostProof, fingerprint: actionFingerprint(params) }) !== true) throw c.uiError("UI_HOST_REQUIRED");
    const { lease, rev } = await this._writeLease(params);
    const action = rev.declaration.actions.find(value => value.actionId === params.actionId);
    if (!action) throw c.uiError("UI_ACTION_INVALID");
    const snapshot = c.normalizeState(params.snapshot, rev.declaration.stateSchema, this.store.secretMatcher);
    const selected = Object.fromEntries(action.stateFields.map(key => [key, snapshot[key]]));
    const fingerprint = c.hash({ version: 1, owner: lease.owner, artifactId: rev.artifactId, revision: rev.revision,
      sourceEventId: rev.sourceEventId, actionId: action.actionId, stateRevision: params.stateRevision, snapshot,
      ...(params.pluginSelection ? { pluginSelection: params.pluginSelection } : {}) });
    const old = this.store.getOperation(lease.owner, { actionRequestId: params.actionRequestId });
    if (old) {
      if (old.fingerprint !== fingerprint) throw c.uiError("UI_OPERATION_CONFLICT");
      return this.operationResult(lease.owner, old);
    }
    const operationId = `ui-operation-${require("node:crypto").randomUUID()}`;
    const prompt = `[Interactive card: ${rev.declaration.title}]\n${rev.declaration.summary}\n${action.instruction}\nCurrent selection: ${c.canonical(selected)}`;
    const sendEnvelope = { operationId, sessionKey: lease.owner.sessionKey, prompt,
      ...(params.pluginSelection ? { pluginSelection: params.pluginSelection } : {}) };
    const operation = this.store.prepareOperation(lease.owner, { actionRequestId: params.actionRequestId, operationId,
      artifactId: rev.artifactId, revision: rev.revision, sourceEventId: rev.sourceEventId,
      actionId: action.actionId, action, baseStateRevision: params.stateRevision, snapshot,
      fingerprint, sendEnvelope, sendFingerprint: c.hash(sendEnvelope), createdAt: this.now() });
    return this.deliver(lease.owner, operation);
  }
  assertOperationCurrent(input) {
    const found = this.store.opened ? this.store.operationById(input.operationId) : null;
    if (!found) { if (input.operationId.startsWith("ui-operation-")) throw c.uiError("UI_OPERATION_EXPIRED"); return null; }
    const { owner, operation: op } = found;
    if (op.sendEnvelope === null || op.status === "expired" || op.status === "failed"
      || owner.sessionKey !== input.sessionKey || c.hash({ operationId: input.operationId, sessionKey: input.sessionKey,
        prompt: input.prompt, ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.pluginSelection ? { pluginSelection: input.pluginSelection } : {}) }) !== op.sendFingerprint) throw c.uiError("UI_SOURCE_EXPIRED");
    if (this.now() - op.createdAt >= c.LIMITS.retentionMs) throw c.uiError("UI_OPERATION_EXPIRED");
    const rev = this._current(owner, this.store.revision(owner, op.artifactId, op.revision, op.sourceEventId), { execution: true });
    if (op.conversationEpoch !== rev.currentEpoch) throw c.uiError("UI_SOURCE_EXPIRED");
    const action = rev.declaration.actions.find(value => value.actionId === op.actionId);
    if (!action || c.canonical(action) !== c.canonical(op.action)) throw c.uiError("UI_SOURCE_EXPIRED");
    return { origin: "ui_action_submission", uiAction: {
      artifactId: rev.artifactId, revision: rev.revision, sourceEventId: rev.sourceEventId,
      actionRequestId: op.actionRequestId, stateRevision: op.stateRevision, actionId: op.actionId,
      title: rev.declaration.title, instruction: action.instruction,
      userSelection: { origin: "ui_user_selection", values: Object.fromEntries(action.stateFields.map(key => [key, op.snapshot[key]])) },
      declarationOrigin: "assistant_generated_ui" },
      borrowedMemoryRefs: rev.provenance.borrowedMemoryRefs,
      ...(rev.provenance.borrowedMemoryDerived ? { borrowedMemoryDerived: true } : {}) };
  }
  operationResult(owner, op) {
    const run = this.coordinator.getChatRunByOperation(op.operationId, owner.sessionKey);
    let status = op.status === "prepared" ? "accepted" : op.status === "accepted" ? "accepted" : op.status;
    if (run && !["expired", "failed"].includes(status)) status = ({ queued: "queued", starting: "accepted", running: "running",
      waiting_input: "running", waiting_approval: "running", completed: "completed", canceled: "cancelled",
      failed: "failed", interrupted: "unknown" })[run.status] || "unknown";
    const errorCode = op.publicCode || run?.errorCode || null;
    const messages = require("./chat-service-protocol").PUBLIC_MESSAGES || {};
    return { actionRequestId: op.actionRequestId, operationId: op.operationId, artifactId: op.artifactId,
      revision: op.revision, sourceEventId: op.sourceEventId, actionId: op.actionId, stateRevision: op.stateRevision,
      status, runId: run?.id || op.receipt?.runId || null, reason: op.receipt?.reason || null,
      errorCode, errorMessage: errorCode ? c.MESSAGES[errorCode] || messages[errorCode] || "操作暂时无法继续，请查看任务状态" : null,
      createdAt: op.createdAt };
  }
  deliver(owner, op) {
    const previous = this.deliveries.get(op.operationId); if (previous) return previous;
    const task = (async () => {
      try {
        this.assertOperationCurrent(op.sendEnvelope);
        const inbox = this.coordinator.inbox.get(op.operationId), run = this.coordinator.getChatRunByOperation(op.operationId, owner.sessionKey);
        if ((!inbox && run) || (!inbox && op.createdAt <= this.coordinator.inbox.idempotencyFloorMs)
          || this.now() - op.createdAt >= c.LIMITS.retentionMs) {
          op = this.store.receipt(owner, op.actionRequestId, "expired", null, "UI_OPERATION_EXPIRED");
        } else if (op.status === "prepared" || inbox) {
          // Only a durable server-side operation may recover this frozen input.
          const receipt = await this.coordinator.send(structuredClone(op.sendEnvelope));
          op = this.store.receipt(owner, op.actionRequestId, "accepted", receipt);
        }
      } catch (error) {
        const code = error?.code || "UI_COMMIT_UNCERTAIN";
        const definite = /^(UI_|CHAT_SESSION_|RUNTIME_DISABLED|CODEX_DESKTOP_|PLUGIN_SELECTION_)/u.test(code)
          && !["UI_COMMIT_UNCERTAIN", "UI_STORAGE_FAILED"].includes(code);
        try { op = this.store.receipt(owner, op.actionRequestId, definite ? "failed" : "unknown", null, code); }
        catch { op = { ...op, status: "unknown", publicCode: "UI_COMMIT_UNCERTAIN" }; }
      }
      return this.operationResult(owner, op);
    })().finally(() => this.deliveries.delete(op.operationId));
    this.deliveries.set(op.operationId, task); return task;
  }
  async recoverOperations() {
    try {
      for (const { owner, operation } of this.store.operationsForRecovery()) if (["prepared", "unknown"].includes(operation.status)) await this.deliver(owner, operation);
    } catch (error) { this.storageError = error; this.revokeAll(); }
  }
  attachLifecycle() {
    for (const stop of this.lifecycleSubscriptions.splice(0)) stop(); clearInterval(this.sourceTimer);
    const onSession = change => {
      const identity = change.current || change.previous; if (!identity) return;
      const session = this.chatSessionStore.getSession(identity.sessionKey);
      const structural = change.changedFields.some(field => ["profileId", "id", "sessionKey", "workspace"].includes(field));
      if (structural || change.cronClassificationChanged || !session || ["archived", "delete_pending"].includes(session.status)) {
        this.invalidateSession({ profileId: identity.profileId, transcriptSessionId: identity.sessionId, sessionKey: identity.sessionKey });
      }
    };
    if (this.chatSessionStore.subscribeChanges) this.lifecycleSubscriptions.push(this.chatSessionStore.subscribeChanges(onSession));
    if (this.transcriptStore.subscribeChanges) this.lifecycleSubscriptions.push(this.transcriptStore.subscribeChanges(change => {
      if (change.type !== "event.append") this.reconcileSources();
    }));
    if (this.memoryEngine?.recallPolicy?.subscribeChanges) this.lifecycleSubscriptions.push(this.memoryEngine.recallPolicy.subscribeChanges(() => this.reconcileSources()));
    // Historical dependencies can change after their generating Run is gone.
    // This bounded sweep supplements durable policy notifications and lease
    // checks, and never opens or reruns a model.
    this.sourceTimer = setInterval(() => this.reconcileSources(), 2000); this.sourceTimer.unref();
  }
  _lifecycleTask(task) {
    this.pendingLifecycle.add(task); void task.finally(() => this.pendingLifecycle.delete(task)).catch(() => {});
  }
  _cancelQueued(owner, artifactId = null, revision = null) {
    if (!this.coordinator.inbox?.opened) return;
    for (const { owner: target, operation } of this.store.operationsForRecovery()) {
      if (target.profileId !== owner.profileId || target.sessionKey !== owner.sessionKey
        || artifactId && (operation.artifactId !== artifactId || operation.revision !== revision)) continue;
      const run = this.coordinator.getChatRunByOperation(operation.operationId, owner.sessionKey);
      if (run?.status === "queued") this._lifecycleTask(this.coordinator.abort({
        operationId: `ui-revoke-${run.id}`, sessionKey: owner.sessionKey, runId: run.id,
      }));
    }
  }
  invalidateSession(owner) {
    if (!this.store.opened || this.storageError) return;
    const publications = this.store.publicationsForRecovery().filter(pub => pub.profileId === owner.profileId
      && pub.sessionKey === owner.sessionKey && pub.transcriptSessionId === owner.transcriptSessionId);
    if (!publications.length) return;
    const currentEpoch = this.store.revision(owner, publications[0].artifactId, publications[0].revision).currentEpoch;
    if (!publications.some(pub => pub.conversationEpoch === currentEpoch)) return;
    // Only metadata affecting conversation authority changes the epoch. A
    // Runtime/model/settings switch does not revoke saved card state.
    try { this.store.invalidate(owner, "UI_SOURCE_EXPIRED"); this.revoke(owner); this._cancelQueued(owner); }
    catch (error) { this.storageError = error; this.revokeAll(); }
  }
  profileChanged(profileId) {
    if (!this.store.opened || this.storageError || this.productStore.getAgentProfile(profileId)?.enabled === true) return;
    const owners = new Map();
    for (const pub of this.store.publicationsForRecovery()) if (pub.profileId === profileId) owners.set(pub.sessionKey,
      { profileId, sessionKey: pub.sessionKey, transcriptSessionId: pub.transcriptSessionId });
    for (const owner of owners.values()) this.invalidateSession(owner);
  }
  reconcileSources() {
    if (!this.store.opened || this.storageError) return;
    try {
      for (const pub of this.store.publicationsForRecovery()) {
        if (pub.status !== "ready") continue;
        const session = this.chatSessionStore.getSession(pub.sessionKey);
        const owner = { profileId: pub.profileId, transcriptSessionId: pub.transcriptSessionId, sessionKey: pub.sessionKey };
        if (!session || session.profileId !== pub.profileId || session.id !== pub.transcriptSessionId) { this.invalidateSession(owner); continue; }
        try { this._current(owner, this.store.revision(owner, pub.artifactId, pub.revision, pub.sourceEventId)); }
        catch (error) {
          if (error.code !== "UI_SOURCE_EXPIRED") throw error;
          if (this.store.revision(owner, pub.artifactId, pub.revision).status !== "revoked") this.store.revokeRevision(owner, pub.artifactId, pub.revision);
          this.revoke(owner, pub.artifactId, pub.revision); this._cancelQueued(owner, pub.artifactId, pub.revision);
        }
      }
    } catch (error) { this.storageError = error; this.revokeAll(); }
  }
  recover() {
    this.attachLifecycle();
    for (const pub of this.store.publicationsForRecovery()) {
      if (pub.status === "revoked") continue;
      const owner = { profileId: pub.profileId, transcriptSessionId: pub.transcriptSessionId, sessionKey: pub.sessionKey };
      const session = this.chatSessionStore.getSession(pub.sessionKey);
      if (!session || session.profileId !== pub.profileId || session.id !== pub.transcriptSessionId) continue;
      try { this._publish(pub, owner, false); }
      catch (error) {
        if (error.code !== "UI_SOURCE_EXPIRED") throw error;
        this.store.revokeRevision(owner, pub.artifactId, pub.revision);
      }
    }
  }
  revoke(owner, artifactId = null, revision = null, reason = "UI_SOURCE_EXPIRED") {
    for (const [key, lease] of this.leases) if (lease.owner.profileId === owner.profileId
      && lease.owner.sessionKey === owner.sessionKey && (!artifactId || lease.artifactId === artifactId && lease.revision === revision)) this.leases.delete(key);
    for (const listener of this.listeners) { try { listener({ ...owner, artifactId, revision, reason, type: "revoked" }); } catch {} }
  }
  revokeAll(reason = "UI_SOURCE_EXPIRED") {
    const owners = new Map([...this.leases.values()].map(lease => [lease.owner.sessionKey, lease.owner]));
    try { for (const pub of this.store.publicationsForRecovery()) owners.set(pub.sessionKey, {
      profileId: pub.profileId, transcriptSessionId: pub.transcriptSessionId, sessionKey: pub.sessionKey }); } catch {}
    for (const owner of owners.values()) this.revoke(owner, null, null, reason); this.leases.clear();
  }
  stopLifecycle() { clearInterval(this.sourceTimer); this.sourceTimer = null; for (const stop of this.lifecycleSubscriptions.splice(0)) stop(); }
  async close() {
    this.stopLifecycle(); this.revokeAll();
    await Promise.allSettled([...this.pendingLifecycle, ...this.deliveries.values(), ...this.publicationTails.values()]);
  }
}
module.exports = { ChatUiController };
