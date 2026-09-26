"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

// Protocol reference: official ext-apps/specification/2026-01-26/apps.mdx.
// This is the Service authority core, not a renderer or a generic MCP proxy.
const PROTOCOL_VERSION = "2026-01-26";
const MIME_TYPE = "text/html;profile=mcp-app";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_HTML = 512 * 1024;
const MAX_MESSAGE = 64 * 1024;
const MAX_RESULT = 256 * 1024;
const MAX_SESSIONS = 32;
const MAX_PENDING = 64;
const MAX_SESSION_PENDING = 4;
const MAX_MESSAGES = 512;
const fail = (code) => { throw serviceError(code, "MCP App 请求无效、已失效或不受支持"); };
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const plain = (value) => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, fields) => plain(value) && Reflect.ownKeys(value).length === fields.length
  && fields.every((field) => Object.hasOwn(value, field));
const boundedText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

function jsonCopy(value, maxBytes, depth = 0) {
  if (depth > 24) fail("MCP_APP_MESSAGE_INVALID");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > maxBytes) fail("MCP_APP_LIMIT");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !plain(value)) fail("MCP_APP_MESSAGE_INVALID");
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).some((key) => typeof key !== "string")
    || Object.keys(entries).length > 1024) fail("MCP_APP_LIMIT");
  const result = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(entries)) {
    if (Array.isArray(value) && key === "length") continue;
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable
      || ["__proto__", "constructor", "prototype"].includes(key)) fail("MCP_APP_MESSAGE_INVALID");
    result[key] = jsonCopy(descriptor.value, maxBytes, depth + 1);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail("MCP_APP_LIMIT");
  return result;
}

function origin(value) {
  if (!boundedText(value, 2048)) fail("MCP_APP_ORIGIN_INVALID");
  let parsed;
  try { parsed = new URL(value); } catch { fail("MCP_APP_ORIGIN_INVALID"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin !== value
    || parsed.username || parsed.password || parsed.hostname.includes("*")) fail("MCP_APP_ORIGIN_INVALID");
  return parsed.origin;
}

function resourceUri(value) {
  if (!boundedText(value, 2048) || !value.startsWith("ui://")
    || /[\u0000-\u0020\u007f]/u.test(value)) fail("MCP_APP_RESOURCE_INVALID");
  let parsed;
  try { parsed = new URL(value); } catch { fail("MCP_APP_RESOURCE_INVALID"); }
  if (parsed.protocol !== "ui:" || !parsed.hostname || parsed.username || parsed.password
    || parsed.hash) fail("MCP_APP_RESOURCE_INVALID");
  return value;
}

function domains(value = []) {
  if (!Array.isArray(value) || value.length > 16) fail("MCP_APP_RESOURCE_INVALID");
  return [...new Set(value.map((item) => {
    const result = origin(item);
    const parsed = new URL(result);
    if (parsed.protocol !== "https:" || parsed.hostname === "localhost"
      || parsed.hostname.endsWith(".localhost") || parsed.hostname.endsWith(".local")
      || parsed.hostname.includes(":") || /^[\d.]+$/u.test(parsed.hostname)) {
      fail("MCP_APP_ORIGIN_INVALID");
    }
    return result;
  }))].sort();
}

function normalizeAppResource({ tool, resource, approvedCsp = {} }) {
  const toolUi = tool?._meta?.ui;
  if (!plain(toolUi) || (toolUi.visibility !== undefined && (!Array.isArray(toolUi.visibility)
    || toolUi.visibility.length > 2 || new Set(toolUi.visibility).size !== toolUi.visibility.length
    || toolUi.visibility.some((item) => !["model", "app"].includes(item))))) {
    fail("MCP_APP_RESOURCE_INVALID");
  }
  const uri = resourceUri(tool?._meta?.ui?.resourceUri);
  if (!plain(resource) || resource.uri !== uri || resource.mimeType !== MIME_TYPE
    || (typeof resource.text === "string") === (typeof resource.blob === "string")) {
    fail("MCP_APP_RESOURCE_INVALID");
  }
  let html = resource.text;
  if (typeof resource.blob === "string") {
    if (resource.blob.length > Math.ceil(MAX_HTML / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(resource.blob)) {
      fail("MCP_APP_RESOURCE_INVALID");
    }
    try { html = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(resource.blob, "base64")); }
    catch { fail("MCP_APP_RESOURCE_INVALID"); }
  }
  if (Buffer.byteLength(html) > MAX_HTML || !/^\s*<!doctype html[\s>]/iu.test(html)
    || !/<html[\s>]/iu.test(html)) fail("MCP_APP_RESOURCE_INVALID");
  const metadata = resource._meta?.ui ?? {};
  if (!plain(metadata) || !plain(metadata.csp ?? {}) || !plain(approvedCsp)) {
    fail("MCP_APP_RESOURCE_INVALID");
  }
  const declared = metadata.csp ?? {};
  const csp = {};
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]) {
    const requested = domains(declared[key]);
    const approved = domains(approvedCsp[key]);
    // Nested frames and alternate base URIs remain unsupported in this core.
    csp[key] = ["frameDomains", "baseUriDomains"].includes(key) ? []
      : requested.filter((item) => approved.includes(item));
  }
  const staticOrigins = csp.resourceDomains.join(" ");
  const header = ["default-src 'none'", `script-src 'unsafe-inline' ${staticOrigins}`,
    `style-src 'unsafe-inline' ${staticOrigins}`, `img-src data: ${staticOrigins}`,
    `media-src data: ${staticOrigins}`, `font-src data: ${staticOrigins}`,
    `connect-src ${csp.connectDomains.join(" ") || "'none'"}`,
    "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    "worker-src 'none'"].map((part) => part.trim()).join("; ");
  const policy = { csp, contentSecurityPolicy: header, permissions: {},
    permissionsPolicy: "camera=(), microphone=(), geolocation=(), clipboard-write=()",
    outerSandbox: "allow-scripts allow-same-origin", innerSandbox: "allow-scripts",
    nodeIntegration: false, contextIsolation: true, sandbox: true, navigation: "blocked",
    dedicatedOriginRequested: typeof metadata.domain === "string",
    prefersBorder: typeof metadata.prefersBorder === "boolean" ? metadata.prefersBorder : true };
  return { uri, mimeType: MIME_TYPE, html,
    resourceDigest: sha(JSON.stringify([uri, html, jsonCopy(metadata, MAX_MESSAGE), policy])), policy };
}

