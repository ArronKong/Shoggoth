import type {
  DesktopModelOperationRecoveryBridge, ModelChangeOperation, ModelOperationRecoveryIdentity,
  ModelOperationRecoveryStoredRow, PendingModelOperationIdentities,
} from "../../types";

// Main owns durable identity. localStorage is an auxiliary legacy-page cache.
export type RetainedModelOperation = ModelOperationRecoveryStoredRow;
export type ModelOperationRecoverySnapshot = {
  revision: number; required: boolean; journal: "unknown" | "loading" | "ready" | "error";
  storageVerified: boolean; serverPending: readonly string[]; operations: readonly RetainedModelOperation[];
};
const STORAGE_KEY = "shoggoth.model-operation-recovery.v1";
const MAX_OPERATIONS = 512, MAX_BYTES = 384 * 1024, MARKER = "model_recovery_requested";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUSES = new Set(["unconfirmed", "in_progress", "partial", "blocked", "needs_secret", "cleanup_pending", "not_found"]);
const operations = new Map<string, RetainedModelOperation>();
const phases = new Map<string, { required: boolean; journal: ModelOperationRecoverySnapshot["journal"] }>();
const serverPending = new Map<string, Set<string>>();
const snapshots = new Map<string, ModelOperationRecoverySnapshot>();
const listeners = new Set<() => void>();
let loaded = false, cacheVerified = true, cacheCorrupt = false, revision = 0;
let nativeDetected = false, nativeState: "unknown" | "loading" | "ready" | "error" = "unknown", nativeRevision = -1;
let tail: Promise<unknown> = Promise.resolve();
const recordKey = (backend: string, operationId: string) => `${backend}\0${operationId}`;
const sameIdentity = (left: ModelOperationRecoveryIdentity, right: ModelOperationRecoveryIdentity) =>
  left.backendId === right.backendId && left.providerKey === right.providerKey && left.operationId === right.operationId;
