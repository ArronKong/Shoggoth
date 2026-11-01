"use strict";
const { EnvHttpProxyAgent } = require("undici");
const { normalizeProxyEnvironment, PROXY_ENV_PAIRS } = require("./proxy-environment");
const { serviceError } = require("./security");
function createMcpFetch({ env = process.env, fetch: fetchImpl = globalThis.fetch, Agent = EnvHttpProxyAgent } = {}) {
  let dispatcher;
  return async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : input.url || input);
    // Local MCP servers and OAuth callbacks must never leave this machine.
    const local = /^(?:localhost|\[?::1\]?|127(?:\.[0-9]{1,3}){3})$/iu.test(url.hostname);
    if (local || init.dispatcher) return fetchImpl(input, init);
    let proxy;
    try {
      proxy = normalizeProxyEnvironment(Object.fromEntries(PROXY_ENV_PAIRS.flat().filter(k => env[k] !== undefined).map(k => [k, env[k]])));
      const httpProxy = proxy.HTTP_PROXY || proxy.ALL_PROXY || "", httpsProxy = proxy.HTTPS_PROXY || proxy.ALL_PROXY || "";
      if (httpProxy || httpsProxy) {
        if ([httpProxy, httpsProxy].filter(Boolean).some(value => !["http:", "https:"].includes(new URL(value).protocol))) throw Error("Unsupported proxy transport");
        dispatcher ||= new Agent({ httpProxy, httpsProxy, noProxy: proxy.NO_PROXY || "" });
      }
    } catch { throw serviceError("MCP_SERVER_CONNECTION_FAILED", "MCP 网络代理配置不可用"); }
    return fetchImpl(input, dispatcher ? { ...init, dispatcher } : init);
  };
}
let shared;
const getMcpFetch = () => shared ||= createMcpFetch();
module.exports = { createMcpFetch, getMcpFetch };
