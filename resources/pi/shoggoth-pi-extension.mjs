import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_TOOLS = 256;
const CONTROL_REQUEST_TIMEOUT_MS = 45_000;
const TOOL_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const PRODUCT_CONFIRMATION_SELECT_PREFIX = "[[shoggoth-product-confirmation]]";
const MUTATING_BUILTINS = new Set(["bash", "powershell", "edit", "write"]);
const RELAY_ENV_ALLOWLIST = Object.freeze([
  "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "HOME",
  "ELECTRON_RUN_AS_NODE", "SHOGGOTH_INTERNAL_LAUNCH",
  "SHOGGOTH_RUNTIME_MCP_GATE_FILE", "SHOGGOTH_RUNTIME_MCP_GATE_NONCE",
]);

function safeString(value, maxBytes = 4096) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function parseArgs(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("Invalid Shoggoth MCP arguments"); }
  if (!Array.isArray(parsed) || parsed.length > 32 || !parsed.every((item) => safeString(item))) {
    throw new Error("Invalid Shoggoth MCP arguments");
  }
  return parsed;
}

function relayEnvironment() {
  const env = Object.create(null);
  for (const key of RELAY_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && value.isWellFormed() && !value.includes("\0")
      && Buffer.byteLength(value, "utf8") <= 64 * 1024) env[key] = value;
  }
  return env;
}

