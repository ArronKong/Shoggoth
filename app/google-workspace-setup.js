"use strict";

const { execFile, spawn } = require("node:child_process");
const { constants: { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { resolveGoogleWorkspaceCli, signedIn } = require("./agent-service/google-workspace-cli");
const { validateDesktopPreset } = require("./agent-service/mcp-desktop-presets");
const { serviceError } = require("./agent-service/security");
const services = require("./core/google-workspace-services.json");

const runFile = promisify(execFile);
const AUTH_TIMEOUT = 6 * 60_000;
const OUTPUT_LIMIT = 64 * 1024;
const phases = { install: "installing", import: "choosingFile", login: "signingIn", authorizeWrite: "signingIn" };
const enableApisUrl = new URL("https://console.cloud.google.com/flows/enableapi");
enableApisUrl.searchParams.set("apiid", Object.values(services).flat().join(","));

function verifiedCommand(env = process.env) {
  const command = resolveGoogleWorkspaceCli(env);
  validateDesktopPreset(command, [], command);
  return command;
}

async function googleWorkspaceStatus({ resolve = verifiedCommand, run = runFile } = {}) {
  let command;
  try { command = resolve(); }
  catch (error) { if (error.code === "MCP_PACKAGE_RUNTIME_MISSING") return { state: "missing" }; throw error; }
  const { stdout } = await run(command, ["auth", "status"], { timeout: 12000, maxBuffer: OUTPUT_LIMIT, encoding: "utf8" });
  return { state: signedIn(stdout) ? "signedIn" : "signedOut" };
}

async function installGoogleWorkspaceCli({ homeDir, signal, arch = process.arch, run = runFile }) {
  const build = { arm64: "macos_silicon", x64: "macos_intel" }[arch];
  if (process.platform !== "darwin" || !build) throw serviceError("GOOGLE_WORKSPACE_INSTALL_FAILED");
  const bin = path.join(homeDir, ".local", "bin");
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(bin, ".shoggoth-gwscli-"));
  const binary = path.join(staging, "gwscli");
  try {
    await run("/usr/bin/curl", ["--disable", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--max-time", "100",
      "--max-filesize", "67108864", "--output", binary, "https://dl.google.com/workspace-cli/" + build + "/gwscli"],
    { signal, timeout: 110000, maxBuffer: OUTPUT_LIMIT });
    signal.throwIfAborted();
    validateDesktopPreset(binary, [], binary);
    await fs.chmod(binary, 0o755);
    // The destination is shared with a user's manual installation. Never replace it.
    try { await fs.link(binary, path.join(bin, "gwscli")); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function readDesktopClient(file) {
  const invalid = () => serviceError("GOOGLE_WORKSPACE_CLIENT_INVALID");
  let handle;
  try {
    handle = await fs.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > OUTPUT_LIMIT) throw invalid();
    const buffer = Buffer.alloc(stat.size);
    if ((await handle.read(buffer, 0, buffer.length, 0)).bytesRead !== buffer.length) throw invalid();
    const client = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/u, "")).installed;
    if (typeof client?.client_id !== "string" || !/^[0-9A-Za-z_-]{1,180}\.apps\.googleusercontent\.com$/u.test(client.client_id)
      || typeof client.client_secret !== "string" || !/^[!-~]{1,512}$/u.test(client.client_secret)
      || !["https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"].includes(client.auth_uri)
      || !["https://oauth2.googleapis.com/token", "https://accounts.google.com/o/oauth2/token"].includes(client.token_uri)
      || !Array.isArray(client.redirect_uris) || !client.redirect_uris.some(uri => ["http://localhost", "http://localhost/", "http://127.0.0.1", "http://127.0.0.1/"].includes(uri))) throw invalid();
    const { client_id, client_secret, auth_uri } = client;
    return { installed: { client_id, client_secret, auth_uri, token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] } };
  } catch { throw invalid(); }
  finally { await handle?.close(); }
}

