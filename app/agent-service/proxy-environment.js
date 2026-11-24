"use strict";

const { execFile } = require("node:child_process");
const { serviceError } = require("./security");

const MAX_SCUTIL_PROXY_BYTES = 64 * 1024;

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

function parseMacSystemProxyOutput(output, error = () => serviceError(
  "PROXY_ENV_INVALID", "Proxy environment is invalid",
)) {
  if (Buffer.isBuffer(output)) output = output.toString("utf8");
  if (typeof output !== "string" || !output.isWellFormed()
    || Buffer.byteLength(output, "utf8") > MAX_SCUTIL_PROXY_BYTES) throw error();

  const fields = {};
  const exceptions = [];
  let readingExceptions = false;
  for (const line of output.split(/\r?\n/u)) {
    if (/^\s*ExceptionsList\s*:\s*<array>\s*\{\s*$/u.test(line)) {
      readingExceptions = true;
      continue;
    }
    if (readingExceptions) {
      if (/^\s*\}\s*$/u.test(line)) {
        readingExceptions = false;
        continue;
      }
      const match = line.match(/^\s*\d+\s*:\s*(.*?)\s*$/u);
      if (match) exceptions.push(match[1]);
      continue;
    }
    const match = line.match(/^\s*(HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort|SOCKSEnable|SOCKSProxy|SOCKSPort)\s*:\s*(.*?)\s*$/u);
    if (match) fields[match[1]] = match[2];
  }
  const endpoint = (prefix, scheme) => {
    if (fields[`${prefix}Enable`] !== "1") return null;
    const host = fields[`${prefix}Proxy`];
    const port = Number(fields[`${prefix}Port`]);
    if (typeof host !== "string" || host.length === 0 || host.length > 1024
      || /[\s\u0000-\u001f\u007f\/@?#]/u.test(host)
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    const hostLiteral = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `${scheme}://${hostLiteral}:${port}`;
  };
  const raw = {};
  const http = endpoint("HTTP", "http");
  const https = endpoint("HTTPS", "http");
  const socks = endpoint("SOCKS", "socks5");
  if (http) raw.HTTP_PROXY = http;
  if (https) raw.HTTPS_PROXY = https;
  if (socks) raw.ALL_PROXY = socks;
  const noProxy = exceptions
    .filter((item) => item !== "<local>" && item.length > 0
      && item.length <= 1024 && !/[,\s\u0000-\u001f\u007f]/u.test(item))
    .map((item) => item.startsWith("*.") ? item.slice(1) : item);
  if (noProxy.length > 0) raw.NO_PROXY = [...new Set(noProxy)].join(",");
  return normalizeProxyEnvironment(raw, error);
}

async function readMacSystemProxyEnvironmentAsync({ platform = process.platform, signal } = {}) {
  if (platform !== "darwin" || signal?.aborted) return {};
  const output = await new Promise((resolve) => {
    execFile("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8", maxBuffer: MAX_SCUTIL_PROXY_BYTES, timeout: 2000, signal,
    }, (error, stdout) => resolve(error ? null : stdout));
  });
  if (output === null) return {};
  try { return parseMacSystemProxyOutput(output); } catch { return {}; }
}

module.exports = { PROXY_ENV_PAIRS, normalizeProxyEnvironment, MAX_SCUTIL_PROXY_BYTES, parseMacSystemProxyOutput,
  readMacSystemProxyEnvironmentAsync };
