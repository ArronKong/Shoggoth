"use strict";
// S1 device-auth 单元 smoke。零网络;全部在临时目录里执行。
// Run: node scripts/device-auth-smoke.cjs
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const da = require("../app/core/device-auth");

let failed = false;
function check(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}: ${err?.message || err}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "da-smoke-"));

check("generateIdentity: deviceId = sha256(公钥raw).hex", () => {
  const id = da.generateIdentity();
  const spki = crypto.createPublicKey(id.publicKeyPem).export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  assert.strictEqual(id.deviceId, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.match(id.privateKeyPem, /BEGIN PRIVATE KEY/);
});

check("credentialsStore: 首读生成并持久化(0600),二读复用同一身份", () => {
  const dir = path.join(tmp, "cred1");
  const store = da.createCredentialsStore(dir);
  const a = store.loadOrCreateIdentity();
  const b = store.loadOrCreateIdentity();
  assert.strictEqual(a.deviceId, b.deviceId);
  const file = path.join(dir, "device-credentials.json");
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600, `mode ${mode.toString(8)}`);
  const again = da.createCredentialsStore(dir).loadOrCreateIdentity();
  assert.strictEqual(again.deviceId, a.deviceId);
});

check("credentialsStore: deviceToken 按 URL 存取,读不到返回 null", () => {
  const store = da.createCredentialsStore(path.join(tmp, "cred2"));
  store.loadOrCreateIdentity();
  assert.strictEqual(store.getDeviceToken("ws://10.0.0.9:18792"), null);
  store.setDeviceToken("ws://10.0.0.9:18792", "dtok-abc", 1751000000000);
  const got = store.getDeviceToken("ws://10.0.0.9:18792");
  assert.strictEqual(got.token, "dtok-abc");
  assert.strictEqual(got.issuedAtMs, 1751000000000);
  // URL 规整:尾斜杠等价
  assert.strictEqual(da.createCredentialsStore(path.join(tmp, "cred2")).getDeviceToken("ws://10.0.0.9:18792/").token, "dtok-abc");
});

// ---- Task 2: resolver / connect 参数 / 错误分类 ----
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
// 沙箱一套"本机 openclaw":身份目录 + 网关配置
const sandboxHome = path.join(tmp, "op-home");
const opIdentityDir = path.join(sandboxHome, "identity");
const opIdentity = da.generateIdentity();
writeJson(path.join(opIdentityDir, "device.json"), opIdentity);
writeJson(path.join(opIdentityDir, "device-auth.json"), {
  tokens: { operator: { token: "op-tok", scopes: ["operator.read"] } },
});
writeJson(path.join(sandboxHome, "openclaw.json"), { gateway: { auth: { mode: "token", token: "local-gw-tok" } } });
const emptyDir = path.join(tmp, "no-such-openclaw"); // 模拟全新机器
const mkResolver = (cfg, opDir) =>
  da.createAuthResolver({
    getConfig: () => cfg,
    credentialsDir: path.join(tmp, "cred-rs-" + (mkResolver.n = (mkResolver.n || 0) + 1)),
    operatorIdentityDir: opDir,
    localGatewayConfigPath: path.join(sandboxHome, "openclaw.json"),
  });

check("resolver: config.token 优先做 token 槽;有共享密钥时用 app 自有身份(R126)", () => {
  const r = mkResolver({ gatewayUrl: "ws://10.1.1.1:18792", token: "ui-tok" }, opIdentityDir);
  const a = r.resolveConnectAuth();
  assert.strictEqual(a.token, "ui-tok");
  assert.notStrictEqual(a.deviceId, opIdentity.deviceId); // 不复用 CLI 身份(旧基线会卡审批)
  assert.strictEqual(a.deviceToken, undefined);
});

