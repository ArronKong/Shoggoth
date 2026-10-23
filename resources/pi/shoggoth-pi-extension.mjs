import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_CATALOG_FRAME_BYTES = 256 * 1024;
const MAX_TOOLS = 256;
const CONTROL_REQUEST_TIMEOUT_MS = 45_000;
// Standalone extension: match the 30-minute input budget plus Service reply grace.
const INPUT_TIMEOUT_MS = 30 * 60_000;
const TOOL_REQUEST_TIMEOUT_MS = INPUT_TIMEOUT_MS + 30_000 + 45_000;
const PLUGIN_REQUEST_TIMEOUT_MS = 2 * (INPUT_TIMEOUT_MS + 30_000) + 45_000;
const WORKSPACE_REQUEST_TIMEOUT_MS = 2_147_000_000;
const PRODUCT_CONFIRMATION_SELECT_PREFIX = "[[shoggoth-product-confirmation]]";
const NATIVE_HOOK_TITLE = "[[shoggoth-native-tool-hook-v1]]";
const RUNTIME_CALL_BINDING_TITLE = "[[shoggoth-runtime-call-binding-v1]]";
const MUTATING_BUILTINS = new Set(["bash", "powershell", "edit", "write"]);
const STRUCTURAL_NULL_FIELDS = new Set([
  "boardId", "cursor", "enabled", "mimeType", "percent", "ref", "status",
  "threadId", "workspace", "x", "y",
]);
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

function parseStructuredArgument(value, type) {
  if (!safeString(value, 32 * 1024)) return value;
  try {
    const parsed = JSON.parse(value);
    return type === "object" ? (plain(parsed) ? parsed : value)
      : (Array.isArray(parsed) ? parsed : value);
  } catch {
    return value;
  }
}

function parseObjectArgument(value) {
  return parseStructuredArgument(value, "object");
}

function schemaBranches(schema) {
  if (!plain(schema)) return [];
  const branches = typeof schema.type === "string" ? [schema] : [];
  for (const alternatives of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(alternatives)) branches.push(...alternatives.flatMap(schemaBranches));
  }
  return branches;
}

function prepareSchemaObject(schema, args, depth = 0) {
  if (!plain(args) || depth >= 8) return args;
  const branches = schemaBranches(schema).filter((branch) => branch.type === "object");
  if (branches.length === 0) return args;
  let prepared = null;
  for (const branch of branches) {
    for (const [key, property] of Object.entries(branch.properties || {})) {
      if (!Object.hasOwn(args, key)) continue;
      const value = prepareSchemaValue(property, args[key], key, depth + 1);
      if (value !== args[key]) {
        if (prepared === null) prepared = { ...args };
        prepared[key] = value;
      }
    }
  }
  return prepared ?? args;
}

function prepareSchemaArray(schema, args, depth) {
  if (!Array.isArray(args) || depth >= 8 || args.length > 256) return args;
  const branch = schemaBranches(schema).find((candidate) => candidate.type === "array");
  if (!plain(branch?.items)) return args;
  let prepared = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = prepareSchemaValue(branch.items, args[index], null, depth + 1);
    if (value !== args[index]) {
      if (prepared === null) prepared = [...args];
      prepared[index] = value;
    }
  }
  return prepared ?? args;
}

function prepareSchemaValue(schema, input, field, depth) {
  if (depth >= 8) return input;
  const types = schemaBranches(schema).map((branch) => branch.type);
  let value = input;
  if (typeof value === "string") {
    if (value === "null" && types.includes("null") && STRUCTURAL_NULL_FIELDS.has(field)) {
      return null;
    }
    if (!types.includes("string")) {
      if (types.includes("object")) value = parseObjectArgument(value);
      else if (types.includes("array")) value = parseStructuredArgument(value, "array");
    }
  }
  if (plain(value) && types.includes("object")) return prepareSchemaObject(schema, value, depth);
  if (Array.isArray(value) && types.includes("array")) return prepareSchemaArray(schema, value, depth);
  return value;
}

function prepareCronSchedule(value) {
  const schedule = parseObjectArgument(value);
  if (!plain(schedule) || schedule.kind !== "at" || !Number.isSafeInteger(schedule.at)
    || schedule.at < 1_000_000_000 || schedule.at >= 100_000_000_000) return schedule;
  // A current Unix timestamp in seconds is far earlier than any future millisecond timestamp.
  const atMs = schedule.at * 1000;
  return Number.isSafeInteger(atMs) ? { ...schedule, at: atMs } : schedule;
}

function prepareCronNullable(value) {
  return value === "null" || value === "" ? null : value;
}

