"use strict";

const crypto = require("node:crypto");
const { assertRuntimeProfileId } = require("./codex-runtime-paths");
const { validRuntimeAccountId } = require("./runtime-adapter");
const { serviceError } = require("./security");

const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const DEFAULT_SESSION_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CHALLENGES = 256;
const DEFAULT_MAX_SESSIONS = 256;
const MCP_CHALLENGE_DOMAIN = "shoggoth-mcp-auth-challenge-v2";

function fixedError(code, message) {
  return serviceError(code, message);
}

function authFailed() {
  return fixedError("MCP_AUTH_FAILED", "mcp_auth_failed");
}

function sessionInvalid() {
  return fixedError("MCP_SESSION_INVALID", "mcp_session_invalid");
}

function authBusy() {
  return fixedError("MCP_AUTH_BUSY", "mcp_auth_busy");
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function decodeCanonicalBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== byteLength || bytes.toString("base64url") !== value) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}

function isCanonicalBase64Url(value, byteLength) {
  const bytes = decodeCanonicalBase64Url(value, byteLength);
  if (!bytes) return false;
  bytes.fill(0);
  return true;
}

function validRuntimeProfileId(value) {
  try {
    assertRuntimeProfileId(value);
    return true;
  } catch {
    return false;
  }
}

function appendLengthPrefixed(parts, value) {
  const bytes = Buffer.from(value, "utf8");
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(bytes.length);
  parts.push(size, bytes);
}

function challengePayload(challenge) {
  const fields = [
    MCP_CHALLENGE_DOMAIN,
    String(challenge.protocolVersion),
    challenge.runtimeProfileId,
    challenge.runtimeAccountId,
    challenge.challengeId,
    challenge.clientNonce,
    challenge.serverNonce,
    String(challenge.expiresAt),
  ];
  const parts = [];
  for (const field of fields) appendLengthPrefixed(parts, field);
  return Buffer.concat(parts);
}

function validateChallengeForProof(challenge) {
  return challenge && typeof challenge === "object" && !Array.isArray(challenge)
    && Number.isSafeInteger(challenge.protocolVersion) && challenge.protocolVersion > 0
    && validRuntimeProfileId(challenge.runtimeProfileId)
    && validRuntimeAccountId(challenge.runtimeAccountId)
    && isCanonicalBase64Url(challenge.challengeId, 16)
    && isCanonicalBase64Url(challenge.clientNonce, 32)
    && isCanonicalBase64Url(challenge.serverNonce, 32)
    && Number.isSafeInteger(challenge.expiresAt) && challenge.expiresAt >= 0;
}

function normalizeHandshakeSecret(value) {
  if (!Buffer.isBuffer(value) || value.length < 32 || value.length > 4096) {
    throw fixedError("MCP_AUTH_SECRET_INVALID", "mcp_auth_secret_invalid");
  }
  return Buffer.from(value);
}

function createMcpChallengeProof(handshakeSecret, challenge) {
  const secret = normalizeHandshakeSecret(handshakeSecret);
  try {
    if (!validateChallengeForProof(challenge)) {
      throw fixedError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
    }
    return crypto.createHmac("sha256", secret).update(challengePayload(challenge)).digest("base64url");
  } finally {
    secret.fill(0);
  }
}

function positiveBoundedInteger(value, fallback, max) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > max) {
    throw fixedError("MCP_AUTH_OPTIONS_INVALID", "mcp_auth_options_invalid");
  }
  return candidate;
}

function digestToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

class McpSessionManager {
  #secret;
  #profileStore;
  #protocolVersion;
  #now;
  #randomBytes;
  #challengeTtlMs;
  #sessionTtlMs;
  #maxChallenges;
  #maxSessions;
  #concurrentHelperSessions;
  #challenges = new Map();
  #sessions = new Map();
  #profileSessionDigests = new Map();
  #closed = false;

