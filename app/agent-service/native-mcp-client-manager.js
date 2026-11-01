"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { Client, StreamableHTTPClientTransport, SSEClientTransport, UnsupportedProtocolVersionError } = require("@modelcontextprotocol/client");
const { endpointOf, boundedHttpResponse, validatedHeaders, validatedQueryCredentials } = require("./mcp-transport-utils");
const { serviceError, ensurePrivateDirectoryTree } = require("./security");
const { officialSkillBridgeEnvironment, validateOfficialSkillBridgeCredentials } = require("./official-skill-mcp-launch");
const { OFFICIAL_SKILL_PUBLIC_MESSAGES } = require("../core/official-skill-connector-dto");
const { ticketmasterBridgeEnvironment, validateTicketmasterBridgeCredentials } = require("./ticketmaster-mcp-launch");
const { flightawareBridgeEnvironment, validateFlightawareBridgeCredentials } = require("./flightaware-mcp-launch");
// The SDK requires a finite response timer. Progress renews this idle window;
// there is no maximum total duration. Cancellation still uses the owning signal.
const MCP_PROGRESS_IDLE_TIMEOUT_MS = 60 * 60_000;

const PROTOCOL_VERSION = "2024-11-05";
// This revision is supported by the bundled SDK's explicit negotiation mode.
// Keep legacy servers on their existing handshake unless the peer rejects it.
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const START_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOOLS = 256;
const OFFICIAL_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function clientError(code, message) { return serviceError(code, message); }
function safeEnvironment(source = process.env) {
  const result = {};
  for (const key of [
    "HOME", "LANG", "LC_ALL", "LC_CTYPE", "NO_PROXY", "PATH", "SSL_CERT_DIR",
    "SSL_CERT_FILE", "TMPDIR", "http_proxy", "https_proxy", "no_proxy",
    "HTTP_PROXY", "HTTPS_PROXY",
  ]) {
    if (typeof source[key] === "string" && !source[key].includes("\0")) result[key] = source[key];
  }
  return result;
}
function withChromeBrowserProfile(spec, paths) {
  const transport = spec.transport;
  if (transport?.kind !== "stdio-package" || transport.registryType !== "npm"
    || transport.identifier !== "chrome-devtools-mcp") return transport;
  const args = transport.packageArgs || [];
  // An explicit profile, connection, temporary mode or Chrome configuration
  // belongs to the user. Only supply the managed connector's default profile.
  if (args.some(arg => /^(?:--(?:isolated|user-data-dir|userDataDir|auto-connect|autoConnect|browser-url|browserUrl|ws-endpoint|wsEndpoint|config|channel|executable-path|executablePath|chrome-arg|chromeArg|ignore-default-chrome-arg|ignoreDefaultChromeArg)(?:=|$)|-[uew])/u.test(arg))) return transport;
  if (!paths?.userDataRoot || !path.isAbsolute(paths.userDataRoot) || !paths.trustedRoot
    || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(spec.id)) {
    throw clientError("MCP_SERVER_PATH_INVALID", "MCP 浏览器资料目录无效");
  }
  // Browser credentials are durable local data, outside disposable caches and
  // the authority backup/restore payload (which resets connector authorization).
  const profile = path.join(paths.userDataRoot, "mcp-browser-profiles", spec.id);
  ensurePrivateDirectoryTree(profile, paths.trustedRoot);
  return { ...transport, packageArgs: [...args, `--user-data-dir=${profile}`,
    "--isolated=false", "--chrome-arg=--restore-last-session"] };
}
function boundedJson(value) {
  let text;
  try { text = JSON.stringify(value); } catch {
    throw clientError("MCP_SERVER_RESPONSE_INVALID", "MCP Server 返回了无效 JSON");
  }
  if (typeof text !== "string") throw clientError("MCP_SERVER_RESPONSE_INVALID", "MCP Server 返回了无效 JSON");
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw clientError("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP Server 响应超过容量上限");
  }
  return JSON.parse(text);
}

