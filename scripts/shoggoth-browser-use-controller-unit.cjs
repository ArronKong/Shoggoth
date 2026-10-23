"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { BrowserUseController, boundedBrowserResult } = require("../app/agent-service/browser-use-controller");
const { browserError, validateBrowserState } = require("../app/agent-service/browser-use-protocol");
const { normalizeConfig, createConfigStore } = require("../app/core/config-store");
const { registerDesktopBrowserIpc, BROWSER_STATE_CHANNEL } = require("../app/desktop-browser-ipc");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAuthorityBackup } = require("../app/agent-service/authority-backup");

const navigation = { name: "browser_navigate", inputSchema: { type: "object",
  properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } };
const snapshot = { name: "browser_snapshot", inputSchema: { type: "object", additionalProperties: false } };
function fixture(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-browser-unit-")));
  const settings = { enabled: true, browser: "chrome", headless: true, isolated: true };
  let authorized = true;
  const calls = [], launches = [], closes = [];
  const controller = new BrowserUseController({ paths: { stateDir: root, trustedRoot: root },
    getSettings: () => settings, isAuthorized: () => authorized,
    engineStatus: () => "0.0.82", executable: () => "/browser",
    clientFactory: async input => {
      launches.push(input);
      return { listTools: async () => [navigation, snapshot, { name: "browser_run_code_unsafe", inputSchema: {} }],
        callTool: async (name, args) => { input.assertCurrent(); calls.push([name, args]);
          return { content: [{ type: "text", text: "done" }] }; },
        close: async () => { closes.push(input.sessionId); } };
    }, ...overrides,
  });
  controller.open();
  t.after(async () => { await controller.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const create = (extra = {}) => controller.create({ profileId: "agent-a", workRunId: "run-a", workspace: root,
    ...extra });
  const input = session => ({ sessionId: session.id, profileId: session.profileId, workRunId: session.workRunId });
  const call = (session, name = "browser_snapshot", args = {}) => controller.callTool({ ...input(session), toolName: name, arguments: args });
  return { root, settings, controller, calls, launches, closes, create, input, call,
    revoke: () => { authorized = false; } };
}
const code = expected => error => error.code === expected;

test("Browser profile caches and process locks are excluded from authority backup", t => {
  const f = fixture(t), paths = resolveServicePaths({ userDataRoot: f.root, trustedRoot: f.root,
    cacheRoot: path.join(f.root, "cache") });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const profile = path.join(paths.stateDir, "browser-use", "profiles", "agent-a", "chrome");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profile, "Cookies"), "private browser login state");
  fs.symlinkSync("/nonexistent/browser-process-lock", path.join(profile, "SingletonLock"));
  fs.writeFileSync(path.join(paths.stateDir, "product-fixture.json"), "{}", { mode: 0o600 });
  const backup = createAuthorityBackup({ paths, backupId: "browser-profile-exclusion" });
  assert.equal(backup.manifest.entries.some(entry => entry.path.startsWith("browser-use")), false);
  assert.equal(backup.manifest.entries.some(entry => entry.path === "product-fixture.json"), true);
  assert.equal(fs.existsSync(path.join(profile, "Cookies")), true);
});

test("Browser settings default once; invalid or unreadable config stays disabled", t => {
  assert.deepEqual(normalizeConfig({}).browserUse, { enabled: true, browser: "chrome", headless: false, isolated: true });
  for (const raw of [null, true, {}, { enabled: "true", browser: "chrome", headless: false, isolated: true }]) {
    assert.equal(normalizeConfig({ browserUse: raw }).browserUse.enabled, false);
  }
  const f = fixture(t), config = createConfigStore(path.join(f.root, "config.json"));
  assert.equal(normalizeConfig({ browserUse: { ...f.settings, browser: "msedge" } }).browserUse.browser, "chrome");
  const saved = config.write({ browserUse: { ...f.settings, isolated: false } });
  assert.deepEqual(config.read().browserUse, saved.browserUse);
  config.write({ locale: "en" });
  assert.deepEqual(config.read().browserUse, saved.browserUse);
  fs.writeFileSync(config.path, "broken JSON");
  assert.equal(config.read().browserUse.enabled, false);
});