function normalizeAuthority(value) {
  const fields = ["profileId", "conversationId", "runId", "installationId", "releaseDigest",
    "componentId", "bindingId", "bindingRevision", "connectionId", "principalIdentity",
    "authRevision", "toolIdentity", "contractDigest", "catalogRevision"];
  if (!exact(value, fields) || !["profileId", "conversationId", "runId", "installationId",
    "bindingId", "connectionId"].every((key) => typeof value[key] === "string" && ID.test(value[key]))
    || !["releaseDigest", "componentId", "contractDigest"].every((key) => typeof value[key] === "string" && HASH.test(value[key]))
    || !["bindingRevision", "authRevision"].every((key) => Number.isSafeInteger(value[key]) && value[key] > 0)
    || !boundedText(value.principalIdentity, 1024) || !boundedText(value.catalogRevision, 128)
    || !boundedText(value.toolIdentity, 512)) fail("MCP_APP_AUTHORITY_INVALID");
  return Object.freeze({ ...value });
}

class PluginAppSessionManager {
  #sessions = new Map();
  #pending = new Map();

  constructor({ assertAuthority, dispatchCapability, now = Date.now } = {}) {
    if (typeof assertAuthority !== "function" || typeof dispatchCapability !== "function"
      || typeof now !== "function") throw new TypeError("MCP App sessions require Service authority and Dispatcher route");
    Object.assign(this, { assertAuthority, dispatchCapability, now });
  }

