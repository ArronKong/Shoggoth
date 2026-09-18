"use strict";

const crypto = require("node:crypto");
const { DeepSeekHarnessJsonlDecoder, encodeDeepSeekHarnessMessage } = require("./deepseek-harness-jsonl");
const { serverRequestUsesApprovalWait } = require("./interactive-timeouts");
const { serviceError } = require("./security");

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

function safeString(value, maxBytes = 1024) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

class DeepSeekHarnessProcess {
  constructor(options = {}) {
    const child = options.child;
    if (!child || !child.stdin || !child.stdout || !child.stderr
      || typeof child.on !== "function" || typeof child.kill !== "function") {
      throw processError(
        "DEEPSEEK_HARNESS_PROCESS_INVALID",
        "DeepSeek Harness process pipes are invalid",
      );
    }
    this.child = child;
    this.decoder = new DeepSeekHarnessJsonlDecoder({
      maxFrameBytes: options.maxFrameBytes,
      maxStreamBytes: options.maxStreamBytes,
    });
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.serverRequestTimeoutMs = options.serverRequestTimeoutMs ?? 310_000;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.onServerRequest = typeof options.onServerRequest === "function"
      ? options.onServerRequest : null;
    this.onFatal = typeof options.onFatal === "function" ? options.onFatal : () => {};
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.inputEnded = false;
    const ready = makeDeferred();
    const close = makeDeferred();
    this.ready = ready.promise;
    this.resolveReady = ready.resolve;
    this.rejectReady = ready.reject;
    this.closedPromise = close.promise;
    this.resolveClosed = close.resolve;
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr.on("data", (chunk) => this._onStderr(chunk));
    child.on("error", () => this._fatal(processError(
      "DEEPSEEK_HARNESS_PROCESS_FAILED",
      "DeepSeek Harness process failed",
    )));
    child.on("close", (code, signal) => this._onClose(code, signal));
  }

