"use strict";

// Shared OpenClaw gateway device-auth v2 helpers.
//
// This replicates the browser Control UI's device-auth handshake using the
// operator identity already on disk (~/.openclaw/identity/{device,device-auth}.json):
//   connect → receive `connect.challenge {nonce}` → send a signed `connect`
//   request → receive HelloOk. No interactive pairing.
//
// NOTE: app/core/openclaw-backend.js still carries its own copy of these
// crypto helpers (the verified R2 RPC client). This module is the shared source
// used by the chat broker; deduping the backend onto it is a safe future cleanup.
// SECURITY: never log/serialize the private key or operator token values.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18792";
const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "webchat";
const CLIENT_ROLE = "operator";
const CLIENT_VERSION = "control-ui";
const PROTOCOL_VERSION = 4;
const MIN_CLIENT_PROTOCOL_VERSION = 4;
// `inline-widgets` is a client rendering capability rather than an auth scope.
// Advertising it lets OpenClaw expose the canonical show_widget tool for runs
// originating from Shoggoth's chat broker; document bytes still stay behind
// the authenticated server-side resource proxy.
const CONNECT_CAPS = ["tool-events", "inline-widgets"];
const DEFAULT_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.questions",
];
const CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_ORIGIN = "http://127.0.0.1";
const LOCAL_TOKEN_CACHE_OK_MS = 5000;
const LOCAL_TOKEN_CACHE_MISS_MS = 1000;
const TOKEN_REVEAL_TIMEOUT_MS = 10000;
const TOKEN_REVEAL_MAX_BYTES = 16 * 1024;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem, payload) {
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem));
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV2({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
  return [
    "v2",
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(","),
    String(signedAtMs),
    token ?? "",
    nonce,
  ].join("|");
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- 自生成设备身份 + 凭证文件(首装机器没有 ~/.openclaw 身份时用) ----
// deviceId 必须 = sha256(ed25519 公钥 raw 32B) hex —— 网关会用
// deriveDeviceIdFromPublicKey 重新派生校验(dist/device-identity)。

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const deviceId = crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
  return { deviceId, publicKeyPem, privateKeyPem };
}

// deviceToken 按网关 URL 键控;规整掉尾斜杠差异,避免同一网关存两份。
function normalizeGatewayUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/**
 * 凭证文件存储:<credentialsDir>/device-credentials.json(0600,原子写)。
 * 形状:{ version:1, identity:{...,createdAtMs}, deviceTokens:{[url]:{token,issuedAtMs}} }
 * SECURITY: 内容含私钥与设备令牌,绝不日志。
 */
function createCredentialsStore(credentialsDir) {
  const file = path.join(credentialsDir, "device-credentials.json");

  function readFile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeFile(data) {
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const tmpFile = `${file}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFile, file);
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch { /* nothing to clean */ }
      throw err;
    }
  }

  // 校验存储身份可用(deviceId 与公钥匹配、密钥对成对),否则重新生成。
  function validIdentity(id) {
    if (!id || typeof id.publicKeyPem !== "string" || typeof id.privateKeyPem !== "string") return null;
    try {
      const derived = crypto.createHash("sha256").update(derivePublicKeyRaw(id.publicKeyPem)).digest("hex");
      if (derived !== id.deviceId) return null;
      const probe = Buffer.from("shoggoth-device-identity-self-check", "utf8");
      const sig = crypto.sign(null, probe, crypto.createPrivateKey(id.privateKeyPem));
      if (!crypto.verify(null, probe, crypto.createPublicKey(id.publicKeyPem), sig)) return null;
      return { deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, privateKeyPem: id.privateKeyPem };
    } catch {
      return null;
    }
  }

  function loadOrCreateIdentity() {
    const data = readFile();
    const existing = validIdentity(data.identity);
    if (existing) return existing;
    const identity = generateIdentity();
    writeFile({
      version: 1,
      identity: { ...identity, createdAtMs: Date.now() },
      deviceTokens: data.deviceTokens && typeof data.deviceTokens === "object" ? data.deviceTokens : {},
    });
    return identity;
  }

  function getDeviceToken(gatewayUrl) {
    const key = normalizeGatewayUrl(gatewayUrl);
    const entry = readFile().deviceTokens?.[key];
    return entry && typeof entry.token === "string" && entry.token
      ? { token: entry.token, issuedAtMs: Number(entry.issuedAtMs) || 0 }
      : null;
  }

  function setDeviceToken(gatewayUrl, token, issuedAtMs) {
    if (typeof token !== "string" || !token) return;
    const data = readFile();
    if (!data.version) data.version = 1;
    if (!data.deviceTokens || typeof data.deviceTokens !== "object") data.deviceTokens = {};
    data.deviceTokens[normalizeGatewayUrl(gatewayUrl)] = { token, issuedAtMs: Number(issuedAtMs) || Date.now() };
    writeFile(data);
  }

  function clearDeviceToken(gatewayUrl) {
    const data = readFile();
    const key = normalizeGatewayUrl(gatewayUrl);
    if (data.deviceTokens && typeof data.deviceTokens === "object" && key in data.deviceTokens) {
      delete data.deviceTokens[key];
      writeFile(data);
    }
  }

  return { loadOrCreateIdentity, getDeviceToken, setDeviceToken, clearDeviceToken };
}

/**
 * Load the operator device identity from disk.
 * @returns {{deviceId, publicKeyPem, privateKeyPem, token, scopes}|null}
 */
function loadOperatorAuth(identityDir = path.join(os.homedir(), ".openclaw", "identity")) {
  try {
    const dir = identityDir;
    const device = JSON.parse(fs.readFileSync(path.join(dir, "device.json"), "utf8"));
    let token;
    let scopes;
    try {
      const da = JSON.parse(fs.readFileSync(path.join(dir, "device-auth.json"), "utf8"));
      const op = da && da.tokens && da.tokens.operator;
      token = op && typeof op.token === "string" ? op.token : undefined;
      scopes = op && Array.isArray(op.scopes) ? op.scopes : undefined;
    } catch {
      /* device-auth.json missing → no operator token */
    }
    if (!device || !device.deviceId || !device.privateKeyPem || !device.publicKeyPem || !token) {
      return null;
    }
    return {
      deviceId: device.deviceId,
      publicKeyPem: device.publicKeyPem,
      privateKeyPem: device.privateKeyPem,
      token,
      scopes: scopes && scopes.length ? scopes : DEFAULT_OPERATOR_SCOPES,
    };
  } catch {
    return null;
  }
}

/**
 * Build the signed `connect` request params answering a challenge nonce.
 * auth.token / auth.deviceToken 是独立槽位:网关先验共享 token,失败再验设备令牌,
 * 任一通过即放行;auth 块只携带非空槽(带空 deviceToken 会把"token 填错"误报成
 * device token mismatch)。签名载荷的 token 字段必须镜像网关的
 * resolveSignatureToken(auth.token ?? auth.deviceToken ?? "")。
 * @param {{deviceId, publicKeyPem, privateKeyPem, token?, deviceToken?, scopes}} auth
 * @param {string} nonce
 */
function buildConnectParams(auth, nonce) {
  const signedAtMs = Date.now();
  const scopes = auth.scopes;
  const signatureToken = auth.token ?? auth.deviceToken ?? "";
  const payload = buildDeviceAuthPayloadV2({
    deviceId: auth.deviceId,
    clientId: CLIENT_ID,
    clientMode: CLIENT_MODE,
    role: CLIENT_ROLE,
    scopes,
    signedAtMs,
    token: signatureToken,
    nonce,
  });
  const signature = signDevicePayload(auth.privateKeyPem, payload);
  const authBlock = {};
  if (auth.token) authBlock.token = auth.token;
  if (auth.deviceToken) authBlock.deviceToken = auth.deviceToken;
  return {
    minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: CLIENT_ID, version: CLIENT_VERSION, platform: process.platform, mode: CLIENT_MODE },
    caps: CONNECT_CAPS,
    role: CLIENT_ROLE,
    scopes,
    auth: authBlock,
    device: {
      id: auth.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(auth.publicKeyPem),
      signature,
      signedAt: signedAtMs,
      nonce,
    },
  };
}

const LOOPBACK_GATEWAY_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackGatewayUrl(url) {
  try {
    return LOOPBACK_GATEWAY_HOSTS.has(new URL(String(url)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

let localTokenCache = null;
const localTokenReveals = new Map();

function resolveOpenclawBinForTokenReveal(injected) {
  if (injected) return injected;
  const candidates = [
    process.env.OPENCLAW_BIN,
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
    path.join(os.homedir(), ".npm-global", "bin", "openclaw"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try next candidate */
    }
  }
  const searchPath = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".npm-global", "bin"),
    ...(process.env.PATH || "").split(":"),
  ];
  for (const dir of searchPath) {
    const candidate = path.join(dir, "openclaw");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function gatewayTokenRevealProgram(bin) {
  let entry;
  let authModuleUrl = null;
  try {
    entry = fs.realpathSync(bin);
    const dist = path.join(path.dirname(entry), "dist");
    const authModule = fs
      .readdirSync(dist)
      .find((name) => /^gateway-auth-token-.*\.m?js$/.test(name));
    if (authModule) {
      authModuleUrl = pathToFileURL(path.join(dist, authModule)).href;
    }
  } catch {
    entry = bin;
  }
  // Compatibility fallback for OpenClaw builds that no longer ship the focused
  // module: execute the stable CLI surface after marking this isolated child as
  // the explicit interactive operator requested by `--show`.
  const entryUrl = pathToFileURL(entry).href;
  const fallback = "()=>{Object.defineProperty(process.stdin,'isTTY',{value:true});"
    + "Object.defineProperty(process.stdout,'isTTY',{value:true});"
    + `process.argv=[process.execPath,${JSON.stringify(entry)},'--no-color','gateway','auth-token','--show'];`
    + `return import(${JSON.stringify(entryUrl)});}`;
  const reportFailure = ".catch((error)=>{process.stderr.write(String(error?.message||error)+'\\n');process.exitCode=1;});";
  if (!authModuleUrl) return `(${fallback})()${reportFailure}`;
  return `import(${JSON.stringify(authModuleUrl)})`
    + ".then((mod)=>{if(typeof mod.gatewayAuthTokenCommand!=='function')throw new Error('unsupported OpenClaw token resolver');"
    + "return mod.gatewayAuthTokenCommand(undefined,{interactive:true});})"
    + `.catch(${fallback})${reportFailure}`;
}

function tokenRevealInvocation(configPath, openclawBin) {
  const bin = resolveOpenclawBinForTokenReveal(openclawBin);
  if (!bin) return null;
  const extraPath = [
    path.dirname(bin),
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/node@22/bin",
    "/usr/local/bin",
  ];
  return {
    command: "/usr/bin/env", args: ["node", "-e", gatewayTokenRevealProgram(bin)],
    options: {
      encoding: "utf8",
      timeout: TOKEN_REVEAL_TIMEOUT_MS,
      maxBuffer: TOKEN_REVEAL_MAX_BYTES,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        PATH: [...extraPath, process.env.PATH || ""].join(":"),
      },
    },
  };
}

function revealLocalGatewayToken(configPath, { openclawBin, spawnSyncImpl = spawnSync, platform } = {}) {
  if ((platform ?? process.platform) !== "darwin") return undefined;
  const invocation = tokenRevealInvocation(configPath, openclawBin);
  if (!invocation) return undefined;
  const result = spawnSyncImpl(invocation.command, invocation.args, invocation.options);
  if (result.error || result.status !== 0) return undefined;
  return parseRevealedToken(result.stdout);
}

function parseRevealedToken(stdout) {
  // Accept one opaque token-shaped line and reject diagnostic/banner output.
  // The value stays in process memory only.
  // eslint-disable-next-line no-control-regex
  const lines = String(stdout || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-A-Za-z0-9._~+/=]{16,1024}$/.test(line));
  return lines.length === 1 ? lines[0] : undefined;
}

function revealLocalGatewayTokenAsync(configPath, { openclawBin, spawnImpl = spawn, platform } = {}) {
  if ((platform ?? process.platform) !== "darwin") return Promise.resolve(undefined);
  const invocation = tokenRevealInvocation(configPath, openclawBin);
  if (!invocation) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let outputBytes = 0;
    let invalid = false;
    let settled = false;
    let timer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(!invalid && code === 0 ? parseRevealedToken(stdout) : undefined);
    };
    const killOwned = () => {
      invalid = true;
      // A CLI compatibility fallback may have children. This freshly spawned
      // group is owned by this reveal only; never signal an existing Gateway.
      try {
        if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, "SIGKILL");
        else child?.kill("SIGKILL");
      } catch { try { child?.kill("SIGKILL"); } catch { /* already exited */ } }
    };
    try {
      const { timeout, maxBuffer, encoding, ...options } = invocation.options;
      child = spawnImpl(invocation.command, invocation.args, {
        ...options, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      timer = setTimeout(killOwned, timeout);
      child.stdout?.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maxBuffer) { killOwned(); return; }
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maxBuffer) killOwned();
      });
      child.once("error", () => { invalid = true; finish(null); });
      child.once("close", finish);
    } catch { invalid = true; finish(null); }
  });
}

// 仅 loopback 网关时读本机 openclaw 配置里的 gateway token(首启零输入的关键;
// 绝不拿本地秘密去连远程网关)。OpenClaw 2026.9+ 可能把 token 写成 SecretRef；
// 这时通过官方 `gateway auth-token --show` 解析逻辑在隔离子进程中读取，既不降级成明文配置，
// 也不复制进 Shoggoth HOME。短缓存只用于合并同一轮 backend/broker 握手。
function readLocalGatewayToken(configPath, options = {}) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    const t = cfg?.gateway?.auth?.token;
    if (typeof t === "string" && t.trim()) return t.trim();
    if (!t || typeof t !== "object" || typeof t.source !== "string" || typeof t.id !== "string") {
      return undefined;
    }
    const stat = fs.statSync(configPath);
    const cacheKey = `${configPath}\0${stat.mtimeMs}\0${stat.size}`;
    const now = () => typeof options.now === "function" ? options.now()
      : typeof options.now === "number" ? options.now : Date.now();
    if (localTokenCache?.key === cacheKey && now() - localTokenCache.at < localTokenCache.ttl) {
      return localTokenCache.value;
    }
    const value = revealLocalGatewayToken(configPath, options);
    localTokenCache = {
      key: cacheKey,
      // A slow resolver may spend the full 10s timeout here. Starting the TTL
      // before it runs would make a 1s miss expire before the caller receives it.
      at: now(),
      ttl: value ? LOCAL_TOKEN_CACHE_OK_MS : LOCAL_TOKEN_CACHE_MISS_MS,
      value,
    };
    return value;
  } catch {
    return undefined;
  }
}

async function readLocalGatewayTokenAsync(configPath, options = {}) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const token = cfg?.gateway?.auth?.token;
    if (typeof token === "string" && token.trim()) return token.trim();
    if (!token || typeof token !== "object" || typeof token.source !== "string" || typeof token.id !== "string") return undefined;
    const stat = fs.statSync(configPath);
    const key = `${configPath}\0${stat.mtimeMs}\0${stat.size}`;
    const now = () => typeof options.now === "function" ? options.now()
      : typeof options.now === "number" ? options.now : Date.now();
    if (localTokenCache?.key === key && now() - localTokenCache.at < localTokenCache.ttl) return localTokenCache.value;
    if (localTokenReveals.has(key)) return await localTokenReveals.get(key);
    const pending = revealLocalGatewayTokenAsync(configPath, options).then((value) => {
      localTokenCache = { key, at: now(), ttl: value ? LOCAL_TOKEN_CACHE_OK_MS : LOCAL_TOKEN_CACHE_MISS_MS, value };
      return value;
    });
    localTokenReveals.set(key, pending);
    try { return await pending; } finally { localTokenReveals.delete(key); }
  } catch { return undefined; }
}

/**
 * 统一认证解析器 —— 管理面(openclaw-backend)与聊天面(chat-broker)共用。
 * token 槽优先级:config.token → 本机 operator token → (仅 loopback) 本机网关配置 token。
 * deviceToken 槽:该 URL 此前 hello-ok 存下的设备令牌(没有就不带)。
 * 身份:本机 operator 身份优先(openclaw 用户零变化),缺失 → 自生成并持久化。
 * operatorIdentityDir / localGatewayConfigPath 参数化只为测试沙箱,默认值即线上行为。
 */
function createAuthResolver({
  getConfig,
  credentialsDir,
  operatorIdentityDir = path.join(os.homedir(), ".openclaw", "identity"),
  localGatewayConfigPath = path.join(os.homedir(), ".openclaw", "openclaw.json"),
} = {}) {
  const store = createCredentialsStore(credentialsDir);

  function configuredGatewayUrl() {
    const cfg = getConfig ? getConfig() : {};
    return (cfg?.gatewayUrl || "").trim() || DEFAULT_GATEWAY_URL;
  }

  function resolveConnectAuth(gatewayUrl) {
    const url = (gatewayUrl || "").trim() || configuredGatewayUrl();
    const cfg = getConfig ? getConfig() : {};
    const configToken = typeof cfg?.token === "string" && cfg.token.trim() ? cfg.token.trim() : undefined;
    // loopback 时本机 gateway.auth.token(真共享密钥,按请求授满 scopes)排在 CLI 的
    // operator token 之前:后者会被 `gateway status` 等探测型连接悄悄轮换收窄成
    // read-only(R125 实测),拿它连本机网关会丢写权限。
    const sharedToken = configToken ?? (isLoopbackGatewayUrl(url) ? readLocalGatewayToken(localGatewayConfigPath) : undefined);
    return authWithSharedToken(url, sharedToken);
  }

  async function resolveConnectAuthAsync(gatewayUrl) {
    const url = (gatewayUrl || "").trim() || configuredGatewayUrl();
    const cfg = getConfig ? getConfig() : {};
    const configToken = typeof cfg?.token === "string" && cfg.token.trim() ? cfg.token.trim() : undefined;
    const sharedToken = configToken ?? (isLoopbackGatewayUrl(url) ? await readLocalGatewayTokenAsync(localGatewayConfigPath) : undefined);
    return authWithSharedToken(url, sharedToken);
  }

  function authWithSharedToken(url, sharedToken) {
    const operator = loadOperatorAuth(operatorIdentityDir);
    // 有真共享密钥时用 app 自己的身份,不复用 CLI 身份(R126):CLI 设备在网关里
    // 带着旧审批基线(常被探测收窄),满额请求会触发"scope 升级审批"卡人工;
    // 全新身份 + token 走网关自动注册,基线即所请求,零审批(S1 live 实测)。
    // 也顺带避免多客户端共用 deviceId 时的设备令牌轮换互踩。
    let identity = sharedToken ? null : operator;
    if (!identity) {
      try {
        identity = store.loadOrCreateIdentity();
      } catch {
        return null; // 磁盘不可写等极端情况;调用方保留错误路径
      }
    }
    const token = sharedToken ?? (operator ? operator.token : undefined);
    const stored = store.getDeviceToken(url);
    return {
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
      token,
      // 只有 token 槽空着才显式带存储的设备令牌:多个客户端(Electron/dev/broker)
      // 共享设备身份时,网关每次 hello-ok 轮换设备令牌,别家存的立即陈旧——显式
      // 陈旧 deviceToken 会抢占网关的 auth.token 回退校验,两条全败还喂饱限流器
      // (R125 真机+本机双双踩过)。token 在手时,网关自会拿它走共享/回退两条路。
      deviceToken: token ? undefined : stored ? stored.token : undefined,
      // 走真共享密钥时按满额请求(shared auth 授"所请求的" scopes);只有走 operator
      // token 认证时才用它自带的 scopes——那份同样会被探测型连接收窄,不可放大。
      scopes: sharedToken ? DEFAULT_OPERATOR_SCOPES : operator?.scopes?.length ? operator.scopes : DEFAULT_OPERATOR_SCOPES,
    };
  }

  function storeDeviceToken(deviceToken, issuedAtMs, gatewayUrl) {
    const url = (gatewayUrl || "").trim() || configuredGatewayUrl();
    store.setDeviceToken(url, deviceToken, issuedAtMs);
  }

  // 设备令牌被网关判陈旧时清掉,下次连接干净重来(自愈)。
  function clearDeviceToken(gatewayUrl) {
    const url = (gatewayUrl || "").trim() || configuredGatewayUrl();
    store.clearDeviceToken(url);
  }

  return { getGatewayUrl: configuredGatewayUrl, resolveConnectAuth, resolveConnectAuthAsync, storeDeviceToken, clearDeviceToken };
}

// 网关 unauthorized 文案/网络错误 → 结构化原因(UI 梯子与设置页共用)。
// 顺序敏感:device token 要先于 gateway token 判(都含 "token")。
function classifyAuthError(err) {
  const msg = String(err?.message || err || "");
  const code = err?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ETIMEDOUT") return "unreachable";
  if (/closed before handshake|connection closed|ECONNREFUSED|socket hang up/i.test(msg)) return "unreachable";
  if (/connect timeout|timed? ?out/i.test(msg)) return "timeout";
  if (/device token (mismatch|rejected|scope)/i.test(msg)) return "device_token_stale";
  if (/token mismatch/i.test(msg)) return "token_mismatch";
  if (/token (missing|not configured)/i.test(msg)) return "token_missing";
  if (/pairing|pair this device|approve/i.test(msg)) return "pairing_required";
  if (/origin/i.test(msg)) return "origin_denied";
  return "unknown";
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  DEFAULT_ORIGIN,
  CONNECT_TIMEOUT_MS,
  CONNECT_CAPS,
  DEFAULT_OPERATOR_SCOPES,
  safeParse,
  loadOperatorAuth,
  buildConnectParams,
  generateIdentity,
  createCredentialsStore,
  createAuthResolver,
  classifyAuthError,
  readLocalGatewayToken,
  readLocalGatewayTokenAsync,
};
