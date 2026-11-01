"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { installerEnvironment } = require("./lark-cli-installer");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { LARK_CLI_PUBLIC_MESSAGES, validLarkVerificationUrl, validateLarkCliResult } = require("../core/lark-cli-contract");

const ACTIVE = new Set(["starting", "configuring", "authorizing"]);
const fail = code => { throw serviceError(code, LARK_CLI_PUBLIC_MESSAGES[code]); };
const empty = () => ({ state: "idle", requestId: null, configured: false, appId: null, brand: null,
  userName: null, verificationUrl: null, userCode: null, qrCode: null, expiresAt: null, warning: null, errorCode: null });
const cleanText = value => typeof value === "string" && value.isWellFormed()
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
function json(value) { try { return JSON.parse(value); } catch { return null; } }
function outputError(result) {
  return json(result.stderr)?.error || json(result.stdout)?.error || null;
}

// Fixed argument vectors only, no shell/PTY and no raw child output in public
// errors or logs. Streaming is used solely for official authorization events.
function runLarkCli(executable, args, { env, cwd, signal, input, onLine = () => {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(serviceError("LARK_CLI_AUTH_CANCELLED", LARK_CLI_PUBLIC_MESSAGES.LARK_CLI_AUTH_CANCELLED));
    let child;
    try { child = spawn(executable, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { return reject(serviceError("LARK_CLI_SETUP_FAILED", LARK_CLI_PUBLIC_MESSAGES.LARK_CLI_SETUP_FAILED)); }
    let bytes = 0, stopped = false, forceTimer;
    const output = { stdout: "", stderr: "" };
    const stop = () => {
      if (stopped) return; stopped = true; child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1500); forceTimer.unref?.();
    };
    const timer = setTimeout(stop, timeoutMs); timer.unref?.();
    const abort = () => stop(); signal?.addEventListener("abort", abort, { once: true });
    for (const kind of ["stdout", "stderr"]) {
      const decoder = new StringDecoder("utf8"); let line = "";
      child[kind].on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) { stop(); return; }
        const text = decoder.write(chunk); output[kind] += text; line += text;
        let index;
        while ((index = line.indexOf("\n")) >= 0) {
          const next = line.slice(0, index); line = line.slice(index + 1);
          try { onLine(kind, next); } catch { stop(); }
        }
      });
      child[kind].on("end", () => { line += decoder.end(); if (line && !stopped) { try { onLine(kind, line); } catch { stop(); } } });
    }
    let spawnError = false;
    child.on("error", () => { spawnError = true; });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(serviceError("LARK_CLI_AUTH_CANCELLED", LARK_CLI_PUBLIC_MESSAGES.LARK_CLI_AUTH_CANCELLED));
      if (stopped || spawnError) return reject(serviceError("LARK_CLI_SETUP_FAILED", LARK_CLI_PUBLIC_MESSAGES.LARK_CLI_SETUP_FAILED));
      resolve({ ...output, exitCode: code });
    });
  });
}

