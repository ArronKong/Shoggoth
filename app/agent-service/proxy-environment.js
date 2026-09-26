"use strict";

const { serviceError } = require("./security");

const PROXY_ENV_PAIRS = Object.freeze([
  Object.freeze(["HTTP_PROXY", "http_proxy"]),
  Object.freeze(["HTTPS_PROXY", "https_proxy"]),
  Object.freeze(["ALL_PROXY", "all_proxy"]),
  Object.freeze(["NO_PROXY", "no_proxy"]),
]);
const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks5:", "socks5h:"]);

// Shared by launchd and its runtime children; never inherit unrelated credentials.
function normalizeProxyEnvironment(value = {}, error = () => serviceError(
  "PROXY_ENV_INVALID", "Proxy environment is invalid",
)) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw error();
  const allowed = new Set(PROXY_ENV_PAIRS.flat());
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.has(key))) throw error();
  const read = (item, noProxy) => {
    if (item === undefined || item === "") return null;
    if (typeof item !== "string" || !item.isWellFormed()
      || /[\u0000-\u001f\u007f]/u.test(item)
      || Buffer.byteLength(item, "utf8") > (noProxy ? 8192 : 4096)) throw error();
    if (noProxy) return item;
    let parsed;
    try { parsed = new URL(item); } catch { throw error(); }
    if (!PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !["", "/"].includes(parsed.pathname)) throw error();
    return item;
  };
  const normalized = {};
  for (const [upper, lower] of PROXY_ENV_PAIRS) {
    const a = read(value[upper], upper === "NO_PROXY");
    const b = read(value[lower], upper === "NO_PROXY");
    if (a !== null && b !== null && a !== b) throw error();
    const resolved = a ?? b;
    if (resolved !== null) normalized[upper] = normalized[lower] = resolved;
  }
  return normalized;
}

module.exports = { PROXY_ENV_PAIRS, normalizeProxyEnvironment };
