"use strict";

const assert = require("node:assert/strict");
const { createDesktopAppInstallPreparation, prepareDesktopAppInstall } = require("../app/desktop-app-install-preparation");

const revision = "a".repeat(64);
const instanceNonce = "b".repeat(48);
const impact = { availability: "available", revision, totalCount: 0, runs: [] };

async function main() {
  const calls = [];
  const launchAgent = {
    status: async () => ({ supported: true, loaded: true }),
    stop: async () => { calls.push("stop"); },
    start: async () => { calls.push("start"); },
  };
  const serviceRequest = async (method, params) => {
    calls.push(method);
    if (method === "service.stopImpact") return impact;
    if (method === "service.status") return { instanceNonce };
    assert.deepEqual(params, { instanceNonce, revision });
    return { quiesced: true, instanceNonce };
  };
  assert.equal(await prepareDesktopAppInstall({ launchAgent, serviceRequest }), null);
  assert.equal(calls.at(-1), "stop");
  assert.ok(calls.indexOf("service.quiesceIdle") < calls.indexOf("stop"));

  calls.length = 0;
  assert.equal(await prepareDesktopAppInstall({
    launchAgent,
    serviceRequest: async (method) => method === "service.stopImpact"
      ? { ...impact, totalCount: 1, runs: [{ runId: "run-1", source: "chat",
        status: "running", agentName: null, title: null }] }
      : { instanceNonce },
  }), "active-runs");
  assert.equal(calls.includes("stop"), false);

  calls.length = 0;
  const failedStop = { ...launchAgent,
    stop: async () => { calls.push("stop"); throw new Error("stop failed"); } };
  assert.equal(await prepareDesktopAppInstall({
    launchAgent: failedStop, serviceRequest,
  }), "background-stop-failed");
  assert.deepEqual(calls.slice(-2), ["stop", "stop"], "do not accept a healthy but quiesced Service as restored");

  calls.length = 0;
  assert.equal(await prepareDesktopAppInstall({
    launchAgent,
    serviceRequest: async (method, params) => {
      if (method === "service.quiesceIdle") {
        assert.deepEqual(params, { instanceNonce, revision });
        throw Object.assign(new Error("busy"), { code: "SERVICE_MAINTENANCE_BUSY" });
      }
      return serviceRequest(method, params);
    },
  }), "background-busy");
  assert.equal(calls.includes("stop"), false);

  {
    let attempts = 0;
    calls.length = 0;
    const recoverableStop = { ...launchAgent, stop: async () => {
      calls.push("stop");
      if (attempts++ === 0) throw new Error("stop was not confirmed");
    } };
    assert.equal(await prepareDesktopAppInstall({ launchAgent: recoverableStop, serviceRequest }),
      "background-stop-failed");
    assert.deepEqual(calls.slice(-3), ["stop", "stop", "start"]);
  }

  {
    calls.length = 0;
    assert.equal(await prepareDesktopAppInstall({ launchAgent,
      serviceRequest: async (method, params) => method === "service.status"
        ? { instanceNonce, maintenanceQuiesced: true } : serviceRequest(method, params),
    }), null);
    assert.equal(calls.includes("service.quiesceIdle"), false,
      "a retry must be able to stop the idle Service left fenced by an earlier failed stop");
    assert.equal(calls.at(-1), "stop");
  }

  for (const status of [{ supported: false }, { supported: true }]) {
    calls.length = 0;
    assert.equal(await prepareDesktopAppInstall({ launchAgent: { ...launchAgent, status: async () => status },
      serviceRequest }), "background-unavailable");
    assert.equal(calls.length, 0, "an unknown launchd state cannot authorize installation");
  }

  for (const response of [{ instanceNonce: "wrong" }, null]) {
    calls.length = 0;
    assert.equal(await prepareDesktopAppInstall({ launchAgent,
      serviceRequest: async (method, params) => method === "service.status"
        ? response : serviceRequest(method, params),
    }), "background-unavailable");
    assert.equal(calls.includes("stop"), false);
  }

  {
    let stopped = 0;
    let started = 0;
    let held = false;
    let released = 0;
    const item = createDesktopAppInstallPreparation({
      launchAgent: { ...launchAgent, whenIdle: async () => {},
        stop: async () => { stopped += 1; }, start: async () => { started += 1; } },
      serviceRequest,
      suspendBackgroundActions: () => {
        assert.equal(held, false);
        held = true;
        return () => { held = false; released += 1; };
      },
    });
    assert.equal(await item.prepareInstall(), null);
    assert.equal(stopped, 1);
    assert.equal(held, true, "background actions stay suspended while the native installer fetches the update");
    assert.equal(await item.prepareInstall(), "background-busy");
    await item.restoreAfterInstallFailure();
    assert.equal(started, 1);
    assert.equal(held, false);
    assert.equal(released, 1);
    await item.restoreAfterInstallFailure();
    assert.equal(started, 1, "an already restored background must not be started a second time");
  }

  {
    let releasePendingStart;
    let statusReads = 0;
    const pendingStart = new Promise((resolve) => { releasePendingStart = resolve; });
    const item = createDesktopAppInstallPreparation({
      launchAgent: { ...launchAgent, whenIdle: () => pendingStart,
        status: async () => { statusReads += 1; return { supported: true, loaded: true }; } },
      serviceRequest, suspendBackgroundActions: () => () => {},
    });
    const install = item.prepareInstall();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statusReads, 0, "observe launchd only after the old queued start has finished");
    releasePendingStart();
    assert.equal(await install, null);
    assert.equal(statusReads, 1);
    await item.restoreAfterInstallFailure();
  }

  for (const loaded of [false, true]) {
    let started = 0;
    let released = 0;
    const item = createDesktopAppInstallPreparation({
      launchAgent: { ...launchAgent, whenIdle: async () => {},
        status: async () => ({ supported: true, loaded }),
        start: async () => { started += 1; if (loaded) throw new Error("restart failed"); } },
      serviceRequest, suspendBackgroundActions: () => () => { released += 1; },
    });
    assert.equal(await item.prepareInstall(), null);
    if (loaded) await assert.rejects(item.restoreAfterInstallFailure(), /restart failed/);
    else await item.restoreAfterInstallFailure();
    assert.equal(started, loaded ? 1 : 0, "do not enable a background the user had already stopped");
    assert.equal(released, 1, "a failed recovery must release the Host maintenance lock");
  }

  {
    let released = 0;
    const item = createDesktopAppInstallPreparation({ launchAgent, serviceRequest,
      backgroundStartup: Promise.reject(new Error("startup failed")),
      suspendBackgroundActions: () => () => { released += 1; },
    });
    assert.equal(await item.prepareInstall(), "background-unavailable");
    assert.equal(released, 1);
  }

  console.log("Desktop App install preparation unit: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
