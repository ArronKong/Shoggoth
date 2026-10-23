"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { atomicWritePrivateFile, fsyncPrivateParent, readPrivateFile,
  validatePrivateStat, writeFully } = require("./private-file");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { READ_TOOLS, ORDINARY_WRITE_TOOLS, SEND_TOOLS } =
  require("./plugin-gogcli-gmail-sidecar");

// Keep hashes in the signed Service code. The separately packaged manifest is
// provenance, never authority for accepting a replacement executable.
const PINNED_BINARY_SHA256 = Object.freeze({
  arm64: "39c0db09b1dcfbe12662d9de58c69d67d6520a77cafdc34e28dad0120f57bf19",
  x64: "5a5cbdabafda5eb7ccb8ff24eb4c54fc20f954aa40181cbdb769a7f7290f05bb",
});
// Codesign replaces the embedded signature and adjusts only these three
// Mach-O size fields. Pin the executable payload independently of its final
// App signing identity; the source archive is still checked by full SHA256.
const PINNED_PAYLOAD_SHA256 = Object.freeze({
  arm64: "b0e46bd2809a838afa16be46435b917aa50d1e953c388be6fa850240c1195b07",
  x64: "ce415e234bfd3f15b0a3817e221f57be5686e05516dc21b1943e20836eb1f66e",
});
const CLIENT = "shoggoth";
const EMAIL = /^[^\s@\x00-\x1f]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/u;
const MACH_CPU = { arm64: 0x0100000c, x64: 0x01000007 };
const MAX_OUTPUT = 64 * 1024;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code, message) => { throw serviceError(code, message); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function gogPayloadDigest(bytes, arch) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4096 || bytes.length > 100 * 1024 * 1024
    || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== MACH_CPU[arch]) {
    fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O 结构无效");
  }
  const count = bytes.readUInt32LE(16), commandsSize = bytes.readUInt32LE(20);
  if (count < 2 || count > 128 || commandsSize > 32768 || 32 + commandsSize > bytes.length) {
    fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O load commands 无效");
  }
  let at = 32, linkedit = null, signature = null;
  for (let index = 0; index < count; index += 1) {
    if (at + 8 > 32 + commandsSize) fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O load commands 截断");
    const command = bytes.readUInt32LE(at), size = bytes.readUInt32LE(at + 4);
    if (size < 8 || at + size > 32 + commandsSize) {
      fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O load command 大小无效");
    }
    if (command === 0x19 && size >= 72
      && bytes.subarray(at + 8, at + 24).toString("ascii").replace(/\0.*$/u, "") === "__LINKEDIT") {
      if (linkedit) fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O LINKEDIT 重复");
      linkedit = at;
    }
    if (command === 0x1d && size === 16) {
      if (signature) fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O 签名命令重复");
      signature = at;
    }
    at += size;
  }
  if (at !== 32 + commandsSize || linkedit === null || signature === null) {
    fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O 签名结构缺失");
  }
  const signatureOffset = bytes.readUInt32LE(signature + 8);
  const signatureSize = bytes.readUInt32LE(signature + 12);
  const linkeditOffset = Number(bytes.readBigUInt64LE(linkedit + 40));
  const linkeditSize = Number(bytes.readBigUInt64LE(linkedit + 48));
  if (signatureOffset < 32 + commandsSize || signatureOffset <= linkeditOffset
    || signatureSize < 256 || signatureSize > 1024 * 1024
    || signatureOffset + signatureSize !== bytes.length
    || linkeditOffset + linkeditSize !== bytes.length) {
    fail("GMAIL_RUNTIME_UNAVAILABLE", "gog Mach-O 签名范围无效");
  }
  const payload = Buffer.from(bytes.subarray(0, signatureOffset));
  payload.fill(0, linkedit + 32, linkedit + 40); // __LINKEDIT.vmsize
  payload.fill(0, linkedit + 48, linkedit + 56); // __LINKEDIT.filesize
  payload.fill(0, signature + 12, signature + 16); // LC_CODE_SIGNATURE.datasize
  return digest(payload);
}

