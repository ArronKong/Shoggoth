"use strict";

const { EnvHttpProxyAgent, request } = require("undici");
const { normalizeProxyEnvironment, PROXY_ENV_PAIRS } = require("./proxy-environment");
const { serviceError } = require("./security");

// The caller owns the fixed destination, projected bytes and auth headers.
// This transport only applies the same explicit proxy environment as the CLI;
// it never follows redirects or retries a model submission.
function createModelSecretTransport({ env = process.env, Agent = EnvHttpProxyAgent } = {}) {
  const environment = Object.fromEntries(PROXY_ENV_PAIRS.flat()
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  let dispatcher, closed = false;
  const proxyUrl = value => value?.replace(/^socks5h:/u, "socks5:") || "";
  // Undici's SOCKS5 connector sends the destination hostname to the proxy.
  const getDispatcher = () => {
    if (closed) throw serviceError("SECRET_MODEL_GATEWAY_CLOSED", "模型请求通道已关闭");
    if (!dispatcher) {
      let proxy;
      try { proxy = normalizeProxyEnvironment(environment); }
      catch { throw serviceError("SECRET_MODEL_PROXY_INVALID", "模型网络代理配置不可用"); }
      dispatcher = new Agent({ httpProxy: proxyUrl(proxy.HTTP_PROXY || proxy.ALL_PROXY),
        httpsProxy: proxyUrl(proxy.HTTPS_PROXY || proxy.ALL_PROXY), noProxy: proxy.NO_PROXY || "",
        connect: { timeout: 300_000 } });
    }
    return dispatcher;
  };
  return {
    async send(url, { method, headers, signal }, body, timeoutMs) {
      const response = await request(url, { method, headers, signal, body, dispatcher: getDispatcher(),
        headersTimeout: timeoutMs, bodyTimeout: timeoutMs, maxRedirections: 0, idempotent: false });
      // Rejected statuses are destroyed without reading their private body.
      // Pipeline/text consumers still observe errors through their own listeners.
      response.body.on("error", () => {});
      return response;
    },
    async close() {
      closed = true;
      if (dispatcher) await dispatcher.destroy();
      dispatcher = null;
    },
  };
}

module.exports = { createModelSecretTransport };
