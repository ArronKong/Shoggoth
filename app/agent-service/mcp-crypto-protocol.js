"use strict";

const path = require("node:path");
const { serviceError } = require("./security");

const MCP_CRYPTO_PROTOCOL_VERSION = 1;
const MCP_CRYPTO_GATE_BYTES = 32;
const MCP_CRYPTO_SECRET_BYTES = 32;
const MCP_CRYPTO_RESPONSE_HEADER_BYTES = 41;
const MCP_CRYPTO_SUCCESS_FRAME_BYTES = 73;
const MCP_CRYPTO_ERROR_FRAME_BYTES = 41;
const MAX_MCP_CRYPTO_HEADER_BYTES = 16 * 1024;
const MAX_SAFE_STORAGE_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_MCP_CRYPTO_REQUEST_BYTES = MAX_MCP_CRYPTO_HEADER_BYTES
  + MAX_SAFE_STORAGE_PAYLOAD_BYTES;
const MCP_CRYPTO_OPERATIONS = new Set([
  "service.loadOrCreate", "service.rewrapLegacyMcpAuth", "helper.read", "safeStorage.encrypt", "safeStorage.decrypt",
]);
const MCP_CRYPTO_CALLER_ROLES = new Set(["agent-service", "mcp"]);

function cryptoError(code = "MCP_CRYPTO_UNAVAILABLE") {
  return serviceError(code, "mcp_crypto_unavailable");
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function decodeBase64Url(value, bytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}

function validateWorkerPaths(paths) {
  if (!exactObject(paths, ["trustedRoot", "stateDir", "mcpAuthPath", "profileDir", "cacheDir"])) {
    throw cryptoError("MCP_CRYPTO_REQUEST_INVALID");
  }
  for (const value of Object.values(paths)) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
      throw cryptoError("MCP_CRYPTO_REQUEST_INVALID");
    }
  }
  if (path.dirname(paths.mcpAuthPath) !== paths.stateDir
    || path.basename(paths.mcpAuthPath) !== "mcp-auth.json") {
    throw cryptoError("MCP_CRYPTO_REQUEST_INVALID");
  }
  return Object.freeze({ ...paths });
}

function validateWorkerGate(gate) {
  if (!exactObject(gate, [
    "version", "parentPid", "generation", "nonce", "callerRole", "parentExecutable", "appRoot",
  ]) || gate.version !== MCP_CRYPTO_PROTOCOL_VERSION
    || !Number.isSafeInteger(gate.parentPid) || gate.parentPid <= 0
    || !Number.isSafeInteger(gate.generation) || gate.generation <= 0
    || !MCP_CRYPTO_CALLER_ROLES.has(gate.callerRole)
    || typeof gate.parentExecutable !== "string" || !path.isAbsolute(gate.parentExecutable)
    || typeof gate.appRoot !== "string" || !path.isAbsolute(gate.appRoot)) {
    throw cryptoError("MCP_CRYPTO_GATE_INVALID");
  }
  const nonce = decodeBase64Url(gate.nonce, MCP_CRYPTO_GATE_BYTES);
  if (!nonce) throw cryptoError("MCP_CRYPTO_GATE_INVALID");
  nonce.fill(0);
  return Object.freeze({ ...gate });
}

function validateWorkerRequest(request, gate) {
  if (!exactObject(request, ["version", "generation", "operation", "paths", "payloadBytes"])
    || request.version !== MCP_CRYPTO_PROTOCOL_VERSION
    || request.generation !== gate.generation
    || !MCP_CRYPTO_OPERATIONS.has(request.operation)
    || (["service.loadOrCreate", "service.rewrapLegacyMcpAuth"].includes(request.operation)
      && gate.callerRole !== "agent-service")
    || (request.operation === "helper.read" && gate.callerRole !== "mcp")
    || !Number.isSafeInteger(request.payloadBytes) || request.payloadBytes < 0
    || request.payloadBytes > MAX_SAFE_STORAGE_PAYLOAD_BYTES
    || (["service.loadOrCreate", "service.rewrapLegacyMcpAuth", "helper.read"].includes(request.operation)
      && request.payloadBytes !== 0)
    || (["safeStorage.encrypt", "safeStorage.decrypt"].includes(request.operation)
      && request.payloadBytes === 0)) {
    throw cryptoError("MCP_CRYPTO_REQUEST_INVALID");
  }
  return Object.freeze({ ...request, paths: validateWorkerPaths(request.paths) });
}

function encodeWorkerRequest({ gate, request, payload = null }) {
  const validated = validateWorkerRequest(request, gate);
  const payloadBytes = payload === null ? Buffer.alloc(0) : payload;
  if (!Buffer.isBuffer(payloadBytes) || payloadBytes.length !== validated.payloadBytes) {
    throw cryptoError("MCP_CRYPTO_REQUEST_INVALID");
  }
  const header = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  try {
    if (header.length === 0 || header.length > MAX_MCP_CRYPTO_HEADER_BYTES) {
      throw cryptoError("MCP_CRYPTO_REQUEST_INVALID");
    }
    return Buffer.concat([header, payloadBytes]);
  } finally {
    header.fill(0);
  }
}

