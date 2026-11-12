"use strict";

const { detectOpenclawHost } = require("./openclaw-host");

// Host-side connection discovery also runs after onboarding has been dismissed.
// It only moves an unavailable automatic endpoint to a reachable local endpoint.
function createOpenclawGatewayDiscovery({ configStore, onConfigChanged, detect = detectOpenclawHost } = {}) {
  let pending = null;
  let lastAttempt = 0;
  let lastScope = "";
  const scope = cfg => JSON.stringify([cfg.gatewayUrl, cfg.token, cfg.gatewayAutoDiscover,
    cfg.openclawPluginHostMode, cfg.disabledBackends]);
  const eligible = cfg => cfg.gatewayAutoDiscover === true && !cfg.token
    && cfg.openclawPluginHostMode !== "managed" && !cfg.disabledBackends?.includes("openclaw")
    && (!cfg.gatewayUrl || isLocalUrl(cfg.gatewayUrl));

  async function discover() {
    const config = configStore.read();
    if (!eligible(config) || configStore.getReadStatus() !== "ok") return false;
    const before = scope(config);
    if (lastScope === before && Date.now() - lastAttempt < 10000) return false;
    lastScope = before;
    lastAttempt = Date.now();
    const host = await detect({ gatewayUrl: config.gatewayUrl });
    if (host.gatewayRunning || !host.localGatewayRunning || !isLocalUrl(host.localGatewayUrl)
      || host.localGatewayUrl === config.gatewayUrl) return false;
    // A settings save, disconnect or managed-host switch during discovery wins.
    if (configStore.getReadStatus() !== "ok" || scope(configStore.read()) !== before) return false;
    const saved = configStore.write({ gatewayUrl: host.localGatewayUrl }, { discoveredGateway: true });
    await onConfigChanged?.(saved);
    return true;
  }

  return function refresh() {
    if (!pending) pending = discover().finally(() => { pending = null; });
    return pending;
  };
}

function isLocalUrl(raw) {
  try {
    const url = new URL(raw);
    return ["ws:", "wss:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}

module.exports = { createOpenclawGatewayDiscovery };
