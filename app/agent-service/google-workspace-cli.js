"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serviceError } = require("./security");
const { MAX_RESPONSE_BYTES } = require("./mcp-transport-utils");
const { resolveOnPath } = require("./mcp-package-launcher");

const SERVICES = Object.keys(require("../core/google-workspace-services.json"));
const PREVIEW_REQUIRED = "GOOGLE_WORKSPACE_PREVIEW_REQUIRED";
const service = { type: "string", enum: SERVICES };
const action = { type: "string", description: "The exact action returned by list_actions." };
const TOOLS = [
  { name: "list_actions", description: "List the actions currently offered by a Google Workspace service.",
    inputSchema: { type: "object", properties: { service }, required: ["service"], additionalProperties: false } },
  { name: "describe_action", description: "Read the current CLI help and supported flags for an action before calling it.",
    inputSchema: { type: "object", properties: { service, action }, required: ["service", "action"], additionalProperties: false } },
  { name: "run_action", description: "Run a Google Workspace action. Use flag names from describe_action as parameters, without leading dashes. Pass repeated values as arrays. Changes and Google approval requests are confirmed by the user.",
    inputSchema: { type: "object", properties: { service, action, parameters: { type: "object", additionalProperties: true } },
      required: ["service", "action", "parameters"], additionalProperties: false } },
];

function isGoogleWorkspaceCommand(command, args) {
  return typeof command === "string" && path.basename(command) === "gwscli" && Array.isArray(args) && args.length === 0;
}

function resolveGoogleWorkspaceCli(env = process.env, homeDir = env.HOME) {
  // Finder-launched apps often lack ~/.local/bin, the official installer's default.
  const dirs = [homeDir && path.join(homeDir, ".local", "bin"), env.PATH, "/usr/local/bin", "/opt/homebrew/bin"];
  return resolveOnPath("gwscli", { PATH: dirs.filter(Boolean).join(path.delimiter) });
}

function binaryStamp(command) {
  try {
    const stat = fs.statSync(command, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.ctimeNs].join(":");
  } catch { throw serviceError("MCP_SERVER_PATH_INVALID"); }
}

function signedIn(status) {
  if (/^Logged in as the following user:/mu.test(status)) return true;
  // A read-only grant may omit the identity scope and print only granted scopes.
  const grants = status.match(/^Granted the following scopes:[ \t]*\r?\n((?:[ \t]+-[ \t]+[^\r\n]+(?:\r?\n|$))*)/mu)?.[1];
  return !!grants && /^[ \t]+-[ \t]+https:\/\/www\.googleapis\.com\/auth\/[\w./-]+[ \t]*\r?$/mu.test(grants);
}

function parseActions(help) {
  const section = help.split(/^Available Commands:\s*$/mu)[1]?.split(/^\S/mu)[0] || "";
  const actions = [...section.matchAll(/^  ([a-z][a-z0-9_]+)\s+([^\n]+)$/gmu)];
  if (!actions.length) throw serviceError("MCP_SERVER_RESPONSE_INVALID");
  return Object.fromEntries(actions.map(([, name, description]) => [name, description.trim()]));
}

function actionHelp(help) {
  const [description, after] = help.split(/^Flags:[ \t]*$/mu);
  if (after === undefined) throw serviceError("MCP_SERVER_RESPONSE_INVALID");
  const section = after.split(/^\S/mu)[0];
  const flags = new Map(), visible = [];
  let include = false;
  for (const line of section.split("\n")) {
    const flag = line.match(/^[ \t]+(?:-\w,[ \t]+)?--([\w-]+)(?: ([A-Za-z]\w*))?/u);
    if (flag) {
      const [, key, type] = flag;
      include = !/(?:path|directory|oauth|token_override)/iu.test(key)
        && !/^(?:schema|show-scopes|help|out|output|outputFile|outputDir|sourceFile|acknowledgeAbuse)$/iu.test(key);
      if (include) flags.set(key, type);
    }
    if (include) visible.push(line);
  }
  return { flags, text: [description.trim(), "Flags:", visible.join("\n").trimEnd()].join("\n") };
}

