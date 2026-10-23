"use strict";
// App-private connection binding. A config save changes the credential namespace
// immediately, even while an earlier lifecycle/config callback is still awaiting.
// Neither credentials nor their hashes leave this closure.
function createManagedOpenClawEndpointGeneration({ getConfig, isManaged, getOwnerGeneration } = {}) {
  if ([getConfig, isManaged, getOwnerGeneration].some(fn => typeof fn !== "function")) throw new TypeError("Invalid endpoint generation composition");
  let namespace = null, revision = 0;
  return Object.freeze({
    current() {
      const owner = getOwnerGeneration();
      if (!Number.isSafeInteger(owner) || owner < 0) throw new TypeError("Invalid owner generation");
      if (isManaged() !== true) {
        const config = getConfig();
        if (!config || typeof config.gatewayUrl !== "string" || typeof config.token !== "string") throw new TypeError("Invalid Gateway config");
        const next = { url: config.gatewayUrl.trim(), token: config.token };
        if (namespace && (namespace.url !== next.url || namespace.token !== next.token)) revision += 1;
        namespace = next;
      }
      return `${owner}:${revision}`;
    },
  });
}
module.exports = { createManagedOpenClawEndpointGeneration };
