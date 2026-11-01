"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
const { LarkCliConnectorController } = require("../app/agent-service/lark-cli-connector-controller");
const { runLarkCli } = require("../app/agent-service/lark-cli-setup-controller");
const { validateLarkCliParams, validateLarkCliResult, validLarkVerificationUrl } = require("../app/core/lark-cli-contract");
const { prepareSetupFixture } = require("./fixtures/lark-cli-setup-fixture.cjs");

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-lark-setup-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const store = new NativeSkillStore({ paths }); store.open(["test-profile"]);
  const controller = new LarkCliConnectorController({ paths, skillStore: store, prepare: prepareSetupFixture }); controller.open();
  t.after(async () => { await controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await controller.handle("connector.lark.install", { expectedRevision: 0 });
  return { root, paths, store, controller, gate: name => fs.writeFileSync(path.join(root, `.fixture-${name}`), "test-only"),
    start: (extra = {}) => controller.handle("connector.lark.setup.start", { expectedRevision: controller.status().revision, mode: "auto", brand: "feishu", ...extra }),
    status: () => controller.handle("connector.lark.setup.status", {}) };
}
async function until(read, predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { const result = await read(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail("Setup did not reach the expected state");
}

test("App setup creates the app, streams two authorization steps/QR codes, verifies and preserves credentials on removal", async t => {
  const f = await fixture(t);
  assert.equal((await f.status()).state, "idle");
  assert.equal(fs.existsSync(path.join(f.root, ".lark-cli/config.json")), false);
  let state = await f.start(); assert.equal(state.state, "starting");
  state = await until(f.status, value => value.state === "configuring" && value.qrCode);
  assert.ok(state.verificationUrl.startsWith("https://open.feishu.cn/page/cli"));
  assert.throws(() => f.controller.handle("connector.lark.remove", { expectedRevision: f.controller.status().revision }), { code: "LARK_CLI_BUSY" });
  f.gate("config-approved");
  state = await until(f.status, value => value.state === "authorizing" && value.qrCode);
  assert.equal(state.userCode, "LOGIN-TEST"); assert.equal(state.configured, true);
  f.gate("auth-approved");
  state = await until(f.status, value => value.state === "ready");
  validateLarkCliResult("connector.lark.setup.status", state); assert.equal(state.userName, "Test User"); assert.equal(state.verificationUrl, null);
  assert.ok(fs.readFileSync(path.join(f.root, ".fixture-calls.jsonl"), "utf8").includes("--verify"));
  fs.unlinkSync(path.join(f.root, ".fixture-auth-approved"));
  await f.start({ mode: "reauthorize" });
  await until(f.status, value => value.state === "authorizing" && value.verificationUrl);
  await f.controller.handle("connector.lark.setup.cancel", { requestId: f.controller.setup.snapshot.requestId });
  await f.controller.handle("connector.lark.remove", { expectedRevision: f.controller.status().revision });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, ".lark-cli/config.json"))).authorized, true);
});

