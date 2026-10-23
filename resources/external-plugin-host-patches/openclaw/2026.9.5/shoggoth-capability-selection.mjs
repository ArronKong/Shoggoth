// Shoggoth compatibility contract v1. This module is host control data only.
// No selection envelope, dispatch reference, proof, or journal enters model input.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { l as isPluginRecordActive } from './registry-lifecycle-FQWvWEID.mjs';

const registrations = new WeakMap();
const runtimeInstanceId = randomUUID();
const runBindings = new Map();
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const envelopeKeys = ['version', 'operationId', 'dispatchRef', 'selectionDigest', 'requiredAdapterId', 'adapterGeneration'];
const digest = text => createHash('sha256').update(text).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const recordObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSelectionEnvelope(value, operationId) {
  if (!recordObject(value) || Object.keys(value).length !== envelopeKeys.length
      || !envelopeKeys.every(key => Object.hasOwn(value, key)) || value.version !== 1
      || !opaque.test(value.operationId) || value.operationId !== operationId
      || !reference.test(value.dispatchRef) || !/^[a-f0-9]{64}$/.test(value.selectionDigest)
      || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.requiredAdapterId)
      || !opaque.test(value.adapterGeneration)) throw failure('CAPABILITY_SELECTION_INVALID');
  return Object.freeze(Object.fromEntries(envelopeKeys.map(key => [key, value[key]])));
}

function trustMatches(record) {
  try {
    const trustFile = process.env.OPENCLAW_SELECTION_TRUST_PATH;
    if (!trustFile || fs.statSync(trustFile).size > 4096) return false;
    const trust = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
    const source = fs.realpathSync(record.source);
    return trust.version === 1 && trust.adapterId === record.id
      && source === fs.realpathSync(trust.sourcePath)
      && /^[a-f0-9]{64}$/.test(trust.sourceSha256)
      && digest(fs.readFileSync(source)) === trust.sourceSha256;
  } catch { return false; }
}

// Called by the actual host plugin API builder with its own plugin record.
// The caller cannot choose another record, ID, or registration generation.
export function registerSelectionGate(record, handler, metadata) {
  if (!recordObject(metadata) || Object.keys(metadata).some(key => !["instanceId", "onTerminal"].includes(key)) || !opaque.test(metadata.instanceId) || typeof metadata.onTerminal !== "function") throw failure("CAPABILITY_SELECTION_ADAPTER_METADATA_INVALID");
  if (typeof handler !== 'function' || !trustMatches(record)) throw failure('CAPABILITY_SELECTION_ADAPTER_UNTRUSTED');
  if (registrations.has(record)) throw failure('CAPABILITY_SELECTION_ADAPTER_DUPLICATE');
  const registration = Object.freeze({ adapterId: record.id, adapterGeneration: randomUUID(), instanceId: metadata.instanceId, handler, onTerminal: metadata.onTerminal });
  registrations.set(record, registration);
  return Object.freeze({ version: 1, adapterId: registration.adapterId, adapterGeneration: registration.adapterGeneration, instanceId: registration.instanceId });
}

function currentRegistration(registry, adapterId) {
  const records = registry?.plugins?.filter(item => item.id === adapterId && item.status === 'loaded' && isPluginRecordActive(registry, item)) ?? [];
  if (records.length !== 1 || !trustMatches(records[0])) throw failure('CAPABILITY_SELECTION_ADAPTER_UNAVAILABLE');
  const registration = registrations.get(records[0]);
  if (!registration) throw failure('CAPABILITY_SELECTION_ADAPTER_UNAVAILABLE');
  return registration;
}

export function selectionCapabilities(registry) {
  const adapters = [];
  for (const record of registry?.plugins ?? []) {
    try {
      const registration = currentRegistration(registry, record.id);
      adapters.push({ adapterId: registration.adapterId, adapterGeneration: registration.adapterGeneration, instanceId: registration.instanceId });
    } catch { /* Untrusted or absent registrations are never advertised. */ }
  }
  return { version: 1, host: 'openclaw', hostVersion: '2026.9.5', wire: 'capabilitySelection',
    receiptMethod: 'chat.selection.get', supportedQueueModes: ['followup'], supportedHarnesses: ['openclaw'], adapters };
}

