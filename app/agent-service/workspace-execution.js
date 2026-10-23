"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");
const crypto = require("node:crypto");
const { assertHookWorkspace } = require("./hook-process-host");
const { workspaceAutoExecution, validWorkspaceExecutionArguments, widerWorkspaceAccess } = require("./workspace-execution-tools");
const { serviceError, ensurePrivateDirectoryTree } = require("./security");
const { EXECUTION_TIMEOUT_MS } = require("../execution-timeout");
// Snapshot trusted launcher bytes before any model-controlled workspace writes.
const supervisorSource = fs.readFileSync(path.join(__dirname, "workspace-execution-supervisor.js"));
const inside = (child, root) => child === root || child.startsWith(root + path.sep);
const fail = code => { throw serviceError(code, "工作区受限执行不可用，请核对执行范围或失败结果"); };
const q = JSON.stringify;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function assertWorkspaceLinks(workspace, scope) {
  // Seatbelt follows symlinks, but an existing hard link has an authorized
  // pathname and can mutate the same inode outside the workspace. Refuse this
  // ambiguous tree before running any command. Do not silently break links.
  const pending = [workspace], started = Date.now();
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 500000 || Date.now() - started > 10000) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
      if (entries % 256 === 0) { await new Promise(resolve => setImmediate(resolve)); scope.assertCurrent(); }
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile() && stat.nlink !== 1) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
      if (stat.isDirectory()) pending.push(target);
    }
  }
}

function workspaceExecutionProfile({ workspace, scratch, nodeExecutable, access = {}, marker }) {
  const reads = ["/System/Library", "/usr/lib", "/usr/share", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
    "/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer",
    "/opt/homebrew/Cellar", "/opt/homebrew/opt", "/opt/homebrew/bin", "/opt/homebrew/lib/node_modules",
    "/usr/local/Cellar", "/usr/local/opt", "/usr/local/bin", "/usr/local/lib/node_modules",
    "/private/var/db/timezone"];
  const bundle = /^(.*[.]app\/Contents)\/MacOS\/[^/]+$/u.exec(nodeExecutable)?.[1];
  if (bundle) reads.push(path.join(bundle, "Frameworks"));
  if (/^node(?:js)?$/u.test(path.basename(nodeExecutable)) && path.basename(path.dirname(nodeExecutable)) === "bin") {
    const prefix = path.dirname(path.dirname(nodeExecutable));
    reads.push(...["lib", "include", "share"].map(part => path.join(prefix, part)));
  }
  return ["(version 1)", "(deny default)",
    "(allow process-exec process-fork)", "(allow process-info* (target self))",
    "(allow sysctl-read)",
    '(deny sysctl-read (sysctl-name "kern.procargs") (sysctl-name "kern.procargs2"))',
    "(allow file-read-metadata)",
    `(allow file-read* ${reads.map(root => `(subpath ${q(root)})`).join(" ")} (literal ${q(nodeExecutable)}) (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime"))`,
    ...(marker ? [`(allow file-read-data (literal ${q(marker)}))`] : []),
    `(allow file-read* file-write* (subpath ${q(workspace)}) (subpath ${q(scratch)}))`,
    ...(access.readPaths || []).map(root => `(allow file-read* (subpath ${q(root)}))`),
    ...(access.writePaths || []).map(root => `(allow file-read* file-write* (subpath ${q(root)}))`),
    ...(access.network ? ['(allow network-outbound (remote ip "*:*"))',
      '(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.mDNSResponder"))'] : []),
    '(allow file-write* (literal "/dev/null"))',
    // No network, Unix sockets, mach lookup, Apple events, keychain, Service
    // storage or native Runtime Home. Children inherit the same restrictions.
  ].join("\n");
}

