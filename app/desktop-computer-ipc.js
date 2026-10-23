"use strict";

const { mapComputerServiceError, validateComputerServiceResult } = require("./agent-service/computer-service-protocol");

const CHANNELS = Object.freeze({
  status: "shoggoth:computer:permissions-status",
  state: "shoggoth:computer:state",
  request: "shoggoth:computer:permissions-request",
  reload: "shoggoth:computer:permissions-reload",
  openAccessibility: "shoggoth:computer:open-accessibility-settings",
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
  return validateComputerServiceResult("computer.permissions.request", value);
}

function registerDesktopComputerIpc(options = {}) {
  const { ipcMain, getMainWindow } = options;
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.removeHandler !== "function"
    || typeof getMainWindow !== "function") {
    throw new TypeError("registerDesktopComputerIpc 需要 IPC 与宿主依赖");
  }
  const state = async () => ({ supported: true,
    ...validateComputerServiceResult("computer.status", await options.serviceRequest("computer.status", {})) });
  const register = (channel, operation) => ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedRenderer(event, getMainWindow)) {
      return failure("PRIVILEGED_RENDERER_REQUIRED", "仅桌面应用可管理 Computer Use 权限");
    }
    if (args.length) return failure("INVALID_PARAMS", "请求参数无效");
    try { return { ok: true, value: await operation() }; }
    catch (error) {
      if (["COMPUTER_PERMISSION_RELOAD_BUSY", "COMPUTER_PERMISSION_RELOAD_FAILED", "COMPUTER_SETTINGS_OPEN_FAILED"].includes(error?.code)) {
        return failure(error.code, error.code === "COMPUTER_PERMISSION_RELOAD_BUSY"
          ? "请等待运行中的任务结束后重载权限" : "操作未能完成，请检查后台服务与系统设置");
      }
      const mapped = mapComputerServiceError(error);
      return failure(mapped.code, mapped.message);
    }
  });
  register(CHANNELS.state, state);
  register(CHANNELS.status, async () => {
    const permissions = (await state()).permissions;
    if (typeof permissions.accessibility !== "boolean" || typeof permissions.screenRecording !== "boolean") {
      throw Object.assign(new Error("permission status unknown"), { code: "COMPUTER_PERMISSION_STATUS_FAILED" });
    }
    return { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording };
  });
  register(CHANNELS.request, async () => permissionValue(
    await options.serviceRequest("computer.permissions.request", {}),
  ));
  register(CHANNELS.reload, async () => { await options.restartService(); return state(); });
  for (const [channel, kind] of [[CHANNELS.openAccessibility, "accessibility"], [CHANNELS.openScreenRecording, "screenRecording"]]) {
    register(channel, async () => {
      try { await options.openSettings(kind); }
      catch { throw Object.assign(new Error("settings unavailable"), { code: "COMPUTER_SETTINGS_OPEN_FAILED" }); }
      return { opened: true };
    });
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
  };
}

module.exports = { CHANNELS, registerDesktopComputerIpc };