test("Availability is read-only, reports missing browser and never launches one", async t => {
  const f = fixture(t);
  assert.equal(validateBrowserState(await f.controller.status()).available, true);
  assert.equal(f.launches.length, 0);
  f.controller.executable = () => { throw browserError("BROWSER_EXECUTABLE_UNAVAILABLE"); };
  assert.equal((await f.controller.status()).reason, "BROWSER_EXECUTABLE_UNAVAILABLE");
  await assert.rejects(f.create(), code("BROWSER_EXECUTABLE_UNAVAILABLE"));
  assert.equal(f.launches.length, 0);
});

test("Every tool and session is bound to its Agent and WorkRun", async t => {
  const f = fixture(t), session = await f.create();
  assert.equal(f.controller.listTools(f.input(session)).tools.length, 2);
  for (const extra of [{ profileId: "agent-b" }, { workRunId: "run-b" }]) {
    const input = { ...f.input(session), ...extra };
    await assert.rejects(f.controller.callTool({ ...input, toolName: "browser_snapshot", arguments: {} }), code("BROWSER_SESSION_FORBIDDEN"));
    await assert.rejects(f.controller.closeSession(input), code("BROWSER_SESSION_FORBIDDEN"));
  }
  assert.equal((await f.controller.status("agent-b")).sessions.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call(session)).untrusted, true);
});

test("Actual MCP schemas, allowlisted tools, workspace URL policy are enforced before dispatch", async t => {
  const f = fixture(t), session = await f.create();
  await assert.rejects(f.call(session, "browser_run_code_unsafe", { code: "process.exit()" }), code("BROWSER_TOOL_FORBIDDEN"));
  await assert.rejects(f.call(session, "browser_navigate", { url: 12 }), code("BROWSER_ARGUMENTS_INVALID"));
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com", "bad url"]) {
    await assert.rejects(f.call(session, "browser_navigate", { url }), code("BROWSER_ARGUMENTS_INVALID"));
  }
  assert.equal(f.calls.length, 0);
  await f.call(session, "browser_navigate", { url: "https://example.com" });
  assert.equal(f.calls.length, 1);
});

test("Tool revocation and the global off switch close owned browser resources", async t => {
  for (const mode of ["revoke", "disable"]) {
    const f = fixture(t), session = await f.create();
    if (mode === "revoke") f.revoke(); else f.settings.enabled = false;
    await assert.rejects(f.call(session));
    await f.controller.reconcile();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.closes, [session.id]);
    assert.equal((await f.controller.status()).sessions.length, 0);
  }
});

test("An active task retains its browser after days without a tool call", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const f = fixture(t), session = await f.create();
  assert.equal(session.expiresAt, null);
  t.mock.timers.tick(3 * 24 * 60 * 60_000);
  assert.equal(Date.now(), 1_000 + 3 * 24 * 60 * 60_000);
  await f.controller.reconcile();
  assert.equal(validateBrowserState(await f.controller.status()).sessions[0].id, session.id);
  assert.deepEqual(f.closes, []);
  await f.call(session);
  await f.controller.closeForWorkRun(session.profileId, session.workRunId);
  assert.deepEqual(f.closes, [session.id]);
});

test("Task teardown drains a dispatched browser action and refuses further admission", async t => {
  let release, started = false, closed = 0, calls = 0;
  const pendingAction = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { clientFactory: async () => ({ listTools: async () => [snapshot],
    callTool: async () => { calls++; started = true; await pendingAction; return { content: [] }; },
    close: async () => { closed++; } }) });
  const session = await f.create(), pending = f.call(session);
  const rejected = assert.rejects(pending, code("BROWSER_SESSION_NOT_FOUND"));
  while (!started) await new Promise(resolve => setImmediate(resolve));
  const closing = f.controller.closeForWorkRun(session.profileId, session.workRunId);
  await assert.rejects(f.call(session), code("BROWSER_SESSION_NOT_FOUND"));
  assert.equal(closed, 0);
  release(); await closing; await rejected;
  assert.equal(closed, 1); assert.equal(calls, 1);
});

