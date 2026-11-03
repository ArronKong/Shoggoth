"use strict";

const { validStopImpact } = require("./agent-service/stop-impact");

// ShipIt waits for the app bundle's running background service to exit. Keep
// the UI open until that service has stopped, so a failed stop can be retried.
async function prepareDesktopAppInstall({ launchAgent, serviceRequest, backgroundStartup, forceStop = false,
  onBackgroundStopped = () => {} }) {
  try { if (backgroundStartup) await backgroundStartup; }
  catch { if (!forceStop) return "background-unavailable"; }

  // Only an explicit App update opts in: the old Service need not be idle or
  // responsive. stop() disables KeepAlive and confirms launchd has unloaded it.
  if (forceStop) {
    let background;
    // This snapshot only preserves an already-stopped background on recovery;
    // failure to read it must not prevent the authoritative stop below.
    try { background = await launchAgent.status(); } catch {}
    try {
      await launchAgent.stop();
      if (background?.loaded !== false) onBackgroundStopped();
    } catch { return "background-stop-failed"; }
    return null;
  }

  let background;
  try { background = await launchAgent.status(); }
  catch { return "background-unavailable"; }
  if (background?.supported !== true || typeof background.loaded !== "boolean") return "background-unavailable";
  if (background.loaded !== true) return null;

  let impact;
  let service;
  try {
    [impact, service] = await Promise.all([
      serviceRequest("service.stopImpact", {}),
      serviceRequest("service.status", {}),
    ]);
  } catch { return "background-unavailable"; }
  if (!validStopImpact(impact) || typeof service?.instanceNonce !== "string"
    || !/^[a-f0-9]{48}$/u.test(service.instanceNonce)) return "background-unavailable";
  if (impact.totalCount > 0) return "active-runs";

  // This Service operation checks the impact revision and fences new runs in
  // one turn. A run starting after the first impact query blocks installation.
  try {
    // A previous failed stop may have left this same idle Service fenced.
    if (service.maintenanceQuiesced !== true) {
      const fence = await serviceRequest("service.quiesceIdle", {
        instanceNonce: service.instanceNonce,
        revision: impact.revision,
      });
      if (fence?.quiesced !== true || fence.instanceNonce !== service.instanceNonce) {
        return "background-unavailable";
      }
    }
  } catch (error) {
    return error?.code === "SERVICE_MAINTENANCE_BUSY" ? "background-busy" : "background-unavailable";
  }

  try {
    await launchAgent.stop();
    onBackgroundStopped();
  } catch {
    // start() accepts a healthy but quiesced Service. Confirm it has stopped
    // before starting it again, so recovery really clears the idle fence.
    try { await launchAgent.stop(); await launchAgent.start(); } catch {}
    return "background-stop-failed";
  }
  return null;
}

function createDesktopAppInstallPreparation(options) {
  let releaseBackgroundActions = null;
  let backgroundStopped = false;
  const release = () => {
    const callback = releaseBackgroundActions;
    releaseBackgroundActions = null;
    callback?.();
  };
  return {
    async prepareInstall() {
      if (releaseBackgroundActions) return "background-busy";
      try { releaseBackgroundActions = options.suspendBackgroundActions(); }
      catch { return "background-busy"; }
      try {
        // Drain startup even if it failed; a user-requested stop can still work.
        try { if (options.backgroundStartup) await options.backgroundStartup; } catch {}
        // The Host fence blocks new actions; drain a start/stop already queued
        // before observing launchd, including one whose old callback is stale.
        await options.launchAgent.whenIdle();
        const reason = await prepareDesktopAppInstall({ ...options, backgroundStartup: null, forceStop: true,
          onBackgroundStopped: () => { backgroundStopped = true; } });
        if (reason) release();
        return reason;
      } catch {
        release();
        return "background-stop-failed";
      }
    },
    async restoreAfterInstallFailure() {
      try {
        if (backgroundStopped) await options.launchAgent.start();
      } finally {
        backgroundStopped = false;
        release();
      }
    },
  };
}

module.exports = { createDesktopAppInstallPreparation, prepareDesktopAppInstall };