function canonicalPath(target) {
  const missing = [];
  let cursor = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(cursor), ...missing); } catch (error) {
      if (error?.code !== "ENOENT") return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function contained(root, target) {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(path.resolve(root, target));
  if (!canonicalRoot || !canonicalTarget) return false;
  const relative = path.relative(canonicalRoot, canonicalTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toolPath(input) {
  if (!plain(input)) return null;
  for (const key of ["path", "filePath", "file_path"]) {
    if (safeString(input[key])) return input[key];
  }
  return null;
}

function isProductConfirmationSchema(schema) {
  if (!plain(schema) || schema.type !== "object" || !plain(schema.properties)
    || Object.keys(schema.properties).length !== 1) return false;
  const property = schema.properties.confirm_product_action;
  return plain(property) && property.type === "string"
    && Array.isArray(property.enum) && property.enum.length === 2
    && property.enum[0] === "确认执行" && property.enum[1] === "取消";
}

async function answerElicitation(params, ctx) {
  const schema = params?.requestedSchema;
  if (!plain(schema) || schema.type !== "object" || !plain(schema.properties)) {
    return { action: "cancel" };
  }
  const productConfirmation = isProductConfirmationSchema(schema);
  const content = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!plain(property)) return { action: "cancel" };
    const title = safeString(property.title, 1024)
      ? property.title : safeString(params.message, 4096) ? params.message : name;
    const description = safeString(property.description, 4096) ? property.description : "";
    if (Array.isArray(property.enum) && property.enum.length > 0
      && property.enum.length <= 32 && property.enum.every((item) => safeString(item, 1024))) {
      const selected = productConfirmation
        ? await ctx.ui.select(`${PRODUCT_CONFIRMATION_SELECT_PREFIX}${title}`, property.enum)
        : await ctx.ui.select(title, property.enum, { timeout: 10 * 60 * 1000 });
      if (selected === undefined) return { action: "cancel" };
      content[name] = selected;
    } else if (property.type === "boolean") {
      content[name] = await ctx.ui.confirm(
        title,
        description || (safeString(params.message, 4096) ? params.message : title),
        {
          timeout: 10 * 60 * 1000,
        },
      );
    } else if (property.type === "string") {
      const entered = await ctx.ui.input(title, description, {
        timeout: 10 * 60 * 1000,
      });
      if (entered === undefined) return { action: "cancel" };
      content[name] = entered;
    } else {
      return { action: "cancel" };
    }
  }
  return { action: "accept", content };
}

class McpClient {
  constructor(command, args) {
    this.child = spawn(command, args, {
      env: relayEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = Buffer.alloc(0);
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.sequence = 0;
    this.pending = new Map();
    this.activeContext = null;
    this.activeRequestId = null;
    this.closed = false;
    this.stderrBytes = 0;
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes = Math.min(256 * 1024, this.stderrBytes + chunk.length);
    });
    this.child.on("error", () => this.fail(new Error("Shoggoth MCP process failed")));
    this.child.on("close", () => this.fail(new Error("Shoggoth MCP process closed")));
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      if (newline === 0 || newline > MAX_FRAME_BYTES) {
        this.fail(new Error("Invalid Shoggoth MCP frame"));
        return;
      }
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(this.decoder.decode(frame)); } catch {
        this.fail(new Error("Invalid Shoggoth MCP frame"));
        return;
      }
      void this.onMessage(message);
    }
    if (this.buffer.length > MAX_FRAME_BYTES) this.fail(new Error("Oversized Shoggoth MCP frame"));
  }

  async onMessage(message) {
    if (!plain(message) || message.jsonrpc !== "2.0") {
      this.fail(new Error("Invalid Shoggoth MCP message"));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "method")) {
      if (message.method !== "elicitation/create" || !this.activeContext
        || !Object.prototype.hasOwnProperty.call(message, "id")) {
        this.write({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Method not found" } });
        return;
      }
      const resumeToolTimeout = isProductConfirmationSchema(message.params?.requestedSchema)
        ? this.pauseActiveToolTimeout() : null;
      try {
        const result = await answerElicitation(message.params, this.activeContext);
        this.write({ jsonrpc: "2.0", id: message.id, result });
      } catch {
        this.write({ jsonrpc: "2.0", id: message.id, result: { action: "cancel" } });
      } finally {
        resumeToolTimeout?.();
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error("Shoggoth MCP request failed"));
    else pending.resolve(message.result);
  }

  write(value) {
    if (this.closed || !this.child.stdin?.writable) throw new Error("Shoggoth MCP is closed");
    const frame = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("Shoggoth MCP request is too large");
    }
    this.child.stdin.write(frame);
  }

  request(method, params, ctx = null) {
    if (this.closed || this.pending.size >= 32) return Promise.reject(new Error("Shoggoth MCP is busy"));
    this.sequence += 1;
    const id = `pi-mcp-${this.sequence}`;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null, deadlineAt: null, remainingTimeoutMs: null };
      this.pending.set(id, pending);
      this.armPendingTimeout(
        id,
        pending,
        ctx ? TOOL_REQUEST_TIMEOUT_MS : CONTROL_REQUEST_TIMEOUT_MS,
      );
      this.activeContext = ctx;
      if (ctx) this.activeRequestId = id;
      try { this.write({ jsonrpc: "2.0", id, method, params }); } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      }
    }).finally(() => {
      this.activeContext = null;
      if (this.activeRequestId === id) this.activeRequestId = null;
    });
  }

  armPendingTimeout(id, pending, timeoutMs) {
    pending.remainingTimeoutMs = timeoutMs;
    pending.deadlineAt = Date.now() + timeoutMs;
    pending.timer = setTimeout(() => {
      if (this.pending.get(id) !== pending) return;
      this.pending.delete(id);
      pending.reject(new Error("Shoggoth MCP request timed out"));
    }, timeoutMs);
    pending.timer.unref?.();
  }

  pauseActiveToolTimeout() {
    const id = this.activeRequestId;
    const pending = id === null ? null : this.pending.get(id);
    if (!pending || pending.timer === null) return null;
    pending.remainingTimeoutMs = Math.max(1, pending.deadlineAt - Date.now());
    clearTimeout(pending.timer);
    pending.timer = null;
    pending.deadlineAt = null;
    return () => {
      if (this.pending.get(id) === pending && pending.timer === null) {
        this.armPendingTimeout(id, pending, pending.remainingTimeoutMs);
      }
    };
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try { this.child.kill("SIGKILL"); } catch {}
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Shoggoth MCP closed"));
    }
    this.pending.clear();
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill("SIGTERM"); } catch {}
  }
}

