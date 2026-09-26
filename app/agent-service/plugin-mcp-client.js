"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
const { serviceError } = require("./security");
const { PluginDataScopeLeaseManager } = require("./plugin-data-scope-lease");
const { pluginToolContractDigest, pluginToolUi } = require("./plugin-tool-contract");

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_HTTP_SSE_BYTES = 1024 * 1024;
const MAX_TOOLS = 256;
const MAX_QUEUED_CALLS = 16;
const DEFAULT_TIMEOUT_MS = 15_000;
const STDIO_EXIT_TIMEOUT_MS = 5_000;
const APP_MIME = "text/html;profile=mcp-app";
const MAX_APP_HTML_BYTES = 192 * 1024;

function fail(code, message) { throw serviceError(code, message); }
function bounded(value, code = "MCP_SERVER_RESPONSE_TOO_LARGE") {
  let json;
  try { json = JSON.stringify(value); } catch { fail("MCP_SERVER_RESPONSE_INVALID", "MCP 消息不是 JSON"); }
  if (typeof json !== "string") fail("MCP_SERVER_RESPONSE_INVALID", "MCP 消息不是 JSON");
  if (Buffer.byteLength(json, "utf8") > MAX_MESSAGE_BYTES) fail(code, "MCP 消息超过容量上限");
  return JSON.parse(json);
}
function endpointOf(value, allowLoopback) {
  let url;
  try { url = new URL(value); } catch { fail("MCP_SERVER_URL_INVALID", "MCP URL 无效"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
    || url.username || url.password || url.hash || !url.pathname.startsWith("/")) {
    fail("MCP_SERVER_URL_INVALID", "MCP 连接仅接受 HTTPS 或明确许可的本地回环地址");
  }
  return url;
}
function outgoingCall(message) {
  const messages = Array.isArray(message) ? message : [message];
  if (messages.length !== 1) fail("CAPABILITY_FORBIDDEN", "批量 MCP 派发未开放");
  return messages[0]?.method === "tools/call" ? messages[0] : null;
}
function outgoingResource(message) {
  return !Array.isArray(message) && message?.method === "resources/read" ? message : null;
}

function appResourceContent(result, uri) {
  const safe = bounded(result);
  if (!Array.isArray(safe.contents) || safe.contents.length !== 1) {
    fail("MCP_APP_RESOURCE_INVALID", "MCP App 资源内容无效");
  }
  const content = safe.contents[0];
  if (content?.uri !== uri || content.mimeType !== APP_MIME
    || (typeof content.text === "string") === (typeof content.blob === "string")) {
    fail("MCP_APP_RESOURCE_INVALID", "MCP App 资源 URI 或 MIME 不匹配");
  }
  let html = content.text;
  if (typeof content.blob === "string") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content.blob)) {
      fail("MCP_APP_RESOURCE_INVALID", "MCP App HTML 编码无效");
    }
    try { html = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(content.blob, "base64")); }
    catch { fail("MCP_APP_RESOURCE_INVALID", "MCP App HTML 编码无效"); }
  }
  if (Buffer.byteLength(html) > MAX_APP_HTML_BYTES) fail("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP App HTML 过大");
  if (!/^\s*<!doctype html[\s>]/iu.test(html) || !/<html[\s>]/iu.test(html)) {
    fail("MCP_APP_RESOURCE_INVALID", "MCP App 需要 HTML 文档");
  }
  return { uri, mimeType: APP_MIME, text: html,
    ...(content._meta?.ui === undefined ? {} : { _meta: { ui: content._meta.ui } }) };
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
function expandStdioTemplate(value, pluginRoot, pluginData) {
  const expanded = value.replaceAll("${PLUGIN_ROOT}", pluginRoot)
    .replaceAll("${PLUGIN_DATA}", pluginData);
  if (expanded.includes("${") || expanded.includes("\0")) {
    fail("MCP_SERVER_START_FAILED", "MCP stdio 含未支持的路径占位符");
  }
  return expanded;
}
function boundedHttpResponse(response) {
  if (!(response instanceof Response)) fail("MCP_SERVER_RESPONSE_INVALID", "MCP HTTP 响应无效");
  const type = response.headers.get("content-type") || "";
  const limit = type.toLowerCase().startsWith("text/event-stream")
    ? MAX_HTTP_SSE_BYTES : MAX_MESSAGE_BYTES;
  const length = response.headers.get("content-length");
  if (length && /^\d+$/u.test(length) && Number(length) > limit) {
    void response.body?.cancel().catch(() => {});
    fail("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP HTTP 响应超过容量上限");
  }
  if (!response.body) return response;
  let bytes = 0;
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) {
        fail("MCP_SERVER_RESPONSE_INVALID", "MCP HTTP 响应帧无效");
      }
      bytes += chunk.byteLength;
      if (bytes > limit) fail("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP HTTP 响应超过容量上限");
      controller.enqueue(chunk);
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText,
    headers: response.headers });
}

