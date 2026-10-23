"use strict";

const assert = require("node:assert/strict");
const { createDesktopComputerServiceRestart } = require("../app/desktop-computer-service-restart");

const instanceNonce = "b".repeat(48), revision = "a".repeat(64);
function fixture({ active = false, raced = false, loaded = true, stopFails = false, startFails = false } = {}) {
  const calls = [];
  let held = false;
  const reload = createDesktopComputerServiceRestart({
    suspendBackgroundActions: () => {
      assert.equal(held, false); held = true; calls.push("hold");
      return () => { held = false; calls.push("release"); };
    },
    launchAgent: {
      whenIdle: async () => { calls.push("drain"); },
      status: async () => ({ supported: true, loaded }),
      stop: async () => { calls.push("stop"); if (stopFails) throw new Error("stop failed"); },
      start: async () => { calls.push("start"); if (startFails) throw new Error("start failed"); },
      repair: async () => { throw new Error("repair does not restart an unchanged plist"); },
    },
    serviceRequest: async (method, params) => {
      calls.push(method);
      if (method === "service.status") return { instanceNonce };
      if (method === "service.stopImpact") return { availability: "available", revision,
        totalCount: active ? 1 : 0, runs: active ? [{ runId: "run-1", source: "chat", status: "running", agentName: null, title: null }] : [] };
      assert.equal(method, "service.quiesceIdle");
      assert.deepEqual(params, { instanceNonce, revision });
      if (raced) throw Object.assign(new Error("run started"), { code: "SERVICE_MAINTENANCE_BUSY" });
      return { quiesced: true, instanceNonce };
    },
    onRestarted: async () => { calls.push("refresh-backends"); },
  });
  return { reload, calls, held: () => held };
}

async function main() {
  {
    const f = fixture();
    const first = f.reload(), second = f.reload();
    assert.equal(first, second, "coalesce overlapping clicks without restarting twice");
    await first;
    assert.deepEqual(f.calls, ["hold", "drain", "service.stopImpact", "service.status", "service.quiesceIdle", "stop", "start", "refresh-backends", "release"]);
    assert.equal(f.held(), false);
  }
  for (const options of [{ active: true }, { raced: true }]) {
    const f = fixture(options);
    await assert.rejects(f.reload(), { code: "COMPUTER_PERMISSION_RELOAD_BUSY" });
    assert.equal(f.calls.includes("stop"), false);
    assert.equal(f.calls.includes("start"), false);
    assert.equal(f.held(), false);
  }
  {
    const f = fixture({ loaded: false });
    await assert.rejects(f.reload(), { code: "COMPUTER_PERMISSION_RELOAD_FAILED" });
    assert.equal(f.calls.includes("start"), false, "do not enable a service the user stopped");
  }
  {
    const f = fixture({ stopFails: true });
    await assert.rejects(f.reload(), { code: "COMPUTER_PERMISSION_RELOAD_FAILED" });
    assert.equal(f.calls.includes("start"), false, "unknown stop outcome cannot authorize start");
    assert.equal(f.held(), false);
  }
  {
    const f = fixture({ startFails: true });
    await assert.rejects(f.reload(), { code: "COMPUTER_PERMISSION_RELOAD_FAILED" });
    assert.equal(f.held(), false);
  }
  console.log("Desktop Computer permission reload: PASS (real restart, idle fence, race refusal, recovery, coalescing)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
