"use strict";

const { validateExternalPluginSelectionInput, validateExternalPluginSelectionResult } = require("./plugin-external-selection-dto");
const ADAPTER_ID = "shoggoth-shared-capabilities";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ENVELOPE_FIELDS = ["version", "operationId", "dispatchRef", "selectionDigest", "requiredAdapterId", "adapterGeneration"];
const RECEIPT_FIELDS = [...ENVELOPE_FIELDS, "agentId", "sessionKey", "sessionId", "clientRunId", "actualRunId", "status", "acceptedAt", "updatedAt"];
const STATUSES = new Set(["accepted", "queued", "bound", "completed", "blocked", "failed", "aborted", "needs-verification"]);

function failure(uncertain = false) {
  const error = new Error(uncertain
    ? "原插件消息的执行结果需要核实，请保留输入并查询原操作"
    : "当前 OpenClaw 尚未提供可信插件选择，输入已保留");
  error.code = uncertain ? "PLUGIN_SELECTION_NEEDS_VERIFICATION" : "PLUGIN_SELECTION_UNAVAILABLE";
  error.executionUncertain = uncertain;
  return error;
}
function exact(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
}
function id(value, max = 256) {
  return typeof value === "string" && ID.test(value) && Buffer.byteLength(value, "utf8") <= max;
}
function sameEnvelope(left, right) { return ENVELOPE_FIELDS.every(field => left?.[field] === right[field]); }

function selectionAdapter(capabilities, withSubject) {
  const fields = ["version", "host", "hostVersion", "wire", "receiptMethod", "supportedQueueModes", "supportedHarnesses", "adapters"];
  if (!exact(capabilities, withSubject ? [...fields, "subject"] : fields)
    || capabilities.version !== 1 || capabilities.host !== "openclaw" || capabilities.hostVersion !== "2026.9.5"
    || capabilities.wire !== "capabilitySelection" || capabilities.receiptMethod !== "chat.selection.get"
    || !Array.isArray(capabilities.supportedQueueModes) || !capabilities.supportedQueueModes.includes("followup")
    || !Array.isArray(capabilities.supportedHarnesses) || !capabilities.supportedHarnesses.includes("openclaw")
    || !Array.isArray(capabilities.adapters) || capabilities.adapters.length > 32) throw failure();
  const adapters = capabilities.adapters.filter(item => item?.adapterId === ADAPTER_ID);
  if (adapters.length !== 1 || !exact(adapters[0], ["adapterId", "adapterGeneration", "instanceId"])
    || !id(adapters[0].adapterGeneration, 128) || !id(adapters[0].instanceId, 128)) throw failure();
  return adapters[0];
}

function hostSubject(capabilities, sessionKey, agentId) {
  const adapter = selectionAdapter(capabilities, true);
  if (!exact(capabilities.subject, ["sessionKey", "sessionId", "agentId"])
    || capabilities.subject.sessionKey !== sessionKey || capabilities.subject.agentId !== agentId
    || !id(capabilities.subject.sessionId)) throw failure();
  return { subject: { backendId: "openclaw", instanceId: adapter.instanceId,
    agentId, sessionId: capabilities.subject.sessionId }, adapterGeneration: adapter.adapterGeneration };
}

function supportsOpenClawPluginSelection(capabilities) {
  try { selectionAdapter(capabilities, false); return true; } catch { return false; }
}

function validateOpenClawSelectionReceipt(value, selection) {
  const fields = value && Object.hasOwn(value, "errorCode") ? [...RECEIPT_FIELDS, "errorCode"] : RECEIPT_FIELDS;
  if (!exact(value, fields) || value.version !== 1 || !id(value.operationId, 128)
    || !id(value.dispatchRef, 128) || typeof value.selectionDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.selectionDigest) || value.requiredAdapterId !== ADAPTER_ID
    || !id(value.adapterGeneration, 128) || !id(value.agentId, 128) || !id(value.sessionId)
    || !sameEnvelope(value, selection.envelope)
    || value.operationId !== selection.operationId
    || value.agentId !== selection.subject.agentId || value.sessionId !== selection.subject.sessionId
    || value.sessionKey !== selection.sessionKey || value.clientRunId !== selection.operationId
    || !STATUSES.has(value.status) || (value.actualRunId !== null && !id(value.actualRunId))
    || (["bound", "completed"].includes(value.status) && value.actualRunId === null)
    || !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.acceptedAt
    || (Object.hasOwn(value, "errorCode") && !id(value.errorCode, 200))) throw failure(true);
  return Object.freeze({ ...value });
}

