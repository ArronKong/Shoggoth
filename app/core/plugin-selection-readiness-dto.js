"use strict";

const BACKEND = /^[a-z][a-z0-9-]{0,63}$/u;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
const invalid = () => { throw new TypeError("invalid plugin selection readiness query"); };

function validatePluginSelectionReadinessInput(value) {
  if (!exact(value, ["agentId", "sessionKey"]) || typeof value.agentId !== "string" || !AGENT.test(value.agentId)
    || typeof value.sessionKey !== "string" || !value.sessionKey.isWellFormed()
    || Buffer.byteLength(value.sessionKey, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(value.sessionKey)
    || !value.sessionKey.startsWith(`agent:${value.agentId}:`)
    || value.sessionKey.length === `agent:${value.agentId}:`.length) invalid();
  return Object.freeze({ ...value });
}

function parsePluginSelectionReadinessQuery(params) {
  const fields = ["backend", "agent", "sessionKey"];
  if (!(params instanceof URLSearchParams) || [...params.keys()].length !== fields.length
    || fields.some(key => params.getAll(key).length !== 1)
    || typeof params.get("backend") !== "string" || !BACKEND.test(params.get("backend"))) invalid();
  return Object.freeze({ backendId: params.get("backend"), input: validatePluginSelectionReadinessInput({
    agentId: params.get("agent"), sessionKey: params.get("sessionKey"),
  }) });
}

module.exports = { parsePluginSelectionReadinessQuery, validatePluginSelectionReadinessInput };
