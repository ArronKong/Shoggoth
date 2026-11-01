"use strict";
const crypto = require("node:crypto"), path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");
const MAX_BYTES = 16 * 1024 * 1024;
// Per-run ACP hosts in one Service must share one synchronous authority.
const stores = new Map();
const invalid = () => { throw serviceError("RUNTIME_LEDGER_INVALID", "ACP execution ledger is invalid"); };
const id = v => typeof v === "string" && v.length > 0 && v.length <= 512 && v.isWellFormed() && !v.includes("\0");
const plain = v => v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).sort().join() === [...keys].sort().join();
const digest = v => crypto.createHash("sha256").update(v).digest("hex");
function safeData(value, maxBytes = 2 * 1024 * 1024) {
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > 25000 || depth > 24) invalid();
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
    if (typeof v === "string") { if (!v.isWellFormed() || v.includes("\0")) invalid(); return; }
    if (!plain(v) && !Array.isArray(v)) invalid();
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === "length") continue;
      const p = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== "string" || !p?.enumerable || !Object.hasOwn(p, "value")) invalid();
      walk(p.value, depth + 1);
    }
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) invalid();
  return value;
}
const metadata = () => ({ models: null, modes: null, commands: [], configOptions: [], contextUsage: null, compactions: [], revision: 0 });
function validateV1(state, workspace) {
  if (!exact(state, ["version", "sessions", "pending"]) || state.version !== 1 || !Array.isArray(state.sessions)
    || state.sessions.length > 4096 || !Array.isArray(state.pending) || state.pending.length > 4096
    || !state.pending.every(id) || new Set(state.pending).size !== state.pending.length) invalid();
  const sessions = new Set(), sources = new Set();
  for (const s of state.sessions) {
    if (!exact(s, ["id", "source", "cwd", "createdAt", "archived", "turns", ...(Object.hasOwn(s, "name") ? ["name"] : [])])
      || !id(s.id) || !id(s.source) || sessions.has(s.id) || sources.has(s.source) || s.cwd !== workspace
      || !Number.isSafeInteger(s.createdAt) || s.createdAt < 0 || typeof s.archived !== "boolean"
      || (s.name !== undefined && !id(s.name)) || !Array.isArray(s.turns) || s.turns.length > 65536
      || state.pending.includes(s.source)) invalid();
    sessions.add(s.id); sources.add(s.source); const ops = new Set(), turns = new Set();
    for (const t of s.turns) {
      if (!exact(t, ["fingerprint", "id", "operationId", "status", "text"]) || !id(t.id) || !id(t.operationId)
        || ops.has(t.operationId) || turns.has(t.id) || !/^[a-f0-9]{64}$/u.test(t.fingerprint)
        || !["inProgress", "completed", "canceled", "failed"].includes(t.status)
        || typeof t.text !== "string" || !t.text.isWellFormed() || Buffer.byteLength(t.text) > 512 * 1024) invalid();
      ops.add(t.operationId); turns.add(t.id);
    }
  }
  return state;
}
function validateV2(state, workspace) {
  if (!exact(state, ["version", "sessions", "pending"]) || state.version !== 2 || !Array.isArray(state.sessions)
    || state.sessions.length > 4096 || !Array.isArray(state.pending) || state.pending.length > 4096
    || !state.pending.every(id) || new Set(state.pending).size !== state.pending.length) invalid();
  const sessions = new Set(), sources = new Set();
  for (const s of state.sessions) {
    if (!exact(s, ["id", "source", "cwd", "createdAt", "archived", "turns", "metadata", "replay", ...(Object.hasOwn(s, "name") ? ["name"] : [])])
      || !id(s.id) || !id(s.source) || sessions.has(s.id) || sources.has(s.source) || state.pending.includes(s.source)
      || s.cwd !== workspace || !Number.isSafeInteger(s.createdAt) || s.createdAt < 0 || typeof s.archived !== "boolean"
      || (s.name !== undefined && !id(s.name)) || !Array.isArray(s.turns) || s.turns.length > 65536
      || !Array.isArray(s.replay) || s.replay.length > 4096 || !plain(s.metadata)) invalid();
    safeData(s.metadata); safeData(s.replay);
    sessions.add(s.id); sources.add(s.source); const ops = new Set(), turns = new Set();
    for (const t of s.turns) {
      if (!exact(t, ["id", "operationId", "attemptId", "fingerprint", "status", "items", "segments", "sequence", "facts", "contextDelivery", "legacy"])
        || !id(t.id) || !id(t.operationId) || !id(t.attemptId) || ops.has(t.operationId) || turns.has(t.id)
        || !/^[a-f0-9]{64}$/u.test(t.fingerprint) || !["inProgress", "completed", "canceled", "failed", "unknown", "notSent"].includes(t.status)
        || typeof t.legacy !== "boolean" || !Array.isArray(t.items) || t.items.length > 4096
        || !plain(t.segments) || !Number.isSafeInteger(t.sequence) || t.sequence < 0 || !plain(t.contextDelivery)
        || !exact(t.facts, ["prepared", "writeAttempted", "frameWritten", "remoteAccepted", "terminal", "unknown", "notSent", "stopReason"])
        || ["prepared", "writeAttempted", "frameWritten", "remoteAccepted", "terminal", "unknown", "notSent"].some(k => typeof t.facts[k] !== "boolean")
        || !t.facts.prepared || (t.facts.frameWritten && !t.facts.writeAttempted) || (t.facts.remoteAccepted && !t.facts.writeAttempted)
        || (t.facts.terminal && !t.legacy && !t.facts.remoteAccepted) || (t.facts.notSent && t.facts.writeAttempted)
        || (t.facts.stopReason !== null && !id(t.facts.stopReason))) invalid();
      safeData(t.items); safeData(t.segments); safeData(t.contextDelivery);
      const itemIds = new Set(); for (const item of t.items) {
        if (!plain(item) || !id(item.id) || !id(item.type) || itemIds.has(item.id)) invalid();
        itemIds.add(item.id);
        // Operation IDs are local delivery keys, never remote echoes.
        if (item.type === "userMessage" && Object.hasOwn(item, "clientId")) invalid();
      }
      ops.add(t.operationId); turns.add(t.id);
    }
  }
  return state;
}
function migrateV1(state, workspace) {
  validateV1(state, workspace);
  return { version: 2, pending: [...state.pending], sessions: state.sessions.map(s => ({ ...s, metadata: metadata(), replay: [],
    turns: s.turns.map(t => {
      const terminal = t.status !== "inProgress";
      return { id: t.id, operationId: t.operationId, attemptId: `legacy-${t.id}`, fingerprint: t.fingerprint,
        status: terminal ? t.status : "unknown", legacy: true, sequence: t.text ? 1 : 0, segments: {},
        items: t.text ? [{ id: `${t.id}-answer`, type: "agentMessage", text: t.text, phase: "final_answer" }] : [],
        // V1 proves a local receipt only. Neither its synthesized userMessage
        // nor its completion status establishes the remote write/accept facts.
        facts: { prepared: true, writeAttempted: !terminal, frameWritten: false, remoteAccepted: false,
          terminal, unknown: !terminal, notSent: false, stopReason: null }, contextDelivery: { reused: false, legacy: true } };
    }) })) };
}
function openAcpLedger({ binding, workspace, stateDir, trustedRoot, writer = atomicWritePrivateFile }) {
  const file = path.join(stateDir, "runtime-acp-ledgers", digest(JSON.stringify([binding, workspace])) + ".json");
  const lease = store => {
    store.assertFileCurrent(); store.refs += 1; let released = false;
    return { state: store.state, file, save() {
      if (released) throw serviceError("RUNTIME_LEDGER_OWNER_CLOSED", "ACP execution ledger owner terminated");
      return store.save();
    }, release() {
      if (released) return; released = true;
      if (--store.refs === 0 && stores.get(file) === store) stores.delete(file);
    } };
  };
  if (stores.has(file)) return lease(stores.get(file));
  const recover = target => { if (recoverInterruptedPrivateFile(target, { trustedRoot }) === "uncertain") {
    throw serviceError("RUNTIME_LEDGER_UNCERTAIN", "ACP execution ledger recovery is uncertain"); } };
  recover(file);
  const original = `${file}.v1-original`, receiptFile = `${file}.migration-v2.json`;
  const originalBytes = lstatIfExists(file) ? readPrivateFile(file, { maxBytes: MAX_BYTES }) : null;
  let state = originalBytes ? JSON.parse(originalBytes) : { version: 2, sessions: [], pending: [] };
  if (state.version === 1) {
    validateV1(state, workspace); const bytes = originalBytes, beforeHash = digest(bytes);
    recover(original); recover(receiptFile);
    if (lstatIfExists(original)) {
      if (digest(readPrivateFile(original, { maxBytes: MAX_BYTES })) !== beforeHash) invalid();
    } else writer(original, bytes, { trustedRoot });
    const next = migrateV1(state, workspace), afterHash = digest(JSON.stringify(next) + "\n");
    const receipt = { version: 1, fromVersion: 1, toVersion: 2, beforeHash, afterHash, status: "prepared" };
    if (lstatIfExists(receiptFile)) {
      const old = JSON.parse(readPrivateFile(receiptFile, { maxBytes: 4096 }));
      if (!exact(old, Object.keys(receipt)) || old.beforeHash !== beforeHash || old.afterHash !== afterHash
        || !["prepared", "committed"].includes(old.status)) invalid();
    }
    writer(receiptFile, JSON.stringify(receipt) + "\n", { trustedRoot });
    writer(file, JSON.stringify(validateV2(next, workspace)) + "\n", { trustedRoot });
    writer(receiptFile, JSON.stringify({ ...receipt, status: "committed" }) + "\n", { trustedRoot });
    state = next;
  } else if (state.version === 2 && lstatIfExists(receiptFile)) {
    // A committed V2 file wins even when the final receipt write was interrupted.
    // Never restore the saved V1 over newer execution facts.
    recover(receiptFile); const receipt = JSON.parse(readPrivateFile(receiptFile, { maxBytes: 4096 }));
    if (!plain(receipt) || receipt.version !== 1 || receipt.fromVersion !== 1 || receipt.toVersion !== 2
      || !["prepared", "committed"].includes(receipt.status) || !lstatIfExists(original)
      || digest(readPrivateFile(original, { maxBytes: MAX_BYTES })) !== receipt.beforeHash) invalid();
    if (receipt.status === "prepared") writer(receiptFile, JSON.stringify({ ...receipt, status: "committed" }) + "\n", { trustedRoot });
  }
  validateV2(state, workspace);
  let expectedStat = lstatIfExists(file), expectedHash = expectedStat ? digest(readPrivateFile(file, { maxBytes: MAX_BYTES })) : null;
  const assertFileCurrent = () => {
    const actual = lstatIfExists(file);
    if (!!actual !== !!expectedStat || (actual && (actual.dev !== expectedStat.dev || actual.ino !== expectedStat.ino
      || digest(readPrivateFile(file, { maxBytes: MAX_BYTES })) !== expectedHash))) {
      throw serviceError("RUNTIME_LEDGER_CHANGED", "ACP execution ledger changed outside its owner");
    }
  };
  const save = () => { assertFileCurrent(); const bytes = JSON.stringify(validateV2(state, workspace)) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw serviceError("RUNTIME_LEDGER_FULL", "ACP execution ledger is full");
    writer(file, bytes, { trustedRoot }); expectedStat = lstatIfExists(file); expectedHash = digest(bytes); };
  // Once all actual owning processes terminated, a fresh acquisition reads the
  // file again. Durable absence of a write marker is proof of never-dispatched;
  // a marker without a terminal stays unknown even when zero events arrived.
  let recovered = false;
  for (const session of state.sessions) for (const turn of session.turns) {
    if (turn.facts.terminal || turn.legacy) continue;
    const attempted = turn.facts.writeAttempted;
    if (turn.status !== (attempted ? "unknown" : "notSent") || turn.facts.unknown !== attempted || turn.facts.notSent !== !attempted) {
      turn.status = attempted ? "unknown" : "notSent"; turn.facts.unknown = attempted; turn.facts.notSent = !attempted; recovered = true;
    }
  }
  if (recovered) save();
  const store = { state, save, file, refs: 0, assertFileCurrent }; stores.set(file, store); return lease(store);
}
module.exports = { openAcpLedger, validateAcpLedgerV1: validateV1, validateAcpLedgerV2: validateV2,
  migrateAcpLedgerV1: migrateV1, acpMetadata: metadata, acpData: safeData, acpId: id, acpPlain: plain };