check("resolver: 无 config.token 时回退 operator token(远程 URL,身份也用 CLI 的)", () => {
  const a = mkResolver({ gatewayUrl: "ws://10.1.1.1:18792", token: "" }, opIdentityDir).resolveConnectAuth();
  assert.strictEqual(a.token, "op-tok");
  assert.strictEqual(a.deviceId, opIdentity.deviceId); // 无共享密钥 → operator 身份+令牌配套用
});

check("resolver: loopback 时本机网关 token 优先于 operator token(防收窄,R125)", () => {
  const a = mkResolver({ gatewayUrl: "ws://127.0.0.1:18792", token: "" }, opIdentityDir).resolveConnectAuth();
  assert.strictEqual(a.token, "local-gw-tok"); // 不是 op-tok
  assert.ok(a.scopes.includes("operator.admin"), "共享密钥应请求满额 scopes,不受收窄的 operator.scopes 污染");
  assert.notStrictEqual(a.deviceId, opIdentity.deviceId); // R126:共享密钥 → app 自有身份
});

check("resolver: 走 operator token 时沿用其自带 scopes(不放大)", () => {
  const a = mkResolver({ gatewayUrl: "ws://10.1.1.1:18792", token: "" }, opIdentityDir).resolveConnectAuth();
  assert.strictEqual(a.token, "op-tok");
  assert.deepStrictEqual(a.scopes, ["operator.read"]);
});

check("resolver: 全新机器 + loopback → 读本机网关配置 token,身份自生成", () => {
  const a = mkResolver({ gatewayUrl: "ws://127.0.0.1:18792", token: "" }, emptyDir).resolveConnectAuth();
  assert.strictEqual(a.token, "local-gw-tok");
  assert.strictEqual(typeof a.deviceId, "string");
  assert.notStrictEqual(a.deviceId, opIdentity.deviceId);
});

check("resolver: 全新机器 + 远程 URL → 绝不读本机网关 token", () => {
  const a = mkResolver({ gatewayUrl: "ws://10.1.1.1:18792", token: "" }, emptyDir).resolveConnectAuth();
  assert.strictEqual(a.token, undefined);
});

check("resolver: token 在手时不带存储 deviceToken(防陈旧抢占,R125)", () => {
  const r = mkResolver({ gatewayUrl: "ws://10.1.1.1:18792", token: "ui-tok" }, emptyDir);
  r.storeDeviceToken("dtok-1", 1751000000000);
  assert.strictEqual(r.resolveConnectAuth().deviceToken, undefined); // token 槽有值 → 省略
  assert.strictEqual(r.resolveConnectAuth().token, "ui-tok");
});

check("resolver: token 槽空时才带存储 deviceToken(按 URL 隔离);clear 自愈", () => {
  const r = mkResolver({ gatewayUrl: "ws://10.1.1.1:18792", token: "" }, emptyDir);
  r.storeDeviceToken("dtok-1", 1751000000000);
  assert.strictEqual(r.resolveConnectAuth().token, undefined); // 全新机器+远程 → 无 token
  assert.strictEqual(r.resolveConnectAuth().deviceToken, "dtok-1");
  assert.strictEqual(r.resolveConnectAuth("ws://other:18792").deviceToken, undefined);
  r.clearDeviceToken();
  assert.strictEqual(r.resolveConnectAuth().deviceToken, undefined); // 陈旧清除后干净重来
});

check("buildConnectParams: 双槽独立;签名 token = auth.token 优先", () => {
  const id = da.generateIdentity();
  const p = da.buildConnectParams(
    { ...id, token: "shared-t", deviceToken: "dev-t", scopes: ["operator.read"] },
    "nonce-1",
  );
  assert.deepStrictEqual(p.auth, { token: "shared-t", deviceToken: "dev-t" });
  // 网关重建载荷:token 字段取 auth.token ?? auth.deviceToken —— 验签必须能过
  const payload = ["v2", id.deviceId, "openclaw-control-ui", "webchat", "operator",
    "operator.read", String(p.device.signedAt), "shared-t", "nonce-1"].join("|");
  const spki = crypto.createPublicKey(id.publicKeyPem).export({ type: "spki", format: "der" });
  const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const sig = Buffer.from(p.device.signature.replace(/-/g, "+").replace(/_/g, "/") + "==", "base64");
  assert.ok(crypto.verify(null, Buffer.from(payload, "utf8"), pub, sig), "签名对不上 token 槽");
});

