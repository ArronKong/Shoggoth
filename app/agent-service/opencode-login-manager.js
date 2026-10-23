"use strict";

// OpenCode signs into model providers from Settings through its own server
// (the account's control instance). OAuth opens the provider's page in the
// app's browser and finishes on OpenCode's callback, or on a code pasted back;
// API keys are saved directly. One sign-in per account at a time.
const crypto = require("node:crypto");
const { serviceError } = require("./security");

const TERMINAL = new Set(["succeeded", "failed", "canceled", "timed_out", "unknown"]);
const LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
const CANCEL_SETTLE_MS = 15_000;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

function failed() {
  return serviceError("AUTH_LOGIN_FAILED", "登录没有完成，请检查填写的信息后重试");
}

class OpenCodeLoginManager {
  constructor(options = {}) {
    if (typeof options.acquireHost !== "function") {
      throw serviceError("AUTH_MANAGER_OPTIONS_INVALID", "OpenCode login options are invalid");
    }
    this.acquireHost = options.acquireHost;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
    this.cancelSettleMs = options.cancelSettleMs ?? CANCEL_SETTLE_MS;
    this.entries = new Map();
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) throw serviceError("AUTH_MANAGER_CLOSED", "登录服务不可用");
  }

  async #host(runtimeAccountId) {
    const host = await this.acquireHost(runtimeAccountId);
    if (!host || ["providerLoginOptions", "providerLoginAuthorize", "providerLoginCallback", "providerLoginApiKey"]
      .some((method) => typeof host[method] !== "function")) {
      throw serviceError("RUNTIME_ACCOUNT_AUTH_UNSUPPORTED", "此运行环境不支持在 Shoggoth Service 内登录或退出");
    }
    return host;
  }

  async options({ runtimeAccountId }) {
    this.#assertOpen();
    return (await this.#host(runtimeAccountId)).providerLoginOptions();
  }

  async providerStart({ runtimeAccountId, providerId, method, inputs }) {
    this.#assertOpen();
    const current = this.entries.get(runtimeAccountId);
    if (current && !TERMINAL.has(current.status)) {
      throw serviceError("AUTH_LOGIN_IN_PROGRESS", "登录已在进行中");
    }
    const host = await this.#host(runtimeAccountId);
    let authorization;
    try { authorization = await host.providerLoginAuthorize({ providerId, method, inputs }); }
    catch { throw failed(); }
    const entry = {
      requestId: this.randomUUID(), providerId, method, host,
      status: "waiting", updatedAt: this.now(), errorCode: null,
      authUrl: authorization.url, instructions: authorization.instructions || null,
      codeRequired: authorization.mode === "code", controller: new AbortController(), done: null,
    };
    this.entries.set(runtimeAccountId, entry);
    if (!entry.codeRequired) this.#settle(entry, undefined);
    else {
      // A code never pasted back ends like a browser sign-in nobody finished.
      const timer = setTimeout(() => {
        if (entry.done || TERMINAL.has(entry.status)) return;
        Object.assign(entry, { status: "timed_out", errorCode: "AUTH_LOGIN_TIMEOUT", updatedAt: this.now() });
      }, this.timeoutMs);
      timer.unref?.();
    }
    return { requestId: entry.requestId, mode: "browser", status: "waiting", loginId: entry.requestId,
      authUrl: entry.authUrl };
  }

  // A sign-in in progress lives in the account's OpenCode server, which must keep running.
  isActive(runtimeAccountId) {
    const entry = this.entries.get(runtimeAccountId);
    return Boolean(entry) && !TERMINAL.has(entry.status);
  }

  async submit({ runtimeAccountId, requestId, code }) {
    this.#assertOpen();
    const entry = this.entries.get(runtimeAccountId);
    if (!entry || entry.requestId !== requestId) throw serviceError("AUTH_LOGIN_NOT_FOUND", "登录请求不存在");
    if (!entry.codeRequired || entry.done || TERMINAL.has(entry.status)) {
      throw serviceError("AUTH_LOGIN_NOT_ACTIVE", "登录请求已结束");
    }
    await this.#settle(entry, code);
    return { requestId, status: entry.status };
  }

  async apiKey({ runtimeAccountId, providerId, key, inputs }) {
    this.#assertOpen();
    const host = await this.#host(runtimeAccountId);
    let saved = false;
    try { saved = await host.providerLoginApiKey({ providerId, key, metadata: inputs }); }
    catch { throw failed(); }
    if (!saved) throw failed();
    return { saved: true };
  }

  #settle(entry, code) {
    const put = (patch) => {
      if (TERMINAL.has(entry.status)) return;
      Object.assign(entry, patch, { updatedAt: this.now() });
    };
    const timer = setTimeout(() => { entry.timedOut = true; entry.controller.abort(); }, this.timeoutMs);
    timer.unref?.();
    entry.done = Promise.resolve()
      .then(() => entry.host.providerLoginCallback({ providerId: entry.providerId, method: entry.method,
        ...(code === undefined ? {} : { code }), signal: entry.controller.signal }))
      .then((ok) => put(ok ? { status: "succeeded" } : { status: "failed", errorCode: "AUTH_LOGIN_FAILED" }),
        () => put(entry.timedOut ? { status: "timed_out", errorCode: "AUTH_LOGIN_TIMEOUT" }
          : entry.controller.signal.aborted ? { status: "canceled" }
            : { status: "failed", errorCode: "AUTH_LOGIN_FAILED" }))
      .finally(() => clearTimeout(timer));
    return entry.done;
  }

  read({ runtimeAccountId }) {
    const entry = this.entries.get(runtimeAccountId);
    return {
      login: entry ? {
        requestId: entry.requestId, mode: "browser", status: entry.status, updatedAt: entry.updatedAt,
        errorCode: entry.errorCode, authUrl: entry.authUrl,
        stage: TERMINAL.has(entry.status) ? null : "waiting", browserOpened: false,
        instructions: entry.instructions, codeRequired: entry.codeRequired,
      } : null,
    };
  }

  async cancel({ runtimeAccountId, requestId }) {
    const entry = this.entries.get(runtimeAccountId);
    if (!entry || entry.requestId !== requestId) throw serviceError("AUTH_LOGIN_NOT_FOUND", "登录请求不存在");
    if (!TERMINAL.has(entry.status)) {
      entry.controller.abort();
      if (entry.done) await Promise.race([entry.done, delay(this.cancelSettleMs)]);
      // Nothing was waiting (a code was never sent), or it did not stop in time.
      if (!TERMINAL.has(entry.status)) {
        Object.assign(entry, { status: entry.done ? "unknown" : "canceled", updatedAt: this.now() });
      }
    }
    return { requestId, status: entry.status };
  }

  close() {
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller.abort();
  }
}

module.exports = { OpenCodeLoginManager };
