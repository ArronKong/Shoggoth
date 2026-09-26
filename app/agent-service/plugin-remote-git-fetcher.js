"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { assertPrivateDirectory, serviceError } = require("./security");

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const fail = (code = "GIT_SOURCE_INVALID") => { throw serviceError(code, "远程固定 Git 来源无法安全读取"); };
const inside = (root, value) => value === root || (value.startsWith(`${root}${path.sep}`));

function identifyRemoteGitSource(input) {
  if (!input || typeof input.repositoryUrl !== "string" || input.repositoryUrl.length > 2048
    || !input.repositoryUrl.isWellFormed() || /[\x00-\x20\x7f]/u.test(input.repositoryUrl)
    || typeof input.commit !== "string" || !SHA.test(input.commit)) fail();
  let url;
  try { url = new URL(input.repositoryUrl); } catch { fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.hostname || url.pathname === "/" || /%00|%0a|%0d/iu.test(url.href)) fail();
  const subdir = input.subdir === undefined || input.subdir === null || input.subdir === "." ? "" : input.subdir;
  if (typeof subdir !== "string" || subdir.length > 512 || !subdir.isWellFormed()
    || subdir.startsWith("-") || subdir.startsWith(":")
    || subdir.includes("\\") || /[\x00-\x1f\x7f]/u.test(subdir)
    || (subdir && subdir.split("/").some(part => !part || part === "." || part === ".."))) fail();
  const repositoryUrl = url.href;
  return Object.freeze({ repositoryUrl, commit: input.commit, subdir,
    sourceIdentity: `remote-git:${repositoryUrl}#${input.commit}:${subdir || "."}` });
}

