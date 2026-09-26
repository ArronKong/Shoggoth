"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { SERVICE_PROTOCOL_VERSION } = require("./service-protocol-version");
const { validRuntimeAccountId, validRuntimeProfileId } = require("./runtime-adapter");

const FEDERATION_MCP_AUTH_FILENAME = "federation-mcp-auth.json";
const FEDERATION_MCP_CLIENTS = new Set(["openclaw", "hermes"]);
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;

function federationMcpAuthPath(paths) {
  if (!paths?.stateDir || !paths?.trustedRoot
    || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw new TypeError("Federation MCP paths 无效");
  }
  return path.join(paths.stateDir, FEDERATION_MCP_AUTH_FILENAME);
}

function validFederationMcpToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  try { return decoded.length === 32 && decoded.toString("base64url") === value; } finally {
    decoded.fill(0);
  }
}

function parseCredential(raw) {
  let value;
  try { value = JSON.parse(raw.toString("utf8")); } catch {
    throw serviceError("FEDERATION_MCP_AUTH_INVALID", "federation_mcp_auth_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== "createdAt,schemaVersion,token"
    || value.schemaVersion !== 1 || !validFederationMcpToken(value.token)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw serviceError("FEDERATION_MCP_AUTH_INVALID", "federation_mcp_auth_invalid");
  }
  return Object.freeze({ ...value });
}

function loadFederationMcpCredential(paths, options = {}) {
  const target = federationMcpAuthPath(paths);
  const raw = readPrivateFile(target, { fs: options.fs, maxBytes: 1024 });
  try { return parseCredential(raw); } finally { raw.fill(0); }
}

function ensureFederationMcpCredential(paths, options = {}) {
  const target = federationMcpAuthPath(paths);
  const fileSystem = options.fs;
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  if (lstatIfExists(target)) return loadFederationMcpCredential(paths, options);
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || Date.now;
  let bytes;
  let createdAt;
  try {
    bytes = randomBytes(32);
    createdAt = now();
  } catch {
    throw serviceError("FEDERATION_MCP_AUTH_UNAVAILABLE", "federation_mcp_auth_unavailable");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32
    || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    throw serviceError("FEDERATION_MCP_AUTH_UNAVAILABLE", "federation_mcp_auth_unavailable");
  }
  let token;
  try { token = bytes.toString("base64url"); } finally { bytes.fill(0); }
  atomicWritePrivateFile(target, `${JSON.stringify({ schemaVersion: 1, token, createdAt })}\n`, {
    fs: fileSystem,
    trustedRoot: paths.trustedRoot,
  });
  token = null;
  return loadFederationMcpCredential(paths, options);
}

function sameFederationMcpToken(left, right) {
  if (!validFederationMcpToken(left) || !validFederationMcpToken(right)) return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  try { return crypto.timingSafeEqual(a, b); } finally { a.fill(0); b.fill(0); }
}

function sessionDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class FederationMcpSessionManager {
  constructor(options = {}) {
    if (!options.productStore || typeof options.productStore.getAgentProfile !== "function"
      || !options.paths?.stateDir || !options.paths?.trustedRoot
      || (options.now !== undefined && typeof options.now !== "function")
      || (options.randomBytes !== undefined && typeof options.randomBytes !== "function")) {
      throw new TypeError("FederationMcpSessionManager 配置无效");
    }
    this.productStore = options.productStore;
    this.paths = options.paths;
    this.defaultProfileId = options.defaultProfileId;
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (typeof this.defaultProfileId !== "string" || !this.defaultProfileId
      || !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000
      || !Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new TypeError("FederationMcpSessionManager 配置无效");
    }
    this.sessions = new Map();
    this.closed = false;
  }

  issue({ runtimeProfileId, runtimeAccountId, credentialToken, client }) {
    if (this.closed || !validRuntimeProfileId(runtimeProfileId)
      || !validRuntimeAccountId(runtimeAccountId)
      || !FEDERATION_MCP_CLIENTS.has(client)) {
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    const credential = loadFederationMcpCredential(this.paths);
    if (!sameFederationMcpToken(credential.token, credentialToken)) {
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    const profile = this.productStore.getAgentProfile(this.defaultProfileId);
    if (!profile || profile.id !== this.defaultProfileId || profile.enabled !== true
      || profile.runtimeProfileId !== runtimeProfileId
      || profile.runtimeAccountId !== runtimeAccountId) {
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.ttlMs) {
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    this.#purge(now);
    if (this.sessions.size >= this.maxSessions) {
      throw serviceError("MCP_AUTH_BUSY", "mcp_auth_busy");
    }
    let bytes;
    try { bytes = this.randomBytes(32); } catch {
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    let token;
    try { token = bytes.toString("base64url"); } finally { bytes.fill(0); }
    const session = {
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      runtimeProfileId,
      runtimeAccountId,
      profileId: profile.id,
      expiresAt: now + this.ttlMs,
      federationClient: client,
    };
    this.sessions.set(sessionDigest(token), session);
    return {
      token,
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      runtimeProfileId,
      runtimeAccountId,
      profileId: profile.id,
      expiresAt: session.expiresAt,
    };
  }

  authorize({ runtimeProfileId, runtimeAccountId, token }) {
    if (this.closed || !validRuntimeProfileId(runtimeProfileId)
      || !validRuntimeAccountId(runtimeAccountId) || !validFederationMcpToken(token)) {
      return null;
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return null;
    this.#purge(now);
    const digest = sessionDigest(token);
    const session = this.sessions.get(digest);
    if (!session || session.runtimeProfileId !== runtimeProfileId
      || session.runtimeAccountId !== runtimeAccountId) return null;
    const profile = this.productStore.getAgentProfile(this.defaultProfileId);
    if (!profile || profile.enabled !== true || profile.id !== session.profileId
      || profile.runtimeProfileId !== runtimeProfileId
      || profile.runtimeAccountId !== runtimeAccountId) {
      this.sessions.delete(digest);
      return null;
    }
    return { ...session };
  }

  close() {
    this.closed = true;
    this.sessions.clear();
  }

  reset() {
    if (this.closed) return;
    this.sessions.clear();
  }

  #purge(now) {
    for (const [digest, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(digest);
    }
  }
}

module.exports = {
  FEDERATION_MCP_AUTH_FILENAME,
  FEDERATION_MCP_CLIENTS,
  FederationMcpSessionManager,
  ensureFederationMcpCredential,
  federationMcpAuthPath,
  loadFederationMcpCredential,
  sameFederationMcpToken,
  validFederationMcpToken,
};