  create({ authority, tool, resource, tools, hostOrigin, sandboxOrigin, sourceId,
    approvedCsp = {}, ttlMs = 120_000 }) {
    this.sweep();
    if (this.#sessions.size >= MAX_SESSIONS || !Number.isSafeInteger(ttlMs)
      || ttlMs < 1000 || ttlMs > 300_000 || typeof sourceId !== "string" || !ID.test(sourceId)) fail("MCP_APP_LIMIT");
    hostOrigin = origin(hostOrigin);
    sandboxOrigin = origin(sandboxOrigin);
    if (hostOrigin === sandboxOrigin) fail("MCP_APP_ORIGIN_INVALID");
    const frozen = normalizeAuthority(authority);
    const normalized = normalizeAppResource({ tool, resource, approvedCsp });
    if (!Array.isArray(tools) || tools.length > 256) fail("MCP_APP_AUTHORITY_INVALID");
    const allowed = new Map();
    const prefix = `plugin:${frozen.installationId}:${frozen.componentId}:${frozen.connectionId}:`;
    for (const entry of tools) {
      const visibility = entry?.visibility ?? entry?.ui?.visibility ?? ["model", "app"];
      if (!plain(entry) || !boundedText(entry.downstreamName, 128)
        || !HASH.test(entry.contractDigest) || entry.toolIdentity !== `${prefix}${sha(entry.downstreamName)}`
        || allowed.has(entry.downstreamName) || entry.appUnsupported === true
        || !Array.isArray(visibility) || visibility.length > 2
        || new Set(visibility).size !== visibility.length
        || visibility.some((item) => !["app", "model"].includes(item))) {
        fail("MCP_APP_AUTHORITY_INVALID");
      }
      allowed.set(entry.downstreamName, Object.freeze({ downstreamName: entry.downstreamName,
        toolIdentity: entry.toolIdentity, contractDigest: entry.contractDigest,
        appVisible: visibility.includes("app") }));
    }
    const originating = allowed.get(tool.name);
    if (!originating || originating.toolIdentity !== frozen.toolIdentity
      || originating.contractDigest !== frozen.contractDigest) fail("MCP_APP_AUTHORITY_INVALID");
    const sessionId = crypto.randomBytes(32).toString("hex");
    const session = { sessionId, nonce: crypto.randomBytes(32).toString("hex"), sourceId,
      hostOrigin, sandboxOrigin, expiresAt: this.now() + ttlMs, resource: normalized,
      context: Object.freeze({ ...frozen, resourceUri: normalized.uri, resourceDigest: normalized.resourceDigest }),
      tools: allowed, state: "created", seen: new Set(), messages: 0,
      windowStart: this.now(), windowMessages: 0, pending: new Map() };
    this.#assert(session, false);
    this.#sessions.set(sessionId, session);
    return { sessionId, nonce: session.nonce, expiresAt: session.expiresAt,
      resource: structuredClone(normalized), hostOrigin, sandboxOrigin, sourceId };
  }

  #assert(session, registered = true) {
    if ((registered && this.#sessions.get(session.sessionId) !== session)
      || session.expiresAt <= this.now()) {
      this.#close(session, "expired");
      fail("MCP_APP_SESSION_EXPIRED");
    }
    let decision;
    try { decision = this.assertAuthority(session.context); }
    catch {
      this.#close(session, "revoked");
      fail("MCP_APP_AUTHORITY_REVOKED");
    }
    if (decision !== true) {
      this.#close(session, "revoked");
      fail("MCP_APP_AUTHORITY_REVOKED");
    }
  }

