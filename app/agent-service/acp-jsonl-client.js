"use strict";

const { TextDecoder } = require("node:util");
const { serviceError } = require("./security");

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const { DEFAULT_SERVER_REQUEST_TIMEOUT_MS } = require("./interactive-timeouts");
// Error codes and messages carry the owning runtime's name so existing
// runtime-specific public mappings (for example GROK_ACP_*) stay unchanged.
const DEFAULT_NAMING = Object.freeze({
  codePrefix: "ACP",
  protocolLabel: "ACP",
  runtimeName: "ACP runtime",
});

function acpError(code, message) {
  return serviceError(code, message);
}

function acpNaming(options = {}) {
  const naming = { ...DEFAULT_NAMING, ...(options.naming || {}) };
  if (!/^[A-Z][A-Z0-9_]{0,31}$/u.test(naming.codePrefix)
    || typeof naming.protocolLabel !== "string" || naming.protocolLabel.length === 0
    || typeof naming.runtimeName !== "string" || naming.runtimeName.length === 0) {
    throw acpError("ACP_OPTIONS_INVALID", "ACP client naming is invalid");
  }
  return Object.freeze(naming);
}

function requestError(error, dispatchState, naming = DEFAULT_NAMING) {
  // Each pending request has its own send boundary. Never mutate a shared
  // connection error: another request may still be waiting in the write queue.
  const result = acpError(error?.code || `${naming.codePrefix}_FAILED`, error?.message || `${naming.protocolLabel} failed`);
  result.dispatchState = dispatchState;
  if (Number.isSafeInteger(error?.rpcCode)) result.rpcCode = error.rpcCode;
  if (typeof error?.rpcDetail === "string") {
    Object.defineProperty(result, "rpcDetail", { value: error.rpcDetail, enumerable: false });
  }
  for (const key of ["frameBytes", "maxFrameBytes"]) {
    if (Number.isSafeInteger(error?.[key])) result[key] = error[key];
  }
  return result;
}

function validRequestId(value) {
  return (Number.isSafeInteger(value) && value >= 0)
    || (typeof value === "string" && value.length > 0
      && Buffer.byteLength(value, "utf8") <= 256 && value.isWellFormed()
      && !value.includes("\0"));
}

