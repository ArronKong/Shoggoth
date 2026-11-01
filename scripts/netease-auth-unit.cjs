"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const dto = require("../app/core/official-skill-connector-dto");
const url = "https://163cn.tv/fixtureAuth", credentials = { NCM_APP_ID: "fixture-app", NCM_PRIVATE_KEY: "fixture-key" };
const authorization = { success: true, qrCodeUrl: url, clickableUrl: url, message: "后台轮询已启动，请点击链接登录" };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, handler) {
  const base = fs.mkdtempSync("/private/tmp/netease-auth-unit-"); fs.chmodSync(base, 0o700);
  const root = path.join(base, "state/runtime-bin/official-skills/netease-music", crypto.randomUUID()), home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 }); const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
    child.finish = (value, code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; child.stdout.end(typeof value === "string" ? value : JSON.stringify(value)); child.stderr.end(); child.emit("close", code); };
    child.kill = signal => { child.signals ||= []; child.signals.push(signal); queueMicrotask(() => child.finish("", 143)); return true; };
    const call = { args, argv: args.slice(3), options, child }; calls.push(call); queueMicrotask(() => handler(call)); return child;
  };
  const runtime = createOfficialSkillRuntime({ providerId: "netease-music", root, home, env: credentials, ...(handler ? { spawn } : {}) });
  t.after(async () => { await runtime.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root, home, calls, runtime };
}
function pending(call) {
  if (call.argv.includes("--field")) return call.child.finish({ success: true });
  if (call.argv.includes("--check")) return call.child.finish({ success: false, message: "未登录，请执行 ncm-cli login 完成登录" });
  call.child.stdout.write(JSON.stringify(authorization));
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function waitFor(predicate, label) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(`Timed out: ${label}`);
}
function realFixture(t) {
  const f = fixture(t), entry = path.join(f.root, "runtime/dist/index.js"); fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
  const source = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const file=name=>path.join(process.env.HOME,name), args=process.argv.slice(2);
if(args[0]==='config'){console.log('{}');}
else if(args[0]==='logout'){fs.rmSync(file('ready'),{force:true});console.log('{"success":true}');}
else if(args.includes('--check')){console.log(JSON.stringify({loggedIn:fs.existsSync(file('ready'))}));}
else if(process.env.NETEASE_BG_WORKER==='1'){
 fs.writeFileSync(file('poller-'+process.pid),String(process.pid),{mode:0o600});
 const timer=setInterval(()=>{fs.appendFileSync(file('polls'),'.',{mode:0o600});if(fs.existsSync(file('grant'))){fs.writeFileSync(file('ready'),'1',{mode:0o600});clearInterval(timer);}},30);
}else{
 const child=cp.spawn(process.execPath,[__filename,'login','--background','--output','json'],{detached:true,stdio:'ignore',env:{...process.env,NETEASE_BG_WORKER:'1',NCM_LOGIN_UNIKEY:'fixture-unikey'}});
 child.unref();console.log(${JSON.stringify(JSON.stringify(authorization))});
}`;
  fs.writeFileSync(entry, source, { mode: 0o600 });
  fs.writeFileSync(path.join(f.root, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, providerId: "netease-music", files: [{ path: "runtime/dist/index.js", sha256: crypto.createHash("sha256").update(source).digest("hex") }] }), { mode: 0o600 });
  return { ...f, pollers: () => fs.readdirSync(f.home).filter(name => name.startsWith("poller-")).map(name => Number(name.slice(7))) };
}

test("NetEase accepts its official HTTPS short-link host and rejects lookalikes and other providers", () => {
  assert.equal(dto.validOfficialVerificationUrl("netease-music", url), true);
  assert.ok(require("../app/agent-service/official-skill-providers").PROVIDERS["netease-music"].verificationHosts.includes("163cn.tv"));
  for (const value of ["http://163cn.tv/a", "https://163cn.tv.attacker.invalid/a", "https://sub.163cn.tv/a", "https://user@163cn.tv/a", "https://163cn.tv:8443/a", "https://163cn.tv./a"])
    assert.equal(dto.validOfficialVerificationUrl("netease-music", value), false, value);
  assert.equal(dto.validOfficialVerificationUrl("shop", url), false);
});
test("actual CLI output returns a usable link without checking login or exposing tokens", async t => {
  const f = fixture(t, call => {
    if (call.argv.includes("--field")) return call.child.finish({ success: true });
    call.child.stdout.write(JSON.stringify({ ...authorization, accessToken: "fixture-token-private", traceId: "diagnostic-field" }));
  });
  const started = await f.runtime.call("account_start", {});
  assert.equal(started.state, "authorizing"); assert.equal(started.verificationUrl, url);
  assert.equal(f.calls.some(call => call.argv.includes("--check")), false);
  assert.equal(JSON.stringify(started).includes("fixture-token-private"), false);
});
test("provider failure cannot turn an embedded authorization link into success", async t => {
  const f = fixture(t, call => call.child.finish(call.argv.includes("--field") ? {} : { ...authorization, success: false }));
  await assert.rejects(f.runtime.call("account_start", {}), { code: "OFFICIAL_SKILL_AUTH_FAILED" });
});
test("an incomplete or diagnostic JSON line cannot hand off a link before the CLI result", async t => {
  const f = fixture(t, call => {
    if (call.argv.includes("--field")) return call.child.finish({});
    call.child.stdout.write(`HTTP Response: ${JSON.stringify(authorization)}\n`);
    call.child.stdout.write(`{\n"qrCodeUrl": "${url}",\n`);
    setImmediate(() => call.child.finish('"success": false\n}'));
  });
  await assert.rejects(f.runtime.call("account_start", {}), { code: "OFFICIAL_SKILL_AUTH_FAILED" });
});
test("failed poller clears the link and reports a fresh authorization failure", async t => {
  const f = fixture(t, pending); await f.runtime.call("account_start", {});
  f.calls.find(call => call.argv[0] === "login").child.finish("", 1); await tick();
  const result = await f.runtime.call("account_status", {});
  assert.equal(result.state, "signedOut"); assert.equal(result.verificationUrl, null); assert.equal(result.errorCode, "OFFICIAL_SKILL_AUTH_FAILED");
});
test("authorization deadline terminates its process and clears stale authorization", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, pending); await f.runtime.call("account_start", {});
  t.mock.timers.tick(300_000); await tick();
  const result = await f.runtime.call("account_status", {});
  assert.equal(result.state, "signedOut"); assert.equal(result.verificationUrl, null);
  assert.equal(result.errorCode, "OFFICIAL_SKILL_AUTH_FAILED");
  assert.ok(f.calls.find(call => call.argv[0] === "login").child.signals.includes("SIGTERM"));
});
test("cancelling before the link is received stops the command", async t => {
  const f = fixture(t, call => { if (call.argv.includes("--field")) call.child.finish({}); });
  const abort = new AbortController(), started = f.runtime.call("account_start", {}, { signal: abort.signal });
  await tick(); abort.abort(); await assert.rejects(started, { code: "OFFICIAL_SKILL_AUTH_CANCELLED" });
  assert.ok(f.calls.at(-1).child.signals.includes("SIGTERM"));
});
test("real managed CLI keeps the poller alive until authorization becomes ready", async t => {
  const f = realFixture(t), started = await f.runtime.call("account_start", {});
  assert.equal(started.state, "authorizing"); assert.equal(started.verificationUrl, url);
  await waitFor(() => f.pollers().length === 1 && fs.existsSync(path.join(f.home, "polls")), "background polling");
  const [pid] = f.pollers(); assert.ok(alive(pid));
  fs.writeFileSync(path.join(f.home, "grant"), "1", { mode: 0o600 });
  await waitFor(() => fs.existsSync(path.join(f.home, "ready")), "authorization completion");
  assert.equal((await f.runtime.call("account_status", {})).state, "ready");
  await waitFor(() => !alive(pid), "completed poller exit");
});
for (const action of ["restart", "logout", "close"]) test(`real authorization ${action} reaps the managed poller`, async t => {
  const f = realFixture(t); await f.runtime.call("account_start", {});
  await waitFor(() => f.pollers().length === 1, "poller start"); const [pid] = f.pollers();
  if (action === "restart") {
    assert.equal((await f.runtime.call("account_start", {})).state, "authorizing");
    await waitFor(() => f.pollers().length === 2, "replacement poller start");
  } else if (action === "logout") assert.equal((await f.runtime.call("account_logout", {})).state, "signedOut");
  else await f.runtime.close();
  await waitFor(() => !alive(pid), "prior poller stopped");
});
