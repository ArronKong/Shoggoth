"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
function unavailable() { throw Object.assign(new Error("App 管理的 Hermes 运行环境尚未验证，请先完成启动"), { code: "MANAGED_HERMES_HOST_UNAVAILABLE", status: 503 }); }
const inside = (root, file) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`); };
function actual(value, directory, owned = false) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) unavailable();
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || fs.realpathSync(value) !== value || (directory ? !stat.isDirectory() : !stat.isFile())
    || (owned && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) unavailable();
  return value;
}
function candidateInterpreter(runtimeRoot, value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || !inside(runtimeRoot, value)) unavailable();
  // The frozen manifest declares venv/bin/python as a relative alias into its
  // self-contained Python closure. Never accept an alias to the system runtime.
  if (fs.lstatSync(value).isSymbolicLink()) {
    const target = fs.realpathSync(value);
    if (value !== path.join(runtimeRoot, "venv", "bin", "python")
      || !inside(path.join(runtimeRoot, "python"), target)) unavailable();
    actual(target, false);
    return value;
  }
  return actual(value, false);
}
function createHermesLocalRuntimeScope({ getManagedExecution = null, getManagedEndpoint = null } = {}) {
  if ((getManagedExecution !== null && typeof getManagedExecution !== "function") || (getManagedEndpoint !== null && typeof getManagedEndpoint !== "function")) throw new TypeError("Invalid Hermes local scope");
  const isManaged = () => getManagedExecution !== null && getManagedExecution() !== undefined;
  function current() {
    if (getManagedExecution === null) return undefined;
    const value = getManagedExecution(); if (value === undefined) return undefined;
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) unavailable();
    try {
      const runtimeRoot = actual(value.runtimeRoot, true), interpreterPath = candidateInterpreter(runtimeRoot, value.interpreterPath), entryPath = actual(value.entryPath, false);
      const home = actual(value.home, true, true), stateDir = actual(value.stateDir, true, true), workspace = actual(value.workspace, true, true), configPath = actual(value.configPath, false, true);
      if (!inside(runtimeRoot, interpreterPath) || entryPath !== path.join(runtimeRoot, "hermes_cli", "main.py") || path.dirname(home) !== stateDir
        || path.dirname(workspace) !== stateDir || configPath !== path.join(stateDir, "config.yaml")
        || !value.env || Object.getPrototypeOf(value.env) !== Object.prototype || value.env.HOME !== home || value.env.HERMES_HOME !== stateDir
        || Object.values(value.env).some(item => typeof item !== "string")) unavailable();
      return Object.freeze({ runtimeRoot, interpreterPath, entryPath, home, stateDir, workspace, configPath, env: Object.freeze({ ...value.env }) });
    } catch { unavailable(); }
  }
  function endpoint() {
    const execution = current(); if (!execution || !getManagedEndpoint) unavailable();
    const value = getManagedEndpoint();
    if (!value || typeof value.baseUrl !== "string" || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(value.token)) unavailable();
    let url; try { url = new URL(value.baseUrl); } catch { unavailable(); }
    const identity = value.identity;
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || !["", "/"].includes(url.pathname) || url.username || url.password || url.search || url.hash
      || !identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 || typeof identity.startIdentity !== "string" || !identity.startIdentity
      || !/^[a-f0-9]{64}$/u.test(identity.nonce || "") || value.runtimeRoot !== execution.runtimeRoot || value.dataRoot !== execution.stateDir
      || value.interpreterPath !== execution.interpreterPath || value.entryPath !== execution.entryPath) unavailable();
    return { ...value, baseUrl: value.baseUrl.replace(/\/+$/u, ""), identity: Object.freeze({ ...identity }), execution };
  }
  const dashboards = new WeakMap();
  const key = value => JSON.stringify([value.baseUrl, value.token, value.identity.pid, value.identity.startIdentity, value.identity.nonce,
    value.runtimeRoot, value.dataRoot, value.interpreterPath, value.entryPath]);
  function assertDashboard(dash) {
    if (!isManaged()) { if (dashboards.has(dash)) unavailable(); return true; }
    const record = dashboards.get(dash); if (!record || key(endpoint()) !== record.key) unavailable();
    return true;
  }
  function profileHome(profile) {
      const value = current(); const base = value?.stateDir || process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
      if (typeof profile !== "string" || !profile || profile === "." || profile === ".." || path.basename(profile) !== profile || /[\\\u0000-\u001f\u007f]/u.test(profile)) unavailable();
      const root = profile === "default" ? base : path.join(base, "profiles", profile);
      if (value) {
        if (!inside(base, root)) unavailable();
        for (const p of [path.join(base, "profiles"), root]) if (fs.existsSync(p)) actual(p, true, true);
      }
      return root;
  }
  return Object.freeze({ current, isManaged,
    assertLegacyProcess() { if (isManaged()) unavailable(); },
    userHome: () => current()?.home || os.homedir(),
    hermesHome: () => current()?.stateDir || process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
    profileHome,
    bindDashboard(profile = "default") {
      profileHome(profile);
      const value = endpoint(), dash = { profile, proc: null, spawned: false, managed: true };
      const record = { key: key(value), baseUrl: value.baseUrl, token: value.token }; dashboards.set(dash, record);
      Object.defineProperties(dash, {
        baseUrl: { enumerable: true, get() { assertDashboard(dash); return record.baseUrl; } },
        token: { get() { assertDashboard(dash); return record.token; } },
        assertCurrent: { value: () => assertDashboard(dash) },
      });
      return Object.freeze(dash);
    },
    assertDashboard,
    requestUrl(dash, requestUrl) {
      assertDashboard(dash);
      if (!isManaged()) return requestUrl; const value = dashboards.get(dash); let url;
      try { url = new URL(requestUrl); } catch { unavailable(); }
      if (url.origin !== value.baseUrl || url.username || url.password || url.hash) unavailable();
      url.searchParams.set("profile", dash.profile);
      return url.toString();
    },
  });
}
module.exports = { createHermesLocalRuntimeScope };
