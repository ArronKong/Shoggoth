"use strict";

const { serviceError } = require("./security");
const { validateAgentRuntimeBinding, MAX_AGENT_RUNTIME_BINDINGS } = require("./agent-runtime-binding");

const AGENT_BINDING_METHODS = Object.freeze([
  "agent.binding.list", "agent.binding.sync", "agent.binding.add", "agent.binding.update", "agent.binding.remove", "agent.binding.setDefault",
]);
const AGENT_BINDING_PUBLIC_MESSAGES = Object.freeze({
  AGENT_BINDING_INVALID: "Agent 运行绑定请求无效",
  AGENT_BINDING_RESPONSE_INVALID: "Agent 运行绑定响应无效",
  AGENT_BINDING_NOT_FOUND: "运行绑定不存在",
  AGENT_BINDING_DEFAULT_PROTECTED: "请先选择其他默认绑定",
  AGENT_BINDING_CAPACITY: "运行绑定数量已达上限",
  AGENT_BINDING_DISABLED: "运行绑定已停用",
  AGENT_BINDING_FEATURE_DISABLED: "尚未启用多个运行绑定",
  AGENT_BINDING_IN_USE: "运行绑定仍有任务在使用",
  AGENT_BINDING_OPERATION_CONFLICT: "该操作标识已用于其他请求",
  AGENT_BINDING_PROJECTION_READONLY: "请通过运行绑定设置修改运行环境",
  AGENT_BINDING_REVISION_CONFLICT: "运行绑定已更新，请刷新后重试",
  AGENT_BINDING_UNAVAILABLE: "暂时无法读取运行绑定",
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function invalid(code = "AGENT_BINDING_INVALID") { return serviceError(code, AGENT_BINDING_PUBLIC_MESSAGES[code]); }
function record(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) throw invalid();
  return Object.fromEntries(keys.map((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw invalid();
    return [key, field.value];
  }));
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) throw invalid(); return value; }
function opaque(value) { if (typeof value !== "string" || !ID.test(value)) throw invalid(); return value; }
function changes(value, adding) {
  const data = record(value, adding ? ["runtime", "runtimeAccountId"] : [],
    adding ? ["label", "enabled"] : ["label", "enabled", "runtimeAccountId"]);
  if (!Object.keys(data).length || (adding && (typeof data.runtime !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(data.runtime)))) throw invalid();
  if (Object.hasOwn(data, "runtimeAccountId")) opaque(data.runtimeAccountId);
  if (Object.hasOwn(data, "label") && data.label !== null && (typeof data.label !== "string"
    || data.label.length < 1 || data.label.length > 256 || !data.label.isWellFormed() || /[\u0000-\u001f]/u.test(data.label))) throw invalid();
  if (Object.hasOwn(data, "enabled") && typeof data.enabled !== "boolean") throw invalid();
  return Object.freeze(data);
}
function validateAgentBindingParams(method, value) {
  try {
    if (!AGENT_BINDING_METHODS.includes(method)) throw invalid();
    const fields = method === "agent.binding.list" ? ["profileId"]
      : method === "agent.binding.sync" ? ["profileId", "runtimeAccountIds"]
      : method === "agent.binding.add" ? ["profileId", "spec", "operationId", "revision"]
        : ["profileId", "bindingId", "revision", ...(method === "agent.binding.update" ? ["patch"] : [])];
    const data = record(value, fields);
    opaque(data.profileId);
    if (method === "agent.binding.sync") {
      const values = data.runtimeAccountIds;
      if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) throw invalid();
      const length = Object.getOwnPropertyDescriptor(values, "length").value;
      if (length > 6 || Reflect.ownKeys(values).length !== length + 1) throw invalid();
      const accounts = [];
      for (let index = 0; index < length; index++) {
        const field = Object.getOwnPropertyDescriptor(values, String(index));
        if (!field?.enumerable || !Object.hasOwn(field, "value")) throw invalid();
        accounts.push(opaque(field.value));
      }
      if (new Set(accounts).size !== length) throw invalid();
      data.runtimeAccountIds = Object.freeze(accounts);
      return Object.freeze(data);
    }
    if (method !== "agent.binding.list") revision(data.revision);
    if (method === "agent.binding.add") { opaque(data.operationId); data.spec = changes(data.spec, true); }
    else if (method !== "agent.binding.list" && (typeof data.bindingId !== "string" || !UUID.test(data.bindingId))) throw invalid();
    if (method === "agent.binding.update") data.patch = changes(data.patch, false);
    return Object.freeze(data);
  } catch { throw invalid(); }
}
function validateAgentBindingResult(method, value, params) {
  try {
    if (!AGENT_BINDING_METHODS.includes(method)) throw invalid();
    const mutation = !["agent.binding.list", "agent.binding.sync"].includes(method);
    const data = record(value, ["bindings", "defaultBindingId", "revision", "canAdd", ...(mutation ? ["binding"] : [])], ["checkpointBindingIds"]);
    revision(data.revision);
    if (typeof data.canAdd !== "boolean" || !Array.isArray(data.bindings) || Object.getPrototypeOf(data.bindings) !== Array.prototype) throw invalid();
    const length = Object.getOwnPropertyDescriptor(data.bindings, "length").value;
    if (length < 1 || length > MAX_AGENT_RUNTIME_BINDINGS || Reflect.ownKeys(data.bindings).length !== length + 1) throw invalid();
    const bindings = [];
    const ids = new Set();
    for (let index = 0; index < length; index += 1) {
      const field = Object.getOwnPropertyDescriptor(data.bindings, String(index));
      if (!field?.enumerable || !Object.hasOwn(field, "value")) throw invalid();
      // Clone only data properties before calling the Product validator.
      const raw = record(field.value, ["id", "profileId", "runtime", "runtimeProfileId", "runtimeAccountId",
        "label", "enabled", "revision", "createdAt", "updatedAt"]);
      const binding = Object.freeze(validateAgentRuntimeBinding(raw));
      if (ids.has(binding.id) || binding.revision > data.revision || (params && binding.profileId !== params.profileId)
        || (bindings.length && binding.profileId !== bindings[0].profileId)) throw invalid();
      ids.add(binding.id); bindings.push(binding);
    }
    if (!bindings.some((entry) => entry.id === data.defaultBindingId && entry.enabled)) throw invalid();
    let selected;
    if (mutation) {
      if (method === "agent.binding.remove") { if (data.binding !== null || ids.has(params?.bindingId)) throw invalid(); selected = null; }
      else {
        const raw = record(data.binding, ["id", "profileId", "runtime", "runtimeProfileId", "runtimeAccountId",
          "label", "enabled", "revision", "createdAt", "updatedAt"]);
        const binding = validateAgentRuntimeBinding(raw);
        selected = bindings.find((entry) => entry.id === binding.id);
        if (!selected || JSON.stringify(selected) !== JSON.stringify(binding)
          || (params?.bindingId && selected.id !== params.bindingId)
          || (method === "agent.binding.setDefault" && selected.id !== data.defaultBindingId)) throw invalid();
      }
    }
    if (data.checkpointBindingIds !== undefined && (!Array.isArray(data.checkpointBindingIds)
      || data.checkpointBindingIds.length > bindings.length || new Set(data.checkpointBindingIds).size !== data.checkpointBindingIds.length
      || data.checkpointBindingIds.some(id => !bindings.some(binding => binding.id === id && binding.enabled)))) throw invalid();
    return Object.freeze({ bindings: Object.freeze(bindings), defaultBindingId: data.defaultBindingId,
      ...(data.checkpointBindingIds !== undefined ? { checkpointBindingIds: Object.freeze([...data.checkpointBindingIds]) } : {}),
      revision: data.revision, canAdd: data.canAdd, ...(mutation ? { binding: selected } : {}) });
  } catch { throw invalid("AGENT_BINDING_RESPONSE_INVALID"); }
}

module.exports = { AGENT_BINDING_METHODS, AGENT_BINDING_PUBLIC_MESSAGES, validateAgentBindingParams, validateAgentBindingResult };