test("Persistent data is private per Agent and per selected browser; concurrent profile writers are refused", async t => {
  const f = fixture(t); f.settings.isolated = false;
  const a = await f.create();
  await assert.rejects(f.create({ workRunId: "run-b" }), code("BROWSER_SESSION_BUSY"));
  const b = await f.create({ profileId: "agent-b", workRunId: "run-b" });
  assert.notEqual(f.launches[0].profileDirectory, f.launches[1].profileDirectory);
  assert.equal(fs.statSync(f.launches[0].profileDirectory).mode & 0o777, 0o700);
  await f.controller.closeForWorkRun("agent-a", "run-a");
  assert.deepEqual(f.closes, [a.id]);
  assert.deepEqual((await f.controller.status()).sessions.map(session => session.id), [b.id]);
  await f.controller.closeForProfile("agent-b");
  assert.equal((await f.controller.status()).sessions.length, 0);
});

test("Capacity reservations include browser launches in progress", async t => {
  const f = fixture(t);
  for (let index = 0; index < 4; index++) await f.create({ profileId: `agent-${index}`, workRunId: `run-${index}` });
  await assert.rejects(f.create(), code("BROWSER_SESSION_CAPACITY"));
  assert.equal(f.launches.length, 4);
});

test("Closing or revoking during asynchronous startup cannot publish or leak a session", async t => {
  let release, launched = false, closed = 0;
  const start = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { clientFactory: async () => { launched = true; await start;
    return { listTools: async () => [snapshot], close: async () => { closed++; } }; } });
  const pending = f.create();
  while (!launched) await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(pending, code("BROWSER_SESSION_NOT_FOUND"));
  const closing = f.controller.closeForWorkRun("agent-a", "run-a");
  release(); await closing; await rejected;
  assert.equal(closed, 1);
  assert.equal((await f.controller.status()).sessions.length, 0);
});

test("Calls are serialized; transport failures retain unknown outcomes and are never resent", async t => {
  let complete, calls = 0;
  const wait = new Promise(resolve => { complete = resolve; });
  const f = fixture(t, { clientFactory: async () => ({ listTools: async () => [snapshot],
    callTool: async () => { calls++; await wait; throw new Error("private transport canary"); }, close: async () => {} }) });
  const session = await f.create();
  const pending = f.call(session), rejected = assert.rejects(pending, code("BROWSER_CALL_OUTCOME_UNKNOWN"));
  await assert.rejects(f.call(session), code("BROWSER_SESSION_BUSY"));
  complete(); await rejected;
  await assert.rejects(f.call(session), code("BROWSER_SESSION_NOT_FOUND"));
  assert.equal(calls, 1);
});

test("Unconfirmed browser exit retains its profile lock and can be explicitly checked again", async t => {
  let fail = true;
  const f = fixture(t, { clientFactory: async () => ({ listTools: async () => [snapshot],
    close: async () => { if (fail) throw new Error("close failed"); } }) });
  f.settings.isolated = false;
  const session = await f.create();
  await assert.rejects(f.controller.closeSession(f.input(session)), code("BROWSER_SESSION_CLOSE_FAILED"));
  assert.equal((await f.controller.status()).sessions[0].status, "close_failed");
  await assert.rejects(f.controller.closeForProfile("agent-a"), code("BROWSER_SESSION_CLOSE_FAILED"));
  await assert.rejects(f.create({ workRunId: "new-run" }), code("BROWSER_SESSION_BUSY"));
  fail = false;
  await f.controller.closeSession(f.input(session));
  assert.equal((await f.controller.status()).sessions.length, 0);
});

test("Browser page output is untrusted and compacted before the 64 KiB Service frame", () => {
  const result = boundedBrowserResult({ isError: true, content: [{ type: "text", text: '\\"中文'.repeat(50_000) }] });
  assert.equal(result.isError, true); assert.equal(result.untrusted, true); assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 42 * 1024);
});

test("人工接管保持同一浏览器、阻止自动操作，完成后只读取新快照", async t => {
  const f = fixture(t); f.settings.headless = false;
  const session = await f.create();
  let answer, asked = false;
  const pending = f.controller.waitForUser(f.input(session), async signal => {
    assert.equal(signal.aborted, false); asked = true;
    return new Promise(resolve => { answer = resolve; });
  });
  assert.equal(asked, true);
  await f.controller.reconcile();
  assert.equal((await f.controller.status()).sessions[0].id, session.id);
  await assert.rejects(f.call(session), code("BROWSER_SESSION_BUSY"));
  await assert.rejects(f.controller.waitForUser(f.input(session), async () => true), code("BROWSER_SESSION_BUSY"));
  assert.equal(f.closes.length, 0); assert.equal(f.calls.length, 0);
  answer(true);
  const result = await pending;
  assert.equal(result.sessionId, session.id); assert.equal(result.canceled, false);
  assert.equal(result.toolName, "browser_snapshot");
  assert.deepEqual(f.calls, [["browser_snapshot", {}]]);
  await f.call(session);
  assert.equal(f.launches.length, 1);
  await f.controller.closeForWorkRun(session.profileId, session.workRunId);
  assert.deepEqual(f.closes, [session.id]);
});

