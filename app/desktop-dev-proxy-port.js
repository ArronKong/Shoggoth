"use strict";

const DEFAULT_PROXY_PORT = 18790;
const DEVELOPMENT_PORT_VARIABLE = "SHOGGOTH_DEV_GATEWAY_PROXY_PORT";

// Packaged installations keep their stable origin. Source-mode instances may
// choose a separate loopback listener without bypassing the federating proxy.
function resolveDesktopProxyPort({ isPackaged, env = process.env } = {}) {
  if (typeof isPackaged !== "boolean") throw new TypeError("desktop packaging mode required");
  if (isPackaged) return DEFAULT_PROXY_PORT;
  const value = env[DEVELOPMENT_PORT_VARIABLE];
  if (value === undefined || value === "") return DEFAULT_PROXY_PORT;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/u.test(value)
    || Number(value) > 65535) {
    throw Object.assign(new Error("Development proxy port is invalid"), { code: "DESKTOP_DEVELOPMENT_PROXY_PORT_INVALID" });
  }
  return Number(value);
}

module.exports = { DEFAULT_PROXY_PORT, DEVELOPMENT_PORT_VARIABLE, resolveDesktopProxyPort };
