"use strict";

const { spawn } = require("node:child_process");
const { serviceError } = require("./security");

const PROTOCOL_VERSION = "2024-11-05";
const START_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOOLS = 256;

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
function boundedJson(value) {
  let text;
  try { text = JSON.stringify(value); } catch {
    throw clientError("MCP_SERVER_RESPONSE_INVALID", "MCP Server 返回了无效 JSON");
  }
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
    this.child = null;
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
    try {
      this.child = this.spawn(this.spec.command, [...this.spec.args], {
        cwd: this.spec.cwd,
        env: safeEnvironment(this.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw clientError("MCP_SERVER_START_FAILED", "MCP Server 无法启动");
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._consume(chunk));
    this.child.stderr?.resume();
    this.child.on("error", () => this._failAll("MCP_SERVER_START_FAILED", "MCP Server 启动失败"));
    this.child.on("exit", () => this._failAll("MCP_SERVER_EXITED", "MCP Server 已退出"));
    const initialized = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "shoggoth-extension-host", version: "1" },
    }, START_TIMEOUT_MS, true);
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
      if (message.error) pending.reject(clientError("MCP_SERVER_CALL_FAILED", "MCP Server 调用失败"));
      else pending.resolve(boundedJson(message.result));
    }
  }
  _write(message) {
    if (this.closed || !this.child?.stdin?.writable) {
      throw clientError("MCP_SERVER_EXITED", "MCP Server 已退出");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params, timeoutMs = CALL_TIMEOUT_MS, duringStart = false) {
    if (this.closed) return Promise.reject(clientError("MCP_SERVER_EXITED", "MCP Server 已退出"));
    if (!duringStart && !this.ready) return Promise.reject(clientError("MCP_SERVER_START_FAILED", "MCP Server 尚未启动"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(clientError("MCP_SERVER_TIMEOUT", "MCP Server 调用超时"));
        void this.close();
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(String(id), { resolve, reject, timer });
      try { this._write({ jsonrpc: "2.0", id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
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
      const result = await this.request("tools/list", cursor === null ? {} : { cursor });
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
  async callTool(name, args) {
    await this.start();
    return boundedJson(await this.request("tools/call", { name, arguments: args }));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this._failAll("MCP_SERVER_EXITED", "MCP Server 已关闭");
    if (!this.child || this.child.exitCode !== null) return;
    try { this.child.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { this.child?.kill("SIGKILL"); } catch {} }, 1000);
    timer.unref?.();
  }
}

class NativeMcpClientManager {
  constructor(options = {}) {
    if (!options.store || typeof options.store.get !== "function") {
      throw new TypeError("NativeMcpClientManager 需要 NativeMcpStore");
    }
    this.store = options.store;
    this.spawn = options.spawn || spawn;
    this.env = options.env || process.env;
    this.clients = new Map();
  }
  _signature(spec) { return JSON.stringify([spec.command, spec.args, spec.cwd, spec.enabled, spec.updatedAt]); }
  _clientFor(id) {
    const spec = this.store.get(id);
    if (!spec || !spec.enabled) throw clientError("MCP_SERVER_NOT_FOUND", "MCP Server 不存在或未启用");
    const signature = this._signature(spec);
    const existing = this.clients.get(id);
    if (existing?.signature === signature) return existing.client;
    if (existing) void existing.client.close();
    const client = new StdioMcpClient(spec, { spawn: this.spawn, env: this.env });
    this.clients.set(id, { signature, client });
    return client;
  }
  async probe(spec) {
    const client = new StdioMcpClient(spec, { spawn: this.spawn, env: this.env });
    try { return await client.listTools(); } finally { await client.close(); }
  }
  async _use(id, action) {
    const client = this._clientFor(id);
    try { return await action(client); }
    catch (error) {
      const existing = this.clients.get(id);
      if (existing?.client === client) this.clients.delete(id);
      await client.close();
      throw error;
    }
  }
  async listTools(id) { return this._use(id, (client) => client.listTools()); }
  async callTool(id, name, args) { return this._use(id, (client) => client.callTool(name, args)); }
  async closeServer(id) {
    const existing = this.clients.get(id);
    this.clients.delete(id);
    if (existing) await existing.client.close();
  }
  async close() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(({ client }) => client.close()));
  }
}

module.exports = { NativeMcpClientManager, StdioMcpClient, safeEnvironment };
