"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

// The upstream module is shared, but no request may borrow another Service's
// storage, Profile, workspace, credentials or session authority.
const scopes = new AsyncLocalStorage();

function withMemoryHost(host, action) {
  if (!host || typeof host.assertCurrent !== "function") {
    throw new TypeError("A current Shoggoth memory host is required");
  }
  host.assertCurrent();
  return scopes.run(host, action);
}

function callHost(name, ...args) {
  const host = scopes.getStore();
  if (!host) throw Object.assign(new Error("Memory operation has no Service scope"), { code: "MEMORY_HOST_SCOPE_REQUIRED" });
  host.assertCurrent();
  if (typeof host[name] !== "function") throw new Error(`Memory host capability unavailable: ${name}`);
  return host[name](...args);
}

// Native timeout cleanup can be queued after the parent hook has returned.
// This capability only releases that invocation's search work; it grants no
// new reads, writes, sessions or model calls after the ordinary scope closes.
function callCleanupHost(name, ...args) {
  const host = scopes.getStore();
  if (name !== "closeActiveMemorySearchManager" || !host
    || typeof host.assertCleanupCurrent !== "function" || typeof host[name] !== "function") {
    throw Object.assign(new Error("Memory cleanup scope is unavailable"), { code: "MEMORY_HOST_SCOPE_REQUIRED" });
  }
  host.assertCleanupCurrent();
  return host[name](...args);
}

// A retained file observer can join its already-owned handles after Product
// read authority ends. Native teardown can only emit a diagnostic here; it
// cannot reopen storage, inspect sources or acquire a new Service capability.
function withMemoryObserverCleanup(host, action) {
  const scope = Object.freeze({
    assertCurrent() {},
    log(level, subsystem, message) {
      if (["debug", "info", "warn", "error"].includes(level)) host.searchIndex?.logger?.[level]?.(`[${subsystem}] ${message}`);
    },
  });
  return scopes.run(scope, action);
}

module.exports = { withMemoryHost, callHost, callCleanupHost, withMemoryObserverCleanup };