function validTimeout(value, fallback, naming = DEFAULT_NAMING) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > 24 * 60 * 60 * 1_000) {
    throw acpError(`${naming.codePrefix}_OPTIONS_INVALID`, `${naming.protocolLabel} timeout is invalid`);
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

// Remote error prose can contain local paths or account details. Keep a bounded,
// non-enumerable copy only for in-process classification; it is never published.
function remoteErrorDetail(value) {
  const parts = [value?.message, value?.data?.message, value?.data?.details]
    .filter((part) => typeof part === "string" && part.length > 0);
  if (parts.length === 0) return null;
  return parts.join("\n").slice(0, 4096);
}

function boundedServerRequest(task, timeoutMs, naming = DEFAULT_NAMING) {
  if (timeoutMs === null) return Promise.resolve().then(task);
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(acpError(
        `${naming.codePrefix}_SERVER_REQUEST_TIMEOUT`,
        `${naming.protocolLabel} reverse request timed out`,
      )), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function retireErrorListener(target, listener, closed = false) {
  // Logical EOF/failure does not close the OS pipes. A pending write can still
  // emit EPIPE after its callback, even after the child has emitted `exit`.
  // Keep owning those errors until physical close, without changing the result
  // already delivered to the request or retaining the whole client.
  if (!closed && target.closed !== true) {
    const onLateError = () => {};
    target.on("error", onLateError);
    target.once("close", () => target.off?.("error", onLateError));
  }
  target.off?.("error", listener);
}

class AcpJsonlClient {
  constructor(child, options = {}) {
    this.naming = acpNaming(options);
    if (!child?.stdin || !child?.stdout || !child?.stderr
      || typeof child.stdin.write !== "function"
      || typeof child.stdout.on !== "function"
      || typeof child.stderr.on !== "function"
      || typeof child.on !== "function") {
      throw acpError(`${this.naming.codePrefix}_CHILD_INVALID`, `${this.naming.protocolLabel} child process is invalid`);
    }
    this.child = child;
    this.requestTimeoutMs = validTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, this.naming);
    this.serverRequestTimeoutMs = validTimeout(
      options.serverRequestTimeoutMs,
      DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      this.naming,
    );
    // Some runtimes print routine auth-related log lines on stderr; they classify
    // failures from structured errors instead of this coarse stderr hint.
    this.stderrAuthHints = options.stderrAuthHints !== false;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes)
      || this.maxFrameBytes < 1024 || this.maxFrameBytes > 16 * 1024 * 1024) {
      throw acpError(`${this.naming.codePrefix}_OPTIONS_INVALID`, `${this.naming.protocolLabel} frame budget is invalid`);
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
      `${this.naming.codePrefix}_STDOUT_ERROR`,
      `${this.naming.protocolLabel} stdout failed`,
    ));
    this.onStderrData = (chunk) => {
      if (this.stderrAuthHints
        && authFailure(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))) {
        for (const [id, pending] of this.pending) {
          if (authSensitiveMethod(pending.method)) this.authFailureRequestIds.add(id);
        }
      }
    };
    this.onStderrError = () => this._fail(acpError(
      `${this.naming.codePrefix}_STDERR_ERROR`,
      `${this.naming.protocolLabel} stderr failed`,
    ));
    this.onStdinError = () => this._fail(acpError(
      `${this.naming.codePrefix}_STDIN_ERROR`,
      `${this.naming.protocolLabel} stdin failed`,
    ));
    this.onChildError = () => this._fail(acpError(
      `${this.naming.codePrefix}_PROCESS_ERROR`,
      `${this.naming.runtimeName} failed to start`,
    ));
    this.onChildExit = () => this._handleProcessExit();
    this.childClosed = false;
    this.onChildClose = () => { this.childClosed = true; this._handleProcessExit(); };
    child.stdout.on("data", this.onStdoutData);
    child.stdout.once("end", this.onStdoutEnd);
    child.stdout.once("error", this.onStdoutError);
    child.stderr.on("data", this.onStderrData);
    child.stderr.once("error", this.onStderrError);
    child.stdin.once("error", this.onStdinError);
    child.once("error", this.onChildError);
    child.once("exit", this.onChildExit);
    child.once("close", this.onChildClose);
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw acpError(`${this.naming.codePrefix}_SUBSCRIBER_INVALID`, `${this.naming.protocolLabel} subscriber is invalid`);
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  registerServerRequestHandler(method, handler, options = {}) {
    if (typeof method !== "string" || method.length === 0 || typeof handler !== "function") {
      throw acpError(`${this.naming.codePrefix}_HANDLER_INVALID`, `${this.naming.protocolLabel} reverse request handler is invalid`);
    }
    const timeoutMs = options.timeoutMs === undefined
      ? this.serverRequestTimeoutMs : options.timeoutMs;
    if (timeoutMs !== null
      && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1_000)) {
      throw acpError(`${this.naming.codePrefix}_HANDLER_INVALID`, `${this.naming.protocolLabel} reverse request timeout is invalid`);
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
      throw acpError(`${this.naming.codePrefix}_OPTIONS_INVALID`, `${this.naming.protocolLabel} pause request is invalid`);
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

  _requestFrame(method, params) {
    if (this.fatalError) throw this.fatalError;
    if (this.ended) throw acpError(`${this.naming.codePrefix}_TERMINATED`, `${this.naming.protocolLabel} is terminated`);
    if (typeof method !== "string" || method.length === 0 || method.includes("\0")) {
      throw acpError(`${this.naming.codePrefix}_METHOD_INVALID`, `${this.naming.protocolLabel} method is invalid`);
    }
    if (this.nextId > Number.MAX_SAFE_INTEGER || this.pending.size >= 256) {
      throw acpError(`${this.naming.codePrefix}_REQUEST_LIMIT`, `${this.naming.protocolLabel} request capacity was exceeded`);
    }
    return this._serialize(params === undefined
      ? { jsonrpc: "2.0", id: this.nextId, method }
      : { jsonrpc: "2.0", id: this.nextId, method, params });
  }

  preflightRequest(method, params) {
    try {
      const frame = this._requestFrame(method, params);
      return { frameBytes: Buffer.byteLength(frame, "utf8"), maxFrameBytes: this.maxFrameBytes };
    } catch (error) {
      throw requestError(error, "not_sent", this.naming);
    }
  }

  request(method, params, options = {}) {
    let frame;
    let timeoutMs;
    try {
      // Serialize the complete actual frame before reserving a pending request.
      // This is repeated even if the caller preflighted before writing its ledger.
      frame = this._requestFrame(method, params);
      timeoutMs = validTimeout(options.timeoutMs, this.requestTimeoutMs, this.naming);
    } catch (error) {
      return Promise.reject(requestError(error, "not_sent", this.naming));
    }
    const id = this.nextId;
    this.nextId += 1;
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
      dispatchState: "not_sent",
    };
    this.pending.set(id, pending);
    this._armRequestTimeout(id, pending, timeoutMs);
    this._writeFrame(frame, {
      shouldWrite: () => this.pending.get(id) === pending,
      beforeWrite: () => {
        // The observer must durably record this conservative boundary before
        // stdin.write can possibly deliver bytes, including on synchronous throw.
        options.onWriteAttempt?.();
        pending.dispatchState = "write_attempted";
      },
      onWriteFailure: (error) => {
        if (pending.dispatchState === "write_attempted"
          || error?.code === `${this.naming.codePrefix}_STDIN_CLOSED`) this._fail(error);
      },
    }).then((written) => {
      if (!written) return;
      try { options.onWritten?.(); } catch {
        this._fail(acpError(`${this.naming.codePrefix}_WRITE_OBSERVER_FAILED`, `${this.naming.protocolLabel} write observer failed`));
      }
    }).catch((error) => {
      if (this.pending.get(id) === pending) {
        this.pending.delete(id);
        this.authFailureRequestIds.delete(id);
        clearTimeout(pending.timer);
        this._retire(id);
        pending.reject(requestError(error, pending.dispatchState, this.naming));
      }
    });
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
      pending.reject(requestError(
        acpError(`${this.naming.codePrefix}_REQUEST_TIMEOUT`, `${this.naming.protocolLabel} request timed out`),
        pending.dispatchState,
        this.naming,
      ));
    }, timeoutMs);
    pending.timer.unref?.();
  }

  notify(method, params) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ended) return Promise.reject(acpError(`${this.naming.codePrefix}_TERMINATED`, `${this.naming.protocolLabel} is terminated`));
    if (typeof method !== "string" || method.length === 0 || method.includes("\0")) {
      return Promise.reject(acpError(`${this.naming.codePrefix}_METHOD_INVALID`, `${this.naming.protocolLabel} method is invalid`));
    }
    return this._write(params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params });
  }

  terminate() {
    if (this.ended) return Promise.resolve();
    this.explicitlyTerminated = true;
    this.ended = true;
    const error = acpError(`${this.naming.codePrefix}_TERMINATED`, `${this.naming.protocolLabel} was stopped`);
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
          this._fail(acpError(`${this.naming.codePrefix}_FRAME_TOO_LARGE`, `${this.naming.protocolLabel} frame exceeded its limit`));
        }
        return;
      }
      const frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (frame.length === 0) {
        this._fail(acpError(`${this.naming.codePrefix}_MALFORMED_JSONL`, `${this.naming.protocolLabel} emitted an empty frame`));
        return;
      }
      if (frame.length > this.maxFrameBytes) {
        this._fail(acpError(`${this.naming.codePrefix}_FRAME_TOO_LARGE`, `${this.naming.protocolLabel} frame exceeded its limit`));
        return;
      }
      let message;
      try {
        message = JSON.parse(this.decoder.decode(frame));
      } catch (error) {
        this._fail(acpError(
          error instanceof SyntaxError ? `${this.naming.codePrefix}_MALFORMED_JSONL` : `${this.naming.codePrefix}_MALFORMED_UTF8`,
          `${this.naming.protocolLabel} emitted an invalid JSONL frame`,
        ));
        return;
      }
      this._handleMessage(message);
      if (this.ended) return;
    }
  }

  _handleMessage(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
      this._fail(acpError(`${this.naming.codePrefix}_INVALID_MESSAGE`, `${this.naming.protocolLabel} envelope is invalid`));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasMethod = Object.prototype.hasOwnProperty.call(message, "method");
    if (hasId && !hasMethod) {
      this._handleResponse(message);
      return;
    }
    if (typeof message.method !== "string" || message.method.length === 0) {
      this._fail(acpError(`${this.naming.codePrefix}_INVALID_MESSAGE`, `${this.naming.protocolLabel} method is invalid`));
      return;
    }
    if (hasId) this._handleServerRequest(message);
    else this._handleNotification(message);
  }

  _handleResponse(message) {
    if (!validRequestId(message.id)) {
      this._fail(acpError(`${this.naming.codePrefix}_RESPONSE_ID_INVALID`, `${this.naming.protocolLabel} response id is invalid`));
      return;
    }
    if (this.retiredIds.delete(message.id)) {
      this.authFailureRequestIds.delete(message.id);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this._fail(acpError(`${this.naming.codePrefix}_UNKNOWN_RESPONSE_ID`, `${this.naming.protocolLabel} response id is unknown`));
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError || (hasError && !isPlainObject(message.error))) {
      this._fail(acpError(`${this.naming.codePrefix}_RESPONSE_INVALID`, `${this.naming.protocolLabel} response is invalid`));
      return;
    }
    this.pending.delete(message.id);
    const authFailureHint = this.authFailureRequestIds.delete(message.id);
    clearTimeout(pending.timer);
    if (hasError) {
      const required = authFailure(message.error) || authFailureHint;
      const error = acpError(
        required ? "AUTH_REQUIRED" : `${this.naming.codePrefix}_REMOTE_ERROR`,
        required ? `${this.naming.runtimeName} authentication is required` : `${this.naming.protocolLabel} request failed`,
      );
      if (Number.isSafeInteger(message.error.code)) error.rpcCode = message.error.code;
      const detail = remoteErrorDetail(message.error);
      if (detail) Object.defineProperty(error, "rpcDetail", { value: detail, enumerable: false });
      pending.reject(requestError(error, pending.dispatchState, this.naming));
    } else {
      pending.resolve(message.result);
    }
  }

  _handleNotification(message) {
    try { this.notificationGuard?.(message); } catch (error) {
      this._fail(error?.code ? error : acpError(
        `${this.naming.codePrefix}_NOTIFICATION_INVALID`,
        `${this.naming.protocolLabel} notification was rejected`,
      ));
      return;
    }
    for (const subscriber of this.subscribers) {
      try { subscriber(message); } catch {
        try { this.onDiagnostic?.({ code: `${this.naming.codePrefix}_SUBSCRIBER_FAILED`, method: message.method }); } catch {}
      }
    }
  }

  _handleServerRequest(message) {
    if (!validRequestId(message.id)
      || this.serverRequestIds.has(message.id) || this.activeServerRequestIds.has(message.id)) {
      this._fail(acpError(`${this.naming.codePrefix}_SERVER_REQUEST_ID_INVALID`, `${this.naming.protocolLabel} reverse request id is invalid`));
      return;
    }
    if (this.activeServerRequestIds.size >= 64) {
      this._fail(acpError(`${this.naming.codePrefix}_SERVER_REQUEST_LIMIT`, `${this.naming.protocolLabel} reverse request limit was exceeded`));
      return;
    }
    try { this.serverRequestGuard?.(message); } catch (error) {
      this._fail(error?.code ? error : acpError(
        `${this.naming.codePrefix}_SERVER_REQUEST_INVALID`,
        `${this.naming.protocolLabel} reverse request was rejected`,
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
            this.naming,
          );
          response = { jsonrpc: "2.0", id: message.id, result: result ?? null };
        } catch (error) {
          response = {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: error?.code === `${this.naming.codePrefix}_SERVER_REQUEST_TIMEOUT`
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

  _serialize(message) {
    let frame;
    try { frame = `${JSON.stringify(message)}\n`; } catch {
      throw acpError(`${this.naming.codePrefix}_SERIALIZE_FAILED`, `${this.naming.protocolLabel} message is not serializable`);
    }
    const frameBytes = Buffer.byteLength(frame, "utf8");
    if (frameBytes > this.maxFrameBytes) {
      const error = acpError(`${this.naming.codePrefix}_OUTBOUND_FRAME_TOO_LARGE`, `${this.naming.protocolLabel} request exceeded its limit`);
      error.frameBytes = frameBytes;
      error.maxFrameBytes = this.maxFrameBytes;
      throw error;
    }
    return frame;
  }

  _write(message) {
    let frame;
    try { frame = this._serialize(message); } catch (error) { return Promise.reject(error); }
    return this._writeFrame(frame);
  }

  _writeFrame(frame, options = {}) {
    const write = this.writeTail.then(() => new Promise((resolve, reject) => {
      // Timed-out/terminated queued requests must never be sent later.
      if (options.shouldWrite && !options.shouldWrite()) { resolve(false); return; }
      if (this.ended || !this.child.stdin.writable) {
        reject(acpError(`${this.naming.codePrefix}_STDIN_CLOSED`, `${this.naming.protocolLabel} stdin is closed`));
        return;
      }
      try { options.beforeWrite?.(); } catch (error) { reject(error); return; }
      try {
        this.child.stdin.write(frame, (error) => {
          if (error) reject(acpError(`${this.naming.codePrefix}_WRITE_FAILED`, `${this.naming.protocolLabel} write failed`));
          else resolve(true);
        });
      } catch {
        reject(acpError(`${this.naming.codePrefix}_WRITE_FAILED`, `${this.naming.protocolLabel} write failed`));
      }
    }));
    this.writeTail = write.catch((error) => {
      // Fence the connection before allowing the next queued writer to run.
      // A local observer failure leaves the transport usable; a write failure
      // may have delivered only part of a JSONL frame.
      options.onWriteFailure?.(error);
    });
    return write;
  }

  _retire(id) {
    this.retiredIds.add(id);
    if (this.retiredIds.size > 1024) this.retiredIds.delete(this.retiredIds.values().next().value);
  }

  _handleStdoutEnd() {
    if (this.ended) return;
    this._fail(acpError(
      this.stdoutBuffer.length > 0 ? `${this.naming.codePrefix}_MALFORMED_TAIL` : `${this.naming.codePrefix}_STDOUT_ENDED`,
      this.stdoutBuffer.length > 0
        ? `${this.naming.protocolLabel} stdout ended with an incomplete frame`
        : `${this.naming.protocolLabel} stdout ended`,
    ));
  }

  _handleProcessExit() {
    if (this.ended) return;
    this._fail(acpError(
      this.stdoutBuffer.length > 0 ? `${this.naming.codePrefix}_MALFORMED_TAIL` : `${this.naming.codePrefix}_PROCESS_EXITED`,
      this.stdoutBuffer.length > 0
        ? `${this.naming.runtimeName} exited with an incomplete ACP frame`
        : `${this.naming.runtimeName} exited`,
    ));
  }

  _rejectOutstanding(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(requestError(error, pending.dispatchState, this.naming));
    }
    this.pending.clear();
    this.authFailureRequestIds.clear();
  }

  _removeListeners() {
    this.child.stdout.off?.("data", this.onStdoutData);
    this.child.stdout.off?.("end", this.onStdoutEnd);
    retireErrorListener(this.child.stdout, this.onStdoutError);
    this.child.stderr.off?.("data", this.onStderrData);
    retireErrorListener(this.child.stderr, this.onStderrError);
    retireErrorListener(this.child.stdin, this.onStdinError);
    retireErrorListener(this.child, this.onChildError, this.childClosed);
    this.child.off?.("exit", this.onChildExit);
    this.child.off?.("close", this.onChildClose);
  }

  _fail(error) {
    if (this.ended) return;
    this.ended = true;
    this.fatalError = error?.code ? error : acpError(`${this.naming.codePrefix}_FAILED`, `${this.naming.protocolLabel} failed`);
    this._rejectOutstanding(this.fatalError);
    this._removeListeners();
    this.rejectTerminated(this.fatalError);
  }
}

module.exports = {
  AcpJsonlClient,
  DEFAULT_MAX_FRAME_BYTES,
  acpError,
  validRequestId,
};