async function importDesktopClient(command, file, { env, signal, run }) {
  const credential = await readDesktopClient(file);
  signal.throwIfAborted();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shoggoth-gws-client-"));
  try {
    const chosen = path.join(temp, "client.json");
    await fs.writeFile(chosen, JSON.stringify(credential), { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    const operation = run(command, ["auth", "setup", "--oauth_client_file=" + chosen], {
      cwd: env.HOME, env, signal, timeout: 20000, maxBuffer: OUTPUT_LIMIT, killSignal: "SIGKILL",
    });
    // The explicit Import action and user's native file selection authorize this one local setup.
    operation.child.stdin.on("error", () => {}); operation.child.stdin.end("Y\n");
    await operation;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

function googleAuthorizationUrl(line) {
  const value = line.trim();
  if (!value.startsWith("https://accounts.google.com/") || value.length > 16384) return null;
  try {
    const url = new URL(value);
    if (url.origin !== "https://accounts.google.com" || url.username || url.password || url.hash
      || !["/o/oauth2/v2/auth", "/o/oauth2/auth"].includes(url.pathname)
      || url.searchParams.get("response_type") !== "code" || !url.searchParams.get("state")
      || !url.searchParams.get("code_challenge")) return null;
    const callback = new URL(url.searchParams.get("redirect_uri"));
    return callback.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(callback.hostname)
      && callback.port && !callback.username && !callback.password ? url.href : null;
  } catch { return null; }
}

function signInGoogleWorkspace(command, bundle, { env, signal, openBrowser, spawnChild }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const args = bundle === "readonly" ? ["auth", "login", "--bundle=readonly"] : ["auth", "login"];
    const child = spawnChild(command, args, { cwd: env.HOME, env, signal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, failure, browser, diagnostics = "";
    const stop = code => {
      failure ||= serviceError(code);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("GOOGLE_WORKSPACE_SIGNIN_TIMEOUT"), AUTH_TIMEOUT);
    timer.unref?.();
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8").on("data", chunk => {
        if (failure) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > OUTPUT_LIMIT) { stop("GOOGLE_WORKSPACE_SIGNIN_FAILED"); return; }
        diagnostics += chunk;
        if (browser) return;
        const lines = (pending + chunk).split(/\r?\n/u);
        pending = lines.pop();
        const url = lines.map(googleAuthorizationUrl).find(Boolean);
        if (url) {
          browser = Promise.resolve().then(() => openBrowser(url));
          browser.catch(() => stop("GOOGLE_WORKSPACE_BROWSER_FAILED"));
        }
      });
    }
    child.once("error", error => { failure ||= error; });
    child.once("close", async code => {
      clearTimeout(timer);
      if (!failure && browser) await browser.catch(() => {});
      if (failure) { reject(failure); return; }
      if (code === 0) { resolve(); return; }
      const denied = /access_denied|authorization denied/iu.test(diagnostics);
      reject(serviceError(denied ? "GOOGLE_WORKSPACE_SIGNIN_DENIED" : "GOOGLE_WORKSPACE_SIGNIN_FAILED"));
    });
  });
}

class GoogleWorkspaceSetup {
  constructor({ homeDir = os.homedir(), env = process.env, selectClient, openExternal, onAuthorized,
    run = runFile, spawnChild = spawn, resolve, install = installGoogleWorkspaceCli } = {}) {
    Object.assign(this, { homeDir, env: { ...env, HOME: homeDir }, selectClient, openExternal, onAuthorized, run, spawnChild, install });
    this.resolve = resolve || (() => verifiedCommand(this.env));
  }

  async account() {
    const status = await googleWorkspaceStatus({ resolve: this.resolve, run: (cmd, args, options) => this.run(cmd, args, { ...options, cwd: this.homeDir, env: this.env }) });
    const configured = status.state === "signedIn" || status.state !== "missing"
      && await fs.stat(path.join(this.homeDir, "Library", "Application Support", "gwscli", "client_credentials.json")).then(s => s.isFile(), () => false);
    this.lastAccount = { state: status.state, configured };
    return this.lastAccount;
  }

  async status() {
    const account = this.active ? this.lastAccount || { state: "signedOut", configured: false } : await this.account();
    return { ...account, phase: this.active?.phase, errorCode: this.errorCode, enableApisUrl: enableApisUrl.href };
  }