export default async function shoggothPiExtension(pi) {
  const command = process.env.SHOGGOTH_PI_MCP_COMMAND;
  const rawArgs = process.env.SHOGGOTH_PI_MCP_ARGS;
  const policyRaw = process.env.SHOGGOTH_PI_PERMISSION_POLICY;
  if (!safeString(command) || !path.isAbsolute(command) || !safeString(rawArgs, 32 * 1024)
    || !safeString(policyRaw, 4096)) {
    throw new Error("Shoggoth Pi bridge environment is invalid");
  }
  let policy;
  try { policy = JSON.parse(policyRaw); } catch { throw new Error("Shoggoth Pi policy is invalid"); }
  if (!plain(policy) || !["untrusted", "on-failure", "on-request", "never"].includes(policy.approvalPolicy)
    || !["read-only", "workspace-write", "danger-full-access"].includes(policy.sandbox)) {
    throw new Error("Shoggoth Pi policy is invalid");
  }

  // Pi rewrites process.title to "pi", while the one-shot MCP gate verifies the
  // direct parent through ps(1). Expose the real launch path until that gate is consumed.
  const originalProcessTitle = process.title;
  let client;
  let catalog;
  try {
    process.title = process.execPath;
    client = new McpClient(command, parseArgs(rawArgs));
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: "shoggoth-pi", version: "1" },
    });
    if (!plain(initialized) || !plain(initialized.capabilities) || !plain(initialized.capabilities.tools)) {
      client.close();
      throw new Error("Shoggoth MCP initialization failed");
    }
    client.notify("notifications/initialized");
    catalog = await client.request("tools/list", {});
    if (!plain(catalog) || !Array.isArray(catalog.tools) || catalog.tools.length > MAX_TOOLS) {
      client.close();
      throw new Error("Shoggoth MCP tool catalog is invalid");
    }
  } finally {
    process.title = originalProcessTitle;
  }
  for (const tool of catalog.tools) {
    if (!plain(tool) || !safeString(tool.name, 128) || !safeString(tool.description, 4096)
      || !plain(tool.inputSchema)) {
      client.close();
      throw new Error("Shoggoth MCP tool catalog is invalid");
    }
    pi.registerTool({
      name: tool.name,
      label: safeString(tool.title, 1024) ? tool.title : tool.name,
      description: tool.description,
      promptSnippet: tool.description,
      parameters: tool.inputSchema,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await client.request("tools/call", { name: tool.name, arguments: params }, ctx);
        if (!plain(result) || !Array.isArray(result.content)) {
          throw new Error("Shoggoth MCP tool response is invalid");
        }
        const content = result.content.filter((item) => plain(item)
          && ((item.type === "text" && typeof item.text === "string")
            || (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")));
        if (result.isError === true) {
          const message = content.find((item) => item.type === "text")?.text || "Shoggoth tool failed";
          throw new Error(message);
        }
        return { content, details: result.structuredContent ?? null };
      },
    });
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!MUTATING_BUILTINS.has(event.toolName)) return undefined;
    if (policy.sandbox === "read-only") {
      return { block: true, reason: "This Pi profile does not permit mutating built-in tools." };
    }
    if (policy.sandbox === "workspace-write" && ["edit", "write"].includes(event.toolName)) {
      const target = toolPath(event.input);
      if (!target || !contained(ctx.cwd, target)) {
        return { block: true, reason: "The target path is outside the authorized workspace." };
      }
    }
    if (["untrusted", "on-failure", "on-request"].includes(policy.approvalPolicy)) {
      const detail = event.toolName === "bash" && safeString(event.input?.command, 4096)
        ? event.input.command : JSON.stringify(event.input ?? {});
      const allowed = await ctx.ui.confirm(
        `Allow Pi ${event.toolName}?`,
        detail,
      );
      if (!allowed) return { block: true, reason: "The user declined this tool call." };
    }
    return undefined;
  });

  pi.on("session_shutdown", () => client.close());
}
