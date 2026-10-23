export type ManagedPluginHostBackend = "openclaw" | "hermes";
export type ManagedPluginHostAction = "prepare" | "restart" | "stop";
export interface ManagedPluginHostStatus {
  version: 1;
  backendId: ManagedPluginHostBackend;
  mode: "existing" | "managed";
  state: "idle" | "preparing" | "activating" | "running" | "stopping" | "stopped" | "failed" | "needs_verification";
  operationId: string | null;
  selectionSupported: boolean;
  errorCode: string | null;
}
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const states = new Set(["idle", "preparing", "activating", "running", "stopping", "stopped", "failed", "needs_verification"]);
function endpoint(backendId: ManagedPluginHostBackend) {
  if (backendId !== "openclaw" && backendId !== "hermes") throw new Error("Managed Host backend invalid");
  return `/__api/plugins/host-runtime/${backendId}`;
}
async function request(backendId: ManagedPluginHostBackend, path: string, options: RequestInit): Promise<ManagedPluginHostStatus | null> {
  const response = await fetch(path, { ...options, credentials: "same-origin" });
  if (response.status === 501) return null;
  if (!response.ok) throw new Error("Managed Host unavailable");
  const value: ManagedPluginHostStatus = await response.json();
  if (!value || Object.keys(value).length !== 7 || value.version !== 1 || value.backendId !== backendId
    || !["existing", "managed"].includes(value.mode) || !states.has(value.state)
    || typeof value.selectionSupported !== "boolean"
    || (value.selectionSupported && (value.state !== "running" || value.mode !== "managed"))
    || (value.operationId !== null && (typeof value.operationId !== "string" || !operationPattern.test(value.operationId)))
    || (value.errorCode !== null && (typeof value.errorCode !== "string" || !/^(?:RUNTIME|MANAGED_HOST|MANAGED_HERMES|MANAGED_WORKER|HERMES)_[A-Z0-9_]{1,80}$/u.test(value.errorCode)))) {
    throw new Error("Managed Host status invalid");
  }
  return value;
}
export const getManagedPluginHostStatus = (backendId: ManagedPluginHostBackend, signal?: AbortSignal) => request(backendId, endpoint(backendId), { signal });
export const getManagedPluginHostOperation = (backendId: ManagedPluginHostBackend, operationId: string, signal?: AbortSignal) => {
  if (typeof operationId !== "string" || !operationPattern.test(operationId)) throw new Error("Managed Host operation invalid");
  return request(backendId, `${endpoint(backendId)}/operations/${encodeURIComponent(operationId)}`, { signal });
};
export const runManagedPluginHostAction = (backendId: ManagedPluginHostBackend, action: ManagedPluginHostAction, operationId: string,
  signal?: AbortSignal) => {
  if (!["prepare", "restart", "stop"].includes(action) || typeof operationId !== "string" || !operationPattern.test(operationId)) throw new Error("Managed Host operation invalid");
  return request(backendId, `${endpoint(backendId)}/${action}`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId }),
  });
};
