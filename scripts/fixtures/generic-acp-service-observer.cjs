"use strict";
// Test-process diagnostics. Every operation returns its original value/Promise;
// rejection observers never replace, retry, suppress or reinterpret the Error.
const { RuntimeExtensionAdapter } = require("../../app/agent-service/runtime-extension-adapter");
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u, SAFE_STAGE = /^[a-zA-Z0-9_.-]{1,80}$/u;
function own(value, key) { return value && (typeof value === "object" || typeof value === "function") ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; }
function errorCodes(error) {
  const values = [];
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    const code = own(current, "code"), stage = own(current, "stage");
    values.push({ code: typeof code === "string" && SAFE_CODE.test(code) ? code : null,
      stage: typeof stage === "string" && SAFE_STAGE.test(stage) ? stage : null });
    current = own(current, "cause");
  }
  return values;
}
function installRuntimeObserver(record) {
  const restores = [], wrappedHosts = new WeakSet();
  const emit = value => { record({ at: Date.now(), ...value }); };
  const failed = (phase, error, host) => emit({ phase, outcome: "rejected", codes: errorCodes(error),
    ...(Number.isSafeInteger(host?.child?.pid) ? { pid: host.child.pid } : {}) });
  const observe = (target, key, phase, after) => {
    if (!target) return;
    const original = target[key]; if (typeof original !== "function") return;
    const wrapped = function (...args) {
      let value;
      try { value = original.apply(this, args); }
      catch (error) { failed(phase, error, this.host || this); throw error; }
      if (value && typeof value.then === "function") {
        // Return the original Promise. The side observer only retains fixed
        // codes; an observation fault remains an explicit test failure receipt.
        void value.then(result => { after?.(result); }, error => { failed(phase, error, this.host || this); })
          .catch(error => emit({ phase: "observer", outcome: "fault", codes: errorCodes(error) }));
      } else after?.(value);
      return value;
    };
    target[key] = wrapped; restores.push(() => { if (target[key] === wrapped) target[key] = original; });
  };
  for (const [key, phase] of [["acquire", "adapter.acquire"], ["_retireForCapacity", "adapter.capacity_retire"], ["_stopEntries", "adapter.stop_entries"]])
    observe(RuntimeExtensionAdapter.prototype, key, phase);
  observe(RuntimeExtensionAdapter.prototype, "start", "adapter.start", handle => {
    const host = handle.host; if (wrappedHosts.has(host)) return; wrappedHosts.add(host);
    observe(host.acpBridge, "close", "bridge.close"); observe(host, "stop", "host.stop"); observe(handle, "stop", "handle.stop");
  });
  const originalKill = process.kill;
  const observedKill = function (pid, signal) {
    try { return originalKill.call(this, pid, signal); }
    catch (error) {
      if (Number.isSafeInteger(pid) && pid < -1 && error.code !== "ESRCH") emit({
        phase: signal === 0 ? "process_group.probe" : "process_group.signal", outcome: "rejected",
        pid: -pid, signal: signal === 0 ? 0 : ["SIGTERM", "SIGKILL"].includes(signal) ? signal : null, codes: errorCodes(error) });
      throw error;
    }
  };
  process.kill = observedKill; restores.push(() => { if (process.kill === observedKill) process.kill = originalKill; });
  return { observeRegistry(registry) { observe(registry, "acquire", "registry.acquire"); },
    uninstall() { for (const restore of restores.reverse()) restore(); } };
}
module.exports = { installRuntimeObserver, errorCodes };
