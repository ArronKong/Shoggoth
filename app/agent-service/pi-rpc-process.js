"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { PiRpcJsonlDecoder, encodePiRpcCommand } = require("./pi-rpc-jsonl");

const INTERACTIVE_METHODS = new Set(["select", "confirm", "input", "editor"]);

function processError(code, message) {
  return serviceError(code, message);
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function safeString(value, maxBytes, empty = false) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

class PiRpcProcess {
  constructor(options = {}) {
    const child = options.child;
    if (!child || !child.stdin || !child.stdout || !child.stderr
      || typeof child.on !== "function" || typeof child.kill !== "function") {
      throw processError("PI_PROCESS_INVALID", "Pi RPC process pipes are invalid");
    }
    this.child = child;
    this.decoder = new PiRpcJsonlDecoder({
      maxFrameBytes: options.maxFrameBytes,
      maxStreamBytes: options.maxStreamBytes,
    });
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.onExtensionRequest = typeof options.onExtensionRequest === "function"
      ? options.onExtensionRequest : null;
    this.onFatal = typeof options.onFatal === "function" ? options.onFatal : () => {};
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.inputEnded = false;
    const close = makeDeferred();
    this.closedPromise = close.promise;
    this.resolveClosed = close.resolve;
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr.on("data", (chunk) => this._onStderr(chunk));
    child.on("error", () => this._fatal(processError("PI_PROCESS_FAILED", "Pi RPC process failed")));
    child.on("close", (code, signal) => this._onClose(code, signal));
  }

  request(type, fields = {}, options = {}) {
    if (this.closed || !safeString(type, 128)) {
      return Promise.reject(processError("PI_RPC_CLOSED", "Pi RPC process is closed"));
    }
    let id;
    try { id = `shoggoth-${this.randomUUID()}`; } catch {
      return Promise.reject(processError("PI_RPC_REQUEST_ID_INVALID", "Pi RPC request id failed"));
    }
    if (!safeString(id, 256) || this.pending.has(id)) {
      return Promise.reject(processError("PI_RPC_REQUEST_ID_INVALID", "Pi RPC request id is invalid"));
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60 * 1000) {
      return Promise.reject(processError("PI_RPC_TIMEOUT_INVALID", "Pi RPC timeout is invalid"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(processError("PI_RPC_REQUEST_TIMEOUT", `Pi RPC ${type} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { type, resolve, reject, timer });
      try {
        this.child.stdin.write(encodePiRpcCommand({ id, type, ...fields }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(processError("PI_RPC_WRITE_FAILED", "Pi RPC request could not be written"));
      }
    });
  }

  endInput() {
    if (this.inputEnded) return;
    this.inputEnded = true;
    try { this.child.stdin.end(); } catch {}
  }

  kill(signal = "SIGTERM") {
    try { this.child.kill(signal); } catch {}
  }

  _onData(chunk) {
    if (this.closed) return;
    try {
      for (const message of this.decoder.push(chunk)) this._onMessage(message);
    } catch (error) {
      this._fatal(error);
    }
  }

  _onStderr(chunk) {
    if (this.closed) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.stderr = `${this.stderr}${text}`;
    const bytes = Buffer.byteLength(this.stderr, "utf8");
    if (bytes > 256 * 1024) {
      this.stderr = Buffer.from(this.stderr, "utf8").subarray(bytes - 256 * 1024).toString("utf8");
    }
  }

  _onMessage(message) {
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending || message.command !== pending.type || typeof message.success !== "boolean") {
        throw processError("PI_RPC_RESPONSE_INVALID", "Pi RPC response is invalid");
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data);
      else pending.reject(processError(
        /auth|credential|api key|login|unauthorized/iu.test(String(message.error || ""))
          ? "AUTH_REQUIRED" : "PI_RPC_REQUEST_FAILED",
        `Pi RPC ${pending.type} failed`,
      ));
      return;
    }
    if (message.type === "extension_ui_request") {
      this._handleExtensionRequest(message);
      return;
    }
    this.onEvent(message);
  }

  _handleExtensionRequest(message) {
    if (!INTERACTIVE_METHODS.has(message.method)) return;
    if (!this.onExtensionRequest || !safeString(message.id, 256)) {
      this._writeExtensionResponse({ type: "extension_ui_response", id: message.id, cancelled: true });
      return;
    }
    Promise.resolve().then(() => this.onExtensionRequest(message)).then(
      (response) => this._writeExtensionResponse(response),
      () => this._writeExtensionResponse({
        type: "extension_ui_response",
        id: message.id,
        cancelled: true,
      }),
    ).catch((error) => this._fatal(error));
  }

  _writeExtensionResponse(response) {
    if (this.closed || !response || response.type !== "extension_ui_response"
      || !safeString(response.id, 256)) return;
    try { this.child.stdin.write(encodePiRpcCommand(response)); } catch {
      this._fatal(processError("PI_RPC_WRITE_FAILED", "Pi extension response could not be written"));
    }
  }

  _fatal(error) {
    if (this.closed) return;
    const failure = error?.code ? error : processError("PI_RPC_FAILED", "Pi RPC transport failed");
    this.onFatal(failure);
    this.kill("SIGKILL");
  }

  _onClose(code, signal) {
    if (this.closed) return;
    this.closed = true;
    let failure = null;
    try { this.decoder.finish(); } catch (error) { failure = error; }
    if (!failure && this.pending.size > 0) {
      failure = processError("PI_PROCESS_CLOSED", "Pi RPC process closed with pending requests");
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure || processError("PI_PROCESS_CLOSED", "Pi RPC process closed"));
    }
    this.pending.clear();
    this.resolveClosed({ code, signal, error: failure, stderr: this.stderr });
  }
}

module.exports = { PiRpcProcess };
