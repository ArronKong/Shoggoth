"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AntigravityAcpLoginManager } = require("../app/agent-service/antigravity-acp-login-manager");
const { validateRuntimeAccountServiceResult } = require("../app/agent-service/runtime-account-service-protocol");

const ACCOUNT = "native-antigravity-default-v1";
const URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake";
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A controllable stand-in for loginAntigravityAcp.
function fakeLogin() {
  const runs = [];
  const login = (options) => new Promise((resolve, reject) => {
    const run = { options, resolve, reject };
    options.signal.addEventListener("abort", () => {
      if (!run.ignoreAbort) reject(Object.assign(new Error("canceled"), { code: "AUTH_LOGIN_CANCELED" }));
    });
    runs.push(run);
  });
  return { login, runs };
}

let clock = 1_000;
const manager = (fake, options = {}) => new AntigravityAcpLoginManager({
  login: fake.login, now: () => (clock += 1), randomUUID: (() => { let n = 0; return () => `req-${++n}`; })(), ...options,
});
const read = (value) => validateRuntimeAccountServiceResult("runtime.account.login.read", value.read({ runtimeAccountId: ACCOUNT }));

test("a sign-in reports its stages, the server's URL and its success", async () => {
  const fake = fakeLogin();
  const logins = manager(fake);
  assert.deepEqual(read(logins), { login: null });
  const start = validateRuntimeAccountServiceResult("runtime.account.login.start", logins.start({ runtimeAccountId: ACCOUNT }));
  assert.deepEqual(start, { requestId: "req-1", mode: "browser", status: "waiting", loginId: "req-1", authUrl: null });
  await tick();
  const [run] = fake.runs;
  assert.equal(run.options.runtimeAccountId, ACCOUNT);
  assert.equal(read(logins).login.status, "starting");
  run.options.onStage("installing");
  assert.equal(read(logins).login.stage, "installing");
  run.options.onStage("waiting");
  run.options.onAuthUrl(URL);
  assert.deepEqual({ ...read(logins).login, updatedAt: 0 }, {
    requestId: "req-1", mode: "browser", status: "waiting", updatedAt: 0, errorCode: null,
    authUrl: URL, stage: "waiting", browserOpened: true, instructions: null, codeRequired: false,
  });
  assert.throws(() => logins.start({ runtimeAccountId: ACCOUNT }), { code: "AUTH_LOGIN_IN_PROGRESS" });
  run.resolve({ authType: "oauth-personal" });
  await tick();
  assert.equal(read(logins).login.status, "succeeded");
  assert.equal(read(logins).login.stage, null);
  assert.equal(logins.start({ runtimeAccountId: ACCOUNT }).requestId, "req-2", "a finished sign-in can start again");
});

test("failures keep only public error codes", async () => {
  for (const [code, expected] of [["ANTIGRAVITY_ACP_DOWNLOAD_FAILED", "ANTIGRAVITY_ACP_DOWNLOAD_FAILED"],
    ["SOMETHING_INTERNAL", "AUTH_LOGIN_FAILED"]]) {
    const fake = fakeLogin();
    const logins = manager(fake);
    logins.start({ runtimeAccountId: ACCOUNT });
    await tick();
    fake.runs[0].reject(Object.assign(new Error("x"), { code }));
    await tick(); await tick();
    assert.deepEqual([read(logins).login.status, read(logins).login.errorCode], ["failed", expected]);
  }
});

test("canceling stops the sign-in and reports canceled", async () => {
  const fake = fakeLogin();
  const logins = manager(fake);
  logins.start({ runtimeAccountId: ACCOUNT });
  await tick();
  await assert.rejects(logins.cancel({ runtimeAccountId: ACCOUNT, requestId: "other" }), { code: "AUTH_LOGIN_NOT_FOUND" });
  const result = await logins.cancel({ runtimeAccountId: ACCOUNT, requestId: "req-1" });
  assert.deepEqual(validateRuntimeAccountServiceResult("runtime.account.login.cancel", result), { requestId: "req-1", status: "canceled" });
  assert.equal(fake.runs[0].options.signal.aborted, true);
});

test("a sign-in that does not stop in time is unknown, not canceled", async () => {
  const fake = fakeLogin();
  const logins = manager(fake, { cancelSettleMs: 20 });
  logins.start({ runtimeAccountId: ACCOUNT });
  await tick();
  fake.runs[0].ignoreAbort = true;
  // The manager's timers are unref'd (the Service socket keeps it alive).
  const keepAlive = setInterval(() => {}, 1_000);
  const result = await logins.cancel({ runtimeAccountId: ACCOUNT, requestId: "req-1" })
    .finally(() => clearInterval(keepAlive));
  assert.deepEqual(validateRuntimeAccountServiceResult("runtime.account.login.cancel", result), { requestId: "req-1", status: "unknown" });
});

test("a sign-in times out with its own code", async () => {
  const fake = fakeLogin();
  const logins = manager(fake, { timeoutMs: 10 });
  logins.start({ runtimeAccountId: ACCOUNT });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual([read(logins).login.status, read(logins).login.errorCode], ["timed_out", "AUTH_LOGIN_TIMEOUT"]);
});

test("closing the manager stops active sign-ins and refuses new ones", async () => {
  const fake = fakeLogin();
  const logins = manager(fake);
  logins.start({ runtimeAccountId: ACCOUNT });
  await tick();
  logins.close();
  await tick(); await tick();
  assert.equal(fake.runs[0].options.signal.aborted, true);
  assert.equal(read(logins).login.status, "canceled");
  assert.throws(() => logins.start({ runtimeAccountId: ACCOUNT }), { code: "AUTH_MANAGER_CLOSED" });
});