function observeStdioExit(transport, lease, onExit, assertDependencyCurrent = null) {
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const markExit = () => {
    if (exited) return;
    exited = true;
    lease.release();
    resolveExit();
  };
  const start = transport.start.bind(transport);
  transport.start = async () => {
    // The SDK installs its onclose callback before start(). Wrap it here so
    // both normal shutdown and a failed handshake retain the child-exit proof.
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      try { sdkOnClose?.(); }
      finally { try { onExit?.(); } finally { markExit(); } }
    };
    try {
      // Re-check a prepared interpreter after all lease/connection waits and
      // immediately before the SDK spawns it. Never await between these steps.
      if (assertDependencyCurrent) {
        const result = assertDependencyCurrent();
        if (result && typeof result.then === "function") fail("DEPENDENCY_CHANGED", "依赖验证必须同步完成");
      }
      await start();
    }
    catch (error) {
      // A spawn error with no PID cannot leave a writer process behind.
      if (transport.pid === null) markExit();
      throw error;
    }
  };
  return { get exited() { return exited; }, exitPromise };
}

async function waitForStdioExit(observation) {
  if (!observation || observation.exited) return;
  let timer;
  try {
    await Promise.race([observation.exitPromise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(serviceError("PLUGIN_DATA_WRITER_ACTIVE",
        "MCP 子进程退出尚未确认，数据 scope 保持占用")), STDIO_EXIT_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

class PluginMcpClient {
  #client;
  #connectionId;
  #principalIdentity;
  #authorizeEgress;
  #timeoutMs;
  #activeCall = null;
  #callReserved = false;
  #callQueue = [];
  #closed = false;
  #transportClosed = false;
  #onDisconnected;
  #stdioExit = null;
  #catalogDirty = false;
  #catalogChangeEpoch = 0;
  #appSupport = false;
  #discoveredTools = new Map();
  #activeResource = null;

  constructor({ transport, connectionId, principalIdentity, authorizeEgress, versionMode,
    timeoutMs = DEFAULT_TIMEOUT_MS, protocol, onToolsChanged = null,
    onDisconnected = null, appSupport = false }) {
    if (typeof connectionId !== "string" || !connectionId || connectionId.length > 128
      || typeof principalIdentity !== "string" || !principalIdentity
      || principalIdentity.length > 1024 || typeof authorizeEgress !== "function"
      || (onToolsChanged !== null && typeof onToolsChanged !== "function")
      || (onDisconnected !== null && typeof onDisconnected !== "function")
      || typeof appSupport !== "boolean"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      fail("CAPABILITY_FORBIDDEN", "MCP 连接缺少身份或派发门禁");
    }
    this.#connectionId = connectionId;
    this.#principalIdentity = principalIdentity;
    this.#authorizeEgress = authorizeEgress;
    this.#onDisconnected = onDisconnected;
    this.#timeoutMs = timeoutMs;
    this.#appSupport = appSupport;
    this.#client = new Client({ name: "shoggoth-plugin-host", version: "1" }, {
      capabilities: appSupport ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [APP_MIME] } } } : {},
      cachePartition: `${connectionId}\0${principalIdentity}`,
      versionNegotiation: { mode: versionMode },
    });
    this.#client.setNotificationHandler("notifications/tools/list_changed", () => {
      this.#catalogChangeEpoch += 1;
      this.#catalogDirty = true;
      try {
        const result = onToolsChanged?.({ connectionId, principalIdentity });
        if (result && typeof result.then === "function") void result.catch(() => {});
      } catch {
        // The local dirty flag still blocks tools/call until a fresh list.
      }
    });
    if (protocol === "stdio") {
      const send = transport.send.bind(transport);
      transport.send = (message, options) => {
        const call = outgoingCall(message);
        if (call) this._admit(call);
        const resource = outgoingResource(message);
        if (resource) this._admitResource(resource);
        return send(message, options);
      };
    }
  }

  static async connectStdio({ command, args = [], cwd, env = {}, connectionId,
    principalIdentity, authorizeEgress, timeoutMs, dataScope, onToolsChanged,
    onDisconnected, pluginRoot = null, appSupport = false, dependencyFingerprint = null,
    assertDependencyCurrent = null }) {
    if ((dependencyFingerprint !== null && (typeof dependencyFingerprint !== "string"
      || !/^[a-f0-9]{64}$/u.test(dependencyFingerprint) || typeof assertDependencyCurrent !== "function"))
      || (assertDependencyCurrent !== null && typeof assertDependencyCurrent !== "function")) {
      fail("DEPENDENCY_CHANGED", "依赖固定信息不完整");
    }
    if (typeof command !== "string" || !path.isAbsolute(command) || !Array.isArray(args)
      || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 4096
        || arg.includes("\0")) || typeof cwd !== "string" || !cwd
      || (pluginRoot === null && !path.isAbsolute(cwd))
      || (pluginRoot !== null && (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot)))
      || !env || typeof env !== "object" || Array.isArray(env)
      || Object.hasOwn(env, "PLUGIN_DATA") || Object.hasOwn(env, "PLUGIN_ROOT")
      || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
        || typeof value !== "string" || value.includes("\0") || value.length > 8192)) {
      fail("MCP_SERVER_START_FAILED", "MCP stdio 启动参数无效");
    }
    if (!(dataScope?.leaseManager instanceof PluginDataScopeLeaseManager)) {
      fail("PLUGIN_DATA_SCOPE_INVALID", "MCP stdio 缺少托管数据 scope");
    }
    try {
      if (!fs.statSync(command).isFile()) {
        fail("DEPENDENCY_MISSING", "MCP stdio 启动依赖尚未准备");
      }
      fs.accessSync(command, fs.constants.X_OK);
    } catch { fail("DEPENDENCY_MISSING", "MCP stdio 启动依赖尚未准备"); }
    const lease = dataScope.leaseManager.acquire({ installationId: dataScope.installationId,
      scopeId: dataScope.scopeId });
    let connection;
    try {
      let root = null;
      if (pluginRoot !== null) {
        try {
          root = fs.realpathSync(pluginRoot);
          if (!fs.statSync(root).isDirectory()) throw new Error("not directory");
        } catch { fail("MCP_SERVER_START_FAILED", "PLUGIN_ROOT 不存在或不是目录"); }
      }
      const effectiveArgs = root === null ? args : args.map((arg) =>
        expandStdioTemplate(arg, root, lease.directory));
      if (effectiveArgs.some((arg) => arg.length > 4096)) {
        fail("MCP_SERVER_START_FAILED", "MCP stdio 展开后的参数过长");
      }
      const effectiveEnv = root === null ? { ...env, PLUGIN_DATA: lease.directory }
        : Object.fromEntries(Object.entries(env).map(([key, value]) => [key,
          expandStdioTemplate(value, root, lease.directory)]));
      if (root !== null) {
        effectiveEnv.PLUGIN_ROOT = root;
        effectiveEnv.PLUGIN_DATA = lease.directory;
      }
      if (Object.values(effectiveEnv).some((value) => value.length > 8192)) {
        fail("MCP_SERVER_START_FAILED", "MCP stdio 展开后的环境变量过长");
      }
      const expandedCwd = root === null ? cwd
        : expandStdioTemplate(cwd, root, lease.directory);
      const effectiveCwd = root !== null && !path.isAbsolute(expandedCwd)
        ? path.resolve(root, expandedCwd) : expandedCwd;
      let realCwd;
      try { realCwd = fs.realpathSync(effectiveCwd); }
      catch { fail("DEPENDENCY_MISSING", "MCP stdio 工作目录尚未准备"); }
      if (root !== null && !inside(root, realCwd)
        && !inside(lease.directory, realCwd)) {
        fail("MCP_SERVER_START_FAILED", "MCP stdio 工作目录越过插件或数据 scope");
      }
      if (!fs.statSync(realCwd).isDirectory()) {
        fail("MCP_SERVER_START_FAILED", "MCP stdio 工作目录不是目录");
      }
      const transport = new StdioClientTransport({ command, args: effectiveArgs, cwd: realCwd,
        env: effectiveEnv, stderr: "pipe",
        maxBufferSize: MAX_MESSAGE_BYTES });
      // Auto negotiation spawns a second disposable stdio process. Keep the
      // single-process handshake until probing is covered by the same lease.
      connection = new PluginMcpClient({ transport, connectionId, principalIdentity,
        authorizeEgress, versionMode: "legacy", timeoutMs, protocol: "stdio",
        onToolsChanged, onDisconnected, appSupport });
      connection.#stdioExit = observeStdioExit(transport, lease,
        () => connection.#notifyDisconnected(), assertDependencyCurrent);
      await connection.#client.connect(transport, { timeout: connection.#timeoutMs });
      return connection;
    } catch (error) {
      if (connection) await connection.close();
      else lease.release();
      throw error;
    }
  }

  static async connectHttp({ url, allowLoopback = false, fetchImpl = globalThis.fetch,
    connectionId, principalIdentity, authRevision = null, credentialProvider = null,
    authorizeEgress, versionMode = "auto", timeoutMs, onToolsChanged,
    onDisconnected, appSupport = false }) {
    const endpoint = endpointOf(url, allowLoopback);
    if (typeof fetchImpl !== "function") fail("MCP_SERVER_URL_INVALID", "MCP HTTP fetch 不可用");
    if (credentialProvider !== null && (typeof credentialProvider !== "function"
      || typeof credentialProvider.assertCurrent !== "function"
      || !Number.isSafeInteger(authRevision) || authRevision < 1)) {
      fail("CONNECTION_AUTH_REQUIRED", "MCP 凭据提供者缺少认证代次");
    }
    const authProvider = credentialProvider === null ? undefined : {
      token: async () => {
        const credential = await credentialProvider();
        if (!credential || credential.principalIdentity !== principalIdentity
          || credential.authRevision !== authRevision) {
          fail("CONNECTION_IDENTITY_CHANGED", "MCP 凭据身份与连接不一致");
        }
        const token = credential.accessToken;
        if (typeof token !== "string" || token.length < 1 || token.length > 16_384
          || !/^[A-Za-z0-9\-._~+/]+=*$/u.test(token)) {
          fail("CONNECTION_AUTH_REQUIRED", "MCP 凭据不可用");
        }
        return token;
      },
    };
    let connection;
    const guardedFetch = (input, init = {}) => {
      const target = new URL(input instanceof URL ? input.href : input.url || input);
      if (target.href !== endpoint.href || target.username || target.password) {
        fail("MCP_SERVER_URL_INVALID", "MCP HTTP 请求越过连接端点");
      }
      if (init.redirect && init.redirect !== "manual") {
        fail("MCP_SERVER_URL_INVALID", "MCP HTTP 不允许自动跟随重定向");
      }
      // The SDK resolved its async token before reaching fetch. Check the
      // current Connection once more in this synchronous final-send turn.
      credentialProvider?.assertCurrent();
      if (String(init.method || "GET").toUpperCase() === "POST") {
        if (typeof init.body !== "string" || Buffer.byteLength(init.body, "utf8") > MAX_MESSAGE_BYTES) {
          fail("MCP_SERVER_REQUEST_TOO_LARGE", "MCP HTTP 请求超过容量上限");
        }
        let message;
        try { message = JSON.parse(init.body); } catch { fail("MCP_SERVER_REQUEST_INVALID", "MCP HTTP 请求无效"); }
        const call = outgoingCall(message);
        if (call) connection._admit(call);
        const resource = outgoingResource(message);
        if (resource) connection._admitResource(resource);
      }
      // authorizeEgress above is synchronous. The fetch starts in the same JS turn;
      // a later revocation cannot slip between the admission check and send start.
      return Promise.resolve(fetchImpl(target, { ...init, redirect: "manual" }))
        .then(boundedHttpResponse);
    };
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: guardedFetch, authProvider, onInsufficientScope: "throw",
    });
    connection = new PluginMcpClient({ transport, connectionId, principalIdentity,
      authorizeEgress, versionMode, timeoutMs, protocol: "http", onToolsChanged,
      onDisconnected, appSupport });
    try {
      await connection.#client.connect(transport, { timeout: connection.#timeoutMs });
      const sdkOnClose = transport.onclose;
      transport.onclose = () => {
        try { sdkOnClose?.(); } finally { connection.#notifyDisconnected(); }
      };
    }
    catch (error) { await connection.close(); throw error; }
    return connection;
  }

  #notifyDisconnected() {
    if (this.#transportClosed) return;
    this.#transportClosed = true;
    this.#catalogDirty = true;
    for (const pending of this.#callQueue.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(serviceError("MCP_SERVER_EXITED", "MCP 连接已关闭"));
    }
    try { this.#onDisconnected?.({ connectionId: this.#connectionId,
      principalIdentity: this.#principalIdentity }); }
    catch { /* The local client remains fenced even if its observer fails. */ }
  }

  _admit(message) {
    if (this.#catalogDirty) fail("TOOL_CONTRACT_CHANGED", "MCP 工具目录等待刷新");
    const active = this.#activeCall;
    if (!active || message.params?.name !== active.name
      || JSON.stringify(message.params?.arguments ?? {}) !== active.argumentsJson) {
      fail("CAPABILITY_FORBIDDEN", "MCP 工具调用缺少匹配的授权上下文");
    }
    const decision = this.#authorizeEgress({ connectionId: this.#connectionId,
      principalIdentity: this.#principalIdentity, toolName: active.name,
      arguments: active.arguments, authority: active.authority });
    if (decision && typeof decision.then === "function") {
      fail("CAPABILITY_FORBIDDEN", "MCP 最终派发门禁必须同步完成");
    }
    if (decision === false) fail("CAPABILITY_FORBIDDEN", "MCP 最终派发被拒绝");
    active.egressed = true;
  }

  #assertResource(input) {
    if (!this.isAlive()) fail("MCP_SERVER_EXITED", "MCP 连接已关闭");
    if (!this.#appSupport || !this.#client.getServerCapabilities()?.resources) {
      fail("MCP_APP_UNSUPPORTED", "MCP App 资源能力未协商");
    }
    const current = this.#discoveredTools.get(input.toolName);
    if (this.#catalogDirty || !current || current.contractDigest !== input.contractDigest
      || current.ui?.resourceUri !== input.resourceUri) {
      fail("MCP_APP_RESOURCE_FORBIDDEN", "资源未绑定当前工具合同");
    }
    const decision = input.assertCurrent();
    if (decision && typeof decision.then === "function") {
      fail("CAPABILITY_FORBIDDEN", "资源授权检查必须同步完成");
    }
    if (decision === false) fail("CAPABILITY_FORBIDDEN", "资源授权已撤销");
  }

  _admitResource(message) {
    const active = this.#activeResource;
    if (!active || message.params?.uri !== active.resourceUri) {
      fail("MCP_APP_RESOURCE_FORBIDDEN", "资源读取缺少受信上下文");
    }
    this.#assertResource(active);
  }

  getProtocol() {
    return { era: this.#client.getProtocolEra(),
      version: this.#client.getNegotiatedProtocolVersion() };
  }

  isAlive() {
    return !this.#closed && !this.#transportClosed && !this.#stdioExit?.exited;
  }

  async listTools() {
    if (this.#closed || this.#transportClosed) fail("MCP_SERVER_EXITED", "MCP 连接已关闭");
    this.#catalogDirty = true;
    this.#discoveredTools.clear();
    const catalogChangeEpoch = this.#catalogChangeEpoch;
    const tools = [];
    const seen = new Set();
    let cursor;
    do {
      const page = await this.#client.listTools(cursor ? { cursor } : undefined,
        { timeout: this.#timeoutMs, cacheMode: "refresh" });
      if (!Array.isArray(page.tools) || tools.length + page.tools.length > MAX_TOOLS
        || (page.nextCursor && (typeof page.nextCursor !== "string" || seen.has(page.nextCursor)))) {
        fail("MCP_SERVER_RESPONSE_INVALID", "MCP 工具清单无效");
      }
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (this.#catalogChangeEpoch !== catalogChangeEpoch) {
      fail("TOOL_CONTRACT_CHANGED", "MCP 工具目录刷新期间变化");
    }
    const safeTools = bounded(tools);
    for (const tool of safeTools) {
      const metadata = pluginToolUi(tool);
      this.#discoveredTools.set(tool.name, { contractDigest: pluginToolContractDigest(tool), ui: metadata.ui });
    }
    this.#catalogDirty = false;
    return safeTools;
  }

  async readAppResource({ toolName, contractDigest, resourceUri, assertCurrent } = {}) {
    if (typeof toolName !== "string" || !toolName || typeof resourceUri !== "string"
      || typeof contractDigest !== "string" || !/^[a-f0-9]{64}$/u.test(contractDigest)
      || typeof assertCurrent !== "function") fail("MCP_APP_RESOURCE_FORBIDDEN", "资源读取参数无效");
    const input = { toolName, contractDigest, resourceUri, assertCurrent };
    this.#assertResource(input);
    await this.#acquireCallTurn();
    try {
      this.#assertResource(input);
      this.#activeResource = input;
      const result = await this.#client.readResource({ uri: resourceUri },
        { timeout: this.#timeoutMs, cacheMode: "bypass" });
      this.#assertResource(input);
      return appResourceContent(result, resourceUri);
    } catch (error) {
      const supported = new Set(["MCP_APP_UNSUPPORTED", "MCP_APP_RESOURCE_FORBIDDEN",
        "MCP_APP_RESOURCE_INVALID", "MCP_SERVER_RESPONSE_TOO_LARGE", "MCP_SERVER_EXITED",
        "CAPABILITY_FORBIDDEN", "GRANT_REVOKED", "CONNECTION_IDENTITY_CHANGED", "TOOL_CONTRACT_CHANGED"]);
      fail(supported.has(error?.code) ? error.code : "MCP_APP_RESOURCE_UNAVAILABLE", "MCP App 资源读取失败");
    } finally {
      this.#activeResource = null;
      this.#releaseCallTurn();
    }
  }

  async callTool(name, args, authority) {
    if (this.#closed || this.#transportClosed) fail("MCP_SERVER_EXITED", "MCP 连接已关闭");
    if (typeof name !== "string" || !name || !args || typeof args !== "object"
      || Array.isArray(args) || !authority) fail("CAPABILITY_FORBIDDEN", "MCP 工具调用参数无效");
    const safeArguments = bounded(args, "MCP_SERVER_REQUEST_TOO_LARGE");
    const argumentsJson = JSON.stringify(safeArguments);
    const safeAuthority = bounded(authority, "MCP_SERVER_REQUEST_TOO_LARGE");
    await this.#acquireCallTurn();
    const active = { name, arguments: safeArguments, argumentsJson,
      authority: safeAuthority, egressed: false };
    try {
      if (this.#closed) fail("MCP_SERVER_EXITED", "MCP 连接已关闭");
      this.#activeCall = active;
      return bounded(await this.#client.callTool({ name, arguments: safeArguments },
        { timeout: this.#timeoutMs }));
    } catch (error) {
      if (active.egressed) fail("CALL_OUTCOME_UNKNOWN", "MCP 请求已发送但结果未能确认");
      throw error;
    } finally {
      this.#activeCall = null;
      this.#releaseCallTurn();
    }
  }

  #acquireCallTurn() {
    if (this.#closed || this.#transportClosed) fail("MCP_SERVER_EXITED", "MCP 连接已关闭");
    if (!this.#callReserved) {
      this.#callReserved = true;
      return Promise.resolve();
    }
    if (this.#callQueue.length >= MAX_QUEUED_CALLS) {
      fail("PLUGIN_CONNECTION_BUSY", "MCP 连接等待队列已满");
    }
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        const index = this.#callQueue.indexOf(pending);
        if (index >= 0) this.#callQueue.splice(index, 1);
        reject(serviceError("PLUGIN_CONNECTION_BUSY", "MCP 连接等待超时"));
      }, this.#timeoutMs);
      this.#callQueue.push(pending);
    });
  }

  #releaseCallTurn() {
    const next = this.#callQueue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else this.#callReserved = false;
  }

  async close() {
    if (this.#closed) {
      await waitForStdioExit(this.#stdioExit);
      return;
    }
    this.#closed = true;
    this.#notifyDisconnected();
    try { await this.#client.close(); }
    finally { await waitForStdioExit(this.#stdioExit); }
  }
}

module.exports = { PluginMcpClient, endpointOf };