function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("model_recovery_unverified");
  const keys = Reflect.ownKeys(value), captured: Record<string, unknown> = {};
  if (required.some((key) => !keys.includes(key))
    || keys.some((key) => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) throw new Error("model_recovery_unverified");
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) throw new Error("model_recovery_unverified");
    captured[key] = descriptor.value;
  }
  return captured;
}
function captureRow(value: unknown, legacy = false): RetainedModelOperation {
  const row = closed(value, ["version", "backendId", "providerKey", "operationId", "status"], ["code"]);
  if (row.version !== 1 || typeof row.backendId !== "string" || !ID.test(row.backendId)
    || typeof row.providerKey !== "string" || !PROVIDER.test(row.providerKey)
    || typeof row.operationId !== "string" || !ID.test(row.operationId)
    || typeof row.status !== "string" || !STATUSES.has(row.status)
    || Object.hasOwn(row, "code") && (typeof row.code !== "string" || (legacy ? !ID.test(row.code) : row.code !== MARKER)))
    throw new Error("model_recovery_unverified");
  // Legacy Renderer errors are never imported into Main or persisted again.
  return Object.freeze({ version: 1, backendId: row.backendId, providerKey: row.providerKey, operationId: row.operationId,
    status: row.status, ...(row.code === MARKER ? { code: MARKER } : {}) });
}
function captureRows(value: unknown, legacy = false): Map<string, RetainedModelOperation> {
  if (!Array.isArray(value) || value.length > MAX_OPERATIONS
    || Reflect.ownKeys(value).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw new Error("model_recovery_unverified");
  const next = new Map<string, RetainedModelOperation>(), ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) throw new Error("model_recovery_unverified");
    const row = captureRow(descriptor.value, legacy);
    if (ids.has(row.operationId)) throw new Error("model_recovery_identity_conflict");
    ids.add(row.operationId); next.set(recordKey(row.backendId, row.operationId), row);
  }
  return next;
}
function assertScope(next: Map<string, RetainedModelOperation>, row: RetainedModelOperation) {
  const prior = [...next.values()].find((value) => value.operationId === row.operationId);
  if (prior && !sameIdentity(prior, row)) throw new Error("model_recovery_identity_conflict");
}
function nativeBridge(): DesktopModelOperationRecoveryBridge | null {
  if (typeof window === "undefined") return null;
  const desktop = (window as unknown as { openclawDesktop?: { modelOperationRecovery?: DesktopModelOperationRecoveryBridge } }).openclawDesktop;
  if ("openclawDesktop" in window) nativeDetected = true;
  if (!nativeDetected) return null;
  const bridge = desktop?.modelOperationRecovery;
  if (!bridge || [bridge.read, bridge.retain, bridge.ack].some((method) => typeof method !== "function"))
    throw new Error("model_recovery_native_unavailable");
  return bridge;
}
function unwrap(value: unknown): unknown {
  const envelope = closed(value, ["ok"], ["value", "error"]);
  if (envelope.ok !== true || !Object.hasOwn(envelope, "value") || Object.hasOwn(envelope, "error")) throw new Error("model_recovery_native_unavailable");
  return envelope.value;
}
function captureRevision(value: Record<string, unknown>): number {
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || (value.revision as number) < nativeRevision) throw new Error("model_recovery_unverified");
  return value.revision as number;
}
function load() {
  if (loaded) return;
  loaded = true;
  try { nativeBridge(); } catch { nativeState = "error"; }
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text === null) return;
    if (text.length > MAX_BYTES) throw new Error("bounded_storage");
    const state = closed(JSON.parse(text), ["version", "operations"]);
    if (state.version !== 1) throw new Error("invalid_storage");
    const captured = captureRows(state.operations, true);
    for (const row of captured.values()) { assertScope(operations, row); operations.set(recordKey(row.backendId, row.operationId), row); }
  } catch { cacheVerified = false; cacheCorrupt = true; }
}
function publish() { revision += 1; snapshots.clear(); for (const listener of listeners) listener(); }
function persist(next: Map<string, RetainedModelOperation>): boolean {
  try {
    if (next.size > MAX_OPERATIONS || cacheCorrupt) throw new Error("unverified_storage");
    const text = JSON.stringify({ version: 1, operations: [...next.values()] });
    if (text.length > MAX_BYTES) throw new Error("bounded_storage");
    localStorage.setItem(STORAGE_KEY, text);
    if (localStorage.getItem(STORAGE_KEY) !== text) throw new Error("unverified_storage");
    cacheVerified = true; return true;
  } catch { cacheVerified = false; return false; }
}
function enqueue<T>(action: () => Promise<T>): Promise<T> {
  const next = tail.then(action); tail = next.catch(() => {}); return next;
}
function replace(next: Map<string, RetainedModelOperation>) {
  operations.clear(); for (const [key, row] of next) operations.set(key, row);
}
async function nativeRetain(bridge: DesktopModelOperationRecoveryBridge, row: RetainedModelOperation): Promise<RetainedModelOperation> {
  const result = closed(unwrap(await bridge.retain(row)), ["version", "revision", "operation"]);
  const nextRevision = captureRevision(result), retained = captureRow(result.operation);
  if (!sameIdentity(retained, row) || retained.status !== row.status || row.code === MARKER && retained.code !== MARKER)
    throw new Error("model_recovery_unverified");
  nativeRevision = nextRevision; return retained;
}
async function initializeStorage(): Promise<void> {
  load();
  let bridge: DesktopModelOperationRecoveryBridge | null;
  try { bridge = nativeBridge(); } catch { nativeState = "error"; publish(); throw new Error("model_recovery_native_unavailable"); }
  if (!bridge) { if (!cacheVerified) throw new Error("model_recovery_cache_unavailable"); return; }
  nativeState = "loading"; publish();
  try {
    const result = closed(unwrap(await bridge.read()), ["version", "revision", "operations"]);
    const nextRevision = captureRevision(result), next = captureRows(result.operations);
    nativeRevision = nextRevision;
    if (cacheCorrupt) throw new Error("model_recovery_cache_unavailable");
    // Main is authoritative. Import only missing safe original IDs or an older
    // cache marker; never replace a Main row with a stale Renderer status.
    for (const local of operations.values()) {
      assertScope(next, local);
      const key = recordKey(local.backendId, local.operationId), stored = next.get(key);
      if (!stored || local.code === MARKER && stored.code !== MARKER) {
        const retained = await nativeRetain(bridge, stored ? { ...stored, code: MARKER } : local);
        next.set(key, retained);
      }
    }
    if (next.size > MAX_OPERATIONS) throw new Error("model_recovery_capacity");
    replace(next); persist(next); nativeState = "ready"; publish();
  } catch { nativeState = "error"; publish(); throw new Error("model_recovery_native_unavailable"); }
}
export function initializeModelOperationRecoveryStorage(): Promise<void> { return enqueue(initializeStorage); }
export function subscribeModelOperationRecovery(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getModelOperationRecoverySnapshot(backend: string): ModelOperationRecoverySnapshot {
  load(); const previous = snapshots.get(backend); if (previous) return previous;
  const phase = phases.get(backend) ?? { required: false, journal: "unknown" as const };
  const snapshot = Object.freeze({ revision, ...phase, storageVerified: nativeDetected ? nativeState === "ready" : cacheVerified,
    serverPending: Object.freeze([...(serverPending.get(backend) ?? [])]),
    operations: Object.freeze([...operations.values()].filter((row) => row.backendId === backend)),
  }); snapshots.set(backend, snapshot); return snapshot;
}
export function beginModelOperationRecoveryRead(backend: string) { load(); serverPending.delete(backend); phases.set(backend, { required: true, journal: "loading" }); publish(); }
export function failModelOperationRecoveryRead(backend: string) { serverPending.delete(backend); phases.set(backend, { required: true, journal: "error" }); publish(); }
export function acceptModelOperationRecoveryRead(summary: PendingModelOperationIdentities): Promise<void> {
  return enqueue(async () => {
    load();
    try {
      if (nativeDetected && nativeState !== "ready") throw new Error("model_recovery_native_unavailable");
      const next = new Map(operations), bridge = nativeBridge();
      for (const row of summary.operations) {
        const safe = captureRow({ version: 1, backendId: summary.backendId, providerKey: row.providerKey,
          operationId: row.operationId, status: row.status });
        assertScope(next, safe);
        const key = recordKey(summary.backendId, row.operationId), previous = next.get(key);
        const retained = Object.freeze({ ...safe, ...(previous?.code === MARKER ? { code: MARKER } : {}) });
        if (next.size >= MAX_OPERATIONS && !next.has(key)) throw new Error("model_recovery_capacity");
        next.set(key, bridge ? await nativeRetain(bridge, retained) : retained);
      }
      // Missing from this list is never proof of a final outcome.
      replace(next);
      if (!persist(next) && !bridge) throw new Error("model_recovery_cache_unavailable");
      serverPending.set(summary.backendId, new Set(summary.operations.map((row) => row.operationId)));
      phases.set(summary.backendId, { required: true, journal: "ready" }); publish();
    } catch {
      if (nativeDetected) nativeState = "error";
      failModelOperationRecoveryRead(summary.backendId); throw new Error("model_recovery_unverified");
    }
  });
}
export function retainedProviderModelOperation(backend: string, provider: string): RetainedModelOperation | null {
  return getModelOperationRecoverySnapshot(backend).operations.find((row) => row.providerKey === provider) ?? null;
}
export function modelOperationRecoveryBlocks(backend: string, provider?: string, originalOperationId?: string): boolean {
  const state = getModelOperationRecoverySnapshot(backend);
  if (!state.required) return false;
  if (nativeDetected && nativeState !== "ready") return true;
  return state.journal !== "ready" || !state.storageVerified || state.operations.some((row) =>
    (!provider || row.providerKey === provider) && row.operationId !== originalOperationId);
}
export function retainModelOperation(value: RetainedModelOperation): Promise<boolean> {
  load(); let row: RetainedModelOperation;
  try {
    row = captureRow(value); assertScope(operations, row);
    const key = recordKey(row.backendId, row.operationId), existing = operations.get(key);
    row = Object.freeze({ ...row, ...(existing?.code === MARKER ? { code: MARKER } : {}) });
    const next = new Map(operations); next.set(key, row);
    if (next.size > MAX_OPERATIONS) return Promise.resolve(false);
    // Preserve the original ID and lock immediately, including a lost retain ACK.
    replace(next); persist(next); publish();
  } catch { return Promise.resolve(false); }
  return enqueue(async () => {
    try {
      const bridge = nativeBridge();
      if (bridge) {
        if (nativeState !== "ready") throw new Error("model_recovery_native_unavailable");
        nativeState = "loading"; publish();
        const retained = await nativeRetain(bridge, row);
        operations.set(recordKey(row.backendId, row.operationId), retained);
        nativeState = "ready"; persist(operations); publish(); return true;
      }
      const verified = persist(operations); publish(); return verified;
    } catch { nativeState = "error"; publish(); return false; }
  });
}
export function confirmModelOperationTerminal(operation: ModelChangeOperation): Promise<boolean> {
  return enqueue(async () => {
    if (operation.terminal !== true || !["applied", "failed", "compensated"].includes(operation.status)
      || !ID.test(operation.backendId) || !ID.test(operation.operationId) || !PROVIDER.test(operation.providerKey)) return false;
    const key = recordKey(operation.backendId, operation.operationId), record = operations.get(key);
    if (!record || record.providerKey !== operation.providerKey) return false;
    try {
      const bridge = nativeBridge();
      if (bridge) {
        if (nativeState !== "ready") throw new Error("model_recovery_native_unavailable");
        nativeState = "loading"; publish();
        const identity: ModelOperationRecoveryIdentity = { version: 1, backendId: operation.backendId,
          providerKey: operation.providerKey, operationId: operation.operationId };
        const result = closed(unwrap(await bridge.ack(identity)),
          ["version", "revision", "backendId", "providerKey", "operationId", "status", "outcome"]);
        const nextRevision = captureRevision(result);
        if (result.status !== "acknowledged" || result.outcome !== operation.status
          || !sameIdentity(result as unknown as ModelOperationRecoveryIdentity, identity)) throw new Error("model_recovery_unverified");
        nativeRevision = nextRevision;
      }
      const next = new Map(operations); next.delete(key);
      if (!persist(next) && !bridge) { publish(); return false; }
      replace(next); serverPending.get(operation.backendId)?.delete(operation.operationId);
      if (bridge) nativeState = "ready";
      publish(); return true;
    } catch { nativeState = "error"; publish(); return false; }
  });
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  for (const [backend, phase] of phases) phases.set(backend, { ...phase, journal: "unknown" });
  serverPending.clear(); loaded = false;
  if (nativeDetected) nativeState = "unknown";
  load(); publish();
});
