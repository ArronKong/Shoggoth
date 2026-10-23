"use strict";

const { prepareDesktopAppInstall } = require("./desktop-app-install-preparation");
const { serviceError } = require("./agent-service/security");

// Reuse the idle fence and stop recovery used by app updates. repair() alone
// keeps the same healthy process when its launchd plist is already correct.
function createDesktopComputerServiceRestart(options) {
  let pending = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      let release;
      try { release = options.suspendBackgroundActions(); }
      catch { throw serviceError("COMPUTER_PERMISSION_RELOAD_BUSY", "后台服务正忙，请稍后重载权限"); }
      try {
        await options.launchAgent.whenIdle();
        let stopped = false;
        const reason = await prepareDesktopAppInstall({ ...options,
          onBackgroundStopped: () => { stopped = true; } });
        if (reason === "active-runs" || reason === "background-busy") {
          throw serviceError("COMPUTER_PERMISSION_RELOAD_BUSY", "请等待运行中的任务结束后重载权限");
        }
        if (reason || !stopped) {
          throw serviceError("COMPUTER_PERMISSION_RELOAD_FAILED", "后台服务未能重载，请检查服务状态后重试");
        }
        try { await options.launchAgent.start(); }
        catch { throw serviceError("COMPUTER_PERMISSION_RELOAD_FAILED", "后台未能重新启动，请检查服务状态后重试"); }
        await options.onRestarted?.();
      } finally { release(); }
    })().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createDesktopComputerServiceRestart };