export function assertSelectionRegistration(envelope, registry) {
  if (!envelope) return;
  const registration = currentRegistration(registry, envelope.requiredAdapterId);
  if (registration.adapterGeneration !== envelope.adapterGeneration) throw failure('CAPABILITY_SELECTION_GENERATION_CHANGED');
}

function journalDirectory() {
  const state = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  const directory = path.join(state, 'shoggoth-capability-selection-v1');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
function journalFile(operationId) { return path.join(journalDirectory(), `${digest(operationId)}.json`); }
function readRecord(operationId) {
  if (!opaque.test(operationId)) throw failure('CAPABILITY_SELECTION_OPERATION_INVALID');
  const file = journalFile(operationId);
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 16384) throw failure('CAPABILITY_SELECTION_JOURNAL_INVALID');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== 1 || record.envelope?.operationId !== operationId) throw failure('CAPABILITY_SELECTION_JOURNAL_INVALID');
  validateSelectionEnvelope(record.envelope, operationId);
  return record;
}
function writeRecord(record) {
  const file = journalFile(record.envelope.operationId);
  if (!fs.existsSync(file) && fs.readdirSync(journalDirectory()).filter(name => name.endsWith('.json')).length >= 10000)
    throw failure('CAPABILITY_SELECTION_JOURNAL_FULL');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  const directoryFd = fs.openSync(journalDirectory(), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}
function canRead(record, client) {
  const device = client?.connect?.device?.id;
  return record.ownerDeviceId ? typeof device === 'string' && device === record.ownerDeviceId
    : typeof client?.connId === 'string' && client.connId === record.ownerConnId;
}
function receipt(record) {
  return { ...record.envelope, agentId: record.agentId, sessionKey: record.sessionKey,
    sessionId: record.sessionId, clientRunId: record.clientRunId, actualRunId: record.actualRunId,
    ...record.errorCode ? { errorCode: record.errorCode } : {}, status: record.runtimeInstanceId !== runtimeInstanceId && !['completed', 'blocked', 'failed', 'aborted'].includes(record.status)
      ? 'needs-verification' : record.status, acceptedAt: record.acceptedAt, updatedAt: record.updatedAt };
}

// Durable retry protection runs before native admission, including omitted envelopes.
export function replaySelectionRequest({ envelope, operationId, requestIdentity, sessionKey, agentId, client }) {
  if (!opaque.test(operationId)) { if (envelope) throw failure('CAPABILITY_SELECTION_OPERATION_INVALID'); return null; }
  const existing = readRecord(operationId);
  if (!existing) return null;
  if (!envelope || existing.requestIdentity !== requestIdentity || JSON.stringify(existing.envelope) !== JSON.stringify(envelope)
      || existing.sessionKey !== sessionKey || existing.agentId !== agentId || !canRead(existing, client))
    throw failure('CAPABILITY_SELECTION_OPERATION_CONFLICT');
  return { runId: existing.clientRunId, status: 'accepted', replayed: true, capabilitySelection: receipt(existing) };
}

export function acceptSelection({ envelope, requestIdentity, identity, client }) {
  if (!envelope) return null;
  validateSelectionEnvelope(envelope, identity.operationId);
  if (!identity.agentId || !identity.sessionId || !identity.sessionKey || !client?.connId)
    throw failure('CAPABILITY_SELECTION_IDENTITY_UNAVAILABLE');
  const existing = readRecord(envelope.operationId);
  if (existing) throw failure('CAPABILITY_SELECTION_OPERATION_CONFLICT');
  const now = Date.now();
  const record = { version: 1, envelope, requestIdentity, ...identity, clientRunId: identity.operationId,
    actualRunId: null, status: 'accepted', ownerConnId: client.connId,
    ownerDeviceId: client.connect?.device?.id ?? null, runtimeInstanceId, acceptedAt: now, updatedAt: now };
  writeRecord(record);
  return receipt(record);
}

export function querySelection(params, client) {
  if (!recordObject(params) || Object.keys(params).some(key => !['operationId', 'sessionKey', 'agentId'].includes(key))
      || !opaque.test(params.operationId) || typeof params.sessionKey !== 'string') throw failure('CAPABILITY_SELECTION_QUERY_INVALID');
  const record = readRecord(params.operationId);
  if (!record) return null;
  if (record.sessionKey !== params.sessionKey || params.agentId && record.agentId !== params.agentId || !canRead(record, client))
    throw failure('CAPABILITY_SELECTION_QUERY_FORBIDDEN');
  return receipt(record);
}

export function markSelection(envelope, status, errorCode) {
  if (!envelope) return;
  const record = readRecord(envelope.operationId);
  if (!record || JSON.stringify(record.envelope) !== JSON.stringify(envelope)) throw failure('CAPABILITY_SELECTION_OPERATION_CONFLICT');
  if (['completed', 'blocked', 'failed', 'aborted'].includes(record.status)) return;
  record.status = status; if (typeof errorCode === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(errorCode)) record.errorCode = errorCode; record.updatedAt = Date.now(); writeRecord(record);
}

function assertIdentity(record, identity) {
  if (record.agentId !== identity.agentId || record.sessionKey !== identity.sessionKey || record.sessionId !== identity.sessionId
      || record.envelope.operationId !== identity.operationId || !opaque.test(identity.actualRunId))
    throw failure('CAPABILITY_SELECTION_IDENTITY_MISMATCH');
  if (record.actualRunId && record.actualRunId !== identity.actualRunId) throw failure('CAPABILITY_SELECTION_RUN_CONFLICT');
}

export async function enforceSelection(envelope, identity, registry) {
  if (!envelope) return;
  envelope = validateSelectionEnvelope(envelope, identity.operationId);
  const record = readRecord(envelope.operationId);
  if (!record || JSON.stringify(record.envelope) !== JSON.stringify(envelope) || record.runtimeInstanceId !== runtimeInstanceId)
    throw failure('CAPABILITY_SELECTION_DISPATCH_UNAVAILABLE');
  assertIdentity(record, identity);
  record.actualRunId = identity.actualRunId; record.status = 'binding'; record.updatedAt = Date.now(); writeRecord(record);
  try {
    assertSelectionRegistration(envelope, registry);
    const registration = currentRegistration(registry, envelope.requiredAdapterId);
    const proofExpected = Object.freeze({ ...envelope, ...identity });
    const gateRequest = Object.freeze({ capabilitySelection: envelope, identity: Object.freeze({ ...identity }) });
    let timer;
    const result = await Promise.race([Promise.resolve().then(() => registration.handler(gateRequest)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('CAPABILITY_SELECTION_GATE_TIMEOUT')), 5000); })])
      .finally(() => clearTimeout(timer));
    if (!recordObject(result) || Object.keys(result).length !== 2 || !Object.hasOwn(result, 'proof') || !Object.hasOwn(result, 'prependSystemContext') || typeof result.prependSystemContext !== 'string' || result.prependSystemContext.trim().length < 1 || result.prependSystemContext.length > 8192) throw failure('CAPABILITY_SELECTION_RESULT_INVALID');
    const proof = result.proof;
    if (!recordObject(proof) || Object.keys(proof).length !== Object.keys(proofExpected).length
        || !Object.entries(proofExpected).every(([key, value]) => proof[key] === value)) throw failure('CAPABILITY_SELECTION_PROOF_INVALID');
    assertSelectionRegistration(envelope, registry);
    const current = readRecord(envelope.operationId);
    if (!current || current.status !== 'binding' || current.actualRunId !== identity.actualRunId)
      throw failure('CAPABILITY_SELECTION_DISPATCH_CHANGED');
    current.status = 'bound'; current.updatedAt = Date.now(); writeRecord(current);
    runBindings.set(identity.actualRunId, Object.freeze({ envelope, identity: Object.freeze({ ...identity }),
      selectionAdapterInstanceId: registration.instanceId, prependSystemContext: result.prependSystemContext }));
  } catch (error) {
    markSelection(envelope, 'blocked', error?.code || 'CAPABILITY_SELECTION_GATE_FAILED');
    throw failure(error?.code || 'CAPABILITY_SELECTION_GATE_FAILED');
  }
}

