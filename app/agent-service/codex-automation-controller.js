"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { OWNER, ACCOUNT_ID, CodexAutomationStore, number, hash, resolveCodexAutomationOwner } = require("./codex-automation-store");
const { TIMEZONE, validateSchedule, nextOccurrence } = require("./codex-automation-schedule");
const { runtimeBinding } = require("./runtime-adapter");
const { serviceError } = require("./security");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { domainOperationId, domainThreadSource } = require("./domain-work-run-executor");
const { MESSAGES } = require("./codex-automation-protocol");
const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const fail = code => { throw serviceError(code, MESSAGES[code]); };
const clip = (text, count = 512) => typeof text === "string" ? text.slice(0, count).toWellFormed() : null;

// Keeps the elected owner for the life of this controller when the Service
// supplies no persistent state.
function memoryOwnerState() {
  let owner = null;
  return { codexAutomationOwner: () => owner, setCodexAutomationOwner: (profileId) => { owner = profileId; } };
}

class CodexAutomationController {
  constructor({ productStore, resolver, adapter, dispatcher, coordinator, paths, now = Date.now, home, databaseFactory, ownerState }) {
    Object.assign(this, { productStore, resolver, adapter, dispatcher, coordinator, paths, now, home, databaseFactory });
    this.ownerState = ownerState || memoryOwnerState();
    this.stores = new Map(); this.results = new Map(); this.runTails = new Map();
  }
  ownerProfile() { return resolveCodexAutomationOwner(this.productStore, this.ownerState); }
  owner(profileId = null) {
    const profile = this.ownerProfile();
    if (!profile || (profileId !== null && profileId !== profile.id)) fail("CODEX_AUTOMATION_OWNER_UNAVAILABLE");
    const account = this.productStore.getRuntimeAccount(ACCOUNT_ID);
    if (account?.kind !== "native-user") fail("CODEX_AUTOMATION_OWNER_UNAVAILABLE");
    const binding = runtimeBinding({ runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId });
    const environment = this.home ? { home: this.home, nativeHome: this.home } : this.resolver.resolve(binding, account);
    if (!environment.nativeHome || environment.nativeHome !== environment.home) fail("CODEX_AUTOMATION_OWNER_UNAVAILABLE");
    const home = fs.realpathSync(environment.home);
    if (!this.stores.has(home)) this.stores.set(home, new CodexAutomationStore({ home, now: this.now, databaseFactory: this.databaseFactory }));
    return { profile, binding, store: this.stores.get(home) };
  }
  ownerIdentity(backendId) {
    const profile = backendId === OWNER.backendId ? this.ownerProfile() : null;
    return { ownerProfileId: profile?.id ?? null, ownerAgentId: profile?.agentId ?? null };
  }
  source(backendId) {
    const base = { origin: "codex-desktop", ...this.ownerIdentity(backendId), backendId: OWNER.backendId,
      timeZone: TIMEZONE, scheduler: "codex-desktop", clientRefreshRequired: true };
    if (backendId !== OWNER.backendId) return { ...base, available: false, canCreate: false, reason: "CODEX_AUTOMATION_OWNER_UNAVAILABLE", unavailable: [] };
    try {
      const { store } = this.owner();
      const scan = store.list();
      let reason = null;
      try { store.database.ownership(); } catch (error) { reason = error.code; }
      return { ...base, available: true, canCreate: !reason, reason, homeIdentity: store.homeIdentity, unavailable: scan.unavailable };
    } catch (error) { return { ...base, available: false, canCreate: false, reason: this.errorCode(error), unavailable: [] }; }
  }
  errorCode(error) { return Object.hasOwn(MESSAGES, error?.code) ? error.code : "CODEX_AUTOMATION_UNAVAILABLE"; }
  runReason(definition) {
    if (definition.kind !== "cron" || !["local", "worktree"].includes(definition.execution_environment)
      || !Array.isArray(definition.cwds) || definition.cwds.length !== 1 || typeof definition.cwds[0] !== "string"
      || (definition.target?.type && definition.target.type !== "projectless") || definition.local_environment_config_path) {
      return "CODEX_AUTOMATION_RUN_UNSUPPORTED";
    }
    return null;
  }
  mapJob(record, owner) {
    const { definition: d, revision } = record, { store, profile } = owner;
    let reason = null, native = null;
    try { store.database.ownership(d.id); native = store.database.metadata(d.id); } catch (error) { reason = this.errorCode(error); }
    const runReason = reason || this.runReason(d);
    // A task keeps its run history when ownership moves to another Agent.
    const localRuns = this.dispatcher.listRuns({ source: "automation", sourceId: store.externalId(d.id) })
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const latest = localRuns[0];
    const nativeFresh = native?.updated_at === number(d.updated_at);
    const schedule = { kind: "rrule", rrule: d.rrule, tz: TIMEZONE, anchorMs: number(d.created_at) };
    const lastRunAt = Math.max(native?.last_run_at || 0, latest?.startedAt || 0) || null;
    const localLatest = latest && (latest.startedAt || 0) >= (native?.last_run_at || 0);
    return {
      id: store.externalId(d.id), externalTaskId: d.id, origin: "codex-desktop", backendId: profile.backendId,
      agentId: profile.agentId, ownerProfileId: profile.id, runtimeAccountId: ACCOUNT_ID, revision,
      name: d.name, enabled: d.status === "ACTIVE", state: d.status, schedule, model: d.model ?? null,
      reasoningEffort: d.reasoning_effort ?? null, createdAt: number(d.created_at), updatedAt: number(d.updated_at),
      lastRunAt, lastStatus: localLatest ? this.executionStatus(latest.status) : lastRunAt ? "unknown" : null,
      lastError: localLatest ? latest.errorCode : null,
      nextRunAt: d.status !== "ACTIVE" ? null : nativeFresh ? native?.next_run_at ?? null : nextOccurrence(d.rrule, number(d.created_at), this.now(), d.kind),
      nextRunSource: nativeFresh ? "codex-desktop" : "calculated",
      promptPreview: clip(d.prompt), promptLength: d.prompt.length,
      actions: { edit: !reason && Buffer.byteLength(d.prompt) <= 32 * 1024, toggle: !reason, delete: false, run: !runReason },
      sourceReason: reason, runReason,
      codex: { kind: d.kind, cwd: d.cwds?.length === 1 ? d.cwds[0] : null, cwds: d.cwds || [], target: typeof d.target?.type === "string" ? { type: d.target.type } : null,
        executionEnvironment: d.execution_environment || null, targetThreadId: d.target_thread_id || null,
        modelEditable: d.kind === "cron", scheduler: "codex-desktop" },
    };
  }
  target(params) {
    const owner = this.owner(params.profileId), id = owner.store.localId(params.id);
    return { ...owner, id, record: owner.store.read(id) };
  }
  async models(owner) {
    const handle = await this.adapter.acquire(owner.binding);
    const rows = [], seen = new Set(); let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await handle.modelsList({ cursor, limit: 100 });
      if (!Array.isArray(response?.data)) fail("CODEX_AUTOMATION_MODEL_UNAVAILABLE");
      for (const row of response.data) rows.push({ id: row.model || row.id, name: row.displayName || row.model || row.id,
        isDefault: row.isDefault === true, thinkingOptions: (row.supportedReasoningEfforts || []).map(value => value.reasoningEffort),
        thinkingDefault: row.defaultReasoningEffort || null });
      cursor = response.nextCursor ?? null;
      if (!cursor) return { models: rows, defaultModelId: rows.find(row => row.isDefault)?.id || null };
      if (seen.has(cursor)) break; seen.add(cursor);
    }
    fail("CODEX_AUTOMATION_MODEL_UNAVAILABLE");
  }
  async validateModel(model, effort, owner, required = false) {
    if (!required && model === null && effort === null) return { model: null, reasoningEffort: null };
    const catalog = await this.models(owner);
    const selected = catalog.models.find(value => value.id === (model || catalog.defaultModelId));
    if (!selected || (effort !== null && !selected.thinkingOptions.includes(effort))) fail("CODEX_AUTOMATION_MODEL_UNAVAILABLE");
    return { model: selected.id, reasoningEffort: effort ?? selected.thinkingDefault };
  }
  applyPatch(d, patch) {
    const map = { name: "name", prompt: "prompt", rrule: "rrule", model: "model", reasoningEffort: "reasoning_effort",
      executionEnvironment: "execution_environment", targetThreadId: "target_thread_id" };
    for (const [key, field] of Object.entries(map)) {
      if (!(key in patch)) continue;
      if (patch[key] === null) delete d[field]; else d[field] = patch[key];
    }
    if ("enabled" in patch) d.status = patch.enabled ? "ACTIVE" : "PAUSED";
    if ("cwd" in patch) d.cwds = [patch.cwd];
    return d;
  }
  registryFile(store) { return path.join(this.paths.stateDir, `codex-automation-runs-${store.homeIdentity}.json`); }
  registry(store) {
    const file = this.registryFile(store);
    if (!fs.existsSync(file)) return { version: 1, operations: {}, creations: {} };
    const value = JSON.parse(readPrivateFile(file, { fs, maxBytes: 8 * 1024 * 1024 }));
    if (value?.version !== 1 || !value.operations || typeof value.operations !== "object" || Object.keys(value.operations).length > 4096) fail("CODEX_AUTOMATION_UNAVAILABLE");
    value.creations ||= {};
    return value;
  }
  saveRegistry(store, value) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) fail("CODEX_AUTOMATION_CAPACITY");
    atomicWritePrivateFile(this.registryFile(store), data, { fs, trustedRoot: this.paths.trustedRoot });
  }
  async workspace(d, operationId) {
    if (this.runReason(d)) fail("CODEX_AUTOMATION_RUN_UNSUPPORTED");
    const raw = d.cwds[0], expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
    if (!path.isAbsolute(expanded) || !fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) fail("CODEX_AUTOMATION_WORKSPACE_UNAVAILABLE");
    const cwd = fs.realpathSync(expanded);
    if (d.execution_environment === "local") return cwd;
    try {
      const root = (await execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10000 })).stdout.trim();
      const target = path.join(this.paths.stateDir, "codex-automation-worktrees", hash(operationId));
      if (fs.existsSync(target)) fail("CODEX_AUTOMATION_COMMIT_UNCERTAIN");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      await execFile("git", ["-C", root, "worktree", "add", "--detach", target, "HEAD"], { timeout: 30000 });
      return fs.realpathSync(target);
    } catch (error) { if (error.code?.startsWith("CODEX_AUTOMATION_")) throw error; fail("CODEX_AUTOMATION_WORKSPACE_UNAVAILABLE"); }
  }
  async run(params) {
    const owner = this.target(params);
    return owner.store.serial("intents", async () => {
      const state = this.registry(owner.store), prior = state.operations[params.operationId];
      const fingerprint = hash(JSON.stringify([params.id, params.revision]));
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("CODEX_AUTOMATION_OPERATION_CONFLICT");
        const run = this.dispatcher.getRun(prior.runId);
        return { runId: prior.runId, status: run?.status || "needs_verification", executionOrigin: "shoggoth" };
      }
      owner.record = owner.store.read(owner.id);
      if (owner.record.revision !== params.revision) fail("CODEX_AUTOMATION_CONFLICT");
      owner.store.database.ownership(owner.id);
      if (this.runReason(owner.record.definition)) fail("CODEX_AUTOMATION_RUN_UNSUPPORTED");
      if (this.dispatcher.listRuns({ source: "automation", sourceId: params.id }).some(run => !TERMINAL.has(run.status))) fail("CODEX_AUTOMATION_RUN_BUSY");
      if (Object.keys(state.operations).length >= 4096) fail("CODEX_AUTOMATION_CAPACITY");
      const d = owner.record.definition;
      const selection = await this.validateModel(d.model ?? null, d.reasoning_effort ?? null, owner, true);
      // Catalog reads can wait for a native process. Recheck the selected
      // revision and ownership before durably admitting that frozen prompt.
      if (owner.store.read(owner.id).revision !== params.revision) fail("CODEX_AUTOMATION_CONFLICT");
      owner.store.database.ownership(owner.id);
      const runId = `automation-${crypto.randomUUID()}`;
      // Persist the intent before creating a workspace or admitting a turn.
      // An uncertain request remains inspectable and is never automatically resent.
      state.operations[params.operationId] = { fingerprint, runId, taskId: params.id, revision: params.revision,
        name: d.name, sourceModel: d.model ?? null, ...selection, workspace: null, createdAt: this.now(), state: "preparing" };
      this.saveRegistry(owner.store, state);
      try {
        const workspace = await this.workspace(d, params.operationId);
        state.operations[params.operationId].workspace = workspace;
        state.operations[params.operationId].state = "admitted";
        this.saveRegistry(owner.store, state);
        const run = this.dispatcher.enqueue({ id: runId, source: "automation", sourceId: params.id,
          idempotencyKey: `codex-automation:${params.operationId}`, profileId: owner.profile.id, workspace });
        const execution = { runId, operationId: domainOperationId(run), prompt: d.prompt,
          threadSource: domainThreadSource(run), threadId: null,
          automationConfig: { model: selection.model, reasoningEffort: selection.reasoningEffort, revision: params.revision } };
        await this.coordinator.executeDomainRun(execution);
        return { runId, status: this.dispatcher.getRun(runId).status, executionOrigin: "shoggoth" };
      } catch (error) {
        const latest = this.registry(owner.store);
        latest.operations[params.operationId].state = "needs_verification";
        latest.operations[params.operationId].error = this.errorCode(error);
        this.saveRegistry(owner.store, latest);
        if (this.dispatcher.getRun(runId)?.status === "queued") this.coordinator.cancelQueuedDomainRun(runId, "RUNTIME_RECOVERY_UNAVAILABLE");
        throw error;
      }
    });
  }
  executionStatus(status) { return status === "completed" ? "ok" : ["failed", "canceled", "interrupted"].includes(status) ? "error" : status === "skipped" ? "skipped" : status; }
  manualRuns(owner) {
    return Object.values(this.registry(owner.store).operations).filter(value => value.taskId === owner.store.externalId(owner.id)).map(value => {
      const run = this.dispatcher.getRun(value.runId);
      return { runId: value.runId, executionOrigin: "shoggoth", status: run ? this.executionStatus(run.status) : value.state,
        executionStatus: run?.status ?? value.state, completionStatus: run?.status === "completed" ? "succeeded" : ["failed", "canceled", "interrupted"].includes(run?.status) ? "failed" : "unknown",
        startedAt: run?.startedAt ?? value.createdAt, finishedAt: run?.finishedAt ?? null, summary: clip(run?.resultSummary),
        error: run?.errorCode ?? value.error ?? null, model: value.model, reasoningEffort: value.reasoningEffort, workspace: value.workspace,
        taskRevision: value.revision, nameAtRun: value.name };
    });
  }
  nativeRun(row) {
    return { runId: `codex:${row.thread_id}`, nativeThreadId: row.thread_id, executionOrigin: "codex-desktop",
      startedAt: row.created_at, status: "unknown", executionStatus: "unknown", completionStatus: "unknown", reviewStatus: row.status,
      summary: clip(row.inbox_summary), workspace: row.source_cwd || null, title: clip(row.inbox_title || row.thread_title, 256) };
  }
  async result(owner, runId) {
    const key = `${owner.store.externalId(owner.id)}:${runId}`;
    if (this.results.get(key)?.expiresAt > this.now()) return this.results.get(key);
    let metadata, threadId, turnId = null, archivedText = null;
    if (runId.startsWith("codex:")) {
      const nativeId = runId.slice(6);
      owner.store.database.ownership(owner.id);
      const row = owner.store.database.query(db => db.prepare(`SELECT thread_id,status,thread_title,source_cwd,inbox_title,inbox_summary,created_at,
        archived_assistant_message FROM automation_runs WHERE automation_id = ? AND thread_id = ?`).get(owner.id, nativeId));
      if (!row) fail("CODEX_AUTOMATION_NOT_FOUND");
      metadata = this.nativeRun(row); threadId = nativeId; archivedText = row.archived_assistant_message || null;
    } else {
      metadata = this.manualRuns(owner).find(value => value.runId === runId);
      if (!metadata) fail("CODEX_AUTOMATION_NOT_FOUND");
      const run = this.dispatcher.getRun(runId);
      if (run?.runtimeSessionRef?.runtimeAccountId !== ACCOUNT_ID) threadId = null;
      else { threadId = run.runtimeSessionRef.sessionId; turnId = run.runtimeTurnRef?.turnId ?? null; }
      const snapshot = run && this.coordinator.getRunSnapshot(runId);
      if (snapshot?.interaction) metadata.interaction = snapshot.interaction;
    }
    let fullText = archivedText, outputSource = archivedText ? "native-archive" : null, outputComplete = !!archivedText;
    try {
      if (threadId) {
        const handle = await this.adapter.acquire(owner.binding);
        const response = await handle.sessionRead({ sessionId: threadId, includeTurns: true });
        const session = response.session;
        const turns = session?.turns || [];
        const turn = metadata.executionOrigin === "shoggoth" ? turns.find(value => value.id === turnId) : turns[0];
        if (turn) {
          const texts = (turn.items || []).filter(item => item.type === "agentMessage" && typeof item.text === "string").map(item => item.text);
          fullText = texts.join("\n\n"); outputSource = "native-session";
          outputComplete = !response.nextCursor && !session.nextCursor && turn.itemsView !== "partial"
            && turn.status !== "inProgress";
          if (metadata.executionOrigin === "codex-desktop") {
            metadata.executionStatus = turn.status === "completed" ? "completed" : turn.status === "inProgress" ? "running" : turn.status;
            metadata.status = this.executionStatus(metadata.executionStatus);
            metadata.completionStatus = turn.status === "completed" ? "succeeded" : ["failed", "interrupted"].includes(turn.status) ? "failed" : "unknown";
            metadata.error = clip(turn.error?.message, 2048);
          }
        }
      }
    } catch { /* Preserve an archive or summary, but never call it a complete native turn. */ }
    if (fullText !== null && (typeof fullText !== "string" || Buffer.byteLength(fullText) > 8 * 1024 * 1024)) fail("CODEX_AUTOMATION_CAPACITY");
    const value = { ...metadata, available: fullText !== null, outputSource, outputComplete, content: fullText ?? "",
      contentLength: fullText?.length || 0, contentRevision: hash(fullText ?? ""), expiresAt: this.now() + (TERMINAL.has(metadata.executionStatus) ? 300000 : 2000) };
    this.results.set(key, value);
    if (this.results.size > 100) this.results.delete(this.results.keys().next().value);
    return value;
  }
  async handle(method, params) {
    const name = method.slice("codex.automation.".length);
    if (name === "source") return this.source(params.backendId);
    if (name === "owner") return this.ownerIdentity(params.backendId);
    const owner = this.owner(params.profileId);
    if (name === "models.list") return this.models(owner);
    if (name === "list") {
      const { records } = owner.store.list();
      records.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
      return { jobs: records.slice(params.offset, params.offset + params.limit).map(record => this.mapJob(record, owner)),
        nextOffset: records.length > params.offset + params.limit ? params.offset + params.limit : null };
    }
    if (name === "create") return owner.store.serial("intents", async () => {
      const registry = this.registry(owner.store);
      const fingerprint = hash(JSON.stringify(Object.entries(params.spec).sort(([a], [b]) => a.localeCompare(b))));
      const previous = registry.creations[params.operationId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail("CODEX_AUTOMATION_OPERATION_CONFLICT");
        const record = owner.store.read(previous.id);
        return { job: this.mapJob(record, owner) };
      }
      if (Object.keys(registry.creations).length >= 4096) fail("CODEX_AUTOMATION_CAPACITY");
      const spec = params.spec, kind = spec.kind || "cron";
      if (!spec.name || !spec.prompt || !spec.rrule || (kind === "heartbeat" && !spec.targetThreadId) || (kind === "cron" && !spec.cwd)) fail("CODEX_AUTOMATION_PARAMS_INVALID");
      validateSchedule(spec.rrule, kind);
      if (kind === "cron") await this.validateModel(spec.model ?? null, spec.reasoningEffort ?? null, owner);
      const now = BigInt(this.now());
      const definition = { version: 1n, id: `shoggoth-${hash(params.operationId).slice(0, 32)}`, kind, name: spec.name, prompt: spec.prompt,
        status: spec.enabled === true ? "ACTIVE" : "PAUSED", rrule: spec.rrule, created_at: now, updated_at: now,
        ...(kind === "cron" ? { target: { type: "projectless" }, execution_environment: spec.executionEnvironment || "local", cwds: [spec.cwd] }
          : { target_thread_id: spec.targetThreadId }) };
      this.applyPatch(definition, spec);
      owner.store.database.ownership();
      registry.creations[params.operationId] = { id: definition.id, fingerprint };
      this.saveRegistry(owner.store, registry);
      return { job: this.mapJob(await owner.store.create(definition), owner) };
    });
    const target = this.target(params);
    if (name === "get") return { job: this.mapJob(target.record, target) };
    if (name === "update" || name === "setStatus") {
      const patch = name === "setStatus" ? { enabled: params.enabled } : params.patch;
      const d = target.record.definition;
      if (patch.rrule !== undefined && patch.rrule !== d.rrule) validateSchedule(patch.rrule, d.kind);
      if (d.kind === "heartbeat" && ["model", "reasoningEffort", "cwd", "executionEnvironment"].some(key => key in patch)) fail("CODEX_AUTOMATION_PARAMS_INVALID");
      const model = patch.model !== undefined ? patch.model : d.model ?? null, effort = patch.reasoningEffort !== undefined ? patch.reasoningEffort : d.reasoning_effort ?? null;
      if (model !== (d.model ?? null) || effort !== (d.reasoning_effort ?? null)) await this.validateModel(model, effort, target);
      if ("cwd" in patch && d.target?.type !== "projectless") fail("CODEX_AUTOMATION_RUN_UNSUPPORTED");
      return { job: this.mapJob(await target.store.update(target.id, params.revision, value => this.applyPatch(value, patch)), target) };
    }
    if (name === "run") return this.run(params);
    if (name === "runs.list") {
      const manual = this.manualRuns(target); let native = [], sourceError = null;
      // Skip only native rows guaranteed to precede this merged page. The
      // bounded manual registry gives the maximum number of displaced rows.
      let nativeOffset = Math.max(0, params.offset - manual.length);
      try { native = target.store.database.runs(target.id, nativeOffset, manual.length + params.limit).map(row => this.nativeRun(row)); }
      catch (error) { sourceError = this.errorCode(error); nativeOffset = 0; }
      const merged = [...manual, ...native].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.runId.localeCompare(a.runId));
      const offset = params.offset - nativeOffset;
      return { runs: merged.slice(offset, offset + params.limit), sourceError,
        nextOffset: merged.length > offset + params.limit ? params.offset + params.limit : null };
    }
    if (name === "runs.control") {
      // The caller is the current owner (checked above); a run started by a
      // previous owner of this task remains controllable.
      const run = this.dispatcher.getRun(params.runId);
      if (!run || run.source !== "automation" || run.sourceId !== params.id) fail("CODEX_AUTOMATION_NOT_FOUND");
      let result;
      if (params.action === "stop") result = await this.coordinator.stopAutomationRun(run.id);
      else if (params.action === "approval") result = await this.coordinator.respondApproval({ operationId: params.operationId,
        runId: run.id, requestId: params.requestId, choice: params.choice });
      else result = await this.coordinator.respondInput({ operationId: params.operationId, runId: run.id, requestId: params.requestId,
        action: params.action === "cancel-input" ? "cancel" : "submit", answers: params.answers });
      this.results.delete(`${params.id}:${params.runId}`);
      return { accepted: true, status: this.dispatcher.getRun(run.id).status };
    }
    if (name === "runs.result") {
      const { content, expiresAt, ...metadata } = await this.result(target, params.runId);
      return metadata;
    }
    if (name === "content.read") {
      let content, revision;
      if (params.field === "prompt") { content = target.record.definition.prompt; revision = target.record.revision; }
      else { const value = await this.result(target, params.runId); content = value.content; revision = value.contentRevision; }
      if (revision !== params.revision) fail("CODEX_AUTOMATION_CONFLICT");
      const end = Math.min(content.length, params.offset + params.limit);
      return { content: content.slice(params.offset, end), revision, nextOffset: end < content.length ? end : null };
    }
    fail("CODEX_AUTOMATION_PARAMS_INVALID");
  }
}
module.exports = { CodexAutomationController };
