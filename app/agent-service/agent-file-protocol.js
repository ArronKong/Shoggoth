"use strict";

const { MIMEType } = require("node:util");

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const FILE_PAGE_SIZE = 20;
const FILE_ID = /^[a-f0-9]{64}$/u;
const UPLOAD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RUN_SOURCES = Object.freeze(["chat", "cron", "kanban", "inspiration", "proactive"]);
const MESSAGES = Object.freeze({
  AGENT_FILE_INVALID: "Invalid file information.",
  AGENT_FILE_NOT_FOUND: "This file could not be found.",
  AGENT_FILE_MISSING: "The file is missing or has changed on disk.",
  AGENT_FILE_DELETED: "This file has been deleted.",
  AGENT_FILE_CONFLICT: "The file changed. Refresh and try again.",
  AGENT_FILE_TOO_LARGE: "The maximum file size is 16 MiB.",
  AGENT_FILE_CAPACITY: "This Agent has reached its file limit.",
  AGENT_FILE_SOURCE_CHANGED: "The source file changed before it could be saved.",
  AGENT_FILE_COMMIT_UNCERTAIN: "The save result is uncertain. Retry the same operation.",
  AGENT_FILE_UNSUPPORTED: "This Agent does not have a managed file library.",
  AGENT_FILE_UNAVAILABLE: "Agent files are temporarily unavailable.",
});
const FIELDS = Object.freeze({
  "agent.files.list": ["profileId", "runId", "sessionKey", "cursor", "limit", "includeMissing"],
  "agent.files.get": ["profileId", "fileId"],
  "agent.files.import": ["profileId", "operationId", "uploadId", "name", "mimeType", "sizeBytes", "sha256"],
  "agent.files.rename": ["profileId", "fileId", "expectedRevision", "name"],
  "agent.files.delete": ["profileId", "fileId", "expectedRevision"],
});
const METHODS = Object.freeze(Object.keys(FIELDS));
const FILE_FIELDS = ["fileId", "profileId", "name", "mimeType", "sizeBytes", "sha256",
  "createdAt", "updatedAt", "revision", "source", "status"];

function fail(code, cause) {
  throw Object.assign(new Error(MESSAGES[code], cause ? { cause } : undefined), { code });
}
function exact(value, fields) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function validText(value, max) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !/[\p{Cc}]/u.test(value) && Buffer.byteLength(value) <= max;
}
function validId(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}
function filename(value) {
  const name = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!validText(name, 200) || Buffer.byteLength(name.normalize("NFD")) > 200
    || name.startsWith(".") || name.endsWith(".") || /[\\/:*?"<>|]/u.test(name)) fail("AGENT_FILE_INVALID");
  return name;
}
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const revision = (value) => count(value) && value > 0;
const nullableText = (value, max) => value === null || validText(value, max);
const mime = (value) => value === null || (validText(value, 128) && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(value));

function fileMimeType(value) {
  if (value === null) return null;
  if (validText(value, 256)) {
    try {
      const essence = new MIMEType(value).essence;
      if (mime(essence)) return essence;
    } catch { /* Invalid media type. */ }
  }
  fail("AGENT_FILE_INVALID");
}

function validSource(source) {
  if (!exact(source, ["kind", "runId", "sourceId", "sessionKey"])) return false;
  if (source.kind === "import") return source.runId === null && source.sourceId === null && source.sessionKey === null;
  return RUN_SOURCES.includes(source.kind) && validText(source.runId, 256) && validText(source.sourceId, 512)
    && nullableText(source.sessionKey, 512);
}

function validateFile(file, profileId) {
  if (!exact(file, FILE_FIELDS) || !validId(file.fileId, FILE_ID) || file.profileId !== profileId
    || filename(file.name) !== file.name || !mime(file.mimeType)
    || !count(file.sizeBytes) || file.sizeBytes > MAX_FILE_BYTES || !validId(file.sha256, FILE_ID)
    || !count(file.createdAt) || !count(file.updatedAt) || file.updatedAt < file.createdAt
    || !revision(file.revision) || !validSource(file.source)
    || !["available", "missing", "deleted"].includes(file.status)) fail("AGENT_FILE_INVALID");
  return file;
}

function validateParams(method, params) {
  if (!Object.hasOwn(FIELDS, method) || !exact(params, FIELDS[method]) || !validId(params.profileId, PROFILE_ID)) {
    fail("AGENT_FILE_INVALID");
  }
  if (method === "agent.files.list") {
    if (!nullableText(params.runId, 256) || !nullableText(params.sessionKey, 512)
      || !count(params.cursor) || !revision(params.limit) || params.limit > FILE_PAGE_SIZE
      || typeof params.includeMissing !== "boolean") fail("AGENT_FILE_INVALID");
  } else if (method === "agent.files.import") {
    if (!validText(params.operationId, 256) || !validId(params.uploadId, UPLOAD_ID)
      || !count(params.sizeBytes) || !validId(params.sha256, FILE_ID)) fail("AGENT_FILE_INVALID");
    if (params.sizeBytes > MAX_FILE_BYTES) fail("AGENT_FILE_TOO_LARGE");
    return { ...params, name: filename(params.name), mimeType: fileMimeType(params.mimeType) };
  } else {
    if (!validId(params.fileId, FILE_ID) || (method !== "agent.files.get" && !revision(params.expectedRevision))) {
      fail("AGENT_FILE_INVALID");
    }
  }
  return Object.hasOwn(params, "name") ? { ...params, name: filename(params.name) } : params;
}

function validateResult(method, result, params) {
  if (method === "agent.files.list") {
    if (!exact(result, ["items", "nextCursor"]) || !Array.isArray(result.items) || result.items.length > params.limit
      || (result.nextCursor !== null && result.nextCursor !== params.cursor + result.items.length)
      || (result.nextCursor !== null && result.items.length !== params.limit)) fail("AGENT_FILE_INVALID");
    for (const file of result.items) {
      validateFile(file, params.profileId);
      if ((params.runId && params.runId !== file.source.runId) || (params.sessionKey && params.sessionKey !== file.source.sessionKey)
        || file.status === "deleted" || (!params.includeMissing && file.status !== "available")) fail("AGENT_FILE_INVALID");
    }
  } else {
    const get = method === "agent.files.get";
    if (!exact(result, get ? ["file", "path"] : ["file"])) fail("AGENT_FILE_INVALID");
    validateFile(result.file, params.profileId);
    if (params.fileId && params.fileId !== result.file.fileId) fail("AGENT_FILE_INVALID");
    if (get && (result.file.status === "available" ? !validText(result.path, 4096) : result.path !== null)) fail("AGENT_FILE_INVALID");
  }
  return result;
}

function contentUrl(backendId, agentId, fileId) {
  return `/__api/agents/${encodeURIComponent(agentId)}/managed-files/${fileId}/content?backend=${encodeURIComponent(backendId)}`;
}

module.exports = {
  MAX_FILE_BYTES, FILE_PAGE_SIZE, FILE_ID, UPLOAD_ID, PROFILE_ID, RUN_SOURCES, METHODS,
  MESSAGES, fail, filename, fileMimeType, validateFile, validateParams, validateResult, contentUrl,
};
