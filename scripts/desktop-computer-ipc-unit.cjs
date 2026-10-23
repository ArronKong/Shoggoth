"use strict";

const assert = require("node:assert/strict");
const { CHANNELS, registerDesktopComputerIpc } = require("../app/desktop-computer-ipc");

async function main() {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const calls = [];
  let permissions = { accessibility: false, screenRecording: false };
  let unavailable = false;
  let unknownStatus = false;
  const state = () => ({ available: !unknownStatus, ...(unknownStatus ? { reason: "COMPUTER_DRIVER_UNAVAILABLE" } : {}), driverVersion: "0.22.0", contractVersion: "0.7.0",
    permissions: { ...permissions }, sessions: [] });
  const dispose = registerDesktopComputerIpc({
    ipcMain,
    getMainWindow: () => window,
    sdkLoader: async () => ({
      currentMacOsPermissionStatus() {
        calls.push("gui-status");
        return { accessibility: true, screenRecording: true };
      },
      requestMacOsPermissions() {
        calls.push("gui-request");
        return { accessibility: true, screenRecording: true };
      },
      openMacOsScreenRecordingSettings() { calls.push("settings"); },
    }),
    serviceRequest: async (method, params) => {
      assert.deepEqual(params, {});
      if (unavailable) throw Object.assign(new Error("private detail"), { code: "SERVICE_UNAVAILABLE" });
      calls.push(method);
      if (method === "computer.permissions.request") {
        permissions = { accessibility: true, screenRecording: false };
        return permissions;
      }
      assert.equal(method, "computer.status");
      return state();
    },
    restartService: async () => {
      calls.push("restart");
      permissions = { accessibility: true, screenRecording: true };
    },
    openSettings: async (kind) => { calls.push(`settings:${kind}`); },
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const denied = await handlers.get(CHANNELS.request)({ sender: {}, senderFrame: mainFrame });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "PRIVILEGED_RENDERER_REQUIRED");
  assert.deepEqual(calls, []);
  console.log("ok 1 - untrusted renderer cannot trigger macOS permission prompts");

  assert.deepEqual(await handlers.get(CHANNELS.status)(trusted), {
    ok: true, value: { accessibility: false, screenRecording: false },
  });
  console.log("ok 2 - GUI grants cannot replace the executing Service's permission state");
  assert.deepEqual(await handlers.get(CHANNELS.request)(trusted), {
    ok: true, value: { accessibility: true, screenRecording: false },
  });
  assert.deepEqual(await handlers.get(CHANNELS.state)(trusted), {
    ok: true, value: { supported: true, ...state() },
  });
  assert.deepEqual(await handlers.get(CHANNELS.openScreenRecording)(trusted), {
    ok: true, value: { opened: true },
  });
  assert.deepEqual(await handlers.get(CHANNELS.openAccessibility)(trusted), {
    ok: true, value: { opened: true },
  });
  assert.deepEqual(await handlers.get(CHANNELS.reload)(trusted), {
    ok: true, value: { supported: true, ...state(), permissions: { accessibility: true, screenRecording: true } },
  });
  assert.deepEqual(calls, ["computer.status", "computer.permissions.request", "computer.status",
    "settings:screenRecording", "settings:accessibility", "restart", "computer.status"]);
  console.log("ok 3 - permission requests and reloads use the executing Service; settings links are fixed");

  for (const handler of handlers.values()) {
    const before = calls.length;
    assert.equal((await handler({ sender: webContents, senderFrame: {} })).error.code,
      "PRIVILEGED_RENDERER_REQUIRED");
    assert.equal((await handler(trusted, { command: "unexpected" })).error.code, "INVALID_PARAMS");
    assert.equal(calls.length, before);
  }
  console.log("ok 4 - iframe callers and unexpected payloads cannot trigger privileged actions");

  unavailable = true;
  const failed = await handlers.get(CHANNELS.state)(trusted);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "COMPUTER_SERVICE_UNAVAILABLE");
  assert.equal(JSON.stringify(failed).includes("private detail"), false);
  console.log("ok 5 - unavailable Service is an error, never a false permission grant");

  unavailable = false;
  unknownStatus = true;
  permissions = { accessibility: null, screenRecording: null };
  assert.deepEqual((await handlers.get(CHANNELS.state)(trusted)).value.permissions, permissions);
  assert.equal((await handlers.get(CHANNELS.status)(trusted)).error.code, "COMPUTER_PERMISSION_STATUS_FAILED");
  console.log("ok 6 - unknown grants stay unknown and legacy status reports a read failure");

  dispose();
  assert.equal(handlers.size, 0);
  console.log("ok 7 - IPC lifecycle removes every privileged handler");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
