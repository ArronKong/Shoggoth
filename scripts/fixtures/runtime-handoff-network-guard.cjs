"use strict";

const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const endpoints = process.env.SHOGGOTH_HANDOFF_OAUTH === "openai-codex"
  ? [new URL("https://chatgpt.com"), new URL("https://auth.openai.com")]
  : [new URL(process.env.SHOGGOTH_HANDOFF_ENDPOINT_ORIGIN)];
if (process.env.SHOGGOTH_HANDOFF_PROXY) {
  const proxy = new URL(process.env.SHOGGOTH_HANDOFF_PROXY);
  if (!["http:", "https:"].includes(proxy.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(proxy.hostname)
    || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== "/" || !proxy.port) {
    throw new Error("HANDOFF_PROXY_INVALID");
  }
  endpoints.push(proxy);
}
if (endpoints.some(endpoint => !(endpoint.protocol === "https:" || (endpoint.protocol === "http:"
  && ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname))))) {
  throw new Error("HANDOFF_ENDPOINT_INVALID");
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "object" ? first.host : args[1];
  const port = typeof first === "object" ? first.port : first;
  if (!endpoints.some(endpoint => host === endpoint.hostname
    && Number(port) === Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)))) {
    throw new Error("HANDOFF_OTHER_ENDPOINT_DENIED");
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();
