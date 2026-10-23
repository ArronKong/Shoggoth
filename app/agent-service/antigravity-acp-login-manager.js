"use strict";

// Antigravity sign-in started from Settings and run inside the Service. One
// sign-in per account at a time; its state is what `runtime.account.login.read`
// reports. The official server opens the browser itself (`browserOpened`).
const crypto = require("node:crypto");
const { loginAntigravityAcp } = require("./antigravity-acp-login");
const { serviceError } = require("./security");

const TERMINAL = new Set(["succeeded", "failed", "canceled", "timed_out", "unknown"]);
const LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
const CANCEL_SETTLE_MS = 15_000;
// Errors the app explains to the user; anything else is AUTH_LOGIN_FAILED.
const PUBLIC_ERROR_CODES = new Set([
  "ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED", "ANTIGRAVITY_ACP_DOWNLOAD_FAILED",
  "ANTIGRAVITY_ACP_INTEGRITY_FAILED", "ANTIGRAVITY_ACP_INSTALL_FAILED",
  "ANTIGRAVITY_ACP_REMOTE_ERROR", "RUNTIME_AUTH_REQUIRED",
]);

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

class AntigravityAcpLoginManager {
  constructor(options = {}) {
    this.loginOptions = {
      ...(options.paths ? { paths: options.paths } : {}),
      ...(options.parentEnv ? { parentEnv: options.parentEnv } : {}),
      ...(options.userHome ? { userHome: options.userHome } : {}),
      ...(options.packageVersion ? { packageVersion: options.packageVersion } : {}),
    };
    this.login = options.login || loginAntigravityAcp;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
    this.cancelSettleMs = options.cancelSettleMs ?? CANCEL_SETTLE_MS;
    this.entries = new Map();
    this.closed = false;
  }

  start({ runtimeAccountId }) {
    if (this.closed) throw serviceError("AUTH_MANAGER_CLOSED", "登录服务不可用");
    const current = this.entries.get(runtimeAccountId);
    if (current && !TERMINAL.has(current.status)) {
      throw serviceError("AUTH_LOGIN_IN_PROGRESS", "登录已在进行中");
    }
    const entry = {
      requestId: this.randomUUID(),
      status: "starting",
      stage: "starting",
      authUrl: null,
      errorCode: null,
      updatedAt: this.now(),
      controller: new AbortController(),
      timedOut: false,
    };
    this.entries.set(runtimeAccountId, entry);
    const put = (patch) => {
      if (TERMINAL.has(entry.status)) return;
      const next = { ...patch };
      // While canceling, only an outcome may replace the status.
      if (entry.status === "canceling" && next.status && !TERMINAL.has(next.status)) delete next.status;
      Object.assign(entry, next, { updatedAt: this.now() });
    };
    const timer = setTimeout(() => { entry.timedOut = true; entry.controller.abort(); }, this.timeoutMs);
    timer.unref?.();
    entry.done = Promise.resolve()
      .then(() => this.login({
        ...this.loginOptions,
        runtimeAccountId,
        signal: entry.controller.signal,
        log: () => {},
        onStage: (stage) => put({ stage, ...(stage === "waiting" ? { status: "waiting" } : {}) }),
        onAuthUrl: (authUrl) => put({ authUrl }),
      }))
      .then(() => put({ status: "succeeded", stage: null }), (error) => put(entry.timedOut
        ? { status: "timed_out", stage: null, errorCode: "AUTH_LOGIN_TIMEOUT" }
        : error?.code === "AUTH_LOGIN_CANCELED" ? { status: "canceled", stage: null }
          : { status: "failed", stage: null,
            errorCode: PUBLIC_ERROR_CODES.has(error?.code) ? error.code : "AUTH_LOGIN_FAILED" }))
      .finally(() => clearTimeout(timer));
    return { requestId: entry.requestId, mode: "browser", status: "waiting", loginId: entry.requestId, authUrl: null };
  }

  read({ runtimeAccountId }) {
    const entry = this.entries.get(runtimeAccountId);
    return {
      login: entry ? {
        requestId: entry.requestId,
        mode: "browser",
        status: entry.status,
        updatedAt: entry.updatedAt,
        errorCode: entry.errorCode,
        authUrl: entry.authUrl,
        stage: entry.stage,
        browserOpened: true,
        instructions: null,
        codeRequired: false,
      } : null,
    };
  }

  async cancel({ runtimeAccountId, requestId }) {
    const entry = this.entries.get(runtimeAccountId);
    if (!entry || entry.requestId !== requestId) {
      throw serviceError("AUTH_LOGIN_NOT_FOUND", "登录请求不存在");
    }
    if (!TERMINAL.has(entry.status)) {
      entry.status = "canceling";
      entry.controller.abort();
      await Promise.race([entry.done, delay(this.cancelSettleMs)]);
      // The sign-in did not stop in time: its outcome is unknown, not canceled.
      if (!TERMINAL.has(entry.status)) Object.assign(entry, { status: "unknown", stage: null, updatedAt: this.now() });
    }
    return { requestId, status: entry.status };
  }

  close() {
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller.abort();
  }
}

module.exports = { AntigravityAcpLoginManager };