function commandArguments(parameters, flags) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).length > 80) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS");
  const args = [];
  for (const [key, value] of Object.entries(parameters)) {
    if (!flags.has(key) || value === null || value === undefined) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS");
    const values = flags.get(key) === "stringArray" && Array.isArray(value) ? value : [value];
    for (const item of values) {
      const encoded = typeof item === "string" ? item : JSON.stringify(item);
      if (typeof encoded !== "string" || encoded.includes("\0")) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS");
      args.push(`--${key}=${encoded}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS");
  return args;
}

function requiresDeveloperPreview(stderr) {
  try {
    const result = JSON.parse(stderr);
    return result?.isError === true && Array.isArray(result.content) && result.content.some(item =>
      item?.type === "text" && typeof item.text === "string"
      && /^Access to this tool requires that your Google Cloud project(?: \(\d+\))? is enrolled in (?:the )?Google Workspace Developer Preview Program\b/iu.test(item.text));
  } catch {
    return false;
  }
}

// The CLI is a terminal client of Google's MCP servers. It is not a stdio MCP server.
class GoogleWorkspaceCliClient {
  constructor(transport, { env, spawn: spawnImpl = spawn }) {
    this.command = transport.command;
    this.cwd = transport.cwd;
    this.env = env;
    this.spawn = spawnImpl;
    this.stamp = binaryStamp(this.command);
    this.stop = new AbortController();
    this.pending = new Set();
  }

  run(args, { signal, assertCurrent, requestApproval, business = false, cwd = this.cwd } = {}) {
    const owner = signal ? AbortSignal.any([this.stop.signal, signal]) : this.stop.signal;
    owner.throwIfAborted();
    assertCurrent?.();
    if (binaryStamp(this.command) !== this.stamp) throw serviceError("MCP_SERVER_PATH_INVALID");
    const child = this.spawn(this.command, args, { cwd, env: this.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const operation = new Promise((resolve, reject) => {
      let stdout = "", stderr = "", size = 0, failure, waiting = false, denied = false, timer;
      const terminate = code => {
        failure ||= serviceError(code);
        if (child.pid > 0) child.kill("SIGKILL");
      };
      const abort = () => terminate(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_EXTERNAL_CALL_CANCELLED");
      const armTimer = () => { timer = setTimeout(() => terminate(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_TIMEOUT"), 90_000); timer.unref?.(); };
      const approvalAbort = new AbortController();
      const review = async message => {
        waiting = true;
        clearTimeout(timer);
        try {
          if (!requestApproval) throw serviceError("MCP_TOOL_CONFIRMATION_REQUIRED");
          const approved = await requestApproval(message, AbortSignal.any([owner, approvalAbort.signal]));
          owner.throwIfAborted(); approvalAbort.signal.throwIfAborted(); assertCurrent?.();
          denied = approved !== true;
          child.stdin.write(denied ? "DENY_ONCE\n" : "ALLOW_ONCE\n");
          stderr = "";
          armTimer();
        } catch (error) { terminate(error?.code === "MCP_TOOL_CONFIRMATION_REQUIRED" ? error.code : "MCP_EXTERNAL_CALL_CANCELLED"); }
        finally { waiting = false; }
      };
      const collect = (data, diagnostic) => {
        size += Buffer.byteLength(data);
        if (failure) return;
        if (size > MAX_RESPONSE_BYTES) { terminate(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_RESPONSE_TOO_LARGE"); return; }
        if (!diagnostic) { stdout += data; return; }
        stderr += data;
        const prompt = business && !waiting && /\(Options:[ \t]*([^\n)]+)\)/iu.exec(stderr);
        if (prompt) {
          if (denied || !/\ballow[ _]once\b/iu.test(prompt[1]) || !/deny|don't allow|do not allow|reject|decline/iu.test(prompt[1]) || Buffer.byteLength(stderr) > 8000) { terminate("MCP_TOOL_CONFIRMATION_REQUIRED"); return; }
          void review(stderr.trim());
        }
      };
      child.stdout.setEncoding("utf8").on("data", data => collect(data, false));
      child.stderr.setEncoding("utf8").on("data", data => collect(data, true));
      child.stdin.on("error", () => terminate(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_CONNECTION_FAILED"));
      if (!business) child.stdin.end();
      child.once("error", () => { failure ||= serviceError("MCP_SERVER_START_FAILED"); });
      child.once("close", code => {
        clearTimeout(timer); owner.removeEventListener("abort", abort); approvalAbort.abort();
        if (failure) return reject(failure);
        if (denied) return reject(serviceError("MCP_EXTERNAL_APPROVAL_DENIED"));
        if (code === 0) return resolve(stdout.trim());
        if (business && code === 1 && requiresDeveloperPreview(stderr)) return reject(serviceError(PREVIEW_REQUIRED));
        if (/not authenticated|not logged in|obtain token|run .*auth login|insufficient.*scope/iu.test(stderr)) return reject(serviceError("MCP_AUTH_REQUIRED"));
        if (/permission_denied|service_disabled|accessnotconfigured|API has not been used|API.*is disabled/iu.test(stderr)) return reject(serviceError("MCP_SERVER_ACCESS_DENIED"));
        reject(serviceError(business ? "MCP_SERVER_RESULT_UNKNOWN" : "MCP_SERVER_CONNECTION_FAILED"));
      });
      armTimer(); owner.addEventListener("abort", abort, { once: true }); if (owner.aborted) abort();
    });
    this.pending.add(operation);
    operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }

  async listTools() {
    const status = await this.run(["auth", "status"]);
    if (!signedIn(status)) throw serviceError("MCP_AUTH_REQUIRED");
    return TOOLS;
  }

  async callTool(name, args, options = {}) {
    const definition = TOOLS.find(tool => tool.name === name);
    if (!definition || !args || !SERVICES.includes(args.service)
      || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))
      || definition.inputSchema.required.some(key => !Object.hasOwn(args, key))) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS");
    const actions = parseActions(await this.run([args.service, "--help"], options));
    let output;
    if (name === "list_actions") output = JSON.stringify(actions);
    else {
      if (typeof args.action !== "string" || !Object.hasOwn(actions, args.action)) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS");
      const command = [args.service, args.action];
      const help = actionHelp(await this.run([...command, "--help"], options));
      if (name === "describe_action") output = help.text;
      else {
        const argv = [...command, ...commandArguments(args.parameters, help.flags)];
        const reads = /^(?:get_|list_|read_|search_)/u.test(args.action)
          || args.service === "calendar" && args.action === "suggest_time" || args.service === "drive" && args.action === "download_file_content";
        if (!reads && !options.reviewedWrite) {
          if (!options.requestApproval) throw serviceError("MCP_TOOL_CONFIRMATION_REQUIRED");
          const signal = options.signal ? AbortSignal.any([this.stop.signal, options.signal]) : this.stop.signal;
          signal.throwIfAborted(); options.assertCurrent?.();
          if (await options.requestApproval("Google Workspace", signal) !== true) throw serviceError("MCP_EXTERNAL_APPROVAL_DENIED");
        }
        try {
          output = args.service === "drive" && args.action === "download_file_content" ? await this.download(argv, options)
            : await this.run(argv, { ...options, business: true });
        } catch (error) {
          if (error.code !== PREVIEW_REQUIRED) throw error;
          // Preserve Google's definitive denial as an MCP error response so the
          // receipt records a returned result, without storing its diagnostics.
          return { isError: true, structuredContent: { code: PREVIEW_REQUIRED },
            content: [{ type: "text", text: "Google rejected this request. The Cloud project currently needs access through the Google Workspace Developer Preview Program. https://developers.google.com/workspace/preview" }] };
        }
      }
    }
    return { content: [{ type: "text", text: output }] };
  }

  async download(argv, options) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shoggoth-drive-"));
    const destination = path.join(dir, "content");
    try {
      const stdout = await this.run([...argv, "--destinationPath=" + destination], { ...options, cwd: dir, business: true });
      const file = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (!file) return stdout;
      if (!file.isFile() || file.size > (MAX_RESPONSE_BYTES - 256) * 0.75) throw serviceError("MCP_SERVER_RESPONSE_TOO_LARGE");
      return JSON.stringify({ base64Content: (await fs.promises.readFile(destination)).toString("base64") });
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  }

  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.pending]);
  }
}

module.exports = { GoogleWorkspaceCliClient, isGoogleWorkspaceCommand, resolveGoogleWorkspaceCli, signedIn };