test("人工接管取消只关闭所属浏览器，不继续读取或执行页面动作", async t => {
  const f = fixture(t); f.settings.headless = false;
  const session = await f.create();
  const other = await f.create({ profileId: "agent-b", workRunId: "run-b" });
  const result = await f.controller.waitForUser(f.input(session), async () => false);
  assert.equal(result.canceled, true);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.closes, [session.id]);
  assert.deepEqual((await f.controller.status()).sessions.map(s => s.id), [other.id]);
});

test("人工接管期间撤权或全局关闭会撤回等待，关闭不被未回答的问题阻塞", async t => {
  for (const mode of ["revoke", "disable"]) {
    const f = fixture(t); f.settings.headless = false;
    const session = await f.create();
    let aborted = false;
    const pending = f.controller.waitForUser(f.input(session), signal => new Promise(resolve => {
      signal.addEventListener("abort", () => { aborted = true; resolve(false); }, { once: true });
    }));
    const rejected = assert.rejects(pending);
    if (mode === "revoke") f.revoke(); else f.settings.enabled = false;
    await f.controller.reconcile(); await rejected;
    assert.equal(aborted, true); assert.deepEqual(f.closes, [session.id]);
    assert.equal((await f.controller.status()).sessions.length, 0);
    assert.deepEqual(f.calls, []);
  }
});

test("人工接管拒绝后台窗口、错误归属和已关闭会话，不发出用户问题", async t => {
  const f = fixture(t), headless = await f.create();
  let asked = 0;
  const request = async () => { asked++; return true; };
  await assert.rejects(f.controller.waitForUser(f.input(headless), request), code("BROWSER_USER_WAIT_UNAVAILABLE"));
  await assert.rejects(f.controller.waitForUser({ ...f.input(headless), workRunId: "old-run" }, request), code("BROWSER_SESSION_FORBIDDEN"));
  await f.controller.closeSession(f.input(headless));
  await assert.rejects(f.controller.waitForUser(f.input(headless), request), code("BROWSER_SESSION_NOT_FOUND"));
  assert.equal(asked, 0);
});

test("人工接管失败关闭资源并保留安全错误，不能把未知响应当完成", async t => {
  for (const response of [undefined, "已完成", new Error("private input failure")]) {
    const f = fixture(t); f.settings.headless = false;
    const session = await f.create();
    await assert.rejects(f.controller.waitForUser(f.input(session), async () => {
      if (response instanceof Error) throw response; return response;
    }), error => error.code === "BROWSER_USER_WAIT_FAILED" && !error.message.includes("private"));
    assert.deepEqual(f.calls, []); assert.deepEqual(f.closes, [session.id]);
  }
});

test("Desktop status requires the main frame and sanitizes malformed or private Service responses", async () => {
  let handler, calls = 0;
  const contents = { mainFrame: {} }, window = { webContents: contents };
  const valid = { available: true, reason: null, engineVersion: "0.0.82", browser: "chrome", sessions: [] };
  let response = valid;
  registerDesktopBrowserIpc({ ipcMain: { handle: (channel, fn) => { assert.equal(channel, BROWSER_STATE_CHANNEL); handler = fn; }, removeHandler() {} },
    getMainWindow: () => window, serviceRequest: async (method, params) => { calls++; assert.equal(method, "browser.status");
      assert.deepEqual(params, {}); return response; } });
  assert.equal((await handler({ sender: contents, senderFrame: {} })).error.code, "PRIVILEGED_RENDERER_REQUIRED");
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal((await handler(event, {})).error.code, "INVALID_PARAMS"); assert.equal(calls, 0);
  assert.deepEqual((await handler(event)).value, valid);
  response = { ...valid, privateCanary: "password" };
  const refused = await handler(event);
  assert.equal(refused.error.code, "BROWSER_SERVICE_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(refused), /password/u);
});
