"use strict";

const { StringDecoder } = require("node:string_decoder");
const {
  boundedTimeout,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  redactDiagnostic,
  rpcError,
  truncateUtf8Tail,
  validateRegisteredSecrets,
  validRequestId,
} = require("./codex-rpc-safety");
const { CodexRpcWriteQueue } = require("./codex-rpc-write-queue");

class CodexJsonlRpcClient {
  constructor(child, options = {}) {
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      throw rpcError("RPC_INVALID_CHILD", "Codex RPC child stdio is unavailable");
    }
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.serverRequestTimeoutMs = options.serverRequestTimeoutMs ?? 30_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 5_000;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.maxBufferedNotifications = options.maxBufferedNotifications ?? 256;
    this.maxBufferedNotificationBytes = options.maxBufferedNotificationBytes ?? (16 * 1024 * 1024);
    this.maxRetiredIds = options.maxRetiredIds ?? 1024;
    this.maxServerRequestIds = options.maxServerRequestIds ?? 4096;
    this.maxActiveServerRequests = options.maxActiveServerRequests ?? 64;
    this.maxPendingRequests = options.maxPendingRequests ?? 256;
    this.maxWaiters = options.maxWaiters ?? 256;
    this.registeredSecrets = validateRegisteredSecrets(options.registeredSecrets || []);
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    this.notificationGuard = typeof options.notificationGuard === "function" ? options.notificationGuard : null;
    this.serverRequestGuard = typeof options.serverRequestGuard === "function" ? options.serverRequestGuard : null;
    this.nextId = 1;
    this.pending = new Map();
    this.retired = new Set();
    this.waiters = new Map();
    this.waiterCount = 0;
    this.notifications = [];
    this.bufferedNotificationBytes = 0;
    this.subscribers = new Set();
    this.serverRequestHandlers = new Map();
    this.serverRequestIds = new Set();
    this.serverRequestIdOrder = [];
    this.activeServerRequestIds = new Set();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrText = "";
    this.fatalError = null;
    this.ended = false;
    this._explicitTermination = false;
    this._decoder = new StringDecoder("utf8");
    this._frameDecoder = new TextDecoder("utf-8", { fatal: true });
    this.terminated = new Promise((resolve, reject) => {
      this._resolveTerminated = resolve;
      this._rejectTerminated = reject;
    });
    // Consumers may observe termination through pending requests only; keep the
    // public promise from becoming an unhandled rejection in that valid usage.
    this.terminated.catch(() => {});
    this.writeQueue = new CodexRpcWriteQueue(child.stdin, {
      writeTimeoutMs: this.writeTimeoutMs,
      maxQueuedWrites: options.maxQueuedWrites,
      maxQueuedWriteBytes: options.maxQueuedWriteBytes,
      onFatal: (error) => this._fail(error),
    });

