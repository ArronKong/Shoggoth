"use strict";
const crypto = require("node:crypto");
const { runtimeCapabilities } = require("./runtime-adapter");
const { serviceError } = require("./security");
const { DEFAULT_EXECUTION_TIMEOUT_MS } = require("../execution-timeout");
const { openAcpLedger, acpMetadata, acpId: boundedId, acpPlain: plain, acpData } = require("./runtime-acp-ledger");
const { projectAcpUpdate, acpSessionCatalogs, sealAcpContent } = require("./runtime-acp-events");
const { normalizeRuntimeCommands, parseRuntimeCommand } = require("./runtime-commands");
const { unknownRuntimeContextUsage } = require("./runtime-context-usage");
const fail = code => serviceError(code, "ACP execution could not be confirmed");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const TERMINALS = new Set(["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"]);
function execution(turn) {
  return { version: 1, sessionId: turn.sessionId, turnId: turn.id, attemptId: turn.attemptId,
    operationId: turn.operationId, fingerprint: turn.fingerprint,
    dispatchState: turn.facts.writeAttempted ? "write_attempted" : "not_sent", frameWritten: turn.facts.frameWritten,
    remoteAccepted: turn.facts.remoteAccepted, terminal: turn.facts.terminal, unknown: turn.facts.unknown,
    stopReason: turn.facts.stopReason };
}
function observerDto(session, turn) { return { sessionId: session.id, turnId: turn.id, operationId: turn.operationId,
  attemptId: turn.attemptId, fingerprint: turn.fingerprint }; }
