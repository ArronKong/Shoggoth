"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { HOOK_LIMITS, HOOK_EVENTS, BUILTINS, safeJson, validateDefinition, validateOutput, id, fail, digest, dataAccess, relativePath } = require("./hook-contract");
const { runtimeHookCapabilities, assertHookSupported } = require("./runtime-hook-bridge");
const { HOOK_TOOL_NAMES, HOOK_DEFINITION_SCHEMA, HOOK_BUILTIN_CONFIG_SCHEMAS, validateHookArguments } = require("./hook-service-protocol");
const { executeBuiltinHook } = require("./hook-runner");
const { extractBorrowedMemoryRefs, mergeBorrowedMemoryRefs } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
function publicHook(record, { source = false, offset = 0, limit = 4096 } = {}) {
  const copy = structuredClone(record), handler = copy.definition.handler;
  copy.boundWorkspace = copy.definition.scope.workspace;
  copy.definition.scope.workspace = copy.boundWorkspace === null ? "profile" : "current";
  if (handler.type === "script") {
    const chars = Array.from(handler.source);
    handler.sourceDigest = digest(handler.source); handler.sourceLength = chars.length;
    const body = source ? chars.slice(offset, offset + limit).join("") : undefined;
    delete handler.source;
    if (source) { copy.source = body; copy.nextOffset = offset + limit < chars.length ? offset + limit : null; }
  }
  return copy;
}
class HookService {
  constructor({ store, runner, processHost, productStore, getRun, toolRegistry, permissionEngine,
    resolveToolIdentity, requestApproval, cacheDir, pluginHooks = null, nativeCapabilities = () => ({}),
    prepareNativeCapabilities = null, getBorrowedMemoryRefs = () => [], isMemorySharingQuery = () => false, now = Date.now }) {
    this.store = store; this.runner = runner; this.processHost = processHost; this.productStore = productStore;
    this.getRun = getRun; this.toolRegistry = toolRegistry; this.permissionEngine = permissionEngine;
    this.getBorrowedMemoryRefs = getBorrowedMemoryRefs; this.isMemorySharingQuery = isMemorySharingQuery;
    this.resolveToolIdentity = resolveToolIdentity; this.requestApproval = requestApproval;
    this.cacheDir = cacheDir; this.nativeCapabilities = nativeCapabilities; this.now = now;
    this.pluginHooks = pluginHooks;
    this.prepareNativeCapabilities = prepareNativeCapabilities; this.preparedNative = new Map();
  }
  actor(authority, scope) {
    if (!authority || authority.federationClient || !id(authority.profileId) || !scope
      || !id(scope.runId) || typeof scope.assertCurrent !== "function") fail("HOOK_FORBIDDEN");
    scope.assertCurrent();
    const profile = this.productStore.getAgentProfile(authority.profileId), run = this.getRun(scope.runId);
    if (!profile?.enabled || !run || run.profileId !== profile.id || !["starting", "running", "waiting_approval", "waiting_input"].includes(run.status)
      || !["chat", "cron", "kanban", "inspiration"].includes(run.source)) fail("HOOK_FORBIDDEN");
    return { profile, run, assertCurrent: scope.assertCurrent, signal: scope.signal,
      confirmed: authority.confirmation === true, operationId: "hook-op-" + digest(authority.callId) };
  }
  capabilities(profile, run) {
    return { ...runtimeHookCapabilities(run?.runtimeSessionRef?.runtime || profile.runtime || "codex",
      this.preparedNative.get(run?.id) || this.nativeCapabilities(profile, run)),
      definitionSchema: HOOK_DEFINITION_SCHEMA,
      handlers: Object.fromEntries(Object.entries(BUILTINS).map(([name, kinds]) => [name, { kinds, configSchema: HOOK_BUILTIN_CONFIG_SCHEMAS[name] }])),
      limits: HOOK_LIMITS, grantRequirements: ["exact version", "event payload", "workspace read/write", "script execution"],
      activation: "next_run", scripts: { javascript: this.processHost?.available("javascript") === true,
        python: this.processHost?.available("python") === true, network: false, subprocesses: false } };
  }
  async validateTargets(definition, actor) {
    if (!definition.event.startsWith("tool.")) return;
    if (!this.resolveToolIdentity) fail("HOOK_TOOL_UNAVAILABLE");
    for (const scope of definition.matcher.toolScopes) {
      const targets = await this.resolveToolIdentity(scope, definition.matcher, actor);
      actor.assertCurrent();
      if (!Array.isArray(targets) || !targets.length) fail("HOOK_TOOL_UNAVAILABLE");
    }
  }
  candidate(actor, hookId, version) {
    return hookId.startsWith("plugin-hook-") && this.pluginHooks
      ? this.pluginHooks.get(actor.profile.id, hookId, actor.run.workspace, version ?? 1)
      : this.store.get(actor.profile.id, hookId, version);
  }
  publicCandidate(candidate, options) {
    return publicHook(candidate.owner === "plugin" ? this.pluginHooks.publicRecord(candidate) : candidate, options);
  }
  listCandidates(actor, args) {
    let items = [], cursor = args.cursor || "";
    let own = this.store.list(actor.profile.id, { cursor }); items.push(...own.items);
    while (own.nextCursor) { own = this.store.list(actor.profile.id, { cursor: own.nextCursor }); items.push(...own.items); }
    items.push(...(this.pluginHooks?.candidates(actor.profile.id, actor.run.workspace) || []));
    items = items.filter(item => item.hookId > cursor && (args.enabled === undefined || (item.activeVersion !== null) === args.enabled)
      && (args.event === undefined || item.definition.event === args.event)).sort((a, b) => a.hookId.localeCompare(b.hookId));
    const limit = args.limit ?? HOOK_LIMITS.pageSize;
    const page = items.slice(0, limit).map(item => this.publicCandidate(item.owner === "plugin"
      ? this.pluginHooks.get(actor.profile.id, item.hookId, actor.run.workspace) : item));
    return { items: page, nextCursor: items.length > limit ? page.at(-1).hookId : null };
  }
  async handleTool(name, args, authority, scope) {
    if (!HOOK_TOOL_NAMES.includes(name) || !validateHookArguments(name, args)) fail();
    const actor = this.actor(authority, scope);
    this.permissionEngine.authorize({ name, profileId: actor.profile.id, profile: actor.profile,
      run: actor.run, workspace: actor.run.workspace, confirmed: actor.confirmed });
    const profileId = actor.profile.id, operationId = actor.operationId;
    const check = () => { actor.assertCurrent(); if (this.productStore.getAgentProfile(profileId)?.enabled !== true) fail("HOOK_REVOKED"); };
    check();
    if (this.prepareNativeCapabilities) {
      this.preparedNative.set(actor.run.id, await this.prepareNativeCapabilities(actor.profile, actor.run)); check();
    }
    const currentCapabilities = this.capabilities(actor.profile, actor.run);
    const supported = definition => assertHookSupported(definition, currentCapabilities, this.processHost);
    let result;
    if (name === "hook_capabilities") result = currentCapabilities;
    else if (name === "hook_list") result = this.listCandidates(actor, args);
    else if (name === "hook_get") result = this.publicCandidate(this.candidate(actor, args.hookId, args.version), { source: true, offset: args.offset, limit: args.limit });
    else if (name === "hook_register" || name === "hook_update") {
      if (args.hookId?.startsWith("plugin-hook-")) fail("HOOK_FORBIDDEN");
      const definition = validateDefinition(args.definition, actor.run.workspace);
      await this.validateTargets(definition, actor); check();
      result = name === "hook_register" ? this.store.register(profileId, operationId, definition)
        : this.store.update(profileId, operationId, args.hookId, args.expectedRevision, definition);
      result = publicHook(result);
    } else if (name === "hook_grant") {
      if (!actor.confirmed) fail("HOOK_GRANT_REQUIRED");
      const candidate = this.candidate(actor, args.hookId, args.version);
      result = candidate.owner === "plugin" ? this.store.operation(profileId, operationId, { name, ...args }, () => this.pluginHooks.grant(candidate))
        : this.store.grant(profileId, operationId, args.hookId, args.version);
    } else if (name === "hook_enable") {
      const candidate = this.candidate(actor, args.hookId, args.version);
      const receipt = candidate.owner === "plugin" ? candidate.binding?.test : this.store.latestTest?.(profileId, args.hookId, args.version);
      if (!receipt?.passed || receipt.contentDigest !== candidate.contentDigest) fail("HOOK_TEST_REQUIRED");
      await this.validateTargets(candidate.definition, actor); check();
      supported(candidate.definition);
      result = candidate.owner === "plugin"
        ? this.store.operation(profileId, operationId, { name, ...args }, () => publicHook(this.pluginHooks.enable(candidate, args.expectedRevision)))
        : publicHook(this.store.activate(profileId, operationId, args.hookId, args.version, args.expectedRevision, supported));
    } else if (name === "hook_disable" || name === "hook_remove") {
      const candidate = this.candidate(actor, args.hookId);
      if (candidate.owner === "plugin") {
        if (name === "hook_remove") fail("HOOK_FORBIDDEN");
        result = this.store.operation(profileId, operationId, { name, ...args }, () => this.pluginHooks.disable(candidate, args.expectedRevision));
      } else result = this.store.disable(profileId, operationId, args.hookId, args.expectedRevision, name === "hook_remove");
    } else if (name === "hook_executions") result = this.store.executions(profileId, args);
    else if (name === "hook_execution_get") {
      const { output, ...receipt } = this.store.execution(profileId, args.executionId);
      // Output can contain sensitive event text. Keep the default management
      // surface metadata-only; actual transformed content goes to its Run.
      result = receipt;
    } else if (name === "hook_test") result = await this.test(actor, args);
    else fail();
    check(); return result;
  }
  async test(actor, { hookId, version, payload, files = [] }) {
    const candidate = this.candidate(actor, hookId, version);
    const recordTest = passed => candidate.owner === "plugin" ? this.pluginHooks.recordTest(candidate, passed)
      : this.store.recordTest(actor.profile.id, hookId, version, candidate.contentDigest, passed);
    const definition = candidate.definition;
    let scratch = null, workspace = actor.run.workspace, tested = definition;
    const requiresProcess = definition.handler.type === "script" || ["workspace.copy", "context.file"].includes(definition.handler.name);
    try {
    if (requiresProcess) {
      if (!this.processHost.available(definition.handler.language || "javascript")) fail("HOOK_SANDBOX_UNAVAILABLE");
      fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      scratch = fs.mkdtempSync(path.join(this.cacheDir, "test-")); workspace = fs.realpathSync(scratch);
      for (const fixture of files) {
        relativePath(fixture.relativePath);
        const target = path.join(workspace, fixture.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, fixture.content, { mode: 0o600, flag: "wx" });
      }
      // Production files are never copied automatically into a simulation.
      tested = { ...definition, scope: { ...definition.scope, workspace } };
    }
    let testTool = null;
    if (definition.event.startsWith("tool.")) {
      const scope = definition.matcher.toolScopes[0];
      const targets = await this.resolveToolIdentity?.(scope, definition.matcher, actor);
      actor.assertCurrent();
      const target = targets?.find(item => definition.matcher.toolNames.some(pattern => require("./hook-contract").glob(pattern, item.name)));
      if (!target) fail("HOOK_TOOL_UNAVAILABLE");
      testTool = { scope, name: target.name,
        ...(definition.matcher.serverId ? { serverId: definition.matcher.serverId } : {}),
        ...(definition.matcher.componentId ? { componentId: definition.matcher.componentId } : {}) };
    }
    const event = { schemaVersion: 1, eventId: "hook-test-" + crypto.randomUUID(), event: definition.event,
      profileId: actor.profile.id, runId: actor.run.id, operationId: null, source: actor.run.source,
      bindingId: null, runtimeSessionRef: null, runtimeTurnRef: null, toolCallId: "hook-test-call-" + crypto.randomUUID(), tool: testTool,
      workspace, payload: safeJson(payload), causation: { parentEventId: null, depth: 0 } };
      let output = requiresProcess ? await this.processHost.run(tested, event, { simulation: true,
        workspace, sourceFile: candidate.sourceFile, signal: actor.signal, assertCurrent: actor.assertCurrent }) : executeBuiltinHook(definition, event);
      output = validateOutput(definition, output);
      if (definition.kind === "action" && (output.status !== "completed" || output.sideEffect === "unknown")) fail("HOOK_TEST_FAILED");
      actor.assertCurrent(); recordTest(true);
      return { hookId, version, simulation: true, passed: true, output, productionWrites: false, network: false,
        testScope: scratch ? "isolated_empty_workspace" : "synthetic_event_only", suppressed: ["business tools", "production workspace", "network"] };
    } catch (error) {
      recordTest(false);
      return { hookId, version, simulation: true, passed: false, errorCode: error.code || "HOOK_TEST_FAILED",
        productionWrites: false, network: false, testScope: scratch ? "isolated_empty_workspace" : "synthetic_event_only" };
    } finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  freezeRun(run, profile, options) {
    const capabilities = this.capabilities(profile, run);
    const { definitionSchema, handlers, limits, grantRequirements, activation, ...frozen } = capabilities;
    return this.store.freeze(run, frozen, definition => assertHookSupported(definition, capabilities, this.processHost), options);
  }
  async prepareRun(run, profile, assertCurrent, permissionPolicy) {
    if (this.prepareNativeCapabilities) {
      this.preparedNative.set(run.id, await this.prepareNativeCapabilities(profile, run, permissionPolicy)); assertCurrent();
    }
    const snapshot = this.freezeRun(run, profile);
    const context = { assertCurrent };
    const base = this.event(snapshot, run, "run.before", "run-before:" + run.id, {});
    const guards = await this.runner.dispatch(snapshot, base, "guard", context);
    if (guards.some(item => item.output.decision === "block")) fail("HOOK_BLOCKED");
    this.observe(snapshot, base);
    const contributions = await this.runner.dispatch(snapshot, this.event(snapshot, run, "context.prepare",
      "context-prepare:" + run.id, {}), "transform", context);
    if (contributions.reduce((sum, item) => sum + Buffer.byteLength(item.output.text), 0) > HOOK_LIMITS.contextRunBytes) fail("HOOK_CAPACITY");
    return { snapshot, contributions: contributions.map(item => ({ hookId: item.hookId, version: item.version, text: item.output.text })),
      summary: this.summary(snapshot) };
  }
  nativeRunScope(runId) {
    const snapshot = this.store.snapshotForRun(runId);
    if (!snapshot) return null;
    const available = snapshot.capabilities.scopes.runtime_builtin.guard.toolNames || [];
    const { glob } = require("./hook-contract");
    const toolNames = available.filter(name => snapshot.entries.some(entry => entry.definition.matcher.toolScopes?.includes("runtime_builtin")
      && entry.definition.matcher.toolNames.some(pattern => glob(pattern, name))));
    return { runId, snapshotId: snapshot.id, toolNames };
  }
  releaseRun(runId) { this.preparedNative.delete(runId); this.runner.releaseRun?.(runId); this.nativeTools?.releaseRun(runId); }
  summary(snapshot) {
    const items = snapshot.entries.slice(0, 8).map(entry => ({ hookId: entry.hookId, version: entry.version,
      name: entry.definition.name, event: entry.definition.event, kind: entry.definition.kind,
      matcher: { ...entry.definition.matcher, toolNames: entry.definition.matcher.toolNames?.slice(0, 4),
        toolNameCount: entry.definition.matcher.toolNames?.length },
      handler: { type: entry.definition.handler.type, name: entry.definition.handler.name,
        reason: entry.definition.handler.config?.reason?.slice(0, 160) },
      scope: entry.definition.scope, effectiveFrom: "this_run" }));
    while (items.length && Buffer.byteLength(JSON.stringify(items)) > HOOK_LIMITS.contextBytes) items.pop();
    return { snapshotId: snapshot.id, total: snapshot.entries.length, items, truncated: snapshot.entries.length > items.length };
  }
  event(snapshot, run, event, eventId, payload, tool = null, toolCallId = null) {
    if (!id(eventId)) eventId = "hook-event-" + digest(eventId);
    const borrowedMemoryRefs = mergeBorrowedMemoryRefs(this.getBorrowedMemoryRefs(run), extractBorrowedMemoryRefs(payload));
    return { ...(borrowedMemoryRefs.length ? { borrowedMemoryRefs } : {}),
      ...(event === "tool.before" && this.isMemorySharingQuery(run, tool, payload) ? { persistPolicy: "reference_only" } : {}), schemaVersion: 1, eventId, event, profileId: snapshot.profileId, runId: snapshot.runId,
      operationId: null, source: snapshot.source, bindingId: run.bindingId ?? null,
      runtimeSessionRef: null, runtimeTurnRef: null, toolCallId, tool, workspace: snapshot.workspace,
      metadata: { status: ["completed", "failed", "unknown", "skipped", "canceled", "interrupted", "running"].includes(payload?.status) ? payload.status : null },
      payload, causation: { parentEventId: null, depth: 0 } };
  }
  observe(snapshot, event) {
    try { this.runner.observe(snapshot, event); }
    catch (error) { this.lastObserverError = error.code || "HOOK_OBSERVER_FAILED"; }
  }
  observeRun(run, event, payload = {}, eventId = event + ":" + run.id) {
    const snapshot = this.store.snapshotForRun(run.id); if (!snapshot) return;
    if (["run.completed", "run.failed", "run.canceled", "run.interrupted", "run.skipped"].includes(event)) this.store.markTerminal(run.id);
    this.observe(snapshot, this.event(snapshot, run, event, eventId, payload));
  }
  observeSkippedRun(run) {
    try {
      if (!this.store.db || run.status !== "skipped" || !["chat", "cron", "kanban", "inspiration"].includes(run.source)
        || !Number.isSafeInteger(run.finishedAt) || run.finishedAt < this.now() - HOOK_LIMITS.retentionMs) return;
      const profile = this.productStore.getAgentProfile(run.profileId);
      if (!profile?.enabled) return;
      this.freezeRun(run, profile, { onlyEvent: "run.skipped" });
      this.observeRun(run, "run.skipped", { status: "skipped", reason: run.resultSummary });
    } catch (error) { this.lastObserverError = error.code || "HOOK_OBSERVER_FAILED"; }
  }
  observeSession(session, event, operationId, payload = {}) {
    try {
      if (!this.store.db || !["session.created", "session.closed", "context.checkpoint.before", "context.checkpoint.after"].includes(event)) return;
      const profile = this.productStore.getAgentProfile(session.profileId);
      if (profile?.enabled !== true) return;
      const eventId = event + ":" + session.sessionKey + (event.startsWith("context.") ? ":" + operationId : "");
      const { definitionSchema, handlers, limits, grantRequirements, activation, ...capabilities } = this.capabilities(profile, null);
      const snapshot = this.store.freezeSession(session, event, eventId, capabilities);
      this.observe(snapshot, this.event(snapshot, { bindingId: session.runtimeBindingId, profileId: session.profileId, source: "chat", sourceId: session.id }, event, eventId,
        { sessionKey: session.sessionKey, ...payload }));
    } catch (error) { this.lastObserverError = error.code || "HOOK_OBSERVER_FAILED"; }
  }
}
module.exports = { HookService, publicHook };
