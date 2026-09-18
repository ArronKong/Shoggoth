"use strict";

const { TextDecoder } = require("node:util");
const { serviceError } = require("./security");

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 330_000;

function acpError(code, message) {
  return serviceError(code, message);
}

function validRequestId(value) {
  return (Number.isSafeInteger(value) && value >= 0)
    || (typeof value === "string" && value.length > 0
      && Buffer.byteLength(value, "utf8") <= 256 && value.isWellFormed()
      && !value.includes("\0"));
}

function validTimeout(value, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > 24 * 60 * 60 * 1_000) {
    throw acpError("GROK_ACP_OPTIONS_INVALID", "Grok ACP timeout is invalid");
  }
  return result;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function authFailure(value) {
  let text = "";
  try { text = JSON.stringify(value); } catch {}
  return /(?:\b401\b|unauthori[sz]ed|authentication required|not authenticated|login required|invalid token|missing token)/iu
    .test(text);
}

function authSensitiveMethod(method) {
  return method === "authenticate" || method.startsWith("session/");
}

function boundedServerRequest(task, timeoutMs) {
  if (timeoutMs === null) return Promise.resolve().then(task);
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(acpError(
        "GROK_ACP_SERVER_REQUEST_TIMEOUT",
        "Grok ACP reverse request timed out",
      )), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

class GrokBuildAcpJsonlClient {
  constructor(child, options = {}) {
    if (!child?.stdin || !child?.stdout || !child?.stderr
      || typeof child.stdin.write !== "function"
      || typeof child.stdout.on !== "function"
      || typeof child.stderr.on !== "function"
      || typeof child.on !== "function") {
      throw acpError("GROK_ACP_CHILD_INVALID", "Grok ACP child process is invalid");
    }
    this.child = child;
    this.requestTimeoutMs = validTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.serverRequestTimeoutMs = validTimeout(
      options.serverRequestTimeoutMs,
      DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
    );
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes)
      || this.maxFrameBytes < 1024 || this.maxFrameBytes > 16 * 1024 * 1024) {
      throw acpError("GROK_ACP_OPTIONS_INVALID", "Grok ACP frame budget is invalid");
    }
    this.notificationGuard = typeof options.notificationGuard === "function"
      ? options.notificationGuard : null;
    this.serverRequestGuard = typeof options.serverRequestGuard === "function"
      ? options.serverRequestGuard : null;
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    this.nextId = 1;
    this.pending = new Map();
    this.retiredIds = new Set();
    this.serverRequestIds = new Set();
    this.activeServerRequestIds = new Set();
    this.serverRequestHandlers = new Map();
    this.subscribers = new Set();
    this.stdoutBuffer = Buffer.alloc(0);
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.writeTail = Promise.resolve();
    this.ended = false;
    this.explicitlyTerminated = false;
    this.fatalError = null;
    this.authFailureRequestIds = new Set();
    this.terminated = new Promise((resolve, reject) => {
      this.resolveTerminated = resolve;
      this.rejectTerminated = reject;
    });
    this.terminated.catch(() => {});

    this.onStdoutData = (chunk) => this._consumeStdout(chunk);
    this.onStdoutEnd = () => this._handleStdoutEnd();
    this.onStdoutError = () => this._fail(acpError(
      "GROK_ACP_STDOUT_ERROR",
      "Grok ACP stdout failed",
    ));
    this.onStderrData = (chunk) => {
      if (authFailure(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))) {
        for (const [id, pending] of this.pending) {
          if (authSensitiveMethod(pending.method)) this.authFailureRequestIds.add(id);
        }
      }
    };
    this.onStderrError = () => this._fail(acpError(
      "GROK_ACP_STDERR_ERROR",
      "Grok ACP stderr failed",
    ));
    this.onStdinError = () => this._fail(acpError(
      "GROK_ACP_STDIN_ERROR",
      "Grok ACP stdin failed",
    ));
    this.onChildError = () => this._fail(acpError(
      "GROK_ACP_PROCESS_ERROR",
      "Grok Build failed to start",
    ));
    this.onChildExit = () => this._handleProcessExit();
    child.stdout.on("data", this.onStdoutData);
    child.stdout.once("end", this.onStdoutEnd);
    child.stdout.once("error", this.onStdoutError);
    child.stderr.on("data", this.onStderrData);
    child.stderr.once("error", this.onStderrError);
    child.stdin.once("error", this.onStdinError);
    child.once("error", this.onChildError);
    child.once("exit", this.onChildExit);
    child.once("close", this.onChildExit);
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw acpError("GROK_ACP_SUBSCRIBER_INVALID", "Grok ACP subscriber is invalid");
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  registerServerRequestHandler(method, handler, options = {}) {
    if (typeof method !== "string" || method.length === 0 || typeof handler !== "function") {
      throw acpError("GROK_ACP_HANDLER_INVALID", "Grok ACP reverse request handler is invalid");
    }
    const timeoutMs = options.timeoutMs === undefined
      ? this.serverRequestTimeoutMs : options.timeoutMs;
    if (timeoutMs !== null
      && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1_000)) {
      throw acpError("GROK_ACP_HANDLER_INVALID", "Grok ACP reverse request timeout is invalid");
    }
    const registration = { handler, timeoutMs };
    this.serverRequestHandlers.set(method, registration);
    return () => {
      if (this.serverRequestHandlers.get(method) === registration) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  pauseRequestTimeout(method, predicate = () => true) {
    if (typeof method !== "string" || typeof predicate !== "function") {
      throw acpError("GROK_ACP_OPTIONS_INVALID", "Grok ACP pause request is invalid");
    }
    const paused = [];
    for (const [id, pending] of this.pending) {
      if (pending.method !== method || !predicate(pending.params)) continue;
      pending.pauseDepth += 1;
      if (pending.pauseDepth === 1) {
        pending.remainingTimeoutMs = Math.max(1, pending.deadlineAt - Date.now());
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.timer = null;
      }
      paused.push([id, pending]);
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      for (const [id, pending] of paused) {
        if (this.pending.get(id) !== pending) continue;
        pending.pauseDepth = Math.max(0, pending.pauseDepth - 1);
        if (pending.pauseDepth === 0) {
          this._armRequestTimeout(id, pending, pending.remainingTimeoutMs);
        }
      }
    };
  }

  request(method, params, options = {}) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ended) return Promise.reject(acpError("GROK_ACP_TERMINATED", "Grok ACP is terminated"));
    if (typeof method !== "string" || method.length === 0 || method.includes("\0")) {
      return Promise.reject(acpError("GROK_ACP_METHOD_INVALID", "Grok ACP method is invalid"));
    }
    if (this.nextId > Number.MAX_SAFE_INTEGER || this.pending.size >= 256) {
      const error = acpError("GROK_ACP_REQUEST_LIMIT", "Grok ACP request capacity was exceeded");
      this._fail(error);
      return Promise.reject(error);
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = validTimeout(options.timeoutMs, this.requestTimeoutMs);
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const pending = {
      method,
      params,
      resolve: resolveResult,
      reject: rejectResult,
      timer: null,
      deadlineAt: 0,
      remainingTimeoutMs: timeoutMs,
      pauseDepth: 0,
    };
    this.pending.set(id, pending);
    this._armRequestTimeout(id, pending, timeoutMs);
    const message = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    this._write(message).then(() => {
      try { options.onWritten?.(); } catch {
        this._fail(acpError("GROK_ACP_WRITE_OBSERVER_FAILED", "Grok ACP write observer failed"));
      }
    }).catch((error) => this._fail(error));
    return result;
  }

  _armRequestTimeout(id, pending, timeoutMs) {
    pending.remainingTimeoutMs = timeoutMs;
    pending.deadlineAt = Date.now() + timeoutMs;
    pending.timer = setTimeout(() => {
      if (this.pending.get(id) !== pending) return;
      this.pending.delete(id);
      this.authFailureRequestIds.delete(id);
      this._retire(id);
      pending.reject(acpError("GROK_ACP_REQUEST_TIMEOUT", "Grok ACP request timed out"));
    }, timeoutMs);
    pending.timer.unref?.();
  }

  notify(method, params) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ended) return Promise.reject(acpError("GROK_ACP_TERMINATED", "Grok ACP is terminated"));
    if (typeof method !== "string" || method.length === 0 || method.includes("\0")) {
      return Promise.reject(acpError("GROK_ACP_METHOD_INVALID", "Grok ACP method is invalid"));
    }
    return this._write(params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params });
  }

  terminate() {
    if (this.ended) return Promise.resolve();
    this.explicitlyTerminated = true;
    this.ended = true;
    const error = acpError("GROK_ACP_TERMINATED", "Grok ACP was stopped");
    this._rejectOutstanding(error);
    this._removeListeners();
    this.resolveTerminated();
    return Promise.resolve();
  }

  _consumeStdout(chunk) {
    if (this.ended) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length > this.maxFrameBytes) {
          this._fail(acpError("GROK_ACP_FRAME_TOO_LARGE", "Grok ACP frame exceeded its limit"));
        }
        return;
      }
      const frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (frame.length === 0) {
        this._fail(acpError("GROK_ACP_MALFORMED_JSONL", "Grok ACP emitted an empty frame"));
        return;
      }
      if (frame.length > this.maxFrameBytes) {
        this._fail(acpError("GROK_ACP_FRAME_TOO_LARGE", "Grok ACP frame exceeded its limit"));
        return;
      }
      let message;
      try {
        message = JSON.parse(this.decoder.decode(frame));
      } catch (error) {
        this._fail(acpError(
          error instanceof SyntaxError ? "GROK_ACP_MALFORMED_JSONL" : "GROK_ACP_MALFORMED_UTF8",
          "Grok ACP emitted an invalid JSONL frame",
        ));
        return;
      }
      this._handleMessage(message);
      if (this.ended) return;
    }
  }

  _handleMessage(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
      this._fail(acpError("GROK_ACP_INVALID_MESSAGE", "Grok ACP envelope is invalid"));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasMethod = Object.prototype.hasOwnProperty.call(message, "method");
    if (hasId && !hasMethod) {
      this._handleResponse(message);
      return;
    }
    if (typeof message.method !== "string" || message.method.length === 0) {
      this._fail(acpError("GROK_ACP_INVALID_MESSAGE", "Grok ACP method is invalid"));
      return;
    }
    if (hasId) this._handleServerRequest(message);
    else this._handleNotification(message);
  }

  _handleResponse(message) {
    if (!validRequestId(message.id)) {
      this._fail(acpError("GROK_ACP_RESPONSE_ID_INVALID", "Grok ACP response id is invalid"));
      return;
    }
    if (this.retiredIds.delete(message.id)) {
      this.authFailureRequestIds.delete(message.id);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this._fail(acpError("GROK_ACP_UNKNOWN_RESPONSE_ID", "Grok ACP response id is unknown"));
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError || (hasError && !isPlainObject(message.error))) {
      this._fail(acpError("GROK_ACP_RESPONSE_INVALID", "Grok ACP response is invalid"));
      return;
    }
    this.pending.delete(message.id);
    const authFailureHint = this.authFailureRequestIds.delete(message.id);
    clearTimeout(pending.timer);
    if (hasError) {
      const required = authFailure(message.error) || authFailureHint;
      const error = acpError(
        required ? "AUTH_REQUIRED" : "GROK_ACP_REMOTE_ERROR",
        required ? "Grok Build authentication is required" : "Grok ACP request failed",
      );
      if (Number.isSafeInteger(message.error.code)) error.rpcCode = message.error.code;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  _handleNotification(message) {
    try { this.notificationGuard?.(message); } catch (error) {
      this._fail(error?.code ? error : acpError(
        "GROK_ACP_NOTIFICATION_INVALID",
        "Grok ACP notification was rejected",
      ));
      return;
    }
    for (const subscriber of this.subscribers) {
      try { subscriber(message); } catch {
        try { this.onDiagnostic?.({ code: "GROK_ACP_SUBSCRIBER_FAILED", method: message.method }); } catch {}
      }
    }
  }

  _handleServerRequest(message) {
    if (!validRequestId(message.id)
      || this.serverRequestIds.has(message.id) || this.activeServerRequestIds.has(message.id)) {
      this._fail(acpError("GROK_ACP_SERVER_REQUEST_ID_INVALID", "Grok ACP reverse request id is invalid"));
      return;
    }
    if (this.activeServerRequestIds.size >= 64) {
      this._fail(acpError("GROK_ACP_SERVER_REQUEST_LIMIT", "Grok ACP reverse request limit was exceeded"));
      return;
    }
    try { this.serverRequestGuard?.(message); } catch (error) {
      this._fail(error?.code ? error : acpError(
        "GROK_ACP_SERVER_REQUEST_INVALID",
        "Grok ACP reverse request was rejected",
      ));
      return;
    }
    this.activeServerRequestIds.add(message.id);
    const registration = this.serverRequestHandlers.get(message.method);
    void (async () => {
      let response;
      if (!registration) {
        response = {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Client method not supported" },
        };
      } else {
        try {
          const result = await boundedServerRequest(
            () => registration.handler(message.params, { id: message.id, method: message.method }),
            registration.timeoutMs,
          );
          response = { jsonrpc: "2.0", id: message.id, result: result ?? null };
        } catch (error) {
          response = {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: error?.code === "GROK_ACP_SERVER_REQUEST_TIMEOUT"
                ? "Client request timed out" : "Client request failed",
            },
          };
        }
      }
      if (!this.ended) {
        try { await this._write(response); } catch (error) { this._fail(error); }
      }
      this.activeServerRequestIds.delete(message.id);
      this.serverRequestIds.add(message.id);
      if (this.serverRequestIds.size > 4096) {
        this.serverRequestIds.delete(this.serverRequestIds.values().next().value);
      }
    })();
  }

  _write(message) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ended || !this.child.stdin.writable) {
      return Promise.reject(acpError("GROK_ACP_STDIN_CLOSED", "Grok ACP stdin is closed"));
    }
    let frame;
    try { frame = `${JSON.stringify(message)}\n`; } catch {
      return Promise.reject(acpError("GROK_ACP_SERIALIZE_FAILED", "Grok ACP message is not serializable"));
    }
    if (Buffer.byteLength(frame, "utf8") > this.maxFrameBytes) {
      return Promise.reject(acpError("GROK_ACP_OUTBOUND_FRAME_TOO_LARGE", "Grok ACP request exceeded its limit"));
    }
    const write = this.writeTail.then(() => new Promise((resolve, reject) => {
      if (this.ended || !this.child.stdin.writable) {
        reject(acpError("GROK_ACP_STDIN_CLOSED", "Grok ACP stdin is closed"));
        return;
      }
      try {
        this.child.stdin.write(frame, (error) => {
          if (error) reject(acpError("GROK_ACP_WRITE_FAILED", "Grok ACP write failed"));
          else resolve();
        });
      } catch {
        reject(acpError("GROK_ACP_WRITE_FAILED", "Grok ACP write failed"));
      }
    }));
    this.writeTail = write.catch(() => {});
    return write;
  }

  _retire(id) {
    this.retiredIds.add(id);
    if (this.retiredIds.size > 1024) this.retiredIds.delete(this.retiredIds.values().next().value);
  }

  _handleStdoutEnd() {
    if (this.ended) return;
    this._fail(acpError(
      this.stdoutBuffer.length > 0 ? "GROK_ACP_MALFORMED_TAIL" : "GROK_ACP_STDOUT_ENDED",
      this.stdoutBuffer.length > 0
        ? "Grok ACP stdout ended with an incomplete frame"
        : "Grok ACP stdout ended",
    ));
  }

  _handleProcessExit() {
    if (this.ended) return;
    this._fail(acpError(
      this.stdoutBuffer.length > 0 ? "GROK_ACP_MALFORMED_TAIL" : "GROK_ACP_PROCESS_EXITED",
      this.stdoutBuffer.length > 0
        ? "Grok Build exited with an incomplete ACP frame"
        : "Grok Build exited",
    ));
  }

  _rejectOutstanding(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.authFailureRequestIds.clear();
  }

  _removeListeners() {
    this.child.stdout.off?.("data", this.onStdoutData);
    this.child.stdout.off?.("end", this.onStdoutEnd);
    this.child.stdout.off?.("error", this.onStdoutError);
    this.child.stderr.off?.("data", this.onStderrData);
    this.child.stderr.off?.("error", this.onStderrError);
    this.child.stdin.off?.("error", this.onStdinError);
    this.child.off?.("error", this.onChildError);
    this.child.off?.("exit", this.onChildExit);
    this.child.off?.("close", this.onChildExit);
  }

  _fail(error) {
    if (this.ended) return;
    this.ended = true;
    this.fatalError = error?.code ? error : acpError("GROK_ACP_FAILED", "Grok ACP failed");
    this._rejectOutstanding(this.fatalError);
    this._removeListeners();
    this.rejectTerminated(this.fatalError);
  }
}

module.exports = {
  DEFAULT_MAX_FRAME_BYTES,
  GrokBuildAcpJsonlClient,
  acpError,
  validRequestId,
};
