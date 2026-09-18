"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const {
  FEDERATION_MAX_FRAME_BYTES,
  FEDERATION_PROTOCOL_VERSION,
  isPublicExternalInspirationError,
  validateFederationParams,
  validateFederationResult,
} = require("../federation-host-protocol");
const { EXTERNAL_INSPIRATION_METHODS } = require("../external-inspiration-protocol");
const {
  assertPrivateDirectory,
  lstatIfExists,
  rejectSymlink,
  serviceError,
  validatePrivateFileStat,
} = require("./security");

const DEFAULT_TIMEOUT_MS = 5_000;
const PUBLIC_HOST_CODES = new Set([
  "APP_HOST_UNAVAILABLE", "BACKEND_UNAVAILABLE", "AGENT_NOT_FOUND",
  "AGENT_OPERATION_FAILED", "AGENT_RUN_TIMEOUT", "FEDERATION_OPERATION_CONFLICT",
  "FEDERATION_RESPONSE_INVALID", "FEDERATION_TASK_NOT_FOUND",
  "FEDERATION_TASK_STATE_CONFLICT",
  "FEDERATION_COMMIT_UNCERTAIN",
]);

function readHostToken(paths) {
  assertPrivateDirectory(paths.runtimeDir);
  let fd;
  try {
    fd = fs.openSync(paths.federationTokenPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = validatePrivateFileStat(fs.fstatSync(fd), paths.federationTokenPath);
    if (!Number.isSafeInteger(opened.size) || opened.size < 20 || opened.size > 256) {
      throw serviceError("APP_HOST_UNAVAILABLE", "app_host_unavailable");
    }
    const token = fs.readFileSync(fd, "utf8").trim();
    const current = rejectSymlink(paths.federationTokenPath);
    if (!current || opened.dev !== current.dev || opened.ino !== current.ino
      || !/^[A-Za-z0-9_-]{40,64}$/u.test(token)) {
      throw serviceError("APP_HOST_UNAVAILABLE", "app_host_unavailable");
    }
    return token;
  } catch {
    throw serviceError("APP_HOST_UNAVAILABLE", "app_host_unavailable");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function socketIdentity(paths) {
  let stat;
  try {
    assertPrivateDirectory(paths.runtimeDir);
    stat = rejectSymlink(paths.federationSocketPath);
  } catch {
    throw serviceError("APP_HOST_UNAVAILABLE", "app_host_unavailable");
  }
  if (!stat?.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (stat.mode & 0o077) !== 0) {
    throw serviceError("APP_HOST_UNAVAILABLE", "app_host_unavailable");
  }
  return stat;
}

class FederationHostClient {
  constructor(options = {}) {
    if (!options.paths?.runtimeDir || !options.paths?.federationSocketPath
      || !options.paths?.federationTokenPath) throw new TypeError("FederationHostClient 需要 paths");
    this.paths = options.paths;
    this._customTimeout = options.timeoutMs !== undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new TypeError("FederationHostClient timeout 无效");
    }
  }

  request(method, params) {
    if (!validateFederationParams(method, params)) {
      return Promise.reject(serviceError("APP_HOST_INVALID_REQUEST", "app_host_invalid_request"));
    }
    let token;
    let before;
    try {
      token = readHostToken(this.paths);
      before = socketIdentity(this.paths);
    } catch (error) { return Promise.reject(error); }
    const id = crypto.randomUUID();
    const external = EXTERNAL_INSPIRATION_METHODS.includes(method);
    const externalMutation = external && method !== "inspiration.external.get";
    const timeoutMs = method === "agent.run"
      ? Math.min(125_000, params.timeoutMs + 2_000)
      : ["federation.run", "federation.message"].includes(method)
        ? Math.min(30_000, Math.max(this.timeoutMs, params.timeoutMs + 2_000))
        : !this._customTimeout && method === "inspiration.external.prepare" ? 30_000
          : !this._customTimeout && ["inspiration.external.respond", "inspiration.external.cancel"].includes(method)
            ? 15_000 : this.timeoutMs;
    const payload = `${JSON.stringify({
      id, token, version: FEDERATION_PROTOCOL_VERSION, method, params,
    })}\n`;
    token = null;
    if (Buffer.byteLength(payload, "utf8") > FEDERATION_MAX_FRAME_BYTES) {
      return Promise.reject(serviceError("APP_HOST_INVALID_REQUEST", "app_host_invalid_request"));
    }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.paths.federationSocketPath);
      let settled = false;
      let sent = false;
      let buffered = Buffer.alloc(0);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(serviceError(
        method.includes("create") || method.includes("update") || method.includes("delete")
          || method.includes("write") || method === "agent.run"
          || ["federation.run", "federation.message", "federation.task.cancel"].includes(method)
          || externalMutation
          ? "FEDERATION_COMMIT_UNCERTAIN" : "APP_HOST_UNAVAILABLE",
        "app_host_timeout",
      )), timeoutMs);
      socket.on("connect", () => {
        const current = lstatIfExists(this.paths.federationSocketPath);
        if (!current || current.dev !== before.dev || current.ino !== before.ino) {
          finish(serviceError("APP_HOST_UNAVAILABLE", "app_host_changed"));
          return;
        }
        sent = true;
        socket.write(payload);
      });
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > FEDERATION_MAX_FRAME_BYTES) {
          finish(serviceError("FEDERATION_RESPONSE_INVALID", "federation_response_invalid"));
        }
      });
      const unavailable = () => serviceError(externalMutation && sent ? "FEDERATION_COMMIT_UNCERTAIN"
        : "APP_HOST_UNAVAILABLE", "app_host_unavailable");
      socket.on("error", () => finish(unavailable()));
      socket.on("end", () => {
        if (settled) return;
        const newline = buffered.indexOf(0x0a);
        if (newline < 0 || newline !== buffered.length - 1) {
          finish(externalMutation && sent && buffered.length === 0 ? unavailable()
            : serviceError("FEDERATION_RESPONSE_INVALID", "federation_response_invalid"));
          return;
        }
        let response;
        try { response = JSON.parse(buffered.subarray(0, newline).toString("utf8")); } catch {
          finish(serviceError("FEDERATION_RESPONSE_INVALID", "federation_response_invalid"));
          return;
        }
        if (!response || response.id !== id || typeof response.ok !== "boolean") {
          finish(serviceError("FEDERATION_RESPONSE_INVALID", "federation_response_invalid"));
          return;
        }
        if (response.ok !== true) {
          const code = PUBLIC_HOST_CODES.has(response.error?.code)
            || (external && isPublicExternalInspirationError(response.error?.code))
            ? response.error.code : "AGENT_OPERATION_FAILED";
          finish(serviceError(code, code));
          return;
        }
        if (!validateFederationResult(method, response.result, params)) {
          finish(serviceError("FEDERATION_RESPONSE_INVALID", "federation_response_invalid"));
          return;
        }
        finish(null, structuredClone(response.result));
      });
      socket.on("close", () => {
        if (!settled) finish(unavailable());
      });
    });
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, FederationHostClient };
