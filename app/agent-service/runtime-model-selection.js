"use strict";

const { types } = require("node:util");

const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validRuntimeModelSelection(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = Object.hasOwn(descriptors, "modelProviderRef")
    ? ["bindingId", "model", "modelProviderRef"] : ["bindingId", "model"];
  if (Reflect.ownKeys(descriptors).length !== fields.length
    || !fields.every(key => Object.hasOwn(descriptors, key) && descriptors[key].enumerable
      && Object.hasOwn(descriptors[key], "value"))) return false;
  return typeof value.bindingId === "string" && BINDING_ID.test(value.bindingId)
    && typeof value.model === "string" && value.model.trim() === value.model && value.model.length > 0
    && value.model.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value.model)
    && Buffer.byteLength(value.model, "utf8") <= 512
    // Loaded on use: cron stores reach the isolated MCP helper, which must not
    // load ProductStore through codex-session-provider at startup.
    && (!Object.hasOwn(value, "modelProviderRef")
      || require("./codex-session-provider").validProviderSelection(value.modelProviderRef));
}

function runtimeModelIdentity(selection) {
  return selection ? [selection.bindingId, selection.model, selection.modelProviderRef ?? null] : selection;
}

function sameRuntimeModel(left, right) {
  return left === right || JSON.stringify(runtimeModelIdentity(left)) === JSON.stringify(runtimeModelIdentity(right));
}

function isLegacyClaudeDefaultModel(runtime, model) {
  return runtime === "claude-code" && model === "default";
}

function matchesRuntimeModel(runtime, model, row) {
  return isLegacyClaudeDefaultModel(runtime, model) ? row.isDefault : row.id === model;
}

module.exports = { validRuntimeModelSelection, runtimeModelIdentity, sameRuntimeModel,
  isLegacyClaudeDefaultModel, matchesRuntimeModel };
