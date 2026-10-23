"use strict";

const { BROWSER_PUBLIC_MESSAGES, validateBrowserState } = require("./agent-service/browser-use-protocol");
const BROWSER_STATE_CHANNEL = "shoggoth:browser:state";

function registerDesktopBrowserIpc({ ipcMain, getMainWindow, serviceRequest }) {
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof getMainWindow !== "function"
    || typeof serviceRequest !== "function") throw new TypeError("Browser Use desktop dependencies are invalid");
  ipcMain.handle(BROWSER_STATE_CHANNEL, async (event, ...args) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed?.() === true || event?.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return { ok: false,
      error: { code: "PRIVILEGED_RENDERER_REQUIRED", message: "仅桌面应用可读取 Browser Use 状态" } };
    if (args.length) return { ok: false, error: { code: "INVALID_PARAMS", message: "请求参数无效" } };
    try { return { ok: true, value: validateBrowserState(await serviceRequest("browser.status", {})) }; }
    catch (error) {
      const code = Object.hasOwn(BROWSER_PUBLIC_MESSAGES, error?.code || "") ? error.code : "BROWSER_SERVICE_UNAVAILABLE";
      return { ok: false, error: { code, message: BROWSER_PUBLIC_MESSAGES[code] } };
    }
  });
  return () => ipcMain.removeHandler(BROWSER_STATE_CHANNEL);
}

module.exports = { BROWSER_STATE_CHANNEL, registerDesktopBrowserIpc };