function syncCall(fn, dto) { const result = fn?.(dto); if (result && typeof result.then === "function") throw fail("RUNTIME_OBSERVER_INVALID"); }
function promptText(input, stable) {
  for (const key of ["developerInstructions", "turnDeveloperInstructions", "context", "prompt", "text"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].isWellFormed() || input[key].includes("\0"))) {
      throw fail("RUNTIME_PROTOCOL_INVALID");
    }
  }
  let user = input.prompt ?? input.text;
  if (user === undefined && Array.isArray(input.input)) {
    if (!input.input.every(v => plain(v) && ["text", "input_text"].includes(v.type) && typeof v.text === "string")) throw fail("RUNTIME_REQUIREMENT_UNSUPPORTED");
    user = input.input.map(v => v.text).join("\n");
  }
  const stableText = input.developerInstructions ?? stable ?? "", turn = input.turnDeveloperInstructions ?? "", dynamic = input.context ?? "";
  return { text: [stableText, turn, dynamic, user ?? ""].filter(Boolean).join("\n\n"), delivery: {
    stableVersion: hash(stableText), stableBytes: Buffer.byteLength(stableText), turnBytes: Buffer.byteLength(turn),
    dynamicBytes: Buffer.byteLength(dynamic), reused: false, retention: "unverified" } };
}
async function createAcpHandle({ binding, rpc, home, workspace, stateDir, trustedRoot, stop, terminated, host = {}, ledgerWriter, onDiagnostic }) {
  const ledger = openAcpLedger({ binding, workspace, stateDir, trustedRoot, ...(ledgerWriter ? { writer: ledgerWriter } : {}) });
  const { state, save } = ledger;
  const listeners = new Set(), active = new Map(), configured = new Map(), loads = new Map(), creating = new Map(), diagnostics = new Map();
  let authentication = Object.freeze({ status: "unverified" }), flushTimer = null, failed = false;
  const cacheAuthentication = status => { authentication = Object.freeze({ status }); };
  host.getCachedAuthenticationState = () => authentication;
  const canRetireIdle = host.canRetireIdle?.bind(host);
  host.canRetireIdle = () => active.size === 0 && loads.size === 0 && state.pending.length === 0
    && state.sessions.every(s => s.turns.every(t => t.facts.terminal || t.facts.notSent))
    && (!canRetireIdle || canRetireIdle() === true);
  const cancelFlush = () => { if (flushTimer) clearTimeout(flushTimer); flushTimer = null; };
  const flush = () => { cancelFlush(); save(); };
  const retire = () => { failed = true; cancelFlush(); for (const a of active.values()) { a.canceled = true;
    try { host.acpBridge?.interruptTurn?.(a.dto); } catch {} }
    void Promise.resolve().then(() => stop()).catch(() => {}); };
  const scheduleSave = () => { if (!flushTimer) { flushTimer = setTimeout(() => { flushTimer = null;
    try { save(); } catch { retire(); } }, 50); flushTimer.unref?.(); } };
  Promise.resolve(terminated).then(() => { failed = true; cancelFlush(); ledger.release(); }, () => { failed = true; cancelFlush(); });
  const assertCurrent = a => { if (failed || a?.canceled) throw fail("RUNTIME_TURN_CANCELED");
    host.assertRuntimeIdentityCurrent?.(); if (a?.signal?.aborted) throw fail("RUNTIME_TURN_CANCELED"); syncCall(a?.observer?.assertCurrent); };
  const authenticatedRequest = async (method, params, options) => {
    try { return await rpc.request(method, params, options); }
    catch (error) {
      if (!Number.isSafeInteger(error?.rpcCode)) throw error;
      const required = error.rpcCode === -32000;
      if (required) cacheAuthentication("unauthenticated");
      const normalized = serviceError(required ? "AUTH_REQUIRED" : "ACP_REMOTE_ERROR",
        required ? "ACP runtime authentication is required" : "ACP request failed");
      normalized.rpcCode = error.rpcCode;
      if (["not_sent", "write_attempted"].includes(error.dispatchState)) normalized.dispatchState = error.dispatchState;
      for (const key of ["frameBytes", "maxFrameBytes"]) if (Number.isSafeInteger(error[key]) && error[key] >= 0) normalized[key] = error[key];
      throw normalized;
    }
  };
  const emit = value => { for (const listener of listeners) { try { listener({ known: true, method: "session/update", ...value }); }
    catch { retire(); } } };
  const find = id => { const s = state.sessions.find(v => v.id === id); if (!s || s.cwd !== workspace) throw fail("RUNTIME_SESSION_NOT_FOUND"); return s; };
  const project = (session, includeTurns = true, includeItems = true) => ({ id: session.id, source: session.source, cwd: session.cwd, archived: session.archived,
    ...(session.name ? { name: session.name } : {}), createdAt: session.createdAt, updatedAt: session.createdAt,
    compactions: JSON.parse(JSON.stringify(session.metadata.compactions || [])),
    ...(includeTurns ? { turns: [...session.replay.map(turn => ({ ...turn, ...(includeItems ? {} : { itemsView: "partial", items: [] }) })), ...session.turns.map(turn => ({ id: turn.id, status: turn.status, itemsView: includeItems ? "full" : "partial",
      items: includeItems ? JSON.parse(JSON.stringify(turn.items)) : [], execution: execution({ ...turn, sessionId: session.id }) }))] } : {}) });
  const reportDiagnostic = (stage, code, outcome) => {
    // The trusted local sink receives fixed metadata only, never native update
    // names/content. Its failure cannot change execution or retirement facts.
    try { Promise.resolve(onDiagnostic?.({ stage, code, outcome, count: 1 })).catch(() => {}); } catch {}
  };
  const noteDiagnostic = kind => { diagnostics.set(kind, Math.min(1000, (diagnostics.get(kind) || 0) + 1));
    while (diagnostics.size > 32) diagnostics.delete(diagnostics.keys().next().value);
    reportDiagnostic("acp_update_ignored", "ACP_UPDATE_IGNORED", "unknown"); };
  rpc.subscribe(message => {
    if (message.method !== "session/update") return;
    try {
      const { sessionId, update } = message.params || {};
      if (!boundedId(sessionId) || !plain(update)) throw fail("RUNTIME_PROTOCOL_INVALID");
      const s = state.sessions.find(v => v.id === sessionId), loading = loads.get(sessionId), a = active.get(sessionId);
      if (!s) {
        const pending = [...creating.values()];
        if (pending.length !== 1 || !["available_commands_update", "config_option_update", "current_mode_update", "session_info_update", "usage_update"].includes(update.sessionUpdate)) throw fail("RUNTIME_PROTOCOL_INVALID");
        const bytes = Buffer.byteLength(JSON.stringify(acpData(update, 256 * 1024)));
        if (pending[0].updates.length >= 256 || (pending[0].bytes += bytes) > 512 * 1024) throw fail("RUNTIME_PROTOCOL_INVALID");
        // A reply and its immediate metadata can share one stdout frame batch;
        // the new session is not committed until its matched response validates.
        pending[0].updates.push({ sessionId, update: JSON.parse(JSON.stringify(update)) }); return;
      }
      if (loading) {
        const result = projectAcpUpdate(loading.session, loading.turn, update);
        if (result.diagnostic) noteDiagnostic(update.sessionUpdate); return;
      }
      if (a?.canceled || failed) return;
      // Session-only updates may be shown in this prepared execution but never
      // prove which prompt was accepted. Only the matched RPC terminal does.
      const result = projectAcpUpdate(s, a?.turn.facts.writeAttempted ? a.turn : undefined, update);
      if (result.diagnostic) noteDiagnostic(update.sessionUpdate);
      if (result.boundary || result.metadata || a?.turn.sequence !== a?.savedSequence) {
        flush(); if (a) a.savedSequence = a.turn.sequence;
      } else scheduleSave();
      for (const event of result.events) emit(event);
    } catch { reportDiagnostic("acp_invalid_update", "ACP_UPDATE_INVALID", "error"); retire(); }
  });
  rpc.registerServerRequestHandler("session/request_permission", async (params, requestContext) => {
    const a = boundedId(params?.sessionId) && active.get(params.sessionId);
    if (!a || a.canceled || failed || !a.turn.facts.writeAttempted || !Array.isArray(params.options)) return { outcome: { outcome: "cancelled" } };
    try {
      assertCurrent(a);
      const release = rpc.pauseRequestTimeout?.("session/prompt", p => p.sessionId === params.sessionId) || (() => {});
      try {
        const result = host.acpBridge?.requestPermission
          ? await host.acpBridge.requestPermission(params, requestContext)
          : { outcome: { outcome: "cancelled" } };
        assertCurrent(a);
        if (!plain(result?.outcome) || (result.outcome.outcome !== "cancelled"
          && (result.outcome.outcome !== "selected" || !params.options.some(v => v.optionId === result.outcome.optionId)))) {
          return { outcome: { outcome: "cancelled" } };
        }
        return result;
      } finally { release(); }
    } catch { return { outcome: { outcome: "cancelled" } }; }
  });
  const hello = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } }, clientInfo: { name: "shoggoth", version: "1" } }, { timeoutMs: 15_000 });
  if (!plain(hello) || hello.protocolVersion !== 1 || (hello.agentCapabilities !== undefined && !plain(hello.agentCapabilities))
    || (hello.agentCapabilities?.loadSession !== undefined && typeof hello.agentCapabilities.loadSession !== "boolean")
    || (hello.agentCapabilities?.sessionCapabilities != null && !plain(hello.agentCapabilities.sessionCapabilities))
    || (hello.agentCapabilities?.sessionCapabilities?.resume != null && !plain(hello.agentCapabilities.sessionCapabilities.resume))
    || (hello.agentCapabilities?.promptCapabilities !== undefined && !plain(hello.agentCapabilities.promptCapabilities))
    || ["image", "audio", "embeddedContext"].some(k => hello.agentCapabilities?.promptCapabilities?.[k] !== undefined
      && typeof hello.agentCapabilities.promptCapabilities[k] !== "boolean")) throw fail("RUNTIME_PROTOCOL_INVALID");
  host.agentCapabilities = Object.freeze({ loadSession: hello.agentCapabilities?.loadSession === true,
    sessionCapabilities: Object.freeze({ resume: hello.agentCapabilities?.sessionCapabilities?.resume != null ? Object.freeze({}) : null }),
    promptCapabilities: Object.freeze(Object.fromEntries(["image", "audio", "embeddedContext"].map(k => [k, hello.agentCapabilities?.promptCapabilities?.[k] === true]))) });
  host.acpDiagnostics = () => Object.freeze({ unknownUpdates: Object.fromEntries(diagnostics) });
  const caps = runtimeCapabilities({ "session.start": true, "session.resume": host.agentCapabilities.loadSession || host.agentCapabilities.sessionCapabilities.resume !== null,
    "session.read": true, "session.list": true, "session.rename": true, "session.archive": true, "session.unarchive": true,
    "turn.start": true, "turn.start.prepare": true, "turn.interrupt": true, "models.list": true,
    "commands.list": true, "commands.execute": true, "context.compact.auto": false, serverRequests: !!host.acpBridge?.registerServerRequestHandler, events: true });
  const checkPolicy = input => {
    if (input.permissionPolicy != null && (!plain(input.permissionPolicy)
      || ["approvalPolicy", "sandbox"].some(key => input.permissionPolicy[key] !== host.permissionPolicy?.[key]))) {
      throw fail("RUNTIME_PERMISSION_UNSUPPORTED");
    }
    if (input.permissionMode != null && input.permissionMode !== "profile") throw fail("RUNTIME_PERMISSION_UNSUPPORTED");
  };
  const modelSelector = session => {
    const selectors = session.metadata.configOptions.filter(option => option.type === "select" && option.category === "model");
    return selectors.length === 1 ? selectors[0] : null;
  };
  const selections = (input, session) => {
    const mode = input.modeId ?? input.mode ?? undefined;
    if (input.modeId !== undefined && input.mode !== undefined && input.modeId !== input.mode) throw fail("RUNTIME_REQUIREMENT_UNSUPPORTED");
    if (mode !== undefined && (!boundedId(mode) || !session.metadata.modes?.availableModes.some(v => v.id === mode))) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
    const config = input.configOptions ?? [];
    if (!Array.isArray(config) || config.length > 256 || new Set(config.map(v => v?.configId)).size !== config.length
      || !config.every(v => plain(v) && Object.keys(v).sort().join() === "configId,value" && boundedId(v.configId) && boundedId(v.value))) {
      throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
    }
    for (const choice of config) {
      const option = session.metadata.configOptions.find(v => v.id === choice.configId);
      const values = option?.type === "select" ? option.options.flatMap(v => Array.isArray(v.options) ? v.options : [v]) : [];
      if (option?.type !== "select" || !values.some(v => v.value === choice.value)) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
    }
    return { mode, config: config.map(value => ({ ...value })) };
  };
  const confirmedStop = async () => {
    try { await stop(); } catch { throw fail("RUNTIME_STOP_UNCONFIRMED"); }
    let timer;
    try { await Promise.race([terminated, new Promise((_, reject) => { timer = setTimeout(() => reject(fail("RUNTIME_STOP_UNCONFIRMED")), 2000); timer.unref?.(); })]); }
    catch { throw fail("RUNTIME_STOP_UNCONFIRMED"); }
    finally { clearTimeout(timer); }
  };
  const sessionParams = async (operation, sessionId) => {
    const bridge = await host.acpBridge?.prepareSession?.({ operation, ...(sessionId ? { sessionId } : {}) });
    const mcpServers = bridge?.mcpServers || [];
    if (!Array.isArray(mcpServers)) throw fail("RUNTIME_PROTOCOL_INVALID");
    acpData(mcpServers, 256 * 1024);
    return { bridge, params: { cwd: workspace, mcpServers, ...(sessionId ? { sessionId } : {}) } };
  };
  const handle = { ...binding, host, homeIdentity: home, workspace, capabilities: caps, terminated, stop,
    authenticationState: () => { host.assertRuntimeIdentityCurrent?.(); return authentication; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    registerServerRequestHandler(method, handler) {
      if (!host.acpBridge?.registerServerRequestHandler) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      return host.acpBridge.registerServerRequestHandler(method, handler);
    },
    pauseManagedToolTimeout(input) {
      const a = active.get(input.sessionId);
      if (!a || a.turn.id !== input.turnId || a.canceled) return () => {};
      return rpc.pauseRequestTimeout?.("session/prompt", p => p.sessionId === input.sessionId) || (() => {});
    },
    async sessionStart(input) {
      assertCurrent(); checkPolicy(input);
      if (input.cwd !== workspace || !boundedId(input.source)) throw fail("RUNTIME_SESSION_PARAMS_INVALID");
      const existing = state.sessions.find(s => s.source === input.source); if (existing) return { session: project(existing) };
      if (state.pending.includes(input.source)) throw fail("RUNTIME_SESSION_ACCEPTANCE_UNKNOWN");
      const { bridge, params } = await sessionParams("new"); rpc.preflightRequest("session/new", params);
      state.pending.push(input.source); flush(); const pending = { updates: [], bytes: 0 }; creating.set(input.source, pending);
      try {
        const result = await authenticatedRequest("session/new", params);
        if (!plain(result) || !boundedId(result.sessionId) || state.sessions.some(s => s.id === result.sessionId)) throw fail("RUNTIME_SESSION_ACCEPTANCE_UNKNOWN");
        assertCurrent();
        const session = { id: result.sessionId, source: input.source, cwd: workspace, createdAt: Date.now(), archived: false,
          turns: [], replay: [], metadata: acpSessionCatalogs(result, acpMetadata()) };
        for (const entry of pending.updates) {
          if (entry.sessionId !== session.id) throw fail("RUNTIME_PROTOCOL_INVALID");
          projectAcpUpdate(session, undefined, entry.update);
        }
        state.sessions.push(session); state.pending = state.pending.filter(source => source !== input.source); flush();
        await bridge?.bindSession?.(session.id); configured.set(session.id, input.developerInstructions || "");
        return { session: project(session) };
      } catch (error) { await bridge?.revoke?.(); throw error; }
      finally { creating.delete(input.source); }
    },
    async sessionResume(input) {
      assertCurrent(); checkPolicy(input); const session = find(input.sessionId);
      if (!configured.has(session.id)) {
        if (!host.agentCapabilities.loadSession && host.agentCapabilities.sessionCapabilities.resume === null) throw fail("RUNTIME_RECOVERY_UNAVAILABLE");
        if (active.has(session.id) || loads.has(session.id)) throw fail("RUNTIME_SESSION_BUSY");
        const { bridge, params } = await sessionParams("load", session.id);
        const replayId = `acp-load-${hash(session.id).slice(0, 32)}`;
        const replay = { session: { ...session, turns: JSON.parse(JSON.stringify(session.turns)), metadata: { ...acpMetadata(), compactions: JSON.parse(JSON.stringify(session.metadata.compactions || [])) } },
          turn: { id: replayId, items: [], sequence: 0, segments: {} } };
        loads.set(session.id, replay);
        try {
          const result = await authenticatedRequest(host.agentCapabilities.loadSession ? "session/load" : "session/resume", params);
          assertCurrent(); acpSessionCatalogs(result, replay.session.metadata);
          session.metadata = replay.session.metadata;
          for (const local of session.turns) {
            const restored = replay.session.turns.find(v => v.id === local.id);
            for (let n = 0; n < local.items.length; n++) {
              if (local.items[n].type !== "contextCompaction") continue;
              const patch = restored?.items.find(v => v.type === "contextCompaction" && v.id === local.items[n].id && v.compactionId === local.items[n].compactionId);
              if (patch) local.items[n] = JSON.parse(JSON.stringify(patch));
            }
          }
          // A portable ACP replay has no operation echo. Validate it separately
          // and never merge repeated text with locally attributed turns.
          if (host.agentCapabilities.loadSession && session.turns.length === 0) session.replay = replay.turn.items.length
            ? [{ id: replayId, status: "completed", itemsView: "full", items: replay.turn.items, provenance: "remote-replay" }] : [];
          flush(); await bridge?.bindSession?.(session.id);
        } catch (error) { await bridge?.revoke?.(); throw error; }
        finally { loads.delete(session.id); }
      }
      configured.set(session.id, input.developerInstructions || ""); return { session: project(session) };
    },
    sessionRead(input) { return { session: project(find(input.sessionId), input.includeTurns !== false, input.includeItems !== false) }; },
    sessionList(input = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.archived !== undefined && typeof input.archived !== "boolean")) throw fail("RUNTIME_SESSION_PARAMS_INVALID");
      const scope = input.archived === undefined ? "all" : input.archived ? "archived" : "active";
      const sessions = state.sessions.filter(s => input.archived === undefined || s.archived === input.archived);
      let start = 0;
      if (input.cursor != null) {
        if (typeof input.cursor !== "string" || !input.cursor.startsWith(`acp-list:${scope}:`)) throw fail("RUNTIME_SESSION_PARAMS_INVALID");
        const anchor = input.cursor.slice(`acp-list:${scope}:`.length);
        const index = sessions.findIndex(s => hash(s.id) === anchor);
        if (index < 0) throw fail("RUNTIME_SESSION_PARAMS_INVALID"); start = index + 1;
      }
      const page = sessions.slice(start, start + limit), last = page.at(-1);
      return { data: page.map(s => project(s, false)), nextCursor: last && start + page.length < sessions.length
        ? `acp-list:${scope}:${hash(last.id)}` : null };
    },
    sessionRename(input) { if (!boundedId(input.name)) throw fail("RUNTIME_SESSION_PARAMS_INVALID"); find(input.sessionId).name = input.name; flush(); return {}; },
    sessionArchive(input) { find(input.sessionId).archived = true; flush(); return {}; },
    sessionUnarchive(input) { find(input.sessionId).archived = false; flush(); return {}; },
    modelsList(input = {}) {
      const sessions = (input.sessionId ? [find(input.sessionId)] : state.sessions).filter(s => configured.has(s.id));
      const models = new Map(); for (const s of sessions) {
        const selector = modelSelector(s); if (!selector) continue;
        for (const m of selector.options.flatMap(value => Array.isArray(value.options) ? value.options : [value])) {
          models.set(m.value, { id: m.value, model: m.value, displayName: m.name, description: m.description || "",
            isDefault: m.value === selector.currentValue, hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: null });
        }
      }
      return { data: [...models.values()], nextCursor: null };
    },
    commandsList(input = {}) {
      const candidate = input.sessionId ? find(input.sessionId) : null;
      const s = candidate && configured.has(candidate.id) ? candidate : null;
      return { supported: !!s, reason: s ? null : "session_required", commands: normalizeRuntimeCommands(s?.metadata.commands || []).filter(command => command.name !== "compact") };
    },
    commandExecute(input) {
      const session = find(input.sessionId);
      if (!configured.has(session.id)) throw fail("RUNTIME_RECOVERY_UNAVAILABLE");
      const parsed = parseRuntimeCommand(input.text, normalizeRuntimeCommands(session.metadata.commands));
      if (!parsed || parsed.command.name === "compact") throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      return { kind: "send", text: parsed.text, warning: null };
    },
    async turnInterrupt(input) {
      const session = find(input.sessionId), a = active.get(session.id);
      if (!a || (input.turnId && input.turnId !== a.turn.id)) throw fail("RUNTIME_TURN_NOT_FOUND");
      a.canceled = true; host.acpBridge?.interruptTurn?.(a.dto);
      try { await rpc.notify("session/cancel", { sessionId: session.id }); } catch { /* process stop below */ }
      let graceTimer, terminal;
      try { terminal = await Promise.race([a.done, new Promise(resolve => { graceTimer = setTimeout(() => resolve(null), 1500); graceTimer.unref?.(); })]); }
      finally { clearTimeout(graceTimer); }
      if (terminal?.facts.terminal) {
        if (terminal.status !== "canceled") throw fail("RUNTIME_TURN_CANCEL_NOT_CONFIRMED");
        return {};
      }
      await confirmedStop();
      host.acpBridge?.finishTurn?.(a.dto); return { stopped: true };
    },
    async turnStart(input, observer) {
      assertCurrent(); checkPolicy(input); const session = find(input.sessionId);
      if (session.archived || input.cwd !== workspace || input.attachments?.length || !boundedId(input.operationId)) throw fail("RUNTIME_REQUIREMENT_UNSUPPORTED");
      if (observer && (!plain(observer) || observer.version !== 1 || !boundedId(observer.attemptId)
        || ["onPrepared", "onDispatchAttempt", "assertCurrent"].some(k => typeof observer[k] !== "function"))) throw fail("RUNTIME_OBSERVER_INVALID");
      const { signal, ...payload } = input;
      if (signal?.aborted) throw fail("RUNTIME_TURN_CANCELED");
      let turn = session.turns.find(t => t.operationId === input.operationId);
      const prepared = promptText(input, configured.get(session.id));
      const params = { sessionId: session.id, prompt: [{ type: "text", text: prepared.text }] };
      const encodedPromptFingerprint = hash(JSON.stringify(params));
      // The session's configured stable instructions are real input even when
      // the caller omits them from this turn DTO. Bind the exact wire encoding
      // as well as its stable version before an unsent attempt may be retried.
      // A cold Handle may verify an existing receipt from its durable hashes;
      // it still must resume/configure the session before any fresh dispatch.
      const receiptOnly = !configured.has(session.id) && input.developerInstructions === undefined && turn;
      const fingerprint = hash(JSON.stringify({ version: 2, input: acpData(payload),
        stableVersion: receiptOnly ? turn.contextDelivery.stableVersion : prepared.delivery.stableVersion,
        encodedPromptFingerprint: receiptOnly ? turn.contextDelivery.encodedPromptFingerprint : encodedPromptFingerprint }));
      if (turn) {
        if (turn.fingerprint !== fingerprint) throw fail("RUNTIME_OPERATION_CONFLICT");
        if (!turn.facts.notSent) {
          if (!turn.facts.terminal) { const error = fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN"); error.dispatchState = turn.facts.writeAttempted ? "write_attempted" : "not_sent";
            error.execution = execution({ ...turn, sessionId: session.id }); throw error; }
          return { turn: { id: turn.id, status: turn.status, items: turn.items }, execution: execution({ ...turn, sessionId: session.id }) };
        }
      }
      if (active.has(session.id) || session.turns.some(t => !t.facts.terminal && !t.facts.notSent)) throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
      const selector = modelSelector(session);
      if (input.model != null && (!boundedId(input.model) || !selector
        || !selector.options.flatMap(value => Array.isArray(value.options) ? value.options : [value]).some(value => value.value === input.model))) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      if (["reasoningEffort", "effort", "thinkingLevel", "serviceTier", "temperature", "topP", "maxTokens", "maxOutputTokens", "config"].some(key => input[key] != null)) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      const choice = selections(input, session);
      if (input.model != null) {
        if (choice.config.some(value => value.configId === selector.id && value.value !== input.model)) throw fail("RUNTIME_REQUIREMENT_UNSUPPORTED");
        if (!choice.config.some(value => value.configId === selector.id)) choice.config.push({ configId: selector.id, value: input.model });
      }
      if (!configured.has(session.id)) throw fail("RUNTIME_RECOVERY_UNAVAILABLE");
      prepared.delivery.encodedPromptFingerprint = encodedPromptFingerprint;
      for (const key of ["contextSnapshotId", "contextRevisions", "nativeMemoryVersion"]) {
        if (input[key] !== undefined) prepared.delivery[key] = JSON.parse(JSON.stringify(acpData(input[key], 64 * 1024)));
      }
      rpc.preflightRequest("session/prompt", params);
      if (turn) { turn.attemptId = observer?.attemptId || `attempt-${crypto.randomUUID()}`; turn.status = "inProgress";
        turn.contextDelivery = prepared.delivery;
        turn.facts.notSent = false; turn.facts.unknown = false; }
      else { turn = { id: `acp-${crypto.randomUUID()}`, operationId: input.operationId,
        attemptId: observer?.attemptId || `attempt-${crypto.randomUUID()}`, fingerprint, status: "inProgress", legacy: false,
        items: [], segments: {}, sequence: 0, contextDelivery: prepared.delivery,
        facts: { prepared: true, writeAttempted: false, frameWritten: false, remoteAccepted: false, terminal: false, unknown: false, notSent: false, stopReason: null } };
        session.turns.push(turn); }
      let resolveDone; const a = { turn, observer, signal, dto: observerDto(session, turn), canceled: false, savedSequence: 0,
        done: new Promise(resolve => { resolveDone = resolve; }) };
      try { flush(); } catch (cause) {
        turn.status = "notSent"; turn.facts.notSent = true;
        const error = fail(cause?.code || "RUNTIME_LEDGER_WRITE_FAILED"); error.dispatchState = "not_sent";
        error.execution = execution({ ...turn, sessionId: session.id }); throw error;
      }
      active.set(session.id, a); let terminalCommitted = false;
      const abort = () => { void handle.turnInterrupt({ sessionId: session.id, turnId: turn.id }).catch(() => {}); };
      signal?.addEventListener?.("abort", abort, { once: true });
      try {
        await observer?.onPrepared(a.dto); assertCurrent(a);
        await host.acpBridge?.prepareTurn?.(a.dto, { signal: input.signal, assertCurrent: () => assertCurrent(a) }); assertCurrent(a);
        if (choice.mode !== undefined && session.metadata.modes.currentModeId !== choice.mode) {
          const result = await authenticatedRequest("session/set_mode", { sessionId: session.id, modeId: choice.mode });
          if (!plain(result)) throw fail("RUNTIME_PROTOCOL_INVALID");
          assertCurrent(a); session.metadata.modes.currentModeId = choice.mode; flush();
        }
        for (const config of choice.config) {
          if (session.metadata.configOptions.find(v => v.id === config.configId)?.currentValue === config.value) continue;
          const result = await authenticatedRequest("session/set_config_option", { sessionId: session.id, configId: config.configId, value: config.value });
          if (!plain(result) || !Array.isArray(result.configOptions)) throw fail("RUNTIME_PROTOCOL_INVALID");
          assertCurrent(a); acpSessionCatalogs(result, session.metadata);
          if (session.metadata.configOptions.find(v => v.id === config.configId)?.currentValue !== config.value) throw fail("RUNTIME_PROTOCOL_INVALID");
          flush();
        }
        const result = await authenticatedRequest("session/prompt", params, { timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS,
          onWriteAttempt() {
            assertCurrent(a); turn.facts.writeAttempted = true; flush();
            syncCall(observer?.onDispatchAttempt, a.dto); assertCurrent(a);
            syncCall(host.acpBridge?.dispatchAttempt?.bind(host.acpBridge), a.dto); assertCurrent(a);
          },
          onWritten() { if (failed) return; turn.facts.frameWritten = true; flush(); } });
        if (failed || !plain(result) || !TERMINALS.has(result.stopReason)) throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
        // Matched terminal response is authoritative even when cancellation
        // raced its arrival; it does not authorize any later callback/write.
        host.assertRuntimeIdentityCurrent?.();
        if (result.stopReason !== "cancelled") cacheAuthentication("authenticated");
        turn.facts.writeAttempted = true; turn.facts.remoteAccepted = true; turn.facts.terminal = true;
        turn.facts.stopReason = result.stopReason; turn.facts.unknown = false;
        turn.status = result.stopReason === "end_turn" ? "completed" : result.stopReason === "cancelled" ? "canceled" : "failed";
        // Full stable context is resent until retention is independently proven.
        // The successful version is recorded as a receipt, never an omission gate.
        turn.contextDelivery.confirmed = ["end_turn", "max_tokens", "max_turn_requests"].includes(result.stopReason);
        const finalContent = sealAcpContent(session, turn); flush(); terminalCommitted = true;
        host.acpBridge?.finishTurn?.(a.dto);
        for (const event of finalContent) emit(event);
        emit({ type: "complete", sessionId: session.id, turnId: turn.id, status: turn.status, stopReason: result.stopReason });
        return { turn: { id: turn.id, status: turn.status, items: turn.items }, execution: execution({ ...turn, sessionId: session.id }) };
      } catch (cause) {
        const attempted = turn.facts.writeAttempted;
        if (!terminalCommitted) turn.facts.terminal = false;
        turn.facts.unknown = attempted; turn.facts.notSent = !attempted;
        // A terminal fact whose durable write failed cannot be published as a
        // success. Its next reader must encounter unknown until reconciled.
        if (attempted && !turn.facts.terminal) turn.status = "unknown";
        else if (!attempted) turn.status = "notSent";
        try { flush(); } catch { turn.facts.terminal = false; turn.facts.unknown = true; turn.status = "unknown"; retire(); }
        if (!attempted) host.acpBridge?.interruptTurn?.(a.dto);
        let stopUnconfirmed = false;
        if (attempted && /(?:REQUEST_TIMEOUT|EXECUTION_TIMEOUT)$/u.test(cause?.code || "")) {
          a.canceled = true; host.acpBridge?.interruptTurn?.(a.dto);
          try { await rpc.notify("session/cancel", { sessionId: session.id }); } catch {}
          try { await confirmedStop(); host.acpBridge?.finishTurn?.(a.dto); } catch { stopUnconfirmed = true; }
        }
        const error = fail(stopUnconfirmed ? "RUNTIME_STOP_UNCONFIRMED" : attempted ? "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" : (cause?.code || "RUNTIME_TURN_NOT_SENT"));
        error.dispatchState = attempted ? "write_attempted" : "not_sent";
        error.execution = execution({ ...turn, sessionId: session.id }); throw error;
      } finally { signal?.removeEventListener?.("abort", abort); active.delete(session.id); resolveDone(turn); }
    },
    contextUsage({ sessionId }) { return find(sessionId).metadata.contextUsage || unknownRuntimeContextUsage(sessionId); },
  };
  host.pauseManagedToolTimeout = input => handle.pauseManagedToolTimeout(input);
  return handle;
}
module.exports = { createAcpHandle };
