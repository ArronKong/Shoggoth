"use strict";

const CHANNELS = Object.freeze({
  read: "shoggoth:model-operation-recovery:read",
  retain: "shoggoth:model-operation-recovery:retain",
  ack: "shoggoth:model-operation-recovery:ack",
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUSES = new Set(["unconfirmed", "in_progress", "partial", "blocked", "needs_secret", "cleanup_pending", "not_found"]);
const TERMINAL = new Set(["applied", "failed", "compensated"]);
const MARKER = "model_recovery_requested";
const MAX_OPERATIONS = 512;

function closed(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("invalid recovery DTO");
  const keys = Reflect.ownKeys(value), result = {};
  if (required.some(key => !keys.includes(key))
    || keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key)))
    throw new TypeError("invalid recovery DTO");
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, "value") || property.enumerable !== true)
      throw new TypeError("invalid recovery DTO");
    result[key] = property.value;
  }
  return result;
}
function identity(value) {
  if (value.version !== 1 || typeof value.backendId !== "string" || !ID.test(value.backendId)
    || typeof value.providerKey !== "string" || !PROVIDER.test(value.providerKey)
    || typeof value.operationId !== "string" || !ID.test(value.operationId)) throw new TypeError("invalid recovery identity");
  return value;
}
function row(value) {
  const result = identity(closed(value, ["version", "backendId", "providerKey", "operationId", "status"], ["code"]));
  if (!STATUSES.has(result.status) || Object.hasOwn(result, "code") && result.code !== MARKER)
    throw new TypeError("invalid recovery state");
  return Object.freeze(result);
}
function ackIdentity(value) {
  return Object.freeze(identity(closed(value, ["version", "backendId", "providerKey", "operationId"])));
}
function revision(value) {
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new TypeError("invalid recovery revision");
  return value;
}
function sameIdentity(left, right) {
  return ["backendId", "providerKey", "operationId"].every(key => left[key] === right[key]);
}
function readResult(value) {
  const result = revision(closed(value, ["version", "revision", "operations"])), list = result.operations;
  if (!Array.isArray(list) || list.length > MAX_OPERATIONS
    || Reflect.ownKeys(list).some(key => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= list.length)))
    throw new TypeError("invalid recovery list");
  const operations = [], seen = new Set();
  for (let index = 0; index < list.length; index++) {
    const property = Object.getOwnPropertyDescriptor(list, String(index));
    if (!property || !Object.hasOwn(property, "value") || !property.enumerable)
      throw new TypeError("invalid recovery list item");
    const captured = row(property.value);
    if (seen.has(captured.operationId)) throw new TypeError("duplicate recovery identity");
    seen.add(captured.operationId); operations.push(captured);
  }
  return Object.freeze({ ...result, operations: Object.freeze(operations) });
}
function retainResult(value, request) {
  const result = revision(closed(value, ["version", "revision", "operation"])), captured = row(result.operation);
  if (!sameIdentity(captured, request) || request.code === MARKER && captured.code !== MARKER)
    throw new TypeError("unverified retained identity");
  return Object.freeze({ ...result, operation: captured });
}
function ackResult(value, request) {
  const result = identity(revision(closed(value,
    ["version", "revision", "backendId", "providerKey", "operationId", "status", "outcome"])));
  if (!sameIdentity(result, request) || result.status !== "acknowledged" || !TERMINAL.has(result.outcome))
    throw new TypeError("unverified acknowledged identity");
  return Object.freeze(result);
}
function failure(code) {
  return { ok: false, error: { code, message: "无法核实模型操作记录，请重新读取。" } };
}
function trustedRenderer(event, getMainWindow, getUiOrigin) {
  try {
    const window = getMainWindow(), frame = event?.senderFrame;
    if (!window || window.isDestroyed?.() === true || !window.webContents
      || window.webContents.isDestroyed?.() === true || event.sender !== window.webContents
      || !frame || frame !== window.webContents.mainFrame) return false;
    const expected = new URL(getUiOrigin()), actual = new URL(frame.url);
    return expected.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname)
      && actual.origin === expected.origin && actual.pathname === expected.pathname
      && actual.search === expected.search && actual.username === "" && actual.password === "";
  } catch { return false; }
}

function registerDesktopModelOperationRecoveryIpc({ ipcMain, getMainWindow, getUiOrigin, getStore }) {
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.removeHandler !== "function"
    || [getMainWindow, getUiOrigin, getStore].some(value => typeof value !== "function"))
    throw new TypeError("model recovery IPC dependencies required");
  let disposed = false;
  const authorize = event => !disposed && trustedRenderer(event, getMainWindow, getUiOrigin);
  for (const method of Object.keys(CHANNELS)) {
    ipcMain.handle(CHANNELS[method], async (event, ...args) => {
      if (!authorize(event)) return failure("MODEL_RECOVERY_CALLER_REQUIRED");
      let request;
      try {
        if (method === "read") { if (args.length) throw new TypeError("read has no arguments"); }
        else {
          if (args.length !== 1) throw new TypeError("one identity required");
          request = method === "retain" ? row(args[0]) : ackIdentity(args[0]);
        }
      } catch { return failure("MODEL_RECOVERY_INVALID_REQUEST"); }
      let store, value;
      try {
        store = await getStore();
        if (!authorize(event)) return failure("MODEL_RECOVERY_CALLER_RETIRED");
        if (!store || typeof store[method] !== "function") throw new TypeError("recovery store unavailable");
        value = await (method === "read" ? store.read() : store[method](request));
      } catch { return failure("MODEL_RECOVERY_STORE_UNAVAILABLE"); }
      if (!authorize(event)) return failure("MODEL_RECOVERY_CALLER_RETIRED");
      try {
        const captured = method === "read" ? readResult(value)
          : method === "retain" ? retainResult(value, request) : ackResult(value, request);
        return { ok: true, value: captured };
      } catch { return failure("MODEL_RECOVERY_RESPONSE_UNVERIFIED"); }
    });
  }
  return { dispose() {
    if (disposed) return; disposed = true;
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
  } };
}
module.exports = { CHANNELS, registerDesktopModelOperationRecoveryIpc, trustedRenderer };