check("buildConnectParams: 无 token 有 deviceToken → auth 只带 deviceToken,签名用它", () => {
  const id = da.generateIdentity();
  const p = da.buildConnectParams({ ...id, deviceToken: "dev-only", scopes: ["operator.read"] }, "n2");
  assert.deepStrictEqual(p.auth, { deviceToken: "dev-only" });
});

check("classifyAuthError: 关键报错 → 结构化原因", () => {
  const c = da.classifyAuthError;
  assert.strictEqual(c(new Error("unauthorized: gateway token mismatch (set gateway...)")), "token_mismatch");
  assert.strictEqual(c(new Error("unauthorized: gateway token missing (provide...)")), "token_missing");
  assert.strictEqual(c(new Error("unauthorized: device token mismatch (rotate/reissue device token)")), "device_token_stale");
  assert.strictEqual(c(new Error("pairing required: approve this device")), "pairing_required");
  assert.strictEqual(c(new Error("origin not allowed")), "origin_denied");
  assert.strictEqual(c(new Error("openclaw: connect timeout")), "timeout");
  assert.strictEqual(c(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18792"), { code: "ECONNREFUSED" })), "unreachable");
  assert.strictEqual(c(new Error("openclaw: closed before handshake")), "unreachable");
  assert.strictEqual(c(new Error("weird")), "unknown");
});

// ---- live 验收(需本机网关在跑):node scripts/device-auth-smoke.cjs --live ----
// 模拟"全新机器":空 operator 身份目录 + 仅 config.token(从本机网关配置读出充当
// 用户输入)→ 应 hello-ok;随后清 token 仅凭存回的 deviceToken 重连 → 仍应成功。
// 会在网关设备表登记一台新设备(功能本身),验收后可 `openclaw devices remove`。
async function live() {
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const gwCfg = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const gwTok = JSON.parse(fs.readFileSync(gwCfg, "utf8"))?.gateway?.auth?.token;
  if (!gwTok) { console.log("skip live: 本机网关无 token 配置"); return; }
  const credDir = path.join(tmp, "live-cred");
  let cfg = { gatewayUrl: "ws://127.0.0.1:18792", token: gwTok };
  const resolver = da.createAuthResolver({
    getConfig: () => cfg,
    credentialsDir: credDir,
    operatorIdentityDir: path.join(tmp, "live-empty-identity"),
    localGatewayConfigPath: path.join(tmp, "live-no-config.json"), // 断掉 loopback 捷径,强制走 config.token
  });
  const be = new OpenClawBackend({ getUpstreamUrl: () => cfg.gatewayUrl, getOrigin: () => undefined, authResolver: resolver });
  await be._connect();
  await be.stop();
  const stored = JSON.parse(fs.readFileSync(path.join(credDir, "device-credentials.json"), "utf8"));
  assert.ok(stored.deviceTokens["ws://127.0.0.1:18792"]?.token, "hello-ok 未存回 deviceToken");
  console.log("ok  live: 全新身份 + config.token 直连成功,deviceToken 已持久化");
  cfg = { gatewayUrl: "ws://127.0.0.1:18792", token: "" }; // 清 token,仅剩 deviceToken
  const be2 = new OpenClawBackend({ getUpstreamUrl: () => cfg.gatewayUrl, getOrigin: () => undefined, authResolver: resolver });
  await be2._connect();
  await be2.stop();
  console.log("ok  live: 仅凭存储 deviceToken 重连成功");
}
if (process.argv.includes("--live")) {
  live().then(() => process.exit(failed ? 1 : 0)).catch((e) => { console.error("FAIL live:", e?.message || e); process.exit(1); });
} else {
  process.exit(failed ? 1 : 0);
}