async function prepareOpenClawPluginSelection({ params, requestHost, service, assertCurrent = () => {} }) {
  if (!params || Object.getPrototypeOf(params) !== Object.prototype
    || typeof requestHost !== "function" || typeof service?.prepareExternalPluginSelection !== "function"
    || Object.hasOwn(params, "capabilitySelection")) throw failure();
  const captured = structuredClone(params);
  const { sessionKey, idempotencyKey: operationId } = captured;
  const agentId = typeof sessionKey === "string" ? /^agent:([^:]+)(?::|$)/u.exec(sessionKey)?.[1] : null;
  if (!id(agentId, 128) || typeof sessionKey !== "string" || Buffer.byteLength(sessionKey, "utf8") > 256
    || /[\u0000-\u001f\u007f]/u.test(sessionKey) || !id(operationId, 128)
    || (captured.agentId !== undefined && captured.agentId !== agentId)) throw failure();
  // Host materializes a physical session through its existing sessions.create,
  // without a model turn. Never infer a physical ID from the UI session key.
  const capability = hostSubject(await requestHost("chat.selection.capabilities", { sessionKey, agentId }), sessionKey, agentId);
  assertCurrent();
  if (captured.sessionId !== undefined && captured.sessionId !== capability.subject.sessionId) throw failure();
  const input = validateExternalPluginSelectionInput("plugins.selection.external.prepare", {
    ...capability, operationId, requiredAdapterId: ADAPTER_ID, pluginSelection: captured.pluginSelection });
  const previous = await requestHost("chat.selection.get", { operationId, sessionKey, agentId });
  assertCurrent();
  if (previous && (previous.adapterGeneration !== input.adapterGeneration
    || previous.sessionId !== input.subject.sessionId || previous.agentId !== agentId)) throw failure(true);
  const prepared = validateExternalPluginSelectionResult("plugins.selection.external.prepare",
    await service.prepareExternalPluginSelection(input), input);
  assertCurrent();
  const selection = Object.freeze({ subject: prepared.receipt.subject, envelope: prepared.envelope, sessionKey, operationId });
  if (previous) validateOpenClawSelectionReceipt(previous, selection);
  if (prepared.receipt.state !== "prepared"
    && (!previous || !["bound", "completed"].includes(prepared.receipt.state))) throw failure(true);
  if (previous?.status === "needs-verification") throw failure(true);
  const wire = { ...captured, sessionId: selection.subject.sessionId, capabilitySelection: selection.envelope };
  delete wire.pluginSelection;
  // Existing operations are sent to the Host's durable replay check so it also
  // compares the original message/attachments. The Host never reruns a replay.
  return { params: wire, selection };
}

async function cancelOpenClawPluginSelectionSession({ sessionKey, requestHost, service }) {
  const agentId = typeof sessionKey === "string" ? /^agent:([^:]+)(?::|$)/u.exec(sessionKey)?.[1] : null;
  if (!id(agentId, 128) || typeof service?.cancelSessionExternalPluginSelections !== "function") throw failure();
  const capability = hostSubject(await requestHost("chat.selection.capabilities", { sessionKey, agentId }), sessionKey, agentId);
  return service.cancelSessionExternalPluginSelections({ subject: capability.subject });
}

async function readOpenClawPluginSelectionOperation({ sessionKey, operationId, requestHost }) {
  const agentId = typeof sessionKey === "string" ? /^agent:([^:]+)(?::|$)/u.exec(sessionKey)?.[1] : null;
  if (!id(agentId, 128) || !id(operationId, 128) || typeof requestHost !== "function") throw failure(true);
  const value = await requestHost("chat.selection.get", { sessionKey, operationId, agentId });
  if (value === null) return { status: "not_found", operationId, sessionKey, backendId: "openclaw" };
  const receipt = validateOpenClawSelectionReceipt(value, { sessionKey, operationId,
    envelope: Object.fromEntries(ENVELOPE_FIELDS.map(field => [field, value?.[field]])),
    subject: { agentId, sessionId: value?.sessionId } });
  const statuses = { accepted: "accepted", queued: "queued", bound: "running", completed: "completed",
    blocked: "failed", failed: "failed", aborted: "canceled", "needs-verification": "needs_verification" };
  return { status: "found", operationId, sessionKey, backendId: "openclaw", admissionAccepted: true,
    run: { status: statuses[receipt.status], runId: receipt.actualRunId } };
}

module.exports = { prepareOpenClawPluginSelection, validateOpenClawSelectionReceipt,
  cancelOpenClawPluginSelectionSession, readOpenClawPluginSelectionOperation, supportsOpenClawPluginSelection };
