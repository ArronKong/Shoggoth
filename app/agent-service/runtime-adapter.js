"use strict";

const { serviceError } = require("./security");

const RUNTIME_CAPABILITY_KEYS = Object.freeze([
  "session.start",
  "session.resume",
  "session.read",
  "session.list",
  "session.rename",
  "session.archive",
  "session.unarchive",
  "session.delete",
  "turn.start",
  "turn.steer",
  "turn.interrupt",
  "models.list",
  "commands.list",
  "commands.execute",
  "account.read",
  "account.login",
  "account.logout",
  "events",
  "serverRequests",
  "context.usage.exact",
  "context.usage.estimated",
  "context.compact.native",
  "context.compact.auto",
  "model.generate.toolFree",
]);

function runtimeError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validRuntime(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

function validRuntimeProfileId(value) {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function validRuntimeAccountId(value) {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function validRefId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value.isWellFormed() && !value.includes("\0");
}

function runtimeBinding(value) {
  if (!exactObject(value, ["runtime", "runtimeProfileId", "runtimeAccountId"])
    || !validRuntime(value.runtime) || !validRuntimeProfileId(value.runtimeProfileId)
    || !validRuntimeAccountId(value.runtimeAccountId)) {
    throw runtimeError("RUNTIME_BINDING_INVALID", "Runtime binding is invalid");
  }
  return Object.freeze({
    runtime: value.runtime,
    runtimeProfileId: value.runtimeProfileId,
    runtimeAccountId: value.runtimeAccountId,
  });
}

function runtimeSessionRef(bindingValue, sessionId) {
  const binding = runtimeBinding(bindingValue);
  if (!validRefId(sessionId)) throw runtimeError("RUNTIME_REF_INVALID", "Runtime session ref is invalid");
  return Object.freeze({ ...binding, sessionId });
}

function runtimeTurnRef(bindingValue, sessionId, turnId) {
  const session = runtimeSessionRef(bindingValue, sessionId);
  if (!validRefId(turnId)) throw runtimeError("RUNTIME_REF_INVALID", "Runtime turn ref is invalid");
  return Object.freeze({ ...session, turnId });
}

function runtimeCapabilities(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !RUNTIME_CAPABILITY_KEYS.includes(key))
    || Object.values(value).some((enabled) => typeof enabled !== "boolean")) {
    throw runtimeError("RUNTIME_CAPABILITIES_INVALID", "Runtime capabilities are invalid");
  }
  return Object.freeze(Object.fromEntries(
    RUNTIME_CAPABILITY_KEYS.map((key) => [key, value[key] === true]),
  ));
}

function ownDataValue(value, key) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function authenticationState(status) {
  return Object.freeze({ status });
}

async function readRuntimeAuthenticationState(handle, { allowDeferred = false } = {}) {
  if (!handle || (typeof handle !== "object" && typeof handle !== "function")) {
    throw runtimeError("RUNTIME_AUTH_STATUS_INVALID", "Runtime auth status is invalid");
  }
  let accountRead;
  let runtimeAuthenticationState;
  try {
    accountRead = handle.accountRead;
    runtimeAuthenticationState = handle.authenticationState;
  } catch {
    throw runtimeError("RUNTIME_AUTH_STATUS_UNAVAILABLE", "Runtime auth status is unavailable");
  }
  if (typeof accountRead === "function") {
    let raw;
    try {
      raw = await accountRead.call(handle, { refreshToken: false });
    } catch {
      throw runtimeError("RUNTIME_AUTH_STATUS_UNAVAILABLE", "Runtime auth status is unavailable");
    }
    const account = ownDataValue(raw, "account");
    const requiresOpenaiAuth = ownDataValue(raw, "requiresOpenaiAuth");
    if (typeof requiresOpenaiAuth !== "boolean"
      || (account !== null && (!account || typeof account !== "object" || Array.isArray(account)))) {
      throw runtimeError("RUNTIME_AUTH_STATUS_INVALID", "Runtime auth status is invalid");
    }
    return authenticationState(account !== null || requiresOpenaiAuth === false
      ? "authenticated" : "unauthenticated");
  }
  if (typeof runtimeAuthenticationState === "function") {
    let raw;
    try {
      raw = await runtimeAuthenticationState.call(handle, { allowDeferred });
    } catch {
      throw runtimeError("RUNTIME_AUTH_STATUS_UNAVAILABLE", "Runtime auth status is unavailable");
    }
    // An adapter may let its executing CLI authenticate the request instead
    // of doing a second network login check. Settings still require an actual
    // check; deferred verification must never be advertised as authenticated.
    if (allowDeferred && ownDataValue(raw, "verificationDeferred") === true) {
      return authenticationState("unverified");
    }
    const authenticated = ownDataValue(raw, "authenticated");
    const credentialPresent = ownDataValue(raw, "credentialPresent");
    if (typeof authenticated !== "boolean"
      || (credentialPresent !== undefined && typeof credentialPresent !== "boolean")) {
      throw runtimeError("RUNTIME_AUTH_STATUS_INVALID", "Runtime auth status is invalid");
    }
    return authenticationState(authenticated
      ? "authenticated"
      : credentialPresent === true ? "unverified" : "unauthenticated");
  }
  return authenticationState("unsupported");
}

function assertRuntimeAdapter(value) {
  if (!value || typeof value !== "object"
    || ["acquire", "stop", "stopAll"].some((method) => typeof value[method] !== "function")) {
    throw runtimeError("RUNTIME_ADAPTER_INVALID", "Runtime adapter contract is invalid");
  }
  return true;
}

module.exports = {
  RUNTIME_CAPABILITY_KEYS,
  assertRuntimeAdapter,
  readRuntimeAuthenticationState,
  runtimeBinding,
  runtimeCapabilities,
  runtimeSessionRef,
  runtimeTurnRef,
  validRuntime,
  validRuntimeAccountId,
  validRuntimeProfileId,
};
