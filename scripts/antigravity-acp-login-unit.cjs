"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { loginAntigravityAcp } = require("../app/agent-service/antigravity-acp-login");

const FAKE_SERVER = path.join(__dirname, "fixtures", "antigravity-acp-server.cjs");
const ACCOUNT = "native-antigravity-default-v1";

function fixture(t, { env = {}, installState = "installed" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-acp-login-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const log = path.join(root, "server.jsonl");
  const serverPath = path.join(root, "agy_acp_server.par");
  const lines = [];
  const calls = { install: 0, spawn: 0, pids: [] };
  const options = {
    paths,
    runtimeAccountId: ACCOUNT,
    userHome: path.join(root, "user"),
    platform: "linux",
    parentEnv: { PATH: process.env.PATH, BROWSER: "/usr/bin/false", HTTPS_PROXY: "http://127.0.0.1:7897" },
    log: (line) => lines.push(line),
    installState: async () => ({ state: installState }),
    installServer: async () => { calls.install += 1; },
    verifyServer: async () => ({ serverPath, harnessPath: path.join(root, "localharness_external") }),
    spawnProcess: (command, args, spawnOptions) => {
      calls.spawn += 1;
      assert.equal(command, serverPath);
      const child = spawn(process.execPath, [FAKE_SERVER, ...args],
        { ...spawnOptions, env: { ...spawnOptions.env, ...env, FAKE_ACP_LOG: log } });
      calls.pids.push(child.pid);
      return child;
    },
  };
  const records = () => (fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
  return { root, paths, options, lines, calls, records, groupAlive };
}

test("sign-in installs a missing server, lets the server open the browser and records the method", async (t) => {
  const f = fixture(t, { env: { FAKE_ACP_BROWSER_LOGIN: "1" }, installState: "missing" });
  assert.deepEqual(await loginAntigravityAcp(f.options), { authType: "oauth-personal" });
  assert.equal(f.calls.install, 1);
  const login = f.records().find((entry) => entry.method === "browser-login");
  assert.equal(login.browser, null, "the sign-in must not inherit a browser override");
  assert.ok(f.lines.includes("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=fake&state=fake"),
    "the complete authorization URL is shown even when stderr splits it");
  assert.match(f.lines.at(-1), /我已登录/u);
  assert.equal(f.groupAlive(f.calls.pids[0]), false, "the server process group is stopped afterwards");
});

test("an installed server is not downloaded again", async (t) => {
  const f = fixture(t, { env: { FAKE_ACP_BROWSER_LOGIN: "1" } });
  await loginAntigravityAcp(f.options);
  assert.equal(f.calls.install, 0);
});

test("an unsupported platform stops before spawning anything", async (t) => {
  const f = fixture(t, { installState: "unsupported" });
  await assert.rejects(loginAntigravityAcp(f.options), { code: "ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED" });
  assert.deepEqual([f.calls.install, f.calls.spawn], [0, 0]);
});

test("the Service sign-in reports each stage and the authorization URL once", async (t) => {
  const f = fixture(t, { env: { FAKE_ACP_BROWSER_LOGIN: "1" }, installState: "missing" });
  const stages = [];
  const urls = [];
  await loginAntigravityAcp({ ...f.options, onStage: (stage) => stages.push(stage), onAuthUrl: (url) => urls.push(url) });
  assert.deepEqual(stages, ["installing", "starting", "waiting"]);
  assert.deepEqual(urls, ["https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=fake&state=fake"]);
});

test("canceling a sign-in that waits for the browser stops the server", async (t) => {
  const f = fixture(t, { env: { FAKE_ACP_LOGIN_FLOW: "1" } });
  const controller = new AbortController();
  const login = loginAntigravityAcp({ ...f.options, signal: controller.signal,
    onStage: (stage) => { if (stage === "waiting") setTimeout(() => controller.abort(), 50); } });
  await assert.rejects(login, { code: "AUTH_LOGIN_CANCELED" });
  assert.equal(f.groupAlive(f.calls.pids[0]), false, "the server process group is stopped after a cancel");
});

test("canceling during the download never starts the server", async (t) => {
  const f = fixture(t, { installState: "missing" });
  const controller = new AbortController();
  const login = loginAntigravityAcp({ ...f.options, signal: controller.signal,
    installServer: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ANTIGRAVITY_ACP_DOWNLOAD_FAILED" })));
    }),
    onStage: (stage) => { if (stage === "installing") setTimeout(() => controller.abort(), 20); } });
  await assert.rejects(login, { code: "AUTH_LOGIN_CANCELED" });
  assert.equal(f.calls.spawn, 0);
});

test("a server sign-in error is reported with its detail and the server is stopped", async (t) => {
  const f = fixture(t, { env: { FAKE_ACP_AUTH_ERROR: "1" } });
  const error = await loginAntigravityAcp(f.options).catch((value) => value);
  assert.equal(error.code, "ANTIGRAVITY_ACP_REMOTE_ERROR");
  assert.match(error.rpcDetail, /OAuth callback failed/u);
  assert.equal(f.groupAlive(f.calls.pids[0]), false);
});