// Recheck after asynchronous preparation and before every built-in model submit.
export function assertSelectionRun(runId, identity, registry) {
  const binding = runBindings.get(runId);
  if (!binding) return; // Ordinary turns have no selection contract.
  const record = readRecord(binding.envelope.operationId);
  if (!record || record.status !== 'bound') throw failure('CAPABILITY_SELECTION_DISPATCH_CHANGED');
  assertIdentity(record, { ...binding.identity, ...identity, actualRunId: runId });
  assertSelectionRegistration(binding.envelope, registry);
}

// The canonical Gateway gate owns this identity. Per-model plugin forks must
// never replace it with their own freshly generated adapter instance UUID.
export function selectionToolContext(runId, context, registry) {
  const binding = runBindings.get(runId);
  if (!binding) return context; // Ordinary turns retain their existing hook context.
  if (!recordObject(context) || !['agentId', 'sessionKey', 'sessionId'].every(key => typeof context[key] === 'string' && context[key].length > 0))
    throw failure('CAPABILITY_SELECTION_TOOL_IDENTITY_UNAVAILABLE');
  assertSelectionRun(runId, { agentId: context.agentId, sessionKey: context.sessionKey, sessionId: context.sessionId }, registry);
  const registration = currentRegistration(registry, binding.envelope.requiredAdapterId);
  if (registration.instanceId !== binding.selectionAdapterInstanceId) throw failure('CAPABILITY_SELECTION_ADAPTER_INSTANCE_CHANGED');
  return Object.freeze({ ...context, capabilitySelection: binding.envelope,
    selectionAdapterInstanceId: binding.selectionAdapterInstanceId });
}

