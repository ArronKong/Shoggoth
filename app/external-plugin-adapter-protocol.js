"use strict";
const fs = require("node:fs"), path = require("node:path");
const { SERVICE_PROTOCOL_VERSION } = require("./agent-service/service-protocol-version");
const transports = { hermes: "transport.py", openclaw: "transport.mjs" };
function assertAdapterProtocol(backend, source) {
  const declaration = backend === "hermes" ? /^VERSION = (\d+)\b/mu : /^const VERSION = (\d+);/mu;
  if (!Object.hasOwn(transports, backend) || Number(declaration.exec(source)?.[1]) !== SERVICE_PROTOCOL_VERSION) {
    throw new Error(`Shoggoth ${backend} adapter Service protocol differs from ${SERVICE_PROTOCOL_VERSION}`);
  }
}
function checkAdapterProtocols(root) {
  const problems = [];
  for (const [backend, file] of Object.entries(transports)) {
    try { assertAdapterProtocol(backend, fs.readFileSync(path.join(root, backend, file), "utf8")); }
    catch (error) { problems.push(error.message); }
  }
  return problems;
}
module.exports = { assertAdapterProtocol, checkAdapterProtocols };