function verifiedGogBinary({ packaged = false, resourcesPath = process.resourcesPath,
  repoRoot = path.join(__dirname, "..", ".."), arch = process.arch } = {}) {
  const expectedSha = PINNED_BINARY_SHA256[arch];
  if (process.platform !== "darwin" || !expectedSha || !MACH_CPU[arch]) {
    fail("GMAIL_RUNTIME_UNAVAILABLE", "Gmail gog 运行平台不可用");
  }
  const binary = packaged ? path.join(resourcesPath, "gogcli", "gog")
    : path.join(repoRoot, ".vendor", "gogcli", arch, "gog");
  let fd;
  try {
    const before = fs.lstatSync(binary);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 8 || before.size > 100 * 1024 * 1024 || (before.mode & 0o111) === 0) {
      fail("GMAIL_RUNTIME_UNAVAILABLE", "gog 可执行文件不安全");
    }
    fd = fs.openSync(binary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail("GMAIL_RUNTIME_UNAVAILABLE", "gog 可执行文件已变化");
    }
    const bytes = fs.readFileSync(fd);
    const payloadDigest = gogPayloadDigest(bytes, arch);
    const valid = packaged ? payloadDigest === PINNED_PAYLOAD_SHA256[arch]
      : digest(bytes) === expectedSha;
    if (!valid) {
      fail("GMAIL_RUNTIME_UNAVAILABLE", "gog 可执行文件未通过固定版本校验");
    }
    if (packaged) {
      const signature = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binary],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 });
      if (signature.error || signature.status !== 0) {
        fail("GMAIL_RUNTIME_UNAVAILABLE", "gog 打包签名校验失败");
      }
    }
    const after = fs.lstatSync(binary);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      fail("GMAIL_RUNTIME_UNAVAILABLE", "gog 可执行文件校验期间已变化");
    }
    return binary;
  } catch (error) {
    if (error?.code === "GMAIL_RUNTIME_UNAVAILABLE") throw error;
    fail("GMAIL_RUNTIME_UNAVAILABLE", "gog 可执行文件不可用");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readSelectedDesktopClient(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("GMAIL_REGISTRATION_INVALID", "OAuth 客户端路径无效");
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > 64 * 1024) fail("GMAIL_REGISTRATION_INVALID", "OAuth 客户端文件无效");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail("GMAIL_REGISTRATION_INVALID", "OAuth 客户端文件已变化");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) fail("GMAIL_REGISTRATION_INVALID", "OAuth 客户端文件已变化");
    const parsed = JSON.parse(bytes.toString("utf8"));
    const client = parsed?.installed;
    if (!exact(parsed, ["installed"]) || !client || typeof client !== "object"
      || typeof client.client_id !== "string" || !client.client_id.endsWith(".apps.googleusercontent.com")
      || typeof client.client_secret !== "string" || client.client_secret.length < 4
      || client.client_secret.length > 4096
      || !Array.isArray(client.redirect_uris)
      || !client.redirect_uris.some(uri => typeof uri === "string"
        && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/u.test(uri))) {
      fail("GMAIL_REGISTRATION_INVALID", "仅支持 Google Desktop OAuth 客户端 JSON");
    }
    return { bytes, clientIdDigest: digest(client.client_id) };
  } catch (error) {
    if (error?.code === "GMAIL_REGISTRATION_INVALID") throw error;
    fail("GMAIL_REGISTRATION_INVALID", "OAuth 客户端 JSON 不可读取或无效");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function runGog(binary, args, { input = null, timeoutMs = 15_000, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: process.env.HOME || "", PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR || "/tmp", LANG: "en_US.UTF-8" } });
    let settled = false, output = "", errors = "", timer, hardTimer, terminationError = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(hardTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const terminate = error => {
      if (terminationError || settled) return;
      terminationError = error;
      child.kill("SIGTERM");
      hardTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const abort = () => terminate(serviceError("GMAIL_AUTH_CANCELED", "Gmail 登录已取消"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => terminate(serviceError("GMAIL_AUTH_FAILED", "gog 操作超时")), timeoutMs);
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => { output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) terminate(serviceError("GMAIL_AUTH_FAILED", "gog 输出超过容量限制")); });
    child.stderr.on("data", chunk => { errors += chunk.toString("utf8");
      if (errors.length > MAX_OUTPUT) terminate(serviceError("GMAIL_AUTH_FAILED", "gog 输出超过容量限制")); });
    child.on("error", () => finish(serviceError("GMAIL_AUTH_FAILED", "无法启动 gog")));
    child.on("close", code => finish(terminationError || (code === 0 ? null
      : serviceError("GMAIL_AUTH_FAILED", "gog 操作未成功")), output));
    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

class GogGmailRuntime {
  #configuring = false;
  #authorizing = false;
  #pendingCommitUncertain = false;
  #pendingCommitEmail = null;

  constructor({ paths, packaged = false, resourcesPath, repoRoot, arch, run = runGog } = {}) {
    if (!paths?.pluginsDir || !paths.trustedRoot || typeof run !== "function") {
      throw new TypeError("GogGmailRuntime requires private Service paths");
    }
    Object.assign(this, { paths, packaged, resourcesPath, repoRoot, arch, run });
    this.home = path.join(paths.pluginsDir, "gogcli");
    this.registrationFile = path.join(this.home, "registration.json");
    this.capabilitiesFile = path.join(this.home, "capabilities.json");
    this.pendingAuthFile = path.join(this.home, "auth-pending.json");
  }

  binary() { return verifiedGogBinary(this); }
  #privateHome() { ensurePrivateDirectoryTree(this.home, this.paths.trustedRoot); return this.home; }
  #registration() {
    try {
      const value = JSON.parse(readPrivateFile(this.registrationFile, { maxBytes: 4096 }).toString("utf8"));
      if (!exact(value, ["version", "clientIdDigest"]) || value.version !== 1
        || !/^[a-f0-9]{64}$/u.test(value.clientIdDigest)) throw new Error("invalid registration");
      return value;
    } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }
  configured() { return this.#registration() !== null; }
  status() {
    let runtimeAvailable = true, reasonCode = null;
    try { this.binary(); } catch (error) { runtimeAvailable = false; reasonCode = error.code || "GMAIL_RUNTIME_UNAVAILABLE"; }
    const configured = this.configured();
    return { configured, restartRequired: false, runtimeAvailable, reasonCode };
  }
  async configure({ credentialsPath }) {
    if (this.#configuring || this.#registration()) {
      fail("GMAIL_REGISTRATION_CONFLICT", "Gmail 客户端已登记或正在导入");
    }
    this.#configuring = true;
    try {
      const binary = this.binary();
      const selected = readSelectedDesktopClient(credentialsPath);
      const home = this.#privateHome();
      await this.run(binary, [`--home=${home}`, `--client=${CLIENT}`, "--no-input",
        "auth", "credentials", "set", "-"], { input: selected.bytes, timeoutMs: 15_000 });
      atomicWritePrivateFile(this.registrationFile, `${JSON.stringify({ version: 1,
        clientIdDigest: selected.clientIdDigest })}\n`, { trustedRoot: this.paths.trustedRoot });
      return this.status();
    } finally { this.#configuring = false; }
  }
  #pendingAuthorization() {
    try {
      const value = JSON.parse(readPrivateFile(this.pendingAuthFile, { maxBytes: 1024 }).toString("utf8"));
      if (!exact(value, ["version", "client", "email"]) || value.version !== 1
        || value.client !== CLIENT || typeof value.email !== "string"
        || !EMAIL.test(value.email) || value.email.length > 254) {
        fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复标记无效");
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code === "GMAIL_AUTH_RECOVERY_REQUIRED") throw error;
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复标记不可读取");
    }
  }
  hasPendingAuthorization() {
    if (this.#pendingCommitUncertain) return true;
    try { return this.#pendingAuthorization() !== null; }
    catch { return true; }
  }
  pendingAuthorization() {
    const pending = this.#pendingAuthorization();
    if (pending) return { email: pending.email, client: pending.client };
    return this.#pendingCommitUncertain && this.#pendingCommitEmail
      ? { email: this.#pendingCommitEmail, client: CLIENT } : null;
  }
  #createPendingAuthorization(email) {
    const parent = this.#privateHome();
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
      // O_EXCL makes the marker create-only even if another Service process
      // appears between the account preflight and this write.
      fd = fs.openSync(this.pendingAuthFile, flags, 0o600);
      validatePrivateStat(fs.fstatSync(fd), this.pendingAuthFile);
      writeFully(fs, fd, `${JSON.stringify({ version: 1, client: CLIENT, email })}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncPrivateParent(parent);
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", error?.code === "EEXIST"
        ? "Gmail 授权恢复标记已存在" : "Gmail 授权恢复标记写入未完成");
    }
  }
  #clearPendingAuthorization(email) {
    const pending = this.#pendingAuthorization();
    if (!pending || pending.email.toLowerCase() !== email.toLowerCase()) {
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复标记与账户不符");
    }
    try {
      const stat = validatePrivateStat(fs.lstatSync(this.pendingAuthFile), this.pendingAuthFile);
      if (stat.nlink !== 1) fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复标记存在多重链接");
      fs.unlinkSync(this.pendingAuthFile);
      fsyncPrivateParent(path.dirname(this.pendingAuthFile));
      this.#pendingCommitUncertain = false;
      this.#pendingCommitEmail = null;
    } catch {
      this.#pendingCommitUncertain = true;
      this.#pendingCommitEmail = email;
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复标记清理状态不确定");
    }
  }
  commitAuthorization(email) {
    if (typeof email !== "string" || !EMAIL.test(email) || email.length > 254) {
      fail("GMAIL_AUTH_INVALID", "Gmail 地址无效");
    }
    this.#clearPendingAuthorization(email);
  }
  async reconcilePendingAuthorization(email) {
    if (typeof email !== "string" || !EMAIL.test(email) || email.length > 254) {
      fail("GMAIL_AUTH_INVALID", "Gmail 地址无效");
    }
    if (this.#authorizing) fail("GMAIL_AUTH_CONFLICT", "另一项 Gmail 授权正在进行");
    this.#authorizing = true;
    try {
      const durablePending = this.#pendingAuthorization();
      const pending = durablePending || (this.#pendingCommitUncertain && this.#pendingCommitEmail
        ? { email: this.#pendingCommitEmail, client: CLIENT } : null);
      if (!pending) {
        return { recovered: false };
      }
      if (pending.email.toLowerCase() !== email.toLowerCase()) {
        fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 恢复账户与标记不符");
      }
      const binary = this.binary(), home = this.#privateHome();
      const accounts = await this.#listedAccounts(binary, home);
      if (accounts.some(account => account.client === CLIENT
        && account.email.toLowerCase() === pending.email.toLowerCase())) {
        fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 凭据仍在钥匙串中，不能清除恢复标记");
      }
      if (durablePending) this.#clearPendingAuthorization(pending.email);
      else {
        // A previous unlink may have succeeded while its directory fsync
        // failed. Confirm the absence durably before lifting the local block.
        try { fsyncPrivateParent(home); }
        catch { fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复标记清理状态不确定"); }
        this.#pendingCommitUncertain = false;
        this.#pendingCommitEmail = null;
      }
      return { recovered: true };
    } finally { this.#authorizing = false; }
  }
  async #listedAccounts(binary, home, signal) {
    let output;
    try {
      output = await this.run(binary, [`--home=${home}`, `--client=${CLIENT}`,
        "--no-input", "--json", "auth", "list"], { timeoutMs: 15_000, signal });
    } catch (error) {
      if (error?.code === "GMAIL_AUTH_CANCELED") throw error;
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "无法确认现有 Gmail 授权账户");
    }
    let value;
    try { value = JSON.parse(output); } catch {
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权账户清单不是 JSON");
    }
    if (!exact(value, ["accounts"]) || !Array.isArray(value.accounts)
      || value.accounts.length > 1024) {
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权账户清单结构无效");
    }
    const seen = new Set();
    for (const account of value.accounts) {
      if (!account || Object.getPrototypeOf(account) !== Object.prototype
        || typeof account.email !== "string" || !EMAIL.test(account.email)
        || account.email.length > 254 || typeof account.client !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(account.client)) {
        fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权账户条目无效");
      }
      const key = `${account.client.toLowerCase()}\0${account.email.toLowerCase()}`;
      if (seen.has(key)) fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权账户清单重复");
      seen.add(key);
    }
    return value.accounts;
  }
  async authorize(email, { signal } = {}) {
    if (!EMAIL.test(email) || email.length > 254) fail("GMAIL_AUTH_INVALID", "Gmail 地址无效");
    if (!this.configured()) fail("GMAIL_REGISTRATION_INVALID", "Gmail 客户端尚未登记");
    if (this.#pendingCommitUncertain) {
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复标记提交状态不确定");
    }
    if (this.#authorizing) fail("GMAIL_AUTH_CONFLICT", "另一项 Gmail 授权正在进行");
    this.#authorizing = true;
    try {
      const binary = this.binary(), home = this.#privateHome();
      if (this.#pendingAuthorization()) {
        fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复尚未完成");
      }
      const accounts = await this.#listedAccounts(binary, home, signal);
      if (signal?.aborted) fail("GMAIL_AUTH_CANCELED", "Gmail 登录已取消");
      const hasAccount = address => accounts.some(account => account.client === CLIENT
        && account.email.toLowerCase() === address.toLowerCase());
      if (this.#pendingAuthorization()) {
        fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复尚未完成");
      }
      if (hasAccount(email)) {
        fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权账户已存在，拒绝覆盖钥匙串凭据");
      }
      if (signal?.aborted) fail("GMAIL_AUTH_CANCELED", "Gmail 登录已取消");
      this.#createPendingAuthorization(email);
      const output = await this.run(binary, [`--home=${home}`, `--client=${CLIENT}`, "--no-input", "--json",
        "auth", "add", email, "--services=gmail", "--gmail-scope=full", "--timeout=5m"],
      { timeoutMs: 310_000, signal });
      let authorized;
      try { authorized = JSON.parse(output); } catch { fail("GMAIL_AUTH_FAILED", "gog 未返回可验证的授权主体"); }
      if (!authorized || authorized.stored !== true || authorized.client !== CLIENT
        || typeof authorized.email !== "string" || !EMAIL.test(authorized.email)
        || authorized.email.toLowerCase() !== email.toLowerCase()
        || !Array.isArray(authorized.services)
        || !authorized.services.includes("gmail")) {
        fail("GMAIL_AUTH_FAILED", "gog 授权主体与请求地址不一致");
      }
      await this.run(binary, [`--home=${home}`, `--client=${CLIENT}`, `--account=${authorized.email}`,
        "--no-input", "--json", "gmail", "labels", "list"], { timeoutMs: 30_000, signal });
      return authorized.email;
    } finally { this.#authorizing = false; }
  }
  capabilities() {
    try {
      const value = JSON.parse(readPrivateFile(this.capabilitiesFile, { maxBytes: 4096 }).toString("utf8"));
      if (!exact(value, ["revision", "writeEnabled", "sendEnabled", "deleteEnabled"])
        || !Number.isSafeInteger(value.revision) || value.revision < 1
        || typeof value.writeEnabled !== "boolean" || typeof value.sendEnabled !== "boolean"
        || value.sendEnabled && !value.writeEnabled || value.deleteEnabled !== false) {
        throw new Error("invalid Gmail policy");
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return { revision: 1, writeEnabled: false,
        sendEnabled: false, deleteEnabled: false };
      throw error;
    }
  }
  configureCapabilities(input) {
    if (!exact(input, ["expectedRevision", "writeEnabled", "sendEnabled"])
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || typeof input.writeEnabled !== "boolean" || typeof input.sendEnabled !== "boolean"
      || input.sendEnabled && !input.writeEnabled) fail("GMAIL_CAPABILITIES_INVALID", "Gmail 权限设置无效");
    const current = this.capabilities();
    if (current.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Gmail 权限代次已变化");
    if (current.writeEnabled === input.writeEnabled && current.sendEnabled === input.sendEnabled) return current;
    const next = { revision: current.revision + 1, writeEnabled: input.writeEnabled,
      sendEnabled: input.sendEnabled, deleteEnabled: false };
    this.#privateHome();
    atomicWritePrivateFile(this.capabilitiesFile, `${JSON.stringify(next)}\n`,
      { trustedRoot: this.paths.trustedRoot });
    return next;
  }
  allowedTools() {
    const policy = this.capabilities();
    return new Set([...READ_TOOLS, ...(policy.writeEnabled ? ORDINARY_WRITE_TOOLS : []),
      ...(policy.sendEnabled ? SEND_TOOLS : [])]);
  }
  launch(email) {
    if (!EMAIL.test(email) || !this.configured()) fail("GMAIL_AUTH_INVALID", "Gmail 连接未登记");
    if (this.hasPendingAuthorization()) {
      fail("GMAIL_AUTH_RECOVERY_REQUIRED", "Gmail 授权恢复尚未完成");
    }
    const policy = this.capabilities();
    const args = [`--home=${this.#privateHome()}`, `--client=${CLIENT}`, `--account=${email}`,
      ...(policy.writeEnabled ? [] : ["--readonly"]),
      ...(policy.sendEnabled ? [] : ["--gmail-no-send"]), "mcp",
      ...[...this.allowedTools()].map(name => `--allow-tool=${name}`),
      ...(policy.writeEnabled ? ["--allow-write"] : []),
      ...(policy.sendEnabled ? ["--allow-gmail-send"] : [])];
    return { command: this.binary(), args, cwd: this.home, env: {},
      timeoutMs: 60_000, appSupport: false };
  }
}

module.exports = { GogGmailRuntime, verifiedGogBinary, gogPayloadDigest,
  readSelectedDesktopClient, runGog, EMAIL };
