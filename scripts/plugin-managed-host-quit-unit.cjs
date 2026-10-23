#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { installManagedPluginHostQuitGate } = require("../app/managed-plugin-host-quit");
async function main() {
  const app = new EventEmitter(); let quits = 0, prevented = 0, stops = 0, failures = 0;
  app.quit = () => { quits += 1; };
  let release, fail = false, managed = false;
  const host = { isManaged: () => managed,
    close: async input => { stops += 1; assert.deepEqual(input, { operationId: "desktop-before-quit", timeoutMs: 60000 });
      await new Promise(resolve => { release = resolve; }); if (fail) throw new Error("own writer not confirmed"); return { state: "stopped" }; } };
  const gate = installManagedPluginHostQuitGate({ app, getHost: () => host, onFailure: () => { failures += 1; } });
  const event = () => ({ preventDefault: () => { prevented += 1; } });
  app.emit("before-quit", event()); assert.equal(prevented, 0); assert.equal(stops, 0);
  managed = true; fail = true;
  app.emit("before-quit", event()); app.emit("before-quit", event()); await Promise.resolve();
  assert.equal(prevented, 2); assert.equal(stops, 1); assert.equal(quits, 0);
  release(); await gate.pending(); assert.equal(gate.complete(), false); assert.equal(failures, 1); assert.equal(quits, 0);
  fail = false; app.emit("before-quit", event()); await Promise.resolve(); release(); await gate.pending();
  assert.equal(stops, 2); assert.equal(quits, 1); assert.equal(gate.complete(), true);
  const old = prevented; app.emit("before-quit", event()); assert.equal(prevented, old);
  const dualApp = new EventEmitter(); let dualQuits = 0, dualFailures = 0; dualApp.quit = () => { dualQuits += 1; };
  let endFirst, endSecond;
  const first = { isManaged: () => true, close: () => new Promise(resolve => { endFirst = resolve; }) };
  const second = { isManaged: () => true, close: () => new Promise(resolve => { endSecond = resolve; }) };
  const dualGate = installManagedPluginHostQuitGate({ app: dualApp, getHosts: () => [first, second, null], onFailure: () => { dualFailures += 1; } });
  dualApp.emit("before-quit", event()); await Promise.resolve();
  endFirst({ state: "stopped" }); await Promise.resolve(); assert.equal(dualQuits, 0);
  endSecond({ state: "needs_verification" }); await dualGate.pending(); assert.equal(dualGate.complete(), false); assert.equal(dualFailures, 1);
  dualApp.emit("before-quit", event()); await Promise.resolve(); endFirst({ state: "stopped" }); endSecond({ state: "stopped" }); await dualGate.pending();
  assert.equal(dualGate.complete(), true); assert.equal(dualQuits, 1);
  console.log("Managed Host quit gate: PASS (existing mode untouched, concurrent quit single-flight, unconfirmed exit retained, real stop receipt required)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
