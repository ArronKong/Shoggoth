"use strict";
// Preloaded before the installed CLI: this fixture permits only its local fake
// provider socket. Credentials and real provider addresses are never supplied.
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const endpoint = new URL(process.env.SHOGGOTH_CAPACITY_ENDPOINT);
if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:") throw new Error("CAPACITY_ENDPOINT_INVALID");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "object" ? first.host : args[1];
  const port = typeof first === "object" ? first.port : first;
  if (host !== "127.0.0.1" || Number(port) !== Number(endpoint.port)) {
    throw new Error("CAPACITY_EXTERNAL_NETWORK_DENIED");
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();