function decodeWorkerRequestFrame(frame, gate) {
  if (!Buffer.isBuffer(frame) || frame.length === 0 || frame.length > MAX_MCP_CRYPTO_REQUEST_BYTES) {
    throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
  }
  const newline = frame.indexOf(0x0a);
  if (newline <= 0 || newline >= MAX_MCP_CRYPTO_HEADER_BYTES
    || frame.subarray(0, newline).includes(0x0a)) {
    throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
  }
  let parsed;
  try {
    parsed = JSON.parse(frame.subarray(0, newline).toString("utf8"));
  } catch {
    throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
  }
  const request = validateWorkerRequest(parsed, gate);
  if (frame.length - newline - 1 !== request.payloadBytes) {
    throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
  }
  return Object.freeze({ request, payload: Buffer.from(frame.subarray(newline + 1)) });
}

function encodeWorkerResponse({ gate, secret = null, payload = null, ok }) {
  const validated = validateWorkerGate(gate);
  const nonce = decodeBase64Url(validated.nonce, MCP_CRYPTO_GATE_BYTES);
  const responsePayload = payload || secret;
  const payloadLength = ok && Buffer.isBuffer(responsePayload) ? responsePayload.length : 0;
  const frame = Buffer.alloc(ok
    ? MCP_CRYPTO_RESPONSE_HEADER_BYTES + payloadLength
    : MCP_CRYPTO_ERROR_FRAME_BYTES);
  try {
    frame[0] = ok ? 0 : 1;
    frame.writeBigUInt64BE(BigInt(validated.generation), 1);
    nonce.copy(frame, 9);
    if (ok) {
      if (!Buffer.isBuffer(responsePayload) || responsePayload.length === 0
        || responsePayload.length > MAX_SAFE_STORAGE_PAYLOAD_BYTES) {
        frame.fill(0);
        throw cryptoError("MCP_CRYPTO_RESPONSE_INVALID");
      }
      responsePayload.copy(frame, MCP_CRYPTO_RESPONSE_HEADER_BYTES);
    }
    return frame;
  } finally {
    nonce.fill(0);
  }
}

function decodeWorkerResponse(frame, gate, options = {}) {
  const validated = validateWorkerGate(gate);
  const expectedPayloadBytes = options.expectedPayloadBytes ?? MCP_CRYPTO_SECRET_BYTES;
  const maxPayloadBytes = options.maxPayloadBytes ?? expectedPayloadBytes;
  if (!Number.isSafeInteger(expectedPayloadBytes) || expectedPayloadBytes < 0
    || !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1
    || maxPayloadBytes > MAX_SAFE_STORAGE_PAYLOAD_BYTES) {
    throw cryptoError("MCP_CRYPTO_RESPONSE_INVALID");
  }
  if (!Buffer.isBuffer(frame)
    || frame.length < MCP_CRYPTO_ERROR_FRAME_BYTES
    || frame.length > MCP_CRYPTO_RESPONSE_HEADER_BYTES + maxPayloadBytes) {
    throw cryptoError("MCP_CRYPTO_RESPONSE_INVALID");
  }
  const expectedNonce = decodeBase64Url(validated.nonce, MCP_CRYPTO_GATE_BYTES);
  const actualNonce = Buffer.from(frame.subarray(9, 41));
  try {
    const generation = Number(frame.readBigUInt64BE(1));
    if (!Number.isSafeInteger(generation) || generation !== validated.generation
      || actualNonce.length !== expectedNonce.length
      || !require("node:crypto").timingSafeEqual(actualNonce, expectedNonce)) {
      throw cryptoError("MCP_CRYPTO_RESPONSE_INVALID");
    }
    if (frame[0] !== 0) {
      if (frame[0] !== 1 || frame.length !== MCP_CRYPTO_ERROR_FRAME_BYTES) {
        throw cryptoError("MCP_CRYPTO_RESPONSE_INVALID");
      }
      throw cryptoError();
    }
    const payloadBytes = frame.length - MCP_CRYPTO_RESPONSE_HEADER_BYTES;
    if (payloadBytes < 1 || payloadBytes > maxPayloadBytes
      || (expectedPayloadBytes > 0 && payloadBytes !== expectedPayloadBytes)) {
      throw cryptoError("MCP_CRYPTO_RESPONSE_INVALID");
    }
    return Buffer.from(frame.subarray(MCP_CRYPTO_RESPONSE_HEADER_BYTES));
  } finally {
    expectedNonce.fill(0);
    actualNonce.fill(0);
  }
}

module.exports = {
  MAX_MCP_CRYPTO_REQUEST_BYTES,
  MAX_MCP_CRYPTO_HEADER_BYTES,
  MAX_SAFE_STORAGE_PAYLOAD_BYTES,
  MCP_CRYPTO_ERROR_FRAME_BYTES,
  MCP_CRYPTO_GATE_BYTES,
  MCP_CRYPTO_PROTOCOL_VERSION,
  MCP_CRYPTO_RESPONSE_HEADER_BYTES,
  MCP_CRYPTO_SECRET_BYTES,
  MCP_CRYPTO_SUCCESS_FRAME_BYTES,
  cryptoError,
  decodeWorkerRequestFrame,
  decodeWorkerResponse,
  encodeWorkerRequest,
  encodeWorkerResponse,
  validateWorkerGate,
  validateWorkerPaths,
  validateWorkerRequest,
};
