"use strict";

const { validateExternalInspirationParams, validateExternalInspirationResult,
  validateGroupExternalDraftParams, validateGroupExternalDraftResult, validateGroupExternalResultParams,
  validateGroupExternalResultResult } = require("./external-inspiration-protocol");
const { isGroupMcpTool, validateGroupMcpArguments } = require("./agent-service/group-mcp-tools");
const crypto = require("node:crypto");

const VERSION = 2;
const FRAME_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const id = value => typeof value === "string" && ID.test(value);
const uuid = value => typeof value === "string" && UUID.test(value);
const text = (value, max = 4096) => typeof value === "string" && value.length > 0 && value.isWellFormed()
  && !/[\u0000-\u001f]/u.test(value) && Buffer.byteLength(value) <= max;
const epoch = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === "string" && HASH.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };

const { validAuthority, validRemoteBinding, validIsolation, validResource } = require("./group-runtime-binding");
function validPeer(value) {
  if (!exact(value, ["id", "backendId", "agentId", "baseUrl", "token", "hostId"]) || !id(value.id)
    || !["hermes", "openclaw"].includes(value.backendId) || !id(value.agentId) || !uuid(value.hostId)
    || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(value.token)) return false;
  try {
    const url = new URL(value.baseUrl);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
      && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
function normalizePeers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || !value.every(validPeer)
    || new Set(value.map(peer => peer.id)).size !== value.length
    || new Set(value.map(peer => peer.hostId)).size !== value.length) fail("GROUP_HOST_CONFIG_INVALID");
  return structuredClone(value);
}

