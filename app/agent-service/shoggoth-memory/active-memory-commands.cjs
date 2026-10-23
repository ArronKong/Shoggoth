"use strict";

const { core } = require("./host.cjs");
const { withMemoryHost } = require("./host-bridge.cjs");
const { sha256 } = require("./migration.cjs");
const { STATUS_NAMESPACE } = require("./active-memory-state.cjs");
const { fail, isCommand, validateParams, validateResult } = require("../active-memory-command-protocol");
const { validateNativeMemoryConfigProjection } = require("../native-memory-config-protocol");
const { registerActiveMemoryPlugin } = require("./active-memory-plugin.cjs");
const NAMESPACE = "active-memory-session-toggles";

class ActiveMemoryCommands {
  constructor(service) { this.service = service; }
  isCommand(text) { return isCommand(text); }
  descriptor() { return { name: "active-memory", description: "Enable, disable, or inspect Active Memory for this session.",
    args: "[status|on|off|help] [--global]", category: "session", aliases: [], source: "Shoggoth Memory", execution: "runtime", allowWhileRunning: true }; }
  scope(sessionKey, parentCheck = () => {}) {
    const service = this.service, session = service.chatSessionStore.getSession(sessionKey);
    if (!session) fail("MEMORY_COMMAND_SESSION_UNAVAILABLE");
    const assertCurrent = () => {
      parentCheck(); service.assertProfile(session.profileId);
      if (service.profiles().find(profile => profile.id === session.profileId)?.enabled === false) fail("MEMORY_COMMAND_SESSION_UNAVAILABLE");
      const current = service.chatSessionStore.getSession(sessionKey);
      if (!current || current.id !== session.id || current.profileId !== session.profileId || current.workspace !== session.workspace
        || !["draft", "binding", "ready"].includes(current.status) || service.chatSessionStore.getCronSessionOrigin?.(sessionKey)) fail("MEMORY_COMMAND_SESSION_UNAVAILABLE");
    };
    assertCurrent();
    const host = service.host(session.profileId), database = host.database;
    const canonical = `agent:${session.profileId}:webchat:${sessionKey}`, key = sha256(canonical);
    const validateValue = value => {
      if (value !== undefined && (!value || Object.keys(value).sort().join() !== "disabled,sessionKey,updatedAt"
        || value.sessionKey !== canonical || value.disabled !== true || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) fail("MEMORY_COMMAND_STATE_INVALID");
      return value;
    };
    const observe = () => {
      assertCurrent(); database.assertOpen();
      const row = database.db.prepare("SELECT version,value,expires_at FROM memory_state WHERE namespace=? AND key=?").get(NAMESPACE, key);
      if (row?.expires_at !== undefined && row.expires_at !== null) fail("MEMORY_COMMAND_STATE_INVALID");
      let value;
      try { value = row?.value == null ? undefined : JSON.parse(row.value); } catch { fail("MEMORY_COMMAND_STATE_INVALID"); }
      validateValue(value);
      return { value, revision: `${database.identity}:${row?.version ?? 0}` };
    };
    const store = database.openKeyedStore({ namespace: NAMESPACE, maxEntries: 10_000 }, assertCurrent);
    let writtenRevision;
    const assertMutationCurrent = () => {
      if (writtenRevision !== undefined && observe().revision !== writtenRevision) fail("MEMORY_COMMAND_STALE");
    };
    const checkKey = requested => { assertCurrent(); if (requested !== key) fail("MEMORY_COMMAND_SESSION_UNAVAILABLE"); };
    const changed = async () => service.activeMemory.invalidateSession(session.profileId, sessionKey);
    const mutate = async action => {
      // MemoryDatabase transactions commit synchronously behind the async SDK
      // interface. Capture this write's version before yielding to another command.
      const committed = action();
      try { writtenRevision = observe().revision; }
      catch (error) { await committed.catch(() => {}); throw error; }
      await committed; await changed(); assertCurrent(); assertMutationCurrent();
    };
    const api = { runtime: { state: { openKeyedStore(options) {
      assertCurrent();
      if (options.namespace !== "session-toggles" || options.maxEntries !== 10_000 || Object.keys(options).length !== 2) fail("MEMORY_COMMAND_STATE_INVALID");
      return {
        async lookup(requested) { checkKey(requested); return observe().value; },
        async register(requested, value) { checkKey(requested); validateValue(value); observe(); await mutate(() => store.register(key, value)); },
        async delete(requested) { checkKey(requested); observe(); await mutate(() => store.delete(key)); },
      };
    } } }, logger: { debug() {}, warn() {} } };
    return { session, canonical, key, host, database, api, observe, assertCurrent, assertMutationCurrent };
  }
  async policy(sessionKey) {
    const scope = this.scope(sessionKey), before = scope.observe();
    const disabled = await core.isSessionActiveMemoryDisabled({ api: scope.api, sessionKey: scope.canonical });
    const assertCurrent = () => {
      if (scope.observe().revision !== before.revision) fail("MEMORY_COMMAND_STALE");
    };
    assertCurrent();
    return { disabled, revision: before.revision, assertCurrent };
  }
  async execute(raw, { assertCurrent: parentCheck, allowConfigUpdate = false } = {}) {
    const input = validateParams(raw), scope = this.scope(input.sessionKey, parentCheck);
    scope.observe();
    const initial = validateNativeMemoryConfigProjection(this.service.getConfigProjection());
    const assertCurrent = () => {
      scope.assertCurrent(); scope.assertMutationCurrent();
      if (JSON.stringify(validateNativeMemoryConfigProjection(this.service.getConfigProjection())) !== JSON.stringify(initial)) fail("MEMORY_COMMAND_STALE");
    };
    let configUpdate = null, statusError = null;
    const config = () => {
      assertCurrent(); const cfg = structuredClone(initial.config);
      // The host currently loads this optional plugin only when explicitly
      // enabled. Expose that resolved state to the native command as well.
      if (!cfg.plugins?.entries?.["active-memory"]) {
        cfg.plugins = { ...cfg.plugins, entries: { ...cfg.plugins?.entries, "active-memory": { enabled: false } } };
      }
      return cfg;
    };
    const statusKey = sha256(input.sessionKey);
    const statusStore = scope.database.openKeyedStore({ namespace: STATUS_NAMESPACE, maxEntries: core.ACTIVE_MEMORY_MAX_CACHE_ENTRIES }, assertCurrent);
    const sessionEntry = request => {
      assertCurrent();
      if (request.agentId !== scope.session.profileId || request.sessionKey !== scope.canonical) fail("MEMORY_COMMAND_SESSION_UNAVAILABLE");
      const present = scope.database.db.prepare("SELECT 1 FROM memory_state WHERE namespace=? AND key=? AND value IS NOT NULL").get(STATUS_NAMESPACE, statusKey);
      // The command only needs presence to clear its own status. Reading a
      // persisted summary here would bypass the recall source proof checks.
      return { sessionId: scope.session.id, ...(present ? { pluginDebugEntries: [{ pluginId: "active-memory", lines: [] }] } : {}) };
    };
    const api = { ...scope.api, id: "active-memory", config: config(), pluginConfig: initial.config.plugins?.entries?.["active-memory"]?.config,
      runtime: { ...scope.api.runtime, config: { current: config, async mutateConfigFile(request) {
        assertCurrent(); if (!allowConfigUpdate) fail("MEMORY_COMMAND_CONFIG_REQUIRED");
        if (configUpdate || typeof request.mutate !== "function") fail("MEMORY_COMMAND_INVALID");
        request.writeOptions?.assertCurrent?.();
        const draft = structuredClone(initial.config); request.mutate(draft);
        const checked = validateNativeMemoryConfigProjection({ revision: initial.revision + 1, config: draft });
        configUpdate = { expectedRevision: initial.revision, config: checked.config };
        assertCurrent();
      } }, agent: { session: { getSessionEntry: sessionEntry, async patchSessionEntry(request) {
        try {
          const before = sessionEntry(request);
          if (request.preserveActivity !== true || typeof request.update !== "function") fail("MEMORY_COMMAND_INVALID");
          const next = request.update(before); assertCurrent();
          if (Object.keys(next).length !== 1 || !Object.hasOwn(next, "pluginDebugEntries") || next.pluginDebugEntries !== undefined) fail("MEMORY_COMMAND_INVALID");
          await statusStore.delete(statusKey); assertCurrent(); return next;
        } catch (error) { statusError = error; throw error; }
      } } } } };
    const host = { assertCurrent,
      normalizePluginsConfig: cfg => core.normalizeOpenClawPluginsConfig(cfg),
      getMemoryCapabilityRegistration: () => ({ pluginId: "memory-core", capability: { recallToolNames: ["memory_search", "memory_get"] } }),
    };
    return withMemoryHost(host, async () => {
      const { command } = registerActiveMemoryPlugin(api); assertCurrent();
      const result = await command.handler({ args: input.text.slice("/active-memory".length).trim(),
        sessionKey: scope.canonical, sessionId: scope.session.id, senderIsOwner: true, assertOwnerCurrent: assertCurrent });
      assertCurrent(); if (statusError) throw statusError;
      return validateResult({ text: result.text, configUpdate }, input);
    });
  }
}
module.exports = { ActiveMemoryCommands, ACTIVE_MEMORY_TOGGLES_NAMESPACE: NAMESPACE };
