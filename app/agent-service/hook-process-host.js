"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { HOOK_LIMITS, dataAccess, safeJson, fail } = require("./hook-contract");
const { defaultProcessIdentity, defaultProcessIsAlive } = require("./private-writer-lease");
const quote = value => JSON.stringify(value);
function moduleManifest(worker) {
  // Node 24 consults the nearest package.json when loading a .js entry point.
  // Authorize only that public module descriptor, never its directory.
  if (!worker.endsWith(".js")) return null;
  for (let parent = path.dirname(worker); ; parent = path.dirname(parent)) {
    const target = path.join(parent, "package.json");
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail("HOOK_SANDBOX_UNAVAILABLE");
      return fs.realpathSync(target);
    }
    if (path.dirname(parent) === parent) return null;
  }
}
function sandboxProfile({ interpreter, worker, sourceFile, workspace, access, scratch }) {
  const reads = ["/System", "/usr/lib", "/usr/share", "/private/etc", "/private/var/db/timezone"];
  const bundle = /^(.*[.]app\/Contents)\/MacOS\/[^/]+$/u.exec(interpreter)?.[1];
  const manifest = moduleManifest(worker);
  if (bundle) reads.push(path.join(bundle, "Frameworks"));
  const rules = ["(version 1)", "(deny default)", "(allow process-exec (literal " + quote(interpreter) + "))",
    "(allow sysctl-read)", "(allow file-read-metadata)",
    "(allow file-read* " + reads.map(root => "(subpath " + quote(root) + ")").join(" ") +
      " (literal \"/\") (literal " + quote(interpreter) + ") (literal " + quote(worker) + ")" +
      (sourceFile ? " (literal " + quote(sourceFile) + ")" : "") +
      (manifest ? " (literal " + quote(manifest) + ")" : "") +
      " (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-read* file-write* (subpath " + quote(scratch) + "))",
    "(allow file-write* (literal \"/dev/null\"))",
  ];
  if (access.workspaceRead) rules.push("(allow file-read* (subpath " + quote(workspace) + "))");
  if (access.workspaceWrite) rules.push("(allow file-write* (subpath " + quote(workspace) + "))");
  // No network, mach lookup, process-fork, other executable, credentials or
  // Service socket access. Descendants cannot escape the timeout process group.
  return rules.join("\n");
}
function workerPath(name) {
  const file = path.join(__dirname, name);
  return file.includes(".asar/") ? file.replace(".asar/", ".asar.unpacked/") : file;
}
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
function assertHookWorkspace(workspace, paths, simulation) {
  if (simulation) return;
  const home = os.homedir();
  const protectedRoots = [paths.profileDir, paths.runtimeDir, path.join(home, ".codex"), path.join(home, ".claude"),
    path.join(home, ".pi"), path.join(home, ".hermes"), path.join(home, ".openclaw"),
    path.join(home, ".config", "opencode"), path.join(home, "Library", "Keychains")].filter(Boolean);
  if (protectedRoots.some(root => inside(workspace, root) || inside(root, workspace))) fail("HOOK_WORKSPACE_FORBIDDEN");
  if (paths.stateDir && (inside(paths.stateDir, workspace)
    || inside(workspace, paths.stateDir) && (!paths.defaultWorkspaceDir || !inside(workspace, paths.defaultWorkspaceDir)))) fail("HOOK_WORKSPACE_FORBIDDEN");
}
class HookProcessHost {
  constructor({ store, cacheDir, nodeExecutable = process.execPath, pythonExecutable, sandboxExecutable = "/usr/bin/sandbox-exec" }) {
    this.store = store; this.cacheDir = cacheDir; this.nodeExecutable = fs.realpathSync(nodeExecutable);
    this.pythonExecutable = pythonExecutable ? fs.realpathSync(pythonExecutable) : null;
    this.sandboxExecutable = sandboxExecutable; this.children = new Set(); this.verified = false; this.pythonVerified = false; this.closed = false;
  }
  available(language = "javascript") {
    return this.verified && !this.closed && process.platform === "darwin"
      && fs.existsSync(this.sandboxExecutable) && (language === "javascript" || language === "python" && this.pythonVerified);
  }
  open() { if (this.children.size) fail("HOOK_CAPACITY"); this.closed = false; }
  async verify() {
    if (process.platform !== "darwin" || !fs.existsSync(this.sandboxExecutable)) return false;
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    const scratch = fs.mkdtempSync(path.join(this.cacheDir, "probe-"));
    const canary = path.join(scratch, "denied.txt");
    const allowed = path.join(scratch, "allowed");
    fs.mkdirSync(allowed, { mode: 0o700 }); fs.writeFileSync(canary, "private-probe", { mode: 0o600 });
    const script = "const fs=require('node:fs');let denied=false;try{fs.readFileSync(" + quote(canary) +
      ")}catch(e){denied=e.code==='EPERM'||e.code==='EACCES'};fs.writeFileSync(" + quote(path.join(allowed, "ok")) +
      ",'ok');process.stdout.write(JSON.stringify({denied}));";
    try {
      this.verified = false; this.pythonVerified = false;
      const profile = sandboxProfile({ interpreter: this.nodeExecutable, worker: this.nodeExecutable,
        workspace: null, access: {}, scratch: allowed });
      const result = await this.launch(this.nodeExecutable, ["-e", script], profile, "", allowed, 2000);
      this.verified = result?.denied === true && fs.existsSync(path.join(allowed, "ok"));
      if (this.verified && this.pythonExecutable) {
        const python = "import json\ndenied=False\ntry:\n open(" + quote(canary) + ", 'rb').read()\nexcept PermissionError:\n denied=True\nwith open(" + quote(path.join(allowed, "python-ok")) + ", 'w') as f:\n f.write('ok')\nprint(json.dumps({'denied': denied}))";
        const pythonProfile = sandboxProfile({ interpreter: this.pythonExecutable, worker: this.pythonExecutable,
          workspace: null, access: {}, scratch: allowed });
        try {
          const result = await this.launch(this.pythonExecutable, ["-I", "-B", "-c", python], pythonProfile, "", allowed, 2000);
          this.pythonVerified = result?.denied === true && fs.existsSync(path.join(allowed, "python-ok"));
        } catch (error) { this.lastPythonProbeError = error.code || "HOOK_SANDBOX_UNAVAILABLE"; }
      }
      return this.verified;
    } catch (error) { this.lastProbeError = error.code || "HOOK_SANDBOX_UNAVAILABLE"; this.verified = false; return false; }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  async run(definition, event, { signal, assertCurrent = () => {}, workspace = event.workspace, simulation = false, remainingMs, onDispatch, sourceFile: trustedSourceFile } = {}) {
    const language = definition.handler.language || "javascript";
    if (!this.available(language)) fail("HOOK_SANDBOX_UNAVAILABLE");
    if (this.children.size >= HOOK_LIMITS.workers) fail("HOOK_CAPACITY");
    assertCurrent(); if (signal?.aborted) fail("HOOK_CANCELED");
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    const access = dataAccess(definition);
    if ((access.workspaceRead || access.workspaceWrite) && (!workspace || fs.realpathSync(workspace) !== workspace)) fail("HOOK_WORKSPACE_INVALID");
    if (access.workspaceRead || access.workspaceWrite) assertHookWorkspace(workspace, this.store.paths, simulation);
    const builtin = definition.handler.type === "builtin";
    const sourceFile = builtin ? null : trustedSourceFile || this.store.sourcePath(definition);
    const worker = workerPath(language === "python" ? "hook-worker.py" : "hook-worker.js");
    const interpreter = language === "python" ? this.pythonExecutable : this.nodeExecutable;
    const scratch = fs.mkdtempSync(path.join(this.cacheDir, "worker-"));
    try {
      const profile = sandboxProfile({ interpreter, worker, sourceFile, workspace, access, scratch });
      const input = safeJson({ event, workspace, ...(builtin ? { builtin: definition.handler.name, config: definition.handler.config }
        : { sourceFile, sourceDigest: require("node:crypto").createHash("sha256").update(definition.handler.source).digest("hex"),
          ...(definition.handler.compatibility ? { compatibility: definition.handler.compatibility } : {}) }) });
      const output = await this.launch(interpreter, language === "python" ? ["-I", "-B", worker] : [worker], profile,
        JSON.stringify(input), scratch, Math.max(1, Math.min(definition.timeoutMs, simulation ? HOOK_LIMITS.testMs : Infinity, remainingMs ?? Infinity)), signal, onDispatch);
      assertCurrent(); return output;
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  launch(interpreter, args, profile, input, scratch, timeoutMs, signal, onDispatch) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(Object.assign(new Error("Hook host closed"), { code: "HOOK_CANCELED" })); return; }
      const env = { PATH: path.dirname(interpreter), HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8", TZ: "UTC",
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
      const child = spawn(this.nodeExecutable, [workerPath("hook-supervisor.js")], {
        cwd: scratch, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child); let stdout = Buffer.alloc(0), stderrBytes = 0, failure = null;
      const stop = code => {
        failure ||= Object.assign(new Error(code), { code });
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure.code = "HOOK_CLEANUP_UNVERIFIED"; }
      };
      const abort = () => stop("HOOK_CANCELED");
      const timer = setTimeout(() => stop("HOOK_TIMEOUT"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => {
        if (stdout.length + chunk.length > HOOK_LIMITS.outputBytes) stop("HOOK_OUTPUT_CAPACITY");
        else stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > HOOK_LIMITS.stderrBytes) stop("HOOK_OUTPUT_CAPACITY"); });
      child.on("error", () => stop("HOOK_WORKER_UNAVAILABLE"));
      child.stdin.on("error", () => { if (!failure) stop("HOOK_WORKER_FAILED"); });
      child.on("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.children.delete(child);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(Object.assign(new Error("Hook worker failed"), { code: "HOOK_WORKER_FAILED" })); return; }
        try { resolve(safeJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)), HOOK_LIMITS.outputBytes)); }
        catch { reject(Object.assign(new Error("Invalid Hook output"), { code: "HOOK_OUTPUT_INVALID" })); }
      });
      try {
        if (onDispatch) {
          const startIdentity = defaultProcessIdentity(child.pid);
          if (!startIdentity) fail("HOOK_CLEANUP_UNVERIFIED");
          onDispatch({ workerPid: child.pid, workerStartIdentity: startIdentity });
        }
        child.stdin.end(JSON.stringify({ parentPid: process.pid, sandboxExecutable: this.sandboxExecutable,
          profile, interpreter, args, input, scratch, timeoutMs, env }));
      } catch (error) { stop(error.code || "HOOK_WORKER_FAILED"); }
      if (signal?.aborted) abort();
    });
  }
  async recoverWorkers() {
    for (const item of this.store?.workersForRecovery?.() || []) {
      if (!defaultProcessIsAlive(item.workerPid)) continue;
      const identity = defaultProcessIdentity(item.workerPid);
      if (!identity) fail("HOOK_CLEANUP_UNVERIFIED");
      if (identity !== item.workerStartIdentity) continue;
      let processInfo;
      try { processInfo = execFileSync("/bin/ps", ["-o", "pgid=", "-o", "args=", "-p", String(item.workerPid)],
        { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { if (defaultProcessIsAlive(item.workerPid)) fail("HOOK_CLEANUP_UNVERIFIED"); else continue; }
      const match = /^(\d+)\s+(.+)$/u.exec(processInfo);
      if (Number(match?.[1]) !== item.workerPid || match?.[2] !== this.nodeExecutable + " " + workerPath("hook-supervisor.js")) fail("HOOK_CLEANUP_UNVERIFIED");
      try { process.kill(-item.workerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") fail("HOOK_CLEANUP_UNVERIFIED"); }
      const until = Date.now() + 2000;
      while (defaultProcessIsAlive(item.workerPid) && defaultProcessIdentity(item.workerPid) === identity) {
        if (Date.now() >= until) fail("HOOK_CLEANUP_UNVERIFIED");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  async close() {
    this.closed = true;
    const children = [...this.children];
    await Promise.all(children.map(child => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("Hook cleanup unverified"), { code: "HOOK_CLEANUP_UNVERIFIED" })), 2000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.once("close", done);
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if (error.code === "ESRCH" && !defaultProcessIsAlive(child.pid)) done();
        else { clearTimeout(timer); reject(Object.assign(new Error("Hook cleanup unverified"), { code: "HOOK_CLEANUP_UNVERIFIED" })); }
      }
    })));
    if (this.children.size) fail("HOOK_CLEANUP_UNVERIFIED");
  }
}
module.exports = { HookProcessHost, sandboxProfile, assertHookWorkspace };
