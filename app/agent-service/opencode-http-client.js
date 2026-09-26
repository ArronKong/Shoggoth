"use strict";

const { serviceError } = require("./security");

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const error = (code, message) => serviceError(code, message);

class OpenCodeHttpClient {
  constructor(options = {}) {
    if (typeof options.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(options.url)
      || typeof options.password !== "string" || options.password.length < 32
      || typeof options.fetch !== "function" && options.fetch !== undefined) {
      throw error("OPENCODE_HTTP_OPTIONS_INVALID", "OpenCode HTTP client options are invalid");
    }
    this.url = options.url;
    this.password = options.password;
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 15_000;
  }

  async request(method, route, body, options = {}) {
    if (!new Set(["GET", "POST", "PATCH", "DELETE"]).has(method)
      || typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")
      || route.includes("\0") || route.includes("#")) {
      throw error("OPENCODE_HTTP_ROUTE_INVALID", "OpenCode HTTP route is invalid");
    }
    const target = new URL(route, this.url);
    if (target.origin !== this.url) throw error("OPENCODE_HTTP_ROUTE_INVALID", "OpenCode route escaped loopback");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    timer.unref?.();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal });
    }
    let response;
    try {
      response = await this.fetch(target, {
        method, redirect: "error", signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 204) return { status: 204, data: null };
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw error("OPENCODE_HTTP_RESPONSE_TOO_LARGE", "OpenCode response exceeds limit");
        chunks.push(Buffer.from(value));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw error("OPENCODE_HTTP_PROTOCOL_INVALID", "OpenCode returned invalid JSON"); }
      if (!response.ok && !options.accept?.includes(response.status)) {
        throw error(response.status === 401 ? "RUNTIME_AUTH_REQUIRED"
          : response.status === 404 ? "OPENCODE_NOT_FOUND"
            : response.status >= 500 ? "RUNTIME_CONNECTION_LOST" : "OPENCODE_HTTP_REJECTED",
        `OpenCode request failed (${response.status})`);
      }
      return { status: response.status, data };
    } catch (cause) {
      if (cause?.code?.startsWith?.("OPENCODE_") || cause?.code === "RUNTIME_AUTH_REQUIRED"
        || cause?.code === "RUNTIME_CONNECTION_LOST") throw cause;
      throw error("RUNTIME_CONNECTION_LOST", "OpenCode HTTP connection failed");
    } finally {
      clearTimeout(timer);
      try { await response?.body?.cancel?.(); } catch {}
    }
  }
}

module.exports = { OpenCodeHttpClient };
