"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { SERVICE_PROTOCOL_VERSION } = require("./agent-service/service-protocol-version");

const RUNTIME_MCP_BRIDGE_TIMEOUT_MS = 10_000;
const RUNTIME_MCP_BRIDGE_ACK_MAX_BYTES = 4 * 1024;
const RUNTIME_MCP_BRIDGE_ACK_FRAME = '{"ok":true,"result":{"bridged":true}}\n';
const RUNTIME_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUNTIME_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const handshakeErrorListeners = new WeakMap();

function relayError(code) {
  const error = new Error(code);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validateBridgeContext(context) {
  if (!exactObject(context, [
    "gatePath", "nonce", "parentPid", "runtimeProfileId", "runtimeAccountId", "servicePaths",
  ]) || !RUNTIME_PROFILE_PATTERN.test(context.runtimeProfileId || "")
    || !RUNTIME_ACCOUNT_PATTERN.test(context.runtimeAccountId || "")
    || !path.isAbsolute(context.gatePath || "")
    || !/^[a-f0-9]{64}$/u.test(context.nonce || "")
    || !Number.isSafeInteger(context.parentPid) || context.parentPid <= 1
    || !exactObject(context.servicePaths, [
      "trustedRoot", "stateDir", "mcpAuthPath", "runtimeDir", "socketPath",
    ])) {
    throw relayError("MCP_RELAY_CONTEXT_INVALID");
  }
  const { runtimeDir, socketPath } = context.servicePaths;
  if (!path.isAbsolute(runtimeDir) || !path.isAbsolute(socketPath)
    || path.dirname(socketPath) !== runtimeDir || path.basename(socketPath) !== "service.sock") {
    throw relayError("MCP_RELAY_CONTEXT_INVALID");
  }
  return context;
}

function validatePrivateSocket(fileSystem, runtimeDir, socketPath) {
  try {
    const runtimeStat = fileSystem.lstatSync(runtimeDir);
    const socketStat = fileSystem.lstatSync(socketPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()
      || (runtimeStat.mode & 0o077) !== 0 || (uid !== null && runtimeStat.uid !== uid)
      || !socketStat.isSocket() || socketStat.isSymbolicLink()
      || (socketStat.mode & 0o077) !== 0 || (uid !== null && socketStat.uid !== uid)) {
      throw new Error("unsafe socket");
    }
    return Object.freeze({ dev: socketStat.dev, ino: socketStat.ino });
  } catch {
    throw relayError("MCP_RELAY_SOCKET_INVALID");
  }
}

function validateBridgeAck(value) {
  return exactObject(value, ["ok", "result"])
    && value.ok === true
    && exactObject(value.result, ["bridged"])
    && value.result.bridged === true;
}

function openRuntimeMcpBridge(context, options = {}) {
  let input;
  try { input = validateBridgeContext(context); } catch (error) { return Promise.reject(error); }
  const fileSystem = options.fs || fs;
  const createConnection = options.createConnection || net.createConnection;
  const timeoutMs = options.timeoutMs ?? RUNTIME_MCP_BRIDGE_TIMEOUT_MS;
  if (typeof createConnection !== "function" || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 10 || timeoutMs > 10_000) {
    return Promise.reject(relayError("MCP_RELAY_OPTIONS_INVALID"));
  }
  let expectedSocket;
  try {
    expectedSocket = validatePrivateSocket(
      fileSystem,
      input.servicePaths.runtimeDir,
      input.servicePaths.socketPath,
    );
  } catch (error) {
    return Promise.reject(error);
  }
  const requestFrame = Buffer.from(`${JSON.stringify({
    version: SERVICE_PROTOCOL_VERSION,
    method: "mcp.runtime.bridge.open",
    params: {
      runtimeProfileId: input.runtimeProfileId,
      runtimeAccountId: input.runtimeAccountId,
      gatePath: input.gatePath,
      nonce: input.nonce,
      parentPid: input.parentPid,
    },
  })}\n`, "utf8");

  return new Promise((resolve, reject) => {
    let socket;
    let buffered = Buffer.alloc(0);
    let settled = false;
    let connected = false;
    let timer;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && typeof socket.off === "function") {
        socket.off("connect", onConnect);
        socket.off("data", onData);
        socket.off("end", onEnd);
        socket.off("close", onClose);
      }
      if (error) {
        if (socket && typeof socket.off === "function") {
          socket.off("error", onError);
        }
        if (socket && typeof socket.destroy === "function") socket.destroy();
        buffered.fill(0);
        requestFrame.fill(0);
        reject(error?.code?.startsWith("MCP_RELAY_")
          ? error : relayError("MCP_RELAY_BRIDGE_FAILED"));
        return;
      }
      socket.pause();
      handshakeErrorListeners.set(socket, onError);
      buffered.fill(0);
      requestFrame.fill(0);
      resolve(Object.freeze({
        runtimeProfileId: input.runtimeProfileId,
        runtimeAccountId: input.runtimeAccountId,
        socket,
      }));
    };
    const onError = () => {
      if (settled) {
        socket.destroy();
        return;
      }
      finish(relayError("MCP_RELAY_BRIDGE_FAILED"));
    };
    const onEnd = () => finish(relayError("MCP_RELAY_BRIDGE_FAILED"));
    const onClose = () => {
      if (!settled) finish(relayError("MCP_RELAY_BRIDGE_FAILED"));
    };
    const onConnect = () => {
      connected = true;
      let current;
      try {
        current = validatePrivateSocket(
          fileSystem,
          input.servicePaths.runtimeDir,
          input.servicePaths.socketPath,
        );
      } catch (error) {
        finish(error);
        return;
      }
      if (current.dev !== expectedSocket.dev || current.ino !== expectedSocket.ino) {
        finish(relayError("MCP_RELAY_SOCKET_CHANGED"));
        return;
      }
      try {
        socket.write(requestFrame, (error) => {
          if (error) finish(relayError("MCP_RELAY_BRIDGE_FAILED"));
        });
      } catch {
        finish(relayError("MCP_RELAY_BRIDGE_FAILED"));
      }
    };
    const onData = (chunk) => {
      if (!connected || settled) return;
      const next = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      buffered.fill(0);
      buffered = next;
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > RUNTIME_MCP_BRIDGE_ACK_MAX_BYTES) {
          finish(relayError("MCP_RELAY_ACK_INVALID"));
        }
        return;
      }
      if (newline === 0 || newline > RUNTIME_MCP_BRIDGE_ACK_MAX_BYTES
        || buffered.length !== newline + 1) {
        finish(relayError("MCP_RELAY_ACK_INVALID"));
        return;
      }
      let ack;
      try { ack = JSON.parse(buffered.subarray(0, newline).toString("utf8")); } catch {
        finish(relayError("MCP_RELAY_ACK_INVALID"));
        return;
      }
      if (buffered.toString("utf8") !== RUNTIME_MCP_BRIDGE_ACK_FRAME
        || !validateBridgeAck(ack)) {
        finish(relayError("MCP_RELAY_ACK_INVALID"));
        return;
      }
      finish();
    };
    timer = setTimeout(() => finish(relayError("MCP_RELAY_BRIDGE_TIMEOUT")), timeoutMs);
    timer.unref?.();
    try {
      socket = createConnection(input.servicePaths.socketPath);
      if (!socket || typeof socket.on !== "function" || typeof socket.write !== "function"
        || typeof socket.pause !== "function" || typeof socket.pipe !== "function"
        || typeof socket.once !== "function" || typeof socket.off !== "function"
        || typeof socket.destroy !== "function") {
        throw new Error("invalid socket");
      }
      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("end", onEnd);
      socket.once("close", onClose);
    } catch {
      finish(relayError("MCP_RELAY_BRIDGE_FAILED"));
    }
  });
}

