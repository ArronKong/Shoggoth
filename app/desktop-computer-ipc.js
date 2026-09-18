"use strict";

const CHANNELS = Object.freeze({
  status: "shoggoth:computer:permissions-status",
  request: "shoggoth:computer:permissions-request",
  openScreenRecording: "shoggoth:computer:open-screen-recording-settings",
});

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function trustedRenderer(event, getMainWindow) {
  let window;
  try { window = getMainWindow(); } catch { return false; }
  return Boolean(window && window.isDestroyed?.() !== true && window.webContents
    && window.webContents.isDestroyed?.() !== true
    && event?.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame);
}

function permissionValue(value) {
  if (!value || typeof value !== "object") throw new TypeError("invalid permission response");
  return {
    accessibility: value.accessibility === true,
    screenRecording: value.screenRecording === true,
  };
}

function registerDesktopComputerIpc(options = {}) {
  const { ipcMain, getMainWindow } = options;
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.removeHandler !== "function"
    || typeof getMainWindow !== "function") {
    throw new TypeError("registerDesktopComputerIpc 需要 IPC 与宿主依赖");
  }
  const sdkLoader = options.sdkLoader || (() => import("@trycua/cua-driver"));
  let sdkPromise = null;
  const sdk = async () => {
    if (!sdkPromise) sdkPromise = Promise.resolve().then(() => sdkLoader());
    const value = await sdkPromise;
    if (!value || typeof value.currentMacOsPermissionStatus !== "function"
      || typeof value.requestMacOsPermissions !== "function"
      || typeof value.openMacOsScreenRecordingSettings !== "function") {
      throw new TypeError("Cua permission SDK unavailable");
    }
    return value;
  };
  const authorized = (event) => trustedRenderer(event, getMainWindow)
    ? null : failure("PRIVILEGED_RENDERER_REQUIRED", "仅桌面应用可管理 Computer Use 权限");

  ipcMain.handle(CHANNELS.status, async (event) => {
    const denied = authorized(event);
    if (denied) return denied;
    try {
      return { ok: true, value: permissionValue((await sdk()).currentMacOsPermissionStatus()) };
    } catch {
      return failure("COMPUTER_PERMISSION_STATUS_FAILED", "无法读取 Computer Use 权限");
    }
  });
  ipcMain.handle(CHANNELS.request, async (event) => {
    const denied = authorized(event);
    if (denied) return denied;
    try {
      return { ok: true, value: permissionValue((await sdk()).requestMacOsPermissions()) };
    } catch {
      return failure("COMPUTER_PERMISSION_REQUEST_FAILED", "无法申请 Computer Use 权限");
    }
  });
  ipcMain.handle(CHANNELS.openScreenRecording, async (event) => {
    const denied = authorized(event);
    if (denied) return denied;
    try {
      (await sdk()).openMacOsScreenRecordingSettings();
      return { ok: true, value: { opened: true } };
    } catch {
      return failure("COMPUTER_SETTINGS_OPEN_FAILED", "无法打开屏幕录制设置");
    }
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
  };
}

module.exports = { CHANNELS, registerDesktopComputerIpc };
