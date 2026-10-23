"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { storageIssueCode, SYSTEM_ISSUE_CODES } = require("../app/system-issue");
const { createDesktopSystemIssueReporter, CHANNELS } = require("../app/desktop-system-issue");

const full = code => Object.assign(new Error("private file path must not reach the toast"), { code });

test("disk-full classification uses explicit codes and bounded causes, never ENOENT or message text", () => {
  for (const code of ["ENOSPC", "EDQUOT", "SQLITE_FULL", "STORAGE_FULL"]) {
    assert.equal(storageIssueCode(full(code)), "STORAGE_FULL");
    assert.equal(storageIssueCode(new Error("wrapped", { cause: full(code) })), "STORAGE_FULL");
  }
  for (const error of [full("ENOENT"), full("EIO"), new Error("ENOSPC: no space left on device"), null]) {
    assert.equal(storageIssueCode(error), null);
  }
  const cycle = {}; cycle.cause = cycle;
  assert.equal(storageIssueCode(cycle), null);
  const getter = { get code() { throw new Error("must not evaluate a getter"); } };
  assert.equal(storageIssueCode(getter), null);
  assert.equal(storageIssueCode({ code: "SERVICE_RECOVERY_REQUIRED", systemIssue: "STORAGE_FULL" }), "STORAGE_FULL");
  assert.equal(storageIssueCode({ get systemIssue() { throw Error("must not evaluate a getter"); } }), null);
});

function reporterFixture() {
  const ipcMain = new EventEmitter(), sent = [];
  const mainFrame = { url: "http://127.0.0.1:18888/#/settings" };
  const window = { isDestroyed: () => false, webContents: {
    isDestroyed: () => false, mainFrame, send: (channel, value) => sent.push({ channel, value }),
  } };
  let currentWindow = window, now = 100_000;
  const reporter = createDesktopSystemIssueReporter({ ipcMain,
    getMainWindow: () => currentWindow, getUiOrigin: () => "http://127.0.0.1:18888", now: () => now });
  const event = { sender: window.webContents, senderFrame: mainFrame };
  return { ipcMain, window, event, sent, reporter,
    ready: (...args) => ipcMain.emit(CHANNELS.ready, event, ...args),
    advance: value => { now += value; }, replaceWindow: value => { currentWindow = value; } };
}

test("main queues until the trusted React subscriber is ready, sanitizes and deduplicates notifications", () => {
  const f = reporterFixture();
  assert.equal(f.reporter.report(full("ENOSPC")), "STORAGE_FULL");
  assert.equal(f.sent.length, 0);
  f.ready();
  assert.deepEqual(f.sent, [{ channel: CHANNELS.notice, value: { code: "STORAGE_FULL" } }]);
  for (let i = 0; i < 3; i++) f.reporter.report(full("EDQUOT"));
  assert.equal(f.sent.length, 1);
  f.advance(30_000); f.reporter.report(full("SQLITE_FULL"));
  assert.equal(f.sent.length, 2);
  assert.equal(f.reporter.report(full("ENOENT")), null);
  f.reporter.report(full("ENOENT"), SYSTEM_ISSUE_CODES.uiResourceUnavailable);
  assert.equal(f.sent.at(-1).value.code, "UI_RESOURCE_UNAVAILABLE");
  f.reporter.dispose();
  assert.equal(f.ipcMain.listenerCount(CHANNELS.ready), 0);
  assert.equal(f.reporter.report(full("ENOSPC")), null);
});

test("notification readiness rejects foreign windows, subframes, origins, paths and caller payloads", () => {
  const f = reporterFixture();
  f.reporter.report(full("ENOSPC"));
  f.ipcMain.emit(CHANNELS.ready, { ...f.event, sender: {} });
  f.ipcMain.emit(CHANNELS.ready, { ...f.event, senderFrame: { ...f.event.senderFrame } });
  f.ready({ code: "STORAGE_FULL" });
  for (const url of ["https://example.invalid/", "http://127.0.0.1:18888/__widget/a",
    "http://127.0.0.1:18889/", "file:///index.html"]) {
    f.event.senderFrame.url = url; f.ready();
  }
  assert.equal(f.sent.length, 0);
  f.event.senderFrame.url = "http://127.0.0.1:18888/index.html#/agents"; f.ready();
  assert.equal(f.sent.length, 1);
  f.reporter.dispose();
});

test("navigation resets readiness; a closed window or failed IPC send retains a bounded pending notice", () => {
  const f = reporterFixture(); f.ready(); f.reporter.reset();
  f.reporter.report(full("ENOSPC"));
  assert.equal(f.sent.length, 0);
  const send = f.window.webContents.send;
  f.window.webContents.send = () => { throw new Error("renderer shutting down"); };
  f.ready(); assert.equal(f.sent.length, 0);
  f.window.webContents.send = send; f.ready();
  assert.equal(f.sent.length, 1);
  f.replaceWindow(null); f.advance(30_000); f.reporter.report(full("ENOSPC"));
  assert.equal(f.sent.length, 1);
  f.replaceWindow(f.window); f.ready();
  assert.equal(f.sent.length, 2);
  f.reporter.dispose();
});