function prepareCronArguments(name, args) {
  if (!plain(args)) return args;
  if (name === "cron_create") {
    const prepared = { ...args, schedule: prepareCronSchedule(args.schedule) };
    if (Object.hasOwn(args, "workspace")) prepared.workspace = prepareCronNullable(args.workspace);
    if (args.threadPolicy === "new" && Object.hasOwn(args, "threadId")) {
      prepared.threadId = prepareCronNullable(args.threadId);
    }
    return prepared;
  }
  if (name === "cron_update") {
    const patch = parseObjectArgument(args.patch);
    if (!plain(patch)) return { ...args, patch };
    const preparedPatch = { ...patch };
    if (Object.hasOwn(patch, "schedule")) preparedPatch.schedule = prepareCronSchedule(patch.schedule);
    if (Object.hasOwn(patch, "workspace")) preparedPatch.workspace = prepareCronNullable(patch.workspace);
    if (patch.threadPolicy === "new" && Object.hasOwn(patch, "threadId")) {
      preparedPatch.threadId = prepareCronNullable(patch.threadId);
    }
    return { ...args, patch: preparedPatch };
  }
  return args;
}

function prepareProductArguments(name, schema, args) {
  const prepared = prepareSchemaObject(schema, args);
  return name === "cron_create" || name === "cron_update"
    ? prepareCronArguments(name, prepared) : prepared;
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
  if (params?._meta?.["shoggoth/runtime-call-binding"] !== undefined) {
    const encoded = JSON.stringify(params);
    if (Buffer.byteLength(encoded, "utf8") > 32 * 1024) return { action: "cancel" };
    const response = await ctx.ui.input(RUNTIME_CALL_BINDING_TITLE, encoded);
    return response === "accept" ? { action: "accept", content: {} } : { action: "cancel" };
  }
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
        : await ctx.ui.select(title, property.enum, { timeout: INPUT_TIMEOUT_MS });
      if (selected === undefined) return { action: "cancel" };
      content[name] = selected;
    } else if (property.type === "boolean") {
      content[name] = await ctx.ui.confirm(
        title,
        description || (safeString(params.message, 4096) ? params.message : title),
        {
          timeout: INPUT_TIMEOUT_MS,
        },
      );
    } else if (property.type === "string") {
      const entered = await ctx.ui.input(title, description, {
        timeout: INPUT_TIMEOUT_MS,
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
      if (newline === 0 || newline > MAX_CATALOG_FRAME_BYTES) {
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
      if (newline > MAX_FRAME_BYTES && this.pending.get(message.id)?.method !== "tools/list") {
        this.fail(new Error("Oversized Shoggoth MCP frame"));
        return;
      }
      void this.onMessage(message);
    }
    if (this.buffer.length > MAX_CATALOG_FRAME_BYTES) this.fail(new Error("Oversized Shoggoth MCP frame"));
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
      const pending = { method, resolve, reject, timer: null, deadlineAt: null, remainingTimeoutMs: null };
      this.pending.set(id, pending);
      this.armPendingTimeout(
        id,
        pending,
        ctx && method === "tools/call" && params?.name === "workspace_execute" ? WORKSPACE_REQUEST_TIMEOUT_MS
          : ctx && method === "tools/call" && params?.name === "mcp_server_call" ? PLUGIN_REQUEST_TIMEOUT_MS
          : ctx ? TOOL_REQUEST_TIMEOUT_MS : CONTROL_REQUEST_TIMEOUT_MS,
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
  const workspaceExecution = process.env.SHOGGOTH_PI_WORKSPACE_EXECUTION_VERSION === "1";
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
  let nativeHookNames;
  try { nativeHookNames = JSON.parse(process.env.SHOGGOTH_PI_NATIVE_HOOK_TOOLS || "[]"); }
  catch { throw new Error("Shoggoth Pi Hook scope is invalid"); }
  const builtinNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  if (!Array.isArray(nativeHookNames) || nativeHookNames.length > 7 || nativeHookNames.some(name => !builtinNames.has(name))) {
    throw new Error("Shoggoth Pi Hook scope is invalid");
  }
  const nativeHooks = new Set(nativeHookNames), pendingNative = new Map();
  const hookRequest = async (ctx, request) => {
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new Error("HOOK_CAPACITY");
    const value = await ctx.ui.input(NATIVE_HOOK_TITLE, encoded);
    if (typeof value !== "string") throw new Error("HOOK_NATIVE_CALL_FAILED");
    const response = JSON.parse(value);
    if (!plain(response) || response.errorCode) throw new Error(response?.errorCode || "HOOK_NATIVE_CALL_FAILED");
    return response;
  };

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
    catalog = { tools: [] };
    const cursors = new Set(), names = new Set();
    let cursor;
    do {
      const page = await client.request("tools/list", cursor ? { cursor } : {});
      if (!plain(page) || !Array.isArray(page.tools)
        || catalog.tools.length + page.tools.length > MAX_TOOLS
        || page.tools.some(tool => !plain(tool) || !safeString(tool.name, 128) || names.has(tool.name))
        || (page.nextCursor !== undefined && page.nextCursor !== null
          && (!safeString(page.nextCursor, 256) || cursors.has(page.nextCursor)))) {
        client.close();
        throw new Error("Shoggoth MCP tool catalog is invalid");
      }
      for (const tool of page.tools) {
        if (names.has(tool.name)) { client.close(); throw new Error("Shoggoth MCP tool catalog is invalid"); }
        names.add(tool.name);
        catalog.tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
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
      // No promptSnippet: Pi would otherwise repeat every product tool's full
      // description in its system prompt "Available tools" text, on top of the
      // tool definitions the model already receives.
      parameters: tool.inputSchema,
      prepareArguments: (args) => prepareProductArguments(tool.name, tool.inputSchema, args),
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
    // --no-builtin-tools removes builtins from the model. Keep a dispatch guard as
    // well: historical tool calls and future builtins cannot bypass the OS
    // workspace executor through an unprompted native read or cached approval.
    if (workspaceExecution && !catalog.tools.some(tool => tool.name === event.toolName)) {
      return { block: true, reason: "Use workspace_execute for workspace operations in this mode." };
    }
    const mutating = MUTATING_BUILTINS.has(event.toolName);
    if (mutating && policy.sandbox === "read-only") {
      return { block: true, reason: "This Pi profile does not permit mutating built-in tools." };
    }
    let prepared = null;
    if (nativeHooks.has(event.toolName)) {
      try {
        const schema = pi.getAllTools().find(tool => tool.name === event.toolName)?.parameters;
        if (!plain(schema) || !plain(event.input) || !safeString(event.toolCallId, 256)) throw new Error("HOOK_NATIVE_CALL_FAILED");
        prepared = await hookRequest(ctx, { phase: "before", toolCallId: event.toolCallId,
          toolName: event.toolName, arguments: event.input, inputSchema: schema });
        if (!plain(prepared.arguments)) throw new Error("HOOK_NATIVE_CALL_FAILED");
        // Pi emits tool_call after its first validation. The Service validates
        // this final input against the actual runtime tool schema before return.
        for (const key of Object.keys(event.input)) delete event.input[key];
        Object.assign(event.input, prepared.arguments);
      } catch (error) { return { block: true, reason: /^HOOK_[A-Z_]+$/u.test(error.message) ? error.message : "HOOK_NATIVE_CALL_FAILED" }; }
    }
    if (mutating && policy.sandbox === "workspace-write" && ["edit", "write"].includes(event.toolName)) {
      const target = toolPath(event.input);
      if (!target || !contained(ctx.cwd, target)) {
        return { block: true, reason: "The target path is outside the authorized workspace." };
      }
    }
    if (prepared?.requiresApproval) {
      try {
        if ((await hookRequest(ctx, { phase: "approve", toolCallId: event.toolCallId })).approved !== true) throw new Error("HOOK_APPROVAL_DENIED");
      } catch { return { block: true, reason: "HOOK_APPROVAL_DENIED" }; }
    } else if (mutating && ["untrusted", "on-failure", "on-request"].includes(policy.approvalPolicy)) {
      const detail = event.toolName === "bash" && safeString(event.input?.command, 4096)
        ? event.input.command : JSON.stringify(event.input ?? {});
      const allowed = await ctx.ui.confirm(
        `Allow Pi ${event.toolName}?`,
        detail,
      );
      if (!allowed) return { block: true, reason: "The user declined this tool call." };
    }
    if (prepared?.needsAfter) {
      if (pendingNative.size >= 1024) return { block: true, reason: "HOOK_CAPACITY" };
      pendingNative.set(event.toolCallId, prepared);
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const prepared = pendingNative.get(event.toolCallId);
    if (!prepared) return undefined;
    pendingNative.delete(event.toolCallId);
    try {
      const response = await hookRequest(ctx, { phase: "after", toolCallId: event.toolCallId,
        result: { content: event.content, details: event.details ?? null, isError: event.isError } });
      const result = response.result;
      if (result?.hookDisposition === "result_withheld") return { content: [{ type: "text", text: "业务操作已执行，Hook 结果需要验证。请勿自动重试。" }],
        details: result, isError: event.isError };
      if (!plain(result) || !Array.isArray(result.content) || result.isError !== event.isError) throw new Error("HOOK_RESULT_FACT_CHANGED");
      if (plain(result._meta?.shoggothHooks)) {
        const metadata = result._meta.shoggothHooks;
        return { content: [...result.content, { type: "text", text: "业务操作已执行，Hook 后续动作未完成，需要验证。请勿自动重试。" }],
          details: { businessDetails: result.details ?? null, shoggothHooks: metadata }, isError: result.isError };
      }
      return { content: result.content, details: result.details, isError: result.isError };
    } catch {
      // Pi logs and ignores thrown result-handler errors. Always return an
      // explicit withheld body for mandatory transformations or actions.
      if (prepared.requiredAfter) return { content: [{ type: "text", text: "业务操作已执行，Hook 结果未确认。请勿自动重试。" }],
        details: { hookDisposition: "result_withheld", businessOperation: "already_executed", retryAllowed: false,
          errorCode: "HOOK_NATIVE_RESULT_UNVERIFIED" }, isError: event.isError };
      return undefined;
    }
  });

  pi.on("session_shutdown", () => { pendingNative.clear(); client.close(); });
}