  request(command, params = {}, options = {}) {
    if (this.closed || !safeString(command, 128)) {
      return Promise.reject(processError(
        "DEEPSEEK_HARNESS_RPC_CLOSED",
        "DeepSeek Harness process is closed",
      ));
    }
    let id;
    try { id = `shoggoth-${this.randomUUID()}`; } catch {
      return Promise.reject(processError(
        "DEEPSEEK_HARNESS_REQUEST_ID_INVALID",
        "DeepSeek Harness request id failed",
      ));
    }
    if (!safeString(id, 256) || this.pending.has(id)) {
      return Promise.reject(processError(
        "DEEPSEEK_HARNESS_REQUEST_ID_INVALID",
        "DeepSeek Harness request id is invalid",
      ));
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60 * 1000) {
      return Promise.reject(processError(
        "DEEPSEEK_HARNESS_TIMEOUT_INVALID",
        "DeepSeek Harness request timeout is invalid",
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(processError(
          "DEEPSEEK_HARNESS_REQUEST_TIMEOUT",
          `DeepSeek Harness ${command} timed out`,
        ));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { command, resolve, reject, timer });
      try {
        this.child.stdin.write(encodeDeepSeekHarnessMessage({
          type: "request", id, command, params,
        }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(processError(
          "DEEPSEEK_HARNESS_WRITE_FAILED",
          "DeepSeek Harness request could not be written",
        ));
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
    if (message.type === "ready") {
      if (message.protocol !== "shoggoth-dsh-runtime" || message.protocolVersion !== 1) {
        throw processError(
          "DEEPSEEK_HARNESS_PROTOCOL_UNSUPPORTED",
          "DeepSeek Harness Bridge protocol is unsupported",
        );
      }
      this.resolveReady();
      return;
    }
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending || message.command !== pending.command || typeof message.success !== "boolean") {
        throw processError(
          "DEEPSEEK_HARNESS_RESPONSE_INVALID",
          "DeepSeek Harness response is invalid",
        );
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data);
      else {
        const remoteCode = safeString(message.error?.code, 128)
          ? message.error.code : "DEEPSEEK_HARNESS_REQUEST_FAILED";
        const auth = /auth|credential|api[ -]?key|login|unauthorized|forbidden/iu
          .test(`${remoteCode} ${message.error?.message || ""}`);
        pending.reject(processError(
          auth ? "AUTH_REQUIRED" : remoteCode,
          safeString(message.error?.message, 4096)
            ? message.error.message : `DeepSeek Harness ${pending.command} failed`,
        ));
      }
      return;
    }
    if (message.type === "event") {
      this.onEvent(message.event);
      return;
    }
    if (message.type === "server_request") {
      this._handleServerRequest(message);
      return;
    }
    throw processError(
      "DEEPSEEK_HARNESS_MESSAGE_INVALID",
      "DeepSeek Harness emitted an unknown message",
    );
  }

  _handleServerRequest(message) {
    if (!safeString(message.id, 256) || !safeString(message.method, 256)
      || !this.onServerRequest) {
      this._writeServerResponse({
        type: "server_response",
        id: message.id,
        success: false,
        error: { code: "RUNTIME_SERVER_REQUEST_UNAVAILABLE", message: "Request handler is unavailable" },
      });
      return;
    }
    const timeoutMs = serverRequestUsesApprovalWait(message.method, message.params)
      ? null : this.serverRequestTimeoutMs;
    let timer = null;
    const timeout = timeoutMs === null ? null : new Promise((_, reject) => {
      timer = setTimeout(() => reject(processError(
        "RUNTIME_SERVER_REQUEST_TIMEOUT",
        "DeepSeek Harness server request timed out",
      )), timeoutMs);
      timer.unref?.();
    });
    Promise.race([
      Promise.resolve().then(() => this.onServerRequest(message.method, message.params)),
      ...(timeout === null ? [] : [timeout]),
    ]).then(
      (data) => this._writeServerResponse({
        type: "server_response", id: message.id, success: true, data: data ?? {},
      }),
      (error) => this._writeServerResponse({
        type: "server_response",
        id: message.id,
        success: false,
        error: {
          code: safeString(error?.code, 128) ? error.code : "RUNTIME_SERVER_REQUEST_FAILED",
          message: safeString(error?.message, 4096) ? error.message : "Server request failed",
        },
      }),
    ).finally(() => {
      if (timer !== null) clearTimeout(timer);
    }).catch((error) => this._fatal(error));
  }

  _writeServerResponse(response) {
    if (this.closed) return;
    try { this.child.stdin.write(encodeDeepSeekHarnessMessage(response)); } catch {
      this._fatal(processError(
        "DEEPSEEK_HARNESS_WRITE_FAILED",
        "DeepSeek Harness server response could not be written",
      ));
    }
  }

  _fatal(error) {
    if (this.closed) return;
    const failure = error?.code ? error : processError(
      "DEEPSEEK_HARNESS_TRANSPORT_FAILED",
      "DeepSeek Harness transport failed",
    );
    this.rejectReady(failure);
    this.onFatal(failure);
    this.kill("SIGKILL");
  }

  _onClose(code, signal) {
    if (this.closed) return;
    this.closed = true;
    let failure = null;
    try { this.decoder.finish(); } catch (error) { failure = error; }
    if (!failure && this.pending.size > 0) {
      failure = processError(
        "DEEPSEEK_HARNESS_PROCESS_CLOSED",
        "DeepSeek Harness process closed with pending requests",
      );
    }
    const closedError = failure || processError(
      "DEEPSEEK_HARNESS_PROCESS_CLOSED",
      "DeepSeek Harness process closed",
    );
    this.rejectReady(closedError);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError);
    }
    this.pending.clear();
    this.resolveClosed({ code, signal, error: failure, stderr: this.stderr });
  }
}

module.exports = { DeepSeekHarnessProcess };