export function rejectSelectionRuntime(envelope, runtime) {
  if (!envelope) return;
  markSelection(envelope, 'blocked');
  throw failure(`CAPABILITY_SELECTION_RUNTIME_UNSUPPORTED:${runtime}`);
}

// Only the trusted gate can contribute bounded preference context to this run.
export function selectionSystemContext(runId, identity, registry) {
  assertSelectionRun(runId, identity, registry);
  return runBindings.get(runId)?.prependSystemContext ?? null;
}

// A failed terminal confirmation is observation-only; selected work is never replayed.
export async function finishSelection(envelope, status, registry) {
  if (!envelope) return;
  const record = readRecord(envelope.operationId);
  if (!record || ['completed', 'blocked', 'failed', 'aborted'].includes(record.status)) return;
  const binding = record.actualRunId ? runBindings.get(record.actualRunId) : null;
  if (!binding) { markSelection(envelope, status); return; }
  try {
    assertSelectionRegistration(envelope, registry);
    const registration = currentRegistration(registry, envelope.requiredAdapterId);
    if (typeof registration.onTerminal !== 'function') throw failure('CAPABILITY_SELECTION_TERMINAL_HANDLER_MISSING');
    let timer;
    await Promise.race([Promise.resolve().then(() => registration.onTerminal(Object.freeze({
      capabilitySelection: envelope, identity: binding.identity, status,
    }))), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('CAPABILITY_SELECTION_TERMINAL_TIMEOUT')), 5000); })])
      .finally(() => clearTimeout(timer));
    markSelection(envelope, status);
  } catch (error) { markSelection(envelope, 'needs-verification', error?.code || 'CAPABILITY_SELECTION_TERMINAL_FAILED'); }
}