function startRuntimeMcpRelay(options = {}) {
  const socket = options.socket;
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!socket || typeof socket.pipe !== "function" || typeof socket.destroy !== "function"
    || typeof socket.off !== "function" || typeof socket.once !== "function"
    || typeof socket.unpipe !== "function" || typeof socket.resume !== "function"
    || socket.destroyed
    || !input || typeof input.pipe !== "function" || typeof input.unpipe !== "function"
    || typeof input.once !== "function" || typeof input.off !== "function"
    || !output || typeof output.write !== "function"
    || typeof output.once !== "function" || typeof output.off !== "function") {
    return Promise.reject(relayError("MCP_RELAY_OPTIONS_INVALID"));
  }
  const handshakeError = handshakeErrorListeners.get(socket);
  if (handshakeError) {
    socket.off("error", handshakeError);
    handshakeErrorListeners.delete(socket);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let remoteEnded = false;
    const cleanup = () => {
      input.unpipe(socket);
      socket.unpipe(output);
      input.off("error", onInputError);
      output.off("error", onOutputError);
      socket.off("error", onSocketError);
      socket.off("end", onSocketEnd);
      socket.off("close", onSocketClose);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error?.code?.startsWith("MCP_RELAY_")
          ? error : relayError("MCP_RELAY_STREAM_FAILED"));
      } else {
        resolve();
      }
    };
    const onInputError = () => finish(relayError("MCP_RELAY_STREAM_FAILED"));
    const onOutputError = () => finish(relayError("MCP_RELAY_STREAM_FAILED"));
    const onSocketError = () => finish(relayError("MCP_RELAY_STREAM_FAILED"));
    const onSocketEnd = () => {
      remoteEnded = true;
      input.unpipe(socket);
      if (output.writableNeedDrain) output.once("drain", () => finish());
      else finish();
    };
    const onSocketClose = () => {
      if (!settled && !remoteEnded) finish(relayError("MCP_RELAY_STREAM_FAILED"));
    };
    input.once("error", onInputError);
    output.once("error", onOutputError);
    socket.once("error", onSocketError);
    socket.once("end", onSocketEnd);
    socket.once("close", onSocketClose);
    input.pipe(socket);
    socket.pipe(output, { end: false });
    socket.resume();
  });
}

module.exports = {
  RUNTIME_MCP_BRIDGE_ACK_MAX_BYTES,
  RUNTIME_MCP_BRIDGE_TIMEOUT_MS,
  openRuntimeMcpBridge,
  startRuntimeMcpRelay,
  validateBridgeAck,
};
