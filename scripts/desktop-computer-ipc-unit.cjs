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
  const dispose = registerDesktopComputerIpc({
    ipcMain,
    getMainWindow: () => window,
    sdkLoader: async () => ({
      currentMacOsPermissionStatus() {
        calls.push("status");
        return { accessibility: true, screenRecording: false };
      },
      requestMacOsPermissions() {
        calls.push("request");
        return { accessibility: true, screenRecording: true };
      },
      openMacOsScreenRecordingSettings() { calls.push("settings"); },
    }),
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const denied = await handlers.get(CHANNELS.request)({ sender: {}, senderFrame: mainFrame });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "PRIVILEGED_RENDERER_REQUIRED");
  assert.deepEqual(calls, []);
  console.log("ok 1 - untrusted renderer cannot trigger macOS permission prompts");

  assert.deepEqual(await handlers.get(CHANNELS.status)(trusted), {
    ok: true, value: { accessibility: true, screenRecording: false },
  });
  assert.deepEqual(await handlers.get(CHANNELS.request)(trusted), {
    ok: true, value: { accessibility: true, screenRecording: true },
  });
  assert.deepEqual(await handlers.get(CHANNELS.openScreenRecording)(trusted), {
    ok: true, value: { opened: true },
  });
  assert.deepEqual(calls, ["status", "request", "settings"]);
  console.log("ok 2 - trusted main frame owns status, prompt, and System Settings handoff");

  dispose();
  assert.equal(handlers.size, 0);
  console.log("ok 3 - IPC lifecycle removes every privileged handler");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