class StdioMcpClient {
  constructor(spec, options = {}) {
    this.spec = spec;
    this.spawn = options.spawn || spawn;
    this.env = options.env || process.env;
    this.secretEnv = options.secretEnv || {};
    this.trustedEnv = options.trustedEnv || {};
    this.trustedOfficialBridge = options.trustedOfficialBridge === true;
    this.trustedTicketmasterBridge = options.trustedTicketmasterBridge === true;
    this.trustedFlightawareBridge = options.trustedFlightawareBridge === true;
    this.timeoutMs = options.readinessTimeoutMs || START_TIMEOUT_MS;
    this.child = null;
    this.exitPromise = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.closed = false;
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }
  async _start() {
    if (this.closed) throw clientError("MCP_SERVER_EXITED", "MCP 连接已关闭");
    try {
      this.child = this.spawn(this.spec.command, [...this.spec.args], {
        cwd: this.spec.cwd,
        env: { ...safeEnvironment(this.env), ...this.secretEnv, ...this.trustedEnv },
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw clientError("MCP_SERVER_START_FAILED", "MCP Server 无法启动");
    }
    this.exitPromise = new Promise(resolve => { this.child.once("exit", resolve); this.child.once("error", resolve); });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._consume(chunk));
    this.child.stderr?.resume();
    this.child.on("error", () => this._failAll("MCP_SERVER_START_FAILED", "MCP Server 启动失败"));
    this.child.on("exit", () => this._failAll("MCP_SERVER_EXITED", "MCP Server 已退出"));
    const initialized = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "shoggoth-extension-host", version: "1" },
    }, this.timeoutMs, true);
    if (!initialized || typeof initialized !== "object" || Array.isArray(initialized)
      || typeof initialized.protocolVersion !== "string") {
      throw clientError("MCP_SERVER_RESPONSE_INVALID", "MCP Server 初始化响应无效");
    }
    this.notify("notifications/initialized", {});
    return this;
  }
  _consume(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_STDOUT_BYTES) {
      this._failAll("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP Server 输出超过容量上限");
      void this.close();
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this._failAll("MCP_SERVER_RESPONSE_INVALID", "MCP Server 输出不是 JSON-RPC");
        void this.close();
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
        this._failAll("MCP_SERVER_RESPONSE_INVALID", "MCP Server 输出不是 JSON-RPC 消息"); void this.close(); return;
      }
      if (Object.hasOwn(message, "id") && Object.hasOwn(message, "method")) {
        this._write({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Client method not supported" } });
        continue;
      }
      if (!Object.hasOwn(message, "id")) continue;
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        // Only our validated bridge can report this private runtime condition.
        // A peer-controlled message never upgrades another MCP server's error.
        const trustedBusinessError = this.trustedOfficialBridge && pending.method === "tools/call" && message.error.code === -32000;
        const officialCode = trustedBusinessError && typeof message.error.message === "string"
          && Object.hasOwn(OFFICIAL_SKILL_PUBLIC_MESSAGES, message.error.message) ? message.error.message : null;
        if (trustedBusinessError && message.error.message === "OFFICIAL_SKILL_OPERATION_UNCERTAIN") {
          pending.reject(clientError("MCP_SERVER_RESULT_UNKNOWN", "MCP 调用结果未知，请先在服务商应用核实，未自动重发"));
        } else if (officialCode && pending.officialAccountCall) {
          // The account controller consumes official DTO codes. Business-tool
          // aliases such as MCP_AUTH_REQUIRED would erase the provider's cause.
          pending.reject(clientError(officialCode, OFFICIAL_SKILL_PUBLIC_MESSAGES[officialCode]));
        } else if (trustedBusinessError && message.error.message === "OFFICIAL_SKILL_AUTH_REQUIRED") {
          pending.reject(clientError("MCP_AUTH_REQUIRED", "请先在 Shopify 连接器中连接个人 Shop 账号"));
        } else if (trustedBusinessError && message.error.message === "OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED") {
          pending.reject(clientError("MCP_AUTH_REQUIRED", "请先在 DoorDash 连接器中授权个人账号"));
        } else if (trustedBusinessError && message.error.message === "OFFICIAL_SKILL_APPROVAL_REQUIRED") {
          pending.reject(clientError("MCP_CONNECTOR_NOT_READY", "DoorDash 尚未允许此账号使用当前功能，请在连接器中核对使用资格或功能权限"));
        } else if (trustedBusinessError && message.error.message === "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED") {
          pending.reject(clientError("MCP_SERVER_REQUEST_INVALID", "订单需要重新预览并确认，或在官方结账页面完成"));
        } else if (trustedBusinessError && message.error.message === "OFFICIAL_SKILL_SESSION_REQUIRED") {
          pending.reject(clientError("OFFICIAL_SKILL_SESSION_REQUIRED", "支付需要有效的当前会话，请从助理会话重新发起"));
        } else if (officialCode) {
          pending.reject(clientError(officialCode, OFFICIAL_SKILL_PUBLIC_MESSAGES[officialCode]));
        } else if (this.trustedTicketmasterBridge && pending.method === "tools/list" && message.error.code === -32001
          && ["MCP_AUTH_REQUIRED", "TICKETMASTER_PYTHON_REQUIRED", "TICKETMASTER_RATE_LIMITED", "MCP_SERVER_CONNECTION_FAILED", "MCP_SERVER_RESPONSE_INVALID", "MCP_SERVER_RESPONSE_TOO_LARGE", "MCP_SERVER_TIMEOUT"].includes(message.error.message)) {
          pending.reject(clientError(message.error.message, message.error.message));
        } else if (this.trustedFlightawareBridge && pending.method === "tools/list" && message.error.code === -32001
          && ["MCP_AUTH_REQUIRED", "FLIGHTAWARE_PYTHON_REQUIRED", "FLIGHTAWARE_RATE_LIMITED", "FLIGHTAWARE_PLAN_REQUIRED", "MCP_SERVER_CONNECTION_FAILED", "MCP_SERVER_RESPONSE_INVALID", "MCP_SERVER_RESPONSE_TOO_LARGE", "MCP_SERVER_TIMEOUT"].includes(message.error.message)) {
          pending.reject(clientError(message.error.message, message.error.message));
        } else pending.reject(clientError("MCP_SERVER_CALL_FAILED", "MCP Server 调用失败"));
      }
      else { try { pending.resolve(boundedJson(message.result)); } catch (error) { pending.reject(error); } }
    }
  }
  _write(message) {
    if (this.closed || !this.child?.stdin?.writable) {
      throw clientError("MCP_SERVER_EXITED", "MCP Server 已退出");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params, timeoutMs = CALL_TIMEOUT_MS, duringStart = false, signal = null) {
    if (signal?.aborted) return Promise.reject(clientError("MCP_SERVER_CALL_FAILED", "MCP 调用已取消，未派发"));
    if (this.closed) return Promise.reject(clientError("MCP_SERVER_EXITED", "MCP Server 已退出"));
    if (!duringStart && !this.ready) return Promise.reject(clientError("MCP_SERVER_START_FAILED", "MCP Server 尚未启动"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(result);
      };
      const onAbort = () => {
        if (!this.pending.delete(String(id))) return;
        try { this.notify("notifications/cancelled", { requestId: id }); } catch {}
        finish(clientError("MCP_SERVER_RESULT_UNKNOWN", "MCP 调用已取消，需核实已派发操作的结果，未自动重发"));
      };
      if (timeoutMs !== null) timer = setTimeout(() => {
        this.pending.delete(String(id));
        finish(clientError("MCP_SERVER_TIMEOUT", "MCP Server 调用超时"));
        void this.close();
      }, timeoutMs);
      timer?.unref?.();
      this.pending.set(String(id), { method,
        officialAccountCall: method === "tools/call" && ["account_start", "account_status", "account_bind", "account_logout"].includes(params?.name),
        resolve: result => finish(null, result), reject: error => finish(error), timer });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      try { this._write({ jsonrpc: "2.0", id, method, params }); } catch (error) {
        this.pending.delete(String(id));
        finish(error);
      }
    });
  }
  notify(method, params) { this._write({ jsonrpc: "2.0", method, params }); }
  _failAll(code, message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(clientError(code, message));
    }
    this.pending.clear();
  }
  async listTools() {
    await this.start();
    const tools = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const result = await this.request("tools/list", cursor === null ? {} : { cursor }, this.timeoutMs);
      if (!result || typeof result !== "object" || Array.isArray(result)
        || !Array.isArray(result.tools) || tools.length + result.tools.length > MAX_TOOLS
        || (result.nextCursor !== undefined && result.nextCursor !== null
          && (typeof result.nextCursor !== "string" || !result.nextCursor
            || Buffer.byteLength(result.nextCursor, "utf8") > 1024
            || cursors.has(result.nextCursor)))) {
        throw clientError("MCP_SERVER_RESPONSE_INVALID", "MCP Server 工具清单无效");
      }
      tools.push(...result.tools);
      cursor = result.nextCursor ?? null;
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    return boundedJson(tools);
  }
  async callTool(name, args, { assertCurrent, signal, officialSessionId } = {}) {
    await this.start();
    assertCurrent?.();
    const params = { name, arguments: args };
    // This option comes from the owning execution scope, never tool arguments.
    // Keep it private to the validated official bridge; other peers do not get it.
    if (this.trustedOfficialBridge && typeof officialSessionId === "string" && OFFICIAL_SESSION_UUID.test(officialSessionId)) {
      params._meta = { "shoggoth/official-session-id": officialSessionId };
    }
    try { return boundedJson(await this.request("tools/call", params, null, false, signal)); }
    catch (error) { if (["MCP_SERVER_TIMEOUT", "MCP_SERVER_EXITED"].includes(error?.code)) throw clientError("MCP_SERVER_RESULT_UNKNOWN", "MCP 调用结果未知，未自动重发"); throw error; }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this._failAll("MCP_SERVER_EXITED", "MCP Server 已关闭");
    this.closePromise = (async () => {
      if (!this.child || this.child.exitCode !== null) return;
      const kill = signal => {
        if (process.platform !== "win32" && Number.isSafeInteger(this.child.pid)) {
          try { process.kill(-this.child.pid, signal); return; } catch {}
        }
        try { this.child.kill(signal); } catch {}
      };
      kill("SIGTERM");
      let timer;
      try { await Promise.race([this.exitPromise, new Promise(resolve => { timer = setTimeout(() => { kill("SIGKILL"); resolve(); }, 1000); })]); }
      finally { clearTimeout(timer); }
      // Reap descendants even if the group leader exited first.
      if (process.platform !== "win32" && Number.isSafeInteger(this.child.pid)) {
        try { process.kill(-this.child.pid, "SIGKILL"); } catch {}
      }
      if (this.child.exitCode === null && this.exitPromise) {
        let reapTimer;
        try { await Promise.race([this.exitPromise, new Promise((_, reject) => { reapTimer = setTimeout(() => reject(clientError("MCP_SERVER_STOP_UNCONFIRMED", "MCP 子进程退出尚未确认")), 3000); })]); }
        finally { clearTimeout(reapTimer); }
      }
    })();
    try { return await this.closePromise; } catch(error) { this.closePromise=null; throw error; }
  }
}

