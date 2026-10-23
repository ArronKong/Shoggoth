"use strict";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new TypeError("invalid Gmail plugin response"); };

function registration(value) {
  if (!exact(value, ["configured", "restartRequired", "runtimeAvailable", "reasonCode"])
    || typeof value.configured !== "boolean" || typeof value.restartRequired !== "boolean"
    || value.restartRequired || typeof value.runtimeAvailable !== "boolean"
    || (value.reasonCode !== null && (typeof value.reasonCode !== "string" || !CODE.test(value.reasonCode)))
    || (value.runtimeAvailable && value.reasonCode !== null)) invalid();
  return { ...value };
}

function capabilities(value) {
  if (!exact(value, ["revision", "writeEnabled", "sendEnabled", "deleteEnabled"])
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.writeEnabled !== "boolean" || typeof value.sendEnabled !== "boolean"
    || value.sendEnabled && !value.writeEnabled || value.deleteEnabled !== false) invalid();
  return { ...value };
}

function flow(value) {
  if (!exact(value, ["flowId", "status", "expiresAt", "reasonCode", "bindingId", "receipt"])
    || typeof value.flowId !== "string" || !ID.test(value.flowId)
    || !["pending", "verifying", "ready", "failed", "canceled"].includes(value.status)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
    || (value.reasonCode !== null && (typeof value.reasonCode !== "string" || !CODE.test(value.reasonCode)))
    || (value.bindingId !== null && (typeof value.bindingId !== "string" || !ID.test(value.bindingId)))
    || (value.status === "ready" && (value.reasonCode !== null || value.bindingId === null))
    || (value.status !== "ready" && (value.bindingId !== null || value.receipt !== null))) invalid();
  if (value.receipt !== null && (!exact(value.receipt,
    ["kind", "profileId", "bindingId", "toolIdentity", "revision"])
    || value.receipt.kind !== "mcp-connect" || value.receipt.bindingId !== value.bindingId
    || typeof value.receipt.profileId !== "string" || !ID.test(value.receipt.profileId)
    || value.receipt.toolIdentity !== null
    || !Number.isSafeInteger(value.receipt.revision) || value.receipt.revision < 1)) invalid();
  return { ...value, receipt: value.receipt ? { ...value.receipt } : null };
}

function validateGmailResult(method, value) {
  if (method === "plugins.gmail.registration.status"
    || method === "plugins.gmail.registration.configure") return registration(value);
  if (method === "plugins.gmail.capabilities.status"
    || method === "plugins.gmail.capabilities.configure") return capabilities(value);
  if (method === "plugins.gmail.auth.start") {
    if (!exact(value, ["canceled", "flow"]) || value.canceled !== false || !value.flow) invalid();
    return { canceled: false, flow: flow(value.flow) };
  }
  if (method === "plugins.gmail.auth.status" || method === "plugins.gmail.auth.cancel") return flow(value);
  invalid();
}

module.exports = { validateGmailResult };