  start(input) {
    const action = input?.action;
    if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "action")
      || typeof action !== "string" || !(Object.hasOwn(phases, action) || action === "cancel")) {
      throw serviceError("MCP_TOOL_INVALID_ARGUMENTS");
    }
    if (action === "cancel") {
      this.active?.controller.abort();
      return { accepted: true, phase: this.active?.phase };
    }
    if (this.closed || !this.openExternal || action === "import" && !this.selectClient) throw serviceError("GOOGLE_WORKSPACE_DESKTOP_REQUIRED");
    if (this.active) throw serviceError("GOOGLE_WORKSPACE_BUSY");
    this.errorCode = undefined;
    const job = { phase: phases[action], controller: new AbortController() };
    this.active = job;
    void this.perform(action, job).catch(error => {
      if (!job.controller.signal.aborted) this.errorCode = publicGoogleWorkspaceError(error,
        action === "install" ? "GOOGLE_WORKSPACE_INSTALL_FAILED" : "GOOGLE_WORKSPACE_SIGNIN_FAILED");
    }).finally(() => { if (this.active === job) this.active = null; });
    return { accepted: true, phase: phases[action] };
  }

  async perform(action, job) {
    const signal = job.controller.signal;
    if (action === "install") {
      if ((await this.account()).state === "missing") await this.install({ homeDir: this.homeDir, signal, run: this.run });
      this.resolve();
      return;
    }
    const command = this.resolve();
    let file;
    if (action === "import") {
      file = await this.selectClient();
      if (!file) return;
    }
    signal.throwIfAborted();
    const account = await this.account();
    // Existing grants also cover a session that was established while the picker was open.
    if (account.state !== "signedIn" || action === "authorizeWrite") {
      if (file) {
        job.phase = "signingIn";
        await importDesktopClient(command, file, { env: this.env, signal, run: this.run });
      } else if (!account.configured) {
        throw serviceError("GOOGLE_WORKSPACE_CLIENT_REQUIRED");
      }
      await signInGoogleWorkspace(command, action === "authorizeWrite" ? "full" : "readonly", {
        env: this.env, signal, spawnChild: this.spawnChild, openBrowser: async url => {
          signal.throwIfAborted();
          if (!await this.openExternal(url)) throw serviceError("GOOGLE_WORKSPACE_BROWSER_FAILED");
          job.phase = "waitingForConsent";
        },
      });
      if ((await this.account()).state !== "signedIn") throw serviceError("GOOGLE_WORKSPACE_SIGNIN_FAILED");
    }
    signal.throwIfAborted();
    job.phase = "checking";
    try { await this.onAuthorized?.(); }
    catch { throw serviceError("GOOGLE_WORKSPACE_CONNECT_FAILED"); }
  }

  close() {
    this.closed = true;
    this.active?.controller.abort();
  }
}

function publicGoogleWorkspaceError(error, fallback = "MCP_SERVER_CONNECTION_FAILED") {
  const code = error?.code;
  return ["MCP_TOOL_INVALID_ARGUMENTS", "MCP_SERVER_PATH_INVALID", "MCP_PACKAGE_RUNTIME_MISSING",
    "GOOGLE_WORKSPACE_DESKTOP_REQUIRED", "GOOGLE_WORKSPACE_BUSY", "GOOGLE_WORKSPACE_CLIENT_REQUIRED",
    "GOOGLE_WORKSPACE_CLIENT_INVALID", "GOOGLE_WORKSPACE_INSTALL_FAILED", "GOOGLE_WORKSPACE_SIGNIN_FAILED",
    "GOOGLE_WORKSPACE_SIGNIN_TIMEOUT", "GOOGLE_WORKSPACE_SIGNIN_DENIED", "GOOGLE_WORKSPACE_BROWSER_FAILED",
    "GOOGLE_WORKSPACE_CONNECT_FAILED"].includes(code) ? code : fallback;
}

module.exports = { GoogleWorkspaceSetup, googleWorkspaceStatus, publicGoogleWorkspaceError };
