"use strict";

// Electron does not await an async before-quit listener. Hold the first quit
// until the current App-owned writer's exact stop receipt is confirmed.
function installManagedPluginHostQuitGate({ app, getHost = null, getHosts = null, onFailure = () => {} } = {}) {
  if (!app || typeof app.on !== "function" || typeof app.quit !== "function"
    || (typeof getHost !== "function" && typeof getHosts !== "function") || typeof onFailure !== "function") throw new TypeError("Invalid managed Host quit gate");
  let complete = false, stopping = null;
  const beforeQuit = event => {
    if (complete) return;
    const hosts = (getHosts ? getHosts() : [getHost()]).filter(host => host?.isManaged());
    if (!hosts.length) return;
    event.preventDefault();
    if (stopping) return;
    stopping = Promise.resolve().then(() => Promise.allSettled(hosts.map(host => host.close({ operationId: "desktop-before-quit", timeoutMs: 60000 }))))
      .then(results => {
        if (results.some(result => result.status !== "fulfilled" || result.value?.state !== "stopped")) throw new Error("Managed Host exit unverified");
        complete = true; app.quit();
      }).catch(() => { onFailure(); }).finally(() => { stopping = null; });
  };
  app.on("before-quit", beforeQuit);
  return Object.freeze({ pending: () => stopping, complete: () => complete });
}
module.exports = { installManagedPluginHostQuitGate };