  constructor(options = {}) {
    this.#secret = normalizeHandshakeSecret(options.handshakeSecret);
    try {
      if (!options.profileStore || typeof options.profileStore.listAgentProfiles !== "function") {
        throw fixedError("MCP_AUTH_PROFILE_STORE_REQUIRED", "mcp_auth_profile_store_required");
      }
      this.#profileStore = options.profileStore;
      this.#protocolVersion = positiveBoundedInteger(options.protocolVersion, 1, 1_000_000);
      this.#now = options.now || Date.now;
      this.#randomBytes = options.randomBytes || crypto.randomBytes;
      this.#challengeTtlMs = positiveBoundedInteger(
        options.challengeTtlMs, DEFAULT_CHALLENGE_TTL_MS, 10 * 60_000,
      );
      this.#sessionTtlMs = positiveBoundedInteger(
        options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 60 * 60_000,
      );
      this.#maxChallenges = positiveBoundedInteger(
        options.maxChallenges, DEFAULT_MAX_CHALLENGES, 4096,
      );
      this.#maxSessions = positiveBoundedInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, 4096);
      if (options.concurrentHelperSessions !== undefined && typeof options.concurrentHelperSessions !== "boolean") {
        throw fixedError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
      }
      this.#concurrentHelperSessions = options.concurrentHelperSessions === true;
    } catch (error) {
      this.#secret.fill(0);
      throw error;
    }
  }

  issueChallenge(request) {
    if (this.#closed) throw authFailed();
    if (!exactObject(request, [
      "protocolVersion", "runtimeProfileId", "runtimeAccountId", "clientNonce",
    ])
      || request.protocolVersion !== this.#protocolVersion
      || !validRuntimeProfileId(request.runtimeProfileId)
      || !validRuntimeAccountId(request.runtimeAccountId)
      || !isCanonicalBase64Url(request.clientNonce, 32)) {
      throw fixedError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
    }
    const now = this.#safeNow();
    this.#purgeExpired(now);
    if (this.#challenges.size >= this.#maxChallenges) throw authBusy();
    const challengeId = this.#randomBase64Url(16);
    const serverNonce = this.#randomBase64Url(32);
    if (this.#challenges.has(challengeId)) throw authBusy();
    const challenge = {
      challengeId,
      protocolVersion: this.#protocolVersion,
      runtimeProfileId: request.runtimeProfileId,
      runtimeAccountId: request.runtimeAccountId,
      clientNonce: request.clientNonce,
      serverNonce,
      expiresAt: now + this.#challengeTtlMs,
    };
    this.#challenges.set(challengeId, { ...challenge });
    return { ...challenge };
  }

  exchangeChallenge(request) {
    if (this.#closed) throw authFailed();
    const now = this.#safeNow();
    this.#purgeExpired(now);
    const candidateChallengeId = typeof request?.challengeId === "string"
      && isCanonicalBase64Url(request.challengeId, 16)
      ? request.challengeId
      : null;
    const challenge = candidateChallengeId ? this.#challenges.get(candidateChallengeId) : null;
    if (candidateChallengeId) this.#challenges.delete(candidateChallengeId);
    if (!challenge || !exactObject(request, [
      "challengeId", "protocolVersion", "runtimeProfileId", "runtimeAccountId",
      "clientNonce", "serverNonce", "proof",
    ]) || request.protocolVersion !== challenge.protocolVersion
      || request.protocolVersion !== this.#protocolVersion
      || request.runtimeProfileId !== challenge.runtimeProfileId
      || request.runtimeAccountId !== challenge.runtimeAccountId
      || request.clientNonce !== challenge.clientNonce
      || request.serverNonce !== challenge.serverNonce
      || challenge.expiresAt <= now) throw authFailed();

    const suppliedProof = decodeCanonicalBase64Url(request.proof, 32);
    let expectedProof;
    try {
      expectedProof = Buffer.from(createMcpChallengeProof(this.#secret, challenge), "base64url");
    } catch {
      throw authFailed();
    }
    let proofMatches = false;
    try {
      proofMatches = Boolean(suppliedProof)
        && suppliedProof.length === expectedProof.length
        && crypto.timingSafeEqual(suppliedProof, expectedProof);
    } finally {
      if (suppliedProof) suppliedProof.fill(0);
      expectedProof.fill(0);
    }
    if (!proofMatches) throw authFailed();

    return this.#issueSession({
      runtimeProfileId: challenge.runtimeProfileId,
      runtimeAccountId: challenge.runtimeAccountId,
    }, now, authFailed, !this.#concurrentHelperSessions);
  }

  issueBridgeSession(binding) {
    if (this.#closed || !exactObject(binding, ["runtimeProfileId", "runtimeAccountId"])
      || !validRuntimeProfileId(binding.runtimeProfileId)
      || !validRuntimeAccountId(binding.runtimeAccountId)) throw authFailed();
    const now = this.#safeNow();
    this.#purgeExpired(now);
    return this.#issueSession(binding, now, authFailed, false);
  }

  revokeSession(request) {
    if (this.#closed || !exactObject(request, ["token", "runtimeProfileId", "runtimeAccountId"])
      || !validRuntimeProfileId(request.runtimeProfileId)
      || !validRuntimeAccountId(request.runtimeAccountId)
      || !isCanonicalBase64Url(request.token, 32)) return false;
    const digest = digestToken(request.token);
    const session = this.#sessions.get(digest);
    if (!session || session.runtimeProfileId !== request.runtimeProfileId
      || session.runtimeAccountId !== request.runtimeAccountId) return false;
    this.#removeSessionDigest(digest, session);
    return true;
  }

  #issueSession(binding, now, errorFactory, exclusiveProfileSession = true) {
    const { runtimeProfileId, runtimeAccountId } = binding;
    const profile = this.#resolveUniqueEnabledProfile(binding, errorFactory);
    const previousDigest = exclusiveProfileSession
      ? this.#profileSessionDigests.get(runtimeProfileId) || null : null;
    const retainedCount = this.#sessions.size - (previousDigest && this.#sessions.has(previousDigest) ? 1 : 0);
    if (retainedCount >= this.#maxSessions) throw authBusy();

    const token = this.#randomBase64Url(32);
    const digest = digestToken(token);
    if (this.#sessions.has(digest)) throw authBusy();
    if (previousDigest) this.#sessions.delete(previousDigest);
    const session = {
      protocolVersion: this.#protocolVersion,
      runtimeProfileId,
      runtimeAccountId,
      profileId: profile.id,
      expiresAt: now + this.#sessionTtlMs,
    };
    this.#sessions.set(digest, session);
    if (exclusiveProfileSession) this.#profileSessionDigests.set(runtimeProfileId, digest);
    return { token, ...session };
  }

  authorizeSession(request) {
    if (this.#closed || !exactObject(request, ["token", "runtimeProfileId", "runtimeAccountId"])
      || !validRuntimeProfileId(request.runtimeProfileId)
      || !validRuntimeAccountId(request.runtimeAccountId)
      || !isCanonicalBase64Url(request.token, 32)) throw sessionInvalid();
    const now = this.#safeNow();
    this.#purgeExpired(now);
    const digest = digestToken(request.token);
    const session = this.#sessions.get(digest);
    if (!session || session.runtimeProfileId !== request.runtimeProfileId
      || session.runtimeAccountId !== request.runtimeAccountId
      || session.expiresAt <= now) throw sessionInvalid();
    let profile;
    try {
      profile = this.#resolveUniqueEnabledProfile(request, sessionInvalid);
    } catch {
      this.#removeSessionDigest(digest, session);
      throw sessionInvalid();
    }
    if (profile.id !== session.profileId || profile.runtimeAccountId !== session.runtimeAccountId) {
      this.#removeSessionDigest(digest, session);
      throw sessionInvalid();
    }
    return { ...session };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#challenges.clear();
    this.#sessions.clear();
    this.#profileSessionDigests.clear();
    this.#secret.fill(0);
  }

  #resolveUniqueEnabledProfile(binding, errorFactory) {
    try {
      const profiles = require("./agent-runtime-profile-views").agentRuntimeProfileViews(this.#profileStore);
      if (!Array.isArray(profiles)) throw new Error("invalid profiles");
      const matches = profiles.filter((candidate) => candidate && candidate.enabled === true
        && candidate.runtimeProfileId === binding.runtimeProfileId
        && candidate.runtimeAccountId === binding.runtimeAccountId
        && typeof candidate.id === "string" && candidate.id.length > 0);
      if (matches.length !== 1) throw new Error("ambiguous profile");
      return { id: matches[0].id, runtimeAccountId: matches[0].runtimeAccountId };
    } catch {
      throw errorFactory();
    }
  }

  #safeNow() {
    let value;
    try {
      value = this.#now();
    } catch {
      throw fixedError("MCP_AUTH_CLOCK_INVALID", "mcp_auth_clock_invalid");
    }
    if (!Number.isSafeInteger(value) || value < 0
      || value > Number.MAX_SAFE_INTEGER - Math.max(this.#challengeTtlMs, this.#sessionTtlMs)) {
      throw fixedError("MCP_AUTH_CLOCK_INVALID", "mcp_auth_clock_invalid");
    }
    return value;
  }

  #randomBase64Url(size) {
    let bytes;
    try {
      bytes = this.#randomBytes(size);
    } catch {
      throw fixedError("MCP_AUTH_RANDOM_FAILED", "mcp_auth_random_failed");
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
      throw fixedError("MCP_AUTH_RANDOM_FAILED", "mcp_auth_random_failed");
    }
    try {
      return bytes.toString("base64url");
    } finally {
      bytes.fill(0);
    }
  }

  #purgeExpired(now) {
    for (const [challengeId, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(challengeId);
    }
    for (const [digest, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#removeSessionDigest(digest, session);
    }
  }

  #removeSessionDigest(digest, session) {
    this.#sessions.delete(digest);
    if (this.#profileSessionDigests.get(session.runtimeProfileId) === digest) {
      this.#profileSessionDigests.delete(session.runtimeProfileId);
    }
  }
}

module.exports = {
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_MAX_CHALLENGES,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TTL_MS,
  McpSessionManager,
  createMcpChallengeProof,
};
