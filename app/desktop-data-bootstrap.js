"use strict";

const path = require("node:path");
const { resolveCanonicalServicePaths } = require("./agent-service/paths");
const { ensurePrivateDirectoryTree } = require("./agent-service/security");
const bootstrapped = new WeakMap();

// Select the one product root before configStore or Chromium can open a writer.
// A previous experiment's profile selector is deliberately not read.
function prepareDesktopData(app, options = {}) {
  if (bootstrapped.has(app)) return bootstrapped.get(app);
  if (!app || app.isReady() || typeof app.requestSingleInstanceLock !== "function") {
    throw Object.assign(new Error("DESKTOP_DATA_BOOTSTRAP_LATE"), { code: "DESKTOP_DATA_BOOTSTRAP_LATE" });
  }
  const paths = resolveCanonicalServicePaths(options);
  const sessionDir = path.join(paths.userDataRoot, "ui-session");
  const cacheDir = path.join(paths.cacheDir, "ui");
  for (const target of [paths.userDataRoot, sessionDir, cacheDir]) {
    ensurePrivateDirectoryTree(target, paths.trustedRoot);
  }
  app.setPath("userData", paths.userDataRoot);
  app.setPath("sessionData", sessionDir);
  app.setPath("cache", cacheDir);
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  bootstrapped.set(app, paths);
  return paths;
}

function getBootstrappedDesktopPaths(app) {
  const paths = bootstrapped.get(app);
  if (!paths) throw Object.assign(new Error("DESKTOP_DATA_BOOTSTRAP_REQUIRED"), { code: "DESKTOP_DATA_BOOTSTRAP_REQUIRED" });
  return paths;
}

module.exports = { prepareDesktopData, getBootstrappedDesktopPaths };
