"use strict";

// LaunchAgent 的 ProcessType=Background 不会覆盖 Electron bundle 自身的
// NSApplication 激活策略。内部 role 必须在 ready 前禁止成为前台 App，否则同一
// bundle 的 Service/MCP 会各自注册 Dock 图标。
function prohibitBackgroundActivation(electronApp, platform = process.platform) {
  if (platform !== "darwin" || !electronApp
    || typeof electronApp.setActivationPolicy !== "function") return false;
  electronApp.setActivationPolicy("prohibited");
  return true;
}

function hideBackgroundDock(electronApp, platform = process.platform) {
  if (platform !== "darwin" || !electronApp?.dock
    || typeof electronApp.dock.hide !== "function") return false;
  electronApp.dock.hide();
  // dock.hide() selects accessory. Keep the final policy prohibited, including
  // after Launch Services delivers an activation to this shared App bundle.
  prohibitBackgroundActivation(electronApp, platform);
  return true;
}

function prepareBackgroundRoleActivation(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const argv = options.argv || process.argv.slice(1);
  if (platform !== "darwin" || env.ELECTRON_RUN_AS_NODE === "1"
    || !argv.some((arg) => typeof arg === "string"
      && arg.startsWith("--shoggoth-internal-role=")
      && arg !== "--shoggoth-internal-role=ui")) return false;
  // This only changes presentation. Role authentication still runs separately,
  // including for malformed/rejected launches, which must also remain silent.
  const electronApp = options.electronApp || require("electron").app;
  return prohibitBackgroundActivation(electronApp, platform);
}

module.exports = { hideBackgroundDock, prepareBackgroundRoleActivation, prohibitBackgroundActivation };