class WorkspaceExecutionService {
  constructor({ cacheDir, paths = {}, nodeExecutable = process.execPath, requestApproval, pauseRuntimeTimeout, processOwnerDir } = {}) {
    if (!path.isAbsolute(cacheDir || "")) throw new TypeError("Workspace execution cache is invalid");
    this.cacheDir = cacheDir; this.paths = paths;
    this.nodeExecutable = fs.realpathSync(nodeExecutable);
    this.requestApproval = requestApproval;
    this.pauseRuntimeTimeout = pauseRuntimeTimeout;
    this.active = new Set(); this.controls = new Set(); this.cleaning = new Map(); this.blockedWorkspaces = new Set(); this.pending = new Set(); this.callControllers = new Set(); this.verified = null;
    const directory = processOwnerDir || (process.resourcesPath
      && fs.existsSync(path.join(process.resourcesPath, "workspace-execution"))
      ? path.join(process.resourcesPath, "workspace-execution") : path.join(__dirname, "..", "..", ".vendor", "workspace-execution"));
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
      const executable = path.join(directory, "process-owner"), stat = fs.lstatSync(executable);
      const bytes = fs.readFileSync(executable);
      if (manifest.version !== 1 || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022)
        || ![0, process.getuid()].includes(stat.uid) || bytes.length > 1024 * 1024
        || crypto.createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("invalid helper");
      this.processOwnerBytes = bytes;
    } catch { this.processOwnerBytes = null; }
  }
  #clean(control) {
    if (this.cleaning.has(control)) return this.cleaning.get(control);
    const promise = Promise.resolve().then(() => {
      if (!this.processOwnerBytes) fail("WORKSPACE_EXECUTION_CLEANUP_FAILED");
      const owner = path.join(control, `reaper-${crypto.randomUUID()}`), marker = path.join(control, "marker"), guard = path.join(control, "guard");
      const stat = fs.lstatSync(control);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail("WORKSPACE_EXECUTION_CLEANUP_FAILED");
      fs.writeFileSync(owner, this.processOwnerBytes, { mode: 0o700, flag: "wx" });
      try {
        const result = require("node:child_process").spawnSync(owner, [marker, guard], {
          encoding: "utf8", timeout: 3000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
        let value;
        try { value = JSON.parse(result.stdout); } catch {}
        if (result.status !== 0 || value?.version !== 1 || value.cleared !== true) fail("WORKSPACE_EXECUTION_CLEANUP_FAILED");
        return value;
      } finally { fs.rmSync(owner, { force: true }); }
    }).finally(() => this.cleaning.delete(control));
    this.cleaning.set(control, promise);
    return promise;
  }
  async #recover() {
    ensurePrivateDirectoryTree(this.cacheDir, this.paths.trustedRoot || path.dirname(this.cacheDir));
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (!/^execution-[A-Za-z0-9]+$/u.test(name)) continue;
      const control = path.join(this.cacheDir, name);
      if (this.controls.has(control)) continue;
      await this.#clean(control);
      try {
        const binding = JSON.parse(fs.readFileSync(path.join(control, "binding.json"), "utf8"));
        this.blockedWorkspaces.delete(binding.workspace);
      } catch { /* Old recovery markers need no model-provided binding. */ }
      fs.rmSync(control, { recursive: true, force: true });
    }
  }
  #workspace(value) {
    if (typeof value !== "string" || !path.isAbsolute(value) || /[\0-\x1f]/u.test(value)) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
    let workspace;
    try {
      workspace = fs.realpathSync(value);
      if (!fs.statSync(workspace).isDirectory()) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
    } catch { fail("WORKSPACE_EXECUTION_SCOPE_INVALID"); }
    try { assertHookWorkspace(workspace, this.paths, false); }
    catch { fail("WORKSPACE_EXECUTION_SCOPE_INVALID"); }
    this.#assertPublicRoot(workspace);
    return workspace;
  }
  #assertPublicRoot(resolved) {
    const home = this.paths.homeDir || os.homedir();
    const appContents = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "app.asar"))
      ? path.dirname(process.resourcesPath) : null;
    const protectedRoots = [this.cacheDir, ...(appContents ? [appContents] : []),
      ...[".ssh", ".aws", ".codex", ".claude", ".gemini", ".pi", ".hermes", ".openclaw", ".dsh",
        ".config/opencode", ".local/share/opencode", "Library/Keychains"].map(part => path.join(home, part))];
    if (protectedRoots.some(root => inside(resolved, root) || inside(root, resolved))) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
  }
  #access(raw = {}) {
    const normalize = value => {
      let resolved;
      try {
        // A missing final leaf may be explicitly granted under an existing
        // directory. The approved profile pins the canonical parent path.
        resolved = fs.existsSync(value) ? fs.realpathSync(value)
          : path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
      } catch { fail("WORKSPACE_EXECUTION_SCOPE_INVALID"); }
      try { assertHookWorkspace(resolved, this.paths, false); }
      catch { fail("WORKSPACE_EXECUTION_SCOPE_INVALID"); }
      this.#assertPublicRoot(resolved);
      return resolved;
    };
    return { readPaths: (raw.readPaths || []).map(normalize), writePaths: (raw.writePaths || []).map(normalize), network: raw.network === true };
  }
  async #launch(command, workspace, cwd, timeoutMs, scope, access) {
    scope.assertCurrent(); if (scope.signal?.aborted) fail("HOST_CAPABILITY_REVOKED");
    ensurePrivateDirectoryTree(this.cacheDir, this.paths.trustedRoot || path.dirname(this.cacheDir));
    const control = fs.mkdtempSync(path.join(this.cacheDir, "execution-"));
    const scratch = path.join(control, "files");
    fs.mkdirSync(scratch, { mode: 0o700 });
    const launcher = path.join(control, "supervisor.cjs");
    fs.writeFileSync(launcher, supervisorSource, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(control, "binding.json"), JSON.stringify({ version: 1, workspace }), { mode: 0o600, flag: "wx" });
    if (!this.processOwnerBytes) fail("WORKSPACE_EXECUTION_UNAVAILABLE");
    const processOwner = path.join(control, "process-owner"), marker = path.join(control, "marker"), guard = path.join(control, "guard");
    fs.writeFileSync(processOwner, this.processOwnerBytes, { mode: 0o700, flag: "wx" });
    for (const file of [marker, guard]) fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    const profile = workspaceExecutionProfile({ workspace, scratch, nodeExecutable: this.nodeExecutable, access, marker });
    this.controls.add(control);
    let cleanupVerified = false;
    const env = { PATH: [path.dirname(this.nodeExecutable), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(this.nodeExecutable, [launcher], { cwd: control, env,
          shell: false, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
        this.active.add(child);
        const output = { stdout: { head: Buffer.alloc(0), tail: Buffer.alloc(0), bytes: 0 },
          stderr: { head: Buffer.alloc(0), tail: Buffer.alloc(0), bytes: 0 } };
        let failure = null, result = null;
        const stop = code => {
          failure ||= serviceError(code, "工作区命令已停止；请检查部分执行结果，不要自动重试");
          try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure = serviceError("WORKSPACE_EXECUTION_CLEANUP_FAILED", "无法确认命令已停止"); }
        };
        const abort = () => stop("HOST_CAPABILITY_REVOKED");
        const timer = setTimeout(() => stop("WORKSPACE_EXECUTION_TIMEOUT"), timeoutMs);
        scope.signal?.addEventListener("abort", abort, { once: true });
        for (const channel of ["stdout", "stderr"]) child[channel].on("data", chunk => {
          const captured = output[channel]; captured.bytes += chunk.length;
          if (output.stdout.bytes + output.stderr.bytes > 32 * 1024 * 1024) { stop("WORKSPACE_EXECUTION_OUTPUT_LIMIT"); return; }
          if (captured.head.length < 8192) {
            const count = Math.min(8192 - captured.head.length, chunk.length);
            captured.head = Buffer.concat([captured.head, chunk.subarray(0, count)]);
            chunk = chunk.subarray(count);
          }
          if (chunk.length) captured.tail = Buffer.concat([captured.tail, chunk]).subarray(-8192);
        });
        child.on("message", message => { result = message; });
        child.on("error", () => stop("WORKSPACE_EXECUTION_UNAVAILABLE"));
        child.stdin.on("error", () => { if (!result && !failure) stop("WORKSPACE_EXECUTION_UNAVAILABLE"); });
        child.on("close", async () => {
          clearTimeout(timer); scope.signal?.removeEventListener("abort", abort); this.active.delete(child);
          let cleanup;
          try { cleanup = await this.#clean(control); }
          catch (error) { reject(error); return; }
          cleanupVerified = true;
          if (failure) { reject(failure); return; }
          try { scope.assertCurrent(); } catch (error) { reject(error); return; }
          if (!result || result.launchFailed || !Number.isInteger(result.exitCode)) { reject(serviceError("WORKSPACE_EXECUTION_UNAVAILABLE", "工作区命令未返回可靠的退出状态")); return; }
          let truncated = false;
          const text = captured => {
            const shortened = captured.bytes > captured.head.length + captured.tail.length;
            let value = shortened ? captured.head.toString("utf8") + "\n[output truncated]\n" + captured.tail.toString("utf8")
              : Buffer.concat([captured.head, captured.tail]).toString("utf8");
            while (Buffer.byteLength(JSON.stringify(value)) > 14000) {
              value = (value.slice(0, Math.floor(value.length / 2) - 256) + "\n[output truncated]\n" + value.slice(-Math.floor(value.length / 2) + 256)).toWellFormed();
              truncated = true;
            }
            truncated ||= shortened;
            return value;
          };
          const stdout = text(output.stdout), stderr = text(output.stderr);
          resolve({ exitCode: result.exitCode, stdout, stderr, outputTruncated: truncated,
            cleanupTerminated: (result.cleanup?.terminated || 0) + cleanup.terminated,
            sandbox: "workspace", network: access?.network ? "approved-for-command" : "denied", cwd,
            ...(access && (access.readPaths.length || access.writePaths.length) ? { approvedAccess: access } : {}) });
        });
        child.stdin.end(JSON.stringify({ parentPid: process.pid, command, cwd, timeoutMs, profile, env, processOwner, marker, guard }));
        if (scope.signal?.aborted) abort();
      });
    } finally {
      // Preserve unresolved ownership markers for the next Service recovery.
      try {
        if (!cleanupVerified) await this.#clean(control);
        fs.rmSync(control, { recursive: true, force: true });
      } catch (error) { this.blockedWorkspaces.add(workspace); throw error; }
      finally { this.controls.delete(control); }
    }
  }
  async verify() {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec") || !this.processOwnerBytes) return false;
    if (this.verified) return this.verified;
    this.verified = (async () => {
      await this.#recover();
      ensurePrivateDirectoryTree(this.cacheDir, this.paths.trustedRoot || path.dirname(this.cacheDir));
      const probe = fs.mkdtempSync(path.join(this.cacheDir, "probe-"));
      const workspace = path.join(probe, "workspace"), outside = path.join(probe, "outside");
      fs.mkdirSync(workspace); fs.writeFileSync(outside, "private-probe");
      const script = `const fs=require('node:fs');let denied=false;try{fs.readFileSync(${q(outside)})}catch(e){denied=['EACCES','EPERM'].includes(e.code)};fs.writeFileSync('ok','ok');require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('late','bad'),5000)"],{detached:true,stdio:'ignore'}).unref();process.stdout.write(JSON.stringify({denied}));`;
      try {
        const result = await this.#launch(`${shellQuote(this.nodeExecutable)} -e ${shellQuote(script)}`,
          workspace, workspace, 3000, { assertCurrent() {} });
        return result.exitCode === 0 && result.cleanupTerminated > 0 && JSON.parse(result.stdout).denied === true
          && fs.readFileSync(path.join(workspace, "ok"), "utf8") === "ok";
      } catch { return false; }
      finally { fs.rmSync(probe, { recursive: true, force: true }); }
    })();
    return this.verified;
  }
  async execute({ contract, run, args, scope }) {
    if (!workspaceAutoExecution(contract) || contract.runId !== run?.id || contract.profileId !== run.profileId
      || contract.workspace !== run.workspace || typeof scope?.assertCurrent !== "function"
      || scope.runId !== run.id || !validWorkspaceExecutionArguments(args)) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
    scope.assertCurrent();
    const release = this.pauseRuntimeTimeout?.({ runId: run.id, profileId: run.profileId, assertCurrent: scope.assertCurrent }) || (() => {});
    if (typeof release !== "function") fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
    const controller = new AbortController(); this.callControllers.add(controller);
    const signal = scope.signal ? AbortSignal.any([scope.signal, controller.signal]) : controller.signal;
    const current = { ...scope, signal, assertCurrent() {
      scope.assertCurrent(); if (signal.aborted) fail("HOST_CAPABILITY_REVOKED");
    } };
    const monitor = setInterval(() => {
      try { scope.assertCurrent(); } catch { controller.abort(); }
    }, 100);
    monitor.unref?.();
    const execution = this.#execute({ contract, run, args, scope: current });
    this.pending.add(execution);
    try { return await execution; }
    finally { clearInterval(monitor); this.callControllers.delete(controller); this.pending.delete(execution); release(); }
  }
  async #execute({ contract, run, args, scope }) {
    const workspace = this.#workspace(contract.workspace);
    if (this.blockedWorkspaces.has(workspace)) fail("WORKSPACE_EXECUTION_CLEANUP_FAILED");
    const access = this.#access(args.access);
    const requestedCwd = path.resolve(workspace, args.cwd || ".");
    let cwd;
    try { cwd = fs.realpathSync(requestedCwd); } catch { fail("WORKSPACE_EXECUTION_SCOPE_INVALID"); }
    if (!inside(cwd, workspace) || !fs.statSync(cwd).isDirectory()) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
    if (widerWorkspaceAccess(args)) {
      if (typeof this.requestApproval !== "function") fail("WORKSPACE_EXECUTION_APPROVAL_REQUIRED");
      const result = await this.requestApproval({ runId: run.id, profileId: run.profileId,
        arguments: { ...args, cwd, effectiveAccess: access }, reason: args.reason,
        signal: scope.signal, assertCurrent: scope.assertCurrent });
      scope.assertCurrent();
      if (result?.approved !== true) fail("WORKSPACE_EXECUTION_APPROVAL_DENIED");
      if (JSON.stringify(this.#access(args.access)) !== JSON.stringify(access)) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
    }
    try {
      await assertWorkspaceLinks(workspace, scope);
      for (const root of access.writePaths) if (fs.existsSync(root)) {
        if (fs.statSync(root).isDirectory()) await assertWorkspaceLinks(root, scope);
        else if (fs.statSync(root).nlink !== 1) fail("WORKSPACE_EXECUTION_SCOPE_INVALID");
      }
    } catch (error) { if (error?.code === "HOST_CAPABILITY_REVOKED") throw error; fail("WORKSPACE_EXECUTION_SCOPE_INVALID"); }
    if (!(await this.verify())) fail("WORKSPACE_EXECUTION_UNAVAILABLE");
    scope.assertCurrent();
    return this.#launch(args.command, workspace, cwd, args.timeoutMs ?? EXECUTION_TIMEOUT_MS, scope, access);
  }
  async close() {
    for (const controller of this.callControllers) controller.abort();
    await Promise.all([...this.active].map(child => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(serviceError("WORKSPACE_EXECUTION_CLEANUP_FAILED", "无法确认工作区命令已停止")), 3000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") { clearTimeout(timer); reject(error); } }
    })));
    await Promise.allSettled([...this.pending]);
    await this.#recover();
  }
}

module.exports = { WorkspaceExecutionService, workspaceExecutionProfile };