    this._onStdoutData = (chunk) => this._consumeStdout(chunk);
    this._onStdoutEnd = () => this._handleStdoutEnd();
    this._onStdoutError = () => this._fail(rpcError("RPC_STDOUT_ERROR", "Codex stdout stream failed"));
    this._onStderrData = (chunk) => this._consumeStderr(chunk);
    this._onStderrError = () => this._fail(rpcError("RPC_STDERR_ERROR", "Codex stderr stream failed"));
    this._onStdinError = () => this._fail(rpcError("RPC_STDIN_ERROR", "Codex stdin stream failed"));
    this._onChildError = () => this._fail(rpcError("RPC_PROCESS_ERROR", "Codex process failed to start"));
    this._onExit = (code, signal) => this._handleProcessExit(code, signal);
    this._onClose = (code, signal) => this._handleProcessExit(code, signal);
    child.stdout.on("data", this._onStdoutData);
    child.stdout.once("end", this._onStdoutEnd);
    child.stdout.once("error", this._onStdoutError);
    child.stderr.on("data", this._onStderrData);
    child.stderr.once("error", this._onStderrError);
    child.stdin.once("error", this._onStdinError);
    child.once("error", this._onChildError);
    child.once("exit", this._onExit);
    child.once("close", this._onClose);
  }

  registerServerRequestHandler(method, handler, options = {}) {
    if (typeof method !== "string" || method.length === 0 || typeof handler !== "function") {
      throw rpcError("RPC_INVALID_HANDLER", "Server request handler must have a method and function");
    }
    const timeoutMs = options.timeoutMs === undefined
      ? this.serverRequestTimeoutMs : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw rpcError("RPC_INVALID_HANDLER", "Server request handler timeout is invalid");
    }
    const registration = { handler, timeoutMs };
    this.serverRequestHandlers.set(method, registration);
    return () => {
      if (this.serverRequestHandlers.get(method) === registration) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw rpcError("RPC_INVALID_SUBSCRIBER", "Subscriber must be a function");
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  stderrDiagnostic() {
    return this.stderrText;
  }

  registerSecret(value) {
    const updated = validateRegisteredSecrets([...this.registeredSecrets, value]);
    this.registeredSecrets = updated;
    this.stderrText = truncateUtf8Tail(
      redactDiagnostic(this.stderrText, this.registeredSecrets),
      this.maxStderrBytes,
    );
  }

  async request(method, params, options = {}) {
    if (this.fatalError) throw this.fatalError;
    if (this.ended) throw rpcError("RPC_TERMINATED", "Codex RPC client is terminated");
    if (typeof method !== "string" || method.length === 0) {
      throw rpcError("RPC_INVALID_METHOD", "RPC method must be a non-empty string");
    }
    if (this.nextId > Number.MAX_SAFE_INTEGER) {
      const error = rpcError("RPC_REQUEST_ID_EXHAUSTED", "Codex RPC request id space is exhausted");
      this._fail(error);
      throw error;
    }
    if (this.pending.size >= this.maxPendingRequests) {
      const error = rpcError("RPC_PENDING_REQUEST_LIMIT", "Codex pending request limit was exceeded");
      this._fail(error);
      throw error;
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const signal = options.signal;
    if (signal?.aborted) {
      this._retireRequestId(id);
      throw rpcError("RPC_REQUEST_ABORTED", "Codex RPC request was aborted");
    }
    let abortListener;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this._retireRequestId(id);
        signal?.removeEventListener("abort", abortListener);
        reject(rpcError("RPC_REQUEST_TIMEOUT", "Codex RPC request timed out"));
      }, timeoutMs);
      abortListener = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this._retireRequestId(id);
        clearTimeout(timer);
        reject(rpcError("RPC_REQUEST_ABORTED", "Codex RPC request was aborted"));
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      this.pending.set(id, { method, resolve, reject, timer, signal, abortListener });
    });
    const message = params === undefined ? { id, method } : { id, method, params };
    this._write(message).catch((error) => this._fail(error));
    return result;
  }

  notify(method, params) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ended) return Promise.reject(rpcError("RPC_TERMINATED", "Codex RPC client is terminated"));
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(rpcError("RPC_INVALID_METHOD", "RPC method must be a non-empty string"));
    }
    return this._write(params === undefined ? { method } : { method, params });
  }

  waitFor(method, options = {}) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ended) return Promise.reject(rpcError("RPC_TERMINATED", "Codex RPC client is terminated"));
    const existingIndex = this.notifications.findIndex((message) => message.method === method);
    if (existingIndex >= 0) {
      const [message] = this.notifications.splice(existingIndex, 1);
      this.bufferedNotificationBytes -= this._messageBytes(message);
      return Promise.resolve(message);
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(rpcError("RPC_WAIT_ABORTED", "Notification wait was aborted"));
    if (this.waiterCount >= this.maxWaiters) {
      const error = rpcError("RPC_WAITER_LIMIT", "Codex notification waiter limit was exceeded");
      this._fail(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let abortListener;
      const waiter = { resolve, reject, timer: null, signal, abortListener: null };
      const remove = () => {
        const current = this.waiters.get(method) || [];
        const found = current.includes(waiter);
        const remaining = current.filter((entry) => entry !== waiter);
        if (found) this.waiterCount -= 1;
        if (remaining.length > 0) this.waiters.set(method, remaining);
        else this.waiters.delete(method);
      };
      waiter.timer = setTimeout(() => {
        remove();
        signal?.removeEventListener("abort", abortListener);
        reject(rpcError("RPC_NOTIFICATION_TIMEOUT", "Codex notification wait timed out"));
      }, timeoutMs);
      abortListener = () => {
        remove();
        clearTimeout(waiter.timer);
        reject(rpcError("RPC_WAIT_ABORTED", "Notification wait was aborted"));
      };
      waiter.abortListener = abortListener;
      signal?.addEventListener("abort", abortListener, { once: true });
      const entries = this.waiters.get(method) || [];
      entries.push(waiter);
      this.waiters.set(method, entries);
      this.waiterCount += 1;
    });
  }

  async terminate(_reason = "terminated") {
    if (this.ended) return;
    this._explicitTermination = true;
    this.ended = true;
    const error = rpcError("RPC_TERMINATED", "Codex RPC client was terminated");
    this.writeQueue.fail(error);
    this._rejectOutstanding(error);
    this._resolveTerminated();
  }

  _consumeStdout(chunk) {
    if (this.ended) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length > this.maxFrameBytes) {
          this._fail(rpcError("RPC_FRAME_TOO_LARGE", "Codex JSONL frame exceeded its byte limit"));
        }
        return;
      }
      const frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (frame.length > this.maxFrameBytes) {
        this._fail(rpcError("RPC_FRAME_TOO_LARGE", "Codex JSONL frame exceeded its byte limit"));
        return;
      }
      if (frame.length === 0) {
        this._fail(rpcError("RPC_MALFORMED_JSONL", "Codex emitted an empty JSONL frame"));
        return;
      }
      let text;
      try {
        text = this._frameDecoder.decode(frame);
      } catch {
        this._fail(rpcError("RPC_MALFORMED_UTF8", "Codex emitted invalid UTF-8"));
        return;
      }
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        this._fail(rpcError("RPC_MALFORMED_JSONL", "Codex emitted malformed JSONL"));
        return;
      }
      this._handleMessage(message);
      if (this.ended) return;
    }
  }

  _consumeStderr(chunk) {
    if (this.ended) return;
    const decoded = this._decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const safe = redactDiagnostic(`${this.stderrText}${decoded}`, this.registeredSecrets);
    this.stderrText = truncateUtf8Tail(safe, this.maxStderrBytes);
  }

  _handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this._fail(rpcError("RPC_INVALID_MESSAGE", "Codex protocol message must be an object"));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasMethod = Object.prototype.hasOwnProperty.call(message, "method");
    if (hasId && !hasMethod) {
      this._handleResponse(message);
      return;
    }
    if (typeof message.method !== "string" || message.method.length === 0) {
      this._fail(rpcError("RPC_INVALID_MESSAGE", "Codex protocol message is missing a method"));
      return;
    }
    if (hasId) {
      if (!validRequestId(message.id)) {
        this._fail(rpcError("RPC_INVALID_SERVER_REQUEST_ID", "Codex server request id is invalid"));
        return;
      }
      if (this.serverRequestIds.has(message.id) || this.activeServerRequestIds.has(message.id)) {
        this._fail(rpcError("RPC_DUPLICATE_SERVER_REQUEST", "Codex repeated a server request id"));
        return;
      }
      if (this.activeServerRequestIds.size >= this.maxActiveServerRequests) {
        this._fail(rpcError("RPC_SERVER_REQUEST_CONCURRENCY", "Codex server request concurrency exceeded its limit"));
        return;
      }
      try {
        this.serverRequestGuard?.(message);
      } catch (error) {
        this._fail(error?.code ? error : rpcError("RPC_SERVER_REQUEST_REJECTED", "Codex server request was rejected"));
        return;
      }
      this.activeServerRequestIds.add(message.id);
      void this._handleServerRequest(message);
      return;
    }
    this._handleNotification(message);
  }

  _handleResponse(message) {
    const id = message.id;
    if (!validRequestId(id)) {
      this._fail(rpcError("RPC_INVALID_RESPONSE_ID", "Codex response id is invalid"));
      return;
    }
    if (this.retired.has(id)) {
      this.retired.delete(id);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      const duplicate = typeof id === "number" && id > 0 && id < this.nextId;
      this._fail(rpcError(
        duplicate ? "RPC_DUPLICATE_RESPONSE" : "RPC_UNKNOWN_RESPONSE_ID",
        duplicate ? "Codex repeated an RPC response" : "Codex responded with an unknown id",
      ));
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError) {
      this._fail(rpcError("RPC_INVALID_RESPONSE", "Codex response must contain exactly one result or error"));
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abortListener);
    if (hasError) {
      const error = rpcError("RPC_REMOTE_ERROR", "Codex RPC request failed");
      if (Number.isSafeInteger(message.error?.code)) error.rpcCode = message.error.code;
      // Preserve only fixed startup classifications, never remote text (which
      // can contain credentials or paths). Codex often reports MCP failures in
      // the JSON-RPC response rather than forwarding helper stderr to this pipe.
      if ((pending.method === "thread/start" || pending.method === "thread/resume")
        && typeof message.error?.message === "string") {
        const diagnostic = message.error.message.match(/\b(?:BOOTSTRAP_ROLE_REJECTED|BOOTSTRAP_CODE_IDENTITY_(?:TIMEOUT|INVALID)|BOOTSTRAP_MCP_START_FAILED|MCP_HELPER_(?:ARGUMENTS_INVALID|AUTH_FAILED|FAILED))\b/u)?.[0];
        if (diagnostic) error.startupDiagnostic = diagnostic;
        else if (/(?:required MCP servers failed to initialize|handshaking with MCP server failed)/iu.test(message.error.message)) {
          error.startupDiagnostic = "MCP_INITIALIZE_FAILED";
        }
      }
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  _handleNotification(message) {
    try {
      this.notificationGuard?.(message);
    } catch (error) {
      this._fail(error?.code ? error : rpcError("RPC_NOTIFICATION_REJECTED", "Codex notification was rejected"));
      return;
    }
    const waiters = this.waiters.get(message.method) || [];
    if (waiters.length > 0) {
      this.waiters.delete(message.method);
      this.waiterCount -= waiters.length;
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.abortListener);
        waiter.resolve(message);
      }
    } else if (this.subscribers.size === 0) {
      this._bufferNotification(message);
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(message);
      } catch {
        this.onDiagnostic?.({ code: "RPC_SUBSCRIBER_FAILED", method: message.method });
      }
    }
  }

  async _handleServerRequest(message) {
    const registration = this.serverRequestHandlers.get(message.method);
    let response;
    if (!registration) {
      response = { id: message.id, error: { code: -32601, message: "Method not found" } };
    } else {
      try {
        const result = await boundedTimeout(
          () => registration.handler(message.params, { id: message.id, method: message.method }),
          registration.timeoutMs,
          rpcError("RPC_SERVER_HANDLER_TIMEOUT", "Server request handler timed out"),
        );
        response = { id: message.id, result: result === undefined ? null : result };
      } catch (error) {
        const timedOut = error?.code === "RPC_SERVER_HANDLER_TIMEOUT";
        response = {
          id: message.id,
          error: {
            code: -32603,
            message: timedOut ? "Server request handler timed out" : "Server request handler failed",
          },
        };
      }
    }
    if (this.ended) return;
    try {
      await this._write(response);
    } catch (error) {
      this._fail(error);
    } finally {
      this.activeServerRequestIds.delete(message.id);
      this._rememberServerRequestId(message.id);
    }
  }

  _write(message) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ended || !this.child.stdin.writable) {
      return Promise.reject(rpcError("RPC_STDIN_CLOSED", "Codex stdin is closed"));
    }
    let frame;
    try {
      frame = `${JSON.stringify(message)}\n`;
    } catch {
      return Promise.reject(rpcError("RPC_SERIALIZE_FAILED", "RPC message is not JSON serializable"));
    }
    if (Buffer.byteLength(frame) > this.maxFrameBytes) {
      return Promise.reject(rpcError("RPC_OUTBOUND_FRAME_TOO_LARGE", "RPC request exceeded its byte limit"));
    }
    return this.writeQueue.enqueue(frame);
  }

  _handleStdoutEnd() {
    if (this.ended) return;
    if (this.stdoutBuffer.length > 0) {
      this._fail(rpcError("RPC_MALFORMED_TAIL", "Codex stdout ended with an incomplete JSONL frame"));
      return;
    }
    this._fail(rpcError("RPC_STDOUT_ENDED", "Codex stdout stream ended"));
  }

  _messageBytes(message) {
    try { return Buffer.byteLength(JSON.stringify(message)); } catch { return this.maxBufferedNotificationBytes + 1; }
  }

  _bufferNotification(message) {
    const bytes = this._messageBytes(message);
    if (bytes > this.maxBufferedNotificationBytes || this.maxBufferedNotifications <= 0) {
      this.onDiagnostic?.({ code: "RPC_NOTIFICATION_DROPPED", method: message.method });
      return;
    }
    this.notifications.push(message);
    this.bufferedNotificationBytes += bytes;
    while (this.notifications.length > this.maxBufferedNotifications
      || this.bufferedNotificationBytes > this.maxBufferedNotificationBytes) {
      const removed = this.notifications.shift();
      this.bufferedNotificationBytes -= this._messageBytes(removed);
    }
  }

  _retireRequestId(id) {
    if (this.retired.has(id)) return;
    if (this.retired.size >= this.maxRetiredIds) {
      this.retired.delete(this.retired.values().next().value);
    }
    this.retired.add(id);
  }

  _rememberServerRequestId(id) {
    if (this.serverRequestIds.has(id)) return;
    this.serverRequestIds.add(id);
    this.serverRequestIdOrder.push(id);
    while (this.serverRequestIdOrder.length > this.maxServerRequestIds) {
      this.serverRequestIds.delete(this.serverRequestIdOrder.shift());
    }
  }

  _handleProcessExit(_code, _signal) {
    if (this.ended) return;
    if (this.stdoutBuffer.length > 0) {
      this._fail(rpcError("RPC_MALFORMED_TAIL", "Codex exited with an incomplete JSONL frame"));
      return;
    }
    this._fail(rpcError("RPC_PROCESS_EXITED", "Codex app-server exited"));
  }

  _rejectOutstanding(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abortListener);
      pending.reject(error);
    }
    this.pending.clear();
    for (const entries of this.waiters.values()) {
      for (const waiter of entries) {
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.abortListener);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    this.waiterCount = 0;
  }

  _fail(error) {
    if (this.ended) return;
    this.ended = true;
    this.fatalError = error;
    this.writeQueue.fail(error);
    this._rejectOutstanding(error);
    this._rejectTerminated(error);
  }
}

module.exports = {
  CodexJsonlRpcClient,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  redactDiagnostic,
  rpcError,
  validRequestId,
};
