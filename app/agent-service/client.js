"use strict";

const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const {
  assertPrivateDirectory,
  lstatIfExists,
  rejectSymlink,
  serviceError,
  validatePrivateFileStat,
} = require("./security");

const DEFAULT_TIMEOUT_MS = 2000;
const CLIENT_MAX_RESPONSE_BYTES = 64 * 1024;

function readClientToken(paths) {
  assertPrivateDirectory(paths.runtimeDir);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(paths.tokenPath, flags);
    const opened = validatePrivateFileStat(fs.fstatSync(fd), paths.tokenPath);
    const token = fs.readFileSync(fd, "utf8").trim();
    const current = rejectSymlink(paths.tokenPath);
    if (!current || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw serviceError("UNSAFE_TOKEN_CHANGED", "token 路径在读取期间被替换");
    }
    return token;
  } catch (error) {
    if (error.code === "ELOOP") throw serviceError("UNSAFE_SYMLINK", "拒绝 token symlink");
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateSocketStat(stat, target) {
  if (!stat?.isSocket()) throw serviceError("SERVICE_UNAVAILABLE", "Service socket 不可用");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw serviceError("UNSAFE_OWNER", `socket 不属于当前用户: ${target}`);
  }
  if ((stat.mode & 0o077) !== 0) throw serviceError("UNSAFE_PERMISSIONS", "Service socket 权限过宽");
  return stat;
}

function requestService(paths, request, options = {}) {
  try {
    assertPrivateDirectory(paths.runtimeDir);
  } catch (error) {
    return Promise.reject(error);
  }
  let socketStat;
  try {
    socketStat = validateSocketStat(rejectSymlink(paths.socketPath), paths.socketPath);
  } catch (error) {
    return Promise.reject(error);
  }
  // Auth reads may start the bundled CLI and let Codex refresh native tokens.
  // Keep ordinary control requests fast while allowing this bounded cold path.
  const authRead = ["auth.read", "runtime.account.auth.read", "profile.models.list"].includes(request.method);
  const timeoutMs = options.timeoutMs ?? (authRead ? 20_000 : DEFAULT_TIMEOUT_MS);
  const payload = {
    id: request.id || randomUUID(),
    ...request,
  };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath);
    let settled = false;
    let buffered = Buffer.alloc(0);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(serviceError("REQUEST_TIMEOUT", `Service 请求在 ${timeoutMs}ms 内未响应`));
    }, timeoutMs);

    socket.on("connect", () => {
      const current = lstatIfExists(paths.socketPath);
      if (!current || current.dev !== socketStat.dev || current.ino !== socketStat.ino) {
        finish(serviceError("UNSAFE_SOCKET_CHANGED", "Service socket 在连接期间被替换"));
        return;
      }
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > CLIENT_MAX_RESPONSE_BYTES) {
        finish(serviceError("RESPONSE_TOO_LARGE", "Service 响应超过上限"));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (settled) return;
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        finish(serviceError("INCOMPLETE_RESPONSE", "Service 在完整 JSONL 响应前断开"));
        return;
      }
      const trailing = buffered.subarray(newline + 1);
      if (trailing.includes(0x0a)) {
        finish(serviceError("MULTIPLE_RESPONSE_FRAMES", "Service 在单连接返回了多个响应帧"));
        return;
      }
      if (trailing.length > 0) {
        finish(serviceError("RESPONSE_TRAILING_DATA", "Service 响应含 JSONL 帧外数据"));
        return;
      }
      let response;
      try {
        response = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      } catch {
        finish(serviceError("MALFORMED_RESPONSE", "Service 返回了无效 JSON"));
        return;
      }
      if (response.id !== payload.id) {
        finish(serviceError("RESPONSE_ID_MISMATCH", "Service 响应 id 不匹配"));
        return;
      }
      if (!response.ok) {
        finish(serviceError(response.error?.code || "SERVICE_ERROR", response.error?.message || "Service 请求失败"));
        return;
      }
      finish(null, response.result);
    });
    socket.on("close", () => {
      if (!settled) finish(serviceError("SERVICE_DISCONNECTED", "Service 未以完整响应结束连接"));
    });
  });
}

module.exports = { DEFAULT_TIMEOUT_MS, readClientToken, requestService };
