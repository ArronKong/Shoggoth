import type { ManagedPluginHostBackend } from "./managedPluginHostApi";

const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function key(backendId: ManagedPluginHostBackend) {
  if (backendId !== "openclaw" && backendId !== "hermes") throw new Error("Managed Host backend invalid");
  return `shoggoth:managed-plugin-host-operation:${backendId}`;
}
export function readManagedHostPending(backendId: ManagedPluginHostBackend): string | null {
  const raw = localStorage.getItem(key(backendId));
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).length !== 3 || value.version !== 1 || value.backendId !== backendId
    || typeof value.operationId !== "string" || !operationPattern.test(value.operationId)) throw new Error("Managed Host recovery invalid");
  return value.operationId;
}
export function saveManagedHostPending(backendId: ManagedPluginHostBackend, operationId: string) {
  if (typeof operationId !== "string" || !operationPattern.test(operationId)) throw new Error("Managed Host operation invalid");
  localStorage.setItem(key(backendId), JSON.stringify({ version: 1, backendId, operationId }));
  if (readManagedHostPending(backendId) !== operationId) throw new Error("Managed Host recovery was not saved");
}
export function clearManagedHostPending(backendId: ManagedPluginHostBackend, operationId: string) {
  // Another surface's newer operation must not be cleared by an older receipt.
  if (readManagedHostPending(backendId) === operationId) localStorage.removeItem(key(backendId));
}
