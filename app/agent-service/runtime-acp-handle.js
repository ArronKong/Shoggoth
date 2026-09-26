"use strict";
const crypto = require("node:crypto"), path = require("node:path");
const { runtimeCapabilities } = require("./runtime-adapter");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");
const fail = code => serviceError(code, "ACP execution could not be confirmed");
const boundedId = value => typeof value === "string" && value.length > 0 && value.length <= 512 && value.isWellFormed() && !value.includes("\0");
function validateLedger(state, workspace) {
  const invalid = () => { throw fail("RUNTIME_LEDGER_INVALID"); };
  if (!state || Object.keys(state).sort().join() !== "pending,sessions,version" || state.version !== 1
    || !Array.isArray(state.sessions) || state.sessions.length > 4096 || !Array.isArray(state.pending) || state.pending.length > 4096
    || !state.pending.every(boundedId) || new Set(state.pending).size !== state.pending.length) invalid();
  const sessions = new Set(), sources = new Set();
  for (const session of state.sessions) {
    if (!session || Object.keys(session).sort().join() !== (Object.hasOwn(session, "name")
      ? "archived,createdAt,cwd,id,name,source,turns" : "archived,createdAt,cwd,id,source,turns")
      || !boundedId(session.id) || !boundedId(session.source) || sessions.has(session.id) || sources.has(session.source)
      || session.cwd !== workspace || !Number.isSafeInteger(session.createdAt) || session.createdAt < 0
      || typeof session.archived !== "boolean" || !Array.isArray(session.turns) || session.turns.length > 65536
      || (session.name !== undefined && !boundedId(session.name)) || state.pending.includes(session.source)) invalid();
    sessions.add(session.id); sources.add(session.source); const operations = new Set(), turns = new Set();
    for (const turn of session.turns) {
      if (!turn || Object.keys(turn).sort().join() !== "fingerprint,id,operationId,status,text"
        || !boundedId(turn.id) || !boundedId(turn.operationId) || operations.has(turn.operationId) || turns.has(turn.id)
        || !/^[a-f0-9]{64}$/u.test(turn.fingerprint) || !["inProgress", "completed", "canceled", "failed"].includes(turn.status)
        || typeof turn.text !== "string" || !turn.text.isWellFormed() || Buffer.byteLength(turn.text) > 512 * 1024) invalid();
      operations.add(turn.operationId); turns.add(turn.id);
    }
  }
  return state;
}
async function createAcpHandle({ binding, rpc, home, workspace, stateDir, trustedRoot, stop, terminated }) {
  const key = crypto.createHash("sha256").update(JSON.stringify([binding, workspace])).digest("hex");
  const file = path.join(stateDir, "runtime-acp-ledgers", key + ".json");
  if (recoverInterruptedPrivateFile(file, { trustedRoot }) === "uncertain") throw fail("RUNTIME_LEDGER_UNCERTAIN");
  const state = lstatIfExists(file) ? JSON.parse(readPrivateFile(file, { maxBytes: 16 * 1024 * 1024 })) : { version: 1, sessions: [], pending: [] };
  validateLedger(state, workspace);
  const save = () => { const bytes = JSON.stringify(validateLedger(state, workspace)); if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw fail("RUNTIME_LEDGER_FULL");
    atomicWritePrivateFile(file, bytes + "\n", { trustedRoot }); };
  const listeners = new Set(), active = new Map(), configured = new Map();
  const emit = value => { for (const listener of listeners) listener({ known: true, method: "session/update", ...value }); };
  const find = id => { const session = state.sessions.find(s => s.id === id); if (!session || session.cwd !== workspace) throw fail("RUNTIME_SESSION_NOT_FOUND"); return session; };
  const project = session => ({ id: session.id, source: session.source, cwd: session.cwd, archived: session.archived,
    createdAt: session.createdAt, updatedAt: session.createdAt, turns: session.turns.map(turn => ({ id: turn.id, status: turn.status,
      items: [{ id: `${turn.id}-user`, type: "userMessage", clientId: turn.operationId },
        ...(turn.text ? [{ id: `${turn.id}-answer`, type: "agentMessage", text: turn.text, phase: "final_answer" }] : [])] })) });
  rpc.subscribe(message => {
    if (message.method !== "session/update") return;
    const { sessionId, update } = message.params || {}, turn = active.get(sessionId);
    if (!turn || !update) return;
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (update.content?.type !== "text" || typeof update.content.text !== "string") return;
      if (update.sessionUpdate === "agent_message_chunk") {
        turn.text += update.content.text;
        if (Buffer.byteLength(turn.text) > 512 * 1024) { void stop(); return; }
      }
      emit({ type: update.sessionUpdate === "agent_message_chunk" ? "text_delta" : "reasoning_delta", sessionId, turnId: turn.id,
        itemId: `${turn.id}-answer`, delta: update.content.text });
    }
  });
  // Generic ACP runs only in explicitly authorized full-access mode. Reject
  // every unrecognized reverse capability; never provide client fs/terminal.
  rpc.registerServerRequestHandler("session/request_permission", params => {
    if (!active.has(params.sessionId) || !Array.isArray(params.options)) return { outcome: { outcome: "cancelled" } };
    const option = params.options.find(item => item.kind === "allow_once" && typeof item.optionId === "string");
    return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
  });
  const hello = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "shoggoth", version: "1" } });
  if (hello.protocolVersion !== 1) throw fail("RUNTIME_PROTOCOL_INVALID");
  const caps = runtimeCapabilities({ "session.start": true, "session.resume": true, "session.read": true, "session.list": true,
    "session.rename": true, "session.archive": true, "session.unarchive": true, "turn.start": true, "turn.interrupt": true,
    "models.list": true, "commands.list": true, events: true });
  const handle = { ...binding, homeIdentity: home, workspace, capabilities: caps, terminated, stop,
    authenticationState: () => ({ authenticated: !hello.authMethods?.length, credentialPresent: false }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async sessionStart(input) {
      if (input.cwd !== workspace || !boundedId(input.source)) throw fail("RUNTIME_SESSION_PARAMS_INVALID");
      const existing = state.sessions.find(s => s.source === input.source); if (existing) return { session: project(existing) };
      if (state.pending.includes(input.source)) throw fail("RUNTIME_SESSION_ACCEPTANCE_UNKNOWN");
      const params = { cwd: workspace, mcpServers: [] }; rpc.preflightRequest("session/new", params);
      state.pending.push(input.source); save();
      const result = await rpc.request("session/new", params);
      if (!boundedId(result.sessionId) || state.sessions.some(s => s.id === result.sessionId)) throw fail("RUNTIME_SESSION_ACCEPTANCE_UNKNOWN");
      const session = { id: result.sessionId, source: input.source, cwd: workspace, createdAt: Date.now(), archived: false, turns: [] };
      state.sessions.push(session); state.pending = state.pending.filter(source => source !== input.source); save();
      configured.set(session.id, input.developerInstructions || "");
      return { session: project(session) };
    },
    async sessionResume(input) {
      const session = find(input.sessionId);
      if (!configured.has(session.id)) {
        if (!hello.agentCapabilities?.loadSession) throw fail("RUNTIME_RECOVERY_UNAVAILABLE");
        await rpc.request("session/load", { sessionId: session.id, cwd: workspace, mcpServers: [] });
      }
      configured.set(session.id, input.developerInstructions || ""); return { session: project(session) };
    },
    sessionRead(input) { const session = find(input.sessionId);
      if (session.turns.some(turn => turn.status === "inProgress" && !active.has(session.id))) throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
      return { session: project(session) }; },
    sessionList() { return { data: state.sessions.map(project), nextCursor: null }; },
    sessionRename(input) { find(input.sessionId).name = input.name; save(); return {}; },
    sessionArchive(input) { find(input.sessionId).archived = true; save(); return {}; },
    sessionUnarchive(input) { find(input.sessionId).archived = false; save(); return {}; },
    modelsList() { return { data: [], nextCursor: null }; }, commandsList() { return { commands: [] }; },
    turnInterrupt(input) { find(input.sessionId); return rpc.notify("session/cancel", { sessionId: input.sessionId }).then(() => ({})); },
    async turnStart(input) {
      const session = find(input.sessionId);
      if (session.archived || input.cwd !== workspace || input.attachments?.length || input.model || !boundedId(input.operationId)) throw fail("RUNTIME_REQUIREMENT_UNSUPPORTED");
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const existing = session.turns.find(turn => turn.operationId === input.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw fail("RUNTIME_OPERATION_CONFLICT");
        if (existing.status === "inProgress") throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
        return { turn: { id: existing.id, status: existing.status } };
      }
      if (active.has(session.id) || session.turns.some(turn => turn.status === "inProgress")) throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
      const text = [configured.get(session.id), input.context, input.prompt || input.text || (Array.isArray(input.input)
        ? input.input.map(item => item.text || "").join("\n") : "")].filter(Boolean).join("\n\n");
      const params = { sessionId: session.id, prompt: [{ type: "text", text }] }; rpc.preflightRequest("session/prompt", params);
      const turn = { id: `acp-${crypto.randomUUID()}`, operationId: input.operationId, fingerprint, status: "inProgress", text: "" };
      session.turns.push(turn); save(); active.set(session.id, turn);
      // The durable receipt precedes every possible write. Return acceptance
      // only after this exact prompt response; interim events are buffered by
      // the coordinator until the turn identity has been bound.
      try {
        const result = await rpc.request("session/prompt", params);
        if (!["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(result.stopReason)) throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
        turn.status = result.stopReason === "end_turn" ? "completed" : result.stopReason === "cancelled" ? "canceled" : "failed"; save();
        if (turn.text) emit({ type: "text", sessionId: session.id, turnId: turn.id,
          itemId: `${turn.id}-answer`, text: turn.text, phase: "final_answer" });
        emit({ type: "complete", sessionId: session.id, turnId: turn.id, status: turn.status });
        return { turn: { id: turn.id, status: turn.status, items: [] } };
      } catch { save(); throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN"); }
      finally { active.delete(session.id); }
    },
  };
  return handle;
}
module.exports = { createAcpHandle };
