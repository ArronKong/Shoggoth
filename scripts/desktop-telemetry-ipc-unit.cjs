"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { CHANNELS, registerDesktopTelemetryIpc } = require("../app/desktop-telemetry-ipc");
const { createConfigStore } = require("../app/core/config-store");
const { tempProfile, fakeClock } = require("./helpers/product-telemetry-fixtures.cjs");

function fixture() {
  const ipcMain = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const state = { visible: true, focused: true, minimized: false, destroyed: false, idle: "active" };
  powerMonitor.getSystemIdleState = () => state.idle;
  const webContents = { mainFrame: { url: "http://127.0.0.1:18888/#/chat" }, isDestroyed: () => state.destroyed };
  const w = { webContents, isDestroyed: () => state.destroyed, isVisible: () => state.visible,
    isFocused: () => state.focused, isMinimized: () => state.minimized };
  const clock = fakeClock();
  const calls = [];
  const dispose = registerDesktopTelemetryIpc({ ipcMain, powerMonitor, getMainWindow: () => w,
    getUiOrigin: () => "http://127.0.0.1:18888", now: clock.now,
    telemetry: { recordActivity(...args) { calls.push(args); } } });
  const trusted = { sender: webContents, senderFrame: webContents.mainFrame };
  const signal = (...args) => ipcMain.emit(CHANNELS.activity, trusted, ...args);
  return { ipcMain, powerMonitor, state, webContents, w, clock, calls, dispose, trusted, signal };
}

test("only the current main frame at the exact UI origin can submit an empty signal", () => {
  const f = fixture();
  try {
    for (const untrusted of [{}, { sender: {}, senderFrame: f.webContents.mainFrame },
      { sender: f.webContents, senderFrame: {} }, { sender: f.webContents }]) f.ipcMain.emit(CHANNELS.activity, untrusted);
    for (const raw of [{}, { page: "chat" }, { distinct_id: "SECRET_CANARY" }, null, "activity", new Array(10000)]) f.signal(raw);
    for (const url of ["http://evil.test/#/chat", "http://127.0.0.1:18889/#/chat", "http://127.0.0.1:18888/__widget/x", "about:blank"]) {
      f.webContents.mainFrame.url = url;
      f.signal();
    }
    assert.equal(f.calls.length, 0);
    f.webContents.mainFrame.url = "http://127.0.0.1:18888/#/settings";
    f.signal();
    assert.deepEqual(f.calls, [[]]);
    assert.deepEqual(Object.keys(CHANNELS), ["activity"], "no settings/status/identity endpoints in phase A");
  } finally { f.dispose(); }
});

test("hidden/unfocused/minimized/destroyed/locked/unknown/inactive/suspended states never produce activity", () => {
  const f = fixture();
  try {
    for (const [key, value] of [["visible", false], ["focused", false], ["minimized", true], ["destroyed", true], ["idle", "locked"], ["idle", "unknown"]]) {
      const prev = f.state[key]; f.state[key] = value; f.signal(); f.state[key] = prev;
    }
    for (const [off, on] of [["lock-screen", "unlock-screen"], ["suspend", "resume"], ["user-did-resign-active", "user-did-become-active"]]) {
      f.powerMonitor.emit(off); f.signal(); f.powerMonitor.emit(on);
    }
    assert.equal(f.calls.length, 0, "waking/unlocking also does not create activity");
    f.signal();
    assert.equal(f.calls.length, 1);
    for (let n = 0; n < 500; n++) f.signal();
    assert.equal(f.calls.length, 1);
    f.clock.advance(1000); f.signal();
    assert.equal(f.calls.length, 2);
    f.clock.set("2026-09-10T23:59:59.999Z"); f.signal();
    f.clock.advance(1); f.signal();
    assert.equal(f.calls.length, 4, "throttle cannot swallow the first next-day interaction");
    f.dispose(); f.dispose();
    assert.equal(f.powerMonitor.eventNames().length, 0);
    assert.equal(f.ipcMain.listenerCount(CHANNELS.activity), 0);
  } finally { f.dispose(); }
});

test("the actual preload cannot pass caller arguments, or expose identity and preference methods", () => {
  let desktop;
  const messages = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld(_name, bridge) { desktop = bridge; } },
        ipcRenderer: { sendSync: () => ({}), send: (...args) => messages.push(args) } };
    },
    process: { platform: "linux" }, localStorage: { removeItem() {}, setItem() {} },
  });
  assert.deepEqual(Object.keys(desktop.productTelemetry), ["recordActivity"]);
  desktop.productTelemetry.recordActivity({ prompt: "SECRET_CANARY" });
  assert.deepEqual(messages, [[CHANNELS.activity]]);
});

test("HTTP has no event endpoint; generic config updates cannot create telemetry configuration", async () => {
  const { startStaticServer } = require("../app/static-server");
  const { BackendRegistry } = require("../app/core/backend-registry");
  const p = tempProfile();
  const configStore = createConfigStore(p.configPath);
  const server = await startStaticServer(0, { configStore, registry: new BackendRegistry() });
  try {
    const put = await fetch(`${server.url}/__api/config`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en", telemetry: { basicEnabled: false, detailedEnabled: true, detailedConsentVersion: 1 }, exportEnabled: true }) });
    assert.equal(put.status, 200);
    const payload = await put.json();
    assert.equal(payload.config.locale, "en");
    assert.equal(Object.hasOwn(payload.config, "telemetry"), false);
    assert.equal(Object.hasOwn(payload.config, "exportEnabled"), false);
    for (const route of ["telemetry", "telemetry/activity", "telemetry/settings"]) {
      const reply = await fetch(`${server.url}/__api/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(reply.status, 404);
      await reply.arrayBuffer();
    }
    assert.equal(fs.existsSync(p.statePath), false);
  } finally { await server.close(); p.cleanup(); }
});

test("composition starts only in locked UI lifecycle and shuts down before asynchronous business cleanup", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/ui-entry.js"), "utf8");
  const lock = source.indexOf("const gotLock = app.requestSingleInstanceLock()");
  const ready = source.indexOf("app.whenReady().then", lock);
  const create = source.indexOf("productTelemetry = createProductTelemetry(", ready);
  const ensure = source.indexOf("ensureConfigFile();", ready);
  assert.ok(lock >= 0 && ready > lock && create > ready && ensure > create);
  const quitting = source.slice(source.indexOf('app.on("before-quit"'));
  assert.ok(quitting.indexOf("productTelemetry?.close()") < quitting.indexOf("await "));
  assert.match(source, /isPackaged: app\.isPackaged/u);
  for (const file of ["app/bootstrap.js", "app/bootstrap-role.js", "app/agent-service.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /require\([^)]*product-telemetry/u);
  }
});
