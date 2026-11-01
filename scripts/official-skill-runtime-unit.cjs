#!/usr/bin/env node
"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream"), { spawn, spawnSync } = require("node:child_process");
const { createOfficialSkillRuntime, assertManagedHome } = require("../app/agent-service/official-skill-runtime");
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, providerId, handler, env = {}) {
  const base = fs.mkdtempSync("/private/tmp/official-runtime-unit-"); fs.chmodSync(base, 0o700);
  const root = path.join(base, "state", "runtime-bin", "official-skills", providerId, crypto.randomUUID()), home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (providerId === "shop") fs.writeFileSync(path.join(root, "shop-tools.json"), JSON.stringify({ tools: require("./fixtures/shop-mcp.json").tools.tools }), { mode: 0o600 });
  const calls = [], children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
    child.finish = (value = {}, code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; child.stdout.end(typeof value === "string" ? value : JSON.stringify(value)); child.stderr.end(); child.emit("close", code); };
    child.kill = signal => { child.signals ||= []; child.signals.push(signal); if (!child.ignoreKill) queueMicrotask(() => child.finish("", 143)); return true; };
    const argv = args[0] === "--require" ? args.slice(3) : args;
    const entry = args[0] === "--require" ? args[2] : command;
    const call = { command, args, argv, entry, options, child, input: "" }; calls.push(call); children.push(child);
    child.stdin.on("data", bytes => { call.input += bytes; });
    queueMicrotask(() => handler?.(call)); return child;
  };
  const runtime = createOfficialSkillRuntime({ providerId, root, home, spawn, env, validate() {} });
  t.after(async () => { await runtime.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root, home, calls, children, runtime, spawn };
}
test("schemas expose only fixed capabilities and reject endpoint, executable and extra arguments", async t => {
  for (const provider of require("../app/core/official-skill-connector-dto").OFFICIAL_SKILL_IDS) {
    const f = fixture(t, provider);
    assert.ok(f.runtime.tools.every(tool => tool.inputSchema.additionalProperties === false));
    await assert.rejects(f.runtime.call("execute", { command: "id" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
    await assert.rejects(f.runtime.call("account_status", { endpoint: "https://example.invalid" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
    assert.equal(f.calls.length, 0);
  }
});
test("WeRead uses one fixed endpoint, flat parameters and the declared version; errors and upgrade responses fail", async t => {
  const f = fixture(t, "weread"), requests = []; let response = { errcode: 0, results: [] };
  const runtime = createOfficialSkillRuntime({ providerId: "weread", root: f.root, home: f.home, env: { WEREAD_API_KEY: "wrk-fixture-private-value" },
    fetch: async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(response)); } });
  await runtime.call("search_books", { keyword: "三体", scope: 10, count: 3 });
  assert.equal(requests[0].url, "https://i.weread.qq.com/api/agent/gateway");
  assert.deepEqual(JSON.parse(requests[0].init.body), { keyword: "三体", scope: 10, count: 3, api_name: "/store/search", skill_version: "1.0.5" });
  assert.equal(requests[0].init.redirect, "error");
  for (const value of [{ errcode: 401 }, { errcode: 0, upgrade_info: { message: "upgrade" } }]) { response = value; await assert.rejects(runtime.call("account_status", {})); }
  await runtime.close();
});
test("Meituan authorization consumes the official auth_link then exchanges the session on explicit status", async t => {
  let hasToken = false;
  const f = fixture(t, "meituan-paotui", call => {
    const command = call.argv[0];
    if (call.argv[1] === "get-code") return call.child.finish({ auth_link: "https://passport.meituan.com/fixture", direct_auth_link: null });
    if (call.argv[1] === "poll-token") { hasToken = true; return call.child.finish({ token: "fixture-passport-private" }); }
    if (command === "get-token") return call.child.finish(hasToken ? "fixture-passport-private" : "", hasToken ? 0 : 1);
    if (command === "login") return call.child.finish({ success: true });
  });
  assert.equal((await f.runtime.call("account_start", {})).state, "authorizing");
  const status = await f.runtime.call("account_status", {});
  assert.equal(status.state, "ready"); assert.equal(JSON.stringify(status).includes("fixture-passport-private"), false);
  assert.ok(f.calls.some(call => call.argv[1] === "poll-token"));
});
test("Meituan timeout clears authorization, and prices above 100 yuan require a second confirmation", async t => {
  let pollsFail = true;
  const f = fixture(t, "meituan-paotui", call => {
    if (call.argv[1] === "get-code") return call.child.finish({ auth_link: "https://passport.meituan.com/fixture" });
    if (call.argv[1] === "poll-token") return call.child.finish({ error: "timeout" }, 1);
    if (call.argv[0] === "get-token") return call.child.finish(pollsFail ? "" : "fixture-passport-private", pollsFail ? 1 : 0);
    if (call.argv[0] === "delivery_preview") return call.child.finish({ orderToken: "preview-private-token", _deliveryFee: 150, _previewTotal: 150 });
    if (call.argv[0] === "submit_order") return call.child.finish({ orderId: "order-fixture" });
  });
  await f.runtime.call("account_start", {}); const failed = await f.runtime.call("account_status", {}); assert.equal(failed.state, "signedOut"); assert.equal(failed.verificationUrl, null);
  pollsFail = false;
  const address = { lat: 40000000, lng: 116000000, address: "Fixture address", phone: "13000000000" };
  const args = { sender: address, recipient: address, goods: { goodsName: "文件", goodsWeight: 1, goodTypes: [4], goodTypeNames: ["文件"] }, serviceType: "1003" };
  const preview = await f.runtime.call("delivery_preview", args);
  assert.equal(preview.highValueConfirmationRequired, true); assert.equal(preview.orderToken, undefined);
  await assert.rejects(f.runtime.call("submit_order", { previewId: preview.previewId, confirmed: true }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.filter(call => call.argv[0] === "submit_order").length, 0);
  await f.runtime.call("submit_order", { previewId: preview.previewId, confirmed: true, highValueConfirmed: true });
  const sent = f.calls.find(call => call.argv[0] === "submit_order").argv;
  assert.equal(sent[sent.indexOf("--delivery-fee") + 1], "150");
  await assert.rejects(f.runtime.call("submit_order", { previewId: preview.previewId, confirmed: true, highValueConfirmed: true }));
});
test("NetEase config uses secret stdin and the verified playlistName flag; unrelated environment is absent", async t => {
  const appId = "fixture-app-private", key = "fixture-private-key-value";
  const f = fixture(t, "netease-music", call => call.child.finish({ success: true }), { NCM_APP_ID: appId, NCM_PRIVATE_KEY: key, OTHER_SECRET: "must-not-forward", NODE_OPTIONS: "--eval=evil" });
  await f.runtime.call("create_playlist", { name: "跑步", confirmed: true });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].input, JSON.stringify(appId)); assert.equal(f.calls[1].input, JSON.stringify(key));
  assert.equal(f.calls.some(call => call.args.includes(key) || call.args.includes(appId)), false);
  assert.ok(f.calls[2].argv.includes("--playlistName")); assert.equal(f.calls[2].options.env.OTHER_SECRET, undefined); assert.equal(f.calls[2].options.env.NODE_OPTIONS, undefined);
  await assert.rejects(f.runtime.call("update_playlist_tracks", {}), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
});
test("NetEase trims saved credential boundaries before authorization and preserves private-key line breaks", async t => {
  const appId = "fixture-app-private", key = "-----BEGIN PRIVATE KEY-----\nfixture-private-key-value\n-----END PRIVATE KEY-----";
  const env = { NCM_APP_ID: ` ${appId}\t`, NCM_PRIVATE_KEY: `\r\n${key}\r\n` };
  const f = fixture(t, "netease-music", call => {
    if (call.argv.includes("--field")) return call.child.finish({ success: true });
    call.child.finish({ verification_url: "https://music.163.com/authorize/fixture" });
  }, env);
  const result = await f.runtime.call("account_start", {});
  assert.equal(f.calls[0].input, JSON.stringify(appId));
  assert.equal(f.calls[1].input, JSON.stringify(key));
  assert.equal(f.calls[2].options.env.NETEASE_APP_ID, appId);
  assert.equal(f.calls[2].options.env.NETEASE_PRIVATE_KEY, key);
  assert.equal(result.state, "authorizing");
  assert.equal(result.verificationUrl, "https://music.163.com/authorize/fixture");
  assert.equal(env.NCM_APP_ID, ` ${appId}\t`, "normalization does not mutate the shared environment");
  assert.equal(env.NCM_PRIVATE_KEY, `\r\n${key}\r\n`);
  assert.equal(JSON.stringify(f.calls.map(call => call.args)).includes(appId), false);
  assert.equal(JSON.stringify(result).includes("fixture-private-key-value"), false);
});
test("NetEase whitespace-only credentials cannot start a provider process", async t => {
  for (const env of [{ NCM_APP_ID: " \t", NCM_PRIVATE_KEY: "fixture-key" }, { NCM_APP_ID: "fixture-app", NCM_PRIVATE_KEY: "\r\n " }]) {
    const f = fixture(t, "netease-music", call => call.child.finish({ success: true }), env);
    const result = await f.runtime.call("account_start", {});
    assert.equal(result.state, "signedOut");
    assert.equal(result.errorCode, "OFFICIAL_SKILL_AUTH_UNSUPPORTED");
    assert.equal(f.calls.length, 0);
  }
});
const paymentContext = { officialSessionId: "1b250e6c-534b-43cf-82fa-edfbd91d098e" };
const payment = suffix => ({ cashierLink: `https://cashier.alipay.com/fixture-${suffix}`, amountYuan: 12, payee: "Fixture merchant", purpose: "Fixture order", confirmed: true });
test("Alipay rejects missing or invalid trusted session context and model-supplied session arguments before dispatch", async t => {
  const f = fixture(t, "alipay", call => call.child.finish({ code: 200, message: "ready", access_url: "" }));
  for (const officialSessionId of [undefined, null, "fixture-session", "00000000-0000-0000-0000-000000000000", "1b250e6c-534b-43cf-02fa-edfbd91d098e", 1, {}])
    await assert.rejects(f.runtime.call("submit_payment", payment("invalid-session"), { officialSessionId }), { code: "OFFICIAL_SKILL_SESSION_REQUIRED" });
  for (const extra of [{ officialSessionId: paymentContext.officialSessionId }, { sessionId: paymentContext.officialSessionId }, { _meta: { "shoggoth/official-session-id": paymentContext.officialSessionId } }])
    await assert.rejects(f.runtime.call("submit_payment", { ...payment("spoofed-session"), ...extra }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(f.home, "operation-guards.json")), false);
  assert.equal((await f.runtime.call("account_status", {})).state, "ready", "account checks do not require payment session metadata");
});
test("real stdio bridge passes only dedicated session metadata into the native payment CLI", async t => {
  const f = fixture(t, "alipay"), relative = "runtime/alipay-bot", executable = path.join(f.root, relative);
  fs.mkdirSync(path.dirname(executable), { mode: 0o700 });
  const source = `#!${process.execPath}\nconst index=process.argv.indexOf('--session-id');console.log(JSON.stringify({code:200,message:'ready',access_url:'',sessionId:index<0?null:process.argv[index+1]}));\n`;
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.writeFileSync(path.join(f.root, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, providerId: "alipay", files: [{ path: relative, sha256: crypto.createHash("sha256").update(source).digest("hex") }] }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve("app/agent-service/official-skill-mcp-bridge.js"), "--provider", "alipay", "--root", f.root, "--home", f.home],
    { cwd: f.home, env: { HOME: f.home, PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", errors = "", nextId = 0; const pending = new Map();
  child.stderr.on("data", bytes => { errors += bytes; });
  child.stdout.on("data", bytes => {
    buffer += bytes;
    while (buffer.includes("\n")) { const index = buffer.indexOf("\n"), result = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); const request = pending.get(result.id); if (request) { pending.delete(result.id); clearTimeout(request.timer); request.resolve(result); } }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) child.kill("SIGTERM"); await closed; for (const item of pending.values()) clearTimeout(item.timer); });
  const request = params => new Promise((resolve, reject) => { const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`bridge timeout: ${errors}`)); }, 5000); pending.set(id, { resolve, timer }); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`); });
  assert.equal((await request({ name: "submit_payment", arguments: payment("bridge-missing") })).error.message, "OFFICIAL_SKILL_SESSION_REQUIRED");
  assert.equal((await request({ name: "submit_payment", arguments: { ...payment("bridge-spoof"), sessionId: paymentContext.officialSessionId } })).error.message, "OFFICIAL_SKILL_INVALID_ARGUMENT");
  assert.equal((await request({ name: "submit_payment", arguments: payment("bridge-invalid"), _meta: { "shoggoth/official-session-id": "not-a-session" } })).error.message, "OFFICIAL_SKILL_SESSION_REQUIRED");
  const valid = await request({ name: "submit_payment", arguments: payment("bridge-valid"), _meta: { "shoggoth/official-session-id": paymentContext.officialSessionId } });
  assert.equal(JSON.parse(valid.result.content[0].text).sessionId, paymentContext.officialSessionId);
  const account = await request({ name: "account_status", arguments: {} }); assert.equal(JSON.parse(account.result.content[0].text).state, "ready");
});
test("Alipay keeps query credentials private and prevents duplicate cashier submissions across runtime restarts", async t => {
  const outShakeNo = "20260617008282174448790088372682";
  const f = fixture(t, "alipay", call => call.child.finish({ code: 200, outShakeNo, message: "pending" }));
  const result = await f.runtime.call("submit_payment", payment("one"), paymentContext);
  assert.equal(JSON.stringify(result).includes(outShakeNo), false); assert.ok(result.receiptId);
  assert.equal(f.calls[0].argv[f.calls[0].argv.indexOf("--session-id") + 1], paymentContext.officialSessionId);
  assert.ok(f.calls[0].args.includes("--json")); assert.equal(f.calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  await f.runtime.call("payment_status", { receiptId: result.receiptId });
  assert.ok(f.calls[1].argv.includes(outShakeNo));
  await assert.rejects(f.runtime.call("submit_payment", payment("one"), paymentContext), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  const restarted = createOfficialSkillRuntime({ providerId: "alipay", root: f.root, home: f.home, spawn: f.spawn });
  await assert.rejects(restarted.call("submit_payment", payment("one"), paymentContext), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  await assert.rejects(restarted.call("payment_status", { receiptId: result.receiptId }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.length, 2, "lost receipts must not trigger a provider call");
  await restarted.close();
  const ledger = fs.readFileSync(path.join(f.home, "operation-guards.json"), "utf8");
  assert.equal(ledger.includes("cashier.alipay.com"), false); assert.equal(ledger.includes(outShakeNo), false);
});
test("Alipay never treats a wallet link or arbitrary final text URL as a payment query credential", async t => {
  const f = fixture(t, "alipay", call => call.child.finish({ code: 200, access_url: "https://u.alipay.cn/wallet-only" }));
  const result = await f.runtime.call("submit_payment", payment("wallet"), paymentContext); assert.equal(result.receiptId, null);
});
test("cancelling a dispatched payment waits for confirmed child exit before the next operation starts", async t => {
  const f = fixture(t, "alipay", call => { call.child.ignoreKill = true; });
  const abort = new AbortController(), first = f.runtime.call("submit_payment", payment("cancel-first"), { ...paymentContext, signal: abort.signal });
  const rejected = assert.rejects(first, { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  await tick(); assert.equal(f.calls.length, 1); abort.abort();
  const second = f.runtime.call("submit_payment", payment("cancel-second"), paymentContext); await tick();
  assert.equal(f.calls.length, 1, "queue remains held while the first subprocess is alive");
  f.calls[0].child.finish("", 143); await rejected; await tick(); assert.equal(f.calls.length, 2);
  f.calls[1].child.finish({ code: 200, message: "completed" }); await second;
});
test("private HOME rejects symlinked cache paths before executing a provider", async t => {
  const f = fixture(t, "fliggy", call => call.child.finish({ success: true }));
  fs.symlinkSync(f.base, path.join(f.home, ".config"));
  assert.throws(() => assertManagedHome(f.home), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
  await assert.rejects(f.runtime.call("travel_search", { query: "杭州" })); assert.equal(f.calls.length, 0);
});

test("Alipay locates the macOS PayGuard helper independently of its private wallet HOME", { skip: process.platform !== "darwin" }, async t => {
  const env = { HOME: "/untrusted-home", PAYGUARD_INSTALL_DIR: "/untrusted-helper", PAYGUARD_INSTALL_LOCK_DIR: "/untrusted-lock", SKIP_PAYGUARD_INSTALL: "1" };
  const f = fixture(t, "alipay", call => call.child.finish({ code: 200, message: "已申请开通，等待授权", access_url: "https://u.alipay.cn/fixture-wallet" }), env);
  assert.equal((await f.runtime.call("account_start", {})).state, "authorizing");
  const forwarded = f.calls[0].options.env;
  assert.equal(forwarded.PAYGUARD_INSTALL_DIR, path.join(require("node:os").userInfo().homedir, "Library", "Application Support", "com.alipay.agent.payguard", "PayGuard.app"));
  assert.equal(forwarded.HOME, f.home); assert.equal(forwarded.TMPDIR, path.join(f.home, "tmp"));
  assert.equal(forwarded.PAYGUARD_INSTALL_LOCK_DIR, undefined); assert.equal(forwarded.SKIP_PAYGUARD_INSTALL, undefined);
  assert.equal(forwarded.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PAYGUARD_INSTALL_DIR, "/untrusted-helper", "the caller's shared environment is unchanged");
});

test("PayGuard discovery is restricted to the native Alipay CLI", () => {
  const { commandEnvironment } = require("../app/agent-service/official-skill-runtime");
  for (const [providerId, native] of [["fliggy", true], ["alipay", false], ["doordash", true]]) {
    const env = commandEnvironment(providerId, "/private-fixture-home", { PAYGUARD_INSTALL_DIR: "/untrusted-helper", SKIP_PAYGUARD_INSTALL: "1" }, {}, native);
    assert.equal(env.PAYGUARD_INSTALL_DIR, undefined); assert.equal(env.SKIP_PAYGUARD_INSTALL, undefined);
  }
});

function alipayVendorState(home) {
  for (const relative of ["Library", "Library/Logs", "Library/LaunchAgents", "Library/Application Support", "Library/Application Support/com.alipay.agent.payguard"]) {
    const directory = path.join(home, relative); fs.mkdirSync(directory, { recursive: true, mode: 0o755 }); fs.chmodSync(directory, 0o755);
  }
  const cache = path.join(home, ".alipay-bot-cli"); fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  for (const relative of [".alipay-bot-cli/environment-detection-cache.json", "Library/Logs/com.alipay.agent.payguard.install.log", "Library/Logs/com.alipay.agent.payguard.preinstall.log"]) {
    const file = path.join(home, relative); fs.writeFileSync(file, "vendor-cache-canary", { mode: 0o644 }); fs.chmodSync(file, 0o644);
  }
}

async function alipayStdio(t, { vendorState = false, trusted = true, unsafe, missingRuntime = false } = {}) {
  const f = fixture(t, "alipay");
  if (vendorState) alipayVendorState(f.home);
  unsafe?.(f);
  const executable = path.join(f.root, "runtime/alipay-bot"); fs.mkdirSync(path.dirname(executable), { mode: 0o700 });
  const source = `#!${missingRuntime ? "/shoggoth-fixture-missing-interpreter" : process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
if(process.platform==='darwin')require('node:assert/strict').equal(process.env.PAYGUARD_INSTALL_DIR,path.join(require('node:os').userInfo().homedir,'Library','Application Support','com.alipay.agent.payguard','PayGuard.app'));
fs.appendFileSync(path.join(process.env.HOME,'provider-invoked'), '1', {mode:0o600});
(${alipayVendorState.toString()})(process.env.HOME);
console.log(JSON.stringify(process.argv[2]==='apply-wallet'?{code:200,message:'已申请开通，等待授权',access_url:'https://u.alipay.cn/fixture-wallet'}:{code:200,message:'ready',access_url:''}));\n`;
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.writeFileSync(path.join(f.root, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, providerId: "alipay", files: [{ path: "runtime/alipay-bot", sha256: crypto.createHash("sha256").update(source).digest("hex") }] }), { mode: 0o600 });
  const { StdioMcpClient } = require("../app/agent-service/native-mcp-client-manager");
  const client = new StdioMcpClient({ command: process.execPath, args: [path.resolve("app/agent-service/official-skill-mcp-bridge.js"), "--provider", "alipay", "--root", f.root, "--home", f.home], cwd: f.root },
    { trustedOfficialBridge: trusted, trustedEnv: { ELECTRON_RUN_AS_NODE: "1", HOME: f.home }, readinessTimeoutMs: 5000 });
  await client.start();
  return { ...f, client, call: name => client.request("tools/call", { name, arguments: {} }, 5000) };
}

test("real Alipay bridge repairs the pinned CLI's cache/log modes without changing content or losing authorization", async t => {
  const f = await alipayStdio(t, { vendorState: true });
  const wallet = path.join(f.home, ".alipay-bot-cli/wallet.json"); fs.writeFileSync(wallet, "private-wallet-canary", { mode: 0o600 });
  try {
    const started = JSON.parse((await f.call("account_start")).content[0].text);
    assert.equal(started.state, "authorizing"); assert.equal(started.verificationUrl, "https://u.alipay.cn/fixture-wallet");
    assertManagedHome(f.home);
    assert.equal(fs.readFileSync(wallet, "utf8"), "private-wallet-canary");
    assert.equal(fs.readFileSync(path.join(f.home, ".alipay-bot-cli/environment-detection-cache.json"), "utf8"), "vendor-cache-canary");
    assert.equal(fs.statSync(path.join(f.home, "Library")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.home, ".alipay-bot-cli/environment-detection-cache.json")).mode & 0o777, 0o600);
    const checked = JSON.parse((await f.call("account_status")).content[0].text);
    assert.equal(checked.state, "ready"); assertManagedHome(f.home);
    assert.equal(fs.readFileSync(path.join(f.home, "provider-invoked"), "utf8"), "11");
  } finally { await f.client.close(); }
});

for (const trusted of [true, false]) test(`Alipay integrity errors cross only a validated bridge (trusted=${trusted})`, async t => {
  const f = await alipayStdio(t, { trusted, vendorState: true, unsafe: f => fs.writeFileSync(path.join(f.home, "unexpected-credential.json"), "private-error-canary", { mode: 0o644 }) });
  try {
    await assert.rejects(f.call("account_start"), error => error.code === (trusted ? "OFFICIAL_SKILL_INTEGRITY_FAILED" : "MCP_SERVER_CALL_FAILED") && !error.message.includes("private-error-canary"));
    assert.equal(fs.existsSync(path.join(f.home, "provider-invoked")), false, "invalid HOME blocks the native CLI before dispatch");
    assert.equal(fs.statSync(path.join(f.home, "unexpected-credential.json")).mode & 0o777, 0o644, "unrecognized files are never adopted or changed");
    assert.equal(fs.statSync(path.join(f.home, "Library")).mode & 0o777, 0o755, "failed full-tree validation changes no modes");
  } finally { await f.client.close(); }
});

for (const trusted of [true, false]) test(`Alipay missing-runtime errors cross only a validated bridge (trusted=${trusted})`, async t => {
  const f = await alipayStdio(t, { trusted, missingRuntime: true });
  try {
    await assert.rejects(f.call("account_start"), { code: trusted ? "OFFICIAL_SKILL_RUNTIME_MISSING" : "MCP_SERVER_CALL_FAILED" });
    assert.equal(fs.existsSync(path.join(f.home, "provider-invoked")), false);
  } finally { await f.client.close(); }
});

for (const unsafe of ["symlink", "hardlink", "writable-cache", "unknown-directory"]) test(`Alipay mode repair refuses ${unsafe} without touching external data or starting a provider`, async t => {
  const f = fixture(t, "alipay"); alipayVendorState(f.home);
  const outside = path.join(f.base, "outside-cache"); fs.writeFileSync(outside, "keep-external-data", { mode: 0o644 });
  const cache = path.join(f.home, ".alipay-bot-cli/environment-detection-cache.json");
  if (unsafe === "symlink" || unsafe === "hardlink") { fs.unlinkSync(cache); if (unsafe === "symlink") fs.symlinkSync(outside, cache); else fs.linkSync(outside, cache); }
  if (unsafe === "writable-cache") fs.chmodSync(cache, 0o666);
  if (unsafe === "unknown-directory") { const directory = path.join(f.home, "unexpected"); fs.mkdirSync(directory); fs.chmodSync(directory, 0o755); }
  await assert.rejects(f.runtime.call("account_start", {}), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
  assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(outside, "utf8"), "keep-external-data");
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(f.home, "Library")).mode & 0o777, 0o755);
});

test("a non-Alipay CLI cannot inherit the compatibility exception", async t => {
  const f = fixture(t, "fliggy"); alipayVendorState(f.home);
  await assert.rejects(f.runtime.call("travel_search", { query: "杭州" }), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
  assert.equal(f.calls.length, 0); assert.equal(fs.statSync(path.join(f.home, "Library")).mode & 0o777, 0o755);
});

test("HOME failure after a dispatched Alipay payment keeps an uncertain receipt and never replays it", async t => {
  const f = fixture(t, "alipay", call => { fs.writeFileSync(path.join(f.home, "unexpected-credential.json"), "private-payment-canary", { mode: 0o644 }); call.child.finish({ code: 200, message: "completed" }); });
  await assert.rejects(f.runtime.call("submit_payment", payment("unsafe-result"), paymentContext), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  await assert.rejects(f.runtime.call("submit_payment", payment("unsafe-result"), paymentContext), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.length, 1); assert.equal(fs.statSync(path.join(f.home, "unexpected-credential.json")).mode & 0o777, 0o644);
});

test("official Node CLIs parse script arguments under Node and packaged Electron", t => {
  const f = fixture(t, "fliggy"), script = path.join(f.root, "cli.cjs");
  fs.writeFileSync(script, `const { Command } = require(${JSON.stringify(require.resolve("commander"))});
const cli = new Command();
cli.command('keyword-search').requiredOption('--query <text>').action(options => {
  console.log(JSON.stringify({ query: options.query, electron: !!process.versions.electron }));
});
cli.parse();`, { mode: 0o600 });
  for (const executable of [process.execPath, require("electron")]) {
    const result = spawnSync(executable, ["--require", path.resolve("app/agent-service/official-skill-child-bootstrap.js"), script, "keyword-search", "--query", "杭州旅行"], {
      env: { HOME: f.home, PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" }, cwd: f.home, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { query: "杭州旅行", electron: executable !== process.execPath });
  }
});
test("the audited Meituan session pathname is remapped into only this installation HOME", t => {
  const f = fixture(t, "meituan-paotui"); fs.mkdirSync(path.join(f.home, "tmp"), { mode: 0o700 });
  const script = `require('fs').writeFileSync('/tmp/pt_passport_session_9fbb5793917d7477.json', 'fixture-private-session', {mode:0o600});`;
  const result = spawnSync(process.execPath, ["--require", path.resolve("app/agent-service/official-skill-child-bootstrap.js"), "-e", script], { env: { HOME: f.home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.home, "tmp", "pt_passport_session_9fbb5793917d7477.json"), "utf8"), "fixture-private-session");
});
test("real Node CLI descendants cannot detach and survive command completion", async t => {
  const f = fixture(t, "fliggy"), target = path.join(f.root, "runtime", "dist"); fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const pidFile = path.join(f.home, "child.pid");
  const childSource = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), {mode:0o600}); setInterval(()=>{},1000);`;
  fs.writeFileSync(path.join(target, "flyai-bundle.cjs"), `const fs=require('fs'),cp=require('child_process'); const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});child.unref();const check=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(check);console.log(JSON.stringify({success:true}));}},10);`, { mode: 0o600 });
  const runtime = createOfficialSkillRuntime({ providerId: "fliggy", root: f.root, home: f.home, env: {} });
  let pid;
  try {
    const result = await runtime.call("travel_search", { query: "fixture" }); assert.equal(result.success, true);
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let index = 0; index < 30 && alive; index++) { await new Promise(resolve => setTimeout(resolve, 10)); try { process.kill(pid, 0); } catch { alive = false; } }
    assert.equal(alive, false, "the command's child process must exit with its managed process group");
  } finally { if (pid) try { process.kill(pid, "SIGKILL"); } catch {} await runtime.close(); }
});
