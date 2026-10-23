"use strict";
// This process never imports Service code. OS sandboxing is the security
// boundary; vm only provides a small, predictable authoring environment.
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const limit = 32768;
function nativeGuardInput(event) {
  return { hook_event_name: "PreToolUse", tool_name: event.tool.name, tool_input: event.payload.arguments,
    tool_use_id: event.toolCallId || event.eventId, cwd: event.workspace,
    ...(typeof event.payload.arguments?.command === "string" ? { command: event.payload.arguments.command } : {}) };
}
function normalizeGuard(format, value, exitCode, stderr) {
  if (exitCode === 2) return { decision: "block", reason: stderr.trim() || "Compatible guard exited with code 2" };
  if (exitCode !== 0) throw new Error("exit");
  if (value === undefined) return { decision: "allow" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("decision");
  const exact = (object, allowed) => { if (Object.keys(object).some(key => !allowed.includes(key))) throw new Error("unsupported output"); };
  let decision, reason;
  if (format === "claude-code-pretooluse-v1") {
    exact(value, ["decision", "reason", "hookSpecificOutput"]);
    if (value.hookSpecificOutput !== undefined) {
      if (value.decision !== undefined || value.reason !== undefined) throw new Error("conflicting output");
      const specific = value.hookSpecificOutput;
      if (!specific || typeof specific !== "object" || Array.isArray(specific)) throw new Error("decision");
      exact(specific, ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
      if (specific.hookEventName !== "PreToolUse") throw new Error("event");
      decision = { allow: "allow", deny: "block", ask: "require_approval" }[specific.permissionDecision];
      reason = specific.permissionDecisionReason;
    } else {
      if (Object.keys(value).length === 0) return { decision: "allow" };
      decision = { approve: "allow", block: "block" }[value.decision]; reason = value.reason;
    }
  } else if (format === "cursor-tool-permission-v1") {
    exact(value, ["permission", "user_message", "agent_message"]);
    decision = { allow: "allow", deny: "block", ask: "require_approval" }[value.permission];
    for (const key of ["user_message", "agent_message"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new Error("message");
    reason = value.agent_message || value.user_message;
  } else throw new Error("format");
  if (!decision || reason !== undefined && (typeof reason !== "string" || !reason || Buffer.byteLength(reason) > 1024 || reason.includes("\0"))) throw new Error("decision");
  return { decision, ...(reason ? { reason } : {}) };
}
async function compatibleGuard(request, source) {
  const input = JSON.stringify(nativeGuardInput(request.event));
  let stdout = "", stderr = "", exitCode = 0, exitSignal = {};
  const append = target => chunk => {
    if (typeof chunk !== "string") chunk = String(chunk);
    if (Buffer.byteLength((target === "out" ? stdout : stderr) + chunk) > (target === "out" ? 8192 : 1024)) throw new Error("output");
    if (target === "out") stdout += chunk; else stderr += chunk; return true;
  };
  const write = append("out"), writeError = append("err");
  const compatProcess = Object.freeze({ env: Object.freeze({}), argv: Object.freeze(["node", "hook-handler.cjs"]),
    stdin: Object.freeze({ fd: 0 }), stdout: Object.freeze({ write }), stderr: Object.freeze({ write: writeError }),
    cwd: () => request.workspace,
    exit: (code = 0) => { if (!Number.isSafeInteger(code)) throw new Error("exit"); exitCode = code; throw exitSignal; } });
  const context = vm.createContext({ module: { exports: null }, process: compatProcess,
    console: Object.freeze({ log: (...args) => write(args.join(" ") + "\n"), error: (...args) => writeError(args.join(" ") + "\n") }),
    require(name) {
      if (["node:process", "process"].includes(name)) return compatProcess;
      if (["node:fs", "fs"].includes(name)) return { ...fs, readFileSync(target, options) {
        return target === 0 ? typeof options === "string" || options?.encoding ? input : Buffer.from(input) : fs.readFileSync(target, options);
      } };
      if (!["node:path", "path", "node:crypto", "crypto"].includes(name)) throw new Error("module");
      return require(name);
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  let value;
  try {
    new vm.Script(source, { filename: "hook-handler.cjs" }).runInContext(context);
    if (typeof context.module.exports === "function") value = await context.module.exports(JSON.parse(input));
  } catch (error) { if (error !== exitSignal) throw error; }
  if (exitCode === 2) return normalizeGuard(request.compatibility, undefined, exitCode, stderr);
  if (stdout.trim()) { if (value !== undefined) throw new Error("mixed output"); value = JSON.parse(stdout); }
  return normalizeGuard(request.compatibility, value, exitCode, stderr);
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  if (buffer.length + chunk.length > limit) process.exit(2);
  buffer = Buffer.concat([buffer, chunk]);
});
process.stdin.on("end", async () => {
  try {
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    let output;
    if (request.builtin === "context.file") {
      const target = path.resolve(request.workspace, request.config.relativePath);
      if (!target.startsWith(request.workspace + path.sep) || fs.realpathSync(target) !== target) throw new Error("scope");
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error("file");
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("changed");
        output = { text: new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fd)) };
      } finally { fs.closeSync(fd); }
    } else if (request.builtin === "workspace.copy") {
      const from = path.resolve(request.workspace, request.config.from);
      const to = path.resolve(request.workspace, request.config.to);
      for (const file of [from, to]) {
        if (!file.startsWith(request.workspace + path.sep)) throw new Error("scope");
        const parts = path.relative(request.workspace, file).split(path.sep);
        let current = request.workspace;
        for (const part of parts) {
          current = path.join(current, part);
          if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink");
        }
      }
      const stat = fs.lstatSync(from);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("source");
      const source = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(source);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error("changed");
        const data = fs.readFileSync(source);
        // Creation is exclusive. Never overwrite an existing household file.
        const dest = fs.openSync(to, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(dest, data); fs.fsyncSync(dest); } finally { fs.closeSync(dest); }
      } finally { fs.closeSync(source); }
      output = { status: "completed", sideEffect: "known", artifacts: [request.config.to] };
    } else {
      const source = fs.readFileSync(request.sourceFile, "utf8");
      if (require("node:crypto").createHash("sha256").update(source).digest("hex") !== request.sourceDigest) throw new Error("changed");
      if (request.compatibility) output = await compatibleGuard(request, source);
      else {
      const context = vm.createContext({ module: { exports: null }, event: request.event,
        console: Object.freeze({ log() {}, error() {} }),
        require(name) {
          if (!["node:fs", "fs", "node:path", "path", "node:crypto", "crypto"].includes(name)) throw new Error("module");
          return require(name);
        },
      }, { codeGeneration: { strings: false, wasm: false } });
      new vm.Script(source, { filename: "hook-handler.cjs" }).runInContext(context);
      if (typeof context.module.exports !== "function") throw new Error("handler");
      output = await context.module.exports(context.event);
      }
    }
    const encoded = JSON.stringify(output);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 8192) throw new Error("output");
    process.stdout.write(encoded + "\n");
  } catch { process.stderr.write("HOOK_WORKER_FAILED\n"); process.exitCode = 2; }
});