  #transport(input) {
    if (!exact(input, ["sessionId", "nonce", "sourceId", "origin", "conversationId"])) {
      fail("MCP_APP_TRANSPORT_INVALID");
    }
    const session = this.#sessions.get(input.sessionId);
    if (!session || session.nonce !== input.nonce || session.sourceId !== input.sourceId
      || session.sandboxOrigin !== input.origin || session.context.conversationId !== input.conversationId) {
      fail("MCP_APP_TRANSPORT_INVALID");
    }
    this.#assert(session);
    return session;
  }

  async handle(transport, rawMessage) {
    // origin/sourceId/conversationId are supplied by the trusted Host after
    // checking event.source; never copy them from the App's JSON-RPC params.
    const session = this.#transport(transport);
    const message = jsonCopy(rawMessage, MAX_MESSAGE);
    if (!plain(message) || message.jsonrpc !== "2.0" || !boundedText(message.method, 128)
      || Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) {
      fail("MCP_APP_MESSAGE_INVALID");
    }
    const request = Object.hasOwn(message, "id");
    if (request && !(boundedText(message.id, 96)
      || (Number.isSafeInteger(message.id) && message.id >= 0))) fail("MCP_APP_MESSAGE_INVALID");
    const reply = (result) => request ? { jsonrpc: "2.0", id: message.id, result } : null;
    try {
      if (this.now() - session.windowStart >= 60_000) {
        session.windowStart = this.now(); session.windowMessages = 0;
      }
      if (++session.messages > MAX_MESSAGES || ++session.windowMessages > 100) {
        this.#close(session, "limit"); fail("MCP_APP_LIMIT");
      }
      const key = `${typeof message.id}:${message.id}`;
      if (request) {
        if (session.seen.has(key)) fail("MCP_APP_DUPLICATE_REQUEST");
        session.seen.add(key);
      }
      const params = message.params ?? {};
      if (message.method === "ui/initialize") {
        if (!request || session.state !== "created" || !exact(params,
          ["appInfo", "appCapabilities", "protocolVersion"])
          || !plain(params.appCapabilities) || !exact(params.appInfo, ["name", "version"])
          || !boundedText(params.appInfo.name, 128) || !boundedText(params.appInfo.version, 128)
          || params.protocolVersion !== PROTOCOL_VERSION) fail("MCP_APP_PROTOCOL_INVALID");
        session.state = "initializing";
        return reply({ protocolVersion: PROTOCOL_VERSION, hostInfo: { name: "Shoggoth", version: "1" },
          hostCapabilities: { serverTools: {}, sandbox: { csp: structuredClone(session.resource.policy.csp), permissions: {} } },
          hostContext: { displayMode: "inline", availableDisplayModes: ["inline"], platform: "desktop" } });
      }
      if (message.method === "ui/notifications/initialized") {
        if (request || session.state !== "initializing" || !exact(params, [])) fail("MCP_APP_PROTOCOL_INVALID");
        session.state = "ready"; return null;
      }
      if (session.state !== "ready") fail("MCP_APP_NOT_READY");
      if (message.method === "ping" && request && exact(params, [])) return reply({});
      if (message.method === "notifications/cancelled" && !request) {
        if (!plain(params) || !Object.hasOwn(params, "requestId")
          || Object.keys(params).some((item) => !["requestId", "reason"].includes(item))) {
          fail("MCP_APP_MESSAGE_INVALID");
        }
        session.pending.get(`${typeof params.requestId}:${params.requestId}`)?.abort();
        return null;
      }
      if (message.method !== "tools/call" || !request) fail("MCP_APP_METHOD_UNSUPPORTED");
      if (!plain(params) || !Object.hasOwn(params, "name")
        || Object.keys(params).some((item) => !["name", "arguments"].includes(item))
        || !plain(params.arguments ?? {})) fail("MCP_APP_MESSAGE_INVALID");
      const selected = session.tools.get(params.name);
      if (!selected?.appVisible) fail("MCP_APP_TOOL_FORBIDDEN");
      if (session.pending.size >= MAX_SESSION_PENDING || this.#pending.size >= MAX_PENDING) fail("MCP_APP_LIMIT");
      const controller = new AbortController();
      session.pending.set(key, controller);
      const callId = `app-${crypto.randomUUID()}`;
      this.#pending.set(callId, controller);
      const assertCurrent = () => {
        this.#assert(session);
        if (controller.signal.aborted) fail("MCP_APP_REQUEST_CANCELLED");
      };
      let abortListener;
      const canceled = new Promise((resolve, reject) => {
        abortListener = () => reject(serviceError("MCP_APP_REQUEST_CANCELLED", "MCP App 调用已取消"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      const operation = Promise.resolve().then(() => {
        assertCurrent();
        return this.dispatchCapability({ callId, context: session.context, tool: selected,
          arguments: params.arguments ?? {}, signal: controller.signal, assertCurrent });
      }).finally(() => {
        session.pending.delete(key); this.#pending.delete(callId);
        controller.signal.removeEventListener("abort", abortListener);
      });
      // Cancellation stops App delivery. The Dispatcher still owns the durable
      // receipt for a request already sent; this layer never retries it.
      const result = await Promise.race([operation, canceled]);
      assertCurrent();
      return reply(jsonCopy(result, MAX_RESULT));
    } catch (error) {
      if (!request) throw error;
      return { jsonrpc: "2.0", id: message.id, error: { code: -32000,
        message: "MCP App 请求失败", data: { code: /^MCP_APP_[A-Z_]+$/u.test(error?.code)
          ? error.code : "MCP_APP_DISPATCH_FAILED" } } };
    }
  }

  #close(session, reason) {
    this.#sessions.delete(session.sessionId);
    for (const controller of session.pending.values()) controller.abort();
    return { closed: true, pendingCalls: session.pending.size,
      teardown: { jsonrpc: "2.0", id: `teardown-${crypto.randomUUID()}`,
        method: "ui/resource-teardown", params: { reason } } };
  }

  close(transport) { return this.#close(this.#transport(transport), "closed"); }

  assertCurrent(transport) { this.#transport(transport); return true; }

  revoke(selector) {
    if (!plain(selector) || Object.keys(selector).length === 0
      || Object.keys(selector).some((key) => !["profileId", "conversationId", "runId",
        "connectionId", "installationId"].includes(key)
        || typeof selector[key] !== "string" || !ID.test(selector[key]))) {
      fail("MCP_APP_AUTHORITY_INVALID");
    }
    const closed = [];
    for (const session of this.#sessions.values()) {
      if (Object.entries(selector).every(([key, value]) => session.context[key] === value)) {
        closed.push({ sessionId: session.sessionId, ...this.#close(session, "revoked") });
      }
    }
    return closed;
  }

  sweep() {
    for (const session of this.#sessions.values()) {
      if (session.expiresAt <= this.now()) this.#close(session, "expired");
    }
  }

  clear() { for (const session of this.#sessions.values()) this.#close(session, "closed"); }
}

module.exports = { PluginAppSessionManager, normalizeAppResource,
  MCP_APP_PROTOCOL_VERSION: PROTOCOL_VERSION, MCP_APP_MIME_TYPE: MIME_TYPE };