test("actual preload subscribes before readiness, accepts only public codes and removes its listener", () => {
  const ipcRenderer = new EventEmitter(), messages = [];
  let bridge;
  ipcRenderer.sendSync = () => ({});
  ipcRenderer.send = (...args) => {
    messages.push(args);
    assert.equal(ipcRenderer.listenerCount(CHANNELS.notice), 1);
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const source = path.resolve(__dirname, "../app/preload.js");
  vm.runInNewContext(fs.readFileSync(source, "utf8"), {
    require: name => { assert.equal(name, "electron"); return { ipcRenderer,
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "openclawDesktop"); bridge = value; } } }; },
    process: { platform: "linux" }, localStorage: storage, sessionStorage: storage,
    location: { protocol: "http:", host: "127.0.0.1:18888", pathname: "/" }, URL,
  }, { filename: source });
  const values = [];
  const stop = bridge.onSystemIssue(value => values.push(JSON.parse(JSON.stringify(value))));
  assert.deepEqual(messages, [[CHANNELS.ready]]);
  for (const value of [null, { code: "OTHER" }, { code: "ENOENT" }]) ipcRenderer.emit(CHANNELS.notice, {}, value);
  ipcRenderer.emit(CHANNELS.notice, {}, { code: "STORAGE_FULL", message: "private path", stack: "private stack" });
  assert.deepEqual(values, [{ code: "STORAGE_FULL" }]);
  stop(); assert.equal(ipcRenderer.listenerCount(CHANNELS.notice), 0);
});

// Isolated UI assets avoid depending on or editing the developer's dist build.
async function serverFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-system-issue-"));
  const appDirectory = path.join(root, "app"), asset = path.join(appDirectory, "manage-ui/dist/assets/page.js");
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset, "export default 1;");
  fs.writeFileSync(path.join(appDirectory, "manage-ui/dist/index.html"), "<!doctype html>UI fixture");
  const source = path.resolve(__dirname, "../app/static-server.js"), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), {
    require: createRequire(source), module, exports: module.exports,
    __dirname: appDirectory, __filename: source,
    Buffer, URL, URLSearchParams, process, console, setTimeout, clearTimeout,
  }, { filename: source });
  let server;
  t.after(async () => { await server?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  server = await module.exports.startStaticServer(0, {
    registry: {}, homeDir: path.join(root, "home"), userDataRoot: path.join(root, "data"), ...options,
  });
  return { server, asset };
}

test("group REST preserves recovery and closed storage facts, without exposing private errors or replaying", async t => {
  let attempts = 0;
  const f = await serverFixture(t, { registry: { getGroupChat: async () => {
    attempts++;
    throw Object.assign(Error("private file path"), { code: "SERVICE_RECOVERY_REQUIRED", systemIssue: "STORAGE_FULL" });
  } } });
  const response = await fetch(`${f.server.url}/__api/group-chats/detail?id=synthetic`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "SERVICE_RECOVERY_REQUIRED");
  assert.equal(body.systemIssue, "STORAGE_FULL");
  assert.match(body.error, /恢复/u);
  assert.equal(JSON.stringify(body).includes("private"), false);
  assert.equal(attempts, 1);
});

for (const code of ["ENOSPC", "EDQUOT", "SQLITE_FULL"]) {
  test(`actual config API ${code} returns a safe disk-full notice, preserves failure and does not retry`, async t => {
    const notices = []; let attempts = 0, fail = true;
    const f = await serverFixture(t, { onSystemIssue: error => notices.push(error), configStore: {
      read: () => ({ theme: "system" }), write: config => { attempts++; if (fail) throw full(code); return config; },
    } });
    const request = () => fetch(`${f.server.url}/__api/config`, { method: "PUT",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "dark" }),
      signal: AbortSignal.timeout(5000) });
    const response = await request(), body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.systemIssue, "STORAGE_FULL");
    assert.equal(body.error, "Disk space is insufficient");
    assert.equal(JSON.stringify(body).includes("private file"), false);
    assert.equal(notices.length, 1); assert.equal(attempts, 1);
    fail = false;
    assert.equal((await request()).status, 200, "a later explicit retry works after space is freed");
    assert.equal(attempts, 2);
  });
}

test("reporting never hides a failed write or its operation identity", async t => {
  const { ModelChangeJournalError } = require("../app/core/model-change-journal");
  const error = new ModelChangeJournalError("journal_commit_unknown", "private path", {
    status: 409, stage: "commit", details: { operationId: "safe-operation" },
  });
  error.cause = full("ENOSPC");
  const f = await serverFixture(t, { configStore: { read: () => ({}), write: () => { throw error; } },
    onSystemIssue: () => { throw new Error("notification failed"); } });
  const response = await fetch(`${f.server.url}/__api/config`, { method: "PUT",
    body: "{}", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, "journal_commit_unknown");
  assert.equal(body.stage, "commit");
  assert.equal(body.details.operationId, "safe-operation");
  assert.equal(body.systemIssue, "STORAGE_FULL");
});

test("actual UI read errors become caught responses and code-only notices; ordinary ENOENT is not disk-full", async t => {
  const notices = [], f = await serverFixture(t, { onSystemIssue: (error, fallback) => {
    notices.push(storageIssueCode(error) || fallback);
  } });
  const original = fs.readFile;
  let code = "ENOSPC";
  fs.readFile = function (file, ...args) {
    if (file === f.asset) { process.nextTick(args.at(-1), full(code)); return; }
    return original.call(this, file, ...args);
  };
  try {
    for (const [fault, status, notice] of [["ENOSPC", 500, "STORAGE_FULL"], ["ENOENT", 404, "UI_RESOURCE_UNAVAILABLE"]]) {
      code = fault;
      const response = await fetch(`${f.server.url}/assets/page.js`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, status);
      assert.equal((await response.text()).includes("private file"), false);
      assert.equal(notices.at(-1), notice);
    }
  } finally { fs.readFile = original; }
  assert.equal((await fetch(`${f.server.url}/assets/page.js`)).status, 200);
});