function innerError(error) {
  for (let value = error, n = 0; value && n < 8; value = value.cause, n += 1) {
    if (typeof value.code === "string" && value.code.startsWith("MCP_")) return value;
  }
  return null;
}
function supportsModernHandshake(error) {
  for (let value = error, n = 0; value && n < 8; value = value.cause, n += 1) {
    if (value instanceof UnsupportedProtocolVersionError && Array.isArray(value.supported)
      && value.supported.every(version => typeof version === "string")
      && value.supported.includes(MODERN_PROTOCOL_VERSION)) return true;
  }
  return false;
}
function sensitiveStrings(spec, ...envelopes) {
  const classification = require("./credential-classification").classificationFor(spec);
  const { mcpEnvelopeSensitiveValues } = require("./encrypted-secret-store");
  return [...new Set(envelopes.filter(Boolean).flatMap(envelope =>
    mcpEnvelopeSensitiveValues(Buffer.from(JSON.stringify(envelope)), classification)))]
    .sort((left, right) => right.length - left.length);
}
function scrub(value, spec, ...envelopes) {
  const strings = sensitiveStrings(spec, ...envelopes);
  // Replace in one pass so a short secret cannot rewrite a redaction marker
  // produced while masking another value.
  const pattern = strings.length ? new RegExp(strings.map(text => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu") : null;
  const visit = item => {
    if (typeof item === "string") return pattern ? item.replace(pattern, "[REDACTED]") : item;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [visit(key), visit(entry)]));
    return item;
  };
  return visit(value);
}
class RemoteMcpClient {
  constructor(spec, options = {}) {
    this.spec = spec; this.endpoint = endpointOf(spec.transport.url); this.protocol = spec.transport.protocol;
    this.fetch = options.fetch || require("./mcp-http-fetch").getMcpFetch(); this.headers = validatedHeaders(options.headers || {});
    this.query = validatedQueryCredentials(spec.transport, options.query);
    this.oauth = options.oauth; this.timeoutMs = options.readinessTimeoutMs || START_TIMEOUT_MS;
    this.client = null; this.transport = null; this.ready = null; this.closed = false; this.activeCall = null;
    this.queue = Promise.resolve();
  }
  start() { if (!this.ready) this.ready = this._start(); return this.ready; }
  async _fetch(input, init = {}, retried = false) {
    const target = endpointOf(input instanceof URL ? input.href : input.url || input);
    const sse = this.currentProtocol === "sse";
    if (target.origin !== this.endpoint.origin || ((!sse || Object.keys(this.query).length) && target.href !== this.endpoint.href)) throw clientError("MCP_SERVER_URL_INVALID", "MCP HTTP 请求越过连接端点");
    const method = String(init.method || "GET").toUpperCase();
    let message;
    if (method === "POST") {
      if (typeof init.body !== "string" || Buffer.byteLength(init.body) > MAX_RESPONSE_BYTES) throw clientError("MCP_SERVER_REQUEST_INVALID", "MCP 请求无效或过大");
      try { message = JSON.parse(init.body); } catch { throw clientError("MCP_SERVER_REQUEST_INVALID", "MCP 请求不是 JSON"); }
      if (Array.isArray(message)) throw clientError("MCP_SERVER_REQUEST_INVALID", "MCP 批量派发未开放");
    }
    const business = message?.method === "tools/call";
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(this.headers)) headers.set(key, value);
    if (["oauth-dcr", "oauth-client"].includes(this.spec.auth?.kind)) {
      if (!this.oauth) throw clientError("MCP_AUTH_REQUIRED", "MCP 连接需要登录");
      for (const [key, value] of Object.entries(await this.oauth.authorization(this.spec.id))) headers.set(key, value);
    }
    if (business) {
      if (!this.activeCall || this.activeCall.sent || message.params?.name !== this.activeCall.name || JSON.stringify(message.params?.arguments || {}) !== this.activeCall.args) throw clientError("MCP_SERVER_RESULT_UNKNOWN", "MCP 调用没有可重放的派发凭证");
      this.activeCall.assertCurrent?.(); this.activeCall.sent = true;
    }
    let response;
    try {
      for (const [key, value] of Object.entries(this.query)) target.searchParams.set(key, value);
      response = await this.fetch(target, { ...init, headers, redirect: "manual" });
    } catch { throw clientError(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_CONNECTION_FAILED", business ? "MCP 调用结果未知，未自动重发" : "MCP 连接失败"); }
    if (method === "POST" && !this.firstPostObserved) { this.firstPostObserved = true; this.firstPostStatus = response.status; }
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw clientError(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_URL_INVALID", "MCP HTTP 重定向已拒绝"); }
    // A gateway may refuse the client or network without offering authorization.
    // Do not turn that refusal into an inferred OAuth connection or discard its
    // credentials. An already dispatched business call still must not be replayed.
    if (response.status === 403 && !response.headers.get("www-authenticate")?.trim()) {
      void response.body?.cancel().catch(() => {});
      throw clientError(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_ACCESS_DENIED", business ? "MCP 调用结果未知，未自动重发" : "MCP 服务拒绝此连接（HTTP 403），请向服务方确认客户端准入或访问限制");
    }
    if (response.status === 401 || response.status === 403) {
      await this.oauth?.noteUnauthorized?.(this.spec.id, response);
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 && this.oauth && ["oauth-dcr", "oauth-client"].includes(this.spec.auth?.kind)) {
        try {
          await this.oauth.authorization(this.spec.id, { forceRefresh: true });
          // Only read-only negotiation/listing can be replayed. A tools/call is never sent twice.
          if (!business && !retried && (!message || ["initialize", "server/discover", "tools/list"].includes(message.method))) return this._fetch(input, init, true);
        } catch {}
      }
      throw clientError(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_AUTH_REQUIRED", business ? "MCP 调用结果未知，未自动重发" : "MCP 连接需要重新登录或更新凭据");
    }
    return boundedHttpResponse(response);
  }
  async _connect(protocol, negotiationMode = "legacy") {
    if (this.closed) throw clientError("MCP_SERVER_EXITED", "MCP 连接已关闭");
    this.currentProtocol = protocol;
    this.client = new Client({ name: "shoggoth-mcp-connectors", version: "1" }, { capabilities: {}, inputRequired: { autoFulfill: false }, versionNegotiation: { mode: negotiationMode } });
    const config = { fetch: this._fetch.bind(this), onInsufficientScope: "throw", reconnectionOptions: { maxRetries: 0 } };
    this.transport = protocol === "sse" ? new SSEClientTransport(this.endpoint, config) : new StreamableHTTPClientTransport(this.endpoint, config);
    await this.client.connect(this.transport, { timeout: this.timeoutMs });
    if (this.closed) { await this.client.close(); throw clientError("MCP_SERVER_EXITED", "MCP 连接已关闭"); }
  }
  async _start() {
    try { await this._connect(this.protocol); }
    catch (error) {
      await this.client?.close().catch(() => {});
      if (supportsModernHandshake(error)) {
        // Only continue a rejected handshake, once. Never retry a business call
        // or guess a newer revision when the peer did not explicitly offer it.
        try { await this._connect(this.protocol, { pin: MODERN_PROTOCOL_VERSION }); }
        catch (modernError) { await this.client?.close().catch(() => {}); throw innerError(modernError) || clientError("MCP_SERVER_CONNECTION_FAILED", "MCP 远程连接失败"); }
      } else if (!Object.keys(this.query).length && this.protocol === "streamable-http" && [400, 404, 405].includes(this.firstPostStatus) && !innerError(error)) {
        try { await this._connect("sse"); } catch (fallbackError) { await this.client?.close().catch(() => {}); throw innerError(fallbackError) || clientError("MCP_SERVER_CONNECTION_FAILED", "MCP 远程连接失败"); }
      } else throw innerError(error) || clientError("MCP_SERVER_CONNECTION_FAILED", "MCP 远程连接失败");
    }
    return this;
  }
  async listTools() {
    await this.start();
    const tools = []; const seen = new Set(); let cursor;
    do {
      let result;
      try { result = await this.client.listTools(cursor ? { cursor } : {}, { timeout: this.timeoutMs }); }
      catch (error) { throw innerError(error) || clientError("MCP_SERVER_CALL_FAILED", "MCP 工具清单读取失败"); }
      if (!Array.isArray(result?.tools) || tools.length + result.tools.length > MAX_TOOLS || (result.nextCursor !== undefined && result.nextCursor !== null && (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 1024 || seen.has(result.nextCursor)))) throw clientError("MCP_SERVER_RESPONSE_INVALID", "MCP 工具清单无效");
      tools.push(...result.tools); cursor = result.nextCursor; if (cursor) seen.add(cursor);
    } while (cursor);
    return boundedJson(tools);
  }
  callTool(name, args, { assertCurrent, signal } = {}) {
    const run = async () => {
      await this.start(); assertCurrent?.();
      this.activeCall = { name, args: JSON.stringify(args || {}), assertCurrent, sent: false };
      try { return boundedJson(await this.client.callTool({ name, arguments: args }, { signal, timeout: MCP_PROGRESS_IDLE_TIMEOUT_MS,
        resetTimeoutOnProgress: true, onprogress: () => {} })); }
      catch (error) { throw innerError(error) || clientError(this.activeCall.sent ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_CALL_FAILED", this.activeCall.sent ? "MCP 调用结果未知，未自动重发" : "MCP 调用失败"); }
      finally { this.activeCall = null; }
    };
    const result = this.queue.then(run, run); this.queue = result.catch(() => {}); return result;
  }
  async close() { this.closed = true; await this.client?.close().catch(() => {}); }
}
class NativeMcpClientManager {
  constructor(options = {}) {
    if (!options.store || typeof options.store.get !== "function") throw new TypeError("NativeMcpClientManager 需要 NativeMcpStore");
    this.store = options.store; this.spawn = options.spawn || spawn; this.env = options.env || process.env;
    this.secrets = options.secrets || null; this.packageLauncher = options.packageLauncher || null;
    this.oauth = options.oauth || null; this.fetch = options.fetch || require("./mcp-http-fetch").getMcpFetch();
    this.readinessTimeoutMs = options.readinessTimeoutMs || START_TIMEOUT_MS;
    this.clients = new Map(); this.closed = false;
  }
  open() { if(this.clients.size) throw clientError("MCP_SERVER_STOP_UNCONFIRMED", "MCP 子进程退出尚未确认"); this.closed=false; return this; }
  setOAuth(oauth) { this.oauth = oauth; }
  _signature(spec) { return JSON.stringify([spec.transport || [spec.command, spec.args, spec.cwd], spec.auth, spec.secretRef, spec.enabled, spec.updatedAt]); }
  async _create(spec) {
    if (typeof this.store.prepareLaunch === "function") this.store.prepareLaunch(spec);
    let secret = {};
    if (this.secrets && spec.secretRef) { secret = await this.secrets.get(spec.secretRef); if (!secret) throw clientError("MCP_CREDENTIALS_LOCKED", "MCP 加密凭据缺失，请重新填写"); }
    validateOfficialSkillBridgeCredentials(spec.transport, secret, { paths: this.store.paths });
    validateTicketmasterBridgeCredentials(spec.transport, secret);
    validateFlightawareBridgeCredentials(spec.transport, secret);
    validatedQueryCredentials(spec.transport, secret.query);
    let client;
    if (spec.transport?.kind === "remote") client = new RemoteMcpClient(spec, { fetch: this.fetch, headers: secret.headers, query: secret.query, oauth: this.oauth, readinessTimeoutMs: this.readinessTimeoutMs });
    else {
      let launch = spec.transport?.kind === "stdio-command" ? spec.transport : spec;
      if (spec.transport?.kind === "stdio-package") {
        if (!this.packageLauncher) throw clientError("MCP_PACKAGE_RUNTIME_MISSING", "MCP 包运行时不可用");
        launch = await this.packageLauncher.prepare(withChromeBrowserProfile(spec, this.store.paths), { env: { ...safeEnvironment(this.env), ...(secret.env || {}) } });
      }
      const env = secret.env || {};
      if (Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0") || value.length > 16384)) throw clientError("MCP_SECRET_INVALID", "MCP 环境变量无效");
      const values = sensitiveStrings(spec, secret);
      if ((launch.args || []).some(arg => values.some(value => arg.includes(value)))) throw clientError("MCP_SECRET_INVALID", "MCP 密钥不能出现在进程参数中");
      const officialEnv = officialSkillBridgeEnvironment(launch.command, launch.args, { paths: this.store.paths });
      const ticketmasterEnv = ticketmasterBridgeEnvironment(launch.command, launch.args);
      const flightawareEnv = flightawareBridgeEnvironment(launch.command, launch.args);
      client = new StdioMcpClient({ ...launch, args: launch.args || [] }, { spawn: this.spawn, env: this.env, secretEnv: env, trustedEnv: { ...officialEnv, ...ticketmasterEnv, ...flightawareEnv },
        trustedOfficialBridge: officialEnv.ELECTRON_RUN_AS_NODE === "1", trustedTicketmasterBridge: ticketmasterEnv.ELECTRON_RUN_AS_NODE === "1", trustedFlightawareBridge: flightawareEnv.ELECTRON_RUN_AS_NODE === "1", readinessTimeoutMs: this.readinessTimeoutMs });
    }
    client.secretValues = secret; return client;
  }
  async _clientFor(id) {
    if (this.closed) throw clientError("MCP_REGISTRY_CLOSED", "MCP 客户端管理器已关闭");
    const spec = this.store.getPrivate?.(id) ?? this.store.get(id);
    if (!spec || !spec.enabled) throw clientError("MCP_SERVER_NOT_FOUND", "MCP Server 不存在或未启用");
    const signature = this._signature(spec); const existing = this.clients.get(id);
    if (existing?.signature === signature) return existing.promise;
    if (existing) await existing.promise.then(client => client.close());
    const promise = this._create(spec); this.clients.set(id, { signature, promise });
    try { return await promise; } catch (error) { if (this.clients.get(id)?.promise === promise) this.clients.delete(id); throw error; }
  }
  async _readiness(client) {
    let timer;
    try { return await Promise.race([client.listTools(), new Promise((_, reject) => { timer = setTimeout(() => reject(clientError("MCP_SERVER_TIMEOUT", "MCP 就绪检查超时")), this.readinessTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async _currentSecrets(spec) {
    const current = (spec?.id && (this.store.getPrivate?.(spec.id) ?? this.store.get(spec.id))) || spec;
    return this.secrets && current?.secretRef ? this.secrets.get(current.secretRef) : null;
  }
  async probe(spec) {
    const client = await this._create(spec);
    try { const result = await this._readiness(client); return scrub(result, spec, client.secretValues, await this._currentSecrets(spec)); }
    finally { await client.close(); }
  }
  async _use(id, action, { localResult = false, onResultSecrets = null } = {}) {
    const client = await this._clientFor(id);
    const initialSpec = this.store.getPrivate?.(id) ?? this.store.get(id);
    const initialSecrets = onResultSecrets ? await this._currentSecrets(initialSpec) : null;
    try {
      const result = await action(client);
      const spec = this.store.getPrivate?.(id) ?? this.store.get(id);
      // The endpoint has returned a definitive result. A concurrent credential
      // rotation/read failure must not erase that execution fact. The caller
      // can withhold only its model copy until matching becomes available.
      let currentSecrets;
      try { currentSecrets = await this._currentSecrets(spec); }
      catch (error) { if (!localResult) throw error; onResultSecrets?.(null); return result; }
      if (onResultSecrets) {
        const { mcpEnvelopeSensitiveValues } = require("./encrypted-secret-store");
        const classification = require("./credential-classification").classificationFor(initialSpec);
        onResultSecrets([client.secretValues, initialSecrets, currentSecrets].filter(Boolean)
          .flatMap(envelope => mcpEnvelopeSensitiveValues(Buffer.from(JSON.stringify(envelope)), classification)));
      }
      if (localResult) return result;
      return scrub(result, spec, client.secretValues, currentSecrets);
    }
    catch (error) {
      const record = this.clients.get(id);
      const existing = record ? await record.promise.catch(() => null) : null;
      try { await client.close(); if(existing===client)this.clients.delete(id); }
      catch(stopError) { if(record&&existing===client)this.clients.set(id,record); throw stopError; }
      throw error;
    }
  }
  async listTools(id) { return this._use(id, client => this._readiness(client)); }
  async callTool(id, name, args, options) { return this._use(id, client => client.callTool(name, args, options),
    { localResult: options?.localResult === true, onResultSecrets: options?.onResultSecrets }); }
  async closeServer(id) { const entry = this.clients.get(id); if (entry) { await entry.promise.then(client => client.close()); if(this.clients.get(id)===entry)this.clients.delete(id); } }
  async close() {
    this.closed = true; const entries = [...this.clients.entries()];
    const results=await Promise.allSettled(entries.map(async ([id,entry])=>{await entry.promise.then(client=>client.close());if(this.clients.get(id)===entry)this.clients.delete(id);}));
    const failed=results.find(result=>result.status==="rejected");if(failed)throw failed.reason;
  }
}
module.exports = { NativeMcpClientManager, StdioMcpClient, RemoteMcpClient, safeEnvironment };