function validHostRequest(value) {
  if (!exact(value, ["version", "id", "hostId", "authority", "method", "params"]) || ![1, VERSION].includes(value.version)
    || !uuid(value.id) || !uuid(value.hostId) || (value.authority !== null && !validAuthority(value.authority))) return false;
  const { method, params } = value;
  if (method === "host.capabilities") return exact(params, ["backendId", "agentId"])
    && ["openclaw", "hermes"].includes(params.backendId) && id(params.agentId);
  if (method === "host.member" || method === "host.models") return exact(params, ["backendId", "agentId"]) && ["openclaw", "hermes"].includes(params.backendId) && id(params.agentId);
  if (method === "host.role") return exact(params, ["digest", "offset"]) && digest(params.digest) && Number.isSafeInteger(params.offset) && params.offset >= 0;
  if (!value.authority) return false;
  if (method === "host.group.stop") return exact(params, []);
  if (method === "host.authority.transfer") return exact(params, ["ownerId", "epoch"]) && uuid(params.ownerId)
    && epoch(params.epoch) && params.epoch > value.authority.epoch;
  if (method === "host.prepare") return exact(params, ["execution", "kind", "taskId"])
    && validateExternalInspirationParams("group.external.prepare", params.execution) && ["turn", "task"].includes(params.kind)
    && (params.kind === "turn" ? params.taskId === null : uuid(params.taskId));
  if (method === "host.execution") return validateExternalInspirationParams("group.external.get", params);
  if (method === "host.tools.next") return exact(params, []) ;
  if (method === "host.tools.result") return exact(params, ["callId", "fingerprint", "result"])
    && id(params.callId) && digest(params.fingerprint) && params.result !== undefined;
  if (method === "host.artifact") return exact(params, ["execution", "path", "digest", "offset"])
    && validateExternalInspirationParams("group.external.get", params.execution) && text(params.path, 1024)
    && (params.digest === null || digest(params.digest)) && Number.isSafeInteger(params.offset) && params.offset >= 0;
  if (method === "group.external.draft") return validateGroupExternalDraftParams(params);
  if (method === "group.external.activity") return value.version === VERSION
    && require("./external-inspiration-protocol").validateGroupExternalActivityParams(params);
  if (method === "group.external.result") return validateGroupExternalResultParams(params);
  if (method === "group.external.metadata") return require("./external-inspiration-protocol").validateGroupExternalMetadataParams(params);
  return method.startsWith("group.external.") && validateExternalInspirationParams(method, params);
}
function validHostResult(method, result) {
  if (method === "host.group.stop") return exact(result, ["stopped", "pending"]) && result.stopped === true
    && Number.isSafeInteger(result.pending) && result.pending >= 0;
  if (method === "host.models") return require("./group-member-model").validModelCatalog(result);
  if (method === "host.member") return exact(result, ["agent", "document"]) && exact(result.agent, ["id", "name", "model"])
    && id(result.agent.id) && text(result.agent.name, 256) && (result.agent.model === null || text(result.agent.model, 512))
    && exact(result.document, ["digest", "bytes"]) && digest(result.document.digest) && Number.isSafeInteger(result.document.bytes)
    && result.document.bytes >= 0 && result.document.bytes <= 16 * 1024 * 1024;
  if (method === "host.role") return exact(result, ["page"]) && require("./group-result-content").validResultPage(result.page);
  if (method === "host.authority.transfer") return exact(result, ["transferred"]) && result.transferred === true;
  if (method === "host.prepare" || method === "host.execution") {
    if (!exact(result, ["hostId", method === "host.prepare" ? "binding" : "snapshot", "isolation", "resource"]) || !validIsolation(result.isolation) || !validResource(result.resource)) return false;
    const { isolation: _i, resource: _r, ...plain } = result;
    return validateExternalInspirationResult(method === "host.prepare" ? "group.external.prepare" : "group.external.get", plain);
  }
  if (method === "host.capabilities") return exact(result, ["version", "hostId", "backendId", "agentId", "groupTools", "workspaces", "artifacts", ...(result.version === VERSION ? ["capabilities"] : [])])
    && [1, VERSION].includes(result.version) && uuid(result.hostId) && ["hermes", "openclaw"].includes(result.backendId)
    && id(result.agentId) && typeof result.groupTools === "boolean" && typeof result.workspaces === "boolean" && result.artifacts === true
    && (result.version === 1 || require("./agent-service/group-capabilities").validGroupCapabilities(result.capabilities));
  if (method === "host.tools.next") return exact(result, ["calls"]) && Array.isArray(result.calls) && result.calls.length <= 8
    && result.calls.every(validToolCall);
  if (method === "host.tools.result") return exact(result, ["accepted"]) && result.accepted === true;
  if (method === "host.artifact") return exact(result, ["artifact"]) && (result.artifact === null
    || exact(result.artifact, ["path", "digest", "bytes", "offset", "nextOffset", "content"])
      && text(result.artifact.path, 1024) && digest(result.artifact.digest) && Number.isSafeInteger(result.artifact.bytes)
      && result.artifact.bytes >= 0 && result.artifact.bytes <= 64 * 1024 * 1024
      && Number.isSafeInteger(result.artifact.offset) && result.artifact.offset >= 0
      && (result.artifact.nextOffset === null || Number.isSafeInteger(result.artifact.nextOffset))
      && typeof result.artifact.content === "string" && /^[A-Za-z0-9+/]*={0,2}$/u.test(result.artifact.content)
      && result.artifact.content.length <= 32 * 1024);
  if (method === "group.external.draft") return validateGroupExternalDraftResult(result);
  if (method === "group.external.activity") return require("./external-inspiration-protocol").validateGroupExternalActivityResult(result);
  if (method === "group.external.result") return validateGroupExternalResultResult(result);
  if (method === "group.external.metadata") return require("./external-inspiration-protocol").validateGroupExternalMetadataResult(result);
  return validateExternalInspirationResult(method, result);
}
function validToolCall(value) {
  return exact(value, ["callId", "fingerprint", "execution", "name", "arguments"])
    && id(value.callId) && digest(value.fingerprint) && validateExternalInspirationParams("group.external.get", value.execution)
    && isGroupMcpTool(value.name) && validateGroupMcpArguments(value.name, value.arguments)
    && Object.hasOwn(value.arguments, "groupToken");
}
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

module.exports = { VERSION, FRAME_BYTES, exact, id, uuid, text, epoch, digest, fail, fingerprint,
  validAuthority, validRemoteBinding, validPeer, normalizePeers, validHostRequest, validHostResult, validToolCall };
