"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const native = require("../app/agent-service/native-notification-sender");

const entry = fs.readFileSync(path.join(__dirname, "../app/ui-entry.js"), "utf8");
const start = entry.indexOf("// Desktop notifications. The renderer-side Notifier");
const end = entry.indexOf("// --- App lifecycle", start);
assert.ok(start >= 0 && end > start);
const navigationStart = entry.indexOf('mainWindow.webContents.on("did-start-navigation"');
const navigationEnd = entry.indexOf("// Renderer text/source URLs", navigationStart);
assert.ok(navigationStart >= 0 && navigationEnd > navigationStart);
const origin = "http://127.0.0.1:41888";
const preferences = { notifications: { chat: true, cron: true, task: true, proactive: true } };
const payload = (category = "chat", target = "agent:fixture:main") => ({ category, target, title: "Fixture", body: "Reply" });
const tick = () => new Promise(setImmediate);

function desktopFixture() {
  const weak = [], sent = [], handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor() { super(); weak.push(new WeakRef(this)); }
    show() {}
  }
  function windowFixture(loading = false) {
    const webContents = new EventEmitter();
    webContents.mainFrame = { url: `${origin}/#/settings` };
    webContents.loading = loading;
    webContents.isLoadingMainFrame = () => webContents.loading;
    webContents.isDestroyed = () => false;
    webContents.send = (...args) => sent.push({ window, args });
    const window = { webContents, restored: 0, shown: 0, focused: 0, minimized: false,
      isDestroyed: () => false, isFocused: () => false, isMinimized: () => window.minimized,
      restore() { window.restored++; window.minimized = false; },
      show() { window.shown++; }, focus() { window.focused++; } };
    return window;
  }
  const context = vm.createContext({
    ipcMain, Notification, process: { argv: [] }, mainWindow: windowFixture(),
    boardWidgetNavigation: { isBoardFrame: () => false }, desktopSystemIssues: null,
    desktopBoardWidgetIpc: { revokeOwner() {} },
    showNativeNotification: native.showNativeNotification,
    readConfig: () => preferences, notificationPolicy: require("../app/agent-service/notification-policy").notificationPolicy,
    isInternalUrl: url => { try { return new URL(url).origin === origin; } catch { return false; } },
    showMainWindow() {
      if (!context.mainWindow) { context.mainWindow = windowFixture(true); attachNavigation(); }
      if (context.mainWindow.isMinimized()) context.mainWindow.restore();
      context.mainWindow.show(); context.mainWindow.focus();
    },
  });
  vm.runInContext(entry.slice(start, end), context, { filename: "ui-entry-notifications.js" });
  function attachNavigation() {
    vm.runInContext(`{ const windowWebContentsId = 1; ${entry.slice(navigationStart, navigationEnd)} }`, context);
  }
  attachNavigation();
  return { context, weak, sent, ipcMain, windowFixture,
    notify(value = payload()) { assert.equal(handlers.get("openclaw:notify")({}, value), true); return weak.at(-1); },
    ready(window = context.mainWindow, event = {}) {
      ipcMain.emit("openclaw:open-target-ready", { sender: window.webContents, senderFrame: window.webContents.mainFrame, ...event });
    },
  };
}

function preloadFixture() {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.sendSync = () => ({});
  ipcRenderer.invoke = async () => true;
  const signals = [];
  ipcRenderer.send = (...args) => signals.push(args);
  let desktop;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return { ipcRenderer, contextBridge: { exposeInMainWorld(_name, value) { desktop = value; } } };
    },
    process: { platform: "linux" }, localStorage: { removeItem() {}, setItem() {} },
  });
  return { desktop, ipcRenderer, signals };
}

async function gcFixture() {
  assert.equal(typeof global.gc, "function");
  const f = desktopFixture();
  f.ready();
  const ui = f.notify();
  const weak = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor() { super(); weak.push(new WeakRef(this)); }
    show() { if (Notification.fail) throw new Error("show failed"); }
  }
  const opened = [];
  const send = native.createNativeNotificationSender({ Notification, readConfig: () => preferences,
    openTarget: async value => { opened.push(value); } });
  const input = { ...payload("proactive"), noticeId: "notice-fixture" };
  await send(input);
  await send(input);
  assert.equal(weak.length, 1, "retention must preserve service deduplication");
  await tick(); global.gc();
  assert.ok(ui.deref(), "desktop notifications must survive GC until the user interacts");
  assert.ok(weak[0].deref(), "background Service notifications must survive GC");
  ui.deref().emit("click");
  weak[0].deref().emit("click");
  await tick(); global.gc();
  assert.equal(ui.deref(), undefined, "clicked desktop notifications must be released");
  assert.equal(weak[0].deref(), undefined, "clicked Service notifications must be released");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(opened, [input]);

  const closed = f.notify();
  const failed = f.notify();
  const remaining = f.notify(payload("cron", { kind: "cron", backendId: "shoggoth", jobId: "job-1" }));
  closed.deref().emit("close");
  failed.deref().emit("failed", "fixture failure");
  await tick(); global.gc();
  assert.equal(closed.deref(), undefined, "dismissed notifications must be released");
  assert.equal(failed.deref(), undefined, "failed notifications must be released");
  assert.ok(remaining.deref(), "closing one notification must preserve the others");
  remaining.deref().emit("click");
  await tick(); global.gc();
  assert.equal(remaining.deref(), undefined);

  Notification.fail = true;
  await assert.rejects(send(payload()), /show failed/);
  await tick(); global.gc();
  assert.equal(weak.at(-1).deref(), undefined, "synchronous show failure must release the notification");
}

