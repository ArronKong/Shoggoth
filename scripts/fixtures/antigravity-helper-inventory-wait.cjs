"use strict";

// Observation only: no SDK, protocol, gate or process identity is changed.
function helperInventoryState({ observations = [], helpers = [], gateConsumptions = [] }) {
  const progress = [];
  for (const helper of helpers) {
    if (!Number.isSafeInteger(helper.pid) || !Number.isSafeInteger(helper.ppid)) continue;
    const rows = observations.filter(row => row.pid === helper.pid && row.ppid === helper.ppid);
    const failure = rows.find(row => row.method === "helper.failure");
    if (failure) return { status: "failed", reason: failure.code || "AGY_KERNEL_HELPER_FAILED", helperPid: helper.pid, progress };
    if (!gateConsumptions.some(gate => gate.actualProductionGateAccepted === true && gate.parentPid === helper.ppid)) continue;
    const requests = new Map();
    let initialized = false;
    for (const row of rows) {
      if (row.direction === "runtime" && ["initialize", "tools/list", "server/discover"].includes(row.method)) {
        requests.set(JSON.stringify(row.frameId), row.method);
      }
      if (row.direction !== "helper" || row.method !== "response") continue;
      const method = requests.get(JSON.stringify(row.frameId));
      if (method === "initialize") {
        if (row.rpcError === true) return { status: "failed", reason: "AGY_KERNEL_HELPER_INITIALIZE_REJECTED", helperPid: helper.pid, progress };
        initialized = Boolean(row.resultShape && row.resultShape.protocolVersion === "string");
      }
      if (method === "tools/list" && row.rpcError === true) return { status: "failed", reason: "AGY_KERNEL_HELPER_INVENTORY_REJECTED", helperPid: helper.pid, progress };
      if (method === "tools/list" && initialized && Array.isArray(row.groupToolsAvailable) && row.groupToolsAvailable.includes("group_messages_read")) {
        return { status: "ready", reason: "same-helper-initialize-and-group-inventory-response", helperPid: helper.pid,
          helperPpid: helper.ppid, initializeResponseSeen: true, groupInventoryResponseSeen: true, progress };
      }
    }
    progress.push({ helperPid: helper.pid, helperPpid: helper.ppid, gateAccepted: true, initializeResponseSeen: initialized,
      discoveryProbeSeen: rows.some(row => row.direction === "runtime" && row.method === "server/discover"), observations: rows.length });
  }
  return { status: "pending", reason: "waiting-for-same-helper-initialize-and-group-inventory", progress };
}

async function waitForHelperInventory({ read, readFailure = () => null, timeoutMs = 10000, pollMs = 25 }) {
  if (typeof read !== "function" || typeof readFailure !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || timeoutMs > 30000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new TypeError("Invalid inventory wait options");
  const started = performance.now();
  let polls = 0;
  for (;;) {
    polls += 1;
    const state = helperInventoryState(read());
    const elapsedMs = Math.round(performance.now() - started);
    if (state.status !== "pending") return { ...state, elapsedMs, polls };
    const failure = readFailure();
    if (failure) return { ...state, status: "failed", reason: failure, elapsedMs, polls };
    if (elapsedMs >= timeoutMs) return { ...state, status: "deadline", reason: "AGY_KERNEL_HELPER_INVENTORY_DEADLINE", elapsedMs, polls };
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, timeoutMs - elapsedMs))));
  }
}

module.exports = { helperInventoryState, waitForHelperInventory };
