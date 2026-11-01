#!/usr/bin/env node
"use strict";
// Test-process observation only: no source stop policies, outcomes or deadlines
// are replaced. This is a diagnostic preflight, never a formal soak receipt.
const fs = require("node:fs"), path = require("node:path");
const { RuntimeExtensionAdapter } = require("../app/agent-service/runtime-extension-adapter");
const output = path.resolve(__dirname, "../.artifacts/acp-foundation-completion-20261026/d-bridge");
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, `acquire-retirement-diagnostic-${Date.now()}.jsonl`);
const note = row => fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...row }) + "\n", { mode: 0o600 });
const errorData = (error, depth = 0) => error && depth < 8 ? { code: error.code || error.name || null, message: error.message || null,
  stack: error.stack || null, cause: errorData(Object.getOwnPropertyDescriptor(error, "cause")?.value, depth + 1) } : null;
const hostData = host => ({ pid: host?.child?.pid || null, state: host?.state, cleanupIncomplete: host?.cleanupIncomplete,
  pendingOperations: host?.pendingOperations, pendingRpc: host?.rpc?.pending.size, activeServerRequests: host?.rpc?.activeServerRequestIds.size,
  bridgeIdle: host?.acpBridge?.isIdle(), idle: host?.canRetireIdle?.(), streams: host?.child ? ["stdin", "stdout", "stderr"].map(key => ({ key,
    closed: host.child[key]?.closed, destroyed: host.child[key]?.destroyed })) : [] });
const entriesData = adapter => [...adapter.handles.values()].map(entry => ({ key: entry.key, retiring: !!entry.retiring,
  executionUnknown: entry.executionUnknown, activeTurns: entry.activeTurns.size, ...hostData(entry.host) }));
for (const method of ["acquire", "_retireForCapacity", "_stopEntries", "start"]) {
  const original = RuntimeExtensionAdapter.prototype[method];
  RuntimeExtensionAdapter.prototype[method] = async function (...args) {
    const startedAt = Date.now();
    try {
      const value = await original.apply(this, args);
      if (method === "start") {
        const host = value.host, originalStop = host.stop, originalClose = host.acpBridge.close;
        host.acpBridge.close = function (...values) { try { return originalClose.apply(this, values); }
          catch (error) { note({ phase: "bridge-close-error", host: hostData(host), error: errorData(error) }); throw error; } };
        const tracedStop = function (...values) {
          const before = hostData(host), at = Date.now();
          return Promise.resolve().then(() => originalStop.apply(this, values)).then(result => {
            note({ phase: "host-stop-success", durationMs: Date.now() - at, before, after: hostData(host) }); return result;
          }, error => { note({ phase: "host-stop-error", durationMs: Date.now() - at, before, after: hostData(host), error: errorData(error) }); throw error; });
        };
        host.stop = value.stop = tracedStop;
      }
      return value;
    } catch (error) {
      note({ phase: `${method}-error`, durationMs: Date.now() - startedAt, error: errorData(error), entries: entriesData(this),
        stopGeneration: this.stopGeneration, closing: this.closing }); throw error;
    }
  };
}
console.log("ACP_ACQUIRE_DIAGNOSTIC " + JSON.stringify({ file }));
process.argv = [process.execPath, path.join(__dirname, "generic-acp-service-isolation-soak.cjs"), "--preflight", "--interactions", "200", "--agents", "2"];
require("./generic-acp-service-isolation-soak.cjs");