class LarkCliSetupController {
  constructor({ paths, env, getInstallation, run = runLarkCli, now = Date.now } = {}) {
    Object.assign(this, { paths, getInstallation, run, now });
    this.env = installerEnvironment(paths.homeDir, env);
    this.snapshot = empty(); this.operation = null; this.reading = null; this.closed = true;
  }
  get active() { return Boolean(this.operation); }
  open() { this.closed = false; this.snapshot = empty(); }
  stopAdmission() { this.closed = true; this.operation?.abort.abort(); this.operation?.qrAbort.abort(); this.readAbort?.abort(); }
  async close() {
    this.stopAdmission();
    await Promise.allSettled([this.operation?.work, this.reading].filter(Boolean));
  }
  _public() { return validateLarkCliResult("connector.lark.setup.status", { ...this.snapshot }); }
  _installation() {
    const installed = this.getInstallation();
    if (installed.state !== "installed" || !installed.cliPath) fail("LARK_CLI_NOT_INSTALLED");
    return installed;
  }
  async _account(executable, signal, verify = false) {
    const result = await this.run(executable, ["auth", "status", "--json", ...(verify ? ["--verify"] : [])],
      { env: this.env, cwd: this.paths.homeDir, signal, timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      if (outputError(result)?.subtype === "not_configured") return { configured: false, appId: null, brand: null, userName: null, ready: false };
      fail("LARK_CLI_AUTH_STATUS_FAILED");
    }
    const value = json(result.stdout), user = value?.identities?.user;
    if (!value || !cleanText(value.appId) || !["feishu", "lark"].includes(value.brand) || typeof user?.available !== "boolean") fail("LARK_CLI_AUTH_STATUS_FAILED");
    return { configured: true, appId: value.appId, brand: value.brand, userName: cleanText(user.userName),
      ready: user.available && user.verified !== false };
  }
  async status() {
    if (this.active) return this._public();
    const installed = this.getInstallation();
    if (installed.state !== "installed") { this.snapshot = empty(); return this._public(); }
    if (!this.reading) {
      this.readAbort = new AbortController();
      this.reading = (async () => {
        try {
          const { ready, ...account } = await this._account(installed.cliPath, this.readAbort.signal);
          this.snapshot = { ...this.snapshot, ...account };
          if (!this.active && ready) this.snapshot = { ...this.snapshot, state: "ready", errorCode: null };
          else if (!this.active && this.snapshot.state === "ready") this.snapshot.state = "idle";
        } catch { if (!this.active) this.snapshot = { ...this.snapshot, state: "failed", errorCode: "LARK_CLI_AUTH_STATUS_FAILED" }; }
      })().finally(() => { this.reading = null; this.readAbort = null; });
    }
    await this.reading;
    return this._public();
  }
  async handle(method, input) {
    if (this.closed) fail("LARK_CLI_UNAVAILABLE");
    if (method.endsWith(".status")) return this.status();
    if (method.endsWith(".cancel")) {
      const op = this.operation;
      if (op?.id !== input.requestId) fail("LARK_CLI_REVISION_CONFLICT");
      op.abort.abort(); op.qrAbort.abort(); await op.work; return this._public();
    }
    if (this.active) fail("LARK_CLI_BUSY");
    const installed = this._installation();
    if (input.expectedRevision !== installed.revision) fail("LARK_CLI_REVISION_CONFLICT");
    const op = { id: crypto.randomUUID(), abort: new AbortController(), qrAbort: new AbortController(), work: null, qr: new Set() };
    this.operation = op;
    this.snapshot = { ...empty(), state: "starting", requestId: op.id };
    // Retain the secret only in the operation's transient stdin input. It is
    // never a command argument, persisted record, event, or public snapshot.
    op.work = this._connect(op, installed.cliPath, input).catch(error => {
      const code = op.abort.signal.aborted ? "LARK_CLI_AUTH_CANCELLED"
        : Object.hasOwn(LARK_CLI_PUBLIC_MESSAGES, error?.code || "") ? error.code : "LARK_CLI_SETUP_FAILED";
      return { ...this.snapshot, state: code === "LARK_CLI_AUTH_CANCELLED" ? "cancelled" : "failed", errorCode: code,
        verificationUrl: null, userCode: null, qrCode: null, expiresAt: null };
    }).then(async terminal => {
      op.qrAbort.abort();
      await Promise.allSettled([...op.qr]);
      if (this.operation === op) { this.snapshot = terminal; this.operation = null; }
    });
    return this._public();
  }
  _link(op, executable, url, userCode = null, expiresIn = 600) {
    if (!validLarkVerificationUrl(url)) fail("LARK_CLI_AUTH_FAILED");
    if (this.operation !== op || op.abort.signal.aborted || this.snapshot.verificationUrl === url) return;
    this.snapshot = { ...this.snapshot, verificationUrl: url, userCode: cleanText(userCode), qrCode: null,
      expiresAt: this.now() + Math.min(1800, Math.max(1, Number.isSafeInteger(expiresIn) ? expiresIn : 600)) * 1000 };
    const work = this._qrCode(op, executable, url).catch(() => {}).finally(() => op.qr.delete(work));
    op.qr.add(work);
  }
  async _qrCode(op, executable, url) {
    const parent = path.join(this.paths.cacheDir, "lark-cli-setup");
    ensurePrivateDirectoryTree(parent, this.paths.trustedRoot);
    const root = fs.mkdtempSync(path.join(parent, `${op.id}-`));
    const output = path.join(root, "authorization.png");
    try {
      const result = await this.run(executable, ["auth", "qrcode", url, "--size", "256", "--output", output],
        { env: this.env, cwd: root, signal: op.qrAbort.signal, timeoutMs: 45_000 });
      if (result.exitCode !== 0) return;
      const stat = fs.lstatSync(output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 90 * 1024) return;
      const png = fs.readFileSync(output);
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
      if (this.operation === op && !op.abort.signal.aborted && this.snapshot.verificationUrl === url) this.snapshot.qrCode = `data:image/png;base64,${png.toString("base64")}`;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  async _connect(op, executable, input) {
    const signal = op.abort.signal;
    const timer = setTimeout(() => op.abort.abort(), 90 * 60 * 1000); timer.unref?.();
    try {
      await this.reading;
      signal.throwIfAborted();
      const { ready, ...account } = await this._account(executable, signal);
      this.snapshot = { ...this.snapshot, ...account };
      if (account.configured && input.mode === "existing") fail("LARK_CLI_CONFIG_EXISTS");
      if (!account.configured) {
        // A corrupt/missing active profile must not be replaced as if it were a
        // first install. Named init appends and preserves any concurrent app.
        if (fs.existsSync(path.join(this.paths.homeDir, ".lark-cli", "config.json"))) fail("LARK_CLI_AUTH_STATUS_FAILED");
        this.snapshot.state = "configuring";
        const args = ["config", "init", "--brand", input.brand, "--lang", "zh_cn", "--name", `shoggoth-${op.id.slice(0, 8)}`];
        let secret;
        if (input.mode === "existing") { args.push("--app-id", input.appId, "--app-secret-stdin"); secret = `${input.appSecret}\n`; }
        else args.push("--new");
        const configured = await this.run(executable, args, { env: this.env, cwd: this.paths.homeDir, signal, input: secret,
          timeoutMs: 60 * 60 * 1000, onLine: (kind, line) => {
            if (kind !== "stderr") return;
            for (const url of line.match(/https:\/\/[^\s<>\u001b]+/gu) || []) {
              if (validLarkVerificationUrl(url) && new URL(url).pathname === "/page/cli") this._link(op, executable, url);
            }
          } });
        secret = null; input = { mode: input.mode, brand: input.brand };
        if (configured.exitCode !== 0) fail("LARK_CLI_SETUP_FAILED");
        const next = await this._account(executable, signal);
        if (!next.configured) fail("LARK_CLI_SETUP_FAILED");
        if (json(configured.stdout)?.appId !== next.appId) fail("LARK_CLI_CONFIG_EXISTS");
        this.snapshot = { ...this.snapshot, configured: next.configured, appId: next.appId, brand: next.brand };
      } else if (ready && input.mode !== "reauthorize") { return { ...this.snapshot, state: "ready" }; }
      signal.throwIfAborted();
      this.snapshot = { ...this.snapshot, state: "authorizing", verificationUrl: null, userCode: null, qrCode: null, expiresAt: null };
      let complete = false;
      const login = await this.run(executable, ["auth", "login", "--recommend", "--json"], {
        env: this.env, cwd: this.paths.homeDir, signal, timeoutMs: 60 * 60 * 1000,
        onLine: (kind, line) => {
          if (kind !== "stdout") return;
          const event = json(line);
          if (event?.event === "device_authorization") this._link(op, executable, event.verification_uri_complete || event.verification_uri, event.user_code, event.expires_in);
          if (event?.event === "authorization_complete") {
            complete = true;
            if (event.warning?.type === "missing_scope" || event.missing?.length) this.snapshot.warning = "missingScopes";
          }
        },
      });
      signal.throwIfAborted();
      if (login.exitCode !== 0 || !complete) {
        if (this.snapshot.expiresAt && this.now() >= this.snapshot.expiresAt) fail("LARK_CLI_AUTH_EXPIRED");
        fail("LARK_CLI_AUTH_FAILED");
      }
      const { ready: verified, ...connected } = await this._account(executable, signal, true);
      if (!verified) fail("LARK_CLI_AUTH_FAILED");
      return { ...this.snapshot, ...connected, state: "ready", errorCode: null, verificationUrl: null, userCode: null, qrCode: null, expiresAt: null };
    } finally { clearTimeout(timer); }
  }
}

module.exports = { LarkCliSetupController, runLarkCli, ACTIVE };