function repositoryBytes(root, maximum) {
  let total = 0; let count = 0;
  const pending = [root];
  while (pending.length) {
    const item = pending.pop();
    let stat;
    try { stat = fs.lstatSync(item); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (++count > 8192 || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail("GIT_REMOTE_TOO_LARGE");
    if (stat.isDirectory()) {
      let names;
      try { names = fs.readdirSync(item); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const name of names) pending.push(path.join(item, name));
    } else total += stat.size;
    if (total > maximum) fail("GIT_REMOTE_TOO_LARGE");
  }
  return total;
}

// This is an explicitly-consented Service intake, never a repository hook or
// package dependency installer. No checkout, remote config, credential helper,
// submodule/LFS hydration or package executable is used. Every fetch owns a new
// disposable repository; its random cache path is never source authority.
class PluginRemoteGitFetcher {
  #jobs = new Set();
  #leases = new Set();
  #aborts = new Set();
  #closed = false;
  #exitUnknown = false;

  constructor({ paths, gitExecutable = process.platform === "darwin" ? "/usr/bin/git" : "/usr/bin/git",
    spawnImpl = spawn, timeoutMs = 30_000, maxRepositoryBytes = 64 * 1024 * 1024,
    maxLogBytes = 64 * 1024, pollMs = 25, killGraceMs = 1000 } = {}) {
    if (!paths?.pluginStagingDir || !paths.trustedRoot || !path.isAbsolute(gitExecutable)
      || typeof spawnImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000
      || !Number.isSafeInteger(maxRepositoryBytes) || maxRepositoryBytes < 1024 || maxRepositoryBytes > 128 * 1024 * 1024
      || !Number.isSafeInteger(maxLogBytes) || maxLogBytes < 256 || maxLogBytes > 128 * 1024
      || !Number.isSafeInteger(pollMs) || pollMs < 5 || pollMs > 100
      || !Number.isSafeInteger(killGraceMs) || killGraceMs < 10 || killGraceMs > 2000) {
      throw new TypeError("Private remote Git fetcher configuration required");
    }
    Object.assign(this, { paths, gitExecutable, spawnImpl, timeoutMs, maxRepositoryBytes,
      maxLogBytes, pollMs, killGraceMs });
  }

  fetch(input, { signal } = {}) {
    const pending = this.#fetch(input, signal);
    this.#jobs.add(pending);
    void pending.finally(() => this.#jobs.delete(pending)).catch(() => {});
    return pending;
  }

  async #fetch(input, signal) {
    const source = identifyRemoteGitSource(input);
    if (this.#closed || signal?.aborted) fail("GIT_REMOTE_CANCELLED");
    if (this.#exitUnknown) fail("GIT_REMOTE_EXIT_UNKNOWN");
    if (this.#jobs.size >= 4 || this.#jobs.size + this.#leases.size >= 8) fail("GIT_REMOTE_LIMIT");
    const staging = fs.realpathSync(this.paths.pluginStagingDir);
    const trusted = fs.realpathSync(this.paths.trustedRoot);
    if (!inside(trusted, staging)) fail();
    for (let current = staging;; current = path.dirname(current)) {
      assertPrivateDirectory(current);
      if (current === trusted) break;
    }
    const temporary = fs.mkdtempSync(path.join(staging, "remote-git-"));
    fs.chmodSync(temporary, 0o700);
    const repo = path.join(temporary, "repository");
    const privateHome = path.join(temporary, "home");
    const template = path.join(temporary, "empty-template");
    for (const directory of [repo, privateHome, template]) fs.mkdirSync(directory, { mode: 0o700 });
    const controller = new AbortController();
    const effectiveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.#aborts.add(controller);
    let exitUnknown = false;
    const remove = () => {
      const stat = fs.lstatSync(temporary);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(temporary) !== temporary) fail();
      fs.rmSync(temporary, { recursive: true, force: true });
    };
    try {
      const environment = { PATH: "/usr/bin:/bin", HOME: privateHome, XDG_CONFIG_HOME: privateHome,
        LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_LFS_SKIP_SMUDGE: "1",
        GIT_ALLOW_PROTOCOL: "https", GIT_PROTOCOL_FROM_USER: "0" };
      const config = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.attributesFile=/dev/null",
        "credential.helper=", "credential.interactive=false", "protocol.allow=never", "protocol.https.allow=always",
        "http.followRedirects=false", "http.sslVerify=true", "http.proxy=", "fetch.recurseSubmodules=false",
        "fetch.fsckObjects=true", "transfer.fsckObjects=true", "fetch.unpackLimit=0", "transfer.unpackLimit=0",
        "gc.auto=0", "maintenance.auto=false", "submodule.recurse=false"];
      const common = [...config.flatMap(value => ["-c", value]), "-C", repo];
      await this.#run([...common, "init", "--quiet", `--template=${template}`,
        `--object-format=${source.commit.length === 64 ? "sha256" : "sha1"}`], temporary, environment, effectiveSignal);
      await this.#run([...common, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules",
        "--no-write-fetch-head", "--", source.repositoryUrl, source.commit], temporary, environment, effectiveSignal);
      if (effectiveSignal.aborted || this.#closed) fail("GIT_REMOTE_CANCELLED");
      repositoryBytes(temporary, this.maxRepositoryBytes);
      let released = false;
      const lease = Object.freeze({ repositoryPath: repo, commit: source.commit, subdir: source.subdir,
        sourceIdentity: source.sourceIdentity,
        release: async () => {
          if (released) return;
          remove(); released = true; this.#leases.delete(lease);
        } });
      this.#leases.add(lease);
      return lease;
    } catch (error) {
      exitUnknown = error?.code === "GIT_REMOTE_EXIT_UNKNOWN";
      if (exitUnknown) this.#exitUnknown = true;
      if (!exitUnknown) remove();
      throw error;
    } finally { this.#aborts.delete(controller); }
  }

  #run(args, root, environment, signal) {
    if (signal.aborted) return Promise.reject(serviceError("GIT_REMOTE_CANCELLED", "远程 Git 获取已取消"));
    return new Promise((resolve, reject) => {
      // POSIX shell provides RLIMIT_FSIZE without interpolating a URL, SHA or
      // path into code. Units are at most 1024 bytes on supported platforms;
      // division by 1024 is conservative on shells using 512-byte blocks.
      // The aggregate limit is polled and may overshoot between 25 ms checks;
      // the per-file kernel limit is independent of that polling interval.
      const script = 'umask 077; ulimit -f "$1" || exit 72; shift; exec "$@"';
      let child;
      try { child = this.spawnImpl("/bin/sh", ["-c", script, "shoggoth-git-worker",
        String(Math.floor(this.maxRepositoryBytes / 1024)), this.gitExecutable, ...args],
      { cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch { reject(serviceError("GIT_REMOTE_FAILED", "远程 Git 进程无法启动")); return; }
      let failure = null; let logs = 0; let closed = false; let killTimer; let exitTimer;
      const kill = signalName => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signalName); }
        catch (error) { if (error.code !== "ESRCH") { try { child.kill(signalName); } catch { /* close remains required */ } } }
      };
      const stop = code => {
        if (closed || failure) return;
        failure = serviceError(code, "远程 Git 获取被安全限制中止");
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), this.killGraceMs);
        exitTimer = setTimeout(() => {
          if (closed) return;
          cleanup(); reject(serviceError("GIT_REMOTE_EXIT_UNKNOWN", "远程 Git 进程退出未确认，暂存目录已保留"));
        }, this.killGraceMs + 5000);
      };
      const timeout = setTimeout(() => stop("GIT_REMOTE_TIMEOUT"), this.timeoutMs);
      const poll = setInterval(() => {
        try { repositoryBytes(root, this.maxRepositoryBytes); }
        catch { stop("GIT_REMOTE_TOO_LARGE"); }
      }, this.pollMs);
      const onAbort = () => stop("GIT_REMOTE_CANCELLED");
      const cleanup = () => {
        clearTimeout(timeout); clearInterval(poll); clearTimeout(killTimer); clearTimeout(exitTimer);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
        logs += chunk.length;
        if (logs > this.maxLogBytes) stop("GIT_REMOTE_LOG_LIMIT");
      });
      child.once("error", () => { failure ||= serviceError("GIT_REMOTE_FAILED", "远程 Git 进程无法启动"); });
      child.once("close", async (code, exitSignal) => {
        closed = true; cleanup();
        // A reaped group leader is insufficient if a Git transport/index-pack
        // child survived. Confirm the entire process group before any cleanup.
        if (child.pid) {
          const deadline = Date.now() + 2000;
          let gone = false;
          while (!gone && Date.now() < deadline) {
            try { process.kill(-child.pid, 0); kill("SIGKILL"); }
            catch (error) { if (error.code === "ESRCH") gone = true; }
            if (!gone) await new Promise(resolve => setTimeout(resolve, 10));
          }
          if (!gone) { reject(serviceError("GIT_REMOTE_EXIT_UNKNOWN", "Git 进程组退出未确认，暂存目录已保留")); return; }
        }
        if (failure) reject(failure);
        else if (exitSignal === "SIGXFSZ") reject(serviceError("GIT_REMOTE_TOO_LARGE", "远程 Git 文件超过内核容量限制"));
        else if (code !== 0 || exitSignal) reject(serviceError("GIT_REMOTE_FAILED", "远程固定 Git 获取失败"));
        else resolve();
      });
      if (signal.aborted) onAbort();
    });
  }

  async close() {
    this.#closed = true;
    for (const controller of this.#aborts) controller.abort();
    const jobs = await Promise.allSettled([...this.#jobs]);
    if (this.#exitUnknown || jobs.some(result => result.status === "rejected" && result.reason?.code === "GIT_REMOTE_EXIT_UNKNOWN")) {
      fail("GIT_REMOTE_EXIT_UNKNOWN");
    }
    await Promise.all([...this.#leases].map(lease => lease.release()));
  }
}

module.exports = { PluginRemoteGitFetcher, identifyRemoteGitSource };