test("cancel targets the active request, drains the process, and retry reuses completed configuration", async t => {
  const f = await fixture(t); f.gate("config-approved");
  const started = await f.start();
  await assert.rejects(f.start(), { code: "LARK_CLI_BUSY" });
  await assert.rejects(f.controller.handle("connector.lark.setup.cancel", { requestId: "00000000-0000-4000-8000-000000000001" }), { code: "LARK_CLI_REVISION_CONFLICT" });
  await until(f.status, value => value.state === "authorizing" && value.verificationUrl);
  const cancelled = await f.controller.handle("connector.lark.setup.cancel", { requestId: started.requestId });
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.verificationUrl, null); assert.equal(f.controller.setup.active, false);
  f.gate("auth-approved"); await f.start();
  assert.equal((await until(f.status, value => value.state === "ready")).configured, true);
  const calls = fs.readFileSync(path.join(f.root, ".fixture-calls.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === "config").length, 1);
});

test("existing app secret travels through stdin only, and configured apps are not overwritten", async t => {
  const f = await fixture(t), secret = "private-app-secret-canary";
  f.gate("auth-approved");
  await f.start({ mode: "existing", appId: "cli_existing_fixture", appSecret: secret, brand: "lark" });
  const state = await until(f.status, value => value.state === "ready");
  assert.equal(state.brand, "lark"); assert.equal(state.appId, "cli_existing_fixture");
  assert.equal(JSON.stringify(state).includes(secret), false);
  const calls = fs.readFileSync(path.join(f.root, ".fixture-calls.jsonl"), "utf8");
  assert.equal(calls.includes(secret), false); assert.ok(calls.includes("--app-secret-stdin")); assert.match(calls, /"--name","shoggoth-[a-f0-9]{8}"/u);
  const configPath = path.join(f.root, ".lark-cli/config.json"), before = fs.readFileSync(configPath, "utf8");
  assert.equal(before.includes(secret), false);
  await f.start({ mode: "existing", appId: "cli_replacement", appSecret: secret });
  await until(f.status, value => !f.controller.setup.active);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("authorization rejection and expiry expose safe errors and remain retryable", async t => {
  const f = await fixture(t); f.gate("config-approved"); f.gate("denied");
  await f.start();
  let state = await until(f.status, value => value.state === "failed");
  assert.equal(state.errorCode, "LARK_CLI_AUTH_FAILED"); assert.equal(JSON.stringify(state).includes("private-auth-canary"), false);
  fs.unlinkSync(path.join(f.root, ".fixture-denied")); f.gate("expired");
  await f.start(); state = await until(f.status, value => value.state === "failed");
  assert.equal(state.errorCode, "LARK_CLI_AUTH_EXPIRED");
  fs.unlinkSync(path.join(f.root, ".fixture-expired")); f.gate("auth-approved");
  await f.start(); assert.equal((await until(f.status, value => value.state === "ready")).configured, true);
});

test("shutdown cancels active authorization, restart reads credentials without replaying login", async t => {
  const f = await fixture(t); await f.start();
  await until(f.status, value => value.verificationUrl);
  await f.controller.close();
  assert.equal(f.controller.setup.active, false);
  f.controller.open();
  assert.equal((await f.status()).state, "idle");
  const calls = fs.readFileSync(path.join(f.root, ".fixture-calls.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === "config").length, 1);
});

test("shutdown also aborts a pending passive account-status read", async t => {
  const f = await fixture(t);
  f.controller.setup.run = (_executable, _args, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const pending = f.status();
  await f.controller.close();
  assert.equal((await pending).errorCode, "LARK_CLI_AUTH_STATUS_FAILED");
});

test("malformed config and untrusted authorization links stop setup without exposing raw output", async t => {
  const f = await fixture(t), configPath = path.join(f.root, ".lark-cli/config.json");
  fs.mkdirSync(path.dirname(configPath)); fs.writeFileSync(configPath, "corrupt-private-canary");
  await f.start(); let state = await until(f.status, value => value.state === "failed");
  assert.equal(state.errorCode, "LARK_CLI_AUTH_STATUS_FAILED"); assert.equal(fs.readFileSync(configPath, "utf8"), "corrupt-private-canary");
  fs.unlinkSync(configPath); f.gate("config-approved"); f.gate("unsafe-url");
  await f.start(); state = await until(f.status, value => value.state === "failed");
  assert.equal(state.verificationUrl, null); assert.equal(JSON.stringify(state).includes("untrusted.example"), false);
});

test("setup contracts reject extra commands, secret shape changes and untrusted URLs", () => {
  assert.throws(() => validateLarkCliParams("connector.lark.setup.start", { expectedRevision: 0, mode: "auto", brand: "feishu", command: "anything" }));
  assert.throws(() => validateLarkCliParams("connector.lark.setup.start", { expectedRevision: 0, mode: "existing", brand: "feishu", appId: ["cli_fake_app"], appSecret: "secret" }));
  assert.throws(() => validateLarkCliParams("connector.lark.setup.start", { expectedRevision: 0, mode: "existing", brand: "feishu", appId: "cli_fake_app", appSecret: "line\nbreak" }));
  assert.equal(validLarkVerificationUrl("https://open.feishu.cn/page/cli?user_code=test"), true);
  for (const url of ["javascript:alert(1)", "https://open.feishu.cn.attacker.example/x", "https://user@open.feishu.cn/x", "http://open.feishu.cn/x", "https://open.feishu.cn:444/x"]) assert.equal(validLarkVerificationUrl(url), false);
});

test("subprocess abort waits for an uncooperative child to be killed", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shg-lark-abort-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "wait.cjs"); fs.writeFileSync(file, "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);");
  const abort = new AbortController(); let ready;
  const began = new Promise(resolve => { ready = resolve; });
  const work = runLarkCli(process.execPath, [file], { env: { PATH: "/usr/bin:/bin", HOME: root }, cwd: root, signal: abort.signal, onLine: () => ready() });
  const rejected = assert.rejects(work, { code: "LARK_CLI_AUTH_CANCELLED" });
  await began; abort.abort(); await rejected;
});
