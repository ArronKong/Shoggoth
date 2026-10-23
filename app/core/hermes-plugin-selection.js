"use strict";

const { validateExternalPluginSelectionInput, validateExternalPluginSelectionResult } = require("./plugin-external-selection-dto");
const ADAPTER_ID = "shoggoth_shared_capabilities";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const WIRE = { version: "version", operation_id: "operationId", dispatch_ref: "dispatchRef",
  selection_digest: "selectionDigest", required_adapter_id: "requiredAdapterId", adapter_generation: "adapterGeneration" };
const FIELDS = [...Object.keys(WIRE), "dispatch_id", "state", "actual_session_id", "actual_task_id", "actual_turn_id", "error_code"];
const STATES = new Set(["accepted", "queued", "binding", "bound", "complete", "stopped", "failed", "canceled", "cancelled", "interrupted", "unknown"]);
function fail(uncertain = false) {
  throw Object.assign(new Error(uncertain ? "原 Hermes 插件消息需要核实，请查询原操作，不能自动重发"
    : "当前 Hermes 尚未提供可信插件选择，输入已保留"), {
    code: uncertain ? "PLUGIN_SELECTION_NEEDS_VERIFICATION" : "PLUGIN_SELECTION_UNAVAILABLE", executionUncertain: uncertain });
}
function exact(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === fields.length
    && fields.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, "value"); });
}
function id(value, max = 256) {
  return typeof value === "string" && ID.test(value) && Buffer.byteLength(value, "utf8") <= max;
}
function wire(envelope) { return Object.fromEntries(Object.entries(WIRE).map(([source, target]) => [source, envelope[target]])); }
function subject(capabilities, agentId) {
  const fields = Object.hasOwn(capabilities || {}, "selection_inputs") ? ["version", "runtime_session_id", "adapters", "selection_inputs"] : ["version", "runtime_session_id", "adapters"];
  if (!exact(capabilities, fields) || capabilities.version !== 1
    || !id(capabilities.runtime_session_id) || !Array.isArray(capabilities.adapters) || capabilities.adapters.length > 32) fail();
  const matches = capabilities.adapters.filter(item => item?.required_adapter_id === ADAPTER_ID);
  if (matches.length !== 1 || !exact(matches[0], ["required_adapter_id", "adapter_generation", "instance_id", "agent_id"])
    || matches[0].agent_id !== agentId || !id(agentId, 128) || !id(matches[0].instance_id, 128)
    || !id(matches[0].adapter_generation, 128)) fail();
  return { subject: { backendId: "hermes", instanceId: matches[0].instance_id, agentId,
    sessionId: capabilities.runtime_session_id }, adapterGeneration: matches[0].adapter_generation };
}
function validateHermesSelectionReceipt(value, selection, event = false) {
  if (!exact(value, event ? [...FIELDS, "runtime_session_id"] : FIELDS)
    || value.version !== 1 || !id(value.operation_id, 128) || !id(value.dispatch_ref, 128)
    || !id(value.dispatch_id, 128) || value.required_adapter_id !== ADAPTER_ID
    || !id(value.adapter_generation, 128) || typeof value.selection_digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.selection_digest) || !STATES.has(value.state)
    || (selection.operationId !== undefined && value.operation_id !== selection.operationId)
    || (value.error_code !== null && !id(value.error_code, 200))
    || Object.entries(WIRE).some(([source, target]) => value[source] !== selection.envelope[target])
    || (event && value.runtime_session_id !== selection.subject.sessionId)) fail(true);
  const identities = [value.actual_session_id, value.actual_task_id, value.actual_turn_id];
  if (!identities.every(item => item === null) && (!identities.every(item => id(item))
    || value.actual_session_id !== selection.subject.sessionId)) fail(true);
  if (["bound", "complete", "stopped"].includes(value.state) && identities.some(item => item === null)) fail(true);
  return Object.freeze({ ...value });
}
function validateHermesSelectionAcknowledgement(value, selection) {
  const receipt = validateHermesSelectionReceipt(value?.selection_dispatch, selection);
  if (!["streaming", "queued"].includes(value?.status)
    || (value.replayed !== undefined && typeof value.replayed !== "boolean")
    || ["unknown", "interrupted"].includes(receipt.state)
    || (value.status === "streaming" && receipt.state === "queued")
    || (value.status === "queued" && receipt.state === "accepted")) fail(true);
  return receipt;
}
async function getReceipt(requestHost, runtimeId, operationId) {
  try {
    const result = await requestHost("prompt.selection.get", { session_id: runtimeId, operation_id: operationId });
    if (!exact(result, ["selection_dispatch"])) fail(true);
    return result.selection_dispatch;
  } catch (error) {
    if (error?.jsonRpc === true && error.code === 4096 && error.contractCode === "SELECTION_NOT_FOUND") return null;
    throw error;
  }
}
async function prepareHermesPluginSelection({ runtimeId, agentId, operationId, pluginSelection, requestHost, service, assertCurrent = () => {}, requireNewOperation = false }) {
  if (!id(runtimeId) || !id(agentId, 128) || !id(operationId, 128)
    || typeof requestHost !== "function" || typeof service?.prepareExternalPluginSelection !== "function") fail();
  pluginSelection = structuredClone(pluginSelection);
  const capability = subject(await requestHost("prompt.selection.capabilities", { session_id: runtimeId }), agentId);
  assertCurrent();
  const input = validateExternalPluginSelectionInput("plugins.selection.external.prepare", {
    ...capability, operationId, requiredAdapterId: ADAPTER_ID, pluginSelection });
  const previous = await getReceipt(requestHost, runtimeId, operationId);
  assertCurrent();
  if (requireNewOperation && previous !== null) fail(true);
  if (previous && (previous.adapter_generation !== input.adapterGeneration
    || (previous.actual_session_id !== null && previous.actual_session_id !== input.subject.sessionId))) fail(true);
  const prepared = validateExternalPluginSelectionResult("plugins.selection.external.prepare",
    await service.prepareExternalPluginSelection(input), input);
  assertCurrent();
  const selection = Object.freeze({ subject: prepared.receipt.subject, envelope: prepared.envelope, runtimeId, operationId });
  if (previous) validateHermesSelectionReceipt(previous, selection);
  if (prepared.receipt.state !== "prepared"
    && (!previous || !["bound", "completed"].includes(prepared.receipt.state))) fail(true);
  if (previous && ["unknown", "interrupted"].includes(previous.state)) fail(true);
  return { wire: Object.freeze(wire(prepared.envelope)), selection };
}
async function cancelHermesPluginSelectionSession({ runtimeId, agentId, requestHost, service }) {
  if (!id(runtimeId) || !id(agentId, 128) || typeof service?.cancelSessionExternalPluginSelections !== "function") fail();
  const capability = subject(await requestHost("prompt.selection.capabilities", { session_id: runtimeId }), agentId);
  return service.cancelSessionExternalPluginSelections({ subject: capability.subject });
}
async function readHermesPluginSelectionOperation({ runtimeId, agentId, sessionKey, operationId, requestHost }) {
  if (!id(runtimeId) || !id(agentId, 128) || !id(operationId, 128)) fail(true);
  const capability = subject(await requestHost("prompt.selection.capabilities", { session_id: runtimeId }), agentId);
  const value = await getReceipt(requestHost, runtimeId, operationId);
  if (value === null) return { status: "not_found", operationId, sessionKey, backendId: "hermes" };
  const receipt = validateHermesSelectionReceipt(value, { subject: capability.subject,
    operationId, envelope: Object.fromEntries(Object.entries(WIRE).map(([source, target]) => [target, value?.[source]])) });
  const statuses = { accepted: "accepted", queued: "queued", binding: "running", bound: "running", complete: "completed",
    stopped: "canceled", failed: "failed", canceled: "canceled", cancelled: "canceled", interrupted: "interrupted", unknown: "needs_verification" };
  return { status: "found", operationId, sessionKey, backendId: "hermes", admissionAccepted: true,
    run: { status: statuses[receipt.state], runId: receipt.actual_turn_id } };
}
module.exports = { trustedHermesSelectionSubject: subject, getHermesSelectionReceipt: getReceipt, prepareHermesPluginSelection, validateHermesSelectionReceipt, validateHermesSelectionAcknowledgement,
  cancelHermesPluginSelectionSession, readHermesPluginSelectionOperation };