if (process.argv.includes("--gc-fixture")) {
  gcFixture().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  test("desktop and Service notification click handlers survive GC and release completed objects", () => {
    const result = spawnSync(process.execPath, ["--expose-gc", __filename, "--gc-fixture"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });

  test("every category restores the main window and delivers its original target exactly once", () => {
    const f = desktopFixture();
    f.ready();
    for (const value of [payload(), payload("cron", { kind: "cron", backendId: "shoggoth", jobId: "job&1" }),
      payload("task", "inspiration:note-1"), payload("proactive", { kind: "chat", backendId: "shoggoth", agentId: "fixture", sessionKey: "session-1" })]) {
      f.context.mainWindow.minimized = true;
      f.notify(value).deref().emit("click");
      assert.equal(f.context.mainWindow.minimized, false);
      assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1).args)), ["openclaw:open-target", { category: value.category, target: value.target }]);
    }
    assert.equal(f.sent.length, 4);
    assert.equal(f.context.mainWindow.shown, 4);
    assert.equal(f.context.mainWindow.focused, 4);
  });

  test("a click recreates a closed window and waits for the renderer subscription", () => {
    const f = desktopFixture();
    const note = f.notify();
    f.context.mainWindow = null;
    note.deref().emit("click");
    assert.ok(f.context.mainWindow, "a closed main window must be recreated");
    assert.equal(f.sent.length, 0, "load completion alone does not prove the React listener is ready");
    f.context.mainWindow.webContents.loading = false;
    f.context.mainWindow.webContents.emit("did-finish-load");
    assert.equal(f.sent.length, 0);
    f.ready(); f.ready();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].args[1].target, "agent:fixture:main");
  });

  test("the newest click wins during bootstrap; unrelated windows and frames cannot consume it", () => {
    const f = desktopFixture();
    f.notify(payload("chat", "agent:first:main")).deref().emit("click");
    f.notify(payload("chat", "agent:last:main")).deref().emit("click");
    assert.equal(f.sent.length, 0);
    f.ready(f.windowFixture());
    f.ready(f.context.mainWindow, { senderFrame: { url: `${origin}/#/chat` } });
    f.context.mainWindow.webContents.mainFrame.url = "https://untrusted.invalid/";
    f.ready();
    assert.equal(f.sent.length, 0);
    f.context.mainWindow.webContents.mainFrame.url = `${origin}/#/chat`;
    f.ready(); f.ready();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].args[1].target, "agent:last:main");
  });

  test("readiness before load completion flushes once; a renderer reload requires a new subscriber", () => {
    const f = desktopFixture(), wc = f.context.mainWindow.webContents;
    wc.loading = true;
    f.notify().deref().emit("click");
    f.ready();
    assert.equal(f.sent.length, 0);
    wc.loading = false; wc.emit("did-finish-load");
    assert.equal(f.sent.length, 1);
    wc.loading = true;
    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    const note = f.notify(payload("chat", "agent:after-reload:main"));
    note.deref().emit("click");
    note.deref().emit("click");
    wc.loading = false; wc.emit("did-finish-load");
    assert.equal(f.sent.length, 1, "the previous renderer's readiness must not consume the new target");
    f.ready(); f.ready();
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent.at(-1).args[1].target, "agent:after-reload:main");
  });

  test("a Service proactive notice uses the same ready handoff after reopening the window", async () => {
    const f = desktopFixture();
    f.context.fixtureRegistry = { async proactiveCall(method) {
      if (method === "proactive.notice.get") return { notice: { profileId: "profile-1", sessionKey: "notice-session" } };
      assert.equal(method, "proactive.agents.list");
      return { agents: [{ id: "profile-1", backendId: "shoggoth", agentId: "shoggoth-fixture" }] };
    } };
    vm.runInContext("proactiveUiRegistry = fixtureRegistry", f.context);
    f.context.mainWindow = null;
    await f.context.openProactiveNotice("notice-fixture");
    assert.ok(f.context.mainWindow);
    assert.equal(f.sent.length, 0);
    f.context.mainWindow.webContents.loading = false;
    f.ready();
    assert.equal(f.sent.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0].args[1])), {
      category: "proactive", target: { kind: "chat", backendId: "shoggoth", agentId: "shoggoth-fixture", sessionKey: "notice-session" },
    });
  });

  test("preload registers the click callback before announcing readiness and unsubscribes cleanly", () => {
    const f = preloadFixture(), received = [];
    f.ipcRenderer.send = channel => {
      f.signals.push([channel]);
      f.ipcRenderer.emit("openclaw:open-target", {}, payload());
    };
    const off = f.desktop.onOpenTarget(value => received.push(value));
    assert.deepEqual(f.signals, [["openclaw:open-target-ready"]]);
    assert.equal(received.length, 1, "pending targets may be delivered synchronously during readiness");
    off();
    f.ipcRenderer.emit("openclaw:open-target", {}, payload());
    assert.equal(received.length, 1);
    assert.equal(f.ipcRenderer.listenerCount("openclaw:open-target"), 0);
  });
}
